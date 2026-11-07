/**
 * layouts/os-wm-logic.js — the pure half of the NBD OS layout (2026-11-06,
 * NBD OS phases 2-3; plan: documentation/projects/NBD-OS-PLAN-2026-11-06.md).
 *
 * No DOM, no clock, no storage: the window manager's geometry and the phone
 * home screen's paging, tested in plain Node (tests/nbd-os-layout-2026-11-06.test.js).
 *
 * Window rects are kept as FRACTIONS of the desktop area ({x,y,w,h} in 0..1),
 * so a layout saved on a 1920px monitor restores sensibly on a 1280px laptop.
 *
 *   Desktop / windows
 *     clampFrac(r)               keep a rect on screen and at least MIN big
 *     toPx / toFrac              convert against a { w, h } desk size
 *     snapZone(pt, desk)         'left' | 'right' | 'max' | 'tl' | 'tr' | 'bl' | 'br' | null
 *     zoneFrac(zone)             the rect a snap zone means
 *     cascadeFrac(n)             where the nth new window opens
 *     front(wins, id)            raise one window (z 1..n, no gaps)
 *     nextFocus(wins, closedId)  who gets focus after a close / minimise
 *     orderApps(apps, order)     icons in the saved order, new apps at the end
 *     normalizeState(raw, ids)   a saved state made safe (known apps only, bounded)
 *   Phone
 *     pages(apps, perPage)       the home screen pages
 *     pushRecent(list, id)       the app switcher list, newest first, capped
 *     dockApps(apps, wanted)     four dock slots
 *
 * Classic script: window.NBDOSWm; require()-able for tests.
 */
