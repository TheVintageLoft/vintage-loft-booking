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
    confirmation TEXT,
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
  CREATE TABLE IF NOT EXISTS code_redemptions (
    code TEXT PRIMARY KEY,
    confirmation TEXT,
    used_at TEXT
  );
`);

// Migration: add columns to databases created before they existed.
try { db.exec("ALTER TABLE bookings ADD COLUMN confirmation TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN code TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN discount REAL NOT NULL DEFAULT 0"); } catch (_) {}

/* ---------- payments: Square Web Payments (test mode) with a stand-in fallback ----------
   Set these environment variables on the host to switch from stand-in to real Square:
     SQUARE_ACCESS_TOKEN  (sandbox access token; keep secret — host env only)
     SQUARE_APP_ID        (sandbox application id — safe, used in the browser)
     SQUARE_LOCATION_ID   (sandbox location id)
     SQUARE_ENV           ("sandbox" (default) or "production")
   The front-end reads app id + location id from /api/square-config (never the token).
   When keys are absent we run in stand-in mode so the flow still works. */
const SQ = {
  token: process.env.SQUARE_ACCESS_TOKEN || '',
  appId: process.env.SQUARE_APP_ID || '',
  locationId: process.env.SQUARE_LOCATION_ID || '',
  env: (process.env.SQUARE_ENV || 'sandbox').toLowerCase(),
  version: process.env.SQUARE_VERSION || ''    // optional; blank = app default version
};
SQ.apiBase = SQ.env === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
SQ.enabled = !!(SQ.token && SQ.appId && SQ.locationId);

const payments = {
  get mode() { return SQ.enabled ? 'square-' + SQ.env : 'standin'; },
  async charge({ amountCents, sourceId }) {
    if (!SQ.enabled) return { ok: true, ref: 'TEST-' + Date.now().toString(36).toUpperCase(), mode: 'standin' };
    if (!sourceId) return { ok: false, mode: this.mode, error: 'Missing card token' };
    const headers = { 'Authorization': 'Bearer ' + SQ.token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (SQ.version) headers['Square-Version'] = SQ.version;
    const body = { source_id: sourceId, idempotency_key: 'vl-' + Date.now() + '-' + Math.round(Math.random() * 1e9),
      amount_money: { amount: amountCents, currency: 'CAD' }, location_id: SQ.locationId };
    try {
      const r = await fetch(SQ.apiBase + '/v2/payments', { method: 'POST', headers, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      const st = d.payment && d.payment.status;
      if (r.ok && (st === 'COMPLETED' || st === 'APPROVED')) return { ok: true, ref: d.payment.id, mode: this.mode };
      return { ok: false, mode: this.mode, error: (d.errors && d.errors[0] && d.errors[0].detail) || 'Payment failed' };
    } catch (e) { return { ok: false, mode: this.mode, error: e.message }; }
  }
};

/* ---------- helpers ---------- */
const nowISO = () => new Date().toISOString();
// Confirmation date code in the studio's local time zone (Eastern), as YYMMDD.
// The host runs in UTC, so we format explicitly for America/Toronto or a late-evening
// booking could roll onto the next day's number.
function torontoDateCode(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  return g('year') + g('month') + g('day');
}
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

// clear any reservations left "pending" by an interrupted checkout on a prior run
db.exec(`DELETE FROM bookings WHERE status='pending'`);

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

/* ---------- discount / gift / reschedule codes ----------
   Codes live here on the server only (the browser never receives the full list).
   A client submits a code, the server validates it and returns just that one code's
   effect. On booking the server re-validates and recomputes the price authoritatively.
   Types:
     percent  -> % off, scope 'room' (studio rental only) or 'all' (room + add-ons)
     fixed    -> a flat dollar credit off the order's grand total (tax-inclusive)
   reusable:false codes can only ever be redeemed once (reschedule credits, gift cards). */
const CODES = (() => {
  const vip = { type: 'percent', off: 0.20, scope: 'room', reusable: true, kind: 'VIP' };
  const emp = { type: 'percent', off: 0.50, scope: 'room', reusable: true, kind: 'Employee' };
  const owner = { type: 'percent', off: 1.00, scope: 'all', reusable: true, kind: 'Owner' };
  const friend = { type: 'percent', off: 0.15, scope: 'room', reusable: true, kind: 'Friends' };
  const map = {
    STEVEVIP: vip, KBKVIP: vip, JOSIEVIP: vip,
    ALANNAH50: emp, BRIA50: emp, SHAY50: emp, MACKENZIE50: emp, MIKHELA50: emp, JOELLE50: emp, ROSALIND50: emp,
    KELLY: owner, KAYA: owner,
    FRIENDSWITHBENEFITS: friend, ONELOVE15: friend,
    VALERIEVON339: { type: 'fixed', amount: 339, scope: 'total', reusable: false, kind: 'Reschedule credit' }
  };
  return map;
})();
const normCode = s => (s || '').toString().toUpperCase().replace(/\s+/g, '');
// A short, customer-safe label describing what a code does (no other codes revealed).
function codeLabel(c) {
  if (c.type === 'fixed') return '$' + c.amount.toFixed(2) + ' credit';
  if (c.off >= 1) return 'Free (owner)';
  return Math.round(c.off * 100) + '% off the studio';
}
// Look up a code; returns null if unknown. Does NOT check single-use here.
function lookupCode(input) {
  const k = normCode(input);
  return CODES[k] ? Object.assign({ code: k }, CODES[k]) : null;
}
// Has a non-reusable code already been redeemed?
function codeUsed(code) {
  return !!db.prepare('SELECT 1 FROM code_redemptions WHERE code=?').get(code);
}
// A safe, browser-facing descriptor (never includes the raw catalog).
function publicCode(c) {
  return { code: c.code, type: c.type, off: c.off || 0, amount: c.amount || 0, scope: c.scope, kind: c.kind, label: codeLabel(c) };
}

// Validate a code (and, if provided, the order items) and return its effect + the new total.
app.post('/api/apply-code', (req, res) => {
  const c = lookupCode(req.body && req.body.code);
  if (!c) return res.status(404).json({ ok: false, error: 'That code is not valid. Please check the spelling.' });
  if (!c.reusable && codeUsed(c.code)) return res.status(409).json({ ok: false, error: 'That code has already been used.' });
  let breakdown = null;
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length) breakdown = quoteOrderWithCode(items, c);
  } catch (e) { /* items optional; ignore quoting errors here, booking re-validates */ }
  res.json(Object.assign({ ok: true }, { discount: publicCode(c) }, breakdown ? { breakdown } : {}));
});

// Compute an order's quotes with a code applied. Percent -> per room; fixed -> order-level credit.
function quoteOrderWithCode(items, c) {
  const quotes = items.map(it => VL.priceQuote(it.room, it.date, (+it.end) - (+it.start), it.addons || {}, it.addonOptions || {}));
  let discounted = quotes, fixedCredit = 0;
  if (c && c.type === 'percent') {
    discounted = quotes.map(q => VL.applyDiscountToQuote(q, c));
  }
  let grandTotal = VL.round2(discounted.reduce((s, q) => s + q.total, 0));
  if (c && c.type === 'fixed') {
    fixedCredit = Math.min(c.amount, grandTotal);
    grandTotal = VL.round2(grandTotal - fixedCredit);
  }
  const discountTotal = c && c.type === 'fixed'
    ? fixedCredit
    : VL.round2(discounted.reduce((s, q) => s + (q.discount || 0), 0));
  return { quotes: discounted, grandTotal, discountTotal, fixedCredit };
}

app.get('/api/rooms', (_req, res) => res.json({ rooms: VL.ROOMS, addons: VL.ADDONS, config: {
  minHours: VL.CONFIG.minHours, incrementMin: VL.CONFIG.incrementMin, hstRate: VL.CONFIG.hstRate } }));

// Non-secret Square settings for the browser card form (token is NEVER sent here)
app.get('/api/square-config', (_req, res) => res.json({ enabled: SQ.enabled, appId: SQ.appId || null, locationId: SQ.locationId || null, env: SQ.env }));

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

// Create a reservation of ONE OR MORE studios/rooms. Reserve the slots atomically,
// charge once (real Square or stand-in), then confirm — or release the slots if the charge fails.
app.post('/api/bookings', async (req, res) => {
  let { items, customerName, customerEmail, paymentToken } = req.body;
  if (!Array.isArray(items)) {   // backward-compatible with a single-room body
    items = req.body.room ? [{ room: req.body.room, date: req.body.date, start: req.body.start, end: req.body.end, addons: req.body.addons, addonOptions: req.body.addonOptions }] : [];
  }
  if (!items.length) return res.status(400).json({ error: 'No studios in the booking.' });
  if (!customerName || !customerEmail) return res.status(400).json({ error: 'name and email required' });
  for (const it of items) {
    const s = +it.start, e = +it.end, room = VL.roomById(it.room);
    if (!room) return res.status(400).json({ error: 'unknown room' });
    if (!it.date) return res.status(400).json({ error: 'date required' });
    const terr = validTimes(s, e); if (terr) return res.status(400).json({ error: terr });
    if (!VL.validDuration(it.room, e - s)) return res.status(400).json({ error: 'That duration is not available for ' + room.name + '.' });
  }

  // Validate the discount/gift code (if one was entered) before we reserve or charge.
  let codeInfo = null;
  if (req.body.code && normCode(req.body.code)) {
    codeInfo = lookupCode(req.body.code);
    if (!codeInfo) return res.status(400).json({ error: 'That discount code is not valid.' });
    if (!codeInfo.reusable && codeUsed(codeInfo.code)) return res.status(409).json({ error: 'That code has already been used.' });
  }

  // 1) Reserve the slots atomically (no await inside the transaction)
  let reservedIds = [], quotes = [], grandTotal, finals;
  try {
    db.exec('BEGIN IMMEDIATE');
    const claimed = {};
    for (const it of items) {
      const s = +it.start, e = +it.end, room = VL.roomById(it.room);
      if (!isFree(it.room, it.date, s, e)) { db.exec('ROLLBACK'); return res.status(409).json({ error: room.name + ' was just taken for that time. Please adjust.' }); }
      const key = it.room + '|' + it.date; claimed[key] = claimed[key] || [];
      if (claimed[key].some(([cs, ce]) => VL.overlaps(s, e, cs, ce))) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'You added ' + room.name + ' twice at overlapping times.' }); }
      claimed[key].push([s, e]);
      quotes.push(VL.priceQuote(it.room, it.date, e - s, it.addons || {}, it.addonOptions || {}));
    }
    // Apply the discount code to the fresh quotes (the server is authoritative on price).
    if (codeInfo && codeInfo.type === 'percent') {
      finals = quotes.map(q => { const d = VL.applyDiscountToQuote(q, codeInfo); return { pre: d.pre, hst: d.hst, total: d.total, discount: d.discount, paid: d.total }; });
    } else if (codeInfo && codeInfo.type === 'fixed') {
      const baseGrand = VL.round2(quotes.reduce((s, q) => s + q.total, 0));
      let remaining = Math.min(codeInfo.amount, baseGrand);
      finals = quotes.map(q => { const rowCredit = VL.round2(Math.min(remaining, q.total)); remaining = VL.round2(remaining - rowCredit); return { pre: q.pre, hst: q.hst, total: q.total, discount: rowCredit, paid: VL.round2(q.total - rowCredit) }; });
    } else {
      finals = quotes.map(q => ({ pre: q.pre, hst: q.hst, total: q.total, discount: 0, paid: q.total }));
    }
    grandTotal = VL.round2(finals.reduce((sum, f) => sum + f.paid, 0));
    const ins = db.prepare(`INSERT INTO bookings (room_id,date,start,end,hours,addons_json,pre,hst,total,paid,payment_ref,payment_mode,customer_name,customer_email,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,'PENDING','pending',?,?, 'pending', ?)`);
    items.forEach((it, i) => {
      const s = +it.start, e = +it.end, q = quotes[i];
      const info = ins.run(it.room, it.date, s, e, e - s, JSON.stringify({ items: it.addons || {}, options: it.addonOptions || {} }), q.pre, q.hst, q.total, customerName, customerEmail, nowISO());
      reservedIds.push(info.lastInsertRowid);
    });
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} return res.status(500).json({ error: e.message }); }

  // 2) Charge once for the whole order (awaits Square in real mode)
  const pay = await payments.charge({ amountCents: Math.round(grandTotal * 100), sourceId: paymentToken });

  // 3) Confirm the reservations, or release them if the charge failed
  if (!pay.ok) {
    const del = db.prepare(`DELETE FROM bookings WHERE id=? AND status='pending'`);
    reservedIds.forEach(id => del.run(id));
    return res.status(402).json({ error: pay.error || 'Payment failed' });
  }
  // One confirmation number for the whole order: VL_YYMMDD-N, N = the Nth booking made that day.
  const prefix = 'VL_' + torontoDateCode() + '-';
  const usedToday = db.prepare(`SELECT COUNT(DISTINCT confirmation) AS n FROM bookings WHERE confirmation LIKE ?`).get(prefix + '%');
  const confirmation = prefix + ((usedToday.n || 0) + 1);
  const upd = db.prepare(`UPDATE bookings SET status='confirmed', pre=?, hst=?, total=?, paid=?, discount=?, code=?, payment_ref=?, payment_mode=?, confirmation=? WHERE id=?`);
  reservedIds.forEach((id, i) => upd.run(finals[i].pre, finals[i].hst, finals[i].total, finals[i].paid, finals[i].discount, codeInfo ? codeInfo.code : null, pay.ref, pay.mode, confirmation, id));
  // Retire a single-use code (reschedule credits, gift cards) so it can't be used again.
  if (codeInfo && !codeInfo.reusable) {
    try { db.prepare('INSERT OR IGNORE INTO code_redemptions (code, confirmation, used_at) VALUES (?,?,?)').run(codeInfo.code, confirmation, nowISO()); } catch (_) {}
  }
  const discountTotal = VL.round2(finals.reduce((s, f) => s + f.discount, 0));
  const created = reservedIds.map((id, i) => ({ id, room: items[i].room, roomName: quotes[i].roomName, date: items[i].date, start: +items[i].start, end: +items[i].end, total: finals[i].total, paid: finals[i].paid }));
  res.json({ ok: true, confirmation, bookings: created, grandTotal, discountTotal, code: codeInfo ? codeInfo.code : null, paymentMode: pay.mode, paymentRef: pay.ref });
});

// Customer's own bookings (simple email lookup; real accounts in Phase 2)
app.get('/api/my-bookings', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const rows = db.prepare(`SELECT id,room_id,date,start,end,total,paid,status,confirmation,created_at FROM bookings WHERE lower(customer_email)=? ORDER BY date DESC, start DESC`).all(email);
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
