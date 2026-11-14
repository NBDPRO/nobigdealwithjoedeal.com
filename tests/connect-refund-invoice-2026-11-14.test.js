/**
 * tests/connect-refund-invoice-2026-11-14.test.js — a refund on a Connect
 * tenant's (contractor's) invoice reopens what's owed.
 *
 * THE BUG. A contractor on Stripe Connect is paid through a destination
 * charge minted by createStripePaymentLink. When that charge was refunded,
 * invoiceWebhook's charge.refunded branch only sent an alert ("the CRM
 * invoice ledger was NOT changed") — the "phase 4" deferral. The owner's
 * Stripe ledger deliberately skips Connect charges (#3037), so nothing wrote
 * the refund anywhere: the contractor's invoice stayed 'paid', balanceDue 0,
 * and their revenue still counted money that went back to the homeowner.
 *
 * JOE'S DECISION (2026-11-14). A refund on a Connect invoice marks it
 * refunded / partly refunded and puts the amount back into what's owed.
 *
 * WHAT THIS PINS (real source: the charge.refunded branch and its helpers
 * are EXTRACTED from functions/stripe.js and run in a vm against a fake
 * Stripe + fake Firestore, the stripe-dispute-branches.test.js pattern):
 *   R1 a partial refund: refunds[] entry, amountPaid down, balanceDue up,
 *      status 'partial', refundStatus 'partly_refunded'; payments[] untouched
 *   R2 a webhook retry (same refund) changes nothing — no double reopen
 *   R3 a second refund for the rest: owed in full again, status 'sent',
 *      refundStatus 'refunded'
 *   R4 revenue (the real collected-revenue.js) nets the refund ONCE, and the
 *      owed rule reads the reopened balance
 *   R5 cross-tenant: another company's invoice, a different connected account,
 *      or an invoice this payment never credited is never touched
 *   R6 the owner's own (non-Connect) charge is left to the Stripe ledger
 *   R7 the alert says what happened
 *   R8 a void invoice records the refund but is not reopened
 *   R9 planner: a refund that later FAILED gives the money back
 *
 * Zero deps. Run: node tests/connect-refund-invoice-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STRIPE_SRC = fs.readFileSync(path.join(ROOT, 'functions', 'stripe.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

let PLAN = null;
try { PLAN = require(path.join(ROOT, 'functions', 'connect-refund-logic.js')); } catch (e) { PLAN = null; }

// ── Extraction (same brace matcher as stripe-dispute-branches.test.js) ────
function matchPair(src, from, open, close) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e === -1) return -1; i = e + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function refundBranch() {
  const re = /\}\s*else\s+if\s*\(/g;
  const hits = [];
  let m;
  while ((m = re.exec(STRIPE_SRC)) !== null) {
    const op = m.index + m[0].length - 1;
    const cp = matchPair(STRIPE_SRC, op, '(', ')');
    if (cp === -1) continue;
    if (!/event\.type\s*===\s*['"]charge\.refunded['"]/.test(STRIPE_SRC.slice(op + 1, cp))) continue;
    const b = STRIPE_SRC.indexOf('{', cp);
    const e = matchPair(STRIPE_SRC, b, '{', '}');
    if (e > -1) hits.push(STRIPE_SRC.slice(b + 1, e));
  }
  return hits;
}
function extractFn(name) {
  const re = new RegExp('(?:^|\\n)\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(STRIPE_SRC);
  if (!m) return null;
  const open = STRIPE_SRC.indexOf('{', m.index + m[0].length);
  const close = open === -1 ? -1 : matchPair(STRIPE_SRC, open, '{', '}');
  return close === -1 ? null : STRIPE_SRC.slice(m.index, close + 1).trim();
}

console.log('CONNECT REFUND → the tenant invoice reopens (real source, vm-executed)');
console.log('\nExtraction');
const BRANCHES = refundBranch();
ok('exactly one branch handles charge.refunded', BRANCHES.length === 1, 'found ' + BRANCHES.length);
const HELPERS = ['resolveInvoiceContext', 'alertInvoicePaymentEvent', 'connectDestinationOf', 'applyConnectRefund'];
const SRC = {};
for (const h of HELPERS) {
  SRC[h] = extractFn(h);
  ok(h + ' extracted from functions/stripe.js', !!SRC[h], 'missing — the Connect refund is not applied to the invoice');
}
ok('functions/connect-refund-logic.js loads (the pure planner)', !!PLAN && typeof PLAN.planConnectRefund === 'function');

let SCRIPT = null;
let compileErr = '';
if (BRANCHES.length === 1) {
  const boot = HELPERS.map((h) => SRC[h] || '').join('\n')
    + '\nglobalThis.__run = async function () {' + BRANCHES[0] + '\n};';
  try { SCRIPT = new vm.Script(boot, { filename: 'extracted-charge-refunded.js' }); }
  catch (e) { compileErr = e.message; }
}
ok('the extracted region compiles', !!SCRIPT, compileErr);

// ── Fakes ─────────────────────────────────────────────────────────────────
const SERVER_TS = { __serverTimestamp: true };
function makeDb(w) {
  const docRef = (name, id) => ({
    _name: name, _id: id,
    get: async () => {
      const d = (w.fs[name] || {})[id];
      return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) };
    },
    update: async (patch) => { w.writes.push([name, id, patch]); apply(name, id, patch); },
  });
  function apply(name, id, patch) {
    const cur = (w.fs[name] || {})[id];
    if (!cur) throw new Error('update on missing doc ' + name + '/' + id);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      cur[k] = v instanceof Date ? v.toISOString() : JSON.parse(JSON.stringify(v === undefined ? null : v));
    }
  }
  return {
    collection: (name) => ({
      add: async (doc) => {
        if (name === 'email_queue') w.emails.push(doc);
        else if (/\/activity$/.test(name)) w.activities.push(doc);
        return { id: 'doc_' + (++w.seq) };
      },
      doc: (id) => docRef(name, String(id)),
    }),
    doc: (p) => { const i = p.lastIndexOf('/'); return docRef(p.slice(0, i), p.slice(i + 1)); },
    runTransaction: async (fn) => {
      const tx = {
        get: (ref) => ref.get(),
        update: (ref, patch) => { w.writes.push([ref._name, ref._id, patch]); apply(ref._name, ref._id, patch); },
      };
      return fn(tx);
    },
  };
}
function makeStripe(w) {
  return {
    paymentIntents: { retrieve: async (id) => {
      const pi = w.pis[id];
      if (!pi) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
      return pi;
    } },
    refunds: { list: async (p) => ({ data: (w.refunds[p && p.charge] || []).slice() }) },
  };
}

const T0 = 1789000000; // a fixed Stripe-seconds timestamp
function world(over) {
  return Object.assign({
    seq: 0, writes: [], emails: [], activities: [], logs: [], slack: [],
    pis: { pi_T: { id: 'pi_T', metadata: { invoiceId: 'INV_T', userId: 'u_roofco', companyId: 'C_ROOFCO' } } },
    refunds: { ch_T: [{ id: 're_1', amount: 40000, status: 'succeeded', created: T0 + 86400, charge: 'ch_T' }] },
    fs: {
      invoices: {
        INV_T: {
          companyId: 'C_ROOFCO', createdBy: 'u_roofco', leadId: 'lead_T', status: 'paid',
          total: 1000, amountPaid: 1000, balanceDue: 0, depositAmount: 300, depositPaid: true,
          paidAt: '2026-11-01T16:00:00.000Z',
          payments: [{ amount: 1000, at: '2026-11-01T16:00:00.000Z', method: 'stripe', paymentIntentId: 'pi_T' }],
          paidIntentIds: ['pi_T'],
        },
      },
      connectAccounts: { C_ROOFCO: { accountId: 'acct_ROOFCO' } },
    },
  }, over || {});
}
// A destination charge as Stripe delivers it on the PLATFORM endpoint.
function charge(over) {
  return Object.assign({
    id: 'ch_T', object: 'charge', amount: 100000, amount_refunded: 40000, refunded: false,
    payment_intent: 'pi_T', destination: 'acct_ROOFCO',
    transfer_data: { destination: 'acct_ROOFCO' }, on_behalf_of: 'acct_ROOFCO',
  }, over || {});
}

async function run(w, ch, evtId) {
  if (!SCRIPT) return new Error('no script');
  const ctx = vm.createContext({
    event: { id: evtId || 'evt_1', type: 'charge.refunded', data: { object: ch } },
    stripe: makeStripe(w),
    db: makeDb(w),
    logger: {
      warn: (n, p) => w.logs.push(['warn', n, p]),
      error: (n, p) => w.logs.push(['error', n, p]),
      info: (n, p) => w.logs.push(['info', n, p]),
    },
    getAuth: () => ({ getUser: async () => ({ email: 'contractor@example.com' }) }),
    FieldValue: { serverTimestamp: () => SERVER_TS },
    require: (p) => {
      if (/slack$/.test(p)) return { postSlack: async (x) => { w.slack.push(x); return { posted: true }; } };
      if (/connect-refund-logic$/.test(p)) return PLAN;
      throw new Error('unexpected require in extracted branch: ' + p);
    },
    console, Date, Math, JSON, Number, String, Array, Object, Promise, Error,
  });
  SCRIPT.runInContext(ctx);
  try { await ctx.__run(); return null; } catch (e) { return e; }
}

const inv = (w, id) => w.fs.invoices[id || 'INV_T'];
const told = (w) => JSON.stringify([w.emails[w.emails.length - 1] || {}, w.slack[w.slack.length - 1] || {}]);

// Revenue: the real collected-revenue.js.
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'collected-revenue.js'), 'utf8'),
  { window: win, console, Date, Math, JSON, parseFloat, isNaN, Array, Object });
const R = win.NBDRevenue;
const lifetime = (i) => R.collectedBetween([i], null, null).total;

async function main() {
  console.log('\nR1 — a partial refund on a Connect invoice reopens that much');
  const w = world();
  {
    const err = await run(w, charge());
    ok('R1 the branch runs without throwing', !err, err && err.message);
    const i = inv(w);
    ok('R1 amountPaid comes down by the refund (1000 → 600)', i.amountPaid === 600, 'amountPaid=' + i.amountPaid);
    ok('R1 balanceDue goes back up (0 → 400)', i.balanceDue === 400, 'balanceDue=' + i.balanceDue);
    ok('R1 status is the existing word \'partial\' (some is still paid)', i.status === 'partial', 'status=' + i.status);
    ok('R1 refundStatus labels it partly refunded', i.refundStatus === 'partly_refunded', 'refundStatus=' + i.refundStatus);
    ok('R1 the refund is on refunds[], keyed by the Stripe refund id',
      Array.isArray(i.refunds) && i.refunds.length === 1 && i.refunds[0].stripeRef === 're_1'
      && i.refunds[0].amount === 400 && i.refunds[0].kind === 'refund' && i.refunds[0].status === 'succeeded',
      JSON.stringify(i.refunds));
    ok('R1 the refund carries its own date (the day it went back)',
      i.refunds && new Date(i.refunds[0].at).getTime() === (T0 + 86400) * 1000);
    ok('R1 refundedTotal = 400', i.refundedTotal === 400, 'refundedTotal=' + i.refundedTotal);
    ok('R1 payments[] is left as it was (the refund is not a negative payment)',
      i.payments.length === 1 && i.payments[0].amount === 1000);
    ok('R1 paidAt cleared — it is no longer paid in full', i.paidAt === null, 'paidAt=' + i.paidAt);
    ok('R1 a payment link would bill exactly the reopened amount (total − amountPaid = balanceDue)',
      Math.round((i.total - i.amountPaid) * 100) === Math.round(i.balanceDue * 100));
  }

  console.log('\nR2 — a webhook retry never reopens twice');
  {
    const before = JSON.stringify(inv(w));
    await run(w, charge(), 'evt_1_retry');
    ok('R2 same refund delivered again: invoice unchanged', JSON.stringify(inv(w)) === before,
      JSON.stringify(inv(w)));
  }

  console.log('\nR3 — refunding the rest: owed in full again');
  {
    w.refunds.ch_T.push({ id: 're_2', amount: 60000, status: 'succeeded', created: T0 + 2 * 86400, charge: 'ch_T' });
    await run(w, charge({ amount_refunded: 100000, refunded: true }), 'evt_2');
    const i = inv(w);
    ok('R3 amountPaid 0, balanceDue 1000', i.amountPaid === 0 && i.balanceDue === 1000, JSON.stringify([i.amountPaid, i.balanceDue]));
    ok('R3 status \'sent\' (owed, nothing paid — the ACH-return word)', i.status === 'sent', 'status=' + i.status);
    ok('R3 refundStatus \'refunded\'', i.refundStatus === 'refunded', 'refundStatus=' + i.refundStatus);
    ok('R3 two refund entries, refundedTotal 1000', (i.refunds || []).length === 2 && i.refundedTotal === 1000);
    ok('R3 depositPaid is false again', i.depositPaid === false);
    const again = JSON.stringify(i);
    await run(w, charge({ amount_refunded: 100000, refunded: true }), 'evt_2_retry');
    ok('R3 retry of the full refund: unchanged', JSON.stringify(inv(w)) === again);
  }

  console.log('\nR4 — revenue nets the refund once; the owed rule sees the balance');
  {
    const w4 = world();
    await run(w4, charge());
    const i = inv(w4);
    ok('R4 lifetime collected = 600 after a 400 refund (not 200: no double subtraction)', lifetime(i) === 600, 'got ' + lifetime(i));
    ok('R4 the refund is one negative entry dated the refund day',
      R.paymentsOf(i).filter((p) => p.refund).length === 1);
    ok('R4 isOwedInvoice is true and owedDollarsOf = 400', R.isOwedInvoice(i) && R.owedDollarsOf(i) === 400, String(R.owedDollarsOf(i)));
    const full = inv(w);
    ok('R4 fully refunded: lifetime collected = 0, owed 1000', lifetime(full) === 0 && R.owedDollarsOf(full) === 1000,
      JSON.stringify([lifetime(full), R.owedDollarsOf(full)]));
    // Control: the bug's end state (paid, no refund recorded) counts the full 1000.
    const bug = JSON.parse(JSON.stringify(world().fs.invoices.INV_T));
    ok('R4 control: the unfixed invoice counts 1000 collected and 0 owed', lifetime(bug) === 1000 && R.owedDollarsOf(bug) === 0);
  }

  console.log('\nR5 — only the invoice that belongs to that Connect account');
  {
    const wa = world();
    wa.fs.invoices.INV_T.companyId = 'C_OTHER';
    const before = JSON.stringify(wa.fs.invoices.INV_T);
    await run(wa, charge());
    ok('R5 PI says C_ROOFCO but the invoice is another company\'s: untouched',
      JSON.stringify(wa.fs.invoices.INV_T) === before);

    const wb = world();
    wb.fs.connectAccounts.C_ROOFCO.accountId = 'acct_SOMEONE_ELSE';
    const beforeB = JSON.stringify(inv(wb));
    await run(wb, charge());
    ok('R5 the charge went to a different connected account than the company\'s: untouched',
      JSON.stringify(inv(wb)) === beforeB);

    const wc = world();
    delete wc.fs.connectAccounts.C_ROOFCO;
    const beforeC = JSON.stringify(inv(wc));
    await run(wc, charge());
    ok('R5 the company has no connected account on file: untouched', JSON.stringify(inv(wc)) === beforeC);

    const wd = world();
    wd.fs.invoices.INV_T.paidIntentIds = ['pi_SOMETHING_ELSE'];
    const beforeD = JSON.stringify(inv(wd));
    await run(wd, charge());
    ok('R5 this payment never credited the invoice: untouched', JSON.stringify(inv(wd)) === beforeD);
    ok('R5 …and the alert still goes out, saying the invoice was not changed',
      /not changed/i.test(told(wd)), told(wd));

    const we = world();
    we.pis.pi_T.metadata = { invoiceId: 'INV_T', userId: 'u_roofco' }; // no companyId
    const beforeE = JSON.stringify(inv(we));
    await run(we, charge());
    ok('R5 a PI with no companyId: untouched', JSON.stringify(inv(we)) === beforeE);
  }

  console.log('\nR6 — the owner\'s own charge stays the Stripe ledger\'s job');
  {
    const wo = world();
    wo.pis.pi_T.metadata.companyId = 'OWNER_CO';
    wo.fs.invoices.INV_T.companyId = 'OWNER_CO';
    const before = JSON.stringify(inv(wo));
    await run(wo, charge({ destination: null, transfer_data: null, on_behalf_of: null }));
    ok('R6 a platform (non-Connect) charge: this branch does not touch the invoice',
      JSON.stringify(inv(wo)) === before, 'the ledger already records it; doing it here too would double it');
  }

  console.log('\nR7 — the alert says what happened');
  {
    const w7 = world();
    await run(w7, charge());
    const t = told(w7);
    ok('R7 the alert says the amount is owed again', /owed again/i.test(t) && /\$400\.00/.test(t), t.slice(0, 400));
    ok('R7 …and no longer claims the CRM ledger was NOT changed', !/was NOT changed/.test(t));
  }

  console.log('\nR8 — a void invoice records the refund but is not reopened');
  {
    const w8 = world();
    w8.fs.invoices.INV_T.status = 'void';
    await run(w8, charge());
    const i = inv(w8);
    ok('R8 refund recorded on refunds[]', Array.isArray(i.refunds) && i.refunds.length === 1);
    ok('R8 status stays void, balanceDue stays 0', i.status === 'void' && i.balanceDue === 0 && i.amountPaid === 1000,
      JSON.stringify([i.status, i.balanceDue, i.amountPaid]));
  }

  console.log('\nR9 — planner: status changes, failed refunds, nothing-to-do');
  if (PLAN) {
    const base = JSON.parse(JSON.stringify(world().fs.invoices.INV_T));
    const p1 = PLAN.planConnectRefund(base, [{ id: 're_1', amount: 40000, status: 'pending', created: T0 }]);
    ok('R9 a pending refund already reopens (Stripe has taken it back from the balance)',
      p1 && p1.patch.amountPaid === 600 && p1.patch.balanceDue === 400);
    const after1 = Object.assign({}, base, p1.patch);
    const p2 = PLAN.planConnectRefund(after1, [{ id: 're_1', amount: 40000, status: 'succeeded', created: T0 }]);
    ok('R9 pending → succeeded updates the entry, money unchanged',
      p2 && p2.patch.refunds[0].status === 'succeeded' && !('amountPaid' in p2.patch));
    const after2 = Object.assign({}, after1, p2.patch);
    const p3 = PLAN.planConnectRefund(after2, [{ id: 're_1', amount: 40000, status: 'failed', created: T0 }]);
    ok('R9 a refund that FAILED gives the money back: paid in full again',
      p3 && p3.patch.amountPaid === 1000 && p3.patch.balanceDue === 0 && p3.patch.status === 'paid'
      && p3.patch.refundStatus === null && p3.patch.refundedTotal === 0, JSON.stringify(p3 && p3.patch));
    ok('R9 the same refunds again → null (nothing to write)',
      PLAN.planConnectRefund(Object.assign({}, after2, p3.patch), [{ id: 're_1', amount: 40000, status: 'failed', created: T0 }]) === null);
    ok('R9 a zero / id-less refund is ignored', PLAN.planConnectRefund(base, [{ id: '', amount: 500 }, { id: 're_z', amount: 0 }]) === null);
    const odd = Object.assign({}, base, { total: 1234.56, amountPaid: 1234.56 });
    const p4 = PLAN.planConnectRefund(odd, [{ id: 're_c', amount: 33, status: 'succeeded', created: T0 }]);
    ok('R9 cents stay exact (1234.56 − 0.33)', p4 && p4.patch.amountPaid === 1234.23 && p4.patch.balanceDue === 0.33,
      JSON.stringify(p4 && [p4.patch.amountPaid, p4.patch.balanceDue]));
    ok('R9 the planner never names status words outside invoiceStatusWord',
      ['paid', 'partial', 'sent'].includes(p1.patch.status) && ['paid', 'partial', 'sent'].includes(p3.patch.status));
  } else {
    ok('R9 planner present', false, 'functions/connect-refund-logic.js missing');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
