/**
 * layouts/board-logic.js — the pure board math, lifted from Bento (2026-11-09,
 * NBD OS P1 "Board and drag"; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.3, §4).
 *
 * The placement, gravity packing, move, resize, reading-order swap and
 * pointer-to-cell math of layouts/bento.js (NBDBentoLogic), as a factory any
 * board can configure: a column count, a tile cap, a row cap, the field that
 * names a tile, the field that names its catalogue entry, and the catalogue's
 * [w, h] def / min / max per entry. Nothing here touches the DOM, the clock,
 * storage or the network.
 *
 *   make(cfg) -> { COLS, MAX_TILES, MAX_Y, BY_ID, pack, compact, sanitize, defaultBoard,
 *                  moveTo, moveBy, swapOrder, resizeTo, resizeBy, remove, add, available,
 *                  has, find, bottom, cellFromPoint, describe, firstFit, byReading }
 *     cfg.cols      grid columns (4)
 *     cfg.maxTiles  tiles a board keeps (24)
 *     cfg.maxY      the lowest row a tile may start on (40)
 *     cfg.key       the field that names a tile on the board ('widgetId')
 *     cfg.kind      the field that names its catalogue entry (default: cfg.key)
 *     cfg.catalog   [{ id, title, def:[w,h], min:[w,h], max:[w,h] }]
 *     cfg.defaults  the board a new person starts with (sanitized)
 *     cfg.carry     extra fields each tile keeps through every op (a copy, never shared)
 *
 * Bento itself is left byte-for-byte as it shipped: make() configured with
 * Bento's catalogue gives exactly NBDBentoLogic's outputs, which
 * tests/nbd-os-board-2026-11-09.test.js proves on a table of inputs and a
 * random walk. firstFit() is the one addition (the OS desk auto-places a
 * widget saved without a position into the first gap, reading order).
 *
 * Classic script: window.NBDBoardLogic; require()-able for tests. Loaded
 * lazily with the OS layout (layout-system.js `needs`), never at boot.
 */
