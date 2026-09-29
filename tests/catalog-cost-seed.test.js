/**
 * tests/catalog-cost-seed.test.js
 *
 * The BEHAVIOUR half of the tenant-owned catalog cost model (the leak guard
 * itself lives in tests/catalog-cost-privacy.test.js):
 *
 *   1. Lossless split — for all 276 live SKUs, strip(full) === the published
 *      product and merge(published, book) === full. Byte-for-byte via
 *      JSON.stringify, so key ORDER is asserted too. This is what says the
 *      2026-07-30 migration moved data rather than dropping it.
 *   2. validateCostOverlay — the `sell >= cost > 0` invariant that used to
 *      live in tests/product-data.test.js, now enforced at extract and import
 *      time. Each failure mode gets a mutant.
 *   3. Client hydration — catalog-costs.js + product-library.js driven through
 *      window / localStorage / Firestore shims: warm path, cold path, the
 *      write-back on save, the one-time adoptLocal upgrade, and a rep whose
 *      write is refused by rules. applyCostSeed must preserve migrateStore's
 *      tombstone / user-edit / archive semantics and must NOT stamp updatedAt.
 *   4. "Cost not set" is a real state — a tenant that has entered no costs
 *      must never be shown a fabricated 100% margin. That fake 100% is the
 *      exact reason "just delete the cost fields" was the wrong fix.
 *
 * Pure-Node, no emulator. Run: node tests/catalog-cost-seed.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs', 'pro', 'js');
const {
  buildCostOverlay, extractProductCosts, stripProductCosts,
  validateCostOverlay, SEED_VERSION,
} = require(path.join(ROOT, 'functions', 'catalog-cost-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; fails.push(name + ': ' + e.message); }
}
function ok(cond, label) { if (!cond) throw new Error(label || 'assertion failed'); }
function eq(a, b, label) {
  if (a !== b) throw new Error((label || 'value') + ' = ' + JSON.stringify(a) + ' (expected ' + JSON.stringify(b) + ')');
}

const DATA_SRC  = fs.readFileSync(path.join(PRO_JS, 'product-data.js'), 'utf8');
const RIV_SRC   = fs.readFileSync(path.join(PRO_JS, 'roofivent-catalog.js'), 'utf8');
const COSTS_SRC = fs.readFileSync(path.join(PRO_JS, 'catalog-costs.js'), 'utf8');
const LIB_SRC   = fs.readFileSync(path.join(PRO_JS, 'product-library.js'), 'utf8');
const DATA_VERSION = Number((LIB_SRC.match(/const DATA_VERSION = (\d+);/) || [])[1]);

const TIERS = ['good', 'better', 'best'];
const CACHE_PREFIX = 'nbd_catalog_costs';
const TENANT = 'co_test';

function loadPublicCatalog() {
  const win = {};
  win.window = win;
  const sandbox = { window: win, Date, Math, JSON, Set, Object, console: { log() {} } };
  vm.runInNewContext(DATA_SRC, sandbox, { filename: 'product-data.js' });
  vm.runInNewContext(RIV_SRC, sandbox, { filename: 'roofivent-catalog.js' });
  return win.NBD_PRODUCTS;
}
const PUBLIC = loadPublicCatalog();

/**
 * Rebuild a plausible PRE-STRIP product: costs back inside each pricing tier,
 * labor appended. Deterministic (40% of sell) so assertions are readable and
 * no real figure is checked into the repo — the real ones live in the tenant's
 * Firestore book, which is the whole point.
 *
 * Do NOT floor this at 1: the catalog has sub-dollar SKUs (paint_004 sells at
 * 0.50/0.75) and zero-sell service lines (riv_warranty_cert), so a flat floor
 * produces sell < cost. validateCostOverlay caught exactly that while this
 * fixture was being written — the invariant doing its job.
 */
function synthCost(sell) {
  if (!(sell > 0)) return 0;                     // zero-sell SKUs are allowlisted
  return Math.max(0.01, Math.round(sell * 40) / 100);
}
function makeFull(p) {
  const full = JSON.parse(JSON.stringify(p));
  TIERS.forEach((t) => {
    if (full.pricing && full.pricing[t]) full.pricing[t].cost = synthCost(full.pricing[t].sell);
  });
  full.labor = { perUnit: 12, ratePerManHour: 35, crewSize: 2, hoursPerUnit: 0.35, overheadMultiplier: 1.1, profitMarginPct: 20 };
  return full;
}
const FULL = PUBLIC.map(makeFull);
const BOOK = buildCostOverlay(FULL);

/* ── shared harness ─────────────────────────────────────────────────────── */

function makeLocalStorage(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _keys: () => Array.from(store.keys()),
  };
}

