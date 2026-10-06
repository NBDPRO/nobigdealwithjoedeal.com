/**
 * tests/r4-silent-jobs-2026-10-06.test.js
 *
 * Review round 4, area 7 (silent failures), PR B — jobs and endpoints that
 * failed without telling anyone. Report: nbd-content/review-r4-2026-10-06.md;
 * the matching pins are on draft PR #2262 (not edited here).
 *
 *   R4-7-4  incomingSMS read the Twilio token with bare .value(): the
 *           '__unset__' stub "validated" a forged signature. → secretValue + 503
 *   hail    hailMatchCron read leads.limit(500) with no cursor. → pages all
 *   overdue invoiceOverdueSweep stopped at 1000 open invoices. → pages all
 *   R4-7-5  emailQueueWorker: info + return when unconfigured; terminal
 *           failures only warned; the digest never showed the queue.
 *   R4-7-6  leadBridge swallowed a failed mirror / company lookup, no retry.
 *   R4-7-7  recordingRetentionCron deleted the doc when the audio delete
 *           failed (audio orphaned in Storage forever).
 *   R4-11   stripe-crm-invoice left a partly paid open prior invoice payable
 *           next to the new one.
 *   R4-12   a failed job-spine stage move on payment was one warning.
 *   R4-13   guardHttp's per-uid limit failed OPEN on a limiter error (and the
 *           per-IP path threw unhandled).
 *   R4-10   portal / report / remote-signing / deal-room fired view counters
 *           and the view alert without await, then responded.
 *   alerting the heartbeat wrapper reports caught errors; the error-rate
 *           policy gains a condition for the background triggers.
 *
 * Real modules with Firebase / Twilio / Stripe / Resend stubbed — no network.
 * Run: node tests/r4-silent-jobs-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Load `file` with `stubs` (keyed by the exact require string). The hook
// stays available through `run` for handlers that require lazily.
function loadWith(file, stubs) {
  const real = Module._load;
  const hook = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.apply(this, arguments);
  };
  const abs = path.join(FN, file);
  delete require.cache[abs];
  Module._load = hook;
  let mod;
  try { mod = require(abs); } finally { Module._load = real; }
  return {
    mod,
    run: async (f) => { Module._load = hook; try { return await f(); } finally { Module._load = real; } },
    done: () => { delete require.cache[abs]; },
  };
}
function mkLogger() {
  const lines = { info: [], warn: [], error: [] };
  return { lines, info: (m) => lines.info.push(String(m)), warn: (m) => lines.warn.push(String(m)), error: (m) => lines.error.push(String(m)), debug() {}, log() {} };
}
const capture = (op, h) => ({ __opts: op, __handler: h });
const mkRes = () => ({ code: 200, body: null, headers: {}, set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } });
const FV = { serverTimestamp: () => 'ts', increment: (n) => ({ inc: n }), delete: () => 'del' };

// Strip // and /* */ comments (line-oriented; a // inside a string with a
// ':' or quote before it survives). For the ordering checks below.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => {
    const m = l.match(/(^|[^:'"`\\])\/\//);
    return m ? l.slice(0, m.index + m[1].length) : l;
  }).join('\n');
}

// firebase-functions' logger writes JSON lines straight to stdout/stderr;
// the failures these checks provoke on purpose would bury the results.
for (const stream of [process.stdout, process.stderr]) {
  const orig = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => (/^{.*"severity":"(WARNING|ERROR|INFO|DEBUG)"/.test(String(chunk)) ? true : orig(chunk, ...rest));
}

(async () => {
  // ── R4-7-4 incomingSMS ─────────────────────────────────────────────────
  console.log('R4-7-4 incomingSMS');
  {
    let validated = 0;
    const L = loadWith('sms-functions.js', {
      'firebase-functions/v2/https': { onRequest: capture, onCall: capture, HttpsError: Error },
      'firebase-functions/v2/firestore': { onDocumentUpdated: capture, onDocumentCreated: capture },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '__unset__' }) },
      twilio: Object.assign(() => ({}), { validateRequest: () => { validated++; return true; } }),
    });
    const res = mkRes();
    await L.run(() => L.mod.incomingSMS.__handler({
      method: 'POST', headers: { 'x-twilio-signature': 'forged' }, get: () => 'example.test', originalUrl: '/sms',
      body: { From: '+15135550100', Body: 'START', MessageSid: 'SMx' },
    }, res));
    ok('token is the __unset__ stub -> 503 not configured', res.code === 503, res.code + ' ' + JSON.stringify(res.body));
    ok('...and the (forgeable) signature check never ran', validated === 0, 'validateRequest calls=' + validated);
    L.done();
  }

  // ── hailMatchCron pagination ───────────────────────────────────────────
  console.log('hailMatchCron');
  {
    const N = 1203;
    const ids = Array.from({ length: N }, (_, i) => 'L' + String(i).padStart(5, '0'));
    const recent = { toMillis: () => Date.now() - 3600e3 };
    let pages = 0;
    const query = (st) => ({
      orderBy: () => query(Object.assign({}, st, { ordered: true })),
      limit: (n) => query(Object.assign({}, st, { lim: n })),
      startAfter: (d) => query(Object.assign({}, st, { after: d.id })),
      get: async () => {
        pages++;
        let from = st.after ? ids.indexOf(st.after) + 1 : 0;
        const slice = ids.slice(from, from + (st.lim || N));
        return { size: slice.length, empty: !slice.length, docs: slice.map((id) => ({ id, data: () => ({ lat: 39.1, lng: -84.5, lastHailCheck: recent }), ref: { update: async () => {} } })) };
      },
    });
    const log = mkLogger();
    let infoMeta = null;
    log.info = (m, meta) => { if (m === 'hail-cron complete') infoMeta = meta; };
    const L = loadWith('integrations/hail-cron.js', {
      './heartbeat': { onSchedule: capture },
      'firebase-functions/v2': { logger: log },
      'firebase-admin/firestore': { getFirestore: () => ({ collection: () => query({}) }), FieldValue: FV, FieldPath: { documentId: () => '__name__' } },
    });
    await L.run(() => L.mod.hailMatchCron.__handler({}));
    ok('every lead is read, not just the first 500 (' + N + ' leads)', !!infoMeta && infoMeta.leads === N && infoMeta.skipped === N, JSON.stringify(infoMeta));
    ok('...in pages of 500 (3 pages)', pages === 3, 'pages=' + pages);
    L.done();
  }

  // ── invoiceOverdueSweep pagination ─────────────────────────────────────
  console.log('invoiceOverdueSweep');
  {
    const OV = require(path.join(FN, 'invoice-overdue.js'))._internal;
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let pages = 0;
    const q = (st) => ({
      where: () => q(st), limit: (n) => q(Object.assign({}, st, { lim: n })),
      startAfter: (d) => q(Object.assign({}, st, { after: d.id })),
      get: async () => { pages++; const from = st.after ? ids.indexOf(st.after) + 1 : 0; const s = ids.slice(from, from + st.lim); return { docs: s.map((id) => ({ id, data: () => ({ status: 'sent', leadId: 'L' + id }) })) }; },
    });
    const db = { collection: () => q({}), doc: () => ({ get: async () => ({ exists: false }) }) };
    const quiet = { info() {}, warn() {}, error() {} };
    const out = await OV.runOverdueSweep(db, Date.now(), { logger: quiet, FieldValue: FV, pageSize: 2 });
    ok('scans every open invoice across pages (5 with page size 2)', out.scanned === 5 && pages === 3, JSON.stringify(out) + ' pages=' + pages);
    let errs = 0;
    const bad = { collection: (c) => (c === 'invoices' ? q({}) : { doc: () => ({ get: async () => { throw new Error('UNAVAILABLE'); } }) }), doc: () => ({ get: async () => ({ exists: false }) }) };
    const out2 = await OV.runOverdueSweep(bad, Date.now(), { logger: { info() {}, warn() {}, error: () => { errs++; } }, FieldValue: FV, pageSize: 10 });
    ok('a per-invoice failure is counted and logged at error', out2.failed === 5 && errs === 5, JSON.stringify(out2) + ' errs=' + errs);
  }

  // ── R4-7-5 emailQueueWorker + health digest ────────────────────────────
  console.log('R4-7-5 emailQueueWorker');
  {
    const log = mkLogger();
    const L = loadWith('integrations/email-queue-worker.js', {
      './heartbeat': { onSchedule: capture },
      'firebase-functions/v2': { logger: log },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '__unset__' }) },
    });
    let threw = null;
    try { await L.run(() => L.mod.emailQueueWorker.__handler({})); } catch (e) { threw = e; }
    ok('Resend not configured -> the run THROWS (heartbeat records a failure)', !!threw && /not configured/.test(threw.message));
    ok('...and logs at error level', log.lines.error.some((m) => /not configured/.test(m)));
    L.done();
  }
  {
    // A row on its 5th failed attempt fails for good -> error, not warn.
    const log = mkLogger();
    const updates = [];
    const row = { id: 'q1', ref: { update: async (d) => updates.push(d) }, data: () => ({ to: 'pat@example.test', subject: 's', bodyPlain: 'b', attempts: 4, status: 'pending', source: 'dunning' }) };
    const emptyQ = { where: () => emptyQ, orderBy: () => emptyQ, limit: () => emptyQ, get: async () => ({ docs: [], size: 0 }) };
    let call = 0;
    const db = {
      collection: () => ({ where: (f, op, v) => (v === 'pending' ? { orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [row], size: 1 }) }) }) } : emptyQ) }),
      runTransaction: async (fn) => fn({ get: async () => ({ exists: true, data: () => ({ status: 'pending' }) }), update: () => {} }),
    };
    class Resend { constructor() { this.emails = { send: async () => { call++; throw new Error('resend 500'); } }; } }
    const L = loadWith('integrations/email-queue-worker.js', {
      './heartbeat': { onSchedule: capture },
      'firebase-functions/v2': { logger: log },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 're_' + 'testkey' }) },
      'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ms }, FieldValue: FV },
      resend: { Resend },
    });
    await L.run(() => L.mod.emailQueueWorker.__handler({}));
    ok('a row that fails for good (max attempts) is marked failed', call === 1 && updates.some((u) => u.status === 'failed'), JSON.stringify(updates));
    ok('...and logged at ERROR level', log.lines.error.some((m) => /failed for good/.test(m)), JSON.stringify(log.lines));
    L.done();
  }
  {
    const HD = require(path.join(FN, 'health-digest.js'))._test;
    const counts = { pending: 3, sending: 0, failed: 2 };
    const db = { collection: () => ({ where: (f, op, v) => ({ count: () => ({ get: async () => ({ data: () => ({ count: counts[v] }) }) }) }) }) };
    const q = await HD.gatherEmailQueue(db);
    ok('health digest counts pending / sending / failed email rows', q.pending === 3 && q.failed === 2 && q.sending === 0, JSON.stringify(q));
    const html = HD.buildEmailBody({ vision: { userTotal: 0, userCount: 0, topLeads: [] }, stripe: { total: 0, recentTypes: {} }, api: { total: 0, topUsers: [] }, activity: { photos: 0, portalEvents: 0 }, imagePipe: { genuineRecent: false, noDocMatched: 0, noDocMatchedD2d: 0 }, renderPdf: { attempted: false }, periodLabel: 'p', aiSpend: null, scorecard: null, emailQueue: q });
    ok('...and the digest body shows them, flagged when anything failed', /Email Queue/.test(html) && /<strong>3<\/strong> pending/.test(html) && /<strong>2<\/strong> failed for good/.test(html) && /needs a look/.test(html));
    ok('...a healthy queue is not flagged; an unreadable one says so', !HD.emailQueueBad({ pending: 0, sending: 0, failed: 0 }) && /unavailable/.test(HD.renderEmailQueueSection(null)));
    ok('...and the subject line carries the warning', /emailQueueBad\(emailQueue\) \? ' · ⚠ email queue'/.test(read('functions/health-digest.js')));
  }

  // ── R4-7-6 leadBridge ──────────────────────────────────────────────────
  console.log('R4-7-6 leadBridge');
  function loadBridge(db, mint) {
    return loadWith('lead-bridge.js', {
      'firebase-functions/v2/firestore': { onDocumentCreated: capture },
      'firebase-functions/v2': { logger: mkLogger() },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue: FV },
      './customer-id-mint': { createLeadWithCustomerId: mint },
    });
  }
  const evt = (data, ageMs) => ({ data: { data: () => data }, params: { leadId: 'src1' }, time: new Date(Date.now() - (ageMs || 0)).toISOString() });
  {
    const db = { collection: () => ({ doc: () => ({}) }) };
    const L = loadBridge(db, async () => { throw new Error('DEADLINE_EXCEEDED (simulated)'); });
    ok('every leadBridge trigger has retry: true', ['leadBridgeContact', 'leadBridgeEstimate', 'leadBridgeInspect', 'leadBridgeFreeRoof', 'leadBridgeStorm', 'leadBridgeThumbtack']
      .every((k) => L.mod[k] && L.mod[k].__opts && L.mod[k].__opts.retry === true));
    let threw = null;
    try { await L.run(() => L.mod.leadBridgeInspect.__handler(evt({ name: 'Pat', phone: '5135550100', address: '1 Vine St' }))); } catch (e) { threw = e; }
    ok('a failed CRM mirror REJECTS so the trigger retries', !!threw && /DEADLINE/.test(threw.message), threw ? threw.message : 'resolved');
    L.done();
  }
  {
    let mints = 0;
    const db = { collection: (c) => ({ doc: () => ({ get: async () => { if (c === 'companies') throw new Error('UNAVAILABLE (simulated)'); return { exists: false }; } }) }) };
    const L = loadBridge(db, async () => { mints++; return { customerId: 'x' }; });
    let threw = null;
    try { await L.run(() => L.mod.leadBridgeContact.__handler(evt({ name: 'Pat', companyId: 'co-a' }))); } catch (e) { threw = e; }
    ok('a failed company lookup REJECTS (not "no owner, skip")', !!threw && mints === 0, threw ? threw.message : 'resolved, mints=' + mints);
    L.done();
  }
  {
    let mints = 0;
    const L = loadBridge({ collection: () => ({ doc: () => ({}) }) }, async () => { mints++; throw new Error('still failing'); });
    let threw = null;
    try { await L.run(() => L.mod.leadBridgeInspect.__handler(evt({ name: 'Pat' }, 25 * 3600e3))); } catch (e) { threw = e; }
    ok('a delivery older than 24h stops retrying (resolves, logged) instead of 7 days of retries', !threw && mints === 0);
    L.done();
  }
  {
    let mints = 0;
    const L = loadBridge({ collection: () => ({ doc: () => ({}) }) }, async () => { mints++; return { customerId: 'NBD-0001' }; });
    let threw = null;
    try { await L.run(() => L.mod.leadBridgeInspect.__handler(evt({ name: 'Pat' }))); } catch (e) { threw = e; }
    ok('control: a normal delivery mirrors once and resolves', !threw && mints === 1);
    L.done();
  }

  // ── R4-7-7 recordingRetentionCron ──────────────────────────────────────
  console.log('R4-7-7 recordingRetentionCron');
  {
    const deleted = [];
    const now = Date.now();
    const recPath = 'leads/L1/recordings/r1';
    const rec = { status: 'soft_deleted', hardDeleteAt: { toMillis: () => now - 1 }, audioPath: 'audio/u1/L1/r1.m4a', companyId: 'c1' };
    const doc = { id: 'r1', data: () => rec, ref: { path: recPath, delete: async () => deleted.push(recPath), update: async () => {} } };
    const q = (status) => {
      const self = { where: () => self, orderBy: () => self, limit: () => self, startAfter: () => self,
        get: async () => (status === 'soft_deleted' ? { empty: false, size: 1, docs: [doc] } : { empty: true, size: 0, docs: [] }) };
      return self;
    };
    let firstStatus = null;
    const db = { collectionGroup: () => ({ where: (f, op, v) => { firstStatus = v; return q(v); } }), doc: () => ({ get: async () => ({ exists: false }) }) };
    const log = mkLogger();
    const VI = loadWith('integrations/voice-intelligence.js', {
      './heartbeat': { onSchedule: capture },
      'firebase-functions/v2': { logger: log },
      'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { now: () => ({ toMillis: () => now }), fromMillis: (ms) => ({ toMillis: () => ms }) }, FieldValue: FV },
      'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file: () => ({ delete: async () => { throw new Error('storage 503 (simulated)'); } }) }) }) },
    });
    const pathOk = VI.mod._retentionAudioPathFor ? VI.mod._retentionAudioPathFor(recPath, rec.audioPath) : null;
    await VI.run(() => VI.mod.recordingRetentionCron.__handler({}));
    ok('fixture: the doc names its own audio (the delete is attempted)', !!pathOk, String(pathOk));
    ok('audio delete fails -> the Firestore doc is KEPT for the next run', deleted.length === 0, 'deleted=' + deleted.join(','));
    ok('...and the failure is logged at error', log.lines.error.some((m) => /audio delete failed/.test(m)));
    VI.done();
  }

  // ── R4-11 stripe-crm-invoice ───────────────────────────────────────────
  console.log('R4-11 stripe-crm-invoice');
  {
    const SCI = require(path.join(FN, 'stripe-crm-invoice.js'));
    const calls = [];
    const stripe = {
      customers: { list: async () => ({ data: [] }), create: async () => ({ id: 'cus_1' }), update: async () => ({}) },
      invoices: {
        retrieve: async (id) => { calls.push('retrieve:' + id); return { id, status: 'open', amount_paid: 50000, amount_remaining: 132500, amount_due: 182500, number: 'NBD-0007' }; },
        voidInvoice: async (id) => { calls.push('void:' + id); },
        del: async (id) => { calls.push('del:' + id); },
        create: async () => { calls.push('create'); return { id: 'in_new' }; },
        finalizeInvoice: async () => { calls.push('finalize'); return {}; },
      },
      invoiceItems: { create: async () => { calls.push('item'); } },
    };
    const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ stripeCustomerId: 'cus_1' }) }), update: async () => {} }) }) };
    let threw = null;
    try {
      await SCI.mintCrmStripeInvoice(stripe, db, { invoiceId: 'i1', invoice: { leadId: 'L1', stripeInvoiceId: 'in_old' }, tenantId: 't', uid: 'u', lineItems: [], balanceDueCents: 100000 });
    } catch (e) { threw = e; }
    ok('an open, partly paid prior Stripe invoice -> REFUSED (prior_invoice_partly_paid, 409)', !!threw && threw.code === 'prior_invoice_partly_paid' && threw.httpStatus === 409, threw ? threw.message : 'minted');
    ok('...no second invoice is created and the prior is not voided', !calls.includes('create') && !calls.some((c) => /^void/.test(c)), calls.join(','));
    ok('...the message tells the office what to do', !!threw && /partly paid/.test(threw.publicMessage) && /Stripe/.test(threw.publicMessage));
    const st = stripeSrc();
    ok('createStripePaymentLink answers 409 with that message', /e\.code === 'prior_invoice_partly_paid'\)\s*\{\s*res\.status\(409\)\.json\(\{ error: e\.publicMessage/.test(st));
  }
  function stripeSrc() { return stripComments(read('functions/stripe.js')); }

  // ── R4-12 money-paper job-spine move ───────────────────────────────────
  console.log('R4-12 money-paper spine');
  {
    const MP = require(path.join(FN, 'money-paper.js'))._internal;
    const before = { leadId: 'L1', status: 'sent', total: 1000, amountPaid: 0, balanceDue: 1000, invoiceType: 'deposit' };
    const after = { leadId: 'L1', status: 'paid', total: 1000, amountPaid: 1000, balanceDue: 0, invoiceType: 'deposit', payments: [{ id: 'p1', amount: 1000, method: 'check' }] };
    let n = 0;
    const deps = (results) => ({
      db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) },
      now: () => Date.now(), retryDelayMs: 0, loadLeadInvoices: async () => [],
      recordJobEvent: async () => { const r = results[Math.min(n, results.length - 1)]; n++; return r; },
    });
    n = 0;
    const out1 = await MP.spineOnInvoice(deps([{ moved: false, reason: 'error', error: 'x' }, { moved: true }]), 'i1', before, after);
    const ev = out1 ? Object.keys(out1) : [];
    ok('fixture: a paid invoice yields a spine event', ev.length >= 1, JSON.stringify(out1));
    ok('a transient spine failure is retried in place and lands', ev.length >= 1 && out1[ev[0]].moved === true && n === 2, 'calls=' + n + ' ' + JSON.stringify(out1));
    n = 0;
    const out2 = await MP.spineOnInvoice(deps([{ moved: false, reason: 'error', error: 'down' }]), 'i1', before, after);
    ok('a persistent failure is tried 3 times, then reported as failed', n === 3 * Object.keys(out2 || {}).length && MP.spineFailures({ spine: out2 }).length >= 1, 'calls=' + n);
    const mp = stripComments(read('functions/money-paper.js'));
    const trig = mp.slice(mp.indexOf('exports.moneyPaperOnInvoice'));
    ok('...and the trigger run FAILS on it (after the rest of handle ran)',
      /const out = await handle\(/.test(trig) && /spineFailures\(out\)/.test(trig) && trig.indexOf('throw new Error') > trig.indexOf('await handle('));
  }

  // ── R4-13 guardHttp ────────────────────────────────────────────────────
  console.log('R4-13 guardHttp');
  async function guarded(limiter, auth) {
    const L = loadWith('rate-limit-policy.js', {
      './integrations/upstash-ratelimit': { enforceRateLimit: limiter, clientIp: () => '203.0.113.9', hashKey: (s) => s },
      'firebase-functions/v2': { logger: mkLogger() },
      'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: async () => ({ uid: 'u1' }) }) },
      'firebase-admin/app': { getApps: () => [1] },
      'firebase-admin': {},
    });
    let ran = 0;
    const h = L.mod.guardHttp('unknownRoute', async (req, res) => { ran++; res.status(200).json({ ok: true }); });
    const res = mkRes();
    let threw = null;
    try { await L.run(() => h({ headers: auth ? { authorization: 'Bearer t' } : {} }, res)); } catch (e) { threw = e; }
    L.done();
    return { res, ran, threw };
  }
  {
    const r = await guarded(async (k) => { if (/:uid$/.test(k)) throw new Error('Firestore UNAVAILABLE'); }, true);
    ok('per-uid limiter error -> 503, handler NOT run (was fail-open)', r.res.code === 503 && r.ran === 0 && !r.threw, r.res.code + ' ran=' + r.ran);
    const r2 = await guarded(async (k) => { if (/:ip$/.test(k)) throw new Error('Firestore UNAVAILABLE'); }, false);
    ok('per-IP limiter error -> clean 503 (was an unhandled throw)', r2.res.code === 503 && r2.ran === 0 && !r2.threw, r2.threw ? 'threw ' + r2.threw.message : String(r2.res.code));
    const r3 = await guarded(async (k) => { if (/:uid$/.test(k)) { const e = new Error('limited'); e.rateLimited = true; throw e; } }, true);
    ok('control: a real limit is still 429', r3.res.code === 429 && r3.ran === 0);
    const r4 = await guarded(async () => ({}), true);
    ok('control: limiter healthy -> handler runs', r4.res.code === 200 && r4.ran === 1);
  }

  // ── R4-10 view counters awaited before the response ────────────────────
  console.log('R4-10 view counters');
  {
    const { awaitBriefly } = require(path.join(FN, 'await-briefly.js'));
    let done = false;
    const slow = new Promise((r) => setTimeout(() => { done = true; r(); }, 30));
    const a = await awaitBriefly([slow, Promise.reject(new Error('x'))], 1000);
    ok('awaitBriefly waits for the writes (and swallows their errors)', a.settled === true && done === true);
    const t0 = Date.now();
    const b = await awaitBriefly([new Promise(() => {})], 60);
    ok('...but never longer than its timeout', b.settled === false && Date.now() - t0 < 1000);
    // Each endpoint: the counters go into pendingWrites, and the awaited
    // flush comes BEFORE the success response (order, comments stripped).
    const sites = [
      ['functions/portal.js', 'tokRef.update(isPoll', 'res.status(200).json(view)'],
      ['functions/remote-signing.js', 'doc_sign_tokens/${token}`).update', "res.status(200).json({\n      html,"],
      ['functions/report-sharing.js', 'report_share_tokens/${token}`).update({\n      viewedAt', ".send(html);"],
      ['functions/deal-acceptance.js', 'deal_accept_tokens/${token}`).update({ viewedAt', ".set('Content-Security-Policy', withThursday"],
    ];
    for (const [f, write, respond] of sites) {
      const s = stripComments(read(f)).replace(/\r/g, '');
      const iw = s.indexOf(write);
      const iPush = s.lastIndexOf('pendingWrites.push(', iw + 1);
      const iAwait = s.indexOf('await awaitBriefly(pendingWrites)', iw);
      const iRes = s.indexOf(respond, iw);
      ok(path.basename(f) + ': view writes are collected and awaited before the response',
        iw !== -1 && iPush !== -1 && iw - iPush < 40 && iAwait > iw && iRes > iAwait, `write=${iw} push=${iPush} await=${iAwait} res=${iRes}`);
    }
  }

  // ── alerting ───────────────────────────────────────────────────────────
  console.log('alerting');
  {
    const hb = require(path.join(FN, 'integrations', 'heartbeat.js'));
    const urls = [];
    hb._overrides.pingKey = 'k';
    hb._overrides.fetchImpl = async (u, o) => { urls.push([u, JSON.parse(o.body)]); return { ok: true, status: 200 }; };
    const { logger } = require(path.join(FN, 'node_modules', 'firebase-functions', 'lib', 'v2', 'index.js'));
    const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true; process.stderr.write = () => true;
    let r1, r2;
    try {
      r1 = await hb.withHeartbeat('job-a', async () => { logger.error('one item failed'); logger.error('another'); return 'done'; })({});
      r2 = await hb.withHeartbeat('job-b', async () => 'clean')({});
    } finally { process.stdout.write = ow; process.stderr.write = ew; }
    const a = urls.find((u) => /job-a/.test(u[0]));
    const b = urls.find((u) => /job-b/.test(u[0]));
    ok('a run that caught + logged errors pings /fail with the count', !!a && /\/job-a\/fail$/.test(a[0]) && a[1].caughtErrors === 2, JSON.stringify(a));
    ok('...and still returns its own result', r1 === 'done');
    ok('control: a clean run pings success', !!b && /\/job-b$/.test(b[0]) && r2 === 'clean', JSON.stringify(b));
    hb._overrides.pingKey = undefined; hb._overrides.fetchImpl = undefined;

    const pol = JSON.parse(read('monitoring/alert-functions-error-rate.json'));
    const c2 = (pol.conditions || []).find((c) => /Background/.test(c.displayName || ''));
    const f = c2 ? c2.conditionThreshold.filter : '';
    ok('error-rate policy: a background-function condition exists with threshold 0',
      !!c2 && c2.conditionThreshold.thresholdValue === 0 && c2.conditionThreshold.comparison === 'COMPARISON_GT' && c2.conditionThreshold.aggregations[0].perSeriesAligner === 'ALIGN_DELTA');
    const re = (() => { const m = f.match(/full_match\("([^"]+)"\)/); return m ? new RegExp('^(?:' + m[1] + ')$') : null; })();
    ok('...covering every leadBridge trigger, invoicewebhook and moneypaperoninvoice (lowercase Cloud Run names)',
      !!re && ['leadbridgecontact', 'leadbridgeestimate', 'leadbridgeinspect', 'leadbridgefreeroof', 'leadbridgestorm', 'leadbridgethumbtack', 'invoicewebhook', 'moneypaperoninvoice'].every((s) => re.test(s)) && !re.test('claudeproxy'));
    ok('...on ERROR log entries (metric label, not the log field)', /metric\.labels\.severity="ERROR"/.test(f) && /log_entry_count/.test(f));
    ok('control: the original user-facing condition is unchanged (>50)', pol.conditions[0].conditionThreshold.thresholdValue === 50);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
