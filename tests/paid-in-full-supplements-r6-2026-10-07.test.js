/**
 * tests/paid-in-full-supplements-r6-2026-10-07.test.js
 *
 * Review round 6 money fix (Jo approved 2026-10-07). The repro pinned as
 * KNOWN BUG R6-2-9 on draft PR #2293
 * (tests/review-r6-money-texting-2026-10-07.test.js) becomes a regression
 * here. (R6-2-6, the portal's spent deposit link, waits on #2299 — its tests
 * are parked on the local branch wip/r6-2-6-portal-spent-link.)
 *
 *   A. R6-2-9  "Paid in full?" (catch-up deck) and the Record Payment sheet
 *              use the amount the invoice will actually say: the estimate's
 *              total PLUS approved / partly approved insurance supplements —
 *              invoice-pipeline.js recordPaymentTarget + recordPaymentContext,
 *              the real catchup.js paidInFull in a Firestore-fake sandbox,
 *              and the signed price still wins (customer-estimate-rows.js
 *              signedView, #2299 — runs once that is on main).
 *
 * Worked dollar example (the review's own):
 *   R6-2-9  $14,000 insurance estimate + $2,000 approved supplement.
 *           Before: "Paid in full?" recorded $14,000 on a $16,000 invoice →
 *           $2,000 still owed in Collections. After: $16,000, balance $0.
 *   Signed $14,000, re-saved at $15,000 without a re-sign, + $2,000
 *           supplement → $16,000 (the signed price wins).
 *
 * Run: node tests/paid-in-full-supplements-r6-2026-10-07.test.js
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
async function sec(name, fn) {
  try { await fn(); } catch (e) { ok(String(name) + ' — threw: ' + (e && e.stack || e), false); }
}
function req(rel) {
  try { return require(path.join(ROOT, rel)); }
  catch (e) { ok('loads ' + rel, false, e && e.message); return null; }
}
const c = (dollars) => Math.round(Number(dollars) * 100);

const OH = '1 Main St, Cincinnati, OH 45202';

// ── A browser sandbox: Firestore v9 modular fakes (catchup-2026-10-04 shape) ──
const CL = req('docs/pro/js/catchup-logic.js');
const NL = req('docs/pro/js/numbers-logic.js');
const CER_CLIENT = req('docs/pro/js/customer-estimate-rows.js');
let IP = null, CU = null;
function browser(seed, extra) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const emails = [], writes = [];
  let seq = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const W = {
    _db: { fake: true }, db: { fake: true },
    doc: (db, ...segs) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
    collection: (db, col) => ({ col }),
    where: (f, op, v) => ({ f, op, v }),
    query: (col, ...ws) => ({ col: col.col, ws }),
    getDoc: async (r) => ({ exists: () => store.has(r.path), data: () => (store.has(r.path) ? clone(store.get(r.path)) : undefined) }),
    getDocs: async (q) => {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== 2 || parts[0] !== q.col) continue;
        if ((q.ws || []).every((w) => v[w.f] === w.v)) docs.push({ id: parts[1], data: () => clone(v) });
      }
      return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
    },
    updateDoc: async (r, patch) => { if (!store.has(r.path)) throw new Error('NOT_FOUND ' + r.path); writes.push(['update', r.path]); store.set(r.path, Object.assign({}, store.get(r.path), clone(patch))); },
    addDoc: async (col, data) => { const id = 'new' + (++seq); writes.push(['add', col.col + '/' + id]); store.set(col.col + '/' + id, clone(data)); return { id }; },
    setDoc: async (r, data, opts) => { writes.push(['set', r.path]); store.set(r.path, (opts && opts.merge) ? Object.assign({}, store.get(r.path) || {}, clone(data)) : clone(data)); },
    deleteDoc: async (r) => { writes.push(['delete', r.path]); store.delete(r.path); },
    serverTimestamp: () => '__TS__',
    NBDComms: { sendEmail: async (o) => { emails.push(o); return { success: true }; }, sendSMS: async () => ({ success: true }) },
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    NBDJurisdiction: req('docs/pro/js/ky-insurance-law.js'),
    NBDCustomerEstimateRows: CER_CLIENT,
    _auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok' } },
    _user: { uid: 'u1' },
    _userClaims: {},
    _leads: [],
    _estimates: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
    NBDNumbersData: {
      isOwner: () => true, companyId: () => 'u1', loadExpenses: async () => [],
      loadSpend: async () => ({ months: {} }), saveSpendMonth: async () => true, mergeSpendMonths: async () => true,
    },
  };
  Object.assign(W, extra || {});
  global.window = W;
  global.showToast = () => {};
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  W.NBDNumbers = NL;
  W.NBDCatchUpLogic = CL;
  W.InvoicePipeline = IP;
  return { W, store, emails, writes };
}
browser({});
IP = req('docs/pro/js/invoice-pipeline.js');
CU = req('docs/pro/js/catchup.js');

// The review's insurance job: a $14,000 estimate, an approved $2,000 supplement.
const insEst = (f) => Object.assign({
  userId: 'u1', leadId: 'C2', grandTotal: 14000, subtotal: 14000, tax: 0, taxRate: 0, mode: 'insurance', addr: OH,
  rows: [{ description: 'Roof', qty: 1, unitPrice: 14000, total: 14000 }],
}, f || {});
const sup = (f) => Object.assign({ parentEstimateId: 'estC', userId: 'u1', version: 1, status: 'approved', supplementTotal: 2000, reason: 'Ice & water shield' }, f || {});

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nA. R6-2-9 — "Paid in full?" counts approved supplements');
  // ════════════════════════════════════════════════════════════════════
  await sec('A1 recordPaymentTarget', async () => {
    if (!IP || !CL) return ok('modules loaded', false);
    const est = Object.assign({ id: 'estC' }, insEst());
    const lead = { id: 'C2', jobValue: 14000 };
    const totalsOpts = { estimateValue: CER_CLIENT && CER_CLIENT.estimateValue };
    const t = IP.recordPaymentTarget({ lead, invoices: [], estimate: est, estimateId: 'estC', totalsOpts, supplements: [sup({ id: 's1' })] });
    const plan = CL.paidInFullPlan(t);
    ok('FIXED (was KNOWN BUG R6-2-9): the $14,000 estimate + $2,000 approved supplement → "Paid in full?" records $16,000',
      t.kind === 'estimate' && t.totalCents === 1600000 && plan.ok === true && plan.cents === 1600000, JSON.stringify({ t, plan }));
    // The same number the invoice it makes will carry (createOrOpenJobInvoice).
    const inv = IP.applySupplementsToTotals(IP.invoiceTotalsFromEstimate(est, totalsOpts), [sup({ id: 's1' })]);
    ok('…which is exactly the total of the invoice made from that estimate ($16,000)', c(inv.total) === t.totalCents, JSON.stringify(inv.total));
    ok('…and the target says how much of it is supplements ($2,000)', t.supplementCents === 200000, t.supplementCents);
    const none = IP.recordPaymentTarget({ lead, invoices: [], estimate: est, estimateId: 'estC', totalsOpts });
    ok('no supplements on file → the estimate total, unchanged ($14,000)', none.totalCents === 1400000 && !none.supplementCents);
    const mixed = IP.recordPaymentTarget({ lead, invoices: [], estimate: est, estimateId: 'estC', totalsOpts, supplements: [
      sup({ id: 'p', status: 'partial', supplementTotal: 3000, submission: { approvedAmount: 1250.5 } }),
      sup({ id: 'd', status: 'denied', supplementTotal: 900 }),
      sup({ id: 'x', status: 'submitted', supplementTotal: 700 }),
      sup({ id: 'v', status: 'draft', supplementTotal: 500 }),
      sup({ id: 'b', status: 'approved', supplementTotal: 400, invoicedInvoiceId: 'old' }),
    ] });
    ok('a partial approval counts what the adjuster approved ($1,250.50); denied / submitted / draft / already-invoiced do not',
      mixed.totalCents === 1400000 + 125050, mixed.totalCents);
    const live = IP.recordPaymentTarget({ lead: { id: 'C2' }, invoices: [{ id: 'i1', leadId: 'C2', status: 'sent', total: 16000 }], estimate: est, estimateId: 'estC', totalsOpts, supplements: [sup()] });
    ok('a job with a live invoice still pays that invoice (supplements already on it)', live.kind === 'existing' && live.invoices[0].id === 'i1');
  });

  await sec('A2 the real catch-up "Paid in full? Yes" in a sandbox', async () => {
    if (!IP || !CU) return ok('modules loaded', false);
    const lead = { userId: 'u1', companyId: 'u1', firstName: 'Ins', lastName: 'Job', address: OH, stage: 'closed', stageRole: 'won',
      jobValue: 14000, primaryEstimateId: 'estC', insCarrier: 'State Farm', claimNumber: 'C-77', createdAt: Date.now() - 90 * 86400000 };
    const B = browser({ 'leads/C2': lead, 'estimates/estC': insEst(), 'supplements/s1': sup() });
    B.W._leads = [Object.assign({ id: 'C2' }, lead)];
    CU._setData({ invs: [], expenses: [], spend: { months: {} } }, { doneJobs: {}, log: [] });
    const ctx = await IP.recordPaymentContext('C2');
    ok('the Record Payment sheet / deck reads the supplement: target $16,000', ctx.target.kind === 'estimate' && ctx.target.totalCents === 1600000, JSON.stringify(ctx.target));
    const r = await CU.paidInFull('C2', { method: 'check', payer: 'insurance', ymd: '2026-09-20' });
    const invs = [...B.store.entries()].filter(([k]) => k.startsWith('invoices/'));
    const inv = invs[0] && invs[0][1];
    ok('one invoice made, for $16,000 (estimate + supplement)', invs.length === 1 && inv && c(inv.total) === 1600000, inv && inv.total);
    ok('FIXED: ONE payment of $16,000 — the invoice is paid, $0 owed (was $14,000 paid, $2,000 still owed)',
      inv && inv.payments.length === 1 && c(inv.payments[0].amount) === 1600000 && c(inv.amountPaid) === 1600000
        && c(inv.balanceDue) === 0 && inv.status === 'paid' && r.cents === 1600000,
      inv && JSON.stringify({ paid: inv.amountPaid, bal: inv.balanceDue, status: inv.status, cents: r.cents }));
    ok('no email sent', B.emails.length === 0);
  });

  await sec('A3 the signed price still wins (customer-estimate-rows.js signedView, #2299)', async () => {
    if (!IP || !CU) return ok('modules loaded', false);
    // signedView arrives with #2299 (signed price wins). Until it is on main
    // there is no signed price to honour; the section runs (and must pass)
    // the moment it lands — verified against #2299's head on 2026-10-07.
    if (!(CER_CLIENT && typeof CER_CLIENT.signedView === 'function')) {
      console.log('  - SKIP: customer-estimate-rows.js has no signedView yet (#2299 not merged)');
      return;
    }
    // Signed at $14,000, then re-saved at $15,000 without a re-sign; the
    // adjuster then approved a $2,000 supplement. Owed: $14,000 + $2,000.
    const signedFields = { grandTotal: 14000, subtotal: 14000, tax: 0, taxRate: 0, mode: 'insurance',
      rows: [{ description: 'Roof', qty: 1, unitPrice: 14000, total: 14000 }] };
    const est = insEst({ grandTotal: 15000, subtotal: 15000, rows: [{ description: 'Roof', qty: 1, unitPrice: 15000, total: 15000 }],
      signedPrice: { fields: signedFields, totalCents: 1400000, source: 'esign', sourceId: 'env1' } });
    const lead = { userId: 'u1', companyId: 'u1', firstName: 'Sig', lastName: 'Ned', address: OH, stage: 'closed', stageRole: 'won',
      jobValue: 14000, primaryEstimateId: 'estC', insCarrier: 'State Farm', claimNumber: 'C-78', createdAt: Date.now() - 90 * 86400000 };
    const B = browser({ 'leads/C2': lead, 'estimates/estC': est, 'supplements/s1': sup() });
    B.W._leads = [Object.assign({ id: 'C2' }, lead)];
    CU._setData({ invs: [], expenses: [], spend: { months: {} } }, { doneJobs: {}, log: [] });
    const ctx = await IP.recordPaymentContext('C2');
    ok('"Paid in full?" offers the SIGNED $14,000 + the $2,000 supplement = $16,000 (not the re-saved $15,000 + $2,000)',
      ctx.target.kind === 'estimate' && ctx.target.totalCents === 1600000, JSON.stringify(ctx.target));
    await CU.paidInFull('C2', { method: 'check', payer: 'insurance', ymd: '2026-09-20', expectCents: 1600000 });
    const inv = [...B.store.entries()].filter(([k]) => k.startsWith('invoices/')).map(([, v]) => v)[0];
    ok('…the invoice it makes says $16,000 and is paid in full with one $16,000 payment',
      inv && c(inv.total) === 1600000 && inv.payments.length === 1 && c(inv.payments[0].amount) === 1600000 && c(inv.balanceDue) === 0 && inv.status === 'paid',
      inv && JSON.stringify({ total: inv.total, paid: inv.amountPaid, bal: inv.balanceDue }));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
