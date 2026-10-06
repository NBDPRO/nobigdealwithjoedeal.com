/**
 * tests/r2-money-lines-jobvalue-2026-10-06.test.js
 *
 * Fixes for review round 2 (nbd-content/review-r2-2026-10-06.md, Jo approved
 * 2026-10-06), built from the repros pinned in draft PR #2243:
 *
 *   R2-2-2  the e-sign contract and the homeowner estimate link listed lines
 *           that did not foot to the price: no sales-tax row, no Rounding /
 *           Minimum job charge adjustment row. buildDisplayRows and
 *           buildDocLineItems (customer-estimate-rows.js, both copies) now
 *           end with those rows, worded and computed like the invoice's
 *           (invoiceTotalsFromEstimate, #2200).
 *   R2-2-3  re-saving an existing estimate (V2 reopen / re-send) left
 *           lead.jobValue at the old total. The _saveEstimate edit branch now
 *           re-stamps it when the estimate is the lead's primaryEstimateId.
 *   R2-2-4  the pre-flight "Total Price" / "Contract Price" (and the fallback
 *           fill modal) prefilled lead.jobValue over the estimate's total.
 *
 * Behavioural wherever the code runs in Node. Pure Node, no functions/ deps:
 *   node tests/r2-money-lines-jobvalue-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}

// The { … } block that opens at the first '{' at/after `from`.
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const CER = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));
const IFE = require(path.join(ROOT, 'functions', 'invoice-from-estimate.js'));
const cents = (n) => Math.round(n * 100);
const sum = (rows) => rows.reduce((s, r) => s + cents(Number(r.total)), 0) / 100;

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\nR2-2-2 — contract / estimate-link lines foot to the price');
  // ══════════════════════════════════════════════════════════════════
  // The #2243 repro fixtures, verbatim.
  const taxed = { rows: [{ desc: 'Tear off + install', qty: '20 SQ', retailTotal: 8000, total: 8000 }, { desc: 'Ridge vent', qty: '40 LF', retailTotal: 800, total: 800 }],
    materialMarkupPct: 0.25, overhead: 880, profit: 880, overheadPct: 0.1, profitPct: 0.1, subtotal: 10560, tax: 739.2, taxRate: 0.07, grandTotal: 11300 };
  const minJob = { rows: [{ desc: 'Pipe boot repair', qty: '1 EA', retailTotal: 555, total: 555 }], materialMarkupPct: 0.3,
    subtotal: 555, tax: 41.63, taxRate: 0.075, grandTotal: 2500, minJobApplied: true };

  const r1 = CER.buildDisplayRows(taxed), r2 = CER.buildDisplayRows(minJob);
  ok('FIXED (was KNOWN BUG R2-2-2): a taxed $11,300 job\'s display rows foot to $11,300', sum(r1) === 11300, 'got ' + sum(r1));
  ok('FIXED (was KNOWN BUG R2-2-2): a $2,500 minimum job\'s display rows foot to $2,500', sum(r2) === 2500, 'got ' + sum(r2));
  const tax1 = r1.find((r) => /^Sales tax/.test(r.desc));
  ok('the taxed job prints "Sales tax (7%)" at the saved $739.20', !!tax1 && tax1.desc === 'Sales tax (7%)' && tax1.total === 739.2, JSON.stringify(tax1));
  ok('the taxed job\'s $0.80 nearest-$25 difference prints as "Rounding"',
    r1[r1.length - 1].desc === 'Rounding' && r1[r1.length - 1].total === 0.8, JSON.stringify(r1[r1.length - 1]));
  ok('the minimum job prints "Sales tax (7.5%)" then "Minimum job charge adjustment" $1,903.37 — the invoice\'s wording',
    r2.length === 3 && r2[1].desc === 'Sales tax (7.5%)' && r2[2].desc === 'Minimum job charge adjustment' && r2[2].total === 1903.37,
    JSON.stringify(r2));
  ok('the tax and adjustment rows come AFTER the O&P row (lines → O&P → tax → adjustment)',
    r1.map((r) => r.code).join(',') === ',,O&P,TAX,ADJ', r1.map((r) => r.code).join(','));

  // Agreement with the invoice (#2200): same adjustment cents, same label,
  // and lines + tax == the invoice's total, for every fixture.
  const agree = [
    ['taxed', taxed], ['minimum job', minJob],
    ['round-down (−$5)', { rows: [{ desc: 'Repair', qty: '1 EA', retailTotal: 1000, total: 1000 }], materialMarkupPct: 0.3, subtotal: 1000, tax: 80, taxRate: 0.08, grandTotal: 1075 }],
    ['insurance, untaxed, rounded', { rows: [{ desc: 'Scope', qty: '1', retailTotal: 9990, total: 9990 }], materialMarkupPct: 0.25, subtotal: 9990, tax: 0, taxRate: 0, grandTotal: 10000, mode: 'insurance' }],
    ['already foots (no extra rows)', { rows: [{ desc: 'Scope', qty: '1', retailTotal: 1000, total: 1000 }], materialMarkupPct: 0.25, subtotal: 1000, tax: 75, taxRate: 0.075, grandTotal: 1075 }],
    ['min-job flag but a round-DOWN', { rows: [{ desc: 'Scope', qty: '1', retailTotal: 3000, total: 3000 }], materialMarkupPct: 0.25, subtotal: 3000, tax: 210, taxRate: 0.07, grandTotal: 3200, minJobApplied: true }],
  ];
  for (const [name, est] of agree) {
    const rows = CER.buildDisplayRows(est);
    const inv = IFE.invoiceTotalsFromEstimate(est, { estimateValue: CER.estimateValue });
    const invAdj = inv.items.find((i) => i.adjustment);
    const adj = rows.find((r) => r.code === 'ADJ');
    const invFoot = (inv.items.reduce((s, i) => s + cents(i.total), 0) + cents(inv.tax)) / 100;
    ok('agreement (' + name + '): display rows foot to the invoice total $' + inv.total + ', and the adjustment row matches the invoice\'s line',
      sum(rows) === inv.total && invFoot === inv.total
        && (invAdj ? (adj && adj.desc === invAdj.description && cents(adj.total) === cents(invAdj.total)) : !adj),
      JSON.stringify({ rows: sum(rows), inv: inv.total, adj, invAdj }));
  }
  const ins = CER.buildDisplayRows(agree[3][1]);
  ok('an untaxed insurance job gets NO tax row (a $0 tax line is never printed)', !ins.some((r) => r.code === 'TAX'), JSON.stringify(ins));
  ok('a job that already foots gets neither row', CER.buildDisplayRows(agree[4][1]).map((r) => r.code).join(',') === ',TAX', JSON.stringify(CER.buildDisplayRows(agree[4][1])));
  ok('a negative difference is "Rounding" even on a min-job estimate (the lift is only ever positive)',
    (CER.buildDisplayRows(agree[5][1]).find((r) => r.code === 'ADJ') || {}).desc === 'Rounding');
  ok('no saved subtotal → no footing rows (cannot tell what the lines already include; unchanged behaviour)',
    CER.buildDisplayRows({ rows: [{ desc: 'Roof', qty: '1', total: '$12,000' }], grandTotal: 12000, tax: 500 }).length === 1);
  ok('per-SQ docs still return NO rows (the tier price is the only customer number)',
    CER.buildDisplayRows({ priceMode: 'per-sq', prices: { good: 1, better: 2, best: 3 }, rows: [{ desc: 'x', total: 1 }], subtotal: 1, tax: 1, grandTotal: 3 }).length === 0);
  ok('the classic 3-row legacy shape (no V2 pricing) still maps rows at face, then foots',
    sum(CER.buildDisplayRows({ rows: [{ desc: 'Roof', qty: '30 SQ', rate: '$400/SQ', total: 12000 }], subtotal: 12000, taxAmount: 900, taxRate: 0.075, grandTotal: 12900 })) === 12900);

  {
    // The engine rounds each row: lines a cent off the saved subtotal still foot to the price exactly.
    const drift = { rows: [{ desc: 'A', qty: '1', retailTotal: 333.33, total: 333.33 }, { desc: 'B', qty: '1', retailTotal: 333.33, total: 333.33 }, { desc: 'C', qty: '1', retailTotal: 333.33, total: 333.33 }],
      materialMarkupPct: 0.25, subtotal: 1000, tax: 70, taxRate: 0.07, grandTotal: 1075 };
    ok('a 1-cent per-row rounding drift is absorbed: the printed lines foot to $1,075 to the cent', sum(CER.buildDisplayRows(drift)) === 1075, String(sum(CER.buildDisplayRows(drift))));
    // An old doc whose lines are far from the subtotal: the adjustment is the invoice's (from the subtotal), never a big "Rounding" that hides the gap.
    const gap = { rows: [{ desc: 'A', qty: '1', retailTotal: 600, total: 600 }], materialMarkupPct: 0.25, subtotal: 1000, tax: 70, taxRate: 0.07, grandTotal: 1075 };
    const g = CER.buildDisplayRows(gap), gi = IFE.invoiceTotalsFromEstimate(gap, { estimateValue: CER.estimateValue }).items.find((i) => i.adjustment);
    ok('lines $400 short of the subtotal: the adjustment row equals the invoice\'s ($5), it does not swallow the gap', (g.find((r) => r.code === 'ADJ') || {}).total === 5 && gi && gi.total === 5, JSON.stringify(g));
  }

  // buildDocLineItems (the contract pre-flight's scope, getEstimateForView's
  // lineItems fallback, esign-envelope's lineItems fallback).
  const d1 = CER.buildDocLineItems(taxed), d2 = CER.buildDocLineItems(minJob);
  ok('buildDocLineItems: V2 rows foot to the price ($11,300 / $2,500)', sum(d1) === 11300 && sum(d2) === 2500, sum(d1) + ' / ' + sum(d2));
  ok('buildDocLineItems: the footing rows read as qty 1 at their own total (doc templates print qty × unit)',
    d2.length === 3 && d2.slice(-2).every((r) => r.qty === 1 && r.unitPrice === r.total) && d2[2].description === 'Minimum job charge adjustment');
  const classic = { lineItems: [{ description: 'Roof', quantity: 1, amount: 10000 }], subtotal: 10000, taxAmount: 700, taxRate: 0.07, total: 10725 };
  const dc = CER.buildDocLineItems(classic);
  ok('buildDocLineItems: classic lineItems foot to the price too (tax + rounding)', sum(dc) === 10725 && dc.length === 3, JSON.stringify(dc.map((r) => [r.description, r.total])));
  // Pre-flight saves the scope back onto the doc as lineItems — the footing
  // rows must not be added a second time on the next read.
  const savedBack = Object.assign({}, classic, { lineItems: dc });
  const again = CER.buildDocLineItems(savedBack);
  ok('buildDocLineItems: a scope saved back WITH its tax/adjustment rows is not double-footed', sum(again) === 10725 && again.length === 3,
    JSON.stringify(again.map((r) => [r.description, r.total])));
  const v2Back = Object.assign({}, taxed, { lineItems: d1 });
  ok('buildDocLineItems: a V2 doc whose rows were saved back as lineItems still foots once', sum(CER.buildDocLineItems(v2Back)) === 11300);
  ok('per-SQ buildDocLineItems is still ONE summary line at the tier total (tax inside it)',
    (() => { const p = CER.buildDocLineItems({ priceMode: 'per-sq', prices: { better: 12000 }, tier: 'better', grandTotal: 12000, subtotal: 11162.79, tax: 837.21 }); return p.length === 1 && p[0].total === 12000; })());

  // The two copies ship together (byte-identical rule).
  ok('functions/ and docs/pro/js/ customer-estimate-rows.js are byte-identical',
    rd('functions/customer-estimate-rows.js') === rd('docs/pro/js/customer-estimate-rows.js'));

  // The consumers really use these rows (a private copy would drift again).
  ok('esign-envelope estimateLines and portal getEstimateForView read buildDisplayRows',
    /CER\.buildDisplayRows\(est\)/.test(rd('functions/esign-envelope.js')) && /const displayRows = buildDisplayRows\(est\);/.test(rd('functions/portal.js')));
  // The estimate link prints a negative Rounding as −$5, not $-5.
  {
    const src = rd('docs/pro/js/estimate-view.js');
    const at = src.indexOf('function money(n)');
    const body = at === -1 ? null : braceBlock(src, at);
    const money = body ? new Function('n', body.slice(1, -1)) : null;
    ok('estimate-view money(): negative amounts print the sign before the $',
      !!money && money(-5) === '−$5' && money(0.8) === '$0.80' && money(11300) === '$11,300', money && [money(-5), money(0.8), money(11300)].join(' '));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nR2-2-3 — re-saving the primary estimate updates lead.jobValue');
  // ══════════════════════════════════════════════════════════════════
  const boot = rd('docs/pro/js/dashboard-bootstrap.module.js');
  const at = boot.indexOf('window._saveEstimate = async (data) => {');
  const fnBody = at === -1 ? null : braceBlock(boot, at + 'window._saveEstimate = async (data) =>'.length);
  ok('anchor: window._saveEstimate is found', !!fnBody);
  async function runSave({ lead, estimates, data, editId, failLeadWrite }) {
    const writes = [];
    const store = { 'leads/L1': lead ? Object.assign({}, lead) : null };
    const win = { _editingEstimateId: editId, _estimates: estimates || [], _user: { uid: 'u1' }, _userClaims: {} };
    const api = {
      window: win, db: {},
      doc: (_db, col, id) => ({ path: col + '/' + id }),
      collection: (_db, col) => ({ col }),
      serverTimestamp: () => 'TS',
      getDoc: async (ref) => ({ exists: () => !!store[ref.path], data: () => store[ref.path] }),
      updateDoc: async (ref, patch) => {
        if (failLeadWrite && ref.path.startsWith('leads/')) throw new Error('denied');
        writes.push({ path: ref.path, patch });
        if (store[ref.path]) Object.assign(store[ref.path], patch);
      },
      addDoc: async () => ({ id: 'NEW' }),
      loadEstimates: async () => {},
      _estValue: (e) => CER.estimateValue(e),
      _canStampJobValue: (v) => Number.isFinite(v) && v > 0,
      normalizeStage: (s) => s, S: { NEW: 'new' }, _estimateBumpToContacted: async () => {},
      console: { warn() {}, error() {}, log() {} },
    };
    const names = Object.keys(api);
    const save = new Function(...names, 'return async (data) => ' + fnBody + ';')(...names.map((k) => api[k]));
    const ret = await save(data);
    return { ret, writes, lead: store['leads/L1'], win };
  }
  if (fnBody) {
    const prim = { primaryEstimateId: 'E1', jobValue: 14500, stage: 'estimate_submitted' };
    const a = await runSave({ lead: prim, editId: 'E1', data: { leadId: 'L1', grandTotal: 16200, rows: [] } });
    ok('FIXED (was KNOWN BUG R2-2-3): re-saving the primary $14,500 estimate at $16,200 sets lead.jobValue to $16,200',
      a.ret === 'E1' && a.lead.jobValue === 16200 && a.writes.some((w) => w.path === 'estimates/E1') && a.writes.some((w) => w.path === 'leads/L1' && w.patch.jobValue === 16200),
      JSON.stringify(a.writes));
    const b = await runSave({ lead: prim, editId: 'E2', data: { leadId: 'L1', grandTotal: 16200 } });
    ok('re-saving a NON-primary estimate leaves the lead alone (the confirmed number is never clobbered)',
      b.lead.jobValue === 14500 && !b.writes.some((w) => w.path.startsWith('leads/')), JSON.stringify(b.writes));
    const c = await runSave({ lead: prim, editId: 'E1', data: { leadId: 'L1', grandTotal: 0 } });
    ok('a $0 re-save never overwrites a real job value (_canStampJobValue, same rule as create)',
      c.lead.jobValue === 14500 && !c.writes.some((w) => w.path.startsWith('leads/')));
    const d = await runSave({ lead: prim, editId: 'E1', estimates: [{ id: 'E1', leadId: 'L1', grandTotal: 14500 }], data: { title: 'Classic', amount: '$15,000' } });
    ok('the lead is found from the loaded estimate when the save payload carries no leadId; a Classic "$15,000" amount reads as 15000',
      d.lead.jobValue === 15000, JSON.stringify(d.writes));
    const e = await runSave({ lead: prim, editId: 'E1', data: { leadId: 'L1', grandTotal: 14500 } });
    ok('an unchanged total writes nothing to the lead', !e.writes.some((w) => w.path.startsWith('leads/')));
    const f = await runSave({ lead: prim, editId: 'E1', data: { leadId: 'L1', grandTotal: 16200 }, failLeadWrite: true });
    ok('a lead-write failure does not fail the estimate save (best-effort, like create)', f.ret === 'E1' && f.writes.some((w) => w.path === 'estimates/E1'));
    const g = await runSave({ lead: { jobValue: 9000 }, editId: 'E1', data: { leadId: 'L1', grandTotal: 16200 } });
    ok('a lead with no primaryEstimateId is left alone on an edit', g.lead.jobValue === 9000);
    ok('the edit branch clears _editingEstimateId', a.win._editingEstimateId === null);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nR2-2-4 — the contract price prefill prefers the estimate total');
  // ══════════════════════════════════════════════════════════════════
  {
    const DG = path.join(ROOT, 'docs/pro/js');
    const win = { _brand: () => ({ legalName: 'X', colors: {}, contact: {} }) };
    win.window = win;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON,
      document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() } };
    for (const f of ['estimate-config.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(DG, f), 'utf8'), sandbox, { filename: f });
    }
    const resolve = win.DocPreflight && win.DocPreflight._resolveFieldValue;
    ok('anchor: DocPreflight._resolveFieldValue is exposed', typeof resolve === 'function');
    if (resolve) {
      const field = { key: 'totalPrice', source: 'computed.jobValue' };
      ok('FIXED (was KNOWN BUG R2-2-4): lead.jobValue $14,500 + selected estimate $16,200 → the pre-flight prefills $16,200',
        Number(resolve(field, { lead: { jobValue: 14500 }, estimate: { grandTotal: 16200 } })) === 16200);
      ok('a Classic estimate (total / amount) wins over lead.jobValue too',
        Number(resolve(field, { lead: { jobValue: 14500 }, estimate: { amount: 15000 } })) === 15000);
      ok('no estimate selected → lead.jobValue (unchanged)', Number(resolve(field, { lead: { jobValue: 14500 }, estimate: null })) === 14500);
      ok('an estimate with no price → lead.jobValue', Number(resolve(field, { lead: { jobValue: 14500 }, estimate: { grandTotal: 0 } })) === 14500);
    }
    // The fallback fill modal (_docgenAutoFill) — runs when pre-flight is absent.
    const src = rd('docs/pro/js/document-generator.js');
    const fa = src.indexOf('window._docgenAutoFill = function(leadId) {');
    const body = fa === -1 ? null : braceBlock(src, fa + 'window._docgenAutoFill = function(leadId)'.length);
    ok('anchor: _docgenAutoFill is found', !!body);
    if (body) {
      const els = {};
      const doc = { getElementById: (id) => (els[id] = els[id] || { value: '' }) };
      const w = { _leads: [{ id: 'L1', firstName: 'A', jobValue: 14500, primaryEstimateId: 'E1' }], _estimates: [{ id: 'E0', grandTotal: 99999 }, { id: 'E1', grandTotal: 16200 }] };
      new Function('window', 'document', 'return function(leadId) ' + body + ';')(w, doc)('L1');
      ok('FIXED (was KNOWN BUG R2-2-4, fill modal): totalPrice / contractPrice / totalAmount prefill the PRIMARY estimate\'s $16,200',
        ['totalPrice', 'contractPrice', 'totalAmount'].every((k) => els['docgen_' + k].value === '16200'),
        JSON.stringify(['totalPrice', 'contractPrice', 'totalAmount'].map((k) => els['docgen_' + k].value)));
      const els2 = {};
      const doc2 = { getElementById: (id) => (els2[id] = els2[id] || { value: '' }) };
      new Function('window', 'document', 'return function(leadId) ' + body + ';')({ _leads: [{ id: 'L2', jobValue: 14500 }], _estimates: [] }, doc2)('L2');
      ok('no primary estimate loaded → lead.jobValue (unchanged)', els2.docgen_contractPrice.value === '14500');
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
