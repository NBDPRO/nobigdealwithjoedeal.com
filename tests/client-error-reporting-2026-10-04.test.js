/**
 * tests/client-error-reporting-2026-10-04.test.js — CRM browser errors reach Jo.
 *
 * Before: dashboard-bootstrap.module.js's window 'error' / 'unhandledrejection'
 * handlers only console.error'd; nothing left the phone.
 *
 *  A. scrub — the browser copy (docs/pro/js/client-error-reporter.js) and the
 *     server copy (functions/client-error-logic.js) strip the same PII.
 *  B. the browser reporter — dedupe by signature, per-page + per-session caps,
 *     off on localhost / under automation, payload shape (uid HASH only),
 *     callable wrapping that observes and rethrows.
 *  C. the clientError handler — 405 / 413 / 429 / 400, and ONE structured
 *     ERROR line with message exactly 'client_error' (logger.error would not
 *     give that — proven against the real firebase-functions logger).
 *  D. wiring — pages, hosting rewrite, export, alert policy files, runbook.
 *
 * Run: node tests/client-error-reporting-2026-10-04.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));

const C = require(path.join(ROOT, 'docs/pro/js/client-error-reporter.js'));
const S = require(path.join(ROOT, 'functions/client-error-logic.js'));

function fakeStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
}
function fakeWin(over) {
  const listeners = {};
  const w = {
    location: { hostname: 'nobigdealwithjoedeal.com', pathname: '/pro/dashboard', hash: '' },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', onLine: true, standalone: true, webdriver: false },
    document: {
      querySelector: (sel) => {
        if (/script-loader/.test(sel)) return { getAttribute: () => 'js/script-loader.js?v=116' };
        if (sel === '.view.active') return { id: 'view-crm' };
        return null;
      },
    },
    crypto: webcrypto,
    TextEncoder,
    _user: { uid: 'UIDabc123secret' },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    _listeners: listeners,
  };
  return Object.assign(w, over || {});
}
function mk(winOver, opts) {
  const sent = [];
  const win = fakeWin(winOver);
  const r = C.createReporter(win, Object.assign({ storage: fakeStorage(), send: (b) => sent.push(JSON.parse(b)) }, opts || {}));
  return { r, sent, win };
}
function errAt(msg, file, line) {
  const e = new Error(msg);
  e.stack = 'Error: ' + msg + '\n    at fn (https://nobigdealwithjoedeal.com/pro/js/' + (file || 'crm.js') + '?v=9:' + (line || 10) + ':5)';
  return e;
}

(async () => {
  // ═══ A. scrub ═══════════════════════════════════════════════════════════
  console.log('\nA. scrub — both copies strip PII the same way');
  const FIX = [
    ['Lead jo.deal+x@gmail.com not found', /@|gmail/],
    ['call (859) 555-1234 errored', /555|859/],
    ['call +1 859.555.1234 errored', /555/],
    ['bad id 8595551234', /8595551234/],
    ['account 123456789012 rejected', /123456789012/],
    ['geocode 1234 Main Street errored', /Main Street|1234 Main/],
    ['at https://x.app/pro/portal?token=abcSECRET123&email=a@b.co:4:5', /SECRET|token=|a@b/],
    ['fetch /api/x?idToken=SECRETTOKEN failed', /SECRETTOKEN/],
    ['auth Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij expired', /eyJ|abcdefghij/],
    ['at load (js/crm.js?v=31&k=PRIVATE:120:7)', /PRIVATE/],
  ];
  for (const [input, leak] of FIX) {
    const c = C.scrub(input), s = S.scrub(input);
    ok('scrubs: ' + input.slice(0, 48), !leak.test(c) && !leak.test(s) && c === s, 'client=' + c + ' server=' + s);
  }
  ok('keeps what is useful: the error text, file name and line',
    C.scrub("TypeError: Cannot read properties of undefined (reading 'stage') at crm.js:120:7") === "TypeError: Cannot read properties of undefined (reading 'stage') at crm.js:120:7");
  ok('signature ignores digits and quoted values, so one bug is one signature',
    C.signature('error', "Cannot read 'abc' of row 12", 'at x (crm.js:10:5)') === C.signature('error', "Cannot read 'xyz' of row 99", 'at x (crm.js:10:9)')
    && S.signature('error', 'row 12', 'crm.js:10') === S.signature('error', 'row 99', 'crm.js:10'));
  ok('…but a different line or file is a different signature',
    C.signature('error', 'boom', 'at x (crm.js:10:5)') !== C.signature('error', 'boom', 'at x (crm.js:11:5)'));

  // ═══ B. the browser reporter ════════════════════════════════════════════
  console.log('\nB. browser reporter — dedupe, caps, payload, gates');
  {
    const { r, sent } = mk();
    r.onError({ error: errAt('boom 1') });
    r.onError({ error: errAt('boom 2') }); // same signature (digits normalised)
    r.onError({ error: errAt('boom 3') });
    await tick();
    ok('the same error three times sends ONE report', sent.length === 1, 'sent ' + sent.length);
    const p = sent[0] || {};
    ok('payload carries kind/page/view/build/ua/standalone/online/sig',
      p.kind === 'error' && p.page === 'dashboard' && p.view === 'crm' && p.build === 'loader-116'
      && /iPhone/.test(p.ua) && p.standalone === true && p.online === true && /^[0-9a-f]{8}$/.test(p.sig), JSON.stringify(p));
    ok('uid is sent only as a 16-hex SHA-256 hash, never raw',
      /^[0-9a-f]{16}$/.test(p.uidHash || '') && !JSON.stringify(p).includes('UIDabc123secret'), p.uidHash);
    ok('stack is trimmed and its URL query stripped', p.stack && !/\?v=9/.test(p.stack) && /crm\.js:10:5/.test(p.stack), p.stack);
  }
  {
    // Private mode / blocked storage: the per-page ledger alone must dedupe.
    const { r, sent } = mk(null, { storage: null });
    r.onError({ error: errAt('nostore') }); r.onError({ error: errAt('nostore') });
    await tick();
    ok('dedupes without sessionStorage (private mode)', sent.length === 1, 'sent ' + sent.length);
  }
  {
    const { r, sent } = mk();
    for (let i = 0; i < 15; i++) r.onError({ error: errAt('boom', 'f' + String.fromCharCode(97 + i) + '.js') });
    await tick();
    ok('at most ' + C.MAX_PER_PAGE + ' reports per page load', sent.length === C.MAX_PER_PAGE, 'sent ' + sent.length);
  }
  {
    const storage = fakeStorage();
    let total = 0;
    for (let load = 0; load < 4; load++) {          // a reload loop: 4 page loads, 10 distinct errors each
      const sent = [];
      const r = C.createReporter(fakeWin(), { storage, send: (b) => sent.push(b) });
      for (let i = 0; i < 10; i++) r.onError({ error: errAt('boom', 'L' + load + 'e' + String.fromCharCode(97 + i) + '.js') });
      await tick();
      total += sent.length;
    }
    ok('at most ' + C.MAX_PER_SESSION + ' per tab session across reloads (sessionStorage)', total === C.MAX_PER_SESSION, 'total ' + total);
    const sent = [];
    const r = C.createReporter(fakeWin(), { storage: fakeStorage(), send: (b) => sent.push(b) });
    const r2 = C.createReporter(fakeWin(), { storage: (() => { const s = fakeStorage(); return s; })(), send: (b) => sent.push(b) });
    r.onError({ error: errAt('same') }); r2.onError({ error: errAt('same') });
    await tick();
    ok('dedupe is per tab session — a fresh session sends the error again', sent.length === 2);
  }
  {
    const shared = fakeStorage();
    const a = []; const b = [];
    C.createReporter(fakeWin(), { storage: shared, send: (x) => a.push(x) }).onError({ error: errAt('reload') });
    await tick();
    C.createReporter(fakeWin(), { storage: shared, send: (x) => b.push(x) }).onError({ error: errAt('reload') });
    await tick();
    ok('after a reload the same signature is not sent again', a.length === 1 && b.length === 0);
  }
  {
    const loc = mk({ location: { hostname: '127.0.0.1', pathname: '/pro/dashboard', hash: '' } });
    loc.r.onError({ error: errAt('local') });
    const wd = mk({ navigator: { userAgent: 'x', onLine: true, webdriver: true } });
    wd.r.onError({ error: errAt('auto') });
    const forced = mk({ location: { hostname: '127.0.0.1', pathname: '/pro/dashboard', hash: '' }, __NBD_CLIENT_ERRORS_LOCAL: true });
    forced.r.onError({ error: errAt('forced') });
    await tick();
    ok('off on localhost and under automation; on with __NBD_CLIENT_ERRORS_LOCAL',
      loc.sent.length === 0 && wd.sent.length === 0 && forced.sent.length === 1);
  }
  {
    const { r, sent } = mk();
    r.onError({ message: 'Script error.', filename: '', error: null });
    r.onError({ error: Object.assign(new Error('ResizeObserver loop completed'), { stack: '' }) });
    r.onError({ error: errAt('ext') && Object.assign(new Error('x'), { stack: 'at y (safari-web-extension://abc/content.js:1:1)' }) });
    await tick();
    ok('cross-origin "Script error.", ResizeObserver and extension errors are ignored', sent.length === 0, 'sent ' + sent.length);
  }
  {
    const { r, sent } = mk();
    r.onRejection({ reason: errAt('rejected', 'x.js') });
    r.onRejection({ reason: undefined });
    r.onError({ message: 'Uncaught ReferenceError: foo is not defined', filename: 'https://h/pro/js/a.js?v=2', lineno: 3, colno: 4 });
    await tick();
    ok('unhandled rejections (with or without a reason) and event-only errors are reported',
      sent.length === 3 && sent[0].kind === 'unhandledrejection' && sent[2].kind === 'error' && /a\.js:3:4/.test(sent[2].stack), JSON.stringify(sent.map((s) => s.kind)));
    const scrubbed = mk();
    scrubbed.r.onError({ error: errAt('lead jo@x.com phone 859-555-1234 at 12 Oak Street') });
    await tick();
    ok('the sent message is scrubbed', !/jo@x|555|Oak Street/.test(scrubbed.sent[0].message), scrubbed.sent[0].message);
  }

  console.log('\nB2. callables through window._httpsCallable');
  {
    const { r, sent, win } = mk();
    r.install();
    ok('install adds error + unhandledrejection listeners', (win._listeners.error || []).length === 1 && (win._listeners.unhandledrejection || []).length === 1);
    const internal = Object.assign(new Error('internal'), { code: 'functions/internal', stack: 'Error: internal\n at q (https://www.gstatic.com/firebasejs/x/firebase-functions.js:1:2)' });
    const denied = Object.assign(new Error('nope'), { code: 'functions/permission-denied' });
    const factory = (fns, name) => async (data) => {
      if (name === 'boom') throw internal;
      if (name === 'deny') throw denied;
      return { data: { echo: data } };
    };
    // Assigned AFTER install, the way the bootstrap module does it.
    win._httpsCallable = factory;
    ok('a later assignment is wrapped (accessor)', win._httpsCallable !== factory && win._httpsCallable.__nbdErrWrap === true);
    const okRes = await win._httpsCallable({}, 'fine')({ a: 1 });
    ok('a successful callable returns the same result', okRes && okRes.data && okRes.data.echo.a === 1);
    let caught = null;
    try { await win._httpsCallable({}, 'boom')({}); } catch (e) { caught = e; }
    ok('a failed callable rejects with the SAME error object', caught === internal);
    let caught2 = null;
    try { await win._httpsCallable({}, 'deny')({}); } catch (e) { caught2 = e; }
    await tick();
    ok('internal is reported as kind callable with the function name and code; permission-denied is not',
      caught2 === denied && sent.length === 1 && sent[0].kind === 'callable' && /^callable boom \[internal\]/.test(sent[0].message), JSON.stringify(sent));
    r.onRejection({ reason: internal });
    await tick();
    ok('the same failure left unhandled is not reported a second time', sent.length === 1, 'sent ' + sent.length);
  }

  // ═══ C. the clientError handler ═════════════════════════════════════════
  console.log('\nC. clientError handler');
  const { makeClientErrorHandler } = require(path.join(ROOT, 'functions/handlers/monitoring.js'))._test;
  function run(req, opts) {
    opts = opts || {};
    const logs = [];
    const calls = { ip: 0, uid: [] };
    const deps = {
      logger: {
        write: (e) => logs.push(['write', e]),
        warn: (m, d) => logs.push(['warn', m, d]),
        error: (m, d) => logs.push(['error', m, d]),
      },
      httpRateLimit: async (rq, rs, ns, limit) => { calls.ip++; calls.ipNs = ns; calls.ipLimit = limit; if (opts.ipLimited) { rs.status(429).json({}); return false; } return true; },
      enforceRateLimit: async (ns, key) => { calls.uid.push([ns, key]); if (opts.uidLimited) { const e = new Error('rl'); e.rateLimited = true; throw e; } },
    };
    const res = { statusCode: 200, ended: false, status(n) { this.statusCode = n; return this; }, end() { this.ended = true; return this; }, json() { this.ended = true; return this; }, set() { return this; } };
    return makeClientErrorHandler(deps)(Object.assign({ method: 'POST', headers: {} }, req), res).then(() => ({ res, logs, calls }));
  }
  const body = (o) => { const t = JSON.stringify(o); return { body: t, rawBody: Buffer.from(t) }; };
  const good = { kind: 'error', message: 'TypeError: x is undefined (lead jo@x.com)', stack: 'at a (https://h/pro/js/crm.js?v=3&token=SECRET:10:5)', page: 'dashboard', view: 'crm', build: 'loader-116', ua: 'iPhone', standalone: true, online: true, uidHash: 'abcdef0123456789', sig: 'ffffffff' };

  let t = await run({ method: 'GET' });
  ok('GET → 405', t.res.statusCode === 405 && t.logs.length === 0);
  t = await run({ body: {}, rawBody: Buffer.alloc(5000, 97) });
  ok('a body over 4 KiB → 413, nothing logged, limiter never touched', t.res.statusCode === 413 && t.logs.length === 0 && t.calls.ip === 0);
  t = await run(body(good), { ipLimited: true });
  ok('per-IP limit (clientError:ip, 30/min) → 429 and nothing logged',
    t.res.statusCode === 429 && t.logs.length === 0 && t.calls.ipNs === 'clientError:ip' && t.calls.ipLimit === 30);
  t = await run({ body: 'not json{', rawBody: Buffer.from('not json{') });
  ok('junk → 400 + a client_error_rejected warning, no ERROR line',
    t.res.statusCode === 400 && t.logs.length === 1 && t.logs[0][1] === 'client_error_rejected' && t.logs[0][2].reason === 'bad_json');
  t = await run(body({ kind: 'error', stack: 'x' }));
  ok('no message → 400', t.res.statusCode === 400 && t.logs[0][2].reason === 'no_message');
  t = await run(body([1, 2]));
  ok('an array → 400', t.res.statusCode === 400 && t.logs[0][2].reason === 'not_object');
  t = await run(body(good), { uidLimited: true });
  ok('per-uid-hash limit → 429, nothing logged', t.res.statusCode === 429 && t.logs.length === 0 && t.calls.uid[0][0] === 'clientError:uid' && t.calls.uid[0][1] === good.uidHash);
  t = await run(body(good));
  const w = t.logs[0] && t.logs[0][1];
  ok('valid → 204 and exactly ONE log line', t.res.statusCode === 204 && t.logs.length === 1 && t.logs[0][0] === 'write');
  ok("that line is severity ERROR, message 'client_error', event 'client_error'",
    w && w.severity === 'ERROR' && w.message === 'client_error' && w.event === 'client_error', JSON.stringify(w));
  ok('fields are re-scrubbed server-side (email, token query gone)',
    w && /\[email\]/.test(w.errorMessage) && !/SECRET|jo@x/.test(JSON.stringify(w)), w && w.errorMessage + ' | ' + w.stack);
  ok('the signature is recomputed, not trusted from the client', w && /^[0-9a-f]{12}$/.test(w.sig) && w.sig !== good.sig);
  ok('context survives: page/view/build/standalone/online/uidHash',
    w && w.page === 'dashboard' && w.view === 'crm' && w.build === 'loader-116' && w.standalone === true && w.online === true && w.uidHash === good.uidHash);
  t = await run({ body: { message: 'hi', uidHash: 'NOT-A-HASH', page: '<script>' }, rawBody: Buffer.from('{}') });
  ok('a bad uidHash or page slug is dropped (and no uid limiter call)', t.res.statusCode === 204 && t.logs[0][1].uidHash === '' && t.logs[0][1].page === '' && t.calls.uid.length === 0);
  t = await run(body({ message: 'x'.repeat(1000), stack: Array(30).fill('at f (a.js:1:1)').join('\n') }));
  ok('message ≤ 300 chars, stack ≤ 8 lines', t.logs[0][1].errorMessage.length === 300 && t.logs[0][1].stack.split('\n').length === 8);

  console.log('\nC2. why logger.write — the real firebase-functions logger');
  {
    const { logger } = require(path.join(ROOT, 'functions/node_modules/firebase-functions/lib/v2/index.js'));
    const out = [];
    const origErr = process.stderr.write, origOut = process.stdout.write;
    const cap = function (chunk) { out.push(String(chunk)); return true; };
    process.stderr.write = cap; process.stdout.write = cap;
    try {
      logger.error('client_error', { a: 1 });
      logger.write({ severity: 'ERROR', message: 'client_error', event: 'client_error' });
    } finally { process.stderr.write = origErr; process.stdout.write = origOut; }
    const lines = out.join('').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    ok('logger.error turns the message into a stack ("Error: client_error\\n at …") — an exact filter would miss it',
      lines[0] && lines[0].message !== 'client_error' && /^Error: client_error/.test(lines[0].message), JSON.stringify(lines[0]).slice(0, 120));
    ok("logger.write keeps message exactly 'client_error'", lines[1] && lines[1].message === 'client_error' && lines[1].event === 'client_error');
  }

  // ═══ D. wiring ══════════════════════════════════════════════════════════
  console.log('\nD. wiring');
  for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
    const html = read(page);
    const at = html.search(/<script defer src="js\/client-error-reporter\.js\?v=\d+"><\/script>/);
    const boot = html.search(/<script type="module" src="js\/(dashboard|customer)-bootstrap\.module\.js/);
    ok(page + ' loads the reporter deferred, BEFORE the bootstrap module', at > 0 && boot > at, at + ' vs ' + boot);
  }
  const fb = JSON.parse(read('firebase.json'));
  ok('hosting rewrite /api/client-error → clientError', fb.hosting.rewrites.some((r) => r.source === '/api/client-error' && r.function && r.function.functionId === 'clientError'));
  ok('index.js exports clientError', /exports\.clientError = monitoringHandlers\.clientError;/.test(read('functions/index.js')));
  ok('FUNCTIONS_INDEX has a clientError row', /\| `clientError` \| onRequest \|/.test(read('functions/FUNCTIONS_INDEX.md')));
  ok('rate-limit-policy records clientError 30/30', /clientError:\s*\{\s*uidLimit:\s*30,[^}]*ipLimit:\s*30/.test(read('functions/rate-limit-policy.js')));
  for (const f of ['alert-client-error-new-signature.json', 'alert-client-error-spike.json', 'alert-csp-report-spike.json']) {
    let j = null; try { j = JSON.parse(read('monitoring/' + f)); } catch (_) { /* */ }
    const filt = j && j.conditions && j.conditions[0] && (j.conditions[0].conditionMatchedLog || j.conditions[0].conditionThreshold).filter;
    ok(f + ' parses, names Jo\'s two channels, filters a lowercase service',
      !!j && j.notificationChannels.length === 2 && /service_name=\\?"(clienterror|cspreport)"/.test(filt || ''), filt);
  }
  const sigPolicy = JSON.parse(read('monitoring/alert-client-error-new-signature.json'));
  ok('new-signature policy matches jsonPayload.event and extracts sig',
    /jsonPayload\.event="client_error"/.test(sigPolicy.conditions[0].conditionMatchedLog.filter)
    && sigPolicy.conditions[0].conditionMatchedLog.labelExtractors.sig === 'EXTRACT(jsonPayload.sig)');
  ok('INDEX links the runbook', /\]\(runbooks\/CLIENT-ERROR-ALERTS\.md\)/.test(read('documentation/INDEX.md')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
