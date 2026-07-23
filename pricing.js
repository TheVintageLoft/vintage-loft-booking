/* Shared pricing + availability logic for The Vintage Loft.
   Works in Node (module.exports) and the browser (window.VL).
   The SERVER is authoritative: it recomputes price and re-checks availability
   on every booking. The browser uses the same code only for instant display. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.VL = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const CONFIG = {
    payInFull: true,          // rentals paid 100% up front (deposits are photography-only, later phase)
    cancelWindowHours: 48,    // free cancel + full credit if >= this many hours out (Phase 2)
    hstRate: 0.13,            // Ontario HST
    minHours: 1,              // 1-hour minimum
    incrementMin: 30,         // 30-minute booking increments
    dreamSingleHour: 75,      // Dream: a 1-hour-only booking costs this (else $50/hr)
    christmasWeekendsOnly: true,
    christmasStart: [10, 7],  // Nov 7  (month index 10)
    christmasEnd: [11, 22],   // Dec 22 (month index 11)
    tiers: [                  // length-of-booking discounts
      { minH: 3, off: 0.10 }, // 3–4 hrs
      { minH: 5, off: 0.15 }, // 5–6 hrs
      { minH: 8, off: 0.25 }  // 8–10 hrs
    ]
  };

  // Room catalog (config). Bookings/blocks live in the database and reference these ids.
  const ROOMS = [
    { id: 'grand',    name: 'Grand Room',   cap: '900 sq ft',      reg: 100, xmas: 150, color: '#857a6d', tags: 'Natural light · high ceilings' },
    { id: 'gatsby',   name: 'The Gatsby',   cap: '600 sq ft',      reg: 80,  xmas: 120, color: '#99855f', tags: 'Bedroom & office suite · calm, textured neutrals' },
    { id: 'carnegie', name: 'The Carnegie', cap: 'Kitchen studio', reg: 80,  xmas: 120, color: '#728175', tags: 'Kitchen · natural light' },
    { id: 'dream',    name: 'Dream Room',   cap: '200 sq ft',      reg: 50,  xmas: 100, color: '#a98f8c', tags: 'Dreamy · cloud-soft couch · olive greens & natural light', special: 'dream' }
  ];

  const ADDONS = [
    { id: 'backdrop',  name: 'Seamless backdrop', unit: 'each', desc: 'Professional seamless paper backdrop',
      options: [ { label: 'Rolled to Floor for Headshots', price: 15 }, { label: 'Taped to Floor for Full Body', price: 35 } ] },
    { id: 'lighting',  name: 'Studio lighting', price: 0,  unit: 'kit',   desc: 'Profoto strobes & softboxes for Canon, Nikon & Sony' },
    { id: 'cakesmash', name: 'Cake Smash Set',  price: 35, unit: 'set',   desc: 'Complete cake smash setup' },
    { id: 'wardrobe',  name: 'Dress rental',    price: 50, unit: 'dress', desc: 'A styled dress from our collection' },
    { id: 'bedsetup',  name: 'Bed set-up',      price: 25, unit: 'set',   desc: 'Queen bed with fresh linens', rooms: ['gatsby'] },
    { id: 'swing',     name: 'Macramé swing',   price: 15, unit: 'each',  desc: 'Hanging macramé swing', rooms: ['grand', 'dream'] }
  ];

  const roomById = id => ROOMS.find(r => r.id === id);

  function tierFor(hours) { let off = 0; for (const t of CONFIG.tiers) if (hours >= t.minH) off = t.off; return { off }; }
  function isWeekend(dateStr) { const g = new Date(dateStr + 'T12:00:00').getDay(); return g === 0 || g === 6; }
  function isChristmas(dateStr) {
    const d = new Date(dateStr + 'T12:00:00'), y = d.getFullYear();
    const start = new Date(y, CONFIG.christmasStart[0], CONFIG.christmasStart[1]);
    const end = new Date(y, CONFIG.christmasEnd[0], CONFIG.christmasEnd[1], 23, 59, 59);
    if (!(d >= start && d <= end)) return false;
    return CONFIG.christmasWeekendsOnly ? isWeekend(dateStr) : true;
  }
  function rateFor(room, dateStr) { return isChristmas(dateStr) ? room.xmas : room.reg; }
  function roomBaseFor(room, dateStr, hours) {
    if (room.special === 'dream' && !isChristmas(dateStr) && hours <= 1) return CONFIG.dreamSingleHour;
    return rateFor(room, dateStr) * hours;
  }
  function roomTotalFor(room, dateStr, hours) { const b = roomBaseFor(room, dateStr, hours); return b - b * tierFor(hours).off; }

  // Which durations a studio allows. Dream skips 1.5 hr (goes 1 hr -> 2 hr).
  function validDuration(roomId, hours) {
    const room = roomById(roomId);
    if (hours < CONFIG.minHours) return false;
    if (Math.round(hours * 2) !== hours * 2) return false;          // 30-minute increments only
    if (room && room.special === 'dream' && hours > 1 && hours < 2) return false; // no 1.5 hr for Dream
    return true;
  }

  // Add-on price for a chosen option (option-priced add-ons like the backdrop).
  function addonUnitPrice(a, optionLabel) {
    if (a.options && a.options.length) { const o = a.options.find(x => x.label === optionLabel) || a.options[0]; return o.price; }
    return a.price || 0;
  }
  // Is this add-on offered for this studio? (room-restricted add-ons, e.g. Bed set-up = Gatsby only)
  function addonAllowed(a, roomId) { return !a.rooms || a.rooms.includes(roomId); }

  // Authoritative price breakdown for a booking.
  function priceQuote(roomId, dateStr, hours, addons, addonOptions) {
    const room = roomById(roomId);
    if (!room) throw new Error('unknown room: ' + roomId);
    const xmas = isChristmas(dateStr);
    const rate = rateFor(room, dateStr);
    const dreamSpecial = room.special === 'dream' && !xmas && hours <= 1;
    const roomBase = roomBaseFor(room, dateStr, hours);
    const tier = tierFor(hours);
    const tierDisc = roomBase * tier.off;
    const roomTotal = roomBase - tierDisc;
    let addonTotal = 0;
    const items = [];
    for (const id in (addons || {})) {
      const a = ADDONS.find(x => x.id === id); const qty = addons[id];
      if (!a || qty <= 0 || !addonAllowed(a, roomId)) continue;   // ignore add-ons not offered for this studio
      const opt = (addonOptions || {})[id];
      const unit = addonUnitPrice(a, opt);
      addonTotal += unit * qty;
      items.push({ id, name: a.name, qty, option: opt || null, unit, amount: unit * qty });
    }
    const pre = roomTotal + addonTotal;
    const hst = round2(pre * CONFIG.hstRate);
    const total = round2(pre + hst);
    return { room: room.id, roomName: room.name, rate, xmas, dreamSpecial, roomBase: round2(roomBase),
      tierOff: tier.off, tierDisc: round2(tierDisc), roomTotal: round2(roomTotal), addonItems: items,
      addonTotal: round2(addonTotal), pre: round2(pre), hst, total };
  }

  function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  return { CONFIG, ROOMS, ADDONS, roomById, tierFor, isWeekend, isChristmas, rateFor,
    roomBaseFor, roomTotalFor, priceQuote, validDuration, overlaps, round2 };
});
