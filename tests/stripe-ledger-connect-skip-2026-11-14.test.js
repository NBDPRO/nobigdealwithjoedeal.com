/**
 * tests/stripe-ledger-connect-skip-2026-11-14.test.js
 *
 * A Connect tenant's payment-link charge is a DESTINATION charge: the PI and
 * the charge live on the platform account (stripe.js createStripePaymentLink,
 * on_behalf_of + transfer_data), so the ledger's webhook and nightly sync see
 * them. They are another company's money and another company's homeowner:
 * the ledger must never match them to the platform owner's leads, never book
 * them onto the owner's invoices, never copy the payer's details into the
 * owner's ledger, and never put them in the owner's review list.
 * Before 2026-11-14 a Connect charge whose payer shared an email / phone /
 * address with one of the owner's leads was credited to the owner's invoice.
 * In-memory Firestore + a fake Stripe account; synthetic data only.
 *
 * Run: node tests/stripe-ledger-connect-skip-2026-11-14.test.js
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
const T0 = 1789600000;
function charge(id, amount, customer, extra) {
  return Object.assign({
    id, object: 'charge', status: 'succeeded', amount, amount_captured: amount, amount_refunded: 0, created: T0,
    balance_transaction: { fee: 100, net: amount - 100 },
    payment_intent: { id: 'pi_' + id, metadata: {} }, invoice: null, metadata: {},
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    customer, billing_details: {}, receipt_url: 'https://pay.stripe.test/' + id,
  }, extra || {});
}
const cust = (id, name, email, phone) => ({ id, object: 'customer', name, email, phone, address: null, metadata: {} });

const seedLeads = [
  { id: 'L_OWN', companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: 'Shared', email: 'shared@example.com', phone: '513-555-0142', address: '12 ZZQA St' },
];
const seedInvoices = [
  { id: 'INV_OWN', companyId: 'OWNER', createdBy: 'OWNER', leadId: 'L_OWN', total: 2000, amountPaid: 0, balanceDue: 2000, status: 'sent', payments: [] },
];
const payer = cust('cus_payer', 'ZZ_QA Shared', 'shared@example.com', '(513) 555-0142');

(async () => {
  const cases = [
    ['destination charge (transfer_data)', charge('ch_dest', 200000, payer, { transfer_data: { destination: 'acct_B' },
      payment_intent: { id: 'pi_dest', metadata: { invoiceId: 'TENANT_B_INV', companyId: 'tenantB' } } })],
    ['on_behalf_of only', charge('ch_obo', 200000, payer, { on_behalf_of: 'acct_B' })],
    ['another company in the PI metadata', charge('ch_meta', 200000, payer, { payment_intent: { id: 'pi_meta', metadata: { invoiceId: 'TENANT_B_INV2', companyId: 'tenantB' } } })],
  ];
  for (const [label, ch] of cases) {
    console.log('\n' + label);
    for (const via of ['webhook', 'sync']) {
      const db = makeDb({ leads: seedLeads, invoices: seedInvoices });
      X.setStripe(makeStripe({ charges: [ch], invoices: [], refunds: [], disputes: [], payouts: [] }));
      if (via === 'webhook') await ledger.onEvent(db, { id: 'evt_' + ch.id, type: 'charge.succeeded', data: { object: { id: ch.id } } });
      else await X.sync(db, { sinceSec: null, dryRun: false });
      const inv = db._dump('invoices').find((i) => i.id === 'INV_OWN');
      ok(via + ': the owner\'s open invoice is untouched', inv && inv.balanceDue === 2000 && inv.amountPaid === 0 && inv.payments.length === 0 && inv.status === 'sent', JSON.stringify(inv));
      ok(via + ': no mirror invoice was created', db._dump('invoices').length === 1);
      const row = db._dump('stripeLedger').find((r) => r.id === ch.id);
      ok(via + ': not matched to the owner\'s lead', !row || !(row.match && row.match.leadId));
      ok(via + ': not in the owner\'s review list', !row || row.needsReview !== true);
      const blob = JSON.stringify(row || {});
      ok(via + ': the payer\'s email / phone / name are not copied into the owner\'s ledger', !/shared@example\.com|555-0142|5550142|ZZ_QA Shared/.test(blob), blob.slice(0, 300));
      const lead = db._dump('leads').find((l) => l.id === 'L_OWN');
      ok(via + ': the payer\'s Stripe customer is not remembered on the owner\'s lead', !lead.stripeCustomerId);
    }
  }

  console.log('\ncontrol: an ordinary platform charge from the same payer still books');
  {
    const db = makeDb({ leads: seedLeads, invoices: seedInvoices });
    const plain = charge('ch_plain', 200000, payer);
    X.setStripe(makeStripe({ charges: [plain], invoices: [], refunds: [], disputes: [], payouts: [] }));
    await X.sync(db, { sinceSec: null, dryRun: false });
    const inv = db._dump('invoices').find((i) => i.id === 'INV_OWN');
    ok('the owner\'s invoice took the $2,000 (the skip is not a blanket off-switch)', inv.balanceDue === 0 && inv.status === 'paid', JSON.stringify(inv));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
