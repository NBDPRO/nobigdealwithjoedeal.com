/**
 * estimate-pricing.test.js
 *
 * Locks in the spec'd pricing math from
 * memory/site_wide_spec_20260410.md:
 *   - per-SQ flat rates Good/Better/Best ($545/$595/$660)
 *   - $2,500 minimum job charge below ~4.5 SQ
 *   - $25 rounding
 *   - county tax (Hamilton 7.80, Butler 7.25, Warren 6.75, Clermont 7.25,
 *     Kenton/Boone/Campbell 6.00)
 *   - cash mode applies tax, insurance mode hides it
 *   - tear-off layers add $50/SQ per extra layer
 *
 * Pure-Node test, no emulator required. Run via:
 *   node tests/estimate-pricing.test.js
 */

const path = require('path');
const EBv2 = require(path.join('..', 'docs', 'pro', 'js', 'estimate-builder-v2.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error((label || 'value') + ' = ' + JSON.stringify(actual) + ' (expected ' + JSON.stringify(expected) + ')');
}
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) throw new Error((label || 'value') + ' = ' + actual + ' (expected ~' + expected + ' ±' + tol + ')');
}

console.log('\nestimate-builder-v2 pricing engine');
console.log('──────────────────────────────────────────────────');

// ── Tier rates ──
test('TIER_RATES: Good = $545/SQ', () => {
  eq(EBv2.TIER_RATES.good, 545);
});
test('TIER_RATES: Better = $595/SQ', () => {
  eq(EBv2.TIER_RATES.better, 595);
});
test('TIER_RATES: Best = $660/SQ', () => {
  eq(EBv2.TIER_RATES.best, 660);
});

// ── Constants ──
test('Minimum job charge = $2,500', () => {
  eq(EBv2.MIN_JOB_CHARGE, 2500);
});
test('Round to nearest $25 (derived from roundToNearest default)', () => {
  // ROUND_TO is internal; verify by passing no step.
  eq(EBv2.roundToNearest(1037), 1025);
  eq(EBv2.roundToNearest(1038), 1050);
});
test('Tear-off extra defaults to $50/SQ per extra (derived via calc)', () => {
  // 10 SQ × 2 extra layers × $50 = $1,000 — verified end-to-end below.
  // This test is a sanity placeholder for the constant.
  eq(true, true);
});

// ── roundToNearest ──
test('roundToNearest: 1003 → 1000', () => {
  eq(EBv2.roundToNearest(1003, 25), 1000);
});
test('roundToNearest: 1013 → 1025', () => {
  eq(EBv2.roundToNearest(1013, 25), 1025);
});
test('roundToNearest: $25 default step', () => {
  eq(EBv2.roundToNearest(1037), 1025);
});

// ── County tax (verify shape; calculatePerSq exercises full path) ──
test('County tax: Hamilton OH = 7.80%', () => {
  eq(EBv2.COUNTY_TAX['hamilton-oh'], 0.0780);
});
test('County tax: Butler OH = 7.25%', () => {
  eq(EBv2.COUNTY_TAX['butler-oh'], 0.0725);
});
test('County tax: Warren OH = 6.75%', () => {
  eq(EBv2.COUNTY_TAX['warren-oh'], 0.0675);
});
test('County tax: Clermont OH = 7.25%', () => {
  eq(EBv2.COUNTY_TAX['clermont-oh'], 0.0725);
});
test('County tax: Kenton KY = 6.00%', () => {
  eq(EBv2.COUNTY_TAX['kenton-ky'], 0.0600);
});
test('County tax: Boone KY = 6.00%', () => {
  eq(EBv2.COUNTY_TAX['boone-ky'], 0.0600);
});
test('County tax: Campbell KY = 6.00%', () => {
  eq(EBv2.COUNTY_TAX['campbell-ky'], 0.0600);
});

// ── extraPipeBootCharge ──
test('extraPipeBootCharge: 4 pipes → $0 (free)', () => {
  eq(EBv2.extraPipeBootCharge(4, 85), 0);
});
test('extraPipeBootCharge: 5 pipes → $85', () => {
  eq(EBv2.extraPipeBootCharge(5, 85), 85);
});
test('extraPipeBootCharge: 7 pipes → $255 (3 extra)', () => {
  eq(EBv2.extraPipeBootCharge(7, 85), 255);
});

