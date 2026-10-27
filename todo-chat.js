'use strict';
const { naturalParts, localParts, parseDeadline, formatWib } = require('./todo-time');
function createTodoChat({ db, service, classify, now = () => new Date() }) {
  const queues = new Map();
  async function saveDraft(chatId,draft){
    await db.query('INSERT INTO todo_conversations(chat_id,draft,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) ON DUPLICATE KEY UPDATE draft=VALUES(draft), expires_at=VALUES(expires_at)', [chatId, JSON.stringify(draft)]);
  }
  async function process(chatId, text, existingIntent) {
    const [rows] = await db.query('SELECT draft FROM todo_conversations WHERE chat_id=? AND expires_at>UTC_TIMESTAMP()', [chatId]);
    let draft = rows[0] ? (typeof rows[0].draft === 'string' ? JSON.parse(rows[0].draft) : rows[0].draft) : null;
    if (draft && /^(batal|batalkan|cancel)$/i.test(text.trim())) { await db.query('DELETE FROM todo_conversations WHERE chat_id=?', [chatId]); return 'Pembuatan TodoList dibatalkan.'; }
    const shortReply=text.trim().toLowerCase().replace(/[?!.,]+$/,'').replace(/\s+/g,' ');
    const dateReply=/^(?:(?:iya|ya|untuk|deadline(?:nya)?|tanggalnya)\s+)?(?:hari ini|besok|lusa|(?:(?:\d{1,3}|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)\s+hari\s+(?:lagi|ke depan))|(?:minggu depan(?: (?:tanggal|tgl) \d{1,2})?)|(?:tanggal|tgl) \d{1,2}(?: [a-z]+(?: 20\d\d)?)?|\d{4}-\d\d-\d\d)(?:\s+(?:jam|pukul)\s+\d{1,2}(?:[.:]\d{2})?(?:\s+(?:pagi|siang|sore|malam|nanti))*)?$/i.test(shortReply);
    const timeReply=/^(?:(?:iya|ya|sebelum|sebelom|seblm)\s+)?(?:(?:jam|pukul)\s+)?\d{1,2}(?:[.:]\d{2})?(?:\s+(?:pagi|siang|sore|malam|nanti))*$|^(pagi|siang|sore|malam)$/i.test(shortReply);
    const retryReply=draft?.date && draft?.time && /^(coba lagi|simpan(?: lagi)?|ulangi|ulang|lanjut)$/i.test(shortReply);
    const intent = existingIntent || (draft && (dateReply || timeReply || retryReply) ? {intent:'lanjut_todolist'} : await classify(text, draft));
    if (['list_todolist','list_reminder'].includes(intent.intent)) {
      const active = (await service.list()).filter(t => !t.done && !t.archived);
      return active.length ? '📋 *TodoList aktif*\n' + active.map(t => `#${t.id} ${t.title}\n${formatWib(t.deadline)}`).join('\n\n') : '✅ Semua tugas sudah selesai.';
    }
    if (['selesai_todolist','selesai_reminder'].includes(intent.intent)) {
      const all = (await service.list()).filter(t => !t.done && !t.archived);
      const id = text.match(/#(\d+)/) || String(intent.keyword || '').match(/^(\d+)$/);
      const matches = id ? all.filter(t => t.id === +id[1]) : all.filter(t => intent.keyword && t.title.toLowerCase().includes(String(intent.keyword).toLowerCase()));
      if (matches.length !== 1) return matches.length ? 'Ada beberapa tugas yang cocok. Balas selesai tugas #ID:\n' + matches.map(t => `#${t.id} ${t.title}`).join('\n') : 'Tugas aktif tidak ditemukan. Ketik daftar TodoList untuk melihat ID.';
      await service.update(matches[0].id, { done: true }); return `✅ TodoList “${matches[0].title}” selesai. Pengingat WA dihentikan.`;
    }
    if (!['tambah_todolist','tambah_reminder','lanjut_todolist'].includes(intent.intent)) return { nonTodoIntent: intent };
    draft ||= { title: null, date: null, time: null, history: [], reference: now().toISOString() };
    let parseText=text;
    if(/^\d{1,2}$/.test(shortReply))parseText=(draft.date?'jam ':'tanggal ')+shortReply;
    let parts = naturalParts(parseText, now());
    if(!draft.time && !parts.time && dateReply){
      const previous=draft.history.slice().reverse().find(t=>/\b(?:jam|pukul)\s*\d{1,2}/i.test(t));
      if(previous){const recovered=naturalParts(previous,new Date(draft.reference||now()));if(recovered.time)draft.time=recovered.time;}
    }
    // Recover an ambiguous hour when the next message is just 'pagi'/'sore'/etc.
    if(!parts.time && /^(pagi|siang|sore|malam)$/i.test(shortReply)){
      const previous=draft.history.slice().reverse().find(t=>/\b(?:jam|pukul)\s*\d{1,2}/i.test(t));
      if(previous)parts=naturalParts(previous+' '+shortReply,now());
    }
    // Explicit new statements override the draft; don't silently manufacture missing date/time.
    if (intent.isi && intent.isi !== 'null') draft.title = intent.isi;
    if (parts.date || intent.tanggal) draft.date = parts.date || intent.tanggal;
    if (parts.time || intent.jam) draft.time = parts.time || intent.jam;
    if (parts.ambiguous || (intent.jam_ambigu === true && !parts.time)) draft.time = null;
    if (/minggu depan/i.test(text) && !parts.date && !/senin|selasa|rabu|kamis|jumat|sabtu|minggu depan hari minggu/i.test(text)) draft.date = null;
    if (parts.conflict) draft.date = null;
    draft.history.push(parseText.slice(0, 3000)); draft.history = draft.history.slice(-8);
    let question;
    if (!draft.title) question = 'Tugas apa yang ingin dimasukkan ke TodoList?';
    else if (parts.conflict) question = 'Tanggal itu tidak cocok dengan minggu yang disebutkan. Deadline tanggal berapa tepatnya?';
    else if (!draft.date) question = `Deadline “${draft.title}” tanggal berapa?`;
    else if (!draft.time) question = parts.ambiguous ? 'Jam berapa tepatnya—pagi, siang, sore, atau malam?' : 'Deadline jam berapa? Sebutkan pagi/siang/sore/malam atau format 24 jam.';
    if (!question) {
      let deadline;
      try { deadline = parseDeadline(draft.date + 'T' + draft.time); }
      catch {
        try{parseDeadline(draft.date+'T00:00');}catch{draft.date=null;}
        try{parseDeadline('2000-01-01T'+draft.time);}catch{draft.time=null;}
        question=!draft.date?'Tanggalnya belum valid. Deadline tanggal berapa tepatnya?':'Jamnya belum valid. Sebutkan jam yang dimaksud, ya.';
      }
      if(deadline && +deadline<=+now())question='Waktu itu sudah lewat. Deadline tanggal dan jam berapa yang kamu maksud?';
      if(deadline && !question){
        // Preserve the understood schedule before attempting a write. Storage failures are not date errors.
        await saveDraft(chatId,draft);
        let result;
        try{result=await service.create({title:draft.title,deadline:deadline.toISOString()});}
        catch(error){console.error('[TodoList] Gagal menyimpan tugas:',error.code||error.name);return `Jadwal “${draft.title}” sudah terbaca: ${formatWib(deadline)}, tetapi tugas belum berhasil disimpan. Balas “coba lagi” untuk mengulangi penyimpanan.`;}
        await db.query('DELETE FROM todo_conversations WHERE chat_id=?',[chatId]);
        return `📋 TodoList #${result.id} disimpan: ${draft.title}\nJadwal: ${formatWib(deadline)}\nPengingat pada jadwal tersebut, ditambah pengingat harian 12.00 WIB mulai H-2 sampai selesai.`;
      }
    }
    await saveDraft(chatId,draft);
    return question;
  }
  return {
    async handle(chatId, text, intent) {
      // Messages from the same chat are processed in order, including rapid date/time replies.
      const previous = queues.get(chatId) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => process(chatId, text, intent)); queues.set(chatId, next);
      try { return await next; } finally { if (queues.get(chatId) === next) queues.delete(chatId); }
    },
    contextPrompt(draft) { return `Saat ini ${localParts(now())} WIB. Draft TodoList: ${JSON.stringify(draft)}.`; }
  };
}
module.exports = { createTodoChat };
