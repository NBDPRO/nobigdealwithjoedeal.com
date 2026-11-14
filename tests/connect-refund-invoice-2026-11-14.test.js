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
function refundBranch(type) {
  const re = /\}\s*else\s+if\s*\(/g;
  const hits = [];
  const typeRe = new RegExp('event\\.type\\s*===\\s*[\'"]' + (type || 'charge.refunded').replace(/\./g, '\\.') + '[\'"]');
  let m;
  while ((m = re.exec(STRIPE_SRC)) !== null) {
    const op = m.index + m[0].length - 1;
    const cp = matchPair(STRIPE_SRC, op, '(', ')');
    if (cp === -1) continue;
    if (!typeRe.test(STRIPE_SRC.slice(op + 1, cp))) continue;
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

const UPDATED = refundBranch('charge.refund.updated');
ok('exactly one branch handles charge.refund.updated (a pending refund that later fails)', UPDATED.length === 1,
  'found ' + UPDATED.length + ' — a failed refund would leave the invoice reopened and the homeowner billed again');

let SCRIPT = null;
let compileErr = '';
if (BRANCHES.length === 1) {
  const boot = HELPERS.map((h) => SRC[h] || '').join('\n')
    + '\nglobalThis.__run = async function () {' + BRANCHES[0] + '\n};'
    + (UPDATED.length === 1 ? '\nglobalThis.__runUpdated = async function () {' + UPDATED[0] + '\n};' : '');
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
    set: async (data) => { setDoc(name, id, data); },
    collection: (sub) => colRef(name + '/' + id + '/' + sub),
  });
  function setDoc(name, id, data) {
    w.writes.push([name, id, data]);
    (w.fs[name] = w.fs[name] || {})[id] = JSON.parse(JSON.stringify(data));
  }
  const colRef = (name) => ({
    _isCol: true, _name: name,
    add: async (doc) => {
      if (name === 'email_queue') w.emails.push(doc);
      else if (/\/activity$/.test(name)) w.activities.push(doc);
      return { id: 'doc_' + (++w.seq) };
    },
    doc: (id) => docRef(name, String(id)),
    get: async () => snapCol(name),
  });
  const snapCol = (name) => {
    const m = w.fs[name] || {};
    const docs = Object.keys(m).map((k) => ({ id: k, exists: true, data: () => JSON.parse(JSON.stringify(m[k])) }));
    return { docs, empty: docs.length === 0, size: docs.length };
  };
  function apply(name, id, patch) {
    const cur = (w.fs[name] || {})[id];
    if (!cur) throw new Error('update on missing doc ' + name + '/' + id);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      cur[k] = v instanceof Date ? v.toISOString() : JSON.parse(JSON.stringify(v === undefined ? null : v));
    }
  }
  return {
    collection: (name) => colRef(name),
    doc: (p) => { const i = p.lastIndexOf('/'); return docRef(p.slice(0, i), p.slice(i + 1)); },
    runTransaction: async (fn) => {
      // Reads-before-writes, as Firestore enforces.
      let wrote = false;
      const tx = {
        get: async (ref) => {
          if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          return ref._isCol ? snapCol(ref._name) : ref.get();
        },
        update: (ref, patch) => { wrote = true; w.writes.push([ref._name, ref._id, patch]); apply(ref._name, ref._id, patch); },
        set: (ref, data) => { wrote = true; setDoc(ref._name, ref._id, data); },
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
    charges: { retrieve: async (id) => {
      const c = (w.charges || {})[id];
      if (!c) { const e = new Error('No such charge'); e.code = 'resource_missing'; throw e; }
      return c;
    } },
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

const OWNER = 'OWNER_UID_TEST';
async function run(w, ch, evtId, type, eventExtra) {
  if (!SCRIPT) return new Error('no script');
  const evType = type || 'charge.refunded';
  const ctx = vm.createContext({
    event: Object.assign({ id: evtId || 'evt_1', type: evType, data: { object: ch } }, eventExtra || {}),
    NBD_OWNER_UID: OWNER,
    stripe: makeStripe(w),
    db: makeDb(w),
    logger: {
      warn: (n, p) => w.logs.push(['warn', n, p]),
      error: (n, p) => w.logs.push(['error', n, p]),
      info: (n, p) => w.logs.push(['info', n, p]),
    },
    getAuth: () => ({ getUser: async (uid) => {
      w.userLookups = (w.userLookups || []).concat([uid]);
      if (w.failUsers && w.failUsers.includes(uid)) throw new Error('no such user ' + uid);
      return { email: uid === OWNER ? 'owner@example.com' : 'contractor@example.com' };
    } }),
    FieldValue: { serverTimestamp: () => SERVER_TS },
    require: (p) => {
      if (/slack$/.test(p)) return { postSlack: async (x) => { w.slack.push(x); return { posted: true }; } };
      if (/connect-refund-logic$/.test(p)) return PLAN;
      throw new Error('unexpected require in extracted branch: ' + p);
    },
    console, Date, Math, JSON, Number, String, Array, Object, Promise, Error,
  });
  SCRIPT.runInContext(ctx);
  const fn = evType === 'charge.refunded' ? ctx.__run : ctx.__runUpdated;
  if (typeof fn !== 'function') return new Error('no branch handles ' + evType);
  try { await fn(); return null; } catch (e) { return e; }
}
const errLogs = (w, name) => w.logs.filter((l) => l[0] === 'error' && (!name || l[1] === name));
const ownerMails = (w) => w.emails.filter((m) => m.to === 'owner@example.com');

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
    const errD = await run(wd, charge());
    ok('R5 this payment never credited the invoice: untouched', JSON.stringify(inv(wd)) === beforeD);
    ok('T4 …and the delivery FAILS (non-200) so Stripe retries once the payment credit lands',
      !!errD && /not_credited_here|credited/i.test(errD.message), errD ? errD.message : 'returned normally (200, never retried)');
    ok('T4 …with no alert sent on the failed try (the retry alerts once)', wd.emails.length === 0);
    // …and when the credit lands, the retry applies it.
    wd.fs.invoices.INV_T.paidIntentIds = ['pi_T'];
    const errD2 = await run(wd, charge(), 'evt_1');
    ok('T4 the retry after the credit applies the refund', !errD2 && inv(wd).balanceDue === 400, errD2 ? errD2.message : JSON.stringify(inv(wd).balanceDue));

    const wf = world();
    wf.fs.invoices.INV_T.companyId = OWNER;
    wf.pis.pi_T.metadata.companyId = OWNER;
    wf.fs.connectAccounts[OWNER] = { accountId: 'acct_ROOFCO' };
    const beforeF = JSON.stringify(inv(wf));
    await run(wf, charge());
    ok('R5 the platform tenant\'s own company is never reopened here (platform_tenant)', JSON.stringify(inv(wf)) === beforeF);

    const wg = world();
    const beforeG = JSON.stringify(inv(wg));
    const errG = await run(wg, charge(), 'evt_acct', 'charge.refunded', { account: 'acct_ROOFCO' });
    ok('T5 an event carrying event.account (a connected account\'s own event) is skipped',
      !errG && JSON.stringify(inv(wg)) === beforeG && wg.emails.length === 0, errG ? errG.message : JSON.stringify(inv(wg)).slice(0, 200));

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
    ok('R6 …and its alert does not falsely say the ledger was NOT changed (the Stripe ledger records it)',
      !/NOT changed/.test(told(wo)) && /Stripe ledger/.test(told(wo)), told(wo).slice(0, 400));
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

  console.log('\nR9 — planner: status changes, failed refunds, nothing-to-do, clamps');
  if (PLAN) {
    // step(): apply one plan to an invoice + its server-only records, like the txn does.
    const step = (st, refunds, opts) => {
      const p = PLAN.planConnectRefund(st.inv, refunds, st.rec, opts);
      if (!p) return { st, p: null };
      return { st: { inv: Object.assign({}, st.inv, p.patch), rec: Object.assign({}, st.rec, p.records) }, p };
    };
    const base = { inv: JSON.parse(JSON.stringify(world().fs.invoices.INV_T)), rec: {} };
    const s1 = step(base, [{ id: 're_1', amount: 40000, status: 'pending', created: T0 }]);
    ok('R9 a pending refund already reopens (Stripe has taken it back from the balance)',
      s1.p && s1.p.patch.amountPaid === 600 && s1.p.patch.balanceDue === 400 && s1.p.patch.refundReopenedTotal === 400);
    const s2 = step(s1.st, [{ id: 're_1', amount: 40000, status: 'succeeded', created: T0 }]);
    ok('R9 pending → succeeded updates the entry, money unchanged',
      s2.p && s2.p.patch.refunds[0].status === 'succeeded' && !('amountPaid' in s2.p.patch));
    const s3 = step(s2.st, [{ id: 're_1', amount: 40000, status: 'failed', created: T0 }]);
    ok('R9 a refund that FAILED gives the money back: paid in full again',
      s3.p && s3.p.patch.amountPaid === 1000 && s3.p.patch.balanceDue === 0 && s3.p.patch.status === 'paid'
      && s3.p.patch.refundStatus === null && s3.p.patch.refundedTotal === 0 && s3.p.patch.refundReopenedTotal === 0,
      JSON.stringify(s3.p && s3.p.patch));
    ok('R9 the same refunds again → null (nothing to write)',
      step(s3.st, [{ id: 're_1', amount: 40000, status: 'failed', created: T0 }]).p === null);
    ok('R9 a zero / id-less refund is ignored', step(base, [{ id: '', amount: 500 }, { id: 're_z', amount: 0 }]).p === null);
    const odd = { inv: Object.assign({}, base.inv, { total: 1234.56, amountPaid: 1234.56 }), rec: {} };
    const s4 = step(odd, [{ id: 're_c', amount: 33, status: 'succeeded', created: T0 }]);
    ok('R9 cents stay exact (1234.56 − 0.33)', s4.p && s4.p.patch.amountPaid === 1234.23 && s4.p.patch.balanceDue === 0.33,
      JSON.stringify(s4.p && [s4.p.patch.amountPaid, s4.p.patch.balanceDue]));
    ok('R9 the planner never names status words outside invoiceStatusWord',
      ['paid', 'partial', 'sent'].includes(s1.p.patch.status) && ['paid', 'partial', 'sent'].includes(s3.p.patch.status));

    // Clamp: amountPaid already below the refund (a rep took 300 off by hand).
    const low = { inv: Object.assign({}, base.inv, { amountPaid: 300, balanceDue: 700, status: 'partial' }), rec: {} };
    const c1 = step(low, [{ id: 're_L', amount: 40000, status: 'succeeded', created: T0 }]);
    ok('R9 clamp: a $400 refund on $300 paid moves only $300 (amountPaid 0, balance 1000)',
      c1.p && c1.p.patch.amountPaid === 0 && c1.p.patch.balanceDue === 1000 && c1.p.patch.refundReopenedTotal === 300,
      JSON.stringify(c1.p && c1.p.patch));
    const c2 = step(c1.st, [{ id: 're_L', amount: 40000, status: 'failed', created: T0 }]);
    ok('R9 clamp: that refund failing gives back only the $300 it moved (not $400)',
      c2.p && c2.p.patch.amountPaid === 3 * 100 && c2.p.patch.balanceDue === 700 && c2.p.patch.refundReopenedTotal === 0,
      JSON.stringify(c2.p && c2.p.patch));

    // Missing created → the delivery time, never 1970.
    const nowMs = Date.UTC(2026, 10, 14, 12);
    const d1 = step(base, [{ id: 're_nd', amount: 100, status: 'succeeded' }], { nowMs });
    ok('R9 a refund with no created is dated at delivery, not 1970',
      d1.p && new Date(d1.p.patch.refunds[0].at).getTime() === nowMs, d1.p && String(d1.p.patch.refunds[0].at));

    // refundStatus on a void invoice.
    const voidInv = { inv: Object.assign({}, base.inv, { status: 'void' }), rec: {} };
    const v1 = step(voidInv, [{ id: 're_v', amount: 100000, status: 'succeeded', created: T0 }]);
    ok('R9 a FULL refund on a void invoice reads refunded (not partly_refunded), nothing reopened',
      v1.p && v1.p.patch.refundStatus === 'refunded' && !('amountPaid' in v1.p.patch) && v1.p.patch.refundReopenedTotal === 0,
      JSON.stringify(v1.p && v1.p.patch));
    const v2 = step(voidInv, [{ id: 're_v', amount: 40000, status: 'succeeded', created: T0 }]);
    ok('R9 a partial refund on a void invoice reads partly_refunded', v2.p && v2.p.patch.refundStatus === 'partly_refunded');
  } else {
    ok('R9 planner present', false, 'functions/connect-refund-logic.js missing');
  }

  console.log('\nR10 — Joe, 2026-11-14: EVERY refund reopens what\'s owed, whatever the reason');
  {
    // Decided, not an accident: a cancelled job, a goodwill refund, a duplicate
    // charge or a fraud refund all put the amount back into what's owed. No
    // reason, metadata flag or refund description gates it.
    for (const [label, extra] of [
      ['requested_by_customer (a cancelled job)', { reason: 'requested_by_customer' }],
      ['duplicate', { reason: 'duplicate' }],
      ['fraudulent', { reason: 'fraudulent' }],
      ['no reason at all', { reason: null }],
      ['a goodwill note in metadata', { reason: 'requested_by_customer', metadata: { note: 'goodwill', reopen: 'false' } }],
    ]) {
      const wr = world();
      wr.refunds.ch_T = [Object.assign({ id: 're_r', amount: 40000, status: 'succeeded', created: T0 + 86400, charge: 'ch_T' }, extra)];
      await run(wr, charge());
      ok('R10 ' + label + ': reopened (amountPaid 600, balanceDue 400)',
        inv(wr).amountPaid === 600 && inv(wr).balanceDue === 400, JSON.stringify([inv(wr).amountPaid, inv(wr).balanceDue]));
    }
    ok('R10 the planner source never reads a refund\'s reason or metadata',
      !!PLAN && !/\.reason\b|\.metadata\b/.test(fs.readFileSync(path.join(ROOT, 'functions', 'connect-refund-logic.js'), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')));
  }

  console.log('\nT2 — a rep editing refunds[] cannot steer the money (server-only record)');
  {
    // Tamper A: mark the applied refund 'failed' on the invoice, then a new refund lands.
    const wt = world();
    await run(wt, charge());
    ok('T2 setup: first refund applied (balance 400)', inv(wt).balanceDue === 400);
    inv(wt).refunds[0].status = 'failed';
    inv(wt).refundedTotal = 0;
    wt.refunds.ch_T.push({ id: 're_2', amount: 10000, status: 'succeeded', created: T0 + 2 * 86400, charge: 'ch_T' });
    await run(wt, charge({ amount_refunded: 50000 }), 'evt_t2');
    ok('T2 status tamper: the new $100 refund moves only $100 (amountPaid 500, balance 500)',
      inv(wt).amountPaid === 500 && inv(wt).balanceDue === 500, JSON.stringify([inv(wt).amountPaid, inv(wt).balanceDue]));
    ok('T2 …and the tampered entry is put back from Stripe (succeeded)',
      inv(wt).refunds.find((r) => r.stripeRef === 're_1').status === 'succeeded');
    ok('T2 the applied amounts are in invoices/{id}/connectRefunds/{refundId}',
      !!(wt.fs['invoices/INV_T/connectRefunds'] || {}).re_1 && wt.fs['invoices/INV_T/connectRefunds'].re_1.movedCents === 40000);

    // Tamper B: inflate the recorded amount, then a new refund lands.
    const wb = world();
    await run(wb, charge());
    inv(wb).refunds[0].amount = 1400;
    wb.refunds.ch_T.push({ id: 're_2', amount: 10000, status: 'succeeded', created: T0 + 2 * 86400, charge: 'ch_T' });
    await run(wb, charge({ amount_refunded: 50000 }), 'evt_t2b');
    ok('T2 amount tamper: amountPaid is 500 (not 1599) and the status is partial (not paid)',
      inv(wb).amountPaid === 500 && inv(wb).status === 'partial', JSON.stringify([inv(wb).amountPaid, inv(wb).status]));
    ok('T2 …and the entry amount is put back to 400', inv(wb).refunds.find((r) => r.stripeRef === 're_1').amount === 400);

    // The server-only path is not matched by any rule: the default deny covers it.
    const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    ok('T2 firestore.rules: no match names connectRefunds (client reads/writes fall to the default deny)',
      !/connectRefunds/.test(RULES) && /match \/\{document=\*\*\} \{\s*allow read, write: if false;/.test(RULES));
    ok('T2 firestore.rules: no recursive invoices/{id}/{sub=**} match opens subcollections',
      !/match \/invoices\/\{[^}]+\}\/\{[^}]+=\*\*\}/.test(RULES));
  }

  console.log('\nT3 — charge.refund.updated: a pending refund that FAILS gives the money back');
  {
    const w3 = world();
    w3.refunds.ch_T = [{ id: 're_1', amount: 40000, status: 'pending', created: T0 + 86400, charge: 'ch_T' }];
    w3.charges = { ch_T: charge() };
    await run(w3, charge());
    ok('T3 setup: pending refund reopened $400', inv(w3).balanceDue === 400);
    const failedRefund = { id: 're_1', object: 'refund', amount: 40000, status: 'failed', created: T0 + 86400, charge: 'ch_T', payment_intent: 'pi_T' };
    w3.refunds.ch_T = [failedRefund];
    const e3 = await run(w3, failedRefund, 'evt_ru', 'charge.refund.updated');
    ok('T3 the branch runs', !e3, e3 && e3.message);
    ok('T3 amountPaid back to 1000, balanceDue 0, status paid', inv(w3).amountPaid === 1000 && inv(w3).balanceDue === 0
      && inv(w3).status === 'paid', JSON.stringify([inv(w3).amountPaid, inv(w3).balanceDue, inv(w3).status]));
    ok('T3 revenue is back to 1000', lifetime(inv(w3)) === 1000, String(lifetime(inv(w3))));
    ok('T3 the contractor is told the refund failed and the money is back', /failed/i.test(told(w3)), told(w3).slice(0, 300));
    const before = JSON.stringify(inv(w3));
    await run(w3, failedRefund, 'evt_ru2', 'charge.refund.updated');
    ok('T3 a retry is a no-op', JSON.stringify(inv(w3)) === before);
    const wp = world(); wp.charges = { ch_T: charge({ destination: null, transfer_data: null, on_behalf_of: null }) };
    const beforeP = JSON.stringify(inv(wp));
    await run(wp, failedRefund, 'evt_ru3', 'charge.refund.updated');
    ok('T3 a platform (non-Connect) refund update is left to the Stripe ledger', JSON.stringify(inv(wp)) === beforeP);
  }

  console.log('\nT7 — a skipped refund reaches the platform owner, loudly');
  {
    const w7b = world();
    w7b.fs.connectAccounts.C_ROOFCO.accountId = 'acct_SOMEONE_ELSE';
    w7b.failUsers = ['u_roofco'];
    await run(w7b, charge());
    ok('T7 account_mismatch: the platform owner gets an email (ownerUid passed)', ownerMails(w7b).length === 1,
      'owner emails: ' + ownerMails(w7b).length);
    ok('T7 …and the failed contractor alert is logged as an ERROR, not a warn',
      errLogs(w7b, 'payment_event_alert_failed').length === 1, JSON.stringify(w7b.logs.map((l) => l[0] + ':' + l[1])));
    const ok7 = world();
    await run(ok7, charge());
    ok('T7 control: an applied refund does not page the owner', ownerMails(ok7).length === 0);
  }

  console.log('\nT6 — every revenue reader nets a Connect refund once (worked examples)');
  {
    const D = (s) => new Date(s);
    // A: total 1000; $300 cash never put on payments[]; $700 card on it; $200 refunded.
    const A = { total: 1000, status: 'partial', amountPaid: 800, balanceDue: 200, refundReopenedTotal: 200,
      payments: [{ amount: 700, at: D('2026-11-02T16:00:00Z') }], lastPaymentAt: D('2026-11-02T16:00:00Z'),
      refunds: [{ amount: 200, at: D('2026-11-05T16:00:00Z'), status: 'succeeded', kind: 'refund' }] };
    // B: full ledger: $1000 card, $400 refunded.
    const B = { total: 1000, status: 'partial', amountPaid: 600, balanceDue: 400, refundReopenedTotal: 400,
      payments: [{ amount: 1000, at: D('2026-11-01T16:00:00Z') }],
      refunds: [{ amount: 400, at: D('2026-11-05T16:00:00Z'), status: 'succeeded', kind: 'refund' }] };
    // C (security T6): payments[] only the $1000 card; $500 cash unrecorded; total 1500; $1000 refunded.
    const C = { total: 1500, status: 'partial', amountPaid: 500, balanceDue: 1000, refundReopenedTotal: 1000,
      payments: [{ amount: 1000, at: D('2026-11-01T16:00:00Z') }],
      refunds: [{ amount: 1000, at: D('2026-11-05T16:00:00Z'), status: 'succeeded', kind: 'refund' }] };
    // L: no payments[] at all (lump), $1000 paid, $250 refunded.
    const L = { total: 1000, status: 'partial', amountPaid: 750, balanceDue: 250, refundReopenedTotal: 250,
      lastPaymentAt: D('2026-11-01T16:00:00Z'),
      refunds: [{ amount: 250, at: D('2026-11-05T16:00:00Z'), status: 'succeeded', kind: 'refund' }] };
    // O: owner-ledger shape (refund NOT reopened, no refundReopenedTotal) — unchanged behaviour.
    const O = { total: 1000, status: 'paid', amountPaid: 1000, balanceDue: 0, refundedTotal: 250,
      payments: [{ amount: 1000, at: D('2026-11-01T16:00:00Z') }],
      refunds: [{ amount: 250, at: D('2026-11-05T16:00:00Z'), status: 'succeeded', kind: 'refund' }] };
    const WANT = { A: 800, B: 600, C: 500, L: 750, O: 750 };
    const FIX = { A, B, C, L, O };

    const lift = (src, name) => {
      const a = src.search(new RegExp('function ' + name + '\\('));
      if (a < 0) return '';
      let depth = 0, i = src.indexOf('{', a);
      for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
      return src.slice(a, i + 1);
    };
    const sumOf = (list) => Math.round(list.reduce((t, p) => t + Math.round(Number(p.amount) * 100), 0)) / 100;
    const readers = {};
    readers['collected-revenue.js'] = (i) => R.paymentsOf(i);
    for (const [f, names] of [
      ['docs/pro/js/money-dashboard.js', ['toJSDate', 'collectedCentsOf', 'paymentsOnlyOf', 'refundsOf', 'paymentsOf']],
      ['docs/pro/js/analytics-kpi.js', ['toJSDate', 'collectedDollarsOf', 'paymentsOnlyOf', 'refundsOf', 'paymentsOf']],
      ['docs/pro/js/pages/leaderboard.js', ['toDate', 'paymentsOnlyOf', 'refundsOf', 'paymentsOf']],
      ['functions/weekly-digest.js', ['timestampMillis', '_paymentsOnlyOf', '_refundsOf', '_paymentsOf']],
    ]) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const body = names.map((n) => lift(src, n)).join('\n');
      const c = { Date, Math, parseFloat, isNaN, Array, Number, Object, JSON };
      vm.createContext(c);
      try {
        vm.runInContext(body + '\nglobalThis.__p = ' + names[names.length - 1] + ';', c);
        readers[f] = c.__p;
      } catch (e) { readers[f] = () => { throw e; }; }
    }
    const AM = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
    readers['functions/agent-mcp-logic.js'] = (i) => AM.paymentsOf(i);
    for (const [rname, fn] of Object.entries(readers)) {
      for (const [k, i] of Object.entries(FIX)) {
        let got;
        try { got = sumOf(fn(JSON.parse(JSON.stringify(i), (kk, v) => (kk === 'at' || kk === 'lastPaymentAt') ? new Date(v) : v))); }
        catch (e) { got = 'threw ' + e.message; }
        ok('T6 ' + rname + ' ' + k + ' collects ' + WANT[k], got === WANT[k], 'got ' + got);
      }
    }
  }

  console.log('\nT8 — the homeowner portal does not read a refunded job as paid');
  {
    const PA = require(path.join(ROOT, 'functions', 'portal-after-signing.js'));
    const full = { status: 'sent', total: 1000, amountPaid: 0, balanceDue: 1000, refundReopenedTotal: 1000, refundedTotal: 1000,
      payments: [{ amount: 1000, at: '2026-11-01T16:00:00Z', method: 'stripe' }],
      refunds: [{ amount: 1000, at: '2026-11-05T16:00:00Z', status: 'succeeded', kind: 'refund' }] };
    ok('T8 anyPaid is false after a full Connect refund', PA.anyPaid([full]) === false);
    const part = Object.assign({}, full, { status: 'partial', amountPaid: 600, balanceDue: 400, refundReopenedTotal: 400, refundedTotal: 400 });
    ok('T8 anyPaid stays true after a partial refund', PA.anyPaid([part]) === true);
    const ownerFull = { status: 'paid', total: 1000, amountPaid: 1000, balanceDue: 0, refundedTotal: 1000,
      payments: [{ amount: 1000, at: '2026-11-01T16:00:00Z' }], refunds: [{ amount: 1000, at: '2026-11-05T16:00:00Z', status: 'succeeded' }] };
    ok('T8 an owner-ledger full refund (not reopened) is not "paid" either', PA.anyPaid([ownerFull]) === false);
    ok('T8 control: a plain paid invoice is paid', PA.anyPaid([{ status: 'partial', total: 1000, amountPaid: 300, payments: [{ amount: 300 }] }]) === true);
    ok('T8 control: payments[] only (legacy, no amountPaid) still counts', PA.anyPaid([{ status: 'partial', total: 1000, payments: [{ amount: 300 }] }]) === true);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
