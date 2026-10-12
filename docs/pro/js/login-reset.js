// /pro/js/login-reset.js — recovery escape hatch loaded by login.html.
//
// Visit /pro/login?reset=1 to nuke any stuck service-worker / cache /
// IndexedDB / storage state from a bad deploy. Lives in an external file
// (not inline) because the per-page CSP for /pro/login.html does NOT
// permit 'unsafe-inline' for script-src; same-origin scripts are allowed
// via 'self', so this file works.
//
// Also acts as a hard safety net for the login buttons: login.html ships
// #loginBtn / #codeBtn / #demoBtn with `disabled` so the e2e wait
// `:not([disabled])` and any human tap both wait for login.js to finish
// its dynamic Firebase imports before firing. If those imports fail
// (network blip, CSP regression, gstatic outage), login.js never reaches
// its `removeAttribute('disabled')` lines and the page is unrecoverable.
// This timer flips the gate after 8s no matter what, so the user can at
// least retry and see a real error message instead of a frozen UI.
(function () {
  try {
    setTimeout(function () {
      ['loginBtn', 'codeBtn', 'demoBtn'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.disabled) el.removeAttribute('disabled');
      });
    }, 8000);
  } catch (_) { /* never let the safety net itself break the page */ }

  try {
    var p = new URLSearchParams(location.search);
    if (!p.has('reset')) return;

    document.documentElement.style.background = '#0A0C0F';
    document.documentElement.style.color = '#fff';

    var done = function () {
      try { localStorage.clear(); } catch (_) {}
      try { sessionStorage.clear(); } catch (_) {}
      location.replace('/pro/login.html');
    };

    var jobs = [];

    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(
        navigator.serviceWorker.getRegistrations()
          .then(function (regs) {
            return Promise.all(regs.map(function (r) { return r.unregister(); }));
          })
          .catch(function () {})
      );
    }

    if (window.caches && caches.keys) {
      jobs.push(
        caches.keys()
          .then(function (keys) {
            return Promise.all(keys.map(function (k) { return caches.delete(k); }));
          })
          .catch(function () {})
      );
    }

    if (window.indexedDB && indexedDB.databases) {
      jobs.push(
        indexedDB.databases()
          .then(function (dbs) {
            return Promise.all((dbs || []).map(function (d) {
              return new Promise(function (res) {
                try {
                  var req = indexedDB.deleteDatabase(d.name);
                  req.onsuccess = req.onerror = req.onblocked = res;
                } catch (_) { res(); }
              });
            }));
          })
          .catch(function () {})
      );
    }

    // indexedDB.databases() is missing on older Safari: name My Skin's private
    // picture cache (nbd-myskin) directly so a reset always drops it.
    if (window.indexedDB && !indexedDB.databases) {
      jobs.push(new Promise(function (res) {
        try {
          var r = indexedDB.deleteDatabase('nbd-myskin');
          r.onsuccess = r.onerror = r.onblocked = res;
        } catch (_) { res(); }
      }));
    }

    Promise.all(jobs).then(done, done);
  } catch (_) {
    location.replace('/pro/login.html');
  }
})();
