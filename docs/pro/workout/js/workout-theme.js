/**
 * workout-theme.js - the Workout app wears the Daily Success theme (2026-11-17).
 *
 * Daily Success keeps its theme on the device (app.js nbdBoot: nbd_pro_theme, then the older nbd-theme / ds-theme keys) and its
 * accent in nbd_ds_accent (accent-logic.js). This file reads the same keys with the same precedence and sets data-theme on <html>;
 * the colours themselves are the token blocks in workout-app.css, mirrored from the Daily Success page. The accent is laid over
 * the skin exactly as accent-ui.js does it (NBDAccent.vars, judged against the skin's card colour).
 *
 * The apps may wear different themes (Jo, 2026-11-17): nbd_wk_theme holds the Workout app's OWN skin when one was picked on its Theme
 * control (workout-app.js). Empty, it follows Daily Success. setOwn() writes it and tells look-sync.js, which sends it with the account.
 * The accent works the same way through nbd_wk_accent and setOwnAccent(): empty follows Daily Success, 'none' is the theme's own colour
 * (what Daily Success calls "Theme default"), an accent id is that accent.
 *
 * CUSTOM THEMES (2026-11-17). Daily Success saves a custom theme as five colours in nbd-customs: { id: 'custom-<time>', name,
 * accent, bg, s (surface), tc (text), m (muted) }. There is no stylesheet block for one, so the colours are set inline here, from
 * all five (derive()). This page does NOT copy what Daily Success draws for a saved custom theme: there only the background, the
 * bar and the accent are applied and the text and muted colours are dropped, which can leave black text on a dark page. Because the
 * colours are free picks, derive() also keeps the result readable: a text colour that does not reach 4.5:1 on its surface is replaced
 * by black or white, a muted colour under 3:1 by the text colour, and an accent that cannot carry text falls back to the text colour.
 * A theme whose definition is not on this device (and has not arrived with the account) shows as the default skin.
 *
 * The keys are per device. Where the two apps share storage (Android) the Workout app follows a change at once. An installed iPhone
 * app has its own storage: there the look arrives through the account (daily-success/js/look-sync.js writes these keys and calls apply()).
 *
 * Loaded in <head> after the stylesheets and accent-logic.js, so the first paint is already in the right colours.
 * Re-applied when the app comes back to the front and when another tab changes a key. CSP: external classic script.
 */
