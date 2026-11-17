const $ = (s) => document.querySelector(s);
const DISCRETO = true; // true = la pestaña del navegador dice "Notas" con ícono 📝
const MAX_MB = 80;
const COLORS = ['#e4572e','#17a398','#7768ae','#f3a712','#2e86ab','#d1495b','#4f772d','#c06c84'];
const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 😉 😍 🥰 😘 😋 😛 😜 🤪 🤔 😏 😴 😮 😳 🥺 😢 😭 😤 😡 🤯 😱 🥵 🥶 🤗 🤭 😎 🥳 👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 🤞 👌 👀 💀 🔥 ✨ 💯 🎉 🏳️‍🌈 🌈 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💕 💖 💋 🍑 🍆 🍸 🍷 🍺 ☕ 🍕 🍔 🍩 🎂 🎁 🎶 🎮 ⚽ 🏖️ ✈️ 🚗 🏠 🌞 🌙 ⭐ 🐶 🐱 🦄 🦋'.split(' ');

if (!DISCRETO) {
  document.title = 'Mensajes';
  $('link[rel=icon]').href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💬%3C/text%3E%3C/svg%3E";
}

let token = localStorage.getItem('token'), me = null, socket = null;
let S = { friends: [], requests: [], sent: [] }, last = {};
let tab = 'chats', current = null, unread = {}, mode = 'login', lastDay = '';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const color = (n) => COLORS[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const avatar = (el, n) => { el.textContent = [...n][0]; el.style.background = color(n); };
const nm = (f) => f.nick || f.username;                       // apodo si existe
const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function dayLabel(d) {
  const t = new Date(), y = new Date(Date.now() - 864e5);
  if (sameDay(d, t)) return 'Hoy'; if (sameDay(d, y)) return 'Ayer';
  return new Date(d).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}
const shortDay = (d) => sameDay(d, new Date()) ? hhmm(d) : sameDay(d, Date.now() - 864e5) ? 'Ayer' : new Date(d).toLocaleDateString();
const mediaUrl = (u) => u.startsWith('/api/media/') ? `${u}?t=${encodeURIComponent(token)}` : u;

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: body && JSON.stringify(body)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Error'), { status: r.status });
  return d;
}

let toastT;
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ---------- Hoja inferior ----------
function sheet(title, html, wire) {
  $('#sheetTitle').textContent = title; $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden'); wire && wire($('#sheetBody'));
}
const closeSheet = () => $('#sheet').classList.add('hidden');
$('#scrim').onclick = closeSheet;
async function run(fn, okMsg) {
  try { await fn(); closeSheet(); okMsg && toast(okMsg); }
  catch (e) { const el = $('#sErr'); el ? (el.textContent = e.message) : toast(e.message); }
}

// ---------- Acceso ----------
document.querySelectorAll('.seg button').forEach((b) => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#authBtn').textContent = mode === 'login' ? 'Entrar' : 'Crear cuenta';
  $('#p').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authErr').textContent = '';
});
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const d = await api('/api/' + mode, 'POST', { username: $('#u').value, password: $('#p').value });
    token = d.token; localStorage.setItem('token', token); start();
  } catch (err) { $('#authErr').textContent = err.message; }
};

// ---------- Inicio ----------
async function start() {
  try { await Promise.all([loadState(), loadLast()]); }
  catch { localStorage.removeItem('token'); token = null; return; }
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  socket = io({ auth: { token } });
  socket.on('friends:update', () => { loadState(); loadLast(); });
  socket.on('message', onMessage);
  EMOJIS.forEach((em) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = em;
    b.onclick = () => { $('#text').value += em; $('#text').focus(); };
    $('#emojis').append(b);
  });
  render();
}
async function loadState() {
  const d = await api('/api/state'); me = d.me; S = d;
  if (current && !S.friends.some((f) => f.id === current.id)) closeRoom();
  render(); updateRoom();
}
async function loadLast() { last = await api('/api/last'); render(); }

