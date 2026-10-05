/**
 * NBD Pro - Job Templates ENGINE (no UI — see job-templates-ui.js)
 * Pre-built, editable quotes: template metadata + line items that resolve
 * through window.EstimateLogic (formulas, tier pricing, retail stamping).
 * Data: window.NBD_JOB_TEMPLATES / NBD_JOB_TEMPLATE_CATEGORIES (job-templates-data.js).
 * Custom/forked templates only in localStorage 'nbd_job_templates_v1' —
 * defaults are NEVER persisted (data file is the source of truth).
 *
 * COSTS ARE NOT IN THE DATA FILE (2026-08-18). Custom line items publish
 * their scope only; materialCost/laborCost come from the tenant's own book at
 * catalogCosts/{companyId}.jtCosts via window.NBDCatalogCosts.jobItem(), keyed
 * by the 'jt-<slug>-<index>' this file already computed for the V2 catalog
 * bridge. Template DEFINITIONS stay uid-scoped (a fork is personal); template
 * COSTS are company-scoped (a buy price is tenant-wide money policy a
 * sales_rep must not rewrite for everyone). A tenant with no book gets an
 * explicit 0 flagged costUnset — never an omitted key, see customLineItem.
 * documentation/audit/JOB-TEMPLATE-COST-LEAK-2026-08-18.md
 */

