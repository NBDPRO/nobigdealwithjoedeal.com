/**
 * tests/estimate-engine-parity.test.js — classic↔V2 config-drift unification.
 *
 * D-1/D-2/D-4 (Joe-approved 2026-06-09): the deprecated Classic builder now
 * uses the validated V2/config values instead of its legacy ones.
 *
 *   D-2 (waste-from-pitch): Classic's recommendedWasteForPitch delegates to
 *     EstimateBuilderV2.wasteFactorForPitch. Classic passes the slope-area
 *     FACTOR (√(1+(rise/run)²)); V2 keys on the rise/run RATIO. This test proves
 *     the factor→ratio conversion (ratio = √(factor²−1)) maps the standard
 *     pitches onto V2's exact buckets — i.e. Classic now == V2 for every pitch.
 *   D-4 (extra pipe boot): unified at $85 in estimate-config.js
 *     (ADDON_EXTRA_PIPE_BOOT), which Classic now reads instead of its legacy $45.
 *   D-7 (2026-10-05, bug #6): classic per-SQ price === V2 per-SQ price on all
 *     five tiers, including a non-$25 job minimum (round THEN floor).
 *   D-1 (permit): Classic's per-city defaults realigned to each city's COUNTY
 *     V2 value (asserted against the committed estimates.js source text).
 *
 * Run: node tests/estimate-engine-parity.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

function loadV2() {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/estimate-builder-v2.js'), 'utf8');
  // deposit-rule.js rides in the same window, as on dashboard.html (eager,
  // 2026-09-25): V2.calcDeposit is a thin adapter over it.
  const RULE = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/deposit-rule.js'), 'utf8');
  const win = {}; win.window = win;
  const ctx = vm.createContext({ window: win, console: { log() {}, warn() {}, error() {} }, Math, JSON, Object, Number });
  vm.runInContext(RULE, ctx, { filename: 'deposit-rule.js' });
  vm.runInContext(SRC, ctx, { filename: 'estimate-builder-v2.js' });
  return win.EstimateBuilderV2;
}
function loadConfig() {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/estimate-config.js'), 'utf8');
  const win = {}; win.window = win;
  vm.runInNewContext(SRC, { window: win, console: { log() {}, warn() {}, error() {} }, Math, JSON, Object }, { filename: 'estimate-config.js' });
  return win.NBD_ESTIMATE_CONFIG;
}

const V2 = loadV2();
const CFG = loadConfig();

// Replicates Classic's delegated recommendedWasteForPitch (the V2 path).
function classicWaste(pitchFactor) {
  const pf = Number(pitchFactor) || 1;
  const ratio = pf > 1 ? Math.sqrt(pf * pf - 1) : 0;
  return V2.wasteFactorForPitch(ratio);
}

// ════════════════════════════════════════════════════════════════════
// D-2 — classic waste (via delegation) == V2 waste for the standard pitches.
// ════════════════════════════════════════════════════════════════════
console.log('\nENGINE PARITY — D-2 waste-from-pitch (classic delegates to V2)');
// [classic slope factor, rise/run label, expected V2 waste]
const PITCHES = [
  [1.000, 'flat', 1.12],
  [1.054, '4/12', 1.15],
  [1.118, '6/12', 1.15],
  [1.202, '8/12', 1.17],
  [1.302, '10/12', 1.20],
  [1.414, '12/12', 1.20],   // rise/run 1.0 → V2 "≤1.00 → 1.20"; only >12/12 hits 1.25
  [1.474, '14/12', 1.25],
];
for (const [factor, label, expected] of PITCHES) {
  const got = classicWaste(factor);
  ok('D-2 ' + label + ' (factor ' + factor + ') → V2 waste ' + expected, got === expected);
  // And it must equal feeding V2 the rise/run directly (no factor-conversion drift).
  const rr = label === 'flat' ? 0 : (Number(label.split('/')[0]) / 12);
  ok('D-2 ' + label + ': factor-conversion == direct rise/run lookup', got === V2.wasteFactorForPitch(rr));
}

// ════════════════════════════════════════════════════════════════════
// D-4 — extra pipe boot unified at $85 in config.
// ════════════════════════════════════════════════════════════════════
console.log('\nENGINE PARITY — D-4 extra pipe boot + config add-ons');
ok('D-4 config ADDON_EXTRA_PIPE_BOOT === 85', CFG.ADDON_EXTRA_PIPE_BOOT === 85);
ok('config still has chimney 425 / skylight 350 (unchanged)', CFG.ADDON_CHIMNEY_FLASH === 425 && CFG.ADDON_SKYLIGHT_FLASH === 350);
// V2's own add-on price agrees with config (single source of truth).
ok('D-4 V2 extraPipeBoot agrees with config ($85)', !V2.ADDON_PRICES || V2.ADDON_PRICES.extraPipeBoot === 85);

// ════════════════════════════════════════════════════════════════════
// D-1 — classic per-city permit defaults realigned to county V2 values.
// PR 3b: the canonical tables now live in estimate-config.js
// (PERMIT_COSTS_BY_COUNTY + PERMIT_CITY_TO_COUNTY); classic derives its
// city map from them at load. Assert the derivation (config → city cost)
// AND that estimates.js still carries the correct inline fallback for the
// config-didn't-load path.
// ════════════════════════════════════════════════════════════════════
console.log('\nENGINE PARITY — D-1 permit defaults realigned to county values');
const cityCost = (city) => {
  const slug = CFG.PERMIT_CITY_TO_COUNTY && CFG.PERMIT_CITY_TO_COUNTY[city];
  const entry = slug && CFG.PERMIT_COSTS_BY_COUNTY && CFG.PERMIT_COSTS_BY_COUNTY[slug];
  return entry && entry.cost;
};
ok('D-1 Cincinnati → Hamilton county $185', cityCost('Cincinnati') === 185);
ok('D-1 Mason → Warren county $165', cityCost('Mason') === 165);
ok('D-1 Milford → Clermont county $170', cityCost('Milford') === 170);
ok('D-1 Covington → Kenton county $125', cityCost('Covington') === 125);
// V2 reads the same canonical table (drift between engines now impossible
// unless a fallback path is running).
ok('D-1 V2 permit table agrees with config', !V2.PERMIT_COSTS ||
  Object.keys(CFG.PERMIT_COSTS_BY_COUNTY).every(s => V2.PERMIT_COSTS[s] && V2.PERMIT_COSTS[s].cost === CFG.PERMIT_COSTS_BY_COUNTY[s].cost));
// Classic's inline fallback literals must stay correct too — they're what
// prices a job if estimate-config.js ever fails to load.
const ESTSRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/estimates.js'), 'utf8');
const permitBlock = (ESTSRC.match(/const PERMIT_COSTS = [\s\S]*?\};/) || [''])[0];
ok('D-1 fallback Cincinnati $185 present', /Cincinnati:\s*185/.test(permitBlock));
ok('D-1 fallback Covington $125 present', /Covington:\s*125/.test(permitBlock));
ok('D-1 legacy Cincinnati $175 is gone', !/Cincinnati:\s*175/.test(permitBlock));

// ════════════════════════════════════════════════════════════════════
// D-5 — deposit math unified (Rock 2 PR 4 close-out).
// Classic delegates to V2.calcDeposit; the engines had drifted on
// rounding (classic → cents, V2 → the $25 step the spec calls for).
// ════════════════════════════════════════════════════════════════════
console.log('\nENGINE PARITY — D-5 deposit unified via V2.calcDeposit');
const near = (a, b) => Math.abs(a - b) < 0.005;
ok('V2 exposes calcDeposit', typeof V2.calcDeposit === 'function');
{
  // Cash default: 50%, amount rounded to the $25 step.
  const cash = V2.calcDeposit(16375, 'cash', {});
  ok('D-5 cash 50% of $16,375 rounds to $8,200 (not $8,187.50)', cash.pct === 50 && cash.amount === 8200);
  ok('D-5 remainder = total − amount', near(cash.remainder, 16375 - 8200));
  // Insurance (deposit rule, 2026-09-25): the deductible (+ the ACV payment)
  // — $0 only while no deductible is entered, and then the plan says so.
  const ins = V2.calcDeposit(16375, 'insurance', {});
  ok('D-5 insurance with no deductible entered → $0 and a needsDeductible plan', ins.pct === 0 && ins.amount === 0
    && ins.plan && ins.plan.needsDeductible === true);
  const insD = V2.calcDeposit(16375, 'insurance', { deductible: 2500 });
  ok('D-5 insurance with a deductible → the deductible at signing', insD.amount === 2500 && insD.remainder === 13875);
  // Override honored on either mode.
  const ovr = V2.calcDeposit(10000, 'insurance', { overridePct: 25 });
  ok('D-5 override 25% honored on insurance', ovr.pct === 25 && ovr.amount === 2500);
  // Zero/invalid totals never produce a deposit.
  const zero = V2.calcDeposit(0, 'cash', {});
  ok('D-5 zero total → zero deposit', zero.pct === 0 && zero.amount === 0);
  // Classic source delegates (same pattern as D-2's waste delegation).
  // 2026-10-03: the options object is built first so the linked lead can ride
  // along (Kentucky hold); behaviour is pinned in deposit-rule.test.js §13.
  ok('D-5 classic calcDeposit delegates to V2 (with the claim figures + linked lead, 2026-10-03)',
    /const o = \{ overridePct, deductible: c\.deductible, acv: c\.acv \};[\s\S]{0,80}V2\.calcDeposit\(grandTotal, mode, o\)/.test(ESTSRC_D5()));
}
function ESTSRC_D5(){ return fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/estimates.js'), 'utf8'); }

// ════════════════════════════════════════════════════════════════════
// D-6 — V2 cents discipline (2026-08-07). The engine used to do pure
// float money math and PERSIST the dirt (subtotal/tax/deposit like
// 1234.5600000000001 reached stored docs → portal/invoice/Stripe).
// Money now runs in integer cents internally; every returned dollar
// field must be an exact 2-decimal value. These fixtures are chosen to
// produce float dirt on the OLD engine (fractional SQ × per-unit rates,
// 7.05% tax on an odd subtotal) — they FAIL against the float engine.
// ════════════════════════════════════════════════════════════════════
console.log('\nENGINE PARITY — D-6 V2 cents discipline (no float drift persists)');
{
  const exact2dp = (v) => typeof v === 'number' && Number.isFinite(v)
    && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
  const moneyFields = (r) => ['baseTotal', 'addOnsTotal', 'subtotal', 'tax',
    'total', 'deposit', 'depositRemainder'].map((k) => [k, r[k]]);

  // Fractional-SQ cash job in a taxed county: 2437 sqft, 8/12 pitch
  // (waste 1.20 → 29.244 SQ), 2 layers, 6 pipes, valley metal.
  const perSq = V2.calculateEstimate({
    method: 'per-sq', tier: 'better', mode: 'cash',
    sqft: 2437, pitch: '8:12', tearOffLayers: 2, pipes: 6,
    valleyMetalLf: 37, county: 'hamilton-oh', city: 'hamilton-oh',
  });
  for (const [k, v] of moneyFields(perSq)) {
    ok('D-6 per-sq ' + k + ' is exact 2-dp (got ' + v + ')', exact2dp(v));
  }
  for (const [k, v] of Object.entries(perSq.addOns)) {
    ok('D-6 per-sq addOn ' + k + ' is exact 2-dp (got ' + v + ')', exact2dp(v));
  }
  // Identities hold exactly in cents — no epsilon needed.
  ok('D-6 per-sq subtotal === baseTotal + addOnsTotal (exact)',
    Math.round(perSq.subtotal * 100)
      === Math.round(perSq.baseTotal * 100) + Math.round(perSq.addOnsTotal * 100));
  ok('D-6 per-sq deposit + remainder === total (exact)',
    Math.round(perSq.deposit * 100) + Math.round(perSq.depositRemainder * 100)
      === Math.round(perSq.total * 100));

  // Line-item insurance scope with fractional quantities and OH&P.
  const li = V2.calculateEstimate({
    method: 'line-item', tier: 'better', mode: 'cash',
    sqft: 2437, pitch: '8:12', county: 'hamilton-oh',
    overheadPct: 0.10, profitPct: 0.10, materialMarkupPct: 0.35,
    lineItems: [
      { desc: 'Shingles', qty: 29.244, materialCost: 118.37, laborCost: 155.55 },
      { desc: 'Underlayment', qty: 29.244, materialCost: 21.13, laborCost: 0 },
      { desc: 'Drip edge', qty: 187.3, materialCost: 2.85, laborCost: 1.15 },
    ],
  });
  for (const k of ['materialCost', 'materialRetail', 'laborCost', 'hardCost',
    'retailBeforeOHP', 'overhead', 'profit', 'subtotal', 'tax', 'total',
    'deposit', 'depositRemainder']) {
    ok('D-6 line-item ' + k + ' is exact 2-dp (got ' + li[k] + ')', exact2dp(li[k]));
  }
  for (const it of li.items) {
    ok('D-6 line "' + it.desc + '" totals are exact 2-dp',
      exact2dp(it.materialTotal) && exact2dp(it.laborTotal) && exact2dp(it.lineTotal));
  }
  ok('D-6 line-item subtotal === retailBeforeOHP + overhead + profit (exact)',
    Math.round(li.subtotal * 100) === Math.round(li.retailBeforeOHP * 100)
      + Math.round(li.overhead * 100) + Math.round(li.profit * 100));
  ok('D-6 line-item deposit + remainder === total (exact)',
    Math.round(li.deposit * 100) + Math.round(li.depositRemainder * 100)
      === Math.round(li.total * 100));

  // Grand total still lands on the $25 step (customer-facing invariant).
  ok('D-6 per-sq total is a $25 multiple (or exact min-job)',
    perSq.minJobApplied || Math.round(perSq.total * 100) % 2500 === 0);
  ok('D-6 line-item total is a $25 multiple (or exact min-job)',
    li.minJobApplied || Math.round(li.total * 100) % 2500 === 0);
}

// ════════════════════════════════════════════════════════════════════
// D-7 — classic per-SQ price == V2 per-SQ price, all five tiers (bug #6,
// fixed 2026-10-05). The classic builder used to floor THEN round (a
// non-$25 minimum came back under itself) and priced good/better/best only.
// Both engines load from the committed files into one window with the real
// estimate-config.js; the classic engine is fed V2's own SQ, add-ons and tax
// rate, so any difference is the price math itself.
// ════════════════════════════════════════════════════════════════════
console.log('\nENGINE PARITY — D-7 classic vs V2 per-SQ, five tiers');
function loadBoth(minDollars) {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  let cfgSrc = read('docs/pro/js/estimate-config.js');
  if (minDollars) {
    const a = cfgSrc.replace(/JOB_MINIMUM_DOLLARS: 2500,/, 'JOB_MINIMUM_DOLLARS: ' + minDollars + ',')
      .replace(/JOB_MINIMUM_CENTS: {3}250000,/, 'JOB_MINIMUM_CENTS:   ' + (minDollars * 100) + ',');
    if ((a.match(new RegExp(String(minDollars), 'g')) || []).length < 2) throw new Error('D-7 minimum mutation did not apply');
    cfgSrc = a;
  }
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild(c) { return c; } });
  const doc = { getElementById: () => null, createElement: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const win = { document: doc, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } }; win.window = win;
  const ctx = vm.createContext({ window: win, document: doc, localStorage: win.localStorage, console: { log() {}, warn() {}, error() {}, info() {} },
    Math, JSON, Object, Number, Date, setTimeout, clearTimeout, estData: {}, selectedTier: null, R: { deckPct: 0.15 } });
  for (const [rel, src] of [['estimate-config.js', cfgSrc], ['ky-insurance-law.js', read('docs/pro/js/ky-insurance-law.js')],
    ['deposit-rule.js', read('docs/pro/js/deposit-rule.js')], ['estimate-builder-v2.js', read('docs/pro/js/estimate-builder-v2.js')],
    ['estimates.js', read('docs/pro/js/estimates.js')]]) vm.runInContext(src, ctx, { filename: rel });
  return { V2: win.EstimateBuilderV2, classic: ctx.calcEstimateTotalCents, CFG: win.NBD_ESTIMATE_CONFIG };
}
for (const minDollars of [0, 2510]) {
  const E = loadBoth(minDollars);
  const tag = minDollars ? ' ($' + minDollars + ' minimum)' : '';
  ok('D-7 five tiers in TIER_ORDER' + tag, E.CFG.TIER_ORDER.length === 5);
  let cases = 0, floored = 0;
  const diffs = [];
  for (const tier of E.CFG.TIER_ORDER) {
    for (const rawSqft of [180, 300, 450, 1234, 2600]) {
      for (const mode of ['cash', 'insurance']) {
        const v = E.V2.calculatePerSq({ tier, mode, rawSqft, pitch: '6/12' });
        const c = E.classic(v.sq, tier, { totalCents: Math.round(v.addOnsTotal * 100) }, { taxRate: v.taxRate });
        cases++; if (v.minJobApplied) floored++;
        if (c !== Math.round(v.total * 100)) diffs.push([tier, rawSqft, mode, c / 100, v.total]);
      }
    }
  }
  ok('D-7 classic price === V2 price for every tier × size × mode' + tag + ' (diffs: ' + JSON.stringify(diffs.slice(0, 4)) + ')', diffs.length === 0);
  // The grid must reach the floor, or the floor-order half proves nothing.
  ok('D-7 the grid exercises the job minimum' + tag + ' (' + floored + '/' + cases + ' floored)', floored > 0 && floored < cases);
  if (minDollars) {
    const v = E.V2.calculatePerSq({ tier: 'economy', mode: 'insurance', rawSqft: 180, pitch: '6/12' });
    ok('D-7 a floored $2,510 job quotes exactly $2,510 on both engines', v.minJobApplied && v.total === 2510
      && E.classic(v.sq, 'economy', { totalCents: Math.round(v.addOnsTotal * 100) }, { taxRate: v.taxRate }) === 251000);
  }
}

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
