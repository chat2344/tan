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
const io = new Server(server, { maxHttpBufferSize: 5e6 });
const SECRET = process.env.JWT_SECRET || 'cambia-este-secreto';
const FEE = Number(process.env.PLATFORM_FEE ?? 0.2);
const DEMO = process.env.DEMO_MODE === 'true';
const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW || 100);
const PASS_HOURS = 24;
const { ObjectId } = mongoose.Schema.Types;

app.set('trust proxy', 1); // Render va detrás de un proxy
app.get('/health', (req, res) => res.send('ok')); // para el Health Check de Render
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Modelos ----------
const ref = () => [{ type: ObjectId, ref: 'User' }];
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  adult:    { type: Boolean, default: false },
  bio:      { type: String, default: '' },
  rate:     { type: Number, default: 0 },   // monedas que cobra por 24 h de conversación (0 = gratis)
  coins:    { type: Number, default: 0 },
  friends: ref(), requests: ref(), sent: ref(), blocked: ref()
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  from: { type: ObjectId, ref: 'User', index: true },
  to:   { type: ObjectId, ref: 'User', index: true },
  text: { type: String, default: '' },
  image: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
}));

const Tx = mongoose.model('Tx', new mongoose.Schema({
  user: { type: ObjectId, ref: 'User', index: true },
  type: String, amount: Number, note: String,
  createdAt: { type: Date, default: Date.now }
}));

const Offer = mongoose.model('Offer', new mongoose.Schema({
  payer: { type: ObjectId, ref: 'User', index: true },  // quien paga por hablar
  payee: { type: ObjectId, ref: 'User', index: true },  // quien cobra
  amount: Number,
  turn: { type: String, enum: ['payer', 'payee'], default: 'payee' }, // a quién le toca responder
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  expiresAt: Date,
  createdAt: { type: Date, default: Date.now }
}));

// ---------- Utilidades ----------
const sign = (u) => jwt.sign({ id: u._id }, SECRET, { expiresIn: '30d' });
const pub = (u) => ({ id: String(u._id), username: u.username });
const pubF = (u) => ({ ...pub(u), rate: u.rate || 0, bio: u.bio || '' });
const amt = (x) => { const n = Math.floor(Number(x)); return n >= 1 && n <= 100000 ? n : 0; };
const notify = (ev, ...ids) => ids.forEach((i) => io.to(String(i)).emit(ev));
const fail = (res, code, error) => res.status(code).json({ error });

function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    req.uid = jwt.verify(t, SECRET).id;
    next();
  } catch { fail(res, 401, 'Sesión no válida'); }
}

async function stateOf(uid) {
  const u = await User.findById(uid)
    .populate('friends', 'username rate bio').populate('requests', 'username').populate('sent', 'username');
  if (!u) return null;
  return {
    me: { ...pub(u), coins: u.coins, rate: u.rate, bio: u.bio },
    friends: u.friends.map(pubF), requests: u.requests.map(pub), sent: u.sent.map(pub), fee: FEE
  };
}

const areFriends = async (a, b) => !!(await User.exists({ _id: a, friends: b }));

// Paga `amount` de payer a payee, descontando la comisión. Devuelve false si no hay saldo.
async function pay(payerId, payeeId, amount, note) {
  const p = await User.findOneAndUpdate({ _id: payerId, coins: { $gte: amount } }, { $inc: { coins: -amount } });
  if (!p) return false;
  const net = Math.floor(amount * (1 - FEE));
  await User.updateOne({ _id: payeeId }, { $inc: { coins: net } });
  await Tx.create([
    { user: payerId, type: 'pago', amount: -amount, note },
    { user: payeeId, type: 'cobro', amount: net, note: `${note} (comisión ${amount - net})` }
  ]);
  return true;
}

// null = puede escribir; texto = motivo del bloqueo
async function blockReason(from, to) {
  if (!(await areFriends(from, to))) return 'No son amigos';
  const target = await User.findById(to).select('rate');
  if (!target) return 'Usuario no encontrado';
  if (!target.rate) return null;
  const ok = await Offer.exists({
    status: 'accepted', expiresAt: { $gt: new Date() },
    $or: [{ payer: from, payee: to }, { payer: to, payee: from }]
  });
  return ok ? null : 'Esta persona cobra por conversar. Propón un acuerdo primero.';
}

