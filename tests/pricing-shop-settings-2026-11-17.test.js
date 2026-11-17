/**
 * tests/pricing-shop-settings-2026-11-17.test.js
 *
 * The pricing batch from the 2026-11-17 repo sweep, built to Jo's answers:
 *   M4 / Q13  Job Template estimates price on the rep's saved markup /
 *             overhead / profit (Settings → Estimates), like the V2 builder,
 *             and say so once ("now using your Settings rates") when those
 *             differ from the 25 / 10 / 10 defaults
 *   M5 / Q14  line-item estimates (V2 and Job Templates) round to the saved
 *             "Round to", not a hard-coded $25
 *   L6 / Q15  resolveEstimate rolls up overhead, profit and tax in whole
 *             cents, so line total + O + P is exactly the printed subtotal
 *   L7 / Q15  pass-through fees are added to the saved subtotal / total in
 *             cents (no sub-cent residue)
 *   review    supplement invoices bill the company's own deposit rule
 *
 * Runs the real engines (estimate-config, estimate-builder-v2,
 * estimate-logic-engine, job-templates, estimate-v2-ui) in a vm, the same
 * stack tests/estimate-pricing-paths-2026-10-05.test.js uses.
 *
 * Run: node tests/pricing-shop-settings-2026-11-17.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  — ' + JSON.stringify(detail) : '')); }
}
// Strict: the number prints as whole cents (325.20000000000005 does not).
const isCents = (x) => typeof x === 'number' && /^-?\d+(\.\d{1,2})?$/.test(String(x));

function makeSandbox() {
  const byId = {};
  const el = (tag) => ({
    tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; }, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, remove() {},
  });
  const document = { head: el('head'), body: el('body'), createElement: el, getElementById: (id) => byId[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = { localStorage, document };
  win.window = win;
  const sandbox = { window: win, document, localStorage, navigator: { userAgent: 'node' }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' } };
  vm.createContext(sandbox);
  return { win, sandbox, store };
}
const FILES = [
  'docs/pro/js/estimate-config.js', 'docs/pro/js/ky-insurance-law.js', 'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js', 'docs/pro/js/roofivent-catalog.js', 'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js', 'docs/pro/js/estimate-catalog-xactimate.js', 'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js', 'docs/pro/js/job-templates.js', 'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/estimate-finalization.js', 'docs/pro/js/estimate-v2-ui.js',
];
function stack(settings) {
  const env = makeSandbox();
  if (settings) env.store.nbd_est_settings_v3 = JSON.stringify(settings);
  FILES.forEach((f) => vm.runInContext(read(f), env.sandbox, { filename: path.basename(f) }));
  return env;
}
const SHOP = { overheadPct: 0.15, profitPct: 0.15, materialMarkupPct: 0.30, roundTo: 1 };

// ════════════════════════════════════════════════════════════════════
console.log('\nM4 + M5: Job Templates price on the shop\'s saved rates and rounding');
{
  const env = stack(SHOP);
  const W = env.win;
  const JT = W.JobTemplates;
  const id = (W.NBD_JOB_TEMPLATES || []).map((t) => t.id).find((tid) => {
    const r = JT.resolveSelection([{ templateId: tid }], { tier: 'better', jobMode: 'cash', county: '' });
    return r && r.totals && r.totals.lines && r.totals.lines.length;
  });
  ok('a priced Job Template exists to test with', !!id);
  // The search above priced templates too, which spent the one-time note.
  delete env.store.nbd_jt_settings_rates_note_v1;
  if (id) {
    let seen = null;
    const real = W.EstimateLogic.resolveEstimate;
    W.EstimateLogic.resolveEstimate = function (l, m, s) { seen = Object.assign({}, s); return real.apply(this, arguments); };
    const r = JT.resolveSelection([{ templateId: id }], { tier: 'better', jobMode: 'cash', county: '' });
    W.EstimateLogic.resolveEstimate = real;
    ok('resolveSelection hands the engine the saved markup / overhead / profit', seen && seen.materialMarkupPct === 0.30 && seen.overheadPct === 0.15 && seen.profitPct === 0.15, seen);
    ok('…and the saved Round to', seen && seen.roundTo === 1, seen);
    ok('the template estimate\'s totals carry 15% / 15%', r.totals && Math.abs(r.totals.overheadPct - 0.15) < 1e-9 && Math.abs(r.totals.profitPct - 0.15) < 1e-9, r.totals && [r.totals.overheadPct, r.totals.profitPct]);
    ok('the resolve reports the "Now using your Settings rates" note (res.ratesNote) with the rates', /Settings rates/.test(r.ratesNote || '') && /30%/.test(r.ratesNote) && /15%/.test(r.ratesNote), r.ratesNote);
    ok('…resolving (e.g. the gallery\'s background price bands) never spends the one-time flag', !env.store.nbd_jt_settings_rates_note_v1);
    ok('the preview takes it once: takeRatesNote → the note, then null on this device', JT.takeRatesNote(r) === r.ratesNote && JT.takeRatesNote(r) === null);
    ok('the resolve reports the Round to it priced at, for the upgrade unwind', r.roundTo === 1, r.roundTo);
    // Template upgrades unwind a floored total at the same Round to.
    let applyOpts = null;
    W.NBDUpgrades = {
      offeredFor: () => [], price: () => ({ rows: [{ upgradeId: 'x', desc: 'Upgrade — x' }], errors: [] }),
      applyToEstimate: (p, priced, opts) => { applyOpts = opts; return p; },
    };
    try { JT.applyUpgrades({ taxRate: 0, rows: [] }, r, { picks: ['x'] }); } catch (e) { /* the stub is enough to reach applyToEstimate */ }
    ok('applyUpgrades hands applyToEstimate the shop\'s Round to (it re-rounded at $25)', !!applyOpts && applyOpts.roundTo === 1, applyOpts);

    const plain = stack(null);
    const rp = plain.win.JobTemplates.resolveSelection([{ templateId: id }], { tier: 'better', jobMode: 'cash', county: '' });
    ok('default settings (25/10/10, $25): no note, and the same totals as before', !rp.ratesNote && Math.abs(rp.totals.overheadPct - 0.10) < 1e-9 && rp.totals.total % 25 === 0, rp.totals && rp.totals.total);
  }
  const bad = stack({ overheadPct: '', profitPct: null, materialMarkupPct: 'abc', roundTo: 0 });
  const id2 = (bad.win.NBD_JOB_TEMPLATES || [])[0] && bad.win.NBD_JOB_TEMPLATES[0].id;
  let seen2 = null;
  const real2 = bad.win.EstimateLogic.resolveEstimate;
  bad.win.EstimateLogic.resolveEstimate = function (l, m, s) { seen2 = Object.assign({}, s); return real2.apply(this, arguments); };
  if (id2) bad.win.JobTemplates.resolveSelection([{ templateId: id2 }], { tier: 'better', jobMode: 'cash', county: '' });
  ok('blank / corrupt saved values are never forwarded (a blank field cannot zero a price)', !!seen2 && seen2.overheadPct === undefined && seen2.profitPct === undefined && seen2.materialMarkupPct === undefined && seen2.roundTo === undefined, seen2);
}

