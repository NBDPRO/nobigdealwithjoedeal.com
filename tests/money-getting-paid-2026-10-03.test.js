/**
 * money-getting-paid-2026-10-03.test.js — getting paid through the CRM.
 *
 * A read-only prod audit (2026-10-03): 30 jobs at install or later, 4 with
 * invoices; all 7 invoices mirrored in from the Stripe dashboard; 0 check /
 * Zelle / cash payments ever recorded; revenue (collected only) $3,650.
 *
 *   1. Record payment on a job with NO invoice (recordPaymentTarget,
 *      jobValueInvoiceDoc, payer + paymentId on the ledger entry, the
 *      customer page's Record payment button).
 *   2. ONE pay-link helper (ky-insurance-law.js payUrlOf / payUrlUnlessHeld)
 *      reads stripePaymentLink OR stripeHostedUrl, and the Kentucky hold
 *      blocks a held invoice's link on EVERY surface: the customer page,
 *      the SMS / email send, the reminder, the homeowner portal.
 *   3. A part payment is 'partial' (Stripe webhook too), 'partial' is owed,
 *      and "Send balance" re-sends through the existing send flow.
 *   4. Double billing: one live invoice per job (planJobInvoice), a final
 *      invoice credits the deposit as "Less deposit paid", the pay link
 *      charges the balance.
 *   5. Install complete → a DRAFT final invoice + "Send final invoice" task,
 *      idempotent per job, through the spine's 'installed' event.
 *   6. One due-date value (7 days, Jo 2026-09-30); one timeline line per
 *      payment on every path (idempotent per payment id); an internal-only
 *      overdue task.
 *
 * Nothing here sends anything: every send primitive is a capturing fake.
 * Run: node tests/money-getting-paid-2026-10-03.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
// A module that fails to load is a red result, never a skipped section.
function req(p) {
  try { return require(path.join(ROOT, p)); }
  catch (e) { ok('loads ' + p, false, e && e.message); return null; }
}
function block(src, name) {
  const s = lf(src);
  const a = s.indexOf('// nbd:' + name + ':start');
  const b = s.indexOf('// nbd:' + name + ':end');
  return (a < 0 || b < 0) ? null : s.slice(a, b);
}

const J = req('functions/ky-insurance-law.js');
const JB = req('docs/pro/js/ky-insurance-law.js');
const DR = req('functions/deposit-rule.js');
const IFE = req('functions/invoice-from-estimate.js');
const D = req('functions/deposit-draft-logic.js');
const DD = req('functions/deposit-draft.js');
const SPINE = req('functions/job-spine.js');
const SL = req('functions/job-spine-logic.js');
const OWED = req('functions/invoice-owed.js');
const PTL = req('functions/payment-timeline.js');
const OVL = req('functions/invoice-overdue-logic.js');
const OV = req('functions/invoice-overdue.js');
const IFI = req('functions/install-final-invoice.js');
const MPL = req('functions/money-paper-logic.js');
const REM = req('docs/pro/js/invoice-reminder.js');
const IP = req('docs/pro/js/invoice-pipeline.js');

const NOW = Date.parse('2026-10-03T15:00:00Z');
const KY = '9 Dixie Hwy, Florence, KY 41042';
const OH = '12 Main St, Milford, OH 45150';
const kyLeadHeld = { id: 'L1', userId: 'u1', companyId: 'u1', address: KY, jobType: 'insurance', claimNumber: 'C-1', firstName: 'Kay' };
const kyLeadReleased = Object.assign({}, kyLeadHeld, { carrierDecisionAt: '2026-08-01' });
const ohLead = { id: 'L1', userId: 'u1', companyId: 'u1', address: OH, jobType: 'cash', firstName: 'Pat', lastName: 'Jones' };
const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_hosted';
const PLINK = 'https://buy.stripe.com/test_link';

// ── fake transactional Firestore (deposit-draft test's, plus create / in) ──
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const writes = [];
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const apply = (cur, patch) => {
    const d = Object.assign({}, cur);
    for (const k of Object.keys(patch)) { const v = patch[k]; d[k] = (v && v.__union) ? (Array.isArray(d[k]) ? d[k] : []).concat(v.__union) : v; }
    return d;
  };
  const exists = (p) => store.has(p);
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)) }; },
    async update(patch) { if (!exists(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
    async set(data) { writes.push(['set', p, data]); store.set(p, clone(data)); },
    async create(data) { if (exists(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', p, data]); store.set(p, clone(data)); },
  });
  const query = (c, filters, lim) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim),
    limit: (n) => query(c, filters, n),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== c.split('/').length + 1 || !k.startsWith(c + '/')) continue;
        if (filters.every(([f, op, val]) => (op === 'in' ? val.indexOf(v[f]) !== -1 : v[f] === val))) docs.push({ id: parts[parts.length - 1], data: () => clone(v) });
      }
      return { docs: docs.slice(0, lim || docs.length) };
    },
  });
  const col = (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, [], 0));
  return {
    store, writes, collection: col, doc: (p) => ref(p),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', r.path, d]); store.set(r.path, clone(d)); }),
        set: (r, d) => pending.push(() => { writes.push(['set', r.path, d]); store.set(r.path, clone(d)); }),
        update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); writes.push(['update', r.path, p]); store.set(r.path, apply(store.get(r.path), p)); }),
      };
      const out = await fn(tx);
      const snap = new Map(store); const wlen = writes.length;
      try { pending.forEach((f) => f()); } catch (e) { store.clear(); snap.forEach((v, k) => store.set(k, v)); writes.length = wlen; throw e; }
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', arrayUnion: (...x) => ({ __union: x }) };
const quiet = { info() {}, warn() {}, error() {} };
const deps = { FieldValue: FV, logger: quiet, now: () => NOW };
const perSq = (o) => Object.assign({ leadId: 'L1', userId: 'u1', priceMode: 'per-sq', prices: { good: 12000, better: 15000 }, selectedTier: 'better', grandTotal: 15000, taxRate: 0, mode: 'cash' }, o || {});

// ── browser sandbox for invoice-pipeline.js (global window, fakes only) ──
function browser(seed, extra) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const sms = [], emails = [], added = [], sets = [], fetches = [];
  let seq = 0;
  const W = {
    _db: { fake: true },
    doc: (db, c, id) => ({ path: c + '/' + id, id }),
    collection: (db, c) => ({ col: c }),
    where: (f, op, v) => ({ f, op, v }),
    query: (c, ...ws) => ({ col: c.col, ws }),
    getDoc: async (r) => ({ exists: () => store.has(r.path), data: () => JSON.parse(JSON.stringify(store.get(r.path))) }),
    getDocs: async (q) => {
      const docs = [];
      for (const [k, v] of store) {
        const [c, id] = k.split('/');
        if (c !== q.col || k.split('/').length !== 2) continue;
        if ((q.ws || []).every((w) => v[w.f] === w.v)) docs.push({ id, data: () => JSON.parse(JSON.stringify(v)) });
      }
      return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
    },
    updateDoc: async (r, patch) => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); store.set(r.path, Object.assign({}, store.get(r.path), JSON.parse(JSON.stringify(patch)))); },
    addDoc: async (c, data) => { const id = 'new' + (++seq); added.push(Object.assign({ id }, data)); store.set(c.col + '/' + id, JSON.parse(JSON.stringify(data))); return { id }; },
    setDoc: async (r, data) => { sets.push([r.path, data]); store.set(r.path, JSON.parse(JSON.stringify(data))); },
    NBDComms: {
      sendSMS: async (o) => { sms.push(o); return { success: true }; },
      sendEmail: async (o) => { emails.push(o); return { success: true }; },
    },
    NBDJurisdiction: JB,
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    _auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok' } },
    _user: { uid: '1phDvAVXHSg82wDLegAbQFq14Ci1' },
    _userClaims: {},
    _leads: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
  };
  Object.assign(W, extra || {});
  global.window = W;
  global.showToast = () => {};
  global.fetch = async (url, opts) => { fetches.push([url, opts]); return { ok: true, json: async () => ({ url: 'https://buy.stripe.com/test_balance_link', paymentLinkId: 'plink_bal' }) }; };
  return { W, store, sms, emails, added, sets, fetches };
}

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\n2. ONE pay-link helper, and the Kentucky hold on every surface');
  ok('ky-insurance-law.js: the browser and server copies are byte-identical (EOL-normalised)',
    lf(read('docs/pro/js/ky-insurance-law.js')) === lf(read('functions/ky-insurance-law.js')));
  if (J) {
    ok('payUrlOf reads stripeHostedUrl when there is no stripePaymentLink (every Stripe invoice)', J.payUrlOf({ stripeHostedUrl: HOSTED }) === HOSTED);
    ok('payUrlOf prefers stripePaymentLink when both exist', J.payUrlOf({ stripePaymentLink: PLINK, stripeHostedUrl: HOSTED }) === PLINK);
    ok('payUrlOf refuses javascript: / data: / junk → falls to the next field or ""',
      J.payUrlOf({ stripePaymentLink: 'javascript:alert(1)' }) === '' && J.payUrlOf({ stripePaymentLink: 'data:x', stripeHostedUrl: HOSTED }) === HOSTED && J.payUrlOf(null) === '');
    ok('payUrlUnlessHeld: KY insurance job inside its window → "" (held)', J.payUrlUnlessHeld(kyLeadHeld, { stripeHostedUrl: HOSTED }, new Date(NOW)) === '');
    ok('payUrlUnlessHeld: KY window has run → the hosted link', J.payUrlUnlessHeld(kyLeadReleased, { stripeHostedUrl: HOSTED }, new Date(NOW)) === HOSTED);
    ok('payUrlUnlessHeld: Ohio → the link; emergency work in KY → the link',
      J.payUrlUnlessHeld(ohLead, { stripeHostedUrl: HOSTED }, new Date(NOW)) === HOSTED
      && J.payUrlUnlessHeld(kyLeadHeld, { stripeHostedUrl: HOSTED, emergencyServices: true }, new Date(NOW)) === HOSTED);
    ok('payUrlUnlessHeld: an invoice flagged kyInsuranceHold is held even with no lead', J.payUrlUnlessHeld(null, { stripePaymentLink: PLINK, kyInsuranceHold: true }, new Date(NOW)) === '');
  }

  // Surface: the reminder sheet (invoice-reminder.js buildReminder).
  if (REM && J) {
    const inv = { id: 'i1', status: 'sent', total: 5000, balanceDue: 5000, customerName: 'Pat', stripeHostedUrl: HOSTED, dueDate: new Date(NOW - 10 * 864e5) };
    const opts = { company: 'NBD', now: new Date(NOW), holdFn: (l, i, n) => J.payLinkHold(l, i, n) };
    ok('reminder: a Stripe invoice (hosted URL only) now carries its pay link', REM.buildReminder(inv, ohLead, opts).text.indexOf('You can pay here: ' + HOSTED) !== -1);
    const held = REM.buildReminder(inv, kyLeadHeld, opts);
    ok('reminder: KY held → no link and not allowed', held.held === true && held.allowed === false && held.text.indexOf(HOSTED) === -1);
  }

  // Surface: the homeowner portal's balance card (functions/portal.js), run for real.
  {
    const src = lf(read('functions/portal.js'));
    const a = src.indexOf('    // Pay link: stripePaymentLink OR stripeHostedUrl');
    // Since 2026-10-06 (review R2-2-6) the card is built by
    // invoice-charge.js portalBalanceCard; the block ends at its `: null;`.
    const b = src.indexOf(': null;', src.indexOf('const _balance', a));
    const code = (a >= 0 && b > a) ? src.slice(a, b + 7) : '';
    ok('portal: the balance build is liftable', !!code);
    const run = (lead, inv) => {
      // tenantKey + require: the balance build asks zelle-contact.js whether
      // this tenant is NBD (Zelle / "Pay by bank" are NBD-only, 2026-10-04).
      const ctx = { KyLaw: J, InvoiceCharge: require(path.join(__dirname, '..', 'functions', 'invoice-charge.js')), lead, _unpaidInvoice: inv, kyTz: J.DEFAULT_TIME_ZONE, Date, Math, Number,
        tenantKey: 'co_other', require: (p) => require(path.join(ROOT, 'functions', p)) };
      vm.createContext(ctx);
      vm.runInContext(code + '\nthis.__b = _balance;', ctx);
      return ctx.__b;
    };
    if (code && J) {
      const inv = { status: 'sent', balanceDue: 4000, stripeHostedUrl: HOSTED };
      ok('portal: a Stripe invoice (hosted URL only) shows Pay Now', run(ohLead, inv).stripePaymentLink === HOSTED);
      // 2026-10-07 (money audit H2): while held, nothing is due — the card is
      // "nothing is due yet", not "Balance due $4,000" with no way to pay.
      ok('portal: KY held → NO Pay Now, and nothing shown as due (kind held, $0)', run(kyLeadHeld, inv).stripePaymentLink === null
        && run(kyLeadHeld, inv).amountCents === 0 && run(kyLeadHeld, inv).kind === 'held' && run(kyLeadHeld, inv).zelle === null);
      ok('portal: http:// is not https → no link', run(ohLead, { status: 'sent', balanceDue: 1, stripePaymentLink: 'http://x.test/y' }).stripePaymentLink === null);
    }
  }

  // Surface: the customer page's Invoices & Payments list, run for real.
  async function customerList(docs, extraWin) {
    const src = lf(read('docs/pro/js/customer-tasks-ui.js'));
    const a = src.indexOf('window.loadInvoices = async function');
    const b = src.indexOf('\n};\n', a);
    const el = { innerHTML: '' };
    const ctx = { console, document: { getElementById: (id) => (id === 'invoiceList' ? el : { innerHTML: '' }) }, window: {} };
    Object.assign(ctx.window, {
      auth: { currentUser: { uid: 'u1' } }, db: {}, _userClaims: {},
      collection: () => ({}), query: () => ({}), where: () => ({}),
      getDocs: async () => ({ docs: docs.map((d) => ({ id: d.id, data: () => Object.assign({}, d) })) }),
      nbdTitleCount: () => {}, NBDJurisdiction: JB, _customerId: 'L1',
    }, extraWin || {});
    vm.createContext(ctx);
    let err = null;
    try { vm.runInContext(src.slice(a, b + 3), ctx); await ctx.window.loadInvoices('L1'); } catch (e) { err = e; }
    return { html: el.innerHTML, err };
  }
  {
    const hostedInv = { id: 'h', leadId: 'L1', status: 'sent', total: 5000, balanceDue: 5000, stripeHostedUrl: HOSTED };
    const r1 = await customerList([hostedInv], { _currentLead: ohLead });
    ok('customer page: a Stripe invoice (hosted URL only) shows its Pay button', !r1.err && r1.html.indexOf('href="' + HOSTED + '"') !== -1, r1.err && r1.err.message);
    const r2 = await customerList([hostedInv], { _currentLead: kyLeadHeld });
    ok('customer page: KY held → no Pay button', !r2.err && r2.html.indexOf(HOSTED) === -1);
    const r3 = await customerList([hostedInv], {});
    ok('customer page: no lead on the page → no Pay button (fail closed)', !r3.err && r3.html.indexOf(HOSTED) === -1);
  }

  // Surface: the invoice SMS / email (invoice-pipeline.js sendInvoice), run for real.
  if (IP) {
    ok('buildInvoiceHtml never reads the invoice\'s link fields itself (no payUrl → no Pay Online)',
      IP.buildInvoiceHtml({ total: 10, items: [], stripePaymentLink: PLINK, stripeHostedUrl: HOSTED }).indexOf('Pay Online') === -1
      && IP.buildInvoiceHtml({ total: 10, items: [] }, { payUrl: HOSTED }).indexOf('href="' + HOSTED + '"') !== -1);
    const base = { leadId: 'L1', status: 'draft', total: 5000, balanceDue: 5000, amountPaid: 0, customerPhone: '5135550142', customerEmail: 'delivered@resend.dev', items: [], stripeHostedUrl: HOSTED };
    {
      const B = browser({ 'invoices/i1': base, 'leads/L1': ohLead }, { _leads: [ohLead] });
      await IP.sendInvoice('i1', 'sms');
      ok('SMS: a Stripe invoice\'s hosted link reaches the text (Ohio)', B.sms.length === 1 && B.sms[0].message.indexOf(HOSTED) !== -1, JSON.stringify(B.sms));
    }
    {
      const B = browser({ 'invoices/i1': base, 'leads/L1': kyLeadHeld }, { _leads: [kyLeadHeld] });
      await IP.sendInvoice('i1', 'sms');
      ok('SMS: KY held → the text goes WITHOUT a link', B.sms.length === 1 && B.sms[0].message.indexOf('http') === -1, JSON.stringify(B.sms));
      const B2 = browser({ 'invoices/i1': base, 'leads/L1': kyLeadHeld }, { _leads: [kyLeadHeld] });
      await IP.sendInvoice('i1', 'email');
      ok('email: KY held → no Pay Online button in the invoice email', B2.emails.length === 1 && B2.emails[0].html.indexOf('Pay Online') === -1 && B2.emails[0].html.indexOf(HOSTED) === -1);
    }
    {
      // The lead cannot be read → fail closed.
      const B = browser({ 'invoices/i1': base }, { _leads: [] });
      await IP.sendInvoice('i1', 'sms');
      ok('SMS: lead unreadable → no link (fail closed)', B.sms.length === 1 && B.sms[0].message.indexOf('http') === -1);
    }
    {
      const r = await IP.homeownerPayUrl({ leadId: 'L1', stripeHostedUrl: HOSTED }, { J, readLead: async () => ohLead, now: new Date(NOW) });
      const h = await IP.homeownerPayUrl({ leadId: 'L1', stripeHostedUrl: HOSTED }, { J, readLead: async () => kyLeadHeld, now: new Date(NOW) });
      const t = await IP.homeownerPayUrl({ leadId: 'L1', stripeHostedUrl: HOSTED }, { J, readLead: async () => { throw new Error('x'); }, now: new Date(NOW) });
      ok('homeownerPayUrl (Copy Payment Link, SMS, email): OH → link, KY held → "", read error → ""', r === HOSTED && h === '' && t === '');
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n3. part paid → partial, owed, and "Send balance"');
  {
    const src = lf(read('functions/stripe.js'));
    const m = src.match(/\n\s*status: (fullyPaid \? 'paid' : [^\n]+),\n\s*paidAt: fullyPaid/);
    ok('stripe.js webhook: the credit status expression is liftable', !!m);
    if (m) {
      const st = (fullyPaid, newPaid, prior) => vm.runInNewContext('(' + m[1] + ')', { fullyPaid, newPaid, inv: { status: prior } });
      ok('stripe.js webhook: a deposit-sized card payment → partial (was: left "sent")', st(false, 3000, 'sent') === 'partial');
      ok('…paid off → paid; nothing received → unchanged', st(true, 10000, 'partial') === 'paid' && st(false, 0, 'sent') === 'sent');
    }
  }
  if (OWED && IP) {
    ok('partial counts as OWED under #2112\'s rule (server + browser copies)',
      OWED.isOwedInvoice({ status: 'partial' }) && IP.isOwedInvoice({ status: 'partial' }) && IP.owedDollarsOf({ status: 'partial', total: 10000, balanceDue: 7000 }) === 7000);
    ok('isPartPaid / canSendBalance: partial yes; legacy "sent" with money in yes; draft / paid / unpaid sent no',
      IP.canSendBalance({ status: 'partial', amountPaid: 3000, balanceDue: 7000 })
      && IP.canSendBalance({ status: 'sent', amountPaid: 3000, balanceDue: 7000 })
      && !IP.canSendBalance({ status: 'sent', amountPaid: 0, balanceDue: 7000 })
      && !IP.canSendBalance({ status: 'paid', amountPaid: 10000, balanceDue: 0 })
      && !IP.canSendBalance({ status: 'draft', amountPaid: 0, balanceDue: 7000 }));
    const partInv = { leadId: 'L1', status: 'sent', total: 10000, amountPaid: 3000, balanceDue: 7000, customerPhone: '5135550142', items: [], stripeHostedUrl: HOSTED, sentAt: '2026-09-01' };
    {
      const B = browser({ 'invoices/p1': partInv, 'leads/L1': ohLead }, { _leads: [ohLead] });
      let err = null;
      try { await IP.sendInvoice('p1', 'sms'); } catch (e) { err = e; }
      ok('Send balance on a part-paid "sent" invoice goes out (was: "Use Resend", a button that never existed)', !err && B.sms.length === 1, err && err.message);
      ok('…the text names the remaining balance', B.sms[0] && /remaining balance of \$7,000\.00/.test(B.sms[0].message), B.sms[0] && B.sms[0].message);
      ok('…and the invoice keeps its status (never back to draft)', B.store.get('invoices/p1').status === 'sent');
    }
    {
      const B = browser({ 'invoices/p2': Object.assign({}, partInv, { amountPaid: 0, balanceDue: 10000 }), 'leads/L1': ohLead }, { _leads: [ohLead] });
      let err = null;
      try { await IP.sendInvoice('p2', 'sms'); } catch (e) { err = e; }
      ok('positive control: an unpaid "sent" invoice is still refused as a double send', !!err && /already sent/i.test(err.message) && B.sms.length === 0);
    }
    {
      // A CRM payment link minted for the full amount is re-minted for the balance first.
      const B = browser({ 'invoices/p3': Object.assign({}, partInv, { status: 'partial', stripePaymentLink: PLINK, stripeHostedUrl: null }), 'leads/L1': ohLead }, { _leads: [ohLead] });
      await IP.sendInvoice('p3', 'sms');
      ok('Send balance re-mints the pay link for the balance (createStripePaymentLink) and texts the NEW link',
        B.fetches.length === 1 && /createStripePaymentLink/.test(B.fetches[0][0]) && B.sms[0] && B.sms[0].message.indexOf('test_balance_link') !== -1 && B.sms[0].message.indexOf(PLINK) === -1,
        JSON.stringify(B.sms));
    }
    {
      const r = await customerList([{ id: 'p', leadId: 'L1', status: 'partial', total: 10000, balanceDue: 7000 }, { id: 'u', leadId: 'L1', status: 'sent', total: 2000, balanceDue: 2000 }], { _currentLead: ohLead });
      ok('customer page: "Send balance" on the part-paid row only', /data-send-balance data-action="NBDCustomerInvoices\.sendBalance" data-arg="p"/.test(r.html) && !/sendBalance" data-arg="u"/.test(r.html));
      ok('customer page: Total Owed counts the partial balance', /Total Owed<\/div>\s*<div class="summary-value">\$9,000\.00/.test(r.html), r.html.slice(-400));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n4. no double billing — one live invoice per job, a final invoice credits the deposit');
  ok('nbd:job-billing is byte-identical in invoice-pipeline.js and functions/invoice-from-estimate.js',
    !!block(read('docs/pro/js/invoice-pipeline.js'), 'job-billing') && block(read('docs/pro/js/invoice-pipeline.js'), 'job-billing') === block(read('functions/invoice-from-estimate.js'), 'job-billing'));
  if (IFE) {
    const T = 1500000;
    const depDraft = { id: 'depdraft_L1_j1', status: 'draft', total: 15000, jobId: 'j1', autoDraft: { kind: 'deposit_on_sign' } };
    ok('a live invoice that bills the whole job (the deposit draft) → OPEN it, never a second', JSON.stringify(IFE.planJobInvoice(T, [depDraft], 'j1')) === JSON.stringify({ action: 'open', invoiceId: 'depdraft_L1_j1', reason: 'live_invoice' }));
    const paidDep = { id: 'd1', status: 'paid', total: 5000, amountPaid: 5000, jobId: 'j1' };
    const p = IFE.planJobInvoice(T, [paidDep], 'j1');
    ok('a PAID deposit-only invoice → create the final, crediting "Less deposit paid" $5,000', p.action === 'create' && p.creditCents === 500000 && p.credits[0].label === 'Less deposit paid');
    const issued = IFE.planJobInvoice(T, [{ id: 'd2', status: 'sent', total: 5000, amountPaid: 0, jobId: 'j1' }], 'j1');
    ok('an ISSUED (unpaid) deposit-only invoice is credited too ("Less deposit invoiced")', issued.action === 'create' && issued.credits[0].label === 'Less deposit invoiced' && issued.creditCents === 500000);
    ok('void / cancelled / deleted / another job\'s invoices are ignored',
      IFE.planJobInvoice(T, [{ id: 'v', status: 'void', total: 15000, jobId: 'j1' }, { id: 'o', status: 'draft', total: 15000, jobId: 'j2' }, { id: 'x', status: 'sent', total: 15000, jobId: 'j1', deleted: true }], 'j1').action === 'create');
    ok('the job already billed in full → open the last invoice, never bill again',
      IFE.planJobInvoice(T, [{ id: 'a', status: 'paid', total: 15000, amountPaid: 15000, jobId: 'j1' }], 'j1').reason === 'billed_in_full');
    const f = IFE.applyJobCredits({ items: [{ description: 'Roof', quantity: 1, unitPrice: 15000, total: 15000 }], subtotal: 15000, tax: 0, total: 15000 }, p.credits);
    const credit = f.items.find((i) => i.credit === true);
    ok('applyJobCredits: a "Less deposit paid" line of −$5,000 and total due $10,000 (cents-exact)',
      f.total === 10000 && f.creditTotal === 5000 && credit && credit.total === -5000 && /^Less deposit paid/.test(credit.description) && f.subtotal === 15000);
  }
  if (IP) {
    // createInvoiceFromEstimate in the browser, run for real.
    {
      const B = browser({ 'estimates/E1': perSq({ jobId: 'j1' }), 'leads/L1': Object.assign({}, ohLead, { activeJobId: 'j1' }),
        'invoices/depdraft_L1_j1': { leadId: 'L1', createdBy: 'u1', status: 'draft', total: 15000, jobId: 'j1' } });
      const r = await IP.createOrOpenJobInvoice('E1');
      ok('Create Invoice with the deposit draft live → opens the draft, writes NOTHING', r.reused === true && r.invoiceId === 'depdraft_L1_j1' && B.added.length === 0, JSON.stringify(r));
    }
    {
      const B = browser({ 'estimates/E1': perSq({ jobId: 'j1' }), 'leads/L1': Object.assign({}, ohLead, { activeJobId: 'j1' }),
        'invoices/d1': { leadId: 'L1', createdBy: 'u1', status: 'paid', total: 5000, amountPaid: 5000, jobId: 'j1' } });
      const r = await IP.createOrOpenJobInvoice('E1');
      const inv = B.added[0] || {};
      ok('Create Invoice after a paid $5,000 deposit → a FINAL invoice for $10,000 with a "Less deposit paid" line',
        r.reused === false && B.added.length === 1 && inv.total === 10000 && inv.balanceDue === 10000 && inv.kind === 'final'
        && inv.items.some((i) => i.credit === true && i.total === -5000) && inv.depositAmount === 0 && inv.creditTotal === 5000, JSON.stringify(inv).slice(0, 400));
    }
    {
      const src = lf(read('functions/stripe.js'));
      ok('createStripePaymentLink: credit lines are summed (never sent to Stripe as a negative line) and the balance is one line',
        /if \(item && item\.credit === true\)/.test(src) && /creditCents \+= -c;\s*\n\s*continue;/.test(src)
        && /reduce\(\s*\n?\s*\(sum, li\) => sum \+ li\.price_data\.unit_amount \* li\.quantity, 0\) - creditCents;/.test(src)
        && /if \(amountPaidCents > 0 \|\| creditCents > 0\)/.test(src));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n5. install complete → a DRAFT final invoice + "Send final invoice" task, idempotent per job');
  if (SL) {
    ok('enteredStage: a move onto install_complete counts; staying there, a legacy re-label, or a deleted lead does not',
      SL.enteredStage({ stage: 'crew_scheduled' }, { stage: 'install_complete' }, 'install_complete')
      && !SL.enteredStage({ stage: 'install_complete' }, { stage: 'install_complete', notes: 'x' }, 'install_complete')
      && !SL.enteredStage({ stage: 'Install Complete' }, { stage: 'install_complete' }, 'install_complete')
      && !SL.enteredStage({ stage: 'crew_scheduled' }, { stage: 'install_complete', deleted: true }, 'install_complete'));
  }
  if (D) {
    const lead = Object.assign({}, ohLead, { stage: 'install_complete', primaryEstimateId: 'E1', activeJobId: 'j1' });
    const live = D.decideFinalDraft({ leadId: 'L1', lead, est: perSq({ jobId: 'j1' }), estimateId: 'E1', nowMs: NOW,
      invoices: [{ id: 'depdraft_L1_j1', status: 'partial', total: 15000, amountPaid: 7500, balanceDue: 7500, jobId: 'j1' }] });
    ok('the deposit invoice (full total, part paid) is the job\'s bill → use it, no new invoice', live.action === 'use_existing' && live.invoiceId === 'depdraft_L1_j1');
    const fresh = D.decideFinalDraft({ leadId: 'L1', lead, est: perSq({ jobId: 'j1' }), estimateId: 'E1', nowMs: NOW, invoices: [] });
    ok('no invoice yet → a DRAFT final at the deterministic id finaldraft_L1_j1, nothing sent, Net 7 / due in 7 days',
      fresh.action === 'create' && fresh.invoiceId === 'finaldraft_L1_j1' && fresh.invoice.status === 'draft' && fresh.invoice.sentAt === null
      && fresh.invoice.stripePaymentLink === null && fresh.invoice.total === 15000 && /^Net 7\./.test(fresh.invoice.terms)
      && fresh.invoice.dueDate.getTime() === NOW + 7 * 864e5 && fresh.invoice.autoDraft.kind === 'final_on_install');
    const credited = D.decideFinalDraft({ leadId: 'L1', lead, est: perSq({ jobId: 'j1' }), estimateId: 'E1', nowMs: NOW,
      invoices: [{ id: 'dep', status: 'paid', total: 4000, amountPaid: 4000, jobId: 'j1' }] });
    ok('a paid deposit-only invoice → the final credits it ("Less deposit paid"), total due $11,000',
      credited.action === 'create' && credited.invoice.total === 11000 && credited.invoice.items.some((i) => i.credit && i.total === -4000) && credited.invoice.creditedInvoiceIds[0] === 'dep');
    ok('no estimate → never guesses an amount (skip no_estimate)', D.decideFinalDraft({ leadId: 'L1', lead: Object.assign({}, lead, { primaryEstimateId: null }), invoices: [] }).reason === 'no_estimate');
  }
  if (DD && SPINE && IFI) {
    const seed = () => ({
      'leads/L1': Object.assign({}, ohLead, { stage: 'install_complete', primaryEstimateId: 'E1', activeJobId: 'j1' }),
      'estimates/E1': perSq({ jobId: 'j1' }),
    });
    const db = makeDb(seed());
    const invs = () => [...db.store.keys()].filter((k) => /^invoices\/[^/]+$/.test(k));
    const r1 = await DD.draftFinalAtInstall(db, { leadId: 'L1', sourceId: 's' }, deps);
    const task = db.store.get('leads/L1/tasks/send-final-invoice-j1');
    ok('draftFinalAtInstall: ONE draft final invoice + ONE "Send final invoice" task',
      r1.created === true && invs().length === 1 && db.store.get('invoices/finaldraft_L1_j1').status === 'draft'
      && task && task.text === '🧾 Send final invoice' && task.invoiceId === 'finaldraft_L1_j1' && task.done === false);
    const n = db.writes.length;
    const r2 = await DD.draftFinalAtInstall(db, { leadId: 'L1', sourceId: 's' }, deps);
    ok('…a retry / re-entered stage writes NOTHING (idempotent per job)', r2.created === false && db.writes.length === n && invs().length === 1);
    ok('…only invoices/ and the lead\'s tasks were written — no mail, sms or Stripe doc', db.writes.every((w) => /^invoices\/finaldraft_L1_j1$/.test(w[1]) || /^leads\/L1\/tasks\//.test(w[1])));

    // Through the lead trigger → spine → draft, twice.
    const db2 = makeDb(Object.assign(seed(), { 'leads/L1': Object.assign({}, ohLead, { stage: 'crew_scheduled', primaryEstimateId: 'E1', activeJobId: 'j1', jobType: 'cash' }) }));
    const before = db2.store.get('leads/L1');
    const after = Object.assign({}, before, { stage: 'install_complete' });
    db2.store.set('leads/L1', after);
    const t1 = await IFI._internal.onLeadWrite(db2, 'L1', before, after, deps);
    ok('lead enters Install Done (a client stage move) → spine "installed" → the draft final invoice',
      t1 && t1.finalDraft && t1.finalDraft.created === true && db2.store.has('invoices/finaldraft_L1_j1') && db2.store.has('job_events/L1__installed__stage_install_complete_j1'), JSON.stringify(t1));
    const t2 = await IFI._internal.onLeadWrite(db2, 'L1', before, after, deps);
    ok('…the trigger re-delivered: spine duplicate, still ONE invoice and ONE task',
      t2.duplicate === true && t2.finalDraft.created === false && [...db2.store.keys()].filter((k) => /^invoices\//.test(k)).length === 1
      && [...db2.store.keys()].filter((k) => /send-final-invoice/.test(k)).length === 1);
    const t3 = await IFI._internal.onLeadWrite(db2, 'L1', after, Object.assign({}, after, { notes: 'x' }), deps);
    ok('…a later unrelated write to the lead does nothing', t3.skipped === 'not_entered');
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n6a. ONE due date');
  if (DR) {
    ok('deposit-rule.js copies are byte-identical; INVOICE_DUE_DAYS = 7 (Jo, 2026-09-30); Net 7.',
      lf(read('docs/pro/js/deposit-rule.js')) === lf(read('functions/deposit-rule.js')) && DR.INVOICE_DUE_DAYS === 7 && DR.netTermsText() === 'Net 7.'
      && DR.invoiceDueDateMs(NOW) === NOW + 7 * 864e5);
    ok('the Stripe invoice reads it (stripe-crm-invoice.js days_until_due), and the CRM doc takes Stripe\'s due date at mint',
      /days_until_due: require\('\.\/deposit-rule'\)\.INVOICE_DUE_DAYS,/.test(read('functions/stripe-crm-invoice.js'))
      && /finPatch\.dueDate = new Date\(Number\(fin\.due_date\) \* 1000\)/.test(read('functions/stripe-crm-invoice.js')));
    ok('no "Net 14" / 14-day due date left on any invoice writer',
      !/Net 14|14 \* 24 \* 60 \* 60 \* 1000/.test(read('docs/pro/js/invoice-pipeline.js') + read('functions/deposit-draft-logic.js')));
    // 3 (2026-10-06): createInvoice, the deposit draft, and _sentPatch's
    // first-send re-date (review round 4 R4-6-4).
    ok('the sandbox fallbacks in invoice-pipeline.js equal INVOICE_DUE_DAYS',
      (lf(read('docs/pro/js/invoice-pipeline.js')).match(/\+ 7 \* 86400000/g) || []).length === 3 && DR.INVOICE_DUE_DAYS === 7);
    if (MPL) {
      const pay = MPL.invoicePayload({ total: 100, items: [], amountPaid: 0 }, null, 'NBD-1', NOW, null);
      const want = new Date(NOW + 7 * 864e5).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
      ok('the NBD-500 PDF states the same due date', !!pay.invoice.dueDate && pay.invoice.dueDate === pay.projectMeta.find((m) => m.label === 'Due').value, pay.invoice.dueDate + ' vs ' + want);
    }
  }

  console.log('\n6b. one timeline line per payment, every path, idempotent per payment id');
  ok('nbd:payment-timeline is byte-identical in invoice-pipeline.js and functions/payment-timeline.js',
    !!block(read('docs/pro/js/invoice-pipeline.js'), 'payment-timeline') && block(read('docs/pro/js/invoice-pipeline.js'), 'payment-timeline') === block(read('functions/payment-timeline.js'), 'payment-timeline'));
  if (PTL && IP) {
    const manual = { amount: 1000, method: 'check', reference: '1042', payer: 'insurance', paymentId: 'mp_abc', at: '2026-10-02T12:00:00Z' };
    const card = { amount: 2500, method: 'stripe', paymentIntentId: 'pi_123', at: '2026-10-02T13:00:00Z' };
    const ledger = { amount: 700, method: 'card', source: 'stripe_ledger', stripeRef: 'ch_9', at: '2026-10-02T14:00:00Z' };
    ok('the note id comes from the payment\'s own id — the browser and the server agree',
      IP.paymentTimelineNoteId('inv1', manual) === PTL.noteIdFor('inv1', manual) && PTL.noteIdFor('inv1', card) === 'pay-inv1-pi_123' && PTL.noteIdFor('inv1', ledger) === 'pay-inv1-ch_9');
    ok('the line says what came in, how, and from whom', IP.paymentTimelineText('inv1', manual) === '💵 Payment received: $1,000.00 by check #1042 from the insurance carrier — invoice inv1.');
    const db = makeDb({ 'leads/L1': { userId: 'u1' } });
    // Every writer stamps createdBy + companyId; the note goes only onto a
    // lead of the invoice's own company (R3-6, 2026-10-06).
    const before = { leadId: 'L1', createdBy: 'u1', companyId: 'u1', payments: [] };
    const after = { leadId: 'L1', createdBy: 'u1', companyId: 'u1', payments: [manual, card, ledger] };
    const w1 = await PTL.writePaymentTimeline(db, 'inv1', before, after, { FieldValue: FV });
    const notes = () => [...db.store.keys()].filter((k) => /^notes\//.test(k));
    ok('Mark Paid / webhook / ledger entries → three timeline lines on the lead', w1.written === 3 && notes().length === 3 && db.store.get('notes/pay-inv1-pi_123').leadId === 'L1' && db.store.get('notes/pay-inv1-pi_123').userId === 'u1', JSON.stringify(w1));
    const w2 = await PTL.writePaymentTimeline(db, 'inv1', before, after, { FieldValue: FV });
    ok('the same write re-delivered → no second line', w2.written === 0 && w2.existing === 3 && notes().length === 3);
    const w3 = await PTL.writePaymentTimeline(db, 'inv1', after, Object.assign({}, after, { status: 'paid' }), { FieldValue: FV });
    ok('a later write that adds no payment → nothing', w3.skipped === 'no_new_payment' && notes().length === 3);
    const legacy = { amount: 50, method: 'cash', at: '2026-01-01T12:00:00Z' };
    ok('a legacy entry with no id gets a stable content hash (same id twice)', PTL.noteIdFor('inv1', legacy) === PTL.noteIdFor('inv1', Object.assign({}, legacy)) && /^pay-inv1-h[0-9a-f]{16}$/.test(PTL.noteIdFor('inv1', legacy)));
    // The invoice trigger calls it on a real write, and never on history.
    const MP = req('functions/money-paper.js');
    if (MP && MP._internal && typeof MP._internal.handle === 'function') {
      const seen = [];
      const fake = { db: makeDb({}), now: () => NOW, recordJobEvent: async () => ({}), writePaymentTimeline: async (d, id, b, a) => { seen.push([id, !!b]); return { written: 1, existing: 0, ids: [] }; } };
      process.env.NBD_MONEY_PAPER = 'off';
      await MP._internal.handle('invX', { leadId: 'L1', status: 'partial', payments: [card] }, fake, { leadId: 'L1', status: 'sent', payments: [] });
      await MP._internal.handle('invY', { leadId: 'L1', payments: [card] }, fake, undefined);
      delete process.env.NBD_MONEY_PAPER;
      ok('moneyPaperOnInvoice writes the timeline on a real write (kill switch or not), never when it cannot see before', seen.length === 1 && seen[0][0] === 'invX');
    } else {
      ok('money-paper.js exposes handle for tests', false, 'no MP._internal.handle');
    }
    // The browser's Mark Paid writes the same note.
    const B = browser({ 'invoices/m1': { leadId: 'L1', status: 'sent', total: 10000, amountPaid: 0, balanceDue: 10000 } });
    await IP.markPaid('m1', '4000', 'zelle', { at: new Date('2026-10-02T12:00:00'), reference: 'Z1', payer: 'homeowner', paymentId: 'mp_z1' });
    const inv = B.store.get('invoices/m1');
    ok('Mark Paid: payment recorded (status partial, $6,000 left) with payer + paymentId',
      inv.status === 'partial' && inv.balanceDue === 6000 && inv.payments[0].payer === 'homeowner' && inv.payments[0].paymentId === 'mp_z1');
    ok('Mark Paid: ONE timeline note at the shared id', B.sets.length === 1 && B.sets[0][0] === 'notes/pay-m1-mp_z1' && B.sets[0][1].leadId === 'L1' && /by Zelle #Z1 from the homeowner/.test(B.sets[0][1].text));
    ok('Mark Paid: no receipt email without a customer email (behaviour unchanged)', B.emails.length === 0);
  }

  console.log('\n6c. overdue → an INTERNAL task for the rep, nothing to the customer');
  if (OVL && OV) {
    const base = { id: 'o1', leadId: 'L1', status: 'partial', total: 10000, balanceDue: 6000, dueDate: '2026-09-20T12:00:00Z' };
    ok('a part-paid invoice past due → due (partial is owed)', OVL.decideOverdue(base, ohLead, NOW).due === true);
    ok('draft / paid / void → never', ['draft', 'paid', 'void'].every((s) => OVL.decideOverdue(Object.assign({}, base, { status: s }), ohLead, NOW).due === false));
    ok('due today → not yet; KY held → skipped',
      OVL.decideOverdue(Object.assign({}, base, { dueDate: '2026-10-03T12:00:00Z' }), ohLead, NOW).reason === 'not_yet'
      && OVL.decideOverdue(base, kyLeadHeld, NOW).reason === 'ky_hold');
    const db = makeDb({ 'invoices/o1': base, 'invoices/o2': Object.assign({}, base, { status: 'paid', balanceDue: 0 }), 'leads/L1': ohLead });
    const r1 = await OV._internal.runOverdueSweep(db, NOW, { logger: quiet, FieldValue: FV });
    const r2 = await OV._internal.runOverdueSweep(db, NOW, { logger: quiet, FieldValue: FV });
    const t = db.store.get('leads/L1/tasks/invoice-overdue-o1');
    ok('the sweep files ONE task per overdue invoice; the next run is a no-op',
      r1.created === 1 && r2.created === 0 && r2.existing === 1 && t && t.internalOnly === true && /nothing was sent to the customer/.test(t.notes));
    ok('…and writes nothing but that task', db.writes.every((w) => /^leads\/L1\/tasks\/invoice-overdue-o1$/.test(w[1])));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n1. Record payment on a job with no invoice');
  if (IP) {
    ok('methods: check, Zelle, cash, card (not Stripe), ACH (not Stripe), other', IP.PAYMENT_METHODS.map((m) => m.key).join(',') === 'check,zelle,cash,card,ach,other');
    ok('payers: homeowner, insurance carrier, mortgage company', IP.PAYERS.map((p) => p.key).join(',') === 'homeowner,insurance,mortgage');
    const e = IP.buildManualPaymentEntry({ amount: '1,234.56', method: 'card', at: new Date(NOW), payer: 'mortgage', recordedBy: 'u1' });
    ok('the ledger entry keeps payer + a paymentId; amount in dollars from cents', e.payer === 'mortgage' && /^mp_/.test(e.paymentId) && e.amount === 1234.56);
    ok('an unknown payer is dropped, not stored', !('payer' in IP.buildManualPaymentEntry({ amount: 5, method: 'cash', at: new Date(NOW), payer: '<b>' })));
    const live = { id: 'a', status: 'sent', total: 5000, jobId: 'j1' };
    ok('target: the job\'s live invoice when there is one', IP.recordPaymentTarget({ lead: { activeJobId: 'j1' }, invoices: [live] }).kind === 'existing');
    ok('target: no invoice + an estimate → make it from the estimate', JSON.stringify(IP.recordPaymentTarget({ lead: {}, invoices: [], estimate: perSq(), estimateId: 'E1' })) === JSON.stringify({ kind: 'estimate', estimateId: 'E1', totalCents: 1500000, jobId: null }));
    ok('target: no invoice, no estimate → the rep confirms a total (jobValue only SUGGESTED)',
      JSON.stringify(IP.recordPaymentTarget({ lead: { jobValue: 8200 }, invoices: [] })) === JSON.stringify({ kind: 'jobValue', suggestedCents: 820000, jobId: null })
      && IP.recordPaymentTarget({ lead: {}, invoices: [] }).suggestedCents === 0);
    const doc = IP.jobValueInvoiceDoc({ lead: ohLead, leadId: 'L1', totalCents: 820000, jobId: 'j1', uid: 'u1', depRule: DR, J, now: new Date(NOW) });
    ok('the confirmed-total invoice: $8,200 one line, owed in full, Net 7, owner + tenant, who confirmed it',
      doc.total === 8200 && doc.balanceDue === 8200 && doc.items.length === 1 && doc.status === 'draft' && doc.terms === 'Net 7.'
      && doc.createdBy === 'u1' && doc.companyId === 'u1' && doc.jobId === 'j1' && doc.totalConfirmedBy === 'u1' && doc.customerName === 'Pat Jones' && doc.source === 'record_payment');
    let threw = false; try { IP.jobValueInvoiceDoc({ lead: ohLead, totalCents: 0 }); } catch (_) { threw = true; }
    ok('never a $0 invoice', threw);
    // Receipts (Jo, 2026-10-04 — supersedes the 2026-10-03 "Email a receipt"
    // box): recording a payment NEVER emails the customer, from any caller.
    // The payment gets a receipt DRAFT; "Send receipt" sends it
    // (tests/receipts-zelle-ach-2026-10-04.test.js).
    {
      const withEmail = Object.assign({}, ohLead, { email: 'delivered@resend.dev' });
      const run = async (sendReceipt) => {
        const B = browser({ 'leads/L1': withEmail, 'invoices/r1': { leadId: 'L1', createdBy: 'u1', status: 'sent', total: 8200, amountPaid: 0, balanceDue: 8200, customerEmail: 'delivered@resend.dev', jobId: null } });
        const args = { leadId: 'L1', lead: withEmail, target: IP.recordPaymentTarget({ lead: withEmail, invoices: [{ id: 'r1', status: 'sent', total: 8200 }] }),
          amount: '3000', method: 'check', payer: 'insurance', at: new Date(NOW), reference: '1042' };
        if (sendReceipt !== undefined) args.sendReceipt = sendReceipt;
        await IP.recordPaymentCommit(args);
        return B;
      };
      const off = await run(undefined);
      ok('Record payment → payment recorded, NO email, receipt drafted on the payment',
        off.emails.length === 0 && off.store.get('invoices/r1').amountPaid === 3000 && off.store.get('invoices/r1').payments[0].receipt.status === 'draft');
      const on = await run(true);
      ok('…even a caller passing sendReceipt:true sends nothing (the flag is gone)', on.emails.length === 0);
      const B = browser({ 'invoices/r2': { leadId: 'L1', status: 'sent', total: 100, amountPaid: 0, balanceDue: 100, customerEmail: 'delivered@resend.dev' } });
      await IP.markPaid('r2', '50', 'cash', { at: new Date(NOW) });
      ok('markPaid from any other caller: no email either (was: one automatic receipt)', B.emails.length === 0);
      const sheet = lf(read('docs/pro/js/invoice-pipeline.js')).split('async function recordPaymentUI')[1].split('// ═══')[0];
      ok('the sheet has no "Email a receipt" box any more — it says a receipt is drafted',
        !/nbd-rp-receipt/.test(sheet) && !/sendReceipt/.test(sheet) && /data-rp-receipt-note/.test(sheet));
    }
    const r = await customerList([], { _currentLead: ohLead });
    ok('customer page: a "Record payment" button even with no invoices', /data-rp-open data-action="NBDCustomerInvoices\.recordPayment" data-arg="L1"/.test(r.html) && /No invoices yet/.test(r.html));
    const css = read('docs/pro/css/invoice-pipeline.css');
    ok('every target in the sheet is at least 44px (CSS), and the sheet carries no inline style',
      /\.ipx-rp-pick[^{]*\{[^}]*min-height: 44px/.test(css) && /\.ipx-rp-input[^{]*\{[^}]*min-height: 44px/.test(css) && /\.ipx-rp-confirm[^{]*\{[^}]*min-height: 44px/.test(css)
      && /\.ipx-rp-open[^{]*\{[^}]*min-height: 44px/.test(css)
      && !/style="/.test(lf(read('docs/pro/js/invoice-pipeline.js')).split('async function recordPaymentUI')[1].split('// ═══')[0]));
    ok('role gate: a viewer cannot record a payment or send a balance',
      /'NBDCustomerInvoices\.recordPayment', 'NBDCustomerInvoices\.sendBalance'/.test(read('docs/pro/js/role-gate.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
