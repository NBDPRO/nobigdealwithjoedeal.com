/**
 * sole-job-no-estimate-credit-2026-10-05.test.js — a paid, un-stamped
 * invoice counts for the customer's ONLY job when the customer has no
 * estimate at all.
 *
 * The gap (production, 2026-10-05): jobInvoicesOf (nbd:job-billing, in
 * docs/pro/js/invoice-pipeline.js and the byte-identical
 * functions/invoice-from-estimate.js) credits a paid invoice with no jobId
 * only when the lead has exactly one job AND the invoice is dated on/after
 * that job's estimate. A repair recorded straight from a Stripe payment has
 * one job and NO estimate, so the Stripe mirror was never credited and
 * Record Payment billed the whole job again.
 *
 * The Zanders shape: one job, no estimate, a $450 Stripe-dashboard mirror
 * (paid, no jobId) + a $250 Zelle invoice → on a $700 job nothing is owed.
 *
 * The fix: opts.noEstimate (the caller saw no estimate on the lead) with
 * soleJob → every paid un-stamped invoice on the lead is this job's. Two or
 * more jobs → unchanged (never the wrong job). recordPaymentCommit passes
 * it; the install-day final draft still never bills without an estimate.
 *
 * Synthetic data only; every Firestore is an in-memory fake.
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

const IFE = req('functions/invoice-from-estimate.js');
const D = req('functions/deposit-draft-logic.js');
const IP = req('docs/pro/js/invoice-pipeline.js');

const NOW = Date.parse('2026-10-05T15:00:00Z');
const JOB_C = 70000;
// The Zanders shape. No primaryEstimateId, no estimate anywhere.
const lead = (o) => Object.assign({ id: 'LZ', userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Zanders',
  address: '12 Main St, Milford, OH 45150', jobType: 'cash', stage: 'install_complete', activeJobId: 'j1', jobValue: 700 }, o || {});
// The Stripe-dashboard mirror (stripe-ledger-logic.js mirrorInvoice): paid, no jobId.
const stripeMirror = (o) => Object.assign({ id: 'MZ', leadId: 'LZ', companyId: 'u1', createdBy: 'u1', source: 'stripe', status: 'paid',
  total: 450, amountPaid: 450, balanceDue: 0, createdAt: '2026-09-28T16:00:00.000Z', stripeInvoiceId: 'in_rep' }, o || {});
// The Zelle payment's invoice, paid. Recorded by hand: no jobId either.
const zelle = (o) => Object.assign({ id: 'ZZ', leadId: 'LZ', companyId: 'u1', createdBy: 'u1', status: 'paid',
  total: 250, amountPaid: 250, balanceDue: 0, createdAt: '2026-09-30T16:00:00.000Z' }, o || {});
const SOLE_NO_EST = { soleJob: true, noEstimate: true };

// Browser fake with sub-collections (leads/LZ/jobs) for invoice-pipeline.js.
function browser(seed) {
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
      const docs = [];
      const depth = q.col.split('/').length + 1;
      for (const [k, v] of store) {
        if (!k.startsWith(q.col + '/') || k.split('/').length !== depth) continue;
        if ((q.ws || []).every((w) => v[w.f] === w.v)) docs.push({ id: k.split('/').pop(), data: () => JSON.parse(JSON.stringify(v)) });
      }
      return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
    },
    updateDoc: async (r, patch) => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); store.set(r.path, Object.assign({}, store.get(r.path), JSON.parse(JSON.stringify(patch)))); },
    addDoc: async (c, data) => { const id = 'new' + (++seq); added.push(Object.assign({ id }, data)); store.set(c.col + '/' + id, JSON.parse(JSON.stringify(data))); return { id }; },
    setDoc: async (r, data) => { store.set(r.path, JSON.parse(JSON.stringify(data))); },
    NBDComms: { sendSMS: async () => ({ success: true }), sendEmail: async () => ({ success: true }) },
    NBDJurisdiction: req('docs/pro/js/ky-insurance-law.js'),
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    _auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok' } },
    _user: { uid: 'u1' },
    _userClaims: {},
    _leads: [],
    _estimates: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
  };
  global.window = W;
  global.showToast = () => {};
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  return { W, store, added };
}
const jobsSeed = (ids) => Object.fromEntries(ids.map((id) => ['leads/LZ/jobs/' + id, { title: 'Repair', companyId: 'u1', userId: 'u1' }]));

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\n1. jobInvoicesOf / planJobInvoice — one job, no estimate (pure, server copy)');
  ok('nbd:job-billing is byte-identical in invoice-pipeline.js and functions/invoice-from-estimate.js',
    !!block(read('docs/pro/js/invoice-pipeline.js'), 'job-billing')
    && block(read('docs/pro/js/invoice-pipeline.js'), 'job-billing') === block(read('functions/invoice-from-estimate.js'), 'job-billing'));
  if (IFE) {
    const mine = IFE.jobInvoicesOf([stripeMirror(), zelle()], 'j1', SOLE_NO_EST);
    ok('ZANDERS: one job, no estimate → the $450 Stripe mirror AND the $250 Zelle invoice are this job\'s',
      mine.length === 2 && mine[0].id === 'MZ' && mine[1].id === 'ZZ', JSON.stringify(mine.map((i) => i.id)));
    const p = IFE.planJobInvoice(JOB_C, [stripeMirror(), zelle()], 'j1', SOLE_NO_EST);
    ok('…a $700 job is billed in full: nothing new to make (owes $0)', p.action === 'open' && p.reason === 'billed_in_full', JSON.stringify(p));
    const p9 = IFE.planJobInvoice(90000, [stripeMirror(), zelle()], 'j1', SOLE_NO_EST);
    ok('…a $900 job → a final crediting $450 + $250 ($200 left)',
      p9.action === 'create' && p9.creditCents === 70000 && p9.credits.length === 2 && p9.credits.every((c) => c.paid === true), JSON.stringify(p9));
    ok('a Zelle invoice STAMPED j1 + the un-stamped mirror → still $700 credited, never double-counted',
      IFE.planJobInvoice(90000, [stripeMirror(), zelle({ jobId: 'j1' })], 'j1', SOLE_NO_EST).creditCents === 70000);
    ok('TWO jobs, no estimate → the un-stamped paid invoices stay out (never the wrong job)',
      IFE.planJobInvoice(JOB_C, [stripeMirror(), zelle()], 'j1', { soleJob: IFE.soleJobOf([{ id: 'j1' }, { id: 'j2' }], 'j1'), noEstimate: true }).action === 'create'
      && IFE.planJobInvoice(JOB_C, [stripeMirror(), zelle()], 'j1', { soleJob: false, noEstimate: true }).creditCents === 0);
    ok('noEstimate alone (jobs not read) → unchanged', IFE.planJobInvoice(JOB_C, [stripeMirror()], 'j1', { noEstimate: true }).creditCents === 0);
    ok('noEstimate must be exactly true (a truthy string does not adopt)', IFE.planJobInvoice(JOB_C, [stripeMirror()], 'j1', { soleJob: true, noEstimate: 'yes' }).creditCents === 0);
    ok('no job id → nothing adopted', IFE.jobInvoicesOf([stripeMirror()], null, SOLE_NO_EST).length === 0);
    ok('soleJob + an estimate date (no noEstimate) → still only on/after the estimate (unchanged)',
      IFE.planJobInvoice(JOB_C, [stripeMirror()], 'j1', { soleJob: true, since: '2026-10-01T00:00:00Z' }).creditCents === 0);
    ok('soleJob, no estimate date, no noEstimate → unchanged (not credited)', IFE.planJobInvoice(JOB_C, [stripeMirror()], 'j1', { soleJob: true }).creditCents === 0);
    ok('a paid invoice stamped for ANOTHER job stays out', IFE.planJobInvoice(JOB_C, [stripeMirror({ jobId: 'j2' })], 'j1', SOLE_NO_EST).creditCents === 0);
    ok('void / deleted un-stamped invoices stay out',
      IFE.planJobInvoice(JOB_C, [stripeMirror({ status: 'void' }), zelle({ deleted: true })], 'j1', SOLE_NO_EST).creditCents === 0);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n2. Record Payment (docs/pro/js/invoice-pipeline.js recordPaymentCommit)');
  if (IP) {
    // $700 job, $450 + $250 already paid: confirming the $700 total must NOT bill again.
    {
      const B = browser(Object.assign({ 'leads/LZ': lead(), 'invoices/MZ': stripeMirror(), 'invoices/ZZ': zelle() }, jobsSeed(['j1'])));
      const target = IP.recordPaymentTarget({ lead: lead(), invoices: [stripeMirror(), zelle()] });
      ok('target: no live invoice, no estimate → the rep confirms a total', target.kind === 'jobValue' && target.jobId === 'j1');
      let err = null;
      try { await IP.recordPaymentCommit({ leadId: 'LZ', lead: lead(), target, totalCents: JOB_C, amount: '100', method: 'check', at: new Date(NOW) }); }
      catch (e) { err = e; }
      ok('ZANDERS: Record Payment on the $700 job makes NO new invoice (owes $0)', B.added.length === 0, JSON.stringify(B.added.map((a) => ({ total: a.total, items: a.items }))));
      ok('…and says the job is already paid in full', !!err && /already paid in full/.test(err.message), err && err.message);
    }
    // $900 job: the new invoice credits both and bills only the $200 left.
    {
      const B = browser(Object.assign({ 'leads/LZ': lead(), 'invoices/MZ': stripeMirror(), 'invoices/ZZ': zelle() }, jobsSeed(['j1'])));
      const target = IP.recordPaymentTarget({ lead: lead(), invoices: [stripeMirror(), zelle()] });
      await IP.recordPaymentCommit({ leadId: 'LZ', lead: lead(), target, totalCents: 90000, amount: '200', method: 'check', at: new Date(NOW) });
      const made = B.added[0] || {};
      ok('a $900 job → one new invoice: $200 due, crediting the $450 mirror and the $250 Zelle',
        B.added.length === 1 && made.total === 200 && made.kind === 'final'
        && made.items.filter((i) => i.credit === true).map((i) => i.total).join(',') === '-450,-250'
        && JSON.stringify(made.creditedInvoiceIds) === JSON.stringify(['MZ', 'ZZ']),
        JSON.stringify({ n: B.added.length, total: made.total, items: made.items }));
    }
    // Two jobs: unchanged — the un-stamped invoices are not credited.
    {
      const B = browser(Object.assign({ 'leads/LZ': lead(), 'invoices/MZ': stripeMirror(), 'invoices/ZZ': zelle() }, jobsSeed(['j1', 'j2'])));
      const target = IP.recordPaymentTarget({ lead: lead(), invoices: [stripeMirror(), zelle()] });
      await IP.recordPaymentCommit({ leadId: 'LZ', lead: lead(), target, totalCents: JOB_C, amount: '100', method: 'check', at: new Date(NOW) });
      ok('two jobs → the full $700 invoice, no credit (unchanged)', B.added.length === 1 && B.added[0].total === 700 && !B.added[0].items.some((i) => i.credit));
    }
    // An estimate on the lead (primaryEstimateId) → no noEstimate adoption.
    {
      const L2 = lead({ primaryEstimateId: 'E1' });
      const B = browser(Object.assign({ 'leads/LZ': L2, 'invoices/MZ': stripeMirror(), 'invoices/ZZ': zelle() }, jobsSeed(['j1'])));
      const target = { kind: 'jobValue', suggestedCents: JOB_C, jobId: 'j1' };
      await IP.recordPaymentCommit({ leadId: 'LZ', lead: L2, target, totalCents: JOB_C, amount: '100', method: 'check', at: new Date(NOW) });
      ok('the lead HAS an estimate (primaryEstimateId) → not adopted here: full $700, no credit', B.added.length === 1 && B.added[0].total === 700);
    }
    // An estimate in the page cache for this lead → same.
    {
      const B = browser(Object.assign({ 'leads/LZ': lead(), 'invoices/MZ': stripeMirror(), 'invoices/ZZ': zelle() }, jobsSeed(['j1'])));
      B.W._estimates = [{ id: 'E9', leadId: 'LZ' }];
      const target = { kind: 'jobValue', suggestedCents: JOB_C, jobId: 'j1' };
      await IP.recordPaymentCommit({ leadId: 'LZ', lead: lead(), target, totalCents: JOB_C, amount: '100', method: 'check', at: new Date(NOW) });
      ok('an estimate for the lead in the page cache → not adopted: full $700', B.added.length === 1 && B.added[0].total === 700);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n3. the install-day final draft (functions/deposit-draft-logic.js decideFinalDraft)');
  if (D) {
    const r = D.decideFinalDraft({ leadId: 'LZ', lead: lead(), est: null, estimateId: null, nowMs: NOW, invoices: [stripeMirror(), zelle()], jobs: [{ id: 'j1' }] });
    ok('ZANDERS: no estimate → no final draft is billed (owes $0 from the server)', r.action === 'skip' && r.reason === 'no_estimate', JSON.stringify(r));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
