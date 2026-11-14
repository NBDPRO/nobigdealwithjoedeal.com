/**
 * tests/invoice-supplements-company-2026-11-14.test.js
 *
 * Finding 5 (2026-11-14): an invoice silently left off approved insurance
 * supplements.
 *
 *   invoice-pipeline.js loadEstimateSupplements read supplements with
 *   where('userId','==', <the person invoicing>) and returned [] on ANY error.
 *   A rep enters the supplement; the office (company_admin / manager) makes the
 *   invoice; the office's query matched nothing, so the invoice under-billed by
 *   the approved supplement with no warning. A failed read did the same.
 *
 * After the fix:
 *   A. company staff find the job's supplements by companyId + parentEstimateId
 *      (supplements now carry companyId, stamped at save);
 *   B. a failed supplement read BLOCKS the invoice with a clear message
 *      (createOrOpenJobInvoice), and blocks "make an invoice from the estimate"
 *      in Record payment / Paid in full (recordPaymentContext), while a payment
 *      on an invoice that already exists still goes through;
 *   C. a supplement the lead's timeline says exists but this account cannot
 *      read (an old one saved before companyId) BLOCKS the invoice too;
 *   D. estimate-supplement.js saveToFirestore stamps companyId from the ID
 *      token claims (a solo owner's companyId is their uid).
 *
 * Fake Firestore, synthetic ids and dollars only (public repo).
 * Run: node tests/invoice-supplements-company-2026-11-14.test.js
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

const CER_CLIENT = req('docs/pro/js/customer-estimate-rows.js');
let IP = null;

/**
 * A browser sandbox with a fake Firestore. `opts.uid` / `opts.claims` are the
 * signed-in user. `opts.failSupplementQueries` makes every supplements query
 * throw (an index still building, a network drop, a permission error).
 * `opts.canRead(path, data)` decides single-doc reads of supplements (a
 * stand-in for the rules: returning false throws permission-denied).
 */
function browser(seed, opts) {
  opts = opts || {};
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const writes = [];
  let seq = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const uid = opts.uid || 'u1';
  const W = {
    _db: { fake: true }, db: { fake: true },
    doc: (db, ...segs) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
    collection: (db, ...segs) => ({ col: segs.join('/') }),
    where: (f, op, v) => ({ f, op, v }),
    query: (col, ...ws) => ({ col: col.col, ws }),
    getDoc: async (r) => {
      if (r.path.startsWith('supplements/') && store.has(r.path) && opts.canRead && !opts.canRead(r.path, store.get(r.path))) {
        const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e;
      }
      return { exists: () => store.has(r.path), data: () => (store.has(r.path) ? clone(store.get(r.path)) : undefined) };
    },
    getDocs: async (q) => {
      if (q.col === 'supplements' && opts.failSupplementQueries) {
        const e = new Error('The query requires an index.'); e.code = 'failed-precondition'; throw e;
      }
      const depth = q.col.split('/').length + 1;
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== depth || parts.slice(0, -1).join('/') !== q.col) continue;
        if ((q.ws || []).every((w) => v[w.f] === w.v)) docs.push({ id: parts[parts.length - 1], data: () => clone(v) });
      }
      return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
    },
    updateDoc: async (r, patch) => { if (!store.has(r.path)) throw new Error('NOT_FOUND ' + r.path); writes.push(['update', r.path]); store.set(r.path, Object.assign({}, store.get(r.path), clone(patch))); },
    addDoc: async (col, data) => { const id = 'new' + (++seq); writes.push(['add', col.col + '/' + id]); store.set(col.col + '/' + id, clone(data)); return { id }; },
    setDoc: async (r, data, o) => { writes.push(['set', r.path]); store.set(r.path, (o && o.merge) ? Object.assign({}, store.get(r.path) || {}, clone(data)) : clone(data)); },
    deleteDoc: async (r) => { writes.push(['delete', r.path]); store.delete(r.path); },
    serverTimestamp: () => '__TS__',
    NBDComms: { sendEmail: async () => ({ success: true }), sendSMS: async () => ({ success: true }) },
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    NBDJurisdiction: req('docs/pro/js/ky-insurance-law.js'),
    NBDCustomerEstimateRows: CER_CLIENT,
    _auth: { currentUser: { uid, getIdToken: async () => 'tok' } },
    _user: { uid },
    _userClaims: opts.claims || {},
    _leads: [],
    _estimates: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
  };
  global.window = W;
  global.showToast = () => {};
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  W.InvoicePipeline = IP;
  return { W, store, writes };
}
browser({});
IP = req('docs/pro/js/invoice-pipeline.js');

