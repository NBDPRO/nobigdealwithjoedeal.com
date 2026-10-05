/**
 * tests/markpaid-concurrent-payments-2026-10-05.test.js
 *
 * HIGH bug (approved fix 2026-10-05): concurrent payments erased each other.
 * Client markPaid (docs/pro/js/invoice-pipeline.js) did getDoc → updateDoc of
 * the WHOLE payments[] / amountPaid / status. A card payment the Stripe
 * webhook credited in between (functions/stripe.js, its own transaction) was
 * overwritten by the page's stale copy; the webhook's retry is
 * idempotent-skipped (paidIntentIds), so the card money never came back and
 * the homeowner was chased for money already paid.
 *
 * This suite INTERLEAVES the two writers on one fake Firestore with real
 * optimistic-concurrency semantics (a transaction whose read went stale is
 * re-run; a plain updateDoc just overwrites):
 *   - the client side is the REAL markPaid, loaded from invoice-pipeline.js;
 *   - the server side is the REAL webhook credit callback, cut out of
 *     functions/stripe.js by its anchor (the Cloud Function can't be
 *     require()d standalone — onRequest/defineSecret run at load) and run
 *     with its own scope (invRef, paymentIntent, metadata, FieldValue).
 * The Stripe credit is injected right after markPaid's FIRST read of the
 * invoice — the exact window that lost money. Both payments must survive.
 *
 * Proven red on the old code (getDoc + updateDoc): the card payment vanished
 * (payments 1, amountPaid 4000) — see the PR.
 *
 * Synthetic data only (public repo): ZZ_QA ids, fake intents.
 * Run: node tests/markpaid-concurrent-payments-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── the real server credit callback, cut out of stripe.js ──────────────────
const STRIPE_SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'stripe.js'), 'utf8').replace(/\r\n/g, '\n');
const ANCHOR = 'const creditResult = await db.runTransaction(async (tx) => {';
const at0 = STRIPE_SRC.indexOf(ANCHOR);
const end0 = at0 === -1 ? -1 : STRIPE_SRC.indexOf('\n          });', at0);
ok('stripe.js still has the webhook credit transaction (anchor found)', at0 !== -1 && end0 !== -1);
const BODY = STRIPE_SRC.slice(at0 + ANCHOR.length, end0);
// eslint-disable-next-line no-new-func
const serverCredit = new Function('tx', 'invRef', 'paymentIntent', 'metadata', 'claimedUserId', 'FieldValue',
  'return (async () => {' + BODY + '\n})();');

// ── one fake Firestore, shared by both writers ─────────────────────────────
const SERVER_TS = { __ts: true };
const FieldValue = {
  serverTimestamp: () => SERVER_TS,
  arrayUnion: (...xs) => ({ __union: xs }),
};
function makeStore(seed) {
  const docs = new Map(); // path → { data, v }
  Object.entries(seed).forEach(([p, d]) => docs.set(p, { data: structuredClone(d), v: 1 }));
  const resolve = (prior, patch) => {
    const next = Object.assign({}, prior);
    for (const [k, val] of Object.entries(patch)) {
      if (val === SERVER_TS) next[k] = new Date();
      else if (val && val.__union) {
        const a = Array.isArray(prior[k]) ? prior[k].slice() : [];
        val.__union.forEach((x) => { if (!a.includes(x)) a.push(x); });
        next[k] = a;
      } else next[k] = structuredClone(val);
    }
    return next;
  };
  const read = (p) => { const d = docs.get(p); return d ? { data: structuredClone(d.data), v: d.v } : { data: null, v: 0 }; };
  const write = (p, patch) => {
    const d = docs.get(p);
    if (!d) throw new Error('NOT_FOUND');
    docs.set(p, { data: resolve(d.data, patch), v: d.v + 1 });
  };
  // Optimistic transaction: re-run fn when any doc it read changed before commit.
  async function transact(fn, snapOf, onRead) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const seen = new Map(); const queued = [];
      const tx = {
        get: async (ref) => {
          const r = read(ref.path); seen.set(ref.path, r.v);
          if (onRead) await onRead(ref.path);
          return snapOf(r.data);
        },
        update: (ref, patch) => { queued.push([ref.path, patch]); },
      };
      const out = await fn(tx);
      if ([...seen].every(([p, v]) => read(p).v === v)) {
        queued.forEach(([p, patch]) => write(p, patch));
        stats.commits++;
        return out;
      }
      stats.retries++;
    }
    throw new Error('transaction: too much contention');
  }
  const stats = { commits: 0, retries: 0 };
  return { docs, read, write, transact, stats };
}
const clientSnap = (d) => ({ exists: () => d != null, data: () => d });
const adminSnap = (d) => ({ exists: d != null, data: () => d });

// Run the real webhook credit for one PaymentIntent against the store.
function stripeCredit(store, invoiceId, pi) {
  const invRef = { path: 'invoices/' + invoiceId };
  return store.transact((tx) => serverCredit(tx, invRef, pi, pi.metadata || {}, (pi.metadata || {}).userId, FieldValue), adminSnap);
}

// ── the real markPaid, with its window globals pointed at the store ────────
global.window = global.window || {};
const IP = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-pipeline.js'));

function wire(store, onFirstInvoiceRead) {
  let fired = false;
  const hook = async (p) => {
    if (fired || !p.startsWith('invoices/')) return;
    fired = true;
    if (onFirstInvoiceRead) await onFirstInvoiceRead();
  };
  Object.assign(global.window, {
    _db: { fake: true },
    _auth: { currentUser: { uid: 'zzqa-rep' } },
    collection: () => ({}),
    doc: (_db, col, id) => ({ path: col + '/' + id }),
    getDoc: async (ref) => { const r = store.read(ref.path); await hook(ref.path); return clientSnap(r.data); },
    updateDoc: async (ref, patch) => { store.write(ref.path, patch); },
    runTransaction: (_db, fn) => store.transact(fn, clientSnap, hook),
  });
  delete global.window.NBDComms;
}

const baseInvoice = () => ({
  createdBy: 'zzqa-owner', companyId: 'zzqa-co', total: 10000, amountPaid: 0, balanceDue: 10000,
  depositAmount: 5000, status: 'sent', paidAt: null, payments: [],
});
const pi = (id, cents) => ({ id, amount_received: cents, metadata: { invoiceId: 'zzqa-inv', companyId: 'zzqa-co' } });
const sumCents = (ps) => ps.reduce((t, p) => t + Math.round(Number(p.amount) * 100), 0);

(async () => {
  console.log('\n1. a card payment lands between markPaid\'s read and its write');
  {
    const store = makeStore({ 'invoices/zzqa-inv': baseInvoice() });
    let credit = null;
    wire(store, async () => { credit = await stripeCredit(store, 'zzqa-inv', pi('pi_zzqa_card1', 300000)); });
    await IP.markPaid('zzqa-inv', 4000, 'check', { at: new Date('2026-10-05T12:00:00'), reference: 'ZZQA-1042', paymentId: 'mp_zzqa_chk1' });
    const inv = store.read('invoices/zzqa-inv').data;
    ok('the webhook really credited in the window', credit && credit.credited === true, JSON.stringify(credit));
    ok('BOTH payments survive (card + check)', inv.payments.length === 2
      && inv.payments.some((p) => p.paymentIntentId === 'pi_zzqa_card1' && p.amount === 3000)
      && inv.payments.some((p) => p.paymentId === 'mp_zzqa_chk1' && p.amount === 4000),
    JSON.stringify(inv.payments.map((p) => [p.method, p.amount])));
    ok('amountPaid = 7000 = sum of payments[] (cents)', Math.round(inv.amountPaid * 100) === 700000 && sumCents(inv.payments) === 700000, String(inv.amountPaid));
    ok('balanceDue 3000, status partial', inv.balanceDue === 3000 && inv.status === 'partial', inv.balanceDue + ' ' + inv.status);
    ok('the idempotency key for the card survives (a Stripe retry stays a no-op)', Array.isArray(inv.paidIntentIds) && inv.paidIntentIds.includes('pi_zzqa_card1'));
    ok('markPaid re-ran its transaction once on the stale read', store.stats.retries === 1, JSON.stringify(store.stats));
    const replay = await stripeCredit(store, 'zzqa-inv', pi('pi_zzqa_card1', 300000));
    const after = store.read('invoices/zzqa-inv').data;
    ok('a Stripe retry of the same intent is skipped, nothing double-counted', replay.skipped === 'already_applied' && after.payments.length === 2 && Math.round(after.amountPaid * 100) === 700000);
  }

  console.log('\n2. the two together pay the invoice off');
  {
    const store = makeStore({ 'invoices/zzqa-inv': baseInvoice() });
    wire(store, async () => { await stripeCredit(store, 'zzqa-inv', pi('pi_zzqa_card2', 600000)); });
    await IP.markPaid('zzqa-inv', 4000, 'zelle', { paymentId: 'mp_zzqa_z2' });
    const inv = store.read('invoices/zzqa-inv').data;
    ok('6000 card + 4000 zelle → paid, balance 0, amountPaid 10000', inv.status === 'paid' && inv.balanceDue === 0 && inv.amountPaid === 10000 && inv.payments.length === 2, inv.status + ' ' + inv.amountPaid);
    ok('paidAt stamped on the payoff', inv.paidAt instanceof Date);
  }

  console.log('\n3. the other order: a check is recorded while the webhook transaction is open');
  {
    const store = makeStore({ 'invoices/zzqa-inv': baseInvoice() });
    wire(store, null);
    const invRef = { path: 'invoices/zzqa-inv' };
    let injected = false;
    const p = pi('pi_zzqa_card3', 250000);
    await store.transact((tx) => serverCredit(tx, invRef, p, p.metadata, undefined, FieldValue), adminSnap, async () => {
      if (injected) return; injected = true;
      await IP.markPaid('zzqa-inv', 1000, 'cash', { paymentId: 'mp_zzqa_cash3' });
    });
    const inv = store.read('invoices/zzqa-inv').data;
    ok('both survive: 2500 card + 1000 cash = 3500', inv.payments.length === 2 && Math.round(inv.amountPaid * 100) === 350000 && sumCents(inv.payments) === 350000, JSON.stringify(inv.payments.map((x) => [x.method, x.amount])));
  }

  console.log('\n4. two reps record at once (client vs client)');
  {
    const store = makeStore({ 'invoices/zzqa-inv': baseInvoice() });
    wire(store, async () => { await IP.markPaid('zzqa-inv', 1500, 'cash', { paymentId: 'mp_zzqa_repB' }); });
    await IP.markPaid('zzqa-inv', 2000, 'check', { paymentId: 'mp_zzqa_repA' });
    const inv = store.read('invoices/zzqa-inv').data;
    ok('both manual payments survive: 3500', inv.payments.length === 2 && inv.amountPaid === 3500, JSON.stringify(inv.payments.map((x) => [x.paymentId, x.amount])));
  }

  console.log('\n5. a retried markPaid with the same paymentId is a no-op');
  {
    const store = makeStore({ 'invoices/zzqa-inv': baseInvoice() });
    wire(store, null);
    await IP.markPaid('zzqa-inv', 2000, 'check', { paymentId: 'mp_zzqa_same' });
    await IP.markPaid('zzqa-inv', 2000, 'check', { paymentId: 'mp_zzqa_same' });
    const inv = store.read('invoices/zzqa-inv').data;
    ok('one entry, amountPaid 2000', inv.payments.length === 1 && inv.amountPaid === 2000, inv.payments.length + ' / ' + inv.amountPaid);
  }

  console.log('\n6. guard: markPaid writes through runTransaction, not a bare getDoc→updateDoc');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-pipeline.js'), 'utf8').replace(/\r\n/g, '\n');
    const fn = src.split('async function markPaid(')[1].split('\n  async function ')[0]
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const iTx = fn.indexOf('window.runTransaction(db');
    const iGet = fn.indexOf('window.getDoc(invRef)');
    ok('markPaid opens a transaction on the invoice', iTx !== -1 && /tx\.get\(invRef\)/.test(fn) && /tx\.update\(invRef/.test(fn));
    ok('the transaction comes first; getDoc is only the no-runTransaction fallback', iTx !== -1 && iGet > iTx);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
