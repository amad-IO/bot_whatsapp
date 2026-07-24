'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const qrcode     = require('qrcode');
const fileUpload = require('express-fileupload');
const socketIO   = require('socket.io');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const db = require('./db');
const eventBus = require('./eventBus');
const cron = require('node-cron');

// ============================================================
//  CONFIG
// ============================================================
const PORT            = parseInt(process.env.PORT)            || 3030;
const CHAT_LOG_FILE   = process.env.CHAT_LOG_FILE             || 'chats-log.jsonl';
const CRON_TOKEN      = process.env.CRON_TOKEN                || 'RAHASIA_CRON_123';
const API_KEY         = process.env.API_KEY                   || '';
const WEBHOOK_URL     = process.env.WEBHOOK_URL               || '';
const MAX_RETRY       = parseInt(process.env.MAX_RETRY)       || 3;
const QUEUE_DELAY_MIN = parseInt(process.env.QUEUE_DELAY_MIN) || 2000;
const QUEUE_DELAY_MAX = parseInt(process.env.QUEUE_DELAY_MAX) || 5000;
const AUTO_REPLY_ENABLED  = process.env.AUTO_REPLY_ENABLED  === 'true';
const AUTO_BOT_AI_ENABLED = process.env.AUTO_BOT_AI_ENABLED === 'true';
const SESSIONS_FILE   = '.wa-sessions.json';

// ============================================================
//  EXPRESS + SOCKET.IO
// ============================================================
const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload());
app.use('/', express.static(path.join(__dirname)));

let clients = {};
let qrStore = {};
const initializing = {};
const qrCount = {};
const crashCount = {};

// ============================================================
//  RATE LIMITER (kirim langsung)
// ============================================================
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests — slow down' },
});

// ============================================================
//  HELPERS
// ============================================================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizePhone(raw) {
  let n = (raw || '').toString().replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.substring(1);
  return n;
}

function logChat(id, msg) {
  try {
    const entry = {
      clientId: id, from: msg.from, to: msg.to || null,
      body: msg.body, type: msg.type, hasMedia: msg.hasMedia,
      timestamp: new Date().toISOString(),
    };
    fs.appendFile(CHAT_LOG_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch (e) {
    console.error('Gagal log chat:', e.message);
  }
}

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('[WEBHOOK] Error:', e.message);
  }
}

// ============================================================
//  SESSION PERSISTENCE (auto-start on reboot)
// ============================================================
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE))
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.keys(clients)));
  } catch (e) {
    console.error('[SESSIONS] Save error:', e.message);
  }
}

// ============================================================
//  AUTH MIDDLEWARE (aktif hanya jika API_KEY diset)
// ============================================================
function apiAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key']
    || (req.headers['authorization'] || '').replace('Bearer ', '')
    || req.query.api_key;
  if (key !== API_KEY)
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
}

