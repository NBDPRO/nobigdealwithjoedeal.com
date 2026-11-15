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
  ok('reversalPairs is exported', typeof IP.reversalPairs === 'function');
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
  ok('its own id, built from frozen fields (index, date, cents)', e.paymentId === 'rev_0_' + typo.at.getTime() + '_4000000', e.paymentId);
  ok('amountPaid falls by the whole amount', r.patch.amountPaid === 0, String(r.patch.amountPaid));
  ok('the full $4,000 is owed again', r.patch.balanceDue === 4000);
  ok('no longer paid, paidAt cleared, deposit not paid', r.patch.status === 'sent' && r.patch.paidAt === null && r.patch.depositPaid === false);
  ok('lastPaymentAt is not touched', !('lastPaymentAt' in r.patch));

  // A real $4,000 plus the typo: reversing the typo leaves a paid invoice.
  const two = typoInv();
  two.payments = [{ paymentId: 'p_ok', amount: 4000, at: D(2026, 10, 1), method: 'zelle', recordedBy: 'u1' }, Object.assign({}, typo)];
  two.amountPaid = 44000;
  const r2 = PR.planReversal(two, 1, { reason: 'duplicate', by: 'o' });
  ok('the rest still covers the total: stays paid with its paidAt', r2.patch.status === 'paid' && r2.patch.amountPaid === 4000 && r2.patch.balanceDue === 0 && r2.patch.paidAt != null);
  const part = { total: 10000, amountPaid: 6000, balanceDue: 4000, status: 'partial', payments: [{ paymentId: 'a', amount: 2000, at: D(2026, 9, 1), method: 'cash', recordedBy: 'u1' }, { paymentId: 'b', amount: 4000, at: D(2026, 9, 9), method: 'check', recordedBy: 'u1' }] };
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
  ok('an old typed-in entry with no paymentId CAN be reversed (it is picked by its frozen fields)', IP.reversalBlockedReason(legacy, 0) === '');
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
  // The mirrored readers: each copy's own ledger function, run on the reversed invoice (behaviour, not file text).
  const K = require(path.join(ROOT, 'tests/lib/src-kit.js'));
  const runCopy = (file, fnName, helpers) => {
    const code = K.read(file);
    const src = helpers.concat([fnName]).map((n) => K.sliceFn(code, n)).join('\n');
    const ctx = K.loadInVm([file], { Date, Math, JSON, parseFloat, Number, Array, Object, isNaN }, { src: { [file]: src }, expose: [fnName] });
    return ctx.__exposed[fnName];
  };
  const netCents = (list) => list.reduce((t, p) => t + Math.round(p.amount * 100), 0);
  for (const [file, fnName, helpers] of [
    ['docs/pro/js/money-dashboard.js', 'paymentsOnlyOf', ['toJSDate', 'collectedCentsOf']],
    ['docs/pro/js/analytics-kpi.js', 'paymentsOnlyOf', ['toJSDate', 'collectedDollarsOf']],
    ['docs/pro/js/pages/leaderboard.js', 'paymentsOnlyOf', ['toDate']],
    ['functions/weekly-digest.js', '_paymentsOnlyOf', ['timestampMillis']],
  ]) {
    let got = 'not run';
    try { got = netCents(runCopy(file, fnName, helpers)(reversed)); } catch (e) { got = e.message; }
    ok(file + ': its ledger nets the reversal to $0', got === 0, String(got));
  }
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
  ok('customer page: no Send receipt for a reversed payment', /if \(reversedIdx\[i\]\) return;/.test(cust));
}

