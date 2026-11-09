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
 *   layoutState['os-home'] = { v:1, phone:[{ id, s, cfg?, items? }], desk:[{ id, s, x, y, w, h, cfg?, items? }], wp?:{ phone, desk } }
 *
 *   id    a widget in CATALOG (unknown ids are dropped)
 *   s     'S' | 'M' | 'L' as 's' | 'm' | 'l', one the widget offers (else its default)
 *   cfg   enum values the widget declares, at most 64 chars of JSON
 *   items a Smart Stack's cards (P1): 1-4 other widget ids, each counted against the cap
 *   x y   the desk board cell (P1): 4 columns, rows of 160px, x 0-3, y 0-47
 *   w h   the cells its size takes on the desk: S 1x1, M 2x1, L 2x2 (DESK_CELLS);
 *         a saved w x h that is one of the widget's sizes wins over s
 * At most 24 per surface (P1; 12 in P0), a stack counting its cards. Phone and desk are
 * separate arrangements. A desk item saved without x / y (a P0 ordered list) is placed
 * by layouts/board-logic.js into the first gap, in list order, so an old home
 * keeps its order with no migration; the board is gravity-packed (Bento's
 * rule) and kept in reading order, which is also the one-column order below
 * 1100px.
 *   wp    (P1) each surface's wallpaper: 'tod' (time of day), 'none', or a My
 *         Skin image id; ids only, never a URL. null / absent = the default
 *         (time of day, unless My Skin is painting a picture). Kept only when
 *         a surface has one, so a home saved before P1 normalises unchanged.
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
 *   P1: needsYou(plan, opts)   the Today plan's sections as counted groups (Needs you)
 *   urgency(x) / urgencyText(u) a new lead with no reply on file (speedToLead on), else a missed
 *                              call under 30 min: the OS icon's ring and the stack's Call back
 *   frecency(apps, usage, recent) most-used-lately first (Start, phone page 1); parseUsage(raw)
 *   stormNow(cache, now)       Storm Center's cache as none / stale / clear / alert
 *   moneyMonth(invs, uid, now, collect) the member's own collected this month, in cents
 *   stackItems / weight / toggleCard   a Smart Stack's cards and the cap
 *   P2: peekAppt(plan, now)    the appointment starting within 30 min: Up Next's Peek button
 *   parseCarry(raw) / recapDue(raw, seen, uid, now)  Shutdown's carry-over and the Welcome Recap's due check
 *
 * The company home (P1): an owner or company_admin publishes one surface's
 * arrangement to companies/{cid}/settings/layout.defaultWidgets['os-phone' |
 * 'os-desk'] (ids, sizes, stack cards and desk cells; never anyone's numbers) and may lock it.
 *   companyList(defaultWidgets, surface)  that surface's published home, cleaned; null when none
 *   resolveHome({ own, company, locked, admin })
 *                              per surface: company lock > own home > company default > built-in,
 *                              -> { v, phone, desk, src: { phone, desk } }; src is
 *                              'company-lock' | 'user' | 'company-default' | 'default'. The lock
 *                              binds members, not the owner or admins who set it, and only a
 *                              surface that has a published home. A member on a company home sees
 *                              only the business half of Coach and Daily Success (their own counts).
 *   setSurface(own, surface, list)  the member's own key with one surface replaced (the other
 *                              surface stays theirs only if it already was)
 *   cleanWp / wpOf / setWp     (P1) the per-surface wallpaper id
 *   todPeriod(ms)              'dawn' | 'day' | 'dusk' | 'night' for a local time
 *   wpPaint(stored, ctx)       what a surface paints: { wp:'auto'|'tod'|'none'|'img', tod, img }
 *   tintOf(key) / setTint(key, on)  (P3 #12) the member's "colour my widgets from my picture"
 *                              switch: tint:false in the key when off, absent (on) by default
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
    // P1: reads 2 = the goals getDoc + today's doors count, in its lazy bundle (os/ds-business.js), at most every 5 min
    daily: { title: 'Daily Success', sizes: ['s', 'm', 'l'], def: 'm', reads: 2, config: { show: ['both', 'personal', 'business'] }, cat: 'you', about: 'Your floors and streak, and what is left today' },
    // P1 (os/widgets-p1.js, a runtime ScriptLoader bundle): p1 marks a renderer that lives there.
    // money: the member's role must see the Money view (and not be a viewer) or it never shows.
    needsyou: { title: 'Needs you', sizes: ['s', 'm', 'l'], def: 'm', reads: 0, cat: 'today', nav: 'crm', p1: true, about: 'What is waiting on you, by kind, one tap to each' },
    storm: { title: 'Storm', sizes: ['s', 'm'], def: 's', reads: 0, cat: 'today', nav: 'storm', p1: true, about: 'The weather alert Storm Center has cached, when there is one' },
    // names: it lists customers by name (P2: "In a home" never paints it, home-logic actHides)
    closes: { title: 'Closes this week', sizes: ['m', 'l'], def: 'm', reads: 0, cat: 'money', nav: 'crm', p1: true, names: true, about: 'Open deals most likely to close, and why' },
    money: { title: 'Money', sizes: ['s', 'm'], def: 's', reads: 0, cat: 'money', nav: 'money', money: true, p1: true, about: 'What you collected this month' },
    // a stack holds up to STACK_MAX other widgets (items), each counted against the cap
    stack: { title: 'Smart Stack', sizes: ['m', 'l'], def: 'm', reads: 0, cat: 'today', stack: true, p1: true, about: 'One card that follows your day, with Why this?' },
    // P1: the evening loop (os/shutdown.js, the lazy osshutdown bundle). The widget paints from memory;
    // the sheet it opens reads today's visits once, only on a tap: one visit_captures
    // query (NBDVisitRecorder.listAll, limit 40), so tapReads is up to 40 billed doc reads.
    shutdown: { title: 'Shutdown', sizes: ['s', 'm', 'l'], def: 'm', reads: 0, tapReads: 40, bundle: 'osshutdown', cat: 'today', nav: 'crm', names: true, about: 'From 4 PM: give every lead you touched today a next step' },
    // P2 (os/team.js, the lazy osteam bundle): the company's leaderboard/{uid} rows (functions/leaderboard-aggregate.js),
    // one query of at most 50 docs, at most every refreshMin minutes, only while painted. owner: the solo owner, the
    // company-keyed owner or a company_admin; nobody else ever gets it painted or offered.
    // id teamboard, not team: .os-hw-team is the layout's Publish / Lock group (layouts/os.js, home.css)
    // names: it lists teammates by name, so "In a home" never paints it (actHides)
    teamboard: { title: 'Team', sizes: ['s', 'm', 'l'], def: 'm', reads: 50, refreshMin: 5, owner: true, bundle: 'osteam', cat: 'today', names: true, about: 'Your team\'s doors, appointments, estimates and deals, today and this week' },
    // P3 (os/focus.js, the lazy osfocus bundle): a knock block the rep starts by hand. A paint reads nothing;
    // tapReads: a start costs one knocks count plus Daily Success's goals refresh (1 getDoc + 1 count, its
    // 5-minute cache); each knock saved during the block one more count, and its end one final count.
    focus: { title: 'Knock block', sizes: ['s', 'm'], def: 'm', reads: 0, tapReads: 3, bundle: 'osfocus', cat: 'tools', nav: 'd2d', about: 'A 30, 60 or 90 minute canvassing block: Do Not Disturb on, doors counted' },
  };
  var GROUPS = [{ id: 'today', title: 'Today' }, { id: 'money', title: 'Money' }, { id: 'you', title: 'You' }, { id: 'tools', title: 'Tools' }];
  var SIZE_NAME = { s: 'small', m: 'medium', l: 'large' };
  var ORDER = ['glance', 'upnext', 'shortcuts', 'coach', 'daily', 'needsyou', 'storm', 'closes', 'money', 'stack', 'shutdown', 'teamboard', 'focus'];
  var STACK_MAX = 4;
  // the stack's own cards when none are saved: one per Smart Stack rule (os/stack-logic.js)
  // (P2: Shutdown in Coach's place, so the evening rule has its card; Coach was only its fallback.
  // The P1 default already held four, so this replaces Coach rather than adding Shutdown. It reaches
  // a new stack, and a saved stack with no valid card left (stackItems below); saved cards are kept.)
  var STACK_DEFAULT = ['upnext', 'storm', 'daily', 'shutdown'];
  var DEFAULT = [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'shortcuts', s: 's' }];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function known(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, id); }
  function ids() { return ORDER.slice(); }
  function copyList(list) { return list.map(function (it) { var o = { id: it.id, s: it.s }; if (it.cfg) o.cfg = JSON.parse(JSON.stringify(it.cfg)); if (it.items) o.items = it.items.slice(); return o; }); }
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
    if (c.stack) o.items = stackItems(it.items);
    return o;
  }
  /** A stack's cards: known, not a stack, no repeats, at most STACK_MAX; none valid -> the default set. */
  function stackItems(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (id) {
      if (known(id) && !CATALOG[id].stack && out.indexOf(id) === -1 && out.length < STACK_MAX) out.push(id);
    });
    return out.length ? out : STACK_DEFAULT.slice();
  }
  /** What a list costs against MAX_ITEMS: one per widget, a stack one per card it holds. */
  function weightOf(it) { return it && Array.isArray(it.items) ? Math.max(1, it.items.length) : 1; }
  function weight(list) { var n = 0; (Array.isArray(list) ? list : []).forEach(function (it) { n += weightOf(it); }); return n; }
  function cleanList(list, desk) {
    if (!Array.isArray(list)) return desk ? deskBoard(copyList(DEFAULT)) : copyList(DEFAULT);
    var out = [], used = 0;
    for (var i = 0; i < list.length && used < MAX_ITEMS; i++) {
      var it = desk ? cleanDeskItem(list[i]) : cleanItem(list[i]);
      if (it && used + weightOf(it) <= MAX_ITEMS) { out.push(it); used += weightOf(it); }
    }
    // a list that had items and lost every one was garbage; an empty list is a choice
    if (list.length && !out.length) out = copyList(DEFAULT);
    return desk ? deskBoard(out) : out;
  }
  function normalize(raw) {
    var r = isObj(raw) ? raw : {};
    var out = { v: 1 };
    SURFACES.forEach(function (s) { out[s] = cleanList(r[s], s === 'desk'); });
    var wp = isObj(r.wp) ? r.wp : {};
    var w = { phone: cleanWp(wp.phone), desk: cleanWp(wp.desk) };
    if (w.phone || w.desk) out.wp = w;
    return carryActs(r, out);
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
      cols: DESK_COLS, maxTiles: MAX_ITEMS, maxY: DESK_MAX_Y, key: '_b', kind: 'id', carry: ['s', 'cfg', 'items', '_k'],
      catalog: ORDER.map(function (id) { return { id: id, title: CATALOG[id].title, def: DESK_CELLS[CATALOG[id].def], min: [1, 1], max: [2, 2] }; }),
    });
    return board;
  }
  function toBoard(list) {
    return list.map(function (it, i) {
      var o = { _b: 'b' + i, id: it.id, x: it.x, y: it.y, w: DESK_CELLS[it.s][0], h: DESK_CELLS[it.s][1], s: it.s };
      if (it.cfg) o.cfg = JSON.parse(JSON.stringify(it.cfg));
      if (it.items) o.items = it.items.slice();
      if (it._k) o._k = it._k;
      return o;
    });
  }
  function fromBoard(b) {
    return b.slice().sort(function (a, c) { return a.y - c.y || a.x - c.x; }).map(function (t) {
      var o = { id: t.id, s: t.s, x: t.x, y: t.y, w: t.w, h: t.h };
      if (t.cfg) o.cfg = t.cfg;
      if (t.items) o.items = t.items;
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

  // ── the company home (P1) ─────────────────────────────────────
  var CO_KEY = { phone: 'os-phone', desk: 'os-desk' };
  function companyList(dw, surface) {
    var raw = isObj(dw) && CO_KEY[surface] ? dw[CO_KEY[surface]] : null;
    if (!Array.isArray(raw)) return null;
    var out = [], used = 0, desk = surface === 'desk';
    for (var i = 0; i < raw.length && used < MAX_ITEMS; i++) {
      var it = desk ? cleanDeskItem(raw[i]) : cleanItem(raw[i]);
      if (it && used + weightOf(it) <= MAX_ITEMS) { out.push(it); used += weightOf(it); }
    }
    if (raw.length && !out.length) return null;   // all garbage = nothing published
    return desk ? deskBoard(out) : out;
  }
  /** Company-level means business-level: a widget with a personal half shows only the business half. */
  function businessOnly(list) {
    return list.map(function (it) {
      var c = CATALOG[it.id].config;
      if (!c || !c.show || c.show.indexOf('business') === -1) return it;
      var o = copyItem(it);
      o.cfg = {};
      Object.keys(it.cfg || {}).forEach(function (k) { o.cfg[k] = it.cfg[k]; });
      o.cfg.show = 'business';
      return o;
    });
  }
  function resolveHome(input) {
    var inp = isObj(input) ? input : {};
    var own = isObj(inp.own) ? inp.own : null;
    var mine = own ? normalize(own) : null;
    var out = { v: 1, src: {} };
    SURFACES.forEach(function (s) {
      var co = companyList(inp.company, s);
      if (co && inp.locked === true && inp.admin !== true) { out[s] = businessOnly(co); out.src[s] = 'company-lock'; }
      else if (mine && Array.isArray(own[s])) { out[s] = mine[s]; out.src[s] = 'user'; }
      else if (co) { out[s] = inp.admin === true ? co : businessOnly(co); out.src[s] = 'company-default'; }
      else { out[s] = s === 'desk' ? deskBoard(copyList(DEFAULT)) : copyList(DEFAULT); out.src[s] = 'default'; }
    });
    if (mine && mine.wp) out.wp = mine.wp;   // the wallpaper is always the member's own
    return out;
  }
  function setSurface(own, surface, list) {
    var r = isObj(own) ? own : {};
    var out = { v: 1 };
    SURFACES.forEach(function (s) {
      if (s === surface) out[s] = cleanList(Array.isArray(list) ? list : [], s === 'desk');
      else if (Array.isArray(r[s])) out[s] = cleanList(r[s], s === 'desk');
    });
    var wp = isObj(r.wp) ? { phone: cleanWp(r.wp.phone), desk: cleanWp(r.wp.desk) } : null;
    if (wp && (wp.phone || wp.desk)) out.wp = wp;
    return carryActs(r, out);
  }

  // ── wallpaper (P1, design §3.6) ──────────────────────────────
  // Built-ins, or a My Skin per-theme image id (my-skin-logic.js IMAGE_ID_RE).
  // Never a URL or a path: the picture is read by My Skin under its own rules.
  var WP_BUILTIN = ['tod', 'none'];
  var WP_IMAGE_RE = /^[a-z0-9]{8,16}$/;
  function cleanWp(v) { return typeof v === 'string' && (WP_BUILTIN.indexOf(v) !== -1 || WP_IMAGE_RE.test(v)) ? v : null; }
  function wpOf(key, surface) { var k = normalize(key); return k.wp && SURFACES.indexOf(surface) !== -1 ? k.wp[surface] : null; }
  /**
   * A new key with one surface's wallpaper set (null = back to the default); the other surface's
   * wallpaper kept. Like setSurface, only the widget lists the member saved are kept (cleaned):
   * a member still on the company home (P1) stays on it after picking a wallpaper.
   */
  function setWp(key, surface, v) {
    var r = isObj(key) ? key : {};
    var out = { v: 1 };
    SURFACES.forEach(function (s) { if (Array.isArray(r[s])) out[s] = cleanList(r[s], s === 'desk'); });
    var old = isObj(r.wp) ? r.wp : {};
    var w = { phone: cleanWp(old.phone), desk: cleanWp(old.desk) };
    if (SURFACES.indexOf(surface) !== -1) w[surface] = cleanWp(v);
    if (w.phone || w.desk) out.wp = w;
    return carryActs(r, out);
  }
  /** Fixed local hours: dawn 5-8, day 8-17, dusk 17-20, night 20-5. */
  function todPeriod(ms) {
    var d = new Date(Number(ms));
    var m = d.getHours() * 60 + d.getMinutes();
    if (!isFinite(m)) return 'day';
    return m >= 300 && m < 480 ? 'dawn' : m >= 480 && m < 1020 ? 'day' : m >= 1020 && m < 1200 ? 'dusk' : 'night';
  }
  /**
   * What a surface paints. stored: wpOf(); ctx: { now, sun } (sun: Sunlight is on,
   * which forces day). auto = the default: time of day, but a picture My Skin
   * paints shows through (css/layouts/os.css decides that from My Skin's own class).
   */
  function wpPaint(stored, ctx) {
    var c = ctx || {};
    var v = cleanWp(stored);
    var tod = c.sun ? 'day' : todPeriod(c.now);
    if (!v) return { wp: 'auto', tod: tod, img: null };
    if (v === 'tod' || v === 'none') return { wp: v, tod: tod, img: null };
    return { wp: 'img', tod: tod, img: v };
  }

  // ── Activities and Focus modes (P2, design §6.3, uncommon #3) ──
  // At most 4 named modes, each with a phone face (its name, focus, own widgets and wallpaper)
  // and a laptop face (desk N of 4 is the Nth mode's job-phase workspace: Leads, Inspect/Claim,
  // Build, Collect). acts is absent until the member renames a mode or gives one its own
  // widgets; then all four are written. on = which mode is on, per surface (on.desk non-null:
  // the desks are workspaces, the one showing is the one on). Switching is manual only: nothing
  // here or anywhere in the OS sets `on` except a tap, a key or a Spotlight action.
  var ACT_MAX = 4;
  var ACT_ITEMS = 8;        // a mode's own widgets per surface, a stack counting its cards (the max fill)
  var ACT_NAME_MAX = 24;
  var PHASES = ['leads', 'inspect', 'build', 'collect'];
  var PHASE_NAME = { leads: 'Leads', inspect: 'Inspect/Claim', build: 'Build', collect: 'Collect' };
  // focus: phase (Up Next and Needs you show that phase's leads only), privacy ("In a home":
  // no money, no other customer's name, only time-sensitive toasts). A preset's phone list is
  // its own widgets; with none the mode shows the member's home.
  var ACT_PRESETS = [
    { id: 'canvass', name: 'Canvassing', focus: { phase: 'leads' }, phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'shortcuts', s: 's' }] },
    { id: 'inhome', name: 'In a home', focus: { privacy: true }, phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }] },
    { id: 'storm', name: 'Storm day', focus: {}, phone: [{ id: 'storm', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'needsyou', s: 'm' }] },
    { id: 'office', name: 'Office', focus: {} },
  ];
  function actIdx(id) { for (var i = 0; i < ACT_PRESETS.length; i++) if (ACT_PRESETS[i].id === id) return i; return -1; }
  function cleanName(v, fallback) {
    var n = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, ACT_NAME_MAX).trim() : '';
    return n || fallback;
  }
  function cleanFocus(f) {
    var o = {};
    if (isObj(f) && PHASES.indexOf(f.phase) !== -1) o.phase = f.phase;
    if (isObj(f) && f.privacy === true) o.privacy = true;
    return o;
  }
  /** A mode's own widget list (cleaned like a home, ACT_ITEMS at most); not a list = none (null). */
  function cleanActList(list, desk) {
    if (!Array.isArray(list)) return null;
    var out = [], used = 0;
    for (var i = 0; i < list.length && used < ACT_ITEMS; i++) {
      var it = desk ? cleanDeskItem(list[i]) : cleanItem(list[i]);
      if (it && used + weightOf(it) <= ACT_ITEMS) { out.push(it); used += weightOf(it); }
    }
    return desk ? deskBoard(out) : out;
  }
  function wpPair(v) {
    var w = isObj(v) ? { phone: cleanWp(v.phone), desk: cleanWp(v.desk) } : null;
    return w && (w.phone || w.desk) ? w : null;
  }
  /** One act from its stored copy (or the preset when there is none), fields in a fixed order. */
  function cleanAct(p, r) {
    var a = { id: p.id, name: cleanName(r ? r.name : null, p.name), focus: cleanFocus(r && isObj(r.focus) ? r.focus : p.focus) };
    SURFACES.forEach(function (s) {
      var l = r ? cleanActList(r[s], s === 'desk') : (p[s] ? cleanActList(p[s], s === 'desk') : null);
      if (l) a[s] = l;
    });
    var w = r ? wpPair(r.wp) : null;
    if (w) a.wp = w;
    return a;
  }
  /** Stored acts -> all four, in preset order (unknown ids and repeats dropped); not a list -> null. */
  function cleanActs(raw) {
    if (!Array.isArray(raw)) return null;
    var by = {};
    raw.forEach(function (r) { if (isObj(r) && actIdx(r.id) !== -1 && !by[r.id]) by[r.id] = r; });
    return ACT_PRESETS.map(function (p) { return cleanAct(p, by[p.id] || null); });
  }
  function cleanOn(raw) {
    if (!isObj(raw)) return null;
    var o = { phone: actIdx(raw.phone) !== -1 ? raw.phone : null, desk: actIdx(raw.desk) !== -1 ? raw.desk : null };
    return o.phone || o.desk ? o : null;
  }
  /** Copy a key's acts and on (cleaned) onto `out`: every key op keeps them. P3: and tint, the same way. */
  function carryActs(r, out) {
    var a = cleanActs(r && r.acts);
    if (a) out.acts = a;
    var on = cleanOn(r && r.on);
    if (on) out.on = on;
    if (r && r.tint === false) out.tint = false;
    return out;
  }
  // ── P3 #12: wallpaper to palette, the member's own switch ─────
  // tint:false = "don't colour my widgets from my picture"; absent = on (the default
  // for a tenant; the platform tenant never gets a wash whatever this says).
  function tintOf(key) { return !(isObj(key) && key.tint === false); }
  function setTint(key, on) {
    var out = keepKey(key);
    if (on === false) out.tint = false; else delete out.tint;
    return out;
  }
  /** The four modes of a key: its own, else the presets (a fresh copy). */
  function actsOf(key) { return cleanActs(isObj(key) && Array.isArray(key.acts) ? key.acts : []); }
  /** The member's own lists, wallpaper, acts and on, cleaned; nothing filled in (a company home stays one). */
  function keepKey(key) {
    var r = isObj(key) ? key : {};
    var out = { v: 1 };
    SURFACES.forEach(function (s) { if (Array.isArray(r[s])) out[s] = cleanList(r[s], s === 'desk'); });
    var w = wpPair(r.wp);
    if (w) out.wp = w;
    return carryActs(r, out);
  }
  function deskSlot(n) { var d = Math.floor(Number(n)); return isFinite(d) && d >= 0 && d < ACT_MAX ? d : 0; }
  /**
   * The mode on for a surface, or null: { id, slot, surface, name, focus, items, wp }.
   * phone: the mode `on.phone` names. desk: with on.desk set, the mode of the desk showing
   * (deskIdx), named for its phase, its focus that phase only. items null = the member's home.
   */
  function activeAct(key, surface, deskIdx) {
    var k = isObj(key) ? key : {};
    var on = cleanOn(k.on);
    if (!on || SURFACES.indexOf(surface) === -1 || !on[surface]) return null;
    var slot = surface === 'desk' ? deskSlot(deskIdx) : actIdx(on.phone);
    var a = actsOf(k)[slot];
    return {
      id: a.id, slot: slot, surface: surface,
      name: surface === 'desk' ? PHASE_NAME[PHASES[slot]] : a.name,
      focus: surface === 'desk' ? { phase: PHASES[slot] } : cleanFocus(a.focus),
      items: a[surface] || null, wp: a.wp ? a.wp[surface] : null,
    };
  }
  /** Turn a surface's mode on (a mode id) or off (null, or an id that is not a mode). */
  function setActOn(key, surface, id) {
    var out = keepKey(key);
    if (SURFACES.indexOf(surface) === -1) return out;
    var on = out.on || { phone: null, desk: null };
    on[surface] = actIdx(id) !== -1 ? id : null;
    if (on.phone || on.desk) out.on = on; else delete out.on;
    return out;
  }
  function withAct(key, id, fn) {
    var i = actIdx(id);
    if (i === -1) return null;
    var out = keepKey(key);
    var acts = actsOf(out);
    fn(acts[i]);
    out.acts = cleanActs(acts);
    return out;
  }
  function renameAct(key, id, name) { return withAct(key, id, function (a) { a.name = name; }); }
  /** A mode's own widgets on a surface (the edit-mode list while that mode is on). */
  function setActList(key, id, surface, list) {
    if (SURFACES.indexOf(surface) === -1) return null;
    return withAct(key, id, function (a) { a[surface] = Array.isArray(list) ? list : []; });
  }
  function setActWp(key, id, surface, v) {
    if (SURFACES.indexOf(surface) === -1) return null;
    return withAct(key, id, function (a) { var w = a.wp || { phone: null, desk: null }; w[surface] = v; a.wp = w; });
  }
  /** What a focus never paints: in privacy ("In a home"), a widget that shows money or names customers. */
  function actHides(focus, id) {
    var c = known(id) ? CATALOG[id] : null;
    return !!(c && isObj(focus) && focus.privacy === true && (c.money || c.names));
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
    if (it.items) o.items = it.items.slice();
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
    if (!known(id)) return null;
    var c = CATALOG[id];
    var it = { id: id, s: c.sizes.indexOf(s) !== -1 ? s : c.def };
    if (c.stack) it.items = STACK_DEFAULT.slice();
    if (weight(list) + weightOf(it) > MAX_ITEMS) return null;
    return list.map(copyItem).concat([it]);
  }
  /** Turn one card of the stack at i on or off (1..STACK_MAX cards, within the cap); null when it can't. */
  function toggleCard(list, i, id) {
    var it = list[i];
    if (!it || !known(it.id) || !CATALOG[it.id].stack || !known(id) || CATALOG[id].stack) return null;
    var cards = stackItems(it.items), at = cards.indexOf(id);
    if (at !== -1) { if (cards.length < 2) return null; cards.splice(at, 1); }
    else { if (cards.length >= STACK_MAX || weight(list) + 1 > MAX_ITEMS) return null; cards.push(id); }
    var out = list.map(copyItem);
    out[i].items = cards;
    return out;
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

  // ── P1 widgets: what they count, from data already in memory ──
  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
    if (t instanceof Date) return isFinite(t.getTime()) ? t.getTime() : 0;
    if (typeof t.toMillis === 'function') { var v = Number(t.toMillis()); return isFinite(v) ? v : 0; }
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (typeof t === 'string') { var p = Date.parse(t); return isFinite(p) ? p : 0; }
    return 0;
  }
  function len(a) { return Array.isArray(a) ? a.length : 0; }
  /**
   * Needs you: the Today plan's own sections as counted groups, each with its tap-through.
   * opts: money (the role may see money: else the money group is left out), waiting (urgency()
   * of kind 'lead', the new leads with no reply on file). null with no plan yet.
   *   -> { total, groups:[{ id, n, text, go }] }   (only groups with something in them)
   */
  function needsYou(plan, opts) {
    if (!isObj(plan)) return null;
    var o = opts || {};
    var groups = [];
    function g(id, n, one, many, tail, go) { if (n > 0) groups.push({ id: id, n: n, text: plural(n, one, many) + tail, go: go }); }
    var w = o.waiting && o.waiting.kind === 'lead' ? int(o.waiting.n) : 0;
    g('waiting', w, 'new lead', 'new leads', ' waiting for a reply', 'crm');
    g('calls', len(plan.calls), 'person', 'people', ' to get back to', 'calls');
    g('promises', len(plan.promises), 'promise', 'promises', ' due', 'home');
    g('followups', len(plan.promised) + len(plan.stalled), 'follow-up', 'follow-ups', ' due', 'home');
    g('estimates', len(plan.estimates), 'estimate', 'estimates', ' to follow up', 'home');
    if (o.money) g('money', len(plan.money), 'payment', 'payments', ' to collect', 'money');
    g('nns', isObj(plan.noNextStep) ? int(plan.noNextStep.count) : 0, 'lead', 'leads', ' with no next step', 'home');
    var total = 0;
    groups.forEach(function (x) { total += x.n; });
    return { total: total, groups: groups };
  }

  var LEAD_HOURS = 24;          // a lead is "new inbound" for its first day
  var CALL_MIN = 30;            // the 30-minute call-back rule (home-strips.js, coach-logic missed-calls)
  function roleOfLead(l, roleOf) {
    if (typeof l._stageRole === 'string' && l._stageRole) return l._stageRole;
    var key = String(l._stageKey || l.stage || '');
    if (typeof roleOf === 'function') { try { var r = roleOf(key); if (r) return String(r); } catch (e) { /* the key below */ } }
    return key.toLowerCase() === 'new' ? 'new' : '';
  }
  /**
   * The urgency ring (#5): someone new is waiting on the rep. -> null, or
   *   { kind:'lead', n, oldestMin, leadId }  new leads (stage role new, created in the last 24 h)
   *                                           with no firstRespondedAt, never a CSV import; only when `stamped` (the
   *                                           speedToLead feature is on, so a reply gets stamped)
   *   { kind:'call', n, oldestMin, leadId }   else: missed calls in the Today plan from the last
   *                                           30 minutes (the call-back rule)
   * leadId only when one lead / call. Nothing when the data isn't there (no leads, no plan).
   * uid (the signed-in member): a lead owned by someone else (userId, else assignedTo, the Shutdown
   * owner rule) is not counted: a manager's or owner's _leads holds the team's leads. An unowned lead
   * still counts (nobody else is on it). A missed call (P2) is the member's when its phone_calls doc's
   * userId is (callOwners: { callId: userId }, NBDHomeAttention.lastRows, by the row's callIds), else
   * when the lead it is filed on is (the lead rule above); with neither on file it counts.
   * That call check is defensive today: the plan's calls are NBDHomeAttention.lastRows, which
   * home-attention.js reads with where('userId', '==', uid), so every row is already the member's
   * and the lead fallback never runs in production. It guards a future team-wide calls read.
   */
  function urgency(x) {
    var o = isObj(x) ? x : {};
    var now = Number(o.now);
    if (!(now > 0)) return null;
    if (o.stamped === true) {
      if (!Array.isArray(o.leads)) return null;
      var uid = typeof o.uid === 'string' ? o.uid : '';
      var wait = o.leads.filter(function (l) {
        if (!isObj(l) || l.id == null || l.deleted === true || l.isProspect || l.e2eTestData) return false;
        if (l.meter === 'import' || l.importedAt) return false;   // a CSV import (data-import.js) was never inbound: nobody is waiting
        var owner = l.userId || l.assignedTo;
        if (uid && owner && String(owner) !== uid) return false;   // a teammate's lead is waiting on them
        var made = toMs(l.createdAt);
        return made > 0 && made <= now + 60000 && now - made <= LEAD_HOURS * 3600000 && !toMs(l.firstRespondedAt) && roleOfLead(l, o.roleOf) === 'new';
      });
      if (!wait.length) return null;
      var first = wait.reduce(function (a, b) { return toMs(b.createdAt) < toMs(a.createdAt) ? b : a; });
      return { kind: 'lead', n: wait.length, oldestMin: Math.max(0, Math.floor((now - toMs(first.createdAt)) / 60000)), leadId: wait.length === 1 ? String(first.id) : '' };
    }
    if (!isObj(o.plan)) return null;
    var me = typeof o.uid === 'string' ? o.uid : '';
    var owners = isObj(o.callOwners) ? o.callOwners : {};
    var leadBy = {};
    (Array.isArray(o.leads) ? o.leads : []).forEach(function (l) { if (isObj(l) && l.id != null) leadBy[String(l.id)] = l; });
    function mine(r) {
      if (!me) return true;
      var by = (Array.isArray(r.callIds) ? r.callIds : []).map(function (id) {
        var u = Object.prototype.hasOwnProperty.call(owners, String(id)) ? owners[String(id)] : '';
        return typeof u === 'string' ? u : '';
      }).filter(Boolean);
      if (by.length) return by.indexOf(me) !== -1;   // the call doc's own userId decides
      var l = r.leadId != null && Object.prototype.hasOwnProperty.call(leadBy, String(r.leadId)) ? leadBy[String(r.leadId)] : null;
      var owner = l ? (l.userId || l.assignedTo) : '';
      return !owner || String(owner) === me;
    }
    var calls = (Array.isArray(o.plan.calls) ? o.plan.calls : []).filter(function (r) {
      var t = isObj(r) && r.missed === true ? toMs(r.latestMs) : 0;
      return t > 0 && t <= now + 60000 && now - t <= CALL_MIN * 60000 && mine(r);
    });
    if (!calls.length) return null;
    var old = calls.reduce(function (a, b) { return toMs(b.latestMs) < toMs(a.latestMs) ? b : a; });
    return { kind: 'call', n: calls.length, oldestMin: Math.max(0, Math.floor((now - toMs(old.latestMs)) / 60000)), leadId: calls.length === 1 && old.leadId ? String(old.leadId) : '' };
  }
  /** The ring's words (never colour only): a short visible pill and the line added to the icon's name. */
  function urgencyText(u) {
    if (!isObj(u) || !int(u.n)) return null;
    if (u.kind === 'lead') return { app: 'crm', pill: 'New', text: plural(int(u.n), 'new lead', 'new leads') + ' waiting for a reply' };
    return { app: 'calls', pill: 'Call', text: plural(int(u.n), 'missed call', 'missed calls') + ' to return' };
  }

  /** The command palette's per-device usage counts (nbd_cmd_usage_v1) made safe: { id: count > 0 }. */
  function parseUsage(raw) {
    var m = {}, r;
    try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return m; }
    if (!isObj(r)) return m;
    Object.keys(r).forEach(function (k) { var n = Number(r[k]); if (/^[a-z0-9:_-]{1,60}$/i.test(k) && n > 0 && isFinite(n)) m[k] = n; });
    return m;
  }
  /**
   * Frecency (#13): apps the member opens often and lately first, the rest in their own order.
   * score = 3 per palette "go to" use (go-<id>, capped at 20 uses) + recency (the OS's recent
   * list, newest first: 10, 8, 6, 4, 2). Ties keep the original order; apps never used keep theirs.
   */
  function frecency(apps, usage, recent) {
    var list = Array.isArray(apps) ? apps : [];
    var u = isObj(usage) ? usage : {};
    var rec = Array.isArray(recent) ? recent : [];
    var scored = list.map(function (a, i) {
      var id = a && a.id;
      var n = Math.min(20, Number(u['go-' + id]) || 0);
      var r = rec.indexOf(id);
      return { a: a, i: i, sc: (n > 0 ? 3 * n : 0) + (r !== -1 && r < 5 ? 10 - 2 * r : 0) };
    });
    var used = scored.filter(function (x) { return x.sc > 0; }).sort(function (p, q) { return q.sc - p.sc || p.i - q.i; });
    return used.concat(scored.filter(function (x) { return !(x.sc > 0); })).map(function (x) { return x.a; });
  }

  var STORM_MS = 60 * 60000;    // Storm Center's cache is fresh for an hour (today-plan.js stormLine)
  /**
   * Storm Center's cache (localStorage nbd_storm_alerts_cache, { ts, data:[{event}] }) as a state:
   *   none (never cached) | stale (older than an hour) | clear (fresh, no alert) | alert ({ n, event, ageMin })
   */
  function stormNow(cache, now) {
    var t = Number(now);
    if (!isObj(cache) || typeof cache.ts !== 'number' || !isFinite(cache.ts) || !Array.isArray(cache.data)) return { state: 'none' };
    if (cache.ts > t + 5 * 60000 || t - cache.ts >= STORM_MS) return { state: 'stale' };
    if (!cache.data.length) return { state: 'clear', ageMin: Math.max(0, Math.floor((t - cache.ts) / 60000)) };
    var first = isObj(cache.data[0]) ? cache.data[0] : {};
    return { state: 'alert', n: cache.data.length, event: str(first.event || 'Weather alert', 60), ageMin: Math.max(0, Math.floor((t - cache.ts) / 60000)) };
  }

  /** Local midnight on the 1st of this month. */
  function monthStart(ms) { var d = new Date(Number(ms)); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
  /**
   * Money: what the member collected this month, in cents. invoices = NBDRevenue.cached();
   * only the member's own (createdBy === uid); collect = NBDRevenue.collectedBetween (its sum is
   * kept in cents and divided once, so x100 and a round give the cents back exactly).
   *   -> { cents, count } | null (no invoices loaded, no user, no collector)
   */
  function moneyMonth(invoices, uid, now, collect) {
    if (!Array.isArray(invoices) || typeof uid !== 'string' || !uid || typeof collect !== 'function') return null;
    var mine = invoices.filter(function (inv) { return isObj(inv) && inv.createdBy === uid; });
    var r = collect(mine, monthStart(now), Number(now));
    if (!isObj(r) || typeof r.total !== 'number' || !isFinite(r.total)) return null;
    return { cents: Math.round(r.total * 100), count: int(r.count) };
  }

  // ── P2 (design §6 #6, #7): the pre-flight peek and the Welcome Recap's due check ──
  var PEEK_AHEAD = 30, PEEK_GRACE = 15, RECAP_DAYS = 3;
  /**
   * The appointment the Peek button is for: the next timed one (nextAppointment's 15 minutes' grace)
   * when it starts within 30 minutes. { key, leadId, name, time, min } (min < 0: under way), else null.
   */
  function peekAppt(plan, now) {
    var list = plan && Array.isArray(plan.appointments) ? plan.appointments : [];
    var t = Number(now), best = null;
    if (!isFinite(t)) return null;
    list.forEach(function (a) {
      var s = a && !a.allDay ? Number(a.sortMs) : NaN;
      if (isFinite(s) && s >= t - PEEK_GRACE * 60000 && (!best || s < Number(best.sortMs))) best = a;
    });
    if (!best || Number(best.sortMs) - t > PEEK_AHEAD * 60000) return null;
    return { key: str(best.key, 120), leadId: best.leadId ? str(best.leadId, 120) : '', name: str(best.name) || 'Appointment',
      time: str(best.timeLabel, 40), min: Math.round((Number(best.sortMs) - t) / 60000) };
  }
  /** Shutdown's device-only carry-over (localStorage nbd_os_carry) parsed and checked, or null. */
  function parseCarry(raw) {
    var c = null;
    try { c = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
    if (!isObj(c) || c.v !== 1 || typeof c.uid !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.dk))) return null;
    function idList(v) { return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === 'string' && x; }).map(function (x) { return x.slice(0, 120); }).slice(0, 30); }
    return { uid: c.uid, dk: c.dk, leads: idList(c.leads), visits: idList(c.visits), promises: idList(c.promises) };
  }
  /**
   * Show the Welcome Recap? Only a carry-over this uid left on an earlier day (at most 3 days back,
   * so Saturday's reaches Monday), with something still on it, and not dismissed today (seen = the
   * day key the member dismissed it on).
   */
  function recapDue(raw, seen, uid, now) {
    var c = parseCarry(raw);
    if (!c || typeof uid !== 'string' || !uid || c.uid !== uid) return false;
    var today = dayKey(now);
    if (seen === today || c.dk >= today) return false;
    var d = new Date(Number(now)); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - RECAP_DAYS);
    if (c.dk < dayKey(d.getTime())) return false;
    return c.leads.length + c.visits.length + c.promises.length > 0;
  }

  var api = {
    KEY: KEY, MAX_ITEMS: MAX_ITEMS, MAX_CFG: MAX_CFG, SIZES: SIZES, SURFACES: SURFACES, CATALOG: CATALOG,
    ids: ids, defaults: defaults, normalize: normalize, cleanCfg: cleanCfg,
    CO_KEY: CO_KEY, companyList: companyList, resolveHome: resolveHome, setSurface: setSurface,
    CELLS: CELLS, pageRoom: pageRoom, upNext: upNext, nextAppointment: nextAppointment, jobsLeft: jobsLeft, glanceCounts: glanceCounts, headline: headline, noMoreLine: noMoreLine,
    dayKey: dayKey, dsLite: dsLite, dsPersonal: dsPersonal, todaySummary: todaySummary,
    STACK_MAX: STACK_MAX, STACK_DEFAULT: STACK_DEFAULT, stackItems: stackItems, weight: weight, toggleCard: toggleCard,
    needsYou: needsYou, urgency: urgency, urgencyText: urgencyText, parseUsage: parseUsage, frecency: frecency,
    stormNow: stormNow, monthStart: monthStart, moneyMonth: moneyMonth, toMs: toMs,
    PEEK_AHEAD: PEEK_AHEAD, peekAppt: peekAppt, parseCarry: parseCarry, recapDue: recapDue,
    WP_BUILTIN: WP_BUILTIN, cleanWp: cleanWp, wpOf: wpOf, setWp: setWp, todPeriod: todPeriod, wpPaint: wpPaint, tintOf: tintOf, setTint: setTint,
    GROUPS: GROUPS, SIZE_NAME: SIZE_NAME, pack: pack, moveTo: moveTo, moveBy: moveBy, resize: resize, remove: remove, add: add, describe: describe,
    DESK_COLS: DESK_COLS, DESK_MAX_Y: DESK_MAX_Y, DESK_CELLS: DESK_CELLS, deskBoard: deskBoard, deskMoveBy: deskMoveBy, deskMoveTo: deskMoveTo, deskSwap: deskSwap,
    deskResize: deskResize, deskSizeTo: deskSizeTo, deskRemove: deskRemove, deskAdd: deskAdd, describeDesk: describeDesk,
    ACT_MAX: ACT_MAX, ACT_ITEMS: ACT_ITEMS, ACT_NAME_MAX: ACT_NAME_MAX, ACT_PRESETS: ACT_PRESETS, PHASES: PHASES, PHASE_NAME: PHASE_NAME,
    actsOf: actsOf, activeAct: activeAct, setActOn: setActOn, renameAct: renameAct, setActList: setActList, setActWp: setActWp, actHides: actHides,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSHomeLogic = api;
})(typeof window !== 'undefined' ? window : null);