// ============================================================
//  CONNECT WA PER STAFF (socket room-based)
// ============================================================
function connectWhatsApp(id) {
  if (initializing[id] || clients[id]) {
    return; // Cegah double init
  }
  initializing[id] = true;
  console.log(`\n[${id}] Starting WhatsApp Web.js...`);

  const authDir = path.join(__dirname, '.wwebjs_auth', 'session-' + id);
  if (fs.existsSync(authDir)) {
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(file => {
      const filePath = path.join(authDir, file);
      try {
        const stat = fs.lstatSync(filePath);
        if (stat) {
          fs.unlinkSync(filePath);
          console.log(`[${id}] Removed stale lock: ${file}`);
        }
      } catch (e) {}
    });
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    },
  });

  qrCount[id] = 0;

  client.on('qr', async (qr) => {
    qrCount[id] = (qrCount[id] || 0) + 1;
    if (qrCount[id] > 3) {
      console.log(`[${id}] 3x QR expired. Menghapus klien secara otomatis...`);
      client.destroy();
      delete clients[id];
      delete initializing[id];
      delete qrStore[id];
      delete qrCount[id];
      const authPath = path.join(__dirname, '.wwebjs_auth', 'session-' + id);
      if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
      saveSessions();
      return;
    }

    qrStore[id] = qr;
    const img = await qrcode.toDataURL(qr);
    io.to('staff:' + id).emit('qr:' + id, img);
    console.log(`[${id}] QR Generated (Attempt ${qrCount[id]}/3)`);
  });

  client.on('ready', () => {
    console.log(`[${id}] WhatsApp READY`);
    clients[id] = client;
    delete initializing[id];
    delete qrStore[id];
    delete crashCount[id];
    saveSessions();
    io.to('staff:' + id).emit('connected:' + id, { status: 'connected' });
  });

  client.on('authenticated', () => {
    console.log(`[${id}] Authenticated`);
  });

  client.on('message', (msg) => {
    console.log(`[DEBUG] event 'message' terpanggil: from=${msg.from} body=${msg.body}`);
  });

  client.on('message_create', async (msg) => {
    // Abaikan pesan yang dikirim bot sendiri (tandai dengan zero-width space)
    if (msg.fromMe && msg.body.includes('\u200B')) return;

    // Abaikan pesan dari grup
    if (msg.from.includes('@g.us')) return;

    // Ambil nomor pengirim dengan cara yang benar
    // contact.id.user = nomor HP asli (tanpa kode negara awal yang salah)
    const contact = await msg.getContact();
    const fromNum = contact.id ? contact.id.user : msg.from.replace(/@.*/, '');
    const toNum   = msg.to   ? msg.to.replace(/@.*/,   '')                    : '';
    const ownerNumber = process.env.OWNER_WA_NUMBER;

    console.log(`[DEBUG] fromNum=${fromNum} toNum=${toNum} ownerNumber=${ownerNumber} fromMe=${msg.fromMe}`);

    // Jika OWNER_WA_NUMBER diset, hanya proses pesan dari/ke owner
    if (ownerNumber) {
      const ownerClean = ownerNumber.replace(/^0/, '62'); // normalisasi 08xx -> 628xx
      // Pesan masuk dari orang lain ke bot: fromNum harus owner
      if (!msg.fromMe && fromNum !== ownerClean) {
        console.log(`[DEBUG] Ignored: bukan dari owner (${fromNum} != ${ownerClean})`);
        return;
      }
      // Pesan keluar dari bot ke orang lain: abaikan (bukan reply kita)
      if (msg.fromMe && toNum !== ownerClean) return;
    }

    console.log(`[${id}] Pesan masuk dari ${fromNum}: ${msg.body}`);
    logChat(id, msg);

    // Simpan semua pesan masuk ke DB
    try {
      await db.query(
        'INSERT INTO wa_incoming (staff_id, from_number, body, msg_type, has_media) VALUES (?,?,?,?,?)',
        [id, fromNum, msg.body || '', msg.type || 'chat', msg.hasMedia ? 1 : 0]
      );
    } catch (e) {
      console.error('[DB] Gagal simpan incoming:', e.message);
    }

    io.emit('wa-new-incoming', { staff_id: id, from: fromNum, body: msg.body, type: msg.type });
    sendWebhook({ event: 'incoming', staff_id: id, from: fromNum, body: msg.body, type: msg.type });

    // Hanya proses AI bot jika fitur menyala
    try {
      if (AUTO_BOT_AI_ENABLED) {
        const aiBot = require('./ai-bot');
        const reply = await aiBot.processBotMessage(msg.body);
        await msg.reply(reply + '\u200B'); // Sisipkan invisible char agar bot tahu ini balasannya sendiri
      } else if (AUTO_REPLY_ENABLED && !isOwner) {
        await msg.reply('Pesan sudah diterima. Terima kasih 🙏');
      }
    } catch (e) {
      console.error(`[${id}] Gagal auto-reply/ai:`, e.message);
    }
  });

  client.on('message_ack', (msg, ack) => {
    const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read' };
    const status = statusMap[ack];
    if (!status) return;

    console.log(`[ACK] ${msg.id.id} => ${status}`);
    db.query('UPDATE wa_outgoing SET status=?, updated_at=NOW() WHERE message_id=?', [status, msg.id.id])
      .catch(err => console.error('Gagal update status:', err.message));

    io.emit('wa-status-update', { messageId: msg.id.id, status });
    sendWebhook({ event: 'ack', message_id: msg.id.id, status });
  });

  client.on('disconnected', (reason) => {
    console.log(`[${id}] Disconnected (${reason}) — reconnect in 3s...`);
    client.destroy();
    delete clients[id];
    delete initializing[id];
    io.to('staff:' + id).emit('wa-reconnecting:' + id, { reason });
    setTimeout(() => connectWhatsApp(id), 3000);
  });

  client.initialize().catch(e => {
    console.error(`[${id}] Error initializing:`, e.message);
    delete initializing[id];

    if (e.message.includes('Target closed') || e.message.includes('main frame') || e.message.includes('ECONNRESET')) {
      console.log(`[${id}] Chrome crash terdeteksi. Mencoba restart browser tanpa menghapus sesi...`);
      try { client.destroy(); } catch(err) {}
      setTimeout(() => connectWhatsApp(id), 5000);
    }
  });
}

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  socket.on('check-auth', async ({ id: rawId }) => {
    if (!rawId) return;
    // Bersihkan karakter tidak valid (spasi dll) agar whatsapp-web.js tidak crash
    const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '-');

    socket.join('staff:' + id);

    if (clients[id] || initializing[id]) {
      if (clients[id]) socket.emit('connected:' + id, { status: 'connected' });
      return;
    }
    if (qrStore[id]) {
      const img = await qrcode.toDataURL(qrStore[id]);
      socket.emit('qr:' + id, img);
      return;
    }
    connectWhatsApp(id);
  });
});

