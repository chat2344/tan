// DNS de Google/Cloudflare para resolver mongodb+srv (corrige ECONNREFUSED querySrv)
const dns = require('dns');
if (process.env.USE_GOOGLE_DNS !== 'false') dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Detecta conexiones caídas más rápido (mejora también el estado «en línea»)
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000 });
const SECRET = process.env.JWT_SECRET || 'cambia-este-secreto';
const MAX_IMG = 80 * 1024 * 1024; // 80 MB
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const { ObjectId } = mongoose.Schema.Types;

app.set('trust proxy', 1);
app.get('/health', (req, res) => res.send('ok'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Modelos ----------
const ref = () => [{ type: ObjectId, ref: 'User' }];
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  bio: { type: String, default: '' },
  lastSeen: { type: Date, default: null }, // última vez en línea
  nicknames: { type: Map, of: String, default: {} }, // apodos privados: { idAmigo: "apodo" }
  friends: ref(), requests: ref(), sent: ref(), blocked: ref()
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  from: { type: ObjectId, ref: 'User', index: true },
  to: { type: ObjectId, ref: 'User', index: true },
  text: { type: String, default: '' },
  image: { type: String, default: '' }, // /api/media/<id>
  createdAt: { type: Date, default: Date.now }
}));

// ---------- Utilidades ----------
const sign = (u) => jwt.sign({ id: u._id }, SECRET, { expiresIn: '30d' });
const pub = (u) => ({ id: String(u._id), username: u.username });
const notify = (ev, ...ids) => {
  if (ev === 'friends:update') friendCache.clear(); // cambió alguna amistad/apodo/bloqueo
  ids.forEach((i) => io.to(String(i)).emit(ev));
};
const fail = (res, code, error) => res.status(code).json({ error });
// Presencia: uid -> { n: conexiones abiertas, timer }
const online = new Map();
async function broadcastPresence(uid, on, lastSeen) {
  const u = await User.findById(uid).select('friends');
  if (u) u.friends.forEach((f) => io.to(String(f)).emit('presence', { id: String(uid), online: on, lastSeen }));
}
// Caché corta de amistades: evita una consulta a Mongo por cada mensaje enviado
const friendCache = new Map();
const areFriends = async (a, b) => {
  const k = `${a}:${b}`, c = friendCache.get(k);
  if (c && Date.now() - c.t < 60000) return c.ok;
  const ok = !!(await User.exists({ _id: a, friends: b }));
  if (friendCache.size > 5000) friendCache.clear();
  friendCache.set(k, { ok, t: Date.now() });
  return ok;
};
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'media' });

function auth(req, res, next) {
  try {
    // El token también puede ir en ?t= (las etiquetas <img> no pueden enviar cabeceras)
    const t = (req.headers.authorization || '').replace('Bearer ', '') || req.query.t || '';
    req.uid = jwt.verify(t, SECRET).id;
    next();
  } catch { fail(res, 401, 'Sesión no válida'); }
}

async function stateOf(uid) {
  const u = await User.findById(uid)
    .populate('friends', 'username bio lastSeen nicknames').populate('requests', 'username').populate('sent', 'username');
  if (!u) return null;
  return {
    me: { ...pub(u), bio: u.bio },
    friends: u.friends.map((f) => ({ ...pub(f), bio: f.bio || '', nick: u.nicknames.get(String(f._id)) || '', theirNick: (f.nicknames && f.nicknames.get(String(u._id))) || '', online: online.has(String(f._id)), lastSeen: f.lastSeen || null })),
    requests: u.requests.map(pub), sent: u.sent.map(pub)
  };
}

// ---------- Cuenta ----------
app.post('/api/register', async (req, res) => {
  const { username = '', password = '' } = req.body;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return fail(res, 400, 'Usuario: 3-20 letras, números o _');
  if (password.length < 4) return fail(res, 400, 'La contraseña debe tener al menos 4 caracteres');
  try {
    const u = await User.create({ username, password: await bcrypt.hash(password, 10) });
    res.json({ token: sign(u), user: pub(u) });
  } catch (e) {
    fail(res, 400, e.code === 11000 ? 'Ese usuario ya existe' : 'No se pudo crear la cuenta');
  }
});

app.post('/api/login', async (req, res) => {
  const { username = '', password = '' } = req.body;
  const u = await User.findOne({ username: username.toLowerCase().trim() });
  if (!u || !(await bcrypt.compare(password, u.password))) return fail(res, 400, 'Usuario o contraseña incorrectos');
  res.json({ token: sign(u), user: pub(u) });
});

