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
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Store data
const activeUsers = new Map();
const activeCalls = new Map();
const userBalances = new Map();
const callHistory = new Map();
const userTransactions = new Map();

// Call rates
const CALL_RATES = {
  voice: parseFloat(process.env.CALL_RATE_VOICE) || 0.01,
  video: parseFloat(process.env.CALL_RATE_VIDEO) || 0.03
};

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function calculateCost(durationSeconds, callType) {
  const minutes = durationSeconds / 60;
  const rate = CALL_RATES[callType] || 0.01;
  let cost = minutes * rate;
  if (cost < 0.01) cost = 0.01;
  if (cost > 5.00) cost = 5.00;
  return parseFloat(cost.toFixed(4));
}

// API Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/rates', (req, res) => {
  res.json({ voice: CALL_RATES.voice, video: CALL_RATES.video, currency: 'USD' });
});

app.get('/api/balance/:userId', (req, res) => {
  const balance = userBalances.get(req.params.userId) || 0;
  res.json({ userId: req.params.userId, balance, currency: 'USD' });
});

app.post('/api/register', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  
  const userId = uuidv4();
  userBalances.set(userId, 0.10);
  
  res.json({ userId, username, balance: 0.10, message: 'Welcome to ZAS Pink! You have $0.10 free credit.' });
});

app.post('/api/add-funds', (req, res) => {
  const { userId, amount, method } = req.body;
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  const currentBalance = userBalances.get(userId) || 0;
  const newBalance = currentBalance + amount;
  userBalances.set(userId, newBalance);
  
  // Record transaction
  const transactions = userTransactions.get(userId) || [];
  transactions.unshift({
    id: Date.now(),
    type: 'deposit',
    amount: amount,
    method: method || 'card',
    date: new Date().toISOString()
  });
  if (transactions.length > 50) transactions.pop();
  userTransactions.set(userId, transactions);
  
  res.json({ success: true, newBalance, message: `$${amount} added successfully` });
});

app.get('/api/transactions/:userId', (req, res) => {
  const transactions = userTransactions.get(req.params.userId) || [];
  res.json({ transactions });
});

