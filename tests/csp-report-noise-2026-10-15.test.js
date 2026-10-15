/**
 * tests/csp-report-noise-2026-10-15.test.js — cspReport stops paging Joe.
 *
 * Since 10-12 one iPhone (Brave, iOS 18.7, WebKit) sent ~300 CSP reports that
 * all logged blank, tripped the 60/min per-IP limit, and every
 * rate_limit_denied WARNING matched the "Rate-limit denial (any…)" SMS alert.
 * ~1 in 4 requests also hit the 5 s timeout (504): ~80 concurrent Firestore
 * transactions on that IP's one counter doc.
 *
 *  1. Three body shapes parse: legacy csp-report, Reporting API array, and
 *     the single Reporting API object WebKit sends (the blank-log bug).
 *  2. Extension-caused reports are ignored.
 *  3. Dedupe: same directive+blocked+document from one IP within 10 min is
 *     dropped BEFORE the limiter (no Firestore call, cannot trip the limit).
 *  4. Every POST path ends with 204 (oversize, bad JSON, duplicate, denied,
 *     slow limiter, limiter error, handler throw); non-POST is 405.
 *  5. Denials log INFO 'csp_report_rate_limited' (sampled:true) at most once
 *     per IP per 10 min, never the paging WARNING; the limiter is told not to.
 *  6. The shared limiter still logs rate_limit_denied for everyone else.
 *  7. The alert policy no longer matches cspReport but still matches the
 *     lead / OTP / AI namespaces.
 *
 * Run: node tests/csp-report-noise-2026-10-15.test.js   (no deps)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const L = require(path.join(ROOT, 'functions/csp-report-logic.js'));

// ── a fake req/res and handler harness ────────────────────────────────────
function mkRes() {
  const res = { statusCode: null, ended: false, headersSent: false, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.json = () => { res.ended = true; res.headersSent = true; return res; };
  res.end = () => { res.ended = true; res.headersSent = true; return res; };
  return res;
}
function mkReq(bodyObj, opts) {
  const o = opts || {};
  const raw = o.raw != null ? o.raw : Buffer.from(typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj));
  return { method: o.method || 'POST', body: o.body != null ? o.body : {}, rawBody: raw, headers: { 'user-agent': 'UA-test' }, ip: o.ip || '203.0.113.7' };
}
function harness(limiterImpl, extra) {
  const logs = [];
  const limiterCalls = [];
  const logger = {
    warn: (m, d) => logs.push({ sev: 'WARNING', m, d }),
    info: (m, d) => logs.push({ sev: 'INFO', m, d }),
  };
  let clock = 1_000_000;
  const handler = L.makeCspReportHandler(Object.assign({
    logger,
    enforceRateLimit: (...a) => { limiterCalls.push(a); return limiterImpl ? limiterImpl(...a) : Promise.resolve({ allowed: true }); },
    clientIp: (req) => req.ip,
    rateLimitIpKey: (ip) => ip,
    hashKey: (s) => 'h' + String(s).replace(/\W/g, ''),
    now: () => clock,
  }, extra || {}));
  return { handler, logs, limiterCalls, tick: (ms) => { clock += ms; } };
}
const denied = () => Promise.reject(Object.assign(new Error('rate_limited'), { rateLimited: true, retryAfterMs: 30_000 }));
const viol = (logs) => logs.filter((l) => l.m === 'csp_violation');

const LEGACY = { 'csp-report': { 'document-uri': 'https://nobigdealwithjoedeal.com/privacy', 'violated-directive': 'style-src-elem', 'effective-directive': 'style-src-elem', 'blocked-uri': 'inline', disposition: 'report', 'source-file': 'https://nobigdealwithjoedeal.com/privacy', 'line-number': 36 } };
const ARRAY = [
  { type: 'csp-violation', age: 3, url: 'https://nobigdealwithjoedeal.com/', body: { documentURL: 'https://nobigdealwithjoedeal.com/', effectiveDirective: 'style-src-elem', blockedURL: 'inline', disposition: 'report', sourceFile: 'https://nobigdealwithjoedeal.com/', lineNumber: 37 } },
  { type: 'deprecation', url: 'https://nobigdealwithjoedeal.com/', body: { id: 'x', message: 'not a CSP report' } },
  { type: 'csp-violation', url: 'https://nobigdealwithjoedeal.com/inspect', body: { effectiveDirective: 'img-src', blockedURL: 'https://evil.test/p.png', disposition: 'enforce' } },
];
// What WebKit (Safari / Brave on iOS) posts: ONE object, not an array.
const WEBKIT = { type: 'csp-violation', age: 0, url: 'https://nobigdealwithjoedeal.com/terms', user_agent: 'iPhone', body: { documentURL: 'https://nobigdealwithjoedeal.com/terms', effectiveDirective: 'style-src-elem', blockedURL: 'inline', disposition: 'report', originalPolicy: "default-src 'self'", sourceFile: 'https://nobigdealwithjoedeal.com/terms', lineNumber: 38, statusCode: 200 } };

(async () => {
  console.log('\n1. All three body shapes parse to normalized reports');
  let r = L.parseCspReports({}, Buffer.from(JSON.stringify(LEGACY)));
  ok('legacy {"csp-report":{…}} (application/csp-report)', r.length === 1 && r[0].directive === 'style-src-elem' && r[0].blocked === 'inline' && r[0].document === 'https://nobigdealwithjoedeal.com/privacy' && r[0].disposition === 'report' && r[0].sourceFile === 'https://nobigdealwithjoedeal.com/privacy' && r[0].line === 36, JSON.stringify(r));
  r = L.parseCspReports({}, Buffer.from(JSON.stringify(ARRAY)));
  ok('Reporting API array: each csp-violation body, non-CSP types skipped', r.length === 2 && r[0].line === 37 && r[1].directive === 'img-src' && r[1].disposition === 'enforce', JSON.stringify(r));
  ok('Reporting API array: a body without documentURL falls back to the wrapper url', r[1].document === 'https://nobigdealwithjoedeal.com/inspect', JSON.stringify(r[1]));
  r = L.parseCspReports({}, Buffer.from(JSON.stringify(WEBKIT)));
  ok('single Reporting API object (WebKit) → its body, NOT a blank wrapper', r.length === 1 && r[0].directive === 'style-src-elem' && r[0].document === 'https://nobigdealwithjoedeal.com/terms' && r[0].line === 38 && r[0].statusCode === 200, JSON.stringify(r));
  ok('a string req.body (text parser) is parsed', L.parseCspReports(JSON.stringify(WEBKIT), undefined).length === 1);
  ok('an already-parsed object body is used as-is', L.parseCspReports(WEBKIT, Buffer.from('ignored')).length === 1);
  ok('a non-CSP single object yields nothing', L.parseCspReports({}, Buffer.from(JSON.stringify({ type: 'intervention', body: { message: 'x' } }))).length === 0);
  ok('bad JSON / empty / blank wrapper yields nothing', L.parseCspReports({}, Buffer.from('{not json')).length === 0 && L.parseCspReports({}, Buffer.from('')).length === 0 && L.parseCspReports({}, Buffer.from(JSON.stringify({ type: 'csp-violation', body: {} }))).length === 0);
  ok('fields are length-bounded', L.parseCspReports({ 'csp-report': { 'blocked-uri': 'x'.repeat(5000) } }).map((n) => n.blocked.length)[0] === 400);

  console.log('\n2. Browser-extension reports are ignored');
  ok('chrome-extension:// source file → extension', L.isExtensionReport({ sourceFile: 'chrome-extension://abc/inject.js', blocked: 'inline' }));
  ok('safari-web-extension:// blocked URL → extension', L.isExtensionReport({ sourceFile: '', blocked: 'safari-web-extension://x/s.css' }));
  ok('our own page is not an extension', !L.isExtensionReport({ sourceFile: 'https://nobigdealwithjoedeal.com/', blocked: 'inline' }));
  {
    const h = harness();
    const res = mkRes();
    await h.handler(mkReq({ 'csp-report': { 'document-uri': 'https://x/', 'violated-directive': 'script-src', 'blocked-uri': 'inline', 'source-file': 'moz-extension://y/c.js' } }), res);
    ok('an extension report is not logged and costs no limiter call', res.statusCode === 204 && viol(h.logs).length === 0 && h.limiterCalls.length === 0);
  }

  console.log('\n3. Dedupe before the limiter');
  {
    const h = harness();
    for (let i = 0; i < 300; i++) { const res = mkRes(); await h.handler(mkReq(WEBKIT), res); }
    ok('300 identical reports from one IP → logged once, ONE limiter call', viol(h.logs).length === 1 && h.limiterCalls.length === 1, `logged=${viol(h.logs).length} limiter=${h.limiterCalls.length}`);
    const res2 = mkRes();
    await h.handler(mkReq(WEBKIT, { ip: '198.51.100.9' }), res2);
    ok('the same report from a different IP is logged', viol(h.logs).length === 2);
    await h.handler(mkReq(LEGACY), mkRes());
    ok('a different report from the same IP is logged', viol(h.logs).length === 3);
    h.tick(L.DEDUPE_WINDOW_MS + 1);
    await h.handler(mkReq(WEBKIT), mkRes());
    ok('after 10 minutes the same report is logged again', viol(h.logs).length === 4);
    const line = viol(h.logs)[0].d;
    ok('the log line carries the normalized fields + user agent', line.directive === 'style-src-elem' && line.blocked === 'inline' && line.document === 'https://nobigdealwithjoedeal.com/terms' && line.disposition === 'report' && line.sourceFile && line.line === 38 && line.userAgent === 'UA-test', JSON.stringify(line));
  }
  {
    const h = harness();
    const twice = [ARRAY[0], ARRAY[0], ARRAY[2]];
    await h.handler(mkReq(twice), mkRes());
    ok('duplicates inside one array body collapse too', viol(h.logs).length === 2);
  }
  {
    const set = L.createTtlSet(1000, 3);
    set.add('a', 0); set.add('b', 0); set.add('c', 0); set.add('d', 0);
    ok('the TTL set is size-bounded (evicts oldest)', set.size <= 3 && set.add('a', 1) === true);
  }

  console.log('\n4. Every POST path ends with a fast 204');
  async function path204(name, h, req, maxMs) {
    const res = mkRes();
    const t0 = Date.now();
    await h.handler(req, res);
    const ms = Date.now() - t0;
    ok(name + ' → 204, ended', res.statusCode === 204 && res.ended && ms <= (maxMs || 200), `status=${res.statusCode} ended=${res.ended} ms=${ms}`);
    return { res, h };
  }
  await path204('logged report', harness(), mkReq(WEBKIT));
  await path204('bad JSON', harness(), mkReq('{"csp-report": nope'));
  await path204('empty body', harness(), mkReq('', { raw: Buffer.alloc(0) }));
  {
    const h = harness();
    await path204('oversize body (> 8 KB, not parsed)', h, mkReq({ 'csp-report': { 'blocked-uri': 'x'.repeat(9000), 'violated-directive': 'img-src' } }));
    ok('oversize body is not logged and costs no limiter call', viol(h.logs).length === 0 && h.limiterCalls.length === 0);
  }
  await path204('duplicate', (() => { const h = harness(); h.handler(mkReq(WEBKIT), mkRes()); return h; })(), mkReq(WEBKIT));
  {
    const { res } = await path204('rate-limited', harness(denied), mkReq(WEBKIT));
    ok('rate-limited is not a 429 (no json body, no Retry-After)', !res.headers['Retry-After']);
  }
  {
    const never = () => new Promise(() => {});      // a transaction stuck behind contention
    const h = harness(never, { limiterTimeoutMs: 50 });
    await path204('limiter never resolves (the 504 cause)', h, mkReq(WEBKIT), 400);
    ok('a stuck limiter drops the report and logs csp_report_limiter_slow at INFO', viol(h.logs).length === 0 && h.logs.some((l) => l.m === 'csp_report_limiter_slow' && l.sev === 'INFO'));
  }
  {
    const h = harness(() => Promise.reject(new Error('firestore unavailable')));
    await path204('limiter backend error', h, mkReq(WEBKIT));
    ok('a limiter backend error fails open (report still logged)', viol(h.logs).length === 1);
  }
  {
    const h = harness();
    const req = mkReq(WEBKIT);
    Object.defineProperty(req, 'headers', { get() { throw new Error('boom'); } });
    await path204('handler throws', h, req);
  }
  {
    const h = harness();
    const res = mkRes();
    await h.handler(mkReq(WEBKIT, { method: 'GET' }), res);
    ok('non-POST → 405, ended', res.statusCode === 405 && res.ended);
  }
  ok('the function keeps a timeout above the limiter race', /timeoutSeconds: 5,/.test(read('functions/handlers/monitoring.js')) && L.LIMITER_TIMEOUT_MS < 5000);

  console.log('\n5. Denial logging is sampled INFO, not the paging WARNING');
  {
    const h = harness(denied);
    const bodies = [];
    for (let i = 0; i < 50; i++) bodies.push({ 'csp-report': { 'document-uri': 'https://x/' + i, 'violated-directive': 'img-src', 'blocked-uri': 'https://a/' + i } });
    for (const b of bodies) await h.handler(mkReq(b), mkRes());
    const den = h.logs.filter((l) => l.m === 'csp_report_rate_limited');
    ok('50 denials from one IP → ONE log line', den.length === 1, `got ${den.length}`);
    ok('it is INFO with sampled:true and the namespace', den[0] && den[0].sev === 'INFO' && den[0].d.sampled === true && den[0].d.namespace === 'cspReport:ip');
    ok('it carries a hashed IP, never the raw one', den[0] && den[0].d.ipHash && !JSON.stringify(den[0].d).includes('203.0.113.7'));
    ok('no rate_limit_denied and no WARNING from the denial path', !h.logs.some((l) => l.m === 'rate_limit_denied' || (l.sev === 'WARNING' && l.m !== 'csp_violation')));
    ok('the limiter is asked not to log its own WARNING', h.limiterCalls.every((a) => a[0] === 'cspReport:ip' && a[2] === 60 && a[3] === 60_000 && a[4] && a[4].logDenial === false));
    await h.handler(mkReq(bodies[0], { ip: '198.51.100.20' }), mkRes());
    ok('a second abusive IP gets its own sampled line', h.logs.filter((l) => l.m === 'csp_report_rate_limited').length === 2);
    h.tick(L.DENIAL_LOG_WINDOW_MS + 1);
    await h.handler(mkReq({ 'csp-report': { 'document-uri': 'https://x/late', 'violated-directive': 'img-src' } }), mkRes());
    const again = h.logs.filter((l) => l.m === 'csp_report_rate_limited' && l.d.ipHash === den[0].d.ipHash);
    ok('after 10 minutes the same IP logs again, counting what was suppressed', again.length === 2 && again[1].d.suppressedSinceLast === 49, JSON.stringify(again.map((x) => x.d.suppressedSinceLast)));
  }

  console.log('\n6. The shared limiter still logs rate_limit_denied for every other caller');
  {
    const rl = read('functions/rate-limit.js');
    ok("rate_limit_denied is skipped only on an explicit logDenial:false", /if \(!opts \|\| opts\.logDenial !== false\) \{\s*logger\(\)\.warn\('rate_limit_denied'/.test(rl));
    ok('the integrations wrapper passes opts through', /firestoreLimiter\.enforceRateLimit\(namespace, keyRaw, limit, windowMs, opts\)/.test(read('functions/integrations/upstash-ratelimit.js')));
    const others = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'functions')).concat(fs.readdirSync(path.join(ROOT, 'functions/handlers')).map((x) => 'handlers/' + x))) {
      if (!f.endsWith('.js') || f === 'csp-report-logic.js' || f === 'rate-limit.js') continue; // the caller, and the limiter's own doc comment
      if (/logDenial\s*:\s*false/.test(read('functions/' + f))) others.push(f);
    }
    ok('no other function opts out of the denial WARNING', others.length === 0, others.join(', '));
  }

  console.log('\n7. The paging alert ignores cspReport, keeps lead / OTP / AI');
  {
    const pol = JSON.parse(read('monitoring/alert-rate-limit-spike.json'));
    const filter = pol.conditions[0].conditionMatchedLog.filter;
    ok('still a WARNING rate_limit_denied matched-log on Cloud Run', /severity="WARNING"/.test(filter) && /jsonPayload\.message="rate_limit_denied"/.test(filter) && /resource\.type="cloud_run_revision"/.test(filter));
    // A tiny evaluator for the exclusion clause this file uses.
    const m = filter.match(/NOT jsonPayload\.namespace=~"([^"]+)"/);
    ok('cspReport namespaces are excluded by a regex clause', !!m, filter);
    const re = m ? new RegExp(m[1]) : /$^/;
    ok('cspReport:ip would not page', re.test('cspReport:ip'));
    // Real namespaces from functions/ (lead intake, OTP, AI, access code).
    const keep = ['publicLead:ip', 'publicLeadIntake:ip', 'publicLeadPhoto:ip', 'notifyNewLead:ip', 'sendVerificationCode:ip', 'verifyCode:ip', 'publicFunnelAI:ip', 'publicVisualizerAI:ip', 'visualizerImageGen:ip', 'analyzeRoofPhoto:ip', 'aiDraft:phone', 'validateAccessCode:ip', 'clientError:ip'];
    ok('lead / OTP / AI / access-code namespaces still page', keep.every((ns) => !re.test(ns)), keep.filter((ns) => re.test(ns)).join(', '));
    ok('notifications still at most every 10 min, same two channels', pol.alertStrategy.notificationRateLimit.period === '600s' && pol.notificationChannels.length === 2);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
