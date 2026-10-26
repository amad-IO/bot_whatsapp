'use strict';
// Existing monitoring calls keep their Response API while gaining session/CSRF handling.
const nativeFetch = window.fetch.bind(window);
const monitoringSession = nativeFetch('/api/auth/session').then(r => r.json()).then(data => { if (data.stage !== 'full') { location.replace('/login.html'); throw new Error('Login diperlukan.'); } return data; });
window.fetch = async (url, options = {}) => {
  const target = new URL(typeof url === 'string' ? url : url.url, location.href);
  if (target.origin !== location.origin) return nativeFetch(url,options);
  const session = await monitoringSession;
  const headers = new Headers(options.headers || {}); headers.set('X-CSRF-Token',session.csrf);
  const response = await nativeFetch(url,{...options,headers});
  if (response.status === 401) location.replace('/login.html');
  return response;
};
document.addEventListener('click', async event => {
  const logout = event.target.closest('[data-web-logout]'); if (!logout) return;
  logout.disabled = true;
  try { await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); location.replace('/login.html'); } catch { logout.disabled=false; }
});