app.get('/api/state', auth, async (req, res) => {
  const s = await stateOf(req.uid);
  s ? res.json(s) : fail(res, 401, 'Sesión no válida');
});

app.post('/api/profile', auth, async (req, res) => {
  await User.updateOne({ _id: req.uid }, { bio: String(req.body.bio || '').slice(0, 140) });
  const me = await User.findById(req.uid).select('friends');
  notify('friends:update', req.uid, ...me.friends);
  res.json({ ok: true });
});

// Apodo privado para un amigo (solo lo ve quien lo pone)
app.post('/api/nickname', auth, async (req, res) => {
  const { id } = req.body;
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!mongoose.isValidObjectId(id) || !(await areFriends(req.uid, id))) return fail(res, 400, 'Datos no válidos');
  await User.updateOne({ _id: req.uid }, name ? { $set: { [`nicknames.${id}`]: name } } : { $unset: { [`nicknames.${id}`]: 1 } });
  notify('friends:update', req.uid, id); // el otro ve el cambio al instante
  res.json({ ok: true });
});

// ---------- Amigos ----------
app.post('/api/friends/request', auth, async (req, res) => {
  const target = await User.findOne({ username: String(req.body.username || '').toLowerCase().trim() });
  if (!target) return fail(res, 404, 'No existe ese usuario');
  if (String(target._id) === req.uid) return fail(res, 400, 'No puedes agregarte a ti mismo');
  const me = await User.findById(req.uid);
  if (me.blocked.some((f) => f.equals(target._id)) || target.blocked.some((f) => f.equals(me._id)))
    return fail(res, 400, 'No se puede enviar la solicitud');
  if (me.friends.some((f) => f.equals(target._id))) return fail(res, 400, 'Ya son amigos');
  if (me.sent.some((f) => f.equals(target._id))) return fail(res, 400, 'Ya enviaste una solicitud');

  if (me.requests.some((f) => f.equals(target._id))) {
    await User.updateOne({ _id: me._id }, { $pull: { requests: target._id }, $addToSet: { friends: target._id } });
    await User.updateOne({ _id: target._id }, { $pull: { sent: me._id }, $addToSet: { friends: me._id } });
  } else {
    await User.updateOne({ _id: me._id }, { $addToSet: { sent: target._id } });
    await User.updateOne({ _id: target._id }, { $addToSet: { requests: me._id } });
  }
  notify('friends:update', me._id, target._id);
  res.json({ ok: true });
});

app.post('/api/friends/respond', auth, async (req, res) => {
  const { id, accept } = req.body;
  if (!mongoose.isValidObjectId(id)) return fail(res, 400, 'Datos no válidos');
  const me = await User.findById(req.uid);
  if (!me.requests.some((f) => f.equals(id))) return fail(res, 400, 'No hay solicitud');
  await User.updateOne({ _id: me._id }, { $pull: { requests: id }, ...(accept && { $addToSet: { friends: id } }) });
  await User.updateOne({ _id: id }, { $pull: { sent: me._id }, ...(accept && { $addToSet: { friends: me._id } }) });
  notify('friends:update', me._id, id);
  res.json({ ok: true });
});

app.post('/api/block', auth, async (req, res) => {
  const { id } = req.body;
  if (!mongoose.isValidObjectId(id) || id === req.uid) return fail(res, 400, 'Datos no válidos');
  await User.updateOne({ _id: req.uid }, { $pull: { friends: id, requests: id, sent: id }, $addToSet: { blocked: id } });
  await User.updateOne({ _id: id }, { $pull: { friends: req.uid, requests: req.uid, sent: req.uid } });
  notify('friends:update', req.uid, id);
  res.json({ ok: true });
});

// ---------- Mensajes ----------
app.get('/api/messages/:id', auth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !(await areFriends(req.uid, req.params.id)))
    return fail(res, 403, 'No son amigos');
  const msgs = await Message.find({
    $or: [{ from: req.uid, to: req.params.id }, { from: req.params.id, to: req.uid }]
  }).sort({ createdAt: -1 }).limit(200);
  res.json(msgs.reverse());
});

// Último mensaje de cada chat (para la lista de chats)
app.get('/api/last', auth, async (req, res) => {
  const me = await User.findById(req.uid).select('friends');
  const out = {};
  await Promise.all(me.friends.map(async (f) => {
    const m = await Message.findOne({ $or: [{ from: req.uid, to: f }, { from: f, to: req.uid }] }).sort({ createdAt: -1 });
    if (m) out[f] = { text: m.text, image: !!m.image, from: String(m.from), createdAt: m.createdAt };
  }));
  res.json(out);
});

