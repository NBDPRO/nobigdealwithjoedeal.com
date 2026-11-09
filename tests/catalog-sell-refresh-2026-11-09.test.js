/**
 * tests/catalog-sell-refresh-2026-11-09.test.js
 *
 * 2026-11-09: retail sells were raised on 17 catalog SKUs in
 * docs/pro/js/product-data.js. A device only re-reads catalog sells when
 * product-library.js DATA_VERSION changes (NBD has no productLibrary/{companyId}
 * company copy, so the localStorage store is the whole story). This suite boots
 * the real product-library.js over a store written at the PREVIOUS version and
 * proves the migration:
 *   - refreshes an untouched catalog item (under_001) to the new sell,
 *   - keeps a product the user edited themselves,
 *   - keeps a tombstoned (hard-deleted) product deleted,
 *   - keeps a user-added product.
 *
 * Fixture sells are arbitrary placeholders, not real figures.
 * Pure-Node. Run: node tests/catalog-sell-refresh-2026-11-09.test.js
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
function eq(a, b, label) {
  if (a !== b) throw new Error((label || 'value') + ' = ' + JSON.stringify(a) + ' (expected ' + JSON.stringify(b) + ')');
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

const version = Number((LIB_SRC.match(/const DATA_VERSION = (\d+);/) || [])[1]);
const catalog = boot(null).win.NBD_PRODUCTS;
const fresh = (id) => JSON.parse(JSON.stringify(catalog.find(p => p.id === id)));
const STALE = { good: { sell: 1 }, better: { sell: 2 }, best: { sell: 3 } };
const SEEDED = '2026-08-01T00:00:00.000Z';

function v5Store(items, deleted) {
  return JSON.stringify({ _v: 5, items, _deleted: deleted || [] });
}
function untouched(id) {
  return Object.assign(fresh(id), { pricing: JSON.parse(JSON.stringify(STALE)), createdAt: SEEDED, updatedAt: SEEDED });
}

console.log('\ncatalog sell refresh (DATA_VERSION bump, 2026-11-09)');

test('DATA_VERSION was bumped past 5 so stored catalogs re-read sells', () => {
  if (!(version >= 6)) throw new Error('DATA_VERSION = ' + version);
});

test('untouched under_001 in a v5 store picks up the new catalog sell', () => {
  const env = boot(v5Store([untouched('under_001')]));
  const p = env.win._productLib.getProducts().find(x => x.id === 'under_001');
  ['good', 'better', 'best'].forEach(t => eq(p.pricing[t].sell, fresh('under_001').pricing[t].sell, t + ' sell'));
  eq(env.read()._v, version, 'stored _v');
});

test('a user-edited under_001 keeps the user\'s own sell', () => {
  const edited = Object.assign(untouched('under_001'), { updatedAt: '2026-09-01T00:00:00.000Z', name: 'My felt' });
  const env = boot(v5Store([edited]));
  const p = env.win._productLib.getProducts().find(x => x.id === 'under_001');
  eq(p.pricing.better.sell, STALE.better.sell, 'edited better sell');
  eq(p.name, 'My felt', 'edited name');
});

test('a hard-deleted under_001 stays deleted', () => {
  const env = boot(v5Store([untouched('flash_008')], ['under_001']));
  eq(env.win._productLib.getProducts().some(x => x.id === 'under_001'), false, 'under_001 present');
  eq(env.read()._deleted.includes('under_001'), true, 'tombstone kept');
});

test('a user-added product survives the migration', () => {
  const custom = { id: 'prod_custom_1', name: 'Custom vent', category: 'roofing_ventilation', unit: 'EA',
    pricing: JSON.parse(JSON.stringify(STALE)), isActive: true, createdAt: SEEDED, updatedAt: SEEDED };
  const env = boot(v5Store([untouched('under_001'), custom]));
  const p = env.win._productLib.getProducts().find(x => x.id === 'prod_custom_1');
  if (!p) throw new Error('custom product dropped');
  eq(p.pricing.best.sell, STALE.best.sell, 'custom best sell');
});

test('an untouched flash_008 (also raised) refreshes alongside under_001', () => {
  const env = boot(v5Store([untouched('under_001'), untouched('flash_008')]));
  const p = env.win._productLib.getProducts().find(x => x.id === 'flash_008');
  eq(p.pricing.better.sell, fresh('flash_008').pricing.better.sell, 'flash_008 better sell');
});

test('SKUs given real sells on 2026-11-09 no longer carry placeholder-pricing notes', () => {
  const stale = /PLACEHOLDER PRICING|PRICING TODO|SELL prices (still )?TODO/;
  const bad = ['under_007', 'flash_009', 'flash_010'].filter(id => stale.test(fresh(id).notes || ''));
  if (bad.length) throw new Error('placeholder notes on ' + bad.join(', '));
});

// A DATA_VERSION bump only reaches a device if product-library.js and
// product-data.js arrive as a matching pair. docs/pro/sw.js serves a cached
// asset when the network is slower than ASSET_NETWORK_TIMEOUT_MS, so a fresh
// library + cached old data would migrate the OLD catalog and stamp the store
// with the new _v. Bumping both ?v keys in script-loader.js gives both URLs no
// cache entry. Each DATA_VERSION lists the minimum ?v keys that shipped with it;
// a future bump must add its row (and bump the keys) or this fails.
const LOADER_SRC = fs.readFileSync(path.join(PRO_JS, 'script-loader.js'), 'utf8');
const PAIRED_CACHE_KEYS = { 6: { data: 4, lib: 15 } };
function loaderKey(file) {
  const m = LOADER_SRC.match(new RegExp("'js/" + file.replace('.', '\\.') + "\\?v=(\\d+)'"));
  return m ? Number(m[1]) : NaN;
}

test('script-loader cache keys for product-data.js and product-library.js were bumped with DATA_VERSION', () => {
  const want = PAIRED_CACHE_KEYS[version];
  if (!want) throw new Error('no PAIRED_CACHE_KEYS row for DATA_VERSION ' + version + ' — bump both ?v keys in script-loader.js and add the row');
  const data = loaderKey('product-data.js');
  const lib = loaderKey('product-library.js');
  if (!(data >= want.data)) throw new Error('product-data.js ?v=' + data + ' (expected >= ' + want.data + ')');
  if (!(lib >= want.lib)) throw new Error('product-library.js ?v=' + lib + ' (expected >= ' + want.lib + ')');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
