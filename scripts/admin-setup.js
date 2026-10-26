'use strict';
// Recovery is deliberately available only to an operator with shell/database access.
require('dotenv').config();
const readline=require('node:readline/promises');
const crypto=require('node:crypto');
const {migrate}=require('../migrate-todolist');
const db=require('../db');
async function main(){
 await migrate(db);const input=readline.createInterface({input:process.stdin,output:process.stdout});
 const confirm=await input.question('Reset Authenticator admin? Semua sesi dan kode pemulihan akan dicabut. Ketik RESET: ');
 if(confirm!=='RESET'){input.close();return;}
 const conn=await db.getConnection();try{await conn.beginTransaction();await conn.query('DELETE FROM web_sessions');await conn.query('DELETE FROM web_recovery_codes');await conn.query('DELETE FROM web_admin');await conn.query('INSERT INTO web_admin(id,username,password_hash) VALUES (1,?,?)',['Pemilik',crypto.randomBytes(32).toString('hex')]);await conn.commit();}catch(e){await conn.rollback();throw e;}finally{conn.release();input.close();}
 console.log('Reset selesai. Buka tautan pengaturan pribadi dan pindai QR Authenticator.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.end());
