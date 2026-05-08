// ========================================
// ZAS Pink Edition - Frontend Logic
// ========================================

// Global variables
let socket = null;
let currentUser = {
    id: null,
    username: null,
    balance: 0
};
let currentCall = null;
let localStream = null;
let peerConnection = null;
let callTimer = null;
let callStartTime = null;
let pendingCall = null;
let isCallActive = false;
let isVideoMode = false;

// WebRTC STUN servers
const STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];

// API URL
const API_URL = window.location.origin;

// ========================================
// Authentication Functions
// ========================================

async function registerUser() {
    const username = document.getElementById('username').value.trim();
    
    if (!username) {
        showToast('Please enter a username', true);
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            currentUser.id = data.userId;
            currentUser.username = username;
            currentUser.balance = data.balance;
            
            localStorage.setItem('zas_user', JSON.stringify(currentUser));
            
            connectSocket();
            showApp();
            showToast(`Welcome ${username}! You have $${currentUser.balance} free credit.`);
        } else {
            showToast(data.error || 'Registration failed', true);
        }
    } catch (error) {
        console.error('Registration error:', error);
        showToast('Network error', true);
    }
}

function connectSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Socket connected');
        socket.emit('user-join', {
            userId: currentUser.id,
            username: currentUser.username
        });
    });
    
    socket.on('online-users', (users) => {
        displayOnlineUsers(users);
        document.getElementById('onlineCount').innerText = users.length;
    });
    
    socket.on('incoming-call', (data) => {
        pendingCall = data;
        document.getElementById('incomingCallerName').innerText = data.callerName;
        document.getElementById('incomingCallType').innerHTML = 
            data.callType === 'voice' ? '<i class="fas fa-phone-alt"></i> Voice Call' : '<i class="fas fa-video"></i> Video Call';
        document.getElementById('incomingCallModal').classList.add('show');
    });
    
    socket.on('call-accepted', async (data) => {
        if (currentCall && currentCall.status === 'calling') {
            document.getElementById('callStatus').innerText = 'Connected';
            await createPeerConnection(true);
        }
    });
    
    socket.on('call-connected', () => {
        startCallTimer();
    });
    
    socket.on('call-rejected', () => {
        showToast('Call rejected', true);
        cleanupCall();
    });
    
    socket.on('call-ended', (data) => {
        showToast(data.message || `Call ended. Duration: ${data.durationFormatted}, Cost: $${data.cost.toFixed(4)}`);
        cleanupCall();
        loadUserBalance();
        loadCallHistory();
    });
    
    socket.on('balance-update', (data) => {
        currentUser.balance = data.balance;
        updateBalanceDisplay();
        if (data.lastCallCost) {
            showToast(`Call cost: $${data.lastCallCost.toFixed(4)}`);
        }
    });
    
    socket.on('call-error', (data) => {
        showToast(data.message, true);
        if (data.error === 'insufficient_balance') {
            showAddFundsModal();
        }
        cleanupCall();
    });
    
    // WebRTC signaling
    socket.on('offer', async (data) => {
        if (!peerConnection) {
            await createPeerConnection(false);
        }
        await handleOffer(data);
    });
    
    socket.on('answer', async (data) => {
        await handleAnswer(data);
    });
    
    socket.on('ice-candidate', async (data) => {
        await handleIceCandidate(data);
    });
}

// ========================================
// UI Functions
// ========================================

function showApp() {
    // Hide splash screen
    const splash = document.getElementById('splashScreen');
    if (splash) splash.style.display = 'none';
    
    document.getElementById('authScreen').classList.remove('active');
    document.getElementById('appScreen').classList.add('active');
    
    document.getElementById('menuUsername').innerText = currentUser.username;
    document.getElementById('menuAvatarInitial').innerText = currentUser.username.charAt(0).toUpperCase();
    document.getElementById('currentUsername').innerText = currentUser.username;
    document.getElementById('profileName').innerText = currentUser.username;
    document.getElementById('profileAvatar').innerHTML = `<span>${currentUser.username.charAt(0).toUpperCase()}</span>`;
    
    updateBalanceDisplay();
    loadOnlineUsers();
    loadCallHistory();
}

