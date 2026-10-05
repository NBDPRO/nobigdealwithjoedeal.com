/**
 * tests/product-library-company-2026-09-29.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * The Product Library (custom products, sell-price edits, archives) lived only
 * in this browser's localStorage under `nbd_product_library`, and
 * NBDAuth.purgeAccountStorage() deletes every `nbd_` key on every sign-out.
 * Jo's edits vanished at each logout and never reached another device or a
 * rep; the classic builder's rates (window.R) and the Close Board read them.
 *
 * Jo, 2026-09-29: "company-wide, owner and admins edit". product-library.js
 * now keeps the company's DELTA from the published catalog in
 * productLibrary/{companyId} (firestore.rules §37 in firestore-rules.test.js):
 *   - a fresh device (what every sign-out leaves) gets the company's edits back;
 *   - the doc never carries cost or labor (those stay in catalogCosts);
 *   - untouched defaults are never uploaded, so catalog fixes still land;
 *   - an editor's first load with no company doc adopts this device's edits
 *     ONCE, and a failed read never triggers it;
 *   - a sales rep reads it but gets no Add/Edit/Archive/Reset, and the modal
 *     refuses; an edited product with no cost is filled from the cost book.
 *
 * Drives the real bundle order in a vm: product-data → roofivent-catalog →
 * catalog-costs → product-library, against a Firestore stub.
 * Run: node tests/product-library-company-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PRO_JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const SRC = (f) => fs.readFileSync(path.join(PRO_JS, f), 'utf8');
const DATA_SRC = SRC('product-data.js');
const RIV_SRC = SRC('roofivent-catalog.js');
const COSTS_SRC = SRC('catalog-costs.js');
// NBD_PLIB_SRC=<file> runs the suite against another copy (break-test only).
const LIB_SRC = process.env.NBD_PLIB_SRC ? fs.readFileSync(process.env.NBD_PLIB_SRC, 'utf8') : SRC('product-library.js');
const CFG_SRC = SRC('estimate-config.js');
const DATA_VERSION = Number((LIB_SRC.match(/const DATA_VERSION = (\d+);/) || [])[1]);
const TENANT = 'co_lib';
const LIB_PATH = 'productLibrary/' + TENANT;

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

function makeLocalStorage(seed) {
  const store = new Map(Object.entries(seed || {}));
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
}

// Firestore stub: setDoc(merge) deep-merges maps, updateDoc dotted paths REPLACE.
function makeFirestore(docs, opts) {
  const st = Object.assign({ reads: [], writes: [], failRead: false, deny: false }, opts || {});
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const deepMerge = (a, b) => { const o = Object.assign({}, a); Object.keys(b).forEach((k) => { o[k] = (isMap(o[k]) && isMap(b[k])) ? deepMerge(o[k], b[k]) : b[k]; }); return o; };
  const deny = () => { if (st.deny) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } };
  return {
    doc: (db, col, id) => ({ __path: col + '/' + id }),
    getDoc: async (ref) => {
      st.reads.push(ref.__path);
      if (st.failRead && ref.__path.indexOf('productLibrary/') === 0) { const e = new Error('client is offline'); e.code = 'unavailable'; throw e; }
      const d = docs[ref.__path];
      return { exists: () => !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : null) };
    },
    setDoc: async (ref, data, o) => {
      deny(); st.writes.push({ op: 'set', path: ref.__path, data: JSON.parse(JSON.stringify(data)), merge: !!(o && o.merge) });
      const prev = (o && o.merge && docs[ref.__path]) ? docs[ref.__path] : {};
      docs[ref.__path] = JSON.parse(JSON.stringify(deepMerge(prev, data)));
    },
    updateDoc: async (ref, paths) => {
      deny();
      const prev = docs[ref.__path];
      if (!prev) { const e = new Error('No document to update'); e.code = 'not-found'; throw e; }
      st.writes.push({ op: 'update', path: ref.__path, data: JSON.parse(JSON.stringify(paths)) });
      const next = JSON.parse(JSON.stringify(prev));
      Object.keys(paths).forEach((p) => {
        const parts = p.split('.'); let cur = next;
        for (let i = 0; i < parts.length - 1; i++) { if (!isMap(cur[parts[i]])) cur[parts[i]] = {}; cur = cur[parts[i]]; }
        cur[parts[parts.length - 1]] = JSON.parse(JSON.stringify(paths[p]));
      });
      docs[ref.__path] = next;
    },
    __st: st,
  };
}

function boot(o) {
  const cfg = o || {};
  const docs = cfg.docs || {};
  const win = {}; win.window = win;
  const localStorage = makeLocalStorage(cfg.storage || {});
  const fsStub = makeFirestore(docs, cfg.fs);
  const toasts = [];
  const sandbox = {
    window: win, localStorage,
    document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } },
    console: { log() {}, warn() {}, error() {}, info() {} },
    Date, Math, JSON, Set, Map, Object, Array, String, Number, Promise, isFinite, setTimeout, navigator: {},
  };
  vm.createContext(sandbox);
  if (cfg.estimateConfig) vm.runInContext(CFG_SRC, sandbox);
  vm.runInContext(DATA_SRC, sandbox);
  vm.runInContext(RIV_SRC, sandbox);
  win._userClaims = cfg.claims || { companyId: TENANT, role: 'company_admin' };
  win._user = { uid: cfg.uid || 'u_admin' };
  win.db = {};
  win.__NBD_FS__ = fsStub;
  win.showToast = (m, k) => toasts.push({ m, k });
  vm.runInContext(COSTS_SRC, sandbox);
  vm.runInContext(LIB_SRC, sandbox);
  const lib = win._productLib;
  return {
    win, lib, docs, fsStub, toasts, localStorage,
    settle: async () => { await win.NBDCatalogCosts.hydrate(); await lib.hydrateCompany(); await new Promise((r) => setTimeout(r, 0)); },
    store: () => JSON.parse(localStorage.getItem('nbd_product_library')),
    byId: (id) => (JSON.parse(localStorage.getItem('nbd_product_library')).items || []).find((p) => p.id === id),
  };
}

// A device's store the way the owner left it: one sell edit on a default,
// one custom product, one archived default, one hard delete.
function ownerDeviceStorage() {
  const env = boot({ docs: {}, fs: { failRead: true } }); // no cloud: just build a store
  const items = env.store().items;
  const t0 = items[0].createdAt;
  const later = '2026-09-28T12:00:00.000Z';
  const edited = items.find((p) => p.id === 'shingle_001');
  edited.pricing.better.sell = 999; edited.pricing.better.cost = 111; edited.labor = { perUnit: 7 }; edited.updatedAt = later;
  const archived = items.find((p) => p.id === 'under_001'); archived.isActive = false; archived.updatedAt = later;
  items.push({ id: 'prod_zzqa_1', name: 'ZZ_QA Custom Vent', category: 'roofing_ventilation', unit: 'EA', pricing: { good: { sell: 50, cost: 20 }, better: { sell: 60 }, best: { sell: 70 } }, labor: { perUnit: 5 }, createdAt: later, updatedAt: later, isActive: true });
  const kept = items.filter((p) => p.id !== 'flash_002');
  return { storage: { nbd_product_library: JSON.stringify({ _v: DATA_VERSION, items: kept, _deleted: ['flash_002'] }) }, t0 };
}

(async () => {
  console.log('\n1. An editor with no company library adopts this device\'s edits once');
  const owner = ownerDeviceStorage();
  const docs = {};
  const a = boot({ docs, storage: owner.storage });
  await a.settle();
  const lib = docs[LIB_PATH];
  ok('the company library doc was created', !!lib && !!lib.items);
  ok('it holds only the delta (edited + archived + custom), not the 276-row catalog',
    lib && Object.keys(lib.items).sort().join(',') === 'prod_zzqa_1,shingle_001,under_001', lib && Object.keys(lib.items).join(','));
  ok('the hard delete travels as a tombstone', lib && JSON.stringify(lib.deleted) === '["flash_002"]');
  const json = JSON.stringify(lib || {});
  ok('no cost and no labor in the doc (they stay in catalogCosts)', !/"cost"\s*:/.test(json) && !/"labor"\s*:/.test(json), json.slice(0, 200));
  ok('the edited sell price is in it', lib && lib.items.shingle_001.pricing.better.sell === 999);
  const reads = a.fsStub.__st.reads.filter((p) => p === LIB_PATH).length;
  await a.lib.hydrateCompany();
  ok('adoption runs once (a second hydrate does not re-read or re-write)', a.fsStub.__st.reads.filter((p) => p === LIB_PATH).length === reads);

  console.log('\n2. A fresh device (what every sign-out leaves) gets the company\'s edits back');
  const b = boot({ docs, uid: 'u_admin' });
  await b.settle();
  ok('the custom product is back', !!b.byId('prod_zzqa_1') && b.byId('prod_zzqa_1').name === 'ZZ_QA Custom Vent');
  ok('the edited sell price is back', b.byId('shingle_001').pricing.better.sell === 999);
  ok('the archived product stays archived', b.byId('under_001').isActive === false);
  ok('the hard-deleted product stays gone', !b.byId('flash_002') && b.store()._deleted.indexOf('flash_002') !== -1);
  ok('untouched defaults are still the published rows', !!b.byId('flash_003') && b.byId('flash_003').updatedAt === b.byId('flash_003').createdAt);
  ok('getProducts (the classic builder / Close Board source) carries the edit',
    b.lib.getProducts().find((p) => p.id === 'shingle_001').pricing.better.sell === 999);

  console.log('\n3. Costs come from the cost book, not the library');
  const docs3 = JSON.parse(JSON.stringify(docs));
  docs3['catalogCosts/' + TENANT] = { version: 1, costs: { shingle_001: { cost: { good: 70, better: 111, best: 150 }, labor: { perUnit: 7 } } } };
  const c = boot({ docs: docs3 });
  await c.settle();
  ok('an edited product on a fresh device gets its cost filled from the book', c.byId('shingle_001').pricing.better.cost === 111, JSON.stringify(c.byId('shingle_001').pricing.better));
  ok('...and its labor', c.byId('shingle_001').labor && c.byId('shingle_001').labor.perUnit === 7);

  console.log('\n4. An editor\'s save / archive / delete / reset reach the company doc');
  const d = boot({ docs });
  await d.settle();
  const p = JSON.parse(JSON.stringify(d.lib.getProducts().find((x) => x.id === 'flash_003')));
  p.pricing.good.sell = 4.25; p.pricing.good.cost = 1.5;
  d.lib.save(p);
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  ok('a saved edit lands as items.flash_003', docs[LIB_PATH].items.flash_003 && docs[LIB_PATH].items.flash_003.pricing.good.sell === 4.25);
  ok('...without its cost', docs[LIB_PATH].items.flash_003 && docs[LIB_PATH].items.flash_003.pricing.good.cost === undefined);
  ok('...other rows untouched', docs[LIB_PATH].items.shingle_001.pricing.better.sell === 999);
  d.lib.delete('flash_004');
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  ok('archive lands (isActive false)', docs[LIB_PATH].items.flash_004 && docs[LIB_PATH].items.flash_004.isActive === false);
  d.lib.hardDelete('prod_zzqa_1');
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  ok('hard delete tombstones it and clears the row', docs[LIB_PATH].deleted.indexOf('prod_zzqa_1') !== -1 && docs[LIB_PATH].items.prod_zzqa_1 === null);
  d.win.nbdConfirm = () => Promise.resolve(true);
  await d.lib.resetDefaults();
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  ok('reset empties the company delta', JSON.stringify(docs[LIB_PATH].items) === '{}' && JSON.stringify(docs[LIB_PATH].deleted) === '[]');

  console.log('\n5. A sales rep reads the library but cannot change it');
  const repDocs = { [LIB_PATH]: { version: 1, items: { prod_zzqa_2: { id: 'prod_zzqa_2', name: 'ZZ_QA Rep Sees This', category: 'roofing_ventilation', unit: 'EA', pricing: { good: { sell: 5 }, better: { sell: 6 }, best: { sell: 7 } }, isActive: true, createdAt: 'x', updatedAt: 'y' } }, deleted: [] } };
  const r = boot({ docs: repDocs, claims: { companyId: TENANT, role: 'sales_rep' }, uid: 'u_rep' });
  await r.settle();
  ok('canEdit is false for a rep', r.lib.canEdit() === false);
  ok('the rep sees the company\'s custom product', !!r.byId('prod_zzqa_2'));
  const html = r.lib.render();
  ok('no Add / Reset / Edit / Archive buttons for a rep',
    !/data-pl-action="(addProduct|resetDefaults|editProduct|archiveProduct)"/.test(html));
  ok('...a note says who can change it', /only the owner or an admin can change it/.test(html));
  ok('control: Export CSV is still offered', /data-pl-action="exportCSV"/.test(html));
  r.lib.openModal('flash_003');
  ok('opening the editor is refused with a toast', r.toasts.some((t) => /only the owner or an admin/.test(t.m)));
  const before = r.fsStub.__st.writes.length;
  await r.lib.archiveProduct('flash_003');
  ok('archive is refused (no write, product still active)', r.fsStub.__st.writes.length === before && r.byId('flash_003').isActive !== false);
  const adminHtml = d.lib.render();
  ok('control: an editor gets the buttons', /data-pl-action="addProduct"/.test(adminHtml) && /data-pl-action="editProduct"/.test(adminHtml));

  console.log('\n6. A failed read never adopts');
  const fdocs = {};
  const f = boot({ docs: fdocs, storage: owner.storage, fs: { failRead: true } });
  await f.settle();
  ok('no company doc written after a failed read', !fdocs[LIB_PATH]);
  ok('...and the device keeps its own edits', f.byId('shingle_001').pricing.better.sell === 999);

  console.log('\n7. A rep\'s device with local edits never uploads them');
  const rdocs = {};
  const rr = boot({ docs: rdocs, storage: owner.storage, claims: { companyId: TENANT, role: 'sales_rep' }, uid: 'u_rep' });
  await rr.settle();
  ok('no company doc created by a rep', !rdocs[LIB_PATH]);

  console.log('\n8. Rate sync (window.R, the classic builder\'s internal cost view) covers all five tiers');
  // Jo 2026-10-05: syncRatesFromProductLibrary knew good/better/best only, so
  // an Economy or Beyond estimate's internal cost view ran on DEFAULT_RATES.
  // It now reads estimate-config.js PRODUCT_TIER: Economy -> Good column,
  // Beyond -> Best. Synthetic sell prices per column on every product
  // PRODUCT_MAP reads, so each column gives a distinct rate and none equals a
  // DEFAULT_RATES value.
  const MAPPED = ['shingle_001', 'under_001', 'flash_008', 'flash_003', 'flash_007', 'under_006', 'flash_002'];
  const rateStorage = (() => {
    const env = boot({ docs: {}, fs: { failRead: true } });
    const items = env.store().items;
    MAPPED.forEach((id, i) => {
      const it = items.find((x) => x.id === id);
      it.pricing = { good: { sell: 1000 + i }, better: { sell: 2000 + i }, best: { sell: 3000 + i } };
      it.updatedAt = '2026-10-05T12:00:00.000Z';
    });
    return { nbd_product_library: JSON.stringify({ _v: DATA_VERSION, items, _deleted: [] }) };
  })();
  const KEYS = ['shingle', 'felt', 'starter', 'drip', 'ridge', 'iws', 'hip', 'pipe'];
  for (const withCfg of [true, false]) {
    const tag = withCfg ? '' : ' (estimate-config missing: inline fallback)';
    const e = boot({ docs: {}, storage: rateStorage, fs: { failRead: true }, estimateConfig: withCfg });
    await e.settle();
    const M = e.win.NBD_ESTIMATE_PRODUCT_MAP;
    const prods = e.lib.getProducts();
    // Expected = the column's synthetic sell x the map's unit conversion (inputs, not the function under test).
    const expect = (col) => { const o = {}; KEYS.forEach((k) => { o[k] = prods.find((x) => x.id === M[k].id).pricing[col].sell * M[k].unitConvert; }); return o; };
    const sync = (t) => { const r = e.win.syncRatesFromProductLibrary(t); const o = {}; KEYS.forEach((k) => { o[k] = r[k]; }); return o; };
    const tiers = withCfg ? Array.from(e.win.NBD_ESTIMATE_CONFIG.TIER_ORDER) : ['economy', 'good', 'better', 'best', 'beyond'];
    const byTier = {};
    tiers.forEach((t) => { byTier[t] = sync(t); });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok('control: the synthetic sells are in the library (Good shingle 1000)' + tag, prods.find((x) => x.id === 'shingle_001').pricing.good.sell === 1000);
    ok('all five tiers get synced rates, none left at DEFAULT_RATES' + tag,
      tiers.length === 5 && tiers.every((t) => KEYS.every((k) => byTier[t][k] >= 1000 * M[k].unitConvert)), JSON.stringify(byTier.economy));
    ok('good / better / best each still read their own column' + tag,
      same(byTier.good, expect('good')) && same(byTier.better, expect('better')) && same(byTier.best, expect('best')), JSON.stringify(byTier.better));
    ok('economy reads the Good column' + tag, same(byTier.economy, expect('good')), JSON.stringify(byTier.economy));
    ok('beyond reads the Best column' + tag, same(byTier.beyond, expect('best')), JSON.stringify(byTier.beyond));
    ok('window.R holds the last synced tier\'s rates' + tag, e.win.R.shingle === byTier.beyond.shingle);
    ok('unmapped keys keep their defaults on every tier' + tag,
      tiers.every((t) => { const r = e.win.syncRatesFromProductLibrary(t); return r.tear === 75 && r.deck === 145 && r.gutter === 8.5 && r.deckPct === 0.15; }));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
