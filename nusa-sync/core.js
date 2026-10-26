'use strict';
const fs = require('node:fs');
const path = require('node:path');
function parseRows(text) {
  return text.split(/\r?\n/).filter(Boolean).map(raw => {
    const fields = raw.split('\t');
    return { raw, done: fields[0] === '1', title: fields.slice(4).join('\t'), valid: fields.length === 5 && /^[01]$/.test(fields[0]) && fields.slice(1,4).every(x => /^\d+$/.test(x)) };
  });
}
function validateTasks(input) {
  if (!Array.isArray(input) || input.length > 10000) throw new Error('Daftar tugas server tidak valid.');
  const ids = new Set();
  return input.map(t => {
    if (!t || !Number.isSafeInteger(t.id) || t.id < 1 || ids.has(t.id) || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 500 || /[\u0000-\u001f\u007f]/.test(t.title) || typeof t.done !== 'boolean' || !Number.isSafeInteger(t.revision) || t.revision < 1 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(t.deadline) || !Number.isFinite(Date.parse(t.deadline))) throw new Error('Data tugas server ditolak.');
    ids.add(t.id); return { id:t.id,title:t.title,done:t.done,deadline:t.deadline,revision:t.revision };
  });
}
function lineTitle(task) {
  const local = new Date(Date.parse(task.deadline) + 7 * 3600000).toISOString();
  return `[WA #${task.id}] ${task.title} · ${local.slice(8,10)}/${local.slice(5,7)}/${local.slice(0,4)} ${local.slice(11,16)} WIB`;
}
function observeCompletions(text, state) {
  const rows = parseRows(text); const pending = new Set(state.pending || []);
  for (const [id, task] of Object.entries(state.tasks)) {
    const matches = rows.filter(row => row.valid && row.title === task.lineTitle);
    if (!task.done && matches.length === 1 && matches[0].done) pending.add(Number(id));
  }
  return [...pending];
}
function hasServerChanges(tasks,state) {
  if(tasks.length!==Object.keys(state.tasks).length)return true;
  return tasks.some(task=>{const old=state.tasks[task.id];return !old || old.title!==task.title || Date.parse(old.deadline)!==Date.parse(task.deadline) || old.done!==task.done;});
}
function merge(text, tasks, state, now = new Date()) {
  tasks = validateTasks(tasks);
  const rows = parseRows(text), used = new Set(), output = [], next = { version:1,tasks:{},pending:[...(state.pending || [])] };
  const today = new Date(+now + 7 * 3600000).toISOString().slice(0,10).replaceAll('-','');
  for (const row of rows) {
    const id = Object.keys(state.tasks).find(id => state.tasks[id].lineTitle === row.title && row.valid);
    if (!id) output.push(row.raw); else used.add(Number(id));
  }
  for (const task of tasks) {
    const previous = state.tasks[task.id];
    // Don't repopulate historical completed tasks after Nusa/user clears them.
    if (task.done && !used.has(task.id)) { next.tasks[task.id] = { ...task, lineTitle:lineTitle(task) }; continue; }
    const title = lineTitle(task), local = new Date(Date.parse(task.deadline) + 7 * 3600000).toISOString();
    const minute = Number(local.slice(11,13)) * 60 + Number(local.slice(14,16));
    const match = rows.find(r => r.valid && r.title === previous?.lineTitle);
    const fired = match?.raw.split('\t')[3] || today;
    output.push([task.done ? 1 : 0, minute, minute, fired, title].join('\t'));
    next.tasks[task.id] = { ...task,lineTitle:title };
  }
  return { text:output.length ? output.join('\n') + '\n' : '', state:next };
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file),{recursive:true}); const temporary = file + '.nusa-sync-tmp';
  fs.writeFileSync(temporary,text,{encoding:'utf8',mode:0o600}); fs.renameSync(temporary,file);
}
module.exports = { parseRows,validateTasks,lineTitle,observeCompletions,hasServerChanges,merge,atomicWrite };