function updateBalanceDisplay() {
    const balanceEl = document.getElementById('walletBalance');
    if (balanceEl) balanceEl.innerText = `$${currentUser.balance.toFixed(2)}`;
}

async function loadUserBalance() {
    try {
        const response = await fetch(`${API_URL}/api/balance/${currentUser.id}`);
        const data = await response.json();
        currentUser.balance = data.balance;
        updateBalanceDisplay();
    } catch (error) {
        console.error('Error loading balance:', error);
    }
}

function loadOnlineUsers() {
    if (socket) {
        socket.emit('get-online-users');
    }
}

function displayOnlineUsers(users) {
    const container = document.getElementById('onlineUsersList');
    if (!container) return;
    
    const otherUsers = users.filter(u => u.userId !== currentUser.id);
    
    if (otherUsers.length === 0) {
        container.innerHTML = '<div class="empty-state">No other users online</div>';
        return;
    }
    
    container.innerHTML = otherUsers.map(user => `
        <div class="user-item">
            <div class="user-avatar">${user.avatar || user.username.charAt(0).toUpperCase()}</div>
            <div class="user-info">
                <div class="user-name">${escapeHtml(user.username)}</div>
                <div class="user-status">● Online</div>
            </div>
            <div class="user-actions">
                <button class="call-action-btn voice" onclick="startCall('${user.userId}', '${escapeHtml(user.username)}', 'voice')">
                    <i class="fas fa-phone-alt"></i>
                </button>
                <button class="call-action-btn video" onclick="startCall('${user.userId}', '${escapeHtml(user.username)}', 'video')">
                    <i class="fas fa-video"></i>
                </button>
            </div>
        </div>
    `).join('');
}

async function loadCallHistory() {
    if (!socket) return;
    
    socket.emit('get-call-history', { userId: currentUser.id });
    
    socket.once('call-history', (data) => {
        const history = data.history || [];
        // Store for later display or show in alert for demo
        if (history.length > 0) {
            console.log('Call history:', history);
        }
    });
}

function switchTab(tabName) {
    // Update dock icons
    document.querySelectorAll('.dock-icon').forEach(icon => {
        icon.classList.remove('active');
        if (icon.getAttribute('data-tab') === tabName) {
            icon.classList.add('active');
        }
    });
    
    // Show/hide sections based on tab
    const onlineSection = document.querySelector('.online-users-section');
    const ratesSection = document.querySelector('.rates-section');
    
    switch(tabName) {
        case 'home':
            if (onlineSection) onlineSection.style.display = 'block';
            if (ratesSection) ratesSection.style.display = 'block';
            break;
        case 'calls':
            if (onlineSection) onlineSection.style.display = 'block';
            if (ratesSection) ratesSection.style.display = 'block';
            loadCallHistory();
            break;
        case 'contacts':
            if (onlineSection) onlineSection.style.display = 'block';
            if (ratesSection) ratesSection.style.display = 'block';
            loadOnlineUsers();
            break;
        case 'wallet':
            if (onlineSection) onlineSection.style.display = 'none';
            if (ratesSection) ratesSection.style.display = 'block';
            break;
        case 'profile':
            if (onlineSection) onlineSection.style.display = 'none';
            if (ratesSection) ratesSection.style.display = 'none';
            break;
    }
}

// ========================================
// Calling Functions
// ========================================

async function startCall(calleeId, calleeName, callType) {
    if (currentCall) {
        showToast('Already in a call', true);
        return;
    }
    
    // Check balance
    if (currentUser.balance < 0.05) {
        showToast(`Insufficient balance: $${currentUser.balance.toFixed(2)}. Please add funds.`, true);
        showAddFundsModal();
        return;
    }
    
    const rate = callType === 'voice' ? 0.01 : 0.03;
    const confirmMsg = `Start ${callType} call with ${calleeName}?\n\nRate: $${rate}/minute\nMinimum charge: $0.01\nCurrent balance: $${currentUser.balance.toFixed(2)}`;
    
    if (!confirm(confirmMsg)) return;
    
    try {
        // Get user media
        localStream = await navigator.mediaDevices.getUserMedia({
            video: callType === 'video',
            audio: true
        });
        
        const localVideo = document.getElementById('localVideo');
        if (localVideo) localVideo.srcObject = localStream;
        
        // Show/hide video elements
        const localVideoWrapper = document.getElementById('localVideoWrapper');
        if (callType === 'video') {
            isVideoMode = true;
            if (localVideoWrapper) localVideoWrapper.classList.remove('hide');
        } else {
            isVideoMode = false;
            if (localVideoWrapper) localVideoWrapper.classList.add('hide');
        }
        
        // Emit call start to server
        socket.emit('call-start', {
            callerId: currentUser.id,
            callerName: currentUser.username,
            calleeId: calleeId,
            callType: callType
        });
        
        currentCall = {
            id: null,
            calleeId: calleeId,
            calleeName: calleeName,
            callType: callType,
            status: 'calling'
        };
        
        showCallScreen();
        
    } catch (error) {
        console.error('Error starting call:', error);
        showToast('Cannot access camera/microphone', true);
        cleanupCall();
    }
}