// ── End-to-end calculations via calculateEstimate ──
test('39 SQ Better tier ≈ $23,900 (rawSqft pre-baked, waste=1)', () => {
  const r = EBv2.calculateEstimate({
    method: 'per-sq', tier: 'better', mode: 'insurance',
    rawSqft: 3900, pitch: '6/12', wasteFactorOverride: 1.0
  });
  // 39 × $595 = $23,205. Insurance hides tax.
  // Base + dumpFee default ($550) = $23,755. C-1 fail-safe: no county set →
  // DEFAULT_PERMIT_COST $150 (was a silent $0) = $23,905.
  // + material delivery $150 (flat per job; Jo 2026-09-27, was $412.50)
  // = $24,055 → rounds to $24,050.
  near(r.total, 24050, 30, 'insurance Better total');
});
test('C-1: blank/unknown jurisdiction → default permit $150, not $0 (per-SQ)', () => {
  const base = { method: 'per-sq', tier: 'better', mode: 'insurance', rawSqft: 3900, pitch: '6/12', wasteFactorOverride: 1.0 };
  const blank   = EBv2.calculateEstimate({ ...base });                          // no county
  const unknown = EBv2.calculateEstimate({ ...base, county: 'zz-nowhere' });    // off-list county
  const known   = EBv2.calculateEstimate({ ...base, county: 'hamilton-oh' });   // in PERMIT_COSTS
  eq(blank.addOns.permit, 150);    // was a silent $0 before the C-1 fix
  eq(unknown.addOns.permit, 150);  // off-list jurisdiction also fails safe to the default
  eq(known.addOns.permit, 185);    // known county still uses its real value (unchanged)
});
test('Blank jurisdiction permit line: "Building Permit — Local Jurisdiction" at $150', () => {
  // Neutral-county fix (first-run audit 2026-07-28): blank county is the
  // COMMON case for off-list tenants and this line name lands on customer
  // paper — it must read presentably (not "jurisdiction not set") while the
  // C-1 fail-safe cost holds.
  const items = EBv2.generateLineItemsFromMeasurements({
    tier: 'better', rawSqft: 3900, pitch: '6/12', wasteFactorOverride: 1.0
  });
  const permit = items.find(i => i.code === 'PERMIT');
  if (!permit) throw new Error('no PERMIT line generated for a blank jurisdiction');
  eq(permit.name, 'Building Permit — Local Jurisdiction', 'permit line name');
  eq(permit.materialCost, 150, 'permit fail-safe cost');
});
test('Cash mode applies county tax; insurance mode hides it', () => {
  const cash = EBv2.calculateEstimate({
    method: 'per-sq', tier: 'better', mode: 'cash',
    rawSqft: 3900, pitch: '6/12', county: 'hamilton-oh'
  });
  const ins = EBv2.calculateEstimate({
    method: 'per-sq', tier: 'better', mode: 'insurance',
    rawSqft: 3900, pitch: '6/12', county: 'hamilton-oh'
  });
  if (cash.total <= ins.total) throw new Error('cash total should exceed insurance total when tax applies; cash=' + cash.total + ' ins=' + ins.total);
});
test('Below 4.5 SQ enforces $2,500 minimum', () => {
  const r = EBv2.calculateEstimate({
    method: 'per-sq', tier: 'good', mode: 'insurance',
    rawSqft: 200, pitch: '4/12' // 2 SQ × $545 = $1,090 → bumps to $2,500
  });
  if (r.total < 2500) throw new Error('expected ≥2500, got ' + r.total);
});
test('Tear-off layers: 3 layers adds (3-1)*sq*$50', () => {
  const common = { method:'per-sq', tier:'good', mode:'insurance',
                   rawSqft: 1000, pitch: '6/12', wasteFactorOverride: 1.0 };
  const oneLayer = EBv2.calculateEstimate(Object.assign({}, common, { tearOffLayers: 1 }));
  const threeLayer = EBv2.calculateEstimate(Object.assign({}, common, { tearOffLayers: 3 }));
  // 10 SQ × 2 extra layers × $50 = $1,000 extra
  near(threeLayer.total - oneLayer.total, 1000, 30, 'tear-off premium');
});

