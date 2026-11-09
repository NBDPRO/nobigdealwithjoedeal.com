/**
 * tests/builder-rate-units-2026-11-09.test.js
 *
 * syncRatesFromProductLibrary (docs/pro/js/product-library.js) builds window.R,
 * the classic builder's per-unit rate table (per SQ for felt, per LF for
 * starter / ridge / hip). Catalog products are priced in their OWN units, so
 * each mapping must divide by the item's real coverage:
 *   - under_001 is sold per ROLL covering 10 SQ (coverage.sqPerRoll) — it was
 *     mapped 1:1 into a per-SQUARE felt rate (10x too high).
 *   - flash_008 starter is sold per BUNDLE of 120 LF (supplier spec; the
 *     catalog text said ~100 LF) — it was divided by 100.
 *   - under_006 ice & water: per roll of 2 SQ (coverage.sqPerRoll).
 *   - flash_007 ridge / hip cap: per bundle of ~25 LF.
 * And a product a user re-priced in the rate's own unit (unit SQ / LF) is
 * taken as-is, not divided again.
 *
 * Pure-Node. Run: node tests/builder-rate-units-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PRO_JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const DATA_SRC = fs.readFileSync(path.join(PRO_JS, 'product-data.js'), 'utf8');
const RIV_SRC = fs.readFileSync(path.join(PRO_JS, 'roofivent-catalog.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(PRO_JS, 'product-library.js'), 'utf8');
const KEY = 'nbd_product_library';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}
function near(a, b, label) {
  if (!(Math.abs(a - b) < 1e-9)) throw new Error((label || 'value') + ' = ' + a + ' (expected ' + b + ')');
}

function boot(storeJson) {
  const map = new Map();
  if (storeJson) map.set(KEY, storeJson);
  const localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  const win = {};
  win.window = win;
  const sandbox = {
    window: win, localStorage,
    document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } },
    console: { log() {}, warn() {}, error() {}, info() {} },
    Date, Math, JSON, Set, Map, Object, isFinite, setTimeout, navigator: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(DATA_SRC, sandbox, { filename: 'product-data.js' });
  vm.runInContext(RIV_SRC, sandbox, { filename: 'roofivent-catalog.js' });
  vm.runInContext(LIB_SRC, sandbox, { filename: 'product-library.js' });
  return { win, read: () => JSON.parse(map.get(KEY)) };
}

const env = boot(null);
const prod = (id) => env.win.NBD_PRODUCTS.find(p => p.id === id);
const TIERS = ['good', 'better', 'best'];

console.log('\nclassic builder rate units (2026-11-09)');

test('felt: per-SQ rate for under_001 = roll sell / 10 SQ per roll', () => {
  TIERS.forEach(t => near(env.win.syncRatesFromProductLibrary(t).felt, prod('under_001').pricing[t].sell / 10, t + ' felt'));
});

test('starter: per-LF rate for flash_008 = bundle sell / 120 LF', () => {
  TIERS.forEach(t => near(env.win.syncRatesFromProductLibrary(t).starter, prod('flash_008').pricing[t].sell / 120, t + ' starter'));
});

test('iws: per-SQ rate for under_006 = roll sell / 2 SQ per roll', () => {
  TIERS.forEach(t => near(env.win.syncRatesFromProductLibrary(t).iws, prod('under_006').pricing[t].sell / 2, t + ' iws'));
});

test('ridge and hip: per-LF rate for flash_007 = bundle sell / 25 LF', () => {
  TIERS.forEach(t => {
    const r = env.win.syncRatesFromProductLibrary(t);
    near(r.ridge, prod('flash_007').pricing[t].sell / 25, t + ' ridge');
    near(r.hip, prod('flash_007').pricing[t].sell / 25, t + ' hip');
  });
});

test('per-SQ shingle, per-LF drip and per-EA pipe pass straight through', () => {
  const r = env.win.syncRatesFromProductLibrary('better');
  near(r.shingle, prod('shingle_001').pricing.better.sell, 'shingle');
  near(r.drip, prod('flash_003').pricing.better.sell, 'drip');
  near(r.pipe, prod('flash_002').pricing.better.sell, 'pipe');
});

test('flash_008 catalog text states the real 120 LF bundle coverage', () => {
  const p = prod('flash_008');
  if (!/120 LF/.test(p.coverage.perUnit)) throw new Error('coverage.perUnit = ' + p.coverage.perUnit);
  if (/100 LF/.test(p.notes)) throw new Error('notes still say 100 LF: ' + p.notes);
});

test('a user who re-priced felt per SQ (unit SQ) is not divided again', () => {
  const items = env.read().items;
  const felt = items.find(x => x.id === 'under_001');
  felt.unit = 'SQ';
  felt.pricing = { good: { sell: 30 }, better: { sell: 31 }, best: { sell: 32 } };
  felt.updatedAt = '2026-11-09T12:00:00.000Z';
  const e2 = boot(JSON.stringify({ _v: env.read()._v, items, _deleted: [] }));
  near(e2.win.syncRatesFromProductLibrary('better').felt, 31, 'felt per SQ');
});

test('a roll whose coverage a user changed converts by the stored coverage', () => {
  const items = env.read().items;
  const felt = items.find(x => x.id === 'under_001');
  felt.coverage = Object.assign({}, felt.coverage, { sqPerRoll: 4 });
  felt.updatedAt = '2026-11-09T12:00:00.000Z';
  const e2 = boot(JSON.stringify({ _v: env.read()._v, items, _deleted: [] }));
  near(e2.win.syncRatesFromProductLibrary('good').felt, felt.pricing.good.sell / 4, 'felt per SQ');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
