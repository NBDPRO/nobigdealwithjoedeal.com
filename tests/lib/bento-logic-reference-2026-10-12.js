/**
 * tests/lib/bento-logic-reference-2026-10-12.js - Bento's board math exactly as
 * it shipped in docs/pro/js/layouts/bento.js (2026-10-12, D5) until 2026-11-09,
 * frozen here as the parity reference. bento.js now builds its math from
 * docs/pro/js/layouts/board-logic.js (NBD OS P2, one copy); the board suite
 * (tests/nbd-os-board-2026-11-09.test.js) runs both against this file on a
 * table of inputs and a 400-step random walk, so the one copy cannot drift
 * from what Bento users have saved. Do not edit the function bodies.
 *
 * make({ COLS, MAX_TILES, MAX_Y, CATALOG, DEFAULT_RAW }) -> NBDBentoLogic's surface.
 */
'use strict';
module.exports = function make(cfg) {
  var COLS = cfg.COLS, MAX_TILES = cfg.MAX_TILES, MAX_Y = cfg.MAX_Y, CATALOG = cfg.CATALOG, DEFAULT_RAW = cfg.DEFAULT_RAW;
  var BY_ID = {};
  CATALOG.forEach(function (c) { BY_ID[c.id] = c; });

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
  return LOGIC;
};
