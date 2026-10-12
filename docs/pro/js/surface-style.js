/**
 * NBD Pro - Surface style (Comfort tab): Solid / Tinted / Glass.
 *
 * Lives in the lazy `theme` ScriptLoader bundle (after theme-engine.js), not
 * in dashboard-ui-prefs-boot.js, to keep the render-blocking boot budget flat.
 * The pre-paint stamp stays in shape-preboot.js; dashboard-state.js kicks the
 * bundle at boot for a saved Glass user so the readability guard runs.
 * Handlers are registered on window.__NBD_CALL_REGISTRY (data-fn / data-on-input
 * in dashboard.html); nbdComfortSet({'surface'}) in dashboard-ui.js routes here,
 * loading the bundle first if it has not arrived yet.
 */
(function () {
'use strict';
function _toast(msg) { if (typeof window.showToast === 'function') window.showToast(msg, 'info'); }
// Same poll-then-read-once hydrate the other synced Comfort/Appearance prefs use.
function _nbdHydratePrefFromFirestore(field, readCurrent, apply) {
  var tries = 0;
  function poll() {
    var uid, ok;
    try {
      uid = (window._user && window._user.uid) || null;
      ok = uid && window.db && window.getDoc && window.doc;
    } catch (e) { ok = false; }
    if (!ok) { if (++tries <= 10) setTimeout(poll, 500); return; }
    try {
      (window.nbdRetryOffline || function (f) { return f(); })(function () {
        return window.getDoc(window.doc(window.db, 'userSettings', uid));
      }).then(function (snap) {
        if (!snap.exists()) return;
        var remote = snap.data() && snap.data()[field];
        if (remote && remote !== readCurrent()) apply(remote);
      }).catch(function (err) { console.warn('[' + field + '] Firestore hydrate failed:', err.message); });
    } catch (e) {}
  }
  setTimeout(poll, 250);
}
// Surface style: Solid / Tinted / Glass (Comfort tab, 2026-10-11, roadmap A4).
// Orthogonal to data-theme, data-shape and data-density. 'solid' is the
// absent-attribute no-op. Local paint never waits on the Firestore echo.
var NBD_SURFACE_KEY = 'nbd_surface_style';
var NBD_SURFACE_BLUR_KEY = 'nbd_surface_blur';
var NBD_SURFACE_FROST_KEY = 'nbd_surface_frost';
var NBD_SURFACES = ['solid', 'tinted', 'glass'];
var NBD_SURFACE_AA = 4.5;
// Pure colour helpers (tests/surface-style-2026-10-11.test.js slices these out
// by marker and checks them against theme-engine's own contrastRatio).
// <surface-pure>
function _nbdSfParse(c) {
  c = String(c || '').trim();
  var m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return null;
}
function _nbdSfLum(c) {
  var v = [c.r, c.g, c.b].map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function _nbdSfContrast(a, b) {
  var la = _nbdSfLum(a), lb = _nbdSfLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Smallest frost percent (0..100) at which text on a pane of the surface colour
// stays >= 4.5:1 over BOTH extreme backdrops (black and white). Wallpaper-
// independent on purpose: whatever shows through, the pane is readable.
// Unparsable colours answer a safe 85.
function nbdSurfaceMinFrost(text, surface) {
  var t = _nbdSfParse(text), s = _nbdSfParse(surface);
  if (!t || !s) return 85;
  for (var f = 0; f <= 100; f++) {
    var a = f / 100, ok = true;
    for (var k = 0; k < 2; k++) {
      var bd = k ? 255 : 0;
      var blended = { r: s.r * a + bd * (1 - a), g: s.g * a + bd * (1 - a), b: s.b * a + bd * (1 - a) };
      if (_nbdSfContrast(t, blended) < NBD_SURFACE_AA) { ok = false; break; }
    }
    if (ok) return f;
  }
  return 100;
}
// </surface-pure>
function _nbdSurfaceRead(key, dflt, lo, hi) {
  try {
    var n = parseInt(localStorage.getItem(key), 10);
    if (n >= lo && n <= hi) return n;
  } catch (e) {}
  return dflt;
}
// The readability guard: recompute the effective frost for the CURRENT theme
// (called on every themechange / modechange as well as on a slider move).
function nbdSurfaceGuard() {
  var html = document.documentElement;
  if (html.getAttribute('data-surface') !== 'glass') { html.style.removeProperty('--glass-frost-eff'); return; }
  var cs = getComputedStyle(html);
  var min = nbdSurfaceMinFrost(cs.getPropertyValue('--t'), cs.getPropertyValue('--s2'));
  var want = _nbdSurfaceRead(NBD_SURFACE_FROST_KEY, 68, 40, 95);
  html.style.setProperty('--glass-frost-eff', Math.max(want, min) + '%');
}
function nbdSyncSurfaceUI() {
  var mode = document.documentElement.getAttribute('data-surface') || 'solid';
  var box = document.getElementById('npm-surface-sliders');
  if (box) box.style.display = mode === 'glass' ? 'block' : 'none';
  var b = document.getElementById('npm-surface-blur');
  if (b) b.value = _nbdSurfaceRead(NBD_SURFACE_BLUR_KEY, 14, 0, 30);
  var f = document.getElementById('npm-surface-frost');
  if (f) f.value = _nbdSurfaceRead(NBD_SURFACE_FROST_KEY, 68, 40, 95);
}
function _nbdSurfaceSync(field, value) {
  try {
    var uid = (window._user && window._user.uid) || null;
    if (uid && window.db && window.doc && window.setDoc) {
      var d = {}; d[field] = value;
      window.setDoc(window.doc(window.db, 'userSettings', uid), d, { merge: true })
        .catch(function (err) { console.warn('[surface-style] Firestore sync failed:', err.message); });
    }
  } catch (e) {}
}
function nbdSetSurface(mode, save) {
  if (save === undefined) save = true;
  if (NBD_SURFACES.indexOf(mode) === -1) mode = 'solid';
  var html = document.documentElement;
  if (mode === 'solid') html.removeAttribute('data-surface');
  else html.setAttribute('data-surface', mode);
  if (document.body) {
    document.body.classList.toggle('surface-tinted', mode === 'tinted');
    document.body.classList.toggle('surface-glass', mode === 'glass');
  }
  try {
    if (mode === 'solid') localStorage.removeItem(NBD_SURFACE_KEY);
    else localStorage.setItem(NBD_SURFACE_KEY, mode);
  } catch (e) {}
  // Re-assert the user's dials on <html> (the pre-paint stamp only runs for non-solid).
  html.style.setProperty('--glass-blur', _nbdSurfaceRead(NBD_SURFACE_BLUR_KEY, 14, 0, 30) + 'px');
  html.style.setProperty('--glass-frost', _nbdSurfaceRead(NBD_SURFACE_FROST_KEY, 68, 40, 95) + '%');
  nbdSurfaceGuard();
  nbdSyncSurfaceUI();
  if (save) {
    _nbdSurfaceSync('surfaceStyle', mode);
    _toast('Surface: ' + mode.charAt(0).toUpperCase() + mode.slice(1));
  }
}
function nbdSetSurfaceBlur(px) {
  var v = Math.max(0, Math.min(30, parseInt(px, 10) || 0));
  try { localStorage.setItem(NBD_SURFACE_BLUR_KEY, String(v)); } catch (e) {}
  document.documentElement.style.setProperty('--glass-blur', v + 'px');
  _nbdSurfaceSync('surfaceBlur', v);
}
function nbdSetSurfaceFrost(pct) {
  var v = Math.max(40, Math.min(95, parseInt(pct, 10) || 68));
  try { localStorage.setItem(NBD_SURFACE_FROST_KEY, String(v)); } catch (e) {}
  document.documentElement.style.setProperty('--glass-frost', v + '%');
  nbdSurfaceGuard();
  _nbdSurfaceSync('surfaceFrost', v);
}
// Boot: mirror the pre-paint <html> stamp onto <body>, recompute the guard once
// the theme tokens exist, and re-run it whenever the theme or mode changes.
(function bootSurface() {
  var mode = 'solid';
  try { mode = localStorage.getItem(NBD_SURFACE_KEY) || 'solid'; } catch (e) {}
  if (NBD_SURFACES.indexOf(mode) === -1) mode = 'solid';
  if (mode !== 'solid') nbdSetSurface(mode, false);
  var rerun = function () { nbdSurfaceGuard(); };
  document.addEventListener('themechange', rerun);
  document.addEventListener('modechange', rerun);
  var onReady = function () {
    nbdSyncSurfaceUI();
    _nbdHydratePrefFromFirestore(
      'surfaceStyle',
      function () { try { return localStorage.getItem(NBD_SURFACE_KEY) || 'solid'; } catch (e) { return 'solid'; } },
      function (remote) { nbdSetSurface(remote, false); }
    );
    _nbdHydratePrefFromFirestore(
      'surfaceBlur',
      function () { return _nbdSurfaceRead(NBD_SURFACE_BLUR_KEY, 14, 0, 30); },
      function (remote) {
        var v = Math.max(0, Math.min(30, parseInt(remote, 10) || 0));
        try { localStorage.setItem(NBD_SURFACE_BLUR_KEY, String(v)); } catch (e) {}
        document.documentElement.style.setProperty('--glass-blur', v + 'px'); nbdSyncSurfaceUI();
      }
    );
    _nbdHydratePrefFromFirestore(
      'surfaceFrost',
      function () { return _nbdSurfaceRead(NBD_SURFACE_FROST_KEY, 68, 40, 95); },
      function (remote) {
        var v = Math.max(40, Math.min(95, parseInt(remote, 10) || 68));
        try { localStorage.setItem(NBD_SURFACE_FROST_KEY, String(v)); } catch (e) {}
        document.documentElement.style.setProperty('--glass-frost', v + '%'); nbdSurfaceGuard(); nbdSyncSurfaceUI();
      }
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();


window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  nbdSetSurface: nbdSetSurface,
  nbdSetSurfaceBlur: nbdSetSurfaceBlur,
  nbdSetSurfaceFrost: nbdSetSurfaceFrost,
  nbdSyncSurfaceUI: nbdSyncSurfaceUI
});
})();
