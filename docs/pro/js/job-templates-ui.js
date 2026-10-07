/**
 * NBD Pro — Job Templates Library UI (v1)
 *
 * Renders the Job Templates view (#jobTemplatesContainer) and drives the
 * pick → configure (preconfirm) → preview → create-estimate flow on top of
 * the window.JobTemplates engine (job-templates.js, same lazy bundle).
 *
 * Contract (job-template-spec.md, "Runtime architecture" item 3):
 *   window.JobTemplatesUI = { render, reRender, openPicker,
 *                             openPickerForScope, openPreconfirm, closeModal,
 *                             clearBandCache }
 *   __NBD_CALL_REGISTRY.renderJobTemplatesLibrary = render  (registry-only
 *     since Globals Tranche 3 T3-C, 2026-09-18 — no longer a window alias)
 *
 * "COST NOT SET" IS A REAL STATE (2026-08-18). Job-template custom-item costs
 * are tenant-owned now (catalogCosts/{companyId}.jtCosts — they used to ship
 * in the public data file). A tenant with no cost book gets a complete scope
 * of work with NO price on those lines: no card price band, '—' in the
 * proposal's rate/total columns, a "Cost not set" chip, and a banner saying
 * how many items are excluded from the total. Never $0.00, never a fabricated
 * margin.
 *
 * THE COST EDITOR (PR-C, 2026-08-19). Entering costs in-product is now
 * possible: the per-item editor row carries Material and Labor $/unit fields.
 * Three properties hold them together and none is optional —
 *
 *   GATED. Rendered only behind canEditCosts(), which mirrors firestore.rules
 *   for catalogCosts/{companyId}. A viewer or sales_rep sees no cost field at
 *   all, because the rule would refuse their write and they would discover
 *   that at quote time rather than at edit time. The gate is an affordance,
 *   not the boundary — the rule is the boundary, and the write path reports a
 *   refusal honestly regardless, since claims can be stale.
 *
 *   STAGED. Edits sit in edState.costEdits until Save. These are COMPANY-wide
 *   values shared by every rep, so Cancel must mean cancel and a half-typed
 *   "4" must never briefly become everyone's cost.
 *
 *   NEVER ON THE TEMPLATE. Costs are keyed jt-<slug(templateId)>-<index> and
 *   written to the company cost book directly — never onto item.custom, which
 *   is uid-scoped and re-embedding them there is precisely the leak this
 *   migration removed. It also means setting a cost on a DEFAULT template does
 *   not force a fork.
 *
 * The per-line $ / unit override on the insert modal remains how anyone quotes
 * an item whose cost is still unset.
 *
 * UPGRADES & ADD-ONS (stage 2, 2026-09-25). The build screen carries an
 * Upgrades card (about three slots, the rest behind "More"; leaf protection
 * is one pick-one block starting on None) and a full-screen "Show homeowner"
 * page. Both are UI over JobTemplates.upgradeOffers / applyUpgrades and
 * window.NBDUpgrades; the rules and the WHY are at the UPGRADES section
 * below and in documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md.
 *
 * Repo rules honored here:
 *  - CSP: ZERO inline handlers anywhere (incl. JS-generated markup). ONE
 *    delegated click listener + one input/change handler, bound once behind
 *    window._NBD_JT_DELEGATE_BOUND (product-library.js pattern), dispatching
 *    on data-jt-action attributes.
 *  - Every interpolated string goes through the local escapeHtml (template
 *    names/descriptions are user-editable → stored-XSS surface).
 *  - Customer-facing money = RETAIL ONLY (retailTotal / retailPerUnit /
 *    resolved total). lineTotal / materialTotal / laborTotal never render
 *    in the preview pane (2026-07-18 money-sweep rule).
 *  - Styles injected once, keyed off the same CSS vars as estimate-v2-ui.js
 *    (var(--s,#111418), var(--orange,#BD5728), ...), mobile responsive.
 */
