'use strict';
const crypto = require('node:crypto');
const OTPAuth = require('otpauth');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const COOKIE = 'gateway_session';
const digest = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function equal(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); }
function createAuth({ db, env = process.env, now = () => new Date() }) {
  const publicUrl = new URL(env.PUBLIC_ORIGIN || 'http://localhost:3030');
  if (publicUrl.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(publicUrl.hostname)) throw new Error('PUBLIC_ORIGIN publik harus HTTPS.');
  const secure = publicUrl.protocol === 'https:';
  const liveSessions = new Map();
  function invalidate(hash) { const watchers = liveSessions.get(hash); if (watchers) for (const close of [...watchers]) close(); }
  function watch(hash, close) { if (!liveSessions.has(hash)) liveSessions.set(hash,new Set()); liveSessions.get(hash).add(close); return () => { const set=liveSessions.get(hash); set?.delete(close); if(!set?.size)liveSessions.delete(hash); }; }
  const encryptionKey = Buffer.from(env.WEB_AUTH_ENCRYPTION_KEY || '', 'hex');
  if (encryptionKey.length !== 32) throw new Error('WEB_AUTH_ENCRYPTION_KEY harus 64 karakter hex acak.');
  function seal(value) {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  function open(value) {
    const b = Buffer.from(value, 'base64'); const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
  }
  function cookieToken(req) {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)gateway_session=([a-f0-9]{64})(?:;|$)/);
    return m ? m[1] : '';
  }
  async function session(req) {
    const token = cookieToken(req); if (!token) return null;
    const [rows] = await db.query('SELECT token_hash, admin_id, stage, csrf FROM web_sessions WHERE token_hash=? AND expires_at > UTC_TIMESTAMP()', [digest(token)]);
    return rows[0] || null;
  }
  function setCookie(res, token, seconds) { res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`); }
  async function issue(req, res, adminId, stage) {
    const old = cookieToken(req); if (old) { await db.query('DELETE FROM web_sessions WHERE token_hash=?', [digest(old)]); invalidate(digest(old)); }
    const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(32).toString('hex');
    const seconds = stage === 'full' ? 8 * 3600 : 600;
    await db.query('INSERT INTO web_sessions (token_hash, admin_id, stage, csrf, expires_at) VALUES (?,?,?,?,?)', [digest(token), adminId, stage, csrf, new Date(+now() + seconds * 1000)]);
    setCookie(res, token, seconds); return { stage, csrf };
  }
  function validOrigin(req) { return req.headers.origin === publicUrl.origin; }
  async function load(req, res, next) { try { req.webSession = await session(req); next(); } catch { res.status(503).json({ error: 'Sistem login belum siap.' }); } }
  function requireFull(req, res, next) {
    if (req.webSession?.stage === 'full') return next();
    if (req.accepts('html') && !req.path.startsWith('/api')) return res.redirect('/login.html');
    res.status(401).json({ error: 'Silakan login.' });
  }
  function csrf(req, res, next) {
    if (!validOrigin(req) || !equal(req.headers['x-csrf-token'], req.webSession?.csrf)) return res.status(403).json({ error: 'Permintaan tidak valid. Muat ulang halaman.' });
    next();
  }
  const limiter = rateLimit({ windowMs: 15 * 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' } });
  function register(app) {
    app.use('/api/auth', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, load);
    app.get('/api/auth/session', async (req, res) => {
      if (req.webSession) return res.json({ stage:req.webSession.stage, csrf:req.webSession.csrf });
      const [rows]=await db.query('SELECT totp_secret IS NOT NULL AS configured FROM web_admin WHERE id=1');
      res.json({stage:'none',configured:!!rows[0]?.configured});
    });
    app.post('/api/auth/bootstrap', limiter, async (req, res) => {
      if (!validOrigin(req) || !equal(req.body.token, env.WEB_SETUP_TOKEN)) return res.sendStatus(403);
      // Legacy NOT NULL fields are retained for schema compatibility, not used as credentials.
      await db.query('INSERT IGNORE INTO web_admin(id,username,password_hash) VALUES (1,?,?)', ['Pemilik',crypto.randomBytes(32).toString('hex')]);
      const [rows]=await db.query('SELECT totp_secret FROM web_admin WHERE id=1');
      if(rows[0]?.totp_secret)return res.status(409).json({error:'Authenticator sudah aktif. Masuk dengan kode 6 digit.'});
      res.json(await issue(req,res,1,'enroll'));
    });
    app.post('/api/auth/login', limiter, async (req, res) => {
      if (!validOrigin(req)) return res.sendStatus(403);
      await verify(req,res,false);
    });
    app.post('/api/auth/enroll', limiter, csrf, async (req, res) => {
      if (req.webSession?.stage !== 'enroll') return res.sendStatus(403);
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT username, totp_secret, totp_pending FROM web_admin WHERE id=? FOR UPDATE', [req.webSession.admin_id]);
        const admin = rows[0]; if (!admin || admin.totp_secret) {await conn.rollback();return res.sendStatus(403);}
        const secret = admin.totp_pending ? open(admin.totp_pending) : new OTPAuth.Secret({ size: 20 }).base32;
        if (!admin.totp_pending) await conn.query('UPDATE web_admin SET totp_pending=? WHERE id=?', [seal(secret), req.webSession.admin_id]);
        await conn.commit();
        const totp = new OTPAuth.TOTP({ issuer: 'WA Gateway', label: admin.username, algorithm: 'SHA1', digits: 6, period: 30, secret });
        res.json({ qr: await qrcode.toDataURL(totp.toString()), secret });
      }catch(e){await conn.rollback();throw e;}finally{conn.release();}
    });
    app.post('/api/auth/verify', limiter, csrf, async (req, res) => {
      if(req.webSession?.stage!=='enroll')return res.sendStatus(403);
      await verify(req,res,true);
    });
    app.post('/api/auth/logout', csrf, async (req, res) => {
      if (req.webSession) { await db.query('DELETE FROM web_sessions WHERE token_hash=?', [req.webSession.token_hash]); invalidate(req.webSession.token_hash); }
      setCookie(res, '', 0); res.json({ success: true });
    });
  }
  async function verify(req,res,enrolling) {
      const adminId=enrolling ? req.webSession.admin_id : 1;
      const conn = await db.getConnection(); let recoveryCodes;
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT * FROM web_admin WHERE id=? FOR UPDATE', [adminId]); const admin = rows[0];
        if(!admin || (!enrolling && !admin.totp_secret)){await conn.rollback();return res.status(503).json({error:'Authenticator belum aktif. Buka tautan pengaturan pribadi.'});}
        const lockedUntil=admin.locked_until instanceof Date ? admin.locked_until : new Date(String(admin.locked_until).replace(' ','T')+'Z');
        if (admin.locked_until && +lockedUntil > +now()) { await conn.rollback(); return res.status(429).json({ error: 'Login dikunci sementara. Coba lagi 15 menit.' }); }
        let ok = false;
        const code = String(req.body.code || '').replace(/\s/g, '');
        if (/^\d{6}$/.test(code)) {
          const encrypted = enrolling ? admin.totp_pending : admin.totp_secret;
          if (!encrypted || (enrolling && admin.totp_secret)) { await conn.rollback(); return res.sendStatus(403); }
          const totp = new OTPAuth.TOTP({ secret: open(encrypted), algorithm: 'SHA1', digits: 6, period: 30 });
          const delta = totp.validate({ token: code, timestamp: +now(), window: 1 });
          const step = Math.floor(+now() / 30000) + (delta || 0);
          ok = delta !== null && step > Number(admin.totp_last_step);
          if (ok) await conn.query('UPDATE web_admin SET totp_last_step=? WHERE id=?', [step, admin.id]);
          if (ok && enrolling) {
            await conn.query('UPDATE web_admin SET totp_secret=totp_pending, totp_pending=NULL WHERE id=?', [admin.id]);
            recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(8).toString('hex'));
            for (const item of recoveryCodes) await conn.query('INSERT INTO web_recovery_codes(code_hash,admin_id) VALUES (?,?)', [digest(item), admin.id]);
          }
        } else if (!enrolling && /^[a-f0-9]{16}$/i.test(code)) {
          const [result] = await conn.query('DELETE FROM web_recovery_codes WHERE code_hash=? AND admin_id=?', [digest(code.toLowerCase()), admin.id]); ok = result.affectedRows === 1;
        }
        if (!ok) {
          await conn.query('UPDATE web_admin SET failed_attempts=failed_attempts+1, locked_until=IF(failed_attempts>=10, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), locked_until) WHERE id=?', [admin.id]);
          await conn.commit(); return res.status(401).json({ error: 'Kode salah, kedaluwarsa, atau sudah digunakan.' });
        }
        await conn.query('UPDATE web_admin SET failed_attempts=0, locked_until=NULL WHERE id=?', [admin.id]); await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
      const result = await issue(req, res, adminId, 'full'); res.json({ ...result, recoveryCodes });
  }
  async function socketAuth(socket, next) {
    try {
      if (socket.handshake.headers.origin && socket.handshake.headers.origin !== publicUrl.origin) return next(new Error('Forbidden'));
      const sess = await session(socket.request);
      if (sess?.stage !== 'full') return next(new Error('Unauthorized'));
      const unwatch=watch(sess.token_hash,()=>socket.disconnect(true));
      const recheck = setInterval(async () => { try { if ((await session(socket.request))?.stage !== 'full') socket.disconnect(true); } catch { socket.disconnect(true); } }, 30000);
      socket.on('disconnect', () => {clearInterval(recheck);unwatch();}); next();
    } catch { next(new Error('Unauthorized')); }
  }
  function protectStream(req,res,next) {
    const close=()=>res.end();const unwatch=watch(req.webSession.token_hash,close);
    const interval=setInterval(async()=>{try{if((await session(req))?.stage!=='full')close();}catch{close();}},30000);
    req.on('close',()=>{clearInterval(interval);unwatch();});next();
  }
  return { register, load, requireFull, csrf, session, socketAuth, protectStream, equal, seal, open, publicOrigin: publicUrl.origin };
}
module.exports = { createAuth, equal, digest };