// A $14,000 insurance estimate the REP wrote, in company co-a.
const est = (f) => Object.assign({
  userId: 'rep1', companyId: 'co-a', leadId: 'L1', grandTotal: 14000, subtotal: 14000, tax: 0, taxRate: 0, mode: 'insurance', addr: OH,
  rows: [{ description: 'Roof', qty: 1, unitPrice: 14000, total: 14000 }],
}, f || {});
const lead = (f) => Object.assign({ userId: 'rep1', companyId: 'co-a', firstName: 'Syn', lastName: 'Thetic', address: OH,
  stage: 'closed', primaryEstimateId: 'estC', insCarrier: 'Carrier', claimNumber: 'C-1', createdAt: 1 }, f || {});
// The rep's approved $2,000 supplement, saved with companyId (after the fix).
const sup = (f) => Object.assign({ parentEstimateId: 'estC', leadId: 'L1', userId: 'rep1', companyId: 'co-a', version: 1,
  status: 'approved', supplementTotal: 2000, reason: 'Ice & water shield' }, f || {});
const CAROL = { uid: 'carol', claims: { role: 'company_admin', companyId: 'co-a' } };
const invoicesOf = (store) => [...store.entries()].filter(([k]) => k.startsWith('invoices/')).map(([id, v]) => Object.assign({ _id: id }, v));

