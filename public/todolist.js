'use strict';
let tasks = [], editing = null;
const node = id => document.getElementById(id);
const fmt = value => new Date(value).toLocaleString('id-ID', { timeZone:'Asia/Jakarta', dateStyle:'medium', timeStyle:'short' }) + ' WIB';
function render() {
  const overdue = t => !t.done && !t.archived && +new Date(t.deadline) < Date.now();
  node('count-active').textContent = tasks.filter(t => !t.done && !t.archived).length; node('count-done').textContent = tasks.filter(t => t.done).length; node('count-overdue').textContent = tasks.filter(overdue).length;
  const filter = node('filter').value, query = node('search').value.toLocaleLowerCase('id');
  const selected = tasks.filter(t => t.title.toLocaleLowerCase('id').includes(query) && (filter === 'all' || filter === 'active' && !t.done && !t.archived || filter === 'done' && t.done && !t.archived || filter === 'archived' && t.archived || filter === 'overdue' && overdue(t)));
  node('tasks').replaceChildren();
  for (const task of selected) {
    const row = document.createElement('article'); row.className = 'task' + (task.done ? ' done' : '');
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = task.done; check.disabled=task.archived; check.setAttribute('aria-label', 'Selesai: ' + task.title);
    check.addEventListener('change', async () => { check.disabled = true; try { await gatewayRequest('/api/todolist/' + task.id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({done:check.checked,revision:task.revision}) }); await load(); } catch(e) { check.checked = task.done; node('connection').textContent = e.message; } finally { check.disabled = false; } });
    const info = document.createElement('div'); info.className = 'task-info';
    const title = document.createElement('div'); title.className = 'task-title'; title.textContent = task.title;
    const meta = document.createElement('div'); meta.className = 'task-meta'; meta.textContent = '#' + task.id + ' · ' + fmt(task.deadline);
    const reminder = document.createElement('div'); reminder.className = 'task-meta'; reminder.textContent = task.archived ? 'Diarsipkan: tidak tampil di Nusa; pengingat dihentikan.' : task.done ? 'Pengingat dihentikan.' : 'Pengingat berikutnya: ' + (task.nextReminder ? fmt(task.nextReminder) : '—');
    const badge = document.createElement('span'); badge.className = 'badge' + (task.done ? ' done' : overdue(task) ? ' overdue' : ''); badge.textContent = task.archived ? 'Diarsipkan' : task.done ? 'Selesai' : overdue(task) ? 'Lewat deadline' : 'Aktif';
    info.append(title, meta, reminder, badge);
    const edit = document.createElement('button'); edit.className = 'secondary'; edit.textContent = 'Edit'; edit.addEventListener('click', () => { editing = task; node('title').value = task.title; node('deadline').value = new Date(+new Date(task.deadline) + 7 * 3600000).toISOString().slice(0,16); node('form-title').textContent = 'Edit tugas #' + task.id; node('cancel').hidden = false; node('title').focus(); });
    const archive=document.createElement('button');archive.className='secondary';archive.textContent=task.archived?'Pulihkan':'Arsipkan';
    archive.addEventListener('click',async()=>{archive.disabled=true;try{await gatewayRequest('/api/todolist/'+task.id+(task.archived?'/restore':'/archive'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:task.revision})});if(editing?.id===task.id)resetForm();await load();}catch(e){node('connection').textContent=e.message;}finally{archive.disabled=false;}});
    const actions=document.createElement('div');actions.className='actions';if(!task.archived)actions.append(edit);actions.append(archive);
    row.append(check, info, actions); node('tasks').append(row);
  }
  if (!selected.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = query ? 'Tidak ada tugas yang cocok.' : 'Belum ada tugas pada filter ini.'; node('tasks').append(empty); }
}
async function load() { const data = await gatewayRequest('/api/todolist'); tasks = data.data; render(); }
function resetForm() { editing = null; node('task-form').reset(); node('form-title').textContent = 'Tambah tugas'; node('cancel').hidden = true; }
node('task-form').addEventListener('submit', async event => { event.preventDefault(); node('save').disabled = true; node('form-message').textContent = ''; try { const data = {title:node('title').value,deadline:node('deadline').value + ':00+07:00',...(editing ? {revision:editing.revision} : {})}; await gatewayRequest('/api/todolist' + (editing ? '/' + editing.id : ''), {method:editing ? 'PATCH' : 'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); resetForm(); await load(); } catch(e) { node('form-message').textContent = e.message; } finally { node('save').disabled = false; } });
node('cancel').addEventListener('click', resetForm); node('filter').addEventListener('change', render); node('search').addEventListener('input', render);
gatewaySession.then(async () => { await load(); const stream = new EventSource('/api/todolist/stream'); stream.onmessage = () => { node('connection').textContent = 'Pembaruan langsung aktif.'; load().catch(e => node('connection').textContent = e.message); }; stream.onerror = () => { node('connection').textContent = 'Koneksi terputus. Mencoba terhubung kembali…'; }; window.addEventListener('pagehide', () => stream.close(), {once:true}); }).catch(e => node('connection').textContent = e.message);
setInterval(() => load().catch(e => node('connection').textContent = e.message), 60000);
