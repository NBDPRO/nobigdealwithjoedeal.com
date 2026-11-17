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
 * all five. The colours come from daily-success/js/custom-theme-logic.js (NBDCustomTheme.derive), the same function Daily Success
 * uses, so the two apps draw a custom theme alike; that file also explains how unreadable picks are kept readable.
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
  var laid = [];   // the inline properties set last time (a custom theme's colours, an accent), so the next look starts clean

  function read(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

  var CT = function () { return window.NBDCustomTheme || null; };
  /** The custom themes saved on this device (Daily Success's list), each checked. get(key) -> string or null. */
  function customs(get) { var C = CT(); return C ? C.parseList((get || read)(CUSTOMS)) : []; }
  function customById(id, get) {
    var C = CT();
    if (!C || !C.isCustomId(id)) return null;
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

  function apply() {
    var html = document.documentElement;
    var id = themeId(read);
    if (html.getAttribute('data-theme') !== id) html.setAttribute('data-theme', id);
    laid.forEach(function (p) { html.style.removeProperty(p); });
    laid = [];
    var lay = function (v) { Object.keys(v).forEach(function (p) { html.style.setProperty(p, v[p]); if (laid.indexOf(p) < 0) laid.push(p); }); };
    var custom = customById(id, read);
    if (custom) lay(CT().derive(custom));
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
          // An accent over a custom theme: its text tint was picked for the card, so the page gets the tint that suits the page.
          var acc = null;
          for (var i = 0; i < A.ACCENTS.length; i++) if (A.ACCENTS[i].id === accent) acc = A.ACCENTS[i];
          lay({ '--page-ac': acc ? A.textFor(acc, custom.bg) : v['--ac-text'] });
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
    customs: customs };
})();