(async () => {
  console.log('\nA. The office invoices a job whose supplement a rep entered');
  await sec('A1', async () => {
    if (!IP) return ok('invoice-pipeline loaded', false);
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() }, CAROL);
    let r = null, err = null;
    try { r = await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    const inv = invoicesOf(B.store)[0];
    ok('the company_admin\'s invoice includes the rep\'s approved $2,000 supplement: $16,000, not $14,000',
      !err && inv && c(inv.total) === 1600000 && c(inv.supplementTotal) === 200000,
      err ? String(err.message) : JSON.stringify(inv && { total: inv.total, supplementTotal: inv.supplementTotal }));
    ok('…and the supplement is stamped with that invoice so it is never billed twice',
      inv && B.store.get('supplements/s1').invoicedInvoiceId === (r && r.invoiceId), JSON.stringify(B.store.get('supplements/s1')));
  });
  await sec('A2 another company\'s supplement on the same estimate id is never folded', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup(),
      'supplements/sx': sup({ userId: 'eve', companyId: 'co-b', supplementTotal: 9999 }) }, CAROL);
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { /* reported below */ }
    const inv = invoicesOf(B.store)[0];
    ok('only co-a\'s supplement is billed ($16,000; co-b\'s $9,999 is not on it)', inv && c(inv.total) === 1600000, inv && inv.total);
  });
  await sec('A3 a rep still bills their own supplement (owner query, unchanged)', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() },
      { uid: 'rep1', claims: { role: 'sales_rep', companyId: 'co-a' } });
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('rep invoice did not throw', false, e.message); }
    const inv = invoicesOf(B.store)[0];
    ok('the rep\'s invoice is $16,000', inv && c(inv.total) === 1600000, inv && inv.total);
  });
  await sec('A4 a solo owner (no claims) still bills their own supplement saved before companyId existed', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead({ userId: 'u1', companyId: 'u1' }), 'estimates/estC': est({ userId: 'u1', companyId: 'u1' }),
      'supplements/s1': sup({ userId: 'u1', companyId: undefined }) }, { uid: 'u1', claims: {} });
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('solo invoice did not throw', false, e.message); }
    const inv = invoicesOf(B.store)[0];
    ok('the solo owner\'s invoice is $16,000', inv && c(inv.total) === 1600000, inv && inv.total);
  });

  console.log('\nB. A failed supplement read blocks the invoice (never a silent under-bill)');
  await sec('B1 createOrOpenJobInvoice', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() },
      Object.assign({ failSupplementQueries: true }, CAROL));
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('no invoice is written when the supplements cannot be read', invoicesOf(B.store).length === 0,
      JSON.stringify(invoicesOf(B.store).map((i) => i.total)));
    ok('the error says why, in plain words (mentions supplements)', !!err && /supplement/i.test(err.message), err && err.message);
    ok('the error carries code SUPPLEMENTS_UNREADABLE', !!err && err.code === 'SUPPLEMENTS_UNREADABLE', err && err.code);
  });
  await sec('B2 recordPaymentContext with no invoice yet', async () => {
    if (!IP) return;
    browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() },
      Object.assign({ failSupplementQueries: true }, CAROL));
    let err = null, ctx = null;
    try { ctx = await IP.recordPaymentContext('L1'); } catch (e) { err = e; }
    ok('"make the invoice from the estimate" is refused when supplements cannot be read',
      !!err && err.code === 'SUPPLEMENTS_UNREADABLE', err ? err.message : JSON.stringify(ctx && ctx.target));
  });
  await sec('B3 recordPaymentContext with an invoice that already exists', async () => {
    if (!IP) return;
    browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup(),
      'invoices/i1': { leadId: 'L1', companyId: 'co-a', createdBy: 'carol', status: 'sent', total: 16000, balanceDue: 16000, estimateId: 'estC' } },
    Object.assign({ failSupplementQueries: true }, CAROL));
    let err = null, ctx = null;
    try { ctx = await IP.recordPaymentContext('L1'); } catch (e) { err = e; }
    ok('a payment on the existing invoice still goes through (supplements are not used there)',
      !err && ctx && ctx.target.kind === 'existing', err ? err.message : JSON.stringify(ctx && ctx.target.kind));
  });

  console.log('\nC. A supplement the timeline knows about but this account cannot read blocks the invoice');
  await sec('C1 an old supplement (no companyId) a rep saved', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(),
      'supplements/sOld': sup({ companyId: undefined, version: 2 }),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'rep1', supplementId: 'sOld', parentEstimateId: 'estC', version: 2 } },
    Object.assign({ canRead: (p, d) => d.userId === 'carol' }, CAROL));
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('no invoice is written', invoicesOf(B.store).length === 0);
    ok('the message names the supplement and says it cannot be read',
      !!err && err.code === 'SUPPLEMENTS_UNREADABLE' && /#2/.test(err.message), err && err.message);
  });
  await sec('C2 the timeline names a supplement this account CAN read (fetched and billed)', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(),
      'supplements/sOld': sup({ companyId: undefined, userId: 'carol' }),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'carol', supplementId: 'sOld', parentEstimateId: 'estC', version: 1 } },
    CAROL);
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('did not throw', false, e.message); }
    const inv = invoicesOf(B.store)[0];
    ok('the invoice is $16,000', inv && c(inv.total) === 1600000, inv && inv.total);
  });
  await sec('C3 a timeline entry for ANOTHER estimate is ignored', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'rep1', supplementId: 'sElse', parentEstimateId: 'estOther', version: 1 } },
    Object.assign({ canRead: () => false }, CAROL));
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    const inv = invoicesOf(B.store)[0];
    ok('the $14,000 invoice is made', !err && inv && c(inv.total) === 1400000, err ? err.message : (inv && inv.total));
  });

  console.log('\nD. Saving a supplement stamps companyId');
  await sec('D1', async () => {
    const run = async (claims, uid) => {
      let saved = null;
      global.window = {
        db: {}, auth: { currentUser: { uid, getIdTokenResult: async () => ({ claims }) } },
        collection: (db, p) => ({ col: p }), serverTimestamp: () => '__TS__',
        addDoc: async (col, data) => { if (col.col === 'supplements') saved = data; return { id: 'x1' }; },
      };
      delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/estimate-supplement.js'))];
      const ES = req('docs/pro/js/estimate-supplement.js');
      if (!ES) return null;
      await ES.saveToFirestore({ parentEstimateId: 'estC', version: 1, status: 'draft' });
      return saved;
    };
    const member = await run({ role: 'sales_rep', companyId: 'co-a' }, 'rep1');
    ok('a company member\'s supplement carries their companyId claim', member && member.companyId === 'co-a', JSON.stringify(member));
    const solo = await run({}, 'solo1');
    ok('a solo owner\'s supplement carries companyId = their uid', solo && solo.companyId === 'solo1', JSON.stringify(solo));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
