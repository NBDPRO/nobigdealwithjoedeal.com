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
 *   layoutState['os-home'] = { v:1, phone:[{ id, s, cfg? }], desk:[{ id, s, x, y, w, h, cfg? }] }
 *
 *   id    a widget in CATALOG (unknown ids are dropped)
 *   s     'S' | 'M' | 'L' as 's' | 'm' | 'l', one the widget offers (else its default)
 *   cfg   enum values the widget declares, at most 64 chars of JSON
 *   x y   the desk board cell (P1): 4 columns, rows of 160px, x 0-3, y 0-47
 *   w h   the cells its size takes on the desk: S 1x1, M 2x1, L 2x2 (DESK_CELLS);
 *         a saved w x h that is one of the widget's sizes wins over s
 * At most 24 items per surface (P1; 12 in P0). Phone and desk are separate
 * arrangements. A desk item saved without x / y (a P0 ordered list) is placed
 * by layouts/board-logic.js into the first gap, in list order, so an old home
 * keeps its order with no migration; the board is gravity-packed (Bento's
 * rule) and kept in reading order, which is also the one-column order below
 * 1100px.
 *
 *   normalize(raw)    a saved key made safe; garbage in, a clean default out
 *   defaults()        a new member's home
 *   cleanCfg(id, cfg) one widget's settings, or null
 *
 * What the read-only widgets show (os/home.js paints it), from data the CRM
 * already holds in memory; nothing here reads, and nothing here names a
 * customer on the glanceable widget:
 *   pageRoom(items, perPage)   phone icon cells left on page 1 (S 2, M 8, L 16 cells)
 *   pack(items)                the phone order with no grid holes (a lone S pairs up or goes last)
 *   moveBy / moveTo / resize / remove / add / describe
 *                              edit mode (P0c): pure list ops and the live-region line
 *   deskBoard(list)            the desk list placed on the board (needs NBDBoardLogic, else as a list)
 *   deskMoveBy / deskMoveTo / deskSwap / deskResize / deskSizeTo / deskRemove / deskAdd / describeDesk
 *                              edit mode on the desk board (P1): each returns the new placed list or null
 *   upNext(plan, opts)         the top rows of the Today plan (NBDToday.last()), each
 *                              with the tap-through the Today list itself uses
 *   nextAppointment(plan, now) { time, place } of the next timed appointment, no name
 *   jobsLeft(plan, now)        appointments not yet past (all-day, or started under 15 min ago)
 *   glanceCounts(counts)       NBDHomeAttention.lastCounts as plain lines + a state
 *   headline(total)            "3 things today" / "Nothing due today"
 *   noMoreLine(plan)           "No more appointments · 2 jobs today" (P0c), else the plain line
 *   dayKey(ms)                 local 'YYYY-MM-DD', the Daily Success writer's key
 *   dsLite(snapshot)           the tracker's snapshot cut to floors / streak state / week %
 *   dsPersonal(lite, dk, now)  that cut, only when it is today's, under 12 h and whole
 *   todaySummary(raw, uid, now) Today's counts-only summary (calls, follow-ups, jobs), same rules
 *
 * Classic script: window.NBDOSHomeLogic; require()-able for tests. Loaded
 * lazily with the OS layout (layout-system.js `needs`), never at boot.
 */
