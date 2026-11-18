/**
 * tests/price-change-devices-2026-11.test.js
 *
 * Slice 4 of the supplier price ledger (Jo, 2026-11-17), the device half of
 * approving a supplier price into the cost book (design section 6 step 8;
 * documentation/projects/LIVE-SUPPLIER-PRICING-SLICE-4-PLAN-2026-11-17.md):
 *
 *   - a product save writes only what changed in that save, one field path each
 *     (Jo's Q6), so a device holding an older cost can not write it back over an
 *     approved one; a name-only save writes nothing to the cost book
 *   - applyApprovedCost sets this device's cost without marking the product edited
 *   - noteApproved changes one path in this device's book and nothing the
 *     estimate engine reads (xactCost, jobItem, laborOp)
 *   - another device picks the approval up after its book loads, once, and only
 *     while the book still holds the approved value; with the flag off it never
 *     reads productLinks
 *
 * The real files run in a vm: product-data, roofivent-catalog, catalog-costs,
 * product-library, price-logic and price-ledger, over an in-memory Firestore.
 * Costs here are synthetic (multiples of 1111 once the point is removed).
 *
 * Run: node tests/price-change-devices-2026-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const SRC = ['product-data.js', 'roofivent-catalog.js', 'catalog-costs.js', 'product-library.js', 'price-logic.js', 'price-ledger.js']
  .map((f) => [f, fs.readFileSync(path.join(JS, f), 'utf8')]);
const CO = 'co_test';
const ID = 'shingle_001';
const clone = (v) => JSON.parse(JSON.stringify(v));
const DELETE = { __delete: true };

function makeStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

/** The Firestore surface catalog-costs.js and price-ledger.js use. updateDoc REPLACES at a dotted path; deleteField removes. */
function makeFs(docs, log) {
  const setPath = (o, dotted, v) => {
    const parts = dotted.split('.');
    for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
    if (v === DELETE) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = clone(v);
  };
  return {
    doc: (db, ...segs) => ({ __path: segs.join('/') }),
    getDoc: async (ref) => { const d = docs[ref.__path]; return { exists: () => !!d, id: ref.__path.split('/').pop(), data: () => (d ? clone(d) : null) }; },
    setDoc: async (ref, data) => { log.push('set:' + ref.__path); docs[ref.__path] = Object.assign({}, docs[ref.__path] || {}, clone(data)); },
    updateDoc: async (ref, paths) => {
      if (!docs[ref.__path]) { const e = new Error('No document to update'); e.code = 'not-found'; throw e; }
      log.push('update:' + ref.__path + ':' + Object.keys(paths).sort().join(','));
      const next = clone(docs[ref.__path]);
      Object.keys(paths).forEach((p) => setPath(next, p, paths[p]));
      docs[ref.__path] = next;
    },
    deleteField: () => DELETE,
  };
}

/**
 * One device. `book` is the company's cost book on the server; `local` is this
 * device's product store (an edited shingle_001 with its own, older numbers).
 */
function device(o) {
  const cfg = o || {};
  const docs = cfg.docs || {};
  const log = [];
  const win = {};
  win.window = win;
  const storage = makeStorage(cfg.storage);
  const reads = [];
  const fsStub = makeFs(docs, log);
  win._userClaims = { companyId: CO };
  win.db = {};
  win.__NBD_FS__ = fsStub;
  win.NBDFlags = { enabled: (f) => f === 'supplierPricing' && cfg.flag === true };
  win.collection = (db, ...segs) => ({ path: segs.join('/') });
  win.query = (c, ...mods) => ({ path: c.path, mods });
  win.where = (f, op, v) => ({ where: [f, op, v] });
  win.limit = (n) => ({ limit: n });
  win.orderBy = () => ({});
  win.doc = (db, ...segs) => ({ __path: segs.join('/') });
  win.getDoc = fsStub.getDoc;
  win.getDocs = async (q) => {
    reads.push(q.path);
    const ids = Object.keys(docs).filter((p) => p.indexOf(q.path + '/') === 0 && p.slice(q.path.length + 1).indexOf('/') === -1);
    return { docs: ids.map((p) => ({ id: p.split('/').pop(), data: () => clone(docs[p]) })) };
  };
  const sandbox = {
    window: win, localStorage: storage,
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } },
    console: { log() {}, warn() {}, error() {}, info() {} },
    Date, Math, JSON, Set, Map, Object, isFinite, setTimeout, navigator: {}, Promise,
  };
  win.localStorage = storage;
  win.addEventListener = () => {};
  vm.createContext(sandbox);
  for (const [f, src] of SRC) vm.runInContext(src, sandbox, { filename: f });
  return { win, docs, log, reads, storage, lib: win._productLib, cc: win.NBDCatalogCosts, pl: win.NBDPriceLedger,
    product: () => win._productLib.getProducts().find((p) => p.id === ID) };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

