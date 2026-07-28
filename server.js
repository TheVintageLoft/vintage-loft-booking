/* The Vintage Loft — booking server (Phase 1)
   Node 22 built-in SQLite (no native deps). Run: npm start  (node --experimental-sqlite server.js) */
const express = require('express');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
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
// client contact (phone/email JSON) on a manually-added booking
try { db.exec("ALTER TABLE blocks ADD COLUMN client TEXT"); } catch (_) {}
// add-ons chosen on a manually-added booking ({items:{id:qty}, options:{id:label}})
try { db.exec("ALTER TABLE blocks ADD COLUMN addons_json TEXT"); } catch (_) {}
// client intake form answers on a manually-added booking (reason/sessions/photographer/details)
try { db.exec("ALTER TABLE blocks ADD COLUMN intake TEXT"); } catch (_) {}
// how a booking was settled: null/'paid' = normal paid booking; 'owner' = owner's own studio use (no charge)
try { db.exec("ALTER TABLE blocks ADD COLUMN pay_mode TEXT"); } catch (_) {}
// day-before reminder guard for manual bookings (mirrors bookings.reminder_sent)
try { db.exec("ALTER TABLE blocks ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
// discount / coupon code applied to a manual booking (so the reserved email, pay link + receipt all reflect it)
try { db.exec("ALTER TABLE blocks ADD COLUMN code TEXT"); } catch (_) {}
// manual-booking payment state: a stable confirmation number, amount paid, and when
try { db.exec("ALTER TABLE blocks ADD COLUMN confirmation TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE blocks ADD COLUMN paid REAL"); } catch (_) {}
try { db.exec("ALTER TABLE blocks ADD COLUMN paid_at TEXT"); } catch (_) {}
// a client directory (imported from Acuity) that powers name autocomplete
try { db.exec(`CREATE TABLE IF NOT EXISTS clients (name_key TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT)`); } catch (_) {}
// client accounts (email + password), login sessions, and a credit-wallet ledger
try { db.exec(`CREATE TABLE IF NOT EXISTS client_accounts (email TEXT PRIMARY KEY, name TEXT, pass_salt TEXT, pass_hash TEXT, created_at TEXT)`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS client_sessions (token TEXT PRIMARY KEY, email TEXT, created_at TEXT)`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS credit_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, amount REAL, reason TEXT, booking_id INTEGER, created_at TEXT)`); } catch (_) {}
// rental-contract signatures (one per client email; a signed client stays signed for future bookings)
try { db.exec(`CREATE TABLE IF NOT EXISTS signatures (email TEXT PRIMARY KEY, name TEXT, confirmation TEXT, signed_at TEXT)`); } catch (_) {}
// early-arrival setup: a flag on the booking + a linked 15-min block that reserves the time before it
try { db.exec("ALTER TABLE bookings ADD COLUMN setup INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE blocks ADD COLUMN booking_id INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN inspo TEXT"); } catch (_) {}   // JSON array of inspiration-photo data URLs
try { db.exec("ALTER TABLE blocks ADD COLUMN inspo TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE blocks ADD COLUMN pay_method TEXT"); } catch (_) {}   // how a manual booking was paid: card / etransfer / cash / debit
// Square card-on-file: link a client email to a Square customer, and remember their saved cards.
db.exec(`CREATE TABLE IF NOT EXISTS square_customers (email TEXT PRIMARY KEY, customer_id TEXT, created_at TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS saved_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, customer_id TEXT, card_id TEXT UNIQUE, brand TEXT, last4 TEXT, exp_month INTEGER, exp_year INTEGER, created_at TEXT)`);
// Timestamped record of the client's consent to store + charge their card (PCI/consent requirement).
db.exec(`CREATE TABLE IF NOT EXISTS card_consents (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, consent_text TEXT, source TEXT, ip TEXT, consented_at TEXT)`);
// Append-only audit trail of sensitive card actions (who did what, when).
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor TEXT, action TEXT, email TEXT, detail TEXT)`);

/* ---------- one-time clean reset (owner-only, no button) ----------
   Set WIPE_ONCE to any word in the host environment to clear ALL bookings + holds
   the next time the server starts. It runs ONCE per value: the word is recorded, so
   leaving the setting in place will NOT wipe again on later restarts. To wipe again
   later, change WIPE_ONCE to a different word. There is no UI or API for this. */
try { db.exec(`CREATE TABLE IF NOT EXISTS wipes (token TEXT PRIMARY KEY, at TEXT)`); } catch (_) {}
if (process.env.WIPE_ONCE) {
  const token = String(process.env.WIPE_ONCE);
  try {
    const already = db.prepare(`SELECT 1 FROM wipes WHERE token=?`).get(token);
    if (!already) {
      const b = db.prepare(`DELETE FROM bookings`).run();
      const k = db.prepare(`DELETE FROM blocks`).run();
      db.prepare(`INSERT INTO wipes (token,at) VALUES (?,?)`).run(token, new Date().toISOString());
      console.log(`[wipe] one-time reset "${token}": removed ${b.changes} bookings + ${k.changes} holds`);
    } else {
      console.log(`[wipe] token "${token}" already used — skipping (calendar left intact)`);
    }
  } catch (e) { console.error('[wipe] error:', e.message); }
}

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
  async charge({ amountCents, sourceId, customerId, idempotencyKey }) {
    if (!SQ.enabled) return { ok: true, ref: 'TEST-' + Date.now().toString(36).toUpperCase(), mode: 'standin' };
    if (!sourceId) return { ok: false, mode: this.mode, error: 'Missing card token' };
    const headers = { 'Authorization': 'Bearer ' + SQ.token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (SQ.version) headers['Square-Version'] = SQ.version;
    // A caller-supplied idempotency key (stable per logical charge) lets Square dedupe a double-submit
    // instead of charging twice; falls back to a unique key for one-off charges.
    const body = { source_id: sourceId, idempotency_key: idempotencyKey || ('vl-' + Date.now() + '-' + Math.round(Math.random() * 1e9)),
      amount_money: { amount: amountCents, currency: 'CAD' }, location_id: SQ.locationId };
    if (customerId) body.customer_id = customerId;   // required when sourceId is a saved card-on-file
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

/* ---------- Square Cards on File (save a client's card, then charge it later with permission) ----------
   Flow: each client email maps to a Square Customer. A card saved at checkout (or already on file in
   Square) is stored against that customer and remembered locally so the Staff App can charge it. */
function sqHeaders() { const h = { 'Authorization': 'Bearer ' + SQ.token, 'Content-Type': 'application/json', 'Accept': 'application/json' }; if (SQ.version) h['Square-Version'] = SQ.version; return h; }
function clientIp(req) { return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || ''; }
function recordConsent(email, text, source, ip) { try { db.prepare(`INSERT INTO card_consents (email,consent_text,source,ip,consented_at) VALUES (?,?,?,?,?)`).run((email || '').toLowerCase(), (text || '').toString().slice(0, 600), source || '', ip || '', nowISO()); } catch (_) {} }
function audit(actor, action, email, detail) { try { db.prepare(`INSERT INTO audit_log (at,actor,action,email,detail) VALUES (?,?,?,?,?)`).run(nowISO(), (actor || '').toString().slice(0, 80), (action || '').toString().slice(0, 60), (email || '').toLowerCase(), (detail || '').toString().slice(0, 600)); } catch (_) {} }
function rememberCard(email, customerId, c) {
  try { db.prepare(`INSERT OR IGNORE INTO saved_cards (email,customer_id,card_id,brand,last4,exp_month,exp_year,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run((email || '').toLowerCase(), customerId, c.id, c.card_brand || c.brand || '', c.last_4 || c.last4 || '', c.exp_month || null, c.exp_year || null, nowISO()); } catch (_) {}
}
// Find or create the Square customer for this email; cache the id locally.
async function sqUpsertCustomer(email, name) {
  email = (email || '').toLowerCase(); if (!email || !SQ.enabled) return null;
  const cached = db.prepare(`SELECT customer_id FROM square_customers WHERE email=?`).get(email);
  if (cached && cached.customer_id) return cached.customer_id;
  let cid = null;
  try {
    const r = await fetch(SQ.apiBase + '/v2/customers/search', { method: 'POST', headers: sqHeaders(), body: JSON.stringify({ query: { filter: { email_address: { exact: email } } } }) });
    const d = await r.json().catch(() => ({}));
    if (d.customers && d.customers[0]) cid = d.customers[0].id;
  } catch (_) {}
  if (!cid) {
    const parts = (name || '').trim().split(/\s+/);
    try {
      const r = await fetch(SQ.apiBase + '/v2/customers', { method: 'POST', headers: sqHeaders(), body: JSON.stringify({ idempotency_key: 'vlcust-' + email, given_name: parts[0] || '', family_name: parts.slice(1).join(' ') || '', email_address: email }) });
      const d = await r.json().catch(() => ({}));
      if (d.customer) cid = d.customer.id;
    } catch (_) {}
  }
  if (cid) db.prepare(`INSERT OR REPLACE INTO square_customers (email,customer_id,created_at) VALUES (?,?,?)`).run(email, cid, nowISO());
  return cid;
}
// Store a card on file from a Web Payments token (source_id) + SCA verification token.
async function sqSaveCard({ email, name, sourceId, verificationToken }) {
  if (!SQ.enabled) return { ok: false, error: 'Square is not connected.' };
  const customerId = await sqUpsertCustomer(email, name);
  if (!customerId) return { ok: false, error: 'Could not create the Square customer.' };
  const body = { idempotency_key: 'vlcard-' + Date.now() + '-' + Math.round(Math.random() * 1e9), source_id: sourceId, card: { customer_id: customerId } };
  if (name) body.card.cardholder_name = name.slice(0, 96);
  if (verificationToken) body.verification_token = verificationToken;
  try {
    const r = await fetch(SQ.apiBase + '/v2/cards', { method: 'POST', headers: sqHeaders(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.card) { rememberCard(email, customerId, d.card); return { ok: true, customerId, card: { id: d.card.id, brand: d.card.card_brand, last4: d.card.last_4, exp_month: d.card.exp_month, exp_year: d.card.exp_year } }; }
    return { ok: false, error: (d.errors && d.errors[0] && (d.errors[0].detail || d.errors[0].code)) || 'Could not save the card.' };
  } catch (e) { return { ok: false, error: e.message }; }
}
// List a client's saved cards: refresh from Square (so cards saved in the Square dashboard show too), fall back to local.
async function sqListCards(email) {
  email = (email || '').toLowerCase();
  const customerId = await sqUpsertCustomer(email, '');
  if (SQ.enabled && customerId) {
    try {
      const r = await fetch(SQ.apiBase + '/v2/cards?customer_id=' + encodeURIComponent(customerId), { method: 'GET', headers: sqHeaders() });
      const d = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(d.cards)) d.cards.filter(c => c.enabled !== false).forEach(c => rememberCard(email, customerId, c));
    } catch (_) {}
  }
  return db.prepare(`SELECT card_id, brand, last4, exp_month, exp_year FROM saved_cards WHERE email=? ORDER BY id DESC`).all(email);
}

/* ---------- PayPal (Orders v2 REST API) — turns on when PAYPAL_CLIENT_ID + PAYPAL_SECRET are set ----------
   Set PAYPAL_ENV='live' for production (else sandbox). The client-id is public (used by the on-page
   PayPal buttons); the secret stays server-side. All amounts are CAD. */
const PP = {
  clientId: process.env.PAYPAL_CLIENT_ID || '',
  secret: process.env.PAYPAL_SECRET || '',
  env: (process.env.PAYPAL_ENV || 'sandbox').toLowerCase()
};
PP.enabled = !!(PP.clientId && PP.secret);
PP.apiBase = PP.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
async function ppToken() {
  const auth = Buffer.from(PP.clientId + ':' + PP.secret).toString('base64');
  const r = await fetch(PP.apiBase + '/v1/oauth2/token', { method: 'POST', headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d && d.error_description) || 'PayPal authentication failed');
  return d.access_token;
}
async function ppCreateOrder(amountCents, desc) {
  const token = await ppToken();
  const r = await fetch(PP.apiBase + '/v2/checkout/orders', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'CAD', value: (amountCents / 100).toFixed(2) }, description: (desc || 'The Vintage Loft studio booking').slice(0, 127) }], application_context: { brand_name: 'The Vintage Loft', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error((d && d.message) || 'Could not create the PayPal order');
  return d.id;
}
async function ppCaptureOrder(orderId) {
  try {
    if (!orderId) return { ok: false, error: 'Missing PayPal order.' };
    const token = await ppToken();
    const r = await fetch(PP.apiBase + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.status === 'COMPLETED') return { ok: true, ref: orderId };
    return { ok: false, error: (d && d.message) || ('PayPal payment not completed (' + (d && d.status) + ')') };
  } catch (e) { return { ok: false, error: e.message }; }
}
// The authoritative order total AFTER any discount code + account credit (mirrors /api/bookings) — so the PayPal order is created for the exact amount owed.
function orderGrandTotal(items, codeStr, token, useCredit) {
  let codeInfo = null;
  if (codeStr && normCode(codeStr)) codeInfo = lookupCode(codeStr);
  const quotes = items.map(it => VL.priceQuote(it.room, it.date, (+it.end) - (+it.start), it.addons || {}, it.addonOptions || {}));
  let paidArr;
  if (codeInfo && codeInfo.type === 'percent') paidArr = quotes.map(q => VL.applyDiscountToQuote(q, codeInfo).total);
  else if (codeInfo && codeInfo.type === 'fixed') { let remaining = Math.min(codeInfo.amount, VL.round2(quotes.reduce((s, q) => s + q.total, 0))); paidArr = quotes.map(q => { const rc = VL.round2(Math.min(remaining, q.total)); remaining = VL.round2(remaining - rc); return VL.round2(q.total - rc); }); }
  else paidArr = quotes.map(q => q.total);
  let grand = VL.round2(paidArr.reduce((s, p) => s + p, 0));
  const acctEmail = emailForToken(token);
  if (acctEmail && useCredit) { const bal = creditBalance(acctEmail); const used = VL.round2(Math.max(0, Math.min(bal, grand))); grand = VL.round2(grand - used); }
  return grand;
}

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
const CONTRACT_URL = process.env.CONTRACT_URL || 'https://www.thevintageloft.ca/rental-contract';

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

