/**
 * payment-reversal-2026-11-14.test.js: a mistyped or bounced payment can be
 * reversed by the owner, and the reversal comes off every money figure.
 *
 * Wave-1 money-path review (2026-11-14, finding 1): no remove, edit or void
 * existed for a recorded payment. $40,000 typed for a $4,000 check marked the
 * invoice paid and inflated Collected by $36,000, permanently. The fix is an
 * owner-only "Reverse" that APPENDS a negative entry for the whole payment
 * (never a delete):
 *
 *   1. the reversePayment callable (functions/payment-reversal.js): planReversal,
 *      who may call it (owner side of the invoice's own company only), and the
 *      UI's reversalBlockedReason copy agreeing with the server's
 *   2. Collected nets it back out on the payment's own date: NBDRevenue
 *      (collected-revenue.js), the agent / owner-digest ledger
 *      (functions/agent-mcp-logic.js), and the same edit in the mirrored
 *      readers (money-dashboard.js, analytics-kpi.js, pages/leaderboard.js,
 *      functions/weekly-digest.js)
 *   3. Lists hide the reversed payment: payment history marks it reversed and
 *      offers no receipt; the homeowner portal neither shows nor counts it;
 *      the review ask, the Stripe duplicate check, the payment backfill index
 *      and catch-up's "already collected" ignore it
 *   4. Wiring: the client calls the callable (no client ledger write; the
 *      rules still refuse any negative entry from a browser, pinned by
 *      tests/firestore-rules.test.js), the button is owner-side only, the
 *      callable is exported and catalogued
 *
 * Run: node tests/payment-reversal-2026-11-14.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function req(p) {
  try { return require(path.join(ROOT, p)); }
  catch (e) { ok('loads ' + p, false, e && e.message); return null; }
}
function throwsMsg(fn) { try { fn(); return ''; } catch (e) { return (e && e.message) || 'threw'; } }

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 16));
// The $40,000 typo for a $4,000 check, on a $4,000 invoice.
const typo = { id: 'p_typo', paymentId: 'p_typo', amount: 40000, at: D(2026, 10, 2), method: 'check', recordedBy: 'u1', recordedAt: D(2026, 10, 2) };
const typoInv = () => ({ total: 4000, amountPaid: 40000, balanceDue: 0, status: 'paid', paidAt: D(2026, 10, 2), lastPaymentAt: D(2026, 10, 2), depositAmount: 2000, payments: [Object.assign({}, typo)] });

const IP = req('docs/pro/js/invoice-pipeline.js');

const PR = req('functions/payment-reversal.js');

console.log('\n1. reversePayment (functions/payment-reversal.js)');
if (PR) ok('planReversal is exported', typeof PR.planReversal === 'function');
if (IP) {
  ok('reversalBlockedReason is exported', typeof IP.reversalBlockedReason === 'function');
  ok('reversedPaymentIds is exported', typeof IP.reversedPaymentIds === 'function');
}
if (IP && PR && typeof PR.planReversal === 'function' && typeof IP.reversalBlockedReason === 'function') {
  const now = D(2026, 11, 14);
  const r = PR.planReversal(typoInv(), 0, { reason: 'Typed $40,000 for a $4,000 check', by: 'owner1', now });
  const e = r.entry;
  ok('appends ONE entry, keeps the original untouched', r.patch.payments.length === 2 && r.patch.payments[0].amount === 40000);
  ok('the entry is negative, for the whole payment', e.amount === -40000);
  ok('it names the payment it reverses (id and index)', e.reversal === true && e.reverses === 'p_typo' && e.reversesIndex === 0);
  ok('dated the day the original said the money came in', e.at.getTime() === typo.at.getTime());
  ok('same method; who and when it was recorded', e.method === 'check' && e.recordedBy === 'owner1' && e.recordedAt === now);
  ok('carries the reason', e.reason === 'Typed $40,000 for a $4,000 check');
  ok('its own id', /^rev_p_typo$/.test(e.paymentId));
  ok('amountPaid falls by the whole amount', r.patch.amountPaid === 0, String(r.patch.amountPaid));
  ok('the full $4,000 is owed again', r.patch.balanceDue === 4000);
  ok('no longer paid, paidAt cleared, deposit not paid', r.patch.status === 'sent' && r.patch.paidAt === null && r.patch.depositPaid === false);
  ok('lastPaymentAt is not touched', !('lastPaymentAt' in r.patch));

  // A real $4,000 plus the typo: reversing the typo leaves a paid invoice.
  const two = typoInv();
  two.payments = [{ paymentId: 'p_ok', amount: 4000, at: D(2026, 10, 1), method: 'zelle' }, Object.assign({}, typo)];
  two.amountPaid = 44000;
  const r2 = PR.planReversal(two, 1, { reason: 'duplicate', by: 'o' });
  ok('the rest still covers the total: stays paid with its paidAt', r2.patch.status === 'paid' && r2.patch.amountPaid === 4000 && r2.patch.balanceDue === 0 && r2.patch.paidAt != null);
  const part = { total: 10000, amountPaid: 6000, balanceDue: 4000, status: 'partial', payments: [{ paymentId: 'a', amount: 2000, at: D(2026, 9, 1), method: 'cash' }, { paymentId: 'b', amount: 4000, at: D(2026, 9, 9), method: 'check' }] };
  const r3 = PR.planReversal(part, 1, { reason: 'check bounced', by: 'o' });
  ok('a bounced $4,000 check on a part-paid invoice: partial, $8,000 owed', r3.patch.status === 'partial' && r3.patch.amountPaid === 2000 && r3.patch.balanceDue === 8000);
  // a Firestore Timestamp date is passed through as-is
  const ts = { toDate: () => D(2026, 10, 2), seconds: 1 };
  const tsInv = typoInv(); tsInv.payments[0].at = ts;
  ok('a Timestamp date is passed through unchanged', PR.planReversal(tsInv, 0, { reason: 'x', by: 'o' }).entry.at === ts);

  ok('no reason: refused', /why/i.test(throwsMsg(() => PR.planReversal(typoInv(), 0, { reason: '  ', by: 'o' }))));
  const done = r.patch;
  ok('reversed twice: refused', /already reversed/.test(throwsMsg(() => PR.planReversal(Object.assign(typoInv(), { payments: done.payments, amountPaid: 0 }), 0, { reason: 'x', by: 'o' }))));
  ok('the reversal entry itself cannot be reversed', /not a payment/.test(throwsMsg(() => PR.planReversal(Object.assign(typoInv(), { payments: done.payments }), 1, { reason: 'x', by: 'o' }))));
  const stripeInv = typoInv(); stripeInv.payments = [{ amount: 4000, at: D(2026, 10, 2), method: 'stripe', paymentIntentId: 'pi_1' }];
  ok('a Stripe payment is refunded in Stripe, not reversed', /Stripe/.test(IP.reversalBlockedReason(stripeInv, 0)));
  const ledgerInv = typoInv(); ledgerInv.payments = [{ paymentId: 'x1', amount: 4000, at: D(2026, 10, 2), method: 'card', stripeRef: 'ch_1' }];
  ok('a Stripe-ledger card entry is not reversible either', /Stripe/.test(IP.reversalBlockedReason(ledgerInv, 0)));
  const legacy = typoInv(); delete legacy.payments[0].paymentId; delete legacy.payments[0].id;
  ok('an old entry with no id cannot be reversed (nothing to name)', /no id/.test(IP.reversalBlockedReason(legacy, 0)));
  ok('a void invoice: refused', /voided/.test(IP.reversalBlockedReason(Object.assign(typoInv(), { status: 'void' }), 0)));
  ok('a sending invoice: refused', /being sent/.test(IP.reversalBlockedReason(Object.assign(typoInv(), { status: 'sending' }), 0)));
  ok('no such entry: refused', IP.reversalBlockedReason(typoInv(), 3) !== '');
  ok('a plain manual payment: allowed', IP.reversalBlockedReason(typoInv(), 0) === '');
  // The UI decides whether to draw the button with its own copy of the reasons: it must agree with the server.
  const fixtures = [[typoInv(), 0], [stripeInv, 0], [ledgerInv, 0], [legacy, 0], [Object.assign(typoInv(), { status: 'void' }), 0],
    [Object.assign(typoInv(), { status: 'sending' }), 0], [typoInv(), 3], [Object.assign(typoInv(), { payments: done.payments }), 0], [Object.assign(typoInv(), { payments: done.payments }), 1]];
  ok('the UI and the server give the same answer on every case',
    fixtures.every(([inv, i]) => IP.reversalBlockedReason(inv, i) === PR.reversalBlockedReason(inv, i)),
    JSON.stringify(fixtures.map(([inv, i]) => [IP.reversalBlockedReason(inv, i), PR.reversalBlockedReason(inv, i)]).filter((x) => x[0] !== x[1])));

  console.log('\n3a. Payment history and receipts');
  const after = Object.assign(typoInv(), r.patch);
  const rows = IP.paymentHistoryRows(after);
  ok('one row: the reversal entry is not a row of its own', rows.length === 1, JSON.stringify(rows.map((x) => x.amount)));
  ok('the row is marked reversed with the reason', rows[0] && rows[0].reversed === true && /Typed/.test(rows[0].reversalReason));
  ok('a reversed row cannot be reversed again or take a proof', rows[0] && rows[0].canReverse === false && rows[0].canAttach === false);
  ok('a normal row can be reversed', IP.paymentHistoryRows(typoInv())[0].canReverse === true);
  ok('no receipt for a reversed payment', IP.receiptDetailsOf(after, 'p_typo') === null);
  if (typeof global.window === 'undefined') global.window = {};   // the html helper reads page flags; none set = defaults
  const html = IP.paymentHistoryHtml('inv1', after);
  ok('history html says Reversed and strikes the amount', /data-ip-reversed/.test(html) && /<s>\$40,000\.00<\/s>/.test(html));
  ok('history html offers no Send receipt on it', !/data-ip-action="sendReceipt"/.test(html));
}

console.log('\n2. Collected nets the reversal back out');
{
  const win = {};
  vm.runInNewContext(read('docs/pro/js/collected-revenue.js'), { window: win, console, Date, Math, JSON, parseFloat, isNaN, Array, Object });
  const R = win.NBDRevenue;
  const reversed = { total: 4000, amountPaid: 0, balanceDue: 4000, status: 'sent', payments: [
    Object.assign({}, typo),
    { paymentId: 'rev_p_typo', amount: -40000, at: typo.at, method: 'check', reversal: true, reverses: 'p_typo', reason: 'typo' },
  ] };
  const oct = [D(2026, 10, 1).getTime(), D(2026, 10, 31).getTime()];
  const before = R.collectedBetween([typoInv()], oct[0], oct[1]);
  ok('(before: the typo counted $40,000)', before.total === 40000);
  const s = R.collectedBetween([reversed], oct[0], oct[1]);
  ok('October nets to $0 after the reversal', s.total === 0, JSON.stringify(s));
  ok('the reversal is not counted as a payment', s.count === 1, JSON.stringify(s));
  const fixed = JSON.parse(JSON.stringify(reversed));
  fixed.payments = reversed.payments.concat([{ paymentId: 'p_right', amount: 4000, at: D(2026, 10, 2), method: 'check' }]);
  fixed.amountPaid = 4000; fixed.balanceDue = 0; fixed.status = 'paid';
  fixed.payments.forEach((p, i) => { p.at = reversed.payments[i] ? reversed.payments[i].at : D(2026, 10, 2); });
  ok('typo reversed, right amount recorded: October shows $4,000', R.collectedBetween([fixed], oct[0], oct[1]).total === 4000);
  ok('collectedByLead nets it too', (R.collectedByLead([Object.assign({ leadId: 'L' }, reversed)], null, null).L || 0) === 0);

  const A = req('functions/agent-mcp-logic.js');
  if (A) {
    const sum = A.paymentsOf(reversed).reduce((t, p) => t + Math.round(p.amount * 100), 0);
    ok('the agent / owner-digest ledger nets to $0 too', sum === 0, String(sum));
  }
  // The mirrored readers carry the same edit (money-field-contract keeps them in step).
  ['docs/pro/js/money-dashboard.js', 'docs/pro/js/analytics-kpi.js', 'docs/pro/js/pages/leaderboard.js', 'functions/weekly-digest.js'].forEach((f) => {
    const src = read(f);
    ok(f + ': the ledger loop keeps negative (reversal) entries', /if \(!amt \|\| at == null\) (continue|return);/.test(src) && !/if \(!\(amt > 0\) \|\| at == null\) (continue|return);/.test(src));
  });
}

console.log('\n3b. Everywhere else a reversed payment never arrived');
{
  const inv = { id: 'i1', leadId: 'L1', status: 'sent', total: 4000, amountPaid: 0, balanceDue: 4000, invoiceNumber: 'NBD-1', payments: [
    Object.assign({}, typo),
    { paymentId: 'rev_p_typo', amount: -40000, at: typo.at, method: 'check', reversal: true, reverses: 'p_typo', reason: 'typo' },
  ] };
  const PAS = req('functions/portal-after-signing.js');
  if (PAS) {
    ok('homeowner portal: nothing shown as paid', PAS.paidSummaryFor([inv]) === null, JSON.stringify(PAS.paidSummaryFor([inv])));
    ok('homeowner portal: "Deposit paid" is not claimed', PAS.anyPaid([inv]) === false);
    const plus = JSON.parse(JSON.stringify(inv)); plus.payments.push({ paymentId: 'p_right', amount: 4000, at: '2026-10-02', method: 'check' });
    const sm = PAS.paidSummaryFor([plus]);
    ok('homeowner portal: only the real $4,000 is listed', sm && sm.payments.length === 1 && sm.totalPaidCents === 400000, JSON.stringify(sm));
  }
  const RA = req('functions/review-ask-auto-logic.js');
  if (RA) ok('review ask: a reversed payment is not "money received"', RA.receivedMs([inv]) === 0, String(RA.receivedMs([inv])));
  const SL = req('functions/stripe-ledger-logic.js');
  if (SL) {
    const mv = { amountCents: 4000000, atMs: D(2026, 10, 3).getTime() };
    ok('Stripe ledger: a reversed manual payment is not a "duplicate" of a real charge', SL.findManualDuplicate([inv], mv) === null);
  }
  const PB = req('docs/pro/js/payment-backfill-logic.js');
  if (PB) ok('payment backfill: a reversed payment is not "already in the CRM"', PB.paymentsIndex([inv], []).length === 0);
  const CU = req('docs/pro/js/catchup-logic.js');
  if (CU) ok('catch-up: already collected nets to $0', CU.collectedCentsOf([inv]) === 0, String(CU.collectedCentsOf([inv])));
  const cust = read('docs/pro/js/customer-tasks-ui.js');
  ok('customer page: no Send receipt for a reversed payment', /reversedIds\.has\(String\(p\.paymentId\)\)\) return;/.test(cust));
}

console.log('\n4. The callable: who may reverse, and the write it makes');
async function callableChecks() {
  if (!PR || typeof PR.handleReversePayment !== 'function') { ok('handleReversePayment is exported', false); return; }
  // A one-document fake Firestore with a transaction.
  function fakeDb(seed) {
    const docs = new Map(Object.entries(seed));
    const writes = [];
    const ref = (id) => ({ id, path: 'invoices/' + id });
    return {
      docs, writes,
      collection: (name) => ({ doc: (id) => ref(id) }),
      runTransaction: async (fn) => fn({
        get: async (r) => ({ exists: docs.has(r.id), data: () => JSON.parse(JSON.stringify(docs.get(r.id)), (k, v) => (k === 'at' || k === 'paidAt' || k === 'recordedAt') && typeof v === 'string' ? new Date(v) : v) }),
        update: (r, patch) => { writes.push([r.id, patch]); docs.set(r.id, Object.assign({}, docs.get(r.id), patch)); },
      }),
    };
  }
  const base = () => Object.assign(typoInv(), { companyId: 'co-a', createdBy: 'rep1' });
  const call = async (auth, data, db) => {
    try { return { out: await PR.handleReversePayment({ auth, data }, { db, now: D(2026, 11, 14) }) }; }
    catch (e) { return { err: e }; }
  };
  const good = { invoiceId: 'inv1', paymentId: 'p_typo', reason: 'Typed $40,000 for a $4,000 check' };
  const owner = { uid: 'carol', token: { role: 'company_admin', companyId: 'co-a' } };

  let db = fakeDb({ inv1: base() });
  let r = await call(owner, good, db);
  ok('the company_admin reverses it', r.out && r.out.ok === true && r.out.amountPaid === 0 && r.out.balanceDue === 4000 && r.out.status === 'sent', r.err && r.err.message);
  const w = db.writes[0] && db.writes[0][1];
  ok('...one write, appending one negative entry for the whole amount', db.writes.length === 1 && w.payments.length === 2 && w.payments[1].amount === -40000 && w.payments[1].reversal === true);
  ok('...the original payment is untouched', w && w.payments[0].amount === 40000 && w.payments[0].paymentId === 'p_typo');
  ok('...recorded by the caller, with the reason', w && w.payments[1].recordedBy === 'carol' && /Typed/.test(w.payments[1].reason));
  r = await call(owner, good, db);
  ok('a second reversal of the same payment is refused', r.err && /changed|already/.test(r.err.message) && db.writes.length === 1, r.err && r.err.message);

  const solo = { uid: 'solo1', token: {} };
  db = fakeDb({ inv1: Object.assign(base(), { companyId: 'solo1', createdBy: 'solo1' }) });
  r = await call(solo, good, db);
  ok('a solo owner reverses their own', r.out && r.out.ok === true, r.err && r.err.message);

  const refusals = [
    ['signed out', null],
    ['the rep who typed it', { uid: 'rep1', token: { role: 'sales_rep', companyId: 'co-a' } }],
    ['a manager', { uid: 'm1', token: { role: 'manager', companyId: 'co-a' } }],
    ['a viewer', { uid: 'v1', token: { role: 'viewer', companyId: 'co-a' } }],
    ['another company\'s owner', { uid: 'bob', token: { role: 'company_admin', companyId: 'co-b' } }],
    ['a solo owner of another company', { uid: 'solo2', token: {} }],
    ['a claimless user whose company claim is someone else\'s', { uid: 'x', token: { companyId: 'co-a' } }],
  ];
  for (const [label, auth] of refusals) {
    db = fakeDb({ inv1: base() });
    r = await call(auth, good, db);
    ok('refused: ' + label + ' (nothing written)', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  }
  for (const [label, data] of [
    ['no reason', Object.assign({}, good, { reason: '   ' })],
    ['a bad invoice id', Object.assign({}, good, { invoiceId: '../x' })],
    ['no payment id', Object.assign({}, good, { paymentId: '' })],
    ['an unknown payment id', Object.assign({}, good, { paymentId: 'p_nope' })],
    ['a missing invoice', Object.assign({}, good, { invoiceId: 'nope' })],
  ]) {
    db = fakeDb({ inv1: base() });
    r = await call(owner, data, db);
    ok('refused: ' + label + ' (nothing written)', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  }
  db = fakeDb({ inv1: Object.assign(base(), { payments: [{ paymentId: 'p_typo', amount: 4000, at: D(2026, 10, 2), method: 'stripe', paymentIntentId: 'pi_1' }] }) });
  r = await call(owner, good, db);
  ok('refused: a Stripe payment (refund it in Stripe)', !!r.err && /Stripe/.test(r.err.message) && db.writes.length === 0);
}

console.log('\n5. Wiring');
function wiringChecks() {
  const rules = read('firestore.rules');
  ok('rules unchanged: a browser still cannot append a negative entry (paymentEntryOk needs amount > 0)', /p\.get\('amount', 0\) > 0/.test(rules) && !/reversalEntryOk/.test(rules));
  const idx = read('functions/index.js');
  ok('the callable is exported from functions/index.js', /exports\.reversePayment = require\('\.\/payment-reversal'\)\.reversePayment;/.test(idx));
  ok('...and catalogued in FUNCTIONS_INDEX.md', /\| `reversePayment` \| onCall \|/.test(read('functions/FUNCTIONS_INDEX.md')));
  const fsrc = read('functions/payment-reversal.js');
  ok('...App Check enforced, behind the ghost-account guard', /enforceAppCheck: true/.test(fsrc) && /wrapCallable\(/.test(fsrc));
  const src = read('docs/pro/js/invoice-pipeline.js');
  ok('the client calls the callable and writes no ledger entry itself', /_httpsCallable\(window\._functions, 'reversePayment'\)/.test(src) && !/planPaymentReversal/.test(src));
  ok('the Reverse button is only drawn for the owner side', /\(r\.canReverse && _isOwnerSide\(\)\)/.test(src));
  ok('reversePaymentUI refuses anyone else', /async function reversePaymentUI[\s\S]{0,200}if \(!_isOwnerSide\(\)\)/.test(src));
  ok('the click is dispatched', /case 'reversePayment':/.test(src));
  ok('role-gate hides it from a viewer too', /\[data-ip-action="reversePayment"\]/.test(read('docs/pro/js/role-gate.js')));
}

(async () => {
  await callableChecks();
  wiringChecks();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
