/**
 * tests/portal-link-supplements-r6-2026-10-07.test.js
 *
 * Review round 6 money fixes (Jo approved 2026-10-07). The repros pinned as
 * KNOWN BUG R6-2-6 / R6-2-9 on draft PR #2293
 * (tests/review-r6-money-texting-2026-10-07.test.js) become regressions here.
 *
 *   A. R6-2-9  "Paid in full?" (catch-up deck) and the Record Payment sheet
 *              use the amount the invoice will actually say: the estimate's
 *              total PLUS approved / partly approved insurance supplements —
 *              invoice-pipeline.js recordPaymentTarget + recordPaymentContext,
 *              the real catchup.js paidInFull in a Firestore-fake sandbox,
 *              and the signed price still wins (customer-estimate-rows.js
 *              signedView, #2299).
 *   B. R6-2-6  after the homeowner pays the deposit online, the portal's
 *              Balance Due "Pay Now" (and the tracker's "Pay your invoice")
 *              is never the spent deposit link — functions/invoice-charge.js
 *              portalBalanceCard, the Kentucky hold still first, and the
 *              portal page says "Your balance link is on its way".
 *
 * Worked dollar examples (the review's own):
 *   R6-2-9  $14,000 insurance estimate + $2,000 approved supplement.
 *           Before: "Paid in full?" recorded $14,000 on a $16,000 invoice →
 *           $2,000 still owed in Collections. After: $16,000, balance $0.
 *   R6-2-6  $12,000 cash job, 50% deposit. The $6,000 deposit link is paid.
 *           Before: "Balance Due $6,000 — Pay Now" opened the SPENT deposit
 *           link. After: no Pay Now until a balance link is minted; the card
 *           says the balance link is on its way.
 *
 * Run: node tests/portal-link-supplements-r6-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F = (rel) => require(path.join(ROOT, 'functions', rel));

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
const KY = '9 Elm St, Covington, KY 41011';

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
    ok('customer-estimate-rows.js has signedView (#2299 merged)', !!(CER_CLIENT && typeof CER_CLIENT.signedView === 'function'));
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

  // ════════════════════════════════════════════════════════════════════
  console.log('\nB. R6-2-6 — the portal never offers the spent deposit link');
  // ════════════════════════════════════════════════════════════════════
  const IC = F('invoice-charge.js');
  const DDL = F('deposit-draft-logic.js');
  const KyLaw = F('ky-insurance-law.js');
  const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed',
    lead: { userId: 'u', primaryEstimateId: 'E', address: OH, state: 'OH', activeJobId: 'J1' },
    est: { userId: 'u', leadId: 'L', grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, mode: 'cash', jobId: 'J1', addr: OH,
      rows: [{ desc: 'Roof', qty: '1', retailTotal: 12000, total: 12000 }] }, estimateId: 'E', existingInvoices: [] });
  const sent = Object.assign({}, dd.invoice, { status: 'sent' });
  const due0 = IC.chargeDueNow(sent);
  // What createStripePaymentLink stamps on a mint (functions/stripe.js _stampCharge).
  const depLink = Object.assign({}, sent, { stripePaymentLink: 'https://buy.stripe.test/deposit', stripeInvoiceId: 'plink_dep',
    stripeChargeCents: due0.chargeCents, stripeChargeKind: due0.kind, stripeChargePaidCents: 0 });
  // invoiceWebhook payment_intent.succeeded: status / amountPaid / balanceDue / depositPaid.
  const afterDep = Object.assign({}, depLink, { status: 'partial', amountPaid: 6000, balanceDue: 6000, depositPaid: true });

  await sec('B1 portalBalanceCard', async () => {
    ok('context: the $12,000 cash job\'s deposit link charged the $6,000 deposit', due0.kind === 'deposit' && due0.chargeCents === 600000);
    const before = IC.portalBalanceCard(depLink, depLink.stripePaymentLink);
    ok('before the deposit: "Deposit Due $6,000" with the deposit link', before.kind === 'deposit' && before.amountCents === 600000
      && before.stripePaymentLink === 'https://buy.stripe.test/deposit' && before.linkPending === false);
    const card = IC.portalBalanceCard(afterDep, afterDep.stripePaymentLink);
    ok('FIXED (was KNOWN BUG R6-2-6): after the $6,000 deposit is paid online, "Balance Due $6,000" offers NO Pay Now (the spent deposit link is never the balance link)',
      card.kind === 'balance' && card.amountCents === 600000 && card.totalOwedCents === 600000 && card.stripePaymentLink === null, JSON.stringify(card));
    ok('…and says a balance link is pending (linkPending)', card.linkPending === true);
    // The same spent deposit, but a Stripe INVOICE (platform tenant): stripeHostedUrl.
    const hosted = Object.assign({}, afterDep, { stripePaymentLink: null, stripeHostedUrl: 'https://invoice.stripe.test/i/dep', stripeInvoiceId: 'in_dep' });
    const hc = IC.portalBalanceCard(hosted, KyLaw.payUrlOf(hosted));
    ok('…the paid deposit Stripe invoice (hosted page) is not offered either', hc.stripePaymentLink === null && hc.linkPending === true, JSON.stringify(hc));
    // The rep then sends the balance: createStripePaymentLink re-mints and stamps.
    const balLink = Object.assign({}, afterDep, { stripePaymentLink: 'https://buy.stripe.test/balance', stripeInvoiceId: 'plink_bal',
      stripeChargeCents: 600000, stripeChargeKind: 'balance', stripeChargePaidCents: 600000 });
    const bc = IC.portalBalanceCard(balLink, balLink.stripePaymentLink);
    ok('once the balance link is minted ($6,000, kind balance), Pay Now is that link', bc.stripePaymentLink === 'https://buy.stripe.test/balance' && bc.linkPending === false);
    // Same kind AND same cents, but spent: the balance link was paid, then an
    // approved supplement added $6,000 to the invoice.
    const supAfter = Object.assign({}, balLink, { total: 18000, amountPaid: 12000, balanceDue: 6000, status: 'partial' });
    const sc = IC.portalBalanceCard(supAfter, supAfter.stripePaymentLink);
    ok('a PAID balance link is not offered again when a later change leaves the same $6,000 owed (money landed since the mint)',
      sc.amountCents === 600000 && sc.stripePaymentLink === null && sc.linkPending === true, JSON.stringify(sc));
    // A link minted before the paid-cents stamp existed (kind + cents only).
    const legacyStamp = Object.assign({}, balLink); delete legacyStamp.stripeChargePaidCents;
    ok('a link stamped before stripeChargePaidCents existed still works when kind + cents match',
      IC.portalBalanceCard(legacyStamp, legacyStamp.stripePaymentLink).stripePaymentLink === 'https://buy.stripe.test/balance');
    const legacyDep = Object.assign({}, afterDep); delete legacyDep.stripeChargePaidCents;
    ok('…and the spent deposit link with that older stamp is still refused (kind deposit ≠ balance)',
      IC.portalBalanceCard(legacyDep, legacyDep.stripePaymentLink).stripePaymentLink === null);
    const plain = { total: 1500, depositAmount: 0, amountPaid: 0, balanceDue: 1500, stripePaymentLink: 'https://buy.stripe.test/p' };
    ok('a plain invoice with a pre-stamp link keeps its Pay Now (unchanged)', IC.portalBalanceCard(plain, plain.stripePaymentLink).stripePaymentLink === 'https://buy.stripe.test/p');
    const noLink = IC.portalBalanceCard(Object.assign({}, afterDep, { stripePaymentLink: null, stripeChargeCents: null, stripeChargeKind: null }), '');
    ok('no link ever sent → no Pay Now and not "on its way" (the page says ask your rep, as before)', noLink.stripePaymentLink === null && noLink.linkPending === false);
  });

  await sec('B2 the Kentucky hold still comes first', async () => {
    const kyLead = { address: KY, state: 'KY', insCarrier: 'State Farm', claimNumber: 'C-1' };
    const kyInv = Object.assign({}, afterDep, { kyInsuranceHold: true, stripeChargeKind: 'balance', stripeChargeCents: 600000, stripeChargePaidCents: 600000 });
    const url = KyLaw.payUrlUnlessHeld(kyLead, kyInv, Date.now(), KyLaw.DEFAULT_TIME_ZONE);
    const card = IC.portalBalanceCard(kyInv, url);
    ok('a Kentucky insurance job before the carrier decision + 5 business days: no pay link, and no "on its way" promise',
      url === '' && card.stripePaymentLink === null && card.linkPending === false, JSON.stringify({ url, card }));
    const released = Object.assign({}, kyLead, { carrierDecisionAt: Date.parse('2026-01-05T15:00:00Z') });
    const rurl = KyLaw.payUrlUnlessHeld(released, kyInv, Date.now(), KyLaw.DEFAULT_TIME_ZONE);
    ok('…once released, a matching balance link is offered', IC.portalBalanceCard(kyInv, rurl).stripePaymentLink === kyInv.stripePaymentLink, rurl);
  });

  await sec('B3 wiring: the server card + tracker, and the portal page copy', async () => {
    const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const srv = strip(rd('functions/portal.js'));
    ok('functions/portal.js spreads portalBalanceCard into view.balance (linkPending reaches the page) and the tracker\'s "Pay your invoice" reads the same card',
      /InvoiceCharge\.portalBalanceCard\(_unpaidInvoice, _payUrl\)/.test(srv) && /\.\.\._dueCard,/.test(srv)
        && /progress\.payLink = _balance\.stripePaymentLink;/.test(srv));
    const pjs = rd('docs/pro/js/portal.js');
    const pick = (re) => { const m = re.exec(pjs); return m ? m[0] : ''; };
    const escSrc = pick(/const esc = \(s\) => [\s\S]*?\.replace\(\/'\/g, '&#39;'\);/);
    const safeSrc = pick(/const safeUrl = \(u\) => \{[\s\S]*?\n  \};/);
    const fnSrc = pick(/function balancePayActionHtml\(b\) \{[\s\S]*?\n  \}/);
    ok('docs/pro/js/portal.js has balancePayActionHtml (lifted and run below)', !!(escSrc && safeSrc && fnSrc));
    if (!(escSrc && safeSrc && fnSrc)) return;
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(escSrc + '\n' + safeSrc + '\n' + fnSrc + '\nthis.f = balancePayActionHtml;', sb);
    const pending = sb.f({ amountCents: 600000, kind: 'balance', stripePaymentLink: null, linkPending: true });
    ok('a pending balance link reads "Your balance link is on its way" — no button', /Your balance link is on its way/.test(pending) && !/<a /.test(pending), pending);
    const live = sb.f({ stripePaymentLink: 'https://buy.stripe.test/balance', linkPending: false });
    ok('a real link is the Pay Now button', /<a class="btn[^"]*" href="https:\/\/buy\.stripe\.test\/balance"/.test(live) && /Pay Now/.test(live), live);
    const none = sb.f({ stripePaymentLink: null, linkPending: false });
    ok('no link sent → "Ask your rep for a payment link" (unchanged)', /Ask your rep for a payment link/.test(none));
    ok('renderView builds the pay line with balancePayActionHtml(view.balance)', /const payAction = balancePayActionHtml\(view\.balance\);/.test(pjs));
    const html = rd('docs/pro/portal.html');
    ok('portal.html loads the new portal.js (cache-buster bumped past v=12)', /src="js\/portal\.js\?v=(\d+)"/.test(html) && Number(/src="js\/portal\.js\?v=(\d+)"/.exec(html)[1]) > 12);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
