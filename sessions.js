/* Photography sessions for The Vintage Loft — catalog, pricing, deposits and resource windows.
   Companion to pricing.js (studio rentals). Works in Node (module.exports) and the browser (window.VLS).

   A session differs from a rental in three ways:
     1) fixed length and fixed price per session type (no hourly rate, no length tiers)
     2) a 50% deposit is taken at booking; the balance is emailed 2 days before
     3) it reserves MORE than a studio: the photographer's own calendar ("Vintage Films" = Kelly)
        and, when hair & makeup is added, The Marilyn for the prep window beforehand.

   The SERVER is authoritative: it recomputes price and re-checks every resource on booking. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.VLS = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const CONFIG = {
    hstRate: 0.13,            // Ontario HST — sessions are quoted +HST like rentals
    depositPct: 0.50,         // 50% of the TAX-INCLUSIVE total, taken at booking
    balanceDaysBefore: 2,     // balance auto-emailed with a pay link this many days ahead
    cancelWindowHours: 48,    // same rule as rentals: full credit if cancelled this far out
    defaultBufferMin: 15,     // before/after a session unless the session says otherwise
    slotStepMin: 15,          // start times offered on the quarter hour
    openHour: 8,              // studio hours — the whole padded window must fit inside these
    closeHour: 20,
    photographer: 'vintagefilms',        // resource id for Kelly's own calendar
    photographerName: 'Vintage Films',
    makeupRoom: 'marilyn',               // resource id for the hair & makeup room
    hmHiddenPadMin: 15        // hidden artist setup/cleanup either side of the H&M window (client never sees it)
  };

  /* ---------- the 27 bookable sessions ----------
     minutes  = client-facing session length (add-ons can stretch it)
     rooms    = studio ids that must be free. 'northwing' covers Grand + Dream together
                (pricing.js ROOM_GROUPS already makes booking the wing block both members).
     bufBefore/bufAfter = minutes of turnover padding around the session.
     bed      = the Gatsby bed is set up for this session (included, not a paid add-on).
     juniorHM = hair & makeup is offered at the junior rate here (Kids Modeling/Acting only,
                confirmed by Mason 2026-07-29). Every other session gets the full $275 rate.
     branding = eligible for the Branding Video add-on. */
  const SESSIONS = [
    { n: 1,  id: 'newborn-snuggle',      name: 'Newborn Snuggle Session',             base: 350,  minutes: 60,  rooms: ['dream'],     bufBefore: 15, bufAfter: 15, blurb: 'Newborn-focused: baby, tiny details, and parents\u2019 hands. Not parent-facing portraits.' },
    { n: 2,  id: 'newborn-lifestyle',    name: 'Newborn Lifestyle Family',            base: 400,  minutes: 90,  rooms: ['dream'],     bufBefore: 15, bufAfter: 15, blurb: 'The snuggle session plus true family portraits, with parents in frame.' },
    { n: 3,  id: 'classic-newborn',      name: 'Classic Newborn Session',             base: 500,  minutes: 120, rooms: ['grand'],     bufBefore: 30, bufAfter: 30, blurb: 'A full posed newborn session in the Grand Room.' },
    { n: 4,  id: 'classic-newborn-fam',  name: 'Classic Newborn + Family',            base: 650,  minutes: 180, rooms: ['grand'],     bufBefore: 30, bufAfter: 30, blurb: 'The classic newborn session extended to include family portraits.' },
    { n: 5,  id: 'first-year',           name: 'First Year Milestones Baby Portraits', base: 250, minutes: 30,  rooms: ['dream'],     bufBefore: 15, bufAfter: 15, blurb: 'A short milestone session for sitters, crawlers and first steps.' },
    { n: 6,  id: 'cake-smash',           name: 'Cake Smash Portraits',                base: 375,  minutes: 45,  rooms: ['dream'],     bufBefore: 30, bufAfter: 15, blurb: 'Portraits plus the cake smash and a warm bath afterwards.' },
    { n: 7,  id: 'branding-individual',  name: 'Individual Branding Session',         base: 900,  minutes: 120, rooms: ['grand'],     bufBefore: 30, bufAfter: 15, branding: true, blurb: 'A full personal-brand shoot with multiple looks and setups.' },
    { n: 8,  id: 'branding-partner',     name: 'Partner Branding Session',            base: 800,  minutes: 90,  rooms: ['northwing'], bufBefore: 30, bufAfter: 15, branding: true, blurb: 'Branding for two partners, across the whole north side of the studio.' },
    { n: 9,  id: 'branding-team',        name: 'Team Branding Session',               base: 1500, minutes: 180, rooms: ['northwing'], bufBefore: 30, bufAfter: 15, branding: true, blurb: 'Team headshots and group branding across the North Wing.' },
    { n: 10, id: 'branding-mini',        name: 'Branding Mini Session',               base: 500,  minutes: 60,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, branding: true, blurb: 'A focused hour of branding portraits.' },
    { n: 11, id: 'headshot',             name: 'Headshot Session',                    base: 275,  minutes: 30,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'Clean professional headshots.' },
    { n: 12, id: 'family-classic',       name: 'Classic Family Portrait Session',     base: 350,  minutes: 60,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'Classic portraits for your immediate family.' },
    { n: 13, id: 'family-extended',      name: 'Extended Family Portrait Session',    base: 650,  minutes: 90,  rooms: ['northwing'], bufBefore: 15, bufAfter: 15, blurb: 'The whole extended family, with groupings and individual-family breakouts.' },
    { n: 14, id: 'grandparent-special',  name: 'Grandparent Special',                 base: 495,  minutes: 60,  rooms: ['northwing'], bufBefore: 15, bufAfter: 15, blurb: 'Extended-family structure where every grouping centres the grandparents. No individual-family breakouts.' },
    { n: 15, id: 'maternity',            name: 'Maternity Portraits',                 base: 450,  minutes: 60,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'Maternity portraits in natural light.' },
    { n: 16, id: 'engagement',           name: 'Engagement In Studio Session',        base: 350,  minutes: 60,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'An in-studio engagement session.' },
    { n: 17, id: 'boudoir-munroe',       name: 'Boudoir: Munroe Mini',                base: 375,  minutes: 45,  rooms: ['gatsby'],    bufBefore: 30, bufAfter: 30, bed: true, blurb: 'A short, private boudoir session in the Gatsby bedroom suite.' },
    { n: 18, id: 'boudoir-crawford',     name: 'Boudoir: Crawford Classic',           base: 575,  minutes: 75,  rooms: ['gatsby'],    bufBefore: 30, bufAfter: 30, bed: true, blurb: 'The classic boudoir session with several looks.' },
    { n: 19, id: 'boudoir-presley',      name: 'Boudoir: Presley Premium',            base: 700,  minutes: 120, rooms: ['gatsby'],    bufBefore: 30, bufAfter: 30, bed: true, blurb: 'The most complete boudoir experience, unhurried and fully styled.' },
    { n: 20, id: 'couples-empowerment',  name: 'Couple\u2019s Empowerment Experience', base: 350, minutes: 90,  rooms: ['gatsby'],    bufBefore: 30, bufAfter: 30, bed: true, blurb: 'An intimate, empowering session for couples.' },
    { n: 21, id: 'kids-personality',     name: 'Kids Personality Portraits',          base: 250,  minutes: 45,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'Portraits that catch who your child actually is right now.' },
    { n: 22, id: 'celebration',          name: 'Celebration Portraits',               base: 295,  minutes: 45,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'Mark a birthday, anniversary or milestone.' },
    { n: 23, id: 'model-portfolio',      name: 'Model Package for Portfolio',         base: 375,  minutes: 90,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'Portfolio-building looks for models.' },
    { n: 24, id: 'kids-modeling',        name: 'Kids Modeling/Acting',                base: 300,  minutes: 60,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, juniorHM: true, blurb: 'Headshots and looks for young performers.' },
    { n: 25, id: 'grad-cap-gown',        name: 'Graduation \u201cCap & Gown\u201d Portraits', base: 175, minutes: 30, rooms: ['grand'], bufBefore: 15, bufAfter: 15, blurb: 'Cap and gown portraits.' },
    { n: 26, id: 'grad-branding',        name: 'Graduation Branding Session',         base: 275,  minutes: 45,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'Graduation portraits with a personal-brand angle.' },
    { n: 27, id: 'kids-grad',            name: 'Kids Grad Portraits',                 base: 100,  minutes: 30,  rooms: ['grand'],     bufBefore: 15, bufAfter: 15, blurb: 'For the littlest graduates.' }
  ];

  /* ---------- add-ons ----------
     stretchMin  : minutes added to the session length
     videoStretch: part of the video group — if several video add-ons are picked only ONE
                   +15 min stretch applies (Kelly shoots the video either way).
     requires    : add-on id that must also be selected (Reel voice option)
     onlyBranding: offered on branding sessions only
     hmLeadMin   : client arrives this many minutes early; The Marilyn is held for that window
     exclusiveWith: can't be combined with these add-on ids
     maxUnits    : quantity add-on (Extra Time); absent = boolean */
  const PHOTO_ADDONS = [
    { id: 'extratime',    name: 'Extra Time',      price: 100, maxUnits: 8, stretchMin: 15, unit: '15 min',
      desc: 'Add more time to your session, in 15-minute blocks (up to 2 extra hours).' },
    { id: 'btsvideo',     name: 'BTS Video',       price: 75,  videoStretch: true,
      desc: 'Behind-the-scenes video of the shoot itself \u2014 the room, the process, the candid moments.' },
    { id: 'reelvideo',    name: 'Reel Video',      price: 200, videoStretch: true,
      desc: 'A polished short film about you: to-camera moments, slow motion, edited into a story.' },
    { id: 'reelvoice',    name: 'Add voice to your Reel', price: 100, requires: 'reelvideo',
      desc: 'Record a voiceover for your Reel. This does not add session time \u2014 add Extra Time if you\u2019d like room for it.' },
    { id: 'brandingvideo', name: 'Branding Video', price: 200, videoStretch: true, onlyBranding: true,
      desc: 'A short branding film to use across your website and social.' },
    { id: 'hairmakeup',   name: 'Hair & Makeup',   price: 275, juniorPrice: 150, hmLeadMin: 90, juniorLeadMin: 60,
      exclusiveWith: ['makeuponly'],
      desc: 'Professional hair and makeup in The Marilyn before your session. You arrive early \u2014 your session time is unchanged.' },
    { id: 'makeuponly',   name: 'Makeup Only',     price: 150, hmLeadMin: 60, exclusiveWith: ['hairmakeup'], hideWhenJunior: true,
      desc: 'Makeup only in The Marilyn before your session. You arrive early \u2014 your session time is unchanged.' },
    { id: 'photopet',     name: 'Pet',             price: 50,
      desc: 'Bring your pet into the session. Covers up to 2 pets per family, includes cleanup and a dedicated staff handler. Pets stay leashed or held except while being photographed.' }
  ];

  /* Session-specific options (not general add-ons) — keyed by session id. */
  const SESSION_OPTIONS = {
    'first-year': [
      { id: 'firstyear-family', name: 'Add family portraits', price: 100, stretchMin: 15,
        desc: 'The session is just the baby. Add family portraits and we extend it by 15 minutes.' }
    ],
    'cake-smash': [
      { id: 'cakesmash-family', name: 'Add family portraits', price: 100, stretchMin: 15,
        desc: 'Family portraits before the cake comes out. Adds 15 minutes to your session.' }
    ]
  };

  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const sessionById = id => SESSIONS.find(s => s.id === id || String(s.n) === String(id));
  const addonById = id => PHOTO_ADDONS.find(a => a.id === id);
  const optionsFor = s => (s && SESSION_OPTIONS[s.id]) || [];

  // Is this add-on offered on this session at all?
  function addonAllowed(a, session) {
    if (!a || !session) return false;
    if (a.onlyBranding && !session.branding) return false;
    // Hidden where junior H&M is the same $150 and includes hair — same price for less is a trap.
    if (a.hideWhenJunior && session.juniorHM) return false;
    return true;
  }
  // What this add-on costs on this session (kids sessions get the junior H&M rate).
  function addonPrice(a, session) {
    if (a.juniorPrice != null && session && session.juniorHM) return a.juniorPrice;
    return a.price || 0;
  }
  // How early the client arrives for hair & makeup on this session, in minutes (0 if not applicable).
  function addonLead(a, session) {
    if (!a.hmLeadMin) return 0;
    if (a.juniorLeadMin != null && session && session.juniorHM) return a.juniorLeadMin;
    return a.hmLeadMin;
  }

  /* Normalise a raw selection from the browser into something trustworthy:
     drops unknown/not-offered add-ons, enforces `requires` and `exclusiveWith`,
     clamps Extra Time to its maximum. Returns { sel, dropped } where sel is {id: units}. */
  function normalizeSelection(session, raw) {
    const sel = {}, dropped = [];
    if (!session) return { sel, dropped };
    const want = raw || {};
    // pass 1: keep only add-ons that exist and are offered here
    for (const id in want) {
      const units = Math.floor(Number(want[id]) || 0);
      if (units <= 0) continue;
      const a = addonById(id) || optionsFor(session).find(o => o.id === id);
      if (!a) { dropped.push(id); continue; }
      if (addonById(id) && !addonAllowed(a, session)) { dropped.push(id); continue; }
      sel[id] = a.maxUnits ? Math.min(units, a.maxUnits) : 1;
    }
    // pass 2: mutual exclusions — the first one listed in the catalog wins, the other goes
    for (const a of PHOTO_ADDONS) {
      if (!sel[a.id] || !a.exclusiveWith) continue;
      for (const other of a.exclusiveWith) if (sel[other]) { delete sel[other]; dropped.push(other); }
    }
    // pass 3: dependencies (voice needs the Reel)
    for (const a of PHOTO_ADDONS) if (sel[a.id] && a.requires && !sel[a.requires]) { delete sel[a.id]; dropped.push(a.id); }
    return { sel, dropped };
  }

  /* Total session length in minutes, including every stretch.
     The video add-ons share ONE +15 min stretch no matter how many are chosen. */
  function minutesFor(session, sel) {
    let mins = session.minutes;
    let videoStretched = false;
    for (const id in sel) {
      const a = addonById(id) || optionsFor(session).find(o => o.id === id);
      if (!a) continue;
      if (a.videoStretch) { if (!videoStretched) { mins += 15; videoStretched = true; } continue; }
      if (a.stretchMin) mins += a.stretchMin * (a.maxUnits ? sel[id] : 1);
    }
    return mins;
  }

  /* Authoritative price breakdown for a session, including the 50% deposit.
     The deposit is half of the TAX-INCLUSIVE total, so the client pays half of what they owe overall. */
  function sessionQuote(sessionId, rawSel) {
    const s = sessionById(sessionId);
    if (!s) throw new Error('unknown session: ' + sessionId);
    const { sel, dropped } = normalizeSelection(s, rawSel);
    const items = [];
    let addonTotal = 0;
    for (const id in sel) {
      const a = addonById(id) || optionsFor(s).find(o => o.id === id);
      const units = sel[id];
      const unit = addonById(id) ? addonPrice(a, s) : (a.price || 0);
      const amount = unit * units;
      addonTotal += amount;
      items.push({ id, name: a.name, units, unit, amount, junior: !!(a.juniorPrice != null && s.juniorHM) });
    }
    const pre = round2(s.base + addonTotal);
    const hst = round2(pre * CONFIG.hstRate);
    const total = round2(pre + hst);
    const deposit = round2(total * CONFIG.depositPct);
    const balance = round2(total - deposit);
    return { session: s.id, n: s.n, sessionName: s.name, base: s.base, addonItems: items,
      addonTotal: round2(addonTotal), pre, hst, total, deposit, balance,
      minutes: minutesFor(s, sel), selection: sel, dropped };
  }

  /* Every resource a session occupies, as decimal-hour windows on one date.

     Rooms + the photographer are held for the PADDED window (session time plus its buffers).
     Storing the padded window is deliberate: the rental availability check in server.js already
     keeps a 15-minute gap from anything on the calendar, so a padded session row automatically
     stops a rental being booked inside a session's 30-minute turnover. It errs 15 minutes on the
     generous side, which is turnover time anyway.

     The Marilyn (hair & makeup) is held for the prep window BEFORE the session, plus a hidden
     15 minutes either side for the artist to set up and clean up. The client never sees that padding. */
  function sessionWindow(sessionId, startHour, rawSel) {
    const s = sessionById(sessionId);
    if (!s) throw new Error('unknown session: ' + sessionId);
    const { sel } = normalizeSelection(s, rawSel);
    const start = Number(startHour);
    const mins = minutesFor(s, sel);
    const end = round2(start + mins / 60);
    const padStart = round2(start - (s.bufBefore == null ? CONFIG.defaultBufferMin : s.bufBefore) / 60);
    const padEnd = round2(end + (s.bufAfter == null ? CONFIG.defaultBufferMin : s.bufAfter) / 60);

    const blocks = [];
    s.rooms.forEach(room => blocks.push({ resource: room, start: padStart, end: padEnd, role: 'studio' }));
    blocks.push({ resource: CONFIG.photographer, start: padStart, end: padEnd, role: 'photographer' });

    // hair & makeup: hold The Marilyn for the prep window + hidden artist padding
    let hm = null;
    for (const a of PHOTO_ADDONS) {
      if (!sel[a.id] || !a.hmLeadMin) continue;
      const lead = addonLead(a, s) / 60;
      const pad = CONFIG.hmHiddenPadMin / 60;
      hm = { addon: a.id, name: a.name, arrival: round2(start - lead), start: round2(start - lead), end: start };
      blocks.push({ resource: CONFIG.makeupRoom, start: round2(start - lead - pad), end: round2(start + pad), role: 'makeup' });
      break;
    }

    // the earliest and latest clock time anything is held — used to check studio hours
    const earliest = blocks.reduce((m, b) => Math.min(m, b.start), padStart);
    const latest = blocks.reduce((m, b) => Math.max(m, b.end), padEnd);
    return { session: s.id, start, end, minutes: mins, padStart, padEnd, blocks, hm, earliest, latest };
  }

  /* Does the whole padded footprint fit inside studio hours? Returns null or a reason. */
  function fitsStudioHours(win) {
    if (win.earliest < CONFIG.openHour) {
      return win.hm
        ? 'Hair & makeup needs the room from ' + hourLabel(win.hm.arrival) + ', which is before we open. Please choose a later session time.'
        : 'That time starts before we open.';
    }
    if (win.latest > CONFIG.closeHour) return 'That session would run past closing. Please choose an earlier time.';
    return null;
  }

  function hourLabel(h) {
    const t = ((h % 24) + 24) % 24;
    let hh = Math.floor(t + 1e-9), mm = Math.round((t - hh) * 60);
    if (mm === 60) { mm = 0; hh += 1; }
    const ap = hh >= 12 ? 'PM' : 'AM';
    let disp = hh % 12; if (disp === 0) disp = 12;
    return disp + ':' + String(mm).padStart(2, '0') + ' ' + ap;
  }
  function lengthLabel(mins) {
    if (mins < 60) return mins + ' min';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h + (m ? ' hr ' + m + ' min' : (h === 1 ? ' hour' : ' hours'));
  }

  return { CONFIG, SESSIONS, PHOTO_ADDONS, SESSION_OPTIONS, sessionById, addonById, optionsFor,
    addonAllowed, addonPrice, addonLead, normalizeSelection, minutesFor, sessionQuote,
    sessionWindow, fitsStudioHours, hourLabel, lengthLabel, round2 };
});