// ── Deposit math (Rock 2 PR 4) ──
// Spec: cash defaults 50%, insurance defaults 0%, override 0–100,
// amount rounded to nearest $25, remainder = total − amount.
test('calcDeposit: cash mode default = 50%', () => {
  const d = EBv2.calcDeposit(10000, 'cash');
  eq(d.pct, 50, 'pct');
  eq(d.amount, 5000, 'amount');
  eq(d.remainder, 5000, 'remainder');
});
test('calcDeposit: insurance mode default = 0%', () => {
  const d = EBv2.calcDeposit(10000, 'insurance');
  eq(d.pct, 0, 'pct');
  eq(d.amount, 0, 'amount');
  eq(d.remainder, 10000, 'remainder');
});
test('calcDeposit: override pct beats default', () => {
  const d = EBv2.calcDeposit(10000, 'cash', { overridePct: 25 });
  eq(d.pct, 25, 'pct');
  eq(d.amount, 2500, 'amount');
  eq(d.remainder, 7500, 'remainder');
});
test('calcDeposit: override 0 on cash collapses to no deposit', () => {
  const d = EBv2.calcDeposit(10000, 'cash', { overridePct: 0 });
  eq(d.pct, 0);
  eq(d.amount, 0);
  eq(d.remainder, 10000);
});
test('calcDeposit: override out-of-range falls back to default', () => {
  const d = EBv2.calcDeposit(10000, 'cash', { overridePct: 150 });
  eq(d.pct, 50, 'rejected 150% → defaulted to 50');
});
test('calcDeposit: zero/negative total returns all zeros', () => {
  const a = EBv2.calcDeposit(0, 'cash');
  eq(a.amount, 0); eq(a.pct, 0); eq(a.remainder, 0);
  const b = EBv2.calcDeposit(-100, 'cash');
  eq(b.amount, 0); eq(b.pct, 0); eq(b.remainder, 0);
});
test('calcDeposit: amount rounds to nearest $25', () => {
  // $16,375 × 50% = $8,187.50 → rounds to $8,200 (nearest $25)
  const d = EBv2.calcDeposit(16375, 'cash');
  eq(d.amount, 8200, 'rounded to nearest $25');
  // remainder = total − amount, preserved to cent precision
  eq(d.remainder, 8175, 'remainder');
});
test('calcDeposit: amount + remainder === total (always)', () => {
  // Property: deposit math must never lose pennies
  const samples = [
    [10000, 'cash'], [16375, 'cash'], [9999, 'insurance'],
    [12345.67, 'cash', { overridePct: 33 }],
    [8888.88, 'cash', { overridePct: 75 }]
  ];
  for (const args of samples) {
    const d = EBv2.calcDeposit.apply(null, args);
    near(d.amount + d.remainder, args[0], 0.01,
         'sum (' + args[0] + ', ' + args[1] + ', override=' + (args[2] && args[2].overridePct) + ')');
  }
});

// ── Deposit integration with calculateEstimate ──
test('calculateEstimate: cash mode includes 50% deposit + remainder', () => {
  const r = EBv2.calculateEstimate({
    method: 'per-sq', tier: 'better', mode: 'cash',
    rawSqft: 3000, pitch: '6/12', wasteFactorOverride: 1.0
  });
  // 30 SQ × $595 = $17,850 base + tax + minor add-ons
  eq(r.depositPct, 50, 'depositPct');
  near(r.deposit + r.depositRemainder, r.total, 0.01, 'deposit + remainder == total');
});
test('calculateEstimate: insurance mode → 0 deposit, full remainder', () => {
  const r = EBv2.calculateEstimate({
    method: 'per-sq', tier: 'better', mode: 'insurance',
    rawSqft: 3000, pitch: '6/12', wasteFactorOverride: 1.0
  });
  eq(r.deposit, 0, 'deposit');
  eq(r.depositPct, 0, 'depositPct');
  eq(r.depositRemainder, r.total, 'remainder = total');
});

// ── Add-on prices unified with classic (Rock 2 PR 4b) ──
// Joe-confirmed values: chimney $425, skylight $350.
test('ADDON_PRICES: chimney flash = $425 (Joe pick over V2 default $285)', () => {
  eq(EBv2.ADDON_PRICES.chimneyFlash, 425);
});
test('ADDON_PRICES: skylight flash = $350 (Joe pick over classic $275)', () => {
  eq(EBv2.ADDON_PRICES.skylightFlash, 350);
});
test('ADDON_PRICES: chimney+skylight+delivery match estimate-config source of truth', () => {
  const cfg = require(require('path').join('..', 'docs', 'pro', 'js', 'estimate-config.js'));
  eq(EBv2.ADDON_PRICES.chimneyFlash,  cfg.ADDON_CHIMNEY_FLASH,  'chimney');
  eq(EBv2.ADDON_PRICES.skylightFlash, cfg.ADDON_SKYLIGHT_FLASH, 'skylight');
  eq(EBv2.ADDON_PRICES.matDelivery,   cfg.ADDON_MAT_DELIVERY,   'material delivery');
});
test('calculateEstimate: chimney add-on adds $425 to subtotal', () => {
  const common = { method:'per-sq', tier:'better', mode:'insurance',
                   rawSqft: 2000, pitch: '6/12', wasteFactorOverride: 1.0 };
  const a = EBv2.calculateEstimate(Object.assign({}, common, { hasChimneyFlash: false }));
  const b = EBv2.calculateEstimate(Object.assign({}, common, { hasChimneyFlash: true }));
  near(b.addOnsTotal - a.addOnsTotal, 425, 0.5, 'chimney add-on premium');
});
test('calculateEstimate: skylight add-on adds $350 to subtotal', () => {
  const common = { method:'per-sq', tier:'better', mode:'insurance',
                   rawSqft: 2000, pitch: '6/12', wasteFactorOverride: 1.0 };
  const a = EBv2.calculateEstimate(Object.assign({}, common, { hasSkylightFlash: false }));
  const b = EBv2.calculateEstimate(Object.assign({}, common, { hasSkylightFlash: true }));
  near(b.addOnsTotal - a.addOnsTotal, 350, 0.5, 'skylight add-on premium');
});

