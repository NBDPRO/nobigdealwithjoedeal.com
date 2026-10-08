/**
 * tests/money-one-number-r2-fix-2026-10-06.test.js
 *
 * Review round 2 money fixes (Jo approved 2026-10-06). The repros pinned as
 * KNOWN BUG R2-2-1 / R2-2-5 / R2-2-6 on draft PR #2243
 * (tests/review-r2-money-texting-2026-10-06.test.js) become regressions here,
 * plus one cross-surface table: for each job, the estimate, the contract
 * pre-flight, the homeowner portal (estimate card + Balance Due), the deal
 * room page, the signing-day invoice and the amount Stripe is asked to
 * charge must name the SAME "due at signing".
 *
 *   A. R2-2-1  the accepted tier is the price (estimate, jobValue, deposit
 *              draft, install-day final) — real deal-accepted-tier.js +
 *              deposit-draft-logic.js
 *   B. R2-2-6  a deposit invoice charges the deposit, then the balance —
 *              invoice-charge.js and the REAL createStripePaymentLink handler
 *              (firebase / Stripe stubbed), both the payment-link and the
 *              Stripe-invoice paths; the Kentucky hold still refuses
 *   C. R2-2-5  the deal room prices its deposit through fromEstimate — the
 *              real close-board.js page
 *   D. the cross-surface table
 *
 * Every behavioural check runs the shipping module; the few source checks
 * strip comments first and assert their anchor.
 *
 * Run: node tests/money-one-number-r2-fix-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F = (rel) => require(path.join(FN, rel));

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => {
    let sl = l.indexOf('//');
    while (sl > 0 && l[sl - 1] === ':') sl = l.indexOf('//', sl + 2);
    return sl === -1 ? l : l.slice(0, sl);
  }).join('\n');
}

const OH = '1 Main St, Cincinnati, OH 45202';
const KY = '9 Elm St, Covington, KY 41011';
const DR = F('deposit-rule.js');
const DAT = F('deal-accepted-tier.js');
const DDL = F('deposit-draft-logic.js');
let IC = null;
try { IC = F('invoice-charge.js'); } catch (_) { IC = null; }

// ── The Stripe handler, for real (stubs for firebase + the Stripe SDK) ──
const OWNER = 'owner-uid-1';
function loadStripeHandler() {
  const calls = { links: [], invItems: [], invoices: [], updates: [] };
  const docs = {};
  const docRef = (p) => ({
    get: async () => ({ exists: docs[p] != null, data: () => docs[p] }),
    update: async (d) => { calls.updates.push([p, d]); docs[p] = Object.assign({}, docs[p] || {}, d); },
    set: async (d) => { docs[p] = d; },
  });
  const db = {
    doc: (p) => docRef(p),
    collection: (n) => ({ doc: (id) => docRef(n + '/' + id) }),
  };
  class FakeStripe {
    constructor() {
      let n = 0;
      this.paymentLinks = {
        create: async (o) => { calls.links.push(o); return { id: 'plink_' + (++n), url: 'https://buy.stripe.test/' + n }; },
        update: async () => ({}),
      };
      this.customers = {
        list: async () => ({ data: [] }),
        create: async () => ({ id: 'cus_1' }),
        update: async () => ({}),
      };
      let pending = [];
      this.invoiceItems = { create: async (o) => { calls.invItems.push(o); pending.push(o.amount); return { id: 'ii' }; } };
      this.invoices = {
        create: async (o) => { calls.invoices.push(o); pending = []; return { id: 'in_' + (++n) }; },
        retrieve: async (id) => ({ id, status: 'paid', amount_paid: 1 }),
        voidInvoice: async () => ({}),
        del: async () => ({}),
        finalizeInvoice: async (id) => ({ id, amount_due: pending.reduce((s, a) => s + a, 0), hosted_invoice_url: 'https://invoice.stripe.test/' + id, invoice_pdf: null, number: 'X', due_date: 0 }),
      };
    }
  }
  const stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => h },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'sk_' + 'test_stub' }) },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error(...a) { if (process.env.DEBUG_R2) console.log('ERR', JSON.stringify(a)); } } },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DEL', arrayUnion: (...a) => a } },
    'firebase-admin/auth': { getAuth: () => ({}) },
    './shared': { requireAuth: async () => ({ decoded: { uid: OWNER, companyId: OWNER } }), viewOnlyRefusal: () => null },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
    './integrations/_shared': { SECRETS: { SLACK_WEBHOOK_URL: { name: 'S', value: () => '' } }, secretValue: () => null },
    stripe: FakeStripe,
  };
  const realLoad = Module._load;
  const hook = function (request) {
    if (request === 'stripe' || /node_modules[\/]stripe[\/]/.test(String(request))) return FakeStripe;
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.apply(this, arguments);
  };
  Module._load = hook;
  const prevOwner = process.env.NBD_OWNER_UID;
  process.env.NBD_OWNER_UID = OWNER;
  let mod = null;
  try {
    for (const f of ['stripe.js', 'stripe-crm-invoice.js']) delete require.cache[path.join(FN, f)];
    mod = require(path.join(FN, 'stripe.js'));
  } finally {
    Module._load = realLoad;
    if (prevOwner == null) delete process.env.NBD_OWNER_UID; else process.env.NBD_OWNER_UID = prevOwner;
  }
  // Mint one invoice: → { status, body, charged (cents Stripe was asked for) }
  async function mint(invoice, opts) {
    const o = opts || {};
    for (const k of Object.keys(docs)) delete docs[k];
    calls.links.length = 0; calls.invItems.length = 0; calls.invoices.length = 0; calls.updates.length = 0;
    docs['invoices/INV1'] = JSON.parse(JSON.stringify(Object.assign({ status: 'sent' }, invoice, { companyId: OWNER, createdBy: OWNER })));
    docs['leads/' + (invoice.leadId || 'L')] = o.lead || { userId: OWNER, address: OH, state: 'OH' };
    docs['companyProfile/' + OWNER] = { timeZone: 'America/New_York' };
    const prevFlag = process.env.NBD_CRM_STRIPE_INVOICES;
    if (o.stripeInvoice) delete process.env.NBD_CRM_STRIPE_INVOICES; else process.env.NBD_CRM_STRIPE_INVOICES = 'off';
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    // The stub hook stays on for the call: the handler require()s the Stripe
    // SDK lazily (getStripe), and the real SDK must never load here.
    Module._load = hook;
    try {
      await mod.createStripePaymentLink({ method: 'POST', body: { invoiceId: 'INV1' }, headers: {} }, res);
    } finally {
      Module._load = realLoad;
      if (prevFlag == null) delete process.env.NBD_CRM_STRIPE_INVOICES; else process.env.NBD_CRM_STRIPE_INVOICES = prevFlag;
    }
    let charged = null;
    if (calls.links.length) charged = calls.links[0].line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
    else if (calls.invItems.length) charged = calls.invItems.reduce((s, it) => s + it.amount, 0);
    const stamp = calls.updates.filter(([p, d]) => p === 'invoices/INV1' && d.stripeChargeCents != null).pop();
    return { status: res.code, body: res.body || {}, charged, lineName: calls.links.length ? calls.links[0].line_items[0].price_data.product_data.name : null,
      stamp: stamp ? stamp[1] : null, invoiceDoc: docs['invoices/INV1'] };
  }
  return { mint, mod };
}

// ── The real close-board.js deal page ──────────────────────────────────
function dealPage(estimateData, leadData) {
  const raw = rd('docs/pro/js/close-board.js').replace(/\bimport\(/g, '__testImport(');
  const mk = () => ({ _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = String(v); },
    style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } });
  const store = {};
  const sb = {
    console: { log() {}, info() {}, warn() {}, error() {} }, JSON, Math, Date, Number, String, Array, Object, RegExp,
    Boolean, Error, Promise, Set, Map, isNaN, parseFloat, parseInt, isFinite, encodeURIComponent, Intl,
    setTimeout: () => 0, clearTimeout: () => {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: { getElementById: () => mk(), createElement: mk, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    navigator: {},
    __testImport: async () => ({ doc: () => ({}), collection: () => ({}), where: () => ({}), query: () => ({}),
      setDoc: () => Promise.resolve(), deleteDoc: () => Promise.resolve(), getDocs: () => Promise.resolve({ empty: true, size: 0, forEach() {} }) }),
  };
  sb.window = sb; sb.addEventListener = () => {}; sb.showToast = () => {}; sb.open = () => null;
  sb._db = null; sb._user = { uid: 'u1' }; sb._userClaims = { companyId: 'c1' };
  sb._companyProfile = { brand: { contact: { mailingAddress: '123 Example Rd, Goshen, OH 45122', email: 'x@nbd.test' } } };
  sb.getLineItems = () => [];
  vm.createContext(sb);
  vm.runInContext(rd('docs/pro/js/deposit-rule.js'), sb, { filename: 'deposit-rule.js' });
  vm.runInContext(rd('docs/pro/js/ky-insurance-law.js'), sb, { filename: 'ky-insurance-law.js' });
  vm.runInContext(raw, sb, { filename: 'close-board.js' });
  const deal = sb.CloseBoard.createFromEstimate(estimateData, leadData);
  const html = sb.CloseBoard.generatePageHTML(deal) || '';
  // Each tier card's "Due at signing" figure, in tier order on the page.
  const deps = (html.match(/class="tier-deposit">[^<]*<strong>([^<]*)<\/strong>/g) || [])
    .map((m) => Number(m.replace(/.*<strong>/, '').replace(/<\/strong>/, '').replace(/[^0-9.]/g, '')));
  return { deal, html, deps };
}

// ── The contract pre-flight (doc-preflight.js) "Deposit Amount" ─────────
let _pf = null;
function preflightDeposit(lead, estimate) {
  if (!_pf) {
    const DG = path.join(ROOT, 'docs/pro/js');
    const win = { _brand: () => ({ legalName: 'X', colors: {}, contact: {} }) };
    win.window = win;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON,
      document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() } };
    for (const f of ['estimate-config.js', 'deposit-rule.js', 'ky-insurance-law.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(DG, f), 'utf8'), sandbox, { filename: f });
    }
    _pf = win.DocPreflight && win.DocPreflight._resolveFieldValue;
  }
  if (typeof _pf !== 'function') return null;
  return Number(_pf({ key: 'depositAmount', source: 'computed.depositAmount' }, { lead, estimate }));
}

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nA. R2-2-1 — the accepted tier is the price');
  // ════════════════════════════════════════════════════════════════════
  const perSq = (extra) => Object.assign({ userId: 'u', leadId: 'L', priceMode: 'per-sq', prices: { good: 10500, better: 12000, best: 15000 },
    tier: 'better', selectedTier: 'better', grandTotal: 12000, subtotal: 11162.79, tax: 837.21, taxRate: 0.075,
    mode: 'cash', jobId: 'J1', addr: OH }, extra || {});
  const leadOf = (extra) => Object.assign({ userId: 'u', primaryEstimateId: 'E', jobValue: 12000, address: OH, state: 'OH', activeJobId: 'J1' }, extra || {});
  const accept = (est, lead, tier, price) => DAT.planAcceptedTier({ lead, estimate: est, estimateId: 'E', leadId: 'L', ownerUid: 'u', tier, price, dealId: 'D', now: 1 });
  function lifecycle(tier, price) {
    const est = perSq(), lead = leadOf();
    const plan = accept(est, lead, tier, price);
    const est2 = Object.assign({}, est, plan.estimate || {});
    const lead2 = Object.assign({}, lead, plan.lead || {});
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'deal_accepted', lead: lead2, est: est2, estimateId: 'E',
      deal: { estimateId: 'E', acceptedTier: tier, acceptedPrice: price }, existingInvoices: [] });
    const paid = Object.assign({ id: dd.invoiceId }, dd.invoice, { status: 'paid', amountPaid: price, balanceDue: 0, createdAt: 1 });
    const fd = DDL.decideFinalDraft({ leadId: 'L', lead: lead2, est: est2, estimateId: 'E', invoices: [paid] });
    return { plan, est2, lead2, dd, fd };
  }
  {
    // The #2243 repro: Standard $10,500 accepted on a V2 per-SQ estimate saved at Preferred $12,000.
    const r = lifecycle('good', 10500);
    ok('FIXED (was KNOWN BUG R2-2-1): accepting Standard $10,500 on a V2 estimate saved at the default Preferred re-tiers the estimate',
      r.plan.reason === 'applied' && r.est2.tier === 'good' && r.est2.selectedTier === 'good' && r.est2.grandTotal === 10500,
      JSON.stringify({ reason: r.plan.reason, est: r.plan.estimate && r.plan.estimate.grandTotal }));
    ok('…lead.jobValue follows ($10,500)', r.lead2.jobValue === 10500, r.lead2.jobValue);
    ok('…the estimate deposit is re-run on the new total (50% of $10,500 = $5,250)', r.est2.deposit === 5250 && r.est2.depositPlan && r.est2.depositPlan.depositCents === 525000, r.est2.deposit);
    ok('…subtotal + tax are backed out of the accepted total', Math.round((r.est2.subtotal + r.est2.tax) * 100) === 1050000);
    ok('…the signing-day draft bills $10,500', r.dd.action === 'create' && r.dd.invoice.total === 10500, r.dd.invoice && r.dd.invoice.total);
    ok('…and once it is paid, Install Done drafts NOTHING more (was: another $1,500)',
      r.fd.action !== 'create', JSON.stringify({ action: r.fd.action, reason: r.fd.reason, total: r.fd.invoice && r.fd.invoice.total }));
    ok('…the replaced tier is kept for the rep\'s history', r.plan.estimate.acceptedTierReplaced === 'better');
  }
  {
    const r = lifecycle('best', 15000);
    ok('accepting Elite $15,000 (higher): estimate, jobValue and the draft all say $15,000',
      r.plan.reason === 'applied' && r.est2.grandTotal === 15000 && r.lead2.jobValue === 15000 && r.dd.invoice.total === 15000 && r.fd.action !== 'create',
      JSON.stringify({ est: r.est2.grandTotal, jv: r.lead2.jobValue, dd: r.dd.invoice && r.dd.invoice.total, fd: r.fd.action }));
    ok('…its deposit is 50% of $15,000 on the estimate and the draft', r.est2.deposit === 7500 && r.dd.invoice.depositAmount === 7500);
  }
  {
    // The same tier at the same price: nothing to change.
    const est = perSq();
    const plan = accept(est, leadOf(), 'better', 12000);
    ok('the same tier at the same price → same-tier, the estimate total is not rewritten', plan.reason === 'same-tier' && plan.estimate.grandTotal === undefined);
    // A re-snapshotted price on the same tier still wins.
    const p2 = accept(est, leadOf(), 'better', 12400);
    ok('the same tier at a new price → applied at the signed price (and prices{} follows)', p2.reason === 'applied' && p2.estimate.grandTotal === 12400 && p2.estimate.prices.better === 12400);
  }
  {
    // A line-item estimate: its rows are priced at the rep's tier, so the
    // acceptance is recorded (the customer-page chip), never swapped in.
    const li = { userId: 'u', leadId: 'L', priceMode: 'line-item', prices: null, tier: 'better', selectedTier: 'better', grandTotal: 12000, mode: 'cash', addr: OH };
    const plan = accept(li, leadOf(), 'good', 10500);
    ok('a line-item estimate keeps the rep\'s tier and records the pick (recorded-differs, unchanged)',
      plan.reason === 'recorded-differs' && plan.estimate.grandTotal === undefined && plan.lead.jobValue === undefined);
    const tl = accept({ userId: 'u', leadId: 'L', tierApplies: false, grandTotal: 900, prices: { good: 900 } }, leadOf(), 'good', 900);
    ok('a template estimate (tierApplies:false) is still record-only', tl.estimate && tl.estimate.tier === undefined);
  }
  {
    // A deposit already collected keeps its amount (bug #10's rule still holds).
    const plan = DAT.planAcceptedTier({ lead: leadOf(), estimate: perSq({ deposit: 6000 }), estimateId: 'E', leadId: 'L', ownerUid: 'u',
      tier: 'good', price: 10500, dealId: 'D', now: 1, depositCollected: true });
    ok('money already taken → the deposit is kept and flagged', plan.estimate.acceptedTierDepositKept === true && plan.estimate.deposit === undefined && plan.estimate.grandTotal === 10500);
  }
  {
    // An estimate accepted BEFORE this fix (recorded beside the rep's tier).
    const legacy = perSq({ acceptedTier: 'good', acceptedPrice: 10500 });
    const lead = leadOf();
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'deal_accepted', lead, est: legacy, estimateId: 'E',
      deal: { estimateId: 'E', acceptedTier: 'good', acceptedPrice: 10500 }, existingInvoices: [] });
    const paid = Object.assign({ id: dd.invoiceId }, dd.invoice, { status: 'paid', amountPaid: 10500, balanceDue: 0, createdAt: 1 });
    const fd = DDL.decideFinalDraft({ leadId: 'L', lead, est: legacy, estimateId: 'E', invoices: [paid] });
    ok('an acceptance recorded before the fix: the final draft bills the accepted price too (nothing more after $10,500 is paid)',
      dd.invoice.total === 10500 && fd.action !== 'create', JSON.stringify({ fd: fd.action, t: fd.invoice && fd.invoice.total }));
    const cs = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed', lead, est: legacy, estimateId: 'E', existingInvoices: [] });
    ok('…and a contract-signed draft on it bills $10,500, not the rep\'s $12,000', cs.action === 'create' && cs.invoice.total === 10500, cs.invoice && cs.invoice.total);
    const kept = perSq({ acceptedTier: 'good', acceptedPrice: 10500, acceptedTierDismissed: true });
    const fd2 = DDL.decideFinalDraft({ leadId: 'L', lead, est: kept, estimateId: 'E', invoices: [] });
    ok('…unless the rep tapped "Keep" on the chip — then the rep\'s $12,000 is billed', fd2.action === 'create' && fd2.invoice.total === 12000, fd2.invoice && fd2.invoice.total);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nB. R2-2-6 — a deposit invoice charges the deposit, then the balance');
  // ════════════════════════════════════════════════════════════════════
  ok('functions/invoice-charge.js loads with chargeDueNow + portalBalanceCard', !!(IC && IC.chargeDueNow && IC.portalBalanceCard));
  const S = loadStripeHandler();
  const cashDraft = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed',
    lead: { userId: 'u', primaryEstimateId: 'E', address: OH, state: 'OH', activeJobId: 'J1' },
    est: { userId: 'u', leadId: 'L', grandTotal: 12000, subtotal: 12000, tax: 0, mode: 'cash', jobId: 'J1', addr: OH,
      rows: [{ desc: 'Roof', qty: '1', retailTotal: 12000, total: 12000 }] }, estimateId: 'E', existingInvoices: [] });
  const inv0 = Object.assign({}, cashDraft.invoice, { status: 'sent' });
  ok('context (#2243 repro): the $12,000 cash signing-day invoice carries depositAmount $6,000 and balanceDue $12,000',
    inv0.total === 12000 && inv0.depositAmount === 6000 && inv0.balanceDue === 12000);
  if (IC) {
    const d0 = IC.chargeDueNow(inv0);
    ok('chargeDueNow: nothing paid → the deposit ($6,000)', d0.kind === 'deposit' && d0.chargeCents === 600000 && d0.balanceCents === 1200000);
    const d1 = IC.chargeDueNow(Object.assign({}, inv0, { amountPaid: 2000, balanceDue: 10000 }));
    ok('…$2,000 paid by check → the rest of the deposit ($4,000)', d1.kind === 'deposit' && d1.chargeCents === 400000);
    const d2 = IC.chargeDueNow(Object.assign({}, inv0, { amountPaid: 6000, balanceDue: 6000, depositPaid: true }));
    ok('…deposit paid → the remaining balance ($6,000)', d2.kind === 'balance' && d2.chargeCents === 600000);
    const d3 = IC.chargeDueNow({ total: 5000, depositAmount: 5000, amountPaid: 0 });
    ok('…a deposit equal to the total is no split → the balance', d3.kind === 'balance' && d3.chargeCents === 500000);
    const d4 = IC.chargeDueNow({ total: 12000, depositAmount: 6000, amountPaid: 12000 });
    ok('…paid in full → nothing to charge', d4.kind === 'none' && d4.chargeCents === 0);
    const d5 = IC.chargeDueNow({ total: 12000, depositAmount: 6000, amountPaid: 0 }, { totalCents: 300000 });
    ok('…never more than the balance due (a $3,000 net total caps a $6,000 deposit)', d5.chargeCents === 300000);
  }
  {
    const r = await S.mint(inv0);
    ok('FIXED (was KNOWN BUG R2-2-6): Pay Now on the unpaid $12,000 cash invoice asks Stripe for the $6,000 deposit (payment link)',
      r.status === 200 && r.charged === 600000 && /^Deposit due/.test(r.lineName || ''), JSON.stringify({ status: r.status, charged: r.charged, body: r.body }));
    ok('…the server stamps what the link charges on the invoice (stripeChargeCents 600000, kind deposit) and returns it',
      r.stamp && r.stamp.stripeChargeCents === 600000 && r.stamp.stripeChargeKind === 'deposit' && r.body.chargedCents === 600000);
    const r2 = await S.mint(inv0, { stripeInvoice: true });
    ok('…the Stripe-invoice path (platform tenant) bills the same $6,000', r2.status === 200 && r2.charged === 600000 && r2.body.stripeInvoice === true,
      JSON.stringify({ status: r2.status, charged: r2.charged, body: r2.body }));
    const r3 = await S.mint(Object.assign({}, inv0, { amountPaid: 2000, balanceDue: 10000, status: 'partial' }));
    ok('…after a $2,000 check: the link asks for the remaining $4,000 of the deposit', r3.status === 200 && r3.charged === 400000, r3.charged);
    const r4 = await S.mint(Object.assign({}, inv0, { amountPaid: 6000, balanceDue: 6000, depositPaid: true, status: 'partial' }));
    ok('…after the deposit is paid: the link asks for the $6,000 balance', r4.status === 200 && r4.charged === 600000 && r4.stamp && r4.stamp.stripeChargeKind === 'balance', r4.charged);
    // R6-2-6: the stamp also records what was already paid at the mint, so
    // the portal stops offering a link once money lands after it.
    ok('…each mint stamps the amount already paid at that moment (stripeChargePaidCents: $0 on the deposit link, $6,000 on the balance link)',
      r.stamp && r.stamp.stripeChargePaidCents === 0 && r4.stamp && r4.stamp.stripeChargePaidCents === 600000,
      JSON.stringify({ dep: r.stamp, bal: r4.stamp }));
    const r5 = await S.mint(Object.assign({}, inv0, { amountPaid: 12000, balanceDue: 0, status: 'partial' }));
    ok('…paid in full: refused, nothing charged', r5.status === 400 && r5.charged === null);
    const noDep = await S.mint({ leadId: 'L', total: 1500, tax: 0, depositAmount: 0, amountPaid: 0, items: [{ description: 'Repair', total: 1500 }] });
    ok('an invoice with no deposit still charges its whole balance (unchanged)', noDep.status === 200 && noDep.charged === 150000, noDep.charged);
    const ky = await S.mint(Object.assign({}, inv0, { leadId: 'LKY', depositAmount: 0 }), { lead: { userId: OWNER, address: KY, state: 'KY', insCarrier: 'State Farm', claimNumber: 'C-1', insuranceClaim: true } });
    ok('a Kentucky insurance job is still refused (409 KY_CANCELLATION_WINDOW) before any Stripe call', ky.status === 409 && ky.body.error === 'KY_CANCELLATION_WINDOW' && ky.charged === null, JSON.stringify(ky.body));
  }
  if (IC) {
    // The portal's Balance Due card.
    const stampDep = Object.assign({}, inv0, { stripePaymentLink: 'https://buy.stripe.test/1', stripeChargeCents: 600000, stripeChargeKind: 'deposit' });
    const c1 = IC.portalBalanceCard(stampDep, stampDep.stripePaymentLink);
    ok('portal: an unpaid deposit invoice shows "Deposit Due $6,000" with the $6,000 link and $12,000 owed',
      c1.kind === 'deposit' && c1.amountCents === 600000 && c1.totalOwedCents === 1200000 && c1.stripePaymentLink === 'https://buy.stripe.test/1');
    const legacy = Object.assign({}, inv0, { stripePaymentLink: 'https://buy.stripe.test/old' });
    ok('portal: a pre-fix link (no stamp — it charged the whole job) is NOT offered on a deposit invoice', IC.portalBalanceCard(legacy, legacy.stripePaymentLink).stripePaymentLink === null);
    const afterDep = Object.assign({}, stampDep, { amountPaid: 6000, balanceDue: 6000, depositPaid: true, status: 'partial' });
    const c3 = IC.portalBalanceCard(afterDep, afterDep.stripePaymentLink);
    // Review R6-2-6 (2026-10-07): this used to assert the spent deposit link
    // WAS offered here because its cents matched — that was the bug. A link
    // stamped kind 'deposit' is never the balance link.
    ok('portal: after the deposit, "Balance Due $6,000" — and the spent $6,000 deposit link is NOT offered as the balance link (R6-2-6)',
      c3.kind === 'balance' && c3.amountCents === 600000 && c3.stripePaymentLink === null && c3.linkPending === true, JSON.stringify(c3));
    const plain = { total: 1500, depositAmount: 0, amountPaid: 0, balanceDue: 1500, stripePaymentLink: 'https://buy.stripe.test/p' };
    ok('portal: a plain invoice with a pre-fix link keeps its Pay Now (unchanged)', IC.portalBalanceCard(plain, plain.stripePaymentLink).stripePaymentLink === 'https://buy.stripe.test/p');
    ok('portal: a held link ("" from payUrlUnlessHeld) is never offered', IC.portalBalanceCard(stampDep, '').stripePaymentLink === null);
    const portalSrc = stripComments(rd('functions/portal.js'));
    ok('functions/portal.js builds its Balance Due card from InvoiceCharge.portalBalanceCard (after the KY hold)',
      /const _payUrl = _unpaidInvoice \? KyLaw\.payUrlUnlessHeld\(/.test(portalSrc) && /InvoiceCharge\.portalBalanceCard\(_unpaidInvoice, _payUrl\)/.test(portalSrc)
        && !/amountCents:\s*Math\.round\(Number\(_unpaidInvoice\.balanceDue\)/.test(portalSrc));
    const pjs = stripComments(rd('docs/pro/js/portal.js'));
    ok('docs/pro/js/portal.js labels a deposit "Deposit Due"', /view\.balance\.kind === 'deposit'/.test(pjs) && /'Deposit Due'/.test(pjs));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC. R2-2-5 — the deal room prices its deposit through fromEstimate');
  // ════════════════════════════════════════════════════════════════════
  const leadOH = { id: 'LOH', firstName: 'Oh', lastName: 'Io', address: OH, insCarrier: 'State Farm', claimNumber: 'C-9', deductible: 1000 };
  {
    const basis = { mode: 'insurance', claim: { deductible: 1000, acv: 8000 }, addr: OH };
    const p = dealPage({ id: 'E1', prices: { better: 12000 }, depositBasis: basis }, leadOH);
    ok('FIXED (was KNOWN BUG R2-2-5): an Ohio insurance deal ($12,000, $1,000 deductible, $8,000 ACV) says $8,000 due at signing — as the estimate and invoice do',
      p.deps.length >= 1 && p.deps.every((d) => d === 8000), JSON.stringify(p.deps));
    ok('…the deal carries the estimate\'s deposit inputs (depositBasis)', p.deal.depositBasis && p.deal.depositBasis.claim.acv === 8000);
  }
  {
    const p = dealPage({ id: 'E2', prices: { better: 12000 }, mode: 'cash', depositPctOverride: 30, addr: OH },
      { id: 'LC', firstName: 'Ca', lastName: 'Sh', address: OH });
    ok('a cash deal whose estimate carries a 30% rep override says $3,600 (was $6,000)', p.deps.length >= 1 && p.deps.every((d) => d === 3600), JSON.stringify(p.deps));
  }
  {
    const p = dealPage({ prices: { good: 15000, better: 15000, best: 15000 } }, { id: 'LX', firstName: 'X', lastName: 'Y', address: OH });
    ok('a deal made with no deposit inputs prices from its own fields as before (cash $15,000 → $7,500)', p.deps.length >= 3 && p.deps.every((d) => d === 7500), JSON.stringify(p.deps));
  }
  {
    const v2 = stripComments(rd('docs/pro/js/estimate-v2-ui.js'));
    const at = v2.indexOf('const dealEst = {');
    const line = at === -1 ? '' : v2.slice(at, v2.indexOf('\n', at));
    ok('estimate-v2-ui.js hands the deal its deposit inputs (dealEst.depositBasis with mode + claim)',
      /depositBasis/.test(line) && /const depositBasis = \{[\s\S]{0,200}mode: estimate\.mode \|\| state\.jobMode[\s\S]{0,120}acv: cl\.acv/.test(v2));
    const cb = stripComments(rd('docs/pro/js/close-board.js'));
    const tp = cb.slice(cb.indexOf('const _tierPlan = (price) =>'), cb.indexOf('const depositLine'));
    ok('close-board.js _tierPlan calls fromEstimate (and no longer compute)', /_depRule\.fromEstimate\(/.test(tp) && !/_depRule\.compute\(/.test(tp));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nD. one number everywhere — estimate == contract == portal == deal room == invoice == Stripe');
  // ════════════════════════════════════════════════════════════════════
  async function table(name, o) {
    const est = o.est, lead = o.lead;
    const estPlan = DR.fromEstimate(est, { lead });
    const estDoc = Object.assign({}, est, { deposit: estPlan.depositCents / 100, depositPlan: DR.toStored(estPlan) });
    const estimate = estPlan.depositCents;
    const contract = Math.round(preflightDeposit(Object.assign({ jobValue: est.grandTotal }, lead), estDoc) * 100);
    const SDP = F('deposit-plan-view.js').safeDepositPlan(estDoc);
    const portalEst = SDP ? SDP.depositCents : null;
    const page = dealPage(Object.assign({ id: 'E' }, est, { prices: { [est.tier || 'better']: est.grandTotal } }), Object.assign({ id: 'L' }, lead));
    const deal = page.deps.length ? Math.round(page.deps[0] * 100) : null;
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed', lead: Object.assign({ userId: 'u' }, lead),
      est: Object.assign({ userId: 'u', leadId: 'L' }, estDoc), estimateId: 'E', existingInvoices: [] });
    const invoice = dd.action === 'create' ? Math.round(dd.invoice.depositAmount * 100) : 0;
    let portalDue = 0, stripe = 0, stripeStatus = null;
    if (dd.action === 'create') {
      const sent = Object.assign({}, dd.invoice, { status: 'sent' });
      const m = await S.mint(sent, { lead: Object.assign({ userId: OWNER }, lead) });
      stripeStatus = m.status; stripe = m.charged;
      portalDue = IC ? IC.portalBalanceCard(Object.assign({}, sent, m.stamp || {}), 'https://x.test/p').amountCents : null;
    } else if (o.kyInvoice) {
      // Kentucky: no draft; a rep-made invoice is refused by the pay-link gate.
      const m = await S.mint({ leadId: 'L', total: est.grandTotal, tax: 0, depositAmount: 0, amountPaid: 0, items: [{ description: 'Roof', total: est.grandTotal }] },
        { lead: Object.assign({ userId: OWNER }, lead) });
      stripeStatus = m.status; stripe = m.charged || 0;
    }
    const row = { estimate, contract, portalEst, deal, invoice, portalDue, stripe };
    const want = o.want * 100;
    const same = Object.values(row).every((v) => v === want);
    ok(name + ' → $' + o.want.toLocaleString() + ' on every surface' + (o.kyInvoice ? ' (and the pay link refused, 409)' : ''),
      same && (!o.kyInvoice || stripeStatus === 409), JSON.stringify(row) + ' stripe=' + stripeStatus);
  }
  const cashEst = (extra) => Object.assign({ grandTotal: 12000, total: 12000, subtotal: 12000, tax: 0, taxRate: 0, mode: 'cash', tier: 'better', priceMode: 'line-item', jobId: 'J1', addr: OH,
    rows: [{ desc: 'Roof replacement', qty: '1', retailTotal: 12000, total: 12000 }] }, extra || {});
  const ohLead = { address: OH, state: 'OH', primaryEstimateId: 'E', activeJobId: 'J1' };
  await table('cash job with a deposit ($12,000, OH)', { est: cashEst(), lead: ohLead, want: 6000 });
  await table('cash job with a 30% rep override', { est: cashEst({ depositPctOverride: 30 }), lead: ohLead, want: 3600 });
  await table('Ohio insurance job with an $8,000 ACV ($1,000 deductible)', {
    est: cashEst({ mode: 'insurance', claim: { deductible: 1000, acv: 8000 } }),
    lead: Object.assign({ insCarrier: 'State Farm', claimNumber: 'C-1', deductibleOrOwedByHO: 1000 }, ohLead), want: 8000 });
  await table('Kentucky insurance job — nothing due at signing', {
    est: cashEst({ mode: 'insurance', claim: { deductible: 1000, acv: 8000 }, addr: KY }),
    lead: { address: KY, state: 'KY', insCarrier: 'State Farm', claimNumber: 'C-2', deductibleOrOwedByHO: 1000, primaryEstimateId: 'E', activeJobId: 'J1' },
    want: 0, kyInvoice: true });
  for (const [label, tier, price, want] of [['lower', 'good', 10500, 5250], ['higher', 'best', 15000, 7500]]) {
    const plan = accept(perSq(), leadOf(), tier, price);
    const est2 = Object.assign({}, perSq(), plan.estimate);
    await table('tier accepted ' + label + ' (' + tier + ' $' + price.toLocaleString() + ' over the default $12,000)', {
      est: Object.assign({}, est2, { tax: 0, taxRate: 0, subtotal: price }), lead: Object.assign({}, ohLead, { jobValue: price }), want });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
