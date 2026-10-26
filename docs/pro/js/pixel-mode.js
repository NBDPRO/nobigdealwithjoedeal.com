/**
 * pixel-mode.js — the only Pixel Mode / Pixel World tag on the dashboard: a
 * boot LOADER (2026-10-11, CRM style roadmap E1 + E2).
 *
 * The skin, the Crew card, the dialog notifications and the town launcher
 * live in pixel-mode-core.js, which this file fetches only when it is needed:
 *   - the person's settings say the skin or dialog notifications are on, or
 *   - the Pixel Mode card in Settings > Appearance scrolls into view, or
 *   - someone calls NBDPixelMode.open() (Pixel World).
 * Everyone else pays for one settings read and a few hundred bytes, nothing
 * else. (dashboard-boot-budget-2026-10-03.test.js is why this split exists.)
 * The town itself (pixel-world*.js, pixel-world.css) is fetched by the core,
 * and only after the person opens it.
 *
 * It reads userSettings/{uid} once and writes nothing.
 *
 * Not a layout (2026-10-15). It used to register as layout 'pixel', but the
 * registry kept none of its fields (enabled/load/mount), the engine had no
 * implementation to mount, and the preboot asked for a pixel.css that does not
 * exist, so picking "Pixel World" in Settings > Layouts did nothing. Pixel
 * World stays where it works: the Pixel Mode card in Settings > Appearance and
 * NBDPixelMode.open().
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

  var CORE_URL = '/pro/js/pixel-mode-core.js?v=2';
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
  // The core replaces window.NBDPixelMode; until it has, the stub answers.
  function viaCore(method) {
    return loadCore().then(function (api) {
      var real = w.NBDPixelMode;
      if (!real || real.__stub || typeof real[method] !== 'function') return api && api[method] ? api[method]() : null;
      return real[method]();
    });
  }

  function ready() {
    try { return !!(w._user && w._user.uid && w.db && w.doc && w.getDoc); } catch (e) { return false; }
  }
  function read(tries) {
    w.getDoc(w.doc(w.db, 'userSettings', w._user.uid)).then(function (snap) {
      var ok = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
      var data = ok && typeof snap.data === 'function' ? (snap.data() || {}) : {};
      // A cache-only read while the connection comes up looks like "no settings".
      if (snap && snap.metadata && snap.metadata.fromCache && !data.pixelMode && !data.pixelWorld && tries < 3) {
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
  w.NBDPixelMode = {
    __v: 1, __stub: true,
    ensure: loadCore,
    open: function () { return viaCore('open'); },
    close: function () { return Promise.resolve(); },
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})();