function showCallScreen() {
    document.getElementById('appScreen').classList.remove('active');
    document.getElementById('callScreen').classList.add('active');
    document.getElementById('callWithName').innerText = currentCall?.calleeName || 'Calling...';
    document.getElementById('callStatus').innerText = 'Ringing...';
    
    // Show/hide video elements
    const localVideoWrapper = document.getElementById('localVideoWrapper');
    if (isVideoMode) {
        localVideoWrapper.classList.remove('hide');
    } else {
        localVideoWrapper.classList.add('hide');
    }
}

function acceptCall() {
    if (!pendingCall) return;
    
    (async () => {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: pendingCall.callType === 'video',
                audio: true
            });
            
            const localVideo = document.getElementById('localVideo');
            if (localVideo) localVideo.srcObject = localStream;
            
            const localVideoWrapper = document.getElementById('localVideoWrapper');
            if (pendingCall.callType === 'video') {
                isVideoMode = true;
                localVideoWrapper.classList.remove('hide');
            } else {
                isVideoMode = false;
                localVideoWrapper.classList.add('hide');
            }
            
            socket.emit('call-accept', {
                callId: pendingCall.callId,
                calleeId: currentUser.id
            });
            
            currentCall = {
                id: pendingCall.callId,
                callerId: pendingCall.callerId,
                callerName: pendingCall.callerName,
                callType: pendingCall.callType,
                status: 'connected'
            };
            
            showCallScreen();
            document.getElementById('incomingCallModal').classList.remove('show');
            
        } catch (error) {
            console.error('Error accepting call:', error);
            showToast('Cannot access camera/microphone', true);
            rejectCall();
        }
    })();
}

function rejectCall() {
    if (pendingCall) {
        socket.emit('call-reject', { callId: pendingCall.callId });
        pendingCall = null;
        document.getElementById('incomingCallModal').classList.remove('show');
    }
}

function hangUp() {
    if (currentCall) {
        socket.emit('call-end', {
            callId: currentCall.id || 'temp_' + Date.now(),
            userId: currentUser.id
        });
    }
    cleanupCall();
}

function cleanupCall() {
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    currentCall = null;
    pendingCall = null;
    callStartTime = null;
    isVideoMode = false;
    
    document.getElementById('callScreen').classList.remove('active');
    document.getElementById('appScreen').classList.add('active');
    
    // Reset video elements
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideo = document.getElementById('localVideo');
    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) localVideo.srcObject = null;
    
    loadUserBalance();
}

function startCallTimer() {
    callStartTime = Date.now();
    callTimer = setInterval(() => {
        if (!callStartTime) return;
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timerEl = document.getElementById('callTimer');
        if (timerEl) {
            timerEl.innerText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }, 1000);
}

function toggleMicrophone() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            const btn = document.getElementById('micToggleBtn');
            if (audioTrack.enabled) {
                btn.innerHTML = '<i class="fas fa-microphone"></i>';
                btn.classList.remove('muted');
            } else {
                btn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
                btn.classList.add('muted');
            }
        }
    }
}

function toggleVideoCall() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            const btn = document.getElementById('cameraToggleBtn');
            const localVideoWrapper = document.getElementById('localVideoWrapper');
            if (videoTrack.enabled) {
                btn.innerHTML = '<i class="fas fa-video"></i>';
                localVideoWrapper.classList.remove('hide');
            } else {
                btn.innerHTML = '<i class="fas fa-video-slash"></i>';
                localVideoWrapper.classList.add('hide');
            }
        }
    }
}

