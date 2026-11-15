const $ = (s) => document.querySelector(s);
const DISCRETO = true; // true = la pestaña del navegador dice "Notas" con ícono 📝
const COLORS = ['#e4572e','#17a398','#7768ae','#f3a712','#2e86ab','#d1495b','#4f772d','#c06c84'];
const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 😉 😍 🥰 😘 😋 😛 😜 🤪 🤔 😏 😴 😮 😳 🥺 😢 😭 😤 😡 🤯 😱 🥵 🥶 🤗 🤭 😎 🥳 👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 🤞 👌 👀 💀 🔥 ✨ 💯 🎉 🏳️‍🌈 🌈 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💕 💖 💋 🍑 🍆 🍸 🍷 🍺 ☕ 🍕 🍔 🍩 🎂 🎁 🎶 🎮 ⚽ 🏖️ ✈️ 🚗 🏠 🌞 🌙 ⭐ 🐶 🐱 🦄 🦋'.split(' ');
const TITLES = { chats: 'Chats', offers: 'Ofertas', friends: 'Amigos', wallet: 'Cartera' };

if (!DISCRETO) {
  document.title = 'Pride Talk';
  $('link[rel=icon]').href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🏳️‍🌈%3C/text%3E%3C/svg%3E";
}

let token = localStorage.getItem('token'), me = null, socket = null;
let S = { friends: [], requests: [], sent: [], fee: 0.2 }, offers = [];
let tab = 'chats', current = null, unread = {}, mode = 'login';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const color = (n) => COLORS[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const avatar = (el, n) => { el.textContent = n[0]; el.style.background = color(n); };
const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pct = () => Math.round(S.fee * 100);

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
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ---------- Hoja inferior ----------
function sheet(title, html, wire) {
  $('#sheetTitle').textContent = title; $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden'); wire && wire($('#sheetBody'));
}
const closeSheet = () => $('#sheet').classList.add('hidden');
$('#scrim').onclick = closeSheet;
// Ejecuta una acción dentro de la hoja; muestra el error ahí mismo
async function run(fn, okMsg) {
  try { await fn(); closeSheet(); okMsg && toast(okMsg); }
  catch (e) { const el = $('#sErr'); el ? (el.textContent = e.message) : toast(e.message); }
}

// ---------- Acceso ----------
document.querySelectorAll('.seg button').forEach((b) => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#authBtn').textContent = mode === 'login' ? 'Entrar' : 'Crear cuenta';
  $('#adultRow').classList.toggle('hidden', mode === 'login');
  $('#p').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authErr').textContent = '';
});

$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const d = await api('/api/' + mode, 'POST', { username: $('#u').value, password: $('#p').value, adult: $('#adult').checked });
    token = d.token; localStorage.setItem('token', token); start();
  } catch (err) { $('#authErr').textContent = err.message; }
};

$('#logout').onclick = () => { localStorage.removeItem('token'); location.reload(); };