// The device's stored library: shingle_001 edited on this device (updatedAt differs), with its own older costs.
function editedStore(costs) {
  const win = {}; const sb = { window: win, console: { log() {} } };
  vm.runInNewContext(SRC[0][1], sb);
  const p = clone(win.NBD_PRODUCTS.find((x) => x.id === ID));
  ['good', 'better', 'best'].forEach((t) => { p.pricing[t].cost = costs[t]; });
  p.labor = { perUnit: 33.33 };
  p.createdAt = '2026-01-01T00:00:00.000Z'; p.updatedAt = '2026-02-02T00:00:00.000Z';
  return { nbd_product_library: JSON.stringify({ _v: 8, items: [p], _deleted: [] }) };
}
const BOOK = () => ({ costs: { [ID]: { cost: { good: 66.66, better: 77.77, best: 88.88 }, labor: { perUnit: 33.33 } }, other_001: { cost: { good: 11.11 } } },
  xactCosts: { TEST_CODE: { materialCost: 22.22, laborCost: 11.11 } }, laborOps: { op_x: { rate: 44.44, hoursPerUnit: 1, crewSize: 2 } } });

(async () => {
  console.log('\nA product save writes only what changed (Q6)');
  {
    const d = device({ docs: { ['catalogCosts/' + CO]: BOOK() }, storage: editedStore({ good: 55.55, better: 77.77, best: 88.88 }) });
    await d.cc.hydrate();
    d.log.length = 0;
    const p = clone(d.product());
    const before = clone(d.docs['catalogCosts/' + CO]);
    p.name = 'TEST renamed';
    d.lib.save(p);
    await settle();
    ok('a name-only save writes nothing to the cost book', d.log.filter((l) => l.indexOf('catalogCosts') !== -1).length === 0 && JSON.stringify(d.docs['catalogCosts/' + CO]) === JSON.stringify(before), d.log);
    ok('…so this device\'s older Good cost did not overwrite the newer one in the book', d.docs['catalogCosts/' + CO].costs[ID].cost.good === 66.66);

    const q = clone(d.product());
    q.pricing.better.cost = 99.99;
    d.lib.save(q);
    await settle();
    const after = d.docs['catalogCosts/' + CO];
    ok('changing one tier writes that one field path', d.log.some((l) => l === 'update:catalogCosts/' + CO + ':costs.' + ID + '.cost.better') && after.costs[ID].cost.better === 99.99, d.log);
    ok('the other tiers, labor and every other product are untouched', after.costs[ID].cost.good === 66.66 && after.costs[ID].cost.best === 88.88 && after.costs[ID].labor.perUnit === 33.33 && after.costs.other_001.cost.good === 11.11);

    const r = clone(d.product());
    delete r.pricing.best.cost;
    d.lib.save(r);
    await settle();
    ok('clearing a tier removes that tier from the book (deleteField), nothing else', !('best' in d.docs['catalogCosts/' + CO].costs[ID].cost) && d.docs['catalogCosts/' + CO].costs[ID].cost.better === 99.99);

    const s = clone(d.product());
    s.labor = { perUnit: 44.44 };
    d.lib.save(s);
    await settle();
    ok('changing labor writes costs.<id>.labor only', d.log.some((l) => l === 'update:catalogCosts/' + CO + ':costs.' + ID + '.labor') && d.docs['catalogCosts/' + CO].costs[ID].labor.perUnit === 44.44 && d.docs['catalogCosts/' + CO].costs[ID].cost.good === 66.66);
  }
  {
    const d = device({ docs: { ['catalogCosts/' + CO]: BOOK() } });
    await d.cc.hydrate();
    d.log.length = 0;
    d.lib.save({ name: 'TEST new product', category: 'roofing_shingles', unit: 'SQ', pricing: { good: { sell: 22.22, cost: 11.11 } } });
    await settle();
    ok('a new product (nothing before it) still writes its whole entry, as before', d.log.some((l) => /^update:catalogCosts\/co_test:costs\.prod_/.test(l)), d.log);
  }

  console.log('\nThis device shows an approval at once');
  {
    const d = device({ docs: { ['catalogCosts/' + CO]: BOOK() }, storage: editedStore({ good: 55.55, better: 77.77, best: 88.88 }) });
    await d.cc.hydrate();
    const stamp = d.product().updatedAt;
    const xBefore = JSON.stringify([d.cc.xactCost('TEST_CODE'), d.cc.laborOp('op_x'), d.cc.jobItem('jt-x-0')]);
    ok('applyApprovedCost sets the tier cost without marking the product edited', d.lib.applyApprovedCost(ID, 'good', 99.99) === true && d.product().pricing.good.cost === 99.99 && d.product().updatedAt === stamp);
    ok('noteApproved changes that one path in this device\'s book', d.cc.noteApproved(ID, 'good', 99.99) === true && d.cc.get().costs[ID].cost.good === 99.99 && d.cc.get().costs[ID].cost.better === 77.77 && d.cc.get().costs[ID].labor.perUnit === 33.33);
    ok('the estimate engine reads the same xactCost, laborOp and jobItem answers', JSON.stringify([d.cc.xactCost('TEST_CODE'), d.cc.laborOp('op_x'), d.cc.jobItem('jt-x-0')]) === xBefore);
    ok('null clears the tier (an undo of a tier the approval created)', d.lib.applyApprovedCost(ID, 'best', null) === true && d.product().pricing.best.cost === undefined);
  }

  console.log('\nAnother device picks the approval up');
  {
    const docs = { ['catalogCosts/' + CO]: BOOK() };
    docs['catalogCosts/' + CO].costs[ID].cost.good = 99.99;           // approved on the owner's phone
    docs['priceBook/' + CO + '/productLinks/' + ID] = { productId: ID, applied: { good: { atMs: 1700000000000, dollars: 99.99, auditId: 'a_1', undo: false } } };
    const d = device({ docs, flag: true, storage: editedStore({ good: 55.55, better: 77.77, best: 88.88 }) });
    await d.pl.syncApplied();
    ok('after its book loads, an edited product shows the approved cost', d.product().pricing.good.cost === 99.99, d.product().pricing);
    ok('the product is not marked edited by it', d.product().updatedAt === '2026-02-02T00:00:00.000Z');
    d.lib.applyApprovedCost(ID, 'good', 44.44);                        // a deliberate edit on this device afterwards
    const again = device({ docs, flag: true, storage: { nbd_product_library: d.storage.getItem('nbd_product_library'), ['nbd_pl_applied_' + CO]: d.storage.getItem('nbd_pl_applied_' + CO) } });
    await again.pl.syncApplied();
    ok('applied once: the next load keeps a later edit made on this device', again.product().pricing.good.cost === 44.44);
  }
  {
    const docs = { ['catalogCosts/' + CO]: BOOK() };                   // the book was edited after the approval: good is 66.66, not 99.99
    docs['priceBook/' + CO + '/productLinks/' + ID] = { productId: ID, applied: { good: { atMs: 1700000000000, dollars: 99.99, auditId: 'a_1', undo: false } } };
    const d = device({ docs, flag: true, storage: editedStore({ good: 55.55, better: 77.77, best: 88.88 }) });
    await d.pl.syncApplied();
    ok('an approval the book no longer holds is not applied', d.product().pricing.good.cost === 55.55);
  }
  {
    const docs = { ['catalogCosts/' + CO]: BOOK() };
    docs['priceBook/' + CO + '/productLinks/' + ID] = { productId: ID, applied: { good: { atMs: 1700000000000, dollars: 66.66, auditId: 'a_1', undo: false } } };
    const d = device({ docs, flag: false, storage: editedStore({ good: 55.55, better: 77.77, best: 88.88 }) });
    await d.pl.syncApplied();
    await settle();
    ok('with the flag off productLinks is never read and nothing changes', d.reads.every((p) => p.indexOf('productLinks') === -1) && d.product().pricing.good.cost === 55.55, d.reads);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
