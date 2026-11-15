/**
 * tests/supplement-invoice-callable-2026-11-14.test.js
 *
 * Finding 5, Joe's decisions (2026-11-14): an invoice with insurance
 * supplements is made, and the supplements marked billed, by the SERVER
 * (functions/supplement-invoice.js createSupplementInvoice), never the browser.
 *
 *   A. who may bill: the estimate's author, same-company staff, the platform
 *      admin; not another tenant, a teammate rep, a viewer, or signed out.
 *   B. which supplements bill: approved / partial WITH an owner-side approval
 *      record, in the estimate's company, not deleted, not already billed.
 *      Approved without the record, or a legacy one with no companyId, refuses.
 *   C. the money is the server's: base lines from the estimate (its signed
 *      view), supplement lines, credits for the job's earlier invoices, the
 *      deposit — and it matches what the browser computed (parity with
 *      docs/pro/js/invoice-pipeline.js applySupplementsToTotals).
 *   D. one transaction: the invoice is created and every billed supplement is
 *      stamped with it; a second call does not bill them again.
 *
 * Fake Admin Firestore, synthetic ids and dollars only (public repo).
 * Run: node tests/supplement-invoice-callable-2026-11-14.test.js
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
const c = (d) => Math.round(Number(d) * 100);

const SI = req('functions/supplement-invoice.js');
const { TS, cloneKeep, APPROVED_AT, DEFAULT_CLAIMS } = require('./lib/supplement-callable-fake');
const NOW = Date.UTC(2026, 10, 16);

// ── A fake Admin SDK Firestore with transactions ──
function fakeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, cloneKeep(v)]));
  let seq = 0;
  const snap = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => (store.has(p) ? cloneKeep(store.get(p)) : undefined) });
  function col(cpath) {
    const q = (ws) => ({
      _q: true, cpath, ws,
      where: (f, op, v) => q(ws.concat([[f, v]])),
      _run() {
        const depth = cpath.split('/').length + 1;
        const docs = [];
        for (const [k, v] of store) {
          const parts = k.split('/');
          if (parts.length !== depth || parts.slice(0, -1).join('/') !== cpath) continue;
          if (ws.every(([f, val]) => v[f] === val)) docs.push({ id: parts[parts.length - 1], data: () => cloneKeep(v) });
        }
        return { docs, empty: !docs.length };
      },
    });
    const base = q([]);
    base.doc = (id) => {
      const p = cpath + '/' + (id || ('auto' + (++seq)));
      return { _ref: true, path: p, id: p.split('/').pop(), collection: (sub) => col(p + '/' + sub) };
    };
    return base;
  }
  const writes = [];
  const db = {
    store, writes,
    collection: (name) => col(name),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: async (r) => (r._q ? r._run() : snap(r.path)),
        create: (r, d) => { if (store.has(r.path)) throw new Error('ALREADY_EXISTS ' + r.path); pending.push(['create', r.path, d]); },
        update: (r, d) => { pending.push(['update', r.path, d]); },
      };
      const out = await fn(tx);
      for (const [k, p, d] of pending) {
        if (k === 'update' && !store.has(p)) throw new Error('NOT_FOUND ' + p);
        writes.push([k, p]);
        store.set(p, k === 'create' ? cloneKeep(d) : Object.assign({}, store.get(p), cloneKeep(d)));
      }
      return out;
    },
  };
  return db;
}

const OH = '1 Main St, Cincinnati, OH 45202';
const est = (f) => Object.assign({ userId: 'rep1', companyId: 'co-a', leadId: 'L1', grandTotal: 14000, subtotal: 14000, tax: 0, taxRate: 0,
  mode: 'insurance', addr: OH, rows: [{ description: 'Roof', qty: 1, unitPrice: 14000, total: 14000 }] }, f || {});
const lead = (f) => Object.assign({ userId: 'rep1', companyId: 'co-a', firstName: 'Syn', lastName: 'Thetic', address: OH, insCarrier: 'Carrier', claimNumber: 'C-1' }, f || {});
const EVID = { approvedBy: 'carol', approvedAt: APPROVED_AT, approvalEvidence: { note: 'Carrier letter 2026-11-10, adjuster approved ice & water.' } };
const sup = (f) => Object.assign({ parentEstimateId: 'estC', leadId: 'L1', userId: 'rep1', companyId: 'co-a', version: 1,
  status: 'approved', supplementTotal: 2000, reason: 'Ice & water shield' }, EVID, f || {});
const who = (uid, token) => ({ uid, token: token || {} });
const CAROL = who('carol', { role: 'company_admin', companyId: 'co-a' });
const REP = who('rep1', { role: 'sales_rep', companyId: 'co-a' });
const call = async (db, auth, data) => {
  try { return { r: await SI.handleCreateSupplementInvoice({ auth, data }, { db, nowMs: NOW, getClaims: async (uid) => (DEFAULT_CLAIMS[uid] || ({ eve: { role: 'company_admin', companyId: 'co-b' } })[uid] || {}) }) }; }
  catch (e) { return { e }; }
};
const invoicesOf = (db) => [...db.store.entries()].filter(([k]) => k.startsWith('invoices/')).map(([k, v]) => Object.assign({ _id: k.slice(9) }, v));
const seedJob = (extra) => Object.assign({ 'estimates/estC': est(), 'leads/L1': lead(), 'supplements/s1': sup() }, extra || {});

(async () => {
  if (!SI) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }

  console.log('\nA. Who may bill');
  await sec('A', async () => {
    for (const [label, auth, want] of [
      ['the estimate\'s author (rep)', REP, true],
      ['same-company company_admin', CAROL, true],
      ['same-company manager', who('mike', { role: 'manager', companyId: 'co-a' }), true],
      ['platform admin', who('joe', { role: 'admin' }), true],
      ['a teammate sales rep', who('rep2', { role: 'sales_rep', companyId: 'co-a' }), false],
      ['another company\'s admin', who('eve', { role: 'company_admin', companyId: 'co-b' }), false],
      ['a viewer', who('vera', { role: 'viewer', companyId: 'co-a' }), false],
    ]) {
      const db = fakeDb(seedJob());
      const { r, e } = await call(db, auth, { estimateId: 'estC' });
      ok(label + (want ? ' may bill' : ' is refused, with nothing written'),
        want ? (!!r && r.ok && invoicesOf(db).length === 1) : (!!e && invoicesOf(db).length === 0 && db.writes.length === 0),
        e ? e.message : JSON.stringify(r));
    }
    const db = fakeDb(seedJob());
    const { e } = await call(db, null, { estimateId: 'estC' });
    ok('signed out → unauthenticated', !!e && e.code === 'unauthenticated', e && e.code);
    const db2 = fakeDb(seedJob());
    const r2 = await call(db2, CAROL, { estimateId: 'nope' });
    const r3 = await call(fakeDb(seedJob()), who('eve', { role: 'company_admin', companyId: 'co-b' }), { estimateId: 'estC' });
    ok('a missing estimate and another tenant\'s get the SAME refusal', r2.e && r3.e && r2.e.message === r3.e.message, (r2.e && r2.e.message) + ' / ' + (r3.e && r3.e.message));
  });

  console.log('\nB. Which supplements bill');
  await sec('B', async () => {
    let db = fakeDb(seedJob({ 'supplements/s2': sup({ version: 2, status: 'approved', supplementTotal: 500, approvedBy: undefined, approvalEvidence: undefined, approvedAt: undefined }) }));
    let res = await call(db, CAROL, { estimateId: 'estC' });
    ok('an approved supplement WITHOUT an owner approval record refuses the invoice and names it', !!res.e && /#2/.test(res.e.message) && /re-approve/.test(res.e.message) && invoicesOf(db).length === 0, res.e ? res.e.message : JSON.stringify(res.r));
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvalEvidence: { note: '   ' } }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('a blank evidence note does not count', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : '');
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvalEvidence: { path: 'companies/co-a/supplement-evidence/letter.pdf' } }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('an evidence document under the company\'s own folder counts', !!res.r && invoicesOf(db).length === 1, res.e && res.e.message);
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvalEvidence: { path: 'companies/co-b/supplement-evidence/letter.pdf' } }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('…another company\'s folder does not', !!res.e && invoicesOf(db).length === 0);
    db = fakeDb(seedJob({ 'supplements/sL': sup({ companyId: undefined, version: 3 }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('a legacy (no companyId) approved supplement refuses the invoice (backfill review)', !!res.e && /#3/.test(res.e.message) && /backfill/.test(res.e.message), res.e ? res.e.message : '');
    db = fakeDb(seedJob({ 'supplements/sB': sup({ companyId: 'co-b', userId: 'eve', supplementTotal: 9999, version: 4 }),
      'supplements/sD': sup({ deleted: true, version: 5, supplementTotal: 700 }),
      'supplements/sX': sup({ invoicedInvoiceId: 'old', version: 6, supplementTotal: 800 }),
      'supplements/sN': sup({ status: 'denied', version: 7, supplementTotal: 600, approvedBy: undefined, approvalEvidence: undefined }),
      'supplements/sDr': sup({ status: 'draft', version: 8, supplementTotal: 400, approvedBy: undefined, approvalEvidence: undefined }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    const inv = invoicesOf(db)[0];
    ok('another company\'s, deleted, already-billed, denied and draft supplements are not billed; only s1 is ($16,000)',
      !!res.r && inv && c(inv.total) === 1600000 && JSON.stringify(inv.supplementIds) === '["s1"]', res.e ? res.e.message : JSON.stringify(inv && { t: inv.total, ids: inv.supplementIds }));
    db = fakeDb(seedJob({ 'supplements/s1': sup({ status: 'partial', supplementTotal: 3000, submission: { approvedAmount: 1250.5 } }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('a partial approval bills the approved amount ($15,250.50)', !!res.r && c(invoicesOf(db)[0].total) === 1525050, res.e ? res.e.message : invoicesOf(db)[0].total);
    db = fakeDb(seedJob({ 'supplements/s1': sup({ status: 'denied' }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('nothing billable any more → refused with "reload" (the browser saw a stale list)', !!res.e && /changed/.test(res.e.message) && invoicesOf(db).length === 0, res.e && res.e.message);
  });

  console.log('\nC. The money is the server\'s, and matches the browser');
  await sec('C', async () => {
    const db = fakeDb(seedJob({ 'supplements/s2': sup({ version: 2, status: 'partial', supplementTotal: 3000, submission: { approvedAmount: 1250.5 }, reason: 'Drip edge' }) }));
    const { r, e } = await call(db, CAROL, { estimateId: 'estC' });
    const inv = invoicesOf(db)[0];
    ok('the invoice: $14,000 base + $2,000 + $1,250.50 = $17,250.50; supplementTotal $3,250.50; companyId co-a; created by the caller',
      !e && inv && c(inv.total) === 1725050 && c(inv.supplementTotal) === 325050 && inv.companyId === 'co-a' && inv.createdBy === 'carol'
        && inv.status === 'draft' && c(inv.amountPaid) === 0 && c(inv.balanceDue) === 1725050, e ? e.message : JSON.stringify(inv));
    // Parity with the browser's fold (docs/pro/js/invoice-pipeline.js).
    global.window = undefined;
    const IP = req('docs/pro/js/invoice-pipeline.js');
    const CERc = req('docs/pro/js/customer-estimate-rows.js');
    if (IP && CERc) {
      const base = IP.invoiceTotalsFromEstimate(est(), { estimateValue: CERc.estimateValue });
      const folded = IP.applySupplementsToTotals(base, [Object.assign({ id: 's1' }, sup()), Object.assign({ id: 's2' }, sup({ version: 2, status: 'partial', supplementTotal: 3000, submission: { approvedAmount: 1250.5 }, reason: 'Drip edge' }))]);
      ok('parity: the same lines and totals as the browser\'s applySupplementsToTotals',
        inv && JSON.stringify(inv.items) === JSON.stringify(folded.items) && c(inv.total) === c(folded.total) && c(inv.subtotal) === c(folded.subtotal),
        JSON.stringify({ server: inv && inv.items, browser: folded.items }));
    }
    ok('the result says what it billed', r && r.reused === false && c(r.supplementTotal) === 325050 && r.supplementIds.length === 2, JSON.stringify(r));
    // A signed estimate bills its signed price.
    const signedFields = { grandTotal: 13000, subtotal: 13000, tax: 0, taxRate: 0, mode: 'insurance', rows: [{ description: 'Roof', qty: 1, unitPrice: 13000, total: 13000 }] };
    const db2 = fakeDb(seedJob({ 'estimates/estC': est({ signedPrice: { fields: signedFields, totalCents: 1300000, source: 'esign', sourceId: 'env1' } }) }));
    await call(db2, CAROL, { estimateId: 'estC' });
    const inv2 = invoicesOf(db2)[0];
    ok('a signed estimate bills its SIGNED price + the supplement ($15,000)', inv2 && c(inv2.total) === 1500000, inv2 && inv2.total);
    // An earlier deposit invoice is credited (a final invoice).
    const db3 = fakeDb(seedJob({ 'estimates/estC': est({ jobId: 'J1' }),
      'invoices/dep1': { leadId: 'L1', companyId: 'co-a', createdBy: 'rep1', estimateId: 'estC', jobId: 'J1', status: 'paid', total: 5000, amountPaid: 5000, createdAt: 2 },
      'invoices/foreign': { leadId: 'L1', companyId: 'co-b', createdBy: 'eve', jobId: 'J1', status: 'paid', total: 4000, amountPaid: 4000, createdAt: 2 } }));
    const r3 = await call(db3, CAROL, { estimateId: 'estC' });
    const inv3 = invoicesOf(db3).find((i) => i.source === 'supplement_invoice');
    ok('the job\'s paid $5,000 deposit invoice is credited (final $11,000); another company\'s invoice is not',
      inv3 && c(inv3.total) === 1100000 && inv3.kind === 'final' && JSON.stringify(inv3.creditedInvoiceIds) === '["dep1"]', r3.e ? r3.e.message : JSON.stringify(inv3 && { t: inv3.total, k: inv3.kind, cr: inv3.creditedInvoiceIds }));
    // A live invoice for the job is opened, not duplicated (nothing written).
    const db4 = fakeDb(seedJob({ 'invoices/live': { leadId: 'L1', companyId: 'co-a', createdBy: 'rep1', estimateId: 'estC', status: 'sent', total: 16000, amountPaid: 0, createdAt: 2 } }));
    const r4 = await call(db4, CAROL, { estimateId: 'estC' });
    ok('a live invoice covering the job → reused, nothing written, nothing stamped', r4.r && r4.r.reused === true && r4.r.invoiceId === 'live' && db4.writes.length === 0, r4.e ? r4.e.message : JSON.stringify(r4.r));
  });

  console.log('\nD. One transaction: the invoice and the stamps');
  await sec('D', async () => {
    const db = fakeDb(seedJob({ 'supplements/s2': sup({ version: 2, supplementTotal: 300 }) }));
    const { r } = await call(db, REP, { estimateId: 'estC' });
    ok('both supplements are stamped with the new invoice, at the invoice\'s createdAt',
      r && db.store.get('supplements/s1').invoicedInvoiceId === r.invoiceId && db.store.get('supplements/s2').invoicedInvoiceId === r.invoiceId
        && db.store.get('supplements/s1').invoicedAt != null, JSON.stringify(db.store.get('supplements/s1')));
    const again = await call(db, REP, { estimateId: 'estC' });
    ok('a second call does not bill them again (refused: nothing billable; the live invoice is the job\'s bill)',
      !!(again.e || (again.r && again.r.reused)) && invoicesOf(db).length === 1, again.e ? again.e.message : JSON.stringify(again.r));
    const lone = fakeDb({ 'estimates/estC': est({ leadId: null }), 'supplements/s1': sup({ leadId: null }) });
    const rl = await call(lone, CAROL, { estimateId: 'estC' });
    ok('the office on a rep\'s estimate with no customer is refused', !!rl.e && /not linked/.test(rl.e.message), rl.e && rl.e.message);
    const rl2 = await call(lone, REP, { estimateId: 'estC' });
    ok('…its author may still bill it', !!rl2.r && invoicesOf(lone).length === 1, rl2.e && rl2.e.message);
    const fl = fakeDb(seedJob({ 'leads/L1': lead({ companyId: 'co-b', userId: 'eve' }) }));
    const rf = await call(fl, CAROL, { estimateId: 'estC' });
    ok('an estimate pointing at another company\'s lead is refused', !!rf.e && invoicesOf(fl).length === 0, rf.e && rf.e.message);
  });

  // ════════════════════════════════════════════════════════════════════
  // Security review of the server invoice (2026-11-15)
  // ════════════════════════════════════════════════════════════════════
  console.log('\nE. M2 — an approval record must be real (after the cutoff, by the owner side)');
  await sec('E', async () => {
    const before = new TS(SI.APPROVALS_SINCE_MS - 1000);
    let db = fakeDb(seedJob({ 'supplements/s1': sup({ approvedAt: before }) }));
    let res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedAt before the approvals cutoff (forged under the old rules) → refused', !!res.e && /re-approve/.test(res.e.message) && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvedAt: SI.APPROVALS_SINCE_MS + 5000 }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedAt a plain number (not a server Timestamp) → refused', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvedAt: { seconds: Math.floor(SI.APPROVALS_SINCE_MS / 1000) + 60 } }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedAt a plain map shaped like a Timestamp → refused', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvedAt: new TS(NOW + 86400000) }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedAt in the future → refused', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvedBy: 'rep1' }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedBy a sales_rep → refused', !!res.e && /re-approve/.test(res.e.message) && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvedBy: 'eve' }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedBy another company\'s admin → refused', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(seedJob({ 'companies/co-a': { ownerId: 'olga' }, 'supplements/s1': sup({ approvedBy: 'olga' }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedBy the company\'s owner (companies/{id}.ownerId) → billed', !!res.r && invoicesOf(db).length === 1, res.e && res.e.message);
    db = fakeDb(seedJob({ 'supplements/s1': sup({ approvedBy: 'joe' }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('approvedBy the platform admin → billed', !!res.r && invoicesOf(db).length === 1, res.e && res.e.message);
  });

  console.log('\nF. M1 — the lead the invoice bills is the job\'s, not one the rep picked');
  await sec('F', async () => {
    const seedL2 = { 'leads/L2': lead({ userId: 'rep2', firstName: 'Other' }) };
    let db = fakeDb(seedJob(Object.assign({ 'estimates/estC': est({ leadId: 'L2' }) }, seedL2)));
    let res = await call(db, REP, { estimateId: 'estC' });
    ok('a rep repointed the estimate at a teammate\'s customer (L2) → refused', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('…and the office is refused too: the supplements belong to L1', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(Object.assign({ 'estimates/estC': est({ leadId: null }), 'leads/L1': lead(), 'supplements/s1': sup({ leadId: null }) }, seedL2));
    res = await call(db, REP, { estimateId: 'estC', leadId: 'L2' });
    ok('a lead-less estimate + an asked lead that is a teammate\'s (L2) → refused', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(Object.assign({ 'estimates/estC': est({ leadId: null }), 'leads/L1': lead(), 'supplements/s1': sup({ leadId: null }) }, seedL2));
    res = await call(db, REP, { estimateId: 'estC', leadId: 'L1' });
    ok('…an asked lead that is the rep\'s own, but the supplements name no lead → refused (leads must match)', !!res.e && invoicesOf(db).length === 0, res.e ? res.e.message : 'made');
    db = fakeDb(seedJob());
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('Carol on the job\'s own lead L1 → allowed', !!res.r && invoicesOf(db).length === 1, res.e && res.e.message);
  });

  console.log('\nG. M3 — a supplement approved after an earlier supplement invoice still bills');
  await sec('G', async () => {
    const A = { leadId: 'L1', companyId: 'co-a', createdBy: 'carol', estimateId: 'estC', status: 'sent', total: 16000, amountPaid: 0, createdAt: 2,
      supplementIds: ['s1'], supplementTotal: 2000, source: 'supplement_invoice' };
    let db = fakeDb(seedJob({ 'supplements/s1': sup({ invoicedInvoiceId: 'A', invoicedAt: 3 }), 'invoices/A': A,
      'supplements/s2': sup({ version: 2, supplementTotal: 300, reason: 'Drip edge' }) }));
    let res = await call(db, CAROL, { estimateId: 'estC' });
    const inv = invoicesOf(db).find((i) => i._id !== 'A');
    ok('s1 on invoice A ($16,000), s2 approved later ($300) → a new invoice for $300 (A credited), s2 stamped; never "reused" with s2 unbilled',
      !!res.r && res.r.reused === false && inv && c(inv.total) === 30000 && db.store.get('supplements/s2').invoicedInvoiceId === res.r.invoiceId
        && JSON.stringify(inv.supplementIds) === '["s2"]' && db.store.get('supplements/s1').invoicedInvoiceId === 'A',
      res.e ? res.e.message : JSON.stringify({ r: res.r, inv: inv && { t: inv.total, ids: inv.supplementIds } }));
    db = fakeDb(seedJob({ 'supplements/s1': sup({ invoicedInvoiceId: 'A', invoicedAt: 3 }), 'invoices/A': Object.assign({}, A, { status: 'paid', amountPaid: 16000 }),
      'supplements/s2': sup({ version: 2, supplementTotal: 300 }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    const inv2 = invoicesOf(db).find((i) => i._id !== 'A');
    ok('…the same when invoice A is already paid: $300 owed, nothing billed twice', !!res.r && inv2 && c(inv2.total) === 30000, res.e ? res.e.message : JSON.stringify(inv2 && inv2.total));
  });

  console.log('\nH. Credits, retries and messages');
  await sec('H', async () => {
    let db = fakeDb(seedJob({ 'estimates/estC': est({ jobId: 'J1' }),
      'invoices/legacy': { leadId: 'L1', createdBy: 'rep1', estimateId: 'estC', jobId: 'J1', status: 'paid', total: 5000, amountPaid: 5000, createdAt: 2 } }));
    let res = await call(db, CAROL, { estimateId: 'estC' });
    let inv = invoicesOf(db).find((i) => i.source === 'supplement_invoice');
    ok('M4: a legacy deposit invoice with no companyId, made by the estimate\'s author, is credited ($11,000, not $16,000)',
      inv && c(inv.total) === 1100000 && JSON.stringify(inv.creditedInvoiceIds) === '["legacy"]', res.e ? res.e.message : JSON.stringify(inv && inv.total));
    db = fakeDb(seedJob({ 'supplements/s1': sup({ invoicedInvoiceId: 'X', invoicedAt: 3 }), 'supplements/s2': sup({ version: 2, invoicedInvoiceId: 'X', invoicedAt: 3 }),
      'invoices/X': { leadId: 'L1', companyId: 'co-a', createdBy: 'carol', estimateId: 'estC', status: 'draft', total: 18000, amountPaid: 0, createdAt: 2, supplementIds: ['s1', 's2'] } }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    ok('L4: a retry after a lost response (every approved supplement on invoice X) → X, reused, nothing written',
      !!res.r && res.r.reused === true && res.r.invoiceId === 'X' && invoicesOf(db).length === 1, res.e ? res.e.message : JSON.stringify(res.r));
    const IFE = require(path.join(ROOT, 'functions/invoice-from-estimate.js'));
    const orig = IFE.invoiceTotalsFromEstimate;
    IFE.invoiceTotalsFromEstimate = () => { throw new Error('internal detail /secret/path'); };
    try {
      db = fakeDb(seedJob());
      res = await call(db, CAROL, { estimateId: 'estC' });
    } finally { IFE.invoiceTotalsFromEstimate = orig; }
    ok('L1: an unexpected internal error returns generic text, not its details', !!res.e && !/secret/.test(res.e.message) && invoicesOf(db).length === 0, res.e && res.e.message);
    db = fakeDb(seedJob({ 'estimates/estC': est({ deleted: true }) }));
    const rTenant = await call(db, who('eve', { role: 'company_admin', companyId: 'co-b' }), { estimateId: 'estC' });
    const rMissing = await call(fakeDb(seedJob()), CAROL, { estimateId: 'nope' });
    ok('L2: another tenant learns nothing from a deleted estimate (the same refusal as a missing one)',
      !!rTenant.e && !!rMissing.e && rTenant.e.message === rMissing.e.message, rTenant.e && rTenant.e.message);
    db = fakeDb(seedJob({ 'supplements/s1': sup({ version: 'abc', reason: '<img src=x onerror=alert(1)>\u0007 roof' }) }));
    res = await call(db, CAROL, { estimateId: 'estC' });
    inv = invoicesOf(db)[0];
    const line = inv && inv.items.find((it) => /Supplement/.test(it.description));
    ok('L3: a non-number version reads #1, and the reason has no markup or control characters in the line',
      !!line && /#1 /.test(line.description) && !/[<>\u0000-\u001f]/.test(line.description), res.e ? res.e.message : JSON.stringify(line));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
