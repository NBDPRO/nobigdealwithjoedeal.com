// explore-entry.js — opens the browser-only sample account (Pro demo
// phase 2, wave 1, 2026-10-06).
//
// 1. Register /pro/explore/demo-sw.js with scope /pro/explore/. That worker
//    answers the CRM's Firebase SDK imports with the in-browser fake
//    (/pro/demo-sdk/), so nothing a sample page does can reach Firebase.
// 2. Wait until it is active, then replace this page with the real dashboard
//    at /pro/explore/dashboard (Firebase Hosting rewrites it to
//    /pro/dashboard.html; the demo route's CSP allows connect-src 'self' only).
//
// ?next= may name another sample page (customer card) to land on instead; it
// is matched against a fixed pattern, never followed blindly.
(function () {
  'use strict';
  var NEXT_RE = /^\/pro\/explore\/(dashboard|customer)(\?[\w=&%.-]{0,200})?$/;
  var status = document.getElementById('xe-status');
  var actions = document.getElementById('xe-actions');

  function say(msg, showActions) {
    if (status) status.textContent = msg;
    if (actions && showActions) actions.hidden = false;
    var h = document.querySelector('.xe-card h1');
    if (h && showActions) h.textContent = 'The sample account did not open';
  }

  function target() {
    var next = '';
    try { next = new URLSearchParams(location.search).get('next') || ''; } catch (_) { next = ''; }
    return NEXT_RE.test(next) ? next : '/pro/explore/dashboard';
  }

  function go() { location.replace(target()); }

  if (!('serviceWorker' in navigator)) {
    say('This browser cannot run the sample account (it blocks service workers, as some private windows do). The guided demo works everywhere.', true);
    return;
  }

  function whenActive(reg) {
    return new Promise(function (resolve, reject) {
      if (reg.active) return resolve(reg.active);
      var w = reg.installing || reg.waiting;
      if (!w) return reject(new Error('no worker'));
      w.addEventListener('statechange', function () {
        if (w.state === 'activated') resolve(w);
        else if (w.state === 'redundant') reject(new Error('worker failed to install'));
      });
    });
  }

  var timer = setTimeout(function () {
    say('The sample account is taking longer than usual to open.', false);
    if (actions) actions.hidden = false;
  }, 8000);

  navigator.serviceWorker.register('/pro/explore/demo-sw.js', { scope: '/pro/explore/', updateViaCache: 'none' })
    .then(function (reg) { try { reg.update(); } catch (_) {} return whenActive(reg); })
    .then(function () { clearTimeout(timer); say('Opening the dashboard…'); go(); })
    .catch(function (e) {
      clearTimeout(timer);
      console.warn('[sample account] could not start:', e);
      say('The sample account could not start in this browser. The guided demo works everywhere.', true);
    });
})();
