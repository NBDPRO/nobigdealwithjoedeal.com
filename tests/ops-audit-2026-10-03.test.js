/**
 * tests/ops-audit-2026-10-03.test.js — the ops fixes from the 2026-10-03 audit.
 *
 *  1. CSP reports: browsers post application/csp-report / reports+json, which
 *     the JSON parser skips. Every report logged blank until parseCspBody read
 *     the raw body.
 *  2. migrationsTick: "every 24 hours" restarted at each deploy and the tick
 *     hadn't run since 09-20. It's now a fixed daily time.
 *  3. Missing composite indexes for two real queries (notes type+createdAt,
 *     otp_requests phone+requestedAt).
 *  4. The AI SMS draft logs a failed thread read instead of hiding it.
 *  5. hailMatchCron retries transient fetch failures (and only those).
 *
 * Run: node tests/ops-audit-2026-10-03.test.js
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

(async () => {
  console.log('\n1. CSP reports are parsed from the raw body');
  const { parseCspBody } = require(path.join(ROOT, 'functions/handlers/monitoring.js'))._test;
  const legacy = Buffer.from(JSON.stringify({ 'csp-report': { 'document-uri': 'https://x.test/pro/', 'violated-directive': 'script-src', 'blocked-uri': 'inline' } }));
  let r = parseCspBody({}, legacy);
  ok('application/csp-report (unparsed, body {}) → one report with its fields', r.length === 1 && r[0]['violated-directive'] === 'script-src' && r[0]['document-uri'] === 'https://x.test/pro/', JSON.stringify(r));
  const modern = Buffer.from(JSON.stringify([{ type: 'csp-violation', body: { documentURL: 'https://x.test/', effectiveDirective: 'img-src', blockedURL: 'https://evil.test/a.png' } }, { type: 'csp-violation', body: { documentURL: 'https://x.test/b', effectiveDirective: 'style-src' } }]));
  r = parseCspBody({}, modern);
  ok('application/reports+json array → each report body', r.length === 2 && r[0].effectiveDirective === 'img-src' && r[1].documentURL === 'https://x.test/b', JSON.stringify(r));
  r = parseCspBody({ 'csp-report': { 'blocked-uri': 'eval' } }, legacy);
  ok('an already-parsed JSON body is used as-is', r.length === 1 && r[0]['blocked-uri'] === 'eval');
  ok('an empty or junk body logs nothing (no blank lines)', parseCspBody({}, Buffer.from('')).length === 0 && parseCspBody({}, Buffer.from('not json')).length === 0 && parseCspBody(undefined, undefined).length === 0);
  ok('a Buffer req.body (raw passthrough) is parsed too', parseCspBody(legacy, legacy).length === 1);
  const mon = read('functions/handlers/monitoring.js');
  ok('the handler routes through parseCspBody', /const reports = parseCspBody\(req\.body, raw\);/.test(mon));

  console.log('\n2. migrationsTick runs at a fixed time');
  const runner = read('functions/migrations/runner.js');
  ok("schedule is a fixed daily time, not 'every 24 hours'", /exports\.migrationsTick = onSchedule\(\s*\{ schedule: 'every day \d\d:\d\d', timeZone: 'America\/New_York'/.test(runner) && !/'every 24 hours'/.test(runner));

  console.log('\n3. The two missing composite indexes exist');
  const idx = JSON.parse(read('firestore.indexes.json')).indexes;
  const has = (cg, fields) => idx.some((i) => i.collectionGroup === cg && i.queryScope === 'COLLECTION' && JSON.stringify(i.fields.map((f) => [f.fieldPath, f.order])) === JSON.stringify(fields));
  ok('notes(type ASC, createdAt DESC) — the AI SMS draft thread read', has('notes', [['type', 'ASCENDING'], ['createdAt', 'DESCENDING']]));
  ok('otp_requests(phone ASC, requestedAt ASC) — the OTP rate limit', has('otp_requests', [['phone', 'ASCENDING'], ['requestedAt', 'ASCENDING']]));
  ok('the queries those indexes serve are still the same shape',
    /\.collection\('notes'\)\s*\.where\('type', '==', 'sms'\)\s*\.orderBy\('createdAt', 'desc'\)/.test(read('functions/handlers/ai-texting.js'))
    && /collection\('otp_requests'\)[\s\S]{0,120}where\('phone', '=='[\s\S]{0,80}where\('requestedAt', '>'/.test(read('functions/verify-functions.js')));

  console.log('\n4. The AI SMS draft no longer hides a failed thread read');
  ok('the notes read logs ai_sms_thread_read_failed', /\.limit\(12\)\.get\(\)\.catch\(\(e\) => \{ logger\.warn\('ai_sms_thread_read_failed'/.test(read('functions/handlers/ai-texting.js')));

  console.log('\n5. hailMatchCron retries transient failures only');
  const { retryTransient, isTransient } = require(path.join(ROOT, 'functions/integrations/retry-transient.js'));
  const noSleep = { sleep: async () => {} };
  let n = 0;
  let v = await retryTransient(async () => { n++; if (n === 1) throw new TypeError('fetch failed'); return 'ok'; }, noSleep);
  ok('a "fetch failed" blip is retried and the call succeeds', v === 'ok' && n === 2);
  n = 0;
  let err = null;
  try { await retryTransient(async () => { n++; throw new Error('Unexpected token < in JSON'); }, noSleep); } catch (e) { err = e; }
  ok('a real (non-transient) error is NOT retried', err && n === 1);
  n = 0; err = null;
  try { await retryTransient(async () => { n++; throw new Error('terminated'); }, noSleep); } catch (e) { err = e; }
  ok('a persistent transient error gives up after the retries (3 tries)', err && n === 3);
  ok('timeouts and aborts count as transient', isTransient({ name: 'TimeoutError', message: 'x' }) && isTransient({ name: 'AbortError', message: 'x' }) && isTransient(new Error('socket hang up')));
  const hc = read('functions/integrations/hail-cron.js');
  // One fetcher now: the HailTrace branch (the second timeout) was removed
  // 2026-10-04 — VENDOR-COST-LOCKIN Lane C. NOAA's fetch keeps its timeout.
  ok('the cron wraps the provider fetch in retryTransient, with a fetch timeout', /await retryTransient\(\(\) => fetcher\(lat, lng, RADIUS_MI, DAYS_BACK\)\)/.test(hc) && (hc.match(/signal: AbortSignal\.timeout\(20000\)/g) || []).length === 1 && !/hailtrace\.com/.test(hc));
  ok('retry-transient.js is a helper, not a deployed function', !/retry-transient/.test(read('functions/index.js')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
