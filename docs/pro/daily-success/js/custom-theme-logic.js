/**
 * custom-theme-logic.js - one place that turns a saved custom theme into colours (2026-11-17).
 *
 * A custom theme is five free colours (app.js nbdSaveCustom, stored in nbd-customs):
 *   { id: 'custom-<time>', name, accent, bg (page), s (surface: cards), tc (text), m (muted) }
 * The ten built-in skins each have a hand-checked token row in index.html. A custom theme has none, so until now Daily Success
 * applied only the page, the bar and the accent: the text and muted colours were saved and never used, cards stayed cream and
 * body text was black on whatever page colour was picked. derive() below produces the full token row from all five colours, for
 * BOTH apps (Daily Success: app.js nbdApplyTheme / nbdBoot; the Workout app: workout/js/workout-theme.js), so they draw alike.
 *
 * The page's styles were written for the built-in skins and count on a few things, so derive() keeps them true:
 *   - the header bar, tab bar and the "bands" that follow --bar carry light text. A light surface colour cannot be the bar, so the
 *     bar is then the theme's own text colour when that is dark, else a near-black (Warm Paper does the same: paper cards, dark bar).
 *   - --on-dark / --ac-on-dark must read on the bar AND on the surfaces that stay dark in every skin (the coach's logger, the
 *     week-glance panel).
 *   - --ink, --muted, --ac-text, --grn, --blu, --pur sit on the cards (--paper).
 *   - every accent-FILLED control (dozens of rules across the tracker and the coach) paints white text on --ac, as the accent
 *     picker's own list guarantees (accent-logic.js: "fill carries white text"). A picked accent too pale for white text is
 *     darkened, keeping its hue, until white reads on it. The accent as picked is still used wherever it is readable as TEXT.
 * Because the five colours are free picks, anything that would not be readable is replaced: text under 4.5:1 by black or white,
 * muted by the text colour, an accent that cannot be text by the text colour. Colours that are readable are used exactly as picked.
 *
 * Pure: no DOM, no storage writes. Loaded before app.js on Daily Success and before workout-theme.js on the Workout app.
 */