// ---------- Cuenta ----------
app.post('/api/register', async (req, res) => {
  const { username = '', password = '', adult } = req.body;
  if (adult !== true) return fail(res, 400, 'Debes confirmar que tienes 18 años o más');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return fail(res, 400, 'Usuario: 3-20 letras, números o _');
  if (password.length < 4) return fail(res, 400, 'La contraseña debe tener al menos 4 caracteres');
  try {
    const u = await User.create({ username, adult: true, password: await bcrypt.hash(password, 10) });
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
  const rate = Math.floor(Number(req.body.rate) || 0);
  if (rate < 0 || rate > 100000) return fail(res, 400, 'Tarifa no válida');
  await User.updateOne({ _id: req.uid }, { rate, bio: String(req.body.bio || '').slice(0, 140) });
  notify('friends:update', req.uid, ...(await User.findById(req.uid).select('friends')).friends);
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
  await Offer.updateMany({ status: 'pending', $or: [{ payer: req.uid, payee: id }, { payer: id, payee: req.uid }] }, { status: 'rejected' });
  notify('friends:update', req.uid, id); notify('offers:update', req.uid, id);
  res.json({ ok: true });
});

// ---------- Monedero ----------
app.get('/api/wallet', auth, async (req, res) => {
  const txs = await Tx.find({ user: req.uid }).sort({ createdAt: -1 }).limit(30);
  res.json({ txs, demo: DEMO, minWithdraw: MIN_WITHDRAW });
});

app.post('/api/wallet/topup', auth, async (req, res) => {
  if (!DEMO) return fail(res, 501, 'Las recargas con dinero real aún no están conectadas a una pasarela de pago.');
  const n = amt(req.body.amount);
  if (!n) return fail(res, 400, 'Cantidad no válida');
  await User.updateOne({ _id: req.uid }, { $inc: { coins: n } });
  await Tx.create({ user: req.uid, type: 'recarga', amount: n, note: 'Recarga de prueba' });
  notify('wallet:update', req.uid);
  res.json({ ok: true });
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  const n = amt(req.body.amount);
  if (!n || n < MIN_WITHDRAW) return fail(res, 400, `El retiro mínimo es de ${MIN_WITHDRAW} monedas`);
  const u = await User.findOneAndUpdate({ _id: req.uid, coins: { $gte: n } }, { $inc: { coins: -n } });
  if (!u) return fail(res, 400, 'Saldo insuficiente');
  await Tx.create({ user: req.uid, type: 'retiro', amount: -n, note: 'Retiro solicitado (pendiente de pago)' });
  notify('wallet:update', req.uid);
  res.json({ ok: true });
});

app.post('/api/gift', auth, async (req, res) => {
  const n = amt(req.body.amount), to = req.body.to;
  if (!n || !mongoose.isValidObjectId(to) || !(await areFriends(req.uid, to))) return fail(res, 400, 'Datos no válidos');
  if (!(await pay(req.uid, to, n, 'Propina'))) return fail(res, 400, 'Saldo insuficiente');
  const m = await Message.create({ from: req.uid, to, text: `🎁 ${n} monedas` });
  io.to(String(req.uid)).to(String(to)).emit('message', m);
  notify('wallet:update', req.uid, to);
  res.json({ ok: true });
});

// ---------- Acuerdos (ofertas) ----------
app.post('/api/offers', auth, async (req, res) => {
  const n = amt(req.body.amount), to = req.body.to;
  if (!n || !mongoose.isValidObjectId(to) || !(await areFriends(req.uid, to))) return fail(res, 400, 'Datos no válidos');
  const open = await Offer.exists({
    status: 'pending', $or: [{ payer: req.uid, payee: to }, { payer: to, payee: req.uid }]
  });
  if (open) return fail(res, 400, 'Ya hay una propuesta abierta con esta persona');
  await Offer.create({ payer: req.uid, payee: to, amount: n, turn: 'payee' });
  notify('offers:update', req.uid, to);
  res.json({ ok: true });
});

app.get('/api/offers', auth, async (req, res) => {
  const list = await Offer.find({
    $and: [
      { $or: [{ payer: req.uid }, { payee: req.uid }] },
      { $or: [{ status: 'pending' }, { status: 'accepted', expiresAt: { $gt: new Date() } }] }
    ]
  }).sort({ createdAt: -1 }).limit(50).populate('payer payee', 'username');
  res.json(list.map((o) => ({
    id: String(o._id), payer: pub(o.payer), payee: pub(o.payee),
    amount: o.amount, turn: o.turn, status: o.status, expiresAt: o.expiresAt
  })));
});

app.post('/api/offers/:id/respond', auth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Datos no válidos');
  const o = await Offer.findById(req.params.id);
  if (!o || o.status !== 'pending') return fail(res, 400, 'La propuesta ya no está abierta');
  const responder = String(o.turn === 'payee' ? o.payee : o.payer);
  if (responder !== req.uid) return fail(res, 403, 'No es tu turno de responder');
  const { action } = req.body;

  if (action === 'reject') {
    await Offer.updateOne({ _id: o._id, status: 'pending' }, { status: 'rejected' });
  } else if (action === 'counter') {
    const n = amt(req.body.amount);
    if (!n) return fail(res, 400, 'Cantidad no válida');
    await Offer.updateOne({ _id: o._id, status: 'pending' }, { amount: n, turn: o.turn === 'payee' ? 'payer' : 'payee' });
  } else if (action === 'accept') {
    const claimed = await Offer.findOneAndUpdate(
      { _id: o._id, status: 'pending', turn: o.turn },
      { status: 'accepted', expiresAt: new Date(Date.now() + PASS_HOURS * 3600e3) });
    if (!claimed) return fail(res, 409, 'La propuesta cambió, actualiza la pantalla');
    if (!(await pay(o.payer, o.payee, o.amount, 'Acuerdo de conversación'))) {
      await Offer.updateOne({ _id: o._id }, { status: 'pending', $unset: { expiresAt: 1 } });
      return fail(res, 400, 'Quien paga no tiene saldo suficiente');
    }
  } else return fail(res, 400, 'Acción no válida');

  notify('offers:update', o.payer, o.payee); notify('wallet:update', o.payer, o.payee);
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

// ---------- Tiempo real ----------
io.use((socket, next) => {
  try { socket.uid = jwt.verify(socket.handshake.auth.token, SECRET).id; next(); }
  catch { next(new Error('auth')); }
});

io.on('connection', (socket) => {
  socket.join(String(socket.uid));
  socket.on('message', async ({ to, text = '', image = '' } = {}, cb = () => {}) => {
    try {
      text = String(text).trim().slice(0, 2000);
      if (image && !/^data:image\/(jpeg|png|gif|webp);base64,/.test(image)) return cb({ error: 'Imagen no válida' });
      if (!text && !image) return cb({ error: 'Mensaje vacío' });
      if (!mongoose.isValidObjectId(to)) return cb({ error: 'Destino no válido' });
      const why = await blockReason(socket.uid, to);
      if (why) return cb({ error: why });
      const m = await Message.create({ from: socket.uid, to, text, image });
      io.to(String(socket.uid)).to(String(to)).emit('message', m);
      cb({ ok: true });
    } catch { cb({ error: 'No se pudo enviar' }); }
  });
});

// ---------- Arranque ----------
// Render asigna el puerto en process.env.PORT y exige escuchar en 0.0.0.0
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

if (!process.env.MONGO_URI) { console.error('Falta la variable MONGO_URI'); process.exit(1); }

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB conectado');
    server.listen(PORT, HOST, () => console.log(`App escuchando en ${HOST}:${PORT}`));
  })
  .catch((e) => { console.error('Error MongoDB:', e.message); process.exit(1); });
