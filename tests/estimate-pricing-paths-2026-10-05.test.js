/**
 * tests/estimate-pricing-paths-2026-10-05.test.js — every pricing path, the
 * job minimum and the tier edges, pinned. Approved by Jo 2026-10-05.
 *
 * TEST-ONLY. Nothing in the pricing code changed with this file. Where a test
 * exposed a bug it was NOT fixed: it is pinned as a KNOWN BUG — the test
 * asserts TODAY's behaviour so the suite stays green, and its name says what
 * happens and what should happen. When Jo approves a fix, that test is
 * flipped on purpose in the fix PR.
 *
 * Expected dollars are worked out by hand from the RULES (inputs → dollars,
 * shown in the comments), never by calling the function under test twice.
 * Every fixture cost is synthetic (tests/catalog-cost-seed.test.js).
 *
 * The real files are loaded the way the app loads them: fs.readFileSync +
 * vm.runInContext against a fake window / document / localStorage, or
 * require() for the functions/ modules.
 *
 *   A. Job minimum — per-SQ (calculatePerSq)
 *   B. Job minimum — line-item path (calculateLineItem) + logic engine (resolveEstimate)
 *   C. Tier pricing — rates, waste breakpoints, cut-up, pitch/story/access adders, layers, boots
 *   D. Five tiers — monotonic, only the rate differs, line-item column mapping
 *   E. Job templates — resolveSelection
 *   F. Deposit boundaries (beyond tests/deposit-rule.test.js)
 *   G. Old builder (estimates.js) — bug #6 FIXED 2026-10-05 (round then floor; five tiers)
 *   H. V2 builder UI composition (estimate-v2-ui.js getCurrentEstimate on the real engines)
 *   I. Deal room accepted tier (functions/deal-accepted-tier.js)
 *   M. Mutation proof — the floor assertions go RED against mutated in-memory copies
 *
 * NBD_EST_MUTANT=dollars|strict runs the WHOLE suite against a mutated
 * in-memory copy (JOB_MINIMUM_DOLLARS 2500→2400, or the per-SQ floor test
 * `<` → `<=`) — the files on disk are never touched. Used once to prove the
 * suite can fail; CI runs it unmutated.
 *
 * Run: node tests/estimate-pricing-paths-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
function safe(fn) { try { return fn(); } catch (e) { return { __threw: String(e && e.stack || e).slice(0, 300) }; } }
const j = (v) => JSON.stringify(v);

// ════════════════════════════════════════════════════════════════════
// Sandbox — a fake window/document/localStorage, the engines loaded into it.
// ════════════════════════════════════════════════════════════════════
const CFG_FILE = 'docs/pro/js/estimate-config.js';
const V2_FILE = 'docs/pro/js/estimate-builder-v2.js';
const MUTANT = process.env.NBD_EST_MUTANT || '';

// In-memory source mutations (proof the suite can fail). Each returns the
// mutated text and THROWS if the needle is gone, so a mutation can never
// silently no-op (rule: prove the check can fail).
const MUTATIONS = {
  dollars: { file: CFG_FILE, apply: (s) => mustReplace(s, /JOB_MINIMUM_DOLLARS: 2500,/, 'JOB_MINIMUM_DOLLARS: 2400,') },
  // The FIRST `if (totalCents < minJobCents) {` is calculatePerSq's.
  strict: { file: V2_FILE, apply: (s) => mustReplace(s, /if \(totalCents < minJobCents\) \{/, 'if (totalCents <= minJobCents) {') },
};
function mustReplace(src, re, rep) {
  const out = src.replace(re, rep);
  if (out === src) throw new Error('mutation needle not found: ' + re);
  return out;
}

function makeSandbox(extraWin) {
  const byId = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null, checked: false,
      classList: {
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = {
    head: el('head'), body: el('body'), createElement: el,
    getElementById(id) { return byId[id] || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  };
  const win = Object.assign({ localStorage, document }, extraWin || {});
  win.window = win;
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' },
  };
  vm.createContext(sandbox);
  return { win, sandbox, byId, store };
}
function load(env, rel, mutation) {
  let src = read(rel);
  if (mutation && mutation.file === rel) src = mutation.apply(src);
  vm.runInContext(src, env.sandbox, { filename: path.basename(rel) });
}
function stack(files, mutation) {
  const env = makeSandbox();
  files.forEach((f) => load(env, f, mutation));
  return env;
}

const PRICING_FILES = [
  CFG_FILE,
  'docs/pro/js/ky-insurance-law.js',
  'docs/pro/js/deposit-rule.js',
  V2_FILE,
  'docs/pro/js/estimate-logic-engine.js',
];
const FULL_FILES = [
  CFG_FILE,
  'docs/pro/js/ky-insurance-law.js',
  'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js',
  'docs/pro/js/roofivent-catalog.js',
  'docs/pro/js/estimate-labor-catalog.js',
  V2_FILE,
  'docs/pro/js/estimate-catalog-xactimate.js',
  'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js',
  'docs/pro/js/job-templates.js',
  'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/estimate-finalization.js',
  'docs/pro/js/estimate-v2-ui.js',
];

const ACTIVE_MUTATION = MUTANT ? MUTATIONS[MUTANT] : null;
if (MUTANT && !ACTIVE_MUTATION) { console.log('unknown NBD_EST_MUTANT=' + MUTANT); process.exit(2); }
if (MUTANT) console.log('*** RUNNING AGAINST IN-MEMORY MUTANT: ' + MUTANT + ' (files on disk untouched) ***');

const P = stack(PRICING_FILES, ACTIVE_MUTATION);
const EB = P.win.EstimateBuilderV2;
const EL = P.win.EstimateLogic;
const CFG = P.win.NBD_ESTIMATE_CONFIG;
const RULE = P.win.NBDDepositRule;
if (!EB || !EL || !CFG || !RULE) { console.log('FATAL: pricing stack did not load'); process.exit(1); }

const TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
const KY_ADDR = '1944 Kentucky Ave, Fort Thomas, KY 41075';

// Per-SQ input with the geometry pinned (waste 1.0 → sq = rawSqft / 100) and
// insurance mode (tax 0) unless a test says otherwise. Default add-ons on a
// blank county: permit $150 (C-1 fail-safe) + dump $550 + delivery $150 = $850.
function perSq(extra, settings) {
  const input = Object.assign({ tier: 'good', mode: 'insurance', rawSqft: 400, pitch: '6/12', wasteFactorOverride: 1.0 }, extra || {});
  if (settings) input.settingsOverride = Object.assign(EB.getDefaultSettings(), settings);
  return EB.calculatePerSq(input);
}
// 4 SQ Good, insurance, blank county: 4 × $550 = $2,200 + permit $150 = $2,350,
// delivery zeroed, so the dump fee is the knob that lands the subtotal anywhere.
const near2500 = (dump, extra) => perSq(Object.assign({ dumpFeeOverride: dump, matDeliveryOverride: 0 }, extra || {}));

// ════════════════════════════════════════════════════════════════════
section('A. JOB MINIMUM — per-SQ (estimate-builder-v2.js calculatePerSq: tax → round $25 → floor, strict <)');
// ════════════════════════════════════════════════════════════════════
{
  ok('config: JOB_MINIMUM_DOLLARS 2500 / JOB_MINIMUM_CENTS 250000 / ROUND_TO $25', CFG.JOB_MINIMUM_DOLLARS === 2500 && CFG.JOB_MINIMUM_CENTS === 250000 && CFG.ROUND_TO_DOLLARS === 25);

  // $2,200 + $150 + $150 = $2,500.00 exactly → not below the floor.
  let r = near2500(150);
  ok('subtotal exactly $2,500.00 → $2,500, minJobApplied false (the floor is strict <)', r.subtotal === 2500 && r.total === 2500 && r.minJobApplied === false, j([r.subtotal, r.total, r.minJobApplied]));
  r = near2500(149.99);
  ok('$2,499.99 → rounds to $2,500 BEFORE the floor, so minJobApplied stays false', r.subtotal === 2499.99 && r.total === 2500 && r.minJobApplied === false, j([r.subtotal, r.total, r.minJobApplied]));
  r = near2500(150.01);
  ok('$2,500.01 → $2,500 by rounding, never floored', r.subtotal === 2500.01 && r.total === 2500 && r.minJobApplied === false, j([r.total, r.minJobApplied]));
  r = near2500(137.50);
  ok('$2,487.50 → rounds UP to $2,500 (half-up), no floor', r.subtotal === 2487.5 && r.total === 2500 && r.minJobApplied === false, j([r.total, r.minJobApplied]));
  r = near2500(137.49);
  ok('$2,487.49 → rounds DOWN to $2,475 → floored to $2,500, minJobApplied true', r.total === 2500 && r.minJobApplied === true, j([r.total, r.minJobApplied]));
  r = near2500(124.99);
  ok('$2,474.99 → $2,475 → floored to $2,500, minJobApplied true', r.total === 2500 && r.minJobApplied === true, j([r.total, r.minJobApplied]));
  r = near2500(162.50);
  ok('$2,512.50 → rounds up to $2,525, no floor', r.total === 2525 && r.minJobApplied === false, j([r.total, r.minJobApplied]));

  // Tax before the floor. Hamilton: permit $185, tax 7.80%.
  // $2,200 + $185 = $2,385 pre-tax (below $2,500); tax round(238500 × 0.078) = 18603¢
  // → $2,571.03 → $2,575. The floor never sees the pre-tax number.
  const cash = near2500(0, { mode: 'cash', county: 'hamilton-oh' });
  ok('cash: tax counts before the floor — $2,385 + $186.03 tax = $2,571.03 → $2,575, not floored', cash.subtotal === 2385 && cash.tax === 186.03 && cash.total === 2575 && cash.minJobApplied === false, j([cash.subtotal, cash.tax, cash.total, cash.minJobApplied]));
  const ins = near2500(0, { mode: 'insurance', county: 'hamilton-oh' });
  ok('insurance: same job, no tax — $2,385 → $2,375 → floored to $2,500', ins.taxRate === 0 && ins.tax === 0 && ins.total === 2500 && ins.minJobApplied === true, j([ins.tax, ins.total, ins.minJobApplied]));

  // The size where Economy floors but Beyond does not: 3 SQ + $850 add-ons.
  //   economy 3×440=1320+850=2170 → 2175 → FLOORED 2500
  //   good    3×550=1650+850=2500 → exactly 2500, not floored
  //   better  1980+850=2830 → 2825 · best 2310+850=3160 → 3150 · beyond 2640+850=3490 → 3500
  const all = EB.calculateAllTiers({ mode: 'insurance', rawSqft: 300, pitch: '6/12', wasteFactorOverride: 1.0 });
  const want = { economy: [2500, true], good: [2500, false], better: [2825, false], best: [3150, false], beyond: [3500, false] };
  TIERS.forEach((t) => {
    ok('3 SQ ' + t + ' → $' + want[t][0] + (want[t][1] ? ' (floored)' : ' (no floor)'), all[t].total === want[t][0] && all[t].minJobApplied === want[t][1], j([all[t].subtotal, all[t].total, all[t].minJobApplied]));
  });

  // minJobCharge edge values (settings, the same shape loadSettings returns).
  // 3 SQ Economy: $2,170 → $2,175 before any floor.
  const eco = (min) => perSq({ tier: 'economy', rawSqft: 300 }, { minJobCharge: min });
  ok('minJobCharge 3000 → $3,000, minJobApplied true', eco(3000).total === 3000 && eco(3000).minJobApplied === true);
  ok('minJobCharge 2510 (not a $25 multiple) → $2,510 exactly — the floor itself is never rounded', eco(2510).total === 2510);
  ok('minJobCharge 2000 (below the job) → $2,175, no floor', eco(2000).total === 2175 && eco(2000).minJobApplied === false);
  ok('minJobCharge -100 → no floor ($2,175) — a negative minimum disables it (behaviour pinned)', eco(-100).total === 2175 && eco(-100).minJobApplied === false, j(eco(-100).total));
  ok("minJobCharge '' (blank field) → falls back to the $2,500 default", eco('').total === 2500 && eco('').minJobApplied === true);
  ok('minJobCharge NaN → falls back to the $2,500 default', eco(NaN).total === 2500);
  ok("minJobCharge 'abc' → falls back to the $2,500 default", eco('abc').total === 2500);
  const zero = eco(0);
  ok('KNOWN BUG #1 (reported 2026-10-05): a $0 per-SQ minimum (`_toCents(0) || DEFAULT`, estimate-builder-v2.js:1038) floors the job to $2,500 — expected no floor, $2,175',
    zero.total === 2500 && zero.minJobApplied === true, j([zero.total, zero.minJobApplied]));
  // Same bug through the real device path: Settings → Estimates saves minJobCharge 0 to localStorage.
  {
    const E = stack(PRICING_FILES, ACTIVE_MUTATION);
    E.store.nbd_est_settings_v3 = JSON.stringify({ minJobCharge: 0 });
    const viaSaved = E.win.EstimateBuilderV2.calculatePerSq({ tier: 'economy', mode: 'insurance', rawSqft: 300, pitch: '6/12', wasteFactorOverride: 1.0 });
    ok('KNOWN BUG #1 (reported 2026-10-05): a device that SAVED minJobCharge 0 still floors to $2,500 — expected no floor, $2,175',
      viaSaved.total === 2500 && viaSaved.minJobApplied === true, j(viaSaved.total));
  }
}

// ════════════════════════════════════════════════════════════════════
section('B. JOB MINIMUM — line-item path (calculateLineItem) and the logic engine (resolveEstimate)');
// ════════════════════════════════════════════════════════════════════
{
  // calculateLineItem: one synthetic labor line, defaults markup 25% / O 10% / P 10%.
  // $500 labor → retail $500 → +$50 +$50 = $600 subtotal (insurance, no tax).
  const li = (labor, settings) => EB.calculateLineItem({
    mode: 'insurance', tier: 'better', rawSqft: 0,
    lineItems: [{ code: 'TST LAB', name: 'Synthetic labor', unit: 'JOB', qty: 1, materialCost: 0, laborCost: labor }],
    settingsOverride: settings ? Object.assign(EB.getDefaultSettings(), settings) : undefined,
  });
  let r = li(500, { minJobCharge: 600 });
  ok('calculateLineItem: $600 job, floor $600 (equal) → $600, minJobApplied false', r.subtotal === 600 && r.total === 600 && r.minJobApplied === false, j([r.subtotal, r.total, r.minJobApplied]));
  r = li(500, { minJobCharge: 500 });
  ok('calculateLineItem: floor $500 (below) → $600, minJobApplied false', r.total === 600 && r.minJobApplied === false);
  r = li(500, { minJobCharge: 700 });
  ok('calculateLineItem: floor $700 (above) → $700, minJobApplied true', r.total === 700 && r.minJobApplied === true);
  // $489.58 → 48958¢ + 2 × round(4895.8)=4896 → 58750¢ = $587.50 → rounds UP to $600.
  r = li(489.58, { minJobCharge: 600 });
  ok('calculateLineItem: $587.50 rounds up to $600 → meets a $600 floor, minJobApplied false', r.subtotal === 587.5 && r.total === 600 && r.minJobApplied === false, j([r.subtotal, r.total, r.minJobApplied]));
  // $489.57 → 48957 + 9792 = 58749¢ = $587.49 → $575 → floored to $600.
  r = li(489.57, { minJobCharge: 600 });
  ok('calculateLineItem: $587.49 rounds down to $575 → floored to $600, minJobApplied true', r.subtotal === 587.49 && r.total === 600 && r.minJobApplied === true, j([r.subtotal, r.total, r.minJobApplied]));
  // Material markup: 2 × ($100 mat + $50 lab) → mat retail 2×125=250 + lab 100 = 350
  // → +35 +35 = 420 → $425.
  r = EB.calculateLineItem({ mode: 'insurance', rawSqft: 0, settingsOverride: Object.assign(EB.getDefaultSettings(), { minJobCharge: 1 }),
    lineItems: [{ code: 'TST MIX', name: 'Synthetic mixed line', unit: 'EA', qty: 2, materialCost: 100, laborCost: 50 }] });
  ok('calculateLineItem: material ×1.25 + labor, then O&P 10%+10% — $350 → $420 → $425', r.retailBeforeOHP === 350 && r.subtotal === 420 && r.total === 425, j([r.retailBeforeOHP, r.subtotal, r.total]));

  const repair = li(500);
  ok('KNOWN BUG #2 (reported 2026-10-05): calculateLineItem floors a $600 repair to $2,500 — it reads the per-SQ minJobCharge and ignores minRepairCharge 0 (#1470); latent, no live caller today — expected $600',
    EB.getDefaultSettings().minRepairCharge === 0 && repair.total === 2500 && repair.minJobApplied === true, j([repair.total, repair.minJobApplied]));
  const zero = li(500, { minJobCharge: 0 });
  ok('KNOWN BUG #1 (reported 2026-10-05): calculateLineItem with minJobCharge 0 (estimate-builder-v2.js:1320) still floors to $2,500 — expected $600',
    zero.total === 2500 && zero.minJobApplied === true, j(zero.total));

  // Logic engine (estimate-logic-engine.js resolveEstimate). Floats, O&P zeroed
  // where the test is about the floor so the subtotal is the labor itself.
  const LINE = (labor) => [{ code: 'TST LAB', name: 'Synthetic labor', unit: 'JOB', materialCost: 0, laborCost: labor }];
  const res = (labor, extra) => EL.resolveEstimate(LINE(labor), { rawSqft: 0 }, Object.assign({ mode: 'insurance', overheadPct: 0, profitPct: 0 }, extra || {}));
  let e = res(600);
  ok('resolveEstimate: NO floor by default — $600 stays $600, minJobCharge 0', e.total === 600 && e.minJobApplied === false && e.minJobCharge === 0, j([e.total, e.minJobCharge]));
  e = res(200);
  ok('resolveEstimate: a $200 job stays $200 by default (the #1470 opt-in rule)', e.total === 200 && e.minJobApplied === false);
  e = res(600, { minJobCharge: 600 });
  ok('resolveEstimate: floor equal to the total → $600, minJobApplied false', e.total === 600 && e.minJobApplied === false);
  e = res(600, { minJobCharge: 599 });
  ok('resolveEstimate: floor below the total → $600, minJobApplied false', e.total === 600 && e.minJobApplied === false);
  e = res(600, { minJobCharge: 700 });
  ok('resolveEstimate: floor above → $700, minJobApplied true, minJobCharge 700', e.total === 700 && e.minJobApplied === true && e.minJobCharge === 700);
  e = res(587.5, { minJobCharge: 600 });
  ok('resolveEstimate: $587.50 rounds up to $600 → not floored', e.total === 600 && e.minJobApplied === false, j([e.total, e.minJobApplied]));
  e = res(587.49, { minJobCharge: 600 });
  ok('resolveEstimate: $587.49 rounds down to $575 → floored to $600', e.total === 600 && e.minJobApplied === true, j([e.total, e.minJobApplied]));
  // O&P defaults + retail: 2 × ($100 × 1.25 + $50) = $350 → ×1.20 = $420 → $425.
  e = EL.resolveEstimate([{ code: 'TST MIX', name: 'Synthetic mixed', unit: 'EA', materialCost: 100, laborCost: 50, qtyOverride: 2 }], { rawSqft: 0 }, { mode: 'insurance' });
  ok('resolveEstimate: retail = material × 1.25 + labor; overhead 10% + profit 10% — $350 → $420 → $425', e.retailBeforeOHP === 350 && Math.abs(e.subtotal - 420) < 1e-9 && e.total === 425, j([e.retailBeforeOHP, e.subtotal, e.total]));
  // fixedRetail: the $150 line backs out of O&P so it foots to exactly $150.
  e = EL.resolveEstimate([{ code: 'TST FIX', name: 'Synthetic fixed', unit: 'JOB', materialCost: 40, laborCost: 0, fixedRetail: 150 }], { rawSqft: 0 }, { mode: 'insurance' });
  ok('resolveEstimate: fixedRetail $150 → row $125 (150 / 1.2), subtotal exactly $150, cost still $40', Math.abs(e.lines[0].retailTotal - 125) < 1e-9 && Math.abs(e.subtotal - 150) < 1e-9 && e.total === 150 && e.materialCost === 40, j([e.lines[0].retailTotal, e.subtotal]));
  // Quantity: formula / override / unit default.
  e = EL.resolveEstimate([
    { code: 'TST SQ', name: 'Per square', unit: 'SQ', qtyFormula: 'sq', materialCost: 0, laborCost: 1 },
    { code: 'TST OV', name: 'Overridden', unit: 'SQ', qtyFormula: 'sq', _qtyOverride: 3, materialCost: 0, laborCost: 1 },
    { code: 'TST JOB', name: 'Per job', unit: 'JOB', materialCost: 0, laborCost: 1 },
    { code: 'TST BAD', name: 'Bad override', unit: 'SQ', qtyFormula: 'sq', _qtyOverride: 'abc', materialCost: 0, laborCost: 1 },
  ], { rawSqft: 1000, waste: 1 }, { mode: 'insurance' });
  ok('resolveEstimate qty: formula sq (1000 sf, waste 1) = 10; override 3 wins; JOB defaults to 1; a garbage override falls back to the formula',
    j(e.lines.map((l) => l.quantity)) === '[10,3,1,10]', j(e.lines.map((l) => l.quantity)));
  // Cash tax on the engine path: blank county → 7% fallback. $600 + $42 = $642 → $650.
  e = res(600, { mode: 'cash', county: '' });
  ok('resolveEstimate: cash, blank county → 7% fallback, $600 + $42 = $642 → $650', Math.abs(e.taxRate - 0.07) < 1e-12 && e.total === 650, j([e.taxRate, e.total]));
  e = res(600, { mode: 'insurance', county: 'hamilton-oh' });
  ok('resolveEstimate: insurance → tax 0 whatever the county', e.taxRate === 0 && e.total === 600);

  // KNOWN BUG #7 — buildContext: `pitch: Number(input.pitch) || 8` turns a flat
  // roof (pitch 0) into 8/12, and 'LAB ADR-SS' is `pitch >= 8 ? sq : 0`.
  const ADR = [{ code: 'LAB ADR-SS', name: 'Steep adder (synthetic cost)', unit: 'SQ', materialCost: 0, laborCost: 10 }];
  const flat = EL.resolveEstimate(ADR, { rawSqft: 1000, waste: 1, pitch: 0 }, { mode: 'insurance', overheadPct: 0, profitPct: 0 });
  const six = EL.resolveEstimate(ADR, { rawSqft: 1000, waste: 1, pitch: 6 }, { mode: 'insurance', overheadPct: 0, profitPct: 0 });
  ok('control: at 6/12 the steep adder line has qty 0', six.lines[0].quantity === 0);
  ok('KNOWN BUG #7 (reported 2026-10-05): a flat roof (pitch 0) becomes pitch 8 in buildContext (estimate-logic-engine.js:86) and gets the steep labor adder (LAB ADR-SS qty 10 SQ) — expected qty 0',
    flat.context.pitch === 8 && flat.lines[0].quantity === 10, j([flat.context.pitch, flat.lines[0].quantity]));
}

// ════════════════════════════════════════════════════════════════════
section('C. TIER PRICING — rates, waste, cut-up, pitch / story / access adders, layers, boots');
// ════════════════════════════════════════════════════════════════════
{
  const RATES = { economy: 440, good: 550, better: 660, best: 770, beyond: 880 };
  TIERS.forEach((t) => {
    const r = perSq({ tier: t, rawSqft: 1000 });
    ok(t + ': $' + RATES[t] + '/SQ — 10 SQ base = $' + (RATES[t] * 10), r.rate === RATES[t] && r.baseTotal === RATES[t] * 10, j([r.rate, r.baseTotal]));
  });
  ok('no tier given → prices as Better ($660)', EB.calculatePerSq({ mode: 'insurance', rawSqft: 1000, wasteFactorOverride: 1.0 }).rate === 660);

  // Waste by pitch ratio: ≤0.33 1.12 · ≤0.50 1.15 · ≤0.75 1.17 · ≤1.0 1.20 · else 1.25
  const W = EB.wasteFactorForPitch;
  const pts = [[0, 1.12], [0.33, 1.12], [0.3301, 1.15], [0.5, 1.15], [0.5001, 1.17], [0.75, 1.17], [0.7501, 1.20], [1.0, 1.20], [1.0001, 1.25], [2, 1.25]];
  pts.forEach(([ratio, w]) => ok('waste: ratio ' + ratio + ' → ' + w, W(ratio) === w, W(ratio)));
  const viaStr = [['3/12', 1.12], ['4/12', 1.15], ['6/12', 1.15], ['7/12', 1.17], ['9/12', 1.17], ['10/12', 1.20], ['12/12', 1.20], ['13/12', 1.25]];
  viaStr.forEach(([p, w]) => {
    const g = EB.prepGeometry({ rawSqft: 1000, pitch: p });
    ok('waste via pitch "' + p + '" → ' + w + (p === '4/12' ? ' (4/12 = 0.333… is just PAST the 0.33 breakpoint)' : ''), g.waste === w, g.waste);
  });
  const cut = EB.prepGeometry({ rawSqft: 1000, pitch: '6/12', cutUpRoof: true });
  ok('cut-up adds +0.03 waste: 6/12 1.15 → 1.18 (sq 11.8 on 1000 sf)', Math.abs(cut.waste - 1.18) < 1e-12 && Math.abs(cut.sq - 11.8) < 1e-9, j([cut.waste, cut.sq]));
  const cutOv = EB.prepGeometry({ rawSqft: 1000, pitch: '6/12', cutUpRoof: true, wasteFactorOverride: 1.10 });
  ok('cut-up +0.03 also rides on top of a waste override (1.10 → 1.13)', Math.abs(cutOv.waste - 1.13) < 1e-12, cutOv.waste);
  const cutR = perSq({ tier: 'better', rawSqft: 1000, pitch: '6/12', wasteFactorOverride: undefined, cutUpRoof: true });
  ok('cut-up labor $15/SQ on the cut-up squares: 11.8 SQ → $177', cutR.addOns.cutUpLabor === 177, cutR.addOns.cutUpLabor);

  // Pitch adders on 20 SQ (waste pinned 1.0): ≥8/12 $25, ≥12/12 +$45, ≥16/12 +$75 — they STACK.
  const pa = (pitch) => { const r = perSq({ tier: 'better', rawSqft: 2000, pitch }); return [r.addOns.steep, r.addOns.verySteep, r.addOns.extremeSteep]; };
  const PA = [['7.99/12', [0, 0, 0]], ['8/12', [500, 0, 0]], ['11.99/12', [500, 0, 0]], ['12/12', [500, 900, 0]], ['15.99/12', [500, 900, 0]], ['16/12', [500, 900, 1500]]];
  PA.forEach(([p, w]) => ok('pitch adders at ' + p + ' → steep/very/extreme $' + w.join('/$') + ' (20 SQ)', j(pa(p)) === j(w), j(pa(p))));

  // Stories: 2 → $15/SQ; 3+ → $30/SQ (REPLACES the 2-story rate). Access: moderate $15, difficult $35 (replace).
  const st = (n) => perSq({ tier: 'better', rawSqft: 2000, stories: n }).addOns.story;
  ok('stories 1 → $0 · 2 → $300 · 3 → $600 (not $900) · 4 → $600', st(1) === 0 && st(2) === 300 && st(3) === 600 && st(4) === 600, j([st(1), st(2), st(3), st(4)]));
  const ac = (lvl) => perSq({ tier: 'better', rawSqft: 2000, accessLevel: lvl }).addOns.access;
  ok('access standard $0 · moderate $300 · difficult $700 (one tier, not both)', ac('standard') === 0 && ac('moderate') === 300 && ac('difficult') === 700, j([ac('standard'), ac('moderate'), ac('difficult')]));
  const both = perSq({ tier: 'better', rawSqft: 2000, stories: 3, accessLevel: 'difficult' });
  ok('3-story + difficult access stack with each other: $600 + $700', both.addOns.story === 600 && both.addOns.access === 700);

  // Tear-off layers on 20 SQ: (layers − 1) × 20 × $50.
  const lay = (n) => perSq({ tier: 'better', rawSqft: 2000, tearOffLayers: n }).addOns.tearOffExtra;
  ok('tear-off layers 1 → $0 · 2 → $1,000 · 3 → $2,000 · 0/blank → treated as 1', lay(1) === 0 && lay(2) === 1000 && lay(3) === 2000 && lay(0) === 0 && lay(undefined) === 0, j([lay(1), lay(2), lay(3), lay(0)]));
  // Pipe boots: first 4 free, $85 each beyond.
  const pb = (n) => perSq({ tier: 'better', rawSqft: 2000, pipes: n }).addOns.extraPipeBoots;
  ok('pipe boots 4 → $0 · 5 → $85 · 6 → $170', pb(4) === 0 && pb(5) === 85 && pb(6) === 170, j([pb(4), pb(5), pb(6)]));
  // Fixed per-job add-ons.
  const fx = perSq({ tier: 'better', rawSqft: 2000 });
  ok('per-job add-ons: blank county permit $150 · dump $550 · delivery $150 (never × SQ)', fx.addOns.permit === 150 && fx.addOns.dumpFee === 550 && fx.addOns.matDelivery === 150);
  ok('known county permit: Hamilton $185', perSq({ county: 'hamilton-oh' }).addOns.permit === 185);

  // KNOWN BUG #8 — parsePitch("8") is read as a RATIO of 8 (8:1), not 8/12.
  const bare = perSq({ tier: 'better', rawSqft: 2000, pitch: '8', wasteFactorOverride: undefined });
  ok('KNOWN BUG #8 (reported 2026-10-05): parsePitch("8") returns ratio 8 (estimate-builder-v2.js:491) → waste 1.25 + all three steep adders; latent, the UI always sends "<rise>/12" — expected ratio 0.667 (8/12)',
    EB.parsePitch('8') === 8 && bare.waste === 1.25 && bare.addOns.extremeSteep > 0, j([EB.parsePitch('8'), bare.waste, bare.addOns.extremeSteep]));
  ok('control: parsePitch("8/12") = 0.667 and the number 8 is (by contract) a ratio', Math.abs(EB.parsePitch('8/12') - 8 / 12) < 1e-12 && EB.parsePitch(8) === 8);
}

// ════════════════════════════════════════════════════════════════════
section('D. FIVE TIERS — same inputs, only the rate differs; line-item column mapping');
// ════════════════════════════════════════════════════════════════════
{
  // 20 SQ, 8/12, cash, Hamilton. Add-ons: permit 185 + dump 550 + delivery 150 + steep 20×25 = $1,385.
  //   economy  8800+1385=10185 → tax 794.43 → 10979.43 → $10,975
  //   good    11000+1385=12385 → tax 966.03 → 13351.03 → $13,350
  //   better  13200+1385=14585 → tax 1137.63 → 15722.63 → $15,725
  //   best    15400+1385=16785 → tax 1309.23 → 18094.23 → $18,100
  //   beyond  17600+1385=18985 → tax 1480.83 → 20465.83 → $20,475
  const all = EB.calculateAllTiers({ mode: 'cash', county: 'hamilton-oh', rawSqft: 2000, pitch: '8/12', wasteFactorOverride: 1.0 });
  const WANT = { economy: [10185, 794.43, 10975], good: [12385, 966.03, 13350], better: [14585, 1137.63, 15725], best: [16785, 1309.23, 18100], beyond: [18985, 1480.83, 20475] };
  ok('calculateAllTiers returns exactly the five tiers, in TIER_ORDER', j(Object.keys(all)) === j(TIERS) && j(CFG.TIER_ORDER) === j(TIERS));
  TIERS.forEach((t) => ok(t + ': subtotal $' + WANT[t][0] + ' + tax $' + WANT[t][1] + ' → $' + WANT[t][2],
    all[t].subtotal === WANT[t][0] && all[t].tax === WANT[t][1] && all[t].total === WANT[t][2], j([all[t].subtotal, all[t].tax, all[t].total])));
  ok('totals climb economy ≤ good ≤ better ≤ best ≤ beyond', TIERS.every((t, i) => i === 0 || all[TIERS[i - 1]].total <= all[t].total));
  ok('every tier carries the SAME add-ons and tax rate (only the rate differs)',
    TIERS.every((t) => j(all[t].addOns) === j(all.economy.addOns) && all[t].taxRate === all.economy.taxRate && all[t].sq === all.economy.sq));
  ok('subtotal gaps = 20 SQ × rate gap ($2,200 per $110 step)', TIERS.every((t) => all[t].subtotal - all.economy.subtotal === 20 * (all[t].rate - 440)));
  ok('each tier\'s result is the same as pricing that tier alone', TIERS.every((t) => j(all[t]) === j(EB.calculatePerSq({ tier: t, mode: 'cash', county: 'hamilton-oh', rawSqft: 2000, pitch: '8/12', wasteFactorOverride: 1.0 }))));

  // Catalog column mapping: economy → Good column, beyond → Best (config + both engines).
  ok('config productTier: economy→good, good→good, better→better, best→best, beyond→best, unknown→better',
    j(TIERS.map(CFG.productTier)) === j(['good', 'good', 'better', 'best', 'best']) && CFG.productTier('platinum') === 'better');
  const M = EB.TIER_MATERIAL_MAP;
  ok('V2 line-item map: economy uses the Good underlayment/ridge/vent/boot/nails', ['underlayment', 'ridgeCap', 'ridgeVent', 'pipeBoot', 'nails'].every((k) => M.economy[k] === M.good[k]));
  ok('V2 line-item map: beyond uses the Best underlayment/ridge/vent/boot/nails', ['underlayment', 'ridgeCap', 'ridgeVent', 'pipeBoot', 'nails'].every((k) => M.beyond[k] === M.best[k]));
  const shingle = (t) => EB.generateLineItemsFromMeasurements({ tier: t, rawSqft: 1000, wasteFactorOverride: 1.0 }).find((i) => i.category === 'shingles' || /Shingle|HailGuard/.test(i.name));
  const sE = shingle('economy'), sG = shingle('good'), sB = shingle('best'), sY = shingle('beyond');
  ok('line-item economy shingle prices off the Good starter figures, beyond off Best', !!(sE && sG && sB && sY)
    && sE.materialCost === sG.materialCost && sE.laborCost === sG.laborCost && sY.materialCost === sB.materialCost && sY.laborCost === sB.laborCost,
    j([sE && sE.name, sY && sY.name]));
  // Logic engine resolveMaterial with a synthetic product carrying only good/better/best columns.
  P.win.NBD_PRODUCTS = [{ id: 'tst-prod', name: 'Synthetic product', unit: 'SQ', pricing: { good: { cost: 10, sell: 20 }, better: { cost: 11, sell: 22 }, best: { cost: 12, sell: 24 } } }];
  const sell = (t) => EL.resolveMaterial('tst-prod', t).sell;
  ok('resolveMaterial: economy reads the Good column, beyond reads Best (never $0)', sell('economy') === 20 && sell('good') === 20 && sell('better') === 22 && sell('best') === 24 && sell('beyond') === 24, j(TIERS.map(sell)));
  const tierTotal = (t) => EL.resolveEstimate([{ code: 'TST MAT', name: 'Synthetic material', unit: 'SQ', materialId: 'tst-prod', laborCost: 0, qtyOverride: 10 }], { rawSqft: 0 }, { tier: t, mode: 'insurance' }).materialCost;
  ok('resolveEstimate material cost by tier: economy = good ($100), beyond = best ($120)', tierTotal('economy') === 100 && tierTotal('good') === 100 && tierTotal('beyond') === 120 && tierTotal('best') === 120, j(TIERS.map(tierTotal)));
  delete P.win.NBD_PRODUCTS;
}

// ════════════════════════════════════════════════════════════════════
section('E. JOB TEMPLATES — resolveSelection (job-templates.js)');
// ════════════════════════════════════════════════════════════════════
const FULL = stack(FULL_FILES, ACTIVE_MUTATION);
{
  const W = FULL.win;
  const JT = W.JobTemplates;
  ok('job-templates.js + the real catalog loaded', !!(JT && W.NBD_XACT_CATALOG && W.EstimateLogic));
  // Synthetic templates. Custom items carry legacy embedded costs (the
  // customLineItem legacy branch) so each prices at exactly its labor.
  const custom = (name, labor, qty) => ({ custom: { name, unit: 'EA', qty: qty || 1, category: 'roofing', materialCost: 0, laborCost: labor } });
  W.NBD_JOB_TEMPLATES = [
    { id: 'tst_a', name: 'A', category: 'roof_repair', jobType: 'repair', warrantyKind: 'repair', minJobCharge: 400, items: [custom('A work', 100)] },
    { id: 'tst_b', name: 'B', category: 'roof_repair', jobType: 'repair', warrantyKind: 'repair', minJobCharge: 900, items: [custom('B work', 100)] },
    { id: 'tst_c', name: 'C', category: 'roof_repair', jobType: 'repair', warrantyKind: 'repair', minJobCharge: 'abc', items: [custom('C work', 100)] },
    { id: 'tst_d', name: 'D', category: 'roof_repair', jobType: 'repair', warrantyKind: 'repair', items: [{ code: 'DSP HAUL', qty: 1 }] },
    { id: 'tst_e', name: 'E', category: 'roof_repair', jobType: 'repair', warrantyKind: 'repair', items: [{ code: 'DSP HAUL', qty: 3 }] },
    { id: 'tst_t', name: 'T', category: 'roof_replacement', jobType: 'install', warrantyKind: 'roof', tierPriced: true, items: [custom('T work', 100)] },
  ];
  const rs = (ids, opts) => JT.resolveSelection(ids.map((x) => (typeof x === 'string' ? { templateId: x } : x)), Object.assign({ jobMode: 'insurance' }, opts || {}));

  // A + B: $100 + $100 = $200 → O&P ×1.2 = $240 → $250 → floor = the HIGHER minimum, $900.
  let r = rs(['tst_a', 'tst_b']);
  ok('A ($400 floor) + B ($900 floor): the highest minimum wins — $240 → $250 → $900', r.minJobCharge === 900 && r.totals.minJobCharge === 900 && r.totals.total === 900 && r.totals.minJobApplied === true, j([r.minJobCharge, r.totals.total]));
  r = rs(['tst_b', 'tst_a']);
  ok('…in either selection order', r.minJobCharge === 900 && r.totals.total === 900);
  r = rs(['tst_a']);
  ok('A alone: $120 → $125 → floored to its $400', r.totals.total === 400 && r.totals.minJobApplied === true, j(r.totals.total));
  r = rs(['tst_d']);
  ok('a template with no minimum → no floor at all (minJobCharge null, engine 0)', r.minJobCharge === null && r.totals.minJobCharge === 0 && r.totals.minJobApplied === false, j([r.minJobCharge, r.totals.minJobCharge]));

  // Once-per-job codes: one line, the highest qty, either order.
  const haul = (res) => res.lines.filter((l) => l.code === 'DSP HAUL');
  const de = haul(rs(['tst_d', 'tst_e'])), ed = haul(rs(['tst_e', 'tst_d']));
  ok('DSP HAUL qty 1 + qty 3 → ONE line at qty 3 (either order)', de.length === 1 && de[0].quantity === 3 && ed.length === 1 && ed[0].quantity === 3, j([de.map((l) => l.quantity), ed.map((l) => l.quantity)]));

  // Unit-price override = customer retail per unit, booked as labor.
  r = rs([{ templateId: 'tst_a', itemChoices: { 0: { unitPriceOverride: 123, qty: 2 } } }]);
  const ln = r.lines[0];
  ok('unit-price override $123 × 2 → material $0, labor $123, retail $246, "Priced manually" warning',
    ln.materialCostPerUnit === 0 && ln.laborCostPerUnit === 123 && ln.retailPerUnit === 123 && ln.retailTotal === 246 && r.warnings.some((w) => /^Priced manually: A work/.test(w)),
    j([ln.materialCostPerUnit, ln.laborCostPerUnit, ln.retailTotal, r.warnings]));

  // tierPriced vs 'better'.
  r = rs(['tst_a'], { tier: 'best' });
  ok('not tierPriced: the opts tier is ignored, resolves at "better"', r.tierApplies === false && r.totals.tier === 'better', j([r.tierApplies, r.totals.tier]));
  r = rs(['tst_t'], { tier: 'best' });
  ok('tierPriced: the opts tier is honoured ("best")', r.tierApplies === true && r.totals.tier === 'best', j([r.tierApplies, r.totals.tier]));
  r = rs(['tst_t', 'tst_a'], { tier: 'economy' });
  ok('one tierPriced template in the selection makes the tier apply', r.tierApplies === true && r.totals.tier === 'economy');

  // KNOWN BUG #9 — Math.max(400, Number('abc')) is NaN, and `total < NaN` is false.
  r = rs(['tst_a', 'tst_c']);
  ok('KNOWN BUG #9 (reported 2026-10-05): a non-numeric template minJobCharge ("abc") makes the job floor NaN (job-templates.js:958) and silently drops A\'s valid $400 floor — $250 quoted; expected $400 (the highest VALID minimum)',
    Number.isNaN(r.minJobCharge) && r.totals.total === 250 && r.totals.minJobApplied === false, j([r.minJobCharge, r.totals.total]));
  r = rs(['tst_c']);
  ok('KNOWN BUG #9 (reported 2026-10-05): a lone "abc" template minimum → NaN floor, $125 quoted with no floor — expected the bad value ignored (or rejected) rather than NaN',
    Number.isNaN(r.minJobCharge) && r.totals.total === 125, j([r.minJobCharge, r.totals.total]));
}

// ════════════════════════════════════════════════════════════════════
section('F. DEPOSIT BOUNDARIES (deposit-rule.js; only cases tests/deposit-rule.test.js does not already pin)');
// ════════════════════════════════════════════════════════════════════
{
  const R = RULE;
  // Cash ≥ $2,000: 50% → nearest $25.
  const d = (total) => R.compute({ total, mode: 'cash' }).depositCents;
  ok('$2,000.01 cash → 50% = $1,000.005 → $1,000', d(2000.01) === 100000, d(2000.01));
  ok('$2,012.50 cash → $1,006.25 → $1,000', d(2012.5) === 100000, d(2012.5));
  ok('$2,025.00 cash → $1,012.50 (a tie) rounds UP to $1,025', d(2025) === 102500, d(2025));
  ok('$2,037.50 cash → $1,018.75 → $1,025', d(2037.5) === 102500, d(2037.5));
  ok('$2,062.50 cash → $1,031.25 → $1,025', d(2062.5) === 102500, d(2062.5));
  // Insurance: the deductible; an override below it is raised to it.
  let p = R.compute({ total: 12000, mode: 'insurance', deductible: 2500, overridePct: 10 });
  ok('insurance override 10% ($1,200) below a $2,500 deductible → raised to $2,500, rep told', p.depositCents === 250000 && /raised/.test(p.repNote), j([p.depositCents, p.repNote]));
  p = R.compute({ total: 12000, mode: 'insurance', deductible: 2500, overridePct: 30 });
  ok('insurance override 30% ($3,600) above the deductible → $3,600 (override honoured)', p.depositCents === 360000 && p.kind === 'override', j([p.depositCents, p.kind]));
  p = R.compute({ total: 2500, mode: 'insurance', deductible: 2500 });
  ok('deductible EQUAL to the total → the full $2,500 at signing', p.depositCents === 250000 && p.balanceCents === 0);
  p = R.compute({ total: 2500, mode: 'insurance', deductible: 2499.99 });
  ok('deductible 1¢ under the total → $2,499.99 at signing, 1¢ balance', p.depositCents === 249999 && p.balanceCents === 1, j([p.depositCents, p.balanceCents]));
  p = R.compute({ total: 1999.99, mode: 'insurance', deductible: 500, address: KY_ADDR });
  ok('KY insurance below the cash threshold → still $0 at signing', p.depositCents === 0 && p.kyHold === true);
  p = R.compute({ total: 15000, mode: 'insurance', deductible: 2000, overridePct: 50, address: KY_ADDR });
  ok('KY insurance + a 50% PERCENT override → $0, override ignored', p.depositCents === 0 && /override ignored/i.test(p.repNote));
  // The engine adapter (estimate-builder-v2.js calcDeposit) and the engine result.
  ok('V2 calcDeposit: $1,975 cash → no deposit; $2,000 cash → $1,000', EB.calcDeposit(1975, 'cash').amount === 0 && EB.calcDeposit(2000, 'cash').amount === 1000);
  ok('V2 calcDeposit: KY insurance (address passed) → $0', EB.calcDeposit(15000, 'insurance', { deductible: 2000, address: KY_ADDR }).amount === 0);
  // 3 SQ economy cash, blank county: 2170 + 7% (151.90) = 2321.90 → 2325 → floored 2500 → deposit 50% of the FLOORED total.
  const fl = perSq({ tier: 'economy', rawSqft: 300, mode: 'cash' });
  ok('per-SQ: the deposit is 50% of the FLOORED total — $2,500 → $1,250', fl.total === 2500 && fl.minJobApplied === true && fl.deposit === 1250 && fl.depositRemainder === 1250, j([fl.total, fl.deposit]));
  // The functions/ copy is the same module.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  ok('functions/deposit-rule.js is identical to docs/pro/js/deposit-rule.js', norm(read('functions/deposit-rule.js')) === norm(read('docs/pro/js/deposit-rule.js')));
  const FR = require(path.join(ROOT, 'functions', 'deposit-rule.js'));
  ok('functions copy gives the same boundary answers', FR.compute({ total: 1999.99, mode: 'cash' }).depositCents === 0 && FR.compute({ total: 2000, mode: 'cash' }).depositCents === 100000 && FR.compute({ total: 2025, mode: 'cash' }).depositCents === 102500);
}

// ════════════════════════════════════════════════════════════════════
section('G. OLD BUILDER — estimates.js (round THEN floor, like V2; prices all five tiers — bug #6 fixed)');
// ════════════════════════════════════════════════════════════════════
function classicEnv(configMutation) {
  const env = makeSandbox();
  load(env, CFG_FILE, configMutation);
  load(env, 'docs/pro/js/ky-insurance-law.js');
  load(env, 'docs/pro/js/deposit-rule.js');
  load(env, V2_FILE);
  const fields = { estRawSqft: '300', estPitch: '1|flat', estWaste: '1' };
  env.sandbox.document.getElementById = (id) => (id in fields ? { value: fields[id], checked: false } : null);
  env.sandbox.estData = {}; env.sandbox.selectedTier = null; env.sandbox.R = { deckPct: 0.15 };
  load(env, 'docs/pro/js/estimates.js');
  return env;
}
{
  let C = null;
  try { C = classicEnv(); } catch (e) { ok('estimates.js loads in a vm', false, String(e && e.message)); }
  if (C) {
    const S = C.sandbox;
    ok('estimates.js loads in a vm (calcEstimateTotalCents + calcTierPrices are reachable)', typeof S.calcEstimateTotalCents === 'function' && typeof S.calcTierPrices === 'function');
    // 3 SQ economy, $850 add-ons, no tax: 132000 + 85000 = 217000¢ → floor 250000 → round → $2,500.
    ok('classic: 3 SQ Economy $2,170 → floored to $2,500', S.calcEstimateTotalCents(3, 'economy', { totalCents: 85000 }, { taxRate: 0 }) === 250000);
    // Same numbers as V2 for a $25-multiple floor.
    ok('classic: $2,487.49 → floor → $2,500 (V2 gets the same $2,500 by round-then-floor)', S.calcEstimateTotalCents(4, 'good', { totalCents: 28749 }, { taxRate: 0 }) === 250000 && near2500(137.49).total === 2500);
    ok('classic: $2,512.50 → $2,525 (above the floor, plain rounding)', S.calcEstimateTotalCents(4, 'good', { totalCents: 31250 }, { taxRate: 0 }) === 252500);
    // Tax first, then floor, then round: 4 SQ good + $185, 7.8% → $2,571.03 → $2,575.
    ok('classic: tax before the floor — $2,385 + 7.8% → $2,575', S.calcEstimateTotalCents(4, 'good', { totalCents: 18500 }, { taxRate: 0.078 }) === 257500);
    // calcTierPrices on a 3 SQ flat roof (waste 1): good 1650+700=2350 → +7% 164.50 → 2514.50 → $2,525;
    // better 1980+700=2680 → 2867.60 → $2,875; best 2310+700=3010 → 3220.70 → $3,225.
    let prices = null;
    try { S.calcTierPrices(); prices = S.estData.prices; } catch (e) { prices = { __threw: String(e && e.message) }; }
    ok('classic calcTierPrices: good $2,525 · better $2,875 · best $3,225', !!prices && prices.good === 2525 && prices.better === 2875 && prices.best === 3225, j(prices));
    // Economy 1320+700=2020 → +7% 141.40 = 2161.40 → $2,150 → floored $2,500;
    // Beyond 2640+700=3340 → +7% 233.80 = 3573.80 → $3,575.
    ok('FIXED (was KNOWN BUG #6): the old builder prices all five tiers in TIER_ORDER — economy $2,500 (floored) · good $2,525 · better $2,875 · best $3,225 · beyond $3,575',
      !!prices && j(Object.keys(prices)) === j(['economy', 'good', 'better', 'best', 'beyond'])
        && prices.economy === 2500 && prices.good === 2525 && prices.better === 2875 && prices.best === 3225 && prices.beyond === 3575, j(prices));
    // The Step 3 cards: one per tier, labels/rates from estimate-config.js,
    // data-arg = the internal key selectTier() + the saved doc's tier use.
    {
      const R = makeSandbox();
      const kids = [];
      const attrs = {};
      const grid = { textContent: '', appendChild(c) { kids.push(c); return c; }, setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return k in attrs ? attrs[k] : null; } };
      const mk = (tag) => { const a = {}; const ch = []; return { tagName: tag, className: '', textContent: '', id: '', attrs: a, kids: ch, setAttribute(k, v) { a[k] = v; }, appendChild(c) { ch.push(c); return c; } }; };
      R.sandbox.document.createElement = mk;
      R.sandbox.document.getElementById = (id) => (id === 'estTierGrid' ? grid : null);
      R.sandbox.estData = {}; R.sandbox.selectedTier = 'beyond'; R.sandbox.R = { deckPct: 0.15 };
      load(R, CFG_FILE); load(R, 'docs/pro/js/ky-insurance-law.js'); load(R, 'docs/pro/js/deposit-rule.js'); load(R, V2_FILE);
      load(R, 'docs/pro/js/estimates.js');
      const CF = R.win.NBD_ESTIMATE_CONFIG;
      const txt = (card, cls) => ((card.kids.find((k) => k.className.split(' ').indexOf(cls) !== -1) || {}).textContent);
      ok('FIXED (was KNOWN BUG #6): Step 3 renders five tier cards — data-arg economy…beyond, names from TIER_DISPLAY, $rate/SQ from TIER_RATES, a price slot per tier',
        kids.length === 5 && j(kids.map((c) => c.attrs['data-arg'])) === j(CF.TIER_ORDER)
          && kids.every((c) => c.attrs['data-fn'] === 'selectTier' && c.attrs['data-action'] === 'call')
          && kids.every((c, i) => txt(c, 'tier-name') === CF.tierLabel(CF.TIER_ORDER[i]) && txt(c, 'tier-items').indexOf('$' + CF.TIER_RATES[CF.TIER_ORDER[i]] + '/SQ') === 0)
          && kids.every((c, i) => (c.kids.find((k) => k.className === 'tier-price') || {}).id === 'price-' + CF.TIER_ORDER[i]),
        j(kids.map((c) => [c.attrs['data-arg'], txt(c, 'tier-name'), txt(c, 'tier-items')])));
      ok('the saved tier card renders selected (an old 3-tier doc saved as "good" selects the same way)', kids.length === 5 && kids[4].className === 'tier-card selected' && kids[1].className === 'tier-card');
      R.sandbox.calcTierPrices();
      ok('re-pricing does not rebuild the cards (built once per grid)', kids.length === 5);
    }
    // Floor-then-round vs round-then-floor only part ways for a minimum that is
    // not a $25 multiple. In-memory config with a $2,510 minimum:
    //   classic (was): max(217000, 251000) = 251000 → round to $25 → 250000 = $2,500 (below its own minimum)
    //   classic (now) and V2: 2170 → 2175 → floor 2510 → $2,510
    let C2 = null;
    try {
      C2 = classicEnv({ file: CFG_FILE, apply: (s) => mustReplace(mustReplace(s, /JOB_MINIMUM_DOLLARS: 2500,/, 'JOB_MINIMUM_DOLLARS: 2510,'), /JOB_MINIMUM_CENTS: {3}250000,/, 'JOB_MINIMUM_CENTS:   251000,') });
    } catch (e) { ok('classic loads with a $2,510 in-memory minimum', false, String(e && e.message)); }
    if (C2) {
      const classic = C2.sandbox.calcEstimateTotalCents(3, 'economy', { totalCents: 85000 }, { taxRate: 0 });
      const v2 = C2.win.EstimateBuilderV2.calculatePerSq({ tier: 'economy', mode: 'insurance', rawSqft: 300, pitch: '6/12', wasteFactorOverride: 1.0 });
      ok('FIXED (was KNOWN BUG #6): the old builder rounds to $25 THEN floors, like V2 — a $2,510 minimum quotes $2,510 (was $2,500, below its own floor); both engines agree',
        classic === 251000 && v2.total === 2510, j([classic, v2.total]));
    }
  }
}

// ════════════════════════════════════════════════════════════════════
section('H. V2 BUILDER UI — getCurrentEstimate on the real engines (estimate-v2-ui.js)');
// ════════════════════════════════════════════════════════════════════
{
  const W = FULL.win;
  const V2 = W.EstimateV2UI && W.EstimateV2UI._test;
  const FIN = W.EstimateFinalization;
  ok('estimate-v2-ui.js + estimate-finalization.js loaded on the engine stack', !!(V2 && FIN));
  // Per-SQ cash, 100 sf at 6/12 (waste 1.15 → 1.15 SQ), blank county, Better:
  //   1.15 × $660 = $759 + $850 add-ons = $1,609 → +7% $112.63 = $1,721.63 → $1,725 → floored $2,500.
  const priced = (edit) => {
    const st = V2.getState();
    st._reopenedClean = false; st._reopenedDoc = null;
    st.mode = 'per-sq'; st.jobMode = 'cash'; st.tier = 'better'; st.county = '';
    st.measurements = Object.assign({}, st.measurements, { rawSqft: 100, pitch: 6, cutUpRoof: false });
    st.scope = [{ code: 'LAB MOB' }]; st.passThru = []; st.upgrades = []; st.minJobCharge = null;
    if (edit) edit(st);
    return safe(() => V2.effectiveEstimate());
  };
  const est = priced();
  const better = est && est.perSqTiers && est.perSqTiers.better;
  ok('control: the per-SQ overlay set the price (priceMode per-sq) and the Better tier floored $1,725 → $2,500',
    !!better && est.priceMode === 'per-sq' && est.total === 2500 && better.subtotal === 1609 && better.minJobApplied === true, j(est && (est.__threw || [est.priceMode, est.total, better && better.minJobApplied])));
  ok('KNOWN BUG #3 (reported 2026-10-05): a floored per-SQ quote reaches finalization with minJobApplied false / minJobCharge 0 (estimate-v2-ui.js:2779-2796 copies total/tax but not the tier\'s floor flag), so the $775 floor gap prints as "Rounding" — expected minJobApplied true, minJobCharge 2500',
    !!better && est.minJobApplied === false && !est.minJobCharge, j(est && [est.minJobApplied, est.minJobCharge]));
  const iv = safe(() => FIN.formatEstimate(est, 'internal-view', { customer: { name: 'Pat Doe', address: '1 Elm St' }, estimate: { number: 'EST-1', date: '2026-10-05' } }).html);
  ok('KNOWN BUG #3 (reported 2026-10-05): the Internal View footer of that floored per-SQ quote says "Min job applied: No" (estimate-finalization.js:1284) — expected "YES ($2,500.00 floor)"',
    typeof iv === 'string' && /Min job applied:<\/strong> No/.test(iv), typeof iv === 'string' ? (iv.match(/Min job applied:<\/strong>[^·]*/) || [''])[0] : j(iv));

  // KNOWN BUG #5 — the preset/template floor (state.minJobCharge) never reaches the per-SQ engine.
  const patch = priced((st) => { st.minJobCharge = 500; });
  ok('KNOWN BUG #5 (reported 2026-10-05): a preset/template $500 floor is ignored on a per-SQ quote — buildPerSqInput sends no settings override (estimate-v2-ui.js:2423-2446), so it quotes $2,500 — expected $1,725 (the job, above its $500 floor)',
    !!patch && patch.priceMode === 'per-sq' && patch.total === 2500, j(patch && (patch.__threw || patch.total)));

  // #4 is NOT a bug: pass-through fees are charged at face on top of the price
  // by design (estimate-v2-ui.js:2720-2722: a fee added after the floor must
  // never be pulled under it). Pinned as documented behaviour.
  const fee = priced((st) => { st.passThru = [{ code: 'SVC AERIAL', desc: 'Aerial measurement report', amount: 75, source: 'passthru' }]; });
  // Every tier floors at 1.15 SQ (Beyond: 1012 + 850 = 1862 → +7% = 1992.34 → $2,000 → $2,500).
  ok('pass-through $75 rides ON TOP of a floored per-SQ total: $2,500 + $75 = $2,575, on all five tiers (by design, not absorbed by the floor)',
    !!fee && fee.total === 2575 && TIERS.every((t) => fee.prices[t] === 2575), j(fee && (fee.__threw || [fee.total, fee.prices])));
}

