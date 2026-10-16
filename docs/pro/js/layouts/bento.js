/**
 * layouts/bento.js — L01 "Bento Board" (2026-10-12, D5 of the style integration).
 *
 * Home as a board of tiles the rep arranges: collected revenue, projected
 * pipeline, close rate, today's schedule, hail near customers, tasks, a map
 * entry — and more from the widget drawer. Every tile is a window onto what
 * the CRM already computes:
 *
 *   widget tiles  wrap NBDWidgets.WIDGETS[id].render(el) (widgets.js) unchanged,
 *                 so the numbers can never disagree with the classic Home
 *                 (revenue-month is COLLECTED money by payment date; the
 *                 pipeline tile says "projected" in its title).
 *   Today list    adopts the #todayPlan node from the Home template into a
 *                 tile (today-home.js keeps rendering into it by id) and puts
 *                 it back when the layout unmounts.
 *   hail / map    two small native tiles read window._leads (hailHit stamps by
 *                 hail-cron; lat/lng). Nothing is computed that the CRM does
 *                 not already hold.
 *
 * The board is {widgetId,x,y,w,h}[] on a 4-column grid (a phone shows two
 * columns in reading order). Edit board: drag a tile with the pointer (desktop
 * and tablet), or use the per-tile buttons / arrow keys (Shift = resize) — the
 * keyboard path is the primary one, drag is the convenience. Saved per user at
 * userSettings/{uid}.layout.layoutState.bento via LayoutEngine.saveUser; an
 * owner or company_admin can save the board as the company default
 * (companies/{id}/settings/layout.defaultWidgets.bento) that new hires start
 * from. Nothing here sends anything or writes lead data.
 *
 * Pure half (NBDBentoLogic: catalogue, sanitize, pack, move/resize, order) is
 * require()-able for tests.
 */