(function (root) {
  'use strict';

  function num(v, d) { var n = Math.round(Number(v)); return isFinite(n) ? n : d; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function hit(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
  function byReading(a, b) { return a.y - b.y || a.x - b.x; }
  function copyVal(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }

  function make(cfg) {
    var c0 = cfg || {};
    var COLS = num(c0.cols, 4) > 0 ? num(c0.cols, 4) : 4;
    var MAX_TILES = num(c0.maxTiles, 24);
    var MAX_Y = num(c0.maxY, 40);
    var KEY = typeof c0.key === 'string' && c0.key ? c0.key : 'widgetId';
    var KIND = typeof c0.kind === 'string' && c0.kind ? c0.kind : KEY;
    var CARRY = (Array.isArray(c0.carry) ? c0.carry : []).filter(function (f) { return typeof f === 'string' && f !== KEY && f !== KIND && ['x', 'y', 'w', 'h'].indexOf(f) === -1; });
    var CATALOG = Array.isArray(c0.catalog) ? c0.catalog : [];
    var BY_ID = {};
    CATALOG.forEach(function (c) { if (c && typeof c.id === 'string') BY_ID[c.id] = c; });
    var DEFAULT_RAW = Array.isArray(c0.defaults) ? c0.defaults : [];

    function entry(t) { return t && Object.prototype.hasOwnProperty.call(BY_ID, t[KIND]) ? BY_ID[t[KIND]] : null; }
    function clone(t) {
      var o = {};
      o[KEY] = t[KEY];
      if (KIND !== KEY) o[KIND] = t[KIND];
      o.x = t.x; o.y = t.y; o.w = t.w; o.h = t.h;
      CARRY.forEach(function (f) { if (t[f] !== undefined) o[f] = copyVal(t[f]); });
      return o;
    }

    /**
     * Place every tile so none overlap and everything floats up (gravity). The
     * tile named by `pinnedId` keeps the row it was given and the others work
     * around it; with no pin it is plain compaction.
     */
    function pack(tiles, pinnedId) {
      var order = tiles.map(clone).sort(function (a, b) {
        if (pinnedId) {
          if (a[KEY] === pinnedId && b[KEY] !== pinnedId) return -1;
          if (b[KEY] === pinnedId && a[KEY] !== pinnedId) return 1;
        }
        return byReading(a, b);
      });
      var placed = [];
      function blocked(n) { for (var i = 0; i < placed.length; i++) { if (hit(n, placed[i])) return true; } return false; }
      order.forEach(function (t) {
        var n = clone(t);
        if (n[KEY] !== pinnedId) {
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
        var id = t[KEY], c = typeof id === 'string' ? entry(t) : null;
        if (!c || seen[id]) return;
        seen[id] = true;
        var w = clamp(num(t.w, c.def[0]), c.min[0], c.max[0]);
        var h = clamp(num(t.h, c.def[1]), c.min[1], c.max[1]);
        var o = clone(t);
        o.x = clamp(num(t.x, 0), 0, COLS - w); o.y = clamp(num(t.y, 0), 0, MAX_Y); o.w = w; o.h = h;
        out.push(o);
      });
      return compact(out);
    }
    function defaultBoard() { return sanitize(DEFAULT_RAW); }

    function find(board, id) { for (var i = 0; i < board.length; i++) { if (board[i][KEY] === id) return board[i]; } return null; }
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
      order.forEach(function (t, k) { if (t[KEY] === id) i = k; });
      var j = i + (dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= order.length) return board;
      var a = order[i], b = order[j];
      var ax = a.x, ay = a.y;
      a.x = b.x; a.y = b.y; b.x = ax; b.y = ay;
      a.x = Math.min(a.x, COLS - a.w); b.x = Math.min(b.x, COLS - b.w);
      return compact(pack(order, id));
    }
    function resizeTo(board, id, w, h) {
      var next = board.map(clone), t = find(next, id), c = entry(t);
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
    function remove(board, id) { return compact(board.filter(function (t) { return t[KEY] !== id; })); }
    function add(board, id) {
      var c = BY_ID[id];
      if (!c || has(board, id) || board.length >= MAX_TILES) return board;
      var next = board.map(clone);
      var t = {};
      t[KEY] = id;
      if (KIND !== KEY) t[KIND] = id;
      t.x = 0; t.y = bottom(board); t.w = c.def[0]; t.h = c.def[1];
      next.push(t);
      return compact(next);
    }
    /** Catalogue entries not on the board, in catalogue order. */
    function available(board) { return CATALOG.filter(function (c) { return !has(board, c.id); }); }

    /** The first cell (reading order) a w x h tile fits in without overlapping, or under everything. */
    function firstFit(board, w, h) {
      w = clamp(num(w, 1), 1, COLS);
      h = Math.max(1, num(h, 1));
      var end = bottom(board);
      for (var y = 0; y <= end && y <= MAX_Y; y++) {
        for (var x = 0; x + w <= COLS; x++) {
          var n = { x: x, y: y, w: w, h: h }, free = true;
          for (var i = 0; i < board.length && free; i++) { if (hit(n, board[i])) free = false; }
          if (free) return { x: x, y: y };
        }
      }
      return { x: 0, y: Math.min(end, MAX_Y) };
    }

    /** Pointer position -> grid cell. geo: { left, top, width, rowH, gap }. */
    function cellFromPoint(geo, px, py) {
      var cw = (geo.width - geo.gap * (COLS - 1)) / COLS;
      return {
        x: clamp(Math.floor((px - geo.left) / (cw + geo.gap)), 0, COLS - 1),
        y: Math.max(0, Math.floor((py - geo.top) / (geo.rowH + geo.gap))),
      };
    }
    function describe(board, id, phone) {
      var t = find(board, id), c = entry(t);
      if (!t || !c) return '';
      var order = board.slice().sort(byReading);
      var pos = order.indexOf(t) + 1;
      return c.title + ': ' + (phone ? 'position ' + pos + ' of ' + order.length : 'column ' + (t.x + 1) + ', row ' + (t.y + 1)) +
        ', ' + t.w + ' by ' + t.h;
    }

    return {
      COLS: COLS, MAX_TILES: MAX_TILES, MAX_Y: MAX_Y, CATALOG: CATALOG, BY_ID: BY_ID,
      sanitize: sanitize, defaultBoard: defaultBoard, pack: pack, compact: compact,
      moveTo: moveTo, moveBy: moveBy, swapOrder: swapOrder, resizeTo: resizeTo, resizeBy: resizeBy,
      remove: remove, add: add, available: available, has: has, find: find, bottom: bottom,
      cellFromPoint: cellFromPoint, describe: describe, firstFit: firstFit, byReading: byReading,
    };
  }

  var api = { make: make, hit: hit, byReading: byReading };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDBoardLogic = api;
})(typeof window !== 'undefined' ? window : null);