(function() {
  'use strict';
  if (typeof window === 'undefined') return;

  const STORAGE_KEY = 'nbd_job_templates_v1';
  const USAGE_KEY = 'nbd_jt_usage_v1';
  // Usage rollup lives as ONE sibling doc in the same subcollection as the
  // template mirror docs. Hydration MUST skip this id when loading
  // templates (it is not a template) and route it to the usage map.
  const USAGE_DOC_ID = '_usage';
  const DATA_VERSION = 1;

  // Fallback taxonomy — job-templates-data.js may not be loaded yet (lazy
  // bundle order) or may not exist; the engine must degrade, not throw.
  const FALLBACK_CATEGORIES = {
    roof_repair:       { label: 'Roof Repairs' },
    leak_flashing:     { label: 'Leak & Flashing' },
    gutters_repair:    { label: 'Gutter Repair & Maintenance' },
    gutters_install:   { label: 'Gutter Systems' },
    soffit_fascia:     { label: 'Soffit & Fascia' },
    ventilation:       { label: 'Ventilation & Energy' },
    roof_replacement:  { label: 'Full Roof Replacement' },
    specialty_roofing: { label: 'Specialty Roofing' },
    storm_emergency:   { label: 'Storm / Emergency / Insurance' },
    exterior:          { label: 'Siding, Windows & Exterior' },
    maintenance:       { label: 'Maintenance & Inspection' }
  };

  // Overhead codes that make sense once per job, no matter how many
  // templates are merged into one estimate — merged down to ONE line whose
  // fixed qty is the MAX across occurrences (see resolveSelection).
  const SINGLETON_CODES = {
    'LAB MOB': 1, 'LAB DEMOB': 1, 'LAB CLN-M': 1, 'DSP HAUL': 1,
    'PRM RES-OH': 1, 'LAB PHOTO': 1, 'LAB WALK': 1,
    // MAT DEL is a per-JOB supplier delivery + fuel charge (2026-08-19). It has
    // to be a singleton for the same reason LAB MOB is: merging a reroof with a
    // gutter job into one estimate is ONE trip to the site, not two, and
    // billing the homeowner twice for the same delivery is a real overcharge —
    // the mirror of the under-charge that created this line.
    'MAT DEL': 1
  };

  // Workmanship warranty kinds a template may declare (job-templates-data.js
  // header; years live in NBD_ESTIMATE_CONFIG.WORKMANSHIP_WARRANTY).
  const WARRANTY_KINDS = ['roof', 'gutter_system', 'guard_only', 'install_default', 'repair', 'none'];

  // Typical-house measurement context — the BASE of the resolveSelection
  // overlay: DEFAULT_MEASUREMENTS ← each selected template's (possibly
  // PARTIAL) measurements object, in selection order ← opts.measurements
  // last (user always wins). A template's partial object (e.g.
  // {deckReplacePct: 1}) is an overlay, NEVER the whole context — using it
  // wholesale zeroed every formula-driven line (rawSqft/eaveLf/... all 0).
  const DEFAULT_MEASUREMENTS = {
    rawSqft: 2000, pitch: 6, waste: 1.12, ridgeLf: 40, eaveLf: 120,
    rakeLf: 60, hipLf: 0, valleyLf: 20, wallLf: 0, pipes: 3, chimneys: 1,
    skylights: 0, stories: 1, tearOffLayers: 1, deckReplacePct: 0.15,
    cutUpRoof: false
  };

  // ═════════════════════════════════════════════════════════
  // Storage — customs only. Version bumps keep custom entries
  // (they're user data; there's nothing to re-seed).
  // ═════════════════════════════════════════════════════════

  function storage() {
    try { return window.localStorage || null; } catch (e) { return null; }
  }

  function loadCustoms() {
    const ls = storage();
    if (!ls) return [];
    try {
      const stored = ls.getItem(STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch (e) {
      console.error('[JobTemplates] load error:', e);
      return [];
    }
  }

  function persistCustoms(customs) {
    const ls = storage();
    if (ls) {
      try {
        ls.setItem(STORAGE_KEY, JSON.stringify({ _v: DATA_VERSION, items: customs }));
      } catch (e) {
        console.error('[JobTemplates] save error:', e);
      }
    }
    mirrorToFirestore(customs);
  }

  // Best-effort one-way Firestore mirror.
  // window._db is the MODULAR v10 instance — no db.batch()/db.collection();
  // use window.writeBatch + window.doc exposed by the dashboard bootstrap,
  // and guard if they aren't ready yet. Failure is non-fatal by design.
  function mirrorToFirestore(customs) {
    if (!window._db || !window._user?.uid) return;
    if (typeof window.writeBatch !== 'function' || typeof window.doc !== 'function') return;
    try {
      const db = window._db;
      const uid = window._user.uid;
      const batch = window.writeBatch(db);
      customs.forEach(tpl => {
        const ref = window.doc(db, 'users', uid, 'jobTemplates', tpl.id);
        batch.set(ref, tpl, { merge: true });
      });
      batch.commit().catch(e => console.error('[JobTemplates] Firestore mirror failed:', e));
    } catch (e) {
      console.error('[JobTemplates] Firestore mirror failed:', e);
    }
  }

  // ═════════════════════════════════════════════════════════
  // Usage tracking — {templateId: {n, last}} in localStorage,
  // mirrored as ONE doc users/{uid}/jobTemplates/_usage.
  // Stamped on every successful createEstimate / insertIntoV2;
  // surfaced through list() as useCount / lastUsedAt.
  // ═════════════════════════════════════════════════════════

  function loadUsage() {
    const ls = storage();
    if (!ls) return {};
    try {
      const stored = ls.getItem(USAGE_KEY);
      if (!stored) return {};
      const parsed = JSON.parse(stored);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function persistUsage(usage) {
    const ls = storage();
    if (ls) {
      try { ls.setItem(USAGE_KEY, JSON.stringify(usage)); }
      catch (e) { console.error('[JobTemplates] usage save error:', e); }
    }
    mirrorUsage(usage);
  }

  // Best-effort one-way usage mirror — plain set (NOT merge): the local map
  // is the post-LWW merged truth, so overwriting keeps pruned entries dead.
  function mirrorUsage(usage) {
    if (!window._db || !window._user || !window._user.uid) return;
    if (typeof window.doc !== 'function') return;
    try {
      const ref = window.doc(window._db, 'users', window._user.uid, 'jobTemplates', USAGE_DOC_ID);
      const payload = { kind: 'usage', usage: usage, updatedAt: new Date().toISOString() };
      let p = null;
      if (typeof window.setDoc === 'function') {
        p = window.setDoc(ref, payload);
      } else if (typeof window.writeBatch === 'function') {
        const batch = window.writeBatch(window._db);
        batch.set(ref, payload);
        p = batch.commit();
      }
      if (p && typeof p.catch === 'function') {
        p.catch(e => console.error('[JobTemplates] usage mirror failed:', e));
      }
    } catch (e) {
      console.error('[JobTemplates] usage mirror failed:', e);
    }
  }

  // Stamp {n++, last: now} for each involved template. Never throws —
  // usage is telemetry and must not fail the estimate that triggered it.
  function markUsed(templateIds) {
    try {
      const ids = (Array.isArray(templateIds) ? templateIds : [templateIds]).filter(Boolean);
      if (!ids.length) return;
      const usage = loadUsage();
      const now = Date.now();
      ids.forEach(id => {
        const prev = usage[id];
        const n = prev && isFinite(Number(prev.n)) && Number(prev.n) > 0 ? Number(prev.n) : 0;
        usage[id] = { n: n + 1, last: now };
      });
      persistUsage(usage);
    } catch (e) {
      console.error('[JobTemplates] markUsed failed:', e);
    }
  }

  // ═════════════════════════════════════════════════════════
  // Merged read model — defaults + customs, customs win on id.
  // ═════════════════════════════════════════════════════════

  function defaults() {
    return Array.isArray(window.NBD_JOB_TEMPLATES) ? window.NBD_JOB_TEMPLATES : [];
  }

  // A template's minJobCharge as a number, or NaN when it is missing, blank
  // or non-numeric (callers skip NaN — an invalid minimum is ignored).
  function _templateMinOrNaN(v) {
    if (v == null || typeof v === 'boolean' || String(v).trim() === '') return NaN;
    return Number(v);
  }

  function list() {
    const customs = loadCustoms();
    const usage = loadUsage();
    // SHALLOW COPY per entry: usage fields are a read-model overlay, never
    // mutated onto the shared default objects or the stored customs
    // (saveCustom strips them so persisted data stays canonical).
    const withUsage = (t) => {
      const u = t && t.id ? usage[t.id] : null;
      return Object.assign({}, t, {
        useCount: u && isFinite(Number(u.n)) && Number(u.n) > 0 ? Number(u.n) : 0,
        lastUsedAt: u && u.last != null && isFinite(Number(u.last)) ? Number(u.last) : null
      });
    };
    const customById = {};
    customs.forEach(t => { if (t && t.id) customById[t.id] = t; });
    const merged = [];
    const seen = {};
    defaults().forEach(t => {
      if (!t || !t.id) return;
      seen[t.id] = true;
      merged.push(withUsage(customById[t.id] || t));
    });
    customs.forEach(t => {
      if (t && t.id && !seen[t.id]) merged.push(withUsage(t));
    });
    return merged;
  }

  function get(id) {
    if (!id) return null;
    return list().find(t => t.id === id) || null;
  }

  function categories() {
    const data = window.NBD_JOB_TEMPLATE_CATEGORIES;
    const out = {};
    Object.keys(FALLBACK_CATEGORIES).forEach(k => { out[k] = FALLBACK_CATEGORIES[k]; });
    if (data && typeof data === 'object') {
      Object.keys(data).forEach(k => { out[k] = data[k]; });
    }
    // Categories referenced by templates but absent from both maps still
    // need a label so the library never renders an undefined chip.
    list().forEach(t => {
      const c = t.category;
      if (c && !out[c]) out[c] = { label: c.replace(/_/g, ' ') };
    });
    return out;
  }

  function search(q, filters) {
    filters = filters || {};
    const needle = String(q || '').toLowerCase().trim();
    return list().filter(t => {
      if (filters.category && t.category !== filters.category) return false;
      if (filters.jobType && t.jobType !== filters.jobType) return false;
      if (!needle) return true;
      return (t.name || '').toLowerCase().includes(needle)
        || (t.description || '').toLowerCase().includes(needle)
        || (t.category || '').toLowerCase().includes(needle)
        || (t.tags || []).some(tag => String(tag).toLowerCase().includes(needle));
    });
  }

  // ═════════════════════════════════════════════════════════
  // Custom CRUD — defaults are immutable; saving over a default
  // id shadows it as a custom fork (basedOn keeps the lineage).
  // ═════════════════════════════════════════════════════════

  function genId(name) {
    const slug = slugify(name || 'template') || 'template';
    return 'jt_custom_' + slug + '_' + Date.now().toString(36);
  }

  function saveCustom(tpl) {
    if (!tpl || typeof tpl !== 'object' || !(tpl.name || tpl.id)) return null;
    const customs = loadCustoms();
    const now = new Date().toISOString();
    const clean = JSON.parse(JSON.stringify(tpl)); // detach from caller/defaults
    // Usage fields are a list()-time overlay (localStorage map) — never
    // persist them into the stored template (duplicate()/edit flows pass
    // list() copies that carry them).
    delete clean.useCount;
    delete clean.lastUsedAt;
    if (!clean.id) clean.id = genId(clean.name);
    // COST DATA NEVER LANDS IN THE TEMPLATE DOC (2026-08-18). Templates are
    // uid-scoped (users/{uid}/jobTemplates); costs are company-scoped
    // (catalogCosts/{companyId}.jtCosts) because a buy price is tenant-wide
    // money policy, not one rep's preference. Without this split, forking a
    // default template re-embedded the very figures the strip removed — into
    // a doc with different scoping and a different write rule.
    //
    // Lifted out BEFORE persistCustoms, and forwarded to the book, so an
    // owner's edit still reaches their other devices. A rep's write is refused
    // by rules and resolves false; their edit stays local, which is the same
    // deal product-library.js already gives them.
    const lifted = liftCustomCosts(clean);
    const isDefaultId = defaults().some(d => d && d.id === clean.id);
    if (isDefaultId && !clean.basedOn) clean.basedOn = clean.id;
    clean.custom = true;
    clean.updatedAt = now;
    const idx = customs.findIndex(t => t && t.id === clean.id);
    if (idx >= 0) {
      clean.createdAt = customs[idx].createdAt || now;
      customs[idx] = clean;
    } else {
      clean.createdAt = now;
      customs.push(clean);
    }
    persistCustoms(customs);
    // Write the lifted costs to the company book, then re-bridge
    // (last-write-wins) so edited custom-item costs/names resolve at the NEW
    // values in this session's catalogs. The bridge runs regardless of whether
    // the book write succeeds — a rep whose write was refused still sees their
    // own edit for the rest of the session.
    writeLiftedCosts(clean.id, lifted);

    // Re-bridge from a snapshot that STILL CARRIES the costs, not from `clean`.
    //
    // liftCustomCosts() has just deleted them off `clean` (correctly — they
    // must not reach the uid-scoped template document), and the book write
    // above is ASYNC. Registering `clean` here therefore found neither a book
    // entry nor an embedded cost and registered the item as costUnset — so a
    // template the user had just given costs to showed "Cost not set" and
    // PRICED AT ZERO for the rest of the session, correcting only on the next
    // page load. Measured before this fix.
    //
    // The snapshot re-attaches the lifted values for registration only. It
    // resolves via customLineItem's legacy branch (costSource
    // 'legacy-template'), which is exactly right for the half-second before
    // the write lands; writeLiftedCosts re-registers on success and the source
    // becomes 'book'.
    registerCustomItems(withLiftedCosts(clean, lifted));
    return clean;
  }

  /**
   * A registration-only copy of `tpl` with lifted costs re-attached. Never
   * persisted and never returned to a caller — the whole point of lifting is
   * that these values do not live on the template document.
   */
  function withLiftedCosts(tpl, lifted) {
    const keys = Object.keys(lifted || {});
    if (!keys.length) return tpl;
    const copy = JSON.parse(JSON.stringify(tpl));
    keys.forEach(function (i) {
      const item = copy.items && copy.items[Number(i)];
      if (item && item.custom) {
        item.custom.materialCost = lifted[i].materialCost;
        item.custom.laborCost = lifted[i].laborCost;
      }
    });
    return copy;
  }

  /**
   * Remove materialCost/laborCost from every custom item on `tpl` (mutating
   * the already-detached clone) and hand them back keyed by item index.
   * Returns {} when the template carries none.
   */
  function liftCustomCosts(tpl) {
    const out = {};
    if (!tpl || !Array.isArray(tpl.items)) return out;
    tpl.items.forEach(function (item, i) {
      const c = item && item.custom;
      if (!c || typeof c !== 'object') return;
      if (c.materialCost == null && c.laborCost == null) return;
      const mat = Number(c.materialCost) || 0;
      const lab = Number(c.laborCost) || 0;
      delete c.materialCost;
      delete c.laborCost;
      out[i] = { materialCost: mat, laborCost: lab };
    });
    return out;
  }

  /** Push lifted costs into the tenant book under this template's keys. */
  function writeLiftedCosts(templateId, lifted) {
    const keys = Object.keys(lifted || {});
    if (!templateId || !keys.length) return false;
    const cc = window.NBDCatalogCosts;
    if (!cc || typeof cc.recordJobItems !== 'function') return false;
    const entries = {};
    keys.forEach(function (i) { entries[jtCostKey(templateId, Number(i))] = lifted[i]; });
    try {
      const p = cc.recordJobItems(entries);
      if (p && typeof p.then === 'function') {
        // RE-REGISTER once the write lands, so the entry's costSource flips
        // from the transitional 'legacy-template' to 'book' and every later
        // read resolves through the company book. Without this the session
        // keeps pricing off the snapshot, which is right by value but wrong by
        // provenance — and would silently diverge the moment another device
        // edits the same item.
        p.then(function (wrote) {
          if (!wrote) return;              // a rep's refusal: keep the local view
          try {
            const tpl = get(templateId);
            if (tpl) registerCustomItems(tpl);
            const ui = window.JobTemplatesUI;
            if (ui && typeof ui.clearBandCache === 'function') ui.clearBandCache();
          } catch (e) { /* best-effort repaint */ }
        }, function () { /* refusal is expected for a rep */ });
      }
    } catch (e) { return false; }
    return true;
  }

  function duplicate(id) {
    const src = get(id);
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = genId(src.name);
    copy.name = (src.name || 'Template') + ' (copy)';
    copy.basedOn = src.id;
    // genId() mints a NEW template id, so every cost-book key changes and the
    // duplicate would otherwise resolve entirely unpriced. Carry the SOURCE's
    // book entries onto the new keys. If the write is refused (a sales_rep),
    // the copy shows "Cost not set" — which is the honest outcome, and never
    // a silent $0.
    const carried = {};
    const cc = window.NBDCatalogCosts;
    if (cc && typeof cc.jobItem === 'function' && Array.isArray(src.items)) {
      src.items.forEach(function (item, i) {
        if (!item || !item.custom) return;
        const entry = cc.jobItem(jtCostKey(src.id, i));
        if (entry) carried[i] = entry;
      });
    }
    const saved = saveCustom(copy);
    if (saved) writeLiftedCosts(saved.id, carried);
    return saved;
  }

  // Removes a CUSTOM entry only. Removing a shadow restores the default.
  // Best-effort cloud cleanup: the one-way mirror (persistCustoms) never
  // deletes, so without this the removed doc lives in Firestore forever and
  // any future sync/read path resurrects it. Guarded + never throws.
  function remove(id) {
    const customs = loadCustoms();
    const idx = customs.findIndex(t => t && t.id === id);
    if (idx === -1) return false;
    customs.splice(idx, 1);
    persistCustoms(customs);
    // Drop the usage entry too — but ONLY for template ids that vanish
    // entirely. Removing a shadow restores the default under the same id,
    // and its usage history still belongs to that template.
    try {
      if (!defaults().some(d => d && d.id === id)) {
        const usage = loadUsage();
        if (usage[id]) { delete usage[id]; persistUsage(usage); }
      }
    } catch (e) { /* usage cleanup is best-effort */ }
    try {
      if (window._db && window._user && window._user.uid
          && typeof window.deleteDoc === 'function' && typeof window.doc === 'function') {
        const p = window.deleteDoc(window.doc(window._db, 'users', window._user.uid, 'jobTemplates', id));
        if (p && typeof p.catch === 'function') {
          p.catch(e => console.error('[JobTemplates] Firestore delete failed:', e));
        }
      }
    } catch (e) {
      console.error('[JobTemplates] Firestore delete failed:', e);
    }
    return true;
  }

  // ═════════════════════════════════════════════════════════
  // Custom line items — synthetic 'JT <SLUG>' codes bridged into
  // the builder catalogs (xactimate bridge pattern).
  // ═════════════════════════════════════════════════════════

  function slugify(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/\-+/g, '-');
  }

  // Deterministic synthetic code — keyed by TEMPLATE ID + ITEM INDEX (not
  // the item name) so (a) same-named custom items in different templates
  // never collide onto one catalog entry, and (b) the code derives
  // identically in every session, letting saved estimates resolve their
  // 'JT *' rows on reopen.
  function customCode(templateId, itemIndex) {
    return 'JT ' + slugify(templateId).toUpperCase() + '-' + itemIndex;
  }

  // The tenant cost-book key for one custom item. Same string
  // registerCustomItems has always used for the EstimateBuilderV2.CATALOG
  // bridge, now also the Firestore key under catalogCosts/{companyId}.jtCosts.
  // MUST stay identical to jtKey() in functions/job-template-cost-logic.js —
  // tests/job-template-cost-seed.test.js pins both sides against the live data.
  function jtCostKey(templateId, itemIndex) {
    return 'jt-' + slugify(templateId) + '-' + itemIndex;
  }

  // Line-item shape resolveLineItem expects. Costs are CONTRACTOR COST —
  // explicit materialCost/laborCost win inside the engine, which then
  // stamps retail (+25% material markup, 10/10 OH&P at rollup).
  //
  // The costs no longer come from the data file (2026-08-18). They come from
  // the TENANT's own cost book — catalogCosts/{companyId}.jtCosts, keyed by
  // the same 'jt-<slug>-<index>' this file already computes for the V2 catalog
  // bridge. docs/ is the Firebase Hosting root on a public repo, and this
  // library shipped 84 contractor cost pairs to anyone who fetched the URL.
  // See documentation/audit/JOB-TEMPLATE-COST-LEAK-2026-08-18.md.
  function customLineItem(custom, templateId, itemIndex) {
    const key = jtCostKey(templateId, itemIndex);
    let mat = null, lab = null, costSource = null;

    const cc = window.NBDCatalogCosts;
    const entry = (cc && typeof cc.jobItem === 'function') ? cc.jobItem(key) : null;
    if (entry) {
      mat = Number(entry.materialCost);
      lab = Number(entry.laborCost);
      costSource = 'book';
    } else if (custom.materialCost != null || custom.laborCost != null) {
      // LEGACY. A template forked BEFORE the strip still carries embedded
      // costs in users/{uid}/jobTemplates — saveCustom's deep clone has been
      // persisting them all along. Read them so that tenant's pricing does not
      // fall over on deploy day; adoptLegacyCosts() lifts them into the
      // company book on the next hydrate. DELETE THIS BRANCH once no tenant
      // hits it. (2026-08-18)
      mat = Number(custom.materialCost) || 0;
      lab = Number(custom.laborCost) || 0;
      costSource = 'legacy-template';
    }

    return {
      code:         customCode(templateId, itemIndex),
      name:         custom.name || 'Custom item',
      description:  custom.desc || '',
      category:     custom.category || 'custom',
      unit:         custom.unit || 'EA',
      // EXPLICIT ZERO. NEVER AN OMITTED KEY.
      //
      // estimate-logic-engine.js:803 computes
      //   const laborId = item.laborId || inferLaborId(item);
      // BEFORE it tests `item.laborCost != null` at :806, and inferLaborId
      // falls through to LABOR_BY_SUB[item.category] against
      // estimate-labor-catalog.js — a file that is still public. Omitting the
      // key therefore does not produce "no price"; it produces a price
      // re-derived from data we did not close. Measured across the 84 items:
      // 14 of them (categories gutters/ventilation/downspout/trim/soffit) land
      // on a live NBD_LABOR rate. "Attic insulation baffles" prices at $500.00
      // instead of $142.50 — a confidently wrong number wearing a
      // "Cost not set" badge, which is strictly worse than the $0.00 the
      // omission was meant to avoid.
      //
      // An explicit 0 keeps labSource 'explicit' and prices the line at 0.
      // `costUnset` is what the UI reads to render "—" instead of "$0.00";
      // the engine ignores it.
      materialCost: Number.isFinite(mat) ? mat : 0,
      laborCost:    Number.isFinite(lab) ? lab : 0,
      costUnset:    costSource === null,
      costSource:   costSource,
      tier:         'any',
      source:       'job-template'
    };
  }

  function registerCustomItems(tpl) {
    if (!tpl || !tpl.id || !Array.isArray(tpl.items)) return [];
    const registered = [];
    tpl.items.forEach((item, i) => {
      if (!item || !item.custom || !item.custom.name) return;
      const line = customLineItem(item.custom, tpl.id, i);
      const key = jtCostKey(tpl.id, i);
      // V2 catalog bridge — LAST write wins: saveCustom edits (new costs,
      // renamed items) must take effect immediately; first-registration-wins
      // kept resolving inserts at stale pre-edit prices.
      if (window.EstimateBuilderV2 && window.EstimateBuilderV2.CATALOG) {
        window.EstimateBuilderV2.CATALOG[key] = {
          code:      line.code,
          name:      line.name,
          category:  line.category,
          unit:      line.unit,
          cost:      line.materialCost,
          labor:     line.laborCost,
          // Carried so a consumer of the V2 catalog can tell "this tenant has
          // not priced it" from "this tenant prices it at zero".
          costUnset: line.costUnset
        };
      }
      // The V2 UI resolves scope by NBD_XACT_CATALOG.find(code) — the JT
      // code must be findable there or insertIntoV2 scope entries silently
      // drop at getCurrentEstimate. byCode only; the xact search stays clean.
      const xact = window.NBD_XACT_CATALOG;
      if (xact && xact.byCode) {
        xact.byCode[line.code] = line;
      }
      registered.push(key);
    });
    return registered;
  }

  // Load-time bridge: register EVERY template's custom items (defaults +
  // stored customs) so 'JT *' codes inside previously-saved estimates
  // resolve on REOPEN in any session that loads this bundle — not just the
  // session that happened to run insertIntoV2. Re-run after saveCustom.
  function registerAllCustomItems() {
    list().forEach(registerCustomItems);
  }

  /**
   * Called by catalog-costs.js once the tenant's cost book has landed (the
   * COLD-device path: the Firestore read finishes long after this file ran its
   * load-time bridge against an empty book).
   *
   * Re-runs the whole registration — LAST-WRITE-WINS is already this bridge's
   * documented contract — so every 'JT *' entry in EstimateBuilderV2.CATALOG
   * and NBD_XACT_CATALOG.byCode is rebuilt at the tenant's real numbers, then
   * drops the UI's price-band cache so the library cards repaint from "no
   * band" to a real range.
   *
   * Also runs the legacy adoption, because this is the one moment when both
   * the book and the template store are known to exist.
   */
  function applyJtCostSeed() {
    let n = 0;
    try {
      n = list().reduce(function (acc, t) { return acc + registerCustomItems(t).length; }, 0);
    } catch (e) {
      console.error('[JobTemplates] applyJtCostSeed re-registration failed:', e);
    }
    try {
      const ui = window.JobTemplatesUI;
      if (ui && typeof ui.clearBandCache === 'function') ui.clearBandCache();
    } catch (e) { /* the UI may not be loaded; nothing to repaint */ }
    try { adoptLegacyCosts(); } catch (e) { /* best-effort, see below */ }
    return n;
  }

  /**
   * ONE-TIME UPGRADE for a tenant who forked a template BEFORE the 2026-08-18
   * strip. Their fork still carries materialCost/laborCost inside
   * users/{uid}/jobTemplates (saveCustom's deep clone persisted them), so it
   * prices correctly on this device via customLineItem's `legacy-template`
   * branch — but only on this device, and only until the branch is deleted.
   * Lift those figures into the company book so the tenant's other devices
   * converge, exactly as catalog-costs.adoptLocal() does for product costs.
   *
   * Never overwrites an entry the book already holds: the book is the
   * authority, a stale fork is not.
   *
   * CAVEAT worth knowing before you read a support ticket about it: this write
   * targets catalogCosts/{companyId}, which firestore.rules restricts to
   * owner/company_admin. A tenant whose forks live on a SALES REP's device
   * never migrates — recordJobItems resolves false and nothing throws. Their
   * templates keep pricing from the embedded legacy costs; they just stay
   * per-device. This is not "automatic for everyone".
   */
  function adoptLegacyCosts() {
    const cc = window.NBDCatalogCosts;
    if (!cc || typeof cc.recordJobItems !== 'function' || typeof cc.jobItem !== 'function') return 0;
    const entries = {};
    let n = 0;
    loadCustoms().forEach(function (tpl) {
      if (!tpl || !tpl.id || !Array.isArray(tpl.items)) return;
      tpl.items.forEach(function (item, i) {
        const c = item && item.custom;
        if (!c || (c.materialCost == null && c.laborCost == null)) return;
        const key = jtCostKey(tpl.id, i);
        if (cc.jobItem(key)) return;              // the book already knows better
        const mat = Number(c.materialCost) || 0;
        const lab = Number(c.laborCost) || 0;
        if (!(mat > 0 || lab > 0)) return;        // never adopt a row of zeroes
        entries[key] = { materialCost: mat, laborCost: lab };
        n++;
      });
    });
    if (!n) return 0;
    const p = cc.recordJobItems(entries);
    if (p && typeof p.then === 'function') {
      p.then(function (wrote) {
        if (wrote) console.info('[JobTemplates] adopted ' + n + ' legacy forked-template costs into this company\'s cost book');
      }, function () { /* refused writes are expected for a rep */ });
    }
    return n;
  }

  // ═════════════════════════════════════════════════════════
  // Cloud hydration — Firestore-first sync for custom templates.
  // ═════════════════════════════════════════════════════════

  function tplTime(t) {
    const v = t && t.updatedAt;
    if (!v) return 0;
    const ms = Date.parse(v);
    return isFinite(ms) ? ms : 0;
  }

  /**
   * hydrateFromCloud() — pull users/{uid}/jobTemplates ONCE at init (no
   * listeners) and merge into local storage:
   *   - custom templates: last-write-wins by updatedAt (ISO). Cloud must be
   *     STRICTLY newer to replace local; ties keep local (they're the same
   *     write echoed back). Cloud-only docs land locally (new device);
   *     local-side winners (offline edits / never-mirrored customs) are
   *     mirrored back up. Write-through stays on saveCustom/remove.
   *   - the _usage doc id is NEVER a template: it routes into the usage
   *     map with per-entry LWW by .last, and mirrors back up only when the
   *     local side had newer entries.
   *   - offline / logged out / SDK not ready: resolves false, local state
   *     untouched.
   * Custom-item JT codes re-register after the merge so estimates saved on
   * ANOTHER device resolve their 'JT *' rows in this session.
   * Returns Promise<boolean> (true = a cloud merge ran).
   */
  function hydrateFromCloud() {
    if (!window._db || !window._user || !window._user.uid) return Promise.resolve(false);
    if (typeof window.getDocs !== 'function' || typeof window.collection !== 'function') {
      return Promise.resolve(false);
    }
    let pull;
    try {
      pull = window.getDocs(window.collection(window._db, 'users', window._user.uid, 'jobTemplates'));
    } catch (e) {
      console.error('[JobTemplates] cloud hydrate failed:', e);
      return Promise.resolve(false);
    }
    return Promise.resolve(pull).then(snap => {
      const cloudTpls = [];
      let cloudUsage = null;
      const eachDoc = (d) => {
        if (!d) return;
        let data = null;
        try { data = typeof d.data === 'function' ? d.data() : null; } catch (e) { data = null; }
        if (!data || typeof data !== 'object') return;
        if (d.id === USAGE_DOC_ID) {
          // Usage rollup doc — route to the usage map, never the template list.
          cloudUsage = (data.usage && typeof data.usage === 'object') ? data.usage : {};
          return;
        }
        if (!data.id) data.id = d.id;
        cloudTpls.push(data);
      };
      if (snap && typeof snap.forEach === 'function') snap.forEach(eachDoc);
      else if (snap && Array.isArray(snap.docs)) snap.docs.forEach(eachDoc);

      // ── Custom templates: LWW by updatedAt ──
      const locals = loadCustoms();
      const byId = {};
      const order = [];
      locals.forEach(t => {
        if (t && t.id) { byId[t.id] = { tpl: t, src: 'local' }; order.push(t.id); }
      });
      const cloudTime = {};
      cloudTpls.forEach(t => {
        if (!t || !t.id) return;
        cloudTime[t.id] = tplTime(t);
        const cur = byId[t.id];
        if (!cur) { byId[t.id] = { tpl: t, src: 'cloud' }; order.push(t.id); return; }
        if (tplTime(t) > tplTime(cur.tpl)) byId[t.id] = { tpl: t, src: 'cloud' };
      });
      const merged = order.map(id => byId[id].tpl);
      // Local winners the cloud is missing (or holds stale) — push back up.
      const toUpload = merged.filter(t => byId[t.id].src === 'local'
        && (cloudTime[t.id] === undefined || tplTime(t) > cloudTime[t.id]));

      // Persist the merged view locally WITHOUT persistCustoms (its blanket
      // mirror would rewrite every cloud doc on every boot) …
      const ls = storage();
      if (ls) {
        try { ls.setItem(STORAGE_KEY, JSON.stringify({ _v: DATA_VERSION, items: merged })); }
        catch (e) { console.error('[JobTemplates] hydrate save error:', e); }
      }
      // … then mirror ONLY the local-side winners.
      if (toUpload.length) mirrorToFirestore(toUpload);

      // ── Usage map: per-entry LWW by .last ──
      if (cloudUsage) {
        const localUsage = loadUsage();
        const mergedUsage = {};
        let localNewer = false;
        const keys = {};
        Object.keys(localUsage).forEach(k => { keys[k] = 1; });
        Object.keys(cloudUsage).forEach(k => { keys[k] = 1; });
        Object.keys(keys).forEach(k => {
          const l = localUsage[k], c = cloudUsage[k];
          const lLast = l && isFinite(Number(l.last)) ? Number(l.last) : 0;
          const cLast = c && isFinite(Number(c.last)) ? Number(c.last) : 0;
          const win = (lLast >= cLast) ? (l || c) : c;
          if (!win) return;
          mergedUsage[k] = {
            n: isFinite(Number(win.n)) && Number(win.n) > 0 ? Number(win.n) : 0,
            last: isFinite(Number(win.last)) ? Number(win.last) : null
          };
          if (l && (lLast > cLast || !c)) localNewer = true;
        });
        if (ls) {
          try { ls.setItem(USAGE_KEY, JSON.stringify(mergedUsage)); }
          catch (e) { /* usage save is best-effort */ }
        }
        if (localNewer) mirrorUsage(mergedUsage);
      }

      // Re-bridge JT codes for every (possibly just-pulled) custom item so
      // saved estimates from other devices resolve on reopen HERE.
      registerAllCustomItems();
      // Repaint the library if the UI is live (guarded — the engine may
      // load standalone; reRender only repaints hosts that exist).
      if (window.JobTemplatesUI && typeof window.JobTemplatesUI.reRender === 'function') {
        try { window.JobTemplatesUI.reRender(); } catch (e) { /* UI's problem */ }
      }
      return true;
    }).catch(e => {
      // Offline / rules denial / transient — keep local state untouched.
      console.error('[JobTemplates] cloud hydrate failed:', e);
      return false;
    });
  }

  // ═════════════════════════════════════════════════════════
  // Selection → resolved estimate
  // ═════════════════════════════════════════════════════════

  // Accepts 'jt_id', {templateId}, or arrays of either.
  function normalizeSelection(selection) {
    const arr = Array.isArray(selection) ? selection : (selection ? [selection] : []);
    return arr.map(s => (typeof s === 'string' ? { templateId: s } : s)).filter(s => s && s.templateId);
  }

  // ─── Tier + workmanship warranty (2026-09-25) ───────────────────────
  // Good/Better/Best priced nothing on any template: tier reaches price only
  // through EstimateLogic.resolveMaterial(materialId, tier), and no template
  // line carries a materialId, so all 107 resolve to identical totals at every
  // tier (tests/job-template-honest-paperwork.test.js re-measures this). The
  // row still defaulted to 'better' and the paperwork printed that as
  // "Preferred" + a lifetime workmanship warranty. The row now shows only for
  // a template that says `tierPriced: true` — METADATA, never inferred from
  // the price band, which is blank for every template a tenant has not costed.
  // The tier path itself stays intact for the roofing ladder that will set it.
  function tiersApply(selection) {
    return normalizeSelection(selection).some(s => {
      const t = get(s.templateId);
      return !!(t && t.tierPriced === true);
    });
  }

  // A template's workmanship warranty kind. Defaults declare one explicitly.
  // A custom saved before the field existed (an edited default keeps the
  // default's id; a Duplicate records basedOn) inherits its default's kind.
  // A from-scratch custom with neither gets the cautious reading of its own
  // jobType: installs 2 yr, everything else no warranty unless the rep ticks
  // the repair box — never lifetime unless it is a roof replacement.
  function warrantyKindOf(tpl) {
    if (!tpl) return null;
    if (WARRANTY_KINDS.indexOf(tpl.warrantyKind) !== -1) return tpl.warrantyKind;
    const baseId = tpl.basedOn || tpl.id;
    const base = defaults().find(d => d && d.id === baseId);
    if (base && WARRANTY_KINDS.indexOf(base.warrantyKind) !== -1) return base.warrantyKind;
    if (tpl.category === 'roof_replacement') return 'roof';
    if (tpl.jobType === 'inspection') return 'none';
    if (tpl.jobType === 'install' || tpl.jobType === 'replacement') return 'install_default';
    return 'repair';
  }

  // The estimate-level warranty for a set of templates. Any roofing template
  // makes the whole estimate 'roof' (its wording is the unchanged roofing
  // wording); otherwise one shared kind, or 'mixed' with the per-template parts
  // NBDCustomerEstimateRows.estimateWarranty() names in the sentence.
  function selectionWarranty(tpls) {
    const parts = tpls.map(t => ({ name: String(t.name || ''), kind: warrantyKindOf(t) }));
    let kind = null;
    if (parts.some(p => p.kind === 'roof')) kind = 'roof';
    else if (parts.length) kind = parts.every(p => p.kind === parts[0].kind) ? parts[0].kind : 'mixed';
    return { kind, parts };
  }

  function itemChoice(choices, index) {
    if (!choices) return null;
    return choices[index] != null ? choices[index] : (choices[String(index)] || null);
  }

  // Validate a brand pick against the item's declared alternatives; an
  // arbitrary code here would bypass the catalog-codes CI validation.
  function pickBrandCode(item, choice) {
    if (!choice || !choice.brandCode || choice.brandCode === item.code) return item.code;
    const opts = item.brandOptions || [];
    return opts.some(o => o && o.code === choice.brandCode) ? choice.brandCode : item.code;
  }

  /**
   * resolveSelection(selection, opts) — canonical UI↔engine contract:
   *   selection: [{ templateId, itemChoices?: { <itemIndex>: {
   *     include: boolean,              // default true
   *     qty: number|null,              // fixed-qty override (0 is valid and honored)
   *     brandCode: string|null,        // the PICKED brandOptions code
   *     unitPriceOverride: number|null // rep-typed CUSTOMER retail $/unit
   *   } } }]
   *   opts: { tier, jobMode, measurements, county }
   *
   * Measurements context = DEFAULT_MEASUREMENTS ← each selected template's
   * (possibly partial) measurements, in selection order ← opts.measurements
   * LAST (user always wins).
   * Singleton overhead codes merge to ONE line whose fixed qty is the MAX
   * across occurrences (formula-driven occurrence counts as qty 1).
   * unitPriceOverride: the typed value IS the customer's per-unit retail
   * (pre-OH&P, same plane as every other line's retailPerUnit) — the line
   * resolves with materialCost=0, laborCost=<typed> since labor passes
   * through markup untouched, so retailPerUnit === typed exactly; OH&P/tax
   * still apply on top. Cost-split on such a line reads cost==retail
   * (rep-negotiated) by design. Pushes 'Priced manually: <name>'.
   * county → engine tax map; defaults '' — neutral "Other / My county"
   * (estimate-v2-ui parity; EstimateLogic fails safe at the 7% fallback).
   * opts.tier is honored only when a selected template is tierPriced.
   * Returns {lines, totals, measurements, minJobCharge, county,
   *          sourceTemplates, warnings, tierApplies, warrantyKind,
   *          warrantyParts}.
   */
  function resolveSelection(selection, opts) {
    opts = opts || {};
    const sel = normalizeSelection(selection);
    const warnings = [];
    // Custom items this tenant has no cost book entry for. Surfaced as ONE
    // warning at the end rather than N — job-templates-ui.js truncates the
    // warning list to ~3 lines, and "12 items need a cost" is the actionable
    // sentence anyway.
    const unpricedLines = [];
    const lineItems = [];
    const sourceTemplates = [];
    const usedTpls = [];
    const seenSingleton = {};   // code → { line, qty: effective fixed qty }
    const measurements = Object.assign({}, DEFAULT_MEASUREMENTS);
    let minJobCharge = null;

    const xact = window.NBD_XACT_CATALOG;

    sel.forEach(entry => {
      const tpl = get(entry.templateId);
      if (!tpl) {
        warnings.push('Unknown template: ' + entry.templateId);
        return;
      }
      sourceTemplates.push(tpl.id);
      usedTpls.push(tpl);

      // Overlay, never wholesale: a template's PARTIAL measurements object
      // (e.g. {deckReplacePct: 1}) merges over the typical-house defaults.
      if (tpl.measurements && typeof tpl.measurements === 'object') {
        Object.assign(measurements, tpl.measurements);
      }
      // Floor: MAX across selected templates — merging a repair into a
      // full job must never lower the job's trip-charge floor.
      // Only a real number counts (2026-10-05 bug #9): Number('abc') is NaN,
      // Math.max(…, NaN) is NaN and `total < NaN` is false, so one bad
      // template value used to drop EVERY valid floor in the selection.
      const tplMin = _templateMinOrNaN(tpl.minJobCharge);
      if (Number.isFinite(tplMin)) {
        minJobCharge = Math.max(minJobCharge != null ? minJobCharge : 0, tplMin);
      }

      (tpl.items || []).forEach((item, i) => {
        if (!item) return;
        const choice = itemChoice(entry.itemChoices, i);
        if (choice && choice.include === false) return;

        // Custom item — explicit costs + fixed qty, synthetic JT code.
        if (item.custom) {
          const c = item.custom;
          if (!c.name) return;
          const line = customLineItem(c, tpl.id, i);
          const qty = (choice && choice.qty != null) ? Number(choice.qty)
            : (c.qty != null ? Number(c.qty) : 1);
          line.qtyOverride = qty;
          if (choice && choice.unitPriceOverride != null) {
            // Override = customer per-unit retail. Priced as labor (no
            // material markup) so retailPerUnit lands exactly on it.
            //
            // This is ALSO the escape hatch for a tenant with no cost book:
            // typing a $/unit here prices the line exactly on the typed
            // number, so an unpriced template is still quotable today. Note it
            // already sets materialCost explicitly — it neither leaks a cost
            // basis nor trips the engine's labor inference — and the line is
            // no longer "unset" once a human has typed a price on it.
            line.materialCost = 0;
            line.laborCost = Number(choice.unitPriceOverride) || 0;
            line.costUnset = false;
            warnings.push('Priced manually: ' + line.name);
          }
          if (line.costUnset) unpricedLines.push(line.name);
          lineItems.push(line);
          return;
        }

        if (!item.code) return;
        const code = pickBrandCode(item, choice);
        const rawQty = (choice && choice.qty != null) ? choice.qty
          : (item.qty != null ? item.qty : null);
        const fixedQty = (rawQty !== null && rawQty !== '' && isFinite(Number(rawQty)))
          ? Number(rawQty) : null;

        if (SINGLETON_CODES[code] && seenSingleton[code]) {
          // Once-per-job code collision: keep ONE line at the MAX fixed qty
          // (formula-driven occurrence counts as qty 1) — mirrors the
          // minJobCharge 'never lower the floor' rule. First-wins was an
          // order-dependent undercharge (DSP HAUL 1 vs 2).
          const eff = fixedQty != null ? fixedQty : 1;
          const prev = seenSingleton[code];
          if (eff > prev.qty) {
            prev.qty = eff;
            prev.line.qtyOverride = eff;
          }
          return;
        }

        const base = xact && typeof xact.find === 'function' ? xact.find(code) : null;
        if (!base) {
          warnings.push('Unknown catalog code: ' + code + ' (template ' + tpl.id + ')');
          return;
        }
        // Non-destructive — spread a fresh object so the catalog's
        // original stays untouched (matches getCurrentEstimate).
        const line = Object.assign({}, base);
        if (fixedQty != null) {
          line.qtyOverride = fixedQty;
        }
        if (choice && choice.unitPriceOverride != null) {
          // Same semantics as the custom-item path above.
          line.materialCost = 0;
          line.laborCost = Number(choice.unitPriceOverride) || 0;
          line.fixedRetail = null; // the typed price wins over a catalog fixed price
          warnings.push('Priced manually: ' + (line.name || code));
        }
        if (SINGLETON_CODES[code]) {
          seenSingleton[code] = { line, qty: fixedQty != null ? fixedQty : 1 };
        }
        lineItems.push(line);
      });
    });

    if (opts.measurements && typeof opts.measurements === 'object') {
      Object.assign(measurements, opts.measurements);
    }

    // ONE warning, naming the action. A tenant with no cost book still gets a
    // complete scope of work — name, qty, unit, description — with no price on
    // the affected lines. Typing a $/unit per line (unitPriceOverride, above)
    // is how they quote it today; the in-app cost editor is follow-up work.
    if (unpricedLines.length) {
      warnings.push(unpricedLines.length + ' item' + (unpricedLines.length === 1 ? '' : 's') +
        ' need a cost — set your cost book or type a $/unit per line');
    }

    const county = opts.county || ''; // neutral default (estimate-v2-ui.js parity) — engine taxes at the 7% fallback

    // Tier + warranty travel with the resolve so buildEstimatePayload can
    // record them: whether a tier applies at all, and the job-type warranty.
    const tierApplies = usedTpls.some(t => t && t.tierPriced === true);
    const warranty = selectionWarranty(usedTpls);

    if (!window.EstimateLogic || typeof window.EstimateLogic.resolveEstimate !== 'function') {
      warnings.push('EstimateLogic not loaded — cannot resolve');
      return { lines: [], totals: null, measurements, minJobCharge, county, sourceTemplates, warnings,
        tierApplies, warrantyKind: warranty.kind, warrantyParts: warranty.parts };
    }

    // No tier applies → resolve at 'better' whatever the UI last held. The
    // engine still needs a rung to hand resolveMaterial, and every rung prices
    // the same here, so this changes no number; it only stops a stale tier
    // from riding along into the saved estimate.
    const settings = {
      tier: tierApplies ? (opts.tier || (sel[0] && sel[0].tier) || 'better') : 'better',
      mode: opts.jobMode || 'cash',
      county: county
    };
    if (minJobCharge != null) settings.minJobCharge = minJobCharge;

    const totals = window.EstimateLogic.resolveEstimate(lineItems, measurements, settings);
    return {
      lines: totals.lines,
      totals,
      measurements,
      minJobCharge,
      county,
      sourceTemplates,
      warnings,
      tierApplies,
      warrantyKind: warranty.kind,
      warrantyParts: warranty.parts
    };
  }

  // ═════════════════════════════════════════════════════════
  // Payload — classic + V2 compatible doc. PURE (no DOM; the one
  // window read is the pure deposit rule, window.NBDDepositRule — absent,
  // the deposit stays null and the invoice asks the rule itself) so it
  // unit-tests standalone.
  // ═════════════════════════════════════════════════════════

  /**
   * depositStamp(total, mode, meta) → { deposit, depositPlan } for a payload.
   * Deposit (2026-09-25): deposit-rule.js on the SAVED total. This saved
   * `deposit: meta.deposit` — which no caller passes — so every template
   * estimate stored null and the invoice fell back to 50%: a $555 repair
   * asked a $277.50 deposit. Now a sub-$2,000 cash job stores $0 and says
   * "No deposit"; a caller-supplied meta.deposit is a rep override.
   * Review fixes (same day): meta.deductible (the lead's recorded
   * deductible, passed by the build screen) reaches an insurance plan, so the
   * portal names the dollar deductible the invoice does; and createEstimate
   * re-stamps after upgrades move the total, so the saved plan is never for
   * a price the estimate no longer has.
   */
  // meta.lead, else meta.leadId in the loaded pipeline; null when unlinked.
  function _templateLead(meta) {
    if (meta && meta.lead && typeof meta.lead === 'object') return meta.lead;
    const id = meta && meta.leadId;
    if (!id || typeof window === 'undefined') return null;
    try {
      const cur = window._leadDoc;
      if (cur && cur.id === id) return cur;
      return (Array.isArray(window._leads) && window._leads.find((l) => l && l.id === id)) || null;
    } catch (_) { return null; }
  }

  function depositStamp(total, mode, meta) {
    meta = meta || {};
    const R = (typeof window !== 'undefined' && window.NBDDepositRule) || null;
    if (!R) return { deposit: (meta.deposit != null ? Number(meta.deposit) : null), depositPlan: null };
    const input = {
      total: total,
      mode: mode || 'cash',
      deductible: meta.deductible,
      // Kentucky hold (2026-09-27): the job's address decides.
      address: meta.addr || '',
      overrideAmount: (meta.deposit != null && meta.deposit !== '') ? meta.deposit : undefined
    };
    // The lead (2026-10-03): its claim number / carrier / jobType make a
    // Kentucky job an insurance job for the hold even in cash mode — the same
    // test that puts the KY notices on the contract.
    const lead = _templateLead(meta);
    if (lead) input.lead = lead;
    const plan = R.compute(input);
    return { deposit: plan.depositCents / 100, depositPlan: R.toStored(plan) };
  }

  /**
   * buildEstimatePayload(resolved, meta)
   *   resolved: resolveSelection() result (totals required)
   *   meta:     {name, leadId, addr, owner, deposit, deductible?, county?, repairWarranty?}
   * county persists (V2 _buildSavePayload parity — estimate-v2-ui.js:2120)
   * so reopen doesn't silently re-tax at a different rate; meta.owner/addr
   * pass through (blank default stays '').
   * rows[].rate/total carry the RETAIL price — the classic-row contract is
   * customer-facing (portal, classic views, invoice items print these
   * verbatim). Cost basis lives ONLY in the *CostPerUnit/*Total split
   * fields (B-8 reconstruction; money-math sweep 2026-07-18).
   */
  function buildEstimatePayload(resolved, meta) {
    meta = meta || {};
    const est = resolved && resolved.totals;
    if (!est) return null;
    const ctx = est.context || {};
    const m = resolved.measurements || {};
    const num = (v) => (v != null && isFinite(Number(v)) ? Number(v) : null);
    const mk = (num(est.materialMarkupPct) != null ? num(est.materialMarkupPct) : 0.25);
    // "No tier applies" is RECORDED, not implied (2026-09-25): tier and
    // selectedTier are null and tierApplies is false, so no reader can turn a
    // silent default back into "Preferred". Only an explicit
    // resolved.tierApplies === true (a tierPriced template) saves a tier.
    const tierApplies = resolved.tierApplies === true;
    const savedTier = tierApplies ? (est.tier || 'better') : null;
    const warrantyParts = Array.isArray(resolved.warrantyParts) ? resolved.warrantyParts : [];
    // The 1-year repair warranty is a per-estimate choice, off unless the rep
    // ticked it, and meaningless on a job with no repair part — or on one with
    // a roofing template, whose wording covers the whole estimate (the build
    // screen hides the box there).
    const repairWarranty = meta.repairWarranty === true
      && resolved.warrantyKind !== 'roof'
      && warrantyParts.some(p => p && p.kind === 'repair');
    const dep = depositStamp(est.total, est.mode || 'cash', meta);

    return {
      // Identity
      name:            meta.name || 'Template Estimate ' + new Date().toLocaleDateString(),
      builder:         'template',
      estimateVersion: 'v2',
      method:          est.method || 'line-item',
      tier:            savedTier,
      tierApplies:     tierApplies,
      mode:            est.mode || 'cash',
      insurance:       est.mode === 'insurance',
      sourceTemplates: resolved.sourceTemplates || [],
      // Workmanship warranty by job type — printed by every paperwork path
      // through NBDCustomerEstimateRows.estimateWarranty().
      warrantyKind:    resolved.warrantyKind || null,
      warrantyParts:   warrantyParts.map(p => ({ name: String((p && p.name) || ''), kind: (p && p.kind) || null })),
      repairWarranty:  repairWarranty,
      // Customer association
      leadId:          meta.leadId || null,
      addr:            meta.addr || '',
      owner:           meta.owner || '',
      // Tax jurisdiction — must round-trip or the V2 reopen path re-taxes
      // at ITS default and the saved grandTotal shifts on first edit.
      county:          resolved.county || meta.county || null,
      // Measurements (echoed so the estimate list can show them)
      raw:             Math.round(ctx.rawSqft || 0),
      adj:             Math.round(ctx.adjustedSqft || 0),
      sq:              Number((ctx.sq || 0).toFixed(2)),
      wf:              ctx.waste || 1.17,
      pl:              String(m.pitch || 6) + '/12',
      ridge:           ctx.ridgeLf || 0,
      eave:            ctx.eaveLf || 0,
      hip:             ctx.hipLf || 0,
      pipes:           ctx.pipes || 0,
      stories:         num(m.stories),
      tearOffLayers:   num(m.tearOffLayers),
      deckReplacePct:  num(m.deckReplacePct),
      rakeLf:          num(m.rakeLf),
      valleyLf:        num(m.valleyLf),
      wallLf:          num(m.wallLf),
      chimneys:        num(m.chimneys),
      skylights:       num(m.skylights),
      cutUpRoof:       !!m.cutUpRoof,
      // Rows — classic shape (code/desc/qty/rate/total) + B-8 fields.
      rows: (est.lines || []).map(line => {
        const matT = Number(line.materialTotal) || 0;
        const labT = Number(line.laborTotal) || 0;
        const retailTotal = Math.round(((line.retailTotal != null)
          ? Number(line.retailTotal)
          : ((matT === 0 && labT === 0)
              ? (Number(line.lineTotal) || 0)              // pass-through: face value
              : matT * (1 + mk) + labT)) * 100) / 100;
        const retailPerUnit = (line.retailPerUnit != null)
          ? Number(line.retailPerUnit)
          : (Number(line.materialCostPerUnit) || 0) * (1 + mk) + (Number(line.laborCostPerUnit) || 0);
        return {
          code:   line.code,
          desc:   line.name,
          qty:    (line.quantity || 0).toFixed(2) + (line.unit || ''),
          rate:   '$' + retailPerUnit.toFixed(2),
          total:  retailTotal,
          retailTotal: retailTotal,
          // B-8 reconstruction fields:
          quantity:            num(line.quantity),
          unit:                line.unit || '',
          category:            line.category || '',
          materialTotal:       num(line.materialTotal),
          laborTotal:          num(line.laborTotal),
          materialCostPerUnit: num(line.materialCostPerUnit),
          laborCostPerUnit:    num(line.laborCostPerUnit),
          unitPrice:           num(line.unitPrice),
          qtyOverride:         line.qtyOverridden ? num(line.quantity) : null
        };
      }),
      // Totals — grandTotal is the canonical customer total (RETAIL after
      // markup + OH&P + tax/minimum rules).
      grandTotal:      est.total,
      selectedTier:    savedTier,
      priceMode:       'line-item',
      deposit:         dep.deposit,
      depositPlan:     dep.depositPlan,
      materialCost:    est.materialCost,
      laborCost:       est.laborCost,
      subtotal:        est.subtotal,
      tax:             est.tax,
      taxAmount:       est.tax,
      taxRate:         est.taxRate,
      minJobApplied:   !!est.minJobApplied,
      // B-8 retail-scope reconstruction inputs
      materialMarkupPct: num(est.materialMarkupPct),
      retailBeforeOHP:   num(est.retailBeforeOHP),
      overhead:          num(est.overhead),
      overheadPct:       num(est.overheadPct),
      profit:            num(est.profit),
      profitPct:         num(est.profitPct),
      // Internal margin view — never customer-rendered
      internal:        est.internal || null
      // Timestamp handled by _saveEstimate (serverTimestamp)
    };
  }

  // ═════════════════════════════════════════════════════════
  // Upgrades & Add-ons (stage 2, 2026-09-25)
  // ═════════════════════════════════════════════════════════
  //
  // The build screen's Upgrades card (job-templates-ui.js) and its "Show
  // homeowner" page are UI over these functions, and createEstimate saves
  // through the SAME applyUpgrades the preview renders — so the card's
  // price, the preview line, the saved row and the change in the total are
  // one number (documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md).
  //
  // Upgrades never go through EstimateLogic: NBDUpgrades.price() emits
  // face-value retail rows and applyToEstimate() adds them AFTER the engine
  // (upgrade-pricing.js explains why a markup / O&P / $25-rounding pass would
  // print a different number than the one quoted).
  //
  // An upgrade selection (`up`), as the UI sends it:
  //   picks:            ['alurex', ...]  ids chosen, "Make required" ones too
  //   quantities:       { id: qty }      rep-typed; blank means "follow the
  //                                      gutter footage" (never a guess)
  //   required:         { id: true }     "Make required": base scope, not a choice
  //   recommended:      { id: 'reason' } a star counts only WITH a reason from
  //                                      this house, and at most two do
  //   declined:         { id: true }     the homeowner tapped "No thanks"
  //   shownToHomeowner: boolean          the Show homeowner page was opened

  const MAX_RECOMMENDED = 2;

  function upgradesApi() {
    const U = window.NBDUpgrades;
    return (U && typeof U.price === 'function' && typeof U.offeredFor === 'function') ? U : null;
  }

  // The tenant's own upgrade data, read from ONE place: what Settings →
  // Upgrade prices saves (#1762), companyProfile.pricing.upgradePrices =
  //   { <upgradeId>: { cents, enabled, installerName } }
  // passed EXPLICITLY, so the card and the save price from the same map the
  // owner edited. No saved map → {} = the library's Jo-approved prices alone
  // (never a guess: a needs_price item stays unofferable). The certified
  // installer is named per item there (installerName wins inside offeredFor);
  // with none saved the copy stays "an independent certified installer"
  // (tenant neutral). 2026-09-25: this read companyProfile.upgrades, which
  // nothing writes — the Settings lane's contract note asked for this switch.
  function tenantUpgradeSettings() {
    const cp = window._companyProfile;
    const up = cp && cp.pricing && cp.pricing.upgradePrices;
    return {
      overrides: (up && typeof up === 'object' && !Array.isArray(up)) ? up : {},
      tenant: {}
    };
  }

  function upgradeContext(resolved, up, taxRate) {
    const t = (resolved && resolved.totals) || {};
    return {
      templateIds: (resolved && resolved.sourceTemplates) || [],
      lines: (resolved && resolved.lines) || [],
      measurements: (resolved && resolved.measurements) || null,
      quantities: (up && up.quantities && typeof up.quantities === 'object') ? up.quantities : {},
      mode: t.mode || 'cash',
      // A Job Template estimate is always line-item; per-SQ only exists in V2.
      priceMode: 'line-item',
      taxRate: taxRate != null ? taxRate : t.taxRate,
      tenant: tenantUpgradeSettings().tenant
    };
  }

  /** The offers for a resolved selection (NBDUpgrades.offeredFor), [] when none. */
  function upgradeOffers(resolved, up) {
    const U = upgradesApi();
    if (!U || !resolved || !resolved.totals) return [];
    const ctx = upgradeContext(resolved, up);
    return U.offeredFor(ctx.templateIds, ctx, tenantUpgradeSettings().overrides);
  }

  function upgradePickList(up) {
    const seen = {};
    return ((up && Array.isArray(up.picks)) ? up.picks : []).filter(id => {
      if (typeof id !== 'string' || !id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).map(id => ({ id }));
  }

  // The stars that count: a typed reason, at most MAX_RECOMMENDED, in the
  // library's (offer) order so the same card always saves the same stars.
  function recommendedReasons(offers, up) {
    const rec = (up && up.recommended && typeof up.recommended === 'object') ? up.recommended : {};
    const out = {};
    let n = 0;
    offers.forEach(o => {
      const why = typeof rec[o.id] === 'string' ? rec[o.id].replace(/\s+/g, ' ').trim().slice(0, 140) : '';
      if (why && o.state === 'available' && n < MAX_RECOMMENDED) { out[o.id] = why; n++; }
    });
    return out;
  }

  // The offered / chosen / declined record, prices FROZEN at quote time, so a
  // later price change can never rewrite what this homeowner was offered.
  // Only offers the homeowner could have been quoted (state 'available' — a
  // price, eligible, not already in scope) are recorded.
  function buildUpgradeLog(offers, priced, up, version) {
    const avail = offers.filter(o => o.state === 'available');
    if (!avail.length) return null;
    const got = {};
    ((priced && priced.priced) || []).forEach(p => { got[p.id] = p; });
    const stars = recommendedReasons(offers, up);
    const declined = (up && up.declined) || {};
    const required = (up && up.required) || {};
    // A pick-one group whose pick was made required is base scope: its other
    // options were never the homeowner's to choose (the build screen keeps
    // them off the Show homeowner page), so they are not logged as
    // "offered" — the rule offeredFor applies to a guard already in the
    // template's scope (review of #1763, 2026-09-25).
    const heldGroup = {};
    avail.forEach(o => { if (o.group && required[o.id] && got[o.id]) heldGroup[o.group] = o.id; });
    return {
      version: version || null,
      at: new Date().toISOString(),
      shownToHomeowner: !!(up && up.shownToHomeowner),
      items: avail.filter(o => !(o.group && heldGroup[o.group] && heldGroup[o.group] !== o.id)).map(o => {
        const p = got[o.id] || null;
        const unitCents = p ? p.unitCents : o.unitCents;
        const qty = p ? p.qty : (o.qty != null ? o.qty : null);
        return {
          id: o.id,
          code: o.code,
          name: o.name,
          group: o.group || null,
          unit: o.unit,
          unitCents: unitCents,
          qty: qty,
          retailCents: (qty != null && unitCents != null) ? qty * unitCents : null,
          priceSource: o.priceSource || null,
          status: p ? (required[o.id] ? 'required' : 'chosen') : (declined[o.id] ? 'declined' : 'offered'),
          recommended: !!stars[o.id],
          reason: stars[o.id] || null
        };
      })
    };
  }

  /**
   * applyUpgrades(payload, resolved, up) → { payload, priced, offers, errors }
   *   payload:  buildEstimatePayload(resolved, …) — the engine's base estimate
   *   resolved: the resolveSelection() result it was built from
   *   up:       the upgrade selection (see above)
   * Returns a NEW payload with the picked upgrade rows appended at face value
   * (NBDUpgrades.applyToEstimate), the totals moved by exactly the quote plus
   * its tax, and `upgradeLog`. On any refusal (a pick with no quantity, two
   * leaf guards, an insurance job, …) `errors` is non-empty and `payload` is
   * the input unchanged — a caller must never save a half-applied quote.
   */
  function applyUpgrades(payload, resolved, up) {
    const out = { payload: payload, priced: null, offers: [], errors: [] };
    if (!payload || !up) return out;
    const picks = upgradePickList(up);
    const U = upgradesApi();
    if (!U) {
      if (picks.length) out.errors.push({ id: null, code: 'unavailable', message: 'Upgrade pricing did not load, so the picked upgrades cannot be priced.' });
      return out;
    }
    const tenant = tenantUpgradeSettings();
    // Priced at the PAYLOAD's tax rate — applyToEstimate refuses any other.
    const ctx = upgradeContext(resolved, up, payload.taxRate);
    const offers = U.offeredFor(ctx.templateIds, ctx, tenant.overrides);
    out.offers = offers;
    let next = payload;
    if (picks.length) {
      const priced = U.price(picks, ctx, tenant.overrides);
      out.priced = priced;
      if (priced.errors.length) { out.errors = priced.errors.slice(); return out; }
      const required = up.required || {};
      priced.rows.forEach(r => {
        if (!required[r.upgradeId]) return;
        // "Make required" (code work, or a guard the job must have): the
        // line moves into the base scope, so it prints as a plain line,
        // never as a homeowner choice. Same face-value price.
        r.desc = String(r.desc || '').replace(/^Upgrade — /, '');
        r.category = 'Base scope';
        r.upgradeRequired = true;
      });
      try {
        next = U.applyToEstimate(payload, priced, { minJobCharge: resolved && resolved.minJobCharge });
      } catch (e) {
        out.errors.push({ id: null, code: 'apply', message: String((e && e.message) || e) });
        out.payload = payload;
        return out;
      }
    }
    const log = buildUpgradeLog(offers, out.priced, up, U.version);
    if (log) {
      if (next === payload) next = Object.assign({}, payload);
      next.upgradeLog = log;
    }
    out.payload = next;
    return out;
  }

  // ═════════════════════════════════════════════════════════
  // Actions
  // ═════════════════════════════════════════════════════════

  // Resolve → payload → save as a NEW estimate. Clearing the edit id is
  // load-bearing: a stale _editingEstimateId would silently OVERWRITE
  // whatever estimate the user last opened in a builder.
  // opts.upgrades (stage 2, 2026-09-25): the build screen's upgrade selection,
  // applied by the same applyUpgrades the preview rendered. A refusal throws —
  // the rep sees it and nothing is saved.
  async function createEstimate(selection, opts) {
    opts = opts || {};
    const resolved = resolveSelection(selection, opts);
    if (!resolved.totals) {
      throw new Error('[JobTemplates] resolve failed: ' + resolved.warnings.join('; '));
    }
    let payload = buildEstimatePayload(resolved, opts);
    if (opts.upgrades) {
      const up = applyUpgrades(payload, resolved, opts.upgrades);
      if (up.errors.length) {
        const err = new Error('[JobTemplates] upgrades: ' + up.errors.map(e => e.message).join(' '));
        err.upgradeErrors = up.errors;
        throw err;
      }
      payload = up.payload;
      // Upgrades move grandTotal; the deposit follows it (2026-09-25) — a
      // $1,900 base with a $300 upgrade is a $2,200 job, not a no-deposit one.
      if (payload && payload.grandTotal !== undefined) {
        const dep = depositStamp(payload.grandTotal, payload.mode, opts);
        payload = Object.assign({}, payload, { deposit: dep.deposit, depositPlan: dep.depositPlan });
      }
    }
    if (typeof window._saveEstimate !== 'function') {
      throw new Error('[JobTemplates] _saveEstimate not loaded');
    }
    window._editingEstimateId = null;
    const id = await window._saveEstimate(payload);
    // Stickiness: only AFTER the save resolves — a failed save must not
    // inflate useCount. markUsed never throws (usage is telemetry).
    markUsed(resolved.sourceTemplates);
    return id;
  }

  /**
   * insertIntoV2(selection, opts) — push the selection into the open V2
   * builder as additive scope entries. Custom items are bridged first so
   * their JT codes resolve in scope. Scope candidates GROUP by final code
   * (after brand swap) — the old blanket first-wins dedupe silently dropped
   * the second template's quantities:
   *   - singleton codes → one entry, fixed qty = MAX across occurrences
   *     (a formula-driven occurrence counts as qty 1);
   *   - non-singletons where ALL occurrences carry fixed qty → one entry,
   *     qty = SUM;
   *   - non-singleton collisions involving a formula-driven occurrence →
   *     one entry, NO qty override + a verify-qty warning.
   * unitPriceOverride never carries into the builder (warned).
   * Returns { entries, measurements, minJobCharge, warnings } — merged over
   * the addScopeEntries result (added/skipped) when the V2 UI is open.
   */
  function insertIntoV2(selection, opts) {
    opts = opts || {};
    const sel = normalizeSelection(selection);
    const warnings = [];
    const groups = {};        // code → [fixedQty|null, ...]
    const groupOrder = [];
    let measurements = null;
    let minJobCharge = null;
    let anyPriceOverride = false;

    const usedIds = [];
    sel.forEach(entry => {
      const tpl = get(entry.templateId);
      if (!tpl) return;
      usedIds.push(tpl.id);
      registerCustomItems(tpl);
      // Partial template measurements overlay in selection order; the
      // caller's opts.measurements merge LAST below. No defaults base here —
      // the open builder's own context must not be clobbered by ours.
      if (tpl.measurements && typeof tpl.measurements === 'object') {
        measurements = Object.assign(measurements || {}, tpl.measurements);
      }
      // Only a real number counts (2026-10-05 bug #9): Number('abc') is NaN,
      // Math.max(…, NaN) is NaN and `total < NaN` is false, so one bad
      // template value used to drop EVERY valid floor in the selection.
      const tplMin = _templateMinOrNaN(tpl.minJobCharge);
      if (Number.isFinite(tplMin)) {
        minJobCharge = Math.max(minJobCharge != null ? minJobCharge : 0, tplMin);
      }
      (tpl.items || []).forEach((item, i) => {
        if (!item) return;
        const choice = itemChoice(entry.itemChoices, i);
        if (choice && choice.include === false) return;
        if (choice && choice.unitPriceOverride != null) anyPriceOverride = true;
        let code, qty;
        if (item.custom) {
          if (!item.custom.name) return;
          code = customCode(tpl.id, i);
          qty = (choice && choice.qty != null) ? choice.qty
            : (item.custom.qty != null ? item.custom.qty : 1);
        } else {
          if (!item.code) return;
          code = pickBrandCode(item, choice);
          qty = (choice && choice.qty != null) ? choice.qty
            : (item.qty != null ? item.qty : null);
        }
        const fixedQty = (qty !== null && qty !== '' && isFinite(Number(qty)))
          ? Number(qty) : null;
        if (!groups[code]) { groups[code] = []; groupOrder.push(code); }
        groups[code].push(fixedQty);
      });
    });

    const entries = groupOrder.map(code => {
      const occ = groups[code];
      const overrides = {};
      if (SINGLETON_CODES[code]) {
        // Once-per-job: MAX fixed qty wins (formula-driven counts as 1) —
        // same rule as resolveSelection, so preview === inserted scope.
        if (occ.some(q => q != null)) {
          overrides.qty = Math.max.apply(null, occ.map(q => (q != null ? q : 1)));
        }
      } else if (occ.every(q => q != null)) {
        // Every occurrence fixed → quantities SUM (matches the preview,
        // where each occurrence is its own line).
        overrides.qty = occ.reduce((s, q) => s + q, 0);
      } else if (occ.length > 1) {
        // Collision with a measurement-driven occurrence: can't sum a
        // formula — leave the builder's formula in charge and flag it.
        warnings.push(code + ': measurement-driven; verify qty after insert');
      }
      return { code, overrides };
    });

    if (anyPriceOverride) {
      warnings.push('price overrides do not carry into the builder — adjust there');
    }

    if (opts.measurements && typeof opts.measurements === 'object') {
      measurements = Object.assign(measurements || {}, opts.measurements);
    }

    // Stickiness: entries were built for these templates — stamp usage
    // whether the V2 UI consumes them or the caller gets the raw result.
    if (usedIds.length) markUsed(usedIds);

    if (window.EstimateV2UI && typeof window.EstimateV2UI.addScopeEntries === 'function') {
      const result = window.EstimateV2UI.addScopeEntries(entries, measurements, { minJobCharge }) || {};
      return Object.assign({}, result, {
        warnings: warnings.concat(Array.isArray(result.warnings) ? result.warnings : [])
      });
    }
    return { entries, measurements, minJobCharge, warnings };
  }

  // UI passthrough — the engine loads before (or without) the UI file.
  function openLibrary(opts) {
    if (window.JobTemplatesUI && typeof window.JobTemplatesUI.openPicker === 'function') {
      return window.JobTemplatesUI.openPicker(opts);
    }
    console.warn('[JobTemplates] JobTemplatesUI not loaded');
    return null;
  }

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════

  const JobTemplates = {
    STORAGE_KEY,
    USAGE_KEY,
    USAGE_DOC_ID,
    DATA_VERSION,
    SINGLETON_CODES,
    WARRANTY_KINDS,

    list,
    get,
    categories,
    search,

    saveCustom,
    duplicate,
    remove,

    registerCustomItems,
    registerAllCustomItems,
    applyJtCostSeed,
    adoptLegacyCosts,
    jtCostKey,
    hydrateFromCloud,
    tiersApply,
    warrantyKindOf,
    resolveSelection,
    buildEstimatePayload,
    upgradeOffers,
    applyUpgrades,
    createEstimate,
    insertIntoV2,
    openLibrary
  };

  window.JobTemplates = JobTemplates;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = JobTemplates;
  }

  // Load-time custom-item bridge (defaults + stored customs) — saved
  // estimates carry 'JT *' codes and must resolve on reopen in EVERY
  // session, not just the one that ran insertIntoV2. Best-effort: the
  // engine loads after the catalogs in the estimates bundle; if a catalog
  // is absent (standalone load) registerCustomItems guards internally.
  try {
    registerAllCustomItems();
  } catch (e) {
    console.error('[JobTemplates] custom-item bridge failed:', e);
  }

  // Firestore-first sync: one-shot cloud pull at init (fire-and-forget —
  // hydrateFromCloud guards _db/_user/getDocs itself and resolves false
  // when the SDK isn't ready, so a standalone/offline load is a no-op).
  try {
    hydrateFromCloud();
  } catch (e) {
    console.error('[JobTemplates] cloud hydrate failed:', e);
  }

  console.log('[JobTemplates] engine ready (' + defaults().length + ' default templates).');
})();
