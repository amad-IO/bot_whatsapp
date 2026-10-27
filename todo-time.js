'use strict';
const DAY = 86400000;
const WIB = 7 * 3600000;
function localParts(now = new Date()) { return new Date(+now + WIB).toISOString().slice(0, 16); }
function parseDeadline(value) {
  if (typeof value !== 'string') throw new Error('Deadline wajib berupa tanggal dan jam.');
  let s = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(s)) s += ':00+07:00';
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(s)) throw new Error('Tanggal/jam harus menyertakan zona waktu atau memakai format YYYY-MM-DD HH:mm WIB.');
  const d = new Date(s);
  if (!Number.isFinite(+d)) throw new Error('Deadline tidak valid.');
  const input = s.slice(0, 10);
  const local = new Date(input + 'T00:00:00Z');
  if (local.toISOString().slice(0, 10) !== input || Number(s.slice(11, 13)) > 23 || Number(s.slice(14, 16)) > 59) throw new Error('Tanggal/jam tidak valid.');
  return d;
}
function sqlTime(value) { return parseDeadline(value).toISOString().slice(0, 19).replace('T', ' '); }
function isoFromSql(value) { return value instanceof Date ? value.toISOString() : String(value).replace(' ', 'T') + 'Z'; }
function formatWib(value) { return new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB'; }
function reminderDay(deadline, lead = 2) { return new Date(+new Date(deadline) + WIB - lead * DAY).toISOString().slice(0, 10); }
function nextReminder(task, now = new Date()) {
  if (task.done || task.archived) return null;
  const today = localParts(now).slice(0, 10);
  let day = reminderDay(task.deadline, task.leadDays);
  if (day < today) day = today;
  if (day === today && (task.lastNotifiedDay === today || localParts(now).slice(11) > '12:00')) day = new Date(Date.parse(today + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
  return day + 'T12:00:00+07:00';
}
// Deterministic overrides for the user's date/time conventions. Missing components stay missing.
function naturalParts(text, now = new Date()) {
  const s = String(text).toLowerCase();
  const today = localParts(now).slice(0, 10);
  const base = new Date(today + 'T00:00:00Z');
  let date = null, time = null, ambiguous = false, conflict = false;
  const explicit = s.match(/\b(\d{4}-\d\d-\d\d)\b/);
  const nth = s.match(/\b(?:tanggal|tgl)\s*(\d{1,2})\b/);
  const daysAhead=s.match(/\b(\d{1,3}|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)\s+hari\s+(?:lagi|ke depan)\b/);
  const numberWords={satu:1,dua:2,tiga:3,empat:4,lima:5,enam:6,tujuh:7,delapan:8,sembilan:9,sepuluh:10};
  const relative = daysAhead ? (numberWords[daysAhead[1]]??Number(daysAhead[1])) : /\blusa\b/.test(s) ? 2 : /\bbesok\b/.test(s) ? 1 : /\bhari ini\b/.test(s) ? 0 : null;
  if (explicit) date = explicit[1];
  else if (relative !== null) date = new Date(+base + relative * DAY).toISOString().slice(0, 10);
  if (/minggu depan/.test(s)) {
    const monday = new Date(+base + (8 - (base.getUTCDay() || 7)) * DAY);
    if (nth) {
      const match = Array.from({ length: 7 }, (_, n) => new Date(+monday + n * DAY)).find(d => d.getUTCDate() === +nth[1]);
      if (match) date = match.toISOString().slice(0, 10); else conflict = true;
    }
  } else if (nth && !date) {
    const months = ['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember'];
    const month = months.findIndex(m => s.includes(m));
    const year = +(s.match(/\b(20\d{2})\b/) || [null, base.getUTCFullYear()])[1];
    let d = new Date(Date.UTC(year, month < 0 ? base.getUTCMonth() : month, +nth[1]));
    if (month < 0 && +d < +base) d = new Date(Date.UTC(year, base.getUTCMonth() + 1, +nth[1]));
    if (d.getUTCDate() === +nth[1]) date = d.toISOString().slice(0, 10); else conflict = true;
  }
  if (/\bsebel[ue]m\s+(?:jam\s*)?12(?:[.:]00)?\s*malam\b/.test(s)) time = '23:59';
  else {
    const m = s.match(/\b(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?\s*(pagi|siang|sore|malam)?\b/) || s.match(/\b(\d{1,2})[.:](\d{2})\s*(pagi|siang|sore|malam)?\b/);
    if (m) {
      let h = +m[1]; const min = +(m[2] || 0), period = m[3];
      ambiguous = h >= 1 && h <= 12 && !period && !m[2];
      // 'Jam 3 nanti' means the next 03:00/15:00 occurrence, anchored in WIB.
      // Bare 'jam 12' still needs siang/malam clarification as agreed.
      if(ambiguous && h!==12 && (!date || date===today) && /\bnanti\b/.test(s)){
        const current=localParts(now),minutes=Number(current.slice(11,13))*60+Number(current.slice(14,16));
        const candidates=[h,h+12].filter(x=>x*60+min>minutes);h=candidates[0]??h;
        ambiguous=false;
        if(!date)date=new Date(+base+(candidates.length?0:DAY)).toISOString().slice(0,10);
      }
      if (period === 'malam' && h === 12) h = 0;
      else if (['siang','sore','malam'].includes(period) && h < 12) h += 12;
      else if (period === 'pagi' && h === 12) h = 0;
      if (h > 23 || min > 59) ambiguous = true;
      if (!ambiguous) time = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
    }
  }
  if(time && !date && /\bnanti\b/.test(s)){
    const current=localParts(now),minutes=Number(current.slice(11,13))*60+Number(current.slice(14,16));
    const target=Number(time.slice(0,2))*60+Number(time.slice(3,5));
    date=new Date(+base+(target>minutes?0:DAY)).toISOString().slice(0,10);
  }
  return { date, time, ambiguous, conflict };
}
module.exports = { DAY, localParts, parseDeadline, sqlTime, isoFromSql, formatWib, reminderDay, nextReminder, naturalParts };
