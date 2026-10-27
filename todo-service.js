'use strict';
const { sqlTime, isoFromSql, localParts, reminderDay, nextReminder, formatWib } = require('./todo-time');
const ACTIVE = 'Menunggu Waktu', DONE = 'Tugas Selesai';
function validTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Judul tugas harus 1–500 karakter tanpa baris baru/tab.');
  return value.trim();
}
function validId(value) { if (!/^[1-9]\d{0,9}$/.test(String(value))) throw new Error('ID tugas tidak valid.'); return +value; }
function createTodoService({ db, eventBus, syncSheets = async () => {} }) {
  const changed = () => { eventBus.emit('todolists-updated'); eventBus.emit('reminders-updated'); };
  function toTask(row) {
    const task = { id: row.id, title: row.isi, deadline: isoFromSql(row.waktu), createdAt:row.created_at?isoFromSql(row.created_at):null, done: row.status === DONE, archived: !!row.archived_at, displayVersion: row.display_version, leadDays: row.lead_days, revision: row.revision, lastNotifiedDay: row.last_day || null };
    task.nextReminder = nextReminder(task); return task;
  }
  async function list() {
    const [rows] = await db.query(`SELECT t.*, DATE_FORMAT(t.waktu, '%Y-%m-%d %H:%i:%s') AS waktu, DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      (SELECT DATE_FORMAT(MAX(n.local_day), '%Y-%m-%d') FROM todo_notifications n WHERE n.task_id=t.id AND n.state='sent') AS last_day
      FROM bot_todolist t ORDER BY t.waktu, t.id`);
    return rows.map(toTask);
  }
  function sheet(data) { Promise.resolve(syncSheets(data)).catch(() => console.error('[TodoList] Sinkronisasi Sheets gagal.')); }
  async function create(input) {
    const title = validTitle(input.title), deadline = sqlTime(input.deadline);
    const [result] = await db.query('INSERT INTO bot_todolist(isi,waktu,status,lead_days,created_at) VALUES (?,?,?,2,UTC_TIMESTAMP())', [title, deadline, ACTIVE]);
    changed(); sheet({ token: process.env.GOOGLE_SHEET_TOKEN || '', action: 'reminder_baru', id: result.insertId, isi: title, waktu: deadline, status: ACTIVE });
    return { id: result.insertId };
  }
  async function update(id, input, { completeOnly = false } = {}) {
    id = validId(id);
    const fields = [], params = [];
    if (!completeOnly && input.title !== undefined) { fields.push('isi=?'); params.push(validTitle(input.title)); }
    if (!completeOnly && input.deadline !== undefined) { fields.push('waktu=?'); params.push(sqlTime(input.deadline)); }
    if (typeof input.done === 'boolean') { if (completeOnly && input.done !== true) throw new Error('Penghubung hanya boleh menandai selesai.'); fields.push('status=?'); params.push(input.done ? DONE : ACTIVE); }
    if (!fields.length) throw new Error('Tidak ada perubahan tugas.');
    let condition = 'id=? AND archived_at IS NULL'; params.push(id);
    if (input.revision !== undefined && !completeOnly) { condition += ' AND revision=?'; params.push(Number(input.revision)); }
    const [result] = await db.query(`UPDATE bot_todolist SET ${fields.join(',')}, revision=revision+1 WHERE ${condition}`, params);
    if (!result.affectedRows) {
      if(completeOnly){const [found]=await db.query('SELECT archived_at FROM bot_todolist WHERE id=?',[id]);if(found[0]?.archived_at)return {success:true,applied:false};if(!found.length){const err=new Error('Tugas tidak ditemukan.');err.status=404;throw err;}}
      const err = new Error('Tugas berubah, sudah diarsipkan, atau tidak ditemukan. Muat ulang daftar.'); err.status = 409; throw err;
    }
    changed();
    const [rows] = await db.query('SELECT isi, DATE_FORMAT(waktu, "%Y-%m-%d %H:%i:%s") AS waktu, status FROM bot_todolist WHERE id=?', [id]);
    sheet({ token: process.env.GOOGLE_SHEET_TOKEN || '', action: 'reminder_update', id, ...rows[0] });
    return { success: true };
  }
  async function archive(id, input = {}, { fromNusa = false, restore = false } = {}) {
    id=validId(id);
    if(fromNusa && (!Number.isSafeInteger(input.displayVersion) || input.displayVersion<1))throw new Error('Versi tampilan tugas wajib disertakan.');
    const conn=await db.getConnection();let row;
    try{
      await conn.beginTransaction();
      const [rows]=await conn.query('SELECT id, status, archived_at, revision, display_version FROM bot_todolist WHERE id=? FOR UPDATE',[id]);row=rows[0];
      if(!row){const err=new Error('Tugas tidak ditemukan.');err.status=404;throw err;}
      // Old offline deletions must not undo a deliberate restore performed later on the web.
      if(fromNusa && row.display_version!==input.displayVersion){await conn.rollback();return {success:true,applied:false};}
      if(input.revision!==undefined && Number(input.revision)!==row.revision){const err=new Error('Tugas berubah. Muat ulang daftar.');err.status=409;throw err;}
      if(restore ? !row.archived_at : !!row.archived_at){await conn.rollback();return {success:true,applied:false};}
      await conn.query(restore
        ? 'UPDATE bot_todolist SET archived_at=NULL, display_version=display_version+1, revision=revision+1 WHERE id=?'
        : 'UPDATE bot_todolist SET archived_at=UTC_TIMESTAMP(), revision=revision+1 WHERE id=?',[id]);
      await conn.commit();
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
    changed();
    sheet({token:process.env.GOOGLE_SHEET_TOKEN||'',action:'reminder_update',id,status:restore?row.status:'Diarsipkan'});
    return {success:true,applied:true};
  }
  async function notifyDue(send,now=new Date()){
    const tasks=(await list()).filter(t=>!t.done&&!t.archived&&+new Date(t.deadline)<=+now&&+new Date(t.deadline)>=+now-86400000);
    for(const task of tasks){
      const due=sqlTime(task.deadline);
      const [claim]=await db.query('INSERT IGNORE INTO todo_due_notifications(task_id,due_time,state) VALUES (?,?,"sending")',[task.id,due]);
      if(!claim.affectedRows)continue;
      const conn=await db.getConnection();
      try{
        await conn.beginTransaction();
        const [rows]=await conn.query('SELECT status, archived_at, isi, DATE_FORMAT(waktu,"%Y-%m-%d %H:%i:%s") AS waktu FROM bot_todolist WHERE id=? FOR UPDATE',[task.id]);
        const row=rows[0];
        if(!row||row.status===DONE||row.archived_at||row.waktu!==due){await conn.rollback();await db.query('DELETE FROM todo_due_notifications WHERE task_id=? AND due_time=?',[task.id,due]);continue;}
        await send(`⏰ *Waktu TodoList!*\n${row.isi}\nJadwal: ${formatWib(task.deadline)}\nCentang selesai atau balas: selesai tugas #${task.id}\u200B`);
        await conn.query('UPDATE todo_due_notifications SET state="sent" WHERE task_id=? AND due_time=?',[task.id,due]);
        // A task due exactly at noon uses the same delivery for its daily reminder.
        const local=localParts(new Date(task.deadline));
        if(local.slice(11)==='12:00')await conn.query('INSERT IGNORE INTO todo_notifications(task_id,local_day,state) VALUES (?,?,"sent")',[task.id,local.slice(0,10)]);
        await conn.commit();
      }catch(e){await conn.rollback();await db.query('UPDATE todo_due_notifications SET state="uncertain" WHERE task_id=? AND due_time=?',[task.id,due]);console.error('[TodoList] Pengingat waktu belum dapat dipastikan untuk tugas',task.id);}
      finally{conn.release();}
    }
  }
  // One durable claim per task/day. A delivery with an uncertain outcome is not retried automatically.
  async function notifyDaily(send, now = new Date()) {
    const clock = localParts(now); if (clock.slice(11) < '12:00') return;
    const today = clock.slice(0, 10);
    const tasks = (await list()).filter(t => !t.done && !t.archived && reminderDay(t.deadline, t.leadDays) <= today);
    for (const task of tasks) {
      const [claim] = await db.query('INSERT IGNORE INTO todo_notifications(task_id,local_day,state) VALUES (?,?,"sending")', [task.id, today]);
      if (!claim.affectedRows) continue;
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const [fresh] = await conn.query('SELECT status, archived_at, isi, DATE_FORMAT(waktu, "%Y-%m-%d %H:%i:%s") AS waktu, lead_days FROM bot_todolist WHERE id=? FOR UPDATE', [task.id]);
        if (!fresh[0] || fresh[0].archived_at || fresh[0].status === DONE || reminderDay(isoFromSql(fresh[0].waktu), fresh[0].lead_days) > today) {
          await conn.rollback(); await db.query('DELETE FROM todo_notifications WHERE task_id=? AND local_day=?', [task.id, today]); continue;
        }
        const title = fresh[0].isi, deadline = isoFromSql(fresh[0].waktu);
        await send(`📋 *TodoList*\n${title}\nDeadline: ${formatWib(deadline)}${+new Date(deadline) < +now ? '\n⚠️ Sudah lewat deadline.' : ''}\nCentang selesai di Nusa/web atau balas: selesai tugas #${task.id}\u200B`);
        await conn.query('UPDATE todo_notifications SET state="sent" WHERE task_id=? AND local_day=?', [task.id, today]); await conn.commit();
      } catch (e) {
        await conn.rollback(); await db.query('UPDATE todo_notifications SET state="uncertain" WHERE task_id=? AND local_day=?', [task.id, today]);
        console.error('[TodoList] Pengiriman belum dapat dipastikan untuk tugas', task.id);
      } finally { conn.release(); }
    }
  }
  return { list, create, update, archive, notifyDue, notifyDaily, changed };
}
function registerTodoRoutes(app, service, { webGuard, webCsrf, syncGuard, eventBus, protectStream = (req,res,next)=>next() }) {
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
  app.get('/api/todolist', webGuard, wrap(async (req, res) => res.json({ data: await service.list() })));
  app.post('/api/todolist', webGuard, webCsrf, wrap(async (req, res) => res.status(201).json(await service.create(req.body))));
  app.patch('/api/todolist/:id', webGuard, webCsrf, wrap(async (req, res) => res.json(await service.update(req.params.id, req.body))));
  app.post('/api/todolist/:id/archive', webGuard, webCsrf, wrap(async (req,res)=>res.json(await service.archive(req.params.id,req.body))));
  app.post('/api/todolist/:id/restore', webGuard, webCsrf, wrap(async (req,res)=>res.json(await service.archive(req.params.id,req.body,{restore:true}))));
  app.get('/api/nusa/tasks', syncGuard, wrap(async (req, res) => { res.setHeader('Cache-Control','no-store'); res.json({ protocolVersion:2, data: await service.list() }); }));
  app.post('/api/nusa/tasks/:id/done', syncGuard, wrap(async (req, res) => res.json(await service.update(req.params.id, { done: true }, { completeOnly: true }))));
  app.post('/api/nusa/tasks/:id/archive', syncGuard, wrap(async (req,res)=>res.json(await service.archive(req.params.id,req.body,{fromNusa:true}))));
  function stream(req, res) {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const update = () => res.write('data: update\n\n'); update();
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
    eventBus.on('todolists-updated', update);
    req.on('close', () => { clearInterval(heartbeat); eventBus.off('todolists-updated', update); });
  }
  app.get('/api/nusa/stream', syncGuard, stream);
  app.get('/api/todolist/stream', webGuard, protectStream, stream);
}
module.exports = { createTodoService, registerTodoRoutes, validTitle, validId, ACTIVE, DONE };
