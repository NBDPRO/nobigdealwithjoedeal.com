/* Daily Success - keep an offline copy of this page so it opens with no signal.
 *
 * The service worker (/pro/sw.js) keeps offline "app shells" for the pages Jo installs. The tracker is public and local-first (it
 * works signed out and saves to the phone first), so its shell is stored by THIS page, not by the dashboard: it asks only after
 * the page has finished loading under the worker, so the stored HTML and the versioned ?v= scripts it needs come from the same
 * visit. The request names the shell by key; the worker only ever selects from its own list, it never fetches a URL from a message.
 *
 * First visit on a fresh phone installs the worker; the next online visit stores the shell. Nothing here reads or sends account data.
 */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  var KEY = '/pro/__app-shell__/daily-success';
  var asked = false;

  function ask() {
    try {
      if (navigator.onLine === false) return;
      var c = navigator.serviceWorker.controller;
      if (!c) return;
      c.postMessage({ type: 'CACHE_APP_SHELL', keys: [KEY] });
      asked = true;
    } catch (_) { /* best effort: the tracker works either way */ }
  }
  function later() { setTimeout(ask, 3000); }

  if (document.readyState === 'complete') later(); else window.addEventListener('load', later);
  // First ever visit: the worker takes control after the page loaded.
  try { navigator.serviceWorker.addEventListener('controllerchange', function () { if (!asked) later(); }); } catch (_) { /* ignore */ }
})();
