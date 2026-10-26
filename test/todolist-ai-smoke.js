'use strict';
// Optional read-only provider check. No task is created and no WhatsApp message is sent.
require('dotenv').config({quiet:true});
const {deteksiIntent}=require('../ai-bot');
const db=require('../db');
async function main(){
 const cases=[
  ['tolong ingatkan tugas desain interaksi',null],
  ['minggu depan tanggal 5',{title:'Tugas desain interaksi',date:null,time:null}],
  ['sebelum jam 12 malam',{title:'Tugas desain interaksi',date:'2026-11-05',time:null}],
  ['jam 12',{title:'Tugas desain interaksi',date:'2026-11-05',time:null}],
  ['selesai tugas #12',null]
 ];
 for(const[text,draft]of cases){const result=await deteksiIntent(text,draft);console.log(JSON.stringify({text,result}));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.end());
