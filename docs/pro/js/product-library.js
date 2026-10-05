/**
 * NBD Pro - Product Library v2
 * Full CRUD system consuming window.NBD_PRODUCTS / NBD_CATEGORIES from product-data.js
 * Stores user edits in localStorage under 'nbd_product_library'
 *
 * COST DATA (2026-07-30): product-data.js publishes spec + retail `sell` only —
 * it is served unauthenticated from a public repo. Wholesale `cost` and the
 * `labor` block are TENANT-OWNED: they live in this company's own cost book at
 * catalogCosts/{companyId} and are merged in by catalog-costs.js. See that
 * file's header for the load-order reasoning, and applyCostSeed() below.
 *
 * Nothing else about this store changed: localStorage is still the storage
 * layer, and the DATA_VERSION / tombstone / user-edit semantics documented on
 * migrateStore() are unchanged.
 *
 * A tenant that has not entered costs has NO cost — `undefined`, not 0. See
 * hasCost() / marginKnown(): every margin surface renders "not set" rather
 * than the 100% a zero cost would imply.
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'nbd_product_library';
  // DATA_VERSION 4 (2026-07-19): catalog expanded with repair-scale,
  // chimney, skylight, gutter-guard, maintenance, and exterior SKUs
  // (188 base + 88 RoofIVent = 276). v4 also replaces the old
  // wipe-on-mismatch reseed with migrateStore(), which merges fresh
  // defaults with the user's created/edited products.
  // DATA_VERSION 5 (2026-07-29): labor_008 Building Permit Fee description/
  // notes neutralized — the seed text named Hamilton County / Cincinnati on
  // every tenant's product library (NBD-leak audit remnant). migrateStore
  // lands the fix while preserving user-edited copies.
  const DATA_VERSION = 5;

  // Pull from product-data.js globals
  const CATEGORIES = window.NBD_CATEGORIES || {};
  const UNITS = window.NBD_UNITS || {};
  const DEFAULT_PRODUCTS = window.NBD_PRODUCTS || [];

  const TIERS = ['good', 'better', 'best'];
  const TIER_LABELS = { good: 'Good', better: 'Better', best: 'Best' };
  const TIER_COLORS = { good: '#6b7280', better: '#3b82f6', best: '#BD5728' };

  // ============================================================================
  // STATE
  // ============================================================================

  let products = [];
  // Store-level tombstones: ids the user HARD-deleted. Persisted as _deleted
  // in the store so migrateStore never resurrects them from fresh defaults.
  let deletedIds = [];
  let editingProduct = null;
  let currentFilter = { search: '', category: null, tier: null };
  let collapsedCategories = {}; // track which categories are collapsed

  // ============================================================================
  // STORAGE
  // ============================================================================

  function loadProducts() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        deletedIds = Array.isArray(parsed._deleted) ? parsed._deleted : [];
        if (parsed._v === DATA_VERSION) {
          products = parsed.items || [];
        } else {
          migrateStore(Array.isArray(parsed.items) ? parsed.items : []);
        }
      } else {
        seedDefaults();
      }
    } catch (e) {
      console.error('Product library load error:', e);
      seedDefaults();
    }
    return products;
  }

  function seedDefaults() {
    const now = new Date().toISOString();
    products = DEFAULT_PRODUCTS.map(p => ({ ...p, createdAt: now, updatedAt: now }));
    deletedIds = []; // explicit reset restores everything, tombstones included
    saveAll();
  }

  // Version-mismatch migration. Constraints (MUST NOT wipe user data —
  // the pre-v4 reseed did):
  //  - ids in _deleted tombstones = user hard-deleted → never resurrect
  //  - stored ids NOT in fresh defaults = user-created → keep verbatim
  //  - stored default ids with updatedAt !== createdAt = user-edited
  //    (seedDefaults stamps them equal; only saveProduct/deleteProduct bump
  //    updatedAt) → stored copy wins over the fresh default
  //  - stored default ids with isActive === false = user-archived → keep
  //    verbatim even if timestamps are equal (covers stores archived before
  //    deleteProduct stamped updatedAt)
  //  - everything else → fresh default, so new SKUs and data fixes land
  function migrateStore(storedItems) {
    const now = new Date().toISOString();
    const tombstoned = new Set(deletedIds);
    const byId = new Map();
    DEFAULT_PRODUCTS.forEach(p => {
      if (tombstoned.has(p.id)) return;
      byId.set(p.id, { ...p, createdAt: now, updatedAt: now });
    });
    storedItems.forEach(p => {
      if (!p || !p.id || tombstoned.has(p.id)) return;
      if (!byId.has(p.id) || (p.updatedAt && p.updatedAt !== p.createdAt) || p.isActive === false) byId.set(p.id, p);
    });
    products = Array.from(byId.values());
    saveAll();
  }

  // Merge the PRIVATE cost overlay into an already-seeded store.
  //
  // product-data.js no longer ships wholesale cost or the labor block — they
  // live in this company's own cost book and are merged by
  // catalog-costs.js. On a device that has hydrated before, that merge lands
  // on window.NBD_PRODUCTS BEFORE this file runs, so seedDefaults/migrateStore
  // never see a difference. This is the cold-device path: the store was
  // already written from a sell-only catalog and has to be patched in place.
  //
  // It reuses migrateStore's ownership rules verbatim — anything else would
  // overwrite a rep's real numbers with the factory ones:
  //   - tombstoned ids            → never touched (they are gone on purpose)
  //   - user-created products     → no overlay entry exists; skipped
  //   - user-EDITED defaults      → updatedAt !== createdAt; their costs win
  //   - user-ARCHIVED defaults    → isActive === false; kept verbatim
  //   - untouched defaults        → patched
  //
  // It deliberately does NOT stamp updatedAt. Doing so would mark every
  // product user-edited, and migrateStore would then refuse to land any future
  // catalog fix on any of them — permanently. Cost hydration is not an edit.
  function applyCostSeed(seed) {
    const costs = seed && seed.costs;
    const merge = window.NBDCatalogCosts && window.NBDCatalogCosts.mergeInto;
    if (!costs || typeof merge !== 'function') return 0;
    const tombstoned = new Set(deletedIds);
    let patched = 0;
    products.forEach(p => {
      if (!p || !p.id || tombstoned.has(p.id)) return;
      if (p.isActive === false) return;
      // An edited product keeps its own numbers — but one that carries NO
      // cost at all (the company library ships rows without the private
      // half, 2026-09-29) is filled from the book, never overwritten.
      if (p.updatedAt && p.createdAt && p.updatedAt !== p.createdAt
          && (TIERS.some(t => hasCost(p, t)) || p.labor)) return;
      if (merge(p, costs[p.id])) patched++;
    });
    if (patched) { saveAll(); reRender(); }
    return patched;
  }

  function saveAll() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ _v: DATA_VERSION, items: products, _deleted: deletedIds }));
    } catch (e) {
      console.error('Product library save error:', e);
      showToast('Error saving products', 'error');
    }
  }

  function saveProduct(product) {
    const now = new Date().toISOString();
    if (!product.id) {
      product.id = 'prod_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      product.createdAt = now;
    }
    product.updatedAt = now;
    const idx = products.findIndex(p => p.id === product.id);
    if (idx >= 0) products[idx] = product;
    else products.push(product);
    saveAll();
    // Push the cost half up to the company's cost book so the owner's numbers
    // reach their other devices and their reps, instead of living only in this
    // browser's localStorage (the per-device drift #1139 fixed for county
    // overrides). Fire-and-forget: firestore.rules limits cost writes to
    // owner/company_admin, so a rep's edit stays local and that is fine.
    try {
      const cc = window.NBDCatalogCosts;
      if (cc && typeof cc.recordProduct === 'function') cc.recordProduct(product);
    } catch (e) { /* never block a local save on the sync */ }
    // …and the rest of the row to the company library.
    cloudRecord(product);
    return product;
  }

  function deleteProduct(id) {
    const idx = products.findIndex(p => p.id === id);
    if (idx >= 0) {
      products[idx].isActive = false;
      // Archiving IS an edit — stamp updatedAt so migrateStore treats the
      // archived copy as user-touched and never resurrects the default.
      products[idx].updatedAt = new Date().toISOString();
      saveAll();
      cloudRecord(products[idx]);
    }
  }

  function hardDeleteProduct(id) {
    products = products.filter(p => p.id !== id);
    // Tombstone the id so a future DATA_VERSION migration can't re-add it
    // from fresh defaults.
    if (deletedIds.indexOf(id) === -1) deletedIds.push(id);
    saveAll();
    cloudTombstone(id);
  }

  // ============================================================================
  // COMPANY LIBRARY — productLibrary/{companyId} (Jo, 2026-09-29)
  // ============================================================================
  // The store above lived ONLY in this browser's localStorage under an `nbd_`
  // key, and NBDAuth.purgeAccountStorage() deletes every such key on every
  // sign-out. So custom products, sell-price edits and archives were erased at
  // each logout and never reached the owner's other devices or their reps
  // (the classic builder's rates and the Close Board read these prices).
  //
  // Jo's call: ONE company-wide library; the owner and company admins edit it,
  // everyone else in the company reads it. Same rules as catalogCosts.
  //
  // The document holds only the company's DELTA from the published catalog —
  // the same three kinds of row migrateStore already treats as the user's:
  // user-created, user-edited (updatedAt !== createdAt) and archived — plus
  // the hard-delete tombstones. Untouched defaults are never uploaded, so
  // catalog fixes keep landing through migrateStore exactly as before.
  //
  // NEVER the cost half: pricing[tier].cost and the labor block are
  // tenant-private money data and live in catalogCosts/{companyId}
  // (catalog-costs.js recordProduct). cloudItem() strips them, and the apply
  // path merges them back from the cost book.
  const CLOUD_COLLECTION = 'productLibrary';
  const CLOUD_VERSION = 1;
  const SAFE_ID = /^[A-Za-z0-9_-]+$/; // written as a dotted field path
  const DEFAULT_IDS = new Set(DEFAULT_PRODUCTS.map(p => p.id));
  let cloudKey = null;
  let cloudLoaded = false;   // a read completed (the doc exists or not)
  let cloudInflight = null;

  async function cloudFs() {
    if (window.__NBD_FS__) return window.__NBD_FS__;
    return import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
  }
  function cloudDb() { return window.db || window._db || null; }

  async function cloudResolveKey() {
    if (typeof window._resolveCompanyKey === 'function') {
      try { const k = await window._resolveCompanyKey(); if (k) return String(k); } catch (e) { /* fall through */ }
    }
    const c = window._userClaims;
    if (c && c.companyId) return String(c.companyId);
    const u = (window.auth && window.auth.currentUser) || window._user || null;
    return u && u.uid ? String(u.uid) : null;
  }

  // Mirrors firestore.rules productLibrary write: platform admin, the account
  // whose uid IS the company key (a solo owner), or a company_admin of it.
  // Presentation only — the rules are the gate.
  function canEditLibrary() {
    const c = window._userClaims || {};
    const role = c.role || '';
    if (role === 'viewer') return false;
    if (role === 'admin' || role === 'company_admin' || c.owner === true) return true;
    const u = (window.auth && window.auth.currentUser) || window._user || null;
    const uid = u && u.uid;
    if (!c.companyId) return true;             // no company claim: a solo owner
    return !!uid && String(c.companyId) === String(uid);
  }

  function refuseEdit() {
    if (canEditLibrary()) return false;
    showToast('The product library is shared by your company — only the owner or an admin can change it.', 'info');
    return true;
  }

  function isDelta(p) {
    return !!p && !!p.id && (!DEFAULT_IDS.has(p.id) || (p.updatedAt && p.updatedAt !== p.createdAt) || p.isActive === false);
  }

  // A product without its private half (see above).
  function cloudItem(p) {
    const out = JSON.parse(JSON.stringify(p));
    delete out.labor;
    if (out.pricing && typeof out.pricing === 'object') {
      Object.keys(out.pricing).forEach(t => { if (out.pricing[t] && typeof out.pricing[t] === 'object') delete out.pricing[t].cost; });
    }
    return out;
  }

  // Rebuild the store from the published catalog + the company's delta.
  // Cloud rows carry no private half, so each keeps this device's own cost
  // and labor for that product when it has them (else the published row's);
  // applyCostSeed then fills any product still without a cost from the book.
  function applyCloud(data) {
    const now = new Date().toISOString();
    const prevById = new Map(products.map(p => [p.id, p]));
    const tomb = Array.isArray(data.deleted) ? data.deleted.filter(id => typeof id === 'string') : [];
    const items = (data.items && typeof data.items === 'object') ? data.items : {};
    const tombstoned = new Set(tomb);
    const byId = new Map();
    DEFAULT_PRODUCTS.forEach(p => {
      if (tombstoned.has(p.id)) return;
      byId.set(p.id, { ...p, createdAt: now, updatedAt: now });
    });
    Object.keys(items).forEach(id => {
      const it = items[id];
      if (!it || typeof it !== 'object' || tombstoned.has(id)) return;
      const merged = JSON.parse(JSON.stringify({ ...it, id }));
      [prevById.get(id), byId.get(id)].forEach(src => {
        if (!src) return;
        if (src.labor && !merged.labor) merged.labor = JSON.parse(JSON.stringify(src.labor));
        TIERS.forEach(t => {
          const c = src.pricing && src.pricing[t] && src.pricing[t].cost;
          if (typeof c === 'number' && merged.pricing && merged.pricing[t] && merged.pricing[t].cost == null) merged.pricing[t].cost = c;
        });
      });
      byId.set(id, merged);
    });
    products = Array.from(byId.values());
    deletedIds = tomb;
    try {
      const cc = window.NBDCatalogCosts;
      const book = cc && typeof cc.get === 'function' ? cc.get() : null;
      if (book) applyCostSeed(book);
    } catch (e) { /* best-effort */ }
    saveAll();
    try { if (typeof window.syncRatesFromProductLibrary === 'function' && window.R) window.syncRatesFromProductLibrary('better'); } catch (e) { /* best-effort */ }
    reRender();
  }

  // Write rows (and optionally the tombstone list) with per-row dotted paths,
  // so two admins saving different products never clobber each other. First
  // write for a company falls back to setDoc (nothing to merge against).
  async function cloudWrite(rows, extra) {
    if (!canEditLibrary()) return false;
    const db = cloudDb();
    const key = cloudKey || await cloudResolveKey();
    if (!db || !key) return false;
    try {
      const fs = await cloudFs();
      const ref = fs.doc(db, CLOUD_COLLECTION, key);
      const paths = { version: CLOUD_VERSION, updatedAt: new Date().toISOString() };
      Object.keys(rows).forEach(id => { if (SAFE_ID.test(id)) paths['items.' + id] = rows[id]; });
      if (extra && extra.deleted) paths.deleted = extra.deleted.slice();
      let wrote = false;
      if (typeof fs.updateDoc === 'function') {
        try { await fs.updateDoc(ref, paths); wrote = true; }
        catch (e) { if (!/not-found|No document to update/i.test((e && (e.code || e.message)) || '')) throw e; }
      }
      if (!wrote) {
        const payload = { version: CLOUD_VERSION, updatedAt: paths.updatedAt, items: {}, deleted: (extra && extra.deleted) ? extra.deleted.slice() : deletedIds.slice() };
        Object.keys(rows).forEach(id => { if (SAFE_ID.test(id) && rows[id]) payload.items[id] = rows[id]; });
        await fs.setDoc(ref, payload, { merge: true });
      }
      return true;
    } catch (e) {
      const msg = (e && (e.code || e.message)) || '';
      console.warn('[product-library] company library write failed:', msg);
      if (/permission/i.test(msg)) showToast('Saved on this device only — the company library is owner/admin-editable.', 'error');
      else showToast('Could not save to the company library — check your connection.', 'error');
      return false;
    }
  }

  function cloudRecord(p) {
    if (!p || !p.id || !isDelta(p)) return Promise.resolve(false);
    const rows = {}; rows[p.id] = cloudItem(p);
    return cloudWrite(rows);
  }

  function cloudTombstone(id) {
    const rows = {}; rows[id] = null;
    return cloudWrite(rows, { deleted: deletedIds });
  }

  // Reset to defaults = the company has no delta. Whole-document replace.
  async function cloudReset() {
    if (!canEditLibrary()) return false;
    const db = cloudDb();
    const key = cloudKey || await cloudResolveKey();
    if (!db || !key) return false;
    try {
      const fs = await cloudFs();
      await fs.setDoc(fs.doc(db, CLOUD_COLLECTION, key), { version: CLOUD_VERSION, updatedAt: new Date().toISOString(), items: {}, deleted: [] });
      return true;
    } catch (e) {
      console.warn('[product-library] company library reset failed:', (e && (e.code || e.message)) || e);
      showToast('Could not reset the company library — check your connection.', 'error');
      return false;
    }
  }

  // Read the company library and apply it. When the company has none yet and
  // this person may edit it, lift this device's delta up ONCE so the numbers
  // they have been quoting off are not lost (same one-time upgrade
  // catalog-costs.js adoptLocal() did for costs). Guarded on a COMPLETED read
  // — a failed read must never be mistaken for "no library".
  function cloudHydrate(opts) {
    const force = !!(opts && opts.force);
    if (!force && cloudLoaded) return Promise.resolve(true);
    if (cloudInflight) return cloudInflight;
    cloudInflight = (async function () {
      const db = cloudDb();
      const key = await cloudResolveKey();
      if (!db || !key) return false;
      cloudKey = key;
      const fs = await cloudFs();
      const retry = window.nbdRetryOffline || (fn => fn());
      let snap;
      try { snap = await retry(() => fs.getDoc(fs.doc(db, CLOUD_COLLECTION, key))); }
      catch (e) { console.warn('[product-library] company library read failed:', (e && (e.code || e.message)) || e); return false; }
      cloudLoaded = true;
      if (snap && snap.exists()) {
        applyCloud(snap.data() || {});
        return true;
      }
      const delta = products.filter(isDelta);
      if ((delta.length || deletedIds.length) && canEditLibrary()) {
        const rows = {};
        delta.forEach(p => { rows[p.id] = cloudItem(p); });
        if (await cloudWrite(rows, { deleted: deletedIds })) {
          console.info('[product-library] adopted ' + delta.length + ' product edits into the company library');
        }
      }
      return true;
    })().then(r => { cloudInflight = null; return r; }, e => { cloudInflight = null; console.warn('[product-library] hydrate failed:', e && e.message); return false; });
    return cloudInflight;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatCurrency(n) {
    if (n == null) return '$0';
    if (n >= 1) return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return '$' + Number(n).toFixed(2);
  }

  function margin(sell, cost) {
    if (!sell) return 0;
    return Math.round(((sell - cost) / sell) * 100);
  }

  // Prefill for the Add-Product form's Overhead Mult. / Profit Margin % boxes.
  // These used to be hardcoded 1.35 / 25 here — which meant one company's
  // margin policy was published verbatim in a public file (they appeared
  // 176 / 173 times in the leaked catalog) AND applied as every other tenant's
  // default. They now come from the tenant's own cost book. The neutral
  // fallback (no markup, no target margin) applies to a tenant that has not
  // set a policy — the same state in which no product has a cost either.
  // Named constants, not an inline literal — see the same note in
  // catalog-costs.js: tests/catalog-cost-privacy.test.js forbids ANY numeric
  // literal beside these two key names in a catalog file, so no real policy
  // has a way back in.
  const NEUTRAL_OVERHEAD = 1; // multiplier: 1 = straight cost passthrough
  const NEUTRAL_MARGIN = 0;   // percent

  function laborDefaults() {
    const cc = window.NBDCatalogCosts;
    if (cc && typeof cc.defaults === 'function') return cc.defaults();
    return { overheadMultiplier: NEUTRAL_OVERHEAD, profitMarginPct: NEUTRAL_MARGIN };
  }

  // ── "cost not set" is a REAL state, not zero ────────────────────────────
  // Costs are tenant-owned (catalogCosts/{companyId}) and a tenant that has
  // not entered them has NO cost — `undefined`, not 0. The two must never be
  // confused: grossMargin(sell, 0, 0) returns 100%, so treating "not set" as
  // zero makes the library confidently report a perfect margin on every
  // product. That fabricated 100% is exactly the failure mode that made
  // "just delete the cost fields" the wrong fix. Note 0 is a LEGITIMATE cost
  // for a couple of SKUs (owned equipment, a free warranty certificate), so
  // the check is on the type, not on truthiness.
  function hasCost(p, tier) {
    const t = p && p.pricing && p.pricing[tier];
    return !!t && typeof t.cost === 'number' && isFinite(t.cost);
  }

  // A product's margin is only meaningful once its material cost is known.
  // Labor is treated as 0 when unset (a product genuinely can have no labor).
  function marginKnown(p, tier) { return hasCost(p, tier); }

  const NOT_SET = '<span class="plx-muted-soft">Cost not set</span>';

  // True gross margin: sell - material cost - labor cost
  function grossMargin(sell, matCost, laborCost) {
    if (!sell) return 0;
    return Math.round(((sell - matCost - laborCost) / sell) * 100);
  }

  function showToast(msg, type) {
    // window.showToast is guaranteed on the only page this bundle loads on
    // (dashboard-ui-prefs-boot.js defines it before the lazy bundles). The
    // old `window._showToast` reference was assigned NOWHERE, and the old
    // in-template toast div only existed while this panel's own HTML was
    // mounted — every toast fired from anywhere else silently vanished
    // (audit 2026-08-02, silent-failure class).
    if (typeof window.showToast === 'function') { window.showToast(msg, type); return; }
    try { console.log('[product-library] ' + (type || 'info') + ': ' + msg); } catch (e) {}
  }

  function catLabel(catId) {
    return CATEGORIES[catId] ? CATEGORIES[catId].label : catId;
  }

  function catIcon(catId) {
    return CATEGORIES[catId] ? CATEGORIES[catId].icon : '📦';
  }

  function catColor(catId) {
    return CATEGORIES[catId] ? CATEGORIES[catId].color : '#6b7280';
  }

  function unitLabel(u) {
    return UNITS[u] ? UNITS[u].label : u;
  }

  // ============================================================================
  // SEARCH & FILTER
  // ============================================================================

  function getFilteredProducts() {
    let list = products.filter(p => p.isActive !== false);
    if (currentFilter.category) {
      list = list.filter(p => p.category === currentFilter.category);
    }
    if (currentFilter.search) {
      const q = currentFilter.search.toLowerCase();
      list = list.filter(p =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.manufacturer && p.manufacturer.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.tags && p.tags.some(t => t.toLowerCase().includes(q)))
      );
    }
    return list;
  }

  function searchProducts(query) {
    currentFilter.search = query || '';
    return getFilteredProducts();
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  function render() {
    // A read picks up the company library when the view opens (the load-time
    // read can run before sign-in finishes).
    if (!cloudLoaded) cloudHydrate();
    const editable = canEditLibrary();
    const results = getFilteredProducts();
    const activeCount = products.filter(p => p.isActive !== false).length;
    const usedCats = [...new Set(products.filter(p => p.isActive !== false).map(p => p.category))];
    const categoryCount = usedCats.length;
    const marginTier = currentFilter.tier || 'better';
    // Average over the products whose cost is actually KNOWN. Averaging a
    // fabricated 100% for every cost-less product used to make a brand-new
    // tenant's library read "Avg Margin 100%".
    // pricedCount also drives the empty-state banner below: a tenant that has
    // entered no costs gets told so, instead of a library full of confident
    // 100% margins.
    const priced = products.filter(p => p.isActive !== false && marginKnown(p, marginTier));
    const avgMargin = priced.length ? Math.round(
      priced.reduce((s, p) => {
        return s + grossMargin(p.pricing?.[marginTier]?.sell || 0, p.pricing[marginTier].cost, p.labor?.perUnit || 0);
      }, 0) / priced.length
    ) : null;
    const pricedCount = priced.length;

    // Group results by category
    const grouped = {};
    results.forEach(p => {
      if (!grouped[p.category]) grouped[p.category] = [];
      grouped[p.category].push(p);
    });

    // Category filter pills
    const catPills = Object.entries(CATEGORIES).map(([id, cat]) => {
      const count = products.filter(p => p.isActive !== false && p.category === id).length;
      if (count === 0) return '';
      const isActive = currentFilter.category === id;
      return `<button data-pl-action="setFilter" data-pl-id="${id}" style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;border:2px solid ${isActive ? cat.color : 'var(--br)'};background:${isActive ? cat.color + '18' : 'var(--s)'};color:${isActive ? cat.color : 'var(--t)'};cursor:pointer;font-size:12px;font-weight:${isActive?'600':'500'};white-space:nowrap;">${cat.icon} ${cat.label} <span style="background:${isActive ? cat.color : 'var(--br)'};color:${isActive?'#fff':'var(--m)'};border-radius:10px;padding:1px 7px;font-size:11px;">${count}</span></button>`;
    }).join('');

    // Product cards by category (collapsible accordion)
    let productsHtml = '';
    Object.keys(grouped).sort((a, b) => catLabel(a).localeCompare(catLabel(b))).forEach(catId => {
      const catProds = grouped[catId].sort((a, b) => (a.sortOrder || 99) - (b.sortOrder || 99));
      const isCollapsed = isCategoryCollapsed(catId);
      const chevron = isCollapsed ? '▸' : '▾';
      productsHtml += `
        <div class="plx-mb28">
          <div data-pl-action="toggleCategory" data-pl-id="${escapeHtml(catId)}" style="display:flex;align-items:center;gap:8px;margin-bottom:${isCollapsed ? '0' : '12'}px;cursor:pointer;user-select:none;padding:8px 12px;background:var(--s);border-radius:8px;border:1px solid var(--br);transition:all .15s;">
            <span class="plx-caret">${chevron}</span>
            <span class="plx-fs20">${catIcon(catId)}</span>
            <h3 style="margin:0;font-size:16px;font-weight:700;color:${catColor(catId)};flex:1;">${escapeHtml(catLabel(catId))}</h3>
            <span class="plx-t12-w5">${catProds.length} product${catProds.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="pl-product-grid" style="display:${isCollapsed ? 'none' : 'grid'};margin-top:${isCollapsed ? '0' : '12px'};">
      `;
      catProds.forEach(p => {
        const tierForMargin = currentFilter.tier || 'better';
        const laborCost = p.labor?.perUnit || 0;
        const costKnown = marginKnown(p, tierForMargin);
        const matCost = costKnown ? p.pricing[tierForMargin].cost : 0;
        const sellPrice = p.pricing?.[tierForMargin]?.sell || 0;
        const myCost = matCost + laborCost;
        const m = grossMargin(sellPrice, matCost, laborCost);
        const colorCount = p.colors ? p.colors.length : 0;
        const hasLabor = p.labor && p.labor.perUnit > 0;
        productsHtml += `
          <div class="pl-card plx-card">
            <div class="plx-card-head">
              <div class="plx-grow">
                <div class="plx-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
                <div class="plx-t11-mt">${escapeHtml(p.manufacturer || '')} ${p.sku ? '• ' + escapeHtml(p.sku) : ''}</div>
              </div>
              <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${catColor(p.category)}18;color:${catColor(p.category)};white-space:nowrap;">${escapeHtml(p.unit)}</span>
            </div>

            <div class="plx-desc">${escapeHtml(p.description)}</div>

            <!-- Tier Pricing -->
            <div class="plx-g3-tight">
              ${TIERS.map(t => {
                const isHighlighted = currentFilter.tier === t;
                return `<div style="background:${isHighlighted ? TIER_COLORS[t]+'20' : TIER_COLORS[t]+'0a'};border-radius:6px;padding:6px 8px;text-align:center;border:${isHighlighted ? '2px' : '1px'} solid ${isHighlighted ? TIER_COLORS[t] : TIER_COLORS[t]+'20'};${isHighlighted ? 'transform:scale(1.03);box-shadow:0 2px 8px '+TIER_COLORS[t]+'30;' : ''}">
                  <div style="font-size:10px;font-weight:600;color:${TIER_COLORS[t]};text-transform:uppercase;">${TIER_LABELS[t]}</div>
                  <div class="plx-t14">${formatCurrency(p.pricing?.[t]?.sell)}</div>
                  <div class="plx-t10">${hasCost(p, t) ? 'Profit ' + grossMargin(p.pricing[t].sell||0, p.pricing[t].cost, laborCost) + '%' : 'Profit —'}</div>
                </div>`;
              }).join('')}
            </div>

            <!-- Cost Breakdown Row -->
            <div class="plx-wrap6-mb">
              ${costKnown
                ? `<span class="plx-chip plx-chip-dark">🏷️ My Cost: ${formatCurrency(myCost)}/${p.unit} <span class="plx-dim6">(${TIER_LABELS[tierForMargin]})</span></span>`
                : `<span class="plx-chip plx-chip-dashed">🏷️ My Cost: not set <span class="plx-dim7b">(${TIER_LABELS[tierForMargin]})</span></span>`}
              ${costKnown && matCost ? `<span class="plx-pill plx-pill-green">💲 Mat ${formatCurrency(matCost)}</span>` : ''}
              ${hasLabor ? `<span class="plx-pill plx-pill-amber">⚒️ Lab ${formatCurrency(p.labor.perUnit)}</span>` : ''}
            </div>

            <!-- Meta Row -->
            <div class="plx-wrap6-mb">
              ${colorCount > 0 ? `<span class="plx-pill plx-pill-plain">🎨 ${colorCount} ${colorCount === 1 ? 'color' : 'colors'}</span>` : ''}
              ${p.warranty && p.warranty !== 'N/A' ? `<span class="plx-pill plx-pill-mint">🛡️ ${escapeHtml(p.warranty.length > 20 ? p.warranty.substring(0, 18) + '…' : p.warranty)}</span>` : ''}
              ${p.coverage ? `<span class="plx-pill plx-pill-blue">📐 ${escapeHtml(typeof p.coverage === 'string' ? p.coverage : p.coverage.perUnit || '')}</span>` : ''}
            </div>

            <!-- Footer -->
            <div class="plx-card-foot">
              <div class="plx-t12"><strong>Gross Profit <span class="plx-dim7">(${TIER_LABELS[tierForMargin]})</span>:</strong> ${costKnown
                ? `<span style="color:${m >= 40 ? '#10b981' : m >= 25 ? '#f59e0b' : '#ef4444'};font-weight:700;">${formatCurrency(sellPrice - myCost)}/${p.unit} (${m}%)</span>`
                : NOT_SET}</div>
              <div class="plx-row6">${editable ? `
                <button class="pl-card-btn plx-btn-edit" data-pl-action="editProduct" data-pl-id="${escapeHtml(p.id)}">Edit</button>
                <button class="pl-card-btn plx-btn-ghost" data-pl-action="archiveProduct" data-pl-id="${escapeHtml(p.id)}">Archive</button>` : ''}
              </div>
            </div>
          </div>
        `;
      });
      productsHtml += '</div></div>';
    });

    // .pl-card-btn: each card's Edit / Archive measured 45x22 / 57x22 on a
    // phone (11px text, 5px padding) — below the 36px touch floor the rest
    // of the app holds to (Wave 81, dashboard-app.css). Touch devices and
    // phone widths get 40px buttons; desktop keeps the compact pair
    // (phone audit views#14, 2026-09-25). !important because the sizes are
    // inline on each button.
    return `
      <style>.pl-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.1)!important;}.pl-product-grid{grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;}@media (max-width:360px){.pl-product-grid{grid-template-columns:minmax(0,1fr);}}@media (hover:none),(max-width:600px){.pl-card-btn{min-height:40px;padding:8px 16px!important;font-size:13px!important;}}</style>
      <div class="plx-root">

        <!-- Header -->
        <div class="plx-head">
          <div>
            <h1 class="plx-h1">Product Library</h1>
            <p class="plx-sub13">Materials, labor, and pricing for your estimates — ${activeCount} products across ${categoryCount} categories</p>
            ${editable ? '' : '<p class="plx-sub12">🔒 Your company’s shared library — only the owner or an admin can change it.</p>'}
          </div>
          <div class="plx-row8">${editable ? `
            <button data-pl-action="addProduct" class="plx-btn-add">+ Add Product</button>
` : ''}
            <button type="button" class="btn btn-ghost" data-pb-action="open" title="What you actually paid, per store SKU">💲 Price book</button>
            <button data-pl-action="exportCSV" class="plx-btn-green">Export CSV</button>
            ${editable ? `<button data-pl-action="resetDefaults" class="plx-btn-red">Reset</button>` : ''}
          </div>
        </div>

        <!-- Stats -->
        <div class="plx-stats">
          <div class="plx-stat plx-stat-blue">
            <div class="plx-stat-label">Total Products</div>
            <div class="plx-stat-value">${activeCount}</div>
          </div>
          <div class="plx-stat plx-stat-green">
            <div class="plx-stat-label">Categories</div>
            <div class="plx-stat-value">${categoryCount}</div>
          </div>
          <div class="plx-stat plx-stat-amber">
            <div class="plx-stat-label">Avg Margin</div>
            <div class="plx-stat-value">${avgMargin == null ? '—' : avgMargin + '%'}</div>
            ${avgMargin != null && pricedCount < activeCount ? `<div class="plx-t10-mt">${pricedCount} of ${activeCount} priced</div>` : ''}
          </div>
          <div class="plx-stat plx-stat-violet">
            <div class="plx-stat-label">Showing</div>
            <div class="plx-stat-value">${results.length}</div>
          </div>
        </div>

        ${pricedCount === 0 && activeCount > 0 ? `
        <div class="plx-banner">
          <strong>Your costs aren't set yet.</strong> Prices below are your <em>sell</em> prices — profit and margin stay blank until you enter what each item costs you. Open any product and fill in Material Cost per tier.
        </div>` : ''}

        <!-- Search & Filter -->
        <div class="plx-filterbox">
          <input type="text" id="product-search" placeholder="Search by name, brand, tag..." value="${escapeHtml(currentFilter.search)}"
            class="plx-search">

          <!-- Tier Filter Buttons -->
          <div class="plx-row6-mb">
            <button data-pl-action="setTierFilter" data-pl-id="" style="flex:1;padding:8px 12px;border-radius:8px;border:2px solid ${!currentFilter.tier ? '#BD5728' : 'var(--br)'};background:${!currentFilter.tier ? '#BD572818' : 'var(--s)'};color:${!currentFilter.tier ? '#BD5728' : 'var(--m)'};cursor:pointer;font-size:12px;font-weight:600;">All Tiers</button>
            ${TIERS.map(t => {
              const isActive = currentFilter.tier === t;
              return `<button data-pl-action="setTierFilter" data-pl-id="${t}" style="flex:1;padding:8px 12px;border-radius:8px;border:2px solid ${isActive ? TIER_COLORS[t] : 'var(--br)'};background:${isActive ? TIER_COLORS[t]+'18' : 'var(--s)'};color:${isActive ? TIER_COLORS[t] : 'var(--m)'};cursor:pointer;font-size:12px;font-weight:600;">${TIER_LABELS[t]}</button>`;
            }).join('')}
          </div>

          <!-- Category Filter Pills -->
          <div class="plx-wrap6">
            <button data-pl-action="setFilter" data-pl-id="" style="padding:6px 12px;border-radius:20px;border:2px solid ${!currentFilter.category ? '#BD5728' : 'var(--br)'};background:${!currentFilter.category ? '#BD572818' : 'var(--s)'};color:${!currentFilter.category ? '#BD5728' : 'var(--t)'};cursor:pointer;font-size:12px;font-weight:${!currentFilter.category?'600':'500'};">All (${activeCount})</button>
            ${catPills}
          </div>
        </div>

        <!-- Products -->
        ${productsHtml || '<div class="plx-empty">No products match your search</div>'}

      </div>
    `;
  }

  // ============================================================================
  // MODAL — Edit / Add Product
  // ============================================================================

  function openModal(productId) {
    if (refuseEdit()) return;
    const p = productId ? products.find(x => x.id === productId) : null;
    editingProduct = p ? { ...p } : null;

    const catOptions = Object.entries(CATEGORIES).map(([id, c]) =>
      `<option value="${id}" ${(p && p.category === id) ? 'selected' : ''}>${c.icon} ${c.label}</option>`
    ).join('');

    const unitOptions = Object.entries(UNITS).map(([id, u]) =>
      `<option value="${id}" ${(p && p.unit === id) ? 'selected' : ''}>${u.abbr} — ${u.label}</option>`
    ).join('');

    const modal = document.createElement('div');
    modal.id = 'product-edit-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:var(--z-overlay,10000);display:flex;align-items:center;justify-content:center;';
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    modal.innerHTML = `
      <div class="plx-modal">
        <div class="plx-modal-head">
          <h2 class="plx-h2">${p ? 'Edit Product' : 'Add Product'}</h2>
          <button data-pl-action="closeModal" class="plx-close">×</button>
        </div>

        <div class="plx-form">
          <!-- Row 1: Name, Manufacturer -->
          <div class="plx-g21">
            <div>
              <label class="ui-label-sm">Product Name *</label>
              <input class="ui-input ui-input-box" id="pm-name" type="text" value="${escapeHtml(p?.name || '')}" required>
            </div>
            <div>
              <label class="ui-label-sm">Manufacturer</label>
              <input class="ui-input ui-input-box" id="pm-manufacturer" type="text" value="${escapeHtml(p?.manufacturer || '')}">
            </div>
          </div>

          <!-- Row 2: Category, Unit, SKU -->
          <div class="plx-g3">
            <div>
              <label class="ui-label-sm">Category</label>
              <select class="ui-input ui-input-box" id="pm-category">${catOptions}</select>
            </div>
            <div>
              <label class="ui-label-sm">Unit</label>
              <select class="ui-input ui-input-box" id="pm-unit">${unitOptions}</select>
            </div>
            <div>
              <label class="ui-label-sm">SKU</label>
              <input class="ui-input ui-input-box" id="pm-sku" type="text" value="${escapeHtml(p?.sku || '')}">
            </div>
          </div>

          <!-- Description -->
          <div>
            <label class="ui-label-sm">Description</label>
            <textarea class="ui-input ui-input-box plx-resize" id="pm-description" rows="2">${escapeHtml(p?.description || '')}</textarea>
          </div>

          <!-- Tier Pricing -->
          <div>
            <label class="ui-label-strong">Pricing (Good / Better / Best)</label>
            <div class="plx-g3-8">
              ${TIERS.map(t => `
                <div style="background:${TIER_COLORS[t]}08;border:1px solid ${TIER_COLORS[t]}30;border-radius:8px;padding:10px;">
                  <div style="font-size:11px;font-weight:600;color:${TIER_COLORS[t]};text-transform:uppercase;margin-bottom:6px;text-align:center;">${TIER_LABELS[t]}</div>
                  <div class="plx-mb6">
                    <label class="ui-hint">Sell Price</label>
                    <input class="ui-input-sm" id="pm-sell-${t}" type="number" step="0.01" value="${p?.pricing?.[t]?.sell || 0}">
                  </div>
                  <div>
                    <label class="ui-hint">Material Cost</label>
                    <!-- Blank, not 0, when unset: an empty box reads as "tell
                         me your cost", a 0 reads as "your cost is nothing"
                         and prices the tier at a 100% margin. -->
                    <input class="ui-input-sm" id="pm-cost-${t}" type="number" step="0.01" value="${hasCost(p, t) ? p.pricing[t].cost : ''}" placeholder="your cost">
                  </div>
                  <div id="pm-margin-${t}" class="plx-margin"></div>
                </div>
              `).join('')}
            </div>
            <div id="pm-margin-warnings" class="plx-mt8"></div>
          </div>

          <!-- Labor -->
          <div>
            <label class="ui-label-strong">Labor</label>
            <div class="plx-g3r">
              <div>
                <label class="ui-hint">Per Unit Cost</label>
                <input class="ui-input-sm" id="pm-labor-perunit" type="number" step="0.01" value="${p?.labor?.perUnit || 0}">
              </div>
              <div>
                <label class="ui-hint">Rate / Man-Hour</label>
                <input class="ui-input-sm" id="pm-labor-rate" type="number" step="0.01" value="${p?.labor?.ratePerManHour || 0}">
              </div>
              <div>
                <label class="ui-hint">Crew Size</label>
                <input class="ui-input-sm" id="pm-labor-crew" type="number" step="1" value="${p?.labor?.crewSize || 0}">
              </div>
              <div>
                <label class="ui-hint">Hours / Unit</label>
                <input class="ui-input-sm" id="pm-labor-hours" type="number" step="0.01" value="${p?.labor?.hoursPerUnit || 0}">
              </div>
              <div>
                <label class="ui-hint">Overhead Mult.</label>
                <input class="ui-input-sm" id="pm-labor-overhead" type="number" step="0.01" value="${p?.labor?.overheadMultiplier || laborDefaults().overheadMultiplier}">
              </div>
              <div>
                <label class="ui-hint">Profit Margin %</label>
                <input class="ui-input-sm" id="pm-labor-profit" type="number" step="1" value="${p?.labor?.profitMarginPct || laborDefaults().profitMarginPct}">
              </div>
            </div>
          </div>

          <!-- Colors, Warranty, Tags -->
          <div class="plx-g2">
            <div>
              <label class="ui-label-sm">Colors (comma-separated)</label>
              <input class="ui-input ui-input-box" id="pm-colors" type="text" value="${escapeHtml((p?.colors || []).join(', '))}" placeholder="Charcoal, Weathered Wood, ...">
            </div>
            <div>
              <label class="ui-label-sm">Warranty</label>
              <input class="ui-input ui-input-box" id="pm-warranty" type="text" value="${escapeHtml(p?.warranty || '')}">
            </div>
          </div>

          <div class="plx-g2">
            <div>
              <label class="ui-label-sm">Tags (comma-separated)</label>
              <input class="ui-input ui-input-box" id="pm-tags" type="text" value="${escapeHtml((p?.tags || []).join(', '))}">
            </div>
            <div>
              <label class="ui-label-sm">Default Qty</label>
              <input class="ui-input ui-input-box" id="pm-defaultqty" type="number" value="${p?.defaultQty || 1}">
            </div>
          </div>

          <!-- Notes -->
          <div>
            <label class="ui-label-sm">Notes</label>
            <textarea class="ui-input ui-input-box plx-resize" id="pm-notes" rows="2">${escapeHtml(p?.notes || '')}</textarea>
          </div>

          <!-- Actions -->
          <div class="plx-modal-foot">
            ${p ? '<button data-pl-action="deleteFromModal" class="plx-btn-delete">Delete</button>' : '<div></div>'}
            <div class="plx-row8">
              <button data-pl-action="closeModal" class="plx-btn-cancel">Cancel</button>
              <button data-pl-action="saveFromModal" class="plx-btn-save">${p ? 'Update' : 'Add Product'}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    // Trigger initial margin calc
    setTimeout(recalcModalMargins, 0);
  }

  function closeModal() {
    const m = document.getElementById('product-edit-modal');
    if (m) m.remove();
    editingProduct = null;
  }

  function recalcModalMargins() {
    const labor = parseFloat(document.getElementById('pm-labor-perunit')?.value) || 0;
    const warnings = [];
    TIERS.forEach(t => {
      const sell = parseFloat(document.getElementById('pm-sell-' + t)?.value) || 0;
      const costRaw = (document.getElementById('pm-cost-' + t)?.value ?? '').trim();
      const mat = parseFloat(costRaw);
      const el = document.getElementById('pm-margin-' + t);
      if (!el) return;
      // An EMPTY cost box means "not set" — show nothing rather than a margin
      // computed against an assumed zero cost.
      if (costRaw === '' || !isFinite(mat)) {
        el.innerHTML = '<span class="plx-muted">enter cost</span>';
        return;
      }
      const myCost = mat + labor;
      if (sell <= 0) { el.innerHTML = '<span class="plx-muted">—</span>'; return; }
      const m = Math.round(((sell - myCost) / sell) * 100);
      const profit = sell - myCost;
      const color = sell <= myCost ? '#ef4444' : m < 25 ? '#f59e0b' : '#10b981';
      el.innerHTML = '<span style="color:' + color + ';">' + m + '% ($' + profit.toFixed(2) + ')</span>';
      if (sell <= myCost) warnings.push(TIER_LABELS[t] + ' sell ($' + sell + ') is at or below cost ($' + myCost.toFixed(2) + ')');
    });
    const warnEl = document.getElementById('pm-margin-warnings');
    if (warnEl) {
      warnEl.innerHTML = warnings.map(w => '<div class="plx-warn">⚠️ ' + w + '</div>').join('');
    }
  }

  async function saveFromModal() {
    if (refuseEdit()) return;
    const name = document.getElementById('pm-name').value.trim();
    if (!name) { showToast('Product name is required', 'error'); return; }

    // Read the cost boxes once. '' means the tenant has not set that tier's
    // cost — kept as `null` all the way through so it round-trips as "unset"
    // rather than collapsing to a zero cost (and a fake 100% margin).
    const costInput = {};
    TIERS.forEach(t => {
      const raw = (document.getElementById(`pm-cost-${t}`)?.value ?? '').trim();
      const n = parseFloat(raw);
      costInput[t] = (raw === '' || !isFinite(n)) ? null : n;
    });

    // Validate: no tier sells below cost.
    //
    // A tier with no material cost set is still checked against LABOR, which
    // is known. Skipping it entirely (the first cut of this) made the guard
    // unreachable for exactly the case a new tenant hits most: costs blank,
    // labor filled in, and a sell price already underwater on labor alone.
    // Only a tier with NEITHER number known is genuinely unknowable.
    const laborVal = parseFloat(document.getElementById('pm-labor-perunit')?.value) || 0;
    const belowCost = [];
    TIERS.forEach(t => {
      const sell = parseFloat(document.getElementById('pm-sell-' + t)?.value) || 0;
      if (!(sell > 0)) return;
      if (costInput[t] === null && !(laborVal > 0)) return; // nothing to compare against
      const known = (costInput[t] || 0) + laborVal;
      if (sell <= known) belowCost.push(TIER_LABELS[t] + (costInput[t] === null ? ' (labor alone)' : ''));
    });
    // Batch 2 (iOS PWA): nbdConfirm so this guard isn't bypassed in standalone.
    if (belowCost.length) {
      const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      if (!(await _ask('Warning: ' + belowCost.join(', ') + ' tier(s) have sell price at or below cost. Save anyway?'))) return;
    }

    const product = editingProduct ? { ...editingProduct } : {};
    product.name = name;
    product.manufacturer = document.getElementById('pm-manufacturer').value.trim();
    product.category = document.getElementById('pm-category').value;
    product.unit = document.getElementById('pm-unit').value;
    product.sku = document.getElementById('pm-sku').value.trim();
    product.description = document.getElementById('pm-description').value.trim();
    product.warranty = document.getElementById('pm-warranty').value.trim();
    product.defaultQty = parseInt(document.getElementById('pm-defaultqty').value) || 1;
    product.notes = document.getElementById('pm-notes').value.trim();
    product.section = catLabel(product.category);
    product.isActive = true;

    // Colors & Tags
    const colorsRaw = document.getElementById('pm-colors').value;
    product.colors = colorsRaw ? colorsRaw.split(',').map(c => c.trim()).filter(Boolean) : [];
    const tagsRaw = document.getElementById('pm-tags').value;
    product.tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    // Pricing. `cost` is OMITTED (not zeroed) when the box is blank, so an
    // unpriced tier stays visibly unpriced everywhere downstream.
    product.pricing = {};
    TIERS.forEach(t => {
      product.pricing[t] = { sell: parseFloat(document.getElementById(`pm-sell-${t}`).value) || 0 };
      if (costInput[t] !== null) product.pricing[t].cost = costInput[t];
    });

    // Labor
    product.labor = {
      perUnit: parseFloat(document.getElementById('pm-labor-perunit').value) || 0,
      ratePerManHour: parseFloat(document.getElementById('pm-labor-rate').value) || 0,
      crewSize: parseInt(document.getElementById('pm-labor-crew').value) || 0,
      hoursPerUnit: parseFloat(document.getElementById('pm-labor-hours').value) || 0,
      overheadMultiplier: parseFloat(document.getElementById('pm-labor-overhead').value) || laborDefaults().overheadMultiplier,
      profitMarginPct: parseFloat(document.getElementById('pm-labor-profit').value) || laborDefaults().profitMarginPct
    };

    const wasEdit = !!editingProduct;
    saveProduct(product);
    closeModal();
    showToast(wasEdit ? 'Product updated' : 'Product added', 'success');
    reRender();
  }

  async function deleteFromModal() {
    if (!editingProduct) return;
    if (refuseEdit()) return;
    // Batch 2 (iOS PWA): real async gate via nbdConfirm.
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (await _ask('Delete this product?')) {
      hardDeleteProduct(editingProduct.id);
      closeModal();
      showToast('Product deleted', 'success');
      reRender();
    }
  }

  // ============================================================================
  // ACTIONS
  // ============================================================================

  async function archiveProductFromUI(id) {
    if (refuseEdit()) return;
    // Batch 2 (iOS PWA): archiving also stamps updatedAt, which permanently
    // marks the product user-edited — not something to do on a phantom yes.
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (await _ask('Archive this product?')) {
      deleteProduct(id);
      showToast('Product archived', 'success');
      reRender();
    }
  }

  function setFilter(category, search) {
    if (category !== undefined) currentFilter.category = category;
    if (search !== undefined) currentFilter.search = search;
    reRender();
  }

  function setTierFilter(tier) {
    currentFilter.tier = tier;
    reRender();
  }

  // Phones open the library with every category collapsed (phone audit
  // views#14, 2026-09-25): with all 16 expanded it was 276 cards and
  // 87,752px of scroll at 412 (92,512px at 360) before you reached the
  // product you wanted. Search and the category chips already exist, so a
  // search or a chip shows its matches expanded; a category the rep has
  // tapped keeps whatever they chose. Desktop keeps the expanded default.
  function isCategoryCollapsed(catId) {
    if (Object.prototype.hasOwnProperty.call(collapsedCategories, catId)) return collapsedCategories[catId] === true;
    if (currentFilter.search || currentFilter.category) return false;
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches); } catch (_) { return false; }
  }

  function toggleCategory(catId) {
    // Toggle what's on SCREEN (which may be the phone default, not a stored
    // choice) — negating the raw map would re-collapse a phone's first tap.
    collapsedCategories[catId] = !isCategoryCollapsed(catId);
    reRender();
  }

  function reRender() {
    const container = document.getElementById('product-library-container') || document.getElementById('productLibraryContainer');
    if (container) container.innerHTML = render();
  }

  async function resetToDefaults() {
    if (refuseEdit()) return;
    // Batch 2 (iOS PWA): seedDefaults() wipes every edit and every tombstone.
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (await _ask('Reset all products to defaults? Your customizations will be lost.')) {
      seedDefaults();
      cloudReset();
      showToast('Products reset to defaults', 'success');
      reRender();
    }
  }

  function exportProductsCSV() {
    const active = products.filter(p => p.isActive !== false);
    const rows = [['Name','Category','Unit','Good Sell','Good Cost','Better Sell','Better Cost','Best Sell','Best Cost','Labor/Unit','Manufacturer','Warranty','Colors','Tags']];
    // An unset cost exports as an EMPTY cell, not 0 — a spreadsheet full of
    // zeroes would average out to a 100% margin in whatever the rep builds on
    // top of it.
    const costCell = (p, t) => (hasCost(p, t) ? p.pricing[t].cost : '');
    active.forEach(p => {
      rows.push([
        p.name, catLabel(p.category), p.unit,
        p.pricing?.good?.sell, costCell(p, 'good'),
        p.pricing?.better?.sell, costCell(p, 'better'),
        p.pricing?.best?.sell, costCell(p, 'best'),
        p.labor?.perUnit || 0,
        p.manufacturer || '', p.warranty || '',
        (p.colors || []).join('; '), (p.tags || []).join('; ')
      ]);
    });
    const csv = rows.map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nbd_products_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    showToast('CSV exported', 'success');
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  window._productLib = {
    render,
    load: loadProducts,
    save: saveProduct,
    delete: deleteProduct,
    hardDelete: hardDeleteProduct,
    // Called by catalog-costs.js once the tenant's cost book loads.
    applyCostSeed,
    // Company library (productLibrary/{companyId}).
    hydrateCompany: cloudHydrate,
    canEdit: canEditLibrary,
    _cloudItem: cloudItem,
    search: searchProducts,
    exportCSV: exportProductsCSV,
    resetDefaults: resetToDefaults,
    openModal,
    closeModal,
    recalcModalMargins,
    editProduct: openModal,
    addProduct: () => openModal(null),
    saveFromModal,
    deleteFromModal,
    archiveProduct: archiveProductFromUI,
    setFilter,
    setTierFilter,
    toggleCategory,
    getProducts: () => products.filter(p => p.isActive !== false),
    getStats: () => {
      const active = products.filter(p => p.isActive !== false);
      // Only products whose cost this tenant has actually entered contribute.
      // avgMargin is NULL (not 0, not 100) when none are priced — callers must
      // render "—" rather than a number nobody supplied.
      const priced = active.filter(p => marginKnown(p, 'better'));
      return {
        total: active.length,
        categories: new Set(active.map(p => p.category)).size,
        priced: priced.length,
        avgMargin: priced.length ? Math.round(
          priced.reduce((s, p) => s + grossMargin(p.pricing.better.sell || 0, p.pricing.better.cost, p.labor?.perUnit || 0), 0) / priced.length
        ) : null
      };
    }
  };

  // Globals Tranche 3 T3-C (2026-09-18): renderProductLibrary is registry-only
  // (was a window alias of render). Its sole reader is dashboard-actions.js
  // goTo('products'), which prefers _productLib.render() above and reads this
  // entry only after the lazy 'estimates' bundle has loaded. Idempotent: this
  // bundle also loads on customer.html, where the guard reuses the registry.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, { renderProductLibrary: render });

  // ============================================================================
  // EVENT WIRING — CSP-safe delegates (inline on* never executes on /pro pages)
  // ============================================================================
  // Controls render with data-pl-action (+ data-pl-id); the search box and the
  // modal pricing inputs are handled by a delegated 'input' listener. Bound
  // once at document scope so handlers survive every innerHTML re-render.
  if (!window._NBD_PL_DELEGATE_BOUND) {
    window._NBD_PL_DELEGATE_BOUND = true;

    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-pl-action]');
      if (!t) return;
      const fn = window._productLib && window._productLib[t.dataset.plAction];
      // landing-page.js uses the same data-pl-action attribute for its own
      // actions — only dispatch names _productLib actually exposes.
      if (typeof fn !== 'function') return;
      try {
        if (t.dataset.plId !== undefined) fn(t.dataset.plId);
        else fn();
      } catch (e) {
        console.error('[product-library] dispatch ' + t.dataset.plAction + ' failed:', e);
      }
    });

    document.addEventListener('input', function (ev) {
      const el = ev.target;
      if (!el || !el.id) return;
      if (el.id === 'product-search') {
        setFilter(undefined, el.value);
        // setFilter re-renders the view, replacing this input — restore focus
        // and caret so typing isn't interrupted mid-word.
        const fresh = document.getElementById('product-search');
        if (fresh && fresh !== el) {
          fresh.focus();
          fresh.setSelectionRange(fresh.value.length, fresh.value.length);
        }
      } else if (/^pm-(?:sell|cost)-(?:good|better|best)$/.test(el.id) || el.id === 'pm-labor-perunit') {
        recalcModalMargins();
      }
    });
  }

  // Auto-load
  loadProducts();
  cloudHydrate();

})();

// ════════════════════════════════════════════════════════════
// Estimate rate table + product-library sync (Rock 2 PR 6)
// ════════════════════════════════════════════════════════════
//
// Moved verbatim out of estimates.js. This block is the ONLY writer of
// window.R, which eager property-intel.js reads for its project-value
// estimate — so it cannot live inside the classic engine that is being
// retired. It belongs here because it reads window._productLib, which
// this file defines, and this file already loads earlier in the
// estimates bundle than estimates.js did.

// Default pricing table (Cincinnati/Ohio market fallback)
//
// UNIT CONVENTION: all SF-based items (shingle, felt, tear, iws, deck)
// are stored PER SQUARE (100 SF), not per SF. The calcTierPrices()
// formulas multiply by `sq` (the count of 100-SF squares), so these
// rates must be dollars per square. Historical bug: previously these
// were stored as per-SF ($4.25/SF for shingle) but the formula used
// squares, producing estimates ~30x below real market. Example of
// the fix impact: a 54-sq (3900 SF raw) Good-tier reroof was quoting
// $1,194 — now correctly quotes ~$12,000.
//
// LF items (starter, drip, ridge, hip, gutter) stay per LF.
// Count items (pipe) stay per EA.
const DEFAULT_RATES = {
  // SF-based materials — PER SQUARE (100 SF)
  shingle: 135,    // $/SQ — 30-yr architectural retail installed
  felt: 35,        // $/SQ — synthetic underlayment
  tear: 75,        // $/SQ — tear-off labor (1 layer)
  iws: 95,         // $/SQ — ice & water shield
  deck: 145,       // $/SQ — OSB decking material + labor
  // LF-based — PER LINEAR FOOT
  starter: 2.10,   // $/LF
  drip: 1.85,      // $/LF
  ridge: 5.50,     // $/LF ridge cap
  hip: 5.75,       // $/LF hip cap
  gutter: 8.50,    // $/LF seamless aluminum
  // Count-based
  pipe: 45.00,     // $/EA — pipe boot
  // Fractional
  deckPct: 0.15    // 15% deck allowance
};

// Product Library → Estimate Rate Mapping.
// Each entry says: "when syncRatesFromProductLibrary() runs, look up
// product.pricing[tier].sell and multiply by unitConvert to produce
// the value stored in window.R[key]."
//
// Product prices are native to their own units (per SQ for shingles,
// per 25-LF bundle for ridge, etc.). unitConvert bridges that to the
// rate unit required by the calcTierPrices formulas.
//
// For SF-based items the target unit is PER SQ (100 SF), matching
// the DEFAULT_RATES convention above. Previously these used 1/100
// to convert to per-SF, which produced rates the formula couldn't
// use correctly.
const PRODUCT_MAP = {
  shingle: { id: 'shingle_001', unitConvert: 1 },     // product per SQ → rate per SQ
  felt:    { id: 'under_001',   unitConvert: 1 },     // product per SQ → rate per SQ
  tear:    null,                                        // labor only — no product mapping
  starter: { id: 'flash_008',   unitConvert: 1/100 }, // product per 100-LF bundle → rate per LF
  drip:    { id: 'flash_003',   unitConvert: 1 },     // product per LF → rate per LF
  ridge:   { id: 'flash_007',   unitConvert: 1/25 },  // product per 25-LF bundle → rate per LF
  iws:     { id: 'under_006',   unitConvert: 1/2 },   // product per 2-SQ roll (200 SF) → rate per SQ
  hip:     { id: 'flash_007',   unitConvert: 1/25 },  // same as ridge
  pipe:    { id: 'flash_002',   unitConvert: 1 },     // product per EA → rate per EA
  deck:    null,                                        // decking — use default rate
  gutter:  null                                         // gutters — use default rate
};

// Which product pricing column a tier reads. Products carry good/better/best
// only; Economy reads Good and Beyond reads Best (estimate-config.js
// PRODUCT_TIER, the same mapping the V2 engine and the old builder's internal
// cost view use). Without it an Economy/Beyond sync found no column and fell
// back to DEFAULT_RATES. Inline fallback only if estimate-config is missing.
function _rateColumn(tier) {
  const cfg = window.NBD_ESTIMATE_CONFIG;
  if (cfg && typeof cfg.productTier === 'function') return cfg.productTier(tier);
  return ({ economy: 'good', beyond: 'best' })[tier] || tier;
}

// Build window.R by pulling live pricing from product library, falling back to defaults
function syncRatesFromProductLibrary(tier) {
  tier = tier || 'better';
  const col = _rateColumn(tier);
  const rates = Object.assign({}, DEFAULT_RATES);

  if (window._productLib && typeof window._productLib.getProducts === 'function') {
    const products = window._productLib.getProducts();
    for (const [key, mapping] of Object.entries(PRODUCT_MAP)) {
      if (!mapping) continue;
      const product = products.find(p => p.id === mapping.id);
      if (product && product.pricing && product.pricing[col]) {
        // Convert product sell price to per-unit rate used by estimates
        rates[key] = product.pricing[col].sell * mapping.unitConvert;
      }
    }
  }

  window.R = rates;
  return rates;
}

// Initialize rates — try product library first, then defaults
if (typeof window.R === 'undefined' || !window.R) {
  syncRatesFromProductLibrary('better');
}

// getProductName() in estimates.js resolves product display names through
// this map. Exported explicitly rather than leaning on cross-file global
// const scoping, so the dependency is greppable and survives file moves.
window.NBD_ESTIMATE_PRODUCT_MAP = PRODUCT_MAP;
window.syncRatesFromProductLibrary = syncRatesFromProductLibrary;