/**
 * Minimal Firestore stub matching the surface catalog-costs.js uses:
 * doc(db, col, id), getDoc(ref).exists()/data(), setDoc(ref, data, {merge}),
 * updateDoc(ref, {'dotted.path': value}).
 *
 * It reproduces the two real semantics the code depends on:
 *   - setDoc(..., {merge:true}) DEEP-merges nested maps (this is what made a
 *     cleared cost un-deletable through setDoc alone), and
 *   - updateDoc with a dotted field path REPLACES the value at that path.
 * A stub that merged both the same way would have hidden the very bug the
 * dotted-path write exists to fix.
 *
 * `docs` is the backing store keyed 'col/id'. `denyWrite` simulates a rep
 * hitting the owner/company_admin-only rule.
 */
function deepMerge(prev, next) {
  const out = Object.assign({}, prev);
  Object.keys(next).forEach((k) => {
    const a = out[k], b = next[k];
    const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
    out[k] = (isMap(a) && isMap(b)) ? deepMerge(a, b) : b;
  });
  return out;
}

function makeFirestore(docs, opts) {
  const state = Object.assign({ denyWrite: false, reads: 0, writes: 0, failRead: false, noUpdateDoc: false }, opts || {});
  const guard = () => {
    if (state.denyWrite) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
  };
  const mod = {
    doc: (db, col, id) => ({ __path: col + '/' + id }),
    getDoc: async (ref) => {
      state.reads++;
      if (state.failRead) { const e = new Error('client is offline'); e.code = 'unavailable'; throw e; }
      const data = docs[ref.__path];
      return { exists: () => !!data, data: () => (data ? JSON.parse(JSON.stringify(data)) : null) };
    },
    setDoc: async (ref, data, options) => {
      guard();
      state.writes++;
      const prev = (options && options.merge && docs[ref.__path]) ? docs[ref.__path] : {};
      docs[ref.__path] = JSON.parse(JSON.stringify(deepMerge(prev, data)));
    },
    updateDoc: async (ref, paths) => {
      guard();
      const prev = docs[ref.__path];
      if (!prev) { const e = new Error('No document to update'); e.code = 'not-found'; throw e; }
      state.writes++;
      const next = JSON.parse(JSON.stringify(prev));
      Object.keys(paths).forEach((p) => {
        const parts = p.split('.');
        let cur = next;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = JSON.parse(JSON.stringify(paths[p])); // REPLACE
      });
      docs[ref.__path] = next;
    },
    __state: state,
  };
  if (state.noUpdateDoc) delete mod.updateDoc;
  return mod;
}

/**
 * Boot the real estimates-bundle order in one context:
 *   product-data → roofivent-catalog → catalog-costs → product-library
 */
function boot(o) {
  const cfg = o || {};
  const docs = cfg.docs || {};
  const win = {};
  win.window = win;
  const localStorage = makeLocalStorage(cfg.storage || {});
  const fsStub = makeFirestore(docs, cfg.fs);
  const sandbox = {
    window: win, localStorage,
    document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } },
    console: { log() {}, warn() {}, error() {}, info() {} },
    Date, Math, JSON, Set, Map, Object, isFinite, setTimeout, navigator: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(DATA_SRC, sandbox, { filename: 'product-data.js' });
  vm.runInContext(RIV_SRC, sandbox, { filename: 'roofivent-catalog.js' });
  // Tenant identity + Firestore, wired BEFORE catalog-costs.js so its
  // boot-time hydrate() exercises the real read path.
  win._userClaims = cfg.claims === undefined ? { companyId: TENANT } : cfg.claims;
  win.db = {};
  win.__NBD_FS__ = fsStub;
  vm.runInContext(COSTS_SRC, sandbox, { filename: 'catalog-costs.js' });
  vm.runInContext(LIB_SRC, sandbox, { filename: 'product-library.js' });
  return {
    win, localStorage, docs, fsStub, sandbox,
    readStore: () => JSON.parse(localStorage.getItem('nbd_product_library')),
    bookDoc: () => docs['catalogCosts/' + TENANT],
  };
}

/** Drive exportCSV() through the sandbox and hand back the generated CSV. */
function captureCsv(env) {
  let csv = null;
  env.sandbox.Blob = function (parts) { csv = String(parts[0]); };
  env.sandbox.URL = { createObjectURL: () => 'blob:test' };
  const origCreate = env.sandbox.document.createElement;
  env.sandbox.document.createElement = () => ({ style: {}, href: '', download: '', click() {} });
  try { env.win._productLib.exportCSV(); }
  finally { env.sandbox.document.createElement = origCreate; }
  return csv;
}

const warmCache = () => JSON.stringify(BOOK);
const cacheKey = CACHE_PREFIX + ':' + TENANT;

/* ── 1. lossless split ─────────────────────────────────────────────────── */

console.log('\ncatalog split is lossless (' + PUBLIC.length + ' SKUs)');
console.log('──────────────────────────────────────────────────');

