/**
 * tests/stripe-ledger-ingest-2026-09-29.test.js
 *
 * The Stripe ledger's orchestration (functions/stripe-ledger.js) against an
 * in-memory Firestore and a fake Stripe account: what gets written where,
 * that nothing is ever counted twice (webhook retry, nightly reconcile,
 * backfill, a payment Jo already marked paid by hand), and that a dry run
 * writes nothing. The matching rules themselves are covered by
 * stripe-ledger-logic-2026-09-29.test.js. Synthetic data only.
 *
 * Run: node tests/stripe-ledger-ingest-2026-09-29.test.js
 */
'use strict';

const path = require('path');
process.env.NBD_OWNER_UID = 'OWNER';
const ledger = require(path.join(__dirname, '..', 'functions', 'stripe-ledger.js'));
const { _internal: X } = ledger;

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// ── a small in-memory Firestore ─────────────────────────────────────────
function makeDb(seed) {
  const cols = new Map();
  let auto = 0;
  const col = (name) => { if (!cols.has(name)) cols.set(name, new Map()); return cols.get(name); };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Date ? { __d: x.getTime() } : x)), (k, x) => (x && x.__d !== undefined ? new Date(x.__d) : x)));
  function ref(name, id) {
    return {
      id,
      _col: name,
      async get() { const d = col(name).get(id); return { id, exists: !!d, data: () => clone(d), ref: ref(name, id) }; },
      async set(data, opts) { const prev = col(name).get(id); col(name).set(id, opts && opts.merge && prev ? Object.assign(clone(prev), clone(data)) : clone(data)); },
      async update(patch) { const prev = col(name).get(id); if (!prev) throw new Error('no doc ' + name + '/' + id); col(name).set(id, Object.assign(clone(prev), clone(patch))); },
    };
  }
  function query(name, filters) {
    return {
      where(f, op, v) { return query(name, filters.concat([[f, v]])); },
      async get() {
        const docs = [...col(name).entries()].filter(([, d]) => filters.every(([f, v]) => d[f] === v)).map(([id]) => ({ id, ref: ref(name, id), data: () => clone(col(name).get(id)) }));
        return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  const db = {
    collection(name) { return Object.assign(query(name, []), { doc: (id) => ref(name, id || ('auto' + (++auto))) }); },
    async runTransaction(fn) {
      const tx = { get: (r) => r.get(), set: (r, d, o) => { tx._ops.push(() => r.set(d, o)); }, update: (r, p) => { tx._ops.push(() => r.update(p)); }, _ops: [] };
      const out = await fn(tx);
      for (const op of tx._ops) await op();
      return out;
    },
    _dump: (name) => [...col(name).entries()].map(([id, d]) => Object.assign({ id }, clone(d))),
    _count: () => [...cols.values()].reduce((n, m) => n + m.size, 0),
  };
  for (const [name, docs] of Object.entries(seed || {})) for (const d of docs) col(name).set(d.id, clone(d));
  return db;
}

// ── a fake Stripe account ────────────────────────────────────────────────
function makeStripe(objs) {
  const byId = new Map();
  const all = (kind) => (objs[kind] || []);
  for (const k of Object.keys(objs)) for (const o of objs[k]) byId.set(o.id, o);
  const iter = (arr) => ({ [Symbol.asyncIterator]: async function* () { for (const x of arr) yield x; } });
  return {
    charges: { retrieve: async (id) => byId.get(id), list: () => iter(all('charges')) },
    invoices: { retrieve: async (id) => byId.get(id), list: () => iter(all('invoices')) },
    refunds: { retrieve: async (id) => byId.get(id), list: (q) => (q && q.charge ? Promise.resolve({ data: all('refunds').filter((r) => r.charge === q.charge) }) : iter(all('refunds'))) },
    disputes: { list: () => iter(all('disputes')) },
    payouts: { list: () => iter(all('payouts')) },
    balance: { retrieve: async () => ({ available: [{ currency: 'usd', amount: 100 }], pending: [] }) },
  };
}

const DAY = 86400;
const T0 = 1789600000; // mid-Sep 2026 (seconds)
function charge(id, amount, customer, extra) {
  return Object.assign({
    id, object: 'charge', status: 'succeeded', amount, amount_captured: amount, amount_refunded: 0, created: T0,
    balance_transaction: { fee: Math.round(amount * 0.029) + 30, net: amount - (Math.round(amount * 0.029) + 30) },
    payment_intent: { id: 'pi_' + id, metadata: {} }, invoice: null, metadata: {},
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    customer, billing_details: {}, receipt_url: 'https://pay.stripe.test/' + id,
  }, extra || {});
}
const cust = (id, name, email, phone, line1) => ({ id, object: 'customer', name, email, phone, address: line1 ? { line1 } : null, metadata: {} });
function stripeInvoice(id, total, customer, extra) {
  return Object.assign({
    id, object: 'invoice', status: 'paid', billing_reason: 'manual', subscription: null, total, subtotal: total, amount_paid: total,
    created: T0 - DAY, number: 'ZZQA-' + id, custom_fields: [{ name: 'Invoice No.', value: 'NBD-2026-0917-' + id.toUpperCase().slice(-4) }], metadata: {},
    hosted_invoice_url: 'https://invoice.stripe.test/' + id, invoice_pdf: 'https://pay.stripe.test/pdf/' + id,
    lines: { data: [{ description: 'ZZ_QA siding repair', amount: total, quantity: 1 }] },
    customer, customer_name: customer && customer.name, customer_email: customer && customer.email, customer_phone: null, customer_address: null,
    paid_out_of_band: false, charge: 'ch_x', payment_intent: 'pi_x', status_transitions: { paid_at: T0 },
  }, extra || {});
}

const seedLeads = [
  { id: 'L_EMAIL', companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: 'Emailmatch', email: 'em@example.com', address: '1 ZZQA St' },
  { id: 'L_OPEN', companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: 'Openinvoice', phone: '513-555-0111', address: '2 ZZQA St' },
  { id: 'L_HAND', companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: 'Handpaid', email: 'hand@example.com', address: '3 ZZQA St' },
  { id: 'L_NAME', companyId: 'OWNER', userId: 'OWNER', firstName: 'Zora', lastName: 'Nameonly', address: '4 ZZQA St' },
  { id: 'L_OOB', companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: 'Zelle', email: 'zelle@example.com', address: '5 ZZQA St' },
  { id: 'L_OTHER', companyId: 'someone-else', userId: 'someone-else', firstName: 'ZZ_QA', lastName: 'Othertenant', email: 'other@example.com' },
  { id: 'L_PHONE', companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: 'Phonebook', phone: '(513) 555-0199', address: '77 Elsewhere Ave' },
];
const seedInvoices = [
  { id: 'INV_OPEN', companyId: 'OWNER', createdBy: 'OWNER', leadId: 'L_OPEN', total: 1450, amountPaid: 0, balanceDue: 1450, status: 'sent', payments: [] },
  { id: 'INV_HAND', companyId: 'OWNER', createdBy: 'OWNER', leadId: 'L_HAND', total: 600, amountPaid: 600, balanceDue: 0, status: 'paid',
    payments: [{ amount: 600, at: new Date((T0 - DAY) * 1000), method: 'check' }] },
  { id: 'INV_LINK', companyId: 'OWNER', createdBy: 'OWNER', leadId: 'L_EMAIL', total: 99, amountPaid: 99, balanceDue: 0, status: 'paid', paidIntentIds: ['pi_ch_link'], payments: [{ amount: 99, at: new Date(), method: 'stripe' }] },
];

(async () => {
  const cEmail = cust('cus_em', 'ZZ_QA Emailmatch', 'em@example.com', null, null);
  const cOpen = cust('cus_open', 'ZZ_QA Openinvoice', null, '(513) 555-0111', null);
  const cHand = cust('cus_hand', 'ZZ_QA Handpaid', 'hand@example.com', null, null);
  const cName = cust('cus_name', 'Zora & Pat Nameonly', null, null, null);
  const cNobody = cust('cus_nobody', 'Nobody Known', 'nobody@example.com', null, null);
  const cOob = cust('cus_oob', 'ZZ_QA Zelle', 'zelle@example.com', null, null);
  const inMir = stripeInvoice('in_mirror', 182500, cEmail);
  const objs = {
    charges: [
      charge('ch_email', 182500, cEmail, { invoice: inMir }),
      charge('ch_open', 145000, cOpen),
      // The card's customer has only a name; the invoice carries the phone.
      charge('ch_invphone', 35000, cust('cus_bare', 'Somebody Else', null, null, null),
        { invoice: stripeInvoice('in_phone', 35000, null, { customer_name: 'Somebody Else', customer_phone: '513 555 0199', customer_address: { line1: '9 Phoneonly Rd' } }) }),
      charge('ch_hand', 60000, cHand),
      charge('ch_name', 45000, cName),
      charge('ch_nobody', 22500, cNobody),
      charge('ch_failed', 35000, cEmail, { status: 'failed', amount_captured: 0, failure_message: 'Your card was declined.' }),
      charge('ch_sub', 9900, cust('cus_sub', 'A Contractor', 'contractor@example.com'), { invoice: stripeInvoice('in_sub', 9900, null, { billing_reason: 'subscription_cycle', subscription: 'sub_1' }) }),
      charge('ch_link', 9900, cEmail, { payment_intent: { id: 'pi_ch_link', metadata: { invoiceId: 'INV_LINK' } } }),
      // A Roof Care Plan membership charge (care-plan.js, 2026-10-05): a
      // subscription invoice whose subscription_details carry the plan's tag.
      charge('ch_care', 19900, cEmail, { invoice: stripeInvoice('in_care', 19900, null, { billing_reason: 'subscription_create', subscription: 'sub_care',
        subscription_details: { metadata: { nbdProduct: 'roof_care_plan', carePlanId: 'cp_1', leadId: 'L_EMAIL', companyId: 'OWNER' } } }) }),
    ],
    invoices: [
      stripeInvoice('in_oob', 60000, cOob, { amount_paid: 0, paid_out_of_band: true, charge: null, payment_intent: null, status_transitions: { paid_at: T0 + DAY } }),
      stripeInvoice('in_open', 30000, cOob, { status: 'open', amount_paid: 0, charge: null, payment_intent: null }),
      inMir,
    ],
    refunds: [{ id: 're_1', object: 'refund', amount: 5000, created: T0 + 2 * DAY, status: 'succeeded', charge: 'ch_open', reason: 'requested_by_customer' }],
    payouts: [{ id: 'po_1', amount: 300000, arrival_date: T0 + 3 * DAY, status: 'paid', method: 'standard' }],
    disputes: [],
  };

  console.log('\n1. a dry run writes nothing and says what it would do');
  {
    const db = makeDb({ leads: seedLeads, invoices: seedInvoices });
    X.setStripe(makeStripe(objs));
    const before = db._count();
    const res = await X.sync(db, { sinceSec: null, dryRun: true });
    ok('not one document written or changed', db._count() === before && db._dump('stripeLedger').length === 0 && db._dump('invoices').find((i) => i.id === 'INV_OPEN').balanceDue === 1450);
    const by = (id) => res.charges.find((c) => c.id === id) || {};
    ok('email match → would create a CRM invoice from the Stripe invoice', /mirror/.test(by('ch_email').action) || /created/.test(by('ch_email').action), by('ch_email').action);
    ok('phone match with an open invoice → would record on it', by('ch_open').invoiceId === 'INV_OPEN', JSON.stringify(by('ch_open')));
    ok('already marked paid by hand → would NOT count it again', by('ch_hand').action === 'already_recorded_by_hand', by('ch_hand').action);
    ok('name only / unknown → needs review', by('ch_name').action === 'needs review' && by('ch_nobody').action === 'needs review');
    ok('subscription billing is labelled, not a customer job', /subscription/.test(by('ch_sub').action));
    ok('a declined attempt is labelled as such, not "needs review"', /declined/.test(by('ch_failed').action));
    ok('the totals say it was a dry run', res.totals.dryRun === true);
  }

  console.log('\n2. the real run books money exactly once');
  const db = makeDb({ leads: seedLeads, invoices: seedInvoices });
  X.setStripe(makeStripe(objs));
  await X.sync(db, { sinceSec: null, dryRun: false });
  const inv = (id) => db._dump('invoices').find((i) => i.id === id);
  const row = (id) => db._dump('stripeLedger').find((r) => r.id === id);
  const mirrors = () => db._dump('invoices').filter((i) => i.source === 'stripe');
  {
    ok('the open CRM invoice took the $1,450 and is paid', inv('INV_OPEN').balanceDue === 0 && inv('INV_OPEN').status === 'paid' && inv('INV_OPEN').payments.length === 1
      && inv('INV_OPEN').payments[0].amount === 1450 && inv('INV_OPEN').payments[0].stripeRef === 'ch_open');
    const mEmail = mirrors().find((m) => m.stripeInvoiceId === 'in_mirror');
    ok('a Stripe invoice the CRM never had → a CRM invoice under the right customer, paid', mEmail && mEmail.leadId === 'L_EMAIL' && mEmail.total === 1825 && mEmail.balanceDue === 0 && mEmail.payments.length === 1);
    ok('...carrying the NBD number and the Stripe links', mEmail && mEmail.nbdInvoiceNumber === 'NBD-2026-0917-RROR' && mEmail.stripeHostedUrl && mEmail.companyId === 'OWNER');
    ok('money Jo already marked paid by hand is linked, not added', inv('INV_HAND').payments.length === 1 && inv('INV_HAND').amountPaid === 600 && (inv('INV_HAND').stripeCreditKeys || []).includes('ch_hand'));
    ok('the CRM payment-link payment is not credited a second time', inv('INV_LINK').payments.length === 1 && row('ch_link').match.method === 'crm_payment_link');
    ok('the charge rows carry fee and net', row('ch_open').feeCents > 0 && row('ch_open').netCents === 145000 - row('ch_open').feeCents);
    ok('the matched customer is remembered on the lead', db._dump('leads').find((l) => l.id === 'L_OPEN').stripeCustomerId === 'cus_open');
    ok('an unknown customer lands in the review list, no invoice', row('ch_nobody').needsReview === true && !row('ch_nobody').match.invoiceId);
    ok('the phone typed on the INVOICE matches when the card customer has none → booked, not name-guessed',
      row('ch_invphone').match.leadId === 'L_PHONE' && row('ch_invphone').match.method === 'phone' && row('ch_invphone').needsReview === false);
    ok('a name-only match is a suggestion in the review list, not booked', row('ch_name').needsReview === true && row('ch_name').match.leadId === 'L_NAME' && row('ch_name').match.confidence === 'suggest'
      && !db._dump('invoices').some((i) => i.leadId === 'L_NAME'));
    ok('a declined card is recorded for the history, books $0, not in review', row('ch_failed').status === 'failed' && row('ch_failed').amountCents === 0 && row('ch_failed').needsReview === false);
    ok('subscription billing: recorded as platform revenue, never matched', row('ch_sub').kind === 'platform_subscription' && !row('ch_sub').match.leadId && row('ch_sub').needsReview === false);
    ok('NBD Pro subscription billing is tagged nbd_pro', row('ch_sub').product === 'nbd_pro');
    ok('a Roof Care Plan charge is tagged roof_care_plan (never NBD Pro revenue), names its member, books no job invoice, not in review',
      row('ch_care').product === 'roof_care_plan' && row('ch_care').carePlan && row('ch_care').carePlan.leadId === 'L_EMAIL'
      && row('ch_care').needsReview === false && !row('ch_care').match.invoiceId && !db._dump('invoices').some((i) => (i.stripeCreditKeys || []).includes('ch_care')));
    ok('another company\'s lead is never matched (tenant-scoped)', !db._dump('leads').find((l) => l.id === 'L_OTHER').stripeCustomerId);
  }

  console.log('\n3. paid outside Stripe, open, void, refund, payout');
  {
    const oob = mirrors().find((m) => m.stripeInvoiceId === 'in_oob');
    ok('an invoice marked paid in Stripe (Zelle/check) → recorded as collected under the customer', oob && oob.leadId === 'L_OOB' && oob.balanceDue === 0 && oob.payments[0].method === 'marked_paid_in_stripe');
    const open = mirrors().find((m) => m.stripeInvoiceId === 'in_open');
    ok('an open Stripe invoice shows as owed under the customer', open && open.balanceDue === 300 && open.amountPaid === 0);
    ok('the refund is a negative ledger row tied to the customer and invoice', row('re_1').amountCents === -5000 && row('re_1').match.leadId === 'L_OPEN' && row('re_1').match.invoiceId === 'INV_OPEN');
    ok('...recorded on the CRM invoice without touching its payments', inv('INV_OPEN').refunds.length === 1 && inv('INV_OPEN').refundedTotal === 50 && inv('INV_OPEN').payments.length === 1);
    ok('the payout is recorded and never matched', row('po_1').kind === 'payout' && row('po_1').party === null);

    objs.invoices[1] = Object.assign({}, objs.invoices[1], { status: 'void' });
    X.setStripe(makeStripe(objs));
    await X.ingestInvoice(await X.loadContext(db), 'in_open');
    ok('voiding that invoice in Stripe voids the CRM mirror', mirrors().find((m) => m.stripeInvoiceId === 'in_open').status === 'void' && mirrors().find((m) => m.stripeInvoiceId === 'in_open').balanceDue === 0);
  }

  console.log('\n4. re-running everything changes nothing (retry / nightly / backfill)');
  {
    const snap = JSON.stringify(db._dump('invoices').map((i) => [i.id, i.amountPaid, (i.payments || []).length, i.balanceDue]));
    const mirrorCount = mirrors().length;
    await X.sync(db, { sinceSec: null, dryRun: false });
    await X.sync(db, { sinceSec: null, dryRun: false });
    ok('no payment added twice, no invoice created twice', JSON.stringify(db._dump('invoices').map((i) => [i.id, i.amountPaid, (i.payments || []).length, i.balanceDue])) === snap && mirrors().length === mirrorCount);
  }

  console.log('\n5. assigning a review-list payment');
  {
    const r = await X.assign(db, 'ch_nobody', 'L_NAME', 'OWNER');
    ok('assign → booked on a new CRM invoice for that customer', r.ok && r.credited && r.created && inv(r.invoiceId).leadId === 'L_NAME' && inv(r.invoiceId).amountPaid === 225);
    ok('the row is out of the review list, marked manual', row('ch_nobody').needsReview === false && row('ch_nobody').match.method === 'manual' && row('ch_nobody').match.leadId === 'L_NAME');
    ok('the Stripe customer is remembered — the next payment books itself', db._dump('leads').find((l) => l.id === 'L_NAME').stripeCustomerId === 'cus_nobody');
    await X.sync(db, { sinceSec: null, dryRun: false });
    ok('a later sync keeps the manual assignment and does not re-book', row('ch_nobody').match.method === 'manual' && inv(r.invoiceId).payments.length === 1);
    let refused = false;
    try { await X.assign(db, 'ch_failed', 'L_NAME', 'OWNER'); } catch (e) { refused = /completed payment/.test(e.message); }
    ok('a declined attempt cannot be assigned as money', refused);
    let missing = false;
    try { await X.assign(db, 'ch_open', 'L_OTHER', 'OWNER'); } catch (e) { missing = /not found/i.test(e.message); }
    ok('another company\'s customer cannot be picked', missing);
  }

  console.log('\n6. the webhook entry point');
  {
    const r1 = await ledger.onEvent(db, { type: 'charge.succeeded', account: 'acct_tenant', data: { object: { id: 'ch_email' } } });
    ok('a Connect (tenant) event is ignored here', r1.skipped === true);
    const r2 = await ledger.onEvent(db, { type: 'customer.created', data: { object: {} } });
    ok('an event the ledger does not handle is ignored', r2.skipped === true);
    process.env.STRIPE_LEDGER_DISABLED = 'true';
    const r3 = await ledger.onEvent(db, { type: 'charge.succeeded', data: { object: { id: 'ch_email' } } });
    ok('the kill switch stops the webhook path', r3.skipped === 'disabled');
    delete process.env.STRIPE_LEDGER_DISABLED;
    const r4 = await ledger.onEvent(db, { type: 'payment_intent.succeeded', data: { object: { latest_charge: 'ch_open' } } });
    ok('payment_intent.succeeded ingests its charge (idempotently)', r4 && r4.id === 'ch_open' && inv('INV_OPEN').payments.length === 1);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
