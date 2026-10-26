"use strict";
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
    if (!t || !Number.isSafeInteger(t.id) || t.id < 1 || ids.has(t.id) || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 500 || /[\u0000-\u001f\u007f]/.test(t.title) || typeof t.done !== 'boolean' || !Number.isSafeInteger(t.revision) || t.revision < 1 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(t.deadline) || !Number.isFinite(Date.parse(t.deadline)) || (t.archived!==undefined && typeof t.archived!=='boolean') || (t.displayVersion!==undefined && (!Number.isSafeInteger(t.displayVersion) || t.displayVersion<1))) throw new Error('Data tugas server ditolak.');
    ids.add(t.id); return { id:t.id,title:t.title,done:t.done,deadline:t.deadline,revision:t.revision,archived:t.archived??false,displayVersion:t.displayVersion??1 };
  });
}
function lineTitle(task) {
  const local = new Date(Date.parse(task.deadline) + 7 * 3600000).toISOString();
  const identity='\u2063'+task.id.toString(2).replace(/0/g,'\u200B').replace(/1/g,'\u200C')+'\u2063';
  return `${task.title} · ${local.slice(8,10)}/${local.slice(5,7)}/${local.slice(0,4)} ${local.slice(11,16)} WIB${identity}`;
}
function identityOf(title){
  const match=title.match(/\u2063([\u200B\u200C]{1,53})\u2063$/u);if(!match)return null;
  const id=Number.parseInt(match[1].replace(/\u200B/g,'0').replace(/\u200C/g,'1'),2);
  return Number.isSafeInteger(id)&&id>0?id:null;
}
function matches(row,task,id) { return row.valid && (row.title===task.lineTitle || row.title.startsWith(`[WA #${id}] `) || identityOf(row.title)===Number(id)); }
function upgradeState(state,text) {
  if(![1,2].includes(state.version) || !state.tasks || Array.isArray(state.tasks) || !Array.isArray(state.pending))throw new Error('State lokal tidak valid.');
  const legacy=state.version===1,rows=typeof text==='string'?parseRows(text):[];
  state.pendingArchives??=[];
  if(!Array.isArray(state.pendingArchives))throw new Error('Antrean arsip tidak valid.');
  for(const [id,task] of Object.entries(state.tasks)) {
    task.archived??=false;task.displayVersion??=1;
    // Old completed history was never necessarily displayed. Missing active rows were displayed by v1.
    if(legacy)task.visible=!task.done || rows.some(row=>matches(row,task,id));
    task.locallyHidden??=false;
  }
  state.version=2;return state;
}
function observeCompletions(text, state) {
  const rows = parseRows(text); const pending = new Set(state.pending || []);
  for (const [id, task] of Object.entries(state.tasks)) {
    const found = rows.filter(row => matches(row,task,id));
    if (!task.done && !task.archived && !task.locallyHidden && found.length === 1 && found[0].done) pending.add(Number(id));
  }
  return [...pending];
}
function observeRemovals(text,state,now=Date.now()) {
  if(typeof text!=='string')return; // Missing file is not evidence of clicking X.
  const rows=parseRows(text);
  if(rows.some(row=>!row.valid))return; // Ignore incomplete file writes.
  for(const [id,task] of Object.entries(state.tasks)) {
    if(!task.visible || task.archived || state.pendingArchives.some(x=>x.id===Number(id)))continue;
    if(rows.some(row=>matches(row,task,id))){delete task.missingSince;task.locallyHidden=false;continue;}
    task.locallyHidden=true;
    if(!Number.isFinite(task.missingSince)){task.missingSince=now;continue;}
    if(now-task.missingSince<1500)continue; // Confirm across polling cycles, not a transient truncate.
    state.pendingArchives.push({id:Number(id),displayVersion:task.displayVersion});task.visible=false;
  }
}
function waitingForRemovals(state){return Object.values(state.tasks).some(task=>task.visible && task.locallyHidden && !task.archived);}
function hasServerChanges(tasks,state) {
  if(state.titleFormat!==2)return true;
  if(tasks.length!==Object.keys(state.tasks).length)return true;
  return tasks.some(task=>{const old=state.tasks[task.id];return !old || old.title!==task.title || Date.parse(old.deadline)!==Date.parse(task.deadline) || old.done!==task.done || !!old.archived!==!!task.archived || (old.displayVersion??1)!==(task.displayVersion??1);});
}
function merge(text, tasks, state, now = new Date()) {
  tasks=validateTasks(tasks);
  const rows=parseRows(text),byId=new Map(tasks.map(t=>[t.id,t])),used=new Set(),output=[];
  const next={version:2,titleFormat:2,tasks:{},pending:[...(state.pending||[])],pendingArchives:[...(state.pendingArchives||[])]};
  const today=new Date(+now+7*3600000).toISOString().slice(0,10).replaceAll('-','');
  for(const task of tasks){
    const previous=state.tasks[task.id];const restored=task.displayVersion>(previous?.displayVersion??1);
    next.tasks[task.id]={...previous,...task,lineTitle:lineTitle(task),visible:false,locallyHidden:restored?false:!!previous?.locallyHidden};
    if(restored)delete next.tasks[task.id].missingSince;
  }
  function render(task,raw){
    const previous=state.tasks[task.id],entry=next.tasks[task.id];
    if(task.archived || entry.locallyHidden)return;
    const local=new Date(Date.parse(task.deadline)+7*3600000).toISOString();
    const minute=Number(local.slice(11,13))*60+Number(local.slice(14,16));
    const fired=raw?.raw.split('\t')[3]||today;
    const restored=task.displayVersion>(previous?.displayVersion??1);
    if(task.done && !raw && !restored)return;
    output.push([task.done?1:0,minute,minute,fired,entry.lineTitle].join('\t'));entry.visible=true;
  }
  for(const row of rows){
    const id=Object.keys(state.tasks).find(id=>matches(row,state.tasks[id],id));
    if(!id){output.push(row.raw);continue;}
    const task=byId.get(Number(id));if(task && !used.has(task.id))render(task,row);used.add(Number(id));
  }
  for(const task of tasks)if(!used.has(task.id))render(task,null);
  return {text:output.length?output.join('\n')+'\n':'',state:next};
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file),{recursive:true}); const temporary = file + '.nusa-sync-tmp';
  fs.writeFileSync(temporary,text,{encoding:'utf8',mode:0o600}); fs.renameSync(temporary,file);
}
module.exports = { parseRows,validateTasks,lineTitle,identityOf,upgradeState,observeCompletions,observeRemovals,waitingForRemovals,hasServerChanges,merge,atomicWrite };