test('strip(full) reproduces the published product exactly (key order included)', () => {
  const bad = [];
  FULL.forEach((f, i) => {
    if (JSON.stringify(stripProductCosts(f)) !== JSON.stringify(PUBLIC[i])) bad.push(f.id);
  });
  eq(bad.slice(0, 5).join(','), '', bad.length + ' product(s) do not round-trip through strip');
});

test('merge(published, book) reproduces the full product exactly', () => {
  // mergeInto lives in catalog-costs.js — the browser file — so the offline
  // split and the in-browser merge are proven inverses, not just individually
  // plausible.
  const cc = boot({ claims: null }).win.NBDCatalogCosts;
  const bad = [];
  PUBLIC.forEach((p, i) => {
    const restored = JSON.parse(JSON.stringify(p));
    cc.mergeInto(restored, BOOK.costs[p.id]);
    if (JSON.stringify(restored) !== JSON.stringify(FULL[i])) bad.push(p.id);
  });
  eq(bad.slice(0, 5).join(','), '', bad.length + ' product(s) do not round-trip through merge');
});

test('extractFrom is the inverse of mergeInto on a real product', () => {
  const cc = boot({ claims: null }).win.NBDCatalogCosts;
  const entry = cc.extractFrom(FULL[0]);
  eq(JSON.stringify(entry), JSON.stringify(BOOK.costs[FULL[0].id]));
});

test('extractProductCosts / extractFrom return null when nothing is private', () => {
  const cc = boot({ claims: null }).win.NBDCatalogCosts;
  eq(extractProductCosts(PUBLIC[0]), null);
  eq(cc.extractFrom(PUBLIC[0]), null);
});

test('book defaults are the MODAL labor policy, not a hardcoded pair', () => {
  eq(BOOK.defaults.overheadMultiplier, 1.1, 'overheadMultiplier');
  eq(BOOK.defaults.profitMarginPct, 20, 'profitMarginPct');
  eq(BOOK.version, SEED_VERSION, 'version');
});

/* ── 2. validation ─────────────────────────────────────────────────────── */

console.log('\nvalidateCostOverlay');
console.log('──────────────────────────────────────────────────');

const clone = (o) => JSON.parse(JSON.stringify(o));

test('the real book validates against the published catalog', () => {
  const { ok: good, errors } = validateCostOverlay(BOOK, PUBLIC);
  ok(good, errors.slice(0, 3).join(' | '));
});

test('MUTANT killed: a missing entry fails completeness', () => {
  const m = clone(BOOK);
  delete m.costs.shingle_001;
  const r = validateCostOverlay(m, PUBLIC);
  ok(!r.ok && r.errors.some((e) => e.startsWith('shingle_001:')), 'missing entry not reported');
});

test('MUTANT killed: cost 0 on a non-allowlisted SKU fails', () => {
  const m = clone(BOOK);
  m.costs.shingle_001.cost.good = 0;
  ok(!validateCostOverlay(m, PUBLIC).ok, 'zero cost accepted');
});

test('allowlisted zero-cost SKUs (acc_023, riv_warranty_cert) stay legal at 0', () => {
  const m = clone(BOOK);
  TIERS.forEach((t) => { m.costs.acc_023.cost[t] = 0; m.costs.riv_warranty_cert.cost[t] = 0; });
  const r = validateCostOverlay(m, PUBLIC);
  ok(r.ok, r.errors.slice(0, 3).join(' | '));
});

test('MUTANT killed: sell < cost fails (a tier priced below the buy)', () => {
  const m = clone(BOOK);
  const sell = PUBLIC.find((p) => p.id === 'shingle_001').pricing.good.sell;
  m.costs.shingle_001.cost.good = sell + 1;
  const r = validateCostOverlay(m, PUBLIC);
  ok(!r.ok && r.errors.some((e) => e.includes('sell') && e.includes('< cost')), 'sell<cost accepted');
});

test('MUTANT killed: a non-numeric cost fails', () => {
  const m = clone(BOOK);
  m.costs.shingle_001.cost.good = '82';
  ok(!validateCostOverlay(m, PUBLIC).ok, 'string cost accepted');
});

test('MUTANT killed: a wrong version fails', () => {
  const m = clone(BOOK);
  m.version = 99;
  ok(!validateCostOverlay(m, PUBLIC).ok, 'wrong version accepted');
});

test('MUTANT killed: an unknown labor key fails', () => {
  const m = clone(BOOK);
  m.costs.shingle_001.labor.secretMarkup = 3;
  ok(!validateCostOverlay(m, PUBLIC).ok, 'unknown labor key accepted');
});

test('shape-only mode (no catalog to compare against) still catches junk', () => {
  ok(validateCostOverlay(BOOK).ok, 'clean book rejected in shape-only mode');
  const m = clone(BOOK);
  m.costs.shingle_001.cost.good = null;
  ok(!validateCostOverlay(m).ok, 'null cost accepted in shape-only mode');
  ok(!validateCostOverlay({ version: SEED_VERSION }).ok, 'missing costs accepted');
});