/* ---------- SMS booking alerts (Twilio HTTP API — no npm dependency) ----------
   Owner/staff text alert on each new client booking, so a late-night booking never gets missed.
   Turn it on by setting on the host:
     TWILIO_ACCOUNT_SID   your Twilio Account SID (starts with AC...)
     TWILIO_AUTH_TOKEN    your Twilio Auth Token
     TWILIO_FROM          your Twilio phone number in +1 format, e.g. +19055551234
     NOTIFY_SMS           who to text, comma-separated in +1 format, e.g. +19051112222,+19053334444
   Without all four we log and skip, so a booking never fails because of an SMS problem. */
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const NOTIFY_SMS = (process.env.NOTIFY_SMS || '').split(',').map(s => s.trim()).filter(Boolean);
const smsEnabled = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && NOTIFY_SMS.length);

async function sendSMS(to, body) {
  if (!smsEnabled) { console.log('[sms] skipped (Twilio not configured) ->', to); return { ok: false, skipped: true }; }
  try {
    const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
    const form = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, sid: d.sid };
    console.error('[sms] send failed:', d && (d.message || JSON.stringify(d)));
    return { ok: false, error: (d && d.message) || 'send failed' };
  } catch (e) { console.error('[sms] error:', e.message); return { ok: false, error: e.message }; }
}

function smsDate(iso) { const p = (iso || '').split('-').map(Number); if (!p[0]) return iso || ''; const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2])); return _weekdays[dt.getUTCDay()].slice(0, 3) + ' ' + _months[p[1] - 1].slice(0, 3) + ' ' + p[2]; }

function bookingSmsText({ name, confirmation, bookings, grandTotal, source }) {
  const lines = (bookings || []).map(b => `${b.roomName} ${smsDate(b.date)} ${emTime(b.start)}-${emTime(b.end)}`);
  return `New booking${source ? ' (' + source + ')' : ''} ${confirmation}\n${name || 'Guest'}\n${lines.join('\n')}\nTotal ${emMoney(grandTotal)}`;
}