(function (root) {
  'use strict';

  var KEY = 'os-home';
  var MAX_ITEMS = 24;
  var MAX_CFG = 64;
  var SIZES = ['s', 'm', 'l'];
  var SURFACES = ['phone', 'desk'];

  // reads: Firestore reads a widget's paint costs. Every P0 widget reads only
  // what the CRM already holds in memory, so each is 0 (asserted in tests).
  // cat + about: the Add widget sheet's groups and lines (P0c). nav: a sidebar
  // view the widget is about; a member whose role hides that view never gets it.
  var CATALOG = {
    glance: { title: 'At a Glance', sizes: ['s', 'm', 'l'], def: 'm', reads: 0, cat: 'today', about: 'The clock, your next appointment and what needs you' },
    upnext: { title: 'Up Next', sizes: ['s', 'm', 'l'], def: 'm', reads: 0, cat: 'today', about: 'The next things on your Today list' },
    shortcuts: { title: 'Shortcuts', sizes: ['s', 'm', 'l'], def: 's', reads: 0, config: { clock: ['on', 'off'] }, cat: 'tools', about: 'New lead and Search' },
    // P0c: rules over in-memory data (os/coach-logic.js); show = which half
    coach: { title: 'Coach', sizes: ['m', 'l'], def: 'm', reads: 0, config: { show: ['both', 'business', 'personal'] }, cat: 'today', nav: 'crm', about: 'One thing worth doing next, from your own numbers' },
    // P0c: the tracker's own snapshot (personal) and Today's counts (business)
    daily: { title: 'Daily Success', sizes: ['s', 'm', 'l'], def: 'm', reads: 0, config: { show: ['both', 'personal', 'business'] }, cat: 'you', about: 'Your floors and streak, and what is left today' },
  };
  var GROUPS = [{ id: 'today', title: 'Today' }, { id: 'you', title: 'You' }, { id: 'tools', title: 'Tools' }];
  var SIZE_NAME = { s: 'small', m: 'medium', l: 'large' };
  var ORDER = ['glance', 'upnext', 'shortcuts', 'coach', 'daily'];
  var DEFAULT = [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'shortcuts', s: 's' }];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function known(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, id); }
  function ids() { return ORDER.slice(); }
  function copyList(list) { return list.map(function (it) { var o = { id: it.id, s: it.s }; if (it.cfg) o.cfg = JSON.parse(JSON.stringify(it.cfg)); return o; }); }
  function defaults() { return { v: 1, phone: copyList(DEFAULT), desk: deskBoard(copyList(DEFAULT)) }; }

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
  function cleanList(list, desk) {
    if (!Array.isArray(list)) return desk ? deskBoard(copyList(DEFAULT)) : copyList(DEFAULT);
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_ITEMS; i++) {
      var it = desk ? cleanDeskItem(list[i]) : cleanItem(list[i]);
      if (it) out.push(it);
    }
    // a list that had items and lost every one was garbage; an empty list is a choice
    if (list.length && !out.length) out = copyList(DEFAULT);
    return desk ? deskBoard(out) : out;
  }
  function normalize(raw) {
    var r = isObj(raw) ? raw : {};
    var out = { v: 1 };
    SURFACES.forEach(function (s) { out[s] = cleanList(r[s], s === 'desk'); });
    return out;
  }

  // ── the desk board (P1, design §3.2 / §3.5): layouts/board-logic.js does the math ──
  var DESK_COLS = 4;
  var DESK_MAX_Y = 47;
  var DESK_CELLS = { s: [1, 1], m: [2, 1], l: [2, 2] };
  function cellsSize(w, h) {
    for (var k in DESK_CELLS) if (DESK_CELLS[k][0] === w && DESK_CELLS[k][1] === h) return k;
    return null;
  }
  function cellInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 ? v : null; }
  /** One saved desk item: the phone item's rules, then the size its w x h names (if the widget offers it) and its cell. */
  function cleanDeskItem(raw) {
    var o = cleanItem(raw);
    if (!o) return null;
    var ws = cellsSize(cellInt(raw.w), cellInt(raw.h));
    if (ws && CATALOG[o.id].sizes.indexOf(ws) !== -1) o.s = ws;
    var x = cellInt(raw.x), y = cellInt(raw.y);
    if (x !== null && y !== null) { o.x = Math.min(x, DESK_COLS - DESK_CELLS[o.s][0]); o.y = Math.min(y, DESK_MAX_Y); }
    return o;
  }
  var board = null;
  function BL() {
    if (board) return board;
    var M = root && root.NBDBoardLogic;
    if (!M && typeof require === 'function') { try { M = require('../layouts/board-logic.js'); } catch (e) { M = null; } }
    if (!M || typeof M.make !== 'function') return null;
    board = M.make({
      cols: DESK_COLS, maxTiles: MAX_ITEMS, maxY: DESK_MAX_Y, key: '_b', kind: 'id', carry: ['s', 'cfg', '_k'],
      catalog: ORDER.map(function (id) { return { id: id, title: CATALOG[id].title, def: DESK_CELLS[CATALOG[id].def], min: [1, 1], max: [2, 2] }; }),
    });
    return board;
  }
  function toBoard(list) {
    return list.map(function (it, i) {
      var o = { _b: 'b' + i, id: it.id, x: it.x, y: it.y, w: DESK_CELLS[it.s][0], h: DESK_CELLS[it.s][1], s: it.s };
      if (it.cfg) o.cfg = JSON.parse(JSON.stringify(it.cfg));
      if (it._k) o._k = it._k;
      return o;
    });
  }
  function fromBoard(b) {
    return b.slice().sort(function (a, c) { return a.y - c.y || a.x - c.x; }).map(function (t) {
      var o = { id: t.id, s: t.s, x: t.x, y: t.y, w: t.w, h: t.h };
      if (t.cfg) o.cfg = t.cfg;
      if (t._k) o._k = t._k;
      return o;
    });
  }
  /**
   * The desk list placed on the board: items with a cell keep it (gravity-packed), items
   * without one go into the first gap in list order. Without the board logic (it failed to
   * load) the list comes back as it is, and the desk shows it as one column.
   */
  function deskBoard(list) {
    var Q = BL();
    var items = (Array.isArray(list) ? list : []).filter(function (it) { return it && known(it.id) && DESK_CELLS[it.s]; });
    if (!Q) return items.map(copyItem);
    var all = toBoard(items);
    var placed = Q.compact(all.filter(function (t) { return cellInt(t.x) !== null && cellInt(t.y) !== null; }));
    all.forEach(function (t) {
      if (cellInt(t.x) !== null && cellInt(t.y) !== null) return;
      var at = Q.firstFit(placed, t.w, t.h);
      t.x = at.x; t.y = at.y;
      placed = Q.compact(placed.concat([t]));
    });
    return fromBoard(placed);
  }
  function samePlace(a, b) {
    return a.length === b.length && a.every(function (t, i) { return t._k === b[i]._k && t.id === b[i].id && t.s === b[i].s && t.x === b[i].x && t.y === b[i].y && t.w === b[i].w && t.h === b[i].h; });
  }
  function placedAll(list) { return list.every(function (it) { return it && known(it.id) && DESK_CELLS[it.s] && cellInt(it.x) !== null && cellInt(it.y) !== null; }); }
  // the op runs on the list as given (item i is tile 'b' + i); null when the board logic is
  // missing, the list is not placed, or nothing moved
  function deskOp(list, i, fn) {
    var Q = BL();
    if (!Q || !Array.isArray(list) || i < 0 || i >= list.length || !placedAll(list)) return null;
    var b = toBoard(list), was = fromBoard(b);
    var out = fn(Q, b, 'b' + i);
    if (!out) return null;
    out = fromBoard(out);
    return samePlace(out, was) ? null : out;
  }
  /**
   * Arrow keys on the board: one cell left/right/up/down (the others work around it). Gravity
   * floats a widget straight back up when nothing sits under it, so an up/down step that changes
   * nothing swaps it with its reading-order neighbour instead (a key always does something until an end).
   */
  function deskMoveBy(list, i, dx, dy) {
    var out = deskOp(list, i, function (Q, b, id) { return Q.moveBy(b, id, dx, dy); });
    return out || (dy && !dx ? deskSwap(list, i, dy) : null);
  }
  /** A pointer drop: the cell under the pointer. */
  function deskMoveTo(list, i, x, y) { return deskOp(list, i, function (Q, b, id) { return Q.moveTo(b, id, x, y); }); }
  /** One column (below 1100px): swap with the widget before (-1) or after (+1) in reading order. */
  function deskSwap(list, i, dir) { return deskOp(list, i, function (Q, b, id) { return Q.swapOrder(b, id, dir); }); }
  /** S/M/L snap: dir +1 bigger, -1 smaller, 0 cycles (the chip); the others work around it. */
  function deskSizeTo(list, i, s) {
    var it = list[i], c = it && known(it.id) ? CATALOG[it.id] : null;
    if (!c || c.sizes.indexOf(s) === -1 || s === it.s) return null;
    return deskOp(list, i, function (Q, b, id) {
      var t = Q.find(b, id);
      t.s = s;
      return Q.resizeTo(b, id, DESK_CELLS[s][0], DESK_CELLS[s][1]);
    });
  }
  function deskResize(list, i, dir) {
    var next = resize(list, i, dir);
    return next ? deskSizeTo(list, i, next[i].s) : null;
  }
  function deskRemove(list, i) {
    var Q = BL();
    var next = remove(list, i);
    if (!next) return null;
    return Q && placedAll(next) ? fromBoard(Q.compact(toBoard(next))) : next;
  }
  /** Add widget on the desk: the first gap that fits its size. */
  function deskAdd(list, id, s) {
    var next = add(list, id, s);
    if (!next) return null;
    var it = next[next.length - 1];
    delete it.x; delete it.y;
    return deskBoard(next);
  }
  /** "Coach, medium, row 2 column 1" (one column: "position 2 of 4"). */
  function describeDesk(list, i, oneCol) {
    var it = list[i];
    if (!it || !known(it.id)) return '';
    if (oneCol || cellInt(it.x) === null || cellInt(it.y) === null) return describe(list, i);
    return CATALOG[it.id].title + ', ' + SIZE_NAME[it.s] + ', row ' + (it.y + 1) + ' column ' + (it.x + 1);
  }

  // ── what the widgets show ─────────────────────────────────────
  // Phone cells (a page is 4 x 5 = 20): S 2x1, M 4x2, L 4x4.
  var CELLS = { s: 2, m: 8, l: 16 };
  function pageRoom(items, perPage) {
    var used = 0;
    (Array.isArray(items) ? items : []).forEach(function (it) { used += CELLS[it && it.s] || 0; });
    return Math.max(0, (Number(perPage) || 20) - used);
  }
  /**
   * The phone's page grid has 4 columns and no dense flow: an S (half a row)
   * left alone before an M or L (whole rows) leaves a hole the icons after it
   * never fill, so pageRoom's count would push icons past the page. The order
   * is fixed here, not with CSS dense, so DOM order stays reading order: a
   * lone S takes the next S up beside it, or with none left goes after the
   * whole-row widgets (the icons then fill its row).
   */
  function pack(items) {
    var list = Array.isArray(items) ? items.slice() : [];
    var out = [], parked = null;
    while (list.length) {
      var it = list.shift();
      if (!it || it.s !== 's') { out.push(it); continue; }
      if (list.length && list[0] && list[0].s === 's') { out.push(it, list.shift()); continue; }
      var j = -1;
      for (var k = 0; k < list.length; k++) if (list[k] && list[k].s === 's') { j = k; break; }
      if (j !== -1) { out.push(it, list.splice(j, 1)[0]); continue; }
      if (!list.length) { out.push(it); continue; }
      parked = it;   // no partner: after the whole-row widgets
    }
    if (parked) out.push(parked);
    return out;
  }

  // ── edit mode (P0c): each op returns a NEW list, or null when nothing changes ──
  // a caller's own tag (_k: home.js tracks which widget moved) rides along; normalize() drops it
  function copyItem(it) {
    var o = { id: it.id, s: it.s };
    if (cellInt(it.x) !== null && cellInt(it.y) !== null) { o.x = it.x; o.y = it.y; o.w = DESK_CELLS[it.s][0]; o.h = DESK_CELLS[it.s][1]; }
    if (it.cfg) o.cfg = JSON.parse(JSON.stringify(it.cfg));
    if (it._k) o._k = it._k;
    return o;
  }
  function sameList(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function moveTo(list, from, to) {
    var out = list.map(copyItem);
    if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return null;
    out.splice(to, 0, out.splice(from, 1)[0]);
    return out;
  }
  /** One step earlier (dir -1) or later (+1). On the phone a step that pack() would undo goes one further. */
  function moveBy(list, i, dir, phone) {
    var base = phone ? pack(list) : list;
    for (var to = i + dir; to >= 0 && to < list.length; to += dir) {
      var next = moveTo(list, i, to);
      if (next && phone) next = pack(next);
      if (next && !sameList(next, base)) return next;
    }
    return null;
  }
  /** dir +1 bigger, -1 smaller (stops at the ends), 0 cycles through the widget's sizes (the S/M/L chip). */
  function resize(list, i, dir) {
    var it = list[i], c = it && known(it.id) ? CATALOG[it.id] : null;
    if (!c) return null;
    var at = c.sizes.indexOf(it.s);
    var to = dir ? at + (dir > 0 ? 1 : -1) : (at + 1) % c.sizes.length;
    if (to < 0 || to >= c.sizes.length || c.sizes[to] === it.s) return null;
    var out = list.map(copyItem);
    out[i].s = c.sizes[to];
    return out;
  }
  function remove(list, i) {
    if (i < 0 || i >= list.length) return null;
    var out = list.map(copyItem);
    out.splice(i, 1);
    return out;
  }
  /** Add at the end (the first free slot); null when full or unknown. */
  function add(list, id, s) {
    if (!known(id) || list.length >= MAX_ITEMS) return null;
    var c = CATALOG[id];
    return list.map(copyItem).concat([{ id: id, s: c.sizes.indexOf(s) !== -1 ? s : c.def }]);
  }
  /** "Coach, medium, position 2 of 4": what the live region says after a change. */
  function describe(list, i) {
    var it = list[i];
    if (!it || !known(it.id)) return '';
    return CATALOG[it.id].title + ', ' + SIZE_NAME[it.s] + ', position ' + (i + 1) + ' of ' + list.length;
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
  /**
   * Jobs still left today from the Today plan in memory: all-day ones, and timed ones that start
   * no more than 15 minutes ago (nextAppointment's grace; the plan carries no done marker).
   * null with no plan, so the caller keeps the summary's own count.
   */
  function jobsLeft(plan, now) {
    if (!plan || !Array.isArray(plan.appointments)) return null;
    var t0 = Number(now) - 15 * 60000;
    return plan.appointments.filter(function (a) {
      if (!a) return false;
      var t = a.allDay ? NaN : Number(a.sortMs);
      return a.allDay === true || a.sortMs == null || (isFinite(t) && t >= t0);
    }).length;
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
  /** At a Glance with nothing still to come: say how many jobs Today has, so it never reads as an empty day. */
  function noMoreLine(plan) {
    var n = plan && Array.isArray(plan.appointments) ? plan.appointments.length : 0;
    return n ? 'No more appointments · ' + plural(n, 'job', 'jobs') + ' today' : 'No more appointments today';
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
  /**
   * The business half: the counts-only localStorage nbd_today_summary that
   * today-home.js publishes (today-plan.js summaryForTracker), used only when it
   * is this user's, today's, under 12 h old and whole (the Daily Success tile's
   * own rule, daily-success/js/business-tile-logic.js read). -> { calls, followUps, jobs } | null
   */
  function todaySummary(raw, uid, now) {
    if (typeof uid !== 'string' || !uid || typeof raw !== 'string' || !raw) return null;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return null; }
    var t = Number(now);
    if (!isObj(s) || s.v !== 1 || s.uid !== uid) return null;
    if (!isCount(s.calls, 9999) || !isCount(s.followUps, 9999) || !isCount(s.jobs, 9999)) return null;
    if (typeof s.asOf !== 'number' || !(s.asOf > 0) || s.asOf > t + 5 * 60000 || t - s.asOf >= DS_MAX_AGE || dayKey(s.asOf) !== dayKey(t)) return null;
    return { calls: s.calls, followUps: s.followUps, jobs: s.jobs };
  }

  var api = {
    KEY: KEY, MAX_ITEMS: MAX_ITEMS, MAX_CFG: MAX_CFG, SIZES: SIZES, SURFACES: SURFACES, CATALOG: CATALOG,
    ids: ids, defaults: defaults, normalize: normalize, cleanCfg: cleanCfg,
    CELLS: CELLS, pageRoom: pageRoom, upNext: upNext, nextAppointment: nextAppointment, jobsLeft: jobsLeft, glanceCounts: glanceCounts, headline: headline, noMoreLine: noMoreLine,
    dayKey: dayKey, dsLite: dsLite, dsPersonal: dsPersonal, todaySummary: todaySummary,
    GROUPS: GROUPS, SIZE_NAME: SIZE_NAME, pack: pack, moveTo: moveTo, moveBy: moveBy, resize: resize, remove: remove, add: add, describe: describe,
    DESK_COLS: DESK_COLS, DESK_MAX_Y: DESK_MAX_Y, DESK_CELLS: DESK_CELLS, deskBoard: deskBoard, deskMoveBy: deskMoveBy, deskMoveTo: deskMoveTo, deskSwap: deskSwap,
    deskResize: deskResize, deskSizeTo: deskSizeTo, deskRemove: deskRemove, deskAdd: deskAdd, describeDesk: describeDesk,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSHomeLogic = api;
})(typeof window !== 'undefined' ? window : null);