(function (root) {
  'use strict';

  // ── pure: the catalogue ──────────────────────────────────────────────
  // def/min/max are [w, h] in grid cells (4 columns). `kind`:
  //   widget — NBDWidgets.WIDGETS[widget].render(el)
  //   adopt  — an existing Home node moved into the tile (selector)
  //   native — rendered here from window._leads
  // `title` is the tile's honest label (revenue says collected, pipeline says
  // projected). `nav` is the view the tile's open button goes to.
  var COLS = 4;
  var MAX_TILES = 24;
  var MAX_Y = 40;

  var CATALOG = [
    { id: 'today',     title: 'Today list',             kind: 'adopt',  adopt: '#todayPlan',        def: [2, 2], min: [2, 2], max: [4, 3], nav: 'schedule', about: 'What is due today: appointments, calls owed, promises.' },
    { id: 'revenue',   title: 'Revenue · collected',    kind: 'widget', widget: 'revenue-month',    def: [1, 1], min: [1, 1], max: [2, 2], nav: 'crm',      about: 'Money collected this month, by payment date.' },
    { id: 'pipeline',  title: 'Pipeline · projected',   kind: 'widget', widget: 'pipeline-value',   def: [2, 1], min: [1, 1], max: [4, 2], nav: 'crm',      about: 'Projected value of deals still in play (not collected).' },
    { id: 'closerate', title: 'Close rate',             kind: 'widget', widget: 'win-rate',         def: [1, 1], min: [1, 1], max: [2, 2], nav: 'crm',      about: 'Won out of decided jobs.' },
    { id: 'schedule',  title: "Today's schedule",       kind: 'widget', widget: 'today-schedule',   def: [2, 2], min: [1, 1], max: [4, 3], nav: 'schedule', about: 'Appointments, job days and adjuster meetings today.' },
    { id: 'tasks',     title: 'Personal checklist',     kind: 'widget', widget: 'task-checklist',   def: [1, 2], min: [1, 1], max: [2, 3], nav: 'crm',      about: 'Your private scratch list.' },
    { id: 'hail',      title: 'Hail near customers',    kind: 'native', native: 'hail',              def: [2, 1], min: [1, 1], max: [4, 2], nav: 'crm',      about: 'Customers hail-cron stamped a hail hit on.' },
    { id: 'map',       title: 'Map',                    kind: 'native', native: 'map',               def: [1, 1], min: [1, 1], max: [2, 2], nav: 'd2d',      about: 'One tap to the map.' },
    { id: 'storm',     title: 'Storm alerts',           kind: 'widget', widget: 'storm-alerts',     def: [1, 1], min: [1, 1], max: [2, 2], nav: 'storm',    about: 'Weather alerts for your area.' },
    { id: 'hot',       title: 'Hot leads',              kind: 'widget', widget: 'hot-leads',        def: [2, 2], min: [1, 1], max: [4, 3], nav: 'crm',      about: 'Who to call first.' },
    { id: 'stale',     title: 'Stale leads',            kind: 'widget', widget: 'stale-leads',      def: [2, 1], min: [1, 1], max: [4, 3], nav: 'crm',      about: 'Leads that have gone quiet.' },
    { id: 'closeboard',title: 'Close board',            kind: 'widget', widget: 'close-board',      def: [2, 1], min: [1, 1], max: [4, 3], nav: 'closeboard', about: 'Estimates out and negotiations.' },
    { id: 'funnel',    title: 'Stage funnel',           kind: 'widget', widget: 'stage-funnel',     def: [2, 1], min: [1, 1], max: [4, 3], nav: 'crm',      about: 'Where leads sit by stage.' },
    { id: 'activity',  title: 'Recent activity',        kind: 'widget', widget: 'recent-activity',  def: [2, 2], min: [1, 1], max: [4, 3], nav: 'crm',      about: 'The latest things that happened.' },
    { id: 'estimates', title: 'Recent estimates',       kind: 'widget', widget: 'recent-estimates', def: [1, 2], min: [1, 1], max: [2, 3], nav: 'est',      about: 'Your latest estimates.' },
    { id: 'floors',    title: 'Daily floors',           kind: 'widget', widget: 'daily-floors',     def: [2, 1], min: [1, 1], max: [4, 2], nav: 'crm',      about: 'Your daily minimums.' },
    { id: 'sources',   title: 'Lead sources',           kind: 'widget', widget: 'source-breakdown', def: [1, 1], min: [1, 1], max: [2, 2], nav: 'crm',      about: 'Where leads come from.' },
    { id: 'northstar', title: 'North star goal',        kind: 'widget', widget: 'north-star',       def: [1, 1], min: [1, 1], max: [2, 2], nav: 'crm',      about: 'The one goal you set.' },
  ];
  var BY_ID = {};
  CATALOG.forEach(function (c) { BY_ID[c.id] = c; });

  // What a new person (no saved board, no company default) starts with.
  var DEFAULT_RAW = [
    { widgetId: 'today',     x: 0, y: 0, w: 2, h: 2 },
    { widgetId: 'revenue',   x: 2, y: 0, w: 1, h: 1 },
    { widgetId: 'closerate', x: 3, y: 0, w: 1, h: 1 },
    { widgetId: 'pipeline',  x: 2, y: 1, w: 2, h: 1 },
    { widgetId: 'hail',      x: 0, y: 2, w: 2, h: 1 },
    { widgetId: 'tasks',     x: 2, y: 2, w: 1, h: 2 },
    { widgetId: 'map',       x: 3, y: 2, w: 1, h: 1 },
    { widgetId: 'storm',     x: 3, y: 3, w: 1, h: 1 },
  ];

  function num(v, d) { var n = Math.round(Number(v)); return isFinite(n) ? n : d; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function clone(t) { return { widgetId: t.widgetId, x: t.x, y: t.y, w: t.w, h: t.h }; }
  function hit(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
  function byReading(a, b) { return a.y - b.y || a.x - b.x; }

  /**
   * Place every tile so none overlap and everything floats up (gravity). The
   * tile named by `pinnedId` keeps the row it was given and the others work
   * around it; with no pin it is plain compaction.
   */
  function pack(tiles, pinnedId) {
    var order = tiles.map(clone).sort(function (a, b) {
      if (pinnedId) {
        if (a.widgetId === pinnedId && b.widgetId !== pinnedId) return -1;
        if (b.widgetId === pinnedId && a.widgetId !== pinnedId) return 1;
      }
      return byReading(a, b);
    });
    var placed = [];
    function blocked(n) { for (var i = 0; i < placed.length; i++) { if (hit(n, placed[i])) return true; } return false; }
    order.forEach(function (t) {
      var n = clone(t);
      if (n.widgetId !== pinnedId) {
        n.y -= 1;                       // float up while there is room
        while (n.y >= 0 && !blocked(n)) n.y -= 1;
        n.y += 1;
        if (n.y < 0) n.y = 0;
      }
      while (blocked(n) && n.y < MAX_Y) n.y += 1;
      placed.push(n);
    });
    return placed.sort(byReading);
  }
  function compact(tiles) { return pack(tiles, null); }

  /** Anything -> a valid, packed board (or null when `raw` is not a list). */
  function sanitize(raw) {
    if (!Array.isArray(raw)) return null;
    var seen = {}, out = [];
    raw.slice(0, 64).forEach(function (t) {
      if (out.length >= MAX_TILES || !t || typeof t !== 'object') return;
      var id = t.widgetId, c = typeof id === 'string' ? BY_ID[id] : null;
      if (!c || seen[id]) return;
      seen[id] = true;
      var w = clamp(num(t.w, c.def[0]), c.min[0], c.max[0]);
      var h = clamp(num(t.h, c.def[1]), c.min[1], c.max[1]);
      out.push({ widgetId: id, x: clamp(num(t.x, 0), 0, COLS - w), y: clamp(num(t.y, 0), 0, MAX_Y), w: w, h: h });
    });
    return compact(out);
  }
  function defaultBoard() { return sanitize(DEFAULT_RAW); }

  function find(board, id) { for (var i = 0; i < board.length; i++) { if (board[i].widgetId === id) return board[i]; } return null; }
  function has(board, id) { return !!find(board, id); }
  function bottom(board) { return board.reduce(function (m, t) { return Math.max(m, t.y + t.h); }, 0); }

  function moveTo(board, id, x, y) {
    var next = board.map(clone), t = find(next, id);
    if (!t) return board;
    t.x = clamp(num(x, t.x), 0, COLS - t.w);
    t.y = clamp(num(y, t.y), 0, MAX_Y);
    return compact(pack(next, id));
  }
  function moveBy(board, id, dx, dy) {
    var t = find(board, id);
    return t ? moveTo(board, id, t.x + dx, t.y + dy) : board;
  }
  /** Phone / reading order: swap with the neighbour before (-1) or after (+1). */
  function swapOrder(board, id, dir) {
    var order = board.map(clone).sort(byReading);
    var i = -1;
    order.forEach(function (t, k) { if (t.widgetId === id) i = k; });
    var j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= order.length) return board;
    var a = order[i], b = order[j];
    var ax = a.x, ay = a.y;
    a.x = b.x; a.y = b.y; b.x = ax; b.y = ay;
    a.x = Math.min(a.x, COLS - a.w); b.x = Math.min(b.x, COLS - b.w);
    return compact(pack(order, id));
  }
  function resizeTo(board, id, w, h) {
    var next = board.map(clone), t = find(next, id), c = BY_ID[id];
    if (!t || !c) return board;
    t.w = clamp(num(w, t.w), c.min[0], c.max[0]);
    t.h = clamp(num(h, t.h), c.min[1], c.max[1]);
    t.x = Math.min(t.x, COLS - t.w);
    return compact(pack(next, id));
  }
  function resizeBy(board, id, dw, dh) {
    var t = find(board, id);
    return t ? resizeTo(board, id, t.w + dw, t.h + dh) : board;
  }
  function remove(board, id) { return compact(board.filter(function (t) { return t.widgetId !== id; })); }
  function add(board, id) {
    var c = BY_ID[id];
    if (!c || has(board, id) || board.length >= MAX_TILES) return board;
    var next = board.map(clone);
    next.push({ widgetId: id, x: 0, y: bottom(board), w: c.def[0], h: c.def[1] });
    return compact(next);
  }
  /** Catalogue entries not on the board, in catalogue order. */
  function available(board) { return CATALOG.filter(function (c) { return !has(board, c.id); }); }

  /** Pointer position -> grid cell. geo: { left, top, width, rowH, gap }. */
  function cellFromPoint(geo, px, py) {
    var cw = (geo.width - geo.gap * (COLS - 1)) / COLS;
    return {
      x: clamp(Math.floor((px - geo.left) / (cw + geo.gap)), 0, COLS - 1),
      y: Math.max(0, Math.floor((py - geo.top) / (geo.rowH + geo.gap))),
    };
  }
  function describe(board, id, phone) {
    var t = find(board, id), c = BY_ID[id];
    if (!t || !c) return '';
    var order = board.slice().sort(byReading);
    var pos = order.indexOf(t) + 1;
    return c.title + ': ' + (phone ? 'position ' + pos + ' of ' + order.length : 'column ' + (t.x + 1) + ', row ' + (t.y + 1)) +
      ', ' + t.w + ' by ' + t.h;
  }

  var LOGIC = {
    COLS: COLS, MAX_TILES: MAX_TILES, MAX_Y: MAX_Y, CATALOG: CATALOG, BY_ID: BY_ID,
    sanitize: sanitize, defaultBoard: defaultBoard, pack: pack, compact: compact,
    moveTo: moveTo, moveBy: moveBy, swapOrder: swapOrder, resizeTo: resizeTo, resizeBy: resizeBy,
    remove: remove, add: add, available: available, has: has, find: find, bottom: bottom,
    cellFromPoint: cellFromPoint, describe: describe,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = LOGIC;
  if (root) root.NBDBentoLogic = LOGIC;
  if (!root || !root.LayoutEngine) return;

  // ═══ browser half ═════════════════════════════════════════════════════
  var W = root, doc = root.document, E = root.LayoutEngine;
  var K = function () { return W.NBDLayoutKit; };
  var S = { board: [], edit: false, drawer: false, source: 'default', local: false, saveT: null, hydrateT: null };
  var rootEl = null, mounted = false, mo = null, unbind = [], adopted = null, adoptedHome = null;
  var drag = null;

  function esc(s) { return K().esc(s); }
  function isPhone() { try { return !!(W.matchMedia && W.matchMedia('(max-width: 768px)').matches); } catch (e) { return false; } }
  function canAdmin() {
    var c = W._userClaims || {};
    var role = String(c.role || '');
    if (role === 'viewer' || role === 'sales_rep' || role === 'manager') return false;
    var u = W._user && W._user.uid;
    return role === 'company_admin' || !c.companyId || c.companyId === u;
  }
  function toast(msg, kind) {
    if (typeof W.showToast === 'function') { try { W.showToast(msg, kind || 'success'); return; } catch (e) {} }
    say(msg);
  }
  function say(msg) {
    var live = rootEl && rootEl.querySelector('.bn-live');
    if (live) live.textContent = msg;
  }

  // ── which board to show ──────────────────────────────────────────────
  // own saved board > company default (new hires) > built-in default
  function resolveBoard() {
    var p = E.prefs();
    var own = p && p.user && p.user.layoutState ? p.user.layoutState.bento : null;
    var ownB = sanitize(own);
    if (ownB) return { board: ownB, source: 'user' };
    var co = p && p.company && p.company.defaultWidgets ? p.company.defaultWidgets.bento : null;
    var coB = sanitize(co);
    if (coB && coB.length) return { board: coB, source: 'company' };
    return { board: defaultBoard(), source: 'default' };
  }
  /** Does the company have a default board a reset would land on? */
  function companyBoard() {
    var p = E.prefs();
    var co = sanitize(p && p.company && p.company.defaultWidgets ? p.company.defaultWidgets.bento : null);
    return !!(co && co.length);
  }

  // ── persistence ──────────────────────────────────────────────────────
  // Resolves 'none' (nothing to save), true (saved) or false (not saved). A
  // failed save leaves the board dirty, so Done retries it and can say so
  // (audit D12: S.source flipped to 'user' on ANY result, which silenced the
  // toast, and an unchanged Done could claim a failure).
  function flushSave() {
    if (S.saveT) { clearTimeout(S.saveT); S.saveT = null; }
    if (!S.local) return Promise.resolve('none');
    S.local = false;
    return Promise.resolve(E.saveUser({ layoutState: { bento: S.board } })).then(function (r) {
      if (r && r.saved) { S.source = 'user'; return true; }
      S.local = true;
      return false;
    }, function () { S.local = true; return false; });
  }
  function scheduleSave() {
    S.local = true;
    if (S.saveT) clearTimeout(S.saveT);
    S.saveT = setTimeout(function () { S.saveT = null; flushSave(); }, 700);
  }
  function commit(next, note) {
    if (next === S.board) return;
    S.board = next;
    scheduleSave();
    applyPositions();
    if (note) say(note);
  }

  // ── tiles ────────────────────────────────────────────────────────────
  function widgetDef(c) {
    var list = W.NBDWidgets && W.NBDWidgets.WIDGETS;
    if (!list) return null;
    for (var i = 0; i < list.length; i++) { if (list[i].id === c.widget) return list[i]; }
    return null;
  }
  function bodyId(c) { return c.kind === 'widget' ? 'wb-' + c.widget : 'bn-body-' + c.id; }

  function renderNative(c, el) {
    var K0 = K(), leads = W._leads || [];
    // Before the CRM has loaded the leads, a count of them is a guess: "0
    // customers" on a board that is still loading reads as an empty business.
    // The data-refreshed hook re-renders the tile once they arrive.
    if (W._leadsLoaded !== true) {
      el.innerHTML = '<div class="bn-note" role="status">Loading your customers…</div>';
      return;
    }
    if (c.native === 'hail') {
      var rows = leads.filter(function (l) {
        var s = l && l.hailHit && Number(l.hailHit.sizeInches);
        return s > 0 && isFinite(s) && l._stageRole !== 'lost';
      }).sort(function (a, b) { return Number(b.hailHit.sizeInches) - Number(a.hailHit.sizeInches); });
      if (!rows.length) {
        el.innerHTML = '<div class="bn-note">No customers have a hail hit on record right now.</div>';
        return;
      }
      el.innerHTML = '<div class="bn-big">' + rows.length + '</div>' +
        '<div class="bn-sub">customer' + (rows.length === 1 ? '' : 's') + ' with hail near the property</div>' +
        '<ul class="bn-list">' + rows.slice(0, 4).map(function (l) {
          var href = K0.customerUrl(l.id);
          var name = esc(K0.leadName(l)), sz = Number(l.hailHit.sizeInches).toFixed(1) + '"';
          return '<li class="bn-li">' + (href ? '<a class="bn-link" href="' + esc(href) + '">' + name + '</a>' : '<span>' + name + '</span>') +
            '<span class="bn-chip">' + esc(sz) + '</span></li>';
        }).join('') + '</ul>';
      return;
    }
    if (c.native === 'map') {
      var n = leads.filter(function (l) { return l && isFinite(Number(l.lat)) && isFinite(Number(l.lng)) && (l.lat || l.lng); }).length;
      el.innerHTML = '<div class="bn-big">' + n + '</div><div class="bn-sub">customers on the map</div>' +
        '<button type="button" class="bn-go" data-bn-goto="d2d">Open the map</button>';
    }
  }

  function renderBody(c, el) {
    if (!el) return;
    try {
      if (c.kind === 'widget') {
        var d = widgetDef(c);
        if (!d) { el.innerHTML = '<div class="bn-note">This tile is not available on this screen.</div>'; return; }
        d.render(el);
      } else if (c.kind === 'native') {
        renderNative(c, el);
      }
      // 'adopt' tiles hold a moved node; nothing to render
    } catch (e) {
      el.innerHTML = '<div class="bn-note">This tile could not load.</div>';
    }
  }

  function adoptToday(cell) {
    var c = BY_ID.today;
    var body = cell && cell.querySelector('#' + bodyId(c));
    var node = doc.querySelector(c.adopt);
    if (!body || !node) { if (body) body.innerHTML = '<div class="bn-note">The Today list is not on this screen.</div>'; return; }
    if (node.parentNode !== body) {
      if (!adopted) {
        adoptedHome = doc.createComment('nbd-bento-today');
        node.parentNode.insertBefore(adoptedHome, node);
        adopted = node;
      }
      body.appendChild(node);
    }
  }
  function releaseToday() {
    if (adopted && adoptedHome && adoptedHome.parentNode) {
      adoptedHome.parentNode.insertBefore(adopted, adoptedHome);
      adoptedHome.parentNode.removeChild(adoptedHome);
    }
    adopted = null; adoptedHome = null;
  }

  function cellClasses(t) {
    return 'bn-cell bn-c' + (t.x + 1) + ' bn-r' + (t.y + 1) + ' bn-w' + t.w + ' bn-h' + t.h;
  }
  function toolsHtml(t, c) {
    function btn(act, label, glyph, off) {
      return '<button type="button" class="bn-tbtn bn-t-' + act + '" data-bn-act="' + act + '" aria-label="' + esc(label + ' ' + c.title) + '" title="' + esc(label) + '"' + (off ? ' disabled' : '') + '>' + glyph + '</button>';
    }
    var phone = isPhone();
    return '<div class="bn-tools" role="group" aria-label="Arrange ' + esc(c.title) + '">' +
      '<div class="bn-tools-name">' + esc(c.title) + '</div>' +
      '<div class="bn-tgrp">' +
        btn('left', 'Move left', '&larr;', !phone && t.x <= 0) +
        btn('up', phone ? 'Move earlier' : 'Move up', '&uarr;', false) +
        btn('down', phone ? 'Move later' : 'Move down', '&darr;', false) +
        btn('right', 'Move right', '&rarr;', !phone && t.x + t.w >= COLS) +
      '</div><div class="bn-tgrp">' +
        btn('wider', 'Make wider', '+W', t.w >= c.max[0]) +
        btn('narrower', 'Make narrower', '&minus;W', t.w <= c.min[0]) +
        btn('taller', 'Make taller', '+H', t.h >= c.max[1]) +
        btn('shorter', 'Make shorter', '&minus;H', t.h <= c.min[1]) +
        btn('remove', 'Remove', '&times;', false) +
      '</div></div>';
  }
  function cellHtml(t) {
    var c = BY_ID[t.widgetId], k = K();
    var inner = k.widget({
      id: c.id, title: c.title, size: '1x1', state: 'ok',
      body: '<div class="bn-body bn-body-' + esc(c.id) + '" id="' + esc(bodyId(c)) + '"></div>',
    });
    return '<div class="' + cellClasses(t) + '" data-bn-id="' + esc(c.id) + '" role="listitem">' + inner +
      '<button type="button" class="bn-open" data-bn-goto="' + esc(c.nav) + '" aria-label="Open ' + esc(c.title) + '">&#8599;</button>' +
      toolsHtml(t, c) + '</div>';
  }

  function barHtml() {
    var admin = canAdmin();
    var h = '<div class="bn-bar">' +
      '<h2 class="bn-heading">Your board</h2>';
    if (S.edit) {
      h += '<button type="button" class="bn-btn" data-bn-top="add" aria-expanded="' + (S.drawer ? 'true' : 'false') + '" aria-controls="bnDrawer">Add a tile</button>' +
        '<button type="button" class="bn-btn" data-bn-top="reset">Reset my board</button>';
      if (admin) {
        h += '<button type="button" class="bn-btn" data-bn-top="company-save">Save as company default</button>';
      }
      h += '<button type="button" class="bn-btn bn-btn-primary" data-bn-top="done">Done</button>';
    } else {
      h += '<button type="button" class="bn-btn" data-bn-top="edit">Edit board</button>';
    }
    return h + '</div>';
  }
  function drawerHtml() {
    var list = available(S.board);
    var h = '<div class="bn-drawer" id="bnDrawer"' + (S.edit && S.drawer ? '' : ' hidden') + '>' +
      '<div class="bn-drawer-title">Tiles you can add</div>';
    if (!list.length) h += '<div class="bn-note">Every tile is on your board.</div>';
    else {
      h += '<ul class="bn-drawer-list">' + list.map(function (c) {
        return '<li><button type="button" class="bn-add" data-bn-add="' + esc(c.id) + '"><span class="bn-add-t">' + esc(c.title) + '</span><span class="bn-add-d">' + esc(c.about) + '</span></button></li>';
      }).join('') + '</ul>';
    }
    return h + '</div>';
  }

  function render() {
    if (!rootEl) return;
    releaseToday();   // never leave #todayPlan inside nodes we are about to replace
    var order = S.board.slice().sort(byReading);
    rootEl.className = 'bn-root' + (S.edit ? ' bn-editing' : '');
    rootEl.innerHTML = barHtml() + drawerHtml() +
      (order.length ? '' : '<div class="bn-empty">Your board is empty. Choose Edit board, then Add a tile.</div>') +
      '<div class="bn-grid" role="list" aria-label="Your board">' + order.map(cellHtml).join('') + '</div>' +
      '<div class="bn-live" role="status" aria-live="polite"></div>';
    renderBodies();
    syncTabbable();
  }
  function renderBodies() {
    if (!rootEl) return;
    S.board.forEach(function (t) {
      var c = BY_ID[t.widgetId];
      if (!c) return;
      var cell = rootEl.querySelector('[data-bn-id="' + c.id + '"]');
      if (!cell) return;
      if (c.kind === 'adopt') adoptToday(cell);
      else renderBody(c, cell.querySelector('#' + bodyId(c)));
    });
  }
  function syncTabbable() {
    if (!rootEl) return;
    Array.prototype.forEach.call(rootEl.querySelectorAll('.bn-cell'), function (cell) {
      if (S.edit) cell.setAttribute('tabindex', '0'); else cell.removeAttribute('tabindex');
    });
  }

  // Move the existing cells to their new classes (and reading order) without
  // rebuilding them, so a drag or a key press never re-runs a widget.
  function applyPositions() {
    if (!rootEl) return;
    var grid = rootEl.querySelector('.bn-grid');
    if (!grid) return;
    var focused = doc.activeElement;
    var fCell = focused && focused.closest ? focused.closest('[data-bn-id]') : null;
    var fId = fCell && rootEl.contains(fCell) ? fCell.getAttribute('data-bn-id') : null;
    var fAct = fId && focused.getAttribute ? focused.getAttribute('data-bn-act') : null;
    var order = S.board.slice().sort(byReading);
    order.forEach(function (t, i) {
      var cell = grid.querySelector('[data-bn-id="' + t.widgetId + '"]');
      if (!cell) return;
      cell.className = cellClasses(t) + (cell.classList.contains('bn-dragging') ? ' bn-dragging' : '');
      var tools = cell.querySelector('.bn-tools');
      if (tools) { var fresh = doc.createElement('div'); fresh.innerHTML = toolsHtml(t, BY_ID[t.widgetId]); cell.replaceChild(fresh.firstChild, tools); }
      if (grid.children[i] !== cell) grid.insertBefore(cell, grid.children[i] || null);
    });
    // a moved / re-toolbarred node drops focus: put it back where it was
    if (fId && !focused.isConnected) {
      var cellNow = grid.querySelector('[data-bn-id="' + fId + '"]');
      var again = cellNow && fAct ? cellNow.querySelector('[data-bn-act="' + fAct + '"]:not([disabled])') : null;
      try { (again || cellNow) && (again || cellNow).focus({ preventScroll: true }); } catch (e) {}
    }
  }

  // ── actions ──────────────────────────────────────────────────────────
  function applyAct(id, act) {
    var phone = isPhone(), b = S.board, next = b;
    if (act === 'left') next = phone ? swapOrder(b, id, -1) : moveBy(b, id, -1, 0);
    else if (act === 'right') next = phone ? swapOrder(b, id, 1) : moveBy(b, id, 1, 0);
    else if (act === 'up') next = phone ? swapOrder(b, id, -1) : moveBy(b, id, 0, -1);
    else if (act === 'down') next = phone ? swapOrder(b, id, 1) : moveBy(b, id, 0, 1);
    else if (act === 'wider') next = resizeBy(b, id, 1, 0);
    else if (act === 'narrower') next = resizeBy(b, id, -1, 0);
    else if (act === 'taller') next = resizeBy(b, id, 0, 1);
    else if (act === 'shorter') next = resizeBy(b, id, 0, -1);
    else if (act === 'remove') {
      var title = BY_ID[id] ? BY_ID[id].title : 'Tile';
      S.board = remove(b, id); scheduleSave();
      render();
      say(title + ' removed. It is in Add a tile.');
      return;
    }
    if (sameBoard(next, b)) { say(describe(b, id, phone) + ' (no further)'); return; }
    commit(next, describe(next, id, phone));
  }
  function sameBoard(a, b) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      var o = find(b, a[i].widgetId);
      if (!o || o.x !== a[i].x || o.y !== a[i].y || o.w !== a[i].w || o.h !== a[i].h) return false;
    }
    return true;
  }

  function topAction(act) {
    if (act === 'edit') { S.edit = true; S.drawer = false; render(); say('Editing your board. Use the buttons on each tile, or arrow keys; Shift with an arrow resizes.'); return; }
    if (act === 'done') { S.edit = false; S.drawer = false; flushSave().then(function (ok) { if (ok === false) toast('Board kept on this screen; it could not be saved yet.', 'error'); }); render(); return; }
    if (act === 'add') { S.drawer = !S.drawer; var d = rootEl.querySelector('#bnDrawer'); if (d) d.hidden = !S.drawer; var b = rootEl.querySelector('[data-bn-top="add"]'); if (b) b.setAttribute('aria-expanded', S.drawer ? 'true' : 'false'); return; }
    if (act === 'reset') {
      // forget my board: back to the company default (new-hire board) or the
      // built-in one. It cannot be undone, so ask first (the app's own confirm
      // sheet when it is loaded; the browser's otherwise).
      var ask = W.nbdConfirm || function (m) { return Promise.resolve(W.confirm(m)); };
      Promise.resolve(ask('Reset your board? Your tile arrangement is cleared and you start again from ' +
        (companyBoard() ? 'your company\'s default board.' : 'the standard board.'))).then(function (yes) {
        if (!yes) return;
        S.local = false;
        if (S.saveT) { clearTimeout(S.saveT); S.saveT = null; }
        return Promise.resolve(E.saveUser({ layoutState: { bento: null } })).then(function () {
          var r = resolveBoard();
          S.board = r.board; S.source = r.source; render();
          say(r.source === 'company' ? 'Back to your company default board.' : 'Back to the standard board.');
        });
      });
      return;
    }
    if (act === 'company-save') {
      if (!canAdmin()) { toast('Only an owner or admin can set the company default.', 'error'); return; }
      var p = E.prefs(), merged = {};
      var cur = p && p.company && p.company.defaultWidgets ? p.company.defaultWidgets : {};
      Object.keys(cur).forEach(function (k) { merged[k] = cur[k]; });
      merged.bento = S.board;
      Promise.resolve(E.saveCompany({ defaultWidgets: merged })).then(function (r) {
        toast(r && r.saved ? 'Saved as the company default board. New hires start here.' : 'Could not save the company default. Only an owner or admin can.', r && r.saved ? 'success' : 'error');
      });
    }
  }

  function goto(target) {
    if (S.edit || !target) return;
    if (typeof W.goTo === 'function') { try { W.goTo(target); } catch (e) {} }
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t || !rootEl || !rootEl.contains(t)) return;
    var top = t.closest('[data-bn-top]');
    if (top) { ev.preventDefault(); topAction(top.getAttribute('data-bn-top')); return; }
    var addBtn = t.closest('[data-bn-add]');
    if (addBtn) {
      ev.preventDefault();
      var id = addBtn.getAttribute('data-bn-add');
      var next = add(S.board, id);
      if (next === S.board) { toast('Your board is full (24 tiles).', 'error'); return; }
      S.board = next; scheduleSave(); render();
      say((BY_ID[id] ? BY_ID[id].title : 'Tile') + ' added at the bottom.');
      var added = rootEl.querySelector('[data-bn-id="' + id + '"]');
      if (added && added.scrollIntoView) { try { added.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      return;
    }
    var actBtn = t.closest('[data-bn-act]');
    if (actBtn) {
      ev.preventDefault();
      var cell = actBtn.closest('[data-bn-id]');
      if (cell && !actBtn.disabled) applyAct(cell.getAttribute('data-bn-id'), actBtn.getAttribute('data-bn-act'));
      return;
    }
    var go = t.closest('[data-bn-goto]');
    if (go && !S.edit) { ev.preventDefault(); goto(go.getAttribute('data-bn-goto')); }
  }

  function onKey(ev) {
    if (!S.edit || !rootEl) return;
    var cell = ev.target && ev.target.classList && ev.target.classList.contains('bn-cell') ? ev.target : null;
    if (!cell) return;
    var id = cell.getAttribute('data-bn-id');
    var k = ev.key, act = null;
    if (k === 'Delete' || k === 'Backspace') act = 'remove';
    else if (k === 'ArrowLeft') act = ev.shiftKey ? 'narrower' : 'left';
    else if (k === 'ArrowRight') act = ev.shiftKey ? 'wider' : 'right';
    else if (k === 'ArrowUp') act = ev.shiftKey ? 'shorter' : 'up';
    else if (k === 'ArrowDown') act = ev.shiftKey ? 'taller' : 'down';
    if (!act) return;
    ev.preventDefault();
    applyAct(id, act);
    if (act !== 'remove') { try { var again = rootEl.querySelector('[data-bn-id="' + id + '"]'); if (again) again.focus({ preventScroll: true }); } catch (e) {} }
  }

  // ── pointer drag (desktop + tablet; a phone uses the buttons) ────────
  function gridGeo(grid) {
    var r = grid.getBoundingClientRect(), cs = W.getComputedStyle(grid);
    return {
      left: r.left, top: r.top, width: r.width,
      rowH: parseFloat(cs.gridAutoRows) || 160, gap: parseFloat(cs.columnGap) || 12,
    };
  }
  function onDown(ev) {
    if (!S.edit || isPhone() || (ev.button != null && ev.button !== 0)) return;
    var t = ev.target;
    if (!t || !t.closest || t.closest('button, a, input, select, textarea')) return;
    var cell = t.closest('.bn-cell');
    if (!cell || !rootEl.contains(cell)) return;
    var id = cell.getAttribute('data-bn-id'), tile = find(S.board, id);
    if (!tile) return;
    var grid = rootEl.querySelector('.bn-grid'), geo = gridGeo(grid), start = cellFromPoint(geo, ev.clientX, ev.clientY);
    drag = { id: id, pid: ev.pointerId, grab: { dx: start.x - tile.x, dy: start.y - tile.y }, geo: geo, grid: grid, cell: cell, moved: false };
    try { cell.setPointerCapture(ev.pointerId); } catch (e) {}
    cell.classList.add('bn-dragging');
    ev.preventDefault();
  }
  function onMove(ev) {
    if (!drag || ev.pointerId !== drag.pid) return;
    drag.geo = gridGeo(drag.grid);
    var c = cellFromPoint(drag.geo, ev.clientX, ev.clientY);
    var tile = find(S.board, drag.id);
    if (!tile) return;
    var nx = c.x - drag.grab.dx, ny = c.y - drag.grab.dy;
    if (nx === tile.x && ny === tile.y) return;
    var next = moveTo(S.board, drag.id, nx, ny);
    if (!sameBoard(next, S.board)) { drag.moved = true; S.board = next; applyPositions(); }
  }
  function onUp(ev) {
    if (!drag || ev.pointerId !== drag.pid) return;
    var d = drag; drag = null;
    d.cell.classList.remove('bn-dragging');
    try { d.cell.releasePointerCapture(d.pid); } catch (e) {}
    if (d.moved) { scheduleSave(); say(describe(S.board, d.id, false)); }
  }

  // ── lifecycle ────────────────────────────────────────────────────────
  function ensureRoot() {
    var home = doc.getElementById('view-home');
    var scroll = home && home.querySelector('.view-scroll');
    if (!scroll) return false;
    if (rootEl && rootEl.parentNode === scroll) return true;
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = doc.createElement('section');
    rootEl.id = 'nbdBentoRoot';
    rootEl.className = 'bn-root';
    rootEl.setAttribute('aria-label', 'Home board');
    var anchor = scroll.querySelector('#homeAttention') || scroll.querySelector('.page-hdr');
    if (anchor && anchor.nextSibling) scroll.insertBefore(rootEl, anchor.nextSibling);
    else scroll.appendChild(rootEl);
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('keydown', onKey);
    rootEl.addEventListener('pointerdown', onDown);
    rootEl.addEventListener('pointermove', onMove);
    rootEl.addEventListener('pointerup', onUp);
    rootEl.addEventListener('pointercancel', onUp);
    render();
    return true;
  }
  function onData(ev) {
    var src = ev && ev.detail && ev.detail.source;
    if (S.edit || !rootEl) return;
    if (src && src !== 'leads' && src !== 'invoices') return;
    // the classic grid rebuilds itself on a leads refresh and would repeat the
    // widget ids under it: empty it again after it has
    setTimeout(function () {
      var g = doc.getElementById('widgetGrid');
      if (g && !rootEl.contains(g)) g.innerHTML = '';
      renderBodies();
    }, 0);
  }

  function pollHydrate() {
    var tries = 0;
    (function tick() {
      S.hydrateT = null;
      var p = E.prefs();
      if (p && p.hydrated) {
        if (!S.local && !S.edit) {
          var r = resolveBoard();
          if (!sameBoard(r.board, S.board) || r.source !== S.source) { S.board = r.board; S.source = r.source; render(); }
        }
        return;
      }
      if (++tries < 30) S.hydrateT = setTimeout(tick, 1000);
    })();
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    var r = resolveBoard();
    S.board = r.board; S.source = r.source; S.edit = false; S.drawer = false; S.local = false;
    ensureRoot();
    var home = doc.getElementById('view-home');
    if (home && typeof MutationObserver === 'function') {
      mo = new MutationObserver(function () { if (mounted && !(rootEl && rootEl.isConnected)) ensureRoot(); });
      mo.observe(home, { childList: true });
    }
    ['nbd:data-refreshed', 'nbd:invoices-loaded', 'nbd:today-rendered'].forEach(function (n) { W.addEventListener(n, onData); });
    unbind.push(function () { ['nbd:data-refreshed', 'nbd:invoices-loaded', 'nbd:today-rendered'].forEach(function (n) { W.removeEventListener(n, onData); }); });
    pollHydrate();
  }
  function unmount() {
    mounted = false;
    if (S.local) flushSave();
    if (S.saveT) { clearTimeout(S.saveT); S.saveT = null; }
    if (S.hydrateT) { clearTimeout(S.hydrateT); S.hydrateT = null; }
    unbind.forEach(function (f) { try { f(); } catch (e) {} });
    unbind = [];
    if (mo) { mo.disconnect(); mo = null; }
    releaseToday();
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
    S.edit = false; S.drawer = false;
    // onData() kept the classic widget grid empty (its ids would have repeated
    // under the board's); give it back to Classic.
    try { if (W.NBDWidgets && typeof W.NBDWidgets.render === 'function') W.NBDWidgets.render(); } catch (e) {}
  }

  E.implement('bento', { mount: mount, unmount: unmount });
})(typeof window !== 'undefined' ? window : null);