async function notifyNewBooking(info) {
  if (!smsEnabled) { console.log('[sms] new-booking alert skipped (Twilio not configured)'); return; }
  const body = bookingSmsText(info);
  for (const to of NOTIFY_SMS) {
    const r = await sendSMS(to, body);
    if (r.ok) console.log('[sms] booking alert sent ->', to);
  }
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

function confirmationEmail({ name, confirmation, bookings, grandTotal, discountTotal, email }) {
  const savings = discountTotal > 0 ? `<tr><td style="padding:6px 0;color:#2e7d32">Savings</td><td align="right" style="padding:6px 0;color:#2e7d32">&minus;${emMoney(discountTotal)}</td></tr>` : '';
  const receiptUrl = PUBLIC_URL + '/receipt.html?c=' + encodeURIComponent(confirmation) + (email ? '&e=' + encodeURIComponent(email) : '');
  const inner = `
    <p style="font-size:18px;margin:0 0 14px">Hello ${emFirst(name)},</p>
    <p style="margin:0 0 14px;line-height:1.6">Thanks for booking at The Vintage Loft Studios! We look forward to having you come in. You'll receive a reminder email the day before your booking.</p>
    <div style="background:#f6f5f3;border-radius:10px;padding:16px 18px;margin:0 0 18px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9a938a;font-family:Arial,sans-serif;margin-bottom:10px">Your reservation &middot; ${confirmation}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${bookingRowsHtml(bookings)}
        ${savings}
        <tr><td style="padding:10px 0 0"><b>Total paid</b><br><span style="font-size:11px;color:#9a938a;font-family:Arial,sans-serif">HST included</span></td><td align="right" style="padding:10px 0 0;vertical-align:top"><b>${emMoney(grandTotal)}</b></td></tr>
      </table>
    </div>
    <div style="text-align:center;margin:0 0 22px">
      <a href="${receiptUrl}" style="display:inline-block;background:#7c7268;color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px">Download your receipt (PDF)</a>
      <div style="font-family:Arial,sans-serif;font-size:12px;color:#9a938a;margin-top:8px">A printable, itemized receipt for your records &mdash; HST included.</div>
    </div>
    <div style="border:1px solid #eae8e4;border-radius:10px;padding:16px 18px;margin:0 0 20px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#3a352f">
      <div style="font-weight:bold;margin-bottom:6px">Studio policies &amp; rental contract</div>
      <div style="color:#6b6459;margin-bottom:12px">Please review our policies and sign the rental contract before your session if you haven't already.</div>
      <div style="text-align:center"><a href="${PUBLIC_URL}/?sign=1&amp;e=${encodeURIComponent(email || '')}&amp;c=${encodeURIComponent(confirmation)}" style="display:inline-block;background:#7c7268;color:#fff;text-decoration:none;font-size:14px;font-weight:bold;padding:11px 24px;border-radius:8px">Review &amp; sign the rental contract</a></div>
      <div style="text-align:center;margin-top:8px;font-size:13px"><a href="${CONTRACT_URL}" style="color:#7c7268">Read the studio policies &amp; rental contract</a></div>
    </div>
    <div style="border:1px solid #eae8e4;border-radius:10px;padding:16px 18px;margin:0 0 20px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#3a352f">
      <div style="font-weight:bold;margin-bottom:10px">Need to make a change?</div>
      <div style="text-align:center">
        <a href="${PUBLIC_URL}/?account=1" style="display:inline-block;background:#7c7268;color:#fff;text-decoration:none;font-size:14px;font-weight:bold;padding:11px 22px;border-radius:8px;margin:0 4px 6px">Edit my booking</a>
        <a href="${PUBLIC_URL}/?account=1" style="display:inline-block;background:#fff;color:#7c7268;border:1px solid #d8d3cc;text-decoration:none;font-size:14px;font-weight:bold;padding:11px 22px;border-radius:8px;margin:0 4px 6px">Cancel my booking</a>
      </div>
      <div style="color:#9a938a;font-size:12px;text-align:center;margin-top:6px">Sign in with this email (${email ? email.replace(/[<>&"]/g, '') : 'the email you booked with'}) to edit or cancel. Changes follow our cancellation policy below.</div>
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
      <b>Cancellation policy:</b> ${cancelPolicyLine(bookings)}
    </div>`;
  return emailShell(inner);
}

// The cancellation-policy sentence for an email, worded for the booking's dates (holiday weekends = 7 days).
function cancelPolicyLine(bookings) {
  const xmas = (bookings || []).some(b => isXmasWeekend(b.date));
  return xmas
    ? 'We do not give refunds for bookings. Because these are holiday-weekend dates, we give full studio credit only if cancelled or rescheduled with <b>7 days</b> or more notice.'
    : 'We do not give refunds for bookings, however we give full studio credit if cancelled or rescheduled with 48 hours or more notice. (Holiday-weekend dates, Nov–Dec Sat/Sun, require 7 days notice.)';
}

// Sent when a client extends an already-paid manual booking: shows the updated booking, what they've
// already paid, and a Pay-now button for just the balance owed.
function balanceEmail({ name, confirmation, bookings, alreadyPaid, balanceDue, payUrl }) {
  const payBtn = payUrl ? `<div style="text-align:center;margin:0 0 20px"><a href="${payUrl}" style="display:inline-block;background:#7c7268;color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;padding:13px 30px;border-radius:8px">Pay the balance &middot; ${emMoney(balanceDue)}</a></div>` : '';
  const inner = `
    <p style="font-size:18px;margin:0 0 14px">Hello ${emFirst(name)},</p>
    <p style="margin:0 0 14px;line-height:1.6">Your booking at The Vintage Loft has been updated. Here are the new details and the balance still owing.</p>
    <div style="background:#f6f5f3;border-radius:10px;padding:16px 18px;margin:0 0 18px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9a938a;font-family:Arial,sans-serif;margin-bottom:10px">Your reservation &middot; ${confirmation}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${bookingRowsHtml(bookings)}
        <tr><td style="padding:8px 0 0;color:#6b6459">Already paid</td><td align="right" style="padding:8px 0 0;color:#6b6459">&minus;${emMoney(alreadyPaid)}</td></tr>
        <tr><td style="padding:10px 0 0"><b>Balance due</b></td><td align="right" style="padding:10px 0 0"><b>${emMoney(balanceDue)}</b></td></tr>
      </table>
    </div>
    ${payBtn}
    <p style="margin:0 0 18px;line-height:1.6;font-family:Arial,sans-serif;font-size:14px;color:#6b6459">Once your payment is received, we'll email your updated receipt. Questions? Call or text 905-767-2099.</p>
    <div style="background:#f6f5f3;border:1px solid #eae8e4;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.6;color:#6b6459;font-family:Arial,sans-serif">
      <b>Cancellation policy:</b> ${cancelPolicyLine(bookings)}
    </div>`;
  return emailShell(inner);
}

// Sent when a booking is cancelled. Warm wording, and two outcomes: credit issued, or (inside the window) no credit.
function cancellationEmail({ name, confirmation, bookings, credited, email }) {
  const emailSafe = (email || 'this address').replace(/[<>&"]/g, '');
  const resBox = (bookings && bookings.length) ? `
    <div style="background:#f6f5f3;border-radius:10px;padding:16px 18px;margin:0 0 18px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9a938a;font-family:Arial,sans-serif;margin-bottom:10px">Cancelled${confirmation ? ' &middot; ' + confirmation : ''}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${bookings.map(b => `<tr><td style="padding:6px 0"><b>${b.roomName}</b><br><span style="color:#8a8375;font-size:13px;font-family:Arial,sans-serif">${emDate(b.date)} &middot; ${emTime(b.start)}&ndash;${emTime(b.end)}</span></td></tr>`).join('')}
      </table>
    </div>` : '';
  const acctUrl = PUBLIC_URL + '/?account=1';
  const outcome = (credited > 0)
    ? `<div style="background:#eaf5ec;border:1px solid #bfe0c5;border-radius:10px;padding:15px 17px;margin:0 0 18px;line-height:1.6">
         The full amount you paid &mdash; <b>${emMoney(credited)}</b> &mdash; is now waiting in your account as <b>studio credit</b> toward a future booking. It applies automatically the next time you book.
         <div style="text-align:center;margin:16px 0 4px"><a href="${acctUrl}" style="display:inline-block;background:#7c7268;color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;padding:12px 26px;border-radius:8px">View my account &amp; credit</a></div>
         <div style="font-family:Arial,sans-serif;font-size:13px;color:#6b6459;text-align:center;margin-top:6px">Please sign in with the same email you booked with (${emailSafe}) so your credit shows up.</div></div>`
    : `<div style="background:#f6f5f3;border:1px solid #eae8e4;border-radius:10px;padding:15px 17px;margin:0 0 18px;line-height:1.6">
         This cancellation falls within our ${((bookings || []).some(x => isXmasWeekend(x.date)) ? '7-day holiday-weekend' : '48-hour')} cancellation window, so this booking isn't eligible for studio credit. We understand that unexpected situations can arise, and while we stand behind our cancellation policy, truly exceptional circumstances may be reviewed at our discretion.<br><br>
         We appreciate your understanding and look forward to welcoming you back to The Vintage Loft soon.</div>`;
  const inner = `
    <p style="font-size:18px;margin:0 0 14px">Hello ${emFirst(name)},</p>
    <p style="margin:0 0 16px;line-height:1.6">Your booking at The Vintage Loft has been <b>cancelled</b>. Here's what was on it:</p>
    ${resBox}
    ${outcome}
    <p style="margin:0 0 14px;line-height:1.6;font-family:Arial,sans-serif;font-size:14px;color:#6b6459">Questions, or ready to rebook? Call or text 905-767-2099.</p>`;
  return emailShell(inner);
}

// Sent for a manual booking BEFORE payment: reserved + a Pay-now button, no receipt.
function reservedEmail({ name, confirmation, bookings, amountDue, discountTotal, payUrl }) {
  const payBtn = payUrl ? `<div style="text-align:center;margin:0 0 20px"><a href="${payUrl}" style="display:inline-block;background:#7c7268;color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;padding:13px 30px;border-radius:8px">Pay now &middot; ${emMoney(amountDue)}</a></div>` : '';
  const savings = (discountTotal > 0) ? `<tr><td style="padding:6px 0;color:#2e7d32">Discount</td><td align="right" style="padding:6px 0;color:#2e7d32">&minus;${emMoney(discountTotal)}</td></tr>` : '';
  const inner = `
    <p style="font-size:18px;margin:0 0 14px">Hello ${emFirst(name)},</p>
    <p style="margin:0 0 14px;line-height:1.6">Your studio time at The Vintage Loft is <b>reserved</b>. To confirm your booking, please complete payment${payUrl ? ' using the button below' : ' with the link we\'ll send you'}.</p>
    <div style="background:#f6f5f3;border-radius:10px;padding:16px 18px;margin:0 0 18px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9a938a;font-family:Arial,sans-serif;margin-bottom:10px">Your reservation &middot; ${confirmation}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${bookingRowsHtml(bookings)}
        ${savings}
        <tr><td style="padding:10px 0 0"><b>Amount due</b></td><td align="right" style="padding:10px 0 0"><b>${emMoney(amountDue)}</b></td></tr>
      </table>
    </div>
    ${payBtn}
    <p style="margin:0 0 18px;line-height:1.6;font-family:Arial,sans-serif;font-size:14px;color:#6b6459">Once your payment is received, we'll email your receipt. Questions? Call or text 905-767-2099.</p>
    <div style="background:#f6f5f3;border:1px solid #eae8e4;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.6;color:#6b6459;font-family:Arial,sans-serif">
      <b>Cancellation policy:</b> ${cancelPolicyLine(bookings)}
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
  const r = await sendEmail({ to: email, subject: "You're booked at The Vintage Loft!", html: confirmationEmail({ name, confirmation, bookings, grandTotal, discountTotal, email }) });
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

/* ---------- client accounts + credit wallet helpers ---------- */
// Owner logins: accounts that see the "studio use" (Vintage Films) running total. Comma-separated env, sensible defaults.
const OWNER_EMAILS = (process.env.OWNER_EMAILS || 'kelly@thevintageloft.ca,kellylemayphotography@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isOwnerEmail(email) { return OWNER_EMAILS.indexOf((email || '').toLowerCase()) >= 0; }
function roomNameOf(id) { return (VL.roomById(id) || {}).name || id; }
// The regular studio value (what a paying client would owe) for a bookings-table row, ignoring any code.
function bookingRegularValue(b) {
  let a = { items: {}, options: {} };
  try { a = JSON.parse(b.addons_json || '{}'); } catch (_) {}
  try { return VL.priceQuote(b.room_id, b.date, (b.hours || (b.end - b.start)), a.items || {}, a.options || {}).total; } catch (_) { return 0; }
}
// Two year-end buckets for the owner: 'owner' (Kelly / Vintage Films own use) and 'comp' (marketing + goodwill).
// Each pulls from BOTH the Staff-App manual bookings (pay_mode) AND real client checkouts that used an owner/comp code.
function usageSummaries() {
  const ym = torontoISO(0).slice(0, 7), yr = torontoISO(0).slice(0, 4);
  const buckets = { owner: [], comp: [] };
  // 1) manual bookings settled as owner use / comp in the Staff App
  let brows = [];
  try { brows = db.prepare(`SELECT * FROM blocks WHERE kind='booking' AND pay_mode IN ('owner','comp')`).all(); } catch (_) {}
  brows.forEach(b => {
    let v = 0; try { v = blockQuote(b).total; } catch (_) {}
    buckets[b.pay_mode].push({ date: b.date, start: b.start, end: b.end, roomName: roomNameOf(b.room_id), client: b.reason || '', code: (b.pay_mode === 'owner' ? 'Owner (manual)' : 'Comp (manual)'), value: VL.round2(v) });
  });
  // 2) real client checkouts that used an owner or comp code
  let orows = [];
  try { orows = db.prepare(`SELECT * FROM bookings WHERE status!='cancelled' AND code IS NOT NULL AND code!=''`).all(); } catch (_) {}
  orows.forEach(b => {
    const c = CODES[(b.code || '').toUpperCase()]; if (!c) return;
    const bucket = c.kind === 'Owner' ? 'owner' : (c.kind === 'Comp' ? 'comp' : null); if (!bucket) return;
    buckets[bucket].push({ date: b.date, start: b.start, end: b.end, roomName: roomNameOf(b.room_id), client: b.customer_name || '', code: (b.code || '').toUpperCase(), value: VL.round2(bookingRegularValue(b)) });
  });
  function summarize(list) {
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    let mtd = 0, ytd = 0, all = 0;
    list.forEach(s => { all += s.value; if ((s.date || '').slice(0, 4) === yr) ytd += s.value; if ((s.date || '').slice(0, 7) === ym) mtd += s.value; });
    return { mtd: VL.round2(mtd), ytd: VL.round2(ytd), all: VL.round2(all), count: list.length, sessions: list };
  }
  return { owner: summarize(buckets.owner), comp: summarize(buckets.comp) };
}
function hashPassword(pw, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex'); return { salt, hash }; }
function verifyPassword(pw, salt, hash) { try { const h = crypto.scryptSync(String(pw), salt, 64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex')); } catch (_) { return false; } }
function newSession(email) { const token = crypto.randomBytes(24).toString('hex'); db.prepare(`INSERT INTO client_sessions (token,email,created_at) VALUES (?,?,?)`).run(token, email.toLowerCase(), new Date().toISOString()); return token; }
function emailForToken(token) { if (!token) return null; const r = db.prepare(`SELECT email FROM client_sessions WHERE token=?`).get(String(token)); return r ? r.email : null; }
function creditBalance(email) { const r = db.prepare(`SELECT COALESCE(SUM(amount),0) bal FROM credit_ledger WHERE email=?`).get((email || '').toLowerCase()); return VL.round2(r.bal || 0); }
function addCredit(email, amount, reason, bookingId) { db.prepare(`INSERT INTO credit_ledger (email,amount,reason,booking_id,created_at) VALUES (?,?,?,?,?)`).run((email || '').toLowerCase(), VL.round2(amount), reason || '', bookingId || null, new Date().toISOString()); }
// current America/Toronto UTC offset in hours (e.g. -4 in summer, -5 in winter)
function torontoOffsetHours() { try { const n = new Date(); const loc = new Date(n.toLocaleString('en-US', { timeZone: 'America/Toronto' })); const utc = new Date(n.toLocaleString('en-US', { timeZone: 'UTC' })); return (loc - utc) / 3600000; } catch (_) { return -5; } }
// hours from now until a booking's start (date 'YYYY-MM-DD' + decimal start hour, Toronto local)
function hoursUntil(dateStr, startHour) { const p = (dateStr || '').split('-').map(Number); if (!p[0]) return 0; const off = torontoOffsetHours(); const bookingUTC = Date.UTC(p[0], p[1] - 1, p[2]) + startHour * 3600000 - off * 3600000; return (bookingUTC - Date.now()) / 3600000; }
// Christmas-weekend bookings (Sat/Sun, Nov 7–Dec 21, any year) get a 7-day cancellation cutoff instead of
// 48h — they can't be re-rented and photographers book large blocks. Month/day based so it recurs yearly.
const XMAS_CANCEL_HOURS = 168; // 7 days
function isXmasWeekend(dateStr) {
  const p = (dateStr || '').split('-').map(Number); if (!p[0]) return false;
  const dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  if (dow !== 0 && dow !== 6) return false;            // Saturdays & Sundays only
  const md = p[1] * 100 + p[2];                        // Nov 7 = 1107, Dec 21 = 1221
  return md >= 1107 && md <= 1221;
}
function cancelWindowHours(dateStr) { return isXmasWeekend(dateStr) ? XMAS_CANCEL_HOURS : 48; }
function cancelWindowLabel(dateStr) { return isXmasWeekend(dateStr) ? '7 days' : '48 hours'; }

// cancel a real booking (bookings table) and issue full account credit if outside the cancellation window
function cancelBookingWithCredit(b) {
  db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(b.id);
  removeSetupBlocks(b.id);   // free the reserved early-arrival window, if any
  const hrs = hoursUntil(b.date, b.start);
  const win = cancelWindowHours(b.date);
  const already = db.prepare(`SELECT 1 FROM credit_ledger WHERE booking_id=? AND amount>0`).get(b.id);
  let credited = 0;
  if (hrs >= win && !already && (b.paid || 0) > 0 && b.customer_email) { credited = VL.round2(b.paid); addCredit(b.customer_email, credited, 'Cancellation credit', b.id); }
  return { credited, hoursOut: Math.round(hrs), windowHours: win, newBalance: b.customer_email ? creditBalance(b.customer_email) : 0 };
}
function validTimes(start, end) {
  if (!(start >= 8 && end <= 20 && end > start)) return 'Outside studio hours (8:00–20:00)';
  if ((end - start) < VL.CONFIG.minHours) return VL.CONFIG.minHours + '-hour minimum';
  if (Math.round(start * 4) !== start * 4 || Math.round(end * 4) !== end * 4) return 'Times must be on the quarter hour';
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
// A 15-minute turnover gap is required between separate bookings/blocks in the same room.
const BUFFER = (VL.CONFIG.bufferMin || 15) / 60;
// Clients must book online at least this many hours ahead; anything sooner routes to staff (call/text).
const LEAD_HOURS = VL.CONFIG.leadHours || 12;
function busyIntervals(roomId, date) {
  // A composite wing (North Wing) and its member rooms (Grand, Dream) share availability:
  // booking any one of them marks the others busy so nothing double-books.
  const rooms = VL.roomConflicts(roomId);
  const ph = rooms.map(() => '?').join(',');
  const b = db.prepare(`SELECT start,end FROM bookings WHERE room_id IN (${ph}) AND date=? AND status!='cancelled'`).all(...rooms, date);
  const k = db.prepare(`SELECT start,end FROM blocks WHERE room_id IN (${ph}) AND date=?`).all(...rooms, date);
  return [...b, ...k];
}
// Free if the requested window keeps at least the 15-min buffer from every existing entry.
// When setup=true the window is extended 15 min earlier (the reserved early-arrival time).
function isFree(roomId, date, start, end, setup) {
  const s = setup ? VL.round2(start - BUFFER) : start;
  return !busyIntervals(roomId, date).some(iv => VL.overlaps(s, end, iv.start - BUFFER, iv.end + BUFFER));
}
// The reserved 15-min early-arrival window, stored as a block linked to its booking.
function addSetupBlock(bookingId, room, date, start) {
  db.prepare(`INSERT INTO blocks (room_id,date,start,end,reason,kind,booking_id,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(room, date, VL.round2(start - BUFFER), start, 'Early arrival setup', 'hold', bookingId, nowISO());
}
function removeSetupBlocks(bookingId) { db.prepare(`DELETE FROM blocks WHERE booking_id=?`).run(bookingId); }

// ---- manual (staff) bookings: confirmation, price, and paid state (stored on the block rows) ----
function newManualConfirmation() {
  const prefix = 'VLM-' + torontoDateCode() + '-';
  // Go one past the HIGHEST suffix ever used today (not the count — counts break when bookings are
  // cancelled/deleted, which caused two bookings to collide onto one confirmation). Then guard for uniqueness.
  let max = 0;
  try {
    const rows = db.prepare(`SELECT confirmation FROM blocks WHERE confirmation LIKE ?`).all(prefix + '%');
    for (const r of rows) { const m = /-(\d+)$/.exec(r.confirmation || ''); if (m) { const v = +m[1]; if (v > max) max = v; } }
  } catch (_) {}
  let n = max + 1;
  const exists = db.prepare(`SELECT 1 FROM blocks WHERE confirmation=? LIMIT 1`);
  while (exists.get(prefix + n)) n++;   // belt-and-suspenders: never reuse an in-use number
  return prefix + n;
}
function blockQuote(b) {
  let a = { items: {}, options: {} };
  try { a = JSON.parse(b.addons_json || '{}'); } catch (_) {}
  return VL.priceQuote(b.room_id, b.date, (b.end - b.start), a.items || {}, a.options || {});
}
// Gather all booking-kind block rows sharing a confirmation into one order (for reserved/receipt emails + /api/receipt).
function manualOrder(conf) {
  if (!conf) return null;
  const blocks = db.prepare(`SELECT * FROM blocks WHERE confirmation=? AND kind='booking' ORDER BY id`).all(conf);
  if (!blocks.length) return null;
  const codeInfo = blocks[0].code ? lookupCode(blocks[0].code) : null;
  let grandTotal = 0, discountTotal = 0, subtotalPre = 0;
  const bookings = blocks.map(b => {
    let q = blockQuote(b);
    subtotalPre += q.pre;
    if (codeInfo && codeInfo.type === 'percent') { q = VL.applyDiscountToQuote(q, codeInfo); discountTotal += (q.discount || 0); }
    grandTotal += q.total;
    return { room: b.room_id, roomName: (VL.roomById(b.room_id) || {}).name || b.room_id, date: b.date, start: b.start, end: b.end, hours: b.end - b.start, total: q.total, pre: q.pre, hst: q.hst, addonItems: q.addonItems };
  });
  if (codeInfo && codeInfo.type === 'fixed') { const credit = Math.min(codeInfo.amount, grandTotal); discountTotal += credit; grandTotal = VL.round2(grandTotal - credit); }
  let client = {}; try { client = JSON.parse(blocks[0].client || '{}'); } catch (_) {}
  return { confirmation: conf, name: blocks[0].reason || '', email: (client.email || ''), bookings, grandTotal: VL.round2(grandTotal), discountTotal: VL.round2(discountTotal), subtotalPre: VL.round2(subtotalPre), code: codeInfo ? codeInfo.code : null, paid: blocks[0].paid, paidAt: blocks[0].paid_at, payUrl: blocks.map(b => b.pay_link).find(Boolean) || null };
}
// Give a manual booking that predates the confirmation feature (e.g. the imported bookings) a reference number, so it can be marked paid / receipted.
function ensureBlockConfirmation(id) {
  const b = db.prepare(`SELECT confirmation FROM blocks WHERE id=?`).get(id);
  if (b && b.confirmation) return b.confirmation;
  const conf = newManualConfirmation();
  db.prepare(`UPDATE blocks SET confirmation=? WHERE id=?`).run(conf, id);
  return conf;
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
app.use(express.json({ limit: '15mb' }));   // large enough for the full client-list import
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
  // "on the house" — content-creator/marketing comps and goodwill gestures. 100% off, tracked in your Comps year-end total.
  const comp = { type: 'percent', off: 1.00, scope: 'all', reusable: true, kind: 'Comp' };
  const map = {
    STEVEVIP: vip, KBKVIP: vip, JOSIEVIP: vip, VIP20: vip,
    ALANNAH50: emp, BRIA50: emp, SHAY50: emp, MACKENZIE50: emp, MIKHELA50: emp, JOELLE50: emp, ROSALIND50: emp,
    KELLY: owner, KAYA: owner,
    COMP: comp, GOODWILL: comp,
    FRIENDSWITHBENEFITS: friend, ONELOVE15: friend,
    VALERIEVON339: { type: 'fixed', amount: 339, scope: 'total', reusable: false, kind: 'Reschedule credit' }
  };
  return map;
})();
const normCode = s => (s || '').toString().toUpperCase().replace(/\s+/g, '');
// A short, customer-safe label describing what a code does (no other codes revealed).
function codeLabel(c) {
  if (c.type === 'fixed') return '$' + c.amount.toFixed(2) + ' credit';
  if (c.kind === 'Comp') return 'On the house';
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
app.get('/api/paypal-config', (_req, res) => res.json({ enabled: PP.enabled, clientId: PP.enabled ? PP.clientId : null, env: PP.env, currency: 'CAD' }));

// PayPal: create an order for the exact (code + credit adjusted) total. The booking is confirmed by /api/bookings after capture.
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    if (!PP.enabled) return res.status(400).json({ error: 'PayPal is not connected yet.' });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No studios in the booking.' });
    for (const it of items) {
      const s = +it.start, e = +it.end, room = VL.roomById(it.room);
      if (!room || !it.date) return res.status(400).json({ error: 'Invalid booking.' });
      const terr = validTimes(s, e); if (terr) return res.status(400).json({ error: terr });
      if (isClosedDay(it.date)) return res.status(400).json({ error: 'The studio is closed on Mondays.' });
      if (hoursUntil(it.date, s) < LEAD_HOURS) return res.status(400).json({ error: 'Bookings within ' + LEAD_HOURS + ' hours need to be arranged with us directly — please call or text 905-767-2099.' });
      if (!VL.validDuration(it.room, e - s)) return res.status(400).json({ error: 'That duration is not available for ' + room.name + '.' });
      const setup = !!(it.addons && it.addons.earlysetup);
      if (!isFree(it.room, it.date, s, e) || (setup && !isFree(it.room, it.date, s, e, true))) return res.status(409).json({ error: room.name + ' is no longer available for that time.' });
    }
    const grand = orderGrandTotal(items, req.body.code, req.body.token, req.body.useCredit);
    if (!(grand > 0)) return res.status(400).json({ error: 'This order is already fully covered — no PayPal payment needed.' });
    const orderId = await ppCreateOrder(Math.round(grand * 100), 'The Vintage Loft studio booking');
    res.json({ ok: true, orderId, amount: grand });
  } catch (e) { res.status(400).json({ error: e.message || 'Could not start PayPal checkout.' }); }
});

// Which rooms are open for a date + time window
app.get('/api/search', (req, res) => {
  const { date } = req.query; const start = +req.query.start, end = +req.query.end;
  if (!date) return res.status(400).json({ error: 'date required' });
  const err = validTimes(start, end); if (err) return res.status(400).json({ error: err });
  const closed = isClosedDay(date);
  const tooSoon = hoursUntil(date, start) < LEAD_HOURS;   // inside the 12-hr online-booking cutoff
  const rooms = VL.ROOMS.map(r => {
    const free = !closed && !tooSoon && isFree(r.id, date, start, end) && VL.validDuration(r.id, end - start);
    const setupAvailable = free && isFree(r.id, date, start, end, true);   // is the 15-min-before also free for early-arrival setup?
    const q = VL.priceQuote(r.id, date, end - start, {});
    return { id: r.id, name: r.name, cap: r.cap, tags: r.tags, color: r.color,
      rate: q.rate, xmas: q.xmas, total: q.roomTotal, available: free, setupAvailable };
  });
  res.json({ date, start, end, closed, tooSoon, leadHours: LEAD_HOURS, closedReason: closed ? 'The studio is closed on Mondays.' : null, rooms });
});

// Busy intervals for a room across a date range (for the week calendar)
app.get('/api/busy', (req, res) => {
  const { room, from, to } = req.query;
  if (!VL.roomById(room)) return res.status(400).json({ error: 'unknown room' });
  const rooms = VL.roomConflicts(room);   // include member/wing rooms so the calendar greys out shared time
  const ph = rooms.map(() => '?').join(',');
  const b = db.prepare(`SELECT date,start,end FROM bookings WHERE room_id IN (${ph}) AND date BETWEEN ? AND ? AND status!='cancelled'`).all(...rooms, from, to);
  const k = db.prepare(`SELECT date,start,end FROM blocks WHERE room_id IN (${ph}) AND date BETWEEN ? AND ?`).all(...rooms, from, to);
  res.json({ room, busy: [...b, ...k] });
});

// Live price quote
app.post('/api/quote', (req, res) => {
  try {
    const { room, start, end, addons } = req.body;
    res.json(VL.priceQuote(room, req.body.date, end - start, addons || {}, req.body.addonOptions || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Itemized receipt for a confirmation number. Public but requires the client's email to match,
// so receipts can't be enumerated. Powers the downloadable/printable /receipt.html page.
app.get('/api/receipt', (req, res) => {
  const c = String(req.query.c || '').trim();
  const e = String(req.query.e || '').trim().toLowerCase();
  if (!c) return res.status(400).json({ error: 'Missing confirmation number.' });
  const rows = db.prepare(`SELECT * FROM bookings WHERE confirmation=? AND status!='cancelled'`).all(c);
  if (!rows.length) {
    // Manually-added (staff) booking? Those live in the blocks table with a computed price.
    const o = manualOrder(c);
    if (!o) return res.status(404).json({ error: 'That receipt could not be found.' });
    if (o.email && e && o.email.toLowerCase() !== e) return res.status(403).json({ error: 'This receipt is not available with that link.' });
    const mitems = o.bookings.map(bk => {
      const addons = (bk.addonItems || []).map(a => ({ name: a.name, option: a.option, qty: a.qty, amount: a.amount }));
      const addonTotal = addons.reduce((s, a) => s + a.amount, 0);
      return { roomName: bk.roomName, date: bk.date, start: bk.start, end: bk.end, hours: bk.hours, roomCharge: VL.round2(bk.pre - addonTotal), addons, pre: bk.pre, hst: bk.hst, total: bk.total, paid: bk.total, discount: 0 };
    });
    const mt = mitems.reduce((a, i) => ({ hst: a.hst + i.hst, total: a.total + i.total }), { hst: 0, total: 0 });
    return res.json({
      confirmation: c, name: o.name, email: o.email, paidAt: o.paidAt, paymentMode: 'link',
      business: { name: 'The Vintage Loft Studios Inc.', address: '207 Dundas St West, Whitby, ON', phone: '905-767-2099', hstNumber: process.env.HST_NUMBER || '74413-4404 RT0001' },
      items: mitems,
      totals: { pre: VL.round2(o.subtotalPre != null ? o.subtotalPre : mt.total), hst: VL.round2(mt.hst), total: VL.round2(o.grandTotal), paid: (o.paid != null ? o.paid : VL.round2(o.grandTotal)), discount: VL.round2(o.discountTotal || 0) }
    });
  }
  if (rows[0].customer_email && e && rows[0].customer_email.toLowerCase() !== e) return res.status(403).json({ error: 'This receipt is not available with that link.' });
  const items = rows.map(r => {
    const addons = []; let addonTotal = 0;
    try {
      const aj = JSON.parse(r.addons_json || '{}'); const it = aj.items || {}, opts = aj.options || {};
      for (const id in it) {
        if (it[id] > 0) {
          const a = (VL.ADDONS || []).find(x => x.id === id); if (!a) continue;
          const qty = a.boolean ? 1 : it[id];
          const unit = VL.addonUnitPrice(a, opts[id], r.room_id);
          const amt = VL.round2(unit * qty); addonTotal += amt;
          addons.push({ name: a.name, option: opts[id] || null, qty, amount: amt });
        }
      }
    } catch (_) {}
    return { roomName: (VL.roomById(r.room_id) || {}).name || r.room_id, date: r.date, start: r.start, end: r.end, hours: r.hours,
      roomCharge: VL.round2((r.pre || 0) - addonTotal), addons, pre: r.pre, hst: r.hst, total: r.total, paid: r.paid, discount: r.discount || 0 };
  });
  const t = items.reduce((a, i) => ({ pre: a.pre + (i.pre || 0), hst: a.hst + (i.hst || 0), total: a.total + (i.total || 0), paid: a.paid + (i.paid || 0), discount: a.discount + (i.discount || 0) }), { pre: 0, hst: 0, total: 0, paid: 0, discount: 0 });
  res.json({
    confirmation: c, name: rows[0].customer_name, email: rows[0].customer_email,
    paidAt: rows[0].created_at, paymentMode: rows[0].payment_mode,
    business: { name: 'The Vintage Loft Studios Inc.', address: '207 Dundas St West, Whitby, ON', phone: '905-767-2099', hstNumber: process.env.HST_NUMBER || '74413-4404 RT0001' },
    items,
    totals: { pre: VL.round2(t.pre), hst: VL.round2(t.hst), total: VL.round2(t.total), paid: VL.round2(t.paid), discount: VL.round2(t.discount) }
  });
});

// Create a reservation of ONE OR MORE studios/rooms. Reserve the slots atomically,
// charge once (real Square or stand-in), then confirm — or release the slots if the charge fails.
// Inspiration photos: clients upload a few images to help us prep. Stored as a JSON array of
// (already client-compressed) data URLs on each booking/block row. Kept lean and capped for safety.
function sanitizeInspo(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch (_) { arr = null; } }
  if (!Array.isArray(arr)) return null;
  const out = []; let total = 0;
  for (const s of arr) {
    if (typeof s !== 'string') continue;
    if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(s)) continue;
    if (s.length > 2500000) continue;          // ~1.8 MB per image ceiling
    total += s.length; if (total > 12000000) break;   // ~9 MB total ceiling
    out.push(s); if (out.length >= 8) break;   // up to 8 images
  }
  return out.length ? JSON.stringify(out) : null;
}
function inspoCountOf(s) { if (!s) return 0; try { const a = JSON.parse(s); return Array.isArray(a) ? a.length : 0; } catch (_) { return 0; } }

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
    if (hoursUntil(it.date, s) < LEAD_HOURS) return res.status(400).json({ error: 'Bookings within ' + LEAD_HOURS + ' hours need to be arranged with us directly — please call or text 905-767-2099.' });
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
      const setup = !!(it.addons && it.addons.earlysetup);
      if (!isFree(it.room, it.date, s, e)) { db.exec('ROLLBACK'); return res.status(409).json({ error: room.name + ' was just taken for that time. Please adjust.' }); }
      if (setup && !isFree(it.room, it.date, s, e, true)) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'The 15 minutes before your ' + room.name + ' booking is not free for early setup. Please remove that add-on or pick a different time.' }); }
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
    const inspoStr = sanitizeInspo(req.body.inspo);
    const ins = db.prepare(`INSERT INTO bookings (room_id,date,start,end,hours,addons_json,pre,hst,total,paid,payment_ref,payment_mode,customer_name,customer_email,intake,inspo,setup,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,'PENDING','pending',?,?,?,?,?, 'pending', ?)`);
    items.forEach((it, i) => {
      const s = +it.start, e = +it.end, q = quotes[i];
      const setup = (it.addons && it.addons.earlysetup) ? 1 : 0;
      const info = ins.run(it.room, it.date, s, e, e - s, JSON.stringify({ items: it.addons || {}, options: it.addonOptions || {} }), q.pre, q.hst, q.total, customerName, customerEmail, intakeStr, inspoStr, setup, nowISO());
      reservedIds.push(info.lastInsertRowid);
      if (setup) addSetupBlock(info.lastInsertRowid, it.room, it.date, s);   // reserve the 15-min early-arrival window
    });
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} return res.status(500).json({ error: e.message }); }

  // 1b) Apply the logged-in client's account credit before charging (reduces the card amount).
  const acctEmail = emailForToken(req.body.token);
  let creditUsed = 0;
  if (acctEmail && req.body.useCredit) {
    const bal = creditBalance(acctEmail);
    creditUsed = VL.round2(Math.max(0, Math.min(bal, grandTotal)));
    grandTotal = VL.round2(grandTotal - creditUsed);
  }

  // 2) Charge once for the whole order — unless it's free (owner code / full credit).
  //    Square cannot process a $0.00 amount, so skip the processor entirely when nothing is owed.
  let pay;
  if (grandTotal <= 0) {
    pay = { ok: true, ref: 'FREE-' + Date.now().toString(36).toUpperCase(), mode: 'free' };
  } else if (req.body.paymentMethod === 'paypal') {
    pay = PP.enabled ? await ppCaptureOrder(req.body.paypalOrderId) : { ok: false, error: 'PayPal is not connected.' };
    if (pay.ok) pay.mode = 'paypal';
  } else if (req.body.saveCard && paymentToken) {
    // Client ticked "save my card": store it on file first, then charge the stored card so it's kept for next time.
    const saved = await sqSaveCard({ email: customerEmail, name: customerName, sourceId: paymentToken, verificationToken: req.body.verificationToken });
    if (saved.ok) {
      // Log the timestamped consent (exact wording the client agreed to) + an audit entry, then charge the stored card.
      recordConsent(customerEmail, req.body.consentText || 'Client authorized saving and future charging of their card.', 'checkout', clientIp(req));
      audit('client:' + (customerEmail || '').toLowerCase(), 'card_saved', customerEmail, (saved.card.brand || 'card') + ' ...' + (saved.card.last4 || ''));
      pay = await payments.charge({ amountCents: Math.round(grandTotal * 100), sourceId: saved.card.id, customerId: saved.customerId });
    }
    else pay = await payments.charge({ amountCents: Math.round(grandTotal * 100), sourceId: paymentToken });   // saving failed: still take payment so the booking isn't lost
  } else {
    pay = await payments.charge({ amountCents: Math.round(grandTotal * 100), sourceId: paymentToken });
  }

  // 3) Confirm the reservations, or release them if the charge failed
  if (!pay.ok) {
    const del = db.prepare(`DELETE FROM bookings WHERE id=? AND status='pending'`);
    reservedIds.forEach(id => { removeSetupBlocks(id); del.run(id); });
    return res.status(402).json({ error: pay.error || 'Payment failed' });
  }
  // One confirmation number for the whole order: VL_YYMMDD-N, one past the highest suffix used today
  // (max-based, not a count, so it can't collide onto an existing confirmation).
  const prefix = 'VL_' + torontoDateCode() + '-';
  let cmax = 0;
  try { db.prepare(`SELECT confirmation FROM bookings WHERE confirmation LIKE ?`).all(prefix + '%').forEach(r => { const m = /-(\d+)$/.exec(r.confirmation || ''); if (m && +m[1] > cmax) cmax = +m[1]; }); } catch (_) {}
  let cn = cmax + 1; const cex = db.prepare(`SELECT 1 FROM bookings WHERE confirmation=? LIMIT 1`);
  while (cex.get(prefix + cn)) cn++;
  const confirmation = prefix + cn;
  const upd = db.prepare(`UPDATE bookings SET status='confirmed', pre=?, hst=?, total=?, paid=?, discount=?, code=?, payment_ref=?, payment_mode=?, confirmation=? WHERE id=?`);
  reservedIds.forEach((id, i) => upd.run(finals[i].pre, finals[i].hst, finals[i].total, finals[i].paid, finals[i].discount, codeInfo ? codeInfo.code : null, pay.ref, pay.mode, confirmation, id));
  // Retire a single-use code (reschedule credits, gift cards) so it can't be used again.
  if (codeInfo && !codeInfo.reusable) {
    try { db.prepare('INSERT OR IGNORE INTO code_redemptions (code, confirmation, used_at) VALUES (?,?,?)').run(codeInfo.code, confirmation, nowISO()); } catch (_) {}
  }
  // Debit the client's wallet for any credit they applied (only now that the booking is confirmed).
  if (creditUsed > 0 && acctEmail) addCredit(acctEmail, -creditUsed, 'Applied to booking ' + confirmation, reservedIds[0]);
  const discountTotal = VL.round2(finals.reduce((s, f) => s + f.discount, 0));
  const created = reservedIds.map((id, i) => ({ id, room: items[i].room, roomName: quotes[i].roomName, date: items[i].date, start: +items[i].start, end: +items[i].end, total: finals[i].total, paid: finals[i].paid }));
  // Send the confirmation email in the background — never block or fail the booking on an email problem.
  sendConfirmationEmail({ email: customerEmail, name: customerName, confirmation, bookings: created, grandTotal, discountTotal }).catch(e => console.error('[email] confirmation error:', e.message));
  // Text the owner/manager so a booking is never missed — background, never blocks the booking.
  notifyNewBooking({ name: customerName, confirmation, bookings: created, grandTotal }).catch(e => console.error('[sms] alert error:', e.message));
  res.json({ ok: true, confirmation, bookings: created, grandTotal, discountTotal, creditUsed, code: codeInfo ? codeInfo.code : null, paymentMode: pay.mode, paymentRef: pay.ref });
});

