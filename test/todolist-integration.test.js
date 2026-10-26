'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const mysql=require('mysql2/promise'),express=require('express'),OTPAuth=require('otpauth');
const {migrate}=require('../migrate-todolist');
const {createAuth}=require('../web-auth');
const {createTodoService,registerTodoRoutes}=require('../todo-service');
const {createTodoChat}=require('../todo-chat');
test('isolated MySQL: migration, code-only login + TOTP, access boundaries, TodoList scheduling', {skip:!process.env.RUN_TODO_DB_TESTS},async t=>{
 const name='nusa_test_'+crypto.randomBytes(6).toString('hex');
 const options={host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT)||3306,user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',timezone:'Z',dateStrings:true};
 const root=await mysql.createConnection(options);let db,server,databaseCreated=false;
 try{
  await root.query('CREATE DATABASE '+name);databaseCreated=true;db=mysql.createPool({...options,database:name,connectionLimit:5});
  await db.query("CREATE TABLE bot_reminder(id INT PRIMARY KEY AUTO_INCREMENT,isi TEXT,waktu DATETIME,status VARCHAR(50),created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await db.query("INSERT INTO bot_reminder(isi,waktu,status) VALUES ('legacy active','2026-11-05 11:00:00','Terkirim'),('legacy done','2026-11-05 11:00:00','Tugas Selesai')");
  await migrate(db);await migrate(db);
  const [migrated]=await db.query('SELECT id,status FROM bot_todolist ORDER BY id');assert.equal(migrated[0].status,'Menunggu Waktu');assert.equal(migrated[1].status,'Tugas Selesai');
  const app=express();app.use(express.json());let clock=new Date('2026-10-27T03:00:00Z');
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const env={PUBLIC_ORIGIN:origin,WEB_AUTH_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),WEB_SETUP_TOKEN:crypto.randomBytes(32).toString('hex')};
  const auth=createAuth({db,env,now:()=>clock}),eventBus=new EventEmitter(),service=createTodoService({db,eventBus});
  auth.register(app);app.use(auth.load);
  registerTodoRoutes(app,service,{webGuard:auth.requireFull,webCsrf:auth.csrf,eventBus,protectStream:auth.protectStream,syncGuard:(req,res,next)=>req.headers['x-nusa-key']==='scoped-test-key'?next():res.sendStatus(401)});
  app.get('/protected',auth.requireFull,(req,res)=>res.json({ok:true}));app.use((err,req,res,next)=>res.status(500).json({error:err.message}));
  let cookie='',csrf='';
  async function call(route,{body,method=body?'POST':'GET',headers={}}={}){
   const response=await fetch(origin+route,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,...headers},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});
   const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}return{response,data};
  }
  assert.equal((await call('/api/todolist')).response.status,401);
  assert.equal((await call('/api/auth/login',{body:{code:'123456'}})).response.status,503);
  assert.equal((await call('/api/auth/bootstrap',{body:{token:'bad'}})).response.status,403);
  const boot=await call('/api/auth/bootstrap',{body:{token:env.WEB_SETUP_TOKEN}});assert.equal(boot.data.stage,'enroll');csrf=boot.data.csrf;
  assert.equal((await call('/api/todolist')).response.status,401);
  const setup=await call('/api/auth/enroll',{body:{}});assert.match(setup.data.qr,/^data:image\/png;base64,/);
  const resumed=await call('/api/auth/bootstrap',{body:{token:env.WEB_SETUP_TOKEN}});assert.equal(resumed.data.stage,'enroll');csrf=resumed.data.csrf;
  assert.equal((await call('/api/auth/enroll',{body:{}})).data.secret,setup.data.secret);
  const totp=new OTPAuth.TOTP({secret:setup.data.secret,digits:6,period:30});
  const verify=await call('/api/auth/verify',{body:{code:totp.generate({timestamp:+clock})}});assert.equal(verify.data.stage,'full');assert.equal(verify.data.recoveryCodes.length,8);csrf=verify.data.csrf;
  assert.match(verify.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const [secretRows]=await db.query('SELECT totp_secret FROM web_admin');assert.notEqual(secretRows[0].totp_secret,setup.data.secret);
  assert.equal((await call('/api/todolist',{body:{title:'Denied CSRF',deadline:'2026-11-05 18:00'},headers:{'X-CSRF-Token':''}})).response.status,403);
  const created=await call('/api/todolist',{body:{title:'Test task',deadline:'2026-11-05 18:00'}});assert.equal(created.response.status,201);const id=created.data.id;
  assert.equal((await call('/api/todolist/'+id,{method:'PATCH',body:{title:'outdated',revision:999}})).response.status,409);
  assert.equal((await call('/api/nusa/tasks')).response.status,401);
  assert.equal((await call('/api/nusa/tasks',{headers:{'X-Nusa-Key':'scoped-test-key'}})).response.status,200);
  assert.equal((await call('/api/nusa/tasks',{headers:{'X-Nusa-Key':'scoped-test-key'}})).data.protocolVersion,2);
  assert.equal((await call('/api/nusa/tasks',{method:'POST',headers:{'X-Nusa-Key':'scoped-test-key'},body:{title:'must not create'}})).response.status,404);
  const archivedTask=await service.create({title:'Archived on Nusa',deadline:'2026-11-05 18:00'});
  assert.equal((await call('/api/nusa/tasks/'+archivedTask.id+'/archive',{body:{displayVersion:1}})).response.status,401);
  assert.equal((await call('/api/nusa/tasks/'+archivedTask.id+'/archive',{headers:{'X-Nusa-Key':'scoped-test-key'},body:{}})).response.status,400);
  assert.equal((await call('/api/nusa/tasks/'+archivedTask.id+'/archive',{headers:{'X-Nusa-Key':'scoped-test-key'},body:{displayVersion:1}})).data.applied,true);
  let archived=(await service.list()).find(x=>x.id===archivedTask.id);assert.equal(archived.archived,true);assert.equal(archived.done,false);assert.equal(archived.nextReminder,null);
  await migrate(db);assert.equal((await service.list()).find(x=>x.id===archivedTask.id).archived,true);
  assert.equal((await call('/api/nusa/tasks/'+archivedTask.id+'/done',{headers:{'X-Nusa-Key':'scoped-test-key'},body:{}})).data.applied,false);
  assert.equal((await call('/api/todolist/'+archivedTask.id+'/restore',{headers:{'X-CSRF-Token':''},body:{revision:archived.revision}})).response.status,403);
  assert.equal((await call('/api/todolist/'+archivedTask.id+'/restore',{body:{revision:archived.revision}})).data.applied,true);
  archived=(await service.list()).find(x=>x.id===archivedTask.id);assert.equal(archived.displayVersion,2);assert.equal(archived.archived,false);
  assert.equal((await call('/api/nusa/tasks/'+archivedTask.id+'/archive',{headers:{'X-Nusa-Key':'scoped-test-key'},body:{displayVersion:1}})).data.applied,false); // old offline deletion cannot override restore
  assert.equal((await service.list()).find(x=>x.id===archivedTask.id).archived,false);
  assert.equal((await call('/api/nusa/tasks/'+archivedTask.id+'/archive',{headers:{'X-Nusa-Key':'scoped-test-key'},body:{displayVersion:2}})).data.applied,true);
  assert.equal((await call('/api/nusa/tasks/'+archivedTask.id+'/archive',{headers:{'X-Nusa-Key':'scoped-test-key'},body:{displayVersion:2}})).data.applied,false); // retry is idempotent
  const sent=[];await service.notifyDaily(text=>sent.push(text),new Date('2026-11-02T05:00:00Z'));assert.equal(sent.length,0);
  await service.notifyDaily(text=>sent.push(text),new Date('2026-11-03T04:59:00Z'));assert.equal(sent.length,0);
  await Promise.all([service.notifyDaily(text=>sent.push(text),new Date('2026-11-03T05:00:00Z')),service.notifyDaily(text=>sent.push(text),new Date('2026-11-03T05:00:00Z'))]);assert.equal(sent.filter(s=>s.includes('Test task')).length,1);
  assert.equal(sent.filter(s=>s.includes('Archived on Nusa')).length,0);
  assert.equal((await service.list()).find(x=>x.id===id).done,false);
  await service.update(id,{done:true});await service.notifyDaily(text=>sent.push(text),new Date('2026-11-04T05:00:00Z'));assert.equal(sent.filter(s=>s.includes('Test task')).length,1);
  const failing=await service.create({title:'Network uncertain',deadline:'2026-11-05 18:00'});let attempts=0;
  await service.notifyDaily(async text=>{if(text.includes('Network uncertain')){attempts++;throw Error('timeout');}},new Date('2026-11-03T05:00:00Z'));
  await service.notifyDaily(async text=>{if(text.includes('Network uncertain'))attempts++;},new Date('2026-11-03T05:01:00Z'));assert.equal(attempts,1);
  const wake=await service.create({title:'Wake up at three',deadline:'2026-11-06 03:00'});const dueSent=[];
  await service.notifyDue(text=>dueSent.push(text),new Date('2026-11-05T19:59:00Z'));assert.equal(dueSent.filter(x=>x.includes('Wake up at three')).length,0);
  await service.notifyDue(text=>dueSent.push(text),new Date('2026-11-05T20:00:00Z'));await service.notifyDue(text=>dueSent.push(text),new Date('2026-11-05T20:00:30Z'));assert.equal(dueSent.filter(x=>x.includes('Wake up at three')).length,1);assert.equal(dueSent.filter(x=>x.includes('Archived on Nusa')).length,0);
  const noon=await service.create({title:'Noon task',deadline:'2026-11-07 12:00'});const noonSent=[];
  await service.notifyDue(text=>noonSent.push(text),new Date('2026-11-07T05:00:00Z'));await service.notifyDaily(text=>noonSent.push(text),new Date('2026-11-07T05:00:00Z'));assert.equal(noonSent.filter(x=>x.includes('Noon task')).length,1);
  // Exercise the full WA -> conversation -> real service -> MySQL path, not a mocked create().
  const waClock=new Date('2026-10-26T19:54:00Z');
  const waChat=createTodoChat({db,service,now:()=>waClock,classify:async()=>{throw Error('Short follow-up must stay in the task conversation');}});
  const initialReply=await waChat.handle('wa-repro-initial','ingetin makan siang jam 3.30 hari ini',{intent:'tambah_todolist',isi:'makan siang'});
  assert.match(initialReply,/disimpan/);const initialId=Number(initialReply.match(/#(\d+)/)[1]);
  const storedInitial=(await service.list()).find(x=>x.id===initialId);assert.equal(Date.parse(storedInitial.deadline),Date.parse('2026-10-26T20:30:00.000Z'));
  await db.query('INSERT INTO todo_conversations(chat_id,draft,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',['wa-repro-followup',JSON.stringify({title:'makan siang',date:null,time:null,history:['ingetin makan siang jam 3.30 hari ini'],reference:waClock.toISOString()})]);
  const followReply=await waChat.handle('wa-repro-followup','hari ini jam 3.30 pagi');assert.match(followReply,/disimpan/);const followId=Number(followReply.match(/#(\d+)/)[1]);
  const storedFollow=(await service.list()).find(x=>x.id===followId);assert.equal(Date.parse(storedFollow.deadline),Date.parse('2026-10-26T20:30:00.000Z'));assert.equal(storedFollow.title,'makan siang');
  const [pendingFollow]=await db.query('SELECT chat_id FROM todo_conversations WHERE chat_id=?',['wa-repro-followup']);assert.equal(pendingFollow.length,0);
  await call('/api/auth/logout',{body:{}});assert.equal((await call('/api/todolist')).response.status,401);
  cookie='';csrf='';
  assert.equal((await call('/api/auth/enroll',{body:{}})).response.status,403); // public requests cannot obtain the QR
  assert.equal((await call('/api/auth/login',{body:{code:totp.generate({timestamp:+clock})}})).response.status,401); // replay blocked without a password step
  assert.equal((await call('/api/auth/login',{body:{username:'owner',password:'a sufficiently long password'}})).response.status,401);
  clock=new Date(+clock+30000);
  const login=await call('/api/auth/login',{body:{code:totp.generate({timestamp:+clock})}});assert.equal(login.data.stage,'full');csrf=login.data.csrf;
  assert.equal((await call('/api/todolist')).response.status,200);
  await call('/api/auth/logout',{body:{}});cookie='';csrf='';
  const recovery=verify.data.recoveryCodes[0];const recovered=await call('/api/auth/login',{body:{code:recovery}});assert.equal(recovered.data.stage,'full');csrf=recovered.data.csrf;
  await call('/api/auth/logout',{body:{}});cookie='';csrf='';
  assert.equal((await call('/api/auth/login',{body:{code:recovery}})).response.status,401);
  assert.equal((await call('/api/auth/bootstrap',{body:{token:env.WEB_SETUP_TOKEN}})).response.status,409);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));if(db)await db.end();try{if(databaseCreated)await root.query('DROP DATABASE '+name);}finally{await root.end();}}
});
