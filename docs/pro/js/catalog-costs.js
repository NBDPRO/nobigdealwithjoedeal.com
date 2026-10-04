/**
 * catalog-costs.js — the TENANT's own catalog cost book.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHAT CHANGED AND WHY. product-data.js and roofivent-catalog.js are static
 * files under docs/, which is hosting.public AND a public GitHub repo. They
 * used to carry wholesale `cost` beside retail `sell` for every SKU (GAF
 * Timberline HDZ: sell 240 / cost 82 — a 66% margin anyone could compute),
 * plus overheadMultiplier and profitMarginPct on every labor block. That was
 * two leaks at once:
 *
 *   1. anyone could read one company's buy prices off a URL, and
 *   2. every OTHER tenant was seeded with those same figures as their
 *      "defaults" — one company's supplier terms became the whole platform's
 *      starting pricing.
 *
 * Both are closed by making cost data TENANT-OWNED. The published catalog now
 * carries spec + retail `sell` only (retail is already printed on every
 * homeowner estimate, so publishing it costs nothing). Cost and the whole
 * `labor` block live in Firestore at catalogCosts/{companyId} — readable by
 * that tenant's members, writable by its owner/company_admin, and never
 * distributed to anyone else. There is no platform-wide copy.
 *
 * A TENANT WITH NO COST BOOK HAS NO COSTS. That is the correct state, not a
 * bug: `cost` is absent, and product-library.js renders "Cost not set" rather
 * than inventing a 100% margin. Filling it in is the tenant's job.
 *
 * LOAD ORDER (script-loader.js `estimates` bundle):
 *   product-data → roofivent-catalog → catalog-costs → product-library → …
 *
 * Two paths, because product-library.js seeds localStorage SYNCHRONOUSLY at
 * the bottom of its IIFE and a Firestore read cannot be awaited in front of a
 * <script> tag:
 *
 *   WARM DEVICE — the tenant-keyed cache is applied to window.NBD_PRODUCTS at
 *   load, before product-library runs, so seedDefaults()/migrateStore() see a
 *   complete catalog exactly as they did when costs were inline.
 *
 *   COLD DEVICE — no cache. product-library seeds sell-only, hydrate() reads
 *   Firestore, and _productLib.applyCostSeed() patches the store in place. It
 *   patches ONLY untouched defaults, so a rep who already edited a product
 *   keeps their numbers, and it deliberately does NOT bump updatedAt — doing
 *   so would mark every product user-edited and permanently freeze
 *   migrateStore's ability to land future catalog fixes.
 *
 * UPGRADE PATH FOR EXISTING TENANTS. Before this change every tenant's costs
 * lived only in per-device localStorage (nbd_product_library). If the tenant
 * has no cost book yet but this device's store DOES have costs, adoptLocal()
 * uploads them once — so nobody loses the numbers they have been quoting off,
 * and a second device stops silently disagreeing with the first (the same
 * per-device drift #1139 fixed for county overrides).
 *
 * The cache is per-device localStorage under an `nbd_`-prefixed, tenant-keyed
 * name, so NBDAuth.purgeAccountStorage() drops it on sign-out and on account
 * switch — a shared device never hands the next rep the previous tenant's cost
 * book. Same cleanup the product library itself already relies on.
 *
 * ── JOB TEMPLATE COSTS (2026-08-18) ─────────────────────────────────────────
 *
 * The same leak, in a second subsystem. docs/pro/js/job-templates-data.js
 * shipped 84 `custom` line items carrying materialCost + laborCost — 146
 * non-zero contractor figures on a public URL and a public repo, beside a
 * public estimate-logic-engine.js carrying the markup constants. Same fix,
 * same document: this book now also carries a `jtCosts` map, keyed
 * 'jt-<slug(templateId)>-<index>' — the key job-templates.js has already been
 * computing for its EstimateBuilderV2.CATALOG bridge since v1, so the strip
 * was a pure deletion and no new identifier was minted.
 *
 * It rides catalogCosts/{companyId} rather than a new collection ON PURPOSE:
 * firestore.rules already governs every field of that document, so the
 * migration needed ZERO rules changes — and a rules typo is the failure mode
 * that locks a live tenant out of their own money data.
 *
 * Same two paths as products. WARM: the tenant-keyed cache is applied at parse
 * time, fourteen bundle entries before job-templates-data.js, so
 * job-templates.js's load-time registerAllCustomItems() already sees the
 * tenant's numbers. COLD: hydrate() reads Firestore and pushToJobTemplates()
 * calls JobTemplates.applyJtCostSeed(), which re-registers every custom item
 * at the real cost and drops the UI's price-band cache.
 *
 * A TENANT WITH NO COST BOOK HAS NO COSTS applies here too, with one
 * counter-intuitive twist worth stating where people will read it: the
 * unpriced state is an EXPLICIT ZERO plus a `costUnset` flag, never an omitted
 * key. estimate-logic-engine.js:803 resolves `laborId = item.laborId ||
 * inferLaborId(item)` BEFORE it tests `item.laborCost != null`, and
 * inferLaborId falls through to LABOR_BY_SUB[item.category] against the still-
 * public labor catalog. Omitting the key routes 14 of the 84 items to a real
 * labor rate and prices them confidently wrong — "Attic insulation baffles" at
 * $500 instead of $142.50, wearing a "Cost not set" badge. The zero keeps
 * labSource 'explicit'; `costUnset` is what presentation reads.
 *
 * See functions/job-template-cost-logic.js and
 * documentation/audit/JOB-TEMPLATE-COST-LEAK-2026-08-18.md.
 */

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  // v2 (2026-08-18): the book gained a `jtCosts` map. A page that somehow
  // loaded a v1 build first must be re-initialised, not short-circuited.
  if (window.NBDCatalogCosts && window.NBDCatalogCosts.__sentinel === 'nbd-catalog-costs-v2') return;

  const COLLECTION = 'catalogCosts';
  // Every map this document can hold. `costs` (products, 2026-07-30) and
  // `jtCosts` (job templates, PR-B) shipped first; each Phase-2 catalog owns
  // one more. Listed once so "is this a real book?" has a single answer — a
  // tenant legitimately holds some of these and not others, and requiring any
  // particular one has already thrown a valid cache away once.
  const BOOK_MAPS = ['costs', 'jtCosts', 'laborOps', 'xactCosts', 'v2Costs'];
  const hasAnyMap = function (o) {
    return !!o && typeof o === 'object' &&
      BOOK_MAPS.some(function (f) { return o[f] && typeof o[f] === 'object'; });
  };
  const CACHE_PREFIX = 'nbd_catalog_costs';
  const TIERS = ['good', 'better', 'best'];
  const FS_SDK = '/assets/vendor/firebase/12.19.0/firebase-firestore.js';
  // Matches SEED_VERSION in functions/catalog-cost-logic.js — stamped on a
  // book this client creates from scratch so the ops scripts can validate it.
  const SEED_VERSION = 1;

  // Neutral prefill for the Add-Product form when the tenant has set no labor
  // policy yet: no assumed markup, no assumed target margin.
  //
  // Written as named constants rather than an inline literal map so
  // tests/catalog-cost-privacy.test.js can keep the strictest possible rule —
  // "no numeric literal beside overheadMultiplier / profitMarginPct anywhere
  // in a catalog file". Inlining `{ overheadMultiplier: 1 }` would force that
  // guard to allow SOME number next to the key, and the next number to land
  // there might be a real one. (The guard caught exactly this while it was
  // being written.)
  const NEUTRAL_OVERHEAD = 1; // multiplier: 1 = straight cost passthrough
  const NEUTRAL_MARGIN = 0;   // percent
  const NEUTRAL_DEFAULTS = { overheadMultiplier: NEUTRAL_OVERHEAD, profitMarginPct: NEUTRAL_MARGIN };

  let book = null;        // { version, defaults, costs, jtCosts }
  let tenantKey = null;   // resolved companyId
  let inflight = null;
  let loaded = false;     // a Firestore read completed (exists or not)

  function cacheKeyFor(key) { return CACHE_PREFIX + ':' + key; }

  // ── cache ────────────────────────────────────────────────────────────────

  function readCache(key) {
    try {
      const raw = localStorage.getItem(cacheKeyFor(key));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // ANY map makes it a real book. A tenant can legitimately hold jtCosts
      // and no product `costs` (they use job templates but have never filled in
      // the Product Library) — insisting on `costs` would throw that cache away
      // on every load and leave their templates unpriced until Firestore
      // answered.
      return hasAnyMap(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(key, next) {
    try { localStorage.setItem(cacheKeyFor(key), JSON.stringify(next)); }
    catch (e) { console.warn('[catalog-costs] could not cache cost book:', e.message); }
  }

  /**
   * Guess the tenant key at PARSE time for the warm-path cache read, before
   * any await is possible. Only used to pick a cache to hydrate from; the
   * authoritative key comes from _resolveCompanyKey() during hydrate().
   * Reading the wrong tenant's cache is prevented by keying the cache per
   * tenant and by purgeAccountStorage() wiping it on account switch.
   */
  function syncTenantGuess() {
    try {
      const claims = window._userClaims;
      if (claims && claims.companyId) return String(claims.companyId);
      const u = (window.auth && window.auth.currentUser) || window._user || null;
      if (u && u.uid) return String(u.uid);
    } catch (e) { /* ignore */ }
    return null;
  }

  async function resolveKey() {
    if (typeof window._resolveCompanyKey === 'function') {
      try { return await window._resolveCompanyKey(); } catch (e) { /* fall through */ }
    }
    return syncTenantGuess();
  }

  // ── merge ────────────────────────────────────────────────────────────────

  /**
   * Merge one cost entry into one product, in place.
   * The single definition of "put the private half back" — product-library.js
   * calls this too, so the store and the in-memory catalog can never drift.
   * Returns true if anything changed.
   */
  function mergeInto(product, entry) {
    if (!product || !entry) return false;
    let touched = false;

    if (entry.cost) {
      if (!product.pricing || typeof product.pricing !== 'object') product.pricing = {};
      TIERS.forEach(function (t) {
        const cost = entry.cost[t];
        if (typeof cost !== 'number' || !isFinite(cost)) return;
        if (!product.pricing[t] || typeof product.pricing[t] !== 'object') product.pricing[t] = {};
        if (product.pricing[t].cost !== cost) { product.pricing[t].cost = cost; touched = true; }
      });
    }

    if (entry.labor && typeof entry.labor === 'object') {
      // REPLACE the labor block, don't just fill a missing one.
      //
      // This used to be gated on `!product.labor`, to avoid clobbering a
      // user's numbers. That protection is redundant — applyCostSeed()
      // already returns early for user-edited products (updatedAt !==
      // createdAt) before merge is ever called — and it was actively harmful:
      // a device whose store was written from the PRE-STRIP catalog already
      // carries the old public labor block (the leaked overheadMultiplier
      // 1.35 / profitMarginPct 25), and DATA_VERSION did not change, so
      // migrateStore never re-runs to clear it. The tenant's own labor
      // policy could therefore never land on that device — and if an
      // owner then saved such a product, recordProduct would push the
      // stale leaked policy back up into the tenant's book.
      if (JSON.stringify(product.labor) !== JSON.stringify(entry.labor)) {
        product.labor = Object.assign({}, entry.labor);
        touched = true;
      }
    }

    return touched;
  }

  /** Merge the book across a product array in place. Returns the count patched. */
  function applyToProducts(products, overlay) {
    const costs = overlay && overlay.costs;
    if (!Array.isArray(products) || !costs) return 0;
    let n = 0;
    products.forEach(function (p) {
      if (!p || !p.id) return;
      if (mergeInto(p, costs[p.id])) n++;
    });
    return n;
  }

  function applyToCatalog(overlay) {
    return applyToProducts(window.NBD_PRODUCTS || [], overlay);
  }

  function pushToLibrary(overlay) {
    try {
      const lib = window._productLib;
      if (lib && typeof lib.applyCostSeed === 'function') return lib.applyCostSeed(overlay);
    } catch (e) {
      console.warn('[catalog-costs] applyCostSeed failed:', e.message);
    }
    return 0;
  }

  /**
   * COLD-PATH bridge for job templates. job-templates.js reads jobItem() at
   * ITS load time (registerAllCustomItems), which on a warm device already
   * sees the cache — this is what makes the cold device catch up once the
   * Firestore read lands: re-register every custom item at the tenant's real
   * numbers and drop the UI's price-band cache so the cards repaint.
   *
   * Deliberately called on EVERY hydrate outcome, including "this tenant has
   * no book", because applyJtCostSeed also runs the legacy adoption: a
   * template forked before the 2026-08-18 strip still carries embedded costs
   * in users/{uid}/jobTemplates, and JobTemplates owns that store, so it is
   * the module that lifts them into the company book.
   */
  function pushToJobTemplates(overlay) {
    try {
      const jt = window.JobTemplates;
      if (jt && typeof jt.applyJtCostSeed === 'function') return jt.applyJtCostSeed(overlay);
    } catch (e) {
      console.warn('[catalog-costs] applyJtCostSeed failed:', e.message);
    }
    return 0;
  }

  // ── extract (the inverse of mergeInto) ───────────────────────────────────

  /**
   * Pull the cost half OUT of a product, for writing back to the tenant book.
   * Returns null when the product carries no cost data — so a product whose
   * cost the tenant has never set is never persisted as a row of zeroes.
   */
  function extractFrom(product) {
    if (!product || typeof product !== 'object') return null;
    const entry = {};

    const cost = {};
    let sawCost = false;
    TIERS.forEach(function (t) {
      const tier = product.pricing && product.pricing[t];
      const c = tier && tier.cost;
      if (typeof c === 'number' && isFinite(c)) { cost[t] = c; sawCost = true; }
    });
    if (sawCost) entry.cost = cost;

    if (product.labor && typeof product.labor === 'object') {
      const labor = {};
      let sawLabor = false;
      Object.keys(product.labor).forEach(function (k) {
        const v = product.labor[k];
        if (typeof v === 'number' && isFinite(v)) { labor[k] = v; sawLabor = true; }
      });
      if (sawLabor) entry.labor = labor;
    }

    return Object.keys(entry).length ? entry : null;
  }

  // ── Firestore ────────────────────────────────────────────────────────────

  // Firestore SDK accessor. Prefers an already-resolved module on
  // window.__NBD_FS__ so (a) a page that has loaded the SDK doesn't pay for a
  // second dynamic import and (b) tests/catalog-cost-seed.test.js can drive
  // the real read/write paths in a Node vm, where dynamic import of a
  // gstatic URL is not available. Falls back to the normal CDN import.
  async function fsMod() {
    if (window.__NBD_FS__) return window.__NBD_FS__;
    return import(FS_SDK);
  }

  async function readBook(key) {
    if (!window.db) return null;
    const { getDoc, doc } = await fsMod();
    // Cold boot: the Firestore WebChannel can still be establishing, so the
    // first getDoc throws "client is offline". Same retry the companyProfile
    // loader uses (QA 2026-06-21 #1); defined there, guarded here.
    const retry = window.nbdRetryOffline || (function (fn) { return fn(); });
    const snap = await retry(function () { return getDoc(doc(window.db, COLLECTION, key)); });
    if (!snap || !snap.exists()) return null;
    const data = snap.data() || {};
    return hasAnyMap(data) ? data : null;
  }

  /**
   * Write cost entries into the tenant book.
   *
   * Per-SKU REPLACE, whole-doc MERGE. Each entry goes through the dotted field
   * path `costs.<id>`, which replaces the value at that path outright; other
   * SKUs in the document are untouched, so two owners saving different
   * products never clobber each other.
   *
   * The distinction matters because Firestore's `{merge: true}` deep-merges
   * NESTED MAPS. A plain setDoc({costs: {abc: entry}}, {merge: true}) would
   * union the new entry with the stored one — so clearing a tier's Material
   * Cost (saveFromModal omits the key entirely) would leave the old number
   * alive in Firestore forever and resurrect it on the tenant's next device.
   * A dotted path is the only way to express "this SKU's costs are now
   * exactly this".
   *
   * updateDoc fails if the document doesn't exist yet, so the first write for
   * a tenant falls back to setDoc — which is correct there precisely because
   * there is nothing to deep-merge against.
   *
   * Resolves false (never throws) when the caller is a viewer/sales_rep —
   * firestore.rules limits writes to owner/company_admin, and a rep editing
   * their own local copy is a legitimate, non-fatal case.
   */
  /**
   * `field` selects which map on the document is being written: 'costs' (per
   * product SKU) or 'jtCosts' (per job-template custom item). Everything else
   * — dotted-path REPLACE, the setDoc fallback for a first write, the local
   * mirror, the permission-denied path — is identical for both, which is why
   * they share one function rather than growing a near-copy that drifts.
   */
  async function writeEntries(field, entries, extra) {
    const key = tenantKey || await resolveKey();
    if (!key || !window.db || !entries || !Object.keys(entries).length) return false;
    try {
      const mod = await fsMod();
      const { setDoc, updateDoc, doc } = mod;
      const ref = doc(window.db, COLLECTION, key);

      const paths = {};
      Object.keys(entries).forEach(function (id) { paths[field + '.' + id] = entries[id]; });
      if (extra && extra.defaults) paths.defaults = extra.defaults;

      let wrote = false;
      if (typeof updateDoc === 'function') {
        try { await updateDoc(ref, paths); wrote = true; }
        catch (e) { if (!/not-found|No document to update/i.test((e && (e.code || e.message)) || '')) throw e; }
      }
      if (!wrote) {
        const payload = { version: SEED_VERSION };
        payload[field] = {};
        Object.keys(entries).forEach(function (id) { payload[field][id] = entries[id]; });
        if (extra && extra.defaults) payload.defaults = extra.defaults;
        await setDoc(ref, payload, { merge: true });
      }

      // Keep the local view consistent with what we just wrote — REPLACE the
      // per-entry value here too, so a cleared cost disappears locally as well.
      book = book || {};
      book[field] = book[field] || {};
      Object.keys(entries).forEach(function (id) { book[field][id] = entries[id]; });
      if (extra && extra.defaults) book.defaults = extra.defaults;
      writeCache(key, book);
      return true;
    } catch (e) {
      const msg = (e && (e.code || e.message)) || '';
      if (/permission/i.test(msg)) {
        // Expected for a rep: firestore.rules restricts writes to owner/admin.
        console.info('[catalog-costs] cost book is owner/admin-writable; keeping this edit local');
      } else {
        console.warn('[catalog-costs] cost write failed:', msg);
      }
      return false;
    }
  }

  /**
   * ONE-TIME UPGRADE. Before per-tenant cost books, a tenant's costs existed
   * only in this device's localStorage (seeded from the then-public catalog,
   * plus whatever they edited). If the tenant has no book yet, adopt what this
   * device has so nothing is lost and the tenant's other devices converge.
   *
   * Guarded on `loaded` — a FAILED read must never be mistaken for "the tenant
   * has no costs", or a flaky boot would upload a half-empty book. Same
   * discipline as _companyProfileLoaded gating the jurisdictions replace.
   */
  async function adoptLocal() {
    if (!loaded || (book && book.costs && Object.keys(book.costs).length)) return 0;
    let products = [];
    try {
      const lib = window._productLib;
      products = (lib && typeof lib.getProducts === 'function') ? lib.getProducts() : [];
    } catch (e) { return 0; }
    const entries = {};
    let n = 0;
    products.forEach(function (p) {
      if (!p || !p.id) return;
      const entry = extractFrom(p);
      if (entry) { entries[p.id] = entry; n++; }
    });
    if (!n) return 0;
    const wrote = await writeEntries('costs', entries);
    if (wrote) console.info('[catalog-costs] adopted ' + n + ' local product costs into this company\'s cost book');
    return wrote ? n : 0;
  }

  // ── hydrate ──────────────────────────────────────────────────────────────

  /**
   * Ensure this device has the tenant's cost book and that it has been applied
   * to both window.NBD_PRODUCTS and the product-library store.
   *
   * Never rejects: an offline rep, a signed-out session, or a tenant that has
   * simply never entered costs all degrade to "no costs shown" — which the
   * Product Library renders as "Cost not set", not as a 100% margin.
   */
  function hydrate(opts) {
    const force = !!(opts && opts.force);
    if (!force && loaded) return Promise.resolve(book);
    if (inflight) return inflight;

    inflight = (async function () {
      const key = await resolveKey();
      if (!key) return book; // not signed in yet
      tenantKey = key;

      if (!book) {
        const cached = readCache(key);
        if (cached) { book = cached; applyToCatalog(book); pushToLibrary(book); pushToJobTemplates(book); }
      }

      let remote = null;
      try {
        remote = await readBook(key);
        loaded = true;
      } catch (e) {
        console.warn('[catalog-costs] cost book read failed:', (e && (e.code || e.message)) || e);
        return book; // keep the cache; do NOT set loaded (adoptLocal stays off)
      }

      if (remote) {
        book = remote;
        writeCache(key, book);
        applyToCatalog(book);
        pushToLibrary(book);
      }

      // adoptLocal() runs on BOTH branches, not only the no-remote one.
      //
      // It used to sit in the `else`, which was correct while `costs` was the
      // only map on the document. It stopped being correct the moment readBook
      // started accepting a jtCosts-only book (2026-08-18): a tenant seeded
      // with job-template costs but no product costs would take the `remote`
      // branch and PERMANENTLY skip the one-time upgrade that lifts their
      // product costs out of per-device localStorage. adoptLocal's own guard
      // ("book.costs is non-empty ⇒ return 0") already makes the
      // already-adopted case a no-op, so calling it unconditionally is
      // strictly safer than gating it on which half of the book came back.
      await adoptLocal();

      // Always, on every outcome — see pushToJobTemplates. A tenant with NO
      // book still needs this call, because it is what adopts a pre-strip
      // fork's embedded costs into the company book.
      pushToJobTemplates(book);

      // Same one-time upgrade for labor rates: `NBD_LABOR.updateRate` wrote
      // only to per-device localStorage before this book existed, so two reps
      // in one company could silently disagree about a rate. Guarded and
      // never throwing; a rep whose write is refused keeps their local value.
      try {
        const lab = window.NBD_LABOR;
        if (lab && typeof lab.adoptLocalOverrides === 'function') lab.adoptLocalOverrides();
      } catch (e) { /* best-effort */ }

      return book;
    })().then(function (r) { inflight = null; return r; },
             function (e) {
               inflight = null;
               console.warn('[catalog-costs] hydrate failed:', (e && e.message) || e);
               return book;
             });

    return inflight;
  }

  // ── boot: cache-first synchronous apply ──────────────────────────────────
  // Runs BEFORE product-library.js executes, so on any device this tenant has
  // used before, the catalog is whole by the time the store is seeded.
  //
  // It is also what makes `jobItem()` answer correctly on the warm path: this
  // file sits at `estimates` position 3, fourteen entries ahead of
  // job-templates-data.js, so `book` is already populated by the time
  // job-templates.js runs its load-time registerAllCustomItems(). No
  // pushToJobTemplates() here — window.JobTemplates does not exist yet, and
  // does not need to: it pulls.

  const guess = syncTenantGuess();
  if (guess) {
    const cached = readCache(guess);
    if (cached) { book = cached; tenantKey = guess; applyToCatalog(book); }
  }

  window.NBDCatalogCosts = {
    __sentinel: 'nbd-catalog-costs-v2',
    hydrate,
    mergeInto,
    applyToProducts,
    applyToCatalog,
    extractFrom,
    adoptLocal,
    get: function () { return book; },
    isLoaded: function () { return loaded; },

    /**
     * Persist one product's cost/labor to the tenant book. Called by
     * product-library.saveProduct so an owner's edit reaches their other
     * devices instead of dying in this browser's localStorage.
     * Fire-and-forget; resolves false for a caller without write permission.
     *
     * Writes the PRODUCT ONLY — never `defaults`. It used to lift the saved
     * product's overheadMultiplier / profitMarginPct up as the company-wide
     * policy, which meant editing one pass-through line item (a dumpster, a
     * permit) silently reset the Add-Product prefill for every rep in the
     * tenant to whatever that one SKU happened to carry. `defaults` is a
     * company-wide value — buildCostOverlay derives it as the MODE across the
     * whole catalog — so a single product is never evidence of it.
     */
    recordProduct: function (product) {
      const entry = extractFrom(product);
      if (!product || !product.id || !entry) return Promise.resolve(false);
      const entries = {};
      entries[product.id] = entry;
      return writeEntries('costs', entries);
    },

    /**
     * One job-template custom item's cost, keyed 'jt-<slug(templateId)>-<index>'
     * (functions/job-template-cost-logic.js:jtKey — job-templates.js computes
     * the identical string for the V2 catalog bridge).
     *
     * Returns null when this tenant has no entry, which is what makes
     * "Cost not set" a real, distinguishable state rather than a zero.
     * A stored entry that is not two finite numbers is treated as absent —
     * a corrupted book must not price work.
     */
    jobItem: function (key) {
      const map = book && book.jtCosts;
      const entry = key && map && map[key];
      if (!entry || typeof entry !== 'object') return null;
      const mat = Number(entry.materialCost);
      const lab = Number(entry.laborCost);
      if (!isFinite(mat) || !isFinite(lab)) return null;
      return { materialCost: mat, laborCost: lab };
    },

    /** Every job-template key this tenant has priced. Used by the adoption pass. */
    jobItemKeys: function () {
      const map = book && book.jtCosts;
      return map ? Object.keys(map) : [];
    },

    /**
     * Persist one job-template custom item's cost to the tenant book.
     * Fire-and-forget; resolves false for a caller without write permission
     * (firestore.rules limits writes to owner/company_admin — a sales_rep
     * forking a template is a legitimate, non-fatal case, and the caller is
     * expected to leave the item showing "Cost not set" rather than a 0).
     */
    recordJobItem: function (key, entry) {
      const mat = Number(entry && entry.materialCost);
      const lab = Number(entry && entry.laborCost);
      if (!key || !isFinite(mat) || !isFinite(lab) || mat < 0 || lab < 0) return Promise.resolve(false);
      const entries = {};
      entries[key] = { materialCost: mat, laborCost: lab };
      return writeEntries('jtCosts', entries);
    },

    /**
     * One labor action's tenant-owned figures, keyed by its NBD_LABOR id
     * ('LAB TO1'). Returns null when this tenant has no entry, which is what
     * lets estimate-labor-catalog.js fall through to the PUBLISHED starter
     * baseline rather than pricing at zero.
     *
     * Note the asymmetry with jobItem(), and it is deliberate: a job-template
     * custom item with no book entry has NO price and says so, because its
     * costs left the published file entirely. A labor action always has a
     * price, because `rate` is still published as the baseline — what the book
     * does here is OVERRIDE it with the tenant's own figure. Crew productivity
     * (hoursPerUnit/crewSize) is the half that genuinely left, so that half is
     * absent until a tenant fills it in, and nothing reads it anyway.
     */
    laborOp: function (id) {
      const map = book && book.laborOps;
      const entry = id && map && map[id];
      if (!entry || typeof entry !== 'object') return null;
      const out = {};
      ['rate', 'hoursPerUnit', 'crewSize'].forEach(function (k) {
        const v = Number(entry[k]);
        if (isFinite(v) && v >= 0) out[k] = v;
      });
      return Object.keys(out).length ? out : null;
    },

    /**
     * Persist one labor action's figures to the tenant book. Resolves false
     * for a caller without write permission (owner/company_admin only), which
     * is the expected outcome for a sales_rep and must not throw.
     */
    recordLaborOp: function (id, entry) {
      if (!id || !entry || typeof entry !== 'object') return Promise.resolve(false);
      const clean = {};
      ['rate', 'hoursPerUnit', 'crewSize'].forEach(function (k) {
        const v = Number(entry[k]);
        if (isFinite(v) && v >= 0) clean[k] = v;
      });
      if (!Object.keys(clean).length) return Promise.resolve(false);
      const entries = {};
      entries[id] = clean;
      return writeEntries('laborOps', entries);
    },

    /**
     * One xactimate line item's tenant-owned cost, keyed by its catalog code
     * ('RFG 3T20'). Returns null when this tenant has no entry, so
     * NBD_XACT_CATALOG.find() falls through to the PUBLISHED starter baseline
     * rather than pricing at zero.
     *
     * Returns engine-shaped keys (materialCost/laborCost) because that is what
     * resolveLineItem reads — the catalog's own `mat`/`lab` are mapped to these
     * at load (estimate-catalog-xactimate.js:1206-1207) and no longer exist on
     * the item by the time anything looks it up.
     */
    xactCost: function (code) {
      const map = book && book.xactCosts;
      const entry = code && map && map[code];
      if (!entry || typeof entry !== 'object') return null;
      const mat = Number(entry.materialCost);
      const lab = Number(entry.laborCost);
      if (!isFinite(mat) || !isFinite(lab) || mat < 0 || lab < 0) return null;
      return { materialCost: mat, laborCost: lab };
    },

    /**
     * One EstimateBuilderV2 package entry's tenant-owned cost, keyed by its
     * CATALOG key ('shingle-good'). Keys are `cost`/`labor` here because that
     * is the shape EBv2's own catalog uses.
     */
    v2Cost: function (key) {
      const map = book && book.v2Costs;
      const entry = key && map && map[key];
      if (!entry || typeof entry !== 'object') return null;
      const cost = Number(entry.cost);
      const labor = Number(entry.labor);
      if (!isFinite(cost) || !isFinite(labor) || cost < 0 || labor < 0) return null;
      return { cost: cost, labor: labor };
    },

    /** The whole v2 map, for overlaying a settings.catalog copy in one pass. */
    v2Costs: function () {
      const map = book && book.v2Costs;
      return (map && typeof map === 'object') ? map : null;
    },

    /** Bulk form of recordLaborOp — one write for a whole adopted override set. */
    recordLaborOps: function (entries) {
      const clean = {};
      Object.keys(entries || {}).forEach(function (id) {
        const src = entries[id] || {};
        const one = {};
        ['rate', 'hoursPerUnit', 'crewSize'].forEach(function (k) {
          const v = Number(src[k]);
          if (isFinite(v) && v >= 0) one[k] = v;
        });
        if (Object.keys(one).length) clean[id] = one;
      });
      if (!Object.keys(clean).length) return Promise.resolve(false);
      return writeEntries('laborOps', clean);
    },

    /** Bulk form of recordJobItem — one write for a whole duplicated template. */
    recordJobItems: function (entries) {
      const clean = {};
      Object.keys(entries || {}).forEach(function (k) {
        const mat = Number(entries[k] && entries[k].materialCost);
        const lab = Number(entries[k] && entries[k].laborCost);
        if (isFinite(mat) && isFinite(lab) && mat >= 0 && lab >= 0) {
          clean[k] = { materialCost: mat, laborCost: lab };
        }
      });
      if (!Object.keys(clean).length) return Promise.resolve(false);
      return writeEntries('jtCosts', clean);
    },

    /** Add-Product form prefill: the tenant's own policy, or neutral. */
    defaults: function () {
      const d = book && book.defaults;
      return {
        overheadMultiplier: (d && typeof d.overheadMultiplier === 'number') ? d.overheadMultiplier : NEUTRAL_DEFAULTS.overheadMultiplier,
        profitMarginPct: (d && typeof d.profitMarginPct === 'number') ? d.profitMarginPct : NEUTRAL_DEFAULTS.profitMarginPct
      };
    },

    COLLECTION: COLLECTION,
    CACHE_PREFIX: CACHE_PREFIX,
    NEUTRAL_DEFAULTS: NEUTRAL_DEFAULTS
  };

  // Kick the read off without blocking the rest of the bundle.
  hydrate();

})();