// Customer's own bookings (simple email lookup; real accounts in Phase 2)
app.get('/api/my-bookings', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const rows = db.prepare(`SELECT id,room_id,date,start,end,total,paid,status,confirmation,created_at FROM bookings WHERE lower(customer_email)=? ORDER BY date DESC, start DESC`).all(email);
  res.json({ bookings: rows.map(r => ({ ...r, roomName: (VL.roomById(r.room_id) || {}).name || r.room_id })) });
});

/* ---------- staff access. Two codes: a general staff code, and an owner code.
   Set OWNER_KEY to a DIFFERENT value than ADMIN_KEY to restrict card-charging (and the audit log)
   to the owner only. If OWNER_KEY is unset it equals ADMIN_KEY (single-user mode, nothing changes). ---------- */
const ADMIN_KEY = process.env.ADMIN_KEY || 'loft-admin';
const OWNER_KEY = process.env.OWNER_KEY || ADMIN_KEY;
function keyOf(req) { return (req.query.key || req.body.key || ''); }
function admin(req, res, next) { const k = keyOf(req); if (k === ADMIN_KEY || k === OWNER_KEY) return next(); res.status(401).json({ error: 'unauthorized' }); }
function owner(req, res, next) { const k = keyOf(req); if (k === OWNER_KEY) return next(); res.status(403).json({ error: 'Only the owner can charge saved cards.' }); }
// Lets the Staff App know whether the signed-in code is the owner (so it shows the charge button only to you).
app.get('/api/admin/whoami', admin, (req, res) => res.json({ role: keyOf(req) === OWNER_KEY ? 'owner' : 'staff', ownerSeparate: OWNER_KEY !== ADMIN_KEY }));

