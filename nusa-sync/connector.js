'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { merge, upgradeState, observeCompletions, observeRemovals, waitingForRemovals, hasServerChanges, atomicWrite, validateTasks, parseRows } = require('./core');
const local = path.join(process.env.LOCALAPPDATA || '', 'NusaSync');
const configPath = path.join(local,'config.json'), statePath = path.join(local,'state.json');
const todoPath = path.join(process.env.APPDATA || '', 'Nusa','todo.txt');
let busy = false, nextFetch = 0, dirty = true, archiveSupported = false;
function jsonFile(file, fallback) { try { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); } catch(e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function log(message) { fs.mkdirSync(local,{recursive:true}); const file=path.join(local,'sync.log'); if (fs.existsSync(file) && fs.statSync(file).size>1000000) fs.renameSync(file,file+'.old'); fs.appendFileSync(file,new Date().toISOString()+' '+message+'\n'); }
function loadConfig() {
  if (process.platform !== 'win32') throw new Error('Penghubung ini khusus Windows.');
  const config = jsonFile(configPath,null); if (!config) throw new Error('Konfigurasi NusaSync belum tersedia.');
  const server = new URL(config.server);
  if (server.protocol !== 'https:' || server.username || server.password || server.pathname !== '/' || server.search || server.hash) throw new Error('Server harus berupa origin HTTPS.');
  const key = execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname,'read-key.ps1')],{windowsHide:true,encoding:'utf8'}).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Kunci lokal tidak valid.');
  return {server:server.origin,key};
}
let config;
async function request(route, method = 'GET', data) {
  const response = await fetch(config.server + route,{method,headers:{'X-Nusa-Key':config.key,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
  const size = Number(response.headers.get('content-length')); if (size > 2*1024*1024) throw new Error('Respons terlalu besar.');
  let body='', length=0; const decoder=new TextDecoder(); for await(const part of response.body){length+=part.length;if(length>2*1024*1024)throw new Error('Respons terlalu besar.');body+=decoder.decode(part,{stream:true});} body+=decoder.decode();
  if(!response.ok){const error=new Error('Server HTTP '+response.status);error.status=response.status;try{error.remoteError=JSON.parse(body).error;}catch{}throw error;}
  return JSON.parse(body);
}
function readTodo(){return fs.existsSync(todoPath)?fs.readFileSync(todoPath,'utf8').replace(/^\uFEFF/,''):null;}
function save(state){atomicWrite(statePath,JSON.stringify(state,null,2));}
function observe(text,state){if(parseRows(text).some(row=>!row.valid))throw new Error('File Nusa belum valid; perubahan ditunda.');state.pending=observeCompletions(text,state);observeRemovals(text,state);save(state);}
async function flushPending(state){
  for(const id of [...state.pending]){
    if(!Number.isSafeInteger(id)||id<1)throw new Error('ID antrean tidak valid.');
    try{const result=await request('/api/nusa/tasks/'+id+'/done','POST');if(state.tasks[id] && result.applied!==false)state.tasks[id].done=true;}
    catch(e){if(e.status!==404 || e.remoteError!=='Tugas tidak ditemukan.')throw e;delete state.tasks[id];}
    state.pending=state.pending.filter(x=>x!==id);save(state);dirty=true;
  }
  for(const item of [...state.pendingArchives]){
    if(!Number.isSafeInteger(item.id)||item.id<1||!Number.isSafeInteger(item.displayVersion)||item.displayVersion<1)throw new Error('Antrean arsip tidak valid.');
    try{
      const result=await request('/api/nusa/tasks/'+item.id+'/archive','POST',{displayVersion:item.displayVersion});
      if(state.tasks[item.id]){state.tasks[item.id].visible=false;if(result.applied)state.tasks[item.id].archived=true;else state.tasks[item.id].locallyHidden=false;}
    }catch(e){if(e.status!==404 || e.remoteError!=='Tugas tidak ditemukan.')throw e;delete state.tasks[item.id];}
    state.pendingArchives=state.pendingArchives.filter(x=>!(x.id===item.id && x.displayVersion===item.displayVersion));save(state);dirty=true;
  }
}
function controlNusa(mode) {
  // Fixed local script: the server cannot supply commands, executable paths or arguments.
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname,'restart-nusa.ps1'),'-Mode',mode],{windowsHide:true,timeout:15000,encoding:'utf8'});
  if(result.status!==0)throw new Error('Nusa belum berhasil dimuat ulang.');
  return result.stdout.trim()==='running';
}
async function tick() {
  if(busy)return;busy=true;
  try {
    let text=readTodo();
    let state=upgradeState(jsonFile(statePath,{version:2,tasks:{},pending:[],pendingArchives:[]}),text);
    if(state.restartPending){controlNusa('Start');state.restartPending=false;atomicWrite(statePath,JSON.stringify(state,null,2));}
    if(text===null)return;
    observe(text,state);
    if(!archiveSupported){const hello=await request('/api/nusa/tasks');if(hello.protocolVersion!==2)throw new Error('Server belum mendukung arsip Nusa.');validateTasks(hello.data);archiveSupported=true;}
    await flushPending(state);
    if(waitingForRemovals(state)){dirty=true;return;}
    if(!dirty && Date.now()<nextFetch)return;
    const snapshot=await request('/api/nusa/tasks');if(snapshot.protocolVersion!==2)throw new Error('Versi sinkronisasi server tidak cocok.');
    const remote=validateTasks(snapshot.data); nextFetch=Date.now()+15000; dirty=false;
    // Re-read after network I/O so a checkbox clicked while fetching cannot be overwritten.
    text=readTodo();if(text===null)return;
    observe(text,state);
    if(state.pending.length || state.pendingArchives.length || waitingForRemovals(state)){dirty=true;return;}
    // Nusa may sort/reformat its own rows. Those local changes are not a reason to restart it.
    // A completion already acknowledged above updates state.done, so its server echo also stops here.
    if(!hasServerChanges(remote,state))return;
    let result=merge(text,remote,state);
    if(result.text!==text) {
      const wasRunning=controlNusa('Stop');
      state.restartPending=wasRunning;atomicWrite(statePath,JSON.stringify(state,null,2));
      text=readTodo();
      if(text!==null)observe(text,state);
      if(text===null || state.pending.length || state.pendingArchives.length || waitingForRemovals(state)){if(wasRunning)controlNusa('Start');state.restartPending=false;save(state);dirty=true;return;}
      result=merge(text,remote,state);result.state.restartPending=wasRunning;
      fs.mkdirSync(path.join(local,'backups'),{recursive:true});
      const backup=path.join(local,'backups',Date.now()+'-todo.txt');fs.writeFileSync(backup,text);
      atomicWrite(todoPath,result.text); atomicWrite(statePath,JSON.stringify(result.state,null,2));
      if(wasRunning)controlNusa('Start');result.state.restartPending=false;atomicWrite(statePath,JSON.stringify(result.state,null,2));log('Perubahan tugas masuk; data Nusa diperbarui.');
      const files=fs.readdirSync(path.join(local,'backups')).filter(n=>/^\d+-todo\.txt$/.test(n)).sort();
      for(const file of files.slice(0,-20))fs.unlinkSync(path.join(local,'backups',file));
    } else atomicWrite(statePath,JSON.stringify(result.state,null,2));
  } catch(e) { log(e.message); dirty=true; } finally { busy=false; }
}
async function stream() {
  while(true) {
    try {
      const response=await fetch(config.server+'/api/nusa/stream',{headers:{'X-Nusa-Key':config.key},redirect:'error',signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new Error('Stream HTTP '+response.status);
      for await(const part of response.body) { if(part.length)dirty=true; }
    } catch { /* Reconnect after errors, clean EOF and proxy timeouts. Polling remains the fallback. */ }
    await new Promise(resolve=>setTimeout(resolve,10000));
  }
}
if(require.main===module){try{config=loadConfig();log('Penghubung aktif.');tick();setInterval(tick,3000);stream();}catch(e){log(e.message);process.exitCode=1;}}
module.exports={};
