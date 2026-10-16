/**
 * canvasser-logic.js — Canvasser mode, the pure rules (2026-10-16). No I/O.
 *
 * Joe adds a commission-only canvasser: a team member with the Sales Rep role
 * (own leads and own knocks only, enforced by firestore.rules) that he marks
 * as a canvasser with a commission % in the Team settings. This file holds
 * the numbers he sees and the pre-knock checklist the rep ticks.
 *
 * NUMBERS PER REP (tracking only: no payroll, no payouts):
 *   doors knocked     distinct doors in the rep's knocks (address, else GPS)
 *   leads             the rep's own leads (lead.userId = the rep)
 *   appointments set  the rep's knocks marked Appointment Set
 *   closed jobs       the rep's leads that are a sale: a signed contract, a job
 *                     in production, or a won stage (stage-roles.js isSale)
 *   collected         money RECEIVED on the rep's leads' invoices (payments by
 *                     the date received, refunds off), in cents; never the
 *                     contract value
 *   commission owed   collected × the rep's % (0-50), rounded to the cent
 *
 * THE PRE-KNOCK CHECKLIST, once per town per day: my permit for this town is
 * on file and with me (if the town requires one), my ID badge is on me, I hand
 * over the 3-day cancel notice at signing (Kentucky insurance jobs: the
 * 5-business-day notice too), and the town's door-knocking hours. A town that
 * bans door-to-door (Batavia) cannot be started. Legal cross-check
 * 2026-10-16: the cancel line also says never to present yourself as a
 * specialist or expert on claims or insurance (KRS 367.628(1)(a)2), and a Kentucky town's knocking line
 * says to check for an Attorney General emergency order first (KRS 367.379:
 * no in-person soliciting in a designated area for 90 days after a declared
 * emergency without the owner's prior approval). Same four ticks, so the
 * saved doc and firestore.rules are unchanged. The town rules are the
 * 2026-10-15 permit research (nbd-agents reports/canvassing-permits-*):
 * research, not legal advice; the checklist says to confirm with the town.
 *
 * Used by canvasser-ui.js; tests/canvasser-mode-2026-10-16.test.js.
 */