(function (root) {
  'use strict';

  var MIN_W = 0.22, MIN_H = 0.25;   // a window is never smaller than this share of the desk
  var MAX_WINS = 12;                // open windows kept in the saved state
  var MAX_RECENT = 8;
  var ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  /** A rect in desk fractions, on screen (its title bar always reachable) and at least MIN. */
  function clampFrac(r) {
    var x = r || {};
    var w = clamp(num(x.w, 0.5), MIN_W, 1);
    var h = clamp(num(x.h, 0.6), MIN_H, 1);
    return {
      x: round4(clamp(num(x.x, 0), 0, 1 - w)),
      y: round4(clamp(num(x.y, 0), 0, 1 - h)),
      w: round4(w), h: round4(h),
    };
  }
  function toPx(f, desk) {
    var d = desk || { w: 0, h: 0 };
    return { x: Math.round(f.x * d.w), y: Math.round(f.y * d.h), w: Math.round(f.w * d.w), h: Math.round(f.h * d.h) };
  }
  function toFrac(px, desk) {
    var d = desk || {};
    if (!(d.w > 0) || !(d.h > 0)) return clampFrac(null);
    return clampFrac({ x: px.x / d.w, y: px.y / d.h, w: px.w / d.w, h: px.h / d.h });
  }

  /**
   * Where a window dragged to `pt` (desk px) snaps on release. Edge band is
   * 16px (24px corners) so an ordinary drag near an edge isn't hijacked.
   */
  function snapZone(pt, desk, edge) {
    var p = pt || {}, d = desk || {};
    if (!(d.w > 0) || !(d.h > 0)) return null;
    var e = edge > 0 ? edge : 16, c = e + 8;
    var x = num(p.x, -1), y = num(p.y, -1);
    if (x < 0 || y < 0 || x > d.w || y > d.h) return null;
    var left = x <= c, right = x >= d.w - c, top = y <= c, bottom = y >= d.h - c;
    if (top && left) return 'tl';
    if (top && right) return 'tr';
    if (bottom && left) return 'bl';
    if (bottom && right) return 'br';
    if (y <= e) return 'max';
    if (x <= e) return 'left';
    if (x >= d.w - e) return 'right';
    return null;
  }
  var ZONES = {
    max: { x: 0, y: 0, w: 1, h: 1 },
    left: { x: 0, y: 0, w: 0.5, h: 1 }, right: { x: 0.5, y: 0, w: 0.5, h: 1 },
    tl: { x: 0, y: 0, w: 0.5, h: 0.5 }, tr: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    bl: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, br: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  };
  /** The exact rect of a zone (quarters are allowed below MIN: that's what a quarter is). */
  function zoneFrac(zone) {
    var z = ZONES[zone];
    return z ? { x: z.x, y: z.y, w: z.w, h: z.h } : null;
  }
  /** Keyboard snapping: arrow + current zone -> next zone (Win+arrow style). */
  function keySnap(current, key) {
    var c = current || null;
    if (key === 'ArrowUp') return c === 'left' ? 'tl' : c === 'right' ? 'tr' : c === 'bl' ? 'left' : c === 'br' ? 'right' : 'max';
    if (key === 'ArrowDown') return c === 'left' ? 'bl' : c === 'right' ? 'br' : c === 'tl' ? 'left' : c === 'tr' ? 'right' : null;
    if (key === 'ArrowLeft') return c === 'right' ? null : c === 'tr' ? 'tl' : c === 'br' ? 'bl' : 'left';
    if (key === 'ArrowRight') return c === 'left' ? null : c === 'tl' ? 'tr' : c === 'bl' ? 'br' : 'right';
    return c;
  }

  /** The nth new window: a cascade from the top-left, wrapping every 6. */
  function cascadeFrac(n) {
    var k = Math.max(0, Math.floor(num(n, 0))) % 6;
    return clampFrac({ x: 0.06 + k * 0.035, y: 0.05 + k * 0.045, w: 0.62, h: 0.78 });
  }

  /** Raise `id`: it gets the top z; the rest keep their order, renumbered 1..n. */
  function front(wins, id) {
    var list = (Array.isArray(wins) ? wins : []).slice().sort(function (a, b) { return num(a.z, 0) - num(b.z, 0); });
    var top = null;
    list = list.filter(function (w) { if (w.id === id) { top = w; return false; } return true; });
    if (top) list.push(top);
    return list.map(function (w, i) { var o = {}; for (var k in w) o[k] = w[k]; o.z = i + 1; return o; });
  }
  /** After closing or minimising `goneId`: the highest visible window left, or null (the desktop). */
  function nextFocus(wins, goneId) {
    var best = null;
    (Array.isArray(wins) ? wins : []).forEach(function (w) {
      if (w.id === goneId || w.min) return;
      if (!best || num(w.z, 0) > num(best.z, 0)) best = w;
    });
    return best ? best.id : null;
  }

  /** Icons in the saved order; apps the member gained since go at the end; gone ones drop. */
  function orderApps(apps, order) {
    var list = Array.isArray(apps) ? apps : [];
    var by = {};
    list.forEach(function (a) { by[a.id] = a; });
    var out = [], used = {};
    (Array.isArray(order) ? order : []).forEach(function (id) {
      if (by[id] && !used[id]) { out.push(by[id]); used[id] = true; }
    });
    list.forEach(function (a) { if (!used[a.id]) { out.push(a); used[a.id] = true; } });
    return out;
  }

  var ZONE_NAMES = ['max', 'left', 'right', 'tl', 'tr', 'bl', 'br'];
  /**
   * A saved layoutState.os made safe: windows only for apps this member can
   * open (`known`), at most MAX_WINS, rects clamped, z renumbered; icon and
   * dock orders limited to known ids. Unknown keys are dropped, so the state
   * can never grow past the registry's 12 KB cap.
   */
  function normalizeState(raw, known) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var ok = function (id) { return typeof id === 'string' && ID_RE.test(id) && (!known || known.indexOf(id) !== -1); };
    var seen = {};
    var wins = (Array.isArray(r.wins) ? r.wins : []).filter(function (w) {
      if (!w || !ok(w.id) || seen[w.id]) return false;
      seen[w.id] = true;
      return true;
    }).slice(-MAX_WINS).map(function (w) {
      var f = clampFrac(w);
      return {
        id: w.id, x: f.x, y: f.y, w: f.w, h: f.h, z: num(w.z, 0),
        min: w.min === true, zone: ZONE_NAMES.indexOf(w.zone) !== -1 ? w.zone : null,
      };
    });
    wins = front(wins, null);
    var ids = function (arr, max) {
      var s = {};
      return (Array.isArray(arr) ? arr : []).filter(function (id) { if (!ok(id) || s[id]) return false; s[id] = true; return true; }).slice(0, max);
    };
    return {
      v: 1,
      wins: wins,
      focus: ok(r.focus) && seen[r.focus] ? r.focus : nextFocus(wins, null),
      icons: ids(r.icons, 60),
      dock: ids(r.dock, 4),
      recent: ids(r.recent, MAX_RECENT),
    };
  }

  // ── phone ──────────────────────────────────────────────────
  /** Home screen pages of `perPage` icons (default 4 columns x 5 rows). */
  function pages(apps, perPage) {
    var n = Math.max(1, Math.floor(num(perPage, 20)));
    var list = Array.isArray(apps) ? apps : [];
    var out = [];
    for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out.length ? out : [[]];
  }
  /** The app switcher: newest first, no repeats, capped. */
  function pushRecent(list, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return Array.isArray(list) ? list.slice(0, MAX_RECENT) : [];
    return [id].concat((Array.isArray(list) ? list : []).filter(function (x) { return x !== id; })).slice(0, MAX_RECENT);
  }
  var DOCK_DEFAULT = ['home', 'crm', 'schedule', 'messaging'];
  /** Four dock apps: the wanted ones the member has, topped up from the defaults, then any app. */
  function dockApps(apps, wanted) {
    var list = Array.isArray(apps) ? apps : [];
    var by = {};
    list.forEach(function (a) { by[a.id] = a; });
    var out = [], used = {};
    function add(id) { if (out.length < 4 && by[id] && !used[id]) { out.push(by[id]); used[id] = true; } }
    (Array.isArray(wanted) ? wanted : []).forEach(add);
    DOCK_DEFAULT.forEach(add);
    list.forEach(function (a) { add(a.id); });
    return out;
  }

  var api = {
    MIN_W: MIN_W, MIN_H: MIN_H, MAX_WINS: MAX_WINS, MAX_RECENT: MAX_RECENT, DOCK_DEFAULT: DOCK_DEFAULT,
    clampFrac: clampFrac, toPx: toPx, toFrac: toFrac, snapZone: snapZone, zoneFrac: zoneFrac, keySnap: keySnap,
    cascadeFrac: cascadeFrac, front: front, nextFocus: nextFocus, orderApps: orderApps, normalizeState: normalizeState,
    pages: pages, pushRecent: pushRecent, dockApps: dockApps,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSWm = api;
})(typeof window !== 'undefined' ? window : null);