app.get('/api/admin/bookings', admin, (_req, res) => {
  const rows = db.prepare(`SELECT * FROM bookings ORDER BY date DESC, start DESC`).all();
  res.json({ bookings: rows.map(r => { const { inspo, ...rest } = r; return { ...rest, roomName: (VL.roomById(r.room_id) || {}).name || r.room_id, inspoCount: inspoCountOf(inspo) }; }) });
});
app.get('/api/admin/blocks', admin, (_req, res) => res.json({ blocks: db.prepare(`SELECT * FROM blocks ORDER BY date DESC`).all().map(r => { const { inspo, ...rest } = r; return { ...rest, inspoCount: inspoCountOf(inspo) }; }) }));
// Return the actual inspiration photos for one entry (loaded lazily by the staff app, not in the day list).
app.get('/api/admin/inspo', admin, (req, res) => {
  const table = req.query.source === 'booking' ? 'bookings' : 'blocks';
  const id = +req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const row = db.prepare(`SELECT inspo FROM ${table} WHERE id=?`).get(id);
  let images = [];
  if (row && row.inspo) { try { const a = JSON.parse(row.inspo); if (Array.isArray(a)) images = a; } catch (_) {} }
  res.json({ images });
});
app.post('/api/admin/blocks', admin, (req, res) => {
  const { room, date, reason } = req.body; const start = +req.body.start, end = +req.body.end;
  if (!VL.roomById(room)) return res.status(400).json({ error: 'unknown room' });
  const terr = validTimes(start, end); if (terr) return res.status(400).json({ error: terr });
  const info = db.prepare(`INSERT INTO blocks (room_id,date,start,end,reason,created_at) VALUES (?,?,?,?,?,?)`).run(room, date, start, end, reason || 'Blocked', nowISO());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.post('/api/admin/cancel', admin, (req, res) => {
  const b = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(+req.body.id);
  if (!b) return res.json({ ok: false });
  if (b.status === 'cancelled') return res.json({ ok: true, credited: 0 });
  const r = cancelBookingWithCredit(b);
  if (b.customer_email && req.body.notify !== false) sendEmail({ to: b.customer_email, subject: 'Your booking has been cancelled — The Vintage Loft', html: cancellationEmail({ name: b.customer_name || 'there', confirmation: b.confirmation, bookings: [{ roomName: (VL.roomById(b.room_id) || {}).name || b.room_id, date: b.date, start: b.start, end: b.end }], credited: r.credited, email: b.customer_email }) }).catch(e => console.error('[email] cancellation error:', e.message));
  res.json({ ok: true, credited: r.credited, hoursOut: r.hoursOut, newBalance: r.newBalance, email: b.customer_email });
});
// Staff: adjust a client's credit by hand (goodwill, corrections, manual cancellation credit)
app.post('/api/admin/adjust-credit', admin, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const amount = VL.round2(parseFloat(req.body.amount));
  const reason = (req.body.reason || 'Manual adjustment').toString().slice(0, 120);
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'A valid client email is required.' });
  if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Enter an amount (use a minus sign to remove credit).' });
  addCredit(email, amount, reason, null);
  res.json({ ok: true, balance: creditBalance(email) });
});
app.get('/api/admin/credit', admin, (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ balance: 0, history: [] });
  res.json({ balance: creditBalance(email), history: db.prepare(`SELECT amount, reason, created_at FROM credit_ledger WHERE email=? ORDER BY id DESC`).all(email) });
});