/* ── 3. client hydration ───────────────────────────────────────────────── */

console.log('\nclient hydration (catalog-costs.js + product-library.js)');
console.log('──────────────────────────────────────────────────');

// ── warm device: cached book applied before the library seeds ────────────

{
  const w = boot({ storage: { [cacheKey]: warmCache() } });
  const store = w.readStore();
  const hdz = store.items.find((p) => p.id === 'shingle_001');

  test('WARM: cached costs reach window.NBD_PRODUCTS before product-library runs', () => {
    const cat = w.win.NBD_PRODUCTS.find((p) => p.id === 'shingle_001');
    eq(cat.pricing.good.cost, BOOK.costs.shingle_001.cost.good);
  });

  test('WARM: the freshly seeded store already carries costs and labor', () => {
    ok(hdz, 'shingle_001 missing from the seeded store');
    eq(hdz.pricing.good.cost, BOOK.costs.shingle_001.cost.good, 'good cost');
    eq(hdz.labor.perUnit, BOOK.costs.shingle_001.labor.perUnit, 'labor.perUnit');
  });

  test('WARM: Add-Product defaults come from the tenant book, not a hardcoded pair', () => {
    eq(w.win.NBDCatalogCosts.defaults().overheadMultiplier, 1.1);
    eq(w.win.NBDCatalogCosts.defaults().profitMarginPct, 20);
  });
}

// ── cold device with an existing tenant book ─────────────────────────────