(function (root) {
  'use strict';

  var MAX_PCT = 50;
  var SALE = {
    contract_signed: 1, job_created: 1, permit_pulled: 1, materials_ordered: 1, materials_delivered: 1, crew_scheduled: 1, install_in_progress: 1,
    closed: 1, install_complete: 1, final_photos: 1, final_payment: 1, deductible_collected: 1, collections: 1, warranty_claim: 1,
    complete: 1, 'closed won': 1, closed_won: 1, 'closed-won': 1, won: 1,
  };
  var DEAD = { void: 1, voided: 1, cancelled: 1, canceled: 1, uncollectible: 1, draft: 1 };

  // Door-knocking rules by town (the 2026-10-15 permit research). permit:
  // 'yes' | 'no' | 'banned' | 'check' (unverified: call first).
  var TOWNS = [
    { id: 'goshen-oh', name: 'Goshen Twp, OH', state: 'OH', permit: 'yes', hours: '9 a.m. to 6 p.m.', note: 'Transient Vendor permit, $150 / 90 days; carry it.' },
    { id: 'milford-oh', name: 'Milford, OH', state: 'OH', permit: 'yes', hours: 'Not set in what we found: call the city', note: 'License under Ch. 731.' },
    { id: 'miami-twp-clermont-oh', name: 'Miami Twp (Clermont), OH', state: 'OH', permit: 'yes', hours: 'Not set in what we found: call the township', note: 'Police permit, photo badge displayed; 6 working days.' },
    { id: 'batavia-oh', name: 'Batavia (village), OH', state: 'OH', permit: 'banned', hours: 'n/a', note: 'Uninvited door-to-door soliciting is banned (Sec. 113.15). Mail only.' },
    { id: 'loveland-oh', name: 'Loveland, OH', state: 'OH', permit: 'yes', hours: '9 a.m. to 9 p.m.', note: 'Per-person permit with fingerprints; city No-Solicitation lists.' },
    { id: 'madeira-oh', name: 'Madeira, OH', state: 'OH', permit: 'yes', hours: 'Not set in what we found: call the city', note: 'Solicitation Permit through the police.' },
    { id: 'montgomery-oh', name: 'Montgomery, OH', state: 'OH', permit: 'yes', hours: '8 a.m. to 9 p.m. (no knocking 9 p.m. to 8 a.m.)', note: 'Register with Police; registered no-knock homes with a sign are off-limits.' },
    { id: 'blue-ash-oh', name: 'Blue Ash, OH', state: 'OH', permit: 'no', hours: 'None in the code', note: 'No permit found; no knocking or flyers where a No Peddlers sign is posted.' },
    { id: 'anderson-oh', name: 'Anderson Twp, OH', state: 'OH', permit: 'check', hours: 'Unverified', note: 'No permit resolution found; confirm first.' },
    { id: 'mason-oh', name: 'Mason, OH', state: 'OH', permit: 'yes', hours: '9 a.m. to 8 p.m. Apr-Oct; 9 a.m. to 6 p.m. Nov-Mar', note: 'Register with Police; ID with the registration number.' },
    { id: 'west-chester-oh', name: 'West Chester Twp, OH', state: 'OH', permit: 'yes', hours: '9 a.m. to 9 p.m. May-Sep; 9 a.m. to 6 p.m. Oct-Apr', note: 'Solicitor Registration Card from police; show it.' },
    { id: 'norwood-oh', name: 'Norwood, OH', state: 'OH', permit: 'check', hours: '9 a.m. to 9 p.m.', note: 'Ch. 759; permit requirement unverified.' },
    { id: 'cincinnati-oh', name: 'Cincinnati, OH', state: 'OH', permit: 'check', hours: 'No rule found', note: 'Unclear for roofing services: ask the City Treasurer.' },
    { id: 'florence-ky', name: 'Florence, KY', state: 'KY', permit: 'no', hours: 'Unverified', note: 'No door-to-door ordinance found; occupational license.' },
    { id: 'union-ky', name: 'Union, KY', state: 'KY', permit: 'yes', hours: '10 a.m. to 7 p.m.', note: 'Business license plus a $5 / 60-day solicitor permit; NO KNOCK list.' },
    { id: 'covington-ky', name: 'Covington, KY', state: 'KY', permit: 'yes', hours: '9 a.m. to 9 p.m. (no knocking 9 p.m. to 9 a.m.)', note: '$50 permit per solicitor; $500 bond when taking contracts; no-solicitation list.' },
    { id: 'fort-thomas-ky', name: 'Fort Thomas, KY', state: 'KY', permit: 'yes', hours: 'Unverified', note: 'City permit; Licensed Solicitor card.' },
    { id: 'independence-ky', name: 'Independence, KY', state: 'KY', permit: 'yes', hours: '9 a.m. to 9 p.m. or sunset if earlier, Mon-Sat', note: 'City license and ID badge; Zero Knock List.' },
    { id: 'newport-ky', name: 'Newport, KY', state: 'KY', permit: 'check', hours: 'Unverified', note: 'Occupational license; call first.' },
    { id: 'alexandria-ky', name: 'Alexandria, KY', state: 'KY', permit: 'yes', hours: 'Your planned times go on the application', note: '$50 / 90-day license; No-Knock list.' },
  ];
  var DEFAULT_HOURS = '10 a.m. to 6 p.m. (the strictest of the towns we checked)';

  function ms(t) {
    if (!t) return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var d = Date.parse(t);
    return isFinite(d) ? d : 0;
  }
  function cents(v) { var n = Number(v); return isFinite(n) ? Math.round(n * 100) : 0; }
  function clampPct(p) { var n = Number(p); if (!isFinite(n) || n < 0) return 0; return Math.min(MAX_PCT, Math.round(n * 100) / 100); }
  function normAddr(a) { return String(a || '').toLowerCase().trim().replace(/\s+/g, ' '); }
  function doorKey(k) {
    var a = normAddr(k && k.address);
    if (a) return a;
    if (k && k.lat != null && k.lng != null && isFinite(k.lat) && isFinite(k.lng)) return 'geo:' + Number(k.lat).toFixed(5) + ',' + Number(k.lng).toFixed(5);
    return 'k:' + ((k && k.id) || '');
  }
  function stageKey(l) { return String((l && (l._stageKey || l.stage)) || '').trim().toLowerCase().replace(/\s+/g, '_'); }
  function isSale(l) {
    if (!l || l.deleted === true) return false;
    if (l.stageRole === 'won' || l.stageRole === 'job') return true;
    if (l.stageRole === 'lost') return false;
    var k = stageKey(l);
    return !!(SALE[k] || SALE[k.replace(/_/g, ' ')]);
  }
  function inRange(t, from, to) { return t > 0 && (!from || t >= from) && (!to || t <= to); }

  /** Money RECEIVED on one invoice between from..to (cents): payments by date received, refunds off. */
  function collectedCents(inv, from, to) {
    if (!inv || inv.deleted === true || DEAD[String(inv.status || '').toLowerCase()]) return 0;
    var pays = Array.isArray(inv.payments) ? inv.payments : [];
    if (pays.length) {
      var c = 0;
      pays.forEach(function (p) {
        if (!p) return;
        var t = ms(p.at);
        if (!inRange(t, from, to)) return;
        var amt = Math.abs(cents(p.amount));
        c += (p.refund === true || Number(p.amount) < 0) ? -amt : amt;
      });
      return c;
    }
    if (String(inv.status || '').toLowerCase() === 'paid' && inRange(ms(inv.paidAt), from, to)) return Math.max(cents(inv.amountPaid), cents(inv.total));
    return 0;
  }

  /**
   * One rep's numbers. data: { knocks, leads, invoices } (the company's), rep:
   * { uid, pct }, range: { from, to } (ms; either may be 0 = open).
   */
  function repStats(rep, data, range) {
    var r = rep || {}, d = data || {}, g = range || {};
    var uid = String(r.uid || '');
    var from = Number(g.from) || 0, to = Number(g.to) || 0;
    var knocks = (d.knocks || []).filter(function (k) { return k && k.userId === uid && k.deleted !== true && inRange(ms(k.createdAt || k.timestamp || k.date), from, to); });
    var doors = {};
    knocks.forEach(function (k) { doors[doorKey(k)] = 1; });
    var leads = (d.leads || []).filter(function (l) { return l && l.userId === uid && l.deleted !== true; });
    var leadIds = {};
    leads.forEach(function (l) { leadIds[l.id] = 1; });
    var newLeads = leads.filter(function (l) { return inRange(ms(l.createdAt), from, to); });
    var closed = leads.filter(function (l) { return isSale(l) && (!from && !to ? true : inRange(ms(l.closedAt) || ms(l.contractSignedAt) || ms(l.stageStartedAt) || ms(l.updatedAt), from, to)); });
    var collected = 0;
    (d.invoices || []).forEach(function (inv) { if (inv && leadIds[inv.leadId]) collected += collectedCents(inv, from, to); });
    var pct = clampPct(r.pct);
    return {
      uid: uid, name: String(r.name || '').slice(0, 80), pct: pct,
      doors: Object.keys(doors).length, knocks: knocks.length,
      appointments: knocks.filter(function (k) { return k.disposition === 'appointment'; }).length,
      leads: newLeads.length, closed: closed.length,
      collectedCents: collected, commissionCents: Math.round(collected * pct / 100),
    };
  }

  /** Leaderboard: closed jobs, then money collected, then appointments, then doors. */
  function leaderboard(stats) {
    return (stats || []).slice().sort(function (a, b) {
      return b.closed - a.closed || b.collectedCents - a.collectedCents || b.appointments - a.appointments || b.doors - a.doors || String(a.name).localeCompare(String(b.name));
    }).map(function (s, i) { return Object.assign({ rank: i + 1 }, s); });
  }

  function townById(id) { for (var i = 0; i < TOWNS.length; i++) if (TOWNS[i].id === id) return TOWNS[i]; return null; }
  /** The checklist for a town. Unknown town ('other'): permit = confirm with the town. */
  function checklistFor(townId) {
    var t = townById(townId);
    if (t && t.permit === 'banned') return { town: t, blocked: true, why: t.name + ': ' + t.note, items: [] };
    var permitLabel = !t ? 'I checked this town\'s permit rule and have what it requires with me'
      : t.permit === 'yes' ? 'My ' + t.name + ' solicitor permit is on file and with me'
      : t.permit === 'no' ? 'No permit found for ' + t.name + ': I checked for signs and the town\'s no-knock list'
      : 'I called ' + t.name + ' (permit rule unverified) and have what it requires';
    var hours = t && !/^unverified|^not set|^none|^no rule|^n\/a|^your planned/i.test(t.hours) ? t.hours : DEFAULT_HOURS;
    var ky = (t && t.state === 'KY') || !t;
    var noTitle = '; I never present myself as a specialist or expert on claims or insurance, or say I work with any insurer';
    var kyOrder = ky ? '; and I checked the Kentucky Attorney General\'s site: if an emergency order covers this area, I knock only where the owner asked me to come (90 days from the declaration)' : '';
    return {
      town: t, blocked: false, hours: hours,
      items: [
        { id: 'permit', label: permitLabel },
        { id: 'badge', label: 'My ID badge / photo ID is on me and visible' },
        { id: 'cancelNotice', label: (t && t.state === 'KY') || !t
          ? 'At signing I hand over the 3-day cancel notice (Kentucky insurance jobs: the 5-business-day notice too) and say it out loud' + noTitle
          : 'At signing I hand over the 3-day cancel notice in duplicate and say it out loud' + noTitle },
        { id: 'quietHours', label: 'I knock only ' + hours + ', never at a No Soliciting sign, and leave when asked' + kyOrder },
      ],
    };
  }
  function ymdOf(d) { var x = d || new Date(); return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  /** The doc the rep's ticked checklist saves. null if anything is unticked or the town is banned. */
  function checkDoc(townId, ticked, who, now) {
    var c = checklistFor(townId);
    if (c.blocked) return null;
    var t = ticked || {};
    if (!c.items.every(function (it) { return t[it.id] === true; })) return null;
    var w = who || {};
    return {
      userId: String(w.uid || ''), companyId: String(w.companyId || ''), ymd: ymdOf(now || new Date()),
      townId: c.town ? c.town.id : 'other', town: c.town ? c.town.name : String(w.townName || 'Other town').slice(0, 80),
      items: { permit: true, badge: true, cancelNotice: true, quietHours: true }, hours: c.hours.slice(0, 120),
    };
  }
  /** Is there a check for today in this town (or any town today, when townId is omitted)? */
  function checkedToday(checks, uid, townId, now) {
    var today = ymdOf(now || new Date());
    return (checks || []).some(function (c) { return c && c.userId === uid && c.ymd === today && (!townId || c.townId === townId); });
  }
  function fmtMoney(c) { var n = (Number(c) || 0) / 100; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  var api = {
    MAX_PCT: MAX_PCT, TOWNS: TOWNS, DEFAULT_HOURS: DEFAULT_HOURS,
    clampPct: clampPct, isSale: isSale, collectedCents: collectedCents, repStats: repStats, leaderboard: leaderboard,
    checklistFor: checklistFor, checkDoc: checkDoc, checkedToday: checkedToday, ymdOf: ymdOf, fmtMoney: fmtMoney, doorKey: doorKey,
  };
  if (root) root.NBDCanvasserLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