// ---------- Navegación y listas ----------
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
$('#fab').onclick = () => { tab = 'add'; render(); };

function render() {
  if (!me) return;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#fab').classList.toggle('hidden', tab !== 'chats');
  const rb = $('#reqBadge'); rb.textContent = S.requests.length; rb.classList.toggle('hidden', !S.requests.length);
  const list = $('#list'); list.innerHTML = '';
  ({ chats: rChats, requests: rRequests, add: rAdd })[tab](list);
}

function rChats(list) {
  if (!S.friends.length) { list.innerHTML = '<p class="note">Aún no tienes chats.<br>Toca 💬 para añadir a un amigo.</p>'; return; }
  const t = (f) => new Date(last[f.id]?.createdAt || 0);
  [...S.friends].sort((a, b) => t(b) - t(a)).forEach((f) => {
    const l = last[f.id];
    const prev = l ? (l.from === me.id ? 'Tú: ' : '') + (l.image ? '📷 ' + (l.text || 'Foto') : l.text) : (f.bio || 'Toca para chatear');
    const r = document.createElement('div'); r.className = 'row' + (current && current.id === f.id ? ' on' : '');
    r.innerHTML = `<div class="av"></div><div class="mid"><div class="l1"><b>${esc(nm(f))}</b><time>${l ? shortDay(l.createdAt) : ''}</time></div>
      <div class="l2"><span>${esc(prev)}</span>${unread[f.id] ? `<em class="badge">${unread[f.id]}</em>` : ''}</div></div>`;
    avatar(r.firstChild, nm(f)); r.onclick = () => openRoom(f); list.append(r);
  });
}

function simpleRow(u, sub, extra = '') {
  const r = document.createElement('div'); r.className = 'row';
  r.innerHTML = `<div class="av"></div><div class="mid"><div class="l1"><b>${esc(u.username)}</b>${extra}</div><div class="l2"><span>${esc(sub)}</span></div></div>`;
  avatar(r.firstChild, u.username); return r;
}

function rRequests(list) {
  if (!S.requests.length && !S.sent.length) list.innerHTML = '<p class="note">No hay solicitudes pendientes.</p>';
  if (S.requests.length) list.insertAdjacentHTML('beforeend', '<div class="sect">Recibidas</div>');
  S.requests.forEach((u) => {
    const r = simpleRow(u, 'Quiere ser tu amigo', '<span><button class="mini">Aceptar</button><button class="mini no">✕</button></span>');
    const [ok, no] = r.querySelectorAll('button');
    ok.onclick = () => api('/api/friends/respond', 'POST', { id: u.id, accept: true }).catch((e) => toast(e.message));
    no.onclick = () => api('/api/friends/respond', 'POST', { id: u.id, accept: false }).catch((e) => toast(e.message));
    list.append(r);
  });
  if (S.sent.length) list.insertAdjacentHTML('beforeend', '<div class="sect">Enviadas</div>');
  S.sent.forEach((u) => list.append(simpleRow(u, 'Pendiente')));
}

function rAdd(list) {
  list.innerHTML = `<div class="form"><label>Añadir por nombre de usuario</label>
    <input id="fname" placeholder="usuario" autocapitalize="none"><button class="primary" id="fsend">Enviar solicitud</button><p id="fmsg" class="err"></p></div>`;
  $('#fsend').onclick = async () => {
    const m = $('#fmsg');
    try { await api('/api/friends/request', 'POST', { username: $('#fname').value }); m.className = 'err ok'; m.textContent = 'Solicitud enviada ✔'; $('#fname').value = ''; }
    catch (e) { m.className = 'err'; m.textContent = e.message; }
  };
}

