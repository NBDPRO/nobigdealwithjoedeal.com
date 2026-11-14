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
const { installSupplementCallable } = require('./lib/supplement-callable-fake');
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
    // doc(collectionRef) mints an auto id, like the v9 SDK.
    doc: (db, ...segs) => {
      if (db && db.col && !segs.length) { const id = 'auto' + (++seq); return { path: db.col + '/' + id, id }; }
      return { path: segs.join('/'), id: segs[segs.length - 1] };
    },
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
    // writeBatch: all or nothing. opts.failBatch(ops) → the commit is refused
    // (the rules denying the stamp) and NOTHING is written.
    writeBatch: () => {
      const ops = [];
      return {
        set: (r, data) => { ops.push(['set', r.path, data]); },
        update: (r, patch) => { ops.push(['update', r.path, patch]); },
        commit: async () => {
          if (opts.failBatch && opts.failBatch(ops)) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
          for (const [k, p, d] of ops) {
            if (k === 'update' && !store.has(p)) throw new Error('NOT_FOUND ' + p);
            writes.push([k === 'set' ? 'batch-set' : 'batch-update', p]);
            store.set(p, k === 'set' ? clone(d) : Object.assign({}, store.get(p), clone(d)));
          }
        },
      };
    },
    serverTimestamp: () => '__TS__',
    NBDComms: { sendEmail: async () => ({ success: true }), sendSMS: async () => ({ success: true }) },
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    NBDJurisdiction: req('docs/pro/js/ky-insurance-law.js'),
    NBDCustomerEstimateRows: CER_CLIENT,
    _auth: { currentUser: Object.assign({ uid, getIdToken: async () => 'tok' },
      ('tokenClaims' in opts) ? { getIdTokenResult: async () => { if (opts.tokenClaims instanceof Error) throw opts.tokenClaims; return { claims: opts.tokenClaims }; } } : {}) },
    _user: { uid },
    _userClaims: ('claims' in opts) ? opts.claims : {},
    _leads: [],
    _estimates: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: (m, k) => { toasts.push([m, k]); },
  };
  const toasts = [];
  // The supplement invoice is the SERVER's (functions/supplement-invoice.js);
  // run the real handler over this same store (tests/lib/supplement-callable-fake.js).
  const srv = installSupplementCallable(W, store, () => ({ uid,
    token: (('tokenClaims' in opts) && !(opts.tokenClaims instanceof Error)) ? (opts.tokenClaims || {}) : (opts.claims || {}) }), opts);
  W.__calls = srv.calls;
  global.window = W;
  global.showToast = (m, k) => { toasts.push([m, k]); };
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  W.InvoicePipeline = IP;
  return { W, store, writes, toasts };
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
// The rep's $2,000 supplement, saved with companyId, APPROVED by the company
// owner side with the carrier's evidence (Joe, 2026-11-14).
const EVID = { approvedBy: 'carol', approvedAt: 1, approvalEvidence: { note: 'Carrier letter 2026-11-10: ice & water approved.' } };
const sup = (f) => Object.assign({ parentEstimateId: 'estC', leadId: 'L1', userId: 'rep1', companyId: 'co-a', version: 1,
  status: 'approved', supplementTotal: 2000, reason: 'Ice & water shield' }, EVID, f || {});
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
  await sec('A4 a solo owner bills their own supplement; one saved before companyId waits for the backfill review', async () => {
    if (!IP) return;
    let B = browser({ 'leads/L1': lead({ userId: 'u1', companyId: 'u1' }), 'estimates/estC': est({ userId: 'u1', companyId: 'u1' }),
      'supplements/s1': sup({ userId: 'u1', companyId: 'u1', approvedBy: 'u1' }) }, { uid: 'u1', claims: {} });
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('solo invoice did not throw', false, e.message); }
    let inv = invoicesOf(B.store)[0];
    ok('the solo owner\'s invoice is $16,000', inv && c(inv.total) === 1600000, inv && inv.total);
    B = browser({ 'leads/L1': lead({ userId: 'u1', companyId: 'u1' }), 'estimates/estC': est({ userId: 'u1', companyId: 'u1' }),
      'supplements/s1': sup({ userId: 'u1', companyId: undefined, approvedBy: 'u1' }) }, { uid: 'u1', claims: {} });
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('…one saved before companyId (legacy) is refused with the backfill message, not billed or dropped',
      !!err && /backfill/.test(err.message) && invoicesOf(B.store).length === 0, err ? err.message : JSON.stringify(invoicesOf(B.store).map((i) => i.total)));
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
  await sec('C2 the timeline names a LEGACY supplement this account can read', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(),
      'supplements/sOld': sup({ companyId: undefined, userId: 'carol' }),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'carol', supplementId: 'sOld', parentEstimateId: 'estC', version: 1 } },
    CAROL);
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('a readable legacy supplement (no companyId) is refused for the backfill review, not billed blind',
      !!err && /backfill/.test(err.message) && invoicesOf(B.store).length === 0, err ? err.message : JSON.stringify(invoicesOf(B.store).map((i) => i.total)));
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

  // ════════════════════════════════════════════════════════════════════
  // Review round 1 (2026-11-14): silent-failure + security review of #3060
  // ════════════════════════════════════════════════════════════════════
  console.log('\nE1. A legacy supplement (no companyId) with NO timeline entry, and the backfill');
  await sec('E1', async () => {
    if (!IP) return;
    const BF = req('scripts/backfill-supplement-company-id.js');
    const legacy = sup({ companyId: undefined });
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': legacy }, CAROL);
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { /* reported below */ }
    const inv = invoicesOf(B.store)[0];
    ok('KNOWN GAP (pinned, Joe decides): with no companyId and no timeline entry the office cannot see it — $14,000',
      inv && c(inv.total) === 1400000, inv && inv.total);
    ok('the backfill planner exists (scripts/backfill-supplement-company-id.js planBackfill)', !!(BF && typeof BF.planBackfill === 'function'));
    if (!BF || typeof BF.planBackfill !== 'function') return;
    const plan = BF.planBackfill([
      { id: 's1', data: legacy },
      { id: 's2', data: sup() },                                              // already stamped: untouched
      { id: 's3', data: sup({ companyId: undefined, parentEstimateId: 'gone' }) }, // parent missing: reported, untouched
      { id: 's4', data: sup({ companyId: undefined, parentEstimateId: 'estX' }) }, // parent has no companyId: reported
      { id: 's5', data: sup({ companyId: undefined, parentEstimateId: 'estY', userId: 'eve' }) }, // creator is not the estimate's tenant member? still the estimate's tenant
    ], { estC: est(), estX: est({ companyId: undefined }), estY: est({ companyId: 'co-b', userId: 'eve' }) });
    ok('it stamps companyId from the parent estimate', JSON.stringify(plan.updates) === JSON.stringify([
      { id: 's1', companyId: 'co-a' }, { id: 's5', companyId: 'co-b' }]), JSON.stringify(plan.updates));
    ok('it never touches an already-stamped supplement and reports the ones it cannot place',
      plan.skipped.already === 1 && plan.problems.map((p) => p.id).join(',') === 's3,s4', JSON.stringify(plan));
    B.store.set('supplements/s1', Object.assign({}, legacy, { companyId: 'co-a' }));
    for (const k of [...B.store.keys()]) if (k.startsWith('invoices/')) B.store.delete(k);
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('after backfill: did not throw', false, e.message); }
    const inv2 = invoicesOf(B.store)[0];
    ok('after the backfill the office invoice is $16,000', inv2 && c(inv2.total) === 1600000, inv2 && inv2.total);
  });

  console.log('\nE2. Claims come from the ID token, not a cache that may not have loaded');
  await sec('E2', async () => {
    if (!IP) return;
    let B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() },
      { uid: 'carol', claims: {}, tokenClaims: { role: 'company_admin', companyId: 'co-a' } });
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('did not throw', false, e.message); }
    let inv = invoicesOf(B.store)[0];
    ok('cached claims empty, token says company_admin → the team query runs: $16,000', inv && c(inv.total) === 1600000, inv && inv.total);
    B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() },
      { uid: 'carol', claims: undefined });
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('no token API and no cached claims → refused, not an own-only read', !!err && err.code === 'SUPPLEMENTS_UNREADABLE' && invoicesOf(B.store).length === 0,
      err ? err.message : JSON.stringify(invoicesOf(B.store).map((i) => i.total)));
    B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() },
      { uid: 'carol', claims: { role: 'company_admin', companyId: 'co-a' }, tokenClaims: new Error('network') });
    err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('the token read fails → refused', !!err && err.code === 'SUPPLEMENTS_UNREADABLE' && invoicesOf(B.store).length === 0, err && err.message);
  });

  console.log('\nE3. Only this company\'s supplements are billed, even for a platform admin');
  await sec('E3', async () => {
    if (!IP) return;
    const JOE = { uid: 'joe', claims: { role: 'admin', companyId: 'co-a' } };
    let B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup(),
      'supplements/sB': sup({ userId: 'eve', companyId: 'co-b', supplementTotal: 9999, version: 2 }),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'eve', supplementId: 'sB', parentEstimateId: 'estC', version: 2 } }, JOE);
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('did not throw', false, e.message); }
    let inv = invoicesOf(B.store)[0];
    ok('a co-b supplement named on the timeline is NOT billed by the platform admin ($16,000)', inv && c(inv.total) === 1600000, inv && inv.total);
    B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup(),
      'supplements/sL': sup({ companyId: undefined, version: 2 }),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'rep1', supplementId: 'sL', parentEstimateId: 'estC', version: 2 } }, JOE);
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('a teammate\'s legacy supplement (no companyId) the admin can read but cannot place → refused', !!err && err.code === 'SUPPLEMENTS_UNREADABLE' && invoicesOf(B.store).length === 0, err && err.message);
  });

  console.log('\nE4. The invoice and the billed stamps are the SERVER\'s (createSupplementInvoice), never the browser\'s');
  await sec('E4', async () => {
    if (!IP) return;
    const REP = { uid: 'rep1', claims: { role: 'sales_rep', companyId: 'co-a' } };
    const refused = Object.assign(new Error('Invoice not made: the supplements changed.'), { code: 'functions/failed-precondition' });
    let B = browser({ 'estimates/estC': est({ leadId: null }), 'supplements/s1': sup({ leadId: null }) }, Object.assign({ callableFail: refused }, REP));
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('the server refuses → NO invoice, the server\'s words shown, nothing written by the browser',
      !!err && /supplements changed/.test(err.message) && invoicesOf(B.store).length === 0 && !B.writes.some((w) => /^(add|batch|update)/.test(w[0])),
      err ? err.message : JSON.stringify(B.writes));
    B = browser({ 'estimates/estC': est({ leadId: null }), 'supplements/s1': sup({ leadId: null }) }, REP);
    let r = null;
    try { r = await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('server path did not throw', false, e.message); }
    const inv = invoicesOf(B.store)[0];
    ok('one $16,000 invoice made by the server, the supplement stamped with it, the browser wrote nothing to supplements',
      inv && c(inv.total) === 1600000 && B.store.get('supplements/s1').invoicedInvoiceId === (r && r.invoiceId)
        && JSON.stringify(inv.supplementIds) === '["s1"]' && B.W.__calls.length === 1 && B.W.__calls[0].data.estimateId === 'estC'
        && !B.writes.some((w) => w[1] && String(w[1]).startsWith('supplements/')),
      JSON.stringify({ total: inv && inv.total, ids: inv && inv.supplementIds, sup: B.store.get('supplements/s1'), writes: B.writes }));
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('second invoice did not throw', false, e.message); }
    const second = invoicesOf(B.store).filter((i) => i._id !== 'invoices/' + (r && r.invoiceId))[0];
    ok('a second (progress) invoice for the same estimate does NOT bill the supplement again ($14,000)', second && c(second.total) === 1400000, second && second.total);
    B = browser({ 'estimates/estC': est({ leadId: null }), 'supplements/s1': sup({ leadId: null }) }, REP);
    B.W._httpsCallable = undefined; B.W._functions = undefined;
    B.W.__importFunctions = async () => { throw new Error('offline'); };
    err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('the server cannot be reached → refused rather than billed by the browser', !!err && invoicesOf(B.store).length === 0, err && err.message);
  });

  console.log('\nF. The lead id reaches the timeline check from Record payment, and staff never skip it');
  await sec('F', async () => {
    if (!IP) return;
    const legacyOnTimeline = (extra) => Object.assign({ 'leads/L1': lead(), 'estimates/estC': est({ leadId: null }),
      'supplements/sOld': sup({ companyId: undefined, leadId: 'L1', version: 2 }),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'rep1', supplementId: 'sOld', parentEstimateId: 'estC', version: 2 } }, extra || {});
    let B = browser(legacyOnTimeline(), Object.assign({ canRead: (p, d) => d.userId === 'carol' }, CAROL));
    let err = null;
    try {
      await IP.recordPaymentCommit({ leadId: 'L1', lead: Object.assign({ id: 'L1' }, lead()), target: { kind: 'estimate', estimateId: 'estC' },
        totalCents: 1400000, amount: '14000.00', method: 'check', at: new Date() });
    } catch (e) { err = e; }
    ok('Record payment on a leadless estimate checks the lead\'s timeline → refused', !!err && err.code === 'SUPPLEMENTS_UNREADABLE' && invoicesOf(B.store).length === 0,
      err ? err.message : JSON.stringify(invoicesOf(B.store).map((i) => i.total)));
    B = browser({ 'estimates/estC': est({ leadId: null }) }, CAROL);
    err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('office invoicing a teammate\'s estimate with no lead at all → refused (no timeline to check)', !!err && err.code === 'SUPPLEMENTS_UNREADABLE' && invoicesOf(B.store).length === 0, err && err.message);
    B = browser({ 'estimates/estC': est({ leadId: null }) }, { uid: 'rep1', claims: { role: 'sales_rep', companyId: 'co-a' } });
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('own leadless estimate did not throw', false, e.message); }
    ok('a rep invoicing their OWN leadless estimate still works ($14,000)', invoicesOf(B.store).length === 1);
  });

  console.log('\nG. A failed timeline write on save is retried, then the rep is warned');
  await sec('G', async () => {
    const run = async (actFailures) => {
      let n = 0; const toastsG = []; const acts = [];
      global.window = {
        db: {}, auth: { currentUser: { uid: 'rep1', getIdTokenResult: async () => ({ claims: { role: 'sales_rep', companyId: 'co-a' } }) } },
        collection: (db, p) => ({ col: p }), serverTimestamp: () => '__TS__',
        showToast: (m, k) => toastsG.push([m, k]),
        addDoc: async (col, data) => {
          if (col.col !== 'supplements') { if (n++ < actFailures) throw new Error('offline'); acts.push(data); }
          return { id: 'x1' };
        },
      };
      delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/estimate-supplement.js'))];
      const ES = req('docs/pro/js/estimate-supplement.js');
      const id = ES ? await ES.saveToFirestore({ leadId: 'L1', parentEstimateId: 'estC', version: 1, status: 'draft' }) : null;
      return { id, toastsG, acts };
    };
    const once = await run(1);
    ok('one failure → retried, the timeline entry is written, no warning', once.id === 'x1' && once.acts.length === 1 && once.toastsG.length === 0, JSON.stringify(once));
    const twice = await run(2);
    ok('two failures → the supplement is saved and the rep is WARNED it is missing from the timeline',
      twice.id === 'x1' && twice.acts.length === 0 && twice.toastsG.some(([m, k]) => k === 'warning' && /timeline/i.test(m)), JSON.stringify(twice.toastsG));
  });

  console.log('\nI. The Home pay link stops waiting the moment Record payment refuses');
  await sec('I', async () => {
    const vm = require('vm');
    let qs = 0;
    const sbx = {
      URLSearchParams, console, setTimeout, clearTimeout, Date, Promise,
      document: { documentElement: { style: { opacity: '1' } }, querySelector: () => { qs++; return null; }, getElementById: () => null },
    };
    sbx.window = sbx;
    Object.assign(sbx, {
      location: { search: '?id=L1&pay=I1', pathname: '/pro/customer.html', hash: '' },
      history: { state: null, replaceState() {} },
      _customerId: 'L1', _userClaims: { role: 'company_admin', companyId: 'co-a' },
      showToast() {},
      NBDCustomerInvoices: { recordPayment: () => Promise.resolve() },   // refused: no sheet ever opens
    });
    vm.createContext(sbx);
    vm.runInContext(require('fs').readFileSync(path.join(ROOT, 'docs/pro/js/customer-pay-link.js'), 'utf8'), sbx);
    await new Promise((r) => setTimeout(r, 1200));
    const at1 = qs;
    await new Promise((r) => setTimeout(r, 1000));
    ok('no more polling for a sheet once recordPayment has settled without one', qs === at1, 'querySelector calls ' + at1 + ' → ' + qs);
  });

  console.log('\nJ. "No estimate total" (job value) does not slip past an unreadable supplement');
  await sec('J', async () => {
    if (!IP) return;
    browser({ 'leads/L1': lead({ jobValue: 14000 }), 'estimates/estC': est({ grandTotal: 0, subtotal: 0, rows: [] }), 'supplements/s1': sup() },
      Object.assign({ failSupplementQueries: true }, CAROL));
    let err = null, ctx = null;
    try { ctx = await IP.recordPaymentContext('L1'); } catch (e) { err = e; }
    ok('the job-value path is refused too when the supplements cannot be read', !!err && err.code === 'SUPPLEMENTS_UNREADABLE', err ? err.message : JSON.stringify(ctx && ctx.target));
  });

  // ════════════════════════════════════════════════════════════════════
  // Second security pass (2026-11-14)
  // ════════════════════════════════════════════════════════════════════
  console.log('\nK. Soft-deleted supplements are never billed and never block (M-B)');
  await sec('K', async () => {
    if (!IP) return;
    let B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup({ deleted: true }) }, CAROL);
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('did not throw', false, e.message); }
    let inv = invoicesOf(B.store)[0];
    ok('an approved but soft-deleted supplement is not billed ($14,000)', inv && c(inv.total) === 1400000, inv && inv.total);
    B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/sD': sup({ deleted: true, version: 2 }),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'rep1', supplementId: 'sD', parentEstimateId: 'estC', version: 2 } }, CAROL);
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    inv = invoicesOf(B.store)[0];
    ok('a timeline entry naming a soft-deleted supplement does not block, and it is not billed ($14,000)', !err && inv && c(inv.total) === 1400000, err ? err.message : inv && inv.total);
    B = browser({ 'leads/L1': lead(), 'estimates/estC': est(),
      'leads/L1/activity/a1': { type: 'supplement_created', source: 'rep', userId: 'rep1', supplementId: 'gone', parentEstimateId: 'estC', version: 3 } }, CAROL);
    err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('a timeline entry naming a supplement that no longer exists does not block (rules now answer exists() == false)',
      !err && invoicesOf(B.store).length === 1, err && err.message);
    ok('selectBillableSupplements skips a deleted supplement', IP.selectBillableSupplements([sup({ id: 'x', deleted: true })]).length === 0);
  });

  console.log('\nL. The invoice\'s companyId comes from the live claims too (L-A), and a failed save says why (L-B)');
  await sec('L1 createOrOpenJobInvoice', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(), 'supplements/s1': sup() },
      { uid: 'carol', claims: {}, tokenClaims: { role: 'company_admin', companyId: 'co-a' } });
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('did not throw', false, e.message); }
    const inv = invoicesOf(B.store)[0];
    ok('cached claims empty, token co-a → the invoice is stamped companyId co-a (was the uid)', inv && inv.companyId === 'co-a', inv && inv.companyId);
  });
  await sec('L2 recordPaymentCommit job-value invoice', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead({ jobValue: 5000 }) },
      { uid: 'carol', claims: {}, tokenClaims: { role: 'company_admin', companyId: 'co-a' } });
    try {
      await IP.recordPaymentCommit({ leadId: 'L1', lead: Object.assign({ id: 'L1' }, lead({ jobValue: 5000 })), target: { kind: 'jobValue', suggestedCents: 500000 },
        totalCents: 500000, amount: '5000.00', method: 'check', at: new Date() });
    } catch (e) { ok('did not throw', false, e.message); }
    const inv = invoicesOf(B.store)[0];
    ok('the job-value invoice carries companyId co-a from the token (was the uid)', inv && inv.companyId === 'co-a', inv && inv.companyId);
  });
  await sec('L3 saveToFirestore', async () => {
    const run = async (o) => {
      let added = 0;
      global.window = {
        db: {}, auth: { currentUser: { uid: 'rep1', getIdTokenResult: async () => { if (o.tokenThrows) throw new Error('offline'); return { claims: { role: 'sales_rep', companyId: 'co-a' } }; } } },
        collection: (db, p) => ({ col: p }), serverTimestamp: () => '__TS__', showToast() {},
        addDoc: async (col) => {
          if (col.col === 'supplements' && o.denied) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
          added++; return { id: 'x1' };
        },
      };
      delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/estimate-supplement.js'))];
      const ES = req('docs/pro/js/estimate-supplement.js');
      let id = null, err = null;
      try { id = await ES.saveToFirestore({ parentEstimateId: 'estC', version: 1, status: 'draft' }); } catch (e) { err = e; }
      return { id, err, added };
    };
    const a = await run({ tokenThrows: true });
    ok('the token read fails and no claims are cached → not saved, and the rep is told why (no uid-as-companyId guess)',
      a.added === 0 && !!a.err && /not saved/i.test(a.err.message), JSON.stringify({ added: a.added, err: a.err && a.err.message, id: a.id }));
    const b = await run({ denied: true });
    ok('the rules refuse the save → the rep is told it was not saved and why', !!b.err && /not saved/i.test(b.err.message), JSON.stringify({ err: b.err && b.err.message, id: b.id }));
  });

  console.log('\nM. The backfill only stamps a supplement whose author belongs to the estimate\'s tenant (M-C, reviewer #7)');
  await sec('M', async () => {
    const BF = req('scripts/backfill-supplement-company-id.js');
    if (!BF) return;
    const L = (f) => sup(Object.assign({ companyId: undefined }, f));
    const plan = BF.planBackfill([
      { id: 'own', data: L({ userId: 'rep1' }) },                                   // the estimate's own author
      { id: 'mate', data: L({ userId: 'rep2' }) },                                  // a co-a teammate
      { id: 'evil', data: L({ userId: 'eve', supplementTotal: 25000 }) },           // co-b user on co-a's estimate (#7)
      { id: 'nobody', data: L({ userId: 'ghost' }) },                               // author's tenant unknown
      { id: 'lead', data: L({ userId: 'rep1', leadId: 'L9' }) },                    // lead does not match the estimate's
    ], { estC: est() }, { rep2: 'co-a', eve: 'co-b' });
    ok('stamps only the estimate author\'s and a same-tenant teammate\'s',
      JSON.stringify(plan.updates) === JSON.stringify([{ id: 'own', companyId: 'co-a' }, { id: 'mate', companyId: 'co-a' }]), JSON.stringify(plan.updates));
    ok('#7 reports (never stamps) a co-b author on a co-a estimate, an unknown author and a lead mismatch',
      plan.problems.map((p) => p.id).join(',') === 'evil,nobody,lead', JSON.stringify(plan.problems));
    const src = require('fs').readFileSync(path.join(ROOT, 'scripts/backfill-supplement-company-id.js'), 'utf8');
    ok('the write is an update() (fails on a missing doc), not set(merge)', /\.update\(/.test(src) && !/merge:\s*true/.test(src));
  });

  // ════════════════════════════════════════════════════════════════════
  // Joe's decisions (2026-11-14): only the owner side approves, with evidence
  // ════════════════════════════════════════════════════════════════════
  console.log('\nN. A supplement bills only with an owner-side approval record');
  await sec('N1 the loader', async () => {
    if (!IP) return;
    const B = browser({ 'leads/L1': lead(), 'estimates/estC': est(),
      'supplements/s1': sup({ approvedBy: undefined, approvedAt: undefined, approvalEvidence: undefined, version: 2 }) }, CAROL);
    let err = null;
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { err = e; }
    ok('an approved supplement with no approval record (approved before the rule) refuses the invoice and says to re-approve it',
      !!err && err.code === 'SUPPLEMENTS_UNREADABLE' && /#2/.test(err.message) && /re-approve/.test(err.message) && invoicesOf(B.store).length === 0 && B.W.__calls.length === 0,
      err ? err.message : JSON.stringify(invoicesOf(B.store).map((i) => i.total)));
    const B2 = browser({ 'leads/L1': lead(), 'estimates/estC': est(),
      'supplements/s1': sup({ status: 'submitted', approvedBy: undefined, approvedAt: undefined, approvalEvidence: undefined }) }, CAROL);
    try { await IP.createOrOpenJobInvoice('estC'); } catch (e) { ok('a submitted supplement does not block', false, e.message); }
    ok('a submitted (not yet approved) supplement neither bills nor blocks ($14,000)', invoicesOf(B2.store).length === 1 && c(invoicesOf(B2.store)[0].total) === 1400000);
  });
  await sec('N2 updateResponse writes the approval record', async () => {
    const run = async (resp) => {
      let patch = null;
      global.window = {
        db: {}, auth: { currentUser: { uid: 'carol' } }, serverTimestamp: () => '__TS__',
        doc: (db, c2, id) => ({ path: c2 + '/' + id }),
        updateDoc: async (r, p) => { patch = p; },
      };
      delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/estimate-supplement.js'))];
      const ES = req('docs/pro/js/estimate-supplement.js');
      const okv = ES ? await ES.updateResponse('s1', resp) : null;
      return { okv, patch };
    };
    const a = await run({ status: 'approved', evidenceNote: 'Carrier letter 11/10' });
    ok('approved → status, approvedBy = the caller, approvedAt = server time, approvalEvidence.note',
      a.okv === true && a.patch && a.patch.status === 'approved' && a.patch.approvedBy === 'carol' && a.patch.approvedAt === '__TS__'
        && a.patch.approvalEvidence && a.patch.approvalEvidence.note === 'Carrier letter 11/10', JSON.stringify(a.patch));
    const b = await run({ status: 'partial', approvedAmount: 1500, evidenceNote: '' });
    ok('an approval with no evidence note is not sent (returns false, nothing written)', b.okv === false && b.patch === null, JSON.stringify(b));
    const d = await run({ status: 'denied' });
    ok('a denial needs no evidence and writes no approval record', d.okv === true && d.patch && d.patch.status === 'denied' && !('approvedBy' in d.patch), JSON.stringify(d.patch));
    const e = await run({ status: 'approved', evidenceNote: 'x'.repeat(1001) });
    ok('an evidence note over 1000 characters is refused', e.okv === false && e.patch === null);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
