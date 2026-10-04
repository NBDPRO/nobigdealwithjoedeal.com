/**
 * client-error-reporter.js — send CRM browser errors to the server (2026-10-04).
 *
 * Before this, the dashboard's global 'error' / 'unhandledrejection'
 * handlers only console.error'd, so an error on Jo's iPhone reached nobody.
 * This file catches:
 *   - window 'error' (uncaught exceptions)
 *   - window 'unhandledrejection'
 *   - failed callables made through window._httpsCallable (the shared slot
 *     the bootstraps and most feature files use), for server-fault codes
 *     only: internal / unknown / not-found / unimplemented / data-loss.
 *     Expected refusals (permission-denied, resource-exhausted, invalid-
 *     argument …) and network codes are not reported.
 * and POSTs one small JSON report per DISTINCT error to /api/client-error
 * (hosting rewrite → the clientError function, which writes one log line
 * that the alert policies in monitoring/ watch).
 *
 * Privacy: a report carries message + trimmed stack (both scrubbed of
 * emails, phones, long digit runs, street addresses, tokens and every URL
 * query string), page, view, build, user agent, standalone, online and a
 * SHA-256 hash of the uid — never the raw uid, never lead data. The server
 * scrubs again (functions/client-error-logic.js, same fixtures in
 * tests/client-error-reporting-2026-10-04.test.js).
 *
 * Volume: each signature is sent once per tab session; at most
 * MAX_PER_PAGE reports per page load and MAX_PER_SESSION per tab session
 * (sessionStorage, so a reload loop cannot spam). The server also rate-
 * limits per IP and per uid-hash.
 *
 * Off on localhost / 127.0.0.1 and under automation (navigator.webdriver)
 * unless window.__NBD_CLIENT_ERRORS_LOCAL === true — CI E2E runs call
 * production functions, and test-run errors must not page Jo. The E2E spec
 * sets the flag to prove the wiring.
 *
 * Manual use: window.NBDClientErrors.report(err, { kind: 'manual' }).
 */
