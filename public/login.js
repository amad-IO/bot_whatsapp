"use strict";
let csrf = '', recoveryCodes = [], enrolling = false, recoveryMode = false;
const el = id => document.getElementById(id);
let setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
if (setupToken) history.replaceState(null,'','/login.html');
async function request(path, data) {
  const res = await fetch('/api/auth/' + path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const value = await res.json().catch(() => ({})); if (!res.ok) throw new Error(value.error || 'Permintaan gagal.'); return value;
}
async function stage(data) {
  csrf = data.csrf || '';
  if (data.stage === 'full') { location.replace('/todolist.html'); return; }
  enrolling = data.stage === 'enroll';
  el('enroll').hidden = !enrolling;
  el('otp-form').hidden = !enrolling && data.configured === false;
  el('recovery-toggle').hidden = enrolling || data.configured === false;
  if(enrolling){
    el('heading').textContent='Hubungkan Authenticator.';
    el('intro').textContent='Pindai QR ini sekali, lalu masukkan kode 6 digit untuk menyelesaikan pengaturan.';
    const setup = await request('enroll', {}); el('qr').src = setup.qr; el('secret').textContent = setup.secret;
    el('submit-code').textContent='Aktifkan dan masuk';
  }else{
    el('heading').textContent='Masuk dengan kode.';
    el('intro').textContent=data.configured === false ? 'Authenticator belum diaktifkan. Buka tautan pengaturan pribadi untuk memindai QR pertama kali.' : 'Buka Microsoft Authenticator dan masukkan kode 6 digit untuk WA Gateway.';
    el('submit-code').textContent='Masuk';
  }
  if(!el('otp-form').hidden)el('code').focus();
}
el('otp-form').addEventListener('submit', async event => {
  event.preventDefault();el('submit-code').disabled=true;el('message').textContent='';
  try{
    const data = await request(enrolling ? 'verify' : 'login', { code: el('code').value }); el('code').value = ''; csrf=data.csrf;
    if(!data.recoveryCodes)return location.replace('/todolist.html');
    recoveryCodes=data.recoveryCodes;el('otp-form').hidden=true;el('enroll').hidden=true;el('recovery-toggle').hidden=true;
    el('qr').removeAttribute('src');el('secret').textContent='';el('recovery').hidden=false;el('heading').textContent='Authenticator aktif.';el('intro').textContent='Selanjutnya, masuk cukup dengan kode 6 digit.';
    for(const code of recoveryCodes){const item=document.createElement('span');item.textContent=code;el('codes').append(item);}
  }catch(e){el('message').textContent=e.message;}finally{el('submit-code').disabled=false;}
});
el('recovery-toggle').addEventListener('click',()=>{
  recoveryMode=!recoveryMode;el('code').value='';el('code').inputMode=recoveryMode?'text':'numeric';el('code').maxLength=recoveryMode?16:6;el('code').minLength=recoveryMode?16:6;el('code').pattern=recoveryMode?'[a-fA-F0-9]{16}':'[0-9]{6}';
  el('code-label').textContent=recoveryMode?'Kode pemulihan':'Kode Authenticator';el('recovery-toggle').textContent=recoveryMode?'Gunakan kode Authenticator':'Gunakan kode pemulihan';el('code').focus();
});
el('download-codes').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob(['Kode pemulihan WA Gateway — rahasiakan, setiap kode sekali pakai\n\n'+recoveryCodes.join('\n')],{type:'text/plain'}));const link=document.createElement('a');link.href=url;link.download='gateway-recovery-codes.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
async function initialize(){
  const current=await request('session');
  if(setupToken && current.stage!=='full'){
    try{const data=await request('bootstrap',{token:setupToken});setupToken=null;return stage(data);}
    catch(e){setupToken=null;if(current.configured || current.stage==='enroll')return stage(current);throw e;}
  }
  return stage(current);
}
initialize().catch(e=>{el('message').textContent=e.message;el('otp-form').hidden=true;el('recovery-toggle').hidden=true;});