/* ---------- client accounts (email + password) + credit wallet ---------- */
app.post('/api/account/signup', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase(), pw = req.body.password || '', name = (req.body.name || '').trim();
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (String(pw).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare(`SELECT 1 FROM client_accounts WHERE email=?`).get(email)) return res.status(409).json({ error: 'An account with that email already exists — please log in.' });
  const { salt, hash } = hashPassword(pw);
  db.prepare(`INSERT INTO client_accounts (email,name,pass_salt,pass_hash,created_at) VALUES (?,?,?,?,?)`).run(email, name, salt, hash, new Date().toISOString());
  res.json({ ok: true, token: newSession(email), name, email });
});
app.post('/api/account/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase(), pw = req.body.password || '';
  const a = db.prepare(`SELECT * FROM client_accounts WHERE email=?`).get(email);
  if (!a || !verifyPassword(pw, a.pass_salt, a.pass_hash)) return res.status(401).json({ error: 'That email or password is not right.' });
  res.json({ ok: true, token: newSession(email), name: a.name, email });
});
app.get('/api/account', (req, res) => {
  const email = emailForToken(req.query.token);
  if (!email) return res.status(401).json({ error: 'Please log in.' });
  const a = db.prepare(`SELECT name FROM client_accounts WHERE email=?`).get(email);
  const rows = db.prepare(`SELECT * FROM bookings WHERE lower(customer_email)=? ORDER BY date, start`).all(email);
  const today = torontoISO(0); const upcoming = [], past = [];
  rows.forEach(r => {
    const item = { id: r.id, room: r.room_id, roomName: (VL.roomById(r.room_id) || {}).name || r.room_id, date: r.date, start: r.start, end: r.end, paid: r.paid, status: r.status, confirmation: r.confirmation, hoursOut: Math.round(hoursUntil(r.date, r.start)), cancelHours: cancelWindowHours(r.date), manual: false };
    if (r.status === 'cancelled') past.push(Object.assign({ cancelled: true }, item));
    else if (r.date >= today) upcoming.push(item);
    else past.push(item);
  });
  // also include bookings staff entered manually for this client (they live in the blocks table), matched by email
  try {
    const myConfs = new Set();
    db.prepare(`SELECT DISTINCT confirmation, client FROM blocks WHERE kind='booking' AND confirmation IS NOT NULL AND confirmation!=''`).all().forEach(r => {
      let cj = {}; try { cj = JSON.parse(r.client || '{}'); } catch (_) {}
      if (cj.email && cj.email.toLowerCase() === email) myConfs.add(r.confirmation);
    });
    myConfs.forEach(conf => {
      const o = manualOrder(conf); if (!o) return;
      o.bookings.forEach((ln, i) => {
        const item = { id: 'm:' + conf + ':' + i, ref: 'm:' + conf, room: ln.room, roomName: ln.roomName, date: ln.date, start: ln.start, end: ln.end, paid: (o.paidAt ? VL.round2(ln.total) : 0), status: 'confirmed', confirmation: conf, hoursOut: Math.round(hoursUntil(ln.date, ln.start)), cancelHours: cancelWindowHours(ln.date), manual: true, isPaid: !!o.paidAt };
        if (ln.date >= today) upcoming.push(item); else past.push(item);
      });
    });
  } catch (e) { console.error('[account] manual bookings merge error:', e.message); }
  const byDate = (a, b) => (a.date + String(a.start).padStart(5, '0')).localeCompare(b.date + String(b.start).padStart(5, '0'));
  upcoming.sort(byDate); past.sort(byDate).reverse();
  const resp = { ok: true, name: a ? a.name : '', email, credit: creditBalance(email), upcoming, past, cancelWindowHours: 48 };
  if (isOwnerEmail(email)) { const u = usageSummaries(); resp.ownerUsage = u.owner; resp.compUsage = u.comp; }
  res.json(resp);
});
app.post('/api/account/cancel', (req, res) => {
  const email = emailForToken(req.body.token);
  if (!email) return res.status(401).json({ error: 'Please log in.' });
  // Manual (staff-entered) booking — identified by its confirmation. Cancels the whole confirmation, frees the slots, credits per the 48h rule.
  if (req.body.confirmation) {
    const conf = String(req.body.confirmation);
    const blocks = db.prepare(`SELECT * FROM blocks WHERE confirmation=? AND kind='booking'`).all(conf);
    if (!blocks.length) return res.status(404).json({ error: 'Booking not found on your account.' });
    let cj = {}; try { cj = JSON.parse(blocks[0].client || '{}'); } catch (_) {}
    if ((cj.email || '').toLowerCase() !== email) return res.status(404).json({ error: 'Booking not found on your account.' });
    const o = manualOrder(conf);
    const earliest = blocks.reduce((m, b) => ((b.date + String(b.start).padStart(5, '0')) < (m.date + String(m.start).padStart(5, '0')) ? b : m), blocks[0]);
    const hrs = hoursUntil(earliest.date, earliest.start);
    let credited = 0;
    if (o && o.paidAt && (o.paid || 0) > 0 && hrs >= cancelWindowHours(earliest.date)) { credited = VL.round2(o.paid); addCredit(email, credited, 'Cancellation credit for ' + conf); }
    const bookingsForEmail = o ? o.bookings : [];
    db.prepare(`DELETE FROM blocks WHERE confirmation=? AND kind='booking'`).run(conf);   // frees the studio slot(s)
    sendEmail({ to: email, subject: 'Your booking has been cancelled — The Vintage Loft', html: cancellationEmail({ name: (o && o.name) || 'there', confirmation: conf, bookings: bookingsForEmail, credited, email }) }).catch(e => console.error('[email] cancellation error:', e.message));
    return res.json({ ok: true, credited, hoursOut: Math.round(hrs), newBalance: creditBalance(email) });
  }
  const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(customer_email)=?`).get(+req.body.bookingId, email);
  if (!b) return res.status(404).json({ error: 'Booking not found on your account.' });
  if (b.status === 'cancelled') return res.status(400).json({ error: 'That booking is already cancelled.' });
  const r = cancelBookingWithCredit(b);
  if (b.customer_email) sendEmail({ to: b.customer_email, subject: 'Your booking has been cancelled — The Vintage Loft', html: cancellationEmail({ name: b.customer_name || 'there', confirmation: b.confirmation, bookings: [{ roomName: (VL.roomById(b.room_id) || {}).name || b.room_id, date: b.date, start: b.start, end: b.end }], credited: r.credited, email: b.customer_email }) }).catch(e => console.error('[email] cancellation error:', e.message));
  res.json({ ok: true, credited: r.credited, hoursOut: r.hoursOut, newBalance: r.newBalance });
});

/* ---------- rental contract: link + lightweight signature (name + agree), tied to the client's email ---------- */
function emailHasBooking(email) {
  email = (email || '').toLowerCase(); if (!email) return false;
  try { if (db.prepare(`SELECT 1 FROM bookings WHERE lower(customer_email)=? LIMIT 1`).get(email)) return true; } catch (_) {}
  try { const rows = db.prepare(`SELECT client FROM blocks WHERE kind='booking' AND client IS NOT NULL`).all(); for (const r of rows) { let c = {}; try { c = JSON.parse(r.client || '{}'); } catch (_) {} if ((c.email || '').toLowerCase() === email) return true; } } catch (_) {}
  return false;
}
app.get('/api/contract-status', (req, res) => {
  const email = (req.query.e || '').toString().trim().toLowerCase();
  const row = email ? db.prepare(`SELECT name, signed_at FROM signatures WHERE email=?`).get(email) : null;
  res.json({ ok: true, signed: !!row, name: row ? row.name : '', signedAt: row ? row.signed_at : null, contractUrl: CONTRACT_URL });
});
app.post('/api/sign-contract', (req, res) => {
  const email = (req.body.e || '').toString().trim().toLowerCase();
  const name = (req.body.name || '').toString().trim().slice(0, 120);
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  if (name.length < 2) return res.status(400).json({ error: 'Please type your full name to sign.' });
  if (!emailHasBooking(email)) return res.status(404).json({ error: 'We couldn’t find a booking for that email.' });
  const at = nowISO();
  db.prepare(`INSERT INTO signatures (email,name,confirmation,signed_at) VALUES (?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET name=excluded.name, confirmation=excluded.confirmation, signed_at=excluded.signed_at`)
    .run(email, name, (req.body.c || '').toString().slice(0, 40), at);
  res.json({ ok: true, signedAt: at, name });
});

/* ---------- client self-service EDIT a booking (change studio/date/time in place, pay any difference) ---------- */
// Availability for the new slot, ignoring the booking being edited itself (so it doesn't block against its own time).
function isFreeForEdit(roomId, date, start, end, exclude) {
  const rooms = VL.roomConflicts(roomId);
  const ph = rooms.map(() => '?').join(',');
  const bk = db.prepare(`SELECT id,start,end FROM bookings WHERE room_id IN (${ph}) AND date=? AND status!='cancelled'`).all(...rooms, date)
    .filter(r => !(exclude.bookingId && r.id === exclude.bookingId));
  const bl = db.prepare(`SELECT id,confirmation,start,end FROM blocks WHERE room_id IN (${ph}) AND date=?`).all(...rooms, date)
    .filter(r => !(exclude.confirmation && r.confirmation === exclude.confirmation) && !(exclude.blockId && r.id === exclude.blockId));
  return ![...bk, ...bl].some(iv => VL.overlaps(start, end, iv.start - BUFFER, iv.end + BUFFER));
}
// The price of a (possibly re-studio'd) booking, re-applying any code that was on the original.
function editNewTotal(room, date, dur, addons, codeStr) {
  let q = VL.priceQuote(room, date, dur, (addons && addons.items) || {}, (addons && addons.options) || {});
  const c = codeStr ? lookupCode(codeStr) : null;
  if (c && c.type === 'percent') q = VL.applyDiscountToQuote(q, c);
  return VL.round2(q.total);
}
// Load a client's own booking by ref: numeric id = online booking; "m:CONF" = manual (staff-entered) booking.
function loadClientBooking(email, ref) {
  ref = String(ref || '');
  if (ref.indexOf('m:') === 0) {
    const conf = ref.slice(2);
    const blocks = db.prepare(`SELECT * FROM blocks WHERE confirmation=? AND kind='booking'`).all(conf);
    if (!blocks.length) return null;
    let cj = {}; try { cj = JSON.parse(blocks[0].client || '{}'); } catch (_) {}
    if ((cj.email || '').toLowerCase() !== email) return null;
    if (blocks.length > 1) return { multi: true };
    const b = blocks[0]; let aj = { items: {}, options: {} }; try { aj = JSON.parse(b.addons_json || '{}'); } catch (_) {}
    const o = manualOrder(conf);
    return { kind: 'manual', blockId: b.id, confirmation: conf, room: b.room_id, date: b.date, start: b.start, end: b.end, addons: aj, code: b.code || '', paid: (o && o.paidAt ? (o.paid || 0) : 0) };
  }
  const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(customer_email)=?`).get(+ref, email);
  if (!b || b.status === 'cancelled') return null;
  let aj = { items: {}, options: {} }; try { aj = JSON.parse(b.addons_json || '{}'); } catch (_) {}
  return { kind: 'online', id: b.id, confirmation: b.confirmation, room: b.room_id, date: b.date, start: b.start, end: b.end, addons: aj, code: b.code || '', paid: (b.paid || 0) };
}
// Validate a proposed change and price the difference. Returns {error} or {ok,newTotal,paid,difference}.
function evalEdit(cur, room, date, start, end) {
  if (!VL.roomById(room)) return { error: 'Please choose a studio.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Please choose a date.' };
  const vt = validTimes(start, end); if (vt) return { error: vt };
  if (!VL.validDuration(room, end - start)) return { error: 'That length isn’t available for that studio.' };
  if (isClosedDay(date)) return { error: 'We’re closed on Mondays — please choose another day.' };
  if (hoursUntil(date, start) < LEAD_HOURS) return { error: 'Please pick a time at least ' + LEAD_HOURS + ' hours from now, or call us at 905-767-2099.' };
  if (hoursUntil(cur.date, cur.start) < cancelWindowHours(cur.date)) return { error: 'Changes need to be at least ' + cancelWindowLabel(cur.date) + ' before your current start time' + (isXmasWeekend(cur.date) ? ' (holiday-weekend dates have a 7-day policy)' : '') + '. Please call or text 905-767-2099 and we’ll help.' };
  const exclude = cur.kind === 'manual' ? { confirmation: cur.confirmation } : { bookingId: cur.id };
  if (!isFreeForEdit(room, date, start, end, exclude)) return { error: 'That studio isn’t open for the time you picked. Please try another time or day.' };
  const newTotal = editNewTotal(room, date, end - start, cur.addons, cur.code);
  return { ok: true, newTotal, paid: VL.round2(cur.paid || 0), difference: VL.round2(newTotal - (cur.paid || 0)) };
}
// Live preview: price the change + the difference (no changes made).
app.post('/api/account/edit-quote', (req, res) => {
  const email = emailForToken(req.body.token);
  if (!email) return res.status(401).json({ error: 'Please log in.' });
  const cur = loadClientBooking(email, req.body.ref);
  if (!cur) return res.status(404).json({ error: 'Booking not found on your account.' });
  if (cur.multi) return res.status(400).json({ error: 'This booking has more than one studio on it — please call us at 905-767-2099 to change it.' });
  const ev = evalEdit(cur, (req.body.room || cur.room), String(req.body.date || cur.date), +req.body.start, +req.body.end);
  if (ev.error) return res.status(400).json({ error: ev.error, current: { room: cur.room, date: cur.date, start: cur.start, end: cur.end, paid: cur.paid } });
  res.json({ ok: true, newTotal: ev.newTotal, paid: ev.paid, difference: ev.difference, current: { room: cur.room, date: cur.date, start: cur.start, end: cur.end, paid: cur.paid } });
});
// Create a PayPal order for JUST the difference (when the change costs more).
app.post('/api/account/edit-paypal-order', async (req, res) => {
  const email = emailForToken(req.body.token);
  if (!email) return res.status(401).json({ error: 'Please log in.' });
  if (!PP.enabled) return res.status(400).json({ error: 'PayPal is not connected yet.' });
  const cur = loadClientBooking(email, req.body.ref);
  if (!cur || cur.multi) return res.status(400).json({ error: 'Booking not available to edit.' });
  const ev = evalEdit(cur, (req.body.room || cur.room), String(req.body.date || cur.date), +req.body.start, +req.body.end);
  if (ev.error) return res.status(400).json({ error: ev.error });
  if (ev.difference <= 0) return res.status(400).json({ error: 'No extra payment is needed for this change.' });
  try { const orderId = await ppCreateOrder(Math.round(ev.difference * 100), 'The Vintage Loft — booking change'); res.json({ ok: true, orderId, difference: ev.difference }); }
  catch (e) { res.status(400).json({ error: e.message || 'Could not start PayPal.' }); }
});
// Apply the change: charge/capture any difference, move the booking, credit any overage.
app.post('/api/account/edit-apply', async (req, res) => {
  const email = emailForToken(req.body.token);
  if (!email) return res.status(401).json({ error: 'Please log in.' });
  const cur = loadClientBooking(email, req.body.ref);
  if (!cur) return res.status(404).json({ error: 'Booking not found on your account.' });
  if (cur.multi) return res.status(400).json({ error: 'This booking has more than one studio on it — please call us at 905-767-2099 to change it.' });
  const room = (req.body.room || cur.room), date = String(req.body.date || cur.date), start = +req.body.start, end = +req.body.end;
  const ev = evalEdit(cur, room, date, start, end);
  if (ev.error) return res.status(400).json({ error: ev.error });
  // Collect the difference if the change costs more
  if (ev.difference > 0) {
    let pay;
    if (req.body.paymentMethod === 'paypal') pay = PP.enabled ? await ppCaptureOrder(req.body.paypalOrderId) : { ok: false, error: 'PayPal is not connected.' };
    else pay = await payments.charge({ amountCents: Math.round(ev.difference * 100), sourceId: req.body.paymentToken });
    if (!pay || !pay.ok) return res.status(402).json({ error: (pay && pay.error) || 'That payment could not be completed. Your booking was not changed.' });
  }
  // Apply the move
  let credited = 0;
  if (cur.kind === 'online') {
    const q = VL.priceQuote(room, date, end - start, (cur.addons.items) || {}, (cur.addons.options) || {});
    const c = cur.code ? lookupCode(cur.code) : null; const dq = (c && c.type === 'percent') ? VL.applyDiscountToQuote(q, c) : q;
    db.prepare(`UPDATE bookings SET room_id=?, date=?, start=?, end=?, hours=?, pre=?, hst=?, total=?, paid=? WHERE id=?`)
      .run(room, date, start, end, end - start, dq.pre, dq.hst, ev.newTotal, ev.newTotal, cur.id);
    removeSetupBlocks(cur.id);
    if (cur.addons.items && cur.addons.items.earlysetup) addSetupBlock(cur.id, room, date, start);
  } else {
    db.prepare(`UPDATE blocks SET room_id=?, date=?, start=?, end=? WHERE id=?`).run(room, date, start, end, cur.blockId);
    db.prepare(`UPDATE blocks SET paid=?, paid_at=COALESCE(paid_at, ?) WHERE confirmation=? AND kind='booking'`).run(ev.newTotal, nowISO(), cur.confirmation);
  }
  if (ev.difference < 0) { credited = VL.round2(-ev.difference); addCredit(email, credited, 'Credit from shortening booking ' + (cur.confirmation || '')); }
  res.json({ ok: true, newTotal: ev.newTotal, difference: ev.difference, credited, newBalance: creditBalance(email) });
});

// Bulk-import blocks (e.g. existing Acuity bookings). Idempotent: identical blocks are skipped,
// so it's safe to run more than once. Bypasses the booking-time rules since these are real holds.
app.post('/api/admin/import-blocks', admin, async (req, res) => {
  const items = Array.isArray(req.body.blocks) ? req.body.blocks : [];
  // request-level default kind; each block may override with its own b.kind
  const defKind = req.body.kind === 'booking' ? 'booking' : 'hold';
  const client = req.body.client && (req.body.client.phone || req.body.client.email)
    ? JSON.stringify({ phone: (req.body.client.phone || '').toString().slice(0, 40), email: (req.body.client.email || '').toString().slice(0, 120) }) : null;
  const exists = db.prepare(`SELECT id FROM blocks WHERE room_id=? AND date=? AND start=? AND end=?`);
  const manualConf = (defKind === 'booking' || items.some(b => b.kind === 'booking')) ? newManualConfirmation() : null;
  // client intake answers, applied to every booking-kind block in this submission
  const intakeStr = (req.body.intake && typeof req.body.intake === 'object')
    ? JSON.stringify(req.body.intake).slice(0, 4000) : null;
  const inspoStr = sanitizeInspo(req.body.inspo);   // inspiration photos attached to this manual booking
  const notesStr = (req.body.notes || '').toString().slice(0, 4000) || null;   // free-text note (e.g. event details on a Hold)
  // optional coupon / discount code entered at booking time (validated up front)
  const codeStr = (req.body.code || '').toString().trim();
  let codeInfo = null;
  if (codeStr) { codeInfo = lookupCode(codeStr); if (!codeInfo) return res.status(400).json({ error: 'That discount code is not valid.' }); }
  const codeToStore = codeInfo ? codeInfo.code : null;
  const ins = db.prepare(`INSERT INTO blocks (room_id,date,start,end,reason,kind,client,addons_json,intake,inspo,code,confirmation,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const retag = db.prepare(`UPDATE blocks SET kind=? WHERE id=?`);
  let inserted = 0, skipped = 0, bad = 0;
  const madeForEmail = [];
  for (const b of items) {
    const room = (b.room || '').toString(), date = (b.date || '').toString(), s = +b.start, e = +b.end;
    if (!VL.roomById(room) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(e > s)) { bad++; continue; }
    const kind = (b.kind === 'booking' || b.kind === 'hold') ? b.kind : defKind;
    const found = exists.get(room, date, s, e);
    if (found) { retag.run(kind, found.id); skipped++; continue; }   // re-tag existing so labels can be corrected
    const addonsStr = JSON.stringify({ items: (b.addons && typeof b.addons === 'object') ? b.addons : {}, options: (b.addonOptions && typeof b.addonOptions === 'object') ? b.addonOptions : {} });
    ins.run(room, date, s, e, (b.reason || 'Imported').toString().slice(0, 120), kind, client, addonsStr, (kind === 'booking' ? intakeStr : null), (kind === 'booking' ? inspoStr : null), (kind === 'booking' ? codeToStore : null), (kind === 'booking' ? manualConf : null), notesStr, nowISO());
    inserted++;
    madeForEmail.push({ roomName: (VL.roomById(room) || {}).name || room, date, start: s, end: e });
  }

  // Optionally email the client ONE "reserved — please pay" email that already includes the payment link
  // (like Acuity: enter the code, save, and the client gets the info + a Pay-now button in the same email).
  const email = req.body.client && req.body.client.email;
  let payLinkIncluded = false, emailSent = false;
  if (req.body.sendConfirmation && email && defKind === 'booking' && manualConf) {
    try {
      let o = manualOrder(manualConf);
      // generate the payment link now, for the discounted grand total, so it rides along in the same email
      if (o && o.grandTotal > 0) {
        try {
          const link = await payments.createLink({ amountCents: Math.round(o.grandTotal * 100), name: 'The Vintage Loft — studio booking' });
          if (link.ok && link.url) { db.prepare(`UPDATE blocks SET pay_link=? WHERE confirmation=? AND kind='booking'`).run(link.url, manualConf); payLinkIncluded = true; }
        } catch (e) { console.error('[paylink] auto-create error:', e.message); }
        o = manualOrder(manualConf);   // re-read so payUrl is picked up
      }
      if (o) {
        await sendEmail({ to: email, subject: 'Your studio is reserved — The Vintage Loft', html: reservedEmail({ name: o.name || 'there', confirmation: manualConf, bookings: o.bookings, amountDue: o.grandTotal, discountTotal: o.discountTotal, payUrl: o.payUrl }) });
        emailSent = true;
      }
    } catch (e) { console.error('[email] reserved+link error:', e.message); }
  }

  res.json({ ok: true, total: items.length, inserted, skipped, bad, emailSent, payLinkIncluded });
});

// Known clients (for autocomplete): the imported directory + names from bookings/manual entries
app.get('/api/admin/clients', admin, (_req, res) => {
  const map = {};
  const add = (name, phone, email) => {
    name = (name || '').toString().trim();
    if (!name || name.toLowerCase() === 'private hold' || name.toLowerCase() === 'imported') return;
    const key = name.toLowerCase();
    if (!map[key]) map[key] = { name, phone: '', email: '' };
    if (phone && !map[key].phone) map[key].phone = phone;
    if (email && !map[key].email) map[key].email = email;
  };
  try { db.prepare(`SELECT name, phone, email FROM clients`).all().forEach(r => add(r.name, r.phone, r.email)); } catch (_) {}
  try { db.prepare(`SELECT DISTINCT customer_name, customer_email FROM bookings WHERE status!='cancelled'`).all().forEach(r => add(r.customer_name, '', r.customer_email)); } catch (_) {}
  try { db.prepare(`SELECT reason, client FROM blocks`).all().forEach(r => { let c = {}; try { c = JSON.parse(r.client || '{}'); } catch (_) {} add(r.reason, c.phone, c.email); }); } catch (_) {}
  const clients = Object.keys(map).map(k => map[k]).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ clients });
});

// One-time import of the Acuity client list: fills the directory (autocomplete) AND backfills
// contact onto any booking whose name matches, plus explicit fills for oddly-labeled bookings.
app.post('/api/admin/import-clients', admin, (req, res) => {
  const clients = Array.isArray(req.body.clients) ? req.body.clients : [];
  const fills = Array.isArray(req.body.fills) ? req.body.fills : [];   // {reason, phone, email}
  const up = db.prepare(`INSERT INTO clients (name_key,name,phone,email) VALUES (?,?,?,?)
    ON CONFLICT(name_key) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email`);
  const setByName = db.prepare(`UPDATE blocks SET client=? WHERE lower(reason)=? AND (client IS NULL OR client='')`);
  const setByReason = db.prepare(`UPDATE blocks SET client=? WHERE lower(reason)=?`);
  let saved = 0, filled = 0;
  for (const c of clients) {
    const name = (c.name || '').toString().trim(); if (!name) continue;
    const phone = (c.phone || '').toString().slice(0, 40), email = (c.email || '').toString().slice(0, 160);
    up.run(name.toLowerCase(), name.slice(0, 120), phone, email); saved++;
    if (phone || email) filled += setByName.run(JSON.stringify({ phone, email }), name.toLowerCase()).changes;
  }
  for (const f of fills) {
    const reason = (f.reason || '').toString().trim(); if (!reason) continue;
    filled += setByReason.run(JSON.stringify({ phone: (f.phone || '').toString().slice(0, 40), email: (f.email || '').toString().slice(0, 160) }), reason.toLowerCase()).changes;
  }
  res.json({ ok: true, clientsSaved: saved, bookingsFilled: filled });
});

// Remove a single block/hold by id (used by the self-serve hold tool)
app.post('/api/admin/delete-block', admin, (req, res) => {
  const id = +req.body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const info = db.prepare(`DELETE FROM blocks WHERE id=?`).run(id);
  res.json({ ok: true, deleted: info.changes });
});

// Staff cancel of a MANUAL booking: frees the studio and, if `credit` is true and the client paid,
// puts the full amount back into their account credit. Staff choose with/without credit (policy override).
// Emails the client a cancellation note (credit vs no-credit wording). Cancels the whole confirmation.
app.post('/api/admin/cancel-manual', admin, (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.body.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  const withCredit = !!req.body.credit;
  const conf = b.confirmation;
  const o = conf ? manualOrder(conf) : null;
  let credited = 0, email = '', name = '', bookingsForEmail = [];
  if (o) { email = o.email || ''; name = o.name || 'there'; bookingsForEmail = o.bookings || []; if (withCredit && o.paidAt && (o.paid || 0) > 0 && email) { credited = VL.round2(o.paid); addCredit(email, credited, 'Cancellation credit for ' + conf); } }
  if (conf) db.prepare(`DELETE FROM blocks WHERE confirmation=? AND kind='booking'`).run(conf);
  else db.prepare(`DELETE FROM blocks WHERE id=?`).run(b.id);
  let emailed = false;
  if (email && req.body.notify !== false) {
    sendEmail({ to: email, subject: 'Your booking has been cancelled — The Vintage Loft', html: cancellationEmail({ name, confirmation: conf, bookings: bookingsForEmail, credited, email }) })
      .then(r => {}).catch(e => console.error('[email] cancellation error:', e.message));
    emailed = true;
  }
  res.json({ ok: true, credited, email, emailed });
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

// The whole manual booking (all studios sharing one confirmation): grand total + the raw line items,
// so the Staff App can prefill a single payment link / mark-paid amount that covers every studio.
app.get('/api/admin/order', admin, (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.query.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  const conf = b.confirmation || ensureBlockConfirmation(b.id);
  const blocks = db.prepare(`SELECT * FROM blocks WHERE confirmation=? AND kind='booking' ORDER BY id`).all(conf);
  const items = blocks.map(bl => {
    let a = { items: {}, options: {} }; try { a = JSON.parse(bl.addons_json || '{}'); } catch (_) {}
    return { room: bl.room_id, date: bl.date, start: bl.start, end: bl.end, addons: a.items || {}, addonOptions: a.options || {} };
  });
  const o = manualOrder(conf);   // code-aware grand total (reflects any coupon saved on the booking)
  res.json({ ok: true, confirmation: conf, count: blocks.length, grandTotal: o ? o.grandTotal : 0, code: o ? o.code : null, items });
});

// Manual booking: (re)send the "reserved — please pay" email. Regenerates a FRESH payment link for the
// booking's current total first, so after an edit (e.g. the client added an hour) the emailed link is correct.
app.post('/api/admin/send-reserved', admin, async (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.body.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  if (!b.confirmation) b.confirmation = ensureBlockConfirmation(b.id);
  let o = manualOrder(b.confirmation);
  if (!o || !o.email) return res.status(400).json({ error: 'No client email is saved on this booking.' });
  let payLinkIncluded = false;
  if (o.grandTotal > 0) {
    try {
      const link = await payments.createLink({ amountCents: Math.round(o.grandTotal * 100), name: 'The Vintage Loft — studio booking' });
      if (link.ok && link.url) { db.prepare(`UPDATE blocks SET pay_link=? WHERE confirmation=? AND kind='booking'`).run(link.url, o.confirmation); payLinkIncluded = true; }
    } catch (e) { console.error('[paylink] resend re-create error:', e.message); }
    o = manualOrder(b.confirmation);   // re-read for the fresh payUrl
  }
  const r = await sendEmail({ to: o.email, subject: 'Your studio is reserved — The Vintage Loft', html: reservedEmail({ name: o.name || 'there', confirmation: o.confirmation, bookings: o.bookings, amountDue: o.grandTotal, discountTotal: o.discountTotal, payUrl: o.payUrl }) });
  res.json({ ok: r.ok, sentTo: o.email, payLinkIncluded, error: r.ok ? undefined : (r.error || 'Email could not be sent (is email set up on the server?).') });
});

// Client EXTENDED an already-paid booking: email a payment link for ONLY the balance owed (new total minus what they already paid).
app.post('/api/admin/balance-link', admin, async (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.body.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  if (!b.confirmation) b.confirmation = ensureBlockConfirmation(b.id);
  let o = manualOrder(b.confirmation);
  if (!o || o.paidAt == null) return res.status(400).json({ error: 'This booking is not marked paid yet — just use “Email reservation + payment link” for the full amount.' });
  const alreadyPaid = VL.round2(o.paid || 0);
  const balance = VL.round2(o.grandTotal - alreadyPaid);
  if (balance <= 0) return res.status(400).json({ error: 'There is no extra balance owing on this booking.' });
  if (!o.email) return res.status(400).json({ error: 'No client email is saved on this booking.' });
  let payUrl = null;
  try {
    const link = await payments.createLink({ amountCents: Math.round(balance * 100), name: 'The Vintage Loft — balance for added time' });
    if (link.ok && link.url) { payUrl = link.url; db.prepare(`UPDATE blocks SET pay_link=? WHERE confirmation=? AND kind='booking'`).run(payUrl, o.confirmation); }
  } catch (e) { console.error('[paylink] balance-link error:', e.message); }
  const r = await sendEmail({ to: o.email, subject: 'Your updated booking — balance due — The Vintage Loft', html: balanceEmail({ name: o.name || 'there', confirmation: o.confirmation, bookings: o.bookings, alreadyPaid, balanceDue: balance, payUrl }) });
  res.json({ ok: r.ok, sentTo: o.email, balance, payLinkIncluded: !!payUrl, error: r.ok ? undefined : (r.error || 'Email could not be sent (is email set up on the server?).') });
});

// Client SHORTENED an already-paid booking: put the overpaid difference into their account credit, and set the booking paid to the new (lower) total.
app.post('/api/admin/credit-difference', admin, (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.body.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  if (!b.confirmation) b.confirmation = ensureBlockConfirmation(b.id);
  const o = manualOrder(b.confirmation);
  if (!o || o.paidAt == null) return res.status(400).json({ error: 'This booking is not marked paid yet, so there is nothing to credit.' });
  const alreadyPaid = VL.round2(o.paid || 0);
  const diff = VL.round2(alreadyPaid - o.grandTotal);
  if (diff <= 0) return res.status(400).json({ error: 'The booking total is not lower than what they paid, so there is no difference to credit.' });
  if (!o.email) return res.status(400).json({ error: 'No client email is saved on this booking, so credit can’t be applied. Add their email first.' });
  addCredit(o.email, diff, 'Credit for shortened booking ' + o.confirmation);
  db.prepare(`UPDATE blocks SET paid=? WHERE confirmation=? AND kind='booking'`).run(o.grandTotal, o.confirmation);
  res.json({ ok: true, credited: diff, newPaid: o.grandTotal, balance: creditBalance(o.email), email: o.email });
});

// Manual booking: mark paid (or un-pay) — records the amount + time on every room in the order.
app.post('/api/admin/mark-paid', admin, (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.body.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  if (!b.confirmation) b.confirmation = ensureBlockConfirmation(b.id);
  if (req.body.unpay) {
    db.prepare(`UPDATE blocks SET paid=NULL, paid_at=NULL, pay_mode=NULL WHERE confirmation=? AND kind='booking'`).run(b.confirmation);
    return res.json({ ok: true, paid: null, mode: null });
  }
  // Owner's own studio use (Vintage Films): settle at $0 so staff don't see "unpaid", tag it as owner use, no studio income recorded.
  if (req.body.owner) {
    db.prepare(`UPDATE blocks SET paid=0, paid_at=?, pay_mode='owner' WHERE confirmation=? AND kind='booking'`).run(nowISO(), b.confirmation);
    return res.json({ ok: true, paid: 0, mode: 'owner' });
  }
  // Comp "on the house" (marketing / goodwill): settle at $0, tag as comp, tracked in the Comps year-end total.
  if (req.body.comp) {
    db.prepare(`UPDATE blocks SET paid=0, paid_at=?, pay_mode='comp' WHERE confirmation=? AND kind='booking'`).run(nowISO(), b.confirmation);
    return res.json({ ok: true, paid: 0, mode: 'comp' });
  }
  // If a discount code was applied in the mark-paid box, SAVE it on the booking so its computed
  // total reflects the discount. Without this the day view keeps showing the discount as a
  // phantom "balance still owing" (paid the discounted price, but total still read as full price).
  const codeStr = (req.body.code || '').toString().trim();
  if (codeStr) { const ci = lookupCode(codeStr); if (ci) db.prepare(`UPDATE blocks SET code=? WHERE confirmation=? AND kind='booking'`).run(ci.code, b.confirmation); }
  const o = manualOrder(b.confirmation);   // re-read AFTER saving the code so grandTotal is the discounted total
  const amt = (req.body.paid != null && req.body.paid !== '') ? VL.round2(parseFloat(req.body.paid)) : (o ? o.grandTotal : 0);
  // how they paid (card / etransfer / cash / debit) and, for e-transfer or cash, the date it landed
  const method = ['card', 'etransfer', 'cash', 'debit'].indexOf(req.body.method) >= 0 ? req.body.method : null;
  let paidAt = nowISO();
  const pon = (req.body.paidOn || '').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(pon)) paidAt = pon + 'T12:00:00.000Z';   // noon UTC so the calendar date reads correctly
  db.prepare(`UPDATE blocks SET paid=?, paid_at=?, pay_mode='paid', pay_method=? WHERE confirmation=? AND kind='booking'`).run(amt, paidAt, method, b.confirmation);
  res.json({ ok: true, paid: amt, mode: 'paid', method: method, paidAt: paidAt });
});

// Staff: list a client's saved cards (for charging on file with their permission).
app.get('/api/admin/saved-cards', owner, async (req, res) => {
  const email = (req.query.email || '').toString().trim().toLowerCase();
  if (!email) return res.json({ cards: [], squareEnabled: SQ.enabled });
  let cards = [];
  try { cards = await sqListCards(email); } catch (_) { cards = db.prepare(`SELECT card_id, brand, last4, exp_month, exp_year FROM saved_cards WHERE email=? ORDER BY id DESC`).all(email); }
  res.json({ cards, squareEnabled: SQ.enabled });
});

// Staff: charge a client's saved card on file (merchant-initiated, with prior permission), then mark the booking paid.
app.post('/api/admin/charge-card', owner, async (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.body.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  if (!b.confirmation) b.confirmation = ensureBlockConfirmation(b.id);
  const card = db.prepare(`SELECT * FROM saved_cards WHERE card_id=?`).get((req.body.cardId || '').toString());
  if (!card) return res.status(400).json({ error: 'That saved card was not found.' });
  const o = manualOrder(b.confirmation);
  if (o && o.paidAt != null) return res.status(409).json({ error: 'This booking is already marked paid — nothing was charged.' });   // idempotency: never double-charge a paid booking
  const amt = (req.body.amount != null && req.body.amount !== '') ? VL.round2(parseFloat(req.body.amount)) : (o ? o.grandTotal : 0);
  if (!(amt > 0)) return res.status(400).json({ error: 'Enter an amount greater than $0.' });
  if (!SQ.enabled) return res.status(400).json({ error: 'Square is not connected yet, so saved cards can’t be charged. Add your Square keys to turn this on.' });
  // Stable idempotency key (confirmation + amount) so a double-click is deduped by Square rather than charging twice.
  const idem = 'vlcharge-' + b.confirmation + '-' + Math.round(amt * 100);
  const pay = await payments.charge({ amountCents: Math.round(amt * 100), sourceId: card.card_id, customerId: card.customer_id, idempotencyKey: idem });
  if (!pay.ok) { audit('staff', 'card_charge_failed', card.email, '$' + amt + ' ' + b.confirmation + ': ' + (pay.error || '')); return res.status(402).json({ error: pay.error || 'The card could not be charged.' }); }
  db.prepare(`UPDATE blocks SET paid=?, paid_at=?, pay_mode='paid', pay_method='card' WHERE confirmation=? AND kind='booking'`).run(amt, nowISO(), b.confirmation);
  audit('staff', 'card_charged', card.email, '$' + amt + ' to ' + (card.brand || 'card') + ' ...' + (card.last4 || '') + ' for ' + b.confirmation + ' (ref ' + pay.ref + ')');
  res.json({ ok: true, paid: amt, ref: pay.ref, last4: card.last4, brand: card.brand });
});

// Staff: view the card audit trail (most recent first).
app.get('/api/admin/audit', owner, (_req, res) => res.json({ log: db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 500`).all() }));