// ---------- Inicio ----------
async function start() {
  try { await Promise.all([loadState(), loadOffers()]); }
  catch { localStorage.removeItem('token'); token = null; return; }
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  avatar($('#meAv'), me.username);
  socket = io({ auth: { token } });
  socket.on('friends:update', loadState);
  socket.on('wallet:update', loadState);
  socket.on('offers:update', loadOffers);
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
async function loadOffers() { offers = await api('/api/offers'); render(); updateRoom(); }

// ---------- Acuerdos: utilidades ----------
const passFor = (fid) => offers.find((o) => o.status === 'accepted' && new Date(o.expiresAt) > Date.now() && (o.payer.id === fid || o.payee.id === fid));
const isLocked = (f) => f.rate > 0 && !passFor(f.id);
const myTurn = (o) => o.status === 'pending' && ((o.turn === 'payee' && o.payee.id === me.id) || (o.turn === 'payer' && o.payer.id === me.id));

// ---------- Navegación ----------
document.querySelectorAll('.nav button').forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
$('#fab').onclick = () => { tab = 'friends'; render(); };
$('#coinChip').onclick = () => { tab = 'wallet'; render(); };

function render() {
  if (!me) return;
  $('#title').textContent = TITLES[tab];
  $('#coins').textContent = me.coins;
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#fab').classList.toggle('hidden', tab !== 'chats');
  const setB = (k, n) => { const el = $(`[data-b=${k}]`); el.textContent = n; el.classList.toggle('hidden', !n); };
  setB('offers', offers.filter(myTurn).length); setB('friends', S.requests.length);
  const list = $('#list'); list.innerHTML = '';
  ({ chats: rChats, offers: rOffers, friends: rFriends, wallet: rWallet })[tab](list);
}

function rowFor(u, sub, extra = '') {
  const r = document.createElement('div'); r.className = 'row';
  r.innerHTML = `<div class="av"></div><div class="grow"><div class="name">${esc(u.username)}</div><small>${esc(sub)}</small></div>${extra}`;
  avatar(r.firstChild, u.username); return r;
}

function rChats(list) {
  if (!S.friends.length) list.innerHTML = '<p class="note">Aún no tienes amigos 🌈<br>Toca ＋ para añadir a alguien.</p>';
  S.friends.forEach((f) => {
    const extra = (f.rate ? `<span class="tag">🪙 ${f.rate}</span>` : '') + (unread[f.id] ? `<span class="badge">${unread[f.id]}</span>` : '');
    const r = rowFor(f, f.bio || (f.rate ? 'Conversación de pago' : 'Toca para chatear'), extra);
    if (current && current.id === f.id) r.classList.add('on');
    r.onclick = () => openRoom(f); list.append(r);
  });
}

function rOffers(list) {
  if (!offers.length) list.innerHTML = '<p class="note">No tienes ofertas.<br>Abre un chat y toca 🤝 para proponer un acuerdo.</p>';
  offers.forEach((o) => {
    const iPay = o.payer.id === me.id, other = iPay ? o.payee : o.payer;
    const c = document.createElement('div'); c.className = 'cardx';
    let status = '';
    if (o.status === 'accepted') status = `<small class="ok">✔ Activo hasta ${hhmm(o.expiresAt)}</small>`;
    else if (myTurn(o)) status = '<small>Te toca responder</small>';
    else status = '<small>Esperando respuesta…</small>';
    c.innerHTML = `<p>${iPay ? `Quieres hablar con <b>${esc(other.username)}</b>` : `<b>${esc(other.username)}</b> quiere hablar contigo`}<br>
      ${iPay ? 'Pagas' : 'Recibirías'} <span class="coin">🪙 ${o.amount}</span>${iPay ? '' : ` <small>(te quedan 🪙 ${Math.floor(o.amount * (1 - S.fee))})</small>`}</p>${status}`;
    if (myTurn(o)) {
      const a = document.createElement('div'); a.className = 'acts';
      a.innerHTML = `<button class="mini ok">${iPay ? 'Aceptar y pagar' : 'Aceptar y cobrar'}</button><button class="mini no">Contraoferta</button><button class="mini no">Rechazar</button>`;
      const [ok, ct, no] = a.children;
      ok.onclick = () => respond(o.id, 'accept');
      no.onclick = () => respond(o.id, 'reject');
      ct.onclick = () => sheet('Contraoferta', `<p class="hint">Ahora está en 🪙 ${o.amount}. Propón otro monto.</p>
        <input id="amt" type="number" min="1" value="${o.amount}"><button class="primary" id="go">Enviar contraoferta</button><p class="err" id="sErr"></p>`,
        () => $('#go').onclick = () => run(() => api(`/api/offers/${o.id}/respond`, 'POST', { action: 'counter', amount: +$('#amt').value }), 'Contraoferta enviada'));
      c.append(a);
    }
    list.append(c);
  });
}
const respond = (id, action) => api(`/api/offers/${id}/respond`, 'POST', { action })
  .then(() => toast(action === 'accept' ? 'Acuerdo cerrado 🎉' : 'Propuesta rechazada')).catch((e) => toast(e.message));

function rFriends(list) {
  list.innerHTML = `<div class="form"><label>Añadir por nombre de usuario</label>
    <input id="fname" placeholder="usuario" autocapitalize="none"><button class="primary" id="fsend">Enviar solicitud</button><p id="fmsg" class="err"></p></div>`;
  $('#fsend').onclick = async () => {
    const m = $('#fmsg');
    try { await api('/api/friends/request', 'POST', { username: $('#fname').value }); m.className = 'err ok'; m.textContent = 'Solicitud enviada ✔'; $('#fname').value = ''; }
    catch (e) { m.className = 'err'; m.textContent = e.message; }
  };
  if (S.requests.length) list.insertAdjacentHTML('beforeend', '<div class="sect">Solicitudes recibidas</div>');
  S.requests.forEach((u) => {
    const r = rowFor(u, 'Quiere ser tu amigo', '<button class="mini ok">Aceptar</button><button class="mini no">✕</button>');
    const [ok, no] = r.querySelectorAll('button');
    ok.onclick = () => api('/api/friends/respond', 'POST', { id: u.id, accept: true }).catch((e) => toast(e.message));
    no.onclick = () => api('/api/friends/respond', 'POST', { id: u.id, accept: false }).catch((e) => toast(e.message));
    list.append(r);
  });
  if (S.sent.length) list.insertAdjacentHTML('beforeend', '<div class="sect">Enviadas</div>');
  S.sent.forEach((u) => list.append(rowFor(u, 'Pendiente')));
}

async function rWallet(list) {
  list.innerHTML = `<div class="balance"><small>Saldo disponible</small><b>🪙 ${me.coins}</b>
      <div class="acts"><button class="mini" id="topup">Recargar</button><button class="mini" id="withdraw">Retirar</button></div></div>
    <div class="form"><label>Mi tarifa por 24 h de conversación (0 = gratis)</label>
      <input id="rate" type="number" min="0" value="${me.rate}">
      <label>Mi bio</label><input id="bio" maxlength="140" value="${esc(me.bio)}">
      <button class="primary" id="saveP">Guardar perfil</button><p id="pmsg" class="err"></p></div>
    <div class="sect">Movimientos</div><div id="txs"></div>`;
  $('#saveP').onclick = async () => {
    try { await api('/api/profile', 'POST', { rate: +$('#rate').value, bio: $('#bio').value }); toast('Perfil guardado'); loadState(); }
    catch (e) { $('#pmsg').textContent = e.message; }
  };
  $('#topup').onclick = () => sheet('Recargar monedas', `<p class="hint">Aquí se conectará tu pasarela de pago (Stripe, Mercado Pago…). En modo prueba se suman gratis.</p>
    <div class="quick">${[50, 100, 500].map((n) => `<button data-n="${n}">+${n}</button>`).join('')}</div>
    <input id="amt" type="number" min="1" value="100"><button class="primary" id="go">Recargar</button><p class="err" id="sErr"></p>`,
    (b) => { b.querySelectorAll('.quick button').forEach((q) => q.onclick = () => $('#amt').value = q.dataset.n);
      $('#go').onclick = () => run(() => api('/api/wallet/topup', 'POST', { amount: +$('#amt').value }), 'Monedas añadidas'); });
  $('#withdraw').onclick = () => sheet('Retirar ganancias', `<p class="hint">Se descuenta de tu saldo y queda como solicitud pendiente de pago.</p>
    <input id="amt" type="number" min="1" value="${me.coins}"><button class="primary" id="go">Solicitar retiro</button><p class="err" id="sErr"></p>`,
    () => $('#go').onclick = () => run(() => api('/api/wallet/withdraw', 'POST', { amount: +$('#amt').value }), 'Retiro solicitado'));
  try {
    const w = await api('/api/wallet'); const box = $('#txs'); if (!box) return;
    box.innerHTML = w.txs.length ? '' : '<p class="note">Sin movimientos todavía.</p>';
    w.txs.forEach((t) => box.insertAdjacentHTML('beforeend',
      `<div class="tx"><span>${esc(t.type)}<small>${esc(t.note || '')} · ${new Date(t.createdAt).toLocaleDateString()}</small></span><span class="${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : ''}${t.amount}</span></div>`));
  } catch {}
}

// ---------- Sala de chat ----------
async function openRoom(f) {
  current = f; unread[f.id] = 0;
  $('#empty').classList.add('hidden'); $('#room').classList.remove('hidden'); $('#app').classList.add('open');
  avatar($('#rAv'), f.username); $('#rName').textContent = f.username;
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
  current = f;
  const pass = passFor(f.id), lock = isLocked(f);
  $('#rSub').textContent = f.rate > 0 ? (pass ? `Acuerdo activo hasta ${hhmm(pass.expiresAt)}` : `Cobra 🪙 ${f.rate} por 24 h`) : 'Conversación gratis';
  $('#lockTxt').textContent = `${f.username} cobra 🪙 ${f.rate} por 24 h de conversación. Propón un acuerdo para poder escribirle.`;
  $('#lock').classList.toggle('hidden', !lock); $('#form').classList.toggle('hidden', lock);
  if (lock) $('#emojis').classList.add('hidden');
}

const openOffer = () => current && sheet('Proponer acuerdo', `<p class="hint">Ofrece cuántas monedas pagas por 24 h de conversación con <b>${esc(current.username)}</b>.
  Solo se cobra si acepta. La plataforma retiene ${pct()}%. Tu saldo: 🪙 ${me.coins}.</p>
  <input id="amt" type="number" min="1" value="${current.rate || 50}"><button class="primary" id="go">Enviar propuesta</button><p class="err" id="sErr"></p>`,
  () => $('#go').onclick = () => run(() => api('/api/offers', 'POST', { to: current.id, amount: +$('#amt').value }), 'Propuesta enviada'));
$('#dealBtn').onclick = openOffer; $('#lockBtn').onclick = openOffer;

$('#giftBtn').onclick = () => current && sheet('Enviar propina 🎁', `<p class="hint">Regala monedas a ${esc(current.username)}. Tu saldo: 🪙 ${me.coins}.</p>
  <div class="quick">${[5, 10, 50, 100].map((n) => `<button data-n="${n}">🪙 ${n}</button>`).join('')}</div>
  <input id="amt" type="number" min="1" value="10"><button class="primary" id="go">Enviar</button><p class="err" id="sErr"></p>`,
  (b) => { b.querySelectorAll('.quick button').forEach((q) => q.onclick = () => $('#amt').value = q.dataset.n);
    $('#go').onclick = () => run(() => api('/api/gift', 'POST', { to: current.id, amount: +$('#amt').value }), 'Propina enviada'); });

$('#moreBtn').onclick = () => current && sheet(current.username, `<button class="primary" id="blk" style="background:#7a2b3d">Bloquear a ${esc(current.username)}</button>
  <p class="hint">Se elimina la amistad y ya no podrá escribirte ni enviarte solicitudes.</p>`,
  () => $('#blk').onclick = () => run(() => api('/api/block', 'POST', { id: current.id }), 'Usuario bloqueado'));

const onlyEmoji = (t) => t && t.length <= 12 && /^(\p{Extended_Pictographic}|\u200d|\ufe0f|\s)+$/u.test(t);
function addMsg(m) {
  const el = document.createElement('div');
  el.className = 'm ' + (m.from === me.id ? 'me' : 'them') + (m.text.startsWith('🎁 ') ? ' gift' : (!m.image && onlyEmoji(m.text) ? ' big' : ''));
  if (m.image) {
    const img = new Image(); img.src = m.image; img.alt = 'Imagen';
    img.onclick = () => { $('#viewerImg').src = m.image; $('#viewer').classList.remove('hidden'); };
    img.onload = scrollDown; el.append(img);
  }
  if (m.text) el.append(document.createTextNode(m.text));
  const t = document.createElement('time'); t.textContent = hhmm(m.createdAt); el.append(t);
  $('#msgs').append(el); scrollDown();
}
const scrollDown = () => { const b = $('#msgs'); b.scrollTop = b.scrollHeight; };
$('#viewer').onclick = () => $('#viewer').classList.add('hidden');

function onMessage(m) {
  const other = m.from === me.id ? m.to : m.from;
  if (current && current.id === other) addMsg(m); else { unread[other] = (unread[other] || 0) + 1; render(); }
}
function send(payload) {
  if (current) socket.emit('message', { to: current.id, ...payload }, (r) => r && r.error && toast(r.error));
}
$('#form').onsubmit = (e) => { e.preventDefault(); const t = $('#text').value.trim(); if (t) { send({ text: t }); $('#text').value = ''; } };
$('#emojiBtn').onclick = () => $('#emojis').classList.toggle('hidden');

$('#imgBtn').onclick = () => $('#file').click();
$('#file').onchange = (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !f.type.startsWith('image/')) return;
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 900 / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = img.width * k; c.height = img.height * k;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    send({ image: c.toDataURL('image/jpeg', 0.75), text: $('#text').value.trim() });
    $('#text').value = ''; URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(f);
};

if (token) start();