// ---------- Fotos (hasta 80 MB, guardadas en GridFS) ----------
// El cliente envía el archivo tal cual en el cuerpo: POST /api/upload?to=<id>  (Content-Type: image/*)
app.post('/api/upload', auth, async (req, res) => {
  const to = String(req.query.to || '');
  const type = (req.headers['content-type'] || '').split(';')[0];
  if (!IMG_TYPES.includes(type)) return fail(res, 415, 'Formato no compatible (usa JPG, PNG, GIF o WEBP)');
  if (!mongoose.isValidObjectId(to) || !(await areFriends(req.uid, to))) return fail(res, 403, 'No son amigos');
  if (Number(req.headers['content-length'] || 0) > MAX_IMG) return fail(res, 413, 'La imagen pesa más de 80 MB');

  const up = bucket().openUploadStream('img', { contentType: type, metadata: { from: req.uid, to } });
  let size = 0, aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_IMG && !aborted) {
      aborted = true; req.unpipe(up); up.abort(() => {});
      fail(res, 413, 'La imagen pesa más de 80 MB');
      res.on('finish', () => req.destroy());
    }
  });
  req.on('aborted', () => { aborted = true; up.abort(() => {}); });
  up.on('error', () => { if (!aborted) fail(res, 500, 'No se pudo guardar la imagen'); });
  up.on('finish', async () => {
    if (aborted) return;
    const m = await Message.create({ from: req.uid, to, image: '/api/media/' + up.id });
    io.to(String(req.uid)).to(to).emit('message', m);
    res.json({ ok: true });
  });
  req.pipe(up);
});

app.get('/api/media/:id', auth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'No encontrada');
  const [f] = await bucket().find({ _id: new mongoose.Types.ObjectId(req.params.id) }).toArray();
  if (!f) return fail(res, 404, 'No encontrada');
  if (![f.metadata.from, f.metadata.to].includes(req.uid)) return fail(res, 403, 'Sin permiso');
  res.set({ 'Content-Type': f.contentType, 'Content-Length': f.length, 'Cache-Control': 'private, max-age=31536000' });
  bucket().openDownloadStream(f._id).pipe(res);
});

// ---------- Tiempo real (texto) ----------
io.use((socket, next) => {
  try { socket.uid = jwt.verify(socket.handshake.auth.token, SECRET).id; next(); }
  catch { next(new Error('auth')); }
});

io.on('connection', (socket) => {
  const uid = String(socket.uid);
  socket.join(uid);

  // Presencia (con 4 s de margen para no parpadear al recargar la página)
  const e = online.get(uid) || { n: 0, timer: null };
  const wasOnline = online.has(uid);
  clearTimeout(e.timer); e.timer = null; e.n++; online.set(uid, e);
  if (!wasOnline) broadcastPresence(uid, true, null);

  socket.on('disconnect', () => {
    const x = online.get(uid); if (!x) return;
    x.n--;
    if (x.n <= 0) x.timer = setTimeout(async () => {
      online.delete(uid);
      const ls = new Date();
      await User.updateOne({ _id: uid }, { lastSeen: ls }).catch(() => {});
      broadcastPresence(uid, false, ls);
    }, 4000);
  });

  socket.on('message', async ({ to, text = '', cid } = {}, cb = () => {}) => {
    try {
      text = String(text).trim().slice(0, 4000);
      if (!text) return cb({ error: 'Mensaje vacío' });
      if (!mongoose.isValidObjectId(to) || !(await areFriends(socket.uid, to))) return cb({ error: 'No son amigos' });
      // Primero se entrega (rápido) y después se guarda en la base de datos
      const m = new Message({ from: socket.uid, to, text });
      const payload = { ...m.toObject(), cid: typeof cid === 'string' ? cid.slice(0, 40) : undefined };
      io.to(String(socket.uid)).to(String(to)).emit('message', payload);
      cb({ ok: true });
      m.save().catch(() => socket.emit('message:failed', { cid: payload.cid }));
    } catch { cb({ error: 'No se pudo enviar' }); }
  });
});

// ---------- Arranque (Render: puerto en process.env.PORT y host 0.0.0.0) ----------
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

if (!process.env.MONGO_URI) { console.error('Falta la variable MONGO_URI'); process.exit(1); }

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB conectado');
    server.listen(PORT, HOST, () => console.log(`App escuchando en ${HOST}:${PORT}`));
  })
  .catch((e) => { console.error('Error MongoDB:', e.message); process.exit(1); });
