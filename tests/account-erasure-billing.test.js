/**
 * tests/account-erasure-billing.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Account erasure must stop Stripe billing (legal-checklist audit,
 * 2026-10-03). confirmAccountErasure deleted subscriptions/{uid} — the only
 * record of the Stripe ids — without cancelling the subscription, so a user
 * who exercised the right to erasure kept being charged every month.
 *
 * Two layers, both with a FAKE Stripe client (no network, no real API):
 *   A. functions/integrations/erasure-billing.js cancelBillingForErasure —
 *      what is cancelled, what counts as "already gone", when to refuse.
 *   B. The real confirmAccountErasure POST handler with Firestore / Auth /
 *      Storage / limiter stubbed: billing is cancelled BEFORE anything is
 *      deleted, and a Stripe failure deletes NOTHING and leaves the request
 *      retryable.
 *
 * Run: node tests/account-erasure-billing.test.js
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

// ── Fake Stripe ──────────────────────────────────────────────────────────
function fakeStripe(subs, opts) {
  const o = opts || {};
  const calls = [];
  if (o.log) calls.push = function (x) { o.log.push('stripe:' + x); return Array.prototype.push.call(this, x); };
  const byId = Object.assign({}, subs);
  const client = {
    calls,
    subscriptions: {
      list: async (q) => {
        calls.push('list:' + q.customer);
        if (o.listThrows) throw o.listThrows;
        return { data: Object.values(byId).filter((s) => s.customer === q.customer) };
      },
      retrieve: async (id) => {
        calls.push('retrieve:' + id);
        if (!byId[id]) { const e = new Error('No such subscription'); e.code = 'resource_missing'; e.statusCode = 404; throw e; }
        return byId[id];
      },
      cancel: async (id) => {
        calls.push('cancel:' + id);
        if (o.cancelThrows) throw o.cancelThrows;
        byId[id] = Object.assign({}, byId[id], { status: 'canceled' });
        return byId[id];
      },
    },
  };
  return client;
}
function fakeDb(docs, opts) {
  const o = opts || {};
  return {
    doc: (p) => ({
      get: async () => {
        if (o.readThrows) throw new Error('UNAVAILABLE');
        return { exists: docs[p] != null, data: () => docs[p] };
      },
    }),
  };
}

(async () => {
  const { cancelBillingForErasure, REFUSAL_MESSAGE } = require(path.join(FN, 'integrations', 'erasure-billing.js'));

  console.log('A. cancelBillingForErasure');
  {
    const stripe = fakeStripe({ sub_1: { id: 'sub_1', customer: 'cus_1', status: 'active' } });
    const r = await cancelBillingForErasure({
      db: fakeDb({ 'subscriptions/u1': { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'active' } }),
      uid: 'u1', getStripe: () => stripe,
    });
    ok('an active subscription is cancelled at Stripe', r.ok && r.cancelled.join() === 'sub_1' && stripe.calls.includes('cancel:sub_1'), JSON.stringify(r));
  }
  {
    // The double-bill case: a second live sub on the same customer that the
    // doc no longer names. Deleting the doc would orphan it for good.
    const stripe = fakeStripe({
      sub_1: { id: 'sub_1', customer: 'cus_1', status: 'trialing' },
      sub_2: { id: 'sub_2', customer: 'cus_1', status: 'past_due' },
      sub_old: { id: 'sub_old', customer: 'cus_1', status: 'canceled' },
    });
    const r = await cancelBillingForErasure({
      db: fakeDb({ 'subscriptions/u1': { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' } }),
      uid: 'u1', getStripe: () => stripe,
    });
    ok('every live sub on the customer is cancelled, not just the stored one',
      r.ok && r.cancelled.slice().sort().join() === 'sub_1,sub_2', JSON.stringify(r));
    ok('an already-canceled sub is not cancelled again', !stripe.calls.includes('cancel:sub_old'));
  }
  {
    let made = 0;
    const r = await cancelBillingForErasure({
      db: fakeDb({ 'subscriptions/u2': { status: 'none' } }), uid: 'u2', getStripe: () => { made++; return fakeStripe({}); },
    });
    ok('no Stripe ids (free / access-code / comp) → ok, Stripe never touched', r.ok && r.reason === 'no_stripe_billing' && made === 0);
    const r2 = await cancelBillingForErasure({ db: fakeDb({}), uid: 'u3', getStripe: () => { made++; return null; } });
    ok('no billing doc at all → ok, Stripe never touched', r2.ok && made === 0);
  }
  {
    const r = await cancelBillingForErasure({
      db: fakeDb({ 'subscriptions/u1': { stripeSubscriptionId: 'sub_gone' } }), uid: 'u1', getStripe: () => fakeStripe({}),
    });
    ok('a subscription Stripe no longer has (resource_missing) counts as stopped', r.ok && r.cancelled.length === 0);
  }
  {
    const e = new Error('Stripe API down'); e.statusCode = 500;
    const stripe = fakeStripe({ sub_1: { id: 'sub_1', customer: 'cus_1', status: 'active' } }, { cancelThrows: e });
    const r = await cancelBillingForErasure({
      db: fakeDb({ 'subscriptions/u1': { stripeSubscriptionId: 'sub_1' } }), uid: 'u1', getStripe: () => stripe,
    });
    ok('a Stripe error on cancel → refuse (ok:false)', !r.ok && r.reason === 'stripe_error');
  }
  {
    const r = await cancelBillingForErasure({
      db: fakeDb({ 'subscriptions/u1': { stripeSubscriptionId: 'sub_1' } }), uid: 'u1',
      getStripe: () => { throw new Error('STRIPE_SECRET_KEY is empty/unset'); },
    });
    ok('no Stripe client (key unset) with a sub on file → refuse', !r.ok && r.reason === 'stripe_unavailable');
  }
  {
    const r = await cancelBillingForErasure({ db: fakeDb({}, { readThrows: true }), uid: 'u1', getStripe: () => fakeStripe({}) });
    ok('billing doc unreadable → refuse (cannot prove there is no subscription)', !r.ok && r.reason === 'billing_record_unreadable');
  }
  ok('the refusal message says nothing was deleted and how to proceed',
    /nothing has been deleted/.test(REFUSAL_MESSAGE) && /Settings → Billing/.test(REFUSAL_MESSAGE));

  // ═══ B. the real confirmAccountErasure POST ═══════════════════════════
  console.log('B. confirmAccountErasure');
  async function runErasure(opts) {
    const o = opts || {};
    const events = o.events || [];
    const token = 'a'.repeat(64);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const docs = Object.assign({
      'account_erasures/u1': { tokenHash: hash, confirmed: false, expiresAt: { toMillis: () => Date.now() + 3600e3 } },
    }, o.docs || {});
    const emptyQuery = () => { const q = { where: () => q, limit: () => q, get: async () => ({ empty: true, size: 0, docs: [] }) }; return q; };
    const db = {
      doc: (p) => ({
        get: async () => { events.push('read:' + p); return { exists: docs[p] != null, data: () => docs[p] }; },
        update: async (d) => { events.push('update:' + p); docs[p] = Object.assign({}, docs[p], d); },
      }),
      collection: (n) => Object.assign(emptyQuery(), { add: async (row) => { events.push('add:' + n); (docs['__add_' + n] = docs['__add_' + n] || []).push(row); } }),
      collectionGroup: () => emptyQuery(),
      recursiveDelete: async (ref) => { events.push('delete'); },
    };
    const stripe = o.stripe;
    class StripeCtor { constructor() { return stripe; } }
    const stubs = {
      'firebase-functions/v2/https': { onRequest: (op, h) => ({ __opts: op, __handler: h }), onCall: (op, h) => ({ __opts: op, __handler: h }), HttpsError: Error },
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => (o.noKey ? '' : 'sk_test_fake') }) },
      './heartbeat': { onSchedule: (op, h) => ({ __handler: h }) },
      'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) }, FieldValue: { serverTimestamp: () => 'ts' } },
      'firebase-admin/auth': { getAuth: () => ({ updateUser: async () => events.push('auth-disable'), revokeRefreshTokens: async () => {} }) },
      'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ deleteFiles: async () => events.push('storage-delete') }) }) },
      './upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => ({}) },
      stripe: StripeCtor,
    };
    const real = Module._load;
    Module._load = function (request) {
      if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
      return real.apply(this, arguments);
    };
    const file = path.join(FN, 'integrations', 'compliance.js');
    delete require.cache[file];
    delete require.cache[path.join(FN, 'integrations', 'erasure-billing.js')];
    let mod;
    try { mod = require(file); } finally { Module._load = real; }
    const res = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
    // Module._load is restored; the handler's lazy require('./upstash-ratelimit')
    // and require('stripe') must still hit the stubs.
    Module._load = function (request) {
      if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
      return real.apply(this, arguments);
    };
    try { await mod.confirmAccountErasure.__handler({ method: 'POST', body: { uid: 'u1', token } }, res); }
    finally { Module._load = real; delete require.cache[file]; }
    return { res, events, docs, opts: mod.confirmAccountErasure.__opts };
  }

  {
    const shared = [];
    const stripe = fakeStripe({ sub_1: { id: 'sub_1', customer: 'cus_1', status: 'active' } }, { log: shared });
    const { res, events, docs, opts } = await runErasure({
      events: shared, stripe, docs: { 'subscriptions/u1': { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'active' } },
    });
    ok('erasure of a paying user → 200', res.code === 200, JSON.stringify(res.body));
    ok('...the Stripe subscription was cancelled', stripe.calls.includes('cancel:sub_1'));
    const cancelAt = events.indexOf('stripe:cancel:sub_1');
    ok('...and cancelled BEFORE the request is confirmed and before the first delete',
      cancelAt >= 0 && cancelAt < events.indexOf('update:account_erasures/u1') && cancelAt < events.indexOf('delete'), events.join(' > '));
    const audit = (docs.__add_audit_log || [])[0];
    ok('...and the audit row records which subscriptions were cancelled', !!audit && audit.stripeCancelled.join() === 'sub_1');
    ok('confirmAccountErasure binds STRIPE_SECRET_KEY', (opts.secrets || []).some((s) => s && s.name === 'STRIPE_SECRET_KEY'));
  }
  {
    const e = new Error('Stripe API down'); e.statusCode = 500;
    const stripe = fakeStripe({ sub_1: { id: 'sub_1', customer: 'cus_1', status: 'active' } }, { cancelThrows: e });
    const { res, events, docs } = await runErasure({
      stripe, docs: { 'subscriptions/u1': { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'active' } },
    });
    ok('Stripe cancel fails → 409 billing_not_cancelled with the clear message',
      res.code === 409 && res.body && res.body.code === 'billing_not_cancelled' && /nothing has been deleted/.test(res.body.error), JSON.stringify(res.body));
    ok('...NOTHING deleted, Auth not disabled', !events.includes('delete') && !events.includes('storage-delete') && !events.includes('auth-disable'), events.join(' > '));
    ok('...and the request is NOT marked confirmed, so the same link can retry',
      docs['account_erasures/u1'].confirmed === false && !events.includes('update:account_erasures/u1'));
  }
  {
    const { res, events } = await runErasure({ noKey: true, stripe: null,
      docs: { 'subscriptions/u1': { stripeSubscriptionId: 'sub_1', status: 'active' } } });
    ok('Stripe key unset with a live sub on file → refused, nothing deleted', res.code === 409 && !events.includes('delete'));
  }
  {
    const { res, events } = await runErasure({ noKey: true, stripe: null, docs: { 'subscriptions/u1': { status: 'none' } } });
    ok('a free user (no Stripe ids) erases normally, Stripe never needed', res.code === 200 && events.includes('delete'));
  }

  console.log('');
  console.log(failed ? 'FAILED — ' + passed + ' passed, ' + failed + ' failed' : 'PASSED — ' + passed + ' assertions');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