// One-time pre-launch helper: mark every currently-unpaid manual booking as paid at its full computed price.
app.post('/api/admin/mark-all-paid', admin, (req, res) => {
  const rows = db.prepare(`SELECT id, room_id, date, start, end, addons_json FROM blocks WHERE kind='booking' AND paid_at IS NULL`).all();
  let marked = 0;
  for (const b of rows) {
    const conf = ensureBlockConfirmation(b.id);
    let total = 0; try { total = blockQuote(b).total; } catch (_) {}
    db.prepare(`UPDATE blocks SET paid=?, paid_at=? WHERE confirmation=? AND kind='booking'`).run(VL.round2(total), nowISO(), conf);
    marked++;
  }
  res.json({ ok: true, marked });
});

// Manual booking: email the paid receipt (only once marked paid).
app.post('/api/admin/send-receipt', admin, async (req, res) => {
  const b = db.prepare(`SELECT * FROM blocks WHERE id=?`).get(+req.body.id);
  if (!b || b.kind !== 'booking') return res.status(400).json({ error: 'This is not a booking entry.' });
  if (!b.confirmation) b.confirmation = ensureBlockConfirmation(b.id);
  const o = manualOrder(b.confirmation);
  if (!o) return res.status(400).json({ error: 'Booking not found.' });
  if (o.paidAt == null) return res.status(400).json({ error: 'Mark this booking as paid first, then send the receipt.' });
  if (!o.email) return res.status(400).json({ error: 'No client email is saved on this booking.' });
  const r = await sendEmail({ to: o.email, subject: 'Your receipt — The Vintage Loft', html: confirmationEmail({ name: o.name || 'there', confirmation: o.confirmation, bookings: o.bookings, grandTotal: (o.paid != null ? o.paid : o.grandTotal), discountTotal: 0, email: o.email }) });
  res.json({ ok: r.ok, sentTo: o.email, error: r.ok ? undefined : (r.error || 'Email could not be sent.') });
});

