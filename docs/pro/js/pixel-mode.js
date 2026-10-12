/**
 * pixel-mode.js — the only Pixel Mode tag on the dashboard: a boot LOADER
 * (2026-10-11, CRM style roadmap E1).
 *
 * The skin, the Party card, the dialog notifications and (E2) the town live in
 * pixel-mode-core.js, which this file fetches only when it is needed:
 *   - the person's settings say the skin or dialog notifications are on, or
 *   - the Pixel Mode card in Settings > Appearance scrolls into view.
 * Everyone else pays for one settings read and a few hundred bytes, nothing
 * else. (dashboard-boot-budget-2026-10-03.test.js is why this split exists.)
 *
 * It reads userSettings/{uid}.pixelMode once and writes nothing.
 */
(function () {
  'use strict';
  var w = typeof window !== 'undefined' ? window : null;
  var doc = typeof document !== 'undefined' ? document : null;

  // Same rule as NBDPixelLogic: only a literal true turns a flag on.
  function wantsCore(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return r.skin === true || r.dialog === true;
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { wantsCore: wantsCore }; }
  if (!w || !doc || w.NBDPixelMode) return;

  var CORE_URL = '/pro/js/pixel-mode-core.js?v=1';
  var corePromise = null;

  function loadCore() {
    if (corePromise) return corePromise;
    corePromise = new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = CORE_URL; s.async = true;
      s.onload = function () { resolve(w.NBDPixelMode); };
      s.onerror = function () { corePromise = null; reject(new Error('pixel-mode-core failed to load')); };
      doc.head.appendChild(s);
    });
    return corePromise;
  }

  function ready() {
    try { return !!(w._user && w._user.uid && w.db && w.doc && w.getDoc); } catch (e) { return false; }
  }
  function read(tries) {
    w.getDoc(w.doc(w.db, 'userSettings', w._user.uid)).then(function (snap) {
      var ok = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
      var data = ok && typeof snap.data === 'function' ? (snap.data() || {}) : {};
      // A cache-only read while the connection comes up looks like "no settings".
      if (snap && snap.metadata && snap.metadata.fromCache && !data.pixelMode && tries < 3) {
        setTimeout(function () { read(tries + 1); }, 1500);
        return;
      }
      if (wantsCore(data.pixelMode)) loadCore();
    }).catch(function () { /* unreadable: stay off */ });
  }

  function watchPanel() {
    var p = doc.getElementById('pixelModePanel');
    if (!p || typeof IntersectionObserver !== 'function') return;
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) { io.disconnect(); loadCore(); return; }
      }
    });
    io.observe(p);
  }

  function boot() {
    var tries = 0;
    (function poll() {
      if (!ready()) { if (++tries <= 40) setTimeout(poll, 500); return; }
      read(0);
    })();
    watchPanel();
  }

  // Replaced by the real API when the core loads (it checks __stub).
  w.NBDPixelMode = { __v: 1, __stub: true, ensure: loadCore };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})();