// ════════════════════════════════════════════════════════════════════
console.log('\nM5: the V2 line-item builder rounds to the saved Round to');
{
  const env = stack(SHOP);
  const V2 = env.win.EstimateV2UI && env.win.EstimateV2UI._test;
  ok('shopLineItemRates includes roundTo', !!V2 && V2.shopLineItemRates().roundTo === 1, V2 && V2.shopLineItemRates());
  if (V2) {
    const st = V2.getState();
    st._reopenedClean = false; st._reopenedDoc = null;
    st.mode = 'line-item'; st.jobMode = 'cash'; st.tier = 'better'; st.county = '';
    st.measurements = Object.assign({}, st.measurements, { rawSqft: 1000, pitch: 6 });
    st.scope = [{ code: 'LAB MOB' }]; st.passThru = []; st.upgrades = []; st.minJobCharge = null;
    let est = null;
    try { est = V2.effectiveEstimate(); } catch (e) { est = { threw: String(e && e.message) }; }
    ok('a line-item estimate totals to the dollar, not the next $25', !!est && typeof est.total === 'number' && Math.abs(est.total - Math.round((est.subtotal || 0) + (est.tax || 0))) < 0.005, est && [est.total, est.subtotal, est.tax, est.threw]);

    // L7: pass-through fees with cents land as cents. $325 + 0.10 + 0.10 is
    // 325.20000000000005 in float dollars, so the old += left a residue.
    st.passThru = [0.1, 0.1].map((a, i) => ({ code: 'SVC FEE' + i, desc: 'Fee ' + i, amount: a, source: 'passthru' }));
    let e2 = null;
    try { e2 = V2.effectiveEstimate(); } catch (e) { e2 = { threw: String(e && e.message) }; }
    ok('L7: with two $0.10 pass-throughs, the saved subtotal and total are whole cents', !!e2 && isCents(e2.subtotal) && isCents(e2.total) && String(e2.subtotal).length < 12, e2 && [e2.subtotal, e2.total, e2.threw]);
  }
}

