'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { merge, observeCompletions, hasServerChanges, atomicWrite, validateTasks } = require('./core');
const local = path.join(process.env.LOCALAPPDATA || '', 'NusaSync');
const configPath = path.join(local,'config.json'), statePath = path.join(local,'state.json');
const todoPath = path.join(process.env.APPDATA || '', 'Nusa','todo.txt');
let busy = false, nextFetch = 0, dirty = true;
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
async function request(route, method = 'GET') {
  const response = await fetch(config.server + route,{method,headers:{'X-Nusa-Key':config.key},redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('Server HTTP '+response.status);
  const size = Number(response.headers.get('content-length')); if (size > 2*1024*1024) throw new Error('Respons terlalu besar.');
  let body='', length=0; const decoder=new TextDecoder(); for await(const part of response.body){length+=part.length;if(length>2*1024*1024)throw new Error('Respons terlalu besar.');body+=decoder.decode(part,{stream:true});} body+=decoder.decode();
  return JSON.parse(body);
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
    let state=jsonFile(statePath,{version:1,tasks:{},pending:[]});
    if(state.version!==1 || !state.tasks || !Array.isArray(state.pending))throw new Error('State lokal tidak valid; hentikan sinkronisasi untuk menghindari perubahan data.');
    if(state.restartPending){controlNusa('Start');state.restartPending=false;atomicWrite(statePath,JSON.stringify(state,null,2));}
    let text=fs.existsSync(todoPath)?fs.readFileSync(todoPath,'utf8'):'';
    state.pending=observeCompletions(text,state); atomicWrite(statePath,JSON.stringify(state,null,2));
    for(const id of [...state.pending]) {
      if(!Number.isSafeInteger(id)||id<1)throw new Error('ID antrean tidak valid.');
      await request('/api/nusa/tasks/'+id+'/done','POST'); state.pending=state.pending.filter(x=>x!==id); if(state.tasks[id])state.tasks[id].done=true;
      atomicWrite(statePath,JSON.stringify(state,null,2)); dirty=true;
    }
    if(!dirty && Date.now()<nextFetch)return;
    const remote=validateTasks((await request('/api/nusa/tasks')).data); nextFetch=Date.now()+15000; dirty=false;
    // Re-read after network I/O so a checkbox clicked while fetching cannot be overwritten.
    text=fs.existsSync(todoPath)?fs.readFileSync(todoPath,'utf8'):'';
    const newPending=observeCompletions(text,state);
    if(newPending.length){state.pending=newPending;atomicWrite(statePath,JSON.stringify(state,null,2));dirty=true;return;}
    // Nusa may sort/reformat its own rows. Those local changes are not a reason to restart it.
    // A completion already acknowledged above updates state.done, so its server echo also stops here.
    if(!hasServerChanges(remote,state))return;
    let result=merge(text,remote,state);
    if(result.text!==text) {
      const wasRunning=controlNusa('Stop');
      state.restartPending=wasRunning;atomicWrite(statePath,JSON.stringify(state,null,2));
      text=fs.existsSync(todoPath)?fs.readFileSync(todoPath,'utf8'):'';
      state.pending=observeCompletions(text,state);
      if(state.pending.length){atomicWrite(statePath,JSON.stringify(state,null,2));if(wasRunning)controlNusa('Start');state.restartPending=false;atomicWrite(statePath,JSON.stringify(state,null,2));dirty=true;return;}
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