// ════════════════════════════════════════════════════════════════════
section('I. DEAL ROOM — accepted tier onto the estimate (functions/deal-accepted-tier.js)');
// ════════════════════════════════════════════════════════════════════
{
  const { planAcceptedTier } = require(path.join(ROOT, 'functions', 'deal-accepted-tier.js'));
  // A cash estimate with no tier chosen: $10,000 total, $5,000 deposit, tax $700.
  const estimate = { userId: 'u1', leadId: 'l1', grandTotal: 10000, subtotal: 9300, tax: 700, taxRate: 0.07527, deposit: 5000, depositPlan: { depositCents: 500000, totalCents: 1000000 } };
  const plan = planAcceptedTier({ lead: { userId: 'u1', primaryEstimateId: 'e1' }, estimate, estimateId: 'e1', leadId: 'l1', ownerUid: 'u1', tier: 'best', price: 15000, dealId: 'd1', now: 'T' });
  ok('control: the homeowner\'s Best $15,000 is applied to the tier-less estimate', plan.reason === 'applied' && plan.estimate.grandTotal === 15000 && plan.estimate.tier === 'best');
  const merged = Object.assign({}, estimate, plan.estimate);
  ok('KNOWN BUG #10 (reported 2026-10-05): planAcceptedTier overwrites grandTotal ($10,000 → $15,000) without recomputing deposit/tax/subtotal (functions/deal-accepted-tier.js:66) — the saved estimate keeps a $5,000 deposit and a $9,300 subtotal; expected deposit $7,500 and subtotal/tax recomputed for $15,000',
    !('deposit' in plan.estimate) && !('subtotal' in plan.estimate) && !('tax' in plan.estimate) && !('depositPlan' in plan.estimate)
      && merged.grandTotal === 15000 && merged.deposit === 5000 && merged.subtotal === 9300, j(Object.keys(plan.estimate)));
}