// ---------- Menú principal y perfil ----------
$('#menuBtn').onclick = () => sheet('Menú', `<button class="opt" id="oProf">Mi perfil</button><button class="opt red" id="oOut">Cerrar sesión</button>`, () => {
  $('#oProf').onclick = profileSheet;
  $('#oOut').onclick = () => { localStorage.removeItem('token'); location.reload(); };
});
function profileSheet() {
  sheet('Mi perfil', `<p class="hint">Usuario: <b>${esc(me.username)}</b></p><input id="bio" maxlength="140" placeholder="Info (se muestra a tus amigos)" value="${esc(me.bio)}">
    <button class="primary" id="go">Guardar</button><p class="err" id="sErr"></p>`,
    () => $('#go').onclick = () => run(() => api('/api/profile', 'POST', { bio: $('#bio').value }).then(loadState), 'Perfil guardado'));
}

// ---------- Sala de chat ----------
async function openRoom(f) {
  current = f; unread[f.id] = 0; lastDay = '';
  $('#empty').classList.add('hidden'); $('#room').classList.remove('hidden'); $('#app').classList.add('open');
  $('#msgs').innerHTML = ''; $('#emojis').classList.add('hidden');
  render(); updateRoom();
  try { const msgs = await api('/api/messages/' + f.id); if (current && current.id === f.id) msgs.forEach(addMsg); }
  catch (e) { toast(e.message); }
}
function closeRoom() {
  current = null; $('#room').classList.add('hidden'); $('#empty').classList.remove('hidden');
  $('#app').classList.remove('open'); render();
}
$('#back').onclick = closeRoom;

function updateRoom() {
  if (!current) return;
  const f = S.friends.find((x) => x.id === current.id); if (!f) return;
  current = f; avatar($('#rAv'), nm(f));
  $('#rName').textContent = nm(f);
  $('#rSub').textContent = f.nick ? `@${f.username}` : (f.bio || 'Toca para ver opciones');
}

// Apodos
const nickSheet = () => current && sheet('Apodo', `<p class="hint">Solo tú verás este apodo. Usuario real: <b>@${esc(current.username)}</b></p>
  <input id="nick" maxlength="30" placeholder="Escribe un apodo" value="${esc(current.nick || '')}">
  <button class="primary" id="go">Guardar</button><p class="hint">Déjalo vacío para quitar el apodo.</p><p class="err" id="sErr"></p>`,
  () => $('#go').onclick = () => run(() => api('/api/nickname', 'POST', { id: current.id, name: $('#nick').value }).then(loadState), 'Apodo guardado'));

const roomMenu = () => current && sheet(nm(current), `<button class="opt" id="oNick">✏️ Poner apodo</button><button class="opt red" id="oBlk">🚫 Bloquear</button>`, () => {
  $('#oNick').onclick = nickSheet;
  $('#oBlk').onclick = () => sheet('¿Bloquear?', `<p class="hint">Se elimina la amistad y ${esc(nm(current))} ya no podrá escribirte ni enviarte solicitudes.</p>
    <button class="primary" id="go" style="background:#e5484d">Bloquear</button>`,
    () => $('#go').onclick = () => run(() => api('/api/block', 'POST', { id: current.id }), 'Usuario bloqueado'));
});
$('#moreBtn').onclick = roomMenu; $('#rHead').onclick = roomMenu;

// Mensajes
const onlyEmoji = (t) => t && t.length <= 12 && /^(\p{Extended_Pictographic}|\u200d|\ufe0f|\s)+$/u.test(t);
function addMsg(m) {
  if (!sameDay(m.createdAt, lastDay || 0) || !lastDay) {
    const d = document.createElement('div'); d.className = 'day'; d.textContent = dayLabel(m.createdAt); $('#msgs').append(d);
  }
  lastDay = m.createdAt;
  const el = document.createElement('div');
  el.className = 'm ' + (m.from === me.id ? 'me' : 'them') + (m.image ? ' pic' + (m.text ? '' : ' only') : (onlyEmoji(m.text) ? ' big' : ''));
  if (m.image) {
    const src = mediaUrl(m.image), img = new Image();
    img.alt = 'Foto'; img.loading = 'lazy'; img.src = src; img.onclick = () => openViewer(src); img.onload = scrollDown;
    el.append(img);
  }
  if (m.text) { const s = document.createElement(m.image ? 'div' : 'span'); if (m.image) s.className = 'cap'; s.textContent = m.text; el.append(s); }
  const t = document.createElement('time'); t.textContent = hhmm(m.createdAt); el.append(t);
  $('#msgs').append(el); scrollDown();
}
const scrollDown = () => { const b = $('#msgs'); b.scrollTop = b.scrollHeight; };