(function () {
  'use strict';
  if (window.NBDWorkoutTheme) return;
  var SKINS = ['default', 'light', 'paper', 'contrast', 'midnight', 'forest', 'ocean', 'ember', 'graphite', 'terminal'];
  var OWN = 'nbd_wk_theme', OWN_ACCENT = 'nbd_wk_accent', CUSTOMS = 'nbd-customs';
  var KEYS = [OWN, OWN_ACCENT, CUSTOMS, 'nbd_pro_theme', 'nbd-theme', 'ds-theme', 'nbd_ds_accent'];
  var CUSTOM_ID = /^custom-[0-9]{1,16}$/, HEX = /^#[0-9a-f]{6}$/i;
  var laid = [];   // the inline properties set last time (a custom theme's colours, an accent), so the next look starts clean

  function read(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

  /** One saved custom theme with every field well formed, or null. Only these fields are kept. */
  function normCustom(c) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !CUSTOM_ID.test(c.id)) return null;
    var cols = ['accent', 'bg', 's', 'tc', 'm'];
    for (var i = 0; i < cols.length; i++) if (typeof c[cols[i]] !== 'string' || !HEX.test(c[cols[i]])) return null;
    var name = typeof c.name === 'string' ? c.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return { id: c.id, name: name || 'Custom', accent: c.accent.toLowerCase(), bg: c.bg.toLowerCase(), s: c.s.toLowerCase(), tc: c.tc.toLowerCase(), m: c.m.toLowerCase() };
  }
  /** The custom themes saved on this device (Daily Success's list), each checked. get(key) -> string or null. */
  function customs(get) {
    var list;
    try { list = JSON.parse((get || read)(CUSTOMS)); } catch (_) { list = null; }
    if (!Array.isArray(list)) return [];
    var out = [], seen = {};
    list.forEach(function (c) { var n = normCustom(c); if (n && !seen[n.id]) { seen[n.id] = true; out.push(n); } });
    return out;
  }
  function customById(id, get) {
    if (typeof id !== 'string' || !CUSTOM_ID.test(id)) return null;
    var list = customs(get);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  var known = function (id, get) { return SKINS.indexOf(id) > -1 || !!customById(id, get); };

  // get(key) -> the stored string or null. Same order as app.js nbdBoot. The dashboard's 'nbd-original' (this surface's 'default')
  // needs no special case: like any name that is neither a skin nor a custom theme saved here, it comes out as 'default' below.
  function themeId(get) {
    var own = get(OWN);
    if (own && known(own, get)) return own;   // this app's own choice
    var saved = get('nbd_pro_theme');
    if (!saved) saved = get('nbd-theme') || get('ds-theme') || 'default';
    return known(saved, get) ? saved : 'default';
  }

  // ── colour arithmetic for custom themes (WCAG relative luminance / contrast) ──
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
  /** `want` if it reaches `min`:1 on `on`, else `fallback`. */
  function readable(want, on, min, fallback) { return contrast(want, on) >= min ? want : fallback; }

  /**
   * The page's colour properties for one custom theme. Two surfaces carry text: the page (bg) and the cards / header bar (s),
   * and they can be far apart (a light page with dark cards), so each gets its own text, muted and accent-as-text colours.
   */
  function derive(c) {
    var ink = readable(c.tc, c.s, 4.5, bw(c.s));               // text on a card or the bar
    var pageInk = readable(c.tc, c.bg, 4.5, bw(c.bg));         // text on the page
    var muted = readable(c.m, c.s, 3, ink);
    var pageMuted = readable(c.m, c.bg, 3, pageInk);
    var lightBar = lum(c.s) > 0.4;
    return {
      '--bg': c.bg, '--bar': c.s, '--paper': c.s, '--input-bg': c.s,
      '--ink': ink, '--muted': muted, '--ph': muted, '--ghost': ink, '--on-dark': muted,
      '--rule': fade(ink, 0.2),
      '--ac': c.accent, '--orange': c.accent, '--gold': c.accent,
      '--ac-text': readable(c.accent, c.s, 4.5, ink), '--ac-on-dark': readable(c.accent, c.s, 4.5, ink),
      // this page's own hooks (workout-app.css): text on the page, on the bar, and on an accent-filled button
      '--wa-page-ink': pageInk, '--wa-page-muted': pageMuted, '--wa-page-ac': readable(c.accent, c.bg, 4.5, pageInk), '--wa-page-rule': fade(pageInk, 0.2),
      '--wa-bar-ink': ink, '--wa-bar-rule': fade(ink, 0.3), '--wa-on-ac': bw(c.accent),
      '--wa-ok': lightBar ? '#146c43' : '#4caf82', '--wa-err': lightBar ? '#b3261e' : '#ff8a80'
    };
  }

  function apply() {
    var html = document.documentElement;
    var id = themeId(read);
    if (html.getAttribute('data-theme') !== id) html.setAttribute('data-theme', id);
    laid.forEach(function (p) { html.style.removeProperty(p); });
    laid = [];
    var lay = function (v) { Object.keys(v).forEach(function (p) { html.style.setProperty(p, v[p]); if (laid.indexOf(p) < 0) laid.push(p); }); };
    var custom = customById(id, read);
    if (custom) lay(derive(custom));
    var A = window.NBDAccent;
    var accent = null;
    if (A && typeof A.normAccent === 'function') {
      var mine = read(OWN_ACCENT);
      // this app's own accent, or its own "no accent"; with neither, the Daily Success one
      accent = mine === 'none' ? null : (A.normAccent(mine) || A.normAccent(read(A.KEY)));
    }
    if (accent) {
      // judged against the card colour: the custom theme's surface, else the skin's --paper
      var paper = custom ? custom.s : A.surfaceOf(getComputedStyle(html).getPropertyValue('--paper'), '');
      var v = A.vars(accent, paper);
      if (v) {
        lay(v);
        if (custom) {
          // An accent over a custom theme: the list's fill always carries white text; its text tint was picked for the card,
          // so the page gets the tint that suits the page.
          var acc = null;
          for (var i = 0; i < A.ACCENTS.length; i++) if (A.ACCENTS[i].id === accent) acc = A.ACCENTS[i];
          lay({ '--wa-on-ac': '#ffffff', '--wa-page-ac': acc ? A.textFor(acc, custom.bg) : v['--ac-text'] });
        }
      }
    }
    return id;
  }

  /** The Workout app's own theme (a skin id, or a custom theme saved on this device), or '' when it follows Daily Success. */
  function own() { var v = read(OWN); return v && known(v, read) ? v : ''; }
  /** Pick this app's own theme, or go back to following Daily Success (anything that is not a known theme). Returns what is now set. */
  function setOwn(id) {
    var next = typeof id === 'string' && known(id, read) ? id : '';
    try { if (next) localStorage.setItem(OWN, next); else localStorage.removeItem(OWN); } catch (_) { /* blocked storage: nothing to show differently */ }
    apply();
    if (window.NBDLook && typeof window.NBDLook.changed === 'function') window.NBDLook.changed();
    return own();
  }

  /** The Workout app's own accent: an accent id, 'none' (the theme's own colour), or '' when it follows Daily Success. */
  function ownAccent() {
    var v = read(OWN_ACCENT), A = window.NBDAccent;
    if (v === 'none') return 'none';
    return (A && typeof A.normAccent === 'function' && A.normAccent(v)) || '';
  }
  /** Pick this app's own accent (an accent id or 'none'), or go back to following Daily Success (anything else). Returns what is now set. */
  function setOwnAccent(id) {
    var A = window.NBDAccent;
    var next = id === 'none' ? 'none' : ((A && typeof A.normAccent === 'function' && A.normAccent(id)) || '');
    try { if (next) localStorage.setItem(OWN_ACCENT, next); else localStorage.removeItem(OWN_ACCENT); } catch (_) { /* blocked storage: nothing to show differently */ }
    apply();
    if (window.NBDLook && typeof window.NBDLook.changed === 'function') window.NBDLook.changed();
    return ownAccent();
  }

  apply();
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') apply(); });
  window.addEventListener('storage', function (ev) { if (!ev || ev.key == null || KEYS.indexOf(ev.key) > -1) apply(); });

  window.NBDWorkoutTheme = { SKINS: SKINS, themeId: themeId, apply: apply, own: own, setOwn: setOwn, ownAccent: ownAccent, setOwnAccent: setOwnAccent,
    customs: customs, normCustom: normCustom, derive: derive, contrast: contrast };
})();
