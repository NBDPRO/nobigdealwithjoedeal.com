/**
 * os/home-logic.js — the pure half of the NBD OS home screen (2026-11-09, P0b;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md).
 *
 * No DOM, no clock, no storage, no network: tested in plain Node
 * (tests/nbd-os-home-key-2026-11-09.test.js).
 *
 * The home screen's arrangement is its own layoutState key, under its own
 * 12,000-char budget (a separate key, so a full home can never push the OS
 * windows over the budget and drop them):
 *
 *   layoutState['os-home'] = { v:1, phone:[{ id, s, cfg? }], desk:[{ id, s, cfg? }] }
 *
 *   id    a widget in CATALOG (unknown ids are dropped)
 *   s     'S' | 'M' | 'L' as 's' | 'm' | 'l', one the widget offers (else its default)
 *   cfg   enum values the widget declares, at most 64 chars of JSON
 * At most 12 items per surface. Phone and desk are separate arrangements.
 *
 *   normalize(raw)    a saved key made safe; garbage in, a clean default out
 *   defaults()        a new member's home
 *   cleanCfg(id, cfg) one widget's settings, or null
 *
 * What the read-only widgets show (os/home.js paints it), from data the CRM
 * already holds in memory; nothing here reads, and nothing here names a
 * customer on the glanceable widget:
 *   pageRoom(items, perPage)   phone icon cells left on page 1 (S 2, M 8, L 16 cells)
 *   upNext(plan, opts)         the top rows of the Today plan (NBDToday.last()), each
 *                              with the tap-through the Today list itself uses
 *   nextAppointment(plan, now) { time, place } of the next timed appointment, no name
 *   glanceCounts(counts)       NBDHomeAttention.lastCounts as plain lines + a state
 *   headline(total)            "3 things today" / "Nothing due today"
 *   dayKey(ms)                 local 'YYYY-MM-DD', the Daily Success writer's key
 *   dsLite(snapshot)           the tracker's snapshot cut to floors / streak state / week %
 *   dsPersonal(lite, dk, now)  that cut, only when it is today's, under 12 h and whole
 *
 * Classic script: window.NBDOSHomeLogic; require()-able for tests. Loaded
 * lazily with the OS layout (layout-system.js `needs`), never at boot.
 */