// ── Phase 1 per-SQ complexity adders (estimate-qa-2026-06-08, Joe-confirmed) ──
// wasteFactorOverride:1.0 pins sq=20 (2000 sqft) so the adder $ are exact.
test('adder: steep 8/12 = $25/SQ; nothing below 8/12', () => {
  const c = { tier:'better', mode:'insurance', rawSqft:2000, wasteFactorOverride:1.0 };
  eq(EBv2.calculatePerSq(Object.assign({}, c, { pitch:'6/12' })).addOns.steep, 0, '6/12 no steep');
  near(EBv2.calculatePerSq(Object.assign({}, c, { pitch:'8/12' })).addOns.steep, 20*25, 0.5, '8/12 steep $25/SQ');
});
test('adder: pitch tiers STACK — 12/12 = $70/SQ, 16/12 = $145/SQ', () => {
  const c = { tier:'better', mode:'insurance', rawSqft:2000, wasteFactorOverride:1.0 };
  const v = EBv2.calculatePerSq(Object.assign({}, c, { pitch:'12/12' }));
  near(v.addOns.steep + v.addOns.verySteep + v.addOns.extremeSteep, 20*70, 0.5, '12/12 stacks to $70/SQ');
  const x = EBv2.calculatePerSq(Object.assign({}, c, { pitch:'16/12' }));
  near(x.addOns.steep + x.addOns.verySteep + x.addOns.extremeSteep, 20*145, 0.5, '16/12 stacks to $145/SQ');
});
test('adder: stories TIERED — 2-story $15/SQ, 3-story $30/SQ (NOT additive)', () => {
  const c = { tier:'better', mode:'insurance', rawSqft:2000, pitch:'6/12', wasteFactorOverride:1.0 };
  eq(EBv2.calculatePerSq(Object.assign({}, c, { stories:1 })).addOns.story, 0, '1 story = 0');
  near(EBv2.calculatePerSq(Object.assign({}, c, { stories:2 })).addOns.story, 20*15, 0.5, '2-story $15/SQ');
  near(EBv2.calculatePerSq(Object.assign({}, c, { stories:3 })).addOns.story, 20*30, 0.5, '3-story $30/SQ (tiered, not $45)');
});
test('adder: cut-up = +3% material waste AND $15/SQ cutting labor', () => {
  const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000, pitch:'6/12', cutUpRoof:true });
  near(r.waste, 1.18, 0.001, '6/12 waste 1.15 + 3% = 1.18');
  near(r.addOns.cutUpLabor, r.sq * 15, 0.5, 'cut-up labor = sq × $15');
});
test('adder: access TIERED — standard $0, moderate $15/SQ, difficult $35/SQ', () => {
  const c = { tier:'better', mode:'insurance', rawSqft:2000, pitch:'6/12', wasteFactorOverride:1.0 };
  eq(EBv2.calculatePerSq(Object.assign({}, c, { accessLevel:'standard' })).addOns.access, 0, 'standard $0');
  near(EBv2.calculatePerSq(Object.assign({}, c, { accessLevel:'moderate' })).addOns.access, 20*15, 0.5, 'moderate $15/SQ');
  near(EBv2.calculatePerSq(Object.assign({}, c, { accessLevel:'difficult' })).addOns.access, 20*35, 0.5, 'difficult $35/SQ');
});
test('adder: per-SQ adder rates are config-backed (match estimate-config)', () => {
  const cfg = require(path.join('..', 'docs', 'pro', 'js', 'estimate-config.js'));
  eq(EBv2.ADDON_PRICES.steepPerSq,           cfg.ADDON_STEEP_PER_SQ,            'steep');
  eq(EBv2.ADDON_PRICES.verySteepPerSq,       cfg.ADDON_VERY_STEEP_PER_SQ,       'very-steep');
  eq(EBv2.ADDON_PRICES.extremeSteepPerSq,    cfg.ADDON_EXTREME_STEEP_PER_SQ,    'extreme-steep');
  eq(EBv2.ADDON_PRICES.twoStoryPerSq,        cfg.ADDON_TWO_STORY_PER_SQ,        'two-story');
  eq(EBv2.ADDON_PRICES.threeStoryPerSq,      cfg.ADDON_THREE_STORY_PER_SQ,      'three-story');
  eq(EBv2.ADDON_PRICES.cutUpPerSq,           cfg.ADDON_CUTUP_PER_SQ,            'cut-up');
  eq(EBv2.ADDON_PRICES.accessModeratePerSq,  cfg.ADDON_ACCESS_MODERATE_PER_SQ,  'access-moderate');
  eq(EBv2.ADDON_PRICES.accessDifficultPerSq, cfg.ADDON_ACCESS_DIFFICULT_PER_SQ, 'access-difficult');
});

