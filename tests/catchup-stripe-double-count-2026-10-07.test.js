/**
 * tests/catchup-stripe-double-count-2026-10-07.test.js — R6-2-8.
 *
 * A $12,000 job whose $6,000 card deposit sat unmatched in the Stripe
 * ledger's review list. The lead showed $0 collected, so "Catch up my
 * numbers" asked "Paid in full?" and Jo recorded $12,000. Then he assigned the
 * Stripe deposit to the customer: it found no open invoice and no
 * equal-amount manual payment, so the ledger mirrored a NEW paid invoice and
 * the job read $18,000 collected on Home, Numbers, the digest and the agent's
 * collected_revenue.
 *
 * The fix (functions/stripe-ledger-logic.js planCatchUpAbsorb): the catch-up
 * payment is a balancing entry (basis 'catchup_paid_in_full'); a real Stripe
 * payment for that job REPLACES that much of it on the same invoice, with an
 * audit line, instead of adding on top. More than it can give way to → not
 * booked, left in the review list with the reason (never silent). The
 * reverse order (Stripe first, then "Paid in full?") is refused on the
 * client, fresh.
 *
 * Runs the REAL modules end to end: catchup.js + invoice-pipeline.js in a
 * browser sandbox write the catch-up payment; functions/stripe-ledger.js
 * (assign / onEvent / sync) books the Stripe money against an in-memory
 * Firestore and a fake Stripe account; collected-revenue.js and
 * agent-mcp-logic.js read the result. Money checked in cents.
 *
 * Run: node tests/catchup-stripe-double-count-2026-10-07.test.js  (zero deps)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.NBD_OWNER_UID = 'OWNER';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function sec(name, fn) {
  try { await fn(); } catch (e) { ok(String(name).trim() + ' — threw: ' + (e && e.stack || e), false); }
}
const c = (dollars) => Math.round((Number(dollars) || 0) * 100);

const ledger = require(path.join(ROOT, 'functions', 'stripe-ledger.js'));
const X = ledger._internal;
const SL = require(path.join(ROOT, 'functions', 'stripe-ledger-logic.js'));
const AG = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const NL = require(path.join(ROOT, 'docs/pro/js/numbers-logic.js'));
const CL = require(path.join(ROOT, 'docs/pro/js/catchup-logic.js'));

// ── collected-revenue.js (Home / Numbers) in a vm, as the page loads it ──
function collectedByLead(invoices) {
  const win = { addEventListener() {} }; win.window = win;
  const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Object };
  vm.createContext(sb);
  vm.runInContext(read('docs/pro/js/collected-revenue.js'), sb, { filename: 'collected-revenue.js' });
  return win.NBDRevenue.collectedByLead(invoices, null, null);
}

// ── browser sandbox (Firestore v9 modular fakes), as tests/catchup-2026-10-04 ──
function browser(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const writes = [];
  let seq = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const W = {
    _db: { fake: true }, db: { fake: true },
    doc: (db, ...segs) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
    collection: (db, col) => ({ col }),
    where: (f, op, v) => ({ f, op, v }),
    query: (q, ...ws) => ({ col: q.col, ws }),
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
    NBDComms: { sendEmail: async () => ({ success: true }), sendSMS: async () => ({ success: true }) },
    NBDDepositRule: require(path.join(ROOT, 'docs/pro/js/deposit-rule.js')),
    NBDJurisdiction: require(path.join(ROOT, 'docs/pro/js/ky-insurance-law.js')),
    _auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok' } },
    _user: { uid: 'u1' },
    _userClaims: {},
    _leads: [],
    _estimates: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
    NBDNumbersData: { isOwner: () => true, companyId: () => 'u1', loadExpenses: async () => [], loadSpend: async () => ({ months: {} }) },
  };
  global.window = W;
  global.showToast = () => {};
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  W.NBDNumbers = NL;
  W.NBDCatchUpLogic = CL;
  W.InvoicePipeline = IP;
  return { W, store, writes };
}
let IP = null, CU = null;
browser({});
IP = require(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'));
CU = require(path.join(ROOT, 'docs/pro/js/catchup.js'));

// ── in-memory Firestore (admin SDK shape), as tests/stripe-ledger-ingest ──
function makeDb(seed) {
  const cols = new Map();
  let auto = 0;
  const col = (name) => { if (!cols.has(name)) cols.set(name, new Map()); return cols.get(name); };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Date ? { __d: x.getTime() } : x)), (k, x) => (x && x.__d !== undefined ? new Date(x.__d) : x)));
  function ref(name, id) {
    return {
      id, _col: name,
      async get() { const d = col(name).get(id); return { id, exists: !!d, data: () => clone(d), ref: ref(name, id) }; },
      async set(data, opts) { const prev = col(name).get(id); col(name).set(id, opts && opts.merge && prev ? Object.assign(clone(prev), clone(data)) : clone(data)); },
      async update(patch) { const prev = col(name).get(id); if (!prev) throw new Error('no doc ' + name + '/' + id); col(name).set(id, Object.assign(clone(prev), clone(patch))); },
      collection: (sub) => Object.assign(query(name + '/' + id + '/' + sub, []), { doc: (sid) => ref(name + '/' + id + '/' + sub, sid) }),
    };
  }
  function query(name, filters, lim) {
    return {
      where(f, op, v) { return query(name, filters.concat([[f, v]]), lim); },
      limit(n) { return query(name, filters, n); },
      async get() {
        let docs = [...col(name).entries()].filter(([, d]) => filters.every(([f, v]) => d[f] === v)).map(([id]) => ({ id, ref: ref(name, id), data: () => clone(col(name).get(id)) }));
        if (lim) docs = docs.slice(0, lim);
        return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  return {
    collection(name) { return Object.assign(query(name, []), { doc: (id) => ref(name, id || ('auto' + (++auto))) }); },
    async runTransaction(fn) {
      const tx = { get: (r) => r.get(), set: (r, d, o) => { tx._ops.push(() => r.set(d, o)); }, update: (r, p) => { tx._ops.push(() => r.update(p)); }, _ops: [] };
      const out = await fn(tx);
      for (const op of tx._ops) await op();
      return out;
    },
    _dump: (name) => [...col(name).entries()].map(([id, d]) => Object.assign({ id }, clone(d))),
    _seed: (name, id, d) => col(name).set(id, clone(d)),
  };
}
function makeStripe(charges) {
  const byId = new Map(charges.map((ch) => [ch.id, ch]));
  const iter = (arr) => ({ [Symbol.asyncIterator]: async function* () { for (const x of arr) yield x; } });
  return {
    charges: { retrieve: async (id) => byId.get(id), list: () => iter(charges) },
    invoices: { retrieve: async () => null, list: () => iter([]) },
    refunds: { retrieve: async () => null, list: () => iter([]) },
    disputes: { list: () => iter([]) },
    payouts: { list: () => iter([]) },
  };
}
const DAYMS = 86400000;
const CATCHUP_YMD = '2026-09-20';
const CATCHUP_MS = new Date(2026, 8, 20, 12, 0, 0).getTime();
function charge(id, cents, atMs, customer) {
  return {
    id, object: 'charge', status: 'succeeded', amount: cents, amount_captured: cents, amount_refunded: 0, created: Math.floor(atMs / 1000),
    balance_transaction: { fee: 100, net: cents - 100 }, payment_intent: { id: 'pi_' + id, metadata: {} }, invoice: null, metadata: {},
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    customer: customer || { id: 'cus_anon', object: 'customer', name: 'Card Holder', email: null, phone: null, address: null, metadata: {} },
    billing_details: {}, receipt_url: 'https://pay.stripe.test/' + id,
  };
}
// The ledger row the review list holds for an unmatched charge (what ingestCharge wrote).
function reviewRow(ch) {
  return Object.assign(SL.chargeEntry(ch, 'OWNER'), { match: { leadId: null, invoiceId: null, method: null, confidence: 'none', candidates: [] }, needsReview: true });
}
const LEAD = { userId: 'u1', companyId: 'u1', firstName: 'Ida', lastName: 'Example', address: '12 Main St, Milford, OH 45150', email: 'ida@example.com', stage: 'closed', jobValue: 12000, createdAt: CATCHUP_MS - 90 * DAYMS, closedAt: CATCHUP_MS - 60 * DAYMS };

/** "Catch up my numbers" → "Paid in full? Yes" for the $12,000 job, through the real modules. */
async function catchUpPaidInFull(extraStore) {
  const B = browser(Object.assign({ 'leads/I': LEAD }, extraStore || {}));
  B.W._leads = [Object.assign({ id: 'I' }, LEAD)];
  CU._setData({ invs: [], expenses: [], spend: { months: {} } }, { doneJobs: {}, log: [] });
  const r = await CU.paidInFull('I', { method: 'check', payer: 'homeowner', ymd: CATCHUP_YMD, expectCents: 1200000 });
  const invEntry = [...B.store.entries()].find(([k]) => k.startsWith('invoices/'));
  return { B, r, invoiceId: invEntry[0].split('/')[1], invoice: invEntry[1] };
}
/** The functions-side Firestore holding that invoice (and the lead, in the owner tenant). */
function serverDb(invoiceId, invoice, extraLead) {
  const db = makeDb({});
  db._seed('leads', 'I', Object.assign({}, LEAD, { companyId: 'OWNER', userId: 'OWNER' }, extraLead || {}));
  db._seed('invoices', invoiceId, Object.assign({}, invoice, { companyId: 'OWNER' }));
  return db;
}
const leadInvoices = (db) => db._dump('invoices').filter((i) => i.leadId === 'I');

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\n1. The reported order: "Paid in full?" $12,000, THEN Jo assigns the $6,000 Stripe deposit');
  await sec('1', async () => {
    const { r, invoiceId, invoice } = await catchUpPaidInFull();
    ok('context: catch-up records ONE $12,000 payment and the invoice is paid', r.cents === 1200000 && invoice.payments.length === 1 && c(invoice.amountPaid) === 1200000 && invoice.status === 'paid');
    ok('the catch-up payment is tagged as a balancing "paid in full" entry (basis catchup_paid_in_full)',
      invoice.payments[0].basis === 'catchup_paid_in_full', JSON.stringify(invoice.payments[0]));

    const dep = charge('ch_dep', 600000, CATCHUP_MS - 30 * DAYMS);
    const db = serverDb(invoiceId, invoice);
    db._seed('stripeLedger', 'ch_dep', reviewRow(dep));
    X.setStripe(makeStripe([dep]));
    const res = await X.assign(db, 'ch_dep', 'I', 'OWNER');
    const invs = leadInvoices(db);
    ok('assigning the deposit makes NO second invoice (it was mirrored as a new paid one)', invs.length === 1, invs.map((i) => i.id + ':' + i.total).join(','));
    const inv = invs.find((i) => i.id === invoiceId) || {};
    const byLead = collectedByLead(db._dump('invoices'));
    ok('collected for the job reads $12,000 on Home / Numbers (collected-revenue.js) — not $18,000', c(byLead.I) === 1200000, JSON.stringify(byLead));
    const agent = AG.collectedRevenue(db._dump('invoices'), db._dump('leads'), '2026-01-01', '2026-12-31');
    ok('…and $12,000 in the agent\'s collected_revenue', c(agent.collected) === 1200000, JSON.stringify(agent.by_month));
    const pays = inv.payments || [];
    const cu = pays.find((p) => p.basis === 'catchup_paid_in_full') || {};
    const st = pays.find((p) => p.stripeRef === 'ch_dep') || {};
    ok('the invoice holds the catch-up entry cut to $6,000 (was $12,000) + the $6,000 Stripe payment on its own date',
      pays.length === 2 && c(cu.amount) === 600000 && c(cu.originalAmount) === 1200000 && c(st.amount) === 600000
      && new Date(st.at).getTime() === CATCHUP_MS - 30 * DAYMS && st.source === 'stripe_ledger', JSON.stringify(pays));
    ok('amountPaid stays $12,000, nothing owed, still paid', c(inv.amountPaid) === 1200000 && c(inv.balanceDue) === 0 && inv.status === 'paid');
    ok('by date: $6,000 in August (the card), $6,000 in September (the catch-up remainder)',
      c(agent.by_month['2026-08']) === 600000 && c(agent.by_month['2026-09']) === 600000, JSON.stringify(agent.by_month));
    const rec = (inv.reconciliations || [])[0] || {};
    ok('an audit line says what changed and why', (inv.reconciliations || []).length === 1 && rec.stripeRef === 'ch_dep' && c(rec.catchUpReducedBy) === 600000 && /not counted twice/.test(rec.note || ''));
    ok('the charge is remembered on the invoice (stripeCreditKeys) and the row leaves review, booked on that invoice',
      (inv.stripeCreditKeys || []).includes('ch_dep') && res.ok && res.credited && res.replacedCatchUp === true
      && db._dump('stripeLedger')[0].needsReview === false && db._dump('stripeLedger')[0].match.invoiceId === invoiceId);

    // The balance later paid by card, within days of the catch-up date → the
    // catch-up entry is fully replaced (kept in supersededPayments for audit).
    const fin = charge('ch_fin', 600000, CATCHUP_MS + 3 * DAYMS);
    db._seed('stripeLedger', 'ch_fin', reviewRow(fin));
    X.setStripe(makeStripe([dep, fin]));
    await X.assign(db, 'ch_fin', 'I', 'OWNER');
    const inv2 = leadInvoices(db)[0];
    ok('a second Stripe payment for the rest replaces the remaining $6,000: two real payments, catch-up moved to supersededPayments',
      leadInvoices(db).length === 1 && inv2.payments.length === 2 && inv2.payments.every((p) => p.source === 'stripe_ledger')
      && (inv2.supersededPayments || []).length === 1 && c(inv2.supersededPayments[0].originalAmount) === 1200000 && c(inv2.supersededPayments[0].amount) === 0,
      JSON.stringify({ p: inv2.payments, s: inv2.supersededPayments }));
    ok('…collected still $12,000', c(collectedByLead(db._dump('invoices')).I) === 1200000);

    // Re-running every path changes nothing.
    const snap = JSON.stringify(leadInvoices(db).map((i) => [i.id, i.amountPaid, i.payments.length, (i.supersededPayments || []).length]));
    await ledger.onEvent(db, { type: 'charge.succeeded', data: { object: { id: 'ch_dep' } } });
    await X.sync(db, { sinceSec: null, dryRun: false });
    ok('webhook retry + nightly reconcile over the same charges change nothing',
      JSON.stringify(leadInvoices(db).map((i) => [i.id, i.amountPaid, i.payments.length, (i.supersededPayments || []).length])) === snap);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n2. The automatic path (webhook matches the customer by email) — same rule');
  await sec('2', async () => {
    const { invoiceId, invoice } = await catchUpPaidInFull();
    const db = serverDb(invoiceId, invoice);
    const dep = charge('ch_auto', 600000, CATCHUP_MS - 20 * DAYMS, { id: 'cus_ida', object: 'customer', name: 'Ida Example', email: 'ida@example.com', phone: null, address: null, metadata: {} });
    X.setStripe(makeStripe([dep]));
    await ledger.onEvent(db, { type: 'charge.succeeded', data: { object: { id: 'ch_auto' } } });
    const invs = leadInvoices(db);
    ok('booked on the catch-up invoice, no mirror; collected $12,000',
      invs.length === 1 && invs[0].payments.length === 2 && c(collectedByLead(db._dump('invoices')).I) === 1200000, JSON.stringify(invs.map((i) => i.payments)));
    const row = db._dump('stripeLedger').find((r) => r.id === 'ch_auto');
    ok('the row is booked (not in review)', row && row.needsReview === false && row.match.invoiceId === invoiceId && !row.review);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n3. Cannot reconcile → flagged for Jo, nothing booked, nothing swallowed');
  await sec('3', async () => {
    const { invoiceId, invoice } = await catchUpPaidInFull();
    const db = serverDb(invoiceId, invoice);
    const big = charge('ch_big', 1300000, CATCHUP_MS - 10 * DAYMS);
    db._seed('stripeLedger', 'ch_big', reviewRow(big));
    X.setStripe(makeStripe([big]));
    let err = null;
    try { await X.assign(db, 'ch_big', 'I', 'OWNER'); } catch (e) { err = e; }
    ok('assigning a $13,000 Stripe payment to the $12,000 paid-in-full job is refused with a reason Jo can act on',
      err && err.code === 'failed-precondition' && /Paid in full/.test(err.message) && /not counted twice/.test(err.message) && /\$13,000\.00/.test(err.message), err && (err.code + ' ' + err.message));
    const invs = leadInvoices(db);
    ok('…nothing was written to the invoices (no mirror, catch-up untouched)', invs.length === 1 && invs[0].payments.length === 1 && c(invs[0].payments[0].amount) === 1200000);
    const row = db._dump('stripeLedger').find((r) => r.id === 'ch_big');
    ok('…the row stays in the review list carrying the reason (the panel shows it)', row.needsReview === true && row.review && row.review.reason === 'exceeds_paid_in_full' && /Paid in full/.test(row.review.message));
    await X.sync(db, { sinceSec: null, dryRun: false });
    const rowAfter = db._dump('stripeLedger').find((r) => r.id === 'ch_big');
    ok('…and the nightly reconcile keeps that reason and books nothing', rowAfter.needsReview === true && rowAfter.review && rowAfter.review.reason === 'exceeds_paid_in_full'
      && leadInvoices(db).length === 1 && leadInvoices(db)[0].payments.length === 1);

    // Automatic path, same payment: left in review with the reason, not booked.
    const db2 = serverDb(invoiceId, invoice);
    const big2 = Object.assign(charge('ch_big2', 1300000, CATCHUP_MS - 10 * DAYMS), { customer: { id: 'cus_ida', object: 'customer', name: 'Ida Example', email: 'ida@example.com', phone: null, address: null, metadata: {} } });
    X.setStripe(makeStripe([big2]));
    await ledger.onEvent(db2, { type: 'charge.succeeded', data: { object: { id: 'ch_big2' } } });
    const row2 = db2._dump('stripeLedger').find((r) => r.id === 'ch_big2');
    ok('automatic match of the same payment: NOT booked, in review with the reason, no invoice for a refund to hit',
      leadInvoices(db2).length === 1 && leadInvoices(db2)[0].payments.length === 1 && row2.needsReview === true
      && row2.review && row2.review.reason === 'exceeds_paid_in_full' && row2.match.invoiceId === null, JSON.stringify(row2 && { n: row2.needsReview, r: row2.review, m: row2.match }));
    // Positive control for the window: money far outside the job's dates is other work, booked as before.
    const db3 = serverDb(invoiceId, invoice);
    const later = Object.assign(charge('ch_later', 50000, CATCHUP_MS + 60 * DAYMS), { customer: big2.customer });
    X.setStripe(makeStripe([later]));
    await ledger.onEvent(db3, { type: 'charge.succeeded', data: { object: { id: 'ch_later' } } });
    ok('a $500 card payment two months after the paid-in-full date is other work: booked on its own invoice, catch-up untouched',
      leadInvoices(db3).length === 2 && c(collectedByLead(db3._dump('invoices')).I) === 1250000 && c(leadInvoices(db3).find((i) => i.id === invoiceId).payments[0].amount) === 1200000);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n4. The reverse order: the Stripe deposit is booked FIRST, then "Paid in full?"');
  await sec('4', async () => {
    // Server: the deposit arrives and is mirrored under the customer.
    const db = makeDb({});
    db._seed('leads', 'I', Object.assign({}, LEAD, { companyId: 'OWNER', userId: 'OWNER' }));
    const dep = Object.assign(charge('ch_first', 600000, CATCHUP_MS - 30 * DAYMS), { customer: { id: 'cus_ida', object: 'customer', name: 'Ida Example', email: 'ida@example.com', phone: null, address: null, metadata: {} } });
    X.setStripe(makeStripe([dep]));
    await ledger.onEvent(db, { type: 'charge.succeeded', data: { object: { id: 'ch_first' } } });
    const mirror = leadInvoices(db)[0];
    ok('context: the $6,000 deposit is on the customer (a mirrored, paid invoice)', mirror && c(mirror.amountPaid) === 600000 && mirror.status === 'paid');
    ok('context: with money collected the deck does not ask "Paid in full?"',
      CL.jobDeck([Object.assign({ id: 'I', stageRole: 'won', soldTier: 'better' }, LEAD)], { collectedByLead: collectedByLead([mirror]) }).items[0].missing.payment === false);
    // A deck opened BEFORE the webhook landed still shows the button; the tap re-checks fresh.
    const toBrowser = JSON.parse(JSON.stringify(Object.assign({}, mirror, { createdBy: 'u1' })));
    const B = browser({ 'leads/I': LEAD, ['invoices/' + mirror.id]: toBrowser });
    B.W._leads = [Object.assign({ id: 'I' }, LEAD)];
    CU._setData({ invs: [], expenses: [], spend: { months: {} } }, { doneJobs: {}, log: [] });
    let threw = '';
    try { await CU.paidInFull('I', { method: 'check', payer: 'homeowner', ymd: CATCHUP_YMD, expectCents: 1200000 }); } catch (e) { threw = e.message; }
    const invs = [...B.store.entries()].filter(([k]) => k.startsWith('invoices/')).map(([, v]) => v);
    ok('"Paid in full? Yes" is refused — money is already recorded — and NOTHING is written',
      /already recorded/i.test(threw) && invs.length === 1 && B.writes.length === 0, threw + ' / writes ' + JSON.stringify(B.writes));
    ok('…so collected stays the $6,000 that came in (not $18,000)', c(collectedByLead(invs).I) === 600000);
    ok('paidInFullPlan: already_collected wins over any target', CL.paidInFullPlan({ kind: 'jobValue', suggestedCents: 1200000 }, { collectedCents: 600000 }).reason === 'already_collected'
      && CL.paidInFullPlan({ kind: 'jobValue', suggestedCents: 1200000 }, { collectedCents: 0 }).ok === true);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n5. Undo of the catch-up payment cannot erase the Stripe money booked on it since');
  await sec('5', async () => {
    const { B, invoiceId, invoice } = await catchUpPaidInFull();
    const db = serverDb(invoiceId, invoice);
    const dep = charge('ch_u', 600000, CATCHUP_MS - 30 * DAYMS);
    db._seed('stripeLedger', 'ch_u', reviewRow(dep));
    X.setStripe(makeStripe([dep]));
    await X.assign(db, 'ch_u', 'I', 'OWNER');
    const absorbed = JSON.parse(JSON.stringify(leadInvoices(db)[0]));
    delete absorbed.id;
    // The browser sees the invoice as the ledger left it.
    const B2 = browser(Object.assign(Object.fromEntries(B.store), { ['invoices/' + invoiceId]: Object.assign({}, absorbed, { createdBy: 'u1' }) }));
    B2.W._leads = [Object.assign({ id: 'I' }, LEAD)];
    const done = await CU.undoLast();
    ok('Undo is refused and the invoice (with the Stripe payment) is still there',
      done === false && B2.store.has('invoices/' + invoiceId) && (B2.store.get('invoices/' + invoiceId).payments || []).some((p) => p.stripeRef === 'ch_u'));
    ok('…a plain catch-up payment with no Stripe money since still undoes (positive control)',
      CL.paymentUndoBlocked(invoice, { created: true }) === '' && /Stripe payment/.test(CL.paymentUndoBlocked(absorbed, { created: true })));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
