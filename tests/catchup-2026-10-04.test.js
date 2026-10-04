/**
 * tests/catchup-2026-10-04.test.js — "Catch up my numbers" (#/catchup).
 *
 * Prod (owner tenant, 2026-10-04): 38 won jobs ($92.5k booked), payments on
 * 6 ($3,650); job costs on 1; sold package on none; 10 close dates equal to
 * the created date; 25 losses, 3 with reasons; 36 of 104 Thumbtack leads
 * costed. The catch-up screen walks Jo through it one card at a time. This
 * suite runs the REAL code:
 *
 *   1  the won-jobs deck: which jobs appear, what each is missing, Done /
 *      Skip, the progress line ("12 of 38 jobs done")
 *   2  the lost-reasons deck and the Thumbtack months
 *   3  "Paid in full? Yes": ONE payment for the job total already on file,
 *      on the date Jo entered — through invoice-pipeline.js's real
 *      recordPaymentCommit / markPaid in a browser sandbox — and NO email
 *      (positive control: the same harness catches the receipt when asked)
 *   4  every write is logged; Undo reverses the last one (payment, lead
 *      field, spend, Done); loading the screen writes nothing
 *   5  Record payment from this screen hides + forces off the receipt box
 *   6  wiring: route, lazy bundle, Home + Sunday review links, cache-busters
 *
 * Run: node tests/catchup-2026-10-04.test.js   (zero deps)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function sec(name, fn) {
  try { await fn(); } catch (e) { ok(String(name).trim() + ' — threw: ' + (e && e.stack || e), false); }
}
function req(rel) {
  try { return require(path.join(ROOT, rel)); }
  catch (e) { ok('loads ' + rel, false, e && e.message); return null; }
}

const DAY = 86400000;
const NOW = new Date(2026, 9, 4, 15, 0, 0).getTime();
const ago = (d) => NOW - d * DAY;

const NL = req('docs/pro/js/numbers-logic.js');
const CL = req('docs/pro/js/catchup-logic.js');

// ── A browser sandbox: Firestore v9 modular fakes + capturing send primitives ──
function browser(seed, extra) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const emails = [], sms = [], writes = [], fetches = [];
  let seq = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const W = {
    _db: { fake: true }, db: { fake: true },
    doc: (db, ...segs) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
    collection: (db, c) => ({ col: c }),
    where: (f, op, v) => ({ f, op, v }),
    query: (c, ...ws) => ({ col: c.col, ws }),
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
    addDoc: async (c, data) => { const id = 'new' + (++seq); writes.push(['add', c.col + '/' + id]); store.set(c.col + '/' + id, clone(data)); return { id }; },
    setDoc: async (r, data, opts) => { writes.push(['set', r.path]); store.set(r.path, (opts && opts.merge) ? Object.assign({}, store.get(r.path) || {}, clone(data)) : clone(data)); },
    deleteDoc: async (r) => { writes.push(['delete', r.path]); store.delete(r.path); },
    serverTimestamp: () => '__TS__',
    NBDComms: {
      sendEmail: async (o) => { emails.push(o); return { success: true }; },
      sendSMS: async (o) => { sms.push(o); return { success: true }; },
    },
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    NBDJurisdiction: req('docs/pro/js/ky-insurance-law.js'),
    _auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok' } },
    _user: { uid: 'u1' },
    _userClaims: {},
    _leads: [],
    _estimates: [],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
    NBDNumbersData: {
      isOwner: () => true,
      companyId: () => 'u1',
      loadExpenses: async () => [],
      loadSpend: async () => ({ months: clone((store.get('companies/u1/owner_numbers/lead_spend') || {}).months || {}) }),
      saveSpendMonth: async (m, k, c) => { const cur = store.get('companies/u1/owner_numbers/lead_spend') || { months: {} }; cur.months[m] = Object.assign({}, cur.months[m], { [k]: c }); store.set('companies/u1/owner_numbers/lead_spend', cur); writes.push(['set', 'spend']); return true; },
      mergeSpendMonths: async (by, k) => { const cur = store.get('companies/u1/owner_numbers/lead_spend') || { months: {} }; Object.keys(by).forEach((m) => { cur.months[m] = Object.assign({}, cur.months[m], { [k]: by[m] }); }); store.set('companies/u1/owner_numbers/lead_spend', cur); writes.push(['set', 'spend']); return true; },
    },
  };
  Object.assign(W, extra || {});
  global.window = W;
  global.showToast = () => {};
  global.fetch = async (url, o) => { fetches.push([url, o]); return { ok: true, json: async () => ({}) }; };
  W.NBDNumbers = NL;
  W.NBDCatchUpLogic = CL;
  W.InvoicePipeline = IP;
  return { W, store, emails, sms, writes, fetches };
}
// Load the browser modules once, under a first sandbox.
let IP = null, CU = null;
browser({});
IP = req('docs/pro/js/invoice-pipeline.js');
CU = req('docs/pro/js/catchup.js');

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\n1. The won-jobs deck');
  await sec('1', async () => {
    const won = (id, f) => Object.assign({ id, stage: 'closed', stageRole: 'won', jobValue: 10000, createdAt: ago(60), closedAt: ago(30), soldTier: 'better' }, f || {});
    const leads = [
      won('w1'),                                                        // has everything below except payment/cost
      won('w2', { stage: 'contract_signed', stageRole: 'active' }),     // signed = a sale
      won('w3', { stage: 'install_in_progress', stageRole: 'job' }),    // in production = a sale
      won('w4', { soldTier: null, closedAt: ago(60) }),                 // close == created, no package
      { id: 'o1', stage: 'contacted', stageRole: 'active' },            // open: not a job
      { id: 'l1', stage: 'lost', stageRole: 'lost' },                   // lost: not a job
      won('d1', { deleted: true }),                                     // deleted: not counted
      won('p1', { isProspect: true }),                                  // prospect: not counted
    ];
    const collectedByLead = { w1: 5000 };
    const expenses = [{ id: 'e1', leadId: 'w1', amount: 1200, category: 'materials' }, { id: 'e2', leadId: 'w2', amount: 50, category: 'marketing' }];
    const d = CL.jobDeck(leads, { collectedByLead, expenses });
    ok('which jobs appear: won, contract signed and in-production — not open, lost, deleted or prospect',
      d.items.map((i) => i.id).sort().join(',') === 'w1,w2,w3,w4', d.items.map((i) => i.id).join(','));
    const by = {}; d.items.forEach((i) => { by[i.id] = i; });
    ok('w1: paid + costed + package + real close date → nothing missing, counts as done',
      by.w1.missingCount === 0 && by.w1.done === true && d.queue.indexOf('w1') === -1);
    ok('w2: payment + costs missing (a marketing expense is not a job cost)', by.w2.missing.payment && by.w2.missing.costs && !by.w2.missing.package && !by.w2.missing.closeDate);
    ok('w4: close date = created date and no package are flagged', by.w4.missing.closeDate && by.w4.missing.package && by.w4.missingCount === 4);
    ok('a closedAt missing entirely is flagged too', CL.missingFor(won('x', { closedAt: null }), {}).closeDate === true);
    ok('the job with the most gaps comes first', d.queue[0] === 'w4', d.queue.join(','));
    ok('progress: 1 of 4 jobs done', d.done === 1 && d.total === 4 && d.text === '1 of 4 jobs done', d.text);

    const marked = CL.jobDeck(leads, { collectedByLead, expenses, progress: { doneJobs: { w4: true } } });
    ok('Done (marked) takes a job off the deck even with gaps left', marked.queue.indexOf('w4') === -1 && marked.done === 2);
    const skipped = CL.jobDeck(leads, { collectedByLead, expenses, skipped: ['w4'] });
    ok('Skip moves a job to the back, it does not finish it', skipped.queue[skipped.queue.length - 1] === 'w4' && skipped.done === 1);
    const tie = CL.jobDeck([won('a', { jobValue: 100 }), won('b', { jobValue: 900 })], {});
    ok('same gaps → the bigger booked job first', tie.queue.join(',') === 'b,a');

    // The prod shape: 38 wins, 12 caught up.
    const many = [];
    for (let i = 0; i < 38; i++) many.push(won('j' + i));
    const paid = {}; const prog = { doneJobs: {} };
    for (let i = 0; i < 6; i++) { paid['j' + i] = 500; many[i].materialCost = 1000; }   // 6 complete
    for (let i = 6; i < 12; i++) prog.doneJobs['j' + i] = true;                          // 6 marked done
    const p = CL.jobDeck(many, { collectedByLead: paid, expenses: [], progress: prog });
    ok('"12 of 38 jobs done"', p.text === '12 of 38 jobs done' && p.queue.length === 26, p.text);
    ok('a job costed on the lead itself (Job Costs panel) is costed', CL.missingFor(won('z', { laborCost: 400 }), { costed: CL.costedIds([won('z', { laborCost: 400 })], []) }).costs === false);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n2. Lost reasons + Thumbtack months');
  await sec('2', async () => {
    const leads = [
      { id: 'a', stage: 'lost', stageRole: 'lost', closedAt: ago(3) },
      { id: 'b', stage: 'lost', stageRole: 'lost', closedAt: ago(1) },
      { id: 'c', stage: 'lost', stageRole: 'lost', lostReasonKey: 'price' },
      { id: 'd', stage: 'lost', stageRole: 'lost', lostReason: 'went with another roofer' }, // old free text counts
      { id: 'e', stage: 'contacted' },
    ];
    const d = CL.lostDeck(leads, {});
    ok('losses with no reason only; newest loss first', d.queue.join(',') === 'b,a', d.queue.join(','));
    ok('"2 of 4 losses have a reason"', d.text === '2 of 4 losses have a reason', d.text);
    ok('Skip sends a loss to the back', CL.lostDeck(leads, { skipped: ['b'] }).queue.join(',') === 'a,b');

    const tt = [
      { id: 't1', source: 'Thumbtack', createdAt: new Date(2026, 5, 10).getTime(), leadCost: 25 },
      { id: 't2', source: 'thumbtack', createdAt: new Date(2026, 5, 20).getTime() },
      { id: 't3', source: 'Thumbtack', createdAt: new Date(2026, 7, 2).getTime(), leadCost: '30' },
      { id: 'x', source: 'Google', createdAt: new Date(2026, 1, 1).getTime() },
    ];
    const m = CL.thumbtackMonths(tt, { months: { '2026-07': { thumbtack: 0 }, '2026-09': { thumbtack: 45000 } } }, NOW);
    ok('every month from the first Thumbtack lead to now, newest first', m.rows.map((r) => r.month).join(',') === '2026-10,2026-09,2026-08,2026-07,2026-06', m.rows.map((r) => r.month).join(','));
    const r = {}; m.rows.forEach((x) => { r[x.month] = x; });
    ok('June: 2 leads, 1 priced, no spend → not covered', r['2026-06'].leads === 2 && r['2026-06'].priced === 1 && r['2026-06'].spendCents === null && !r['2026-06'].covered);
    ok('July: $0 entered counts as entered (no leads that month)', r['2026-07'].spendCents === 0 && r['2026-07'].covered);
    ok('August: every lead priced → covered without a bill', r['2026-08'].covered && r['2026-08'].spendCents === null);
    ok('September: $450.00 entered, in cents', r['2026-09'].spendCents === 45000 && r['2026-09'].covered);
    ok('3 of 5 months covered; spend key "thumbtack"', m.covered === 3 && m.total === 5 && m.key === 'thumbtack');
    ok('no Thumbtack leads → no rows', CL.thumbtackMonths([], {}, NOW).total === 0);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n3. Paid in full = ONE payment for the job total, on the entered date, no email');
  await sec('3a plan', async () => {
    ok('existing invoice, nothing paid → its total', JSON.stringify(CL.paidInFullPlan({ kind: 'existing', invoices: [{ id: 'i', total: 8200, amountPaid: 0 }] })) === JSON.stringify({ ok: true, cents: 820000, basis: 'invoice', invoiceId: 'i' }));
    ok('an invoice with money on it → no shortcut', CL.paidInFullPlan({ kind: 'existing', invoices: [{ id: 'i', total: 8200, amountPaid: 100 }] }).ok === false);
    ok('two open invoices → no shortcut', CL.paidInFullPlan({ kind: 'existing', invoices: [{ id: 'a', total: 1 }, { id: 'b', total: 2 }] }).ok === false);
    ok('estimate → its total', CL.paidInFullPlan({ kind: 'estimate', estimateId: 'E', totalCents: 1500000 }).cents === 1500000);
    ok('job value on file → that value', CL.paidInFullPlan({ kind: 'jobValue', suggestedCents: 920050 }).cents === 920050);
    ok('NO figure on file → no shortcut (never an invented amount)', CL.paidInFullPlan({ kind: 'jobValue', suggestedCents: 0 }).ok === false && CL.paidInFullPlan(null).ok === false);
    const lead = { createdAt: ago(90), closedAt: ago(60), stage: 'final_payment', stageHistory: [{ to: 'contract_signed', timestamp: ago(60) }, { to: 'install_complete', timestamp: ago(20) }, { to: 'final_payment', timestamp: ago(12) }] };
    ok('default payment date: the move into Final Payment, not today', CL.defaultPaymentYmd(lead, NOW) === CL.ymdOf(ago(12)));
    ok('…else the real sale date', CL.defaultPaymentYmd({ createdAt: ago(90), closedAt: ago(40), stage: 'closed' }, NOW) === CL.ymdOf(ago(40)));
    ok('…and nothing (Jo picks) when the close date is really the created date', CL.defaultPaymentYmd({ createdAt: ago(40), closedAt: ago(40), stage: 'closed' }, NOW) === '');
    ok('a future date is refused; a bad date is refused; today is fine',
      CL.dateFromYmd(CL.ymdOf(NOW + DAY), NOW) === null && CL.dateFromYmd('2026-02-30', NOW) === null && CL.dateFromYmd(CL.ymdOf(NOW), NOW) instanceof Date);
    ok('close-date suggestion: the first sale-stage move that is not the created moment',
      CL.suggestCloseYmd({ createdAt: ago(50), stageHistory: [{ to: 'closed', timestamp: ago(50) }, { to: 'contract_signed', timestamp: ago(31) }] }) === CL.ymdOf(ago(31)));
  });

  const custEmail = 'delivered@resend.dev';
  await sec('3b jobValue (no invoice, no estimate)', async () => {
    if (!IP || !CU) return ok('modules loaded', false);
    const lead = { userId: 'u1', companyId: 'u1', firstName: 'Pat', lastName: 'Jones', address: '12 Main St, Milford, OH 45150', email: custEmail, stage: 'closed', jobValue: 9200.5, createdAt: ago(80), closedAt: ago(50) };
    const B = browser({ 'leads/L1': lead });
    B.W._leads = [Object.assign({ id: 'L1' }, lead)];
    CU._setData({ invs: [], expenses: [], spend: { months: {} } }, { doneJobs: {}, log: [] });
    const r = await CU.paidInFull('L1', { method: 'check', payer: 'homeowner', ymd: '2026-09-12', expectCents: 920050 });
    const invs = [...B.store.entries()].filter(([k]) => k.startsWith('invoices/'));
    ok('exactly one invoice made (from the job value on file)', invs.length === 1, invs.length);
    const inv = invs[0] && invs[0][1];
    ok('exactly ONE payment recorded', inv && Array.isArray(inv.payments) && inv.payments.length === 1, inv && JSON.stringify(inv.payments));
    const p = inv.payments[0];
    ok('amount = the job total ($9,200.50), paid in full', p.amount === 9200.5 && inv.amountPaid === 9200.5 && inv.balanceDue === 0 && inv.status === 'paid' && r.cents === 920050);
    ok('the payment is dated the day Jo entered (2026-09-12), not today', p.at === new Date(2026, 8, 12, 12, 0, 0).toISOString() && inv.paidAt === p.at, p.at);
    ok('method + payer as picked', p.method === 'check' && p.payer === 'homeowner');
    ok('NO email and NO text — the lead and invoice both carry an email', B.emails.length === 0 && B.sms.length === 0 && inv.customerEmail === custEmail, JSON.stringify(B.emails));
    ok('no network call either (no receipt endpoint)', B.fetches.length === 0, JSON.stringify(B.fetches.map((f) => f[0])));
    const prog = B.store.get('companies/u1/owner_numbers/catchup');
    const e = prog && prog.log && prog.log[prog.log.length - 1];
    ok('the write is logged on owner_numbers/catchup with what Undo needs', !!e && e.kind === 'payment' && e.created === true && e.invoiceId === invs[0][0].split('/')[1] && /^pay-/.test(e.noteId || ''));
    ok('the payment timeline note was written', B.store.has('notes/' + e.noteId));

    // Positive control: the SAME harness catches a receipt when one is sent.
    // Since #2143 Record payment never emails (even sendReceipt:true); the
    // only send is the rep's "Send receipt" tap (IP.sendReceipt).
    const C = browser({ 'leads/L1': lead, 'invoices/r1': { leadId: 'L1', createdBy: 'u1', status: 'sent', total: 100, amountPaid: 0, balanceDue: 100, customerEmail: custEmail } });
    await IP.recordPaymentCommit({ leadId: 'L1', lead, target: { kind: 'existing', invoices: [{ id: 'r1' }] }, invoiceId: 'r1', amount: '100', method: 'check', payer: 'homeowner', at: new Date(NOW), sendReceipt: true });
    ok('Record payment with sendReceipt:true still sends nothing (#2143: receipts are drafts)', C.emails.length === 0);
    const cPays = (C.store.get('invoices/r1') || {}).payments || [];
    await IP.sendReceipt('r1', IP.receiptKeyOf(cPays[0], 0));
    ok('positive control: the "Send receipt" tap through the same sandbox → one email captured', C.emails.length === 1);

    // Undo the shortcut → the invoice it made is gone, the timeline note too.
    const B2 = browser(Object.fromEntries(B.store));
    B2.W._leads = B.W._leads;
    const undone = await CU.undoLast();
    ok('Undo: the invoice the shortcut made is deleted and its timeline note removed',
      undone === true && ![...B2.store.keys()].some((k) => k.startsWith('invoices/')) && !B2.store.has('notes/' + e.noteId));
    ok('…and the log entry is gone', (B2.store.get('companies/u1/owner_numbers/catchup').log || []).length === 0);
  });

  await sec('3c existing invoice', async () => {
    if (!IP || !CU) return ok('modules loaded', false);
    const lead = { userId: 'u1', companyId: 'u1', firstName: 'Sam', address: '3 Oak St, Milford, OH 45150', email: custEmail, stage: 'final_payment', jobValue: 9500, createdAt: ago(80), closedAt: ago(50) };
    const inv0 = { leadId: 'L2', createdBy: 'u1', companyId: 'u1', status: 'sent', total: 9000, amountPaid: 0, balanceDue: 9000, customerEmail: custEmail, jobId: null };
    const B = browser({ 'leads/L2': lead, 'invoices/inv1': inv0 });
    B.W._leads = [Object.assign({ id: 'L2' }, lead)];
    CU._setData({ invs: [], expenses: [], spend: { months: {} } }, { doneJobs: {}, log: [] });
    let threw = '';
    try { await CU.paidInFull('L2', { method: 'zelle', payer: 'homeowner', ymd: '2026-09-20', expectCents: 950000 }); } catch (x) { threw = x.message; }
    ok('a stale total (the sheet showed $9,500, the invoice says $9,000) is refused, nothing written',
      /changed/.test(threw) && B.store.get('invoices/inv1').amountPaid === 0 && B.writes.length === 0, threw);
    try { await CU.paidInFull('L2', { method: 'zelle', ymd: CL.ymdOf(NOW + 2 * DAY) }); threw = ''; } catch (x) { threw = x.message; }
    ok('a future date is refused before any read or write', /date/i.test(threw) && B.writes.length === 0);
    await CU.paidInFull('L2', { method: 'zelle', payer: 'insurance', ymd: '2026-09-20', expectCents: 900000 });
    const inv = B.store.get('invoices/inv1');
    ok('the open invoice is paid: ONE payment of its total ($9,000 — the invoice, not the $9,500 job value)',
      inv.payments.length === 1 && inv.payments[0].amount === 9000 && inv.status === 'paid' && inv.balanceDue === 0);
    ok('no second invoice, no email', [...B.store.keys()].filter((k) => k.startsWith('invoices/')).length === 1 && B.emails.length === 0);
    const B2 = browser(Object.fromEntries(B.store));
    await CU.undoLast();
    const back = B2.store.get('invoices/inv1');
    ok('Undo restores the invoice ledger: nothing paid, status sent, no payments',
      back.amountPaid === 0 && back.balanceDue === 9000 && back.status === 'sent' && Array.isArray(back.payments) && back.payments.length === 0 && back.paidAt === null);

    // No total on file → no shortcut, nothing written.
    const B3 = browser({ 'leads/L3': { userId: 'u1', stage: 'closed', jobValue: 0 } });
    CU._setData({ invs: [], expenses: [], spend: { months: {} } }, { doneJobs: {}, log: [] });
    try { await CU.paidInFull('L3', { method: 'cash', ymd: '2026-09-01' }); threw = ''; } catch (x) { threw = x.message; }
    ok('no job total on file → refused, no invoice invented', /Record payment/.test(threw) && B3.writes.length === 0);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n4. Every write is logged; Undo reverses the last; loading writes nothing');
  await sec('4', async () => {
    if (!CU) return ok('modules loaded', false);
    const lead = { userId: 'u1', stage: 'closed', stageRole: 'won', jobValue: 5000, createdAt: ago(40), closedAt: ago(40), soldTier: null };
    const B = browser({ 'leads/L4': lead }, {
      NBDRevenue: { loadInvoices: async () => [], collectedByLead: () => ({}) },
    });
    B.W._leads = [Object.assign({ id: 'L4' }, lead)];
    await CU.refresh();
    ok('opening the screen (load + render) writes nothing', B.writes.length === 0, JSON.stringify(B.writes));
    ok('…and lists the job with all four gaps', CL.jobDeck(B.W._leads, { collectedByLead: {} }).items[0].missingCount === 4);

    await CU.markDone('L4');
    ok('Done is saved to owner_numbers/catchup (a reload keeps it)', B.store.get('companies/u1/owner_numbers/catchup').doneJobs.L4 === true);
    // A fresh load reads it back.
    CU._setData(null, { doneJobs: {}, log: [] });
    await CU.refresh();
    const st = CU._state();
    ok('after a reload the job counts as done', st.progress.doneJobs.L4 === true && CL.jobDeck(B.W._leads, { progress: st.progress }).done === 1);
    await CU.undoLast();
    ok('Undo un-marks Done', !B.store.get('companies/u1/owner_numbers/catchup').doneJobs.L4);

    await CU.saveSpend('2026-08', 'thumbtack', 31250);
    ok('spend saved in cents', B.store.get('companies/u1/owner_numbers/lead_spend').months['2026-08'].thumbtack === 31250);
    await CU.undoLast();
    ok('Undo puts the month back to what it was (none → 0)', B.store.get('companies/u1/owner_numbers/lead_spend').months['2026-08'].thumbtack === 0);
    ok('nothing left to undo', CU._state().progress.log.length === 0 && (await CU.undoLast()) === false);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n5. Record payment from this screen never emails');
  await sec('5', async () => {
    const ipSrc = lf(read('docs/pro/js/invoice-pipeline.js'));
    const sheet = ipSrc.split('async function recordPaymentUI')[1].split('// ═══')[0];
    // Since #2143 the Record payment sheet has no "Email a receipt" box at all
    // and never passes sendReceipt — a receipt is a draft until Send receipt.
    ok('recordPaymentUI(leadId, opts) takes the catch-up screen\'s opts', /async function recordPaymentUI\(leadId, opts\)/.test(ipSrc));
    ok('…and the sheet has no receipt box and no sendReceipt, only the drafted-receipt note',
      !/nbd-rp-receipt/.test(sheet) && !/sendReceipt/.test(sheet) && /data-rp-receipt-note/.test(sheet));
    const cu = lf(read('docs/pro/js/catchup.js'));
    ok('the catch-up screen always opens it with noReceipt, and the shortcut passes sendReceipt:false',
      /recordPaymentUI\(leadId, \{ noReceipt: true \}\)/.test(cu) && /sendReceipt: false,/.test(cu) && !/sendReceipt: true/.test(cu));
    ok('catchup.js never calls a send primitive', !/sendEmail|sendSMS|NBDComms/.test(cu.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\n6. Wiring');
  await sec('6', async () => {
    const sl = lf(read('docs/pro/js/script-loader.js'));
    ok('lazy bundle: rules, css, view', /catchup: \[\s*'js\/catchup-logic\.js\?v=\d+',\s*'css\/catchup\.css\?v=\d+',\s*'js\/catchup\.js\?v=\d+'\s*\]/.test(sl) && /catchup:\s+\['catchup'\]/.test(sl));
    const dash = lf(read('docs/pro/dashboard.html'));
    ok('dashboard: #view-catchup mount + template', /<div class="view" id="view-catchup" data-view-template="tpl-view-catchup"><\/div>/.test(dash) && /<template id="tpl-view-catchup"><div class="view-scroll"/.test(dash));
    ok('Home links to it', /id="homeCatchUpBtn" data-action="goTo" data-target="catchup"/.test(dash));
    ok('the Sunday review data gaps link to it', /id="wrCatchUpBtn" data-action="goTo" data-target="catchup"/.test(lf(read('docs/pro/js/week-review.js'))));
    ok('route registered + init on goTo', /'catchup':\s+\{ label: 'Catch Up Numbers'/.test(lf(read('docs/pro/js/dashboard-state.js'))) && /if\(name==='catchup'\)\s+\{ _lazyPreload\.then\(\(\) => \{ if \(window\.NBDCatchUp\) window\.NBDCatchUp\.init\(\); \}\); \}/.test(lf(read('docs/pro/js/dashboard-actions.js'))));
    ok('no inline style / handlers in the new files', !/style="|\son[a-z]+="/.test(lf(read('docs/pro/js/catchup.js'))) && !/style="|\son[a-z]+="/.test(lf(read('docs/pro/js/catchup-logic.js'))));
    ok('tap targets: buttons and inputs are 44px+', /\.cu-btn \{[^}]*min-height: 44px/.test(read('docs/pro/css/catchup.css')) && /\.cu-date, \.cu-money, \.cu-file \{[^}]*min-height: 44px/.test(read('docs/pro/css/catchup.css')));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