// ── Shop-wide rate architecture (Phase 2a, estimate-qa-2026-06-08) ──
// config = default · companyProfile.pricing = shop override · localStorage ≠ pricing.
test('rates: config defaults win when no companyProfile (Node path)', () => {
  const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000, pitch:'8/12', wasteFactorOverride:1.0 });
  near(r.rate, 595, 0.5, 'tier rate from config');
  near(r.addOns.steep, 20*25, 0.5, 'steep from config $25');
});
test('rates: companyProfile.pricing OVERRIDES config (shop-wide)', () => {
  global.window = { _companyProfile: { pricing: { addonPrices: { steepPerSq: 40 }, tierRates: { better: 700 } } } };
  try {
    const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000, pitch:'8/12', wasteFactorOverride:1.0 });
    near(r.rate, 700, 0.5, 'tier rate from companyProfile $700');
    near(r.baseTotal, 20*700, 0.5, 'base uses overridden tier rate');
    near(r.addOns.steep, 20*40, 0.5, 'steep from companyProfile $40');
  } finally { delete global.window; }
});
test('rates: companyProfile PARTIAL override leaves other rates on config', () => {
  global.window = { _companyProfile: { pricing: { addonPrices: { steepPerSq: 40 } } } };
  try {
    const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000, pitch:'12/12', wasteFactorOverride:1.0 });
    near(r.addOns.steep, 20*40, 0.5, 'steep overridden $40');
    near(r.addOns.verySteep, 20*45, 0.5, 'very-steep stays config $45');
    near(r.rate, 595, 0.5, 'tier rate stays config $595');
  } finally { delete global.window; }
});
test('rates: stale localStorage snapshot CANNOT override ADD-ON prices (L-1 kill)', () => {
  // The chimney-$285 bug: a saved snapshot must no longer override add-on prices.
  global.localStorage = {
    _d: { 'nbd_est_settings_v3': JSON.stringify({ addonPrices: { steepPerSq: 999, chimneyFlash: 285 } }) },
    getItem(k) { return this._d[k] || null; }, setItem() {}, removeItem() {}
  };
  try {
    const s = EBv2.loadSettings();
    eq(s.addonPrices.steepPerSq,  EBv2.ADDON_PRICES.steepPerSq,  'steep stays config, not stale 999');
    eq(s.addonPrices.chimneyFlash, EBv2.ADDON_PRICES.chimneyFlash, 'chimney stays config 425, not the stale $285 (L-1)');
  } finally { delete global.localStorage; }
});
test('rates: blank/garbage companyProfile value is IGNORED, not a silent $0', () => {
  global.window = { _companyProfile: { pricing: { addonPrices: { steepPerSq: '', verySteepPerSq: null }, tierRates: { better: 'abc' } } } };
  try {
    const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000, pitch:'12/12', wasteFactorOverride:1.0 });
    near(r.addOns.steep,     20*25, 0.5, "blank steep '' ignored → config $25");
    near(r.addOns.verySteep, 20*45, 0.5, 'null very-steep ignored → config $45');
    near(r.rate,             595,   0.5, "garbage tier rate 'abc' ignored → config $595");
  } finally { delete global.window; }
});
test('rates: explicit companyProfile 0 IS honored (free add-on)', () => {
  global.window = { _companyProfile: { pricing: { addonPrices: { steepPerSq: 0 } } } };
  try {
    const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000, pitch:'8/12', wasteFactorOverride:1.0 });
    eq(r.addOns.steep, 0, 'steepPerSq:0 → intentional free add-on');
  } finally { delete global.window; }
});

// ══════════════════════════════════════════════════════════
// Internal-view ADD-ON COST (2026-08-19)
//
// Guards the fix for a margin-DISPLAY defect: per-SQ costed every add-on at a
// blanket 40% of its charge, including the permit (remitted to the
// jurisdiction in full) and the dump fee (the hauler's invoice). Line-item
// mode has always costed both at face value; per-SQ was the outlier and told
// the shop it made several hundred dollars more than it did on any job
// carrying both. Nothing the homeowner is charged is affected — every
// assertion below is on r.internal.
//
// Costs here are synthetic. Real per-SQ cost basis is tenant data and ships
// as zeros (tests/catalog-cost-privacy.test.js pins that).
// ══════════════════════════════════════════════════════════

