'use strict';
window.gatewaySession = fetch('/api/auth/session').then(r => r.json()).then(data => { if (data.stage !== 'full') { location.replace('/login.html'); throw new Error('Login diperlukan.'); } return data; });
window.gatewayRequest = async (path, options = {}) => {
  const session = await window.gatewaySession;
  const response = await fetch(path, { ...options, headers: { ...options.headers, 'X-CSRF-Token': session.csrf } });
  if (response.status === 401) { location.replace('/login.html'); throw new Error('Sesi berakhir.'); }
  const data = await response.json(); if (!response.ok) throw new Error(data.error || data.message || 'Permintaan gagal.'); return data;
};
document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', async () => { try { await window.gatewayRequest('/api/auth/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); location.replace('/login.html'); } catch(e) { alert(e.message); } }));
