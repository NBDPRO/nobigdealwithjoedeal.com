/**
 * os/wallpaper-logic.js — the pure half of "wallpaper to palette" (2026-11-09,
 * P3 #12; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #12).
 *
 * pywal-style, inside the brand lock: when a TENANT (never the platform tenant,
 * NBD) shows one of its own My Skin pictures as the OS wallpaper, the OS home
 * surfaces get a faint wash of the picture's colour in --s and --s2, and only
 * those two tokens. The hue is My Skin's own accentFromSample; the checks are
 * My Skin's contrast() / accentCheck(), over the picture as My Skin's dim guard
 * (effectiveDim) veils it. The wash is accepted only if every text-on-surface
 * pair stays >= 4.5:1 (--t and --m always; every other theme colour that met
 * 4.5:1, or the 3:1 UI floor, on a ground keeps meeting it there); otherwise
 * there is no wash and the theme's own tokens stay (a fallback, never a
 * "nearly" colour).
 *
 * No DOM, no clock, no storage, no network. L is NBDMySkinLogic (passed in, so
 * this file needs no My Skin at load time and tests can require both).
 * Classic script: window.NBDOSWallpaperLogic; require()-able for tests. Loaded
 * only in the lazy 'oswp' ScriptLoader bundle (layouts/os.js), never at boot.
 *
 *   allowed(ctx)    whether to wash at all. ctx: { nbd, known, locked, on }:
 *                   nbd must be exactly false for a KNOWN identity (claims read
 *                   for this account), no company-enforced My Skin background,
 *                   and the member's own toggle not off (default on).
 *   avgOf(sample)   the mean colour of a 32x32 RGBA sample, '#rrggbb' or null
 *   surfaceTint(tok, sample, L, opts)
 *                   tok: the theme's { s, s2, t, m, bg, accent } as '#rrggbb',
 *                   plus more: [ '#rrggbb' ] its other colours (red, green, ...);
 *                   opts: { dim } the veil My Skin chose for this picture.
 *                   -> { ok:true, s, s2, hue, share, min } or { ok:false, why }
 */
(function (root) {
  'use strict';

  // The wash, strongest first: the first share that keeps every pair readable wins.
  var SHARES = [0.3, 0.2, 0.12, 0.06];
  var MIN = 4.5;        // text on a surface (WCAG AA body text)
  var UI_MIN = 3;       // a non-text mark on a surface (WCAG 1.4.11)
  var ACCENT_KEEP = 0.9;   // the accent keeps 90% of its contrast on --s and --s2 (a 5:1 accent may not slide to 3:1)
  var GLASS = 0.88;     // home.css / os.css: a widget is --s at 88% over the wallpaper
  var HOVER = 0.7;      // a row's hover: --s2 at 70%
  var DIM_DEFAULT = 0.55, DIM_MAX = 0.85;

  function isHex(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v); }
  function hex2(n) { var x = Math.max(0, Math.min(255, Math.round(n))).toString(16); return x.length < 2 ? '0' + x : x; }

  /** The line a pair may not fall below once washed: the highest of 4.5 / 3 it met before (none under 3). */
  function keepOf(before) { return before >= MIN ? MIN : before >= UI_MIN ? UI_MIN : 0; }

  function rgbOf(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

  function allowed(ctx) {
    var c = ctx || {};
    return c.nbd === false && c.known === true && c.locked !== true && c.on !== false;
  }

  function avgOf(data) {
    if (!data || !data.length) return null;
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 128) continue;   // a see-through pixel is not the picture
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return n ? '#' + hex2(r / n) + hex2(g / n) + hex2(b / n) : null;
  }

  function surfaceTint(tok, sample, L, opts) {
    var t = tok || {};
    if (!L || ['accentFromSample', 'contrast', 'mixHex', 'rgbToHsl', 'hslToHex'].some(function (k) { return typeof L[k] !== 'function'; })) return { ok: false, why: 'no-logic' };
    if (!['s', 's2', 't', 'm', 'bg'].every(function (k) { return isHex(t[k]); })) return { ok: false, why: 'tokens' };
    var hue = L.accentFromSample(sample);
    if (!isHex(hue)) return { ok: false, why: 'grey' };   // a grey picture has no colour to follow
    var avg = avgOf(sample);
    if (!avg) return { ok: false, why: 'grey' };
    var dv = opts && opts.dim != null ? Number(opts.dim) : NaN;
    var dim = Math.min(DIM_MAX, Math.max(0, isFinite(dv) ? dv : DIM_DEFAULT));
    // what shows behind a widget: the picture under the theme's veil (os.css --os-wp-veil)
    var behind = L.mixHex(t.bg, avg, dim);
    // the theme accent (filled buttons, focus rings) on --s and on --s2: never further under
    // accentCheck's 3:1 than it already is, and above it, no more than ACCENT_KEEP of its contrast lost
    var accFloor = isHex(t.accent) && typeof L.accentCheck === 'function' ? [t.s, t.s2].map(function (g0) {
      var a0 = L.accentCheck(t.accent, g0).ui;
      return a0 < UI_MIN ? a0 : Math.max(UI_MIN, a0 * ACCENT_KEEP);
    }) : null;
    // pywal keeps the theme's lightness and takes the picture's hue: the wash is the hue at
    // each surface's own lightness, so text contrast moves little and the theme still reads as itself
    var hh = rgbOf(hue), hs = L.rgbToHsl(hh[0], hh[1], hh[2]);
    function at(base) { var b = rgbOf(base); return L.hslToHex(hs[0], hs[1], L.rgbToHsl(b[0], b[1], b[2])[2]); }
    var wS = at(t.s), wS2 = at(t.s2);
    // every other theme colour (the accent, red, green, ...) on the theme's own grounds, before any wash
    var more = [t.accent].concat(Array.isArray(t.more) ? t.more : []).filter(isHex);
    var grounds0 = [t.s, t.s2, L.mixHex(t.s, behind, GLASS), L.mixHex(t.s2, behind, HOVER)];
    var keep = more.map(function (fg) { return grounds0.map(function (g0) { return keepOf(L.contrast(fg, g0)); }); });
    for (var i = 0; i < SHARES.length; i++) {
      var share = SHARES[i];
      var s = L.mixHex(t.s, wS, 1 - share), s2 = L.mixHex(t.s2, wS2, 1 - share);
      var grounds = [s, s2, L.mixHex(s, behind, GLASS), L.mixHex(s2, behind, HOVER)];
      var min = Infinity;
      grounds.forEach(function (gr) { [t.t, t.m].forEach(function (fg) { min = Math.min(min, L.contrast(fg, gr)); }); });
      if (min < MIN) continue;
      var held = more.every(function (fg, j) {
        return grounds.every(function (gr, k) { return L.contrast(fg, gr) >= keep[j][k] - 1e-9; });
      });
      if (!held) continue;
      if (accFloor && !([s, s2].every(function (g, k) { return L.accentCheck(t.accent, g).ui >= accFloor[k] - 1e-9; }))) continue;
      return { ok: true, s: s, s2: s2, hue: hue, share: share, min: Math.round(min * 100) / 100 };
    }
    return { ok: false, why: 'contrast' };
  }

  var api = { SHARES: SHARES, MIN: MIN, UI_MIN: UI_MIN, ACCENT_KEEP: ACCENT_KEEP, GLASS: GLASS, HOVER: HOVER, allowed: allowed, avgOf: avgOf, surfaceTint: surfaceTint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSWallpaperLogic = api;
})(typeof window !== 'undefined' ? window : null);
