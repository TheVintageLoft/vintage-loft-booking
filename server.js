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
try { db.exec("ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
// 'kind' tells an imported real booking ('booking') apart from a room blockout ('hold').
try { db.exec("ALTER TABLE blocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'hold'"); } catch (_) {}
// staff notes on any calendar entry, plus the client intake form answers on real bookings
try { db.exec("ALTER TABLE blocks ADD COLUMN notes TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN notes TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN intake TEXT"); } catch (_) {}
// a Square payment link Kelly can send for a manual booking
try { db.exec("ALTER TABLE blocks ADD COLUMN pay_link TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN pay_link TEXT"); } catch (_) {}

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
  },
  // Create a Square-hosted payment link (Quick Pay) for a fixed amount — for manual bookings.
  async createLink({ amountCents, name }) {
    if (!SQ.enabled) return { ok: false, error: 'Square is not connected yet, so payment links can’t be created. Add your Square keys in Render to turn this on.' };
    const headers = { 'Authorization': 'Bearer ' + SQ.token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (SQ.version) headers['Square-Version'] = SQ.version;
    const body = { idempotency_key: 'vllink-' + Date.now() + '-' + Math.round(Math.random() * 1e9),
      quick_pay: { name: (name || 'The Vintage Loft studio booking').slice(0, 255), price_money: { amount: amountCents, currency: 'CAD' }, location_id: SQ.locationId } };
    try {
      const r = await fetch(SQ.apiBase + '/v2/online-checkout/payment-links', { method: 'POST', headers, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.payment_link && d.payment_link.url) return { ok: true, url: d.payment_link.url, test: SQ.env !== 'production' };
      return { ok: false, error: (d.errors && d.errors[0] && (d.errors[0].detail || d.errors[0].code)) || 'Could not create the payment link.' };
    } catch (e) { return { ok: false, error: e.message }; }
  }
};

/* ---------- email (Resend HTTP API — no npm dependency) ----------
   Set RESEND_API_KEY on the host to turn real sending on. Without it, we log and skip,
   so a booking never fails because of an email problem. From/reply default to info@thevintageloft.ca. */
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'The Vintage Loft <info@thevintageloft.ca>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'info@thevintageloft.ca';
const emailEnabled = !!RESEND_API_KEY;
// Images are served from the app's own /public folder so they load reliably in email clients.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://vintage-loft-booking.onrender.com').replace(/\/$/, '');
const LOGO_URL = PUBLIC_URL + '/email-logo.png';
const ARRIVAL_URL = PUBLIC_URL + '/email-arrival.jpg';

async function sendEmail({ to, subject, html }) {
  if (!emailEnabled) { console.log('[email] skipped (no RESEND_API_KEY):', subject, '->', to); return { ok: false, skipped: true }; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY_TO, subject, html })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, id: d.id };
    console.error('[email] send failed:', d && (d.message || JSON.stringify(d)));
    return { ok: false, error: (d && d.message) || 'send failed' };
  } catch (e) { console.error('[email] error:', e.message); return { ok: false, error: e.message }; }
}

const _months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const _weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function emFirst(name) { return ((name || '').trim().split(/\s+/)[0]) || 'there'; }
function emTime(t) { const h = Math.floor(t); const m = Math.round((t - h) * 60); const ap = h < 12 ? 'AM' : 'PM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + String(m).padStart(2, '0') + ' ' + ap; }
function emDate(iso) { const p = (iso || '').split('-').map(Number); if (!p[0]) return iso || ''; const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2])); return _weekdays[dt.getUTCDay()] + ', ' + _months[p[1] - 1] + ' ' + p[2] + ', ' + p[0]; }
function emMoney(n) { return '$' + Number(n || 0).toFixed(2); }

