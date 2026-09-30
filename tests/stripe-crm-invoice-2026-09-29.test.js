/**
 * tests/stripe-crm-invoice-2026-09-29.test.js
 *
 * A CRM invoice becomes a real Stripe Invoice for the platform tenant
 * (functions/stripe-crm-invoice.js, called from createStripePaymentLink), and
 * a payment on it books itself onto that CRM invoice through the Stripe
 * ledger. A fake Stripe records every call so the ORDER is checked too (the
 * CRM invoice is linked before the Stripe invoice is finalized). Synthetic
 * data only.
 *
 * Run: node tests/stripe-crm-invoice-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
process.env.NBD_OWNER_UID = 'OWNER';
const M = require(path.join(__dirname, '..', 'functions', 'stripe-crm-invoice.js'));
const ledger = require(path.join(__dirname, '..', 'functions', 'stripe-ledger.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const ORDER = []; // one timeline across Firestore writes and Stripe calls
function makeDb(seed) {
  const cols = new Map();
  const col = (n) => { if (!cols.has(n)) cols.set(n, new Map()); return cols.get(n); };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  let auto = 0;
  const log = [];
  function ref(n, id) {
    return {
      id,
      async get() { const d = col(n).get(id); return { id, exists: !!d, data: () => clone(d), ref: ref(n, id) }; },
      async set(d, o) { log.push(['set', n, id]); const p = col(n).get(id); col(n).set(id, o && o.merge && p ? Object.assign(clone(p), clone(d)) : clone(d)); },
      async update(p) { log.push(['update', n, id, Object.keys(p)]); ORDER.push('db.update:' + n + '/' + id + ':' + Object.keys(p).join(',')); const prev = col(n).get(id); if (!prev) throw new Error('no doc'); col(n).set(id, Object.assign(clone(prev), clone(p))); },
    };
  }
  function q(n, fl) {
    return {
      where(f, op, v) { return q(n, fl.concat([[f, v]])); },
      async get() { const docs = [...col(n).entries()].filter(([, d]) => fl.every(([f, v]) => d[f] === v)).map(([id]) => ({ id, ref: ref(n, id), data: () => clone(col(n).get(id)) })); return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) }; },
    };
  }
  const db = {
    collection(n) { return Object.assign(q(n, []), { doc: (id) => ref(n, id || ('auto' + (++auto))) }); },
    async runTransaction(fn) { const ops = []; const tx = { get: (r) => r.get(), set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, p) => ops.push(() => r.update(p)) }; const out = await fn(tx); for (const o of ops) await o(); return out; },
    _get: (n, id) => clone(col(n).get(id)),
    _all: (n) => [...col(n).entries()].map(([id, d]) => Object.assign({ id }, clone(d))),
    _log: log,
  };
  for (const [n, docs] of Object.entries(seed || {})) for (const d of docs) col(n).set(d.id, clone(d));
  return db;
}

function makeStripe(opts) {
  const o = opts || {};
  const calls = [];
  const invoices = new Map(Object.entries(o.invoices || {}));
  let n = 0;
  const s = {
    calls,
    customers: {
      list: async (q) => { calls.push(['customers.list', q]); return { data: (o.customersByEmail || {})[q.email] ? [{ id: o.customersByEmail[q.email] }] : [] }; },
      create: async (d, k) => { calls.push(['customers.create', d, k]); return { id: 'cus_new' }; },
      update: async (id, d) => { calls.push(['customers.update', id, d]); return { id }; },
    },
    invoices: {
      retrieve: async (id) => { calls.push(['invoices.retrieve', id]); return invoices.get(id); },
      voidInvoice: async (id) => { calls.push(['invoices.voidInvoice', id]); return Object.assign({}, invoices.get(id), { status: 'void' }); },
      del: async (id) => { calls.push(['invoices.del', id]); return { id, deleted: true }; },
      create: async (d, k) => { calls.push(['invoices.create', d, k]); const id = 'in_new' + (++n); invoices.set(id, { id, status: 'draft', items: [], metadata: d.metadata }); return { id, status: 'draft' }; },
      finalizeInvoice: async (id, d) => {
        calls.push(['invoices.finalizeInvoice', id, d]); ORDER.push('stripe.finalize');
        const inv = invoices.get(id);
        const due = o.finalAmountOverride != null ? o.finalAmountOverride : inv.items.reduce((a, it) => a + it.amount, 0);
        return { id, status: 'open', amount_due: due, amount_remaining: due, number: 'ZZQA-0001', hosted_invoice_url: 'https://invoice.stripe.test/' + id, invoice_pdf: 'https://pay.stripe.test/pdf/' + id };
      },
      sendInvoice: async (id) => { calls.push(['invoices.sendInvoice', id]); return {}; },
    },
    invoiceItems: { create: async (d, k) => { calls.push(['invoiceItems.create', d, k]); invoices.get(d.invoice).items.push(d); return { id: 'ii_' + calls.length }; } },
  };
  return s;
}

const baseInvoice = { id: 'CRM1', leadId: 'L1', companyId: 'OWNER', createdBy: 'OWNER', customerName: 'ZZ_QA Homeowner', customerEmail: 'hw@example.com', customerPhone: '5135550100', total: 1825, amountPaid: 0, balanceDue: 1825, status: 'draft' };
const lineItems = [
  { price_data: { currency: 'usd', product_data: { name: 'Siding repair', description: 'LP SmartSide' }, unit_amount: 180000 }, quantity: 1 },
  { price_data: { currency: 'usd', product_data: { name: 'Caulk tubes' }, unit_amount: 1250 }, quantity: 2 },
];
const argsFor = (inv) => ({ invoiceId: inv.id, invoice: inv, tenantId: 'OWNER', uid: 'OWNER', lineItems, balanceDueCents: 182500 });
const names = (s) => s.calls.map((c) => c[0]);

(async () => {
  console.log('\n1. line items');
  {
    const it = M.invoiceItemsFrom(lineItems.concat([{ price_data: { unit_amount: 0, product_data: { name: 'Free' } }, quantity: 1 }]));
    ok('one invoice item per line, amount = unit × qty', it.length === 2 && it[0].amount === 180000 && it[1].amount === 2500);
    ok('quantity and description survive in the text', it[1].description === 'Caulk tubes (×2)' && /LP SmartSide/.test(it[0].description));
    ok('a $0 line is dropped', !it.some((x) => /Free/.test(x.description)));
  }

  console.log('\n2. a new customer, first invoice');
  {
    const db = makeDb({ leads: [{ id: 'L1', companyId: 'OWNER', customerId: 'NBD-0999' }], invoices: [baseInvoice] });
    const st = makeStripe();
    const r = await M.mintCrmStripeInvoice(st, db, argsFor(baseInvoice));
    const create = st.calls.find((c) => c[0] === 'invoices.create')[1];
    ok('returns the Stripe invoice page (the Pay Online button opens it)', r.url === 'https://invoice.stripe.test/in_new1' && r.id === 'in_new1' && r.reused === false);
    ok('customer created with the CRM ids on it', st.calls.find((c) => c[0] === 'customers.create')[1].metadata.nbd_lead_id === 'L1'
      && st.calls.find((c) => c[0] === 'customers.create')[1].metadata.nbd_customer_id === 'NBD-0999');
    ok('...and remembered on the lead', db._get('leads', 'L1').stripeCustomerId === 'cus_new');
    // 14 → 7 days on 2026-09-30 (Jo's live-CRM handoff #7).
    ok('a send_invoice invoice, due in 7 days, NOT auto-advanced (Stripe does not email it)', create.collection_method === 'send_invoice' && create.days_until_due === 7 && create.auto_advance === false);
    ok('tagged with the CRM invoice + lead + source for the ledger', create.metadata.invoiceId === 'CRM1' && create.metadata.leadId === 'L1' && create.metadata.source === 'crm');
    ok('no payment_method_types → the account decides (ACH appears once activated)', !('payment_method_types' in create) && !create.payment_settings);
    ok('the Zelle / check footer is on it', /Zelle/.test(create.footer) && /check/.test(create.footer));
    ok('Stripe never sends it', !names(st).includes('invoices.sendInvoice'));
    const linkAt = ORDER.findIndex((e) => e.startsWith('db.update:invoices/CRM1:') && e.includes('stripeInvoiceId'));
    const finAt = ORDER.indexOf('stripe.finalize');
    ok('the CRM invoice is linked to the in_ id BEFORE Stripe finalizes it', linkAt > -1 && finAt > -1 && linkAt < finAt, JSON.stringify(ORDER));
    const crm = db._get('invoices', 'CRM1');
    ok('the CRM invoice carries the Stripe id, page, PDF, number', crm.stripeInvoiceId === 'in_new1' && crm.stripeHostedUrl && crm.stripePdfUrl && crm.stripeInvoiceNumber === 'ZZQA-0001');
    ok('invoice creation is idempotent per balance + prior invoice', /^nbd-crm-inv-CRM1-182500-none$/.test(st.calls.find((c) => c[0] === 'invoices.create')[2].idempotencyKey));
  }

  console.log('\n3. an existing customer');
  {
    const db = makeDb({ leads: [{ id: 'L1', companyId: 'OWNER', stripeCustomerId: 'cus_linked' }], invoices: [baseInvoice] });
    const st = makeStripe();
    await M.mintCrmStripeInvoice(st, db, argsFor(baseInvoice));
    ok('a lead already linked to a Stripe customer reuses it', !names(st).includes('customers.create') && st.calls.find((c) => c[0] === 'invoices.create')[1].customer === 'cus_linked');
    ok('...and tags it with the CRM ids', st.calls.some((c) => c[0] === 'customers.update' && c[1] === 'cus_linked' && c[2].metadata.nbd_lead_id === 'L1'));
    const db2 = makeDb({ leads: [{ id: 'L1', companyId: 'OWNER' }], invoices: [baseInvoice] });
    const st2 = makeStripe({ customersByEmail: { 'hw@example.com': 'cus_byemail' } });
    await M.mintCrmStripeInvoice(st2, db2, argsFor(baseInvoice));
    ok('an existing Stripe customer with the same email is reused, not duplicated', !names(st2).includes('customers.create') && db2._get('leads', 'L1').stripeCustomerId === 'cus_byemail');
  }

  console.log('\n4. the balance changed (a check came in) — never a stale amount');
  {
    const withPrior = (status, remaining, paid) => Object.assign({}, baseInvoice, { stripeInvoiceId: 'in_old' });
    let db = makeDb({ leads: [{ id: 'L1', companyId: 'OWNER', stripeCustomerId: 'cus_linked' }], invoices: [withPrior()] });
    let st = makeStripe({ invoices: { in_old: { id: 'in_old', status: 'open', amount_remaining: 182500, amount_paid: 0, hosted_invoice_url: 'https://invoice.stripe.test/in_old', invoice_pdf: 'x' } } });
    let r = await M.mintCrmStripeInvoice(st, db, argsFor(withPrior()));
    ok('an open invoice already asking for this exact balance is reused', r.reused === true && r.id === 'in_old' && !names(st).includes('invoices.create'));
    db = makeDb({ leads: [{ id: 'L1', companyId: 'OWNER', stripeCustomerId: 'cus_linked' }], invoices: [withPrior()] });
    st = makeStripe({ invoices: { in_old: { id: 'in_old', status: 'open', amount_remaining: 182500, amount_paid: 0 } } });
    r = await M.mintCrmStripeInvoice(st, db, Object.assign(argsFor(withPrior()), { balanceDueCents: 82500, lineItems: [{ price_data: { unit_amount: 82500, product_data: { name: 'Balance due' } }, quantity: 1 }] }));
    ok('a different balance → the old unpaid invoice is voided first', names(st).indexOf('invoices.voidInvoice') > -1 && names(st).indexOf('invoices.voidInvoice') < names(st).indexOf('invoices.create'));
    ok('...and the new one is for the new balance, keyed off the old one', r.id !== 'in_old' && /-82500-in_old$/.test(st.calls.find((c) => c[0] === 'invoices.create')[2].idempotencyKey));
    db = makeDb({ leads: [{ id: 'L1', companyId: 'OWNER', stripeCustomerId: 'cus_linked' }], invoices: [withPrior()] });
    st = makeStripe({ invoices: { in_old: { id: 'in_old', status: 'draft' } } });
    await M.mintCrmStripeInvoice(st, db, argsFor(withPrior()));
    ok('an abandoned draft is deleted, not left lying around', names(st).includes('invoices.del'));
  }

  console.log('\n5. a total that does not add up is never left payable');
  {
    const db = makeDb({ leads: [{ id: 'L1', companyId: 'OWNER' }], invoices: [baseInvoice] });
    const st = makeStripe({ finalAmountOverride: 999 });
    let threw = false;
    try { await M.mintCrmStripeInvoice(st, db, argsFor(baseInvoice)); } catch (e) { threw = /voided/.test(e.message); }
    ok('finalized amount ≠ balance → voided and refused', threw && names(st).lastIndexOf('invoices.voidInvoice') > names(st).indexOf('invoices.finalizeInvoice'));
  }

  console.log('\n6. paying it books onto THAT CRM invoice (no mirror, no review)');
  {
    const crmInv = Object.assign({}, baseInvoice, { stripeInvoiceId: 'in_crm', status: 'sent' });
    const db = makeDb({
      leads: [{ id: 'L1', companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: 'Homeowner' }],
      invoices: [crmInv],
    });
    const sInv = { id: 'in_crm', object: 'invoice', status: 'paid', billing_reason: 'manual', subscription: null, total: 182500, amount_paid: 182500,
      metadata: { invoiceId: 'CRM1', leadId: 'L1', source: 'crm' }, number: 'ZZQA-0001', custom_fields: [], lines: { data: [] }, hosted_invoice_url: 'u', created: 1789600000 };
    const ch = { id: 'ch_crm', object: 'charge', status: 'succeeded', amount: 182500, amount_captured: 182500, created: 1789700000,
      balance_transaction: { fee: 5323, net: 177177 }, payment_intent: { id: 'pi_crm', metadata: {} }, invoice: sInv, metadata: {},
      payment_method_details: { type: 'us_bank_account' }, customer: { id: 'cus_zz', name: 'Someone Else Entirely', email: 'different@example.com', metadata: {} }, billing_details: {} };
    ledger._internal.setStripe({ charges: { retrieve: async () => ch } });
    const ctx = await ledger._internal.loadContext(db);
    const res = await ledger._internal.ingestCharge(ctx, ch);
    const after = db._get('invoices', 'CRM1');
    ok('matched by the invoice\'s own lead id, even with a different name/email on the card', res.match.leadId === 'L1' && res.match.method === 'metadata');
    ok('booked onto the CRM invoice it was made from — paid', after.balanceDue === 0 && after.status === 'paid' && after.payments.length === 1 && after.payments[0].method === 'us_bank_account');
    ok('no mirror invoice created', db._all('invoices').length === 1);
    ledger._internal.setStripe({ invoices: { retrieve: async () => Object.assign({}, sInv, { status: 'open', amount_paid: 0 }) } });
    await ledger._internal.ingestInvoice(await ledger._internal.loadContext(db), 'in_crm');
    ok('its invoice.finalized/open event does not mirror it either', db._all('invoices').length === 1);
  }

  console.log('\n7. wiring in createStripePaymentLink');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'stripe.js'), 'utf8');
    const branch = src.indexOf("require('./stripe-crm-invoice').mintCrmStripeInvoice");
    ok('the Stripe-invoice branch exists', branch > -1);
    ok('only for the platform tenant, never a Connect tenant, with an off switch',
      /if \(!connectState && isPlatformTenant\(decoded\) && process\.env\.NBD_CRM_STRIPE_INVOICES !== 'off'\)/.test(src));
    ok('it runs AFTER the Kentucky hold and the balance check',
      branch > src.indexOf('KY_CANCELLATION_WINDOW') && branch > src.indexOf('balanceDueCents < MIN_CENTS'));
    ok('...and before a payment link would be minted', branch < src.indexOf('await stripe.paymentLinks.create({'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