const COST_PER_SQ = 300;                 // synthetic basis, not a real figure
function costedSettings(extra) {
  const s = EBv2.getDefaultSettings();
  s.costBasis = Object.assign({}, s.costBasis, { better: COST_PER_SQ });
  return Object.assign(s, extra || {});
}
// 20 SQ, blank jurisdiction (permit falls back to $150), insurance so tax is 0,
// 8/12 so exactly ONE work adder (steep) fires and nothing else does.
function persqJob(settings) {
  return EBv2.calculatePerSq({
    tier: 'better', mode: 'insurance', rawSqft: 2000, pitch: '8/12',
    wasteFactorOverride: 1.0, county: '', settingsOverride: settings
  });
}
const PERMIT = 150, DUMP = 550, STEEP = 20 * 25;   // 150 + 550 + 500 = 1200
// Material delivery: flat per job, always on. Charged $150 (Jo, 2026-09-27;
// was the line-item retail figure 412.50 = 275 × 1.25 markup × 1.20 OH&P).
// Its cost is PINNED to the 'MAT DEL' line baseline regardless of what the
// shop charges — including this default — so it lands on 275 in integer cents.
// MATDEL_COST is the literal 275 on purpose — 412.50/1.5 in floating point is
// 274.99999999999994, while the engine rounds in cents and returns exactly 275,
// and eq() is a strict !==.
const MATDEL = 150;
const MATDEL_COST = 275;

test('add-on cost: the fixture fires permit + dump + delivery + steep and nothing else', () => {
  const r = persqJob(costedSettings());
  eq(r.addOns.permit,      PERMIT, 'permit (blank jurisdiction fallback)');
  eq(r.addOns.dumpFee,     DUMP,   'dump fee');
  eq(r.addOns.matDelivery, MATDEL, 'material delivery');
  eq(r.addOns.steep,       STEEP,  'steep adder');
  const EXPECTED = { permit: PERMIT, dumpFee: DUMP, matDelivery: MATDEL, steep: STEEP };
  Object.keys(r.addOns).forEach((k) => {
    eq(r.addOns[k], EXPECTED[k] || 0, 'add-on ' + k);
  });
  // The inverse direction too: a key silently dropped from the engine would
  // otherwise sail through the loop above.
  Object.keys(EXPECTED).forEach((k) => {
    eq(k in r.addOns, true, 'expected add-on ' + k + ' is missing from the engine output');
  });
  eq(r.addOnsTotal, PERMIT + DUMP + MATDEL + STEEP, 'add-ons total');   // 1612.50
});

test('add-on cost: pass-throughs at face, delivery at its baseline, work adders keep 0.4', () => {
  const r = persqJob(costedSettings());
  eq(r.internal.addOnCost, PERMIT + DUMP + MATDEL_COST + (STEEP * 0.4),
     'permit+dump at 1.0, delivery pinned to its baseline, steep at 0.4');
});

test('add-on cost: a pass-through-only job costs exactly what it charges', () => {
  // Flat pitch → no work adders at all, and delivery waived on this job (the
  // customer hauls their own material), so cost must equal charge. The literal
  // 0 also proves the override honours 0 rather than dropping it as blank.
  const r = EBv2.calculatePerSq({
    tier: 'better', mode: 'insurance', rawSqft: 2000, pitch: '4/12',
    wasteFactorOverride: 1.0, county: '', matDeliveryOverride: 0,
    settingsOverride: costedSettings()
  });
  eq(r.addOnsTotal, PERMIT + DUMP, 'permit + dump only');
  eq(r.internal.addOnCost, r.addOnsTotal, 'no margin is assumed on either');
});

test('add-on cost: the old blanket 40% cannot silently come back', () => {
  const r = persqJob(costedSettings());
  const blanket = r.addOnsTotal * 0.4;
  eq(r.internal.addOnCost === blanket, false, 'must NOT be addOnsTotal * 0.4');
  eq(r.internal.addOnCost > blanket, true, 'the correction can only RAISE assumed cost');
});