(async () => {
  {
    const c = boot({ docs: { ['catalogCosts/' + TENANT]: clone(BOOK) } });

    test('COLD: no cache → neutral defaults and no cost until the book loads', () => {
      eq(c.win.NBDCatalogCosts.defaults().overheadMultiplier, 1, 'neutral overhead');
      eq(c.win.NBDCatalogCosts.defaults().profitMarginPct, 0, 'neutral margin');
      const seeded = c.readStore().items.find((p) => p.id === 'shingle_001');
      eq(seeded.pricing.good.cost, undefined, 'cost must not exist before the book loads');
    });

    const before = c.readStore().items.find((p) => p.id === 'shingle_001');
    await c.win.NBDCatalogCosts.hydrate();
    const after = c.readStore().items.find((p) => p.id === 'shingle_001');

    test('COLD: hydration reads the tenant book and patches the STORE in place', () => {
      eq(c.fsStub.__state.reads, 1, 'Firestore reads');
      eq(after.pricing.good.cost, BOOK.costs.shingle_001.cost.good, 'good cost');
      eq(after.labor.perUnit, BOOK.costs.shingle_001.labor.perUnit, 'labor.perUnit');
    });

    test('COLD: applyCostSeed does NOT stamp updatedAt (would freeze migrateStore forever)', () => {
      eq(after.updatedAt, before.updatedAt, 'updatedAt');
      eq(after.updatedAt, after.createdAt, 'updatedAt must still equal createdAt (untouched default)');
    });

    test('COLD: the book is cached per-tenant for the next load', () => {
      const cached = JSON.parse(c.localStorage.getItem(cacheKey));
      eq(Object.keys(cached.costs).length, Object.keys(BOOK.costs).length);
    });

    test('COLD: a tenant with a book does NOT re-upload its local store', () => {
      eq(c.fsStub.__state.writes, 0, 'adoptLocal must not fire when a book exists');
    });
  }

  // ── ownership semantics ────────────────────────────────────────────────

  {
    const seedRun = boot({ docs: { ['catalogCosts/' + TENANT]: clone(BOOK) } });
    await seedRun.win.NBDCatalogCosts.hydrate();
    const seeded = seedRun.readStore().items;

    const edited = Object.assign(JSON.parse(JSON.stringify(seeded.find((p) => p.id === 'shingle_001'))), {
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
    });
    edited.pricing.good.cost = 1; // the rep's REAL buy price
    delete edited.labor;

    const archived = Object.assign(JSON.parse(JSON.stringify(seeded.find((p) => p.id === 'shingle_003'))), {
      isActive: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    delete archived.pricing.good.cost;

    const custom = {
      id: 'prod_1700000000_joecap', name: 'Joe Custom Ridge Cap', category: 'roofing_flashing', unit: 'BDNL',
      pricing: { good: { sell: 50, cost: 20 }, better: { sell: 60, cost: 25 }, best: { sell: 75, cost: 30 } },
      isActive: true, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    };

    const untouched = JSON.parse(JSON.stringify(seeded.find((p) => p.id === 'shingle_002')));
    delete untouched.pricing.good.cost;
    delete untouched.labor;

    const storeJson = JSON.stringify({
      _v: DATA_VERSION, items: [edited, archived, custom, untouched], _deleted: ['shingle_004'],
    });

    const r = boot({
      storage: { nbd_product_library: storeJson },
      docs: { ['catalogCosts/' + TENANT]: clone(BOOK) },
    });
    await r.win.NBDCatalogCosts.hydrate();
    const out = new Map(r.readStore().items.map((p) => [p.id, p]));

    test('OWNERSHIP: an untouched default IS patched', () => {
      eq(out.get('shingle_002').pricing.good.cost, BOOK.costs.shingle_002.cost.good);
    });

    test('OWNERSHIP: a user-EDITED default keeps its own cost (book must not overwrite)', () => {
      eq(out.get('shingle_001').pricing.good.cost, 1, 'the rep\'s buy price was overwritten');
      eq(out.get('shingle_001').labor, undefined, 'labor was pushed onto a user-edited product');
    });

    test('OWNERSHIP: a user-ARCHIVED default is left verbatim', () => {
      eq(out.get('shingle_003').isActive, false, 'archive flag');
      eq(out.get('shingle_003').pricing.good.cost, undefined, 'archived copy was modified');
    });

    test('OWNERSHIP: a user-CREATED product is untouched (no book entry exists)', () => {
      eq(out.get('prod_1700000000_joecap').pricing.good.cost, 20);
    });

    test('OWNERSHIP: a tombstoned id is not resurrected by hydration', () => {
      ok(!out.has('shingle_004'), 'shingle_004 came back');
      ok(r.readStore()._deleted.includes('shingle_004'), '_deleted tombstone dropped');
    });

    test('OWNERSHIP: a second applyCostSeed pass is a no-op', () => {
      eq(r.win._productLib.applyCostSeed(BOOK), 0);
    });
  }

  // ── the one-time upgrade: local costs are lifted into the tenant book ───

  {
    // A pre-migration tenant: costs live only in this device's localStorage.
    const legacyItems = PUBLIC.slice(0, 5).map((p) => {
      const full = makeFull(p);
      full.createdAt = '2026-01-01T00:00:00.000Z';
      full.updatedAt = '2026-01-01T00:00:00.000Z';
      return full;
    });
    const legacyStore = JSON.stringify({ _v: DATA_VERSION, items: legacyItems, _deleted: [] });

    const up = boot({ storage: { nbd_product_library: legacyStore }, docs: {} });
    await up.win.NBDCatalogCosts.hydrate();

    test('UPGRADE: a tenant with no book has its local costs adopted', () => {
      const doc = up.bookDoc();
      ok(doc, 'no cost book was written');
      eq(Object.keys(doc.costs).length, 5, 'adopted entry count');
      eq(doc.costs.shingle_001.cost.good, synthCost(PUBLIC[0].pricing.good.sell), 'adopted cost value');
    });

    test('UPGRADE: adoption runs once — a second hydrate does not re-write', () => {
      const writesAfterFirst = up.fsStub.__state.writes;
      eq(writesAfterFirst, 1, 'expected exactly one adoption write');
    });

    // A FAILED read must never look like "this tenant has no costs".
    const flaky = boot({ storage: { nbd_product_library: legacyStore }, docs: {}, fs: { failRead: true } });
    await flaky.win.NBDCatalogCosts.hydrate();

    test('UPGRADE: a FAILED book read never triggers adoption (no half-empty upload)', () => {
      eq(flaky.fsStub.__state.writes, 0, 'adoptLocal fired on a failed read');
      eq(flaky.win.NBDCatalogCosts.isLoaded(), false, 'loaded must stay false after a failed read');
    });

    // A brand-new tenant has no local costs either — nothing to adopt.
    const fresh = boot({ docs: {} });
    await fresh.win.NBDCatalogCosts.hydrate();

    test('UPGRADE: a brand-new tenant writes nothing and gets no costs', () => {
      eq(fresh.fsStub.__state.writes, 0, 'wrote a book for a tenant with no costs');
      eq(fresh.bookDoc(), undefined, 'cost book created from nothing');
      const p = fresh.readStore().items.find((x) => x.id === 'shingle_001');
      eq(p.pricing.good.cost, undefined, 'a new tenant must have NO cost, not zero');
    });
  }

  // ── write-back on save ─────────────────────────────────────────────────

  {
    const w = boot({ docs: { ['catalogCosts/' + TENANT]: clone(BOOK) } });
    await w.win.NBDCatalogCosts.hydrate();
    const before = w.fsStub.__state.writes;

    const p = JSON.parse(JSON.stringify(w.readStore().items.find((x) => x.id === 'shingle_001')));
    p.pricing.good.cost = 77;
    w.win._productLib.save(p);
    await new Promise((r) => setTimeout(r, 0));

    test('SAVE: an owner edit is pushed to the company cost book', () => {
      ok(w.fsStub.__state.writes > before, 'no write was issued');
      eq(w.bookDoc().costs.shingle_001.cost.good, 77, 'edited cost did not reach the book');
    });

    test('SAVE: the per-SKU write leaves other SKUs in the book intact', () => {
      eq(Object.keys(w.bookDoc().costs).length, Object.keys(BOOK.costs).length,
         'a full-replace write would have dropped the other SKUs');
      eq(w.bookDoc().costs.shingle_002.cost.good, BOOK.costs.shingle_002.cost.good);
    });

    test('SAVE: recording a product does NOT rewrite the company-wide defaults', () => {
      // A single SKU's labor policy is not evidence of the company's policy.
      // recordProduct used to push it up as `defaults`, so editing one
      // pass-through line item reset the Add-Product prefill for every rep.
      eq(w.bookDoc().defaults.overheadMultiplier, BOOK.defaults.overheadMultiplier);
      eq(w.bookDoc().defaults.profitMarginPct, BOOK.defaults.profitMarginPct);
    });
  }

  // ── clearing a cost must actually delete it from the tenant book ────────
  // Firestore's {merge:true} DEEP-merges nested maps, so a plain setDoc could
  // only ever add or change a cost, never remove one: the cleared tier kept
  // its old number in Firestore and resurrected on the tenant's next device.

  {
    const c = boot({ docs: { ['catalogCosts/' + TENANT]: clone(BOOK) } });
    await c.win.NBDCatalogCosts.hydrate();

    const p = JSON.parse(JSON.stringify(c.readStore().items.find((x) => x.id === 'shingle_001')));
    delete p.pricing.good.cost;               // the user cleared the Good cost box
    p.pricing.better.cost = 99;
    c.win._productLib.save(p);
    await new Promise((r) => setTimeout(r, 0));

    test('CLEAR: a cleared tier cost is REMOVED from the tenant book, not just locally', () => {
      const entry = c.bookDoc().costs.shingle_001;
      eq(entry.cost.good, undefined, 'the cleared Good cost survived in Firestore');
      eq(entry.cost.better, 99, 'the edited Better cost did not land');
    });

    test('CLEAR: clearing one SKU does not disturb any other SKU', () => {
      eq(c.bookDoc().costs.shingle_002.cost.good, BOOK.costs.shingle_002.cost.good);
      eq(Object.keys(c.bookDoc().costs).length, Object.keys(BOOK.costs).length);
    });

    // The dotted-path write needs updateDoc; an SDK without it must still work.
    const legacy = boot({ docs: {}, fs: { noUpdateDoc: true } });
    await legacy.win.NBDCatalogCosts.hydrate();
    const q = JSON.parse(JSON.stringify(legacy.readStore().items.find((x) => x.id === 'shingle_001')));
    q.pricing.good.cost = 5;
    legacy.win._productLib.save(q);
    await new Promise((r) => setTimeout(r, 0));

    test('CLEAR: falls back to setDoc when the doc does not exist yet', () => {
      ok(legacy.bookDoc(), 'no book was created on the first write');
      eq(legacy.bookDoc().costs.shingle_001.cost.good, 5);
    });
  }

  // ── a stale labor block from the pre-strip catalog must be replaced ─────

  {
    // A device whose store was written at the CURRENT DATA_VERSION from the
    // old public catalog: it carries the leaked labor policy, and migrateStore
    // will never re-run to clear it.
    const stale = PUBLIC.slice(0, 3).map((p) => {
      const item = JSON.parse(JSON.stringify(p));
      item.labor = { perUnit: 75, ratePerManHour: 35, crewSize: 4, hoursPerUnit: 0.5, overheadMultiplier: 1.35, profitMarginPct: 25 };
      item.createdAt = '2026-07-29T00:00:00.000Z';
      item.updatedAt = '2026-07-29T00:00:00.000Z'; // untouched default
      return item;
    });
    const staleStore = JSON.stringify({ _v: DATA_VERSION, items: stale, _deleted: [] });

    const s = boot({
      storage: { nbd_product_library: staleStore },
      docs: { ['catalogCosts/' + TENANT]: clone(BOOK) },
    });
    await s.win.NBDCatalogCosts.hydrate();
    const out = s.readStore().items.find((x) => x.id === 'shingle_001');

    test('STALE LABOR: the tenant\'s own labor policy REPLACES the leaked one', () => {
      eq(out.labor.overheadMultiplier, BOOK.costs.shingle_001.labor.overheadMultiplier,
         'the leaked overheadMultiplier survived on this device');
      eq(out.labor.profitMarginPct, BOOK.costs.shingle_001.labor.profitMarginPct,
         'the leaked profitMarginPct survived on this device');
      eq(out.labor.perUnit, BOOK.costs.shingle_001.labor.perUnit, 'labor.perUnit');
    });

    test('STALE LABOR: replacing it still does not stamp updatedAt', () => {
      eq(out.updatedAt, out.createdAt);
    });
  }

  // ── a rep whose write rules refuse ─────────────────────────────────────

  {
    const rep = boot({ docs: { ['catalogCosts/' + TENANT]: clone(BOOK) }, fs: { denyWrite: true } });
    await rep.win.NBDCatalogCosts.hydrate();

    const p = JSON.parse(JSON.stringify(rep.readStore().items.find((x) => x.id === 'shingle_001')));
    p.pricing.good.cost = 55;
    rep.win._productLib.save(p);
    await new Promise((r) => setTimeout(r, 0));

    test('REP: a permission-denied cost write does not throw or lose the local edit', () => {
      const local = rep.readStore().items.find((x) => x.id === 'shingle_001');
      eq(local.pricing.good.cost, 55, 'the rep\'s local edit was lost');
      eq(rep.bookDoc().costs.shingle_001.cost.good, BOOK.costs.shingle_001.cost.good,
         'a rep must not be able to rewrite the company book');
    });
  }

  // ── offline / signed-out ───────────────────────────────────────────────

  {
    const off = boot({ docs: {}, fs: { failRead: true } });
    const result = await off.win.NBDCatalogCosts.hydrate();
    const store = off.readStore();

    test('OFFLINE: a failed read resolves instead of throwing', () => {
      eq(result, null);
    });
    test('OFFLINE: the product library still seeded the full catalog (sell-only)', () => {
      ok(store.items.length >= 260, 'seeded ' + store.items.length);
      eq(store.items.find((p) => p.id === 'shingle_001').pricing.good.sell, 240);
    });

    const anon = boot({ claims: null, docs: {} });
    test('SIGNED OUT: with no tenant key, nothing is read, written or cached', async () => {
      await anon.win.NBDCatalogCosts.hydrate();
      eq(anon.fsStub.__state.reads, 0, 'reads');
      eq(anon.fsStub.__state.writes, 0, 'writes');
    });
  }

  /* ── 4. "cost not set" must never render as a margin ─────────────────── */

  console.log('\n"cost not set" is a real state, not zero');
  console.log('──────────────────────────────────────────────────');

  {
    const fresh = boot({ docs: {} });
    await fresh.win.NBDCatalogCosts.hydrate();
    const html = fresh.win._productLib.render();
    const stats = fresh.win._productLib.getStats();

    test('NEW TENANT: getStats reports avgMargin null, not 0 and not 100', () => {
      eq(stats.avgMargin, null, 'avgMargin');
      eq(stats.priced, 0, 'priced count');
      ok(stats.total >= 260, 'total ' + stats.total);
    });

    test('NEW TENANT: the rendered library never claims a margin it was not given', () => {
      // Margin-shaped output only — a bare /100%/ also matches `width:100%`.
      ok(!/Profit \d+%/.test(html), 'a per-tier Profit % was rendered with no cost set');
      ok(!/\(\d+%\)/.test(html), 'a gross-profit (n%) was rendered with no cost set');
      ok(!/>\s*\d+%\s*</.test(html), 'a bare n% stat was rendered with no cost set');
      ok(/Profit —/.test(html), 'tiers should read "Profit —" when cost is unset');
    });

    test('a one-color product reads "1 color", not "1 colors" (2026-09-28)', () => {
      ok(!/🎨 1 colors</.test(html), '"1 colors" rendered');
      ok(/🎨 1 color</.test(html), 'no one-color product rendered (fixture changed?)');
      ok(/🎨 [2-9]\d* colors</.test(html), 'control: a many-color product should still say "colors"');
    });

    test('NEW TENANT: the library says the costs are not set', () => {
      ok(/not set/i.test(html), 'no "not set" affordance rendered');
      ok(/Your costs aren't set yet/.test(html), 'no empty-state banner');
    });

    test('NEW TENANT: retail sell still renders (the catalog is not broken)', () => {
      ok(html.includes('$240'), 'shingle_001 sell price missing from the render');
    });

    test('NEW TENANT: CSV export leaves cost cells EMPTY rather than 0', () => {
      // A spreadsheet full of zero costs reads as a 100% margin downstream.
      const csv = captureCsv(fresh);
      ok(csv, 'no CSV was generated');
      const line = csv.split('\n').find((l) => l.startsWith('"GAF Timberline HDZ"'));
      ok(line, 'HDZ row missing from the CSV');
      ok(/"240","",/.test(line), 'cost cell should be empty, got: ' + line.slice(0, 90));
    });
  }

  {
    // A tenant with a book must still show real margins — proves the empty
    // state isn't just "margins are broken now".
    const priced = boot({ storage: { [cacheKey]: warmCache() }, docs: { ['catalogCosts/' + TENANT]: clone(BOOK) } });
    await priced.win.NBDCatalogCosts.hydrate();
    const html = priced.win._productLib.render();
    const stats = priced.win._productLib.getStats();

    test('PRICED TENANT: avgMargin is a real number and the banner is gone', () => {
      ok(typeof stats.avgMargin === 'number', 'avgMargin = ' + stats.avgMargin);
      ok(stats.avgMargin > 0 && stats.avgMargin < 100, 'implausible avgMargin ' + stats.avgMargin);
      ok(!/Your costs aren't set yet/.test(html), 'empty-state banner shown to a priced tenant');
    });

    test('PRICED TENANT: My Cost renders a figure', () => {
      ok(/My Cost: \$/.test(html), 'My Cost chip missing');
    });
  }

  // ── the below-cost guard must still fire when only LABOR is known ───────
  // A new tenant's most common state is exactly this: material cost blank,
  // labor filled in. Skipping the check for a blank cost box made the app's
  // only below-cost warning unreachable for a tier that is provably underwater
  // on labor alone.

  {
    const env = boot({ docs: {} });
    await env.win.NBDCatalogCosts.hydrate();

    // Drive saveFromModal through a DOM shim so the real guard runs.
    function trySave(fields) {
      const vals = Object.assign({
        'pm-name': 'Test SKU', 'pm-manufacturer': '', 'pm-category': 'roofing_shingles',
        'pm-unit': 'SQ', 'pm-sku': '', 'pm-description': '', 'pm-warranty': '',
        'pm-defaultqty': '1', 'pm-notes': '', 'pm-colors': '', 'pm-tags': '',
        'pm-sell-good': '0', 'pm-sell-better': '0', 'pm-sell-best': '0',
        'pm-cost-good': '', 'pm-cost-better': '', 'pm-cost-best': '',
        'pm-labor-perunit': '0', 'pm-labor-rate': '0', 'pm-labor-crew': '0',
        'pm-labor-hours': '0', 'pm-labor-overhead': '', 'pm-labor-profit': '',
      }, fields);
      let asked = null;
      env.sandbox.document.getElementById = (id) => (id in vals ? { value: vals[id] } : null);
      env.win.nbdConfirm = (msg) => { asked = msg; return Promise.resolve(false); }; // decline -> abort
      return env.win._productLib.saveFromModal().then(() => asked);
    }

    const underwaterOnLabor = await trySave({ 'pm-sell-good': '40', 'pm-labor-perunit': '65' });
    const healthy = await trySave({ 'pm-sell-good': '300', 'pm-labor-perunit': '65' });
    const nothingKnown = await trySave({ 'pm-sell-good': '40' });

    test('BELOW COST: warns when labor alone exceeds sell and material cost is blank', () => {
      ok(underwaterOnLabor, 'no warning was raised for a tier underwater on labor alone');
      ok(/labor alone/.test(underwaterOnLabor), 'warning should name the labor-only case: ' + underwaterOnLabor);
    });

    test('BELOW COST: a healthy tier is not warned about', () => {
      eq(healthy, null);
    });

    test('BELOW COST: a tier with NEITHER cost nor labor known is not guessed at', () => {
      eq(nothingKnown, null);
    });
  }

  // ── the estimate engine must not go NaN when costs are absent ──────────
  // resolveMaterial did `Number(tierPricing.cost)`. With cost absent — which
  // is now the NORMAL state for a tenant that hasn't entered costs — that is
  // NaN, and NaN propagates silently through every downstream total.

  {
    function buildEngine(withCosts) {
      const win = {};
      win.window = win;
      const sb = { window: win, Date, Math, JSON, Set, Object, isFinite, console: { log() {}, warn() {}, error() {} } };
      vm.createContext(sb);
      ['product-data.js', 'roofivent-catalog.js'].forEach((f) =>
        vm.runInContext(fs.readFileSync(path.join(PRO_JS, f), 'utf8'), sb, { filename: f }));
      if (withCosts) win.NBD_PRODUCTS.forEach((p) => TIERS.forEach((t) => {
        if (p.pricing && p.pricing[t]) p.pricing[t].cost = synthCost(p.pricing[t].sell);
      }));
      ['estimate-labor-catalog.js', 'estimate-logic-engine.js'].forEach((f) =>
        vm.runInContext(fs.readFileSync(path.join(PRO_JS, f), 'utf8'), sb, { filename: f }));
      return win.EstimateLogic;
    }

    const cold = buildEngine(false).resolveMaterial('shingle_001', 'better');
    const warm = buildEngine(true).resolveMaterial('shingle_001', 'better');

    test('ENGINE: resolveMaterial returns cost 0 (never NaN) when costs are unset', () => {
      ok(!Number.isNaN(cold.cost), 'cost is NaN — it would poison every downstream total');
      eq(cold.cost, 0, 'cold cost');
      eq(cold.sell, 275, 'sell must still resolve from the public catalog');
    });

    test('ENGINE: resolveMaterial returns the real cost once the book is merged', () => {
      eq(warm.cost, synthCost(275), 'warm cost');
    });
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exitCode = 1; }
})();
