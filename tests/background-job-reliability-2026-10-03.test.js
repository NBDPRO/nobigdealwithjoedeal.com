/**
 * tests/background-job-reliability-2026-10-03.test.js
 *
 * Background-job reliability fixes (2026-10-03), each driven against the REAL
 * module with its dependencies stubbed at Module._load:
 *
 *   A. lead-followup.js — the "we haven't connected" email used to be sent
 *      and stamped (followUpEmailSentAt) in ONE try: a send that went out but
 *      whose stamp write failed left the lead eligible, so the homeowner got
 *      the same email every 3 hours until the lead aged out of the 20–48h
 *      window. Now the lead is claimed ('sending') BEFORE the send.
 *   B. integrations/thursday.js — a 'processing' doc whose run was killed by
 *      the trigger timeout could never move again: the trigger only proceeds
 *      for pending/reprocess, and thursdayCallAction refused 'reprocess'
 *      while 'processing'. A STALE claim (same STALE_PROCESSING_MS as claim())
 *      is now re-queueable, and the swallowed failure write is logged.
 *   C. Outbound calls in request paths carry a timeout (AbortSignal.timeout):
 *      hail.js lookups and handlers/geocode.js Google + Regrid. (The Upstash
 *      limiter this also covered was removed 2026-10-04; its block now proves
 *      the limiter makes no network call at all.) A fetch stub
 *      that never answers on its own proves each call rejects when its signal
 *      fires, and AbortSignal.timeout is spied to pin each budget under the
 *      owning function's timeout.
 *
 * Funnel recovery paging, the health digest's id-range read and the calendar
 * reconcile paging are covered in their own suites
 * (funnel-recovery-hardening, health-digest-usage-signals,
 * google-calendar-sync-2026-09-29).
 *
 * Needs functions/node_modules (junctioned in a worktree).
 * Run: node tests/background-job-reliability-2026-10-03.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

let stubs = {};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) {
  const p = require.resolve(path.join(FN, file));
  delete require.cache[p];
  return require(p);
}

function makeLogger() {
  const logs = { error: [], warn: [], info: [] };
  return {
    logs,
    logger: {
      error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a),
      info: (...a) => logs.info.push(a), debug: () => {},
    },
  };
}

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

(async () => {

// ═══ A. lead-followup: claim before send ═════════════════════════════════
console.log('A. leadFollowUpSweep claims the lead before sending');
function leadFollowupWorld(opts) {
  const docs = {};
  const sends = [];
  const L = makeLogger();
  const now = Date.now();
  docs['estimate_leads/p1'] = { email: 'homeowner@example.com', firstName: 'Pat', createdAt: { toMillis: () => now - 30 * 3600e3 } };
  const ref = (p) => ({
    id: p.split('/').pop(),
    async get() { return { exists: !!docs[p], data: () => docs[p] }; },
    async update(d) {
      if (opts.updateThrows && opts.updateThrows(p, d)) throw new Error('simulated Firestore write failure');
      docs[p] = Object.assign({}, docs[p] || {}, d);
    },
  });
  const coll = (name) => {
    const q = {
      where: () => q, limit: () => q,
      async get() {
        let rows;
        if (name === 'leads') rows = [{ id: 'crm-1', data: () => ({ stage: 'new', status: 'new' }) }];
        else rows = Object.keys(docs).filter((k) => k.startsWith(name + '/'))
          .map((k) => ({ id: k.split('/')[1], data: () => Object.assign({}, docs[k]), ref: ref(k) }));
        return { empty: rows.length === 0, docs: rows, size: rows.length };
      },
      doc: (id) => ref(name + '/' + id),
    };
    return q;
  };
  const db = { collection: coll, doc: ref };
  stubs = {
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__ts__' },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k-' + n }) },
    'firebase-functions/v2': { logger: L.logger },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
    './lead-bridge-logic': { isFollowUpEvent: () => false },
    './email-suppression': {
      READ_TIMEOUT_MS: 1000,
      gateCommercialEmail: async () => ({ suppressed: false, headers: {}, tags: [] }),
      applyFooter: (u, html, text) => ({ html, text }),
    },
    resend: {
      Resend: function () {
        this.emails = { send: async (m) => { sends.push(m); return opts.reject && opts.reject(sends.length) ? { data: null, error: { message: 'provider down' } } : { data: { id: 're_' + sends.length }, error: null }; } };
      },
    },
  };
  delete process.env.LEAD_FOLLOWUP_ENABLED;
  const mod = fresh('lead-followup.js');
  return { mod, docs, sends, logs: L.logs };
}
{
  // The stamp write (the one carrying followUpEmailSentAt) fails every time.
  const w = leadFollowupWorld({ updateThrows: (p, d) => Object.prototype.hasOwnProperty.call(d, 'followUpEmailSentAt') });
  await w.mod.leadFollowUpSweep.__handler({});
  ok('sweep 1 sends the follow-up once', w.sends.length === 1, w.sends.length);
  ok('...the post-send stamp never landed (simulated failure)', !w.docs['estimate_leads/p1'].followUpEmailSentAt, w.docs['estimate_leads/p1']);
  await w.mod.leadFollowUpSweep.__handler({});
  await w.mod.leadFollowUpSweep.__handler({});
  ok('sweeps 2 and 3 (3h apart, lead still in the window) send NOTHING more', w.sends.length === 1, w.sends.length);
  ok('the lead stays claimed', w.docs['estimate_leads/p1'].followUpEmailStatus === 'sending', w.docs['estimate_leads/p1']);
  ok('the stamp failure is logged loudly', w.logs.error.some((a) => /stamp failed after send/.test(String(a[0]))), w.logs.error.map((a) => a[0]));
}
{
  // The claim itself cannot be written → nothing is sent.
  const w = leadFollowupWorld({ updateThrows: (p, d) => d.followUpEmailStatus === 'sending' });
  await w.mod.leadFollowUpSweep.__handler({});
  ok('an unwritable claim sends nothing (retried next sweep)', w.sends.length === 0, w.sends.length);
}
{
  // A genuine Resend rejection releases the claim; the next sweep retries.
  const w = leadFollowupWorld({ reject: (n) => n === 1 });
  await w.mod.leadFollowUpSweep.__handler({});
  ok('a rejected send is marked failed, not left claimed', w.docs['estimate_leads/p1'].followUpEmailStatus === 'failed' && !w.docs['estimate_leads/p1'].followUpEmailSentAt, w.docs['estimate_leads/p1']);
  await w.mod.leadFollowUpSweep.__handler({});
  ok('...and the next sweep retries and succeeds', w.sends.length === 2 && w.docs['estimate_leads/p1'].followUpEmailStatus === 'sent' && !!w.docs['estimate_leads/p1'].followUpEmailSentAt, w.docs['estimate_leads/p1']);
  await w.mod.leadFollowUpSweep.__handler({});
  ok('...then never again', w.sends.length === 2, w.sends.length);
}

// ═══ B. Thursday: a stale 'processing' claim is recoverable ═══════════════
console.log('\nB. Thursday calls stuck in processing');
function thursdayWorld(opts) {
  const docs = Object.assign({}, opts.docs || {});
  const L = makeLogger();
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    async get() { return { exists: !!docs[p], id: p.split('/').pop(), data: () => docs[p] && Object.assign({}, docs[p]) }; },
    async update(d) {
      if (opts.updateThrows) throw new Error('simulated update failure');
      docs[p] = Object.assign({}, docs[p] || {}, d);
    },
    async set(d) { docs[p] = Object.assign({}, d); },
  });
  const q = () => { const b = { where: () => b, select: () => b, limit: () => b, orderBy: () => b, async get() { return { empty: true, docs: [], size: 0, forEach() {} }; } }; return b; };
  const db = {
    doc: ref,
    collection: (n) => Object.assign(q(), { doc: (id) => ref(n + '/' + id) }),
    runTransaction: async (fn) => fn({
      get: (r) => r.get(),
      update: (r, d) => { docs[r.path] = Object.assign({}, docs[r.path] || {}, d); },
    }),
  };
  stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError },
    'firebase-functions/v2/firestore': { onDocumentWritten: (o, h) => ({ __handler: h }) },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
    'firebase-functions/v2': { logger: L.logger },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => ({ toMillis: () => Date.now() }), increment: (n) => n, delete: () => undefined },
    },
    'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({}) }) },
    './_shared': {
      SECRETS: { BLAND_API_KEY: { name: 'BLAND_API_KEY' }, THURSDAY_LOOKUP_TOKEN: { name: 'THURSDAY_LOOKUP_TOKEN' } },
      getSecret: () => '', hasSecret: () => false, secretValue: () => '', secretOr: (s, d) => d,
    },
    './upstash-ratelimit': { enforceRateLimit: async () => ({}), clientIp: () => '203.0.113.1' },
    '../customer-id-mint': { createLeadWithCustomerId: async () => ({}), isAlreadyExists: () => false },
  };
  const mod = fresh('integrations/thursday.js');
  return { mod, docs, logs: L.logs };
}
const CALL = 'callABC123';
const T = require(path.join(FN, 'integrations', 'thursday-logic.js'));
const CALL_PATH = 'thursday_calls/' + T.callDocId(CALL);
const tsAgo = (ms) => ({ toMillis: () => Date.now() - ms });
const admin = { uid: 'u-owner', token: { role: 'admin' } };
{
  const w = thursdayWorld({ docs: { [CALL_PATH]: { status: 'processing', processingStartedAt: tsAgo(20 * 60e3), userId: 'u-owner', companyId: 'co-1' } } });
  let res = null, err = null;
  try { res = await w.mod.thursdayCallAction.__handler({ auth: admin, data: { callId: CALL, action: 'reprocess' } }); } catch (e) { err = e; }
  ok('a call stuck in processing for 20 min (run killed by the timeout) CAN be reprocessed', !err && res && res.ok === true, err && (err.code + ' ' + err.message));
  ok('...and is re-queued as reprocess (which the trigger picks up)', w.docs[CALL_PATH].status === 'reprocess', w.docs[CALL_PATH].status);
}
{
  const w = thursdayWorld({ docs: { [CALL_PATH]: { status: 'processing', processingStartedAt: tsAgo(60e3), userId: 'u-owner', companyId: 'co-1' } } });
  let err = null;
  try { await w.mod.thursdayCallAction.__handler({ auth: admin, data: { callId: CALL, action: 'reprocess' } }); } catch (e) { err = e; }
  ok('a LIVE run (claimed 1 min ago) is still refused', !!err && err.code === 'failed-precondition' && w.docs[CALL_PATH].status === 'processing', err && err.code);
}
{
  // The trigger: processing throws (every doc write fails) and so does the
  // failure write — that second failure must be logged, not swallowed.
  const w = thursdayWorld({
    updateThrows: true,
    docs: { [CALL_PATH]: { status: 'pending', userId: 'u-owner', companyId: 'co-1', call: { callId: CALL, transcript: 'hello this is a caller asking about a roof leak over the kitchen and gutters please call me back soon thanks so much' } } },
  });
  global.fetch = async () => { throw new Error('no network in tests'); };
  const after = { exists: true, data: () => w.docs[CALL_PATH], ref: { id: T.callDocId(CALL), path: CALL_PATH, get: async () => ({ exists: true, data: () => w.docs[CALL_PATH] }), update: async () => { throw new Error('simulated update failure'); } } };
  // claim() goes through db.runTransaction on the same path.
  after.ref.path = CALL_PATH;
  await w.mod.thursdayCallProcess.__handler({ data: { after } });
  ok('the claim moved the doc to processing', w.docs[CALL_PATH].status === 'processing', w.docs[CALL_PATH].status);
  const flat = w.logs.error.map((a) => JSON.stringify(a));
  ok('the processing failure is logged', flat.some((s) => /processing failed/.test(s)), flat);
  ok('the FAILED failure-write is logged too (was .catch(() => {}))', flat.some((s) => /failure write failed/.test(s) && /simulated update failure/.test(s)), flat);
}

// ═══ C. outbound timeouts ═════════════════════════════════════════════════
console.log('\nC. outbound calls in request paths carry a timeout');
const realTimeout = AbortSignal.timeout;
const timeouts = [];
// Spy: record the budget, hand back a signal the test fires at once — the
// "provider hangs until the signal fires" case without waiting seconds.
AbortSignal.timeout = (ms) => { timeouts.push(ms); const c = new AbortController(); setImmediate(() => c.abort(new DOMException('timed out', 'TimeoutError'))); return c.signal; };
const hangingFetch = (log) => async (url, init) => {
  log.push({ url: String(url), signal: init && init.signal });
  if (!init || !init.signal) return new Promise(() => {}); // never answers
  return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted'))));
};
async function settles(p, ms) {
  let t;
  const guard = new Promise((resolve) => { t = setTimeout(() => resolve('HUNG'), ms); });
  try { const r = await Promise.race([p.then((v) => ({ v }), (e) => ({ e })), guard]); return r; } finally { clearTimeout(t); }
}
{
  stubs = {};
  process.env.NBD_HAIL_PROVIDER = 'hailtrace';
  process.env.HAILTRACE_API_KEY = 'ht-test-key';
  for (const f of ['integrations/_shared.js', 'integrations/hail.js']) delete require.cache[require.resolve(path.join(FN, f))];
  const hail = require(path.join(FN, 'integrations', 'hail.js'));
  const log = [];
  global.fetch = hangingFetch(log);
  timeouts.length = 0;
  const r = await settles(hail.lookupHail(38.2, -84.5, 3, 365), 2000);
  // 2026-10-04: HailTrace was removed (VENDOR-COST-LOCKIN Lane C). A stale
  // NBD_HAIL_PROVIDER=hailtrace plus a key must now select NOAA and never
  // reach api.hailtrace.com.
  ok('hail: a hung NOAA provider rejects instead of hanging the callable', r !== 'HUNG' && !!r.e, r === 'HUNG' ? 'HUNG' : r);
  ok('hail: provider=hailtrace now selects NOAA — one bounded leg, nothing sent to HailTrace', log.length === 1 && log.every((x) => x.signal) && /mesonet/.test(log[0].url) && !log.some((x) => /hailtrace/i.test(x.url)), log.map((x) => x.url.slice(0, 40)));
  ok('hail: the NOAA leg fits inside getHailHistory\'s 20s', timeouts.length === 1 && timeouts[0] <= 18000, timeouts);
  delete process.env.NBD_HAIL_PROVIDER; delete process.env.HAILTRACE_API_KEY;
}
{
  stubs = {};
  const geo = fresh('handlers/geocode.js');
  const log = [];
  global.fetch = hangingFetch(log);
  timeouts.length = 0;
  const calls = [
    ['googleReverse', geo._googleReverse && geo._googleReverse(38.2, -84.5, 'AIza-test')],
    ['googleForward', geo._googleForward('1 Main St, Mason OH', 'AIza-test')],
    ['regridPoint', geo._regridPoint && geo._regridPoint(38.2, -84.5, 'regrid-token-xx')],
    ['regridAddress', geo._regridAddress('1 Main St, Mason OH', 'regrid-token-xx')],
  ];
  for (const [name, p] of calls) {
    const r = p ? await settles(p, 2000) : 'MISSING';
    ok('geocode ' + name + ': a hung provider rejects (the other provider\'s answer survives the .catch)', r !== 'HUNG' && r !== 'MISSING' && !!r.e, r);
  }
  ok('geocode: every request bounded under resolveAddress\'s 15s', log.length === 4 && log.every((x) => x.signal) && timeouts.length === 4 && timeouts.every((ms) => ms > 0 && ms <= 12000), timeouts);
}
{
  stubs = {
    '../rate-limit': { enforceRateLimit: async () => ({ via: 'firestore' }), httpRateLimit: async () => true },
  };
  process.env.NBD_RATE_LIMIT_PROVIDER = 'upstash';
  process.env.UPSTASH_REDIS_REST_URL = 'https://zzqa.upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'zzqa-token-0000000000';
  for (const f of ['integrations/_shared.js', 'integrations/upstash-ratelimit.js']) delete require.cache[require.resolve(path.join(FN, f))];
  const up = require(path.join(FN, 'integrations', 'upstash-ratelimit.js'));
  const log = [];
  global.fetch = hangingFetch(log);
  timeouts.length = 0;
  const r = await settles(up.enforceRateLimit('test:ns', 'k1', 10, 60000), 2000);
  // 2026-10-04: the Upstash backend was removed (never provisioned). Even with
  // the old env flag and both secrets present, every call must go straight to
  // the Firestore limiter and make no network request.
  ok('rate limit: with the old Upstash env + secrets set, enforceRateLimit answers from the Firestore limiter', r !== 'HUNG' && r.v && r.v.via === 'firestore', r);
  ok('rate limit: no outbound request is made (Upstash code is gone)', log.length === 0, log.map((x) => x.url));
  const h = await settles(up.httpRateLimit({ headers: {} }, {}, 'test:http', 10, 60000), 2000);
  ok('rate limit: httpRateLimit answers from the Firestore limiter, no outbound request', h !== 'HUNG' && h.v === true && log.length === 0, h);
  ok('rate limit: provider() reports firestore', up.provider() === 'firestore', up.provider());
  delete process.env.NBD_RATE_LIMIT_PROVIDER; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
}
AbortSignal.timeout = realTimeout;

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error('THREW:', e && e.stack); process.exit(1); });
