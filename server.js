/* The Vintage Loft — booking server (Phase 1)
   Node 22 built-in SQLite (no native deps). Run: npm start  (node --experimental-sqlite server.js) */
const express = require('express');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const VL = require('./pricing');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    date TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    hours REAL NOT NULL,
    addons_json TEXT NOT NULL DEFAULT '{}',
    pre REAL NOT NULL,
    hst REAL NOT NULL,
    total REAL NOT NULL,
    paid REAL NOT NULL DEFAULT 0,
    payment_ref TEXT,
    payment_mode TEXT,
    customer_name TEXT,
    customer_email TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    date TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  );
`);

/* ---------- payments: Square-ready stand-in ----------
   Real Square (sandbox then live) drops in here: use the `square` SDK's
   PaymentsApi.createPayment({ sourceId, amountMoney, idempotencyKey }) with
   process.env.SQUARE_ACCESS_TOKEN. Until keys are provided we run in stand-in
   mode, which accepts the Square test nonce and always succeeds. */
const payments = {
  mode: process.env.SQUARE_ACCESS_TOKEN ? 'square-sandbox' : 'standin',
  charge({ amountCents, sourceId }) {
    if (this.mode === 'standin') {
      return { ok: true, ref: 'TEST-' + Date.now().toString(36).toUpperCase(), mode: 'standin' };
    }
    // TODO: real Square sandbox call here once SQUARE_ACCESS_TOKEN is set.
    throw new Error('Square sandbox not wired yet');
  }
};

/* ---------- helpers ---------- */
const nowISO = () => new Date().toISOString();
function isoOffset(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function validTimes(start, end) {
  if (!(start >= 8 && end <= 20 && end > start)) return 'Outside studio hours (8:00–20:00)';
  if ((end - start) < VL.CONFIG.minHours) return VL.CONFIG.minHours + '-hour minimum';
  if (Math.round(start * 2) !== start * 2 || Math.round(end * 2) !== end * 2) return 'Times must be on the half hour';
  return null;
}
function busyIntervals(roomId, date) {
  const b = db.prepare(`SELECT start,end FROM bookings WHERE room_id=? AND date=? AND status!='cancelled'`).all(roomId, date);
  const k = db.prepare(`SELECT start,end FROM blocks WHERE room_id=? AND date=?`).all(roomId, date);
  return [...b, ...k];
}
function isFree(roomId, date, start, end) {
  return !busyIntervals(roomId, date).some(iv => VL.overlaps(start, end, iv.start, iv.end));
}

/* ---------- seed a little demo data (only if empty) ---------- */
if (db.prepare('SELECT COUNT(*) c FROM bookings').get().c === 0 &&
    db.prepare('SELECT COUNT(*) c FROM blocks').get().c === 0) {
  const insB = db.prepare(`INSERT INTO bookings (room_id,date,start,end,hours,addons_json,pre,hst,total,paid,payment_ref,payment_mode,customer_name,customer_email,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?)`);
  const seed = [
    ['grand', 3, 10, 14], ['grand', 4, 8, 10], ['gatsby', 3, 14, 17],
    ['carnegie', 3, 9, 11], ['dream', 4, 10, 12]
  ];
  for (const [room, off, s, e] of seed) {
    const q = VL.priceQuote(room, isoOffset(off), e - s, {});
    insB.run(room, isoOffset(off), s, e, e - s, '{}', q.pre, q.hst, q.total, q.total, 'SEED', 'seed', 'Seed Client', 'seed@example.com', nowISO());
  }
  db.prepare(`INSERT INTO blocks (room_id,date,start,end,reason,created_at) VALUES (?,?,?,?,?,?)`)
    .run('grand', isoOffset(5), 12, 13.5, 'Maintenance', nowISO());
}

/* ---------- app ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/pricing.js', (_req, res) => res.sendFile(path.join(__dirname, 'pricing.js')));

app.get('/api/rooms', (_req, res) => res.json({ rooms: VL.ROOMS, addons: VL.ADDONS, config: {
  minHours: VL.CONFIG.minHours, incrementMin: VL.CONFIG.incrementMin, hstRate: VL.CONFIG.hstRate } }));

// Which rooms are open for a date + time window
app.get('/api/search', (req, res) => {
  const { date } = req.query; const start = +req.query.start, end = +req.query.end;
  if (!date) return res.status(400).json({ error: 'date required' });
  const err = validTimes(start, end); if (err) return res.status(400).json({ error: err });
  const rooms = VL.ROOMS.map(r => {
    const free = isFree(r.id, date, start, end) && VL.validDuration(r.id, end - start);
    const q = VL.priceQuote(r.id, date, end - start, {});
    return { id: r.id, name: r.name, cap: r.cap, tags: r.tags, color: r.color,
      rate: q.rate, xmas: q.xmas, total: q.roomTotal, available: free };
  });
  res.json({ date, start, end, rooms });
});

// Busy intervals for a room across a date range (for the week calendar)
app.get('/api/busy', (req, res) => {
  const { room, from, to } = req.query;
  if (!VL.roomById(room)) return res.status(400).json({ error: 'unknown room' });
  const b = db.prepare(`SELECT date,start,end FROM bookings WHERE room_id=? AND date BETWEEN ? AND ? AND status!='cancelled'`).all(room, from, to);
  const k = db.prepare(`SELECT date,start,end FROM blocks WHERE room_id=? AND date BETWEEN ? AND ?`).all(room, from, to);
  res.json({ room, busy: [...b, ...k] });
});

// Live price quote
app.post('/api/quote', (req, res) => {
  try {
    const { room, start, end, addons } = req.body;
    res.json(VL.priceQuote(room, req.body.date, end - start, addons || {}, req.body.addonOptions || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Create a booking — server is authoritative: re-checks availability + price, then charges + saves
app.post('/api/bookings', (req, res) => {
  const { room, date, addons, customerName, customerEmail, paymentToken } = req.body;
  const start = +req.body.start, end = +req.body.end;
  if (!VL.roomById(room)) return res.status(400).json({ error: 'unknown room' });
  if (!date) return res.status(400).json({ error: 'date required' });
  const terr = validTimes(start, end); if (terr) return res.status(400).json({ error: terr });
  if (!VL.validDuration(room, end - start)) return res.status(400).json({ error: 'That duration is not available for this studio.' });
  if (!customerName || !customerEmail) return res.status(400).json({ error: 'name and email required' });

  try {
    db.exec('BEGIN IMMEDIATE');
    if (!isFree(room, date, start, end)) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'That time was just taken. Please pick another.' }); }
    const q = VL.priceQuote(room, date, end - start, addons || {}, req.body.addonOptions || {});
    const pay = payments.charge({ amountCents: Math.round(q.total * 100), sourceId: paymentToken || 'cnon:card-nonce-ok' });
    if (!pay.ok) { db.exec('ROLLBACK'); return res.status(402).json({ error: 'Payment declined' }); }
    const info = db.prepare(`INSERT INTO bookings (room_id,date,start,end,hours,addons_json,pre,hst,total,paid,payment_ref,payment_mode,customer_name,customer_email,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?)`)
      .run(room, date, start, end, end - start, JSON.stringify({ items: addons || {}, options: req.body.addonOptions || {} }), q.pre, q.hst, q.total, q.total, pay.ref, pay.mode, customerName, customerEmail, nowISO());
    db.exec('COMMIT');
    res.json({ ok: true, id: info.lastInsertRowid, confirmation: 'VL' + info.lastInsertRowid, quote: q, paymentMode: pay.mode, paymentRef: pay.ref });
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} res.status(500).json({ error: e.message }); }
});

// Customer's own bookings (simple email lookup; real accounts in Phase 2)
app.get('/api/my-bookings', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const rows = db.prepare(`SELECT id,room_id,date,start,end,total,paid,status,created_at FROM bookings WHERE lower(customer_email)=? ORDER BY date DESC, start DESC`).all(email);
  res.json({ bookings: rows.map(r => ({ ...r, roomName: (VL.roomById(r.room_id) || {}).name || r.room_id })) });
});

/* ---------- admin (manual blocking + view). Simple shared key for Phase 1. ---------- */
const ADMIN_KEY = process.env.ADMIN_KEY || 'loft-admin';
function admin(req, res, next) { if ((req.query.key || req.body.key) === ADMIN_KEY) return next(); res.status(401).json({ error: 'unauthorized' }); }

app.get('/api/admin/bookings', admin, (_req, res) => {
  const rows = db.prepare(`SELECT * FROM bookings ORDER BY date DESC, start DESC`).all();
  res.json({ bookings: rows.map(r => ({ ...r, roomName: (VL.roomById(r.room_id) || {}).name || r.room_id })) });
});
app.get('/api/admin/blocks', admin, (_req, res) => res.json({ blocks: db.prepare(`SELECT * FROM blocks ORDER BY date DESC`).all() }));
app.post('/api/admin/blocks', admin, (req, res) => {
  const { room, date, reason } = req.body; const start = +req.body.start, end = +req.body.end;
  if (!VL.roomById(room)) return res.status(400).json({ error: 'unknown room' });
  const terr = validTimes(start, end); if (terr) return res.status(400).json({ error: terr });
  const info = db.prepare(`INSERT INTO blocks (room_id,date,start,end,reason,created_at) VALUES (?,?,?,?,?,?)`).run(room, date, start, end, reason || 'Blocked', nowISO());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.post('/api/admin/cancel', admin, (req, res) => {
  const info = db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(+req.body.id);
  res.json({ ok: info.changes > 0 });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(`Vintage Loft booking server on :${PORT} (payments: ${payments.mode})`));
module.exports = { app, db };