// Edit an entry's studio / date / time (when a client calls to change). Re-checks availability,
// ignoring the entry itself so it can shrink/extend or move without colliding with its old slot.
app.post('/api/admin/edit-entry', admin, (req, res) => {
  const id = +req.body.id;
  const source = req.body.source === 'booking' ? 'booking' : 'block';
  const room = (req.body.room || '').toString();
  const date = (req.body.date || '').toString();
  const s = +req.body.start, e = +req.body.end;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!VL.roomById(room)) return res.status(400).json({ error: 'Unknown studio.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Please choose a valid date.' });
  if (!(e > s)) return res.status(400).json({ error: 'The end time must be after the start time.' });
  // collision check against everything in that room/date (plus any linked wing/member room) except this same entry
  const rooms = VL.roomConflicts(room);
  const ph = rooms.map(() => '?').join(',');
  const others = [
    ...db.prepare(`SELECT id,start,end FROM bookings WHERE room_id IN (${ph}) AND date=? AND status!='cancelled'`).all(...rooms, date).map(x => ({ t: 'booking', id: x.id, start: x.start, end: x.end, bid: null })),
    ...db.prepare(`SELECT id,start,end,booking_id FROM blocks WHERE room_id IN (${ph}) AND date=?`).all(...rooms, date).map(x => ({ t: 'block', id: x.id, start: x.start, end: x.end, bid: x.booking_id }))
  ];
  const clash = others.some(iv => {
    if (iv.t === source && iv.id === id) return false;                            // ignore the entry itself
    if (source === 'booking' && iv.t === 'block' && iv.bid === id) return false;  // ignore this booking's own setup block
    return VL.overlaps(s, e, iv.start - BUFFER, iv.end + BUFFER);                 // keep the 15-min turnover gap
  });
  if (clash) return res.status(409).json({ error: 'That studio is booked (or within 15 minutes of another booking) at that time. Please pick another slot.' });
  if (source === 'booking') {
    db.prepare(`UPDATE bookings SET room_id=?, date=?, start=?, end=?, hours=? WHERE id=?`).run(room, date, s, e, e - s, id);
    const bk = db.prepare(`SELECT setup FROM bookings WHERE id=?`).get(id);   // move its reserved setup window along with it
    removeSetupBlocks(id);
    if (bk && bk.setup) addSetupBlock(id, room, date, s);
  } else {
    db.prepare(`UPDATE blocks SET room_id=?, date=?, start=?, end=? WHERE id=?`).run(room, date, s, e, id);
  }
  res.json({ ok: true });
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

// (The "reset everything" endpoint was intentionally removed — no way to wipe all
//  data from the app or the API, so a teammate can't erase the calendar by accident.)

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
  // Manual bookings (blocks): same day-before reminder, grouped by confirmation so a multi-studio manual order gets one email.
  let mrows = [];
  try { mrows = db.prepare(`SELECT * FROM blocks WHERE date=? AND kind='booking' AND reminder_sent=0`).all(target); } catch (_) {}
  const mgroups = {};
  for (const r of mrows) { const k = r.confirmation || ('b:' + r.id); (mgroups[k] = mgroups[k] || []).push(r); }
  for (const k of Object.keys(mgroups)) {
    const g = mgroups[k]; let email = '', name = '';
    try { const c = JSON.parse(g[0].client || '{}'); email = c.email || ''; } catch (_) {}
    name = g[0].reason || 'there';
    if (!email) { const mark = db.prepare(`UPDATE blocks SET reminder_sent=1 WHERE id=?`); g.forEach(b => mark.run(b.id)); continue; }  // no email: don't retry forever
    const bookingsForEmail = g.map(b => ({ roomName: (VL.roomById(b.room_id) || {}).name || b.room_id, date: b.date, start: b.start, end: b.end }));
    const r = await sendEmail({ to: email, subject: 'See you tomorrow at The Vintage Loft!', html: reminderEmail({ name, confirmation: g[0].confirmation || '', bookings: bookingsForEmail }) });
    if (r.ok) { const mark = db.prepare(`UPDATE blocks SET reminder_sent=1 WHERE id=?`); g.forEach(b => mark.run(b.id)); sent++; }
    else if (!r.skipped) failed++;
  }
  if (sent) console.log('[email] sent ' + sent + ' reminder(s) for ' + target);
  return { date: target, reservations: Object.keys(groups).length + Object.keys(mgroups).length, sent, failed };
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
