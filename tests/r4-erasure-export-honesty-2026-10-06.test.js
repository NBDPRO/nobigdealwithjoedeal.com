/**
 * tests/r4-erasure-export-honesty-2026-10-06.test.js
 *
 * Review round 4, area 7 (silent failures), PR A — privacy-law honesty.
 * Fixes R4-7-1, R4-7-2 and R4-7-3 from nbd-content/review-r4-2026-10-06.md
 * (pins in draft PR #2262, which this suite turns into behaviour checks):
 *
 *   R4-7-1  confirmAccountErasure marked the request confirmed BEFORE the
 *           cascade, every step only logger.warn'ed, and it answered 200
 *           "deleted"; the same link then said 410 "Already processed".
 *           Now: confirmed only when every step succeeded; failures go in
 *           the audit row; 500 erasure_partial; the SAME link retries.
 *   R4-7-2  requestAccountErasure answered { success: true } when the
 *           confirmation email could not be queued or there was no email.
 *   R4-7-3  exportCompanyData shipped a "complete" zip with 0 rows for a
 *           collection whose query failed, and cut at EXPORT_LIMIT silently.
 *
 * Real handlers, with Firestore / Auth / Storage / limiter stubbed (no
 * network, no Stripe: every user here has no Stripe billing on file).
 * Run: node tests/r4-erasure-export-honesty-2026-10-06.test.js
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

class FakeHttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// Loads compliance.js against stubs. `o` controls which steps fail.
function loadCompliance(o) {
  const events = o.events;
  const docs = o.docs;
  const emptyQuery = () => { const q = { where: () => q, limit: () => q, get: async () => ({ empty: true, size: 0, docs: [] }) }; return q; };
  const db = {
    doc: (p) => ({
      get: async () => { events.push('read:' + p); return { exists: docs[p] != null, data: () => docs[p] }; },
      set: async (d) => { events.push('set:' + p); docs[p] = Object.assign({}, d); },
      update: async (d) => { events.push('update:' + p); docs[p] = Object.assign({}, docs[p], d); },
      path: p,
    }),
    collection: (n) => Object.assign(emptyQuery(), {
      add: async (row) => {
        if (o.addThrows && o.addThrows[n]) throw new Error('UNAVAILABLE (simulated add ' + n + ')');
        events.push('add:' + n); (docs['__add_' + n] = docs['__add_' + n] || []).push(row);
      },
    }),
    collectionGroup: () => emptyQuery(),
    recursiveDelete: async (ref) => {
      const p = ref && ref.path;
      if (o.failOnce && o.failOnce.recursive && o.failOnce.recursive[p]) {
        delete o.failOnce.recursive[p];
        throw new Error('DEADLINE_EXCEEDED (simulated ' + p + ')');
      }
      events.push('delete:' + p);
    },
  };
  const stubs = {
    'firebase-functions/v2/https': { onRequest: (op, h) => ({ __opts: op, __handler: h }), onCall: (op, h) => ({ __opts: op, __handler: h }), HttpsError: FakeHttpsError },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error(m) { events.push('log.error:' + m); } } },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
    './heartbeat': { onSchedule: (op, h) => ({ __handler: h }) },
    'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) }, FieldValue: { serverTimestamp: () => 'ts' } },
    'firebase-admin/auth': { getAuth: () => ({
      getUser: async () => { if (o.getUserThrows) throw new Error('auth down'); return { email: o.noEmail ? undefined : 'pat@example.test' }; },
      updateUser: async () => {
        if (o.failOnce && o.failOnce.auth) { o.failOnce.auth = false; throw new Error('auth/internal-error (simulated)'); }
        events.push('auth-disable');
      },
      revokeRefreshTokens: async () => {},
    }) },
    'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ deleteFiles: async (q) => {
      if (o.failOnce && o.failOnce.storage) { o.failOnce.storage = false; throw new Error('storage 503 (simulated)'); }
      events.push('storage-delete:' + q.prefix);
    } }) }) },
    './upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => ({}) },
  };
  const real = Module._load;
  const hook = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.apply(this, arguments);
  };
  const file = path.join(FN, 'integrations', 'compliance.js');
  delete require.cache[file];
  delete require.cache[path.join(FN, 'integrations', 'erasure-billing.js')];
  Module._load = hook;
  let mod;
  try { mod = require(file); } finally { Module._load = real; }
  return {
    mod,
    // Handlers lazy-require ./upstash-ratelimit, so keep the hook on while they run.
    run: async (fnp) => { Module._load = hook; try { return await fnp(); } finally { Module._load = real; } },
    done: () => { delete require.cache[file]; },
  };
}

const TOKEN = 'a'.repeat(64);
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
const mkRes = () => ({ code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, send(b) { this.body = b; return this; } });

async function post(L) {
  const res = mkRes();
  await L.run(() => L.mod.confirmAccountErasure.__handler({ method: 'POST', body: { uid: 'u1', token: TOKEN } }, res));
  return res;
}

(async () => {
  // ── R4-7-1 ────────────────────────────────────────────────────────────
  console.log('R4-7-1 confirmAccountErasure');
  {
    const events = [];
    const docs = { 'account_erasures/u1': { tokenHash: HASH, confirmed: false, expiresAt: { toMillis: () => Date.now() + 3600e3 } } };
    const o = { events, docs, failOnce: { storage: true, recursive: { 'daily_entries/u1': true } } };
    const L = loadCompliance(o);
    const r1 = await post(L);
    const req1 = docs['account_erasures/u1'];
    ok('a failed step -> NOT 200 (500 erasure_partial)', r1.code === 500 && r1.body && r1.body.code === 'erasure_partial', r1.code + ' ' + JSON.stringify(r1.body));
    ok('...the response does not claim success', !!r1.body && r1.body.success !== true && /could not be deleted/i.test(r1.body.error || ''));
    ok('...the request is NOT marked confirmed, and is flagged partial', req1.confirmed === false && req1.partial === true);
    ok('...the failed steps are recorded on the request', Array.isArray(req1.failures) && req1.failures.length === 2
      && req1.failures.some((f) => f.step === 'storage') && req1.failures.some((f) => f.target === 'daily_entries'), JSON.stringify(req1.failures));
    const audit1 = (docs.__add_audit_log || [])[0];
    ok('...the audit row is gdpr_erasure_partial and lists the failures', !!audit1 && audit1.type === 'gdpr_erasure_partial'
      && Array.isArray(audit1.failures) && audit1.failures.length === 2, JSON.stringify(audit1));
    ok('...no gdpr_erasure_confirmed audit row was written', !(docs.__add_audit_log || []).some((a) => a.type === 'gdpr_erasure_confirmed'));
    ok('...the other steps still ran (Auth disabled, other docs deleted)', events.includes('auth-disable') && events.includes('delete:leads/u1'), events.join(' > '));
    ok('...each failure is logged at error level', events.filter((e) => /^log\.error:erasure: /.test(e)).length === 2);

    // Same link, the transient failures are gone: finishes and confirms.
    const r2 = await post(L);
    const req2 = docs['account_erasures/u1'];
    ok('the SAME link retries (not 410 Already processed) and completes with 200', r2.code === 200 && r2.body && r2.body.success === true, r2.code + ' ' + JSON.stringify(r2.body));
    ok('...now confirmed, no longer partial, failures cleared', req2.confirmed === true && req2.partial === false && Array.isArray(req2.failures) && req2.failures.length === 0);
    ok('...the retry re-ran the steps that failed', events.includes('delete:daily_entries/u1') && events.some((e) => /^storage-delete:/.test(e)));
    ok('...and wrote gdpr_erasure_confirmed', (docs.__add_audit_log || []).some((a) => a.type === 'gdpr_erasure_confirmed'));
    const r3 = await post(L);
    ok('once confirmed, the link answers 410 Already processed', r3.code === 410);
    L.done();
  }
  {
    // Partial request whose 24h token window has passed: still finishable.
    const events = [];
    const docs = { 'account_erasures/u1': { tokenHash: HASH, confirmed: false, partial: true, expiresAt: { toMillis: () => Date.now() - 3600e3 } } };
    const L = loadCompliance({ events, docs });
    const r = await post(L);
    ok('a PARTIAL request past 24h can still be finished with its link', r.code === 200 && docs['account_erasures/u1'].confirmed === true, r.code + ' ' + JSON.stringify(r.body));
    L.done();
  }
  {
    const events = [];
    const docs = { 'account_erasures/u1': { tokenHash: HASH, confirmed: false, expiresAt: { toMillis: () => Date.now() - 3600e3 } } };
    const L = loadCompliance({ events, docs });
    const r = await post(L);
    ok('control: a never-attempted request past 24h is still 410 Link expired, nothing deleted', r.code === 410 && !events.some((e) => /^delete:/.test(e)));
    L.done();
  }
  {
    const events = [];
    const docs = { 'account_erasures/u1': { tokenHash: HASH, confirmed: false, expiresAt: { toMillis: () => Date.now() + 3600e3 } } };
    const L = loadCompliance({ events, docs, failOnce: { auth: true } });
    const r = await post(L);
    ok('Auth disable failing alone -> partial, not "deleted" (the account would stay live)',
      r.code === 500 && docs['account_erasures/u1'].confirmed === false && docs['account_erasures/u1'].failures.some((f) => f.step === 'auth'));
    L.done();
  }
  {
    const events = [];
    const docs = { 'account_erasures/u1': { tokenHash: HASH, confirmed: false, expiresAt: { toMillis: () => Date.now() + 3600e3 } } };
    const L = loadCompliance({ events, docs });
    const r = await post(L);
    ok('control: every step succeeds -> 200, confirmed, gdpr_erasure_confirmed', r.code === 200 && docs['account_erasures/u1'].confirmed === true
      && (docs.__add_audit_log || []).length === 1 && docs.__add_audit_log[0].type === 'gdpr_erasure_confirmed');
    L.done();
  }

  // ── R4-7-2 ────────────────────────────────────────────────────────────
  console.log('R4-7-2 requestAccountErasure');
  async function request(o) {
    const events = [];
    const docs = {};
    const L = loadCompliance(Object.assign({ events, docs }, o));
    let out = null, err = null;
    try { out = await L.run(() => L.mod.requestAccountErasure.__handler({ auth: { uid: 'u1' } })); } catch (e) { err = e; }
    L.done();
    return { out, err, docs };
  }
  {
    const r = await request({ addThrows: { email_queue: true } });
    ok('email enqueue fails -> throws (no { success: true })', !!r.err && !r.out && r.err.code === 'unavailable', r.err ? r.err.code : JSON.stringify(r.out));
  }
  {
    const r = await request({ noEmail: true });
    ok('account with no email -> throws failed-precondition', !!r.err && !r.out && r.err.code === 'failed-precondition', r.err ? r.err.code : JSON.stringify(r.out));
    ok('...and nothing was queued', !(r.docs.__add_email_queue || []).length);
  }
  {
    const r = await request({ getUserThrows: true });
    ok('account lookup fails -> throws', !!r.err && !r.out);
  }
  {
    const r = await request({});
    ok('control: email on file -> success and one confirmation queued', !!r.out && r.out.success === true && (r.docs.__add_email_queue || []).length === 1);
  }

  // ── R4-7-3 ────────────────────────────────────────────────────────────
  console.log('R4-7-3 exportCompanyData');
  const T = require(path.join(FN, 'tenant-ops.js'))._test;
  const { readZip } = require(path.join(FN, 'zip-lite.js'));
  const readmeOf = (out) => (out ? String(readZip(out.zip)['README.txt'] || '') : '');
  const mkSnap = (docs) => ({ docs: docs.map(([id, d]) => ({ id, data: () => d })) });
  const mkDb = (o) => ({
    doc: (p) => ({ get: async () => ({ exists: p.startsWith('companies/'), data: () => ({ name: 'Acme', ownerId: 'u1' }) }) }),
    collection: (coll) => ({ where: (field) => ({ limit: (n) => ({ get: async () => {
      if (o.fail && o.fail[coll] === field) throw new Error('DEADLINE_EXCEEDED (simulated)');
      if (o.big === coll && field === 'companyId') return mkSnap(Array.from({ length: n }, (_, i) => [coll + i, { companyId: 'c1' }]));
      return field === 'companyId' ? mkSnap([[coll + '1', { companyId: 'c1' }]]) : mkSnap([]);
    } }) }) }),
  });
  // firebase-functions' logger writes JSON straight to stdout/stderr: mute
  // only the expected export lines.
  async function exportWith(o) {
    const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
    const mute = (orig) => (chunk, ...rest) => (/export query failed|export truncated/.test(String(chunk)) ? true : orig(chunk, ...rest));
    let out = null, err = null;
    try {
      process.stdout.write = mute(ow); process.stderr.write = mute(ew);
      out = await T.buildCompanyExport(mkDb(o), null, 'c1', { sign: false, now: new Date('2026-10-06') });
    } catch (e) { err = e; } finally { process.stdout.write = ow; process.stderr.write = ew; }
    return { out, err };
  }
  {
    const r = await exportWith({ fail: { invoices: 'companyId' } });
    ok('a failed invoices query FAILS the export (no zip with invoices: 0)', !!r.err && !r.out, r.out ? JSON.stringify(r.out.counts) : '');
    ok('...with a retryable error that names the collection', !!r.err && r.err.code === 'unavailable' && /invoices/.test(r.err.message), r.err && (r.err.code + ' ' + r.err.message));
  }
  {
    const r = await exportWith({ fail: { photos: 'userId' } });
    ok('a failed legacy (owner) query also fails the export', !!r.err && !r.out);
  }
  {
    const r = await exportWith({ big: 'leads' });
    ok('a collection that hits EXPORT_LIMIT is reported as truncated', !!r.out && Array.isArray(r.out.truncated) && r.out.truncated.join() === 'leads', r.err ? r.err.message : JSON.stringify(r.out && r.out.truncated));
    const zipTxt = readmeOf(r.out);
    ok('...and the README marks that collection TRUNCATED (others not)', /leads: 5000\s+\(TRUNCATED/.test(zipTxt) && !/invoices: 1\s+\(TRUNCATED/.test(zipTxt));
  }
  {
    const r = await exportWith({});
    ok('control: a clean export has no truncation marker', !!r.out && r.out.truncated.length === 0 && /leads: 1/.test(readmeOf(r.out)) && !/TRUNCATED/.test(readmeOf(r.out)));
  }
  {
    const L2 = require(path.join(FN, 'tenant-ops-logic.js'));
    const txt = L2.exportReadme('Acme', { leads: 5000, invoices: 3 }, 'n', 'g', { truncated: ['leads'], limit: 5000 });
    ok('exportReadme: per-collection TRUNCATED marker', /leads: 5000  \(TRUNCATED: this file holds the first 5000 records only/.test(txt) && /invoices: 3$/m.test(txt));
    ok('exportReadme: old 4-argument call unchanged', L2.exportReadme('Acme', { leads: 2 }, 'n', 'g').includes('  leads: 2\n'));
  }

  console.log('');
  console.log(failed ? 'FAILED — ' + passed + ' passed, ' + failed + ' failed' : 'PASSED — ' + passed + ' assertions');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