(function (root) {
  'use strict';

  var KEY = 'os-home';
  var MAX_ITEMS = 12;
  var MAX_CFG = 64;
  var SIZES = ['s', 'm', 'l'];
  var SURFACES = ['phone', 'desk'];

  // reads: Firestore reads a widget's paint costs. Every P0 widget reads only
  // what the CRM already holds in memory, so each is 0 (asserted in tests).
  var CATALOG = {
    glance: { title: 'At a Glance', sizes: ['s', 'm', 'l'], def: 'm', reads: 0 },
    upnext: { title: 'Up Next', sizes: ['s', 'm', 'l'], def: 'm', reads: 0 },
    shortcuts: { title: 'Shortcuts', sizes: ['s', 'm', 'l'], def: 's', reads: 0, config: { clock: ['on', 'off'] } },
    // P0c: rules over in-memory data (os/coach-logic.js); show = which half
    coach: { title: 'Coach', sizes: ['m', 'l'], def: 'm', reads: 0, config: { show: ['both', 'business', 'personal'] } },
  };
  var ORDER = ['glance', 'upnext', 'shortcuts', 'coach'];
  var DEFAULT = [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'shortcuts', s: 's' }];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function known(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, id); }
  function ids() { return ORDER.slice(); }
  function copyList(list) { return list.map(function (it) { var o = { id: it.id, s: it.s }; if (it.cfg) o.cfg = JSON.parse(JSON.stringify(it.cfg)); return o; }); }
  function defaults() { return { v: 1, phone: copyList(DEFAULT), desk: copyList(DEFAULT) }; }

  function cleanCfg(id, cfg) {
    var c = known(id) ? CATALOG[id] : null;
    if (!c || !c.config || !isObj(cfg)) return null;
    var out = {}, n = 0;
    Object.keys(c.config).forEach(function (k) {
      if (c.config[k].indexOf(cfg[k]) !== -1) { out[k] = cfg[k]; n++; }
    });
    return n && JSON.stringify(out).length <= MAX_CFG ? out : null;
  }
  function cleanItem(it) {
    if (!isObj(it) || !known(it.id)) return null;
    var c = CATALOG[it.id];
    var o = { id: it.id, s: c.sizes.indexOf(it.s) !== -1 ? it.s : c.def };
    var cfg = cleanCfg(it.id, it.cfg);
    if (cfg) o.cfg = cfg;
    return o;
  }
  function cleanList(list) {
    if (!Array.isArray(list)) return copyList(DEFAULT);
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_ITEMS; i++) {
      var it = cleanItem(list[i]);
      if (it) out.push(it);
    }
    // a list that had items and lost every one was garbage; an empty list is a choice
    return list.length && !out.length ? copyList(DEFAULT) : out;
  }
  function normalize(raw) {
    var r = isObj(raw) ? raw : {};
    var out = { v: 1 };
    SURFACES.forEach(function (s) { out[s] = cleanList(r[s]); });
    return out;
  }

  // ── what the widgets show ─────────────────────────────────────
  // Phone cells (a page is 4 x 5 = 20): S 2x1, M 4x2, L 4x4.
  var CELLS = { s: 2, m: 8, l: 16 };
  function pageRoom(items, perPage) {
    var used = 0;
    (Array.isArray(items) ? items : []).forEach(function (it) { used += CELLS[it && it.s] || 0; });
    return Math.max(0, (Number(perPage) || 20) - used);
  }
  function int(v) { var n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : 0; }
  function str(v, max) { return v == null ? '' : String(v).slice(0, max || 80); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function digits10(v) { return String(v == null ? '' : v).replace(/\D/g, '').slice(-10); }
  function street(a) { return str(String(a == null ? '' : a).split(',')[0].trim(), 60); }
  var MAPS = 'https://www.google.com/maps/search/?api=1&query=';
  // Today's own order (today-home.js html()): the sections that count toward its total.
  var SECTIONS = ['appointments', 'promises', 'calls', 'promised', 'estimates', 'money', 'stalled'];

  /** One Today row as { key, name, sub, href, ext, go }: href a link, go a CRM view for goTo. */
  function rowFor(sec, r, o) {
    if (!r || typeof r !== 'object') return null;
    var lead = r.leadId ? String(r.leadId) : '';
    var cust = lead ? '/pro/customer.html?id=' + encodeURIComponent(lead) : '';
    var d = digits10(r.phone);
    var tel = d.length === 10 ? 'tel:+1' + d : '';
    var row = { key: str(r.key || sec, 120), name: str(r.name), sub: '', href: '', ext: false, go: '' };
    if (sec === 'appointments') {
      row.sub = [str(r.timeLabel, 40), street(r.address)].filter(Boolean).join(' · ');
      row.href = cust || (r.address ? MAPS + encodeURIComponent(String(r.address)) : '') || tel;
      row.ext = !cust && !!r.address;
      if (!row.href) row.go = 'schedule';
      row.name = row.name || 'Appointment';
    } else if (sec === 'calls') {
      row.sub = r.urgent ? 'Urgent call' : (r.missed ? 'Missed call' : (r.text ? 'Texts to answer' : 'Call owed'));
      row.href = tel;
      if (!tel) row.go = 'calls';
      row.name = row.name || 'Unknown caller';
    } else if (sec === 'money') {
      if (r.kind === 'stripe') {
        var n = int(r.count);
        row.name = plural(n, 'Stripe payment', 'Stripe payments');
        row.sub = 'Needs a customer';
      } else {
        row.sub = r.kind === 'deposit' ? 'Draft deposit, not sent' : (r.overdue ? 'Past due' : 'Money to collect');
        // the invoice row's one tap is Record payment (a viewer gets the plain record)
        row.href = cust && r.kind === 'invoice' && !o.viewer ? cust + '&pay=' + encodeURIComponent(String(r.invoiceId || '1')) : cust;
      }
      if (!row.href) row.go = 'money';
    } else {
      row.href = cust;
      if (sec === 'promises') {
        var late = (Array.isArray(r.promiseTasks) ? r.promiseTasks : []).some(function (t) { return t && t.overdue; });
        row.sub = 'Promise' + (late ? ' · overdue' : '');
      } else if (sec === 'promised') {
        row.sub = r.overdue ? 'Overdue' : 'Due today';
      } else if (sec === 'estimates') {
        row.sub = 'Estimate to follow up';
      } else {
        var dl = int(r.daysLate);
        row.sub = dl ? plural(dl, 'day', 'days') + ' past follow-up' : 'Follow-up due today';
      }
    }
    if (!row.href && !row.go) row.go = 'home';
    return row;
  }
  /** The first `n` rows of the Today plan, in Today's order. null = no plan yet. */
  function upNext(plan, opts) {
    if (!plan || typeof plan !== 'object') return null;
    var o = opts || {};
    var n = int(o.n) || 3;
    var out = [];
    for (var i = 0; i < SECTIONS.length && out.length < n; i++) {
      var list = Array.isArray(plan[SECTIONS[i]]) ? plan[SECTIONS[i]] : [];
      for (var j = 0; j < list.length && out.length < n; j++) {
        var row = rowFor(SECTIONS[i], list[j], o);
        if (row) out.push(row);
      }
    }
    return out;
  }
  /** The next timed appointment still to come (15 minutes' grace): time and street, never a name. */
  function nextAppointment(plan, now) {
    var list = plan && Array.isArray(plan.appointments) ? plan.appointments : [];
    var t0 = Number(now) - 15 * 60000;
    var best = null;
    list.forEach(function (a) {
      var t = a && !a.allDay ? Number(a.sortMs) : NaN;
      if (isFinite(t) && t >= t0 && (!best || t < Number(best.sortMs))) best = a;
    });
    return best ? { time: str(best.timeLabel, 40), place: street(best.address) } : null;
  }
  /** Needs-you counts as lines. state: unknown | pending | failed | clear | ok (a failed read is never "clear"). */
  function glanceCounts(c) {
    if (!c || typeof c !== 'object') return { state: 'unknown', lines: [] };
    var lines = [];
    var n;
    if ((n = int(c.calls))) lines.push(plural(n, 'person needs', 'people need') + ' you');
    if ((n = int(c.signs))) lines.push(plural(n, 'yard sign', 'yard signs') + ' to pick up');
    if ((n = int(c.stripe))) lines.push(plural(n, 'Stripe payment', 'Stripe payments') + ' to match');
    if ((n = int(c.reviews))) lines.push(plural(n, 'review ask', 'review asks') + ' waiting');
    var failed = !!(c.callsFailed || c.stripeFailed || c.signsFailed || c.reviewsFailed || c.oldFailed);
    var state = failed ? 'failed' : (c.pending ? 'pending' : (lines.length ? 'ok' : 'clear'));
    return { state: state, lines: lines };
  }
  function headline(total) {
    var n = int(total);
    return n ? plural(n, 'thing', 'things') + ' today' : 'Nothing due today';
  }

  // ── Daily Success, personal half (P0c) ────────────────────────
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** ms -> the device's local 'YYYY-MM-DD': the Daily Success writer's own key (daily-success/js/app.js todayKey). */
  function dayKey(ms) { var d = new Date(Number(ms)); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  /**
   * The tracker's published snapshot (nbd_ds_snapshot / userSettings.dsSnapshot,
   * review-logic.js snapshotDoc) cut to what the home may show: today's floors
   * met / of, the streak state and the week %. Never weight, goal, money or the
   * scorecard. The same cut as layout-system.js liteDs.
   */
  function dsLite(s) {
    if (!isObj(s) || !isObj(s.today)) return null;
    var f = Array.isArray(s.today.floors) ? s.today.floors : [];
    var st = isObj(s.streak) ? s.streak : {};
    return { dk: s.today.dk, asOf: s.asOf, met: f.filter(function (x) { return x && x.met === true; }).length, of: f.length,
      warned: st.warned === true, broken: st.broken === true, pct: isObj(s.week) ? s.week.pct : null };
  }
  function isCount(n, max) { return typeof n === 'number' && Math.floor(n) === n && n >= 0 && n <= max; }
  var DS_MAX_AGE = 12 * 3600000;
  /** A lite snapshot that is today's (the writer's key), under 12 h old and whole; else null (show no numbers). */
  function dsPersonal(x, dk, now) {
    if (!isObj(x) || typeof dk !== 'string' || x.dk !== dk) return null;
    var t = Number(now);
    if (typeof x.asOf !== 'number' || !isFinite(x.asOf) || x.asOf > t + 5 * 60000 || t - x.asOf >= DS_MAX_AGE) return null;
    if (!isCount(x.of, 99) || x.of < 1 || !isCount(x.met, x.of)) return null;
    if (x.pct != null && !isCount(x.pct, 100)) return null;
    if (typeof x.warned !== 'boolean' || typeof x.broken !== 'boolean') return null;
    return { dk: x.dk, asOf: x.asOf, met: x.met, of: x.of, warned: x.warned, broken: x.broken, pct: x.pct == null ? null : x.pct };
  }

  var api = {
    KEY: KEY, MAX_ITEMS: MAX_ITEMS, MAX_CFG: MAX_CFG, SIZES: SIZES, SURFACES: SURFACES, CATALOG: CATALOG,
    ids: ids, defaults: defaults, normalize: normalize, cleanCfg: cleanCfg,
    CELLS: CELLS, pageRoom: pageRoom, upNext: upNext, nextAppointment: nextAppointment, glanceCounts: glanceCounts, headline: headline,
    dayKey: dayKey, dsLite: dsLite, dsPersonal: dsPersonal,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSHomeLogic = api;
})(typeof window !== 'undefined' ? window : null);