// ════════════════════════════════════════════════════════════════════
section('M. MUTATION PROOF — floor assertions go RED against mutated in-memory copies');
// ════════════════════════════════════════════════════════════════════
if (!MUTANT) {
  // The same predicates section A asserts, re-run on a mutant stack. Each must
  // FAIL there, or the assertion was vacuous.
  const predicates = (E) => {
    const eb = E.win.EstimateBuilderV2;
    const r = (extra, settings) => {
      const input = Object.assign({ tier: 'good', mode: 'insurance', rawSqft: 400, pitch: '6/12', wasteFactorOverride: 1.0 }, extra || {});
      if (settings) input.settingsOverride = Object.assign(eb.getDefaultSettings(), settings);
      return eb.calculatePerSq(input);
    };
    const exact = r({ dumpFeeOverride: 150, matDeliveryOverride: 0 });
    const eco = eb.calculateAllTiers({ mode: 'insurance', rawSqft: 300, pitch: '6/12', wasteFactorOverride: 1.0 }).economy;
    return {
      exactNotFloored: exact.total === 2500 && exact.minJobApplied === false,
      economyFloorsTo2500: eco.total === 2500 && eco.minJobApplied === true,
    };
  };
  const real = predicates(P);
  ok('unmutated: both floor predicates hold', real.exactNotFloored && real.economyFloorsTo2500, j(real));
  const strict = predicates(stack(PRICING_FILES, MUTATIONS.strict));
  ok('mutant `<` → `<=` in calculatePerSq: "exactly $2,500 is not floored" goes RED', strict.exactNotFloored === false, j(strict));
  const dollars = predicates(stack(PRICING_FILES, MUTATIONS.dollars));
  ok('mutant JOB_MINIMUM_DOLLARS 2500 → 2400: "3 SQ Economy floors to $2,500" goes RED', dollars.economyFloorsTo2500 === false, j(dollars));
  ok('the files on disk were never mutated', /JOB_MINIMUM_DOLLARS: 2500,/.test(read(CFG_FILE)) && /if \(totalCents < minJobCents\) \{/.test(read(V2_FILE)));
} else {
  console.log('  (skipped while running against a mutant)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
