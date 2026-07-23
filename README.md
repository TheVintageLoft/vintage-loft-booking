# The Vintage Loft — Booking System (Phase 1)

A working studio-booking web app for The Vintage Loft: clients find an open studio (or open a studio's live calendar), pick a time, and pay through a Square test-mode checkout. Bookings save to a real database, availability updates live, and double-bookings are prevented server-side. Includes a simple staff page for manual time blocking.

This is Phase 1 (the client booking experience, made real). Later phases add full client accounts + credit wallet, the full staff admin portal, the photography workflow, notifications, and reporting.

## What works today
- **Find a studio**: date + time window search shows which studios are open, with live pricing.
- **Per-studio calendar**: pick a start time, offered only the durations that actually fit.
- **Real pricing**: per-room rates, length-of-booking discounts (10% at 3–4 hr, 15% at 5–6, 25% at 8–10), the Dream single-hour special, Christmas-premium weekends (Nov 7–Dec 22), and HST — all computed on the server so they can't be tampered with.
- **Real bookings**: saved to a SQLite database; a booked time immediately blocks that slot for everyone; double-booking is rejected.
- **Guest checkout**: name + email, then a Square test-mode payment (stand-in until real Square keys are added).
- **My bookings**: look up your reservations by email.
- **Staff page** (`/admin.html`): view bookings, cancel, and block times manually (maintenance, holds, external/Peerspace bookings).

## Run it locally
Requires Node 18+ (Node 22 recommended for built-in SQLite).

```
npm install
npm start        # runs: node --experimental-sqlite server.js
```

Then open http://localhost:3000 (client) and http://localhost:3000/admin.html (staff, key `loft-admin`).

The database is a single file, `data.db`, created automatically.

## Deploy it (going live)
Any Node host works (Render, Railway, Fly.io, a small VPS). Two things to set up:

1. **Start command**: `node --experimental-sqlite server.js` (or move to Node 24+ where the SQLite flag is default). Set `PORT` via the host's env if needed.
2. **Persistent storage for `data.db`**: attach a small persistent disk so bookings survive restarts, OR (recommended for growth) switch the storage layer to managed Postgres — the queries are standard SQL and easy to port.

Set a real staff key with the `ADMIN_KEY` environment variable.

### Square (test then live)
Payments run through `payments.charge()` in `server.js`. Today it's a **stand-in** that accepts the Square test nonce and always succeeds, so the whole flow works with no charges. To wire real Square:

1. Create a Square Developer account and app; get **sandbox** credentials first.
2. Set `SQUARE_ACCESS_TOKEN` (and app/location IDs) as environment variables.
3. Front-end: add the Square Web Payments SDK to tokenize the card into a `sourceId`.
4. Back-end: in `payments.charge()`, call Square's `PaymentsApi.createPayment({ sourceId, amountMoney, idempotencyKey })`.
5. Test with Square's sandbox test cards, then switch the token to production.

No card data ever touches this server — Square's SDK handles it, which is exactly right for PCI compliance.

### Embedding on thevintageloft.ca
- Home page: embed the search (the whole app, or just the search section) via an iframe or a small script include.
- Each studio page: embed that studio's calendar by pointing at the app with the room preselected.
We'll finalize the exact embed snippets when we pick the host.

## Project layout
```
server.js      Express API + SQLite (bookings, blocks, availability, checkout)
pricing.js     Shared pricing + availability rules (server is authoritative)
public/
  index.html   Client booking app (the polished UI)
  admin.html   Staff page (view/cancel bookings, block times)
data.db        SQLite database (created on first run)
```

## Notes
- The heading font (Cormorant Garamond) currently loads from Google Fonts; in production we'll self-host it so it never depends on an external request.
- Rooms are defined in `pricing.js` (config). A future phase moves them into the database with an admin editor.
