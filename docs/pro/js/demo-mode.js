// demo-mode.js — the sample-account shell for CRM pages served under
// /pro/explore/ (Pro demo phase 2, wave 1, 2026-10-06).
//
// Loaded first, synchronously, in dashboard.html and customer.html. On every
// other path (the real CRM at /pro/dashboard, /pro/customer) it returns on
// its first line and does nothing at all.
//
// Under /pro/explore/ it:
//   1. Refuses to run without the demo service worker. /pro/explore/demo-sw.js
//      is what swaps the Firebase SDK for the in-browser fake; a hard reload
//      bypasses it, so the page stops loading and goes back through
//      /pro/explore, which re-arms it. (The demo route's CSP, connect-src
//      'self', is the guarantee even then; this keeps the page from booting
//      the real SDK at all.)
//   2. Trips on any request that is not a same-origin static file read:
//      fetch, XMLHttpRequest, sendBeacon, WebSocket and EventSource are
//      wrapped; a blocked call throws, is logged to window.__NBD_DEMO__.blocked
//      and shows a "blocked" notice, so a bug is loud in QA, never silent.
//   3. Keeps the sample account's localStorage/sessionStorage in its own
//      "nbd_demo:" namespace, so it never reads or overwrites a real
//      signed-in account's cached data in the same browser.
//   4. Keeps the visitor inside the sample account: links and navigations to
//      the CRM pages that exist in the demo are rewritten to /pro/explore/;
//      other CRM pages say they are in the real account instead.
//   5. Shows the fixed "Sample account" strip with Reset and Start free.
(function () {
  'use strict';
  var PREFIX = '/pro/explore/';
  if (typeof location === 'undefined' || location.pathname.indexOf(PREFIX) !== 0) return;

  var NS = 'nbd_demo:';
  var IDB_NAME = 'nbd-demo-account';
  var DEMO_PAGES = { dashboard: true, customer: true };
  // Leaving the CRM for these is fine: they are public pages.
  var EXIT_OK = /^\/(pro\/(register|pricing|sandbox|terms|index)?(\.html)?|pro\/?|privacy(\.html)?)$/;
  var FUNCTION_PATHS = /^\/(api\/|cspReport|share\/|deal\/|report\/|calendar\/|unsubscribe\/|hooks\/|tenant-logo\/|__\/|pro\/account-erasure)/;

  // ── 1. no demo service worker, no demo ─────────────────────────────────
  var sw = navigator.serviceWorker;
  if (!sw || !sw.controller) {
    try { window.stop(); } catch (_) {}
    location.replace('/pro/explore?next=' + encodeURIComponent(location.pathname + location.search));
    return;
  }

  var state = window.__NBD_DEMO__ = { active: true, blocked: [], notices: [] };
  document.documentElement.classList.add('nbd-demo');

  // ── notices (strip toast) ──────────────────────────────────────────────
  var toastEl = null, toastTimer = null, pending = [];
  function notice(msg, isBlock) {
    var text = String(msg || '').slice(0, 240);
    state.notices.push({ at: Date.now(), message: text, blocked: !!isBlock });
    if (!toastEl) { pending.push([text, isBlock]); return; }
    toastEl.textContent = text;
    toastEl.className = 'nbd-demo-toast' + (isBlock ? ' is-block' : '') + ' is-on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.className = 'nbd-demo-toast'; }, 5200);
  }
  window.addEventListener('nbd-demo:notice', function (e) { notice(e.detail && e.detail.message); });
  try {
    sw.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'nbd-demo:blocked') block(e.data.url, e.data.why || 'service worker', true);
    });
  } catch (_) {}

  // ── 2. network tripwire ────────────────────────────────────────────────
  function block(url, how, fromSw) {
    var rec = { url: String(url || '').slice(0, 300), how: how, at: Date.now() };
    state.blocked.push(rec);
    try { console.warn('[sample account] blocked ' + how + ': ' + rec.url); } catch (_) {}
    notice('Blocked in the sample account: ' + (fromSw ? 'a request' : how) + ' to ' + shortUrl(rec.url) + '. Nothing left your browser.', true);
    return rec;
  }
  function shortUrl(u) {
    try { var x = new URL(u, location.href); return x.origin === location.origin ? x.pathname : x.host; } catch (_) { return 'another site'; }
  }
  function allowed(url, method) {
    var m = String(method || 'GET').toUpperCase();
    var x;
    try { x = new URL(String(url), location.href); } catch (_) { return false; }
    if (x.protocol === 'blob:' || x.protocol === 'data:') return true;
    if (x.origin !== location.origin) return false;
    if (m !== 'GET' && m !== 'HEAD') return false;
    return !FUNCTION_PATHS.test(x.pathname);
  }
  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = input && typeof input === 'object' && 'url' in input ? input.url : input;
      var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      if (!allowed(url, method)) {
        block(url, 'fetch ' + String(method).toUpperCase());
        return Promise.reject(new TypeError('Blocked in the sample account: nothing is sent from here.'));
      }
      return realFetch.apply(this, arguments);
    };
  }
  if (window.XMLHttpRequest) {
    var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__nbdDemoOk = allowed(url, method);
      this.__nbdDemoUrl = url;
      this.__nbdDemoMethod = method;
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (!this.__nbdDemoOk) {
        block(this.__nbdDemoUrl, 'XHR ' + String(this.__nbdDemoMethod || 'GET').toUpperCase());
        throw new DOMException('Blocked in the sample account', 'NetworkError');
      }
      return xs.apply(this, arguments);
    };
  }
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url) { block(url, 'beacon'); return false; };
  }
  ['WebSocket', 'EventSource'].forEach(function (name) {
    if (!window[name]) return;
    window[name] = function (url) {
      block(url, name);
      throw new DOMException('Blocked in the sample account', 'SecurityError');
    };
  });

  // ── 3. storage namespace ───────────────────────────────────────────────
  try {
    var SP = Storage.prototype;
    var gi = SP.getItem, si = SP.setItem, ri = SP.removeItem, ki = SP.key;
    var lenDesc = Object.getOwnPropertyDescriptor(SP, 'length');
    var ownKeys = function (store) {
      var out = [], n = lenDesc.get.call(store);
      for (var i = 0; i < n; i++) { var k = ki.call(store, i); if (k && k.indexOf(NS) === 0) out.push(k); }
      return out;
    };
    SP.getItem = function (k) { return gi.call(this, NS + k); };
    SP.setItem = function (k, v) { return si.call(this, NS + k, v); };
    SP.removeItem = function (k) { return ri.call(this, NS + k); };
    SP.key = function (i) { var k = ownKeys(this)[i]; return k ? k.slice(NS.length) : null; };
    SP.clear = function () { var self = this; ownKeys(this).forEach(function (k) { ri.call(self, k); }); };
    Object.defineProperty(SP, 'length', { configurable: true, get: function () { return ownKeys(this).length; } });
    state.clearStorage = function () { [localStorage, sessionStorage].forEach(function (s) { ownKeys(s).forEach(function (k) { ri.call(s, k); }); }); };
  } catch (_) { /* storage blocked: nothing to protect */ }

  // ── service workers: the demo worker stays, /pro/sw.js stays out ───────
  try {
    var SWC = ServiceWorkerContainer.prototype;
    SWC.register = function () { return Promise.resolve({ scope: location.origin + PREFIX, update: function () { return Promise.resolve(); }, unregister: function () { return Promise.resolve(false); }, __nbdDemoStub: true }); };
    SWC.getRegistrations = function () { return Promise.resolve([]); };
  } catch (_) {}

  // ── 4. keep navigation inside the sample account ───────────────────────
  // Returns the URL to go to instead, '' to stay put, or null to allow.
  function remap(href) {
    var x;
    try { x = new URL(href, location.href); } catch (_) { return null; }
    if (x.origin !== location.origin) return null; // off-site links open normally
    var p = x.pathname;
    if (p.indexOf(PREFIX) === 0) return null;
    var m = /^\/pro\/([\w-]+?)(\.html)?$/.exec(p);
    if (m && DEMO_PAGES[m[1]]) return PREFIX + m[1] + x.search + x.hash;
    if (/^\/pro\/login(\.html)?$/.test(p)) return '/pro/sandbox';
    if (EXIT_OK.test(p) || p === '/') return null;
    if (p.indexOf('/pro/') === 0) return '';
    return null;
  }
  function stayNotice() { notice('That screen is in your real account. The sample account has the dashboard and customer cards for now.'); }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var to = remap(a.getAttribute('href'));
    if (to === null) return;
    e.preventDefault();
    if (to === '') { stayNotice(); return; }
    location.assign(to);
  }, true);

  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', function (e) {
      if (!e.cancelable || e.hashChange || e.downloadRequest) return;
      var to = remap(e.destination && e.destination.url);
      if (to === null) return;
      e.preventDefault();
      if (to === '') { stayNotice(); return; }
      setTimeout(function () { location.assign(to); }, 0);
    });
  }

  // ── 5. the strip ───────────────────────────────────────────────────────
  async function resetAccount() {
    // nbdConfirm (standalone-compat.js) on both pages; without it, reset
    // straight away: it only clears this browser's sample data.
    var msg = 'Reset the sample account? Every change you made here is cleared.';
    var yes = typeof window.nbdConfirm === 'function' ? await window.nbdConfirm(msg) : true;
    if (!yes) return;
    try { if (state.clearStorage) state.clearStorage(); } catch (_) {}
    var done = function () { location.replace(PREFIX + 'dashboard'); };
    try {
      var req = indexedDB.deleteDatabase(IDB_NAME);
      req.onsuccess = req.onerror = req.onblocked = done;
    } catch (_) { done(); }
  }
  function mountStrip() {
    if (document.getElementById('nbd-demo-strip')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/pro/css/demo-mode.css?v=1';
    document.head.appendChild(link);
    var bar = document.createElement('div');
    bar.id = 'nbd-demo-strip';
    bar.className = 'nbd-demo-strip';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Sample account');
    bar.innerHTML =
      '<span class="nbd-demo-label"><strong>Sample account</strong><span class="nbd-demo-long">: nothing here is real or saved to NBD Pro</span></span>' +
      '<span class="nbd-demo-actions">' +
        '<button type="button" class="nbd-demo-btn" data-nbd-demo="reset">Reset</button>' +
        '<a class="nbd-demo-btn nbd-demo-cta" href="/pro/register.html">Start free</a>' +
      '</span>';
    toastEl = document.createElement('div');
    toastEl.className = 'nbd-demo-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(bar);
    document.body.appendChild(toastEl);
    bar.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-nbd-demo="reset"]') : null;
      if (b) resetAccount();
    });
    var q = pending; pending = [];
    q.forEach(function (n) { notice(n[0], n[1]); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountStrip);
  else mountStrip();
})();