function emailShell(inner) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eeedec">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eeedec"><tr><td align="center" style="padding:24px 12px">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e7e5e2;border-radius:14px;overflow:hidden;font-family:Georgia,'Times New Roman',serif;color:#3a352f">
      <tr><td style="background:#f6f5f3;padding:30px 30px 24px;text-align:center;border-bottom:2px solid #7c7268">
        <img src="${LOGO_URL}" alt="The Vintage Loft" width="230" style="width:230px;max-width:72%;height:auto;display:inline-block">
      </td></tr>
      <tr><td style="padding:30px">${inner}</td></tr>
      <tr><td style="background:#f6f5f3;padding:18px 30px;text-align:center;color:#9a938a;font-size:12px;font-family:Arial,sans-serif">
        The Vintage Loft &middot; 207 Dundas St West, Whitby &middot; 905-767-2099
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function bookingRowsHtml(bookings) {
  return bookings.map(b => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee">
        <b>${b.roomName}</b><br>
        <span style="color:#8a8375;font-size:13px;font-family:Arial,sans-serif">${emDate(b.date)} &middot; ${emTime(b.start)}&ndash;${emTime(b.end)}</span>
      </td>
      <td align="right" style="padding:8px 0;border-bottom:1px solid #eee;white-space:nowrap">${emMoney(b.total)}</td>
    </tr>`).join('');
}

function confirmationEmail({ name, confirmation, bookings, grandTotal, discountTotal }) {
  const savings = discountTotal > 0 ? `<tr><td style="padding:6px 0;color:#2e7d32">Savings</td><td align="right" style="padding:6px 0;color:#2e7d32">&minus;${emMoney(discountTotal)}</td></tr>` : '';
  const inner = `
    <p style="font-size:18px;margin:0 0 14px">Hello ${emFirst(name)},</p>
    <p style="margin:0 0 14px;line-height:1.6">Thanks for booking at The Vintage Loft Studios! We look forward to having you come in. You'll receive a reminder email the day before your booking.</p>
    <div style="background:#f6f5f3;border-radius:10px;padding:16px 18px;margin:0 0 18px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9a938a;font-family:Arial,sans-serif;margin-bottom:10px">Your reservation &middot; ${confirmation}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${bookingRowsHtml(bookings)}
        ${savings}
        <tr><td style="padding:10px 0 0"><b>Total</b></td><td align="right" style="padding:10px 0 0"><b>${emMoney(grandTotal)}</b></td></tr>
      </table>
    </div>
    <p style="margin:0 0 10px;font-weight:bold">Arrival information</p>
    <img src="${ARRIVAL_URL}" alt="How to find The Vintage Loft — 207 Dundas St West, Whitby. Enter through the awning-covered door on the ground level." width="540" style="width:100%;max-width:540px;height:auto;border:1px solid #eae8e4;border-radius:10px;display:block;margin:0 0 14px">
    <div style="font-size:14px;line-height:1.6;font-family:Arial,sans-serif;margin:0 0 18px;color:#3a352f">
      <p style="margin:0 0 6px"><b>Address:</b> 207 Dundas St West, Whitby &mdash; 2nd floor of the Pizza Nova Building.</p>
      <p style="margin:0 0 6px"><b>Parking:</b> Free parking anywhere in our lot.</p>
      <p style="margin:0 0 6px"><b>Studio:</b> 905-767-2099<br><b>Kelly's cell:</b> 905-767-8099</p>
    </div>
    <p style="margin:0 0 18px;line-height:1.6">If you have any questions before you arrive, give us a call or text. See you soon!<br>Kelly &amp; The Vintage Loft Team</p>
    <div style="background:#f6f5f3;border:1px solid #eae8e4;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.6;color:#6b6459;font-family:Arial,sans-serif">
      <b>Cancellation policy:</b> We do not give refunds for bookings, however we give full studio credit if cancelled or rescheduled with 48 hours or more notice. (Special holiday sets have a different cancellation policy.)
    </div>`;
  return emailShell(inner);
}

function reminderEmail({ name, confirmation, bookings }) {
  const resBox = (bookings && bookings.length) ? `
    <div style="background:#f6f5f3;border-radius:10px;padding:16px 18px;margin:0 0 18px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9a938a;font-family:Arial,sans-serif;margin-bottom:10px">Your reservation${confirmation ? ' &middot; ' + confirmation : ''}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${bookings.map(b => `<tr><td style="padding:6px 0"><b>${b.roomName}</b><br><span style="color:#8a8375;font-size:13px;font-family:Arial,sans-serif">${emDate(b.date)} &middot; ${emTime(b.start)}&ndash;${emTime(b.end)}</span></td></tr>`).join('')}
      </table>
    </div>` : '';
  const inner = `
    <p style="font-size:18px;margin:0 0 14px">Hello ${emFirst(name)},</p>
    <p style="margin:0 0 16px;line-height:1.6">Just a friendly reminder that you're scheduled here at The Vintage Loft <b>tomorrow</b>.</p>
    ${resBox}
    <p style="margin:0 0 14px;line-height:1.6"><b>Inside shoes:</b> Shoes are welcome in your photos! We simply ask that you bring a clean pair of indoor shoes, or the shoes you plan to wear for your session, rather than wearing outdoor shoes into the studio. Please remind everyone joining you to bring their photo shoes as well. If anyone forgets, we have slides available in the entryway.</p>
    <p style="margin:0 0 14px;line-height:1.6"><b>Arrival info:</b> The door will be unlocked, so please come in and head upstairs. A member of our team will be there to greet you when you arrive. If you or anyone in your group requires assistance with the stairs, please call or text us when you arrive so we can help you use the chair lift.</p>
    <img src="${ARRIVAL_URL}" alt="How to find The Vintage Loft entrance — 207 Dundas St West, Whitby" width="540" style="width:100%;max-width:540px;height:auto;border:1px solid #eae8e4;border-radius:10px;display:block;margin:4px 0 16px">
    <p style="margin:0 0 14px;line-height:1.6">If you have questions prior to your visit, please give us a call or text (our studio line can also accept text messages).<br><b>Studio:</b> 905-767-2099<br><b>Kelly's cell:</b> 905-767-8099</p>
    <p style="margin:0;line-height:1.6">See you soon!<br>:) Kelly + Team</p>`;
  return emailShell(inner);
}

async function sendConfirmationEmail({ email, name, confirmation, bookings, grandTotal, discountTotal }) {
  if (!email) return;
  const r = await sendEmail({ to: email, subject: "You're booked at The Vintage Loft!", html: confirmationEmail({ name, confirmation, bookings, grandTotal, discountTotal }) });
  if (r.ok) console.log('[email] confirmation sent for', confirmation, '->', email);
}

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
// Today's date (or an offset) in Toronto as YYYY-MM-DD. Host runs in UTC, so format explicitly.
function torontoISO(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => +((parts.find(p => p.type === t) || {}).value);
  const base = new Date(Date.UTC(g('year'), g('month') - 1, g('day')));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}
function isoOffset(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function validTimes(start, end) {
  if (!(start >= 8 && end <= 20 && end > start)) return 'Outside studio hours (8:00–20:00)';
  if ((end - start) < VL.CONFIG.minHours) return VL.CONFIG.minHours + '-hour minimum';
  if (Math.round(start * 2) !== start * 2 || Math.round(end * 2) !== end * 2) return 'Times must be on the half hour';
  return null;
}
// Days the studio is closed to public bookings (0=Sun ... 6=Sat). 1 = Monday.
// The admin hold tool bypasses this so Kelly can still slot in her own sessions.
const CLOSED_WEEKDAYS = new Set([1]);
function isClosedDay(date) {
  const p = (date || '').split('-').map(Number);
  if (!p[0]) return false;
  return CLOSED_WEEKDAYS.has(new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay());
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

/* ---------- seed a little demo data (only if empty AND explicitly enabled) ----------
   Production must never invent fake bookings, so this only runs when SEED_DEMO=1.     */
if (process.env.SEED_DEMO === '1' &&
    db.prepare('SELECT COUNT(*) c FROM bookings').get().c === 0 &&
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
  const closed = isClosedDay(date);
  const rooms = VL.ROOMS.map(r => {
    const free = !closed && isFree(r.id, date, start, end) && VL.validDuration(r.id, end - start);
    const q = VL.priceQuote(r.id, date, end - start, {});
    return { id: r.id, name: r.name, cap: r.cap, tags: r.tags, color: r.color,
      rate: q.rate, xmas: q.xmas, total: q.roomTotal, available: free };
  });
  res.json({ date, start, end, closed, closedReason: closed ? 'The studio is closed on Mondays.' : null, rooms });
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
    if (isClosedDay(it.date)) return res.status(400).json({ error: 'The studio is closed on Mondays. Please choose another day.' });
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
    const intakeStr = req.body.intake ? JSON.stringify(req.body.intake).slice(0, 4000) : null;
    const ins = db.prepare(`INSERT INTO bookings (room_id,date,start,end,hours,addons_json,pre,hst,total,paid,payment_ref,payment_mode,customer_name,customer_email,intake,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,'PENDING','pending',?,?,?, 'pending', ?)`);
    items.forEach((it, i) => {
      const s = +it.start, e = +it.end, q = quotes[i];
      const info = ins.run(it.room, it.date, s, e, e - s, JSON.stringify({ items: it.addons || {}, options: it.addonOptions || {} }), q.pre, q.hst, q.total, customerName, customerEmail, intakeStr, nowISO());
      reservedIds.push(info.lastInsertRowid);
    });
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} return res.status(500).json({ error: e.message }); }

  // 2) Charge once for the whole order — unless it's free (owner code / full credit).
  //    Square cannot process a $0.00 amount, so skip the processor entirely when nothing is owed.
  const pay = grandTotal <= 0
    ? { ok: true, ref: 'FREE-' + Date.now().toString(36).toUpperCase(), mode: 'free' }
    : await payments.charge({ amountCents: Math.round(grandTotal * 100), sourceId: paymentToken });

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
  // Send the confirmation email in the background — never block or fail the booking on an email problem.
  sendConfirmationEmail({ email: customerEmail, name: customerName, confirmation, bookings: created, grandTotal, discountTotal }).catch(e => console.error('[email] confirmation error:', e.message));
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

// Bulk-import blocks (e.g. existing Acuity bookings). Idempotent: identical blocks are skipped,
// so it's safe to run more than once. Bypasses the booking-time rules since these are real holds.
app.post('/api/admin/import-blocks', admin, (req, res) => {
  const items = Array.isArray(req.body.blocks) ? req.body.blocks : [];
  // request-level default kind; each block may override with its own b.kind
  const defKind = req.body.kind === 'booking' ? 'booking' : 'hold';
  const exists = db.prepare(`SELECT id FROM blocks WHERE room_id=? AND date=? AND start=? AND end=?`);
  const ins = db.prepare(`INSERT INTO blocks (room_id,date,start,end,reason,kind,created_at) VALUES (?,?,?,?,?,?,?)`);
  const retag = db.prepare(`UPDATE blocks SET kind=? WHERE id=?`);
  let inserted = 0, skipped = 0, bad = 0;
  for (const b of items) {
    const room = (b.room || '').toString(), date = (b.date || '').toString(), s = +b.start, e = +b.end;
    if (!VL.roomById(room) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(e > s)) { bad++; continue; }
    const kind = (b.kind === 'booking' || b.kind === 'hold') ? b.kind : defKind;
    const found = exists.get(room, date, s, e);
    if (found) { retag.run(kind, found.id); skipped++; continue; }   // re-tag existing so labels can be corrected
    ins.run(room, date, s, e, (b.reason || 'Imported').toString().slice(0, 120), kind, nowISO());
    inserted++;
  }
  res.json({ ok: true, total: items.length, inserted, skipped, bad });
});

// Remove a single block/hold by id (used by the self-serve hold tool)
app.post('/api/admin/delete-block', admin, (req, res) => {
  const id = +req.body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const info = db.prepare(`DELETE FROM blocks WHERE id=?`).run(id);
  res.json({ ok: true, deleted: info.changes });
});

// Create a Square payment link for a manual booking, and remember it on the entry
app.post('/api/admin/payment-link', admin, async (req, res) => {
  const amount = Math.round(parseFloat(req.body.amount) * 100);
  if (!(amount > 0)) return res.status(400).json({ error: 'Please enter a dollar amount.' });
  const name = (req.body.name || 'The Vintage Loft — studio booking').toString().slice(0, 255);
  const out = await payments.createLink({ amountCents: amount, name });
  if (!out.ok) return res.status(400).json({ error: out.error });
  if (req.body.id) {
    const table = req.body.source === 'booking' ? 'bookings' : 'blocks';
    try { db.prepare(`UPDATE ${table} SET pay_link=? WHERE id=?`).run(out.url, +req.body.id); } catch (_) {}
  }
  res.json({ ok: true, url: out.url, test: !!out.test });
});

// Save/update a staff note on any entry (a block/hold or a real booking)
app.post('/api/admin/set-note', admin, (req, res) => {
  const id = +req.body.id;
  const notes = (req.body.notes == null ? '' : String(req.body.notes)).slice(0, 4000);
  if (!id) return res.status(400).json({ error: 'id required' });
  const table = req.body.source === 'booking' ? 'bookings' : 'blocks';
  const info = db.prepare(`UPDATE ${table} SET notes=? WHERE id=?`).run(notes, id);
  res.json({ ok: true, changed: info.changes });
});

// Flip an entry between a real Booking and a Hold (blocks only)
app.post('/api/admin/set-kind', admin, (req, res) => {
  const id = +req.body.id;
  const kind = req.body.kind === 'booking' ? 'booking' : 'hold';
  if (!id) return res.status(400).json({ error: 'id required' });
  const info = db.prepare(`UPDATE blocks SET kind=? WHERE id=?`).run(kind, id);
  res.json({ ok: true, changed: info.changes, kind });
});

// Remove ONLY the auto-generated demo data (Seed Client bookings + Maintenance block)
app.post('/api/admin/clear-demo', admin, (_req, res) => {
  const b = db.prepare(`DELETE FROM bookings WHERE payment_ref='SEED' OR customer_email='seed@example.com'`).run();
  const k = db.prepare(`DELETE FROM blocks WHERE reason='Maintenance'`).run();
  res.json({ ok: true, bookingsRemoved: b.changes, blocksRemoved: k.changes });
});

// Wipe ALL bookings and holds for a clean pre-launch start. Requires confirm:'RESET'.
app.post('/api/admin/reset-all', admin, (req, res) => {
  if (req.body.confirm !== 'RESET') return res.status(400).json({ error: 'confirmation required' });
  const b = db.prepare(`DELETE FROM bookings`).run();
  const k = db.prepare(`DELETE FROM blocks`).run();
  res.json({ ok: true, bookingsRemoved: b.changes, blocksRemoved: k.changes });
});

// Send day-before reminders for TOMORROW's bookings (Toronto). Grouped by reservation so a
// multi-studio order gets one email. reminder_sent guards against duplicates, so this is safe
// to call repeatedly (the built-in scheduler and the manual endpoint both use it).
async function sendRemindersForTomorrow() {
  const target = torontoISO(1);
  const rows = db.prepare(`SELECT * FROM bookings WHERE date=? AND status='confirmed' AND reminder_sent=0`).all(target);
  const groups = {};
  for (const r of rows) { const k = r.confirmation || ('e:' + r.customer_email); (groups[k] = groups[k] || []).push(r); }
  let sent = 0, failed = 0;
  for (const k of Object.keys(groups)) {
    const g = groups[k]; const first = g[0];
    if (!first.customer_email) continue;
    const bookingsForEmail = g.map(b => ({ roomName: (VL.roomById(b.room_id) || {}).name || b.room_id, date: b.date, start: b.start, end: b.end }));
    const r = await sendEmail({ to: first.customer_email, subject: 'See you tomorrow at The Vintage Loft!', html: reminderEmail({ name: first.customer_name, confirmation: first.confirmation, bookings: bookingsForEmail }) });
    if (r.ok) { const mark = db.prepare(`UPDATE bookings SET reminder_sent=1 WHERE id=?`); g.forEach(b => mark.run(b.id)); sent++; }
    else if (!r.skipped) failed++;
  }
  if (sent) console.log('[email] sent ' + sent + ' reminder(s) for ' + target);
  return { date: target, reservations: Object.keys(groups).length, sent, failed };
}

// Manual trigger (handy for testing, or an external cron as a backup). Same logic as the auto-run.
app.get('/api/tasks/send-reminders', admin, async (req, res) => {
  const r = await sendRemindersForTomorrow();
  res.json(Object.assign({ ok: true, emailEnabled }, r));
});

// Built-in daily scheduler — automatically sends the day-before reminders each morning
// (Toronto time), so no external cron is needed. Checks every 20 min and fires once per day
// at/after REMINDER_HOUR. reminder_sent prevents any duplicate sends.
function startReminderScheduler() {
  if (!emailEnabled) { console.log('[scheduler] reminders off (no RESEND_API_KEY)'); return; }
  const REMINDER_HOUR = Math.max(0, Math.min(23, +(process.env.REMINDER_HOUR || 9)));
  let lastRun = null;
  const tick = () => {
    try {
      const hp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hour12: false }).formatToParts(new Date());
      const hour = (+((hp.find(p => p.type === 'hour') || {}).value)) % 24;
      const today = torontoISO(0);
      if (hour >= REMINDER_HOUR && lastRun !== today) {
        lastRun = today;
        sendRemindersForTomorrow().catch(e => console.error('[email] reminder sweep error:', e.message));
      }
    } catch (e) { console.error('[scheduler] error:', e.message); }
  };
  setInterval(tick, 20 * 60 * 1000); // every 20 minutes
  tick();
  console.log('[scheduler] daily reminders ON — target ' + REMINDER_HOUR + ':00 America/Toronto');
}

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => { console.log(`Vintage Loft booking server on :${PORT} (payments: ${payments.mode}, email: ${emailEnabled ? 'resend' : 'off'})`); startReminderScheduler(); });
module.exports = { app, db };
