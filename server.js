const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ========================================
// DATA STORAGE
// ========================================
const activeUsers = new Map();
const activeCalls = new Map();
const userBalances = new Map();
const userCallHistory = new Map();

// Call rates
const CALL_RATES = {
  voice: 0.01,
  video: 0.03
};

// Helper functions
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function calculateCost(durationSeconds, callType) {
  const minutes = durationSeconds / 60;
  const rate = CALL_RATES[callType];
  let cost = minutes * rate;
  if (cost < 0.01) cost = 0.01;
  if (cost > 5.00) cost = 5.00;
  return parseFloat(cost.toFixed(4));
}

// ========================================
// API ROUTES
// ========================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/rates', (req, res) => {
  res.json(CALL_RATES);
});

app.get('/api/balance/:userId', (req, res) => {
  const balance = userBalances.get(req.params.userId) || 0;
  res.json({ balance, currency: 'USD' });
});

app.post('/api/register', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  
  const userId = uuidv4();
  userBalances.set(userId, 0.10); // Free $0.10
  
  res.json({ 
    userId, 
    username, 
    balance: 0.10, 
    message: 'Welcome! You have $0.10 free credit.' 
  });
});

// REAL PAYMENT GATEWAY SIMULATION (with proper menus)
app.post('/api/initiate-payment', async (req, res) => {
  const { userId, amount, method } = req.body;
  
  if (!amount || amount < 1) {
    return res.status(400).json({ error: 'Minimum amount is $1.00' });
  }
  
  // Generate payment session
  const paymentSession = {
    id: uuidv4(),
    userId,
    amount,
    method,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  
  // Store payment session (in real app, store in DB)
  // For demo, we return payment details based on method
  
  let paymentDetails = {};
  
  switch(method) {
    case 'mpesa':
      paymentDetails = {
        provider: 'M-Pesa',
        instructions: 'Enter your M-Pesa PIN to complete payment',
        phoneNumber: 'Enter your M-Pesa registered number',
        paybillNumber: '123456',
        accountNumber: paymentSession.id
      };
      break;
    case 'airtel':
      paymentDetails = {
        provider: 'Airtel Money',
        instructions: 'Enter your Airtel Money PIN',
        phoneNumber: 'Enter your Airtel number',
        paybillNumber: '789012'
      };
      break;
    case 'card':
      paymentDetails = {
        provider: 'Card Payment',
        instructions: 'Enter card details',
        cardTypes: ['Visa', 'Mastercard', 'American Express']
      };
      break;
    case 'paypal':
      paymentDetails = {
        provider: 'PayPal',
        instructions: 'You will be redirected to PayPal',
        email: 'Enter your PayPal email'
      };
      break;
  }
  
  res.json({
    success: true,
    paymentSessionId: paymentSession.id,
    amount: amount,
    method: method,
    details: paymentDetails
  });
});

// Confirm payment after user submits details
app.post('/api/confirm-payment', (req, res) => {
  const { userId, amount, method, paymentDetails } = req.body;
  
  // Simulate payment processing
  const currentBalance = userBalances.get(userId) || 0;
  const newBalance = currentBalance + amount;
  userBalances.set(userId, newBalance);
  
  res.json({
    success: true,
    newBalance: newBalance,
    message: `$${amount} added successfully via ${method}`,
    transactionId: 'TXN_' + Date.now()
  });
});

// ========================================
// SOCKET.IO - REAL SIGNALING
// ========================================

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  let currentUserId = null;
  
  socket.on('user-join', (data) => {
    const { userId, username } = data;
    currentUserId = userId;
    activeUsers.set(userId, { 
      socketId: socket.id, 
      username, 
      joinedAt: Date.now(),
      inCall: false,
      currentCallId: null
    });
    
    broadcastOnlineUsers();
    console.log(`✅ User ${username} online (${userId})`);
  });
  
  socket.on('call-start', (data) => {
    const { callerId, callerName, calleeId, callType } = data;
    
    // Check caller balance
    const callerBalance = userBalances.get(callerId) || 0;
    if (callerBalance < 0.05) {
      socket.emit('call-error', { 
        error: 'insufficient_balance', 
        message: `Insufficient balance: $${callerBalance.toFixed(2)}. Please add funds.` 
      });
      return;
    }
    
    // Check if callee exists
    const callee = activeUsers.get(calleeId);
    if (!callee) {
      socket.emit('call-error', { error: 'offline', message: 'User is offline' });
      return;
    }
    
    // Check if callee is already in a call
    if (callee.inCall) {
      socket.emit('call-error', { error: 'busy', message: 'User is on another call' });
      return;
    }
    
    // Create call session
    const callId = uuidv4();
    const callSession = {
      id: callId,
      callerId,
      callerName,
      calleeId,
      callType,
      status: 'ringing',
      startTime: new Date(),
      callerSocket: socket.id,
      calleeSocket: callee.socketId
    };
    
    activeCalls.set(callId, callSession);
    
    // Update user status
    const caller = activeUsers.get(callerId);
    if (caller) {
      caller.inCall = true;
      caller.currentCallId = callId;
      activeUsers.set(callerId, caller);
    }
    
    // Notify callee
    io.to(callee.socketId).emit('incoming-call', {
      callId,
      callerId,
      callerName,
      callType,
      rate: CALL_RATES[callType]
    });
    
    socket.emit('call-started', { callId });
    console.log(`📞 Call ${callId}: ${callerName} → ${callee.username}`);
  });
  
  socket.on('call-accept', (data) => {
    const { callId, calleeId } = data;
    const call = activeCalls.get(callId);
    if (!call) return;
    
    // Update callee status
    const callee = activeUsers.get(calleeId);
    if (callee) {
      callee.inCall = true;
      callee.currentCallId = callId;
      activeUsers.set(calleeId, callee);
    }
    
    call.status = 'connected';
    call.connectedAt = new Date();
    activeCalls.set(callId, call);
    
    // Notify caller
    io.to(call.callerSocket).emit('call-accepted', { callId });
    socket.emit('call-connected', { callId });
    
    console.log(`✅ Call ${callId} accepted`);
  });
  
  socket.on('call-reject', (data) => {
    const { callId } = data;
    const call = activeCalls.get(callId);
    if (call) {
      io.to(call.callerSocket).emit('call-rejected', { callId });
      cleanupCall(callId);
    }
  });
  
  // WebRTC Signaling
  socket.on('offer', (data) => {
    const { targetUserId, callId, sdp } = data;
    const target = activeUsers.get(targetUserId);
    if (target && target.socketId) {
      io.to(target.socketId).emit('offer', {
        fromUserId: currentUserId,
        callId,
        sdp
      });
    }
  });
  
  socket.on('answer', (data) => {
    const { targetUserId, callId, sdp } = data;
    const target = activeUsers.get(targetUserId);
    if (target && target.socketId) {
      io.to(target.socketId).emit('answer', {
        fromUserId: currentUserId,
        callId,
        sdp
      });
    }
  });
  
  socket.on('ice-candidate', (data) => {
    const { targetUserId, callId, candidate } = data;
    const target = activeUsers.get(targetUserId);
    if (target && target.socketId) {
      io.to(target.socketId).emit('ice-candidate', {
        fromUserId: currentUserId,
        callId,
        candidate
      });
    }
  });
  
  socket.on('call-end', (data) => {
    const { callId, userId } = data;
    const call = activeCalls.get(callId);
    
    if (call && call.status === 'connected') {
      const endTime = new Date();
      const durationSeconds = Math.floor((endTime - call.connectedAt) / 1000);
      const cost = calculateCost(durationSeconds, call.callType);
      
      // Deduct from caller's balance
      const callerBalance = userBalances.get(call.callerId) || 0;
      const newBalance = parseFloat((callerBalance - cost).toFixed(4));
      userBalances.set(call.callerId, Math.max(0, newBalance));
      
      // Store call history
      const historyEntry = {
        id: callId,
        with: call.callerId === userId ? call.callerName : call.callerName,
        type: call.callType,
        duration: durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        cost: cost,
        timestamp: new Date().toISOString()
      };
      
      const history = userCallHistory.get(userId) || [];
      history.unshift(historyEntry);
      if (history.length > 50) history.pop();
      userCallHistory.set(userId, history);
      
      // Send end notification to both parties
      const endData = {
        callId,
        duration: durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        cost: cost,
        newBalance: Math.max(0, newBalance),
        message: `Call ended. Duration: ${formatDuration(durationSeconds)}, Cost: $${cost.toFixed(4)}`
      };
      
      io.to(call.callerSocket).emit('call-ended', endData);
      io.to(call.calleeSocket).emit('call-ended', endData);
      
      // Send balance update to caller
      io.to(call.callerSocket).emit('balance-update', { balance: Math.max(0, newBalance) });
    }
    
    cleanupCall(callId);
  });
  
  socket.on('get-online-users', () => {
    broadcastOnlineUsers();
  });
  
  socket.on('disconnect', () => {
    if (currentUserId) {
      // End any active calls from this user
      for (const [callId, call] of activeCalls) {
        if (call.callerId === currentUserId || call.calleeId === currentUserId) {
          cleanupCall(callId);
        }
      }
      
      // Update user status
      const user = activeUsers.get(currentUserId);
      if (user) {
        user.inCall = false;
        user.currentCallId = null;
        activeUsers.set(currentUserId, user);
      }
      
      broadcastOnlineUsers();
      console.log(`❌ User ${currentUserId} disconnected`);
    }
  });
  
  function broadcastOnlineUsers() {
    const onlineUsers = Array.from(activeUsers.entries()).map(([id, info]) => ({
      userId: id,
      username: info.username,
      inCall: info.inCall || false
    }));
    io.emit('online-users', onlineUsers);
  }
  
  function cleanupCall(callId) {
    const call = activeCalls.get(callId);
    if (call) {
      // Reset user status
      const caller = activeUsers.get(call.callerId);
      if (caller) {
        caller.inCall = false;
        caller.currentCallId = null;
        activeUsers.set(call.callerId, caller);
      }
      
      const callee = activeUsers.get(call.calleeId);
      if (callee) {
        callee.inCall = false;
        callee.currentCallId = null;
        activeUsers.set(call.calleeId, callee);
      }
      
      activeCalls.delete(callId);
      broadcastOnlineUsers();
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ZAS Fixed App running on http://localhost:${PORT}`);
  console.log(`📞 Voice: $${CALL_RATES.voice}/min | Video: $${CALL_RATES.video}/min`);
});