// ============================================================
//  MIDDLEWARE: auth untuk semua /api/ kecuali /health
// ============================================================
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  apiAuth(req, res, next);
});

// Rate limit pada kirim langsung
app.use(['/api/send-text', '/api/send-media', '/api/broadcast-text'], sendLimiter);

// ============================================================
//  API: HEALTH CHECK
// ============================================================
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await db.query('SELECT 1'); dbOk = true; } catch {}
  res.json({
    success: true,
    uptime: Math.floor(process.uptime()),
    db: dbOk ? 'ok' : 'error',
    clients: Object.keys(clients).length,
    client_ids: Object.keys(clients),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
//  API: LIST CLIENT AKTIF
// ============================================================
app.get('/api/clients', (req, res) => {
  res.json({ success: true, clients: Object.keys(clients).map(id => ({ id, connected: true })) });
});

// ============================================================
//  API: QUEUE STATS
// ============================================================
app.get('/api/queue/stats', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT status, COUNT(*) as count FROM wa_outgoing GROUP BY status');
    const stats = {};
    rows.forEach(r => { stats[r.status] = Number(r.count); });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: RESET FAILED → PENDING
// ============================================================
app.post('/api/queue/reset-failed', async (req, res) => {
  try {
    const { staff_id } = req.body;
    let sql  = "UPDATE wa_outgoing SET status='pending', retry_count=0, updated_at=NOW() WHERE status='failed'";
    const params = [];
    if (staff_id) { sql += ' AND staff_id=?'; params.push(staff_id); }
    const [result] = await db.query(sql, params);
    res.json({ success: true, affected: result.affectedRows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: LIST OUTGOING (dengan pagination)
// ============================================================
app.get('/api/outgoing', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(500, parseInt(req.query.limit) || 200);
    const offset = (page - 1) * limit;
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM wa_outgoing');
    const [rows] = await db.query(
      'SELECT id, staff_id, wa_number, message, msg_type, file_name, status, message_id, retry_count, scheduled_at, created_at, updated_at FROM wa_outgoing ORDER BY id DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    res.json({ success: true, data: rows, total: Number(total), page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: LIST INCOMING
// ============================================================
app.get('/api/incoming', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(500, parseInt(req.query.limit) || 100);
    const offset = (page - 1) * limit;
    const [rows] = await db.query(
      'SELECT * FROM wa_incoming ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]
    );
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM wa_incoming');
    res.json({ success: true, data: rows, total: Number(total), page, limit });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: SEND TEXT
// ============================================================
app.post('/api/send-text', async (req, res) => {
  const { id, phone, message } = req.body;
  if (!id || !phone || !message)
    return res.status(400).json({ success: false, message: 'Param kurang' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'WA belum connect' });

  const number = normalizePhone(phone);
  const waId   = number + '@c.us';

  try {
    const isReg = await client.isRegisteredUser(waId);
    if (!isReg) {
      await db.query(
        'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
        [id, number, message, 'text', 'not_registered']
      );
      return res.status(400).json({ success: false, message: 'Nomor tidak terdaftar', wa_number: number });
    }

    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
      [id, number, message, 'text', 'pending']
    );
    const dbId = result.insertId;
    const sent = await client.sendMessage(waId, message);
    await db.query("UPDATE wa_outgoing SET message_id=?, status='sent' WHERE id=?", [sent.id.id, dbId]);
    io.emit('wa-new-outgoing', { id: dbId, staff_id: id, wa_number: number, message, msg_type: 'text', status: 'sent' });
    res.json({ success: true, messageId: sent.id.id, dbId });
  } catch (err) {
    console.error('ERROR /api/send-text:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: SEND MEDIA (dengan caption opsional)
// ============================================================
app.post('/api/send-media', async (req, res) => {
  const { id, phone, filename, fileData, caption } = req.body;
  if (!id || !phone || !filename || !fileData)
    return res.status(400).json({ success: false, message: 'Param kurang' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'WA belum connect' });

  const number = normalizePhone(phone);
  const waId   = number + '@c.us';

  try {
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
      [id, number, filename, 'file', 'pending']
    );
    const dbId  = result.insertId;
    const media = new MessageMedia('*/*', fileData, filename);
    const sent  = await client.sendMessage(waId, media, caption ? { caption } : {});
    await db.query("UPDATE wa_outgoing SET message_id=?, status='sent' WHERE id=?", [sent.id.id, dbId]);
    io.emit('wa-new-outgoing', { id: dbId, staff_id: id, wa_number: number, message: filename, msg_type: 'file', status: 'sent' });
    res.json({ success: true, messageId: sent.id.id, dbId });
  } catch (err) {
    console.error('ERROR /api/send-media:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: BROADCAST TEXT (dengan delay)
// ============================================================
app.post('/api/broadcast-text', async (req, res) => {
  const { id, message, phones } = req.body;
  if (!id || !message || !Array.isArray(phones) || !phones.length)
    return res.status(400).json({ success: false, message: 'Param kurang' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'WA belum connect' });

  const results = [];
  for (let i = 0; i < phones.length; i++) {
    const number = normalizePhone(phones[i]);
    if (!number) continue;
    const waId = number + '@c.us';
    try {
      const [ins] = await db.query(
        'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
        [id, number, message, 'text', 'pending']
      );
      const dbId = ins.insertId;
      const sent = await client.sendMessage(waId, message);
      await db.query("UPDATE wa_outgoing SET message_id=?, status='sent' WHERE id=?", [sent.id.id, dbId]);
      results.push({ phone: phones[i], success: true, id: sent.id.id, dbId });
      io.emit('wa-new-outgoing', { id: dbId, staff_id: id, wa_number: number, message, msg_type: 'text', status: 'sent' });
    } catch (e) {
      results.push({ phone: phones[i], success: false, error: e.message });
    }
    if (i < phones.length - 1)
      await sleep(QUEUE_DELAY_MIN + Math.random() * (QUEUE_DELAY_MAX - QUEUE_DELAY_MIN));
  }
  res.json({ success: true, results });
});

// ============================================================
//  API: QUEUE TEXT (dengan scheduled_at opsional)
// ============================================================
app.post('/api/queue-text', async (req, res) => {
  try {
    const { staff_id, wa_number, message, scheduled_at } = req.body;
    if (!staff_id || !wa_number || !message)
      return res.status(400).json({ success: false, message: 'staff_id, wa_number, message wajib' });

    const number = normalizePhone(wa_number);
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status, scheduled_at) VALUES (?,?,?,?,?,?)',
      [staff_id, number, message, 'text', 'pending', scheduled_at || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: QUEUE PDF
// ============================================================
app.post('/api/queue-pdf', async (req, res) => {
  try {
    let { staff_id, wa_number, caption, file_name, file_base64, scheduled_at } = req.body;
    if (!staff_id || !wa_number || !file_name || !file_base64)
      return res.status(400).json({ success: false, message: 'staff_id, wa_number, file_name, file_base64 wajib' });

    const prefix = 'data:application/pdf;base64,';
    if (file_base64.startsWith(prefix)) file_base64 = file_base64.substring(prefix.length);

    const number = normalizePhone(wa_number);
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, file_name, file_mime, file_data, msg_type, status, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [staff_id, number, caption || '', file_name, 'application/pdf', file_base64, 'pdf', 'pending', scheduled_at || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: QUEUE MEDIA (gambar / file non-PDF)
// ============================================================
app.post('/api/queue-media', async (req, res) => {
  try {
    let { staff_id, wa_number, file_name, file_mime, file_base64, caption, scheduled_at } = req.body;
    if (!staff_id || !wa_number || !file_name || !file_base64)
      return res.status(400).json({ success: false, message: 'staff_id, wa_number, file_name, file_base64 wajib' });

    // strip data URI prefix if present
    if (file_base64.includes(';base64,'))
      file_base64 = file_base64.split(';base64,')[1];

    const number = normalizePhone(wa_number);
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, file_name, file_mime, file_data, msg_type, status, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [staff_id, number, caption || '', file_name, file_mime || '*/*', file_base64, 'file', 'pending', scheduled_at || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: LOGOUT
// ============================================================
app.post('/api/logout', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: 'ID wajib' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'Client tidak ditemukan' });

  try {
    await client.logout();
    await client.destroy();
    delete clients[id];
    delete qrStore[id];
    saveSessions();

    const sessPath = `.wwebjs_auth/session-${id}`;
    if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });

    io.emit('wa-client-logout', { id });
    res.json({ success: true, message: `Client ${id} berhasil logout` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: RUN CRON
// ============================================================
app.get('/api/run-cron', async (req, res) => {
  const token = req.query.token || req.headers['x-cron-token'] || '';
  if (token !== CRON_TOKEN)
    return res.status(403).json({ success: false, message: 'Forbidden' });

  try {
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const result = await processQueue(limit);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
//  QUEUE PROCESSOR (delay + retry + scheduled_at)
// ============================================================
async function processQueue(limit = 20) {
  const [rows] = await db.query(
    "SELECT * FROM wa_outgoing WHERE status='pending' AND (scheduled_at IS NULL OR scheduled_at <= NOW()) ORDER BY id ASC LIMIT ?",
    [limit]
  );

  let successCount = 0, failCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const dbId = row.id;

    try {
      const client = clients[row.staff_id];
      if (!client) {
        await db.query("UPDATE wa_outgoing SET status='failed', updated_at=NOW() WHERE id=?", [dbId]);
        failCount++;
        continue;
      }

      const number = normalizePhone(row.wa_number);
      const waId   = number + '@c.us';

      const isReg = await client.isRegisteredUser(waId);
      if (!isReg) {
        await db.query("UPDATE wa_outgoing SET status='not_registered', updated_at=NOW() WHERE id=?", [dbId]);
        failCount++;
        continue;
      }

      let sent;
      if (row.msg_type === 'pdf' || row.msg_type === 'file') {
        if (!row.file_data) {
          await db.query("UPDATE wa_outgoing SET status='failed', updated_at=NOW() WHERE id=?", [dbId]);
          failCount++;
          continue;
        }
        const mime    = row.file_mime || (row.msg_type === 'pdf' ? 'application/pdf' : '*/*');
        const media   = new MessageMedia(mime, row.file_data, row.file_name || 'file');
        const caption = row.caption || row.message || '';
        sent = await client.sendMessage(waId, media, caption ? { caption } : {});
      } else {
        sent = await client.sendMessage(waId, (row.message || '') + '\u200B');
      }

      await db.query(
        "UPDATE wa_outgoing SET status='sent', message_id=?, updated_at=NOW() WHERE id=?",
        [sent.id.id, dbId]
      );
      io.emit('wa-status-update', { dbId, messageId: sent.id.id, status: 'sent' });
      successCount++;

    } catch (e) {
      console.error('QUEUE ERROR id=', dbId, e.message);
      const retryCount = (row.retry_count || 0) + 1;
      if (retryCount < MAX_RETRY) {
        await db.query(
          'UPDATE wa_outgoing SET retry_count=?, updated_at=NOW() WHERE id=?',
          [retryCount, dbId]
        );
        console.log(`[QUEUE] id=${dbId} retry ${retryCount}/${MAX_RETRY}`);
      } else {
        await db.query(
          "UPDATE wa_outgoing SET status='failed', retry_count=?, updated_at=NOW() WHERE id=?",
          [retryCount, dbId]
        );
      }
      failCount++;
    }

    if (i < rows.length - 1)
      await sleep(QUEUE_DELAY_MIN + Math.random() * (QUEUE_DELAY_MAX - QUEUE_DELAY_MIN));
  }

  return { total: rows.length, success: successCount, failed: failCount };
}

// ============================================================
//  API: DESKTOP APP (REMINDER WIDGET)
// ============================================================
const desktopApiAuth = (req, res, next) => {
  const key = process.env.DESKTOP_API_KEY;
  if (!key) return next();
  const provided = req.headers['x-desktop-key'];
  if (provided !== key) return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
};

app.get('/api/desktop/reminders', desktopApiAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, isi, waktu, status FROM bot_reminder WHERE status = "Pending" ORDER BY waktu ASC');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/desktop/reminders', desktopApiAuth, async (req, res) => {
  try {
    const { isi, waktu } = req.body;
    if (!isi || !waktu) return res.status(400).json({ success: false, error: 'isi and waktu required' });
    
    const parsedTime = new Date(waktu);
    if (isNaN(parsedTime.getTime())) return res.status(400).json({ success: false, error: 'Invalid time format' });
    const mysqlTime = parsedTime.toISOString().slice(0, 19).replace('T', ' ');

    const [result] = await db.query('INSERT INTO bot_reminder (isi, waktu, status) VALUES (?, ?, "Pending")', [isi, mysqlTime]);
    eventBus.emit('reminders-updated');
    // Sync ke Google Sheets (fire and forget)
    const { syncToGoogleSheets } = require('./ai-bot');
    syncToGoogleSheets({
      token:  process.env.GOOGLE_SHEET_TOKEN || '',
      action: 'reminder_baru',
      id:     result.insertId,
      isi:    isi,
      waktu:  mysqlTime,
      status: 'Pending',
    });
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/desktop/reminders/:id/done', desktopApiAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('UPDATE bot_reminder SET status = "Selesai" WHERE id = ?', [id]);
    eventBus.emit('reminders-updated');
    // Sync status ke Google Sheets (fire and forget)
    const { syncToGoogleSheets } = require('./ai-bot');
    syncToGoogleSheets({
      token:  process.env.GOOGLE_SHEET_TOKEN || '',
      action: 'reminder_update',
      id:     id,
      status: 'Selesai',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/desktop/sync-from-sheets', async (req, res) => {
  try {
    const { token, type, data } = req.body;
    if (token !== process.env.SHEETS_SYNC_TOKEN) return res.status(401).json({ success: false, message: 'Unauthorized' });
    
    if (type === 'reminder_status') {
      if (data && data.id && data.status) {
        await db.query('UPDATE bot_reminder SET status = ? WHERE id = ?', [data.status, data.id]);
        eventBus.emit('reminders-updated');
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: SSE STREAM — Desktop push updates (no polling needed)
// ============================================================
app.get('/api/desktop/stream', desktopApiAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send heartbeat every 30s to keep connection alive through proxies/firewalls
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Immediately push current state so client loads data on connect
  res.write('data: update\n\n');

  // Push an update whenever reminders change (from WA bot or desktop API)
  const onUpdate = () => {
    res.write('data: update\n\n');
  };
  eventBus.on('reminders-updated', onUpdate);

  // Cleanup when client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off('reminders-updated', onUpdate);
  });
});

// ============================================================
//  API: WEBHOOK DARI GOOGLE SHEETS (Sheets → VPS → MySQL → Desktop)
//  Dipanggil oleh onEdit() di SHEET_SYNC.gs saat pengguna edit Sheets
// ============================================================
app.post('/api/webhook/sheets', async (req, res) => {
  try {
    const { sheets_token, type, ...data } = req.body;

    // Validasi token pengaman dari Google Sheets
    const expectedToken = process.env.SHEETS_WEBHOOK_TOKEN || 'RAHASIA_SHEETS_WEBHOOK_TOKEN';
    if (sheets_token !== expectedToken) {
      return res.status(401).json({ success: false, error: 'Unauthorized — token tidak cocok' });
    }

    if (type === 'reminder_edit') {
      // Pengguna mengedit baris di sheet Reminder
      const { id, field, value, isi, waktu, status } = data;
      if (!id) return res.status(400).json({ success: false, error: 'ID reminder wajib diisi' });

      if (field === 'status') {
        await db.query('UPDATE bot_reminder SET status = ? WHERE id = ?', [value, id]);
      } else if (field === 'isi') {
        await db.query('UPDATE bot_reminder SET isi = ? WHERE id = ?', [value, id]);
      } else if (field === 'waktu' && value) {
        const parsedWaktu = new Date(value);
        if (!isNaN(parsedWaktu.getTime())) {
          const mysqlWaktu = parsedWaktu.toISOString().slice(0, 19).replace('T', ' ');
          await db.query('UPDATE bot_reminder SET waktu = ? WHERE id = ?', [mysqlWaktu, id]);
        }
      }

      // Beritahu Desktop App via SSE
      eventBus.emit('reminders-updated');
      return res.json({ success: true, message: `Reminder #${id} field '${field}' diupdate` });

    } else if (type === 'saldo_edit') {
      // Pengguna mengedit saldo langsung di sheet Saldo
      const { rekening, saldo } = data;
      if (!rekening) return res.status(400).json({ success: false, error: 'Rekening wajib diisi' });

      const [existing] = await db.query('SELECT id FROM bot_rekening WHERE LOWER(nama) = ?', [rekening.toLowerCase()]);
      if (existing.length > 0) {
        await db.query('UPDATE bot_rekening SET saldo = ? WHERE LOWER(nama) = ?', [saldo, rekening.toLowerCase()]);
      } else {
        await db.query('INSERT INTO bot_rekening (nama, saldo) VALUES (?, ?)', [rekening, saldo]);
      }
      return res.json({ success: true, message: `Saldo ${rekening} diupdate ke ${saldo}` });

    } else if (type === 'transaksi_edit') {
      // Pengguna mengedit baris transaksi di sheet Transaksi
      const { id, field, value } = data;
      if (!id || !field) return res.status(400).json({ success: false, error: 'ID dan field wajib diisi' });

      // Cek apakah field valid
      const allowedFields = ['tanggal', 'waktu_transaksi', 'kategori', 'jumlah', 'tipe', 'rekening', 'keterangan'];
      if (!allowedFields.includes(field)) {
        return res.status(400).json({ success: false, error: 'Field tidak valid' });
      }

      let finalValue = value;
      // Jika field jumlah, pastikan format angka
      if (field === 'jumlah') {
        const rawNum = value.toString().replace(/Rp/gi, '').replace(/\./g, '').replace(/,/g, '.').trim();
        finalValue = parseFloat(rawNum) || 0;
      }
      // Jika tipe tanggal atau waktu, sesuaikan format
      if (field === 'tanggal' || field === 'waktu_transaksi') {
        const parsed = new Date(value);
        if (!isNaN(parsed.getTime())) {
           finalValue = parsed.toISOString().slice(0, 19).replace('T', ' ');
        }
      }

      await db.query(`UPDATE bot_transaksi SET ?? = ? WHERE id = ?`, [field, finalValue, id]);
      
      console.log(`[Sheets Webhook] Transaksi #${id} diupdate: ${field} = ${finalValue}`);
      return res.json({ success: true, message: `Transaksi #${id} field '${field}' diupdate ke MySQL` });

    } else {
      return res.status(400).json({ success: false, error: 'Type tidak dikenal: ' + type });
    }

  } catch (err) {
    console.error('[Sheets Webhook] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: TEMPLATES
// ============================================================
app.get('/api/templates', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM wa_templates ORDER BY name ASC');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name || !content)
      return res.status(400).json({ success: false, message: 'name dan content wajib' });
    await db.query(
      'INSERT INTO wa_templates (name, content) VALUES (?,?) ON DUPLICATE KEY UPDATE content=VALUES(content)',
      [name, content]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM wa_templates WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  GRACEFUL SHUTDOWN
// ============================================================
async function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received — shutting down...`);
  for (const [id, client] of Object.entries(clients)) {
    try { await client.destroy(); console.log(`[SHUTDOWN] Client ${id} destroyed`); } catch {}
  }
  try { await db.end(); } catch {}
  server.close(() => { console.log('[SHUTDOWN] Server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ============================================================
//  CRON REMINDER AI
// ============================================================
setInterval(async () => {
  try {
    const [rows] = await db.query("SELECT id, isi FROM bot_reminder WHERE status='Pending' AND waktu <= NOW()");
    if (rows.length === 0) return;
    
    const ownerNumber = process.env.OWNER_WA_NUMBER;
    if (!ownerNumber) return;

    const clientIds = Object.keys(clients);
    if (clientIds.length === 0) return;
    const client = clients[clientIds[0]];
    const waId = ownerNumber + '@c.us';

    for (const row of rows) {
      try {
        await client.sendMessage(waId, `⏰ *Reminder!*\n${row.isi}`);
        await db.query("UPDATE bot_reminder SET status='Terkirim' WHERE id=?", [row.id]);
      } catch (err) {
        console.error("Gagal kirim reminder id", row.id, err.message);
      }
    }
  } catch (err) {
    console.error("Error checking reminders:", err.message);
  }
}, 60 * 1000);

// ============================================================
//  CRON: LAPORAN KEUANGAN 08:00 PAGI
// ============================================================
const aiBot = require('./ai-bot');

cron.schedule('0 8 * * *', async () => {
  try {
    const ownerNumber = process.env.OWNER_WA_NUMBER;
    if (!ownerNumber) return;
    const clientIds = Object.keys(clients);
    if (clientIds.length === 0) return;
    const client = clients[clientIds[0]];
    const waId = ownerNumber + '@c.us';

    const now = new Date();
    const isFirstDayOfMonth = now.getDate() === 1;

    // Kalkulasi Hari Kemarin (Business Day)
    // Start: Kemarin 06:00:00, End: Hari Ini 05:59:59
    const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    const startDay = yesterday.toISOString().slice(0, 10) + ' 06:00:00';
    const endDay = now.toISOString().slice(0, 10) + ' 05:59:59';

    const [rowKemarin] = await db.query(
      'SELECT SUM(jumlah) as total FROM bot_transaksi WHERE tipe="Keluar" AND waktu_transaksi >= ? AND waktu_transaksi <= ?',
      [startDay, endDay]
    );
    const totalKemarin = Number(rowKemarin[0].total) || 0;

    const [itemsBesar] = await db.query(
      'SELECT kategori, jumlah FROM bot_transaksi WHERE tipe="Keluar" AND jumlah >= 45000 AND waktu_transaksi >= ? AND waktu_transaksi <= ?',
      [startDay, endDay]
    );

    let listBesar = '';
    if (itemsBesar.length > 0) {
      listBesar = itemsBesar.map(i => `- ${i.kategori} (Rp ${i.jumlah.toLocaleString('id-ID')})`).join('\\n');
    }

    let sysPrompt = "Kamu adalah asisten pribadi bahasa Indonesia yang gaul, seru, dan santai. Tugasmu memberikan laporan keuangan.";
    let userPrompt = `Beri tahu saya laporan keuangan kemarin. Total pengeluaran: Rp ${totalKemarin.toLocaleString('id-ID')}. `;
    if (listBesar) {
      userPrompt += `Pengeluaran besar (>45rb) yang harus dinotis:\\n${listBesar}. Nasihati saya santai soal pengeluaran ini.`;
    } else {
      userPrompt += `Tidak ada pengeluaran besar (di atas 45rb) kemarin, puji saya dengan santai.`;
    }

    // Jika ini tanggal 1, berikan juga Laporan Bulan Lalu
    if (isFirstDayOfMonth) {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const startMonth = lastMonth.toISOString().slice(0, 10) + ' 06:00:00';
      // End month is 1st of current month at 05:59:59
      const endMonth = now.toISOString().slice(0, 10) + ' 05:59:59';
      
      const [rowBulanLalu] = await db.query(
        'SELECT SUM(jumlah) as total FROM bot_transaksi WHERE tipe="Keluar" AND waktu_transaksi >= ? AND waktu_transaksi <= ?',
        [startMonth, endMonth]
      );
      const totalBulanLalu = Number(rowBulanLalu[0].total) || 0;
      userPrompt += `\\n\\nOh ya, ini tanggal 1! Tolong kasih tahu juga bahwa total pengeluaran SUTU BULAN PENUH kemarin adalah Rp ${totalBulanLalu.toLocaleString('id-ID')}. Sampaikan dengan gaya heboh atau kaget (tergantung nominalnya, kalau di atas 2 juta agak omelin).`;
    }

    const aiMessage = await aiBot.panggilGroqText(sysPrompt, userPrompt);
    await client.sendMessage(waId, "☀️ *Laporan Pagi*\n\n" + aiMessage);
    console.log('[CRON 08:00] Laporan pagi berhasil dikirim.');

  } catch (err) {
    console.error('[CRON 08:00] Error:', err.message);
  }
}, {
  scheduled: true,
  timezone: "Asia/Jakarta"
});

// ============================================================
//  RUN SERVER + AUTO-START
// ============================================================
server.listen(PORT, () => {
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`📱 QR Scanner:  http://localhost:${PORT}/qr-scanner.html`);
  console.log(`📊 Dashboard:   http://localhost:${PORT}/wa-dashboard.html`);
  console.log(`📊 Monitoring:  http://localhost:${PORT}/outgoing-dashboard.html`);
  console.log(`❤  Health:     http://localhost:${PORT}/api/health`);
  if (API_KEY)     console.log(`🔐 API Key aktif`);
  if (WEBHOOK_URL) console.log(`🔗 Webhook: ${WEBHOOK_URL}`);

  // Auto-reconnect staff dari sesi sebelumnya
  const saved = loadSessions();
  if (saved.length > 0) {
    console.log(`\n[AUTO-START] Reconnecting: ${saved.join(', ')}`);
    saved.forEach(id => connectWhatsApp(id));
  }
});
