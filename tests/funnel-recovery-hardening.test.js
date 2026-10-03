/**
 * tests/funnel-recovery-hardening.test.js — three funnel-recovery hardening
 * fixes in functions/funnel-recovery.js:
 *
 *   1. DOUBLE-SEND: runAbandonRecovery sent the email first and stamped
 *      recoveryEmailSentAt second. If that second write threw (transient
 *      Firestore error, permission blip, deadline exceeded), the record fell
 *      back to a state the eligibility gate does not exclude (recoveryEmailSentAt
 *      stays null) and the NEXT hourly run mailed the same homeowner again.
 *      Fixed by claiming the record (recoveryEmailStatus: 'sending') BEFORE
 *      calling Resend, and excluding 'sending' records from the query gate
 *      regardless of whether the post-send stamp ever lands.
 *
 *   2. NO PER-EMAIL THROTTLE: saveFunnelProgress only rate-limited by IP
 *      (funnelProgress:ip). Since the doc ID is the client-generated
 *      funnelId, one IP could rotate through fresh funnelIds that all target
 *      the SAME attacker-supplied email, queuing an unbounded number of
 *      future recovery emails to an uninvolved address. Fixed by adding a
 *      3/day enforceRateLimit keyed on the normalized email.
 *
 *   3. HEARTBEAT SWALLOWS A REAL FAILURE: when FUNNEL_RECOVERY_ENABLED=true
 *      but RESEND_API_KEY isn't bound, the handler logged an error and did a
 *      plain `return` — withHeartbeat only pings the dead-man's-switch
 *      /fail endpoint on a throw, so this exact misconfiguration reported as
 *      a healthy, on-time run. Fixed by throwing instead of returning.
 *
 * This suite EXECUTES the real functions/funnel-recovery.js module — the
 * tests/lead-alert-calcom.test.js / tests/legacy-documents-audit.test.js
 * technique: firebase-admin/firestore, resend, and
 * ./integrations/upstash-ratelimit are stubbed at Module._load, so it needs
 * no live Firestore or Resend credentials. firebase-functions itself is the
 * REAL package (functions/node_modules) — the same real onSchedule /
 * onRequest wrapping tests/cron-heartbeat.test.js drives, including the real
 * ./integrations/heartbeat wrapper, so finding #3's assertion is actually
 * observing withHeartbeat's real throw-vs-return behaviour, not a mirror of it.
 *
 * Run: node tests/funnel-recovery-hardening.test.js
 * (needs functions/node_modules — junction it from the main checkout if this
 * worktree doesn't have one: see CLAUDE.md step 7 of the funnel-recovery task.)
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FUNNEL_RECOVERY = path.join(ROOT, 'functions', 'funnel-recovery.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// ── Fake Timestamp (matches firebase-admin/firestore's Timestamp enough for
// the '<'/'>' comparisons runAbandonRecovery's query performs) ─────────────
function fakeTs(ms) {
  return { __fakeTimestamp: true, toMillis: () => ms };
}

// ── Fake Firestore ───────────────────────────────────────────────────────
// One collection ('funnel_abandoned' here), get/set/update on a doc, and a
// where/where/limit/get query with '<' '>' '<=' '>=' '==' comparisons —
// enough to drive both saveFunnelProgress and runAbandonRecovery unmodified.
function makeFakeDb() {
  const collections = {};
  function coll(name) {
    if (!collections[name]) collections[name] = new Map();
    return collections[name];
  }
  let failPredicate = null; // (collName, id, data) => boolean — throws on update() when true
  // CAN-SPAM (2026-10-03): a recovery email is commercial and is BLOCKED
  // without the sender's postal address, so NBD's profile carries one here
  // (tests/email-unsubscribe.test.js covers the no-address case).
  coll('companyProfile').set('1phDvAVXHSg82wDLegAbQFq14Ci1', { brand: { contact: { mailingAddress: 'PO Box 77, Goshen, OH 45122' } } });

  function docRef(name, id) {
    return {
      id,
      async get() {
        const exists = coll(name).has(id);
        return { exists, data: () => (exists ? Object.assign({}, coll(name).get(id)) : undefined) };
      },
      async set(data, opts) {
        const cur = coll(name).get(id) || {};
        coll(name).set(id, (opts && opts.merge) ? Object.assign({}, cur, data) : Object.assign({}, data));
      },
      async update(data) {
        if (failPredicate && failPredicate(name, id, data)) {
          throw new Error('simulated Firestore write failure');
        }
        const cur = coll(name).get(id) || {};
        coll(name).set(id, Object.assign({}, cur, data));
      },
    };
  }

  return {
    _collections: collections,
    setFailPredicate(fn) { failPredicate = fn; },
    // db.doc('coll/id') — the email-unsubscribe gate (functions/
    // email-suppression.js, 2026-09-22) reads email_suppressions/{id} and
    // mints email_unsub_tokens/{token} this way before every recovery send.
    doc(p) {
      const i = String(p).lastIndexOf('/');
      return docRef(String(p).slice(0, i), String(p).slice(i + 1));
    },
    collection(name) {
      return {
        doc: (id) => docRef(name, id),
        where(field, op, value) {
          const preds = [[field, op, value]];
          const builder = {
            where(f2, o2, v2) { preds.push([f2, o2, v2]); return builder; },
            limit(n) { builder._limit = n; return builder; },
            async get() {
              let docs = [...coll(name).entries()].map(([id, data]) => ({
                id, data: () => Object.assign({}, data), ref: docRef(name, id),
              }));
              docs = docs.filter((d) => preds.every(([f, o, v]) => {
                const raw = d.data()[f];
                const val = raw && typeof raw.toMillis === 'function' ? raw.toMillis() : raw;
                const target = v && typeof v.toMillis === 'function' ? v.toMillis() : v;
                if (o === '<') return val < target;
                if (o === '>') return val > target;
                if (o === '<=') return val <= target;
                if (o === '>=') return val >= target;
                if (o === '==') return val === target;
                return true;
              }));
              if (builder._limit != null) docs = docs.slice(0, builder._limit);
              return { empty: docs.length === 0, docs, size: docs.length };
            },
          };
          return builder;
        },
      };
    },
  };
}

// ── Fake rate limiter (funnelProgress:ip / funnelProgress:email) ──────────
function makeRateLimiterStub() {
  const state = {};
  const calls = [];
  function bump(ns, key, limit, windowMs) {
    const now = Date.now();
    const k = ns + '|' + key;
    const rec = state[k];
    if (!rec || now - rec.windowStart >= windowMs) { state[k] = { windowStart: now, count: 1 }; return true; }
    if (rec.count >= limit) return false;
    rec.count++;
    return true;
  }
  return {
    calls,
    async httpRateLimit(req, res, namespace, limit, windowMs) {
      calls.push({ kind: 'http', namespace, limit, windowMs });
      const key = (req.headers && req.headers['x-forwarded-for']) || 'unknown-ip';
      if (!bump(namespace, key, limit, windowMs)) {
        res.status(429).json({ success: false, error: 'rate_limited' });
        return false;
      }
      return true;
    },
    async enforceRateLimit(namespace, key, limit, windowMs) {
      calls.push({ kind: 'enforce', namespace, key, limit, windowMs });
      if (!bump(namespace, key, limit, windowMs)) {
        const e = new Error('rate_limited');
        e.rateLimited = true;
        e.retryAfterMs = windowMs;
        throw e;
      }
      return { allowed: true };
    },
  };
}

// ── Module._load stubs ──────────────────────────────────────────────────
let currentDb = null;
let currentResendSend = async () => ({ data: { id: 'stub' }, error: null });
let currentLimiter = makeRateLimiterStub();

const stubs = {
  'firebase-admin/firestore': {
    Timestamp: { fromDate: (d) => fakeTs(d.getTime()) },
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true, ms: Date.now() }) },
    getFirestore: () => currentDb,
  },
  resend: {
    Resend: function Resend(apiKey) {
      this.apiKey = apiKey;
      this.emails = { send: (p) => currentResendSend(p) };
    },
  },
  './integrations/upstash-ratelimit': {
    httpRateLimit: (...a) => currentLimiter.httpRateLimit(...a),
    enforceRateLimit: (...a) => currentLimiter.enforceRateLimit(...a),
  },
};

const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
process.on('exit', () => { Module._load = realLoad; });

delete require.cache[require.resolve(FUNNEL_RECOVERY)];
const FR = require(FUNNEL_RECOVERY);

// ── req/res fakes for saveFunnelProgress (the real onRequest-wrapped
// handler is directly callable as fn(req, res), same as cron-heartbeat's
// endpoint exposes .run for onSchedule) ───────────────────────────────────
function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(o) { this.body = o; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    // The real onRequest wraps the handler with the `cors` middleware (this
    // file's CORS_ORIGINS) and firebase-functions v2's https trace wrapper —
    // both expect a real-enough Express ServerResponse: header accessors
    // for `cors`/`vary`, and an EventEmitter-shaped 'finish' event for the
    // tracing span. A bare {status,json} fake throws inside those, not
    // inside the code under test.
    getHeader(k) { return this.headers[k]; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    on(event, listener) { if (event === 'finish') this._finishListener = listener; return this; },
    end() { if (this._finishListener) this._finishListener(); return this; },
  };
}
function makeReq(body, ip) {
  return { method: 'POST', body, headers: { 'x-forwarded-for': ip || '203.0.113.9' } };
}

(async () => {

console.log('WIRING');
{
  ok('exports saveFunnelProgress (callable) and runAbandonRecovery (with .run)',
    typeof FR.saveFunnelProgress === 'function' && typeof FR.runAbandonRecovery === 'function'
    && typeof FR.runAbandonRecovery.run === 'function');
}

console.log('\n(1) DOUBLE-SEND — a post-send bookkeeping failure must never replay as a second send');
{
  currentDb = makeFakeDb();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  await currentDb.collection('funnel_abandoned').doc('dbl00001').set({
    email: 'victim@example.com', funnelId: 'dbl00001', firstName: 'Pat',
    createdAt: fakeTs(twoHoursAgo), updatedAt: fakeTs(twoHoursAgo),
    completedAt: null, recoveryEmailSentAt: null, recoveryEmailStatus: null,
  });
  // Every write that tries to persist "sent" (i.e. carries recoveryEmailSentAt)
  // fails, for this doc only — modeling the finding's "transient Firestore
  // error ... deadline exceeded" on exactly the write that would normally
  // exclude the record from a future run.
  currentDb.setFailPredicate((collName, id, data) =>
    id === 'dbl00001' && data && Object.prototype.hasOwnProperty.call(data, 'recoveryEmailSentAt'));

  process.env.FUNNEL_RECOVERY_ENABLED = 'true';
  process.env.RESEND_API_KEY = 'test-resend-key';
  delete process.env.EMAIL_FROM;
  delete process.env.HEALTHCHECKS_PING_KEY; // heartbeat ping becomes a no-op

  const sendCalls = [];
  currentResendSend = async (p) => { sendCalls.push(p); return { data: { id: 'em_' + sendCalls.length }, error: null }; };

  await FR.runAbandonRecovery.run({});
  ok('run 1: the email was sent exactly once', sendCalls.length === 1, sendCalls.length);

  const after1 = await currentDb.collection('funnel_abandoned').doc('dbl00001').get();
  ok('run 1: recoveryEmailSentAt never landed (the simulated bookkeeping failure)',
    !after1.data().recoveryEmailSentAt, after1.data());

  await FR.runAbandonRecovery.run({});
  ok('run 2 (same eligible query window): NO second send went out',
    sendCalls.length === 1, sendCalls.length);

  await FR.runAbandonRecovery.run({});
  ok('run 3: still no second send', sendCalls.length === 1, sendCalls.length);
}

console.log('\n(1b) genuine send failures still retry next run (sanity: the fix does not block real retries)');
{
  currentDb = makeFakeDb(); // fresh — no failPredicate
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  await currentDb.collection('funnel_abandoned').doc('genfail1').set({
    email: 'retryme@example.com', funnelId: 'genfail1', firstName: 'Sam',
    createdAt: fakeTs(twoHoursAgo), updatedAt: fakeTs(twoHoursAgo),
    completedAt: null, recoveryEmailSentAt: null, recoveryEmailStatus: null,
  });
  process.env.FUNNEL_RECOVERY_ENABLED = 'true';
  process.env.RESEND_API_KEY = 'test-resend-key';

  let attempts = 0;
  currentResendSend = async () => {
    attempts++;
    return attempts === 1
      ? { data: null, error: { message: 'temporary provider error' } }
      : { data: { id: 'ok' }, error: null };
  };

  await FR.runAbandonRecovery.run({});
  ok('attempt 1 was rejected by Resend', attempts === 1);
  const mid = await currentDb.collection('funnel_abandoned').doc('genfail1').get();
  ok('a genuine send failure is marked "failed", NOT excluded like a claim',
    mid.data().recoveryEmailStatus === 'failed' && !mid.data().recoveryEmailSentAt, mid.data());

  await FR.runAbandonRecovery.run({});
  ok('attempt 2 retried on the next run and succeeded', attempts === 2);
  const fin = await currentDb.collection('funnel_abandoned').doc('genfail1').get();
  ok('final record shows sent', fin.data().recoveryEmailStatus === 'sent' && !!fin.data().recoveryEmailSentAt, fin.data());
}

console.log('\n(2) PER-EMAIL THROTTLE — saveFunnelProgress must cap recovery-email queuing per recipient, not just per IP');
{
  currentDb = makeFakeDb();
  currentLimiter = makeRateLimiterStub();
  const victim = 'attacker-target@example.com';
  const ip = '203.0.113.50';

  const results = [];
  for (let i = 1; i <= 4; i++) {
    const req = makeReq({ email: victim, funnelId: 'atk' + String(i).padStart(6, '0') }, ip);
    const res = makeRes();
    await FR.saveFunnelProgress(req, res);
    results.push(res.statusCode);
  }
  ok('first 3 distinct funnelIds targeting the same victim email are accepted', results.slice(0, 3).every((c) => c === 200), results);
  ok('the 4th within the same window is throttled (429), not silently queued', results[3] === 429, results);

  const victimDocs = [...currentDb._collections.funnel_abandoned.keys()].filter((k) => k.startsWith('atk'));
  ok('no 4th funnel_abandoned doc (and so no 4th future recovery email) was created for the victim',
    victimDocs.length === 3, victimDocs);

  const otherReq = makeReq({ email: 'someone-else@example.com', funnelId: 'other001' }, ip);
  const otherRes = makeRes();
  await FR.saveFunnelProgress(otherReq, otherRes);
  ok('an unrelated email is not caught by the victim\'s per-email cap', otherRes.statusCode === 200, otherRes.statusCode);

  const capsReq = makeReq({ email: victim.toUpperCase(), funnelId: 'atkupper' }, ip);
  const capsRes = makeRes();
  await FR.saveFunnelProgress(capsReq, capsRes);
  ok('an uppercase variant of an already-capped email is still throttled (same normalized key)',
    capsRes.statusCode === 429, capsRes.statusCode);

  ok('a per-email rate check actually ran (not just per-IP)',
    currentLimiter.calls.some((c) => c.kind === 'enforce' && c.key === victim), currentLimiter.calls);
}

console.log('\n(4) MISCONFIGURATION MUST FAIL THE HEARTBEAT — a missing RESEND_API_KEY must not report a healthy run');
{
  currentDb = makeFakeDb();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  await currentDb.collection('funnel_abandoned').doc('needkey1').set({
    email: 'x@example.com', funnelId: 'needkey1', firstName: '',
    createdAt: fakeTs(twoHoursAgo), updatedAt: fakeTs(twoHoursAgo),
    completedAt: null, recoveryEmailSentAt: null, recoveryEmailStatus: null,
  });
  process.env.FUNNEL_RECOVERY_ENABLED = 'true';
  delete process.env.RESEND_API_KEY; // the misconfiguration
  delete process.env.HEALTHCHECKS_PING_KEY; // ping stays a no-op either way

  let threw = null;
  currentResendSend = async () => { throw new Error('should never be called — no API key'); };
  try {
    await FR.runAbandonRecovery.run({});
  } catch (e) {
    threw = e;
  }
  ok('a missing RESEND_API_KEY while enabled THROWS (so withHeartbeat pings /fail) instead of returning quietly',
    threw instanceof Error && /RESEND_API_KEY|missing_api_key/i.test(threw.message || ''), threw && threw.message);
}

console.log('\n(9) the recovery email escapes the public first name (security audit 2026-09-29)');
{
  currentDb = makeFakeDb();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  await currentDb.collection('funnel_abandoned').doc('xss00001').set({
    email: 'someone@example.com', funnelId: 'xss00001', firstName: '<a href="https://evil.example">Claim your refund</a>',
    createdAt: fakeTs(twoHoursAgo), updatedAt: fakeTs(twoHoursAgo),
    completedAt: null, recoveryEmailSentAt: null, recoveryEmailStatus: null,
  });
  process.env.FUNNEL_RECOVERY_ENABLED = 'true';
  process.env.RESEND_API_KEY = 'test-resend-key';
  const sent = [];
  currentResendSend = async (p) => { sent.push(p); return { data: { id: 'em_x' }, error: null }; };
  await FR.runAbandonRecovery.run({});
  const html = (sent[0] && sent[0].html) || '';
  ok('the recovery email was sent', sent.length === 1, sent.length);
  ok('no live link from the first name', !/<a href="https:\/\/evil\.example"/.test(html), html.slice(0, 200));
  ok('the name shows escaped', /&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;/.test(html));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }

})().catch((e) => { console.error('THREW:', e && e.stack); process.exit(1); });
