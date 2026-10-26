'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {naturalParts,parseDeadline,sqlTime,reminderDay}=require('../todo-time');
const {merge,upgradeState,observeCompletions,observeRemovals,waitingForRemovals,hasServerChanges,validateTasks}=require('../nusa-sync/core');
const {createTodoChat}=require('../todo-chat');
const now=new Date('2026-10-27T03:00:00Z');
test('Indonesian dates, next calendar week, midnight boundary and ambiguous clock',()=>{
 assert.equal(naturalParts('minggu depan tanggal 5 jam 6 sore',now).date,'2026-11-05');
 assert.equal(naturalParts('minggu depan tanggal 5 jam 6 sore',now).time,'18:00');
 assert.equal(naturalParts('minggu depan tanggal 15',now).conflict,true);
 assert.equal(naturalParts('hari ini sebelum jam 12 malam',now).time,'23:59');
 assert.equal(naturalParts('besok jam 12',now).ambiguous,true);
 assert.equal(naturalParts('lusa jam 12 siang',now).date,'2026-10-29');
 assert.equal(naturalParts('lusa jam 12 siang',now).time,'12:00');
 assert.equal(naturalParts('jam 00:00',now).time,'00:00');
 assert.equal(naturalParts('tanggal 31 februari',now).conflict,true);
 assert.equal(sqlTime('2026-11-05 18:00'),'2026-11-05 11:00:00');
 assert.equal(reminderDay('2026-11-05T11:00:00Z',2),'2026-11-03');
 assert.throws(()=>parseDeadline('2026-02-30 18:00'));
 assert.throws(()=>parseDeadline('2026-11-05 24:00'));
});
const task={id:42,title:'Desain interaksi',deadline:'2026-11-05T11:00:00.000Z',done:false,revision:1};
test('Nusa merge preserves manual rows and full-date mapping; completion queues without modifying manual tasks',()=>{
 const state={version:1,tasks:{},pending:[]};
 const manual='0\t720\t800\t0\tTugas manual\n';
 const first=merge(manual,[task],state,now);
 assert.ok(first.text.startsWith(manual));assert.match(first.text,/05\/11\/2026 18:00 WIB/);
 const checked=first.text.replace('0\t1080\t1080','1\t1080\t1080');
 assert.deepEqual(observeCompletions(checked,first.state),[42]);
 const done=merge(checked,[{...task,done:true,revision:2}],{...first.state,pending:[]},now);
 assert.equal(done.text,checked); // A local checkbox acknowledgement does not require a restart.
 assert.equal(merge(manual,[{...task,done:true}],done.state,now).text,manual);
 assert.equal(merge(first.text,[task],first.state,now).text,first.text);
 assert.equal(hasServerChanges([{...task,revision:8}],first.state),false);
 assert.equal(hasServerChanges([{...task,done:true,revision:9}],{...first.state,tasks:{42:{...first.state.tasks[42],done:true}}}),false);
 assert.equal(hasServerChanges([{...task,title:'Changed'}],first.state),true);
});
test('Nusa rejects malicious row delimiters, duplicate IDs and invalid server payloads',()=>{
 for(const bad of [{...task,title:'bad\n1\t0\t0\t0\tpayload'}, {...task,id:'../../file'}, {...task,deadline:'bad'}, {...task,done:'true'}])assert.throws(()=>validateTasks([bad]));
 assert.throws(()=>validateTasks([task,task]));
});
function memoryDb(){const drafts=new Map();return{drafts,async query(sql,args=[]){if(sql.startsWith('SELECT draft'))return[[drafts.has(args[0])?{draft:drafts.get(args[0])}:null].filter(Boolean)];if(sql.startsWith('INSERT INTO todo_conversations')){drafts.set(args[0],args[1]);return[{}];}if(sql.startsWith('DELETE FROM todo_conversations')){drafts.delete(args[0]);return[{}];}throw new Error(sql);}};}
test('WA asks only missing fields; pending draft survives a handler restart and ambiguous noon',async()=>{
 const db=memoryDb(),created=[];const service={create:async input=>{created.push(input);return{id:1};},list:async()=>[]};
 let chat=createTodoChat({db,service,now:()=>now});
 assert.match(await chat.handle('owner','tolong ingatkan tugas desain',{intent:'tambah_todolist',isi:'Tugas desain'}),/tanggal berapa/);
 chat=createTodoChat({db,service,now:()=>now});
 assert.match(await chat.handle('owner','minggu depan tanggal 5',{intent:'lanjut_todolist'}),/jam berapa/);
 assert.match(await chat.handle('owner','jam 12',{intent:'lanjut_todolist',jam:'12:00'}),/pagi, siang/);
 assert.equal(created.length,0);
 const reply=await chat.handle('owner','sebelum jam 12 malam',{intent:'lanjut_todolist',jam:'00:00',jam_ambigu:true});
 assert.match(reply,/disimpan/);assert.equal(created[0].deadline,'2026-11-05T16:59:00.000Z');assert.equal(db.drafts.size,0);
});
test('topic changes preserve pending task and cancel removes it',async()=>{
 const db=memoryDb();const chat=createTodoChat({db,service:{},now:()=>now});
 await chat.handle('owner','ingatkan tugas',{intent:'tambah_todolist',isi:'tugas'});
 const result=await chat.handle('owner','beli kopi 10000',{intent:'transaksi_keuangan',amt:10000});
 assert.equal(result.nonTodoIntent.intent,'transaksi_keuangan');assert.equal(db.drafts.size,1);
 assert.match(await chat.handle('owner','batal',{}),/dibatalkan/);assert.equal(db.drafts.size,0);
});
test('WA completion refuses ambiguous titles and accepts an exact task ID',async()=>{
 const updated=[];const service={list:async()=>[{id:1,title:'desain A',done:false},{id:2,title:'desain B',done:false}],update:async(...a)=>updated.push(a)};
 const chat=createTodoChat({db:memoryDb(),service,now:()=>now});
 assert.match(await chat.handle('x','selesai desain',{intent:'selesai_todolist',keyword:'desain'}),/beberapa/);assert.equal(updated.length,0);
 assert.match(await chat.handle('x','selesai tugas #2',{intent:'selesai_todolist'}),/dihentikan/);assert.equal(updated[0][0],2);
});
test('X queues a durable archive and cannot be resurrected by another task update or a connector restart',()=>{
 const first=merge('',[task],{version:2,tasks:{},pending:[],pendingArchives:[]},now);
 let state=first.state;observeRemovals('',state,1000);assert.equal(waitingForRemovals(state),true);assert.equal(state.pendingArchives.length,0);
 observeRemovals('',state,2600);assert.deepEqual(state.pendingArchives,[{id:42,displayVersion:1}]);
 state=JSON.parse(JSON.stringify(state));
 const other={...task,id:43,title:'New task'};
 const offline=merge('',[task,other],state,now);assert.doesNotMatch(offline.text,/WA #42/);assert.match(offline.text,/WA #43/);
 const archived={...task,archived:true,displayVersion:1};
 const empty=merge('',[archived],{version:2,tasks:{},pending:[],pendingArchives:[]},now);assert.equal(empty.text,'');
 const restored=merge('',[{...task,displayVersion:2}],{...state,pendingArchives:[]},now);assert.match(restored.text,/WA #42/);assert.equal(restored.state.tasks[42].visible,true);
});
test('temporary truncation, a missing file, incomplete rows and manual tasks never trigger an archive',()=>{
 const first=merge('0\t1\t2\t0\tManual\n',[task],{version:2,tasks:{},pending:[],pendingArchives:[]},now);
 const state=first.state;
 observeRemovals(null,state,1000);observeRemovals('broken row',state,3000);assert.equal(state.pendingArchives.length,0);
 observeRemovals('',state,4000);observeRemovals(first.text,state,4500);observeRemovals(first.text,state,7000);assert.equal(state.pendingArchives.length,0);assert.equal(waitingForRemovals(state),false);
 const renamed=first.text.replace('Desain interaksi','Changed locally');observeRemovals(renamed,state,8000);observeRemovals(renamed,state,10000);assert.equal(state.pendingArchives.length,0);
});
test('legacy missing completed history stays hidden; newly removed completed rows are archived',()=>{
 const legacy={version:1,tasks:{42:{...task,done:true,lineTitle:'old completed title'}},pending:[]};
 const upgraded=upgradeState(legacy,'');observeRemovals('',upgraded,1);observeRemovals('',upgraded,5000);assert.equal(upgraded.pendingArchives.length,0);
 const first=merge('',[task],{version:2,tasks:{},pending:[],pendingArchives:[]},now);
 const done=merge(first.text,[{...task,done:true}],first.state,now);observeRemovals('',done.state,1);observeRemovals('',done.state,2000);assert.equal(done.state.pendingArchives[0].id,42);
 const restored=merge('',[{...task,done:true,displayVersion:2}],{...done.state,pendingArchives:[]},now);assert.match(restored.text,/^1\t/);
});
test('jam 3 nanti chooses the next occurrence in WIB; bare jam 12 still needs clarification',()=>{
 assert.deepEqual(naturalParts('ingetin bangun tidur jam 3 nanti',new Date('2026-10-26T19:27:00Z')),{date:'2026-10-27',time:'03:00',ambiguous:false,conflict:false});
 assert.equal(naturalParts('jam 3 nanti',new Date('2026-10-27T07:27:00Z')).time,'15:00');
 assert.equal(naturalParts('jam 3 nanti',new Date('2026-10-27T15:27:00Z')).date,'2026-10-28');
 assert.equal(naturalParts('jam 12 nanti',new Date('2026-10-27T04:27:00Z')).ambiguous,true);
});
test('hari ini continues a pending wake-up task and never calls the finance classifier',async()=>{
 const db=memoryDb(),created=[];const night=new Date('2026-10-26T19:27:00Z');
 db.drafts.set('owner',JSON.stringify({title:'bangun tidur',date:null,time:null,history:['ingetin bangun tidur jam 3 nanti'],reference:night.toISOString()}));
 const chat=createTodoChat({db,service:{create:async data=>{created.push(data);return{id:1};}},classify:async()=>{throw Error('Must not classify a short follow-up as a new topic');},now:()=>night});
 assert.match(await chat.handle('owner','hari ini'),/disimpan/);assert.equal(created[0].deadline,'2026-10-26T20:00:00.000Z');assert.equal(created[0].title,'bangun tidur');
});
test('a complete wake-up request needs no repeated date question; a period reply completes an ambiguous hour',async()=>{
 const night=new Date('2026-10-26T19:27:00Z'),db=memoryDb(),created=[];
 const chat=createTodoChat({db,service:{create:async data=>{created.push(data);return{id:1};}},now:()=>night});
 assert.match(await chat.handle('owner','ingetin bangun tidur jam 3 nanti',{intent:'tambah_todolist',isi:'bangun tidur',jam_ambigu:true}),/disimpan/);
 assert.equal(created[0].deadline,'2026-10-26T20:00:00.000Z');
 db.drafts.set('owner',JSON.stringify({title:'meeting',date:'2026-10-28',time:null,history:['jam 3'],reference:night.toISOString()}));
 assert.match(await chat.handle('owner','sore'),/disimpan/);assert.equal(created[1].deadline,'2026-10-28T08:00:00.000Z');
});
