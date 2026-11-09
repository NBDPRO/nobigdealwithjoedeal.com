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
 *     mergeOrder(order, now)     Classic's order of .content's children, learned as views are adopted
 *     restoreIndex(order, item, now)  where a released view goes back (an index into `now`)
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
  var DESKS = 4;                    // virtual desks (Linux workspaces / ChromeOS desks / macOS Spaces)
  var MAX_PINS = 8;

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

  /**
   * Classic's order of .content's children, learned as views are adopted into
   * windows: `now` (the children as they stand, some views away in windows) is
   * merged into `order`. A child not seen before goes in ahead of the first
   * child after it that is known, else last; known children keep their place.
   */
  function mergeOrder(order, now) {
    var out = (Array.isArray(order) ? order : []).slice();
    var kids = Array.isArray(now) ? now : [];
    var at = out.length;
    for (var i = kids.length - 1; i >= 0; i--) {
      var k = out.indexOf(kids[i]);
      if (k !== -1) at = k; else out.splice(at, 0, kids[i]);
    }
    return out;
  }
  /**
   * Where `item` goes back into `now` (the children that are home, in Classic's
   * relative order): the index of the first one that follows `item` in `order`,
   * else now.length (append). A released view's old next sibling may itself
   * still be in a window, so this walk, not that sibling, restores Classic's
   * column whatever order the windows close in.
   */
  function restoreIndex(order, item, now) {
    var ord = Array.isArray(order) ? order : [], kids = Array.isArray(now) ? now : [];
    var at = ord.indexOf(item);
    if (at === -1) return kids.length;
    for (var i = 0; i < kids.length; i++) if (ord.indexOf(kids[i]) > at) return i;
    return kids.length;
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
        desk: deskIndex(w.desk),
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
      desk: deskIndex(r.desk),
      pins: ids(r.pins, MAX_PINS),
    };
  }

  /** A desk number 0..DESKS-1; anything else is desk 0. */
  function deskIndex(v) {
    var n = Math.floor(Number(v));
    return isFinite(n) && n >= 0 && n < DESKS ? n : 0;
  }
  /** How many windows live on each desk: [n0, n1, n2, n3]. */
  function deskCounts(wins) {
    var out = [];
    for (var i = 0; i < DESKS; i++) out.push(0);
    (Array.isArray(wins) ? wins : []).forEach(function (w) { out[deskIndex(w.desk)]++; });
    return out;
  }
  /**
   * The taskbar / shelf: pinned apps first (in pin order, whether running or
   * not), then this desk's running windows that aren't pinned, in open order.
   * Each item: { id, pinned, running, min, here } (here = a window on this desk).
   */
  function taskItems(wins, pins, desk, order) {
    var d = deskIndex(desk);
    var byId = {};
    (Array.isArray(wins) ? wins : []).forEach(function (w) { byId[w.id] = w; });
    var out = [], used = {};
    (Array.isArray(pins) ? pins : []).forEach(function (id) {
      if (used[id] || !ID_RE.test(String(id))) return;
      used[id] = true;
      var w = byId[id];
      out.push({ id: id, pinned: true, running: !!w, min: !!(w && w.min), here: !!(w && deskIndex(w.desk) === d) });
    });
    var ord = Array.isArray(order) ? order : [];
    (Array.isArray(wins) ? wins : []).slice().sort(function (a, b) { return ord.indexOf(a.id) - ord.indexOf(b.id); }).forEach(function (w) {
      if (used[w.id] || deskIndex(w.desk) !== d) return;
      used[w.id] = true;
      out.push({ id: w.id, pinned: false, running: true, min: !!w.min, here: true });
    });
    return out;
  }
  /** Pin or unpin an app (pinned order kept, at most MAX_PINS). */
  function togglePin(pins, id) {
    var list = (Array.isArray(pins) ? pins : []).filter(function (x) { return x !== id; });
    if (list.length === (Array.isArray(pins) ? pins.length : 0) && ID_RE.test(String(id)) && list.length < MAX_PINS) list.push(id);
    return list;
  }
  /**
   * Overview (Mission Control / Activities / ChromeOS overview): n slots in a
   * grid over the desk (px), roughly matching the desk's shape, with a gap.
   */
  function overviewSlots(n, desk, gap) {
    var count = Math.max(0, Math.floor(num(n, 0)));
    var d = desk || {};
    if (!count || !(d.w > 0) || !(d.h > 0)) return [];
    var g = gap > 0 ? gap : 24;
    var cols = Math.max(1, Math.ceil(Math.sqrt(count * (d.w / d.h) / 1.4)));
    if (cols > count) cols = count;
    var rows = Math.ceil(count / cols);
    var w = (d.w - g * (cols + 1)) / cols;
    var h = (d.h - g * (rows + 1)) / rows;
    var out = [];
    for (var i = 0; i < count; i++) {
      var r = Math.floor(i / cols), c = i % cols;
      var inRow = r === rows - 1 ? count - r * cols : cols;      // centre a short last row
      var offset = (cols - inRow) * (w + g) / 2;
      out.push({ x: Math.round(g + c * (w + g) + offset), y: Math.round(g + r * (h + g)), w: Math.round(w), h: Math.round(h) });
    }
    return out;
  }
  /** The translate + scale that fits a window rect (px) inside a slot, centred, never enlarged. */
  function fitInto(rect, slot) {
    var r = rect || {}, s = slot || {};
    if (!(r.w > 0) || !(r.h > 0) || !(s.w > 0) || !(s.h > 0)) return { tx: 0, ty: 0, s: 1 };
    var k = Math.min(1, s.w / r.w, s.h / r.h);
    var tx = s.x + (s.w - r.w * k) / 2 - r.x;
    var ty = s.y + (s.h - r.h * k) / 2 - r.y;
    return { tx: Math.round(tx), ty: Math.round(ty), s: Math.round(k * 1000) / 1000 };
  }
  var BUTTON_STYLES = ['chrome', 'mac', 'linux'];
  /** Window-button style: 'chrome' (ChromeOS / Windows, the default), 'mac' or 'linux'. */
  function buttonStyle(v) { return BUTTON_STYLES.indexOf(v) !== -1 ? v : 'chrome'; }

  /**
   * Pocket's shortcut (P3, design §6 #9): Alt+` by key position (code Backquote), so
   * macOS's Option+` dead key and other layouts match too. Never with Ctrl, Cmd or Shift,
   * on auto-repeat, mid-IME, after another handler took the key, or inside a field.
   */
  function pocketKey(ev) {
    if (!ev || ev.code !== 'Backquote' || !ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return false;
    if (ev.repeat || ev.isComposing || ev.defaultPrevented) return false;
    var t = ev.target;
    return !(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable));
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

  /**
   * Apps that are a page of their own, not a view the sidebar can goTo
   * (P1, design §2: Daily Success can't be framed, X-Frame-Options DENY). Each
   * opens in the same tab, like widgets.js openDailyTracker; `nav` is the
   * sidebar item whose hidden test (role gating, the customizer) decides
   * whether the member gets the app. They go after the view apps; the dock
   * keeps its defaults (it only takes one when the member puts it there).
   */
  var LINK_APPS = [{ id: 'daily-success', label: 'Daily Success', icon: '📅', nav: 'nav-daily', href: '/pro/daily-success/' }];
  /** The link apps whose sidebar item `shown(navId)` says this member has. */
  function linkApps(shown) {
    return LINK_APPS.filter(function (a) { return typeof shown === 'function' && shown(a.nav) === true; })
      .map(function (a) { return { id: a.id, label: a.label, icon: a.icon, href: a.href }; });
  }

  var api = {
    LINK_APPS: LINK_APPS, linkApps: linkApps,
    MIN_W: MIN_W, MIN_H: MIN_H, MAX_WINS: MAX_WINS, MAX_RECENT: MAX_RECENT, DOCK_DEFAULT: DOCK_DEFAULT,
    clampFrac: clampFrac, toPx: toPx, toFrac: toFrac, snapZone: snapZone, zoneFrac: zoneFrac, keySnap: keySnap,
    cascadeFrac: cascadeFrac, front: front, nextFocus: nextFocus, orderApps: orderApps, mergeOrder: mergeOrder, restoreIndex: restoreIndex, normalizeState: normalizeState,
    pages: pages, pushRecent: pushRecent, dockApps: dockApps,
    DESKS: DESKS, MAX_PINS: MAX_PINS, BUTTON_STYLES: BUTTON_STYLES, deskIndex: deskIndex, deskCounts: deskCounts,
    taskItems: taskItems, togglePin: togglePin, overviewSlots: overviewSlots, fitInto: fitInto, buttonStyle: buttonStyle,
    pocketKey: pocketKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSWm = api;
})(typeof window !== 'undefined' ? window : null);