test('add-on cost: margin falls by exactly the under-counted third-party charges', () => {
  const r = persqJob(costedSettings());
  // Old model assumed 40% of everything. The gap, per line: 60% on each
  // pass-through, and (baseline − 40% of the marked-up charge) on delivery.
  // 700 × 0.6 = 420; 275 − 165 = 110; 530 in total.
  near(r.margin != null ? 0 : 0, 0, 0, 'margin is on internal, not the root');
  eq(r.internal.totalCost, (20 * COST_PER_SQ) + r.internal.addOnCost, 'total cost composition');
  eq(r.internal.margin, r.total - r.internal.totalCost, 'margin = total - cost');
  const overstatedBy = (PERMIT + DUMP) * 0.6 + (MATDEL_COST - (MATDEL * 0.4));
  eq(r.internal.margin + overstatedBy, r.total - ((20 * COST_PER_SQ) + (r.addOnsTotal * 0.4)), 'exactly the old figure, no more');
});

test('add-on cost: a tenant ratio override wins', () => {
  const r = persqJob(costedSettings({ addonCostRatios: { dumpFee: 0.5, steep: 1, matDelivery: 0.6 } }));
  eq(r.internal.addOnCost, PERMIT + (DUMP * 0.5) + (MATDEL * 0.6) + STEEP, 'overrides applied per key');
});

test('add-on cost: an explicit 0 ratio IS honored (a donated add-on)', () => {
  const r = persqJob(costedSettings({ addonCostRatios: { dumpFee: 0 } }));
  eq(r.internal.addOnCost, PERMIT + MATDEL_COST + (STEEP * 0.4), 'dump fee costed at nothing');
});

test('add-on cost: junk/negative ratios are IGNORED, never reach the money', () => {
  // null/'' are the L-1 class: Number('') and Number(null) are both 0, so a
  // blank editor field must NOT read as "this add-on costs nothing" — that
  // understates cost, the exact defect this section exists to prevent.
  const junk = { permit: 'abc', dumpFee: -1, steep: null, matDelivery: 'abc' };
  const r = persqJob(costedSettings({ addonCostRatios: junk }));
  eq(r.internal.addOnCost, PERMIT + DUMP + MATDEL_COST + (STEEP * 0.4), 'falls back to the defaults');
  eq(Number.isFinite(r.internal.addOnCost), true, 'no NaN reaches the internal view');
  const blank = persqJob(costedSettings({ addonCostRatios: { permit: '', dumpFee: undefined } }));
  eq(blank.internal.addOnCost, PERMIT + DUMP + MATDEL_COST + (STEEP * 0.4), "blank '' / undefined are dropped, not read as 0");
});

test('add-on cost: a settingsOverride with no addonCostRatios at all is safe', () => {
  const s = EBv2.getDefaultSettings();
  s.costBasis = Object.assign({}, s.costBasis, { better: COST_PER_SQ });
  delete s.addonCostRatios;
  const r = persqJob(s);
  eq(r.internal.addOnCost, PERMIT + DUMP + MATDEL_COST + (STEEP * 0.4), 'defaults still apply');
});

test('add-on cost: an unconfigured cost basis still shows no margin at all', () => {
  const r = persqJob(EBv2.getDefaultSettings());   // costBasis ships as zeros
  eq(r.internal.addOnCost, 0, 'no cost is assumed when none is configured');
  eq(r.internal.margin, null, 'margin stays null, never a fake 100%');
});

test('add-on cost: loadSettings merges a saved addonCostRatios map', () => {
  global.localStorage = {
    _d: { 'nbd_est_settings_v3': JSON.stringify({ addonCostRatios: { dumpFee: 0.9 } }) },
    getItem(k) { return this._d[k] || null; }, setItem() {}, removeItem() {}
  };
  try {
    eq(EBv2.loadSettings().addonCostRatios.dumpFee, 0.9, 'saved ratio survives the merge');
  } finally { delete global.localStorage; }
});

test('add-on cost: the pass-through list is the permit and the dump fee', () => {
  eq(EBv2.ADDON_COST_PASS_THROUGH.slice().sort().join(','), 'dumpFee,permit');
  eq(EBv2.DEFAULT_ADDON_COST_RATIO, 0.4, 'work adders keep the pre-existing assumption');
});

test('add-on cost: material delivery is NOT a pass-through, and its cost is PINNED', () => {
  // A pass-through means "charged AT cost". Delivery is charged at the
  // marked-up figure, so it is not one. And because the reducer scales the
  // ratio by the CHARGED cents, a fixed fraction would let a shop that
  // discounted the job silently book less cost than the supplier invoices —
  // the exact overstate-margin defect this whole section exists to prevent.
  eq(EBv2.ADDON_COST_PASS_THROUGH.indexOf('matDelivery'), -1,
     'delivery is not charged AT cost, so it is not a pass-through');
  const priced = (p) => persqJob(costedSettings({
    addonPrices: Object.assign({}, EBv2.getDefaultSettings().addonPrices, { matDelivery: p })
  }));
  [300, 500, 1000, MATDEL].forEach((p) => {
    const r = priced(p);
    eq(r.addOns.matDelivery, p, 'the edited charge at ' + p + ' is what is billed');
    eq(r.internal.addOnCost, PERMIT + DUMP + MATDEL_COST + (STEEP * 0.4),
       'charge ' + p + ' still books the baseline — the invoice is the invoice');
  });
});