(function (root) {
  'use strict';

  var ENDPOINT = '/api/client-error';
  var MAX_PER_PAGE = 10;
  var MAX_PER_SESSION = 25;
  var SAMPLE_RATE = 1; // single-tenant volume today; lower if it ever gets loud
  var SS_KEY = 'nbdClientErrSent';
  var REPORT_CODES = { internal: 1, unknown: 1, 'not-found': 1, unimplemented: 1, 'data-loss': 1 };

  // ── Scrub — keep in step with functions/client-error-logic.js SCRUBBERS ──
  var SCRUBBERS = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [token]'],
    [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[jwt]'],
    [/(\b(?:https?|blob|webkit-masked-url):\/\/[^\s?#'"()<>]*)[?#][^\s'"()<>]*?(?=:\d+(?::\d+)?(?![\w.])|[\s'"()<>]|$)/gi, '$1'],
    [/([A-Za-z0-9_./-]+\.(?:js|mjs|html|css))\?[^\s:'"()<>]*/g, '$1'],
    [/\b(?:token|idToken|access_token|key|code|sig|signature)=[^&\s'"]+/gi, '[param]'],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
    [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]'],
    [/\b\d{7,}\b/g, '[num]'],
    [/\b\d{1,6}\s+(?:[A-Z][A-Za-z]*\.?\s+){1,4}(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Pl|Place|Pike|Cir|Circle|Ter|Terrace|Trl|Trail|Pkwy|Parkway|Hwy|Highway)\b\.?/g, '[address]']
  ];
  function scrub(input) {
    var s = String(input == null ? '' : input);
    for (var i = 0; i < SCRUBBERS.length; i++) s = s.replace(SCRUBBERS[i][0], SCRUBBERS[i][1]);
    return s;
  }
  function trimStack(stack) {
    return scrub(stack).split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(Boolean).slice(0, 8).join('\n').slice(0, 1500);
  }

  // Dedupe key: kind + message with digits/quoted values normalised + the
  // first stack frame's file:line. FNV-1a, sync — dedupe must not wait.
  function topFrame(stack) {
    var lines = String(stack || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/([A-Za-z0-9_.-]+\.(?:js|mjs|html))(?:\?[^:\s)]*)?:(\d+)/);
      if (m) return m[1] + ':' + m[2];
    }
    return '';
  }
  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function signature(kind, message, stack) {
    var norm = String(message || '').replace(/(["'`]).*?\1/g, '"_"').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
    return fnv(kind + '|' + norm + '|' + topFrame(stack));
  }

  // Noise that is never ours or never actionable.
  function ignorable(message, stack) {
    var m = String(message || '');
    if (/^Script error\.?$/i.test(m) && !stack) return true;            // cross-origin, no detail
    if (/ResizeObserver loop/i.test(m)) return true;
    if (/(chrome|moz|safari|safari-web)-extension:\/\//i.test(String(stack || ''))) return true;
    if (/client-error-reporter\.js/.test(String(stack || ''))) return true; // never report ourselves
    return false;
  }

  // ── Per-session ledger ──────────────────────────────────────────────────
  function createLedger(storage) {
    var page = { count: 0, sigs: {} };
    function load() {
      try { var v = storage && JSON.parse(storage.getItem(SS_KEY) || 'null'); if (v && typeof v === 'object') return v; } catch (_) { /* private mode */ }
      return { n: 0, s: {} };
    }
    function save(v) { try { if (storage) storage.setItem(SS_KEY, JSON.stringify(v)); } catch (_) { /* ignore */ } }
    return {
      // true = send it; false = dedupe or a cap said no
      admit: function (sig) {
        if (page.sigs[sig] || page.count >= MAX_PER_PAGE) return false;
        var ss = load();
        if (ss.s[sig] || ss.n >= MAX_PER_SESSION) { page.sigs[sig] = 1; return false; }
        page.sigs[sig] = 1; page.count++;
        ss.s[sig] = 1; ss.n++;
        save(ss);
        return true;
      },
      _page: page
    };
  }

  // ── Context ────────────────────────────────────────────────────────────
  function buildVersion(doc) {
    try {
      var el = doc.querySelector('script[src*="script-loader.js"]');
      var m = el && String(el.getAttribute('src')).match(/[?&]v=([A-Za-z0-9._-]+)/);
      if (m) return 'loader-' + m[1];
    } catch (_) { /* ignore */ }
    return '';
  }
  function pageName(loc) {
    var p = String((loc && loc.pathname) || '').replace(/\/+$/, '');
    var last = p.split('/').pop() || 'root';
    return last.replace(/\.html$/, '').slice(0, 40);
  }
  function viewName(doc, loc) {
    try {
      var v = doc.querySelector('.view.active');
      if (v && v.id) return v.id.replace(/^view-/, '').slice(0, 40);
    } catch (_) { /* ignore */ }
    var h = String((loc && loc.hash) || '').replace(/^#\/?/, '').split(/[/?&]/)[0];
    return /^[A-Za-z0-9_-]{1,40}$/.test(h) ? h : '';
  }
  function isStandalone(win) {
    try {
      if (win.navigator && win.navigator.standalone === true) return true;
      return !!(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
    } catch (_) { return false; }
  }

  var _uidHashCache = { uid: null, hash: '' };
  function hashUid(win, uid) {
    if (!uid) return Promise.resolve('');
    if (_uidHashCache.uid === uid) return Promise.resolve(_uidHashCache.hash);
    try {
      var subtle = win.crypto && win.crypto.subtle;
      if (!subtle || !win.TextEncoder) return Promise.resolve('');
      return subtle.digest('SHA-256', new win.TextEncoder().encode('nbd-client-error:' + uid)).then(function (buf) {
        var bytes = new Uint8Array(buf), hex = '';
        for (var i = 0; i < 8; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
        _uidHashCache = { uid: uid, hash: hex };
        return hex;
      }, function () { return ''; });
    } catch (_) { return Promise.resolve(''); }
  }

  function enabled(win) {
    if (win.__NBD_CLIENT_ERRORS_LOCAL === true) return true;
    var host = String((win.location && win.location.hostname) || '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /\.localhost$/.test(host)) return false;
    if (win.navigator && win.navigator.webdriver === true) return false;
    return true;
  }

  // ── The reporter ─────────────────────────────────────────────────────────
  function createReporter(win, opts) {
    opts = opts || {};
    var storage = null;
    try { storage = opts.storage !== undefined ? opts.storage : win.sessionStorage; } catch (_) { storage = null; }
    var ledger = createLedger(storage);
    var send = opts.send || function (body) {
      try {
        if (typeof win.fetch === 'function') {
          return win.fetch(ENDPOINT, {
            method: 'POST', keepalive: true, credentials: 'same-origin',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: body
          }).catch(function () { /* nowhere left to report to */ });
        }
        if (win.navigator && win.navigator.sendBeacon) win.navigator.sendBeacon(ENDPOINT, body);
      } catch (_) { /* ignore */ }
    };
    var random = opts.random || Math.random;

    function report(errLike, meta) {
      try {
        meta = meta || {};
        if (!enabled(win)) return false;
        var kind = meta.kind || 'manual';
        var e = errLike;
        // A callable failure is reported once, as 'callable' — not again when
        // the caller leaves the same rejection unhandled.
        if (e && typeof e === 'object' && e.__nbdReported) return false;
        var message = '', stack = '';
        if (e && typeof e === 'object') {
          message = e.message != null ? String(e.message) : String(e);
          stack = e.stack ? String(e.stack) : '';
          if (e.name && e.name !== 'Error' && message.indexOf(e.name) !== 0) message = e.name + ': ' + message;
        } else {
          message = String(e);
        }
        if (meta.prefix) message = meta.prefix + message;
        if (!stack && meta.where) stack = meta.where;
        if (ignorable(message, stack)) return false;
        message = scrub(message).slice(0, 300);
        stack = trimStack(stack);
        var sig = signature(kind, message, stack);
        if (random() >= SAMPLE_RATE) return false;
        if (!ledger.admit(sig)) return false;
        if (e && typeof e === 'object') { try { e.__nbdReported = true; } catch (_) { /* frozen */ } }
        var user = win._user;
        var uid = user && typeof user.uid === 'string' ? user.uid : '';
        var doc = win.document;
        var base = {
          v: 1, kind: kind, message: message, stack: stack,
          page: pageName(win.location), view: viewName(doc, win.location),
          build: buildVersion(doc),
          ua: scrub(String((win.navigator && win.navigator.userAgent) || '')).slice(0, 200),
          standalone: isStandalone(win),
          online: !(win.navigator && win.navigator.onLine === false),
          sig: sig
        };
        hashUid(win, uid).then(function (h) {
          base.uidHash = h;
          send(JSON.stringify(base));
        });
        return true;
      } catch (_) { return false; }
    }

    function onError(ev) {
      var err = ev && ev.error;
      if (err) { report(err, { kind: 'error' }); return; }
      var where = ev && ev.filename ? (ev.filename + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0)) : '';
      report(String((ev && ev.message) || 'error'), { kind: 'error', where: where });
    }
    function onRejection(ev) {
      var r = ev ? ev.reason : undefined;
      if (r === undefined) r = 'unhandled rejection (no reason)';
      report(r, { kind: 'unhandledrejection' });
    }

    // Wrap a callable factory (httpsCallable). The wrapped callable returns
    // the SAME outcome — it only observes a rejection, then rethrows.
    function wrapCallableFactory(factory) {
      if (typeof factory !== 'function' || factory.__nbdErrWrap) return factory;
      var w = function (functions, name) {
        var callable = factory.apply(this, arguments);
        if (typeof callable !== 'function') return callable;
        var wrapped = function () {
          var p = callable.apply(this, arguments);
          if (!p || typeof p.then !== 'function') return p;
          return p.then(null, function (err) {
            try {
              var code = String((err && err.code) || '').replace(/^functions\//, '');
              if (REPORT_CODES[code]) {
                report(err, { kind: 'callable', prefix: 'callable ' + String(name).slice(0, 60) + ' [' + code + '] ' });
                if (err && typeof err === 'object') err.__nbdReported = true;
              }
            } catch (_) { /* ignore */ }
            throw err;
          });
        };
        for (var k in callable) { try { wrapped[k] = callable[k]; } catch (_) { /* ignore */ } }
        return wrapped;
      };
      w.__nbdErrWrap = true;
      return w;
    }

    function install() {
      if (typeof win.addEventListener !== 'function') return;
      win.addEventListener('error', onError);
      win.addEventListener('unhandledrejection', onRejection);
      // An accessor, so bootstrap assignments made AFTER this file runs
      // (window._httpsCallable = mod.httpsCallable) pass through the wrap.
      var current = wrapCallableFactory(win._httpsCallable);
      try {
        Object.defineProperty(win, '_httpsCallable', {
          configurable: true, enumerable: true,
          get: function () { return current; },
          set: function (v) { current = wrapCallableFactory(v); }
        });
      } catch (_) { /* non-configurable: leave callables unwrapped */ }
    }

    return {
      report: report, onError: onError, onRejection: onRejection,
      wrapCallableFactory: wrapCallableFactory, install: install, _ledger: ledger
    };
  }

  var api = {
    scrub: scrub, trimStack: trimStack, signature: signature, topFrame: topFrame,
    createReporter: createReporter, enabled: enabled, buildVersion: buildVersion,
    ENDPOINT: ENDPOINT, MAX_PER_PAGE: MAX_PER_PAGE, MAX_PER_SESSION: MAX_PER_SESSION
  };

  if (root && root.document && !root.NBDClientErrors) {
    var r = createReporter(root);
    r.install();
    root.NBDClientErrors = { report: r.report };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