// ════════════════════════════════════════════════════════════════════
console.log('\nL6: resolveEstimate rolls up in whole cents');
{
  const env = stack(null);
  const EL = env.win.EstimateLogic;
  // Odd unit costs so the float rollup leaves fractions of a cent.
  const lines = [
    { code: 'T1', name: 'odd material', unit: 'ea', qtyOverride: 3, materialCost: 10.333, laborCost: 0 },
    { code: 'T2', name: 'odd labor', unit: 'ea', qtyOverride: 7, materialCost: 0, laborCost: 13.777 },
  ];
  let r = null;
  try { r = EL.resolveEstimate(lines, { rawSqft: 1000, pitch: 6 }, { tier: 'better', mode: 'cash', county: '', fallbackTaxRate: 0.0725, overheadPct: 0.1, profitPct: 0.1, materialMarkupPct: 0.25 }); } catch (e) { r = { threw: String(e && e.message) }; }
  const c = (x) => Math.round(x * 100);
  ok('overhead, profit, subtotal and tax are whole cents', !!r && isCents(r.overhead) && isCents(r.profit) && isCents(r.subtotal) && isCents(r.tax), r && [r.overhead, r.profit, r.subtotal, r.tax, r.threw]);
  ok('line total + overhead + profit is exactly the subtotal', !!r && c(r.retailBeforeOHP) + c(r.overhead) + c(r.profit) === c(r.subtotal), r && [r.retailBeforeOHP, r.overhead, r.profit, r.subtotal]);
}

// ════════════════════════════════════════════════════════════════════
console.log('\nsupplement invoice: the company\'s own deposit rule');
{
  const SI = require(path.join(ROOT, 'functions', 'supplement-invoice.js'));
  const base = {
    est: { grandTotal: 10000, total: 10000, subtotal: 10000, tax: 0, taxRate: 0, mode: 'cash', addr: '1 Main St, Milford, OH 45150' },
    estimateId: 'E1', lead: null, leadId: null, jobId: null, companyId: 'co-oaks', uid: 'u1',
    bill: [{ line: { description: 'Supplement', qty: 1, rate: 0, amount: 0 }, cents: 0 }], billed: [], invoices: [], jobs: [], nowMs: 1,
  };
  let p = null, err = null;
  try { p = SI.planSupplementInvoice(Object.assign({}, base, { depositConfig: { CASH_NO_DEPOSIT_UNDER_CENTS: 0, CASH_DEPOSIT_PCT: 30, CASH_DEPOSIT_ROUND_TO_CENTS: 100 } })); } catch (e) { err = e.message; }
  ok('planSupplementInvoice honours depositConfig (30% of $10,000 = $3,000)', !!p && p.action === 'create' && p.doc && p.doc.depositAmount === 3000, p ? (p.doc && p.doc.depositAmount) : err);
  let n = null;
  try { n = SI.planSupplementInvoice(base); } catch (e) { err = e.message; }
  ok('…and without one keeps deposit-rule.js\'s own rule (50% = $5,000)', !!n && n.doc && n.doc.depositAmount === 5000, n ? (n.doc && n.doc.depositAmount) : err);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