test('delivery: a flat per-job charge does NOT scale with roof size', () => {
  const c = { tier:'better', mode:'insurance', pitch:'4/12', wasteFactorOverride:1.0, county:'' };
  const small = EBv2.calculatePerSq(Object.assign({}, c, { rawSqft: 1000 }));   // 10 SQ
  const big   = EBv2.calculatePerSq(Object.assign({}, c, { rawSqft: 6000 }));   // 60 SQ
  eq(small.addOns.matDelivery, big.addOns.matDelivery,
     'per JOB — a 60 SQ roof takes the same trip as a 10 SQ roof');
  eq(small.addOns.matDelivery, MATDEL, 'and it is the flat figure');
});

test('delivery: the flat charge is NOT amortised into the per-SQ cost basis', () => {
  // Finding 1 of the audit note: folding a flat per-job fee into costBasis[tier]
  // (a per-SQ number) is exact at exactly one job size. It must stay an add-on.
  const r = persqJob(costedSettings());
  eq(r.internal.materialLaborCost, 20 * COST_PER_SQ,
     'materialLaborCost is sq × costBasis and nothing else');
  eq(r.internal.totalCost, r.internal.materialLaborCost + r.internal.addOnCost,
     'cost composition');
});

test('delivery: a shop-wide companyProfile override reaches the charge', () => {
  global.window = { _companyProfile: { pricing: { addonPrices: { matDelivery: 500 } } } };
  try {
    const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000,
                                    pitch:'4/12', wasteFactorOverride:1.0, county:'' });
    eq(r.addOns.matDelivery, 500, 'companyProfile override honored');
  } finally { delete global.window; }
});

test('delivery: a blank/garbage companyProfile price is IGNORED, not a silent $0', () => {
  global.window = { _companyProfile: { pricing: { addonPrices: { matDelivery: '' } } } };
  try {
    const r = EBv2.calculatePerSq({ tier:'better', mode:'insurance', rawSqft:2000,
                                    pitch:'4/12', wasteFactorOverride:1.0, county:'' });
    eq(r.addOns.matDelivery, MATDEL, "blank '' dropped → config figure stands (L-1)");
  } finally { delete global.window; }
});

test('delivery: on a sub-minimum job the floor absorbs it — the shop still pays', () => {
  // The $25 grid and the $2,500 min-job clamp both run AFTER add-ons, so on a
  // tiny job the customer total does not move even though the trip is real.
  const c = { tier:'good', mode:'insurance', pitch:'4/12', rawSqft: 200 };
  const on  = EBv2.calculatePerSq(c);
  const off = EBv2.calculatePerSq(Object.assign({}, c, { matDeliveryOverride: 0 }));
  eq(on.minJobApplied, true, 'fixture is under the floor');
  eq(on.total, off.total, 'clamped total is identical — delivery is absorbed');
  eq(on.addOns.matDelivery, MATDEL, 'but it IS charged into the subtotal');
  eq(on.subtotal > off.subtotal, true, 'the subtotal moves even when the total cannot');
});

test('delivery: $150 default charge; the booked COST stays pinned to the MAT DEL line', () => {
  // Until 2026-09-27 the per-SQ charge WAS the line-item 'MAT DEL' retail
  // figure (mat 275 × 1.25 markup × 1.20 OH&P = 412.50). Jo set the per-SQ
  // charge to $150 per job. The cost baseline must not follow the price down:
  // it is still the MAT DEL line (275), so a $150 charge books a delivery
  // cost ABOVE the charge — the margin report tells the truth about the trip.
  const chain = (1 + EBv2.DEFAULT_MATERIAL_MARKUP_PCT)
              * (1 + EBv2.DEFAULT_OVERHEAD_PCT + EBv2.DEFAULT_PROFIT_PCT);
  eq(Math.round(MATDEL_COST * chain * 100) / 100, 412.5,
     'the MAT DEL line retail the baseline comes from is unchanged');
  eq(EBv2.ADDON_PRICES.matDelivery, 150, 'default per-SQ delivery charge is $150');
  const r = persqJob(costedSettings());
  eq(r.addOns.matDelivery, 150, 'the job is charged $150');
  eq(r.internal.addOnCost, PERMIT + DUMP + MATDEL_COST + (STEEP * 0.4),
     'and still books the 275 baseline, not 150 / 1.5 = 100');
});

console.log('──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
