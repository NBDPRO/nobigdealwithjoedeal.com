/**
 * deposit-credit-ledger-mirror-2026-10-05.test.js — a deposit paid through
 * the Stripe dashboard is credited on the job's final invoice.
 *
 * The bug (HIGH, 2026-10-05): jobInvoicesOf (nbd:job-billing, in
 * docs/pro/js/invoice-pipeline.js and functions/invoice-from-estimate.js)
 * skipped every PAID invoice with no jobId stamp, and the Stripe ledger's
 * mirror (functions/stripe-ledger-logic.js mirrorInvoice) never stamped one.
 * Repro: a $4,620 deposit paid in Stripe → the final invoice at install
 * billed the full $9,240 with no "Less deposit paid" line.
 *
 * The fix, both halves:
 *   1. mirrorJobStamp: a new mirror carries jobId + estimateId when the
 *      customer has exactly ONE job and the payment is not older than the
 *      lead's primary estimate.
 *   2. jobInvoicesOf(invoices, jobId, { soleJob, since }): an un-stamped PAID
 *      invoice counts for the job when the customer has exactly one job and
 *      it was made on or after the job's estimate (the mirrors already in
 *      prod). Two or more jobs → unchanged (no credit, never the wrong job).
 *
 * Synthetic data only; every Firestore is an in-memory fake.
 * Run: node tests/deposit-credit-ledger-mirror-2026-10-05.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
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

process.env.NBD_OWNER_UID = 'OWNER';
const IFE = req('functions/invoice-from-estimate.js');
const D = req('functions/deposit-draft-logic.js');
const DD = req('functions/deposit-draft.js');
const L = req('functions/stripe-ledger-logic.js');
const LEDGER = req('functions/stripe-ledger.js');

// The repro: a $9,240 job, a $4,620 deposit paid through the Stripe dashboard.
const NOW = Date.parse('2026-10-05T15:00:00Z');
const EST_AT = '2026-09-20T14:00:00.000Z';   // estimate written
const PAID_AT = '2026-09-22T16:00:00.000Z';  // deposit paid in Stripe, after it
const TOTAL_C = 924000;
const est = (o) => Object.assign({ leadId: 'L1', userId: 'u1', companyId: 'u1', priceMode: 'per-sq', prices: { better: 9240 },
  selectedTier: 'better', grandTotal: 9240, taxRate: 0, mode: 'cash', createdAt: EST_AT, jobId: 'j1' }, o || {});
const lead = (o) => Object.assign({ id: 'L1', userId: 'u1', companyId: 'u1', firstName: 'Pat', lastName: 'Jones',
  address: '12 Main St, Milford, OH 45150', jobType: 'cash', stage: 'install_complete', primaryEstimateId: 'E1', activeJobId: 'j1' }, o || {});
// What stripe-ledger-logic.js mirrorInvoice wrote before this fix, after planCredit paid it: no jobId.
const mirror = (o) => Object.assign({ id: 'M1', leadId: 'L1', companyId: 'u1', createdBy: 'u1', source: 'stripe', status: 'paid',
  total: 4620, amountPaid: 4620, balanceDue: 0, createdAt: PAID_AT, stripeInvoiceId: 'in_dep' }, o || {});

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\n1. jobInvoicesOf / planJobInvoice — the un-stamped paid deposit (pure, server copy)');
  ok('nbd:job-billing is byte-identical in invoice-pipeline.js and functions/invoice-from-estimate.js',
    !!block(read('docs/pro/js/invoice-pipeline.js'), 'job-billing')
    && block(read('docs/pro/js/invoice-pipeline.js'), 'job-billing') === block(read('functions/invoice-from-estimate.js'), 'job-billing'));
  if (IFE) {
    ok('functions/invoice-from-estimate.js exports soleJobOf', typeof IFE.soleJobOf === 'function');
    const soleJobOf = (j, id) => (typeof IFE.soleJobOf === 'function' ? IFE.soleJobOf(j, id) : false);
    ok('soleJobOf: exactly one (not deleted) job, and it is this one',
      soleJobOf([{ id: 'j1' }], 'j1') === true
      && soleJobOf([{ id: 'j1' }, { id: 'j2', deleted: true }], 'j1') === true
      && soleJobOf([{ id: 'j1' }, { id: 'j2' }], 'j1') === false
      && soleJobOf([{ id: 'j2' }], 'j1') === false
      && soleJobOf([], 'j1') === false && soleJobOf(null, 'j1') === false
      && soleJobOf([{ id: 'j1' }], null) === false);
    const sole = { soleJob: true, since: EST_AT };
    const p = IFE.planJobInvoice(TOTAL_C, [mirror()], 'j1', sole);
    ok('REPRO: $4,620 paid via Stripe (un-stamped mirror), one job → the final credits "Less deposit paid" $4,620',
      p.action === 'create' && p.creditCents === 462000 && p.credits.length === 1 && p.credits[0].label === 'Less deposit paid' && p.credits[0].invoiceId === 'M1',
      JSON.stringify(p));
    const f = IFE.applyJobCredits({ items: [{ description: 'Roof', quantity: 1, unitPrice: 9240, total: 9240 }], subtotal: 9240, tax: 0, total: 9240 }, p.credits);
    ok('…and the final invoice is $4,620 due (not $9,240), cents-exact', f.total === 4620 && f.creditTotal === 4620 && f.subtotal === 9240);
    ok('two or more jobs on the customer → the un-stamped deposit is NOT credited (safe: never the wrong job)',
      IFE.planJobInvoice(TOTAL_C, [mirror()], 'j1', { soleJob: soleJobOf([{ id: 'j1' }, { id: 'j2' }], 'j1'), since: EST_AT }).creditCents === 0);
    ok('a payment OLDER than this job\'s estimate (an earlier roof) is NOT credited',
      IFE.planJobInvoice(TOTAL_C, [mirror({ createdAt: '2025-05-01T00:00:00Z' })], 'j1', sole).creditCents === 0);
    ok('no estimate date → NOT credited (no guess)', IFE.planJobInvoice(TOTAL_C, [mirror()], 'j1', { soleJob: true }).creditCents === 0);
    ok('no opts (every other caller) → unchanged: an un-stamped paid invoice stays out', IFE.planJobInvoice(TOTAL_C, [mirror()], 'j1').creditCents === 0);
    ok('a paid invoice stamped for ANOTHER job stays out even with soleJob', IFE.planJobInvoice(TOTAL_C, [mirror({ jobId: 'j2' })], 'j1', sole).creditCents === 0);
    ok('a void / deleted un-stamped mirror stays out',
      IFE.planJobInvoice(TOTAL_C, [mirror({ status: 'void' }), mirror({ id: 'M2', deleted: true })], 'j1', sole).creditCents === 0);
    ok('a mirror STAMPED j1 (mirrorJobStamp) is credited with no opts at all',
      IFE.planJobInvoice(TOTAL_C, [mirror({ jobId: 'j1' })], 'j1').creditCents === 462000);
    ok('stamped + un-stamped are never double-counted: one stamped deposit, soleJob → credited once',
      IFE.planJobInvoice(TOTAL_C, [mirror({ jobId: 'j1' })], 'j1', sole).creditCents === 462000);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n2. the install-day final invoice (functions/deposit-draft-logic.js decideFinalDraft)');
  if (D) {
    const r = D.decideFinalDraft({ leadId: 'L1', lead: lead(), est: est(), estimateId: 'E1', nowMs: NOW, invoices: [mirror()], jobs: [{ id: 'j1' }] });
    ok('REPRO: install complete, $4,620 paid via Stripe → the draft final is $4,620 with a −$4,620 "Less deposit paid" line',
      r.action === 'create' && r.invoice.total === 4620 && r.invoice.items.some((i) => i.credit === true && i.total === -4620 && /^Less deposit paid/.test(i.description))
      && r.invoice.creditedInvoiceIds && r.invoice.creditedInvoiceIds[0] === 'M1',
      JSON.stringify(r && r.invoice ? { total: r.invoice.total, items: r.invoice.items } : r));
    const two = D.decideFinalDraft({ leadId: 'L1', lead: lead(), est: est(), estimateId: 'E1', nowMs: NOW, invoices: [mirror()], jobs: [{ id: 'j1' }, { id: 'j2' }] });
    ok('two jobs → the full $9,240, no credit (unchanged, documented)', two.action === 'create' && two.invoice.total === 9240 && !two.invoice.items.some((i) => i.credit));
  }
  if (DD) {
    const db = makeTxDb({
      'leads/L1': lead(), 'estimates/E1': est(), 'leads/L1/jobs/j1': { title: 'Roof', companyId: 'u1', userId: 'u1' },
      'invoices/M1': mirror(),
    });
    const FV = { serverTimestamp: () => '__TS__' };
    const out = await DD.draftFinalAtInstall(db, { leadId: 'L1', sourceId: 's' }, { FieldValue: FV, logger: { info() {}, warn() {}, error() {} }, now: () => NOW });
    const inv = db.store.get('invoices/finaldraft_L1_j1') || {};
    ok('draftFinalAtInstall reads leads/L1/jobs and writes the final at $4,620 (not $9,240)',
      out.created === true && inv.total === 4620 && inv.items.some((i) => i.credit === true && i.total === -4620), JSON.stringify(out) + ' total=' + inv.total);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n3. the Stripe ledger stamps a new mirror with the job (functions/stripe-ledger-logic.js)');
  if (L) {
    const srcMs = Date.parse(PAID_AT);
    ok('functions/stripe-ledger-logic.js exports mirrorJobStamp', typeof L.mirrorJobStamp === 'function');
    const stampOf = (...a) => (typeof L.mirrorJobStamp === 'function' ? L.mirrorJobStamp(...a) : null);
    ok('mirrorJobStamp: one job + primary estimate + paid after it → { jobId: j1, estimateId: E1 }',
      JSON.stringify(stampOf(lead(), [{ id: 'j1' }], est(), srcMs)) === JSON.stringify({ jobId: 'j1', estimateId: 'E1' }));
    ok('mirrorJobStamp: two jobs → {} (never guesses which)', JSON.stringify(stampOf(lead(), [{ id: 'j1' }, { id: 'j2' }], est(), srcMs)) === '{}');
    ok('mirrorJobStamp: paid before the estimate (an earlier roof, a backlog sync) → {}',
      JSON.stringify(stampOf(lead(), [{ id: 'j1' }], est(), Date.parse('2025-01-01T00:00:00Z'))) === '{}');
    ok('mirrorJobStamp: no primary estimate / a deleted one / no jobs / the lone job is not the active one → {}',
      JSON.stringify(stampOf(lead({ primaryEstimateId: null }), [{ id: 'j1' }], est(), srcMs)) === '{}'
      && JSON.stringify(stampOf(lead(), [{ id: 'j1' }], est({ deleted: true }), srcMs)) === '{}'
      && JSON.stringify(stampOf(lead(), [], est(), srcMs)) === '{}'
      && JSON.stringify(stampOf(lead({ activeJobId: 'j9' }), [{ id: 'j1' }], est(), srcMs)) === '{}');
    const sInv = { object: 'invoice', id: 'in_dep', total: 462000, subtotal: 462000, created: Math.floor(srcMs / 1000), number: 'X-1', lines: { data: [{ description: 'Deposit', amount: 462000, quantity: 1 }] } };
    const stamped = L.mirrorInvoice(sInv, lead(), 'OWNER', NOW, { jobId: 'j1', estimateId: 'E1' });
    const bare = L.mirrorInvoice(sInv, lead(), 'OWNER', NOW);
    ok('mirrorInvoice(…, stamp) carries jobId + estimateId; without a stamp the doc is unchanged (no jobId key)',
      stamped.jobId === 'j1' && stamped.estimateId === 'E1' && !('jobId' in bare) && !('estimateId' in bare) && stamped.total === 4620);
  }
  if (LEDGER && LEDGER._internal && IFE) {
    const X = LEDGER._internal;
    const db = makeLedgerDb({
      'leads/L1': lead({ companyId: 'OWNER', userId: 'OWNER' }), 'leads/L1/jobs/j1': { title: 'Roof' }, 'estimates/E1': est({ companyId: 'OWNER' }),
    });
    const leadDoc = lead({ companyId: 'OWNER', userId: 'OWNER' });
    const ctx = { db, leads: new Map([['L1', leadDoc]]), invoicesByLead: new Map(), invoicesById: new Map() };
    const sInv = { object: 'invoice', id: 'in_dep', status: 'paid', total: 462000, subtotal: 462000, amount_paid: 462000, created: Math.floor(Date.parse(PAID_AT) / 1000),
      number: 'X-1', lines: { data: [{ description: 'Deposit', amount: 462000, quantity: 1 }] } };
    const r = await X.book(ctx, { leadId: 'L1', mv: { key: 'ch_dep', amountCents: 462000, atMs: Date.parse(PAID_AT), method: 'card' }, stripeInvoice: sInv, dryRun: false });
    const made = db.dump('invoices')[0] || {};
    ok('book(): a deposit paid in Stripe with no CRM invoice → a PAID mirror stamped jobId j1 / estimateId E1',
      r.created === true && made.status === 'paid' && made.jobId === 'j1' && made.estimateId === 'E1' && made.amountPaid === 4620, JSON.stringify(made).slice(0, 300));
    ok('…and that mirror is credited on the final with no other help (planJobInvoice, no opts)',
      IFE.planJobInvoice(TOTAL_C, [Object.assign({ id: 'MX' }, made)], 'j1').creditCents === 462000);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n4. Create Invoice in the browser (docs/pro/js/invoice-pipeline.js createOrOpenJobInvoice), run for real');
  {
    const seedB = (jobs) => Object.assign({ 'estimates/E1': est(), 'leads/L1': lead(), 'invoices/M1': mirror() }, jobs);
    let B = browser(seedB({ 'leads/L1/jobs/j1': { title: 'Roof' } }));
    const IP = req('docs/pro/js/invoice-pipeline.js');
    if (IP) {
      ok('the browser exports soleJobOf too (parity)', typeof IP.soleJobOf === 'function' && IP.soleJobOf([{ id: 'j1' }], 'j1') === true);
      let r = await IP.createOrOpenJobInvoice('E1');
      let inv = B.added[0] || {};
      ok('REPRO: Create Invoice after a $4,620 Stripe-dashboard deposit, one job → a FINAL invoice of $4,620 with "Less deposit paid"',
        r.reused === false && B.added.length === 1 && inv.total === 4620 && inv.items.some((i) => i.credit === true && i.total === -4620) && inv.creditTotal === 4620,
        JSON.stringify({ total: inv.total, items: inv.items }));
      B = browser(seedB({ 'leads/L1/jobs/j1': { title: 'Roof' }, 'leads/L1/jobs/j2': { title: 'Gutters' } }));
      r = await IP.createOrOpenJobInvoice('E1');
      inv = B.added[0] || {};
      ok('two jobs → the full $9,240, no credit (unchanged, documented)', B.added.length === 1 && inv.total === 9240 && !inv.items.some((i) => i.credit), 'total=' + inv.total);
      B = browser(seedB({ 'leads/L1/jobs/j1': { title: 'Roof' } }), { failJobs: true });
      r = await IP.createOrOpenJobInvoice('E1');
      inv = B.added[0] || {};
      ok('the jobs read fails → treated as multi-job (no credit), the invoice is still made', B.added.length === 1 && inv.total === 9240, 'total=' + inv.total);
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

// ── fakes ───────────────────────────────────────────────────────────────
// A browser window for invoice-pipeline.js (money-getting-paid's sandbox,
// with path-aware collection() so leads/{id}/jobs reads its own docs).
function browser(seed, extra) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const added = [];
  let seq = 0;
  const W = {
    _db: { fake: true },
    doc: (db, ...segs) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
    collection: (db, ...segs) => ({ col: segs.join('/') }),
    where: (f, op, v) => ({ f, op, v }),
    query: (c, ...ws) => ({ col: c.col, ws }),
    getDoc: async (r) => ({ exists: () => store.has(r.path), data: () => JSON.parse(JSON.stringify(store.get(r.path))) }),
    getDocs: async (q) => {
      if (extra && extra.failJobs && /\/jobs$/.test(q.col)) throw new Error('permission-denied');
      const docs = [];
      const depth = q.col.split('/').length + 1;
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== depth || !k.startsWith(q.col + '/')) continue;
        if ((q.ws || []).every((w) => v[w.f] === w.v)) docs.push({ id: parts[parts.length - 1], data: () => JSON.parse(JSON.stringify(v)) });
      }
      return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
    },
    updateDoc: async (r, patch) => { store.set(r.path, Object.assign({}, store.get(r.path), JSON.parse(JSON.stringify(patch)))); },
    addDoc: async (c, data) => { const id = 'new' + (++seq); added.push(Object.assign({ id }, data)); store.set(c.col + '/' + id, JSON.parse(JSON.stringify(data))); return { id }; },
    setDoc: async (r, data) => { store.set(r.path, JSON.parse(JSON.stringify(data))); },
    NBDJurisdiction: req('docs/pro/js/ky-insurance-law.js'),
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    _auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok' } },
    _user: { uid: 'u1' },
    _userClaims: {},
    _leads: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
  };
  Object.assign(W, extra || {});
  global.window = W;
  global.showToast = () => {};
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  return { W, store, added };
}
// Transactional Firestore keyed by full path (deposit-draft's shape).
function makeTxDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const ref = (p) => ({ path: p, id: p.split('/').pop(), collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)) }; } });
  const query = (c, filters, lim) => ({
    where: (f, op, v) => query(c, filters.concat([[f, v]]), lim),
    limit: (n) => query(c, filters, n),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== c.split('/').length + 1 || !k.startsWith(c + '/')) continue;
        if (filters.every(([f, val]) => v[f] === val)) docs.push({ id: parts[parts.length - 1], data: () => clone(v) });
      }
      return { docs: docs.slice(0, lim || docs.length) };
    },
  });
  const col = (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, [], 0));
  return {
    store, collection: col,
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(r.path, clone(d)); }),
        set: (r, d) => pending.push(() => store.set(r.path, clone(d))),
        update: (r, p) => pending.push(() => store.set(r.path, Object.assign({}, store.get(r.path), clone(p)))),
      };
      const out = await fn(tx);
      pending.forEach((f) => f());
      return out;
    },
  };
}
// The ledger's Firestore: auto ids, Dates kept, subcollections by path.
function makeLedgerDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  let auto = 0;
  const ref = (p) => ({ path: p, id: p.split('/').pop(), collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { id: p.split('/').pop(), exists: d !== undefined, data: () => (d === undefined ? undefined : Object.assign({}, d)) }; },
    async set(d) { store.set(p, Object.assign({}, d)); },
    async update(patch) { store.set(p, Object.assign({}, store.get(p), patch)); } });
  const query = (c, lim) => ({
    limit: (n) => query(c, n),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length === c.split('/').length + 1 && k.startsWith(c + '/')) docs.push({ id: parts[parts.length - 1], data: () => Object.assign({}, v) });
      }
      return { docs: docs.slice(0, lim || docs.length) };
    },
  });
  const col = (c) => Object.assign({ doc: (id) => ref(c + '/' + (id || ('auto' + (++auto)))) }, query(c, 0));
  return {
    collection: col,
    async runTransaction(fn) {
      const ops = [];
      const tx = { get: (r) => r.get(), set: (r, d) => ops.push(() => r.set(d)), update: (r, p) => ops.push(() => r.update(p)) };
      const out = await fn(tx);
      for (const op of ops) await op();
      return out;
    },
    dump: (c) => [...store.entries()].filter(([k]) => k.startsWith(c + '/') && k.split('/').length === 2).map(([k, v]) => Object.assign({ id: k.split('/')[1] }, v)),
  };
}