// ========================================
// WebRTC Signaling
// ========================================

async function createPeerConnection(isCaller) {
    const configuration = { iceServers: STUN_SERVERS };
    peerConnection = new RTCPeerConnection(configuration);
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
    
    peerConnection.ontrack = (event) => {
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo) {
            remoteVideo.srcObject = event.streams[0];
        }
    };
    
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && currentCall) {
            const otherUserId = currentCall.calleeId || currentCall.callerId;
            socket.emit('ice-candidate', {
                targetUserId: otherUserId,
                callId: currentCall.id || 'temp',
                candidate: event.candidate
            });
        }
    };
    
    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'disconnected' || 
            peerConnection.connectionState === 'failed') {
            hangUp();
        }
    };
    
    if (isCaller && currentCall && currentCall.status === 'calling') {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('offer', {
            targetUserId: currentCall.calleeId,
            callId: currentCall.id || 'temp',
            sdp: offer
        });
    }
}

async function handleOffer(data) {
    if (!peerConnection) return;
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer', {
        targetUserId: data.fromUserId,
        callId: data.callId,
        sdp: answer
    });
}

async function handleAnswer(data) {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
}

async function handleIceCandidate(data) {
    if (peerConnection && data.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
}

// ========================================
// Wallet Functions
// ========================================

function showAddFundsModal() {
    document.getElementById('addFundsModal').classList.add('show');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

function setAmount(amount) {
    document.getElementById('fundsAmount').value = amount;
}

async function addFunds() {
    const amount = parseFloat(document.getElementById('fundsAmount').value);
    const method = document.getElementById('paymentMethod').value;
    
    if (!amount || amount < 1) {
        showToast('Minimum amount is $1.00', true);
        return;
    }
    
    showToast('Processing payment...');
    
    try {
        const response = await fetch(`${API_URL}/api/add-funds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                amount: amount,
                method: method
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser.balance = data.newBalance;
            updateBalanceDisplay();
            showToast(`$${amount} added successfully! New balance: $${currentUser.balance.toFixed(2)}`);
            closeModal('addFundsModal');
            localStorage.setItem('zas_user', JSON.stringify(currentUser));
        } else {
            showToast(data.error || 'Payment failed', true);
        }
    } catch (error) {
        console.error('Error adding funds:', error);
        showToast('Network error', true);
    }
}

// ========================================
// Utility Functions
// ========================================

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMessage');
    toastMsg.innerHTML = message;
    toast.classList.add('show');
    if (isError) {
        toast.style.background = 'rgba(220, 38, 38, 0.9)';
    } else {
        toast.style.background = 'rgba(0, 0, 0, 0.9)';
    }
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function logout() {
    localStorage.removeItem('zas_user');
    if (socket) socket.disconnect();
    location.reload();
}

// ========================================
// Clock Update
// ========================================

function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const clockEl = document.getElementById('clock');
    if (clockEl) clockEl.textContent = hours + ":" + minutes;
    
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    const dateEl = document.getElementById('date');
    if (dateEl) dateEl.textContent = now.toLocaleDateString('sw', options);
    
    // Update battery (mock)
    const batteryEl = document.getElementById('batteryLevel');
    if (batteryEl) {
        const batteryLevel = Math.floor(Math.random() * 30) + 70;
        batteryEl.textContent = batteryLevel;
    }
}

setInterval(updateClock, 1000);
updateClock();

// ========================================
// Initialize
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    const savedUser = localStorage.getItem('zas_user');
    if (savedUser) {
        try {
            const parsed = JSON.parse(savedUser);
            currentUser = parsed;
            connectSocket();
            showApp();
            loadUserBalance();
        } catch(e) {
            console.error('Error loading saved user:', e);
        }
    } else {
        // Show auth screen, hide splash after delay
        setTimeout(() => {
            const splash = document.getElementById('splashScreen');
            if (splash) splash.style.display = 'none';
            document.getElementById('authScreen').classList.add('active');
        }, 2000);
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hangUp();
    if (e.key === 'm') toggleMicrophone();
    if (e.key === 'v') toggleVideoCall();
});
