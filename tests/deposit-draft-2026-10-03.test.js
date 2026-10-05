/**
 * deposit-draft-2026-10-03.test.js — the DRAFT deposit invoice made when a
 * contract is signed (Jo, 2026-10-03: "it never sends until Jo taps it").
 *
 *   A. one rule, one copy each: functions/deposit-rule.js is
 *      docs/pro/js/deposit-rule.js byte-for-byte; functions/invoice-from-estimate.js
 *      carries invoice-pipeline.js's marked blocks byte-for-byte, and both
 *      runtimes produce the same lines / totals for the same estimate;
 *   B. the amount decision (deposit-draft-logic.js decideDepositDraft):
 *      cash < $2k → none, cash ≥ $2k → 50%, insurance OH → deductible + ACV,
 *      insurance KY → none (also a KY claim lead priced in cash mode), no
 *      deductible → none, no estimate → none, retail lines never cost, the
 *      deal room's accepted tier + price;
 *   C. idempotency with a fake transactional Firestore — draftDepositAfterSign
 *      and the job spine's recordJobEvent: one draft per lead + job whatever
 *      the retries / second signing event, one review task (or the existing
 *      Collect Deposit task), nothing sent, no Stripe link;
 *   D. a draft is never "owed": invoice-owed.js, the morning brief, the agent
 *      tools, the homeowner portal, and the customer page's Total Owed (run
 *      for real in a vm) — plus the "Draft deposit — review & send" chip.
 *
 * Run: node tests/deposit-draft-2026-10-03.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function tryReq(p) { try { return require(path.join(ROOT, p)); } catch (e) { console.log('  (cannot load ' + p + ': ' + e.message + ')'); return null; } }

const D = tryReq('functions/deposit-draft-logic.js');
const DD = tryReq('functions/deposit-draft.js');
const SPINE = tryReq('functions/job-spine.js');
const OWED = tryReq('functions/invoice-owed.js');
const MB = tryReq('functions/morning-brief-logic.js');
const AM = tryReq('functions/agent-mcp-logic.js');
const IFE = tryReq('functions/invoice-from-estimate.js');
const IP = tryReq('docs/pro/js/invoice-pipeline.js');

function block(src, name) {
  const s = lf(src);
  const a = s.indexOf('// nbd:' + name + ':start');
  const b = s.indexOf('// nbd:' + name + ':end');
  return (a < 0 || b < 0) ? null : s.slice(a, b);
}

// ── fixtures ─────────────────────────────────────────────────────────────
const OH = '123 Main St, Cincinnati, OH 45202';
const KY = '9 Pike St, Florence, KY 41042';
const leadOf = (o) => Object.assign({ userId: 'u1', companyId: 'u1', stage: 'estimate_sent_cash', firstName: 'Pat', lastName: 'Jones', email: 'pat@x.test', phone: '555', address: OH }, o || {});
const perSq = (o) => Object.assign({ leadId: 'L1', userId: 'u1', priceMode: 'per-sq', prices: { good: 12000, better: 15000, best: 18000 }, selectedTier: 'better', grandTotal: 15000, taxRate: 0, mode: 'cash' }, o || {});
const NOW = Date.parse('2026-10-03T15:00:00Z');
const decide = (o) => D.decideDepositDraft(Object.assign({ leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1', estimateId: 'E1', nowMs: NOW }, o));

(async () => {
  console.log('\nA. one rule, one copy each');
  {
    ok('functions/deposit-rule.js is docs/pro/js/deposit-rule.js byte-for-byte (EOL-normalised)',
      fs.existsSync(path.join(ROOT, 'functions/deposit-rule.js')) && lf(read('functions/deposit-rule.js')) === lf(read('docs/pro/js/deposit-rule.js')));
    const ip = read('docs/pro/js/invoice-pipeline.js');
    const fe = fs.existsSync(path.join(ROOT, 'functions/invoice-from-estimate.js')) ? read('functions/invoice-from-estimate.js') : '';
    for (const name of ['invoice-from-estimate', 'invoice-customer-name']) {
      const a = block(ip, name); const b = block(fe, name);
      ok('block nbd:' + name + ' is byte-identical in invoice-pipeline.js and functions/invoice-from-estimate.js', !!a && a === b);
    }
    ok('createInvoiceFromEstimate builds from the shared block (no second inline copy)',
      /const _base = invoiceTotalsFromEstimate\(est, \{/.test(ip) && (lf(ip).match(/const isPerSq = /g) || []).length === 1);
    if (IP && IFE) {
      const ests = [
        perSq(),
        { rows: [{ desc: 'Shingles', qty: '20 SQ', rate: '$200/SQ', total: '4000', materialTotal: 3000, laborTotal: 1000 }], materialMarkupPct: 0.5, overhead: 550, profit: 550, overheadPct: 0.1, profitPct: 0.1, grandTotal: 6600, subtotal: 6600, tax: 0, taxRate: 0 },
        { title: 'Classic', amount: 14200, lineItems: [{ desc: 'Tear-off', qty: 1, rate: 14200, total: 14200 }] },
      ];
      const same = ests.every((e) => JSON.stringify(IP.invoiceTotalsFromEstimate(e)) === JSON.stringify(IFE.invoiceTotalsFromEstimate(e)));
      ok('browser and server compute the same lines + totals for per-SQ, V2 cost-split and classic estimates', same);
    }
  }

  console.log('\nB. the amount decision');
  if (D) {
    const small = decide({ lead: leadOf(), est: { leadId: 'L1', userId: 'u1', rows: [{ desc: 'Gutter repair', qty: '1', retailTotal: 1500, materialTotal: 400, laborTotal: 300 }], materialMarkupPct: 0.3, grandTotal: 1500, subtotal: 1500, tax: 0, taxRate: 0 } });
    ok('cash under $2,000 → NO draft (cash_under_threshold)', small.action === 'skip' && small.reason === 'cash_under_threshold', JSON.stringify(small).slice(0, 200));

    const big = decide({ lead: leadOf(), est: perSq() });
    ok('cash $15,000 → draft with a 50% deposit ($7,500)', big.action === 'create' && big.invoice.depositAmount === 7500 && big.plan.depositCents === 750000);
    ok('…status draft, nothing sent, no Stripe link, owed = full total until paid',
      big.invoice.status === 'draft' && big.invoice.sentAt === null && big.invoice.stripePaymentLink === null && big.invoice.stripeInvoiceId === null
      && big.invoice.balanceDue === 15000 && big.invoice.amountPaid === 0 && big.invoice.depositPaid === false);
    ok('…the same fields createInvoiceFromEstimate writes (owner createdBy, companyId, jobId, terms, Bill To)',
      big.invoice.createdBy === 'u1' && big.invoice.companyId === 'u1' && big.invoice.leadId === 'L1' && big.invoice.estimateId === 'E1'
      && big.invoice.customerName === 'Pat Jones' && big.invoice.customerEmail === 'pat@x.test' && /^Net 14\. 50% deposit of \$7,500 due at signing/.test(big.invoice.terms)
      && big.invoice.taxRate === 0 && big.invoice.total === 15000 && 'jobId' in big.invoice && big.invoice.kyInsuranceHold === false);
    ok('…one per-SQ summary line at the tier price, named for the customer', big.invoice.items.length === 1 && big.invoice.items[0].description === 'Roofing system — Preferred tier' && big.invoice.items[0].total === 15000);
    ok('…marked as the server draft (autoDraft.kind deposit_on_sign) and recognised by isDepositDraft',
      big.invoice.autoDraft.kind === 'deposit_on_sign' && big.invoice.autoDraft.event === 'contract_signed' && D.isDepositDraft(big.invoice));
    ok('…money in cents underneath: depositCents is an integer and depositAmount = cents / 100',
      Number.isInteger(big.plan.depositCents) && big.invoice.depositAmount * 100 === big.plan.depositCents);

    const retail = decide({ lead: leadOf(), est: { leadId: 'L1', userId: 'u1', rows: [{ desc: 'Shingles', qty: '20 SQ', rate: '$200/SQ', total: '4000', materialTotal: 3000, laborTotal: 1000 }], materialMarkupPct: 0.5, overhead: 550, profit: 550, overheadPct: 0.1, profitPct: 0.1, grandTotal: 6600, subtotal: 6600, tax: 0, taxRate: 0 } });
    ok('retail lines, never cost: an old V2 cost-split row bills $5,500 (not the $4,000 cost), O&P on its own line',
      retail.action === 'create' && retail.invoice.items[0].total === 5500 && retail.invoice.items[0].unitPrice !== 200
      && retail.invoice.items.some((i) => /Overhead & Profit/.test(i.description)) && !JSON.stringify(retail.invoice).includes('"4000"'));

    const insOh = decide({ lead: leadOf({ jobType: 'insurance', claimNumber: 'C-1', stage: 'scope_received' }), est: { leadId: 'L1', userId: 'u1', mode: 'insurance', grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, rows: [{ desc: 'Roof', qty: '1', retailTotal: 12000 }], claim: { deductible: 1000, acv: 8000 } } });
    ok('insurance OH → deductible + ACV check up front ($1,000 + $7,000 = $8,000)', insOh.action === 'create' && insOh.plan.depositCents === 800000 && insOh.invoice.depositAmount === 8000);

    const insKy = decide({ lead: leadOf({ address: KY, jobType: 'insurance', claimNumber: 'C-2', stage: 'scope_received' }), est: { leadId: 'L1', userId: 'u1', mode: 'insurance', grandTotal: 12000, rows: [{ desc: 'Roof', retailTotal: 12000 }], claim: { deductible: 1000, acv: 8000 } } });
    ok('insurance KY → NO draft (ky_insurance_hold, KRS 367.626)', insKy.action === 'skip' && insKy.reason === 'ky_insurance_hold');

    const kyCash = decide({ lead: leadOf({ address: KY, claimNumber: 'C-3' }), est: perSq() });
    ok('KY lead with a claim number priced in CASH mode → still NO draft (the contract\'s classifyLead test)', kyCash.action === 'skip' && kyCash.reason === 'ky_insurance_hold');
    ok('…and the deposit rule ITSELF holds it: the lead reaches fromEstimate (#2112 / #2117), plan.kyHold, $0 at signing',
      !!kyCash.plan && kyCash.plan.kyHold === true && kyCash.plan.depositCents === 0 && kyCash.plan.rule === 'insurance-ky');

    const kyRetail = decide({ lead: leadOf({ address: KY }), est: perSq() });
    ok('positive control: a KY RETAIL job (no claim) gets its 50% draft', kyRetail.action === 'create' && kyRetail.invoice.depositAmount === 7500);

    const noDed = decide({ lead: leadOf({ jobType: 'insurance', claimNumber: 'C-4' }), est: { leadId: 'L1', userId: 'u1', mode: 'insurance', grandTotal: 12000, rows: [{ desc: 'Roof', retailTotal: 12000 }] } });
    ok('insurance with no deductible entered → NO draft (needs_deductible)', noDed.action === 'skip' && noDed.reason === 'needs_deductible');

    ok('no estimate → NO draft', decide({ lead: leadOf(), est: null }).reason === 'no_estimate');
    ok('estimate with no total → NO draft', decide({ lead: leadOf(), est: { leadId: 'L1', userId: 'u1', rows: [] } }).reason === 'no_total');
    ok('another tenant\'s estimate → NO draft', decide({ lead: leadOf(), est: perSq({ userId: 'other', leadId: 'L1' }) }).reason === 'estimate_other_tenant');
    ok('lost / closed / deleted lead → NO draft',
      decide({ lead: leadOf({ stage: 'lost' }), est: perSq() }).reason === 'lost'
      && decide({ lead: leadOf({ stage: 'closed' }), est: perSq() }).reason === 'closed'
      && decide({ lead: leadOf({ deleted: true }), est: perSq() }).reason === 'deleted');
    ok('an invoice the rep already made for the job → NO draft', decide({ lead: leadOf(), est: perSq(), existingInvoices: [{ id: 'inv1', status: 'sent', total: 15000 }] }).reason === 'invoice_exists');
    ok('…but a VOID one or an earlier job\'s PAID one does not block',
      decide({ lead: leadOf(), est: perSq(), existingInvoices: [{ id: 'v', status: 'void' }, { id: 'p', status: 'paid' }] }).action === 'create');
    ok('not a signing event → nothing', decide({ event: 'deposit_paid', lead: leadOf(), est: perSq() }).reason === 'not_a_signing_event');

    const deal = decide({ event: 'deal_accepted', sourceId: 'deal_k1', lead: leadOf(), est: perSq(), deal: { leadId: 'L1', estimateId: 'E1', acceptedTier: 'best', acceptedPrice: 18000 } });
    ok('deal room: bills the ACCEPTED tier at its accepted price (Elite, $18,000 → $9,000)',
      deal.action === 'create' && deal.invoice.total === 18000 && deal.invoice.items[0].description === 'Roofing system — Elite tier' && deal.invoice.depositAmount === 9000);
    ok('deal room picks the deal\'s estimate over the lead\'s primary', D.estimateIdFor({ primaryEstimateId: 'P' }, { estimateId: 'E' }).estimateId === 'E' && D.estimateIdFor({ primaryEstimateId: 'P' }, null).estimateId === 'P');
    ok('one deterministic id per lead + job', D.draftInvoiceId('L1', null) === 'depdraft_L1_job' && D.draftInvoiceId('L1', 'j2') === 'depdraft_L1_j2');
  }

  // ── fake transactional Firestore (job-spine test's, plus where/limit) ──
  function makeDb(seed) {
    const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
    const writes = [];
    const clone = (d) => JSON.parse(JSON.stringify(d));
    const apply = (cur, patch) => {
      const d = Object.assign({}, cur);
      for (const k of Object.keys(patch)) { const v = patch[k]; d[k] = (v && v.__union) ? (Array.isArray(d[k]) ? d[k] : []).concat(v.__union) : v; }
      return d;
    };
    const ref = (p) => ({
      path: p, id: p.split('/').pop(),
      collection: (c) => col(p + '/' + c),
      async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)) }; },
      async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
      async set(data) { writes.push(['set', p, data]); store.set(p, clone(data)); },
    });
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
      store, writes, collection: col, doc: (p) => ref(p),
      async runTransaction(fn) {
        const pending = [];
        const tx = {
          get: (r) => r.get(),
          create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', r.path, d]); store.set(r.path, clone(d)); }),
          set: (r, d) => pending.push(() => { writes.push(['set', r.path, d]); store.set(r.path, clone(d)); }),
          update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); writes.push(['update', r.path, p]); store.set(r.path, apply(store.get(r.path), p)); }),
        };
        const out = await fn(tx);
        const snap = new Map(store); const wlen = writes.length;
        try { pending.forEach((f) => f()); } catch (e) { store.clear(); snap.forEach((v, k) => store.set(k, v)); writes.length = wlen; throw e; }
        return out;
      },
    };
  }
  const FV = { serverTimestamp: () => '__TS__', arrayUnion: (...x) => ({ __union: x }) };
  const quiet = { info() {}, warn() {}, error() {} };
  const deps = { FieldValue: FV, logger: quiet, now: () => NOW };
  const invoicesIn = (db) => [...db.store.keys()].filter((k) => /^invoices\/[^/]+$/.test(k));

  console.log('\nC. idempotency (fake Firestore)');
  if (DD && SPINE && D) {
    // Since 2026-10-04 a company's own deposit rule decides (tenant-ops-logic
    // depositConfigFor; a company with none takes no cash deposit). This
    // tenant ('u1') runs a 50%-over-$2,000 rule — the cases below exercise it.
    const seed = () => ({
      'leads/L1': leadOf({ primaryEstimateId: 'E1' }),
      'estimates/E1': perSq(),
      'companyProfile/u1': { businessRules: { deposit: { noDepositUnderCents: 200000, depositPct: 50, roundToCents: 2500 } } },
    });
    {
      // A company that never set a deposit rule: no cash deposit → no draft.
      const s = seed(); delete s['companyProfile/u1'];
      const db = makeDb(s);
      await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_n1' }, deps);
      ok('a company with no deposit rule gets no draft deposit (neutral default)', invoicesIn(db).length === 0);
      // Company with a 30% rule: the draft is 30%.
      const s3 = seed(); s3['companyProfile/u1'] = { businessRules: { deposit: { noDepositUnderCents: 0, depositPct: 30, roundToCents: 100 } } };
      const db3 = makeDb(s3);
      await DD.draftDepositAfterSign(db3, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_n3' }, deps);
      const i3 = db3.store.get('invoices/depdraft_L1_job');
      ok('the company\'s own 30% rule sets the draft deposit', !!i3 && Math.round(i3.depositAmount * 100) === Math.round(i3.total * 30));
    }
    {
      const db = makeDb(seed());
      const r1 = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1' }, deps);
      const inv = db.store.get('invoices/depdraft_L1_job');
      ok('draftDepositAfterSign creates ONE draft at the deterministic id', r1.created === true && r1.invoiceId === 'depdraft_L1_job' && invoicesIn(db).length === 1 && inv.status === 'draft' && inv.createdAt === '__TS__');
      const task = db.store.get('leads/L1/tasks/review-deposit-depdraft_L1_job');
      ok('…and files ONE "Review deposit invoice" task due today (ET), linked to the invoice',
        task && task.text === '🧾 Review deposit invoice' && task.invoiceId === 'depdraft_L1_job' && task.done === false && task.dueDate === '2026-10-03' && r1.taskId === 'review-deposit-depdraft_L1_job');
      const n = db.writes.length;
      const r2 = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1' }, deps);
      ok('a retry of the same event writes nothing', r2.created === false && r2.reason === 'duplicate' && db.writes.length === n);
      const r3 = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'deal_accepted', sourceId: 'deal_x', meta: { dealId: 'x' } }, deps);
      ok('a SECOND signing event for the same job (deal room after the contract) writes nothing', r3.created === false && db.writes.length === n && invoicesIn(db).length === 1);
      ok('only invoices/ and the lead\'s tasks were written — no mail, sms, outbox or Stripe doc',
        db.writes.every((w) => /^invoices\/depdraft_L1_job$/.test(w[1]) || /^leads\/L1\/tasks\//.test(w[1])));
    }
    {
      // A concurrent delivery that created the invoice between read and commit.
      const db = makeDb(seed());
      const realTx = db.runTransaction.bind(db);
      db.runTransaction = async (fn) => realTx(async (tx) => { const out = await fn(tx); db.store.set('invoices/depdraft_L1_job', { status: 'draft', leadId: 'L1' }); return out; });
      const r = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1' }, deps);
      ok('a lost create race (ALREADY_EXISTS) is a quiet duplicate, not a second invoice', r.created === false && r.reason === 'duplicate' && invoicesIn(db).length === 1);
    }
    {
      const s = seed(); s['leads/L1/tasks/stage-contract_signed-collect_deposit'] = { text: '💵 Collect Deposit', done: false };
      const db = makeDb(s);
      const r = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1' }, deps);
      ok('an existing Collect Deposit task is reused — no second task', r.created === true && r.taskId === 'stage-contract_signed-collect_deposit'
        && ![...db.store.keys()].some((k) => k.startsWith('leads/L1/tasks/review-deposit')));
    }
    {
      const s = seed(); s['leads/L1'] = leadOf({ primaryEstimateId: 'E1', address: KY, jobType: 'insurance', claimNumber: 'K' });
      s['estimates/E1'] = { leadId: 'L1', userId: 'u1', mode: 'insurance', grandTotal: 12000, rows: [{ desc: 'Roof', retailTotal: 12000 }], claim: { deductible: 1000 } };
      const db = makeDb(s);
      const r = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1' }, deps);
      ok('KY insurance through the I/O path: nothing written, reason logged', r.created === false && r.reason === 'ky_insurance_hold' && db.writes.length === 0);
    }
    {
      // Through the job spine itself.
      const db = makeDb(Object.assign(seed(), { 'leads/L1': leadOf({ primaryEstimateId: 'E1', stage: 'estimate_sent_cash', jobType: 'cash' }) }));
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1', actor: 'remote signing' }, deps);
      ok('recordJobEvent(contract_signed) moves the lead AND makes the draft', r.moved === true && r.depositDraft && r.depositDraft.created === true && invoicesIn(db).length === 1);
      const again = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1', actor: 'remote signing' }, deps);
      ok('…the redelivered event: spine duplicate, draft duplicate, still one invoice', again.duplicate === true && again.depositDraft.created === false && invoicesIn(db).length === 1);
      const deal = await SPINE.spineAfterDealAccept(db, { dealId: 'k9', leadId: 'L1' }, 'better', deps);
      ok('…then the deal room accepted for the same job: still one invoice', deal.depositDraft && deal.depositDraft.created === false && invoicesIn(db).length === 1);
      const booked = await SPINE.recordJobEvent(makeDb(seed()), { leadId: 'L1', event: 'booked', sourceId: 'b1' }, deps);
      ok('a non-signing event never drafts', booked.depositDraft === undefined);
      const mism = makeDb(seed());
      const mm = await SPINE.recordJobEvent(mism, { leadId: 'L1', companyId: 'someone-else', event: 'contract_signed', sourceId: 'doc_z' }, deps);
      ok('a tenant-mismatched event never drafts', mm.reason === 'tenant_mismatch' && mm.depositDraft === undefined && invoicesIn(mism).length === 0);
    }
  }

  console.log('\nD. a draft is never owed');
  const draftInv = { id: 'd', leadId: 'L1', status: 'draft', total: 15000, balanceDue: 15000, autoDraft: { kind: 'deposit_on_sign' } };
  const sentInv = { id: 's', leadId: 'L1', status: 'sent', total: 2000, balanceDue: 2000 };
  {
    // #2112's owed rule is ONE rule: the server copy and the customer page's
    // copy are its canonical block (collected-revenue.js) byte-for-byte.
    const ob = (p) => { const m = lf(read(p)).match(/\/\/ nbd:owed-rule:start[\s\S]*?\/\/ nbd:owed-rule:end/); return m ? m[0] : null; };
    const canon = ob('docs/pro/js/collected-revenue.js');
    ok('functions/invoice-owed.js carries #2112\'s owed-rule block byte-for-byte', !!canon && fs.existsSync(path.join(ROOT, 'functions/invoice-owed.js')) && ob('functions/invoice-owed.js') === canon);
    ok('customer-tasks-ui.js (Total Owed) carries the same block byte-for-byte', !!canon && ob('docs/pro/js/customer-tasks-ui.js') === canon);
  }
  if (OWED) {
    ok('invoice-owed: draft / void / cancelled / deleted are not owed; sent / partial are',
      !OWED.isOwedInvoice(draftInv) && !OWED.isOwedInvoice({ status: 'void' }) && !OWED.isOwedInvoice({ status: 'Cancelled' })
      && !OWED.isOwedInvoice({ status: 'sent', deleted: true }) && OWED.isOwedInvoice(sentInv) && OWED.isOwedInvoice({ status: 'partial' }));
  }
  if (MB) {
    ok('morning brief: open balance skips the draft (sent $2,000 counts, draft $15,000 does not)',
      MB.openBalanceCents([draftInv, sentInv]) === 200000, 'got ' + MB.openBalanceCents([draftInv, sentInv]));
  }
  if (AM) {
    const wonLead = { id: 'L1', stage: 'closed', stageRole: 'won', completedAt: new Date(NOW - 86400000).toISOString(), userId: 'u1' };
    const rows = AM.postJob([wonLead], [draftInv], NOW, {});
    const rows2 = AM.postJob([wonLead], [draftInv, sentInv], NOW, {});
    ok('agent tools: a finished job\'s balance_owed ignores the draft (positive control: the sent one counts)',
      rows.length === 1 && rows[0].balance_owed === 0 && rows2[0].balance_owed === 2000, JSON.stringify(rows2));
  }
  {
    // Since #2130 the portal's balance card and its progress tracker share
    // ONE predicate, homeowner-progress.js invoiceOwes, which goes through
    // isOwedInvoice before balanceDue > 0. Wiring + behaviour, run for real.
    const portal = lf(read('functions/portal.js'));
    const hpSrc = lf(read('functions/homeowner-progress.js'));
    const HPm = require(path.join(ROOT, 'functions', 'homeowner-progress.js'));
    ok('homeowner portal: "balance due" filters through invoiceOwes = isOwedInvoice && balanceDue > 0 (a draft is never shown as owed)',
      /tenantInvoices\s*\n\s*\.filter\(invoiceOwes\)/.test(portal)
      && /return isOwedInvoice\(inv\) && Number\(inv\.balanceDue\) > 0;/.test(hpSrc)
      && /require\('\.\/invoice-owed'\)/.test(hpSrc));
    ok('homeowner portal: the draft owes nothing, the sent one does (and a draft never blocks "paid in full")',
      HPm.invoiceOwes(draftInv) === false && HPm.invoiceOwes(sentInv) === true
      && HPm.paidInFullFor({ stage: 'final_payment' }, [draftInv]) === true
      && HPm.paidInFullFor({ stage: 'final_payment' }, [draftInv, sentInv]) === false);
  }
  {
    // The customer page's Invoices & Payments list, run for real.
    const src = lf(read('docs/pro/js/customer-tasks-ui.js'));
    const a = src.indexOf('window.loadInvoices = async function');
    const b = src.indexOf('\n};\n', a);
    const fnSrc = (a >= 0 && b > a) ? src.slice(a, b + 3) : '';
    const el = { innerHTML: '' };
    const docs = [draftInv, sentInv, { id: 'p', leadId: 'L1', status: 'paid', total: 900, balanceDue: 0 }];
    const ctx = {
      console,
      document: { getElementById: (id) => (id === 'invoiceList' ? el : { innerHTML: '' }) },
      window: {},
    };
    Object.assign(ctx.window, {
      auth: { currentUser: { uid: 'u1' } }, db: {}, _userClaims: {},
      collection: () => ({}), query: () => ({}), where: () => ({}),
      getDocs: async () => ({ docs: docs.map((d) => ({ id: d.id, data: () => Object.assign({}, d) })) }),
      nbdTitleCount: () => {},
    });
    vm.createContext(ctx);
    let err = null;
    try { vm.runInContext(fnSrc, ctx); await ctx.window.loadInvoices('L1'); } catch (e) { err = e; }
    const html = el.innerHTML;
    const owed = (html.match(/Total Owed<\/div>\s*<div class="summary-value">\$([\d,.]+)/) || [])[1];
    ok('customer page Total Owed = $2,000.00 — the $15,000 draft is not owed', !err && owed === '2,000.00', err ? err.message : 'owed=' + owed);
    ok('…the draft row shows the "Draft deposit — review & send" chip (once — only the draft)',
      (html.match(/data-deposit-draft>Draft deposit — review &amp; send</g) || []).length === 1);
    ok('…and a Review & send button that opens the existing invoice detail (no send of its own)',
      /data-action="NBDCustomerInvoices\.review" data-arg="d"/.test(html) && !/NBDCustomerInvoices\.review" data-arg="s"/.test(html)
      && /review: async function[\s\S]{0,900}showInvoiceDetailModal\(invoiceId\)/.test(src)
      && !/review: async function[\s\S]{0,900}sendInvoice/.test(src));
  }
  if (IP) {
    ok('invoice panel / list / detail share one chip helper (isDepositDraft + depositDraftChipHtml)',
      IP.isDepositDraft(draftInv) && !IP.isDepositDraft(Object.assign({}, draftInv, { status: 'sent' })) && !IP.isDepositDraft({ status: 'draft' })
      && /Draft deposit — review &amp; send/.test(IP.depositDraftChipHtml(draftInv)) && IP.depositDraftChipHtml(sentInv) === '');
    const ip = lf(read('docs/pro/js/invoice-pipeline.js'));
    ok('…rendered in renderInvoicePanel, renderInvoiceList and renderInvoiceDetail', (ip.match(/depositDraftChipHtml\(inv\)/g) || []).length >= 3);
  }
  {
    const css = read('docs/pro/css/invoice-pipeline.css');
    ok('the chip is styled by class (no inline style), loaded on both pages at a bumped ?v=',
      /\.ipx-draft-chip/.test(css) && /css\/invoice-pipeline\.css\?v=2/.test(read('docs/pro/customer.html')) && /css\/invoice-pipeline\.css\?v=2/.test(read('docs/pro/dashboard.html')));
  }
  {
    // Nothing in the draft path can send.
    const files = ['functions/deposit-draft.js', 'functions/deposit-draft-logic.js'].filter((f) => fs.existsSync(path.join(ROOT, f)));
    const code = files.map((f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('\n');
    ok('the draft path never emails, texts or calls Stripe', files.length === 2
      && !/sendEmail|sendSms|sendSMS|twilio|resend|mail_queue|sms_outbox|stripe|paymentLink\(|createStripePaymentLink/i.test(code.replace(/stripePaymentLink: null|stripeInvoiceId: null/g, '')));
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
