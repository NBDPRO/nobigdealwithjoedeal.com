/**
 * my-skin-boot.js — My Skin loads only for an account that uses it (2026-11-08).
 *
 * Registers my-skin-logic.js + my-skin.js as the `myskin` ScriptLoader bundle
 * at runtime (like dark-features.js: the blocking script-loader.js does not
 * grow) and loads it: at once when this device painted a skin last time
 * (localStorage nbd_myskin_boot, a load hint my-skin.js writes; an nbd_ key, so
 * sign-out wipes it); else once signed in, when userSettings/{uid}.mySkin exists
 * or the company's skin/config is enabled (one getDoc each, no listener; no
 * answer loads it, as before); and when Settings opens (views.settings).
 */
(function () {
  'use strict';
  var w = window, SL = w.ScriptLoader;
  if (w.NBDMySkinBoot || !SL || typeof SL.loadBundle !== 'function') return;
  // Order is load-bearing: my-skin.js reads window.NBDMySkinLogic.
  if (SL.bundles && !SL.bundles.myskin) SL.bundles.myskin = ['js/my-skin-logic.js?v=7', 'js/my-skin.js?v=12'];
  if (SL.views && SL.views.settings && SL.views.settings.indexOf('myskin') === -1) SL.views.settings.push('myskin');

  var asked = false;
  function load() {
    if (asked) return;
    asked = true;
    try { SL.loadBundle('myskin'); } catch (e) {}
  }
  w.NBDMySkinBoot = { load: load };

  var hint = null;
  try { hint = w.localStorage.getItem('nbd_myskin_boot'); } catch (e) {}
  if (hint === '1') { load(); return; }

  function ready() {
    try { return !!(w._user && w._user.uid && w.db && w.doc && w.getDoc && w.storage); } catch (e) { return false; }
  }
  // true / false, or null for no answer. A boot getDoc can answer from the
  // EMPTY local cache while the connection comes up (my-skin.js readWithRetry):
  // a cached "no" is asked again.
  function has(path, test, n) {
    var run = w.nbdRetryOffline || function (f) { return f(); };
    return Promise.resolve().then(function () {
      return run(function () { return w.getDoc(w.doc.apply(null, [w.db].concat(path))); });
    }).then(function (snap) {
      var ex = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
      if (ex && typeof snap.data === 'function' && test(snap.data() || {})) return true;
      if (!(snap && snap.metadata && snap.metadata.fromCache)) return false;
      if (n >= 4) return null;
      return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return has(path, test, n + 1); });
    });
  }

  var tries = 0;
  (function poll() {
    if (!ready()) { if (++tries <= 40) setTimeout(poll, 500); return; }
    var uid = w._user.uid;
    has(['userSettings', uid], function (d) { return !!d.mySkin; }, 0)
      .catch(function () { return null; })
      .then(function (mine) {
        if (mine !== false) return mine;
        var c = w._userClaims || {};   // read late: the claims land just after _user
        return has(['companies', c.companyId || uid, 'skin', 'config'], function (d) { return d.enabled === true; }, 0)
          .catch(function () { return false; });   // refused: no set, as my-skin.js treats it
      })
      .then(function (yes) { if (yes !== false) load(); });
  })();
})();