(function (root) {
  'use strict';
  var CUSTOMS = 'nbd-customs';
  var CUSTOM_ID = /^custom-[0-9]{1,16}$/, HEX = /^#[0-9a-f]{6}$/i, COLS = ['accent', 'bg', 's', 'tc', 'm'];
  // surfaces that stay dark in every skin: css/workout-coach.css .wc-ov, the week-glance panel (app.js), the onboarding banner (index.html)
  var FIXED_DARK = ['#0a0c0f', '#0a1018', '#151e2b'];

  /** One saved custom theme with every field well formed, or null. Only id, name and the five colours are kept. */
  function normCustom(c) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !CUSTOM_ID.test(c.id)) return null;
    for (var i = 0; i < COLS.length; i++) if (typeof c[COLS[i]] !== 'string' || !HEX.test(c[COLS[i]])) return null;
    var name = typeof c.name === 'string' ? c.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return { id: c.id, name: name || 'Custom', accent: c.accent.toLowerCase(), bg: c.bg.toLowerCase(), s: c.s.toLowerCase(), tc: c.tc.toLowerCase(), m: c.m.toLowerCase() };
  }
  /** The custom themes in a stored nbd-customs value (the JSON string, or null), each checked, repeats dropped. */
  function parseList(json) {
    var list;
    try { list = JSON.parse(json); } catch (_) { list = null; }
    if (!Array.isArray(list)) return [];
    var out = [], seen = {};
    list.forEach(function (c) { var n = normCustom(c); if (n && !seen[n.id]) { seen[n.id] = true; out.push(n); } });
    return out;
  }
  var isCustomId = function (id) { return typeof id === 'string' && CUSTOM_ID.test(id); };

  // ── WCAG relative luminance / contrast ──
  function rgb(hex) { var n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lum(hex) {
    var w = [0.2126, 0.7152, 0.0722], c = rgb(hex), t = 0;
    for (var i = 0; i < 3; i++) { var v = c[i] / 255; t += (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * w[i]; }
    return t;
  }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  /** Black or white, whichever reads better on `bg` (always at least 4.5:1). */
  function bw(bg) { return contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000'; }
  function fade(hex, a) { var c = rgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  /** `hex` made darker (same hue) until white text reaches 4.5:1 on it. A colour that already carries white text comes back unchanged. */
  function fillFor(hex) {
    var c = rgb(hex), out = hex;
    for (var i = 0; i < 60 && contrast('#ffffff', out) < 4.5; i++) {
      c = [c[0] * 0.94, c[1] * 0.94, c[2] * 0.94];
      out = '#' + c.map(function (v) { return Math.round(v).toString(16).padStart(2, '0'); }).join('');
    }
    return out;
  }
  /** The first of `wants` that reaches `min`:1 on every one of `ons`; else `fallback`. */
  function pick(wants, ons, min, fallback) {
    for (var i = 0; i < wants.length; i++) {
      var ok = true;
      for (var j = 0; j < ons.length; j++) if (contrast(wants[i], ons[j]) < min) { ok = false; break; }
      if (ok) return wants[i];
    }
    return fallback;
  }

  /** The full set of colour properties for one custom theme (already through normCustom). */
  function derive(c) {
    var paper = c.s;
    var ink = pick([c.tc], [paper], 4.5, bw(paper));
    var muted = pick([c.m], [paper], 4.5, ink);
    var acText = pick([c.accent], [paper], 4.5, ink);
    var lightPaper = lum(paper) > 0.4;
    var fill = fillFor(c.accent);
    // The bar carries light text: the surface if it is dark enough for that, else the theme's dark text colour, else near-black.
    var bar = pick([c.s, c.tc], ['#ffffff'], 7, '#12161c');
    var dark = [bar].concat(FIXED_DARK);
    var onDark = pick([c.m, c.tc, '#c3cfdf', '#e8eaf0'], dark, 4.5, '#ffffff');
    var acOnDark = pick([c.accent], dark, 4.5, onDark);
    // text that sits straight on the page, which can be far from the cards (a light page with dark cards)
    var pageInk = pick([c.tc, ink], [c.bg], 4.5, bw(c.bg));
    var pageMuted = pick([c.m, muted], [c.bg], 4.5, pageInk);
    var sem = function (onLight, onDarkCol) { return pick(lightPaper ? [onLight, onDarkCol] : [onDarkCol, onLight], [paper], 4.5, ink); };
    return {
      '--bg': c.bg, '--paper': paper, '--mbg': paper, '--sbg': paper, '--input-bg': paper,
      '--bar': bar, '--tabbar': bar, '--taboff': bar,
      '--ink': ink, '--stxt': ink, '--ghost': ink, '--muted': muted, '--ph': muted, '--rule': fade(ink, 0.2),
      '--ac': fill, '--orange': fill, '--ac-text': acText, '--gold': acText,
      '--on-dark': onDark, '--ac-on-dark': acOnDark, '--gold-on-dark': acOnDark, '--tt': onDark, '--tb': fade(onDark, 0.3),
      '--grn': sem('#15803d', '#34d399'), '--blu': sem('#1a3057', '#60a5fa'), '--pur': sem('#5a2a7e', '#a78bfa'),
      '--footer': pageMuted,
      '--shad': lightPaper ? '0 2px 12px rgba(0,0,0,.18)' : '0 2px 20px rgba(0,0,0,.55)',
      // hooks for text straight on the page (each page's CSS falls back to the skin's own colour)
      '--page-ink': pageInk, '--page-muted': pageMuted, '--page-ac': pick([c.accent], [c.bg], 4.5, pageInk), '--page-rule': fade(pageInk, 0.2)
    };
  }

  var api = { CUSTOMS: CUSTOMS, FIXED_DARK: FIXED_DARK, normCustom: normCustom, parseList: parseList, isCustomId: isCustomId, contrast: contrast, lum: lum, bw: bw, fillFor: fillFor, derive: derive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCustomTheme = api;
})(typeof window !== 'undefined' ? window : null);