app.get('/api/history/:userId', (req, res) => {
  const history = callHistory.get(req.params.userId) || [];
  res.json({ history });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  let currentUserId = null;
  
  socket.on('user-join', (data) => {
    const { userId, username } = data;
    currentUserId = userId;
    activeUsers.set(userId, { socketId: socket.id, username, joinedAt: new Date() });
    
    const onlineUsers = Array.from(activeUsers.entries()).map(([id, info]) => ({
      userId: id, username: info.username
    }));
    io.emit('online-users', onlineUsers);
    console.log(`✅ User ${username} joined (${userId})`);
  });
  
  socket.on('call-start', (data) => {
    const { callerId, callerName, calleeId, callType } = data;
    const callerBalance = userBalances.get(callerId) || 0;
    
    if (callerBalance < 0.05) {
      socket.emit('call-error', { error: 'insufficient_balance', message: `Insufficient balance: $${callerBalance.toFixed(2)}` });
      return;
    }
    
    const callee = activeUsers.get(calleeId);
    if (!callee) {
      socket.emit('call-error', { error: 'user_offline', message: 'User is offline' });
      return;
    }
    
    let calleeInCall = false;
    for (const [, call] of activeCalls) {
      if ((call.calleeId === calleeId || call.callerId === calleeId) && call.status === 'connected') {
        calleeInCall = true;
        break;
      }
    }
    
    if (calleeInCall) {
      socket.emit('call-error', { error: 'user_busy', message: 'User is on another call' });
      return;
    }
    
    const callId = uuidv4();
    activeCalls.set(callId, {
      callId, callerId, callerName, calleeId, callType,
      status: 'ringing', startTime: new Date(), duration: 0, cost: 0
    });
    
    // Emit to callee
    io.to(callee.socketId).emit('incoming-call', { 
      callId, callerId, callerName, callType, 
      rate: CALL_RATES[callType],
      callerBalance: callerBalance
    });
    
    socket.emit('call-ringing', { callId });
    console.log(`📞 Call started: ${callerName} → ${callee.username} (${callType})`);
  });
  
  socket.on('call-accept', (data) => {
    const { callId, calleeId } = data;
    const call = activeCalls.get(callId);
    if (!call) return;
    
    const caller = activeUsers.get(call.callerId);
    if (!caller) return;
    
    call.status = 'connected';
    call.connectedAt = new Date();
    activeCalls.set(callId, call);
    
    io.to(caller.socketId).emit('call-accepted', { callId, calleeId, callType: call.callType });
    socket.emit('call-connected', { callId });
    console.log(`✅ Call ${callId} accepted`);
  });
  
  socket.on('call-reject', (data) => {
    const { callId } = data;
    const call = activeCalls.get(callId);
    if (call) {
      const caller = activeUsers.get(call.callerId);
      if (caller) io.to(caller.socketId).emit('call-rejected', { callId });
      activeCalls.delete(callId);
    }
    console.log(`❌ Call ${callId} rejected`);
  });
  
  // WebRTC Signaling
  socket.on('offer', (data) => {
    const { targetUserId, callId, sdp } = data;
    const target = activeUsers.get(targetUserId);
    if (target) io.to(target.socketId).emit('offer', { fromUserId: currentUserId, callId, sdp });
  });
  
  socket.on('answer', (data) => {
    const { targetUserId, callId, sdp } = data;
    const target = activeUsers.get(targetUserId);
    if (target) io.to(target.socketId).emit('answer', { fromUserId: currentUserId, callId, sdp });
  });
  
  socket.on('ice-candidate', (data) => {
    const { targetUserId, callId, candidate } = data;
    const target = activeUsers.get(targetUserId);
    if (target) io.to(target.socketId).emit('ice-candidate', { fromUserId: currentUserId, callId, candidate });
  });
  
  socket.on('call-end', (data) => {
    const { callId, userId } = data;
    const call = activeCalls.get(callId);
    
    if (call) {
      const endTime = new Date();
      const durationSeconds = Math.floor((endTime - call.startTime) / 1000);
      const cost = calculateCost(durationSeconds, call.callType);
      
      call.status = 'ended';
      call.duration = durationSeconds;
      call.cost = cost;
      
      const callerBalance = userBalances.get(call.callerId) || 0;
      userBalances.set(call.callerId, Math.max(0, callerBalance - cost));
      
      // Save to history
      const historyEntry = {
        id: callId,
        otherParty: call.calleeId === userId ? call.callerName : (() => {
          const callee = activeUsers.get(call.calleeId);
          return callee ? callee.username : call.calleeId;
        })(),
        callType: call.callType,
        duration: durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        cost: cost,
        date: new Date().toISOString(),
        wasIncoming: call.calleeId === userId
      };
      
      const userHistory = callHistory.get(userId) || [];
      userHistory.unshift(historyEntry);
      if (userHistory.length > 100) userHistory.pop();
      callHistory.set(userId, userHistory);
      
      // Also save for the other party
      const otherId = call.callerId === userId ? call.calleeId : call.callerId;
      const otherHistory = callHistory.get(otherId) || [];
      otherHistory.unshift({
        ...historyEntry,
        wasIncoming: call.callerId === otherId
      });
      if (otherHistory.length > 100) otherHistory.pop();
      callHistory.set(otherId, otherHistory);
      
      const caller = activeUsers.get(call.callerId);
      const callee = activeUsers.get(call.calleeId);
      
      const endData = { callId, duration: durationSeconds, durationFormatted: formatDuration(durationSeconds), cost };
      
      if (caller) io.to(caller.socketId).emit('call-ended', endData);
      if (callee) io.to(callee.socketId).emit('call-ended', endData);
      
      if (caller) {
        io.to(caller.socketId).emit('balance-update', {
          balance: Math.max(0, callerBalance - cost),
          lastCallCost: cost,
          lastCallDuration: durationSeconds
        });
      }
      
      activeCalls.delete(callId);
      console.log(`📞 Call ${callId} ended: ${formatDuration(durationSeconds)}, cost: $${cost}`);
    }
  });
  
  socket.on('get-online-users', () => {
    const onlineUsers = Array.from(activeUsers.entries()).map(([id, info]) => ({ 
      userId: id, 
      username: info.username,
      avatar: info.username.charAt(0).toUpperCase()
    }));
    socket.emit('online-users', onlineUsers);
  });
  
  socket.on('get-call-history', (data) => {
    const { userId } = data;
    const history = callHistory.get(userId) || [];
    socket.emit('call-history', { history });
  });
  
  socket.on('get-transactions', (data) => {
    const { userId } = data;
    const transactions = userTransactions.get(userId) || [];
    socket.emit('transactions-data', { transactions });
  });
  
  socket.on('disconnect', () => {
    if (currentUserId) {
      activeUsers.delete(currentUserId);
      const onlineUsers = Array.from(activeUsers.entries()).map(([id, info]) => ({ 
        userId: id, 
        username: info.username 
      }));
      io.emit('online-users', onlineUsers);
      console.log(`❌ User ${currentUserId} disconnected`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌸 ZAS Pink Calling App running on http://localhost:${PORT}`);
  console.log(`📞 Voice rate: $${CALL_RATES.voice}/min | Video: $${CALL_RATES.video}/min`);
});
