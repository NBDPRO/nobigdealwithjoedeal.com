// demo-sw.js — the sample account's service worker (Pro demo phase 2,
// wave 1, 2026-10-06). Scope: /pro/explore/ only. It never touches /pro/sw.js
// or any page outside that scope.
//
// What it does, for pages under /pro/explore/:
//   1. Firebase SDK swap. A request for
//      https://www.gstatic.com/firebasejs/<ver>/firebase-<name>.js, or for the
//      self-hosted copy /assets/vendor/firebase/<ver>/firebase-<name>.js
//      (main vendored the SDK on 2026-10-04, #2155), is answered
//      HERE with a one-line module that re-exports the same-origin fake,
//      /pro/demo-sdk/firebase-<name>.js. The real SDK is never downloaded, so
//      no page can open a connection to Firestore, Auth, Functions or Storage.
//      Every SDK version string maps to the same fake, so all callers share
//      one in-memory store.
//   2. Same files, one copy. /pro/explore/<path> subresources are served from
//      /pro/<path>, so dashboard.html and customer.html run unchanged (their
//      relative "js/x.js" references resolve under /pro/explore/).
//   3. No config. The App Check / FCM / Sentry config scripts are answered
//      with an empty script, so the demo never loads a production key.
//      Wave 3: js/claude-proxy.js (the AI proxy client) is answered with the
//      sample one, /pro/demo-sdk/claude-proxy.js (SWAPS below).
//   4. Everything else that is not same-origin is refused with a 451-style
//      error response and reported to the page (belt and braces behind the
//      demo route's CSP, which already says connect-src 'self').
//
// What it never does: intercept a navigation (request.mode === 'navigate').
// The 2026 SW navigation-stall rule applies; navigations go straight to
// Firebase Hosting, which rewrites /pro/explore/<page> to the real page file.
'use strict';

const VERSION = 'nbd-demo-sw-2026-10-07';
const SCOPE_PATH = '/pro/explore/';
const SDK_RE = /^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z-]+)\.js$/;
// The self-hosted SDK (scripts/vendor-firebase-sdk.js), matched on a
// same-origin pathname. Without this the real SDK would load from our own
// origin and only the CSP would stand between it and Firestore.
const VENDOR_SDK_RE = /^\/assets\/vendor\/firebase\/[\d.]+\/(firebase-[a-z-]+)\.js$/;
// The fakes that exist. A compat or unknown module is refused, loudly.
const FAKES = new Set([
  'firebase-app', 'firebase-auth', 'firebase-firestore', 'firebase-functions',
  'firebase-storage', 'firebase-app-check', 'firebase-messaging'
]);
// Production config the demo must never load.
const EMPTY_SCRIPTS = new Set([
  '/pro/js/dashboard-appcheck-config.js',
  '/pro/js/dashboard-fcm-config.js',
  '/pro/js/sentry-config.js'
]);
// Same-origin scripts the sample account swaps for its own (wave 3): the AI
// proxy client (js/claude-proxy.js POSTs to the claudeProxy function) is
// answered with /pro/demo-sdk/claude-proxy.js, so Ask Joe gets sample
// answers and no model is ever called.
const SWAPS = new Map([
  ['/pro/js/claude-proxy.js', '/pro/demo-sdk/claude-proxy.js']
]);
// Same-origin paths that are server functions, not files (firebase.json
// rewrites). The demo never calls them.
const FUNCTION_PATHS = /^\/(api\/|cspReport|share\/|deal\/|report\/|calendar\/|unsubscribe\/|hooks\/|tenant-logo\/|__\/|pro\/account-erasure)/;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

function js(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-NBD-Demo': VERSION }
  });
}

async function tell(clientId, url, why) {
  try {
    const c = clientId ? await self.clients.get(clientId) : null;
    const targets = c ? [c] : await self.clients.matchAll({ type: 'window' });
    for (const t of targets) t.postMessage({ type: 'nbd-demo:blocked', url: String(url).slice(0, 300), why });
  } catch (_) { /* no client to tell */ }
}

function refuse(event, why) {
  event.waitUntil(tell(event.clientId, event.request.url, why));
  return new Response('Blocked in the sample account: ' + why, {
    status: 451, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-NBD-Demo': VERSION }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode === 'navigate') return; // never intercept navigations
  const url = new URL(req.url);

  // 1. Firebase SDK → same-origin fake
  const sdk = SDK_RE.exec(req.url) || (url.origin === self.location.origin ? VENDOR_SDK_RE.exec(url.pathname) : null);
  if (sdk) {
    const name = sdk[1];
    if (!FAKES.has(name)) {
      event.respondWith(js('throw new Error(' + JSON.stringify(name + ' is not available in the sample account') + ');'));
      return;
    }
    event.respondWith(js('export * from ' + JSON.stringify(self.location.origin + '/pro/demo-sdk/' + name + '.js') + ';\n'));
    return;
  }

  // 4. Anything else off-origin: refuse (fonts are the one static exception,
  //    and they never carry data).
  if (url.origin !== self.location.origin) {
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return;
    event.respondWith(refuse(event, 'off-site request'));
    return;
  }

  if (FUNCTION_PATHS.test(url.pathname) || req.method !== 'GET' && req.method !== 'HEAD') {
    event.respondWith(refuse(event, req.method !== 'GET' && req.method !== 'HEAD' ? 'write request' : 'server function'));
    return;
  }

  // 2. /pro/explore/<path> → /pro/<path> (but the demo's own files stay put)
  let path = url.pathname;
  if (path.startsWith(SCOPE_PATH) && !/^\/pro\/explore\/(demo-sw\.js|explore-[\w-]+\.(js|css))$/.test(path)) {
    path = '/pro/' + path.slice(SCOPE_PATH.length);
  }

  // 3. production config → empty
  if (EMPTY_SCRIPTS.has(path)) {
    event.respondWith(js('/* sample account: production config not loaded */\n'));
    return;
  }
  // 3b. the sample account's own copy of a script (wave 3)
  if (SWAPS.has(path)) {
    event.respondWith(fetch(SWAPS.get(path), { credentials: 'same-origin', cache: 'no-store' }));
    return;
  }

  if (path !== url.pathname) {
    const target = path + url.search;
    event.respondWith(fetch(target, { credentials: 'same-origin', cache: req.cache === 'only-if-cached' ? 'default' : req.cache }));
  }
  // else: same-origin static file, straight to the network
});
