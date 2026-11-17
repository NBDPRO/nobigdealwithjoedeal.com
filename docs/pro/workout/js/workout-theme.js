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
 *
 * Only the ten built-in skins are known here. A saved custom theme, or anything else in storage, shows as the default skin.
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
  var OWN = 'nbd_wk_theme';
  var KEYS = [OWN, 'nbd_pro_theme', 'nbd-theme', 'ds-theme', 'nbd_ds_accent'];
  var laid = [];   // the inline properties the accent set last time, so a cleared accent takes them back off

  // get(key) -> the stored string or null. Same order as app.js nbdBoot. The dashboard's 'nbd-original' (this surface's 'default')
  // needs no special case: like any name that is not one of the ten skins, it comes out as 'default' below.
  function themeId(get) {
    var own = get(OWN);
    if (own && SKINS.indexOf(own) > -1) return own;   // this app's own choice
    var saved = get('nbd_pro_theme');
    if (!saved) saved = get('nbd-theme') || get('ds-theme') || 'default';
    return SKINS.indexOf(saved) > -1 ? saved : 'default';
  }

  function read(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

  function apply() {
    var html = document.documentElement;
    var id = themeId(read);
    if (html.getAttribute('data-theme') !== id) html.setAttribute('data-theme', id);
    laid.forEach(function (p) { html.style.removeProperty(p); });
    laid = [];
    var A = window.NBDAccent;
    var accent = A && typeof A.normAccent === 'function' ? A.normAccent(read(A.KEY)) : null;
    if (accent) {
      var paper = A.surfaceOf(getComputedStyle(html).getPropertyValue('--paper'), '');
      var v = A.vars(accent, paper);
      if (v) Object.keys(v).forEach(function (p) { html.style.setProperty(p, v[p]); laid.push(p); });
    }
    return id;
  }

  /** The Workout app's own skin, or '' when it follows Daily Success. */
  function own() { var v = read(OWN); return v && SKINS.indexOf(v) > -1 ? v : ''; }
  /** Pick this app's own skin (a skin id), or go back to following Daily Success (anything else). Returns what is now set. */
  function setOwn(id) {
    var next = typeof id === 'string' && SKINS.indexOf(id) > -1 ? id : '';
    try { if (next) localStorage.setItem(OWN, next); else localStorage.removeItem(OWN); } catch (_) { /* blocked storage: nothing to show differently */ }
    apply();
    if (window.NBDLook && typeof window.NBDLook.changed === 'function') window.NBDLook.changed();
    return own();
  }

  apply();
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') apply(); });
  window.addEventListener('storage', function (ev) { if (!ev || ev.key == null || KEYS.indexOf(ev.key) > -1) apply(); });

  window.NBDWorkoutTheme = { SKINS: SKINS, themeId: themeId, apply: apply, own: own, setOwn: setOwn };
})();