(function () {
  'use strict';

  // Browser guard — this file is UI-only.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ══════════════════════════════════════════════════════════════════════
  // Constants
  // ══════════════════════════════════════════════════════════════════════

  // Fallback taxonomy (mirrors job-templates-data.js NBD_JOB_TEMPLATE_CATEGORIES;
  // used only if the engine/data file hasn't populated categories yet).
  var FALLBACK_CATS = {
    roof_repair:      { label: 'Roof Repairs',                 icon: '🔨' },
    leak_flashing:    { label: 'Leak & Flashing',              icon: '💧' },
    gutters_repair:   { label: 'Gutter Repair & Maintenance',  icon: '🧹' },
    gutters_install:  { label: 'Gutter Systems',               icon: '🌧️' },
    soffit_fascia:    { label: 'Soffit & Fascia',              icon: '🪚' },
    ventilation:      { label: 'Ventilation & Energy',         icon: '🌀' },
    roof_replacement: { label: 'Full Roof Replacement',        icon: '🏠' },
    specialty_roofing:{ label: 'Specialty Roofing',            icon: '⭐' },
    storm_emergency:  { label: 'Storm / Emergency / Insurance',icon: '⛈️' },
    exterior:         { label: 'Siding, Windows & Exterior',   icon: '🧱' },
    maintenance:      { label: 'Maintenance & Inspection',     icon: '🔍' }
  };

  // Category accent colors (cards' left border + chips). Distinct hues per key.
  var CAT_COLORS = {
    roof_repair: '#ef4444',  leak_flashing: '#f59e0b',  gutters_repair: '#06b6d4',
    gutters_install: '#0284c7', soffit_fascia: '#8b5cf6', ventilation: '#10b981',
    roof_replacement: '#BD5728', specialty_roofing: '#64748b',
    storm_emergency: '#be123c', exterior: '#3b82f6', maintenance: '#84cc16'
  };

  var JOB_TYPES = {
    repair: 'Repair', replacement: 'Replacement', install: 'Install',
    maintenance: 'Maintenance', inspection: 'Inspection', emergency: 'Emergency'
  };

  var TIERS = ['good', 'better', 'best'];
  var TIER_LABELS = { good: 'Good', better: 'Better', best: 'Best' };

  // Default measurements used to seed the editable panel when every selected
  // template is measurement-driven (measurements: null in the schema).
  var MEAS_DEFAULTS = {
    rawSqft: 2000, pitch: 6, waste: 1.15, ridgeLf: 0, eaveLf: 0, rakeLf: 0,
    hipLf: 0, valleyLf: 0, wallLf: 0, pipes: 0, chimneys: 0, skylights: 0,
    stories: 1, tearOffLayers: 1, deckReplacePct: 0, cutUpRoof: false
  };
  var MEAS_LABELS = {
    rawSqft: 'Roof area (sqft)', pitch: 'Pitch (/12)', waste: 'Waste factor',
    ridgeLf: 'Ridge (LF)', eaveLf: 'Eave (LF)', rakeLf: 'Rake (LF)',
    hipLf: 'Hip (LF)', valleyLf: 'Valley (LF)', wallLf: 'Wall (LF)',
    pipes: 'Pipe boots', chimneys: 'Chimneys', skylights: 'Skylights',
    stories: 'Stories', tearOffLayers: 'Tear-off layers',
    deckReplacePct: 'Deck replace %', cutUpRoof: 'Cut-up roof'
  };

  // ══════════════════════════════════════════════════════════════════════
  // State
  // ══════════════════════════════════════════════════════════════════════

  var state = {
    search: '',
    category: 'all',
    jobType: 'all',
    selected: [],            // ordered template ids
    choices: {},             // templateId -> [{included, qty, brandCode, unitPriceOverride}]
    collapsed: {},           // templateId -> bool (preconfirm sections)
    tier: 'better',          // used only when a selected template is tierPriced (see tiersApply)
    repairWarranty: false,   // per-estimate "1-year workmanship warranty" box — repair-kind jobs only, off by default
    jobMode: 'cash',
    county: '',              // tax jurisdiction — neutral "Other / My county" default (estimate-v2-ui.js parity; engines fail safe at $150 permit / 7% tax)
    measurements: Object.assign({}, MEAS_DEFAULTS),
    measSeedKey: '',
    measOpen: false,
    step: 'library',         // library | preconfirm | preview | success
    host: 'view',            // 'view' (dashboard container) | 'modal' (picker)
    forScope: false,
    scopeCb: null,
    leadId: null,            // lead-context entry (openPicker({leadId})) — pre-selects the lead in the create step
    createdId: null,
    createdLeadId: null,     // lead the created estimate was attributed to — powers "Send to customer" on the success step
    createdName: '',
    lastResolved: null,
    creating: false,
    // The Create estimate refusal, shown on the preview beside the button
    // (review of #1763, 2026-09-25: a toast sits under #jtModal, unseen).
    createErr: '',
    // Upgrades & Add-ons (stage 2, 2026-09-25) — the build screen's Upgrades
    // card + Show homeowner page. Per estimate: closeModal() resets it, so a
    // pick, a star or a "No thanks" never rides into the next customer's quote.
    upg: freshUpg()
  };

  // picks:    id → true            chosen (a "Make required" item is picked too)
  // qty:      key → typed string   key = 'group:<group>' (one footage for a
  //                                pick-one group) or the upgrade id; blank =
  //                                follow the gutter footage
  // required: id → true            "Make required": base scope, not a choice
  // stars:    id → reason          present = starred; counts only with a reason
  // declined: id → true            the homeowner tapped "No thanks"
  // more:     "More" expanded; homeowner: the Show homeowner page is open;
  // shown:    it was opened at least once for this estimate (saved in the log)
  // notice:   { id, msg } an inline refusal on the card ('*' = the card's
  //           top line), cleared by the next upgrade tap. Inline, not a
  //           toast: the toast layer sits under #jtModal, so a refusal
  //           toasted here was never seen (review of #1763, 2026-09-25).
  function freshUpg() {
    return { picks: {}, qty: {}, required: {}, stars: {}, declined: {}, more: false, homeowner: false, shown: false, notice: null };
  }

  // costEdits: jt-cost-book key → {materialCost, laborCost}, staged while the
  // editor is open and flushed on Save. Staged rather than written on keystroke
  // because these are COMPANY-WIDE values — Cancel must mean cancel, and a
  // half-typed "4" must not briefly become every rep's cost for that item.
  var edState = { tpl: null, isFork: false, costEdits: {} };
  var bandCache = {};        // templateId -> 'price band' html-safe string
  var _codeMap = null;
  var _resolveTimer = null;

  // ══════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════

  // Local HTML escape — EVERY interpolated string passes through this
  // (template names/descriptions are user-editable → stored-XSS surface).
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  var esc = escapeHtml;

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function money(n) {
    var v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // −$51.40, never $-51.40 (the Roof Care Plan member line is the one negative).
  function signedMoney(n) {
    var v = Number(n) || 0;
    return (v < 0 ? '−' : '') + money(Math.abs(v));
  }
  // The payload Create estimate would save, with the member discount applied
  // (null when there is none, or the engine is not loaded).
  function memberDiscountPreview(res, upPay) {
    var JT = engine();
    if (!JT || typeof JT.applyMemberDiscount !== 'function' || !res || !res.totals) return null;
    try {
      var base = upPay || (typeof JT.buildEstimatePayload === 'function' ? JT.buildEstimatePayload(res, resolveOpts()) : null);
      return base ? JT.applyMemberDiscount(base, res, resolveOpts()) : null;
    } catch (e) { console.warn('[job-templates-ui] member discount preview failed:', e); return null; }
  }
  function money0(n) {
    var v = Number(n) || 0;
    return '$' + Math.round(v).toLocaleString('en-US');
  }
  function moneyShort(n) {
    var v = Number(n) || 0;
    if (v >= 10000) return '$' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
    return '$' + Math.round(v);
  }

  function toast(msg, type) {
    // window.showToast is guaranteed on the only page this bundle loads on
    // (dashboard-ui-prefs-boot.js defines it before the lazy bundles). The
    // old `window._showToast` reference was assigned NOWHERE — every toast
    // here was console-only (audit 2026-08-02, silent-failure class).
    if (typeof window.showToast === 'function') { window.showToast(msg, type); return; }
    try { console.log('[job-templates-ui] ' + (type || 'info') + ': ' + msg); } catch (e) {}
  }

  function engine() {
    var jt = window.JobTemplates;
    return (jt && typeof jt === 'object') ? jt : null;
  }

  function categoryMeta() {
    var JT = engine();
    if (JT && typeof JT.categories === 'function') {
      try {
        var c = JT.categories();
        if (c && typeof c === 'object' && Object.keys(c).length) return c;
      } catch (e) { /* fall through */ }
    }
    return (window.NBD_JOB_TEMPLATE_CATEGORIES && Object.keys(window.NBD_JOB_TEMPLATE_CATEGORIES).length)
      ? window.NBD_JOB_TEMPLATE_CATEGORIES : FALLBACK_CATS;
  }

  function catLabel(key) {
    var m = categoryMeta()[key];
    return m && m.label ? m.label : String(key || '').replace(/_/g, ' ');
  }
  function catIcon(key) {
    var m = categoryMeta()[key];
    return m && m.icon ? m.icon : '📋';
  }
  function catColor(key) { return CAT_COLORS[key] || '#6b7280'; }

  function isCustom(t) {
    return !!(t && (t.isCustom || t.custom === true || t.basedOn ||
      /^(jt_custom_|custom_)/.test(String(t.id || ''))));
  }

  function allTemplates() {
    var JT = engine();
    if (!JT || typeof JT.list !== 'function') return [];
    try { return JT.list() || []; } catch (e) { console.error('[job-templates-ui] list() failed:', e); return []; }
  }

  function getTpl(id) {
    var JT = engine();
    if (JT && typeof JT.get === 'function') {
      try { var t = JT.get(id); if (t) return t; } catch (e) { /* fall through */ }
    }
    var list = allTemplates();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  function getFiltered() {
    var JT = engine();
    var cat = state.category === 'all' ? null : state.category;
    var jtF = state.jobType === 'all' ? null : state.jobType;
    if (JT && typeof JT.search === 'function') {
      try { return JT.search(state.search || '', { category: cat, jobType: jtF }) || []; }
      catch (e) { console.error('[job-templates-ui] search() failed:', e); }
    }
    // Manual fallback over list()
    var q = (state.search || '').toLowerCase();
    return allTemplates().filter(function (t) {
      if (!t) return false;
      if (cat && t.category !== cat) return false;
      if (jtF && t.jobType !== jtF) return false;
      if (!q) return true;
      var hay = [t.name, t.description, t.category, (t.tags || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  // Code → {name, unit} lookup (NBD_XACT_CATALOG in array or map shape,
  // plus the V2 builder catalog when present). Rebuilt if still empty.
  function codeMap() {
    if (_codeMap && Object.keys(_codeMap).length) return _codeMap;
    var m = {};
    function push(it) {
      if (it && it.code) m[String(it.code)] = { name: it.name || it.desc || '', unit: it.unit || '' };
    }
    var cat = window.NBD_XACT_CATALOG;
    if (Array.isArray(cat)) cat.forEach(push);
    else if (cat && typeof cat === 'object') {
      Object.keys(cat).forEach(function (k) {
        var v = cat[k];
        if (v && typeof v === 'object') push(v.code ? v : Object.assign({ code: k }, v));
        else m[k] = { name: String(v || ''), unit: '' };
      });
    }
    var v2 = window.EstimateBuilderV2 && window.EstimateBuilderV2.CATALOG;
    if (v2 && typeof v2 === 'object') {
      Object.keys(v2).forEach(function (k) { push(v2[k]); });
    }
    _codeMap = m;
    return m;
  }

  function catalogCodes() {
    return Object.keys(codeMap()).sort();
  }

  function itemLabel(it) {
    if (!it) return '';
    if (it.custom) return it.custom.name || 'Custom item';
    var info = codeMap()[it.code];
    return (info && info.name) ? info.name : (it.code || 'Item');
  }
  function itemDesc(it) {
    if (!it) return '';
    if (it.custom) return it.custom.desc || '';
    return it.code || '';
  }
  function itemUnit(it, choice) {
    if (it && it.custom) return it.custom.unit || 'EA';
    var code = (choice && choice.brandCode) || (it && it.code);
    var info = codeMap()[code];
    return (info && info.unit) ? info.unit : '';
  }

  // County options for the preconfirm tax selector. A neutral "Other / My
  // county" ('' — engine fallbacks fire: default permit, 7% tax) leads every
  // branch so off-list tenants aren't forced onto an OH/KY county.
  //
  // County-jurisdiction settings (2026-07-29): the canonical 7 come from
  // EstimateBuilderV2.PERMIT_COSTS (exported, carries display names, and is
  // present on customer.html via the engine's inline fallbacks — fixing the
  // old customer.html no-config branch that offered only Other + one county),
  // with the config-derived derivation kept as a defensive fallback. The
  // tenant's custom jurisdictions are appended with their STORED display
  // names — never parsed out of the slug. Labels are escaped at the render
  // site (renderPreconfirm's esc()).
  function countyOptions() {
    var other = { value: '', label: 'Other / My county' };
    var opts = [other];
    var eb2 = window.EstimateBuilderV2;
    var permits = eb2 && eb2.PERMIT_COSTS;
    if (permits && typeof permits === 'object' && Object.keys(permits).length) {
      opts = opts.concat(Object.keys(permits).map(function (slug) {
        var entry = permits[slug] || {};
        return { value: slug, label: entry.name || slug };
      }));
    } else {
      var cfg = window.NBD_ESTIMATE_CONFIG;
      var map = cfg && cfg.COUNTY_TAX;
      if (map && typeof map === 'object' && Object.keys(map).length) {
        opts = opts.concat(Object.keys(map).map(function (slug) {
          var entry = map[slug] || {};
          var st = String(slug).split('-').pop();
          var label = entry.name
            ? entry.name + ' County, ' + String(st || '').toUpperCase()
            : slug;
          return { value: slug, label: label };
        }));
      }
    }
    var cj = window._companyProfile
      && window._companyProfile.pricing
      && window._companyProfile.pricing.customJurisdictions;
    if (cj && typeof cj === 'object') {
      Object.keys(cj).forEach(function (slug) {
        var e = cj[slug];
        if (!slug || !e || typeof e.name !== 'string' || !e.name.trim()) return;
        opts.push({ value: slug, label: e.name.trim() });
      });
    }
    return opts;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Selection / choices / engine bridge
  // ══════════════════════════════════════════════════════════════════════

  function isSelected(id) { return state.selected.indexOf(id) !== -1; }

  function toggleSelect(id, on) {
    var idx = state.selected.indexOf(id);
    if (on && idx === -1) state.selected.push(id);
    if (!on && idx !== -1) state.selected.splice(idx, 1);
  }

  function seedChoices(tid) {
    var t = getTpl(tid);
    if (!t) return;
    state.choices[tid] = (t.items || []).map(function (it) {
      var q = null;
      if (it && it.qty != null) q = it.qty;
      else if (it && it.custom && it.custom.qty != null) q = it.custom.qty;
      return {
        included: true,
        qty: q,                              // null → engine measurement formula
        brandCode: (it && it.code) || null,  // brand choice (defaults to own code)
        unitPriceOverride: null              // rep-typed customer retail $/unit
      };
    });
  }

  function ensureChoices() {
    state.selected.forEach(function (tid) {
      var t = getTpl(tid);
      var want = t ? (t.items || []).length : 0;
      if (!state.choices[tid] || state.choices[tid].length !== want) seedChoices(tid);
    });
    // prune stale
    Object.keys(state.choices).forEach(function (tid) {
      if (!isSelected(tid)) delete state.choices[tid];
    });
  }

  // Seed the editable measurements panel from the selected templates:
  // field-wise max across templates that carry baked measurements, OR the
  // generic defaults when everything is measurement-driven (null).
  function seedMeasurements() {
    var key = state.selected.slice().sort().join(',');
    if (key === state.measSeedKey) return;
    state.measSeedKey = key;
    var seeded = null;
    state.selected.forEach(function (tid) {
      var t = getTpl(tid);
      if (!t || !t.measurements) return;
      if (!seeded) seeded = Object.assign({}, MEAS_DEFAULTS, t.measurements);
      else {
        Object.keys(MEAS_DEFAULTS).forEach(function (k) {
          var v = t.measurements[k];
          if (typeof MEAS_DEFAULTS[k] === 'boolean') seeded[k] = seeded[k] || !!v;
          else if (num(v) != null) seeded[k] = Math.max(Number(seeded[k]) || 0, Number(v));
        });
      }
    });
    state.measurements = seeded || Object.assign({}, MEAS_DEFAULTS);
    // Measurement-driven selections need real numbers → open the panel.
    state.measOpen = anyMeasurementDriven();
  }

  function anyMeasurementDriven() {
    return state.selected.some(function (tid) {
      var t = getTpl(tid);
      return t && (t.measurements === null || t.measurements === undefined);
    });
  }

  function buildSelection() {
    ensureChoices();
    return state.selected.map(function (tid) {
      var ch = state.choices[tid] || [];
      return {
        templateId: tid,
        itemChoices: ch.map(function (c, i) {
          // Canonical UI↔engine contract: brandCode + unitPriceOverride —
          // the engine reads EXACTLY these keys (never the legacy names).
          return {
            index: i,
            include: c.included !== false,
            qty: (c.qty === null || c.qty === undefined || c.qty === '') ? null : Number(c.qty),
            brandCode: c.brandCode || null,
            unitPriceOverride: (c.unitPriceOverride === null || c.unitPriceOverride === undefined || c.unitPriceOverride === '') ? null : Number(c.unitPriceOverride)
          };
        })
      };
    });
  }

  function resolveOpts() {
    return {
      // The customer (2026-10-05): a Roof Care Plan member's repair work
      // carries the 10% member line — job-templates.js applyMemberDiscount.
      leadId: state.leadId || null,
      tier: state.tier,
      repairWarranty: state.repairWarranty === true,
      jobMode: state.jobMode,
      county: state.county || '',
      measurements: Object.assign({}, state.measurements)
    };
  }

  function resolveCurrent() {
    var JT = engine();
    if (!JT || typeof JT.resolveSelection !== 'function') return null;
    try { return JT.resolveSelection(buildSelection(), resolveOpts()); }
    catch (e) { console.error('[job-templates-ui] resolveSelection failed:', e); return null; }
  }

  // Does Good/Better/Best price anything for this selection? Only a template
  // flagged tierPriced says yes (none today), so the row is hidden and nothing
  // tier-related prints. 2026-09-25 — see job-templates.js tiersApply.
  function tiersApplyNow() {
    var JT = engine();
    return !!(JT && typeof JT.tiersApply === 'function' && JT.tiersApply(state.selected));
  }

  // The "1-year workmanship warranty" box shows only when a selected template
  // is a repair: repairs are warranted case by case (Jo, 2026-09-25 — "some
  // repairs won't get any depending on severity"), so it starts unticked.
  // Not beside a roofing template: the roofing wording then covers the whole
  // estimate, so the box would change nothing (review 2026-09-25).
  function selectionHasRepair() {
    var JT = engine();
    if (!JT || typeof JT.warrantyKindOf !== 'function') return false;
    var kinds = state.selected.map(function (tid) { return JT.warrantyKindOf(getTpl(tid)); });
    return kinds.indexOf('repair') !== -1 && kinds.indexOf('roof') === -1;
  }

  // The workmanship-warranty sentence this estimate's paperwork will print.
  // Built from the SAME payload createEstimate saves and read through the SAME
  // helper the proposal/contract/portal paths use, so the preview cannot say
  // something the paper does not. Roofing returns the existing tier wording.
  function warrantySentence(res) {
    var JT = engine();
    var rows = window.NBDCustomerEstimateRows;
    if (!res || !res.totals || !JT || typeof JT.buildEstimatePayload !== 'function'
        || !rows || typeof rows.estimateWarranty !== 'function') return '';
    try {
      var w = rows.estimateWarranty(JT.buildEstimatePayload(res, { repairWarranty: state.repairWarranty === true }));
      if (!w) return '';
      if (w.text !== null) return w.text;
      var cfg = window.NBD_ESTIMATE_CONFIG;
      return (cfg && typeof cfg.tierWarrantyText === 'function') ? cfg.tierWarrantyText(w.wordingTier) : '';
    } catch (e) { return ''; }
  }

  // Defensive totals reader — the engine returns {lines, totals} with retail
  // stamped; tolerate a few key spellings but only ever surface RETAIL fields.
  function readTotals(res) {
    if (!res) return null;
    var t = res.totals || res;
    var total = num(t.total); if (total == null) total = num(t.grandTotal);
    var sub = num(t.subtotal); if (sub == null) sub = num(t.retailSubtotal);
    var tax = num(t.tax); if (tax == null) tax = num(t.taxAmount); if (tax == null) tax = num(t.salesTax);
    // Engine flag is minJobApplied (estimate-logic-engine.js resolveEstimate).
    var minApplied = !!t.minJobApplied;
    // O&P bridge (customer-estimate-rows house pattern): lines sum to
    // retailBeforeOHP; the O&P row makes them foot to Subtotal.
    var ohp = (Number(t.overhead) || 0) + (Number(t.profit) || 0);
    var ohpPct = Math.round(((Number(t.overheadPct) || 0) + (Number(t.profitPct) || 0)) * 100);
    return { total: total, subtotal: sub, tax: tax, minApplied: minApplied, ohp: ohp, ohpPct: ohpPct };
  }

  function readLines(res) {
    if (!res) return [];
    if (Array.isArray(res.lines)) return res.lines;
    if (res.estimate && Array.isArray(res.estimate.lines)) return res.estimate.lines;
    return [];
  }

  // A line the tenant has no cost basis for (job-template custom item with no
  // catalogCosts/{companyId}.jtCosts entry). It resolves at an EXPLICIT 0 —
  // see job-templates.js:customLineItem for why omitting the key would be
  // worse — so the numeric fields are all present and all meaningless. This
  // flag is the only way to tell that apart from a genuine zero-cost line.
  function isCostUnset(line) { return !!(line && line.costUnset); }

  /**
   * May this user edit the COMPANY's job-template cost book?
   *
   * Mirrors firestore.rules for catalogCosts/{companyId}: platform admin, the
   * solo operator whose companyId IS their uid, or a company_admin of that
   * company. A viewer or sales_rep gets no cost inputs at all.
   *
   * THIS IS AN AFFORDANCE, NOT A SECURITY BOUNDARY. The boundary is the rule;
   * this only decides whether showing the field would be an invitation to fail.
   * The write path handles a refusal honestly regardless, because claims can be
   * stale and a client check can always be wrong.
   *
   * Deliberately conservative: unknown claims mean no inputs. Better to show a
   * rep nothing than to show them a field whose Save silently does not stick.
   */
  function canEditCosts() {
    try {
      var claims = window._userClaims;
      if (!claims) return false;
      if (claims.admin === true || claims.owner === true) return true;
      if (claims.role === 'company_admin') return true;
      // Solo operator: the tenant key IS the uid, which the rule allows.
      var uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) ||
                (window._user && window._user.uid) || null;
      if (uid && claims.companyId && String(claims.companyId) === String(uid)) return true;
      if (uid && !claims.companyId) return true;   // no company yet ⇒ solo, keyed by uid
      return false;
    } catch (e) { return false; }
  }

  /** The cost-book key for one template item — the engine owns the definition. */
  function costKeyFor(templateId, index) {
    var JT = engine();
    return (JT && typeof JT.jtCostKey === 'function') ? JT.jtCostKey(templateId, index) : null;
  }

  /** This item's current company cost, or null when unset. */
  function bookCostFor(templateId, index) {
    try {
      var cc = window.NBDCatalogCosts;
      var key = costKeyFor(templateId, index);
      if (!cc || !key || typeof cc.jobItem !== 'function') return null;
      return cc.jobItem(key);
    } catch (e) { return null; }
  }

  // Prefer the engine's own tally; fall back to counting lines for a stub or
  // an older cached result that predates costUnsetCount.
  function unpricedCount(res) {
    var t = res && res.totals;
    if (t && typeof t.costUnsetCount === 'number') return t.costUnsetCount;
    return readLines(res).filter(isCostUnset).length;
  }

  function lineRetailTotal(line) {
    var r = num(line && line.retailTotal);
    if (r != null) return r;
    var per = num(line && line.retailPerUnit);
    var q = num(line && (line.quantity != null ? line.quantity : line.qty));
    if (per != null && q != null) return per * q;
    return null;
  }
  function lineRetailPerUnit(line) {
    var per = num(line && line.retailPerUnit);
    if (per != null) return per;
    var r = num(line && line.retailTotal);
    var q = num(line && (line.quantity != null ? line.quantity : line.qty));
    if (r != null && q) return r / q;
    return null;
  }
  function lineQty(line) {
    var q = num(line && (line.quantity != null ? line.quantity : line.qty));
    return q == null ? 0 : q;
  }

  // code → resolved line (also keyed by lowercased name for custom items)
  function lineMapFrom(res) {
    var map = {};
    readLines(res).forEach(function (l) {
      if (!l) return;
      if (l.code) map[String(l.code)] = l;
      var nm = String(l.name || l.desc || l.description || '').trim().toLowerCase();
      if (nm) map['name:' + nm] = l;
    });
    return map;
  }

  function findLineForItem(it, choice, map) {
    if (!it) return null;
    if (it.custom) {
      var nm = String(it.custom.name || '').trim().toLowerCase();
      return map['name:' + nm] || null;
    }
    var code = (choice && choice.brandCode) || it.code;
    return map[String(code)] || null;
  }

  // Card price band: single-template resolve at good & best tier, cached.
  //
  // Returns '' — NO BAND AT ALL — for a template with any unpriced custom item
  // (2026-08-18). Cost data is tenant-owned now, so a tenant with no cost book
  // resolves those lines at an explicit 0. Printing the resulting total would
  // be a real-looking number computed from a missing cost basis, which is the
  // single most misleading thing this screen could show a rep about to quote.
  // Absent is honest; "$0" and "$1,240 (but actually missing three items)" are
  // not. Post-import for a seeded tenant, the band comes straight back.
  function priceBand(tpl) {
    if (!tpl || !tpl.id) return '';
    if (bandCache[tpl.id] !== undefined) return bandCache[tpl.id];
    var JT = engine();
    if (!JT || typeof JT.resolveSelection !== 'function') return (bandCache[tpl.id] = '');
    var out = '';
    try {
      var meas = Object.assign({}, MEAS_DEFAULTS, tpl.measurements || {});
      var sel = [{ templateId: tpl.id, itemChoices: (tpl.items || []).map(function (it, i) {
        return { index: i, include: true, qty: (it && it.qty != null) ? it.qty : null, brandCode: (it && it.code) || null, unitPriceOverride: null };
      }) }];
      var loRes = JT.resolveSelection(sel, { tier: 'good', jobMode: 'cash', measurements: meas });
      var hiRes = JT.resolveSelection(sel, { tier: 'best', jobMode: 'cash', measurements: meas });
      if (unpricedCount(loRes) > 0) { bandCache[tpl.id] = ''; return ''; }
      var lo = readTotals(loRes);
      var hi = readTotals(hiRes);
      if (lo && hi && lo.total != null && hi.total != null) {
        out = (Math.round(lo.total) === Math.round(hi.total))
          ? moneyShort(lo.total)
          : moneyShort(Math.min(lo.total, hi.total)) + ' – ' + moneyShort(Math.max(lo.total, hi.total));
      }
    } catch (e) { out = ''; }
    bandCache[tpl.id] = out;
    return out;
  }

  function clearBandCache() { bandCache = {}; }

  // ══════════════════════════════════════════════════════════════════════
  // Styles (injected once into <head>)
  // ══════════════════════════════════════════════════════════════════════

  function ensureStyles() {
    if (document.getElementById('jtUIStyles')) return;
    var st = document.createElement('style');
    st.id = 'jtUIStyles';
    st.textContent = [
      '.jt-wrap{padding:20px;font-family:"Barlow","Helvetica Neue",-apple-system,sans-serif;color:var(--t,#e8eaf0);}',
      '.jt-hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:18px;}',
      '.jt-hdr h1{margin:0;font-size:26px;font-weight:800;color:var(--t,#e8eaf0);}',
      '.jt-hdr p{margin:5px 0 0;font-size:13px;color:var(--m,#9aa3ad);}',
      '.jt-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px;}',
      '.jt-stat{background:var(--s,#111418);padding:13px 14px;border-radius:8px;border:1px solid var(--br,#2a2f35);border-left-width:4px;}',
      '.jt-stat .k{font-size:11px;color:var(--m,#9aa3ad);font-weight:600;}',
      '.jt-stat .v{font-size:22px;font-weight:800;color:var(--t,#e8eaf0);margin-top:2px;}',
      '.jt-controls{background:var(--s,#111418);border:1px solid var(--br,#2a2f35);padding:14px;border-radius:10px;margin-bottom:16px;}',
      '.jt-search{width:100%;padding:10px 14px;background:var(--s2,#181c22);border:1px solid var(--br,#2a2f35);border-radius:8px;font-size:14px;color:var(--t,#e8eaf0);box-sizing:border-box;}',
      '.jt-search:focus{outline:none;border-color:var(--orange,#BD5728);}',
      '.jt-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;}',
      '.jt-pill{padding:6px 12px;border-radius:20px;border:2px solid var(--br,#2a2f35);background:transparent;color:var(--t,#e8eaf0);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;white-space:nowrap;-webkit-tap-highlight-color:transparent;}',
      '.jt-pill .ct{background:var(--br,#2a2f35);color:var(--m,#9aa3ad);border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px;}',
      '.jt-pill.on{font-weight:700;}',
      // ── Recently-used strip (compact horizontal cards above the grid) ──
      '.jt-recent{margin-bottom:16px;}',
      '.jt-recent-hdr{font-size:11px;font-weight:700;color:var(--m,#9aa3ad);text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;}',
      '.jt-recent-row{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;}',
      '.jt-recent-card{flex:0 0 auto;display:flex;align-items:center;gap:9px;background:var(--s,#111418);border:1px solid var(--br,#2a2f35);border-left-width:3px;border-radius:8px;padding:8px 12px;cursor:pointer;color:var(--t,#e8eaf0);font-family:inherit;text-align:left;max-width:240px;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
      '.jt-recent-card:hover{border-color:var(--orange,#BD5728);}',
      '.jt-recent-card.sel{outline:2px solid var(--orange,#BD5728);outline-offset:-1px;}',
      '.jt-recent-ic{font-size:16px;}',
      '.jt-recent-name{display:block;font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;}',
      '.jt-recent-meta{display:block;font-size:10px;color:var(--m,#9aa3ad);margin-top:1px;}',
      '.jt-recent-check{color:var(--orange,#BD5728);font-weight:800;font-size:13px;}',
      '.jt-used-chip{opacity:.85;}',
      '.jt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding-bottom:96px;}',
      '@media (max-width:640px){.jt-grid{grid-template-columns:1fr;}.jt-wrap{padding:12px;}}',
      '.jt-card{position:relative;background:var(--s,#111418);border:1px solid var(--br,#2a2f35);border-left-width:4px;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;transition:box-shadow .15s;}',
      '.jt-card:hover{box-shadow:0 4px 14px rgba(0,0,0,.28);}',
      '.jt-card.sel{outline:2px solid var(--orange,#BD5728);outline-offset:-1px;}',
      '.jt-card-top{display:flex;gap:10px;align-items:flex-start;}',
      '.jt-check{width:20px;height:20px;min-width:20px;accent-color:var(--orange,#BD5728);cursor:pointer;margin-top:2px;}',
      '.jt-card-name{font-weight:700;font-size:14.5px;color:var(--t,#e8eaf0);line-height:1.25;}',
      '.jt-card-desc{font-size:12px;color:var(--m,#9aa3ad);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.jt-chip{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--s2,#181c22);color:var(--m,#9aa3ad);border:1px solid var(--br,#2a2f35);white-space:nowrap;}',
      '.jt-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center;}',
      // "Cost not set" — a job-template custom item with no entry in this
      // tenant's cost book (catalogCosts/{companyId}.jtCosts). Amber, not red:
      // it is a setup step, not an error.
      '.jt-chip-warn{color:#f0a92e;border-color:#f0a92e55;background:#f0a92e14;}',
      '.jt-unpriced-note{margin-top:8px;font-size:12px;color:#f0a92e;line-height:1.45;}',
      '.jt-cost-scope-note{margin-top:14px;padding:9px 12px;border-radius:8px;background:#f0a92e14;border:1px solid #f0a92e33;font-size:12px;color:var(--m,#9aa3ad);line-height:1.5;}',
      '.jt-band{font-size:13px;font-weight:800;color:var(--orange,#BD5728);}',
      // Bottom action block: primary "Use" CTA over the band + edit/dupe row.
      // margin-top:auto pins it to the card bottom (grid cards stretch equal).
      '.jt-card-actions{margin-top:auto;display:flex;flex-direction:column;gap:9px;border-top:1px solid var(--br,#2a2f35);padding-top:10px;}',
      '.jt-card-use{width:100%;}',
      '.jt-card-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;}',
      '.jt-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--br,#2a2f35);background:var(--s2,#181c22);color:var(--t,#e8eaf0);cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
      '.jt-btn:hover{border-color:var(--orange,#BD5728);}',
      '.jt-btn-sm{padding:5px 10px;font-size:11px;border-radius:6px;}',
      '.jt-btn-primary{background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);color:#fff;font-weight:700;}',
      '.jt-btn-primary:hover{background:#ff8420;border-color:#ff8420;}',
      '.jt-btn-primary:disabled{opacity:.55;cursor:default;}',
      '.jt-btn-danger{color:#ef4444;border-color:#7f1d1d;background:transparent;}',
      '.jt-empty{text-align:center;padding:56px 20px;color:var(--m,#9aa3ad);font-size:14px;}',
      '.jt-stickybar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:900;background:var(--s,#111418);border:1px solid var(--orange,#BD5728);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);padding:10px 14px;display:flex;gap:12px;align-items:center;max-width:calc(100vw - 24px);flex-wrap:wrap;justify-content:center;}',
      '.jt-stickybar .n{font-size:13px;font-weight:700;color:var(--t,#e8eaf0);white-space:nowrap;}',
      // Ride above bottom strips (Free-plan banner, z 9999) and, on phones, the
      // 62px #mobile-nav (z 1900): both covered this bar, so the checkboxes'
      // "Configure & Preview (N)" action was unreachable (QA 2026-09-27).
      '.jt-stickybar{margin-bottom:var(--nbd-bottom-chrome,0px);}',
      '@media (max-width:768px){.jt-stickybar{bottom:calc(62px + 12px + env(safe-area-inset-bottom,0px));z-index:1950;}}',
      // ── Modal shell ──
      // Phone audit 2026-09-25 (estimate#12): the body had no background, so
      // the full-screen modal was the .96 overlay over the live dashboard —
      // the library intro drew on top of a ghosted "WELCOME BACK" and
      // "+ NEW ESTIMATE", and in the light theme the navy h1 sat on the near-
      // black overlay (1.02:1). The title was hard-coded #fff on a header that
      // is var(--s) — cream in the light theme — so "JOB" vanished (1.06:1).
      // Both now follow the theme tokens, like V2's own .v2-title does.
      '#jtModal{position:fixed;inset:0;z-index:10500;background:rgba(10,12,15,.96);display:none;font-family:"Barlow","Helvetica Neue",sans-serif;padding-top:env(safe-area-inset-top,0);padding-bottom:env(safe-area-inset-bottom,0);}',
      '#jtModal.open{display:flex;flex-direction:column;}',
      '.jt-m-hdr{background:var(--s,#111418);border-bottom:2px solid var(--orange,#BD5728);padding:12px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-shrink:0;}',
      '.jt-m-title{font-family:"Barlow Condensed",sans-serif;font-size:20px;font-weight:800;color:var(--t,#fff);text-transform:uppercase;letter-spacing:.06em;}',
      '.jt-m-title .pro{color:var(--orange,#BD5728);}',
      '.jt-m-step{font-size:11px;color:var(--m,#9aa3ad);letter-spacing:.12em;text-transform:uppercase;font-weight:700;}',
      '.jt-m-step b{color:var(--orange,#BD5728);}',
      '.jt-m-close{background:var(--orange,#BD5728);border:1px solid var(--orange,#BD5728);color:#fff;padding:10px 18px;cursor:pointer;font-weight:700;border-radius:6px;font-size:13px;min-height:44px;min-width:44px;font-family:inherit;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
      '.jt-m-close:hover{background:#ff8420;}',
      '.jt-m-body{flex:1;overflow-y:auto;min-height:0;padding:18px;color:var(--t,#e8eaf0);background:var(--bg,#0a0c0f);}',
      '.jt-m-body>.jt-col{max-width:960px;margin:0 auto;}',
      '.jt-m-foot{flex-shrink:0;background:var(--s,#111418);border-top:1px solid var(--br,#2a2f35);padding:12px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.jt-run{font-size:13px;color:var(--m,#9aa3ad);}',
      '.jt-run b{font-size:20px;color:var(--t,#e8eaf0);font-weight:800;margin-left:6px;}',
      '@media (max-width:640px){.jt-m-hdr{padding:10px 12px;}.jt-m-title{font-size:15px;}.jt-m-body{padding:10px;}.jt-m-foot{padding:10px 12px;}.jt-m-step{display:none;}}',
      // ── Preconfirm ──
      '.jt-topctl{display:flex;gap:14px;flex-wrap:wrap;align-items:center;background:var(--s2,#181c22);border:1px solid var(--br,#2a2f35);border-radius:10px;padding:12px 14px;margin-bottom:14px;}',
      '.jt-seg{display:inline-flex;border:1px solid var(--br,#2a2f35);border-radius:8px;overflow:hidden;}',
      '.jt-seg button{background:transparent;color:var(--m,#9aa3ad);border:none;padding:8px 14px;cursor:pointer;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-family:inherit;-webkit-tap-highlight-color:transparent;}',
      '.jt-seg button.on{background:var(--orange,#BD5728);color:#fff;}',
      '.jt-ctl-lbl{font-size:10.5px;color:var(--m,#9aa3ad);font-weight:700;text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:4px;}',
      '.jt-sec{border:1px solid var(--br,#2a2f35);border-radius:10px;margin-bottom:12px;overflow:hidden;background:var(--s,#111418);}',
      '.jt-sec-hdr{display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer;user-select:none;background:var(--s2,#181c22);-webkit-tap-highlight-color:transparent;}',
      '.jt-sec-hdr .nm{font-weight:700;font-size:14px;color:var(--t,#e8eaf0);flex:1;min-width:0;}',
      '.jt-sec-hdr .meta{font-size:11px;color:var(--m,#9aa3ad);white-space:nowrap;}',
      '.jt-sec-hdr .chev{color:var(--orange,#BD5728);font-size:15px;font-weight:800;width:14px;text-align:center;}',
      '.jt-sec-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px;}',
      '.jt-sec.closed .jt-sec-body{display:none;}',
      '.jt-scopenotes{font-size:11.5px;color:var(--m,#9aa3ad);border-left:3px solid var(--br,#2a2f35);padding:4px 10px;margin:2px 0 4px;line-height:1.45;}',
      '.jt-row{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border:1px solid var(--br,#2a2f35);border-radius:8px;background:var(--s2,#181c22);}',
      '.jt-row.off{opacity:.45;}',
      '.jt-row-main{flex:1;min-width:0;}',
      '.jt-row-name{font-size:13px;font-weight:600;color:var(--t,#e8eaf0);line-height:1.3;}',
      '.jt-row-desc{font-size:11px;color:var(--m,#9aa3ad);margin-top:1px;}',
      '.jt-opt{display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.08em;color:#eab308;border:1px solid #713f12;border-radius:4px;padding:1px 6px;margin-left:6px;text-transform:uppercase;vertical-align:1px;}',
      '.jt-row-ctrls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;}',
      '.jt-in{background:var(--s,#111418);border:1px solid var(--br,#2a2f35);color:var(--t,#e8eaf0);border-radius:6px;padding:7px 8px;font-size:13px;font-family:inherit;box-sizing:border-box;}',
      '.jt-in:focus{outline:none;border-color:var(--orange,#BD5728);}',
      '.jt-in-qty{width:76px;text-align:right;}',
      '.jt-in-price{width:92px;text-align:right;}',
      '.jt-mini-lbl{font-size:9.5px;color:var(--m,#9aa3ad);font-weight:700;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:2px;}',
      '.jt-unit{font-size:11px;color:var(--m,#9aa3ad);min-width:24px;}',
      '.jt-lineretail{font-size:12px;font-weight:700;color:var(--orange,#BD5728);min-width:90px;text-align:right;white-space:nowrap;}',
      '.jt-brand{max-width:230px;font-size:12px;}',
      '@media (max-width:640px){.jt-row{flex-wrap:wrap;}.jt-row-ctrls{width:100%;justify-content:flex-start;}.jt-lineretail{margin-left:auto;}}',
      '.jt-meas{border:1px dashed var(--br,#2a2f35);border-radius:10px;padding:12px 14px;margin-bottom:14px;background:var(--s,#111418);}',
      '.jt-meas-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-top:10px;}',
      // ── Proposal (customer-facing paper — deliberately light-on-white) ──
      '.jt-prop{max-width:820px;margin:0 auto;background:#fff;color:#1a202c;border-radius:10px;padding:34px 38px;box-shadow:0 10px 40px rgba(0,0,0,.5);}',
      '.jt-prop-co{font-family:"Barlow Condensed",sans-serif;font-size:26px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#1a202c;}',
      // Compact legal-name line shown UNDER the logo (letterhead), so the name
      // doesn\'t read as a second giant wordmark beside the logo mark.
      '.jt-prop-co-sm{font-family:"Barlow Condensed",sans-serif;font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:7px;line-height:1.1;}',
      '.jt-prop-kind{font-size:11px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:var(--orange,#BD5728);margin-top:3px;}',
      '.jt-prop-meta{font-size:12px;color:#64748b;margin-top:6px;}',
      '.jt-prop hr{border:none;border-top:2px solid #1a202c;margin:16px 0;}',
      '.jt-prop-scope h3{margin:14px 0 3px;font-size:14px;font-weight:800;color:#1a202c;}',
      '.jt-prop-scope p{margin:0;font-size:12.5px;color:#475569;line-height:1.55;}',
      '.jt-prop table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;}',
      '.jt-prop th{text-align:left;border-bottom:2px solid #1a202c;padding:8px 6px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#334155;}',
      '.jt-prop td{padding:8px 6px;border-bottom:1px solid #e2e8f0;vertical-align:top;}',
      '.jt-prop .num{text-align:right;white-space:nowrap;}',
      '.jt-prop-grp td{background:#f8fafc;font-weight:800;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#475569;}',
      '.jt-prop-tots{margin-top:14px;margin-left:auto;max-width:300px;font-size:13.5px;}',
      '.jt-prop-tots .r{display:flex;justify-content:space-between;padding:5px 0;color:#334155;}',
      '.jt-prop-tots .g{border-top:2px solid #1a202c;margin-top:5px;padding-top:9px;font-size:17px;font-weight:800;color:#1a202c;}',
      '.jt-prop-note{margin-top:20px;font-size:11px;color:#94a3b8;line-height:1.5;}',
      '.jt-prop-warranty{margin-top:16px;font-size:12.5px;color:#334155;line-height:1.5;}',
      // Repair-job "1-year workmanship warranty" box: the whole label is the
      // tap target, 44px tall on touch.
      '.jt-warr{display:flex;align-items:center;gap:8px;min-height:36px;font-size:13px;font-weight:600;color:var(--t,#e8eaf0);cursor:pointer;-webkit-tap-highlight-color:transparent;}',
      '@media (pointer:coarse){.jt-warr{min-height:44px;}}',
      '@media (max-width:640px){.jt-prop{padding:20px 14px;}}',
      '.jt-createbar{max-width:820px;margin:16px auto 0;background:var(--s,#111418);border:1px solid var(--br,#2a2f35);border-radius:10px;padding:14px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;}',
      '.jt-createbar .fld{flex:1;min-width:200px;}',
      '.jt-create-err{flex-basis:100%;font-size:13px;font-weight:700;color:var(--red,#ef4444);line-height:1.4;}',
      '.jt-create-err:empty{display:none;}',
      // ── Lead picker (EntityResolver) ──
      '.er-picker{position:relative;}',
      // Two-choice chooser — same flex:1 primary/secondary pair pattern as
      // D2D's Hot Lead "Convert Now" / "Edit First" prompt, for consistency.
      '.er-choice{display:flex;gap:10px;}',
      '.er-choice button{flex:1;}',
      '.er-search-wrap{position:relative;}',
      '.er-search{width:100%;}',
      '.er-back{margin-top:8px;}',
      '.er-selected{display:flex;align-items:center;gap:8px;background:var(--s2,#181c22);border:1px solid var(--br,#2a2f35);border-radius:6px;padding:7px 8px;}',
      '.er-selected-name{font-size:13px;font-weight:700;color:var(--t,#e8eaf0);}',
      '.er-selected-sub{font-size:11px;color:var(--m,#9aa3ad);flex:1;}',
      '.er-results{position:absolute;left:0;right:0;top:100%;margin-top:4px;background:var(--s,#111418);border:1px solid var(--br,#2a2f35);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.4);max-height:240px;overflow-y:auto;z-index:5;}',
      '.er-row{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--br,#2a2f35);}',
      '.er-row:last-child{border-bottom:none;}',
      '.er-row:hover{background:var(--s2,#181c22);}',
      '.er-row-name{display:block;font-size:12.5px;font-weight:600;color:var(--t,#e8eaf0);}',
      '.er-row-sub{display:block;font-size:11px;color:var(--m,#9aa3ad);}',
      '.er-row-empty{cursor:default;font-size:11.5px;color:var(--m,#9aa3ad);}',
      '.er-row-empty:hover{background:transparent;}',
      // ── Success ──
      '.jt-success{max-width:520px;margin:8vh auto 0;text-align:center;background:var(--s,#111418);border:1px solid var(--br,#2a2f35);border-radius:14px;padding:38px 26px;}',
      '.jt-success .ic{width:64px;height:64px;border-radius:50%;background:rgba(16,185,129,.12);border:2px solid #10b981;color:#10b981;font-size:30px;line-height:60px;margin:0 auto 14px;}',
      '.jt-success h2{margin:0 0 6px;font-size:20px;color:var(--t,#e8eaf0);}',
      '.jt-success p{margin:0 0 20px;font-size:13px;color:var(--m,#9aa3ad);}',
      '.jt-success .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}',
      // ── Editor overlay ──
      '#jtEditModal{position:fixed;inset:0;z-index:10600;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;padding:18px;font-family:"Barlow","Helvetica Neue",sans-serif;}',
      '#jtEditModal.open{display:flex;}',
      '.jt-ed-card{background:var(--s,#111418);border:1px solid var(--br,#2a2f35);border-radius:12px;width:min(880px,100%);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;color:var(--t,#e8eaf0);box-shadow:0 14px 50px rgba(0,0,0,.6);}',
      '.jt-ed-hdr{padding:14px 18px;border-bottom:2px solid var(--orange,#BD5728);display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.jt-ed-hdr .t{font-weight:800;font-size:16px;color:#fff;}',
      '.jt-ed-body{flex:1;overflow-y:auto;min-height:0;padding:16px 18px;}',
      '.jt-ed-foot{padding:12px 18px;border-top:1px solid var(--br,#2a2f35);display:flex;justify-content:flex-end;gap:10px;}',
      '.jt-ed-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      '@media (max-width:640px){.jt-ed-grid{grid-template-columns:1fr;}}',
      '.jt-ed-item{display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--br,#2a2f35);border-radius:8px;background:var(--s2,#181c22);flex-wrap:wrap;}',
      '.jt-ed-item .code{flex:1;min-width:160px;}',
      '.jt-fork-note{font-size:11.5px;color:#eab308;border:1px solid #713f12;background:rgba(234,179,8,.06);border-radius:8px;padding:8px 12px;margin-bottom:12px;line-height:1.45;}',
      // ── Upgrades card (stage 2, 2026-09-25) ──
      // Thumb-first: every pick is a 56px row, every tool a 48px button, and
      // number boxes are 16px text (iOS zooms the page on a smaller input).
      // The price sits on its own line so "150 ft × $18 = $2,700" never
      // squeezes the name at 360px.
      '#jtUpgCard:empty{display:none;}',
      '.jt-upg{border:1px solid var(--br,#2a2f35);border-left:4px solid var(--orange,#BD5728);border-radius:10px;background:var(--s,#111418);margin-bottom:14px;overflow:hidden;}',
      '.jt-upg-hdr{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;background:var(--s2,#181c22);}',
      '.jt-upg-t{font-weight:800;font-size:15px;color:var(--t,#e8eaf0);}',
      '.jt-upg-sum{flex:1;min-width:150px;font-size:13px;font-weight:700;color:var(--orange,#BD5728);}',
      '.jt-upg-show{min-height:48px;padding:10px 16px;font-size:14px;}',
      '.jt-upg-body{padding:10px;display:flex;flex-direction:column;gap:10px;}',
      '.jt-upg-note{font-size:12.5px;color:var(--m,#9aa3ad);line-height:1.45;}',
      // Status colours follow the theme tokens, so a light theme's darker
      // --green / --gold / --red apply (a fixed #10b981 on the "paper" theme's
      // white reads at about 2.5:1).
      '.jt-upg-gerr{font-size:12.5px;color:var(--red,#ef4444);line-height:1.45;}',
      '.jt-upg-gerr:empty{display:none;}',
      '.jt-upg-grp{border:1px solid var(--br,#2a2f35);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;}',
      '.jt-upg-grp-hd{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;}',
      '.jt-upg-grp-t{font-size:14px;font-weight:800;color:var(--t,#e8eaf0);}',
      '.jt-upg-grp-t small{font-size:12px;font-weight:600;color:var(--m,#9aa3ad);margin-left:6px;}',
      '.jt-upg-qty{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--m,#9aa3ad);}',
      '.jt-upg-qty input{width:92px;min-height:48px;text-align:right;font-size:16px;}',
      '.jt-upg-hint{font-size:11.5px;color:var(--m,#9aa3ad);flex-basis:100%;}',
      '.jt-upg-opt{border:1px solid var(--br,#2a2f35);border-radius:10px;background:var(--s2,#181c22);}',
      '.jt-upg-opt.on{border-color:var(--orange,#BD5728);box-shadow:inset 0 0 0 1px var(--orange,#BD5728);}',
      '.jt-upg-pick{display:flex;align-items:flex-start;gap:12px;width:100%;min-height:56px;padding:12px;background:transparent;border:0;color:inherit;text-align:left;font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;box-sizing:border-box;}',
      '.jt-upg-pick:disabled{cursor:default;}',
      '.jt-upg-ind{flex:none;width:24px;height:24px;border:2px solid var(--m,#9aa3ad);border-radius:6px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;line-height:1;color:#fff;}',
      '.jt-upg-ind.r{border-radius:50%;}',
      '.on>.jt-upg-pick .jt-upg-ind,.jt-upg-none.on .jt-upg-ind{background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);}',
      '.jt-upg-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.jt-upg-nm{font-size:14.5px;font-weight:700;color:var(--t,#e8eaf0);line-height:1.3;}',
      '.jt-upg-ben{font-size:12.5px;color:var(--m,#9aa3ad);line-height:1.4;}',
      '.jt-upg-war{font-size:12px;color:var(--green,#10b981);line-height:1.4;}',
      '.jt-upg-nc,.jt-upg-inst{font-size:12px;color:var(--m,#9aa3ad);line-height:1.4;}',
      '.jt-upg-px{font-size:14px;font-weight:800;color:var(--orange,#BD5728);margin-top:2px;}',
      '.jt-upg-badge{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:4px;padding:2px 6px;margin-left:6px;vertical-align:1px;border:1px solid currentColor;}',
      '.jt-upg-badge.req{color:var(--blue,#3b82f6);}',
      '.jt-upg-badge.star{color:var(--gold,#eab308);}',
      '.jt-upg-badge.no{color:var(--m,#9aa3ad);}',
      '.jt-upg-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:0 12px 12px 48px;}',
      '.jt-upg-tool{min-height:48px;padding:8px 12px;font-size:13px;}',
      '.jt-upg-tool[aria-pressed="true"]{border-color:var(--orange,#BD5728);color:var(--orange,#BD5728);}',
      '.jt-upg-why{display:flex;flex-direction:column;gap:4px;padding:0 12px 12px 48px;font-size:12px;color:var(--m,#9aa3ad);}',
      '.jt-upg-why input{width:100%;min-height:48px;font-size:16px;}',
      '.jt-upg-err{font-size:12.5px;color:var(--red,#ef4444);padding:0 12px 12px 48px;line-height:1.4;}',
      '.jt-upg-err:empty{display:none;}',
      '.jt-upg-none{display:flex;align-items:center;gap:12px;width:100%;min-height:48px;padding:10px 12px;border:1px solid var(--br,#2a2f35);border-radius:10px;background:var(--s2,#181c22);color:var(--t,#e8eaf0);font:inherit;font-size:14px;font-weight:700;text-align:left;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
      '.jt-upg-none.on{border-color:var(--orange,#BD5728);}',
      '.jt-upg-np{opacity:.62;}',
      '.jt-upg-np .jt-upg-px{color:var(--m,#9aa3ad);font-weight:700;}',
      '.jt-upg-more{min-height:48px;width:100%;font-size:13px;}',
      '@media (max-width:640px){.jt-upg-tools,.jt-upg-why,.jt-upg-err{padding-left:12px;}}',
      // ── Show homeowner page ──
      // Its own layer over the build screen (the rep's controls are gone),
      // light paper like the proposal, safe-area padded for the installed
      // iPhone app, and Add / No thanks the same size on purpose.
      '#jtHomeowner{position:fixed;inset:0;z-index:10560;display:none;flex-direction:column;background:#f8fafc;color:#1a202c;font-family:"Barlow","Helvetica Neue",-apple-system,sans-serif;padding-top:env(safe-area-inset-top,0);padding-bottom:env(safe-area-inset-bottom,0);}',
      '#jtHomeowner.open{display:flex;}',
      '.jt-ho-hdr{flex-shrink:0;background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 18px;}',
      '.jt-ho-co{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#64748b;}',
      '.jt-ho-hdr h2{margin:4px 0 2px;font-size:22px;font-weight:800;color:#1a202c;}',
      '.jt-ho-hdr h2:focus{outline:none;}',
      '.jt-ho-hdr p{margin:0;font-size:14px;color:#475569;line-height:1.45;}',
      '.jt-ho-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 16px 24px;}',
      '.jt-ho-col{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:14px;}',
      '.jt-ho-min{margin:0;background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;border-radius:12px;padding:10px 14px;font-size:14px;line-height:1.45;}',
      '.jt-ho-incl{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:0 14px;}',
      '.jt-ho-incl summary{min-height:48px;display:flex;align-items:center;font-size:15px;font-weight:700;cursor:pointer;color:#1a202c;}',
      '.jt-ho-incl ul{margin:0 0 12px;padding-left:20px;font-size:14px;color:#334155;line-height:1.6;}',
      '.jt-ho-grp h3{margin:0 0 8px;font-size:15px;font-weight:800;color:#1a202c;}',
      '.jt-ho-grp h3 small{font-weight:600;color:#64748b;margin-left:6px;font-size:13px;}',
      '.jt-ho-card{background:#fff;border:2px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;}',
      '.jt-ho-card.added{border-color:#10b981;box-shadow:0 0 0 1px #10b981 inset;}',
      '.jt-ho-rec{font-size:13px;font-weight:700;color:#92400e;background:#fef3c7;border-radius:8px;padding:6px 10px;margin-bottom:8px;line-height:1.4;}',
      '.jt-ho-card h4{margin:0 0 4px;font-size:17px;font-weight:800;color:#1a202c;}',
      '.jt-ho-card p{margin:0 0 4px;font-size:14px;color:#475569;line-height:1.45;}',
      '.jt-ho-card .war{color:#065f46;}',
      '.jt-ho-px{font-size:16px;color:#1a202c;margin:8px 0 10px;}',
      '.jt-ho-px b{font-size:19px;}',
      '.jt-ho-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
      '.jt-ho-btn{min-height:52px;border-radius:10px;border:2px solid #cbd5e1;background:#fff;color:#1a202c;font:inherit;font-size:16px;font-weight:800;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
      '.jt-ho-btn[aria-pressed="true"].add{background:#10b981;border-color:#10b981;color:#fff;}',
      '.jt-ho-btn[aria-pressed="true"].no{background:#e2e8f0;border-color:#94a3b8;}',
      '.jt-ho-foot{flex-shrink:0;background:#fff;border-top:1px solid #e2e8f0;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.jt-ho-tot{font-size:14px;color:#475569;}',
      '.jt-ho-tot b{display:block;font-size:24px;color:#1a202c;}',
      '.jt-ho-done{min-height:52px;padding:10px 20px;border-radius:10px;border:0;background:var(--orange,#BD5728);color:#fff;font:inherit;font-size:16px;font-weight:800;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Modal shell (injected once — estimate-v2-ui ensureModal pattern)
  // ══════════════════════════════════════════════════════════════════════

  function ensureModal() {
    ensureStyles();
    if (document.getElementById('jtModal')) return;

    var modal = document.createElement('div');
    modal.id = 'jtModal';
    modal.innerHTML =
      '<div class="jt-m-hdr">' +
        '<div class="jtx-dflex-aibaseline-gap14px">' +
          '<span class="jt-m-title">Job <span class="pro">Templates</span></span>' +
          '<span class="jt-m-step" id="jtStepLbl"></span>' +
        '</div>' +
        '<button type="button" class="jt-m-close" data-jt-action="close-modal">✕ Close</button>' +
      '</div>' +
      '<div class="jt-m-body" id="jtModalBody"></div>' +
      '<div class="jt-m-foot" id="jtModalFoot" style="display:none;"></div>';
    document.body.appendChild(modal);

    var ed = document.createElement('div');
    ed.id = 'jtEditModal';
    ed.innerHTML = '<div class="jt-ed-card" id="jtEditCard"></div>';
    document.body.appendChild(ed);
  }

  function modalOpen() {
    var m = document.getElementById('jtModal');
    return !!(m && m.classList.contains('open'));
  }

  function showModal() {
    ensureModal();
    document.getElementById('jtModal').classList.add('open');
  }

  function closeModal() {
    var m = document.getElementById('jtModal');
    if (m) m.classList.remove('open');
    var e = document.getElementById('jtEditModal');
    if (e) e.classList.remove('open');
    state.step = 'library';
    state.creating = false;
    state.createErr = '';
    state.leadId = null; // lead context is per-open, never sticky
    state.repairWarranty = false; // a warranty is chosen per estimate — never carried into the next one
    state.upg = freshUpg();       // so are upgrade picks, stars and "No thanks" answers
    var ho = document.getElementById('jtHomeowner');
    if (ho) { ho.classList.remove('open'); ho.innerHTML = ''; }
    if (state.host === 'modal') {
      state.host = 'view';
      state.forScope = false;
      state.scopeCb = null;
    }
    reRender(); // refresh the dashboard view (selection state may have changed)
  }

  // ══════════════════════════════════════════════════════════════════════
  // LIBRARY view
  // ══════════════════════════════════════════════════════════════════════

  function renderStats(list) {
    var all = allTemplates();
    var customs = all.filter(isCustom).length;
    var cats = {};
    all.forEach(function (t) { if (t && t.category) cats[t.category] = 1; });
    function tile(k, v, color) {
      return '<div class="jt-stat" style="border-left-color:' + esc(color) + ';">' +
        '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
    }
    return '<div class="jt-stats">' +
      tile('Templates', all.length, '#3b82f6') +
      tile('Custom', customs, '#8b5cf6') +
      tile('Categories', Object.keys(cats).length, '#10b981') +
      tile('Showing', list.length, '#f59e0b') +
      tile('Selected', state.selected.length, 'var(--orange,#BD5728)') +
      '</div>';
  }

  function renderPills() {
    var meta = categoryMeta();
    var all = allTemplates();
    var counts = {};
    all.forEach(function (t) { if (t) counts[t.category] = (counts[t.category] || 0) + 1; });

    var catPills = '<button type="button" class="jt-pill' + (state.category === 'all' ? ' on' : '') + '" ' +
      'data-jt-action="set-category" data-id="all" style="' +
      (state.category === 'all' ? 'border-color:var(--orange,#BD5728);color:var(--orange,#BD5728);background:rgba(189,87,40,.09);' : '') +
      '">All <span class="ct">' + all.length + '</span></button>';
    Object.keys(meta).forEach(function (key) {
      var c = counts[key] || 0;
      if (!c) return;
      var on = state.category === key;
      var col = catColor(key);
      catPills += '<button type="button" class="jt-pill' + (on ? ' on' : '') + '" data-jt-action="set-category" data-id="' + esc(key) + '"' +
        (on ? ' style="border-color:' + esc(col) + ';color:' + esc(col) + ';background:' + esc(col) + '18;"' : '') + '>' +
        esc(catIcon(key)) + ' ' + esc(catLabel(key)) + ' <span class="ct">' + c + '</span></button>';
    });

    var typePills = '<button type="button" class="jt-pill' + (state.jobType === 'all' ? ' on' : '') + '" data-jt-action="set-jobtype" data-id="all"' +
      (state.jobType === 'all' ? ' style="border-color:var(--orange,#BD5728);color:var(--orange,#BD5728);background:rgba(189,87,40,.09);"' : '') +
      '>All types</button>';
    Object.keys(JOB_TYPES).forEach(function (key) {
      var on = state.jobType === key;
      typePills += '<button type="button" class="jt-pill' + (on ? ' on' : '') + '" data-jt-action="set-jobtype" data-id="' + esc(key) + '"' +
        (on ? ' style="border-color:var(--orange,#BD5728);color:var(--orange,#BD5728);background:rgba(189,87,40,.09);"' : '') + '>' +
        esc(JOB_TYPES[key]) + '</button>';
    });

    return '<div class="jt-controls">' +
      '<input type="text" class="jt-search" id="jtSearch" data-jt-action="search" ' +
        'placeholder="Search templates by name, tag, or description..." value="' + esc(state.search) + '">' +
      '<div class="jt-pills">' + typePills + '</div>' +
      '<div class="jt-pills">' + catPills + '</div>' +
      '</div>';
  }

  function renderCard(t) {
    var col = catColor(t.category);
    var sel = isSelected(t.id);
    var custom = isCustom(t);
    var items = (t.items || []).length;
    var band = priceBand(t);
    var tags = (t.tags || []).slice(0, 3).map(function (tg) {
      return '<span class="jt-chip">#' + esc(tg) + '</span>';
    }).join('');
    // Primary card CTA — the always-visible entry into the use flow, so the
    // rep never has to discover the checkbox + sticky bar to apply a
    // template. In scope mode it inserts into the open estimate; otherwise
    // it runs configure → preview → attribute-to-customer → create.
    var useLabel = state.forScope ? 'Insert into estimate →' : 'Use this template →';
    var useTitle = state.forScope
      ? 'Add this template to the open estimate'
      : 'Configure this template, then apply it to a customer, lead, or prospect';

    return '<div class="jt-card' + (sel ? ' sel' : '') + '" style="border-left-color:' + esc(col) + ';">' +
      '<div class="jt-card-top">' +
        '<input type="checkbox" class="jt-check" data-jt-action="toggle-select" data-id="' + esc(t.id) + '"' + (sel ? ' checked' : '') + ' aria-label="Select ' + esc(t.name) + '">' +
        '<div class="jtx-fx1-minw0">' +
          '<div class="jt-card-name">' + esc(t.name) +
            (custom ? ' <span class="jt-chip jtx-c8b5cf6-bor8b5cf6">Custom</span>' : '') +
          '</div>' +
          '<div class="jt-chips jtx-mt4px">' +
            '<span class="jt-chip" style="color:' + esc(col) + ';border-color:' + esc(col) + '55;">' + esc(catIcon(t.category)) + ' ' + esc(catLabel(t.category)) + '</span>' +
            (t.jobType ? '<span class="jt-chip">' + esc(JOB_TYPES[t.jobType] || t.jobType) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="jt-card-desc">' + esc(t.description || '') + '</div>' +
      '<div class="jt-chips">' +
        '<span class="jt-chip">' + items + ' item' + (items === 1 ? '' : 's') + '</span>' +
        (t.durationHint ? '<span class="jt-chip">⏱ ' + esc(t.durationHint) + '</span>' : '') +
        // Subtle stickiness signal — list() stamps useCount from the usage map.
        (Number(t.useCount) > 0 ? '<span class="jt-chip jt-used-chip">used ' + Number(t.useCount) + '×</span>' : '') +
        tags +
      '</div>' +
      '<div class="jt-card-actions">' +
        '<button type="button" class="jt-btn jt-btn-primary jt-card-use" data-jt-action="quick-use" data-id="' + esc(t.id) + '" title="' + esc(useTitle) + '">' + useLabel + '</button>' +
        '<div class="jt-card-foot">' +
          '<span class="jt-band">' + (band ? esc(band) : '&nbsp;') + '</span>' +
          '<div class="jtx-dflex-gap6px">' +
            '<button type="button" class="jt-btn jt-btn-sm" data-jt-action="edit-template" data-id="' + esc(t.id) + '">Edit</button>' +
            '<button type="button" class="jt-btn jt-btn-sm" data-jt-action="duplicate-template" data-id="' + esc(t.id) + '">Duplicate</button>' +
            (custom ? '<button type="button" class="jt-btn jt-btn-sm jt-btn-danger" data-jt-action="delete-template" data-id="' + esc(t.id) + '">Delete</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>';
  }

  // "Recently used" strip — top 6 by lastUsedAt (list() overlays the usage
  // map), compact cards, hidden entirely when nothing has been used yet.
  // Tapping a card toggles selection (same effect as the grid checkbox).
  function renderRecentStrip() {
    var recent = allTemplates()
      .filter(function (t) { return t && Number(t.useCount) > 0 && t.lastUsedAt != null; })
      .sort(function (a, b) { return Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0); })
      .slice(0, 6);
    if (!recent.length) return '';
    var cards = recent.map(function (t) {
      var col = catColor(t.category);
      var sel = isSelected(t.id);
      return '<button type="button" class="jt-recent-card' + (sel ? ' sel' : '') + '" ' +
        'data-jt-action="quick-select" data-id="' + esc(t.id) + '" ' +
        'style="border-left-color:' + esc(col) + ';" aria-label="Select ' + esc(t.name) + '">' +
        '<span class="jt-recent-ic">' + esc(catIcon(t.category)) + '</span>' +
        '<span class="jtx-minw0">' +
          '<span class="jt-recent-name">' + esc(t.name) + '</span>' +
          '<span class="jt-recent-meta">used ' + Number(t.useCount) + '×</span>' +
        '</span>' +
        (sel ? '<span class="jt-recent-check">✓</span>' : '') +
        '</button>';
    }).join('');
    return '<div class="jt-recent">' +
      '<div class="jt-recent-hdr">🕘 Recently used</div>' +
      '<div class="jt-recent-row">' + cards + '</div>' +
      '</div>';
  }

  function renderStickyBar() {
    var n = state.selected.length;
    if (!n) return '';
    var label = state.forScope ? 'Insert setup (' + n + ')' : 'Configure &amp; Preview (' + n + ')';
    return '<div class="jt-stickybar">' +
      '<span class="n">' + n + ' template' + (n === 1 ? '' : 's') + ' selected</span>' +
      '<button type="button" class="jt-btn jt-btn-sm" data-jt-action="clear-selection">Clear</button>' +
      '<button type="button" class="jt-btn jt-btn-primary" data-jt-action="open-preconfirm">' + label + '</button>' +
      '</div>';
  }

  function renderLibrary() {
    ensureStyles();
    var JT = engine();
    if (!JT) {
      return '<div class="jt-wrap"><div class="jt-empty">' +
        '<div class="jtx-fs34px-mb10px">📋</div>' +
        'Job templates are still loading.<br>' +
        '<button type="button" class="jt-btn jtx-mt14px" data-jt-action="rerender">Retry</button>' +
        '</div></div>';
    }
    var list = getFiltered();
    var cards = list.map(renderCard).join('');
    var hdrBtns =
      '<div class="jtx-dflex-gap8px">' +
        '<button type="button" class="jt-btn jt-btn-primary" data-jt-action="new-template">+ New Template</button>' +
      '</div>';
    // In modal (picker) mode the dashboard page header isn't around us,
    // so include a compact heading either way.
    return '<div class="jt-wrap">' +
      '<div class="jt-hdr"><div>' +
        '<h1>Job Templates</h1>' +
        '<p>Pre-built quotes — select one or more, customize, and generate a retail estimate.</p>' +
      '</div>' + hdrBtns + '</div>' +
      renderStats(list) +
      renderPills() +
      renderRecentStrip() +
      (cards ? '<div class="jt-grid">' + cards + '</div>'
             : '<div class="jt-empty">No templates match your filters.</div>') +
      renderStickyBar() +
      '</div>';
  }

  // Public: render() → HTML string (same contract as _productLib.render()).
  function render() {
    return renderLibrary();
  }

  function viewHost() { return document.getElementById('jobTemplatesContainer'); }

  function paintView() {
    var host = viewHost();
    if (host) host.innerHTML = renderLibrary();
  }

  function paintModal() {
    ensureModal();
    var body = document.getElementById('jtModalBody');
    var foot = document.getElementById('jtModalFoot');
    var stepLbl = document.getElementById('jtStepLbl');
    if (!body || !foot) return;

    var stepNames = state.host === 'modal'
      ? ['library', 'preconfirm'].concat(state.forScope ? [] : ['preview'])
      : ['preconfirm'].concat(state.forScope ? [] : ['preview']);
    if (stepLbl) {
      stepLbl.innerHTML = stepNames.map(function (s) {
        var lbl = s === 'library' ? 'Pick' : (s === 'preconfirm' ? 'Configure' : 'Preview');
        return (s === state.step) ? '<b>' + lbl + '</b>' : lbl;
      }).join(' › ');
    }

    if (state.step === 'library') {
      body.innerHTML = renderLibrary();
      foot.style.display = 'none';
    } else if (state.step === 'preconfirm') {
      body.innerHTML = renderPreconfirm();
      foot.innerHTML = renderPreconfirmFoot();
      foot.style.display = 'flex';
      refreshTotals(); // populate running total + per-line retail
    } else if (state.step === 'preview') {
      var res = resolveCurrent();
      state.lastResolved = res;
      var model = upgModel(res);
      body.innerHTML = renderPreview(res, model);
      _jtWireLeadPicker();
      foot.innerHTML =
        '<button type="button" class="jt-btn" data-jt-action="back-to-preconfirm">← Back to edit</button>' +
        '<span class="jt-run" id="jtRunTotal">' + runTotalHtml(res, model) + '</span>';
      foot.style.display = 'flex';
    } else if (state.step === 'success') {
      body.innerHTML = renderSuccess();
      foot.style.display = 'none';
    }
    body.scrollTop = 0;
  }

  // Public: reRender — repaints whichever host is live.
  // opts.background (the engine's one-time cloud pull, 2026-10-06): data
  // changed under the rep, not because they did something. Never rebuild an
  // open Configure/Preview/Success screen (paintModal resets scrollTop and
  // the inputs); those steps re-read the templates on their next paint. An
  // open library repaints in place, keeping its scroll position.
  function reRender(opts) {
    if (opts && opts.background) {
      if (modalOpen()) {
        if (state.step !== 'library') { paintView(); return; }
        var mb = document.getElementById('jtModalBody');
        var keep = mb ? mb.scrollTop : 0;
        if (state.host === 'modal') paintModal();
        if (mb) mb.scrollTop = keep;
      }
      paintView();
      return;
    }
    if (modalOpen() && state.step !== 'library') { paintModal(); return; }
    if (modalOpen() && state.host === 'modal') { paintModal(); }
    paintView();
  }

  // ══════════════════════════════════════════════════════════════════════
  // PRECONFIRM step
  // ══════════════════════════════════════════════════════════════════════

  function renderPreconfirm() {
    ensureChoices();
    seedMeasurements();

    // Tier row only where the tier prices something (a tierPriced template —
    // none today). On every current template it changed no number and only
    // printed "Preferred" on the paperwork (2026-09-25).
    var tierSeg = tiersApplyNow()
      ? '<div><span class="jt-ctl-lbl">Tier</span><div class="jt-seg">' +
        TIERS.map(function (t) {
          return '<button type="button" class="' + (state.tier === t ? 'on' : '') + '" data-jt-action="set-tier" data-id="' + t + '">' + TIER_LABELS[t] + '</button>';
        }).join('') + '</div></div>'
      : '';

    var repairBox = selectionHasRepair()
      ? '<div><span class="jt-ctl-lbl">Warranty</span>' +
        '<label class="jt-warr"><input type="checkbox" class="jt-check" data-jt-action="set-repair-warranty"' +
        (state.repairWarranty ? ' checked' : '') + '> 1-year workmanship warranty</label></div>'
      : '';

    var modeSeg = '<div><span class="jt-ctl-lbl">Job mode</span><div class="jt-seg">' +
      ['cash', 'insurance'].map(function (m) {
        return '<button type="button" class="' + (state.jobMode === m ? 'on' : '') + '" data-jt-action="set-jobmode" data-id="' + m + '">' + (m === 'cash' ? 'Cash' : 'Insurance') + '</button>';
      }).join('') + '</div></div>';

    // County/tax jurisdiction — same tax map + neutral default as the V2
    // builder, so preview tax == saved tax == V2 tax ("Other / My county"
    // = '' rides the engines' 7% fallback by design).
    var countySel = '<div><span class="jt-ctl-lbl">County / Tax</span>' +
      '<select class="jt-in jtx-minw180px" data-jt-action="set-county">' +
      countyOptions().map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (state.county === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select></div>';

    var measBtn = '<div class="jtx-mlauto"><span class="jt-ctl-lbl">&nbsp;</span>' +
      '<button type="button" class="jt-btn" data-jt-action="toggle-meas">📐 Measurements ' + (state.measOpen ? '▾' : '▸') + '</button></div>';

    // The Upgrades card sits right under the job's controls, above the line
    // items. It is painted by refreshTotals() (it needs the resolved lines —
    // offers and footage follow the scope), so this is only its slot.
    var html = '<div class="jt-col">' +
      '<div class="jt-topctl">' + tierSeg + modeSeg + countySel + repairBox + measBtn + '</div>' +
      (state.measOpen ? renderMeasPanel() : '') +
      '<div id="jtUpgCard"></div>';

    state.selected.forEach(function (tid) {
      html += renderTplSection(tid);
    });

    html += '</div>';
    return html;
  }

  function renderMeasPanel() {
    var driven = anyMeasurementDriven();
    var fields = Object.keys(MEAS_DEFAULTS).map(function (k) {
      var v = state.measurements[k];
      if (typeof MEAS_DEFAULTS[k] === 'boolean') {
        return '<label class="jtx-dflex-aicenter-gap8px">' +
          '<input type="checkbox" class="jt-check jtx-wd17px-hei17px-minw17px" data-jt-meas="' + esc(k) + '"' + (v ? ' checked' : '') + '>' +
          esc(MEAS_LABELS[k] || k) + '</label>';
      }
      return '<div><span class="jt-mini-lbl">' + esc(MEAS_LABELS[k] || k) + '</span>' +
        '<input type="number" step="any" class="jt-in jtx-wd100" data-jt-meas="' + esc(k) + '" value="' + esc(v == null ? '' : v) + '"></div>';
    }).join('');
    return '<div class="jt-meas">' +
      '<div class="jtx-fs12px-w700-corange">Measurements' +
      (driven ? ' <span class="jtx-ceab308-w600-ttnone">— required: a selected template scales to real measurements</span>' : '') +
      '</div>' +
      '<div class="jt-meas-grid">' + fields + '</div>' +
      '</div>';
  }

  function renderTplSection(tid) {
    var t = getTpl(tid);
    if (!t) return '';
    var ch = state.choices[tid] || [];
    var closed = !!state.collapsed[tid];
    var included = ch.filter(function (c) { return c.included !== false; }).length;
    var col = catColor(t.category);

    var rows = (t.items || []).map(function (it, i) {
      return renderItemRow(tid, it, ch[i] || {}, i);
    }).join('');

    return '<div class="jt-sec' + (closed ? ' closed' : '') + '" style="border-left:4px solid ' + esc(col) + ';">' +
      '<div class="jt-sec-hdr" data-jt-action="toggle-section" data-id="' + esc(tid) + '">' +
        '<span class="chev">' + (closed ? '+' : '−') + '</span>' +
        '<span class="nm">' + esc(catIcon(t.category)) + ' ' + esc(t.name) + '</span>' +
        '<span class="meta">' + included + '/' + (t.items || []).length + ' items' +
          (t.durationHint ? ' · ' + esc(t.durationHint) : '') + '</span>' +
      '</div>' +
      '<div class="jt-sec-body">' +
        (t.scopeNotes ? '<div class="jt-scopenotes">' + esc(t.scopeNotes) + '</div>' : '') +
        rows +
      '</div>' +
      '</div>';
  }

  function renderItemRow(tid, it, choice, idx) {
    var incl = choice.included !== false;
    var unit = itemUnit(it, choice);
    var name = itemLabel(it);
    var desc = itemDesc(it);
    var qtyVal = (choice.qty === null || choice.qty === undefined) ? '' : choice.qty;
    var priceVal = (choice.unitPriceOverride === null || choice.unitPriceOverride === undefined) ? '' : choice.unitPriceOverride;

    var brandSel = '';
    if (Array.isArray(it.brandOptions) && it.brandOptions.length) {
      brandSel = '<select class="jt-in jt-brand" data-jt-action="item-brand" data-tid="' + esc(tid) + '" data-idx="' + idx + '">' +
        it.brandOptions.map(function (o) {
          var on = (choice.brandCode || it.code) === o.code;
          return '<option value="' + esc(o.code) + '"' + (on ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') + '</select>';
    }

    return '<div class="jt-row' + (incl ? '' : ' off') + '">' +
      '<input type="checkbox" class="jt-check" data-jt-action="item-include" data-tid="' + esc(tid) + '" data-idx="' + idx + '"' + (incl ? ' checked' : '') + ' aria-label="Include ' + esc(name) + '">' +
      '<div class="jt-row-main">' +
        '<div class="jt-row-name">' + esc(name) +
          (it.optional ? '<span class="jt-opt">Optional</span>' : '') +
        '</div>' +
        (desc ? '<div class="jt-row-desc">' + esc(desc) + '</div>' : '') +
        (brandSel ? '<div class="jtx-mt6px">' + brandSel + '</div>' : '') +
      '</div>' +
      '<div class="jt-row-ctrls">' +
        '<div><span class="jt-mini-lbl">Qty</span>' +
          '<input type="number" step="any" min="0" class="jt-in jt-in-qty" placeholder="auto" data-jt-action="item-qty" data-tid="' + esc(tid) + '" data-idx="' + idx + '" value="' + esc(qtyVal) + '">' +
        '</div>' +
        '<span class="jt-unit">' + esc(unit) + '</span>' +
        '<div><span class="jt-mini-lbl">$ / unit</span>' +
          '<input type="number" step="any" min="0" class="jt-in jt-in-price" placeholder="auto" data-jt-action="item-price" data-tid="' + esc(tid) + '" data-idx="' + idx + '" value="' + esc(priceVal) + '">' +
        '</div>' +
        '<span class="jt-lineretail" data-jt-lineref="' + esc(tid) + '|' + idx + '">…</span>' +
      '</div>' +
      '</div>';
  }

  function renderPreconfirmFoot() {
    var back = '<button type="button" class="jt-btn" data-jt-action="' +
      (state.host === 'modal' ? 'back-to-library' : 'close-modal') + '">← Back</button>';
    var primary = state.forScope
      ? '<button type="button" class="jt-btn jt-btn-primary" data-jt-action="insert-into-v2">Insert into estimate →</button>'
      : '<button type="button" class="jt-btn jt-btn-primary" data-jt-action="go-preview">Preview proposal →</button>';
    return back +
      '<span class="jt-run" id="jtRunTotal">…</span>' +
      primary;
  }

  // The foot's running total. With upgrades picked it is the total the saved
  // estimate will carry (the same applyUpgrades payload), to the cent — the
  // engine's own total is rounded to $25 and the upgrades add exactly on top.
  function runTotalHtml(res, model) {
    var t = readTotals(res);
    if (!t || t.total == null) return 'Total (retail): <b>—</b>';
    var up = model && model.pv && model.pv.applied ? model.pv.payload : null;
    var bits = 'Total (retail): <b>' + esc(up ? moneyCents(Math.round(Number(up.grandTotal) * 100)) : money0(t.total)) + '</b>';
    var extra = [];
    if (up) {
      extra.push('upgrades +' + moneyCents(up.upgradeCents));
      if (Number(up.tax) > 0) extra.push('tax ' + moneyCents(Math.round(Number(up.tax) * 100)));
      if (up.minJobApplied) extra.push('min charge applied');
    } else {
      if (t.subtotal != null) extra.push('subtotal ' + money0(t.subtotal));
      if (t.tax != null && t.tax > 0) extra.push('tax ' + money0(t.tax));
      if (t.minApplied) extra.push('min charge applied');
    }
    if (model && model.errors.length) extra.push('upgrades not added — see the Upgrades card');
    if (extra.length) bits += ' <span class="jtx-fs11px">(' + esc(extra.join(' · ')) + ')</span>';
    return bits;
  }

  // Debounced live re-resolve → running total + per-line retail chips only
  // (never a full repaint, so typing in qty/price inputs keeps focus).
  function scheduleResolve() {
    if (_resolveTimer) clearTimeout(_resolveTimer);
    _resolveTimer = setTimeout(refreshTotals, 250);
  }

  function refreshTotals() {
    _resolveTimer = null;
    if (!modalOpen() || state.step !== 'preconfirm') return;
    var res = resolveCurrent();
    state.lastResolved = res;
    // Offers and their footage follow the scope (a gutter-run qty edit moves
    // the guard's feet), so the card re-reads the same resolve as the total.
    var model = upgModel(res);
    paintUpgCard(model);
    if (state.upg.homeowner) paintHomeowner(model);
    var footTotal = document.getElementById('jtRunTotal');
    if (footTotal) footTotal.innerHTML = runTotalHtml(res, model);
    var map = lineMapFrom(res);
    var spans = document.querySelectorAll('[data-jt-lineref]');
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      var parts = String(sp.getAttribute('data-jt-lineref') || '').split('|');
      var tid = parts[0], idx = Number(parts[1]);
      var t = getTpl(tid);
      var it = t && t.items && t.items[idx];
      var ch = (state.choices[tid] || [])[idx] || {};
      if (!it || ch.included === false) { sp.textContent = '—'; continue; }
      var line = findLineForItem(it, ch, map);
      if (!line) { sp.textContent = res ? '—' : '…'; continue; }
      var q = lineQty(line);
      var unit = line.unit || itemUnit(it, ch);
      var rt = lineRetailTotal(line);
      sp.textContent = (q ? (q % 1 ? q.toFixed(1) : q) + (unit ? ' ' + unit : '') + ' · ' : '') +
        (rt != null ? money0(rt) : '—');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // UPGRADES & ADD-ONS — the Upgrades card and the Show homeowner page
  // ══════════════════════════════════════════════════════════════════════
  //
  // WHY (stage 2, 2026-09-25 — documentation/projects/
  // UPGRADES-ADDONS-DESIGN-2026-09-25.md). Tiers priced nothing on any Job
  // Template, and the real extras a homeowner can choose (leaf protection
  // first) had no priced home at all. Upgrades are their OWN feature, never
  // the Good/Better/Best buttons. The rules this UI keeps:
  //  - Nothing is pre-ticked. Leaf protection is one pick-one block that
  //    starts on "None".
  //  - At most two "Recommended" stars, and a star shows only with a reason
  //    typed for THIS house.
  //  - A row with no saved price says "Needs a price in Settings", can't be
  //    picked, and never reaches the homeowner page — no research-guess
  //    price ever reaches a homeowner. Neither does a row with no measured
  //    quantity (a template default is not this house's footage).
  //  - Every price shown is the one NBDUpgrades.price() will save, and every
  //    total comes from the SAME JobTemplates.applyUpgrades() payload
  //    createEstimate saves: card price = printed line = change in total.
  //  - No "free", "today only" or "limited time" copy, and the installer is
  //    named from tenant data or not at all.
  // Offers come from the resolved selection (upgModel), so they follow the
  // scope: edit the gutter run and the guard's footage follows unless the
  // rep typed one.

  var UPG_VISIBLE_SLOTS = 3;
  var UPG_MAX_STARS = 2;

  function upgLib() {
    var L = window.NBD_UPGRADE_LIBRARY;
    return (L && Array.isArray(L.items)) ? L : null;
  }

  // "$2,700" for whole dollars, "$407.22" otherwise — always exact cents.
  function moneyCents(c) {
    var n = Math.round(Number(c) || 0);
    return '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: n % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  }
  function unitWord(unit) { return unit === 'LF' ? 'ft' : (unit === 'EA' ? 'ea' : String(unit || '').toLowerCase()); }
  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  // Rep-typed quantities keyed by upgrade id, the shape NBDUpgrades reads.
  // One typed footage covers every option of a pick-one group.
  function upgQuantities() {
    var L = upgLib();
    var out = {};
    if (!L) return out;
    L.items.forEach(function (it) {
      var v = state.upg.qty[it.group ? 'group:' + it.group : it.id];
      if (v !== undefined && v !== null && String(v).trim() !== '') out[it.id] = String(v).trim();
    });
    return out;
  }

  function upgStarCount() { return Object.keys(state.upg.stars).length; }

  // The selection JobTemplates.applyUpgrades() takes. Only live offers can be
  // picked: a pick left over from another template set, or from before the
  // job went to insurance, is not sent (and not shown).
  function upgSelection(offers) {
    var u = state.upg;
    var avail = {};
    (offers || []).forEach(function (o) { if (o.state === 'available') avail[o.id] = true; });
    var picks = Object.keys(u.picks).filter(function (id) { return u.picks[id] && avail[id]; });
    var required = {};
    picks.forEach(function (id) { if (u.required[id]) required[id] = true; });
    var recommended = {};
    Object.keys(u.stars).forEach(function (id) {
      var why = String(u.stars[id] || '').trim();
      if (why && avail[id]) recommended[id] = why;
    });
    var declined = {};
    Object.keys(u.declined).forEach(function (id) { if (u.declined[id] && avail[id]) declined[id] = true; });
    return { picks: picks, quantities: upgQuantities(), required: required, recommended: recommended,
      declined: declined, shownToHomeowner: !!u.shown };
  }

  // Offers → card slots. A pick-one group is ONE slot. Slots the rep can
  // act on come first; "Needs a price" next; ineligible last. Offers hidden
  // by the scope (a guard already in the base, an item already in scope) are
  // not slots at all.
  function upgSlots(offers) {
    var slots = [];
    var groups = {};
    offers.forEach(function (o) {
      if (o.state === 'hidden') return;
      if (o.group) {
        var g = groups[o.group];
        if (!g) {
          g = groups[o.group] = { key: 'group:' + o.group, group: o.group, label: o.groupLabel || o.group, items: [] };
          slots.push(g);
        }
        g.items.push(o);
      } else {
        slots.push({ key: o.id, group: null, label: o.name, items: [o] });
      }
    });
    function rank(list) {
      if (list.some(function (o) { return o.state === 'available'; })) return 0;
      if (list.some(function (o) { return o.state === 'needs_price'; })) return 1;
      return 2;
    }
    function byRank(arr, rk) {
      return arr.map(function (x, i) { return { x: x, i: i }; })
        .sort(function (a, b) { return (rk(a.x) - rk(b.x)) || (a.i - b.i); })
        .map(function (y) { return y.x; });
    }
    slots.forEach(function (s) { s.items = byRank(s.items, function (o) { return rank([o]); }); });
    return byRank(slots, function (s) { return rank(s.items); });
  }

  /**
   * Everything the card, the homeowner page, the foot total and the preview
   * read, from ONE resolve: offers, slots, the selection, and the payload
   * createEstimate would save right now (pv). null when nothing is offered.
   */
  function upgModel(res) {
    var JT = engine();
    if (!JT || typeof JT.upgradeOffers !== 'function' || typeof JT.applyUpgrades !== 'function' || !res || !res.totals) return null;
    // "Insert into estimate" (scope mode) hands V2 catalog codes only —
    // insertIntoV2 has no upgrade path yet, so a card there would take
    // picks that silently never reach the estimate. No card, no picks.
    if (state.forScope) return null;
    var offers;
    try { offers = JT.upgradeOffers(res, { quantities: upgQuantities() }) || []; }
    catch (e) { console.error('[job-templates-ui] upgrade offers failed:', e); return null; }
    if (!offers.length) return null;
    var byId = {};
    offers.forEach(function (o) { byId[o.id] = o; });
    // Upgrades stay out of insurance claims entirely: every offer comes back
    // hidden with that one reason, and the card says so instead of vanishing.
    var blocked = (state.jobMode === 'insurance' && offers.every(function (o) { return o.state === 'hidden'; }))
      ? offers[0].reason : null;
    var sel = upgSelection(offers);
    var pv = null;
    var errors = [];
    try {
      var base = JT.buildEstimatePayload(res, { repairWarranty: state.repairWarranty === true });
      if (base) {
        var r = JT.applyUpgrades(base, res, sel);
        errors = r.errors || [];
        pv = { base: base, payload: errors.length ? base : r.payload, priced: r.priced,
          applied: !errors.length && !!(r.priced && r.priced.rows && r.priced.rows.length) };
      }
    } catch (e) {
      errors = [{ id: null, code: 'apply', message: String((e && e.message) || e) }];
    }
    var errById = {};
    var general = [];
    errors.forEach(function (e) {
      if (e && e.id && byId[e.id]) errById[e.id] = (errById[e.id] ? errById[e.id] + ' ' : '') + e.message;
      else if (e) general.push(e.message);
    });
    return { offers: offers, byId: byId, slots: upgSlots(offers), blocked: blocked, sel: sel, pv: pv,
      errors: errors, errById: errById, general: general,
      minJobCharge: res.minJobCharge != null ? res.minJobCharge : null };
  }

  // The pick-one group's "Make required" pick, or null.
  //
  // Review of #1763 (2026-09-25): a group holding a required pick IS base
  // scope — the job gets that guard — so none of the group's options is a
  // homeowner choice any more. That is the rule NBDUpgrades.offeredFor
  // already applies when a template's own scope carries a guard
  // (groupInScope). The homeowner page used to hide only the required item
  // and still offer its siblings; "Add" on one ran upgPickOn, which swapped
  // the rep's required guard OUT of the base scope, so the total moved by the
  // price DIFFERENCE, not by the price on the card, and the log lost the
  // rep's "required".
  function upgGroupRequiredId(group) {
    if (!group) return null;
    var L = upgLib();
    var u = state.upg;
    var items = L ? L.items : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].group === group && u.required[items[i].id] && u.picks[items[i].id]) return items[i].id;
    }
    return null;
  }

  // The required pick that holds an option in place, or null: the option
  // itself when it is required, else its group's required pick.
  function upgRequiredHolding(o) {
    if (!o) return null;
    if (state.upg.required[o.id] && state.upg.picks[o.id]) return o.id;
    return upgGroupRequiredId(o.group);
  }

  // What the homeowner page may show: a saved price, eligible, a measured
  // quantity, and not already in the base scope — neither moved there by
  // "Make required" itself nor in a pick-one group whose guard was.
  function upgShowable(o) {
    return !!o && o.state === 'available' && o.unitCents != null && o.qty != null && !upgRequiredHolding(o);
  }

  // Why "Show homeowner" has nothing to show.
  function upgNothingToShowText(m) {
    var heldOnly = m && m.offers.some(function (o) {
      return o.state === 'available' && o.unitCents != null && o.qty != null && !!upgRequiredHolding(o);
    });
    return heldOnly
      ? 'Nothing left to offer: the priced options are already in the price as required.'
      : 'Nothing priced and measured to show yet.';
  }

  // The rep's inline refusal for a row ('*' = the card's top line).
  function upgNoticeFor(id) {
    var n = state.upg.notice;
    return (n && n.id === id) ? n.msg : '';
  }

  // A job minimum absorbs part of an option's price (review of #1763,
  // 2026-09-25): the pricing core re-applies the floor to the WHOLE job
  // (NBDUpgrades.totalsWithUpgrades), so on a floored job an option first
  // fills the gap up to the minimum and the total rises by less than its
  // price. The card and the homeowner page say so instead of letting the
  // quoted price and the total silently disagree. '' when no floor applies.
  function upgMinJobText(m) {
    var base = m && m.pv && m.pv.base;
    if (!base || !base.minJobApplied) return '';
    var floor = Number(m.minJobCharge) > 0 ? Math.round(Number(m.minJobCharge) * 100) : null;
    var at = floor != null ? moneyCents(floor) : moneyCents(Math.round(Number(base.grandTotal) * 100));
    return 'This job is priced at its ' + at + ' minimum charge. An option counts toward that minimum first, ' +
      'so the total goes up by less than the option’s price until the job passes ' + at + '.';
  }

  function upgLineCents(o) {
    return (o && o.qty != null && o.unitCents != null) ? o.qty * o.unitCents : null;
  }

  // "150 ft × $18 = $2,700" — the same integers NBDUpgrades.price() saves.
  function upgPriceText(o) {
    if (!o) return '';
    if (o.state === 'needs_price') return 'Needs a price in Settings';
    if (o.state === 'ineligible') return o.reason || 'Not available on this job';
    if (o.unitCents == null) return '';
    var per = moneyCents(o.unitCents);
    var u = unitWord(o.unit);
    if (o.qty == null) return per + ' per ' + u + ' — type the ' + (o.unit === 'LF' ? 'footage' : 'quantity') + ' to price it';
    return o.qty + ' ' + u + ' × ' + per + ' = ' + moneyCents(upgLineCents(o));
  }

  function upgSummary(m) {
    var n = m.sel.picks.length;
    if (m.errors.length) return '· ' + n + ' picked · fix ' + (m.errors.length === 1 ? 'the upgrade' : m.errors.length + ' upgrades') + ' below';
    if (!n) return '· none picked';
    var cents = (m.pv && m.pv.applied) ? m.pv.payload.upgradeCents : 0;
    return '· ' + n + ' picked · +' + moneyCents(cents);
  }

  function upgQtyHint(o) {
    if (!o) return '';
    if (o.qtySource === 'rep') return 'Your measurement.';
    if (o.qty != null) return 'From the gutter footage on this estimate — type to change.';
    if (o.suggestedQty != null) return 'Measure the gutters: the template assumes about ' + o.suggestedQty + ' ' + unitWord(o.unit) + ', which is not this house.';
    return 'Type the measured ' + (o.unit === 'LF' ? 'feet' : 'quantity') + '.';
  }

  function upgQtyField(key, o, label) {
    var typed = state.upg.qty[key];
    var val = (typed !== undefined && typed !== null) ? typed : (o && o.qty != null ? o.qty : '');
    return '<label class="jt-upg-qty">' + esc(label) +
      ' <input type="number" inputmode="decimal" min="0" step="any" class="jt-in" data-jt-action="upg-qty" data-id="' + esc(key) + '" value="' + esc(val) + '"> ' +
      esc(unitWord(o && o.unit)) + '</label>' +
      '<span class="jt-upg-hint" data-upg-hint="' + esc(key) + '">' + esc(upgQtyHint(o)) + '</span>';
  }

  function upgOptionHtml(o, m, inGroup) {
    var avail = o.state === 'available';
    var picked = avail && !!state.upg.picks[o.id];
    var req = picked && !!state.upg.required[o.id];
    var starred = hasOwn(state.upg.stars, o.id);
    var why = starred ? String(state.upg.stars[o.id] || '') : '';
    var declined = !picked && !!state.upg.declined[o.id];
    var badges = (req ? '<span class="jt-upg-badge req">Required</span>' : '') +
      (starred && why.trim() ? '<span class="jt-upg-badge star">★ Recommended</span>' : '') +
      (declined ? '<span class="jt-upg-badge no">Homeowner: no thanks</span>' : '');
    var info =
      '<span class="jt-upg-nm">' + esc(o.name) + badges + '</span>' +
      (o.benefit ? '<span class="jt-upg-ben">' + esc(o.benefit) + '</span>' : '') +
      // A warranty line only where the manufacturer really warrants it (the
      // library carries null otherwise), and what it does NOT cover beside it.
      (avail && o.warrantyLine ? '<span class="jt-upg-war">' + esc(o.warrantyLine) + '</span>' : '') +
      (avail && o.notCovered ? '<span class="jt-upg-nc">' + esc(o.notCovered) + '</span>' : '') +
      (avail && o.installerLine ? '<span class="jt-upg-inst">' + esc(o.installerLine) + '</span>' : '') +
      (avail && o.check ? '<span class="jt-upg-nc">' + esc(o.check) + '</span>' : '') +
      '<span class="jt-upg-px" data-upg-px="' + esc(o.id) + '">' + esc(upgPriceText(o)) + '</span>';
    var pick = '<button type="button" class="jt-upg-pick" data-jt-action="upg-pick" data-id="' + esc(o.id) + '" aria-pressed="' + (picked ? 'true' : 'false') + '"' +
      (avail ? '' : ' disabled aria-disabled="true"') + '>' +
      '<span class="jt-upg-ind' + (inGroup ? ' r' : '') + '" aria-hidden="true">' + (picked ? '✓' : '') + '</span>' +
      '<span class="jt-upg-main">' + info + '</span></button>';
    if (!avail) return '<div class="jt-upg-opt jt-upg-np" data-upg-row="' + esc(o.id) + '">' + pick + '</div>';
    var tools =
      (inGroup ? '' : upgQtyField(o.id, o, 'Qty')) +
      '<button type="button" class="jt-btn jt-upg-tool" data-jt-action="upg-star" data-id="' + esc(o.id) + '" aria-pressed="' + (starred ? 'true' : 'false') + '">' +
        (starred ? '★ Recommended' : '☆ Recommend') + '</button>' +
      '<button type="button" class="jt-btn jt-upg-tool" data-jt-action="upg-require" data-id="' + esc(o.id) + '" aria-pressed="' + (req ? 'true' : 'false') + '">' +
        (req ? '✓ Required' : 'Make required') + '</button>';
    var whyField = starred
      ? '<label class="jt-upg-why">Why this house needs it — the star shows only with a reason' +
        '<input type="text" class="jt-in" maxlength="140" enterkeyhint="done" data-jt-action="upg-reason" data-id="' + esc(o.id) + '" value="' + esc(why) + '"></label>'
      : '';
    return '<div class="jt-upg-opt' + (picked ? ' on' : '') + '" data-upg-row="' + esc(o.id) + '">' + pick +
      '<div class="jt-upg-tools">' + tools + '</div>' + whyField +
      '<div class="jt-upg-err" data-upg-err="' + esc(o.id) + '" role="alert">' + esc(m.errById[o.id] || upgNoticeFor(o.id)) + '</div>' +
      '</div>';
  }

  // The ★ Recommended badge follows the reason as it is typed (review of
  // #1763, 2026-09-25: it appeared only on the next repaint, so the rep saw
  // a pressed "★ Recommended" tool and no badge). Patched in place — a
  // repaint would take the phone's keyboard away mid-word.
  function upgPatchStarBadge(id) {
    var host = document.getElementById('jtUpgCard');
    var nm = host && typeof host.querySelector === 'function' ? host.querySelector('[data-upg-row="' + id + '"] .jt-upg-nm') : null;
    if (!nm) return;
    var want = hasOwn(state.upg.stars, id) && !!String(state.upg.stars[id] || '').trim();
    var badge = nm.querySelector('.jt-upg-badge.star');
    if (want && !badge) {
      badge = document.createElement('span');
      badge.className = 'jt-upg-badge star';
      badge.textContent = '★ Recommended';
      var after = nm.querySelector('.jt-upg-badge.no');
      if (after) nm.insertBefore(badge, after); else nm.appendChild(badge);
    } else if (!want && badge && badge.parentNode) {
      badge.parentNode.removeChild(badge);
    }
  }

  function upgSlotHtml(s, m) {
    if (!s.group) return upgOptionHtml(s.items[0], m, false);
    var live = s.items.filter(function (o) { return o.state === 'available'; });
    var noneOn = !s.items.some(function (o) { return o.state === 'available' && state.upg.picks[o.id]; });
    var footage = live.length && live[0].unit ? upgQtyField(s.key, live[0], live[0].unit === 'LF' ? 'Footage' : 'Qty') : '';
    // A required pick makes the whole group base scope (upgGroupRequiredId):
    // say so here, since the homeowner page will not show this group at all.
    var reqId = upgGroupRequiredId(s.group);
    var reqItem = reqId ? s.items.filter(function (o) { return o.id === reqId; })[0] : null;
    var reqNote = reqItem
      ? '<div class="jt-upg-note" data-upg-grp-req="' + esc(s.group) + '">' + esc(reqItem.name) +
        ' is required, so this job’s ' + esc(String(s.label).toLowerCase()) + ' is in the price and the homeowner is not offered another option. ' +
        'To change it, tap “✓ Required” to release it first.</div>'
      : '';
    return '<div class="jt-upg-grp" data-upg-slot="' + esc(s.key) + '">' +
      '<div class="jt-upg-grp-hd"><span class="jt-upg-grp-t">' + esc(s.label) + '<small>pick one</small></span>' + footage + '</div>' +
      reqNote +
      (live.length
        ? '<button type="button" class="jt-upg-none' + (noneOn ? ' on' : '') + '" data-jt-action="upg-pick-none" data-id="' + esc(s.group) + '" aria-pressed="' + (noneOn ? 'true' : 'false') + '">' +
          '<span class="jt-upg-ind r" aria-hidden="true">' + (noneOn ? '✓' : '') + '</span>None</button>'
        : '') +
      s.items.map(function (o) { return upgOptionHtml(o, m, true); }).join('') +
      '</div>';
  }

  function upgCardHtml(m) {
    if (!m || (!m.blocked && !m.slots.length)) return '';
    var canShow = !m.blocked && m.offers.some(upgShowable);
    var hdr = '<div class="jt-upg-hdr">' +
      '<span class="jt-upg-t">Upgrades</span>' +
      '<span class="jt-upg-sum" data-upg-sum>' + esc(m.blocked ? '· not on insurance jobs' : upgSummary(m)) + '</span>' +
      (m.blocked ? '' : '<button type="button" class="jt-btn jt-btn-primary jt-upg-show" data-jt-action="upg-show-homeowner"' +
        (canShow ? '' : ' disabled title="' + esc(upgNothingToShowText(m)) + '"') + '>Show homeowner</button>') +
      '</div>';
    if (m.blocked) {
      return '<div class="jt-upg" data-upg-card>' + hdr + '<div class="jt-upg-body"><div class="jt-upg-note">' + esc(m.blocked) + '</div></div></div>';
    }
    var vis = m.slots.slice(0, UPG_VISIBLE_SLOTS);
    var more = m.slots.slice(UPG_VISIBLE_SLOTS);
    var minTxt = upgMinJobText(m);
    var body = (m.general.length ? '<div class="jt-upg-gerr" role="alert">' + esc(m.general.join(' ')) + '</div>' : '') +
      '<div class="jt-upg-gerr" data-upg-err="*" role="alert">' + esc(upgNoticeFor('*')) + '</div>' +
      (minTxt ? '<div class="jt-upg-note" data-upg-min>' + esc(minTxt) + '</div>' : '') +
      vis.map(function (s) { return upgSlotHtml(s, m); }).join('');
    if (more.length) {
      body += state.upg.more
        ? more.map(function (s) { return upgSlotHtml(s, m); }).join('') +
          '<button type="button" class="jt-btn jt-upg-more" data-jt-action="upg-more">Show fewer</button>'
        : '<button type="button" class="jt-btn jt-upg-more" data-jt-action="upg-more">More (' + more.length + ')</button>';
    }
    return '<div class="jt-upg" data-upg-card>' + hdr + '<div class="jt-upg-body">' + body + '</div></div>';
  }

  // Full repaint, except while the rep is typing in one of the card's boxes:
  // then only the numbers change, so the box keeps focus (and the phone
  // keeps its keyboard up).
  function paintUpgCard(m) {
    var host = document.getElementById('jtUpgCard');
    if (!host) return;
    var act = document.activeElement;
    var typing = !!(act && act.tagName === 'INPUT' && typeof host.contains === 'function' && host.contains(act));
    if (typing && m && !m.blocked && host.querySelector('[data-upg-card]')) { patchUpgCard(host, m); return; }
    host.innerHTML = upgCardHtml(m);
  }

  function patchUpgCard(host, m) {
    function setText(sel, txt) { var e = host.querySelector(sel); if (e) e.textContent = txt; }
    setText('[data-upg-sum]', upgSummary(m));
    m.offers.forEach(function (o) {
      setText('[data-upg-px="' + o.id + '"]', upgPriceText(o));
      setText('[data-upg-err="' + o.id + '"]', m.errById[o.id] || upgNoticeFor(o.id));
    });
    setText('[data-upg-err="*"]', upgNoticeFor('*'));
    m.slots.forEach(function (s) {
      var o = s.items.filter(function (x) { return x.state === 'available'; })[0];
      if (o) setText('[data-upg-hint="' + s.key + '"]', upgQtyHint(o));
    });
    var show = host.querySelector('[data-jt-action="upg-show-homeowner"]');
    if (show) show.disabled = !m.offers.some(upgShowable);
  }

  // ── Show homeowner ────────────────────────────────────────────────────

  // The base scope, by name — what the price already covers — plus anything
  // the rep moved into it with "Make required".
  function upgIncludedNames(m) {
    var seen = {};
    var out = [];
    var rows = (m.pv && m.pv.payload && m.pv.payload.rows) || [];
    rows.forEach(function (r) {
      if (!r) return;
      var base = r.upgrade !== true;
      if (!(base ? Number(r.retailTotal != null ? r.retailTotal : r.total) > 0 : r.upgradeRequired === true)) return;
      var nm = String(r.desc || '').trim();
      if (!nm || seen[nm]) return;
      seen[nm] = true;
      out.push(nm);
    });
    return out;
  }

  function homeownerHtml(m) {
    var groupsHtml = '';
    var singles = '';
    m.slots.forEach(function (s) {
      var show = s.items.filter(upgShowable);
      if (!show.length) return;
      var cards = show.map(function (o) {
        var added = !!state.upg.picks[o.id];
        var declined = !added && !!state.upg.declined[o.id];
        var why = m.sel.recommended[o.id];
        return '<article class="jt-ho-card' + (added ? ' added' : '') + '" data-ho-id="' + esc(o.id) + '">' +
          (why ? '<div class="jt-ho-rec">★ Recommended for your home: ' + esc(why) + '</div>' : '') +
          '<h4>' + esc(o.name) + '</h4>' +
          (o.benefit ? '<p>' + esc(o.benefit) + '</p>' : '') +
          (o.warrantyLine ? '<p class="war">' + esc(o.warrantyLine) + '</p>' : '') +
          (o.notCovered ? '<p>' + esc(o.notCovered) + '</p>' : '') +
          (o.installerLine ? '<p>' + esc(o.installerLine) + '</p>' : '') +
          '<div class="jt-ho-px" data-ho-px="' + esc(o.id) + '">' + esc(o.qty + ' ' + unitWord(o.unit) + ' × ' + moneyCents(o.unitCents) + ' = ') +
            '<b>' + esc(moneyCents(upgLineCents(o))) + '</b></div>' +
          '<div class="jt-ho-btns">' +
            '<button type="button" class="jt-ho-btn add" data-jt-action="upg-ho-add" data-id="' + esc(o.id) + '" aria-pressed="' + (added ? 'true' : 'false') + '">' + (added ? '✓ Added' : 'Add') + '</button>' +
            '<button type="button" class="jt-ho-btn no" data-jt-action="upg-ho-no" data-id="' + esc(o.id) + '" aria-pressed="' + (declined ? 'true' : 'false') + '">No thanks</button>' +
          '</div>' +
          '</article>';
      }).join('');
      if (s.group) {
        groupsHtml += '<section class="jt-ho-grp"><h3>' + esc(s.label) + '<small>choose one, or none</small></h3>' + cards + '</section>';
      } else {
        singles += cards;
      }
    });
    if (singles) groupsHtml += '<section class="jt-ho-grp"><h3>More options</h3>' + singles + '</section>';
    var incl = upgIncludedNames(m);
    var minTxt = upgMinJobText(m);
    var pay = m.pv && m.pv.payload;
    var totalC = pay ? Math.round(Number(pay.grandTotal) * 100) : null;
    var taxC = pay ? Math.round(Number(pay.tax) * 100) : 0;
    return '<div class="jt-ho-hdr">' +
        '<div class="jt-ho-co">' + esc(companyName()) + '</div>' +
        '<h2 tabindex="-1">Options for your home</h2>' +
        '<p>Your price already covers everything under “Already included”. Add an option only if you want it.</p>' +
      '</div>' +
      '<div class="jt-ho-body"><div class="jt-ho-col">' +
        (minTxt ? '<p class="jt-ho-min" data-ho-min>' + esc(minTxt) + '</p>' : '') +
        (incl.length ? '<details class="jt-ho-incl"><summary>Already included (' + incl.length + ')</summary><ul>' +
          incl.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></details>' : '') +
        groupsHtml +
      '</div></div>' +
      '<div class="jt-ho-foot">' +
        '<div class="jt-ho-tot" data-ho-total>Total with your choices<b>' + esc(totalC != null ? moneyCents(totalC) : '—') + '</b>' +
          (taxC > 0 ? 'includes ' + esc(moneyCents(taxC)) + ' sales tax' : '') + '</div>' +
        '<button type="button" class="jt-ho-done" data-jt-action="upg-ho-done">Done — hand back</button>' +
      '</div>';
  }

  // The Show homeowner page: its own full-screen layer above the build
  // screen, so handing the phone over hides every rep control. Created on
  // first use (not in ensureModal, which returns early once #jtModal exists).
  function homeownerEl(create) {
    var el = document.getElementById('jtHomeowner');
    if (el || !create) return el;
    ensureStyles();
    el = document.createElement('div');
    el.id = 'jtHomeowner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Options for your home');
    document.body.appendChild(el);
    return el;
  }

  function paintHomeowner(m) {
    var want = !!(state.upg.homeowner && m && !m.blocked);
    var el = homeownerEl(want);
    if (!el) return;
    if (!want) {
      el.classList.remove('open');
      el.innerHTML = '';
      return;
    }
    // Keep the homeowner's place: Add / No thanks repaint the page.
    var oldBody = el.querySelector && el.querySelector('.jt-ho-body');
    var top = oldBody ? oldBody.scrollTop : 0;
    el.innerHTML = homeownerHtml(m);
    el.classList.add('open');
    var nb = el.querySelector && el.querySelector('.jt-ho-body');
    if (nb) nb.scrollTop = top;
  }

  // ── Actions ───────────────────────────────────────────────────────────

  function upgPickOn(o) {
    if (!o || o.state !== 'available') return;
    var u = state.upg;
    if (o.group) {
      // Pick one: choosing an option replaces the group's other pick.
      var L = upgLib();
      (L ? L.items : []).forEach(function (it) {
        if (it.group === o.group && it.id !== o.id) { delete u.picks[it.id]; delete u.required[it.id]; }
      });
    }
    u.picks[o.id] = true;
    delete u.declined[o.id];
  }
  function upgPickOff(id) {
    delete state.upg.picks[id];
    delete state.upg.required[id];
  }

  function upgRepaint() {
    var res = state.lastResolved || resolveCurrent();
    state.lastResolved = res;
    var m = upgModel(res);
    paintUpgCard(m);
    paintHomeowner(m);
    var footTotal = document.getElementById('jtRunTotal');
    if (footTotal && state.step === 'preconfirm') footTotal.innerHTML = runTotalHtml(res, m);
    return m;
  }

  // A fresh resolve, not lastResolved: a tap can land inside the 250ms
  // debounce of a line-qty edit, and the offer's footage must be today's.
  function upgCurrentModel() {
    if (_resolveTimer) { clearTimeout(_resolveTimer); _resolveTimer = null; }
    var res = resolveCurrent();
    state.lastResolved = res;
    return upgModel(res);
  }

  // The refusal when a tap would drop a required pick (review of #1763,
  // 2026-09-25). "Make required" is the rep's call that the job needs this
  // item; only its own "✓ Required" button releases it. A sibling tap or
  // None used to swap it out silently.
  function upgRequiredNotice(atId, reqId, m) {
    var req = m && m.byId[reqId];
    var name = req ? req.name : 'This item';
    return { id: atId, msg: (atId === reqId ? 'Required on this job.' : name + ' is required on this job.') +
      ' Tap its “✓ Required” to release it first.' };
  }

  function onUpgradeAction(action, id) {
    var m = upgCurrentModel();
    if (!m) return;
    var o = id ? m.byId[id] : null;
    var u = state.upg;
    // An inline refusal for this tap; the next upgrade tap clears it.
    var notice = null;
    var reqId;
    switch (action) {
      case 'upg-pick':
        if (!o || o.state !== 'available') return;
        reqId = upgRequiredHolding(o);
        if (reqId) { notice = upgRequiredNotice(id, reqId, m); break; }
        if (u.picks[id]) upgPickOff(id); else upgPickOn(o);
        break;
      case 'upg-pick-none':
        reqId = upgGroupRequiredId(id);
        if (reqId) { notice = upgRequiredNotice(reqId, reqId, m); break; }
        m.offers.forEach(function (x) { if (x.group === id) upgPickOff(x.id); });
        break;
      case 'upg-star':
        if (!o || o.state !== 'available') return;
        if (hasOwn(u.stars, id)) { delete u.stars[id]; break; }
        if (upgStarCount() >= UPG_MAX_STARS) {
          notice = { id: id, msg: 'Up to ' + UPG_MAX_STARS + ' recommendations. Unstar one first.' };
          break;
        }
        u.stars[id] = '';
        break;
      case 'upg-require':
        if (!o || o.state !== 'available') return;
        if (u.required[id]) { delete u.required[id]; break; }
        // "Make required" on a sibling of the group's required pick ran
        // upgPickOn, which clears the group's other picks AND their required
        // flags — the rep's guard was swapped out and the total moved with no
        // word (second review of #1763, 2026-09-25). Refused like a row tap.
        reqId = upgGroupRequiredId(o.group);
        if (reqId && reqId !== id) { notice = upgRequiredNotice(id, reqId, m); break; }
        upgPickOn(o);
        u.required[id] = true;
        break;
      case 'upg-more':
        u.more = !u.more;
        break;
      case 'upg-show-homeowner':
        if (m.errors.length) { notice = { id: '*', msg: 'Fix the upgrade first: ' + m.errors[0].message }; break; }
        if (!m.offers.some(upgShowable)) { notice = { id: '*', msg: upgNothingToShowText(m) }; break; }
        u.homeowner = true;
        u.shown = true;
        break;
      // The homeowner can only act on what the page offers (upgShowable):
      // a required item, or any option of a group holding one, is base
      // scope and never replaced or declined from here.
      case 'upg-ho-add':
        if (!upgShowable(o)) return;
        upgPickOn(o);
        break;
      case 'upg-ho-no':
        if (!upgShowable(o)) return;
        upgPickOff(id);
        u.declined[id] = true;
        break;
      case 'upg-ho-done':
        u.homeowner = false;
        break;
      default:
        return;
    }
    u.notice = notice;
    upgRepaint();
    // Focus follows the hand-over: into the homeowner page when it opens
    // (a screen reader or keyboard starts on its title, not on the rep
    // controls underneath), back to "Show homeowner" when it is handed back.
    try {
      var focusEl = null;
      if (action === 'upg-show-homeowner') {
        var ho = document.getElementById('jtHomeowner');
        focusEl = ho && ho.querySelector && ho.querySelector('.jt-ho-hdr h2');
      } else if (action === 'upg-ho-done') {
        var cardEl = document.getElementById('jtUpgCard');
        focusEl = cardEl && cardEl.querySelector && cardEl.querySelector('[data-jt-action="upg-show-homeowner"]');
      }
      if (focusEl && typeof focusEl.focus === 'function') focusEl.focus({ preventScroll: action === 'upg-ho-done' ? false : true });
    } catch (e) { /* focus is a courtesy, never a blocker */ }
  }

  // ══════════════════════════════════════════════════════════════════════
  // PREVIEW step (customer-facing — RETAIL ONLY)
  // ══════════════════════════════════════════════════════════════════════

  // Active-tenant brand — the same source every other brand-bearing surface
  // reads (company-profile.js window._brand(): NBD defaults deep-merged with
  // this tenant's companyProfile.brand). Never null once company-profile.js
  // is loaded; falls back to _companyProfile.brand, then null.
  function brandCtx() {
    try {
      if (typeof window._brand === 'function') {
        var b = window._brand();
        if (b && typeof b === 'object') return b;
      }
    } catch (e) { /* fall through */ }
    var cp = window._companyProfile;
    return (cp && cp.brand && typeof cp.brand === 'object') ? cp.brand : null;
  }

  // Company display name — the tenant's legal name (e.g. "No Big Deal Home
  // Solutions"), NOT the old hardcoded "No Big Deal Roofing". Legacy
  // _companyProfile.companyName/name still win if a page set them.
  function companyName() {
    var b = brandCtx();
    if (b && (b.legalName || b.displayName)) return b.legalName || b.displayName;
    var cp = window._companyProfile;
    return (cp && (cp.companyName || cp.name)) || 'No Big Deal Home Solutions';
  }

  // Logo src for the proposal letterhead. The tenant's own brand.logoUrl
  // wins; only the NBD tenant falls back to the NBD asset — a non-NBD tenant
  // with no logo gets none, never NBD's (cross-tenant leak guard, mirrors
  // document-generator.js _logoSrc / review M1).
  function brandLogo() {
    var b = brandCtx();
    if (b && b.logoUrl) return String(b.logoUrl);
    var isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    if (!isNbd) return '';
    if (typeof window.NBD_LOGO_DATA_URI === 'string' && window.NBD_LOGO_DATA_URI) return window.NBD_LOGO_DATA_URI;
    return 'https://nobigdealwithjoedeal.com/assets/images/nbd-logo.png';
  }

  // Brand colors for the customer-facing proposal — primary (navy) titles the
  // company, accent (orange) tags the proposal kind. Falls back to the
  // canonical NBD palette so the paper is never unstyled.
  function brandColors() {
    var b = brandCtx();
    var c = (b && b.colors && typeof b.colors === 'object') ? b.colors : {};
    return {
      primary: c.primary || '#1A3057',
      accent:  c.accent  || '#BD5728',
      ink:     c.ink     || '#14181F'
    };
  }

  function defaultEstimateName() {
    var first = getTpl(state.selected[0]);
    var base = first ? first.name : 'Job Template Estimate';
    var extra = state.selected.length > 1 ? ' + ' + (state.selected.length - 1) + ' more' : '';
    var d = new Date();
    return base + extra + ' — ' + (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  // Total = Subtotal + Tax rounded to the nearest $25 (either way), then
  // lifted to the shop minimum. Print the difference as its own row so the
  // proposal's rows foot to its Total.
  function totalsAdjustmentRow(totals) {
    if (!totals || totals.total == null || totals.subtotal == null) return '';
    // In cents from the printed (cent-rounded) figures, so the rows foot as shown.
    var adj = (Math.round((totals.total) * 100) - Math.round((totals.subtotal) * 100) - Math.round((totals.tax || 0) * 100)) / 100;
    if (!adj) return '';
    return '<div class="r"><span>' + ((totals.minApplied && adj > 0) ? 'Minimum job charge adjustment' : 'Rounding') +
      '</span><span>' + (adj < 0 ? '−' : '') + esc(money(Math.abs(adj))) + '</span></div>';
  }

  function renderPreview(res, model) {
    var totals = readTotals(res);
    var lines = readLines(res).filter(function (l) {
      // Customer preview: only lines that actually bill. Hides zero-qty
      // formula lines (incl. the self-selecting dumpster trio).
      return lineQty(l) > 0 && (lineRetailTotal(l) || 0) > 0;
    });

    // Upgrades (stage 2, 2026-09-25): the rows and totals of the payload
    // Create estimate will save (upgModel → JobTemplates.applyUpgrades), so
    // this paper shows exactly the saved line and total. Face value: the
    // O&P row above them is untouched.
    var upPay = model && model.pv && model.pv.applied ? model.pv.payload : null;
    if (upPay) {
      upPay.rows.forEach(function (r) {
        if (!r || r.upgrade !== true) return;
        lines.push({ name: r.desc, quantity: r.quantity, unit: r.unit, category: r.category || 'Upgrades',
          retailPerUnit: r.unitPrice, retailTotal: r.retailTotal, upgrade: true });
      });
      totals = Object.assign({}, totals || {}, {
        subtotal: Number(upPay.subtotal), tax: Number(upPay.tax), total: Number(upPay.grandTotal),
        minApplied: !!upPay.minJobApplied
      });
    }

    // Roof Care Plan member — 10% off repairs (2026-10-05): the SAME
    // applyMemberDiscount Create estimate runs, on the same payload (upgrades
    // included), so this paper shows the saved line and total.
    var mdPay = memberDiscountPreview(res, upPay);
    if (mdPay && mdPay.memberDiscount) {
      var mdc = mdPay.memberDiscount;
      lines.push({ name: mdc.label, quantity: 1, unit: 'ea', category: 'Discounts',
        retailPerUnit: -mdc.preTaxCents / 100, retailTotal: -mdc.preTaxCents / 100, memberDiscount: true });
      totals = Object.assign({}, totals || {}, {
        subtotal: Number(mdPay.subtotal), tax: Number(mdPay.tax), total: Number(mdPay.grandTotal)
      });
    }

    // Scope descriptions — template.description is the customer-facing text
    // (scopeNotes is rep-internal and deliberately NOT shown here).
    var scopes = state.selected.map(function (tid) {
      var t = getTpl(tid);
      if (!t) return '';
      return '<div class="jt-prop-scope"><h3>' + esc(t.name) + '</h3>' +
        (t.description ? '<p>' + esc(t.description) + '</p>' : '') + '</div>';
    }).join('');

    // Group lines by resolved category when present, else one section.
    var groups = {};
    var order = [];
    lines.forEach(function (l) {
      var g = String(l.category || 'Scope of Work');
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(l);
    });

    var rowsHtml = '';
    order.forEach(function (g) {
      if (order.length > 1) {
        rowsHtml += '<tr class="jt-prop-grp"><td colspan="5">' + esc(g.replace(/_/g, ' ')) + '</td></tr>';
      }
      groups[g].forEach(function (l) {
        var q = lineQty(l);
        // An unpriced line resolves at 0, and money(0) is "$0.00" — a number
        // the rep would read as "this is free". Render '—' regardless of the
        // numeric, exactly as a missing value is rendered.
        var unset = isCostUnset(l);
        var per = unset ? null : lineRetailPerUnit(l);
        var rt = unset ? null : lineRetailTotal(l);
        var nm = l.name || l.desc || l.description || l.code || 'Item';
        rowsHtml += '<tr>' +
          '<td>' + esc(nm) + (unset ? ' <span class="jt-chip jt-chip-warn">Cost not set</span>' : '') + '</td>' +
          '<td class="num">' + esc(q % 1 ? q.toFixed(1) : q) + '</td>' +
          '<td>' + esc(l.unit || '') + '</td>' +
          '<td class="num">' + (per != null ? esc(signedMoney(per)) : '—') + '</td>' +
          '<td class="num">' + (rt != null ? esc(signedMoney(rt)) : '—') + '</td>' +
          '</tr>';
      });
    });

    var totsHtml = '';
    if (totals) {
      // House pattern (customer-estimate-rows.js): retail lines sum to
      // retailBeforeOHP — the O&P bridge row is mandatory so the printed
      // lines foot to the Subtotal, matching the portal/invoice rendering.
      if (totals.ohp > 0) {
        totsHtml += '<div class="r"><span>Overhead &amp; Profit' +
          (totals.ohpPct ? ' (' + esc(totals.ohpPct) + '%)' : '') + '</span><span>' +
          esc(money(totals.ohp)) + '</span></div>';
      }
      if (totals.subtotal != null) totsHtml += '<div class="r"><span>Subtotal</span><span>' + esc(money(totals.subtotal)) + '</span></div>';
      if (totals.tax != null && totals.tax > 0) totsHtml += '<div class="r"><span>Tax</span><span>' + esc(money(totals.tax)) + '</span></div>';
      totsHtml += totalsAdjustmentRow(totals);
      totsHtml += '<div class="r g"><span>Total</span><span>' + esc(totals.total != null ? money(totals.total) : '—') + '</span></div>';
    } else {
      totsHtml = '<div class="r g"><span>Total</span><span>—</span></div>';
    }

    // The total above EXCLUDES every unpriced line (they resolve at 0). Say so
    // where the number is, not somewhere else on the page — a rep who reads
    // this total as complete will quote low. Cost data is tenant-owned
    // (2026-08-18); until this company's book is filled in, the per-line
    // $/unit field is how these get priced.
    var nUnset = lines.filter(isCostUnset).length;
    if (nUnset > 0) {
      totsHtml += '<div class="jt-unpriced-note">⚠ ' + nUnset + ' of ' + lines.length +
        ' item' + (nUnset === 1 ? '' : 's') + ' ha' + (nUnset === 1 ? 's' : 've') +
        ' no cost set and ' + (nUnset === 1 ? 'is' : 'are') +
        ' excluded from this total — type a $ / unit on each, or fill in your company\'s cost book.</div>';
    }

    var d = new Date();
    var dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    // '' for an unticked repair or an inspection — then no warranty line.
    var warranty = warrantySentence(res);

    // Lead-context flow: openPicker/openPreconfirm({leadId}) staged the
    // lead — _jtWireLeadPicker() (called from paintModal right after this
    // HTML is inserted) preselects it. #jtLeadSel is the load-bearing
    // contract: doCreateEstimate() reads its .value unchanged regardless
    // of whether the lead came from search, quick-create, or pre-staging.
    var leadField =
      '<div class="fld"><span class="jt-mini-lbl">Apply to customer / lead (optional)</span>' +
      '<input type="hidden" id="jtLeadSel" value="' + (state.leadId ? esc(state.leadId) : '') + '">' +
      '<div id="jtLeadPickerRoot"></div>' +
      '</div>';

    var colors = brandColors();
    var logo = brandLogo();
    var coName = companyName();
    var kind = (state.jobMode === 'insurance' ? 'Insurance Proposal' : 'Project Proposal');
    // Letterhead. When a logo is present it is the hero brand mark and the
    // legal name renders as a COMPACT line beneath it (a proposal becomes a
    // contract — the legal entity name must still appear, but not as a second
    // giant wordmark competing with the logo). With no logo (e.g. a white-label
    // tenant that hasn't uploaded one) the legal name IS the masthead.
    // No inline onerror — CSP sets script-src-attr 'none'; the NBD logo src is
    // same-origin (docs/assets/images/nbd-logo.png) so it resolves under img-src 'self'.
    var brandBlock = logo
      ? '<img src="' + esc(logo) + '" alt="' + esc(coName) + '" ' +
          'style="max-height:52px;max-width:240px;display:block;object-fit:contain;">' +
        '<div class="jt-prop-co-sm" style="color:' + esc(colors.primary) + ';">' + esc(coName) + '</div>'
      : '<div class="jt-prop-co" style="color:' + esc(colors.primary) + ';">' + esc(coName) + '</div>';

    return '<div class="jt-prop">' +
      '<div class="jtx-dflex-jcspacebet-gap14px">' +
        '<div>' +
          brandBlock +
          '<div class="jt-prop-kind" style="color:' + esc(colors.accent) + ';">' + kind + '</div>' +
        '</div>' +
        '<div class="jt-prop-meta jtx-taright">' +
          esc(dateStr) +
          (tiersApplyNow() ? '<br>' + esc(TIER_LABELS[state.tier] || state.tier) + ' tier' : '') +
        '</div>' +
      '</div>' +
      '<hr>' +
      scopes +
      '<table><thead><tr>' +
        '<th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit Price</th><th class="num">Total</th>' +
      '</tr></thead><tbody>' +
        (rowsHtml || '<tr><td colspan="5" class="jtx-c94a3b8">No billable line items — adjust quantities or measurements.</td></tr>') +
      '</tbody></table>' +
      '<div class="jt-prop-tots">' + totsHtml + '</div>' +
      (warranty ? '<div class="jt-prop-warranty"><b>Workmanship warranty:</b> ' + esc(warranty) + '</div>' : '') +
      '<div class="jt-prop-note">Prepared with ' + esc(companyName()) + '. Pricing reflects the selected scope and is valid for 30 days. Final invoice follows the signed agreement.</div>' +
      '</div>' +
      // Create bar (rep-facing, below the paper)
      '<div class="jt-createbar">' +
        '<div class="fld"><span class="jt-mini-lbl">Estimate name</span>' +
          '<input type="text" class="jt-in jtx-wd100" id="jtEstName" value="' + esc(defaultEstimateName()) + '"></div>' +
        leadField +
        '<button type="button" class="jt-btn jt-btn-primary" data-jt-action="create-estimate"' + (state.creating ? ' disabled' : '') + '>' +
          (state.creating ? 'Creating…' : 'Create estimate') + '</button>' +
        '<div class="jt-create-err" id="jtCreateErr" role="alert">' + esc(state.createErr || '') + '</div>' +
      '</div>';
  }

  // Wires the real search/quick-create widget into the #jtLeadPickerRoot
  // container renderPreview() just emitted. Called from paintModal AFTER
  // body.innerHTML is set, since the container must be live in the DOM.
  function _jtWireLeadPicker() {
    var root = document.getElementById('jtLeadPickerRoot');
    var hidden = document.getElementById('jtLeadSel');
    if (!root || !hidden || !window.EntityResolver) return;
    var leads = Array.isArray(window._leads) ? window._leads : [];
    var initialLead = state.leadId
      ? leads.filter(function (l) { return l && String(l.id) === String(state.leadId); })[0] || null
      : null;
    window.EntityResolver.mountLeadPicker(root, {
      hiddenInput: hidden,
      initialLead: initialLead,
      // Mirror the pick into state.leadId so IT is the source of truth — not
      // just the #jtLeadSel input. Any reRender()/paintModal() while the create
      // step is open (an external engine callback — see job-templates.js's
      // reRender hook — a live snapshot, or the input/change delegate) rebuilds
      // renderPreview() from state.leadId and re-mounts this picker. Before this
      // sync, state.leadId stayed null after a pick, so a repaint silently
      // dropped the chosen customer and the estimate saved with leadId:null —
      // "created but not attached to the customer". onSelect(null) fires on
      // the picker's Change/clear, keeping state.leadId honest.
      onSelect: function (lead) {
        state.leadId = (lead && lead.id != null) ? String(lead.id) : null;
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // SUCCESS step
  // ══════════════════════════════════════════════════════════════════════

  function renderSuccess() {
    // "Send to customer" only when the estimate was attributed to a lead —
    // the shared estimate-view link mints a portal token whose leadId must
    // match the estimate's leadId (getEstimateForView enforces it). When a
    // lead is attached it's the primary action (the payoff of quoting a
    // customer); otherwise the builder is primary.
    var hasLead = !!state.createdLeadId;
    var sendBtn = hasLead
      ? '<button type="button" class="jt-btn jt-btn-primary" data-jt-action="send-to-customer">📤 Send to customer</button>'
      : '';
    return '<div class="jt-success">' +
      '<div class="ic">✓</div>' +
      '<h2>Estimate created</h2>' +
      '<p>' + esc(state.createdName || 'Your estimate') + ' has been saved to your estimates.' +
        (hasLead ? ' Send the customer a private link to view it.' : '') + '</p>' +
      '<div class="btns">' +
        sendBtn +
        '<button type="button" class="jt-btn' + (hasLead ? '' : ' jt-btn-primary') + '" data-jt-action="open-in-v2">Open in Estimate Builder</button>' +
        '<button type="button" class="jt-btn" data-jt-action="done">Done</button>' +
      '</div>' +
      '</div>';
  }

  // ══════════════════════════════════════════════════════════════════════
  // Template editor (fork-on-edit; JSON-backed form)
  // ══════════════════════════════════════════════════════════════════════

  function blankTemplate() {
    return {
      id: '', name: '', category: 'roof_repair', jobType: 'repair',
      description: '', scopeNotes: '', tags: [], durationHint: '',
      minJobCharge: null, measurements: null, items: []
    };
  }

  function openEditor(id) {
    var t = id ? getTpl(id) : null;
    edState.tpl = t ? JSON.parse(JSON.stringify(t)) : blankTemplate();
    edState.isFork = !!(t && !isCustom(t));
    // Reset staged cost edits. Without this, opening template B after typing a
    // cost into template A would carry A's pending COMPANY-WIDE change along
    // and write it when B is saved.
    edState.costEdits = {};
    ensureModal();
    paintEditor();
    document.getElementById('jtEditModal').classList.add('open');
  }

  function closeEditor() {
    var e = document.getElementById('jtEditModal');
    if (e) e.classList.remove('open');
    edState.tpl = null;
    edState.costEdits = {};   // Cancel means cancel, for costs too.
  }

  function paintEditor() {
    var card = document.getElementById('jtEditCard');
    var t = edState.tpl;
    if (!card || !t) return;

    var meta = categoryMeta();
    var catOpts = Object.keys(meta).map(function (k) {
      return '<option value="' + esc(k) + '"' + (t.category === k ? ' selected' : '') + '>' + esc(catLabel(k)) + '</option>';
    }).join('');
    var typeOpts = Object.keys(JOB_TYPES).map(function (k) {
      return '<option value="' + esc(k) + '"' + (t.jobType === k ? ' selected' : '') + '>' + esc(JOB_TYPES[k]) + '</option>';
    }).join('');

    var dl = '<datalist id="jtCodeList">' + catalogCodes().map(function (c) {
      return '<option value="' + esc(c) + '"></option>';
    }).join('') + '</datalist>';

    var itemsHtml = (t.items || []).map(function (it, i) {
      var isCustomItem = !!it.custom;
      var codeField = isCustomItem
        ? '<input type="text" class="jt-in code" data-jt-edi="customName" data-idx="' + i + '" value="' + esc(it.custom.name || '') + '" placeholder="Custom item name">'
        : '<input type="text" class="jt-in code" list="jtCodeList" data-jt-edi="code" data-idx="' + i + '" value="' + esc(it.code || '') + '" placeholder="Catalog code">';
      var q = (isCustomItem ? it.custom.qty : it.qty);

      // ── cost state for this item ────────────────────────────────────────
      // Costs are COMPANY-scoped and keyed by jt-<slug(templateId)>-<index>,
      // independent of the template document. So the inputs below read and
      // write the cost book directly rather than riding item.custom — which
      // also means setting a cost on a DEFAULT template does not force a fork.
      var unsetBadge = '';
      var costFields = '';
      if (isCustomItem) {
        var key = costKeyFor(t.id, i);
        var staged = key && edState.costEdits[key];
        var booked = bookCostFor(t.id, i);
        var priced = !!(staged || booked);
        // A pre-strip fork still carries its own embedded costs; that counts
        // as priced (customLineItem's legacy branch reads them).
        if (!priced && (it.custom.materialCost != null || it.custom.laborCost != null)) priced = true;
        if (!priced) unsetBadge = ' <span class="jt-chip jt-chip-warn">Cost not set</span>';

        if (key && canEditCosts()) {
          var cur = staged || booked ||
            ((it.custom.materialCost != null || it.custom.laborCost != null)
              ? { materialCost: Number(it.custom.materialCost) || 0, laborCost: Number(it.custom.laborCost) || 0 }
              : null);
          var unitLbl = esc(it.custom.unit || 'EA');
          costFields =
            '<div><span class="jt-mini-lbl">Material $/' + unitLbl + '</span>' +
              '<input type="number" step="any" min="0" class="jt-in jt-in-qty" placeholder="—" ' +
              'data-jt-edi="materialCost" data-idx="' + i + '" value="' +
              esc(cur && cur.materialCost != null ? cur.materialCost : '') + '"></div>' +
            '<div><span class="jt-mini-lbl">Labor $/' + unitLbl + '</span>' +
              '<input type="number" step="any" min="0" class="jt-in jt-in-qty" placeholder="—" ' +
              'data-jt-edi="laborCost" data-idx="' + i + '" value="' +
              esc(cur && cur.laborCost != null ? cur.laborCost : '') + '"></div>';
        }
      }
      return '<div class="jt-ed-item">' +
        '<span class="jt-chip jtx-minw52px-tacenter">' + (isCustomItem ? 'CUSTOM' : 'CODE') + '</span>' +
        unsetBadge +
        codeField +
        '<div><span class="jt-mini-lbl">Qty</span>' +
          '<input type="number" step="any" min="0" class="jt-in jt-in-qty" placeholder="auto" data-jt-edi="qty" data-idx="' + i + '" value="' + esc(q == null ? '' : q) + '"></div>' +
        costFields +
        '<label class="jtx-dflex-aicenter-gap6px">' +
          '<input type="checkbox" data-jt-edi="optional" data-idx="' + i + '"' + (it.optional ? ' checked' : '') + '> optional</label>' +
        '<div class="jtx-dflex-gap4px-mlauto">' +
          '<button type="button" class="jt-btn jt-btn-sm" data-jt-action="ed-move-up" data-idx="' + i + '" title="Move up">↑</button>' +
          '<button type="button" class="jt-btn jt-btn-sm" data-jt-action="ed-move-down" data-idx="' + i + '" title="Move down">↓</button>' +
          '<button type="button" class="jt-btn jt-btn-sm jt-btn-danger" data-jt-action="ed-remove-item" data-idx="' + i + '">✕</button>' +
        '</div>' +
        '</div>';
    }).join('');

    card.innerHTML =
      '<div class="jt-ed-hdr">' +
        '<span class="t">' + (t.id ? 'Edit Template' : 'New Template') + '</span>' +
        '<button type="button" class="jt-m-close jtx-min38px-p8px14px" data-jt-action="ed-cancel">✕</button>' +
      '</div>' +
      '<div class="jt-ed-body">' + dl +
        (edState.isFork
          ? '<div class="jt-fork-note">This is a built-in template. Saving your changes creates your own editable copy — the original stays untouched.</div>'
          : '') +
        '<div class="jt-ed-grid">' +
          '<div><span class="jt-mini-lbl">Name</span>' +
            '<input type="text" class="jt-in jtx-wd100" data-jt-ed="name" value="' + esc(t.name) + '"></div>' +
          '<div><span class="jt-mini-lbl">Duration hint</span>' +
            '<input type="text" class="jt-in jtx-wd100" data-jt-ed="durationHint" value="' + esc(t.durationHint || '') + '" placeholder="e.g. 2-3 hours"></div>' +
          '<div><span class="jt-mini-lbl">Category</span>' +
            '<select class="jt-in jtx-wd100" data-jt-ed="category">' + catOpts + '</select></div>' +
          '<div><span class="jt-mini-lbl">Job type</span>' +
            '<select class="jt-in jtx-wd100" data-jt-ed="jobType">' + typeOpts + '</select></div>' +
          '<div><span class="jt-mini-lbl">Tags (comma-separated)</span>' +
            '<input type="text" class="jt-in jtx-wd100" data-jt-ed="tags" value="' + esc((t.tags || []).join(', ')) + '"></div>' +
          '<div><span class="jt-mini-lbl">Minimum job charge ($, blank = engine default)</span>' +
            '<input type="number" step="any" min="0" class="jt-in jtx-wd100" data-jt-ed="minJobCharge" value="' + esc(t.minJobCharge == null ? '' : t.minJobCharge) + '"></div>' +
        '</div>' +
        '<div class="jtx-mt12px"><span class="jt-mini-lbl">Customer description (shown on proposals)</span>' +
          '<textarea class="jt-in jtx-wd100-min56px-resvertical" data-jt-ed="description">' + esc(t.description || '') + '</textarea></div>' +
        '<div class="jtx-mt10px"><span class="jt-mini-lbl">Scope notes (internal, rep-facing)</span>' +
          '<textarea class="jt-in jtx-wd100-min56px-resvertical" data-jt-ed="scopeNotes">' + esc(t.scopeNotes || '') + '</textarea></div>' +
        // The cost fields below are COMPANY-WIDE, while the template itself is
        // this user's own copy. That asymmetry is invisible unless it is said,
        // and a rep who assumes "my template, my numbers" would be wrong in a
        // way that changes other people's quotes.
        (canEditCosts()
          ? '<div class="jt-cost-scope-note">💰 Item costs are your <strong>company\'s</strong> cost book — shared by every rep, and used to price these lines on every estimate. The template itself stays your own copy.</div>'
          : '') +
        '<div class="jtx-m16px08px-dflex-jcspacebet">' +
          '<span class="jtx-fs12px-w800-corange">Line items (' + (t.items || []).length + ')</span>' +
          '<button type="button" class="jt-btn jt-btn-sm" data-jt-action="ed-add-item">+ Add item</button>' +
        '</div>' +
        '<div class="jtx-dflex-flecolumn-gap8px">' +
          (itemsHtml || '<div class="jt-empty jtx-p22px">No items yet — add catalog codes above.</div>') +
        '</div>' +
      '</div>' +
      '<div class="jt-ed-foot">' +
        '<button type="button" class="jt-btn" data-jt-action="ed-cancel">Cancel</button>' +
        '<button type="button" class="jt-btn jt-btn-primary" data-jt-action="ed-save">' + (edState.isFork ? 'Save as my copy' : 'Save template') + '</button>' +
      '</div>';
  }

  function editorSave() {
    var t = edState.tpl;
    if (!t) return;
    if (!String(t.name || '').trim()) { toast('Template needs a name', 'error'); return; }
    // Drop empty item rows (no code and no custom name)
    t.items = (t.items || []).filter(function (it) {
      if (it.custom) return String(it.custom.name || '').trim() !== '';
      return String(it.code || '').trim() !== '';
    });
    var JT = engine();
    if (!JT || typeof JT.saveCustom !== 'function') { toast('Template engine not ready', 'error'); return; }
    // Snapshot before closeEditor() clears edState.
    var costEdits = edState.costEdits;
    var nCosts = Object.keys(costEdits).length;
    try {
      JT.saveCustom(t); // engine handles fork semantics (basedOn) for defaults
      toast(edState.isFork ? 'Saved as your custom copy' : 'Template saved', 'success');
      closeEditor();
      clearBandCache();
      reRender();
    } catch (e) {
      console.error('[job-templates-ui] saveCustom failed:', e);
      toast('Could not save template', 'error');
      return;
    }
    if (nCosts) flushCostEdits(costEdits, nCosts);
  }

  /**
   * Write staged cost edits to the COMPANY book, then re-price.
   *
   * Separate from the template save on purpose: the two land in different
   * documents with different scoping and different write rules. A template
   * save that succeeds must not be reported as a failure because the cost
   * write was refused — and vice versa. Runs after the template save so a
   * newly-forked template's keys already exist.
   */
  function flushCostEdits(costEdits, nCosts) {
    var cc = window.NBDCatalogCosts;
    if (!cc || typeof cc.recordJobItems !== 'function') {
      toast('Costs could not be saved — cost book unavailable', 'error');
      return;
    }
    var p;
    try { p = cc.recordJobItems(costEdits); }
    catch (e) { console.error('[job-templates-ui] recordJobItems threw:', e); toast('Costs could not be saved', 'error'); return; }
    if (!p || typeof p.then !== 'function') return;
    p.then(function (wrote) {
      if (!wrote) {
        // The affordance check said yes and the rule said no — stale claims,
        // or a role changed mid-session. Say so plainly rather than leaving a
        // rep to discover the numbers did not stick.
        toast('Costs were not saved — company cost settings are owner/admin only', 'error');
        return;
      }
      // Re-register every JT line at the new figures and drop the band cache,
      // so the library repaints from "Cost not set" to a real price band
      // without a reload.
      try {
        var JT2 = engine();
        if (JT2 && typeof JT2.applyJtCostSeed === 'function') JT2.applyJtCostSeed();
      } catch (e) { /* the repaint below still runs */ }
      clearBandCache();
      reRender();
      toast(nCosts + ' item cost' + (nCosts === 1 ? '' : 's') + ' saved for your company', 'success');
    }, function (e) {
      console.error('[job-templates-ui] cost write failed:', e);
      toast('Costs could not be saved', 'error');
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Flow actions
  // ══════════════════════════════════════════════════════════════════════

  // Both entries accept an optional { leadId } (lead-context flow — the
  // dashboard card-detail "Template Quote" action): the create step's lead
  // select pre-selects that lead. Plain calls (no opts) keep any leadId
  // already staged by openPicker.
  function openPreconfirm(opts) {
    if (opts && opts.leadId) state.leadId = String(opts.leadId);
    if (!state.selected.length) { toast('Select at least one template first', 'error'); return; }
    ensureChoices();
    seedMeasurements();
    state.step = 'preconfirm';
    showModal();
    paintModal();
  }

  function openPicker(opts) {
    state.host = 'modal';
    state.forScope = false;
    state.scopeCb = null;
    state.leadId = (opts && opts.leadId) ? String(opts.leadId) : null;
    state.step = 'library';
    showModal();
    paintModal();
  }

  // One-tap "Use this template" — the per-card primary CTA. Ensures the
  // template is in the selection (additive, never clobbers an in-progress
  // multi-select) and jumps straight into the configure step, from which
  // the rep previews and attributes the quote to a customer/lead. Honors
  // scope mode (openPickerForScope) via openPreconfirm's Insert primary.
  function quickUse(id) {
    if (!id) return;
    toggleSelect(id, true);
    openPreconfirm();
  }

  function openPickerForScope(cb) {
    state.host = 'modal';
    state.forScope = true;
    state.scopeCb = (typeof cb === 'function') ? cb : null;
    state.step = 'library';
    showModal();
    paintModal();
  }

  function goPreview() {
    state.step = 'preview';
    state.createErr = '';
    paintModal();
  }

  function doInsertIntoV2() {
    var JT = engine();
    if (!JT || typeof JT.insertIntoV2 !== 'function') { toast('Template engine not ready', 'error'); return; }
    try {
      var sel = buildSelection();
      var result = JT.insertIntoV2(sel, resolveOpts()) || {};
      // Surface added/skipped counts + engine warnings (truncated ~3 lines).
      var msgs = [];
      if (typeof result.added === 'number' || typeof result.skipped === 'number') {
        var added = Number(result.added) || 0;
        var skipped = Number(result.skipped) || 0;
        msgs.push(added + ' line' + (added === 1 ? '' : 's') + ' added' +
          (skipped ? ', ' + skipped + ' skipped (already in scope)' : ''));
      } else {
        msgs.push('Templates inserted into estimate scope');
      }
      var warns = Array.isArray(result.warnings) ? result.warnings : [];
      var room = Math.max(0, 3 - msgs.length);
      warns.slice(0, room).forEach(function (w) { msgs.push(String(w)); });
      if (warns.length > room) msgs.push('+' + (warns.length - room) + ' more warning' + (warns.length - room === 1 ? '' : 's'));
      toast(msgs.slice(0, 4).join('\n'), warns.length ? 'info' : 'success');
      var cb = state.scopeCb;
      closeModal();
      if (typeof cb === 'function') { try { cb(sel); } catch (e) { /* caller's problem */ } }
    } catch (e) {
      console.error('[job-templates-ui] insertIntoV2 failed:', e);
      toast('Could not insert into the estimate', 'error');
    }
  }

  // The refusal beside Create estimate, patched in place so the typed
  // estimate name survives; the toast is kept for any page where it shows.
  function showCreateErr(msg) {
    state.createErr = msg || '';
    var el = document.getElementById('jtCreateErr');
    if (el) el.textContent = state.createErr;
    if (msg) toast(msg, 'error');
  }

  function doCreateEstimate() {
    if (state.creating) return;
    var JT = engine();
    if (!JT || typeof JT.createEstimate !== 'function') { toast('Template engine not ready', 'error'); return; }
    var nameEl = document.getElementById('jtEstName');
    var leadEl = document.getElementById('jtLeadSel');
    var name = (nameEl && nameEl.value.trim()) || defaultEstimateName();
    var leadId = (leadEl && leadEl.value) ? leadEl.value : null;

    // Upgrades ride the save through the same applyUpgrades the preview
    // rendered. A pick that cannot be priced (no measured footage, …) stops
    // the save here: an estimate missing a line the homeowner said yes to is
    // worse than no estimate.
    var upgModelNow = upgModel(resolveCurrent());
    if (upgModelNow && upgModelNow.errors.length) {
      showCreateErr('Not saved — fix the upgrade first: ' + upgModelNow.errors[0].message);
      return;
    }
    showCreateErr('');

    state.creating = true;
    var btn = document.querySelector('[data-jt-action="create-estimate"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

    var opts = resolveOpts();
    opts.name = name;
    // Sent whenever upgrades were offered — even with nothing picked, the
    // offered / declined record (prices frozen) is saved on the estimate.
    if (upgModelNow && !upgModelNow.blocked) opts.upgrades = upgModelNow.sel;
    if (leadId) {
      opts.leadId = leadId;
      // Stamp owner/addr from the selected lead so the saved payload carries
      // the customer block (V2 prefillFromLead parity — reopen shows customer).
      var leads = Array.isArray(window._leads) ? window._leads : [];
      var lead = null;
      for (var li = 0; li < leads.length; li++) {
        if (leads[li] && String(leads[li].id) === String(leadId)) { lead = leads[li]; break; }
      }
      if (lead) {
        var ownerName = lead.name || lead.customerName ||
          ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
        if (ownerName) opts.owner = ownerName;
        var leadAddr = lead.address || lead.addr || '';
        if (leadAddr) opts.addr = leadAddr;
        // The lead's recorded deductible (2026-09-25): an insurance template
        // estimate's saved deposit plan names it, as the invoice does.
        var leadDed = (lead.deductibleOrOwedByHO != null && lead.deductibleOrOwedByHO !== '')
          ? lead.deductibleOrOwedByHO : lead.deductible;
        if (leadDed != null && leadDed !== '' && Number(leadDed) > 0) opts.deductible = Number(leadDed);
      }
    }

    Promise.resolve()
      .then(function () { return JT.createEstimate(buildSelection(), opts); })
      .then(function (res) {
        state.creating = false;
        state.createdId = (res && typeof res === 'object') ? (res.id || res.estimateId || null) : (res || null);
        // Capture the attributed lead now — #jtLeadSel is destroyed on the
        // transition to the success step, and "Send to customer" needs it to
        // mint a portal token whose leadId matches the estimate's leadId.
        state.createdLeadId = leadId || null;
        state.createdName = name;
        state.step = 'success';
        paintModal();
        toast('Estimate created', 'success');
      })
      .catch(function (e) {
        console.error('[job-templates-ui] createEstimate failed:', e);
        state.creating = false;
        var upErr = e && Array.isArray(e.upgradeErrors) && e.upgradeErrors[0];
        state.createErr = upErr ? 'Not saved — fix the upgrade first: ' + upErr.message : 'Could not create the estimate. Try again.';
        toast(state.createErr, 'error');
        paintModal(); // re-enable the button (and show createErr beside it)
      });
  }

  function openInV2() {
    var id = state.createdId;
    closeModal();
    if (!id) { toast('Estimate saved — open it from the Estimates view', 'info'); return; }
    // Canonical reopen entry (dashboard-widgets.js viewEstimate pattern):
    // window.openEstimateV2Builder({ estimateId }) — estimate-v2-ui.js open().
    if (typeof window.openEstimateV2Builder === 'function') {
      window.openEstimateV2Builder({ estimateId: id });
      return;
    }
    toast('Estimate saved — open it from the Estimates view', 'info');
  }

  // "Send to customer" — share a private, revocable link to THIS estimate's
  // customer view. Reuses the proven token path: CustomerPortal.mintUrl mints
  // a createPortalToken bound to the lead (loaded on both dashboard + customer
  // pages, unlike the customer-only shareEstimateViewLink), then we point it at
  // /pro/estimate-view.html?token=&estimateId= — the same viewer + server guard
  // (getEstimateForView) the customer page's 🔗 button uses. Web Share on mobile,
  // else clipboard, else prompt() so the rep always walks away with the link.
  async function sendToCustomer() {
    var estId = state.createdId;
    var leadId = state.createdLeadId;
    if (!estId) { toast('Estimate not saved yet', 'error'); return; }
    if (!leadId) { toast('Attach a customer to this estimate to send it', 'info'); return; }
    if (!window.CustomerPortal || typeof window.CustomerPortal.mintUrl !== 'function') {
      toast('Portal module not loaded — open the estimate and share from there', 'error');
      return;
    }
    var btn = document.querySelector('[data-jt-action="send-to-customer"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating link…'; }
    try {
      var portalUrl = await window.CustomerPortal.mintUrl(leadId);
      var token = '';
      try { token = new URL(portalUrl).searchParams.get('token') || ''; } catch (e) { token = ''; }
      if (!token) throw new Error('No token');
      var url = location.origin + '/pro/estimate-view.html?token=' +
        encodeURIComponent(token) + '&estimateId=' + encodeURIComponent(estId);

      var shared = false;
      if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '')) {
        try { await navigator.share({ title: 'Your estimate', text: 'Here’s your estimate:', url: url }); shared = true; }
        catch (e) { /* user cancelled or unsupported — fall through to copy */ }
      }
      if (!shared && navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(url); shared = true; toast('Customer estimate link copied ✓', 'success'); }
        catch (e) { /* clipboard blocked — fall through to prompt */ }
      }
      if (!shared) { window.prompt('Copy this link to send to your customer:', url); }

      // Feed the existing share-tracking widgets (last-shared chip, freshness).
      if (window.PortalLinkHelpers && typeof window.PortalLinkHelpers.recordShare === 'function') {
        try { window.PortalLinkHelpers.recordShare(leadId, 'copy'); } catch (e) { /* non-fatal */ }
      }
    } catch (e) {
      console.error('[job-templates-ui] sendToCustomer failed:', e);
      toast('Could not create the customer link — try again', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📤 Send to customer'; }
    }
  }

  function duplicateTemplate(id) {
    var JT = engine();
    if (!JT || typeof JT.duplicate !== 'function') { toast('Template engine not ready', 'error'); return; }
    try {
      JT.duplicate(id);
      toast('Template duplicated', 'success');
      clearBandCache();
      reRender();
    } catch (e) {
      console.error('[job-templates-ui] duplicate failed:', e);
      toast('Could not duplicate template', 'error');
    }
  }

  async function deleteTemplate(id) {
    var t = getTpl(id);
    if (!t) return;
    // Native confirm() is patched to always return true in PWA standalone
    // mode (standalone-compat.js), which would delete the template with no
    // question asked on the phone. nbdConfirm gives a real Promise<boolean>
    // via a modal there, and falls back to native confirm on desktop.
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
    if (!(await ask('Delete "' + (t.name || id) + '"? This cannot be undone.'))) return;
    var JT = engine();
    if (!JT || typeof JT.remove !== 'function') { toast('Template engine not ready', 'error'); return; }
    try {
      JT.remove(id);
      toggleSelect(id, false);
      delete state.choices[id];
      toast('Template deleted', 'success');
      clearBandCache();
      reRender();
    } catch (e) {
      console.error('[job-templates-ui] remove failed:', e);
      toast('Could not delete template', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Delegated events — bound ONCE at document scope behind a window flag
  // (product-library.js _NBD_PL_DELEGATE_BOUND pattern). ZERO inline
  // handlers anywhere; everything dispatches on data-jt-action.
  // ══════════════════════════════════════════════════════════════════════

  function onDelegatedClick(ev) {
    var t = ev.target.closest && ev.target.closest('[data-jt-action]');
    if (!t) return;
    // Inputs/selects are handled by the input/change delegate below.
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;

    var action = t.dataset.jtAction;
    var id = t.dataset.id;
    var idx = t.dataset.idx !== undefined ? Number(t.dataset.idx) : null;

    try {
      switch (action) {
        case 'rerender': reRender(); break;

        // ── Library ──
        case 'set-category': state.category = id || 'all'; reRender(); break;
        case 'set-jobtype': state.jobType = id || 'all'; reRender(); break;
        case 'clear-selection':
          state.selected = [];
          state.choices = {};
          state.upg = freshUpg();
          reRender();
          break;
        // Recently-used compact card — toggles selection like the checkbox.
        case 'quick-select':
          if (id) { toggleSelect(id, !isSelected(id)); reRender(); }
          break;
        case 'open-preconfirm': openPreconfirm(); break;
        case 'quick-use': if (id) quickUse(id); break;
        case 'new-template': openEditor(null); break;
        case 'edit-template': if (id) openEditor(id); break;
        case 'duplicate-template': if (id) duplicateTemplate(id); break;
        case 'delete-template': if (id) deleteTemplate(id); break;

        // ── Modal nav ──
        case 'close-modal': closeModal(); break;
        case 'back-to-library': state.step = 'library'; paintModal(); break;
        case 'back-to-preconfirm': state.step = 'preconfirm'; paintModal(); break;
        case 'go-preview': goPreview(); break;
        case 'toggle-section':
          if (id) { state.collapsed[id] = !state.collapsed[id]; paintModal(); }
          break;
        case 'set-tier':
          if (id && TIERS.indexOf(id) !== -1) { state.tier = id; paintModal(); }
          break;
        case 'set-jobmode':
          if (id === 'cash' || id === 'insurance') { state.jobMode = id; paintModal(); }
          break;
        case 'toggle-meas': state.measOpen = !state.measOpen; paintModal(); break;

        // ── Upgrades card + Show homeowner ──
        case 'upg-pick':
        case 'upg-pick-none':
        case 'upg-star':
        case 'upg-require':
        case 'upg-more':
        case 'upg-show-homeowner':
        case 'upg-ho-add':
        case 'upg-ho-no':
        case 'upg-ho-done':
          onUpgradeAction(action, id);
          break;

        // ── Terminal actions ──
        case 'insert-into-v2': doInsertIntoV2(); break;
        case 'create-estimate': doCreateEstimate(); break;
        case 'send-to-customer': sendToCustomer(); break;
        case 'open-in-v2': openInV2(); break;
        case 'done': closeModal(); break;

        // ── Editor ──
        case 'ed-add-item':
          if (edState.tpl) {
            edState.tpl.items = edState.tpl.items || [];
            edState.tpl.items.push({ code: '' });
            paintEditor();
          }
          break;
        case 'ed-remove-item':
          if (edState.tpl && idx !== null && edState.tpl.items && edState.tpl.items[idx] !== undefined) {
            edState.tpl.items.splice(idx, 1);
            paintEditor();
          }
          break;
        case 'ed-move-up':
        case 'ed-move-down':
          if (edState.tpl && idx !== null && edState.tpl.items) {
            var to = action === 'ed-move-up' ? idx - 1 : idx + 1;
            if (to >= 0 && to < edState.tpl.items.length) {
              var tmp = edState.tpl.items[idx];
              edState.tpl.items[idx] = edState.tpl.items[to];
              edState.tpl.items[to] = tmp;
              paintEditor();
            }
          }
          break;
        case 'ed-save': editorSave(); break;
        case 'ed-cancel': closeEditor(); break;
      }
    } catch (e) {
      console.error('[job-templates-ui] dispatch ' + action + ' failed:', e);
    }
  }

  function onDelegatedInput(ev) {
    var el = ev.target;
    if (!el || !el.dataset) return;

    try {
      // ── Measurements panel ──
      if (el.dataset.jtMeas !== undefined) {
        var mk = el.dataset.jtMeas;
        if (el.type === 'checkbox') state.measurements[mk] = !!el.checked;
        else {
          var mv = num(el.value);
          state.measurements[mk] = mv == null ? 0 : mv;
        }
        scheduleResolve();
        return;
      }

      // ── Editor: template-level fields (update working copy only —
      //    no re-render so typing keeps focus) ──
      if (el.dataset.jtEd !== undefined && edState.tpl) {
        var f = el.dataset.jtEd;
        if (f === 'tags') {
          edState.tpl.tags = String(el.value || '').split(',')
            .map(function (s) { return s.trim(); }).filter(Boolean);
        } else if (f === 'minJobCharge') {
          edState.tpl.minJobCharge = (el.value === '') ? null : (num(el.value) || 0);
        } else {
          edState.tpl[f] = el.value;
        }
        return;
      }

      // ── Editor: per-item fields ──
      if (el.dataset.jtEdi !== undefined && edState.tpl) {
        var ii = Number(el.dataset.idx);
        var item = edState.tpl.items && edState.tpl.items[ii];
        if (!item) return;
        var fld = el.dataset.jtEdi;
        if (fld === 'code') item.code = el.value.trim();
        else if (fld === 'customName') { item.custom = item.custom || {}; item.custom.name = el.value; }
        else if (fld === 'qty') {
          var qv = (el.value === '') ? null : num(el.value);
          if (item.custom) item.custom.qty = (qv == null ? 1 : qv);
          else if (qv == null) delete item.qty;
          else item.qty = qv;
        }
        else if (fld === 'optional') {
          if (el.checked) item.optional = true; else delete item.optional;
        }
        else if (fld === 'materialCost' || fld === 'laborCost') {
          // STAGED, not written. These are company-wide values; they reach
          // Firestore only on Save, so Cancel means cancel and a half-typed
          // number never becomes every rep's cost. Never written onto
          // item.custom either — that would re-embed cost data into the
          // uid-scoped template document, which is the leak this migration
          // removed.
          var ckey = costKeyFor(edState.tpl.id, ii);
          if (!ckey || !item.custom) return;
          // Built field-by-field rather than from a `{materialCost: 0,
          // laborCost: 0}` literal — that shape is a published cost pair as far
          // as tests/catalog-cost-privacy.test.js is concerned, and it flagged
          // this line on the first run. The guard is right to be shape-based:
          // it cannot tell a placeholder from a real figure, and it should not
          // have to learn exceptions for one file's convenience.
          var base = edState.costEdits[ckey] || bookCostFor(edState.tpl.id, ii) || null;
          var next = {
            materialCost: Number(base && base.materialCost) || 0,
            laborCost: Number(base && base.laborCost) || 0
          };
          var cv = (el.value === '') ? 0 : num(el.value);
          next[fld] = (cv == null || cv < 0) ? 0 : cv;
          edState.costEdits[ckey] = next;
        }
        return;
      }

      var action = el.dataset.jtAction;
      if (!action) return;

      // ── Library search (re-render + restore caret, PL pattern) ──
      if (action === 'search') {
        state.search = el.value || '';
        reRender();
        var fresh = document.getElementById('jtSearch');
        if (fresh && fresh !== el) {
          fresh.focus();
          fresh.setSelectionRange(fresh.value.length, fresh.value.length);
        }
        return;
      }

      // ── Card multi-select ──
      if (action === 'toggle-select') {
        toggleSelect(el.dataset.id, !!el.checked);
        reRender();
        return;
      }

      // ── Preconfirm global county/tax jurisdiction ──
      if (action === 'set-county') {
        state.county = el.value || '';
        scheduleResolve();
        return;
      }

      // ── Repair job: per-estimate 1-year workmanship warranty (no price
      //    change, so no re-resolve; it is saved by createEstimate) ──
      if (action === 'set-repair-warranty') {
        state.repairWarranty = !!el.checked;
        return;
      }

      // ── Upgrades card: typed footage re-prices (debounced, focus kept);
      //    a star's reason changes no price, so it only updates the state ──
      if (action === 'upg-qty') {
        if (el.dataset.id) state.upg.qty[el.dataset.id] = String(el.value == null ? '' : el.value);
        scheduleResolve();
        return;
      }
      if (action === 'upg-reason') {
        var sid = el.dataset.id;
        if (sid && hasOwn(state.upg.stars, sid)) {
          state.upg.stars[sid] = String(el.value == null ? '' : el.value).slice(0, 140);
          upgPatchStarBadge(sid);
        }
        return;
      }

      // ── Preconfirm per-item edits ──
      var tid = el.dataset.tid;
      var idx = Number(el.dataset.idx);
      if (!tid || !state.choices[tid] || !state.choices[tid][idx]) return;
      var ch = state.choices[tid][idx];

      if (action === 'item-include') {
        ch.included = !!el.checked;
        var row = el.closest('.jt-row');
        if (row) row.classList.toggle('off', !el.checked);
        scheduleResolve();
      } else if (action === 'item-qty') {
        ch.qty = (el.value === '') ? null : num(el.value);
        scheduleResolve();
      } else if (action === 'item-price') {
        ch.unitPriceOverride = (el.value === '') ? null : num(el.value);
        scheduleResolve();
      } else if (action === 'item-brand') {
        ch.brandCode = el.value || null;
        scheduleResolve();
      }
    } catch (e) {
      console.error('[job-templates-ui] input dispatch failed:', e);
    }
  }

  if (!window._NBD_JT_DELEGATE_BOUND) {
    window._NBD_JT_DELEGATE_BOUND = true;
    document.addEventListener('click', onDelegatedClick);
    // One handler wired to both events: text/number fields fire 'input',
    // selects/checkboxes fire 'change'. The handler is idempotent, so the
    // occasional double fire (checkboxes emit both) is harmless.
    document.addEventListener('input', onDelegatedInput);
    document.addEventListener('change', onDelegatedInput);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════════

  window.JobTemplatesUI = {
    render: render,
    reRender: reRender,
    openPicker: openPicker,
    openPickerForScope: openPickerForScope,
    openPreconfirm: openPreconfirm,
    closeModal: closeModal,
    // Exported for catalog-costs.js → JobTemplates.applyJtCostSeed(): when a
    // cold device's cost book lands AFTER the library has painted, every
    // cached price band was computed against an empty book and is wrong (an
    // empty band where there should be a range). Dropping the cache is what
    // makes the cards repaint at the tenant's real numbers.
    clearBandCache: clearBandCache,
    // Test hook (tests/estimate-rounding-line-2026-09-28.test.js).
    _totalsAdjustmentRow: totalsAdjustmentRow
  };

  // Globals Tranche 3 T3-C (2026-09-18): renderJobTemplatesLibrary is
  // registry-only (was a window alias of render). Its sole reader is
  // dashboard-actions.js goTo('job-templates'), which prefers
  // JobTemplatesUI.render() above and reads this entry only after the lazy
  // 'estimates' bundle has loaded.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, { renderJobTemplatesLibrary: render });

})();