console.log('\n4. The callable: who may reverse, and the write it makes');
async function callableChecks() {
  if (!PR || typeof PR.handleReversePayment !== 'function') { ok('handleReversePayment is exported', false); return; }
  // A one-document fake Firestore with a transaction.
  function fakeDb(seed) {
    const docs = new Map(Object.entries(seed));   // keyed by path: 'invoices/inv1', 'companies/co-a'
    const writes = [];
    const ref = (name, id) => ({ id, path: name + '/' + id });
    return {
      docs, writes,
      collection: (name) => ({ doc: (id) => ref(name, id) }),
      runTransaction: async (fn) => fn({
        get: async (r) => ({ exists: docs.has(r.path), data: () => JSON.parse(JSON.stringify(docs.get(r.path)), (k, v) => (k === 'at' || k === 'paidAt' || k === 'recordedAt') && typeof v === 'string' ? new Date(v) : v) }),
        update: (r, patch) => { writes.push([r.path, patch]); docs.set(r.path, Object.assign({}, docs.get(r.path), patch)); },
        create: (r, v) => { if (docs.has(r.path)) throw new Error('ALREADY_EXISTS'); writes.push([r.path, v]); docs.set(r.path, v); },
      }),
    };
  }
  const base = () => Object.assign(typoInv(), { companyId: 'co-a', createdBy: 'rep1' });
  const seedA = (inv) => ({ 'invoices/inv1': inv || base(), 'companies/co-a': { ownerId: 'carol' }, 'companies/co-b': { ownerId: 'bob' } });
  const call = async (auth, data, db) => {
    try { return { out: await PR.handleReversePayment({ auth, data }, { db, now: D(2026, 11, 14) }) }; }
    catch (e) { return { err: e }; }
  };
  // The row the owner tapped: its index plus its FROZEN fingerprint (amount, date, method, recorder).
  const fp = (p, index) => ({ index, cents: Math.round(p.amount * 100), atMs: new Date(p.at).getTime(), method: p.method, recordedBy: p.recordedBy });
  const good = Object.assign({ invoiceId: 'inv1', reason: 'Typed $40,000 for a $4,000 check' }, fp(typo, 0));
  const owner = { uid: 'carol', token: { role: 'company_admin', companyId: 'co-a' } };

  let db = fakeDb(seedA());
  let r = await call(owner, good, db);
  ok('the company owner (companies/co-a.ownerId) reverses it', r.out && r.out.ok === true && r.out.amountPaid === 0 && r.out.balanceDue === 4000 && r.out.status === 'sent', r.err && r.err.message);
  const wInv = db.writes.find((x) => x[0] === 'invoices/inv1');
  const w = wInv && wInv[1];
  ok('...the invoice write appends one negative entry for the whole amount', !!w && w.payments.length === 2 && w.payments[1].amount === -40000 && w.payments[1].reversal === true);
  ok('...the original payment is untouched', w && w.payments[0].amount === 40000 && w.payments[0].paymentId === 'p_typo');
  ok('...recorded by the caller, with the reason', w && w.payments[1].recordedBy === 'carol' && /Typed/.test(w.payments[1].reason));
  const audit = db.writes.find((x) => /^payment_reversals\//.test(x[0]));
  ok('...and a server-only audit record (who, why, how much) that no browser can edit',
    !!audit && audit[1].byUid === 'carol' && audit[1].cents === 4000000 && /Typed/.test(audit[1].reason) && audit[1].companyId === 'co-a', JSON.stringify(audit && audit[1]));
  const nWrites = db.writes.length;
  r = await call(owner, good, db);
  ok('a second reversal of the same payment is refused', r.err && /changed|already/.test(r.err.message) && db.writes.length === nWrites, r.err && r.err.message);

  // Tampering (security review 2026-11-14): an editor may rewrite every non-money key of an entry.
  // Which payment is reversed is read only from amount / date / method, which the rules freeze.
  const done = JSON.parse(JSON.stringify(db.docs.get('invoices/inv1')));
  const tampered = JSON.parse(JSON.stringify(done));
  tampered.payments[1].reversal = false; tampered.payments[1].reverses = 'something_else'; tampered.payments[0].paymentId = 'p_renamed';
  db = fakeDb(seedA(tampered));
  r = await call(owner, good, db);
  ok('flags / ids rewritten by an editor do not reopen a reversed payment (no double reversal)', !!r.err && /already/.test(r.err.message) && db.writes.length === 0, r.err ? r.err.message : 'ALLOWED');
  const realPlusTypo = Object.assign(base(), { amountPaid: 44000, payments: [
    { paymentId: 'p1', amount: 4000, at: D(2026, 10, 1), method: 'check', recordedBy: 'rep1' }, Object.assign({}, typo)] });
  db = fakeDb(seedA(realPlusTypo));
  r = await call(owner, Object.assign({}, good, fp(typo, 1)), db);
  const afterTwo = JSON.parse(JSON.stringify(db.docs.get('invoices/inv1')));
  afterTwo.payments[2].reverses = 'p1';           // point the reversal at the real payment
  const rowsT = IP.paymentHistoryRows(Object.assign({}, afterTwo, { payments: afterTwo.payments.map((p) => Object.assign({}, p, { at: new Date(p.at) })) }));
  const realRow = rowsT.find((x) => x.index === 0), typoRow = rowsT.find((x) => x.index === 1);
  ok('history: re-pointing the reversal at the real payment changes nothing (amount + date decide)', realRow && !realRow.reversed && typoRow && typoRow.reversed);
  db = fakeDb(seedA(Object.assign(base(), { payments: [{ paymentId: 'x1', amount: 40000, at: D(2026, 10, 2), method: 'card' }] })));
  r = await call(owner, good, db);
  ok('refused: an entry with no recordedBy (Stripe-ledger money whose markers were stripped)', !!r.err && db.writes.length === 0, r.err ? r.err.message : 'ALLOWED');
  db = fakeDb(seedA(Object.assign(base(), { companyId: undefined, createdBy: 'rep1' })));
  r = await call({ uid: 'rep1', token: {} }, good, db);
  ok('refused: an invoice with no companyId, even to its creator (an ex-member)', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  db = fakeDb(Object.assign(seedA(), { 'companies/co-a': { ownerId: 'dan' } }));
  r = await call(owner, good, db);
  ok('refused: a former owner after the company was transferred', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  db = fakeDb(seedA());
  r = await call(owner, Object.assign({}, good, { cents: 400000 }), db);
  ok('refused: the entry no longer carries the amount the owner confirmed', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  db = fakeDb(seedA());
  const missing = await call(owner, Object.assign({}, good, { invoiceId: 'nope' }), db);
  const foreign = await call({ uid: 'bob', token: { role: 'company_admin', companyId: 'co-b' } }, good, db);
  ok('a missing invoice gets the same answer as another company\'s (nothing leaks)', missing.err && foreign.err && missing.err.code === foreign.err.code && missing.err.message === foreign.err.message, (missing.err && missing.err.code) + ' / ' + (foreign.err && foreign.err.code));
  const full = Object.assign(base(), { payments: Array.from({ length: 15 }, (_, k) => ({ paymentId: 'q' + k, amount: 100, at: D(2026, 10, 1), method: 'cash', recordedBy: 'rep1' })) });
  db = fakeDb(seedA(full));
  r = await call(owner, Object.assign({}, good, fp(full.payments[3], 3)), db);
  ok('refused: an invoice with 15 payment lines (a 16th would lock it for the browser)', !!r.err && /too many/.test(r.err.message) && db.writes.length === 0, r.err ? r.err.message : 'ALLOWED');
  // Second security pass: the entry is picked by index + frozen fingerprint, never by paymentId.
  const R1 = { paymentId: 'r1', amount: 5000, at: D(2026, 10, 1), method: 'check', recordedBy: 'alice' };
  const F1 = { paymentId: 'r1', amount: 5000, at: D(2026, 10, 20), method: 'cash', recordedBy: 'alice' };   // a rep renamed the fake to the real one's id
  db = fakeDb(seedA(Object.assign(base(), { total: 10000, amountPaid: 10000, payments: [R1, F1] })));
  r = await call(owner, Object.assign({}, good, fp(F1, 1)), db);
  const wA = (db.writes.find((x) => x[0] === 'invoices/inv1') || [])[1];
  ok('a renamed paymentId cannot steer the reversal onto the real check: the tapped row (Oct 20 cash) is the one reversed',
    r.out && wA && new Date(wA.payments[2].at).getTime() === D(2026, 10, 20).getTime() && wA.payments[2].method === 'cash', r.err ? r.err.message : JSON.stringify(wA && wA.payments[2]));
  const stripped = Object.assign({}, typo, { stripeRef: 'ch_x', source: 'stripe_ledger' }); delete stripped.paymentId;
  db = fakeDb(seedA(Object.assign(base(), { payments: [stripped] })));
  r = await call(owner, good, db);
  ok('an editor adding stripeRef / deleting paymentId cannot block the owner\'s reversal of a typed-in payment', r.out && r.out.ok === true, r.err && r.err.message);
  const twinA = { paymentId: 'a', amount: 5000, at: D(2026, 10, 3), method: 'check', recordedBy: 'alice' };
  const twinB = Object.assign({}, twinA, { paymentId: 'b' });
  db = fakeDb(seedA(Object.assign(base(), { total: 10000, amountPaid: 10000, payments: [twinA, twinB] })));
  r = await call(owner, Object.assign({}, good, fp(twinB, 1)), db);
  ok('two identical payments: reversing the later twin is refused (readers would mark the earlier one)', !!r.err && /identical earlier/.test(r.err.message) && db.writes.length === 0, r.err ? r.err.message : 'ALLOWED');
  r = await call(owner, Object.assign({}, good, fp(twinA, 0)), db);
  ok('...the earlier twin can be reversed', r.out && r.out.ok === true, r.err && r.err.message);
  const cardTypo = Object.assign({}, typo, { method: 'card' });
  db = fakeDb(seedA(Object.assign(base(), { stripeCreditKeys: ['ch_1'], payments: [cardTypo] })));
  r = await call(owner, Object.assign({}, good, fp(cardTypo, 0)), db);
  ok('a typed-in card payment on an invoice with Stripe money matched to it is refused (would lose the charge)', !!r.err && /Stripe money matched/.test(r.err.message) && db.writes.length === 0, r.err ? r.err.message : 'ALLOWED');
  const SL = req('functions/stripe-ledger-logic.js');
  if (SL) {
    const cu = { id: 'cu', leadId: 'L', status: 'paid', total: 10000, amountPaid: 10000, payments: [
      { paymentId: 'cu1', amount: 10000, at: D(2026, 10, 1), method: 'other', basis: 'catchup', recordedBy: 'o' },
      { paymentId: 'rev_cu1', amount: -10000, at: D(2026, 10, 1), method: 'other', reversal: true, recordedBy: 'o' },
      { paymentId: 'q', amount: 10000, at: D(2026, 10, 5), method: 'check', recordedBy: 'o' }] };
    ok('Stripe catch-up: a reversed catch-up entry is not a stand-in to absorb', SL.findCatchUpInvoice([cu], { amountCents: 1000000, atMs: D(2026, 10, 3).getTime() }) === null);
  }

  const solo = { uid: 'solo1', token: {} };
  db = fakeDb({ 'invoices/inv1': Object.assign(base(), { companyId: 'solo1', createdBy: 'solo1' }) });
  r = await call(solo, good, db);
  ok('a solo owner reverses their own', r.out && r.out.ok === true, r.err && r.err.message);

  const refusals = [
    ['signed out', null],
    ['the rep who typed it', { uid: 'rep1', token: { role: 'sales_rep', companyId: 'co-a' } }],
    ['a manager', { uid: 'm1', token: { role: 'manager', companyId: 'co-a' } }],
    ['a company_admin who is not the owner (Joe: owner only)', { uid: 'dan', token: { role: 'company_admin', companyId: 'co-a' } }],
    ['a platform admin (not the company owner)', { uid: 'pat', token: { role: 'admin' } }],
    ['the owner of co-b claiming co-a', { uid: 'bob', token: { role: 'company_admin', companyId: 'co-a' } }],
    ['a viewer', { uid: 'v1', token: { role: 'viewer', companyId: 'co-a' } }],
    ['another company\'s owner', { uid: 'bob', token: { role: 'company_admin', companyId: 'co-b' } }],
    ['a solo owner of another company', { uid: 'solo2', token: {} }],
    ['a claimless user whose company claim is someone else\'s', { uid: 'x', token: { companyId: 'co-a' } }],
  ];
  for (const [label, auth] of refusals) {
    db = fakeDb(seedA());
    r = await call(auth, good, db);
    ok('refused: ' + label + ' (nothing written)', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  }
  for (const [label, data] of [
    ['no reason', Object.assign({}, good, { reason: '   ' })],
    ['a bad invoice id', Object.assign({}, good, { invoiceId: '../x' })],
    ['no index', Object.assign({}, good, { index: undefined })],
    ['an index past the list', Object.assign({}, good, { index: 7 })],
    ['a different date than the row shows', Object.assign({}, good, { atMs: good.atMs + 86400000 })],
    ['a different method than the row shows', Object.assign({}, good, { method: 'cash' })],
    ['a different recorder than the row shows', Object.assign({}, good, { recordedBy: 'someone' })],
    ['no recorder in the request', Object.assign({}, good, { recordedBy: '' })],
    ['a missing invoice', Object.assign({}, good, { invoiceId: 'nope' })],
  ]) {
    db = fakeDb(seedA());
    r = await call(owner, data, db);
    ok('refused: ' + label + ' (nothing written)', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  }
  db = fakeDb(seedA(Object.assign(base(), { payments: [{ paymentId: 'p_typo', amount: 4000, at: D(2026, 10, 2), method: 'stripe', paymentIntentId: 'pi_1' }] })));
  r = await call(owner, Object.assign({}, good, { cents: 400000, method: 'stripe', recordedBy: 'nobody' }), db);
  ok('refused: a Stripe payment (no recorder, method stripe; nothing written)', !!r.err && db.writes.length === 0, r.out ? 'ALLOWED' : '');
  ok('...and the reason the UI shows for it says to refund in Stripe', /Stripe/.test(PR.reversalBlockedReason({ payments: [{ amount: 4000, at: D(2026, 10, 2), method: 'stripe', paymentIntentId: 'pi_1' }] }, 0)));
}

console.log('\n5. Wiring');
// (A browser still cannot append a negative entry: tests/firestore-rules.test.js pins it in the emulator. The callable's
//  export and deploy shape: functions-lazy-load and merge-leftovers-guard.)
async function wiringChecks() {
  ok('the module exports a callable', PR && typeof PR.reversePayment === 'function');
  // an overdue invoice whose only payment is reversed stays overdue (the money set 'paid', not the aging)
  const od = PR.planReversal(Object.assign(typoInv(), { status: 'overdue' }), 0, { reason: 'x', by: 'o' });
  ok('reversing the only payment keeps "overdue"', od.patch.status === 'overdue', od.patch.status);
  ok('a paid invoice whose only payment is reversed reads "sent"', PR.planReversal(typoInv(), 0, { reason: 'x', by: 'o' }).patch.status === 'sent');

  // The page, driven for real: who sees the button, what a non-owner and a blank reason get, and what the server is sent.
  const toasts = []; const calls = [];
  const typoTs = { toDate: () => typo.at, toMillis: () => typo.at.getTime() };
  const invDoc = Object.assign(typoInv(), { payments: [Object.assign({}, typo, { at: typoTs, recordedAt: { toMillis: () => typo.recordedAt.getTime() } })] });
  let answer = 'Typed $40,000 for a $4,000 check';
  global.window = {
    _db: {}, doc: (...a) => ({ path: a.slice(1).join('/') }), collection: () => ({}),
    getDoc: async () => ({ exists: () => true, data: () => invDoc }),
    _user: { uid: 'carol' }, _userClaims: { role: 'company_admin', companyId: 'co-a' },
    showToast: (m, t) => toasts.push([m, t]),
    nbdPrompt: async () => answer, nbdConfirm: async () => true,
    _functions: {}, _httpsCallable: (fns, name) => async (data) => { calls.push([name, data]); return { data: { ok: true, balanceDue: 0 } }; },
  };
  global.document = { getElementById: () => null };
  const htmlFor = (claims) => { window._userClaims = claims; return IP.paymentHistoryHtml('inv1', typoInv()); };
  ok('the owner (company_admin) is offered Reverse', /data-ip-action="reversePayment"/.test(htmlFor({ role: 'company_admin', companyId: 'co-a' })));
  ok('a manager, rep or viewer is not', ['manager', 'sales_rep', 'viewer'].every((role) => !/data-ip-action="reversePayment"/.test(htmlFor({ role, companyId: 'co-a' }))));
  window._userClaims = { role: 'sales_rep', companyId: 'co-a' };
  let res = await IP.reversePaymentUI('inv1', 0, NaN);
  ok('reversePaymentUI refuses a non-owner and calls nothing', res === false && calls.length === 0 && toasts.some((t) => /owner/.test(t[0])));
  window._userClaims = { role: 'company_admin', companyId: 'co-a' };
  answer = '   ';
  res = await IP.reversePaymentUI('inv1', 0, NaN);
  ok('a blank reason says so and calls nothing', res === false && calls.length === 0 && toasts.some((t) => /reason is required/.test(t[0])));
  answer = 'Typed $40,000 for a $4,000 check';
  res = await IP.reversePaymentUI('inv1', 0, NaN);
  const sent = calls[0] && calls[0][1];
  ok('the owner calls reversePayment with the row\'s frozen fingerprint and the reason (no ledger write of its own)',
    res === true && calls.length === 1 && calls[0][0] === 'reversePayment' && sent.index === 0 && sent.cents === 4000000
      && sent.atMs === typo.at.getTime() && sent.method === 'check' && sent.recordedBy === 'u1' && /Typed/.test(sent.reason), JSON.stringify(calls));
  // Two wiring facts only the source shows (the dispatcher is a document-level click delegate; role-gate is a selector list).
  ok('the click is dispatched', /case 'reversePayment':/.test(read('docs/pro/js/invoice-pipeline.js')));
  ok('role-gate hides it from a viewer too', /\[data-ip-action="reversePayment"\]/.test(read('docs/pro/js/role-gate.js')));
  ok('App Check is enforced on the callable', /enforceAppCheck: true/.test(read('functions/payment-reversal.js')));
  ok('...and it is catalogued in FUNCTIONS_INDEX.md', /\| `reversePayment` \| onCall \|/.test(read('functions/FUNCTIONS_INDEX.md')));
}

(async () => {
  await callableChecks();
  await wiringChecks();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