function onMessage(m) {
  const other = m.from === me.id ? m.to : m.from;
  last[other] = { text: m.text, image: !!m.image, from: m.from, createdAt: m.createdAt };
  if (current && current.id === other) { addMsg(m); render(); }
  else { unread[other] = (unread[other] || 0) + 1; render(); }
}
$('#form').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#text').value.trim(); if (!t || !current) return;
  socket.emit('message', { to: current.id, text: t }, (r) => r && r.error && toast(r.error));
  $('#text').value = '';
};
$('#emojiBtn').onclick = () => $('#emojis').classList.toggle('hidden');

// ---------- Fotos: cámara o galería (hasta 80 MB) ----------
$('#camBtn').onclick = () => $('#fileCam').click();
$('#clipBtn').onclick = () => sheet('Enviar foto', `<div class="grid">
    <button id="gCam"><i style="background:#e5484d">📷</i>Cámara</button>
    <button id="gGal"><i style="background:#7c4dff">🖼️</i>Galería</button></div>
  <p class="hint" style="text-align:center">JPG, PNG, GIF o WEBP · máximo ${MAX_MB} MB</p>`, () => {
  $('#gCam').onclick = () => { closeSheet(); $('#fileCam').click(); };
  $('#gGal').onclick = () => { closeSheet(); $('#fileGal').click(); };
});
for (const id of ['#fileCam', '#fileGal']) $(id).onchange = (e) => {
  [...e.target.files].forEach(upload); e.target.value = '';
};

function upload(file) {
  if (!current) return;
  const to = current.id;
  if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) return toast('Formato no compatible (usa JPG, PNG, GIF o WEBP)');
  if (file.size > MAX_MB * 1024 * 1024) return toast(`La imagen pesa más de ${MAX_MB} MB`);
  const el = document.createElement('div'); el.className = 'm me up';
  el.innerHTML = '<span>Subiendo…</span><div class="bar"><i></i></div>';
  $('#msgs').append(el); scrollDown();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload?to=' + to);
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.setRequestHeader('Content-Type', file.type);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const p = Math.round((e.loaded / e.total) * 100);
    el.querySelector('i').style.width = p + '%'; el.querySelector('span').textContent = `Subiendo ${p}%`;
  };
  xhr.onload = () => {
    el.remove();
    if (xhr.status !== 200) { let msg = 'No se pudo enviar la foto'; try { msg = JSON.parse(xhr.responseText).error; } catch {} toast(msg); }
  };
  xhr.onerror = () => { el.remove(); toast('Error de conexión al subir la foto'); };
  xhr.send(file);
}

// ---------- Visor de imágenes ----------
function openViewer(src) {
  const img = $('#vImg'); img.classList.remove('zoom'); img.src = src; $('#vDl').href = src;
  $('#viewer').classList.remove('hidden'); $('#viewer').scrollTo(0, 0);
}
const closeViewer = () => { $('#viewer').classList.add('hidden'); $('#vImg').src = ''; };
$('#vImg').onclick = (e) => { e.stopPropagation(); e.target.classList.toggle('zoom'); };
$('#vClose').onclick = closeViewer;
$('#viewer').onclick = (e) => { if (e.target.id === 'viewer') closeViewer(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeViewer(); closeSheet(); } });

if (token) start();
