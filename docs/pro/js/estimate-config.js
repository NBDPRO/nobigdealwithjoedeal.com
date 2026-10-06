// ============================================================
// NBD Pro — Estimate Pricing Config (single source of truth)
// Phase 3 of BIG_ROCKS Rock 2 (estimate engine consolidation).
//
// Both estimates.js (classic) and estimate-builder-v2.js (EBv2)
// previously kept their own copies of these constants. A change
// in one engine could quietly diverge from the other. This file
// is the canonical home so a single edit propagates to both.
//
// ─── WHAT'S UNIFIED HERE ─────────────────────────────────────
// Tables/values where both engines used identical SHAPES with
// identical SEMANTIC values, and only the literals were duplicated:
//
//   • TIER_RATES                   (good/better/best per-SQ)
//   • JOB_MINIMUM_DOLLARS / _CENTS (the 100x unit-mismatch trap)
//   • ROUND_TO_DOLLARS / _CENTS    (same)
//   • DEFAULT_DUMP_FEE
//   • CUT_UP_ROOF_WASTE_BONUS
//   • TEAR_OFF_EXTRA_PER_SQ_DOLLARS / _CENTS
//
// Both engines read these as `window.NBD_ESTIMATE_CONFIG.<name>`
// with an inline fallback to the historical literal — so if this
// file fails to load, pricing still works on stale-but-correct
// values and a console.warn surfaces the misload to Sentry.
//
// ─── WHAT'S NOT UNIFIED YET (drift risks remaining) ──────────
// ─── SHAPE-RECONCILED TABLES (PR 3b) ─────────────────────────
// COUNTY_TAX and the permit tables are canonically keyed here by
// county-state slug (V2's shape). Each engine derives the shape
// it historically used:
//   • V2 reads COUNTY_TAX rates / PERMIT_COSTS_BY_COUNTY directly.
//   • Classic derives its bare-county-name tax map via each
//     entry's `name`, and its city-keyed permit map via
//     PERMIT_CITY_TO_COUNTY (the D-1 unify basis, Joe 2026-06-09:
//     every city's default is its primary county's cost).
// The waste-for-pitch divergence is already resolved in code:
// classic's recommendedWasteForPitch delegates to V2's
// wasteFactorForPitch (D-2 unify), converting factor → ratio.
//
// Migration tracker: docs/dev/estimate-engines-audit.md
// ============================================================

(function () {
  'use strict';

  // Per-company business rules (tenant-rules.js, 2026-10-04). Read at CALL
  // time; absent (Node, or a page that does not load it) → the NBD values
  // in this file, exactly as before.
  function _tenantRules() {
    return (typeof window !== 'undefined' && window.NBDTenantRules) || null;
  }

  const CFG = Object.freeze({
    // Per-SQ flat tier rates. Customer price = SQ × TIER_RATE + add-ons + tax
    // (cash mode). FIVE tiers since 2026-10-02 (Jo): Economy and Beyond join
    // Good/Better/Best, and the three existing rates moved up (were
    // 545/595/660). Economy and Beyond are sold in person — CRM only; the
    // public site keeps three tiers whose prices follow these.
    TIER_RATES: Object.freeze({
      economy: 440,  // Jo's choice of economy-grade architectural (never 3-tab); 1-yr labor
      good:    550,  // Standard system + standard accessories; GAF System Plus included
      better:  660,  // Upgraded materials; GAF System Plus included
      best:    770,  // Impact-rated; GAF System Plus included + annual inspection
      beyond:  880   // TAMKO HailGuard ONLY (the one shingle with a hail warranty)
    }),

    // Every tier, cheapest first. Loop over THIS — never a hand-written
    // ['good','better','best'] (2026-10-02: ~40 places assumed three).
    TIER_ORDER: Object.freeze(['economy', 'good', 'better', 'best', 'beyond']),

    // Catalog products (product-data.js, the xactimate catalog) carry
    // pricing for good/better/best only. Economy prices materials off the
    // Good column and Beyond off Best — without this, the line-item engine
    // priced an Economy/Beyond estimate's materials at $0 (resolveMaterial
    // returns cost 0 / sell 0 for a missing tier column).
    PRODUCT_TIER: Object.freeze({ economy: 'good', good: 'good', better: 'better', best: 'best', beyond: 'best' }),
    productTier: function (tier) {
      return CFG.PRODUCT_TIER[tier] || 'better';
    },
    isTier: function (tier) {
      return CFG.TIER_ORDER.indexOf(tier) !== -1;
    },
    // The tiers THIS company offers, cheapest first (2026-10-04, tenant-
    // ready). NBD: TIER_ORDER above, unchanged. Another company: its own
    // Settings → Business rules list (tenant-rules.js), three tiers until set.
    // Pricing and storage still loop over TIER_ORDER — this is what to SHOW.
    tierOrder: function () {
      var tr = _tenantRules();
      var o = tr && typeof tr.tierOrder === 'function' ? tr.tierOrder() : null;
      return (Array.isArray(o) && o.length) ? o : CFG.TIER_ORDER.slice();
    },

    // Shingle rules per tier (Jo, 2026-10-02). A shingle is a catalog item
    // whose sub starts with "shingles-".
    //   beyond:  TAMKO HailGuard ONLY — "they're the only shingle that offers
    //            a hail warranty, so we've gotta lock that".
    //   economy: Jo's pick, but NEVER a 3-tab ("I will not use a three tab").
    // checkTierShingles(tier, items) → { ok, problems: [string] }. items are
    // catalog entries ({ code, name, sub }). Used by the builder (on tier
    // switch, on add, and before save) and by the server copy.
    TIER_SHINGLE_RULES: Object.freeze({
      beyond:  Object.freeze({ onlyCodes: Object.freeze(['RFG 240-TAMKO-HAIL']), onlyName: 'TAMKO HailGuard' }),
      economy: Object.freeze({ forbidSubs: Object.freeze(['shingles-3tab']) })
    }),
    isShingleItem: function (item) {
      return !!item && /^shingles-/.test(String(item.sub || ''));
    },
    checkTierShingles: function (tier, items) {
      // A company's own shingle lock (tenant-rules.js) wins; undefined = no
      // override (NBD's locks above), null = this company set no lock.
      var tr = _tenantRules();
      var own = tr && typeof tr.shingleRuleOverride === 'function' ? tr.shingleRuleOverride(tier) : undefined;
      var rule = (own === undefined) ? CFG.TIER_SHINGLE_RULES[tier] : own;
      var problems = [];
      if (!rule) return { ok: true, problems: problems };
      (items || []).forEach(function (it) {
        if (!CFG.isShingleItem(it)) return;
        if (rule.onlyCodes && rule.onlyCodes.indexOf(it.code) === -1) {
          problems.push((it.name || it.code) + ' is not allowed on ' + CFG.tierLabel(tier) + ' — ' + CFG.tierLabel(tier) + ' is ' + rule.onlyName + ' only.');
        }
        if (rule.forbidSubs && rule.forbidSubs.indexOf(it.sub) !== -1) {
          problems.push((it.name || it.code) + ' is a 3-tab — ' + CFG.tierLabel(tier) + ' never uses a 3-tab shingle.');
        }
      });
      return { ok: problems.length === 0, problems: problems };
    },

    // Job minimum: kicks in below ~4.5 SQ. Both unit forms exposed
    // so each engine reads the unit it already uses without the
    // 100x bug risk that came from one file storing 250000 (cents)
    // and the other storing 2500 (dollars).
    JOB_MINIMUM_DOLLARS: 2500,
    JOB_MINIMUM_CENTS:   250000,

    // Grand-total rounding step.
    ROUND_TO_DOLLARS: 25,
    ROUND_TO_CENTS:   2500,

    // Per-SQ extra layer charge (tear-off layers > 1).
    TEAR_OFF_EXTRA_PER_SQ_DOLLARS: 50,
    TEAR_OFF_EXTRA_PER_SQ_CENTS:   5000,

    // Editable per-estimate, this is the default.
    DEFAULT_DUMP_FEE: 550,

    // +3% waste added on top of pitch-based waste when the
    // "cut-up roof" checkbox is on.
    CUT_UP_ROOF_WASTE_BONUS: 0.03,

    // ── County sales tax (PR 3b) ─────────────────────────────
    // Canonical key: county-state slug (V2's shape). `name` is the
    // bare county name classic keys by — estimates.js derives its
    // COUNTY_TAX_RATES map from it, estimate-builder-v2.js reads
    // the rates directly. Edit a rate HERE and both engines move.
    // Rates validated 2026-04 (OH DOT / KY DOR).
    COUNTY_TAX: Object.freeze({
      'hamilton-oh': Object.freeze({ name: 'Hamilton', rate: 0.0780 }),
      'butler-oh':   Object.freeze({ name: 'Butler',   rate: 0.0725 }),
      'warren-oh':   Object.freeze({ name: 'Warren',   rate: 0.0675 }),
      'clermont-oh': Object.freeze({ name: 'Clermont', rate: 0.0725 }),
      'kenton-ky':   Object.freeze({ name: 'Kenton',   rate: 0.0600 }),
      'boone-ky':    Object.freeze({ name: 'Boone',    rate: 0.0600 }),
      'campbell-ky': Object.freeze({ name: 'Campbell', rate: 0.0600 })
    }),
    DEFAULT_TAX_RATE: 0.07,

    // ── Permit costs (PR 3b) ─────────────────────────────────
    // Canonical key: county-state slug with {name, cost} (V2's
    // shape). Classic keys by CITY — PERMIT_CITY_TO_COUNTY maps
    // each city to its primary county (D-1 unify, Joe 2026-06-09;
    // Loveland spans 3 counties → Hamilton primary, rep-overridable
    // per estimate). estimates.js derives its city→cost map from
    // these two tables.
    PERMIT_COSTS_BY_COUNTY: Object.freeze({
      'hamilton-oh': Object.freeze({ name: 'Hamilton County, OH', cost: 185 }),
      'butler-oh':   Object.freeze({ name: 'Butler County, OH',   cost: 150 }),
      'warren-oh':   Object.freeze({ name: 'Warren County, OH',   cost: 165 }),
      'clermont-oh': Object.freeze({ name: 'Clermont County, OH', cost: 170 }),
      'kenton-ky':   Object.freeze({ name: 'Kenton County, KY',   cost: 125 }),
      'boone-ky':    Object.freeze({ name: 'Boone County, KY',    cost: 135 }),
      'campbell-ky': Object.freeze({ name: 'Campbell County, KY', cost: 130 })
    }),
    PERMIT_CITY_TO_COUNTY: Object.freeze({
      Cincinnati: 'hamilton-oh', Loveland: 'hamilton-oh',
      Hamilton: 'butler-oh', Fairfield: 'butler-oh', 'West Chester': 'butler-oh',
      Mason: 'warren-oh',
      Milford: 'clermont-oh',
      Covington: 'kenton-ky',
      Florence: 'boone-ky',
      'Fort Thomas': 'campbell-ky', Newport: 'campbell-ky'
    }),
    DEFAULT_PERMIT_COST: 150,

    // Add-on flat charges (Rock 2 PR 4b — Joe-confirmed prices).
    // Classic and V2 had divergent values for these:
    //   chimney: classic $425, V2 $285 → unified at $425 (Joe pick)
    //   skylight: classic $275, V2 $350 → unified at $350 (Joe pick)
    //   extra pipe boot: classic $45, V2 $85 → unified at $85 (D-4, Joe 2026-06-09)
    ADDON_CHIMNEY_FLASH:  425,
    ADDON_SKYLIGHT_FLASH: 350,
    // Extra pipe boot beyond 4 ($/EA). D-4 unify: classic now reads this instead
    // of its legacy $45 (window.R.pipe fallback), matching V2's $85.
    ADDON_EXTRA_PIPE_BOOT: 85,
    // Material delivery + fuel surcharge — FLAT PER JOB (no _PER_SQ suffix:
    // the suffix is the unit contract in this file). A RETAIL CHARGE, not a
    // cost. Jo set it to $150 per job on 2026-09-27 (was 412.50, the
    // line-item catalog line 'MAT DEL' carried through the default markup
    // ladder). The per-SQ charge and the line-item 'MAT DEL' line no longer
    // match; the delivery COST stays pinned to the catalog line
    // (estimate-builder-v2.js MAT_DELIVERY_BASELINE), so internal margin
    // reports the trip at what the supplier bills, not at what is charged.
    ADDON_MAT_DELIVERY: 150,

    // Per-SQ complexity add-ons (Phase 1, Joe-confirmed 2026-06-08).
    // Surfaced into the per-SQ engine (calculatePerSq) so cash/retail
    // Good-Better-Best pricing reflects the same complexity the line-item
    // labor adders (LAB ADR-SS/VS/2S/CU) already catch.
    //   PITCH tiers STACK: 8/12 → +steep, 12/12 → +very-steep, 16/12 → +extreme.
    //   STORY + ACCESS tiers REPLACE (a 3-story job pays the 3-story rate only).
    //   Cut-up adds cutting LABOR on top of the +3% material waste (separate).
    ADDON_STEEP_PER_SQ:            25,   // pitch 8/12+
    ADDON_VERY_STEEP_PER_SQ:       45,   // pitch 12/12+ (stacks → $70/SQ at 12/12)
    ADDON_EXTREME_STEEP_PER_SQ:    75,   // pitch 16/12+ (stacks → $145/SQ at 16/12)
    ADDON_TWO_STORY_PER_SQ:        15,   // exactly 2 stories
    ADDON_THREE_STORY_PER_SQ:      30,   // 3+ stories (replaces 2-story rate)
    ADDON_CUTUP_PER_SQ:            15,   // cutting labor (material waste +3% is separate)
    ADDON_ACCESS_MODERATE_PER_SQ:  15,   // tight lot / longer carry / protect landscaping
    ADDON_ACCESS_DIFFICULT_PER_SQ: 35,   // no driveway / hillside (crane/boom = equipment lines)

    // ── Customer-facing tier display (2026-09-09, Jo-confirmed) ──────
    // GBB tier audit (documentation/audit/GBB-TIER-SOURCE-OF-TRUTH-2026-09-09.md)
    // found the internal good/better/best keys above leaking to customers
    // as-is in some places, and four OTHER independent tier-name schemes
    // plus eight independent warranty-duration schemes in others. Decision:
    // the internal keys never change (too deeply embedded — Firestore
    // prices{good,better,best}/selectedTier, catalog tier fields, doc
    // schemas), but every CUSTOMER-FACING surface renders the tier through
    // TIER_DISPLAY instead of hardcoding its own label/warranty text.
    // Rep-facing/internal tool UI may keep saying Good/Better/Best.
    // The ONE customer-facing phrase for the GAF System Plus inclusion
    // (Standard/Preferred/Elite — TIER_DISPLAY[tier].warranty.systemPlus).
    // GAF's own framing: a manufacturer warranty on the GAF shingles and
    // qualifying GAF accessories. No year counts here — GAF sets and changes
    // them, and the registered certificate is the homeowner's record.
    SYSTEM_PLUS_TEXT: 'GAF System Plus warranty included — GAF\'s manufacturer warranty on the GAF shingles and qualifying GAF accessories (GAF terms apply)',

    TIER_DISPLAY: Object.freeze({
      // Economy (Jo, 2026-10-02): "only one year labor warranty, and then
      // just the limited warranty from the shingle package itself — no
      // system warranty." NOT the lifetime ladder the other tiers share.
      economy: Object.freeze({
        label: 'Economy',
        warranty: Object.freeze({ workmanshipYears: 1, systemWarranty: false, transferable: false, transferWindowDays: 0, inspection: false })
      }),
      // systemPlus (Jo, 2026-10-05: "System Plus is Standard and up"): the
      // GAF System Plus Limited Warranty is INCLUDED in Standard, Preferred
      // and Elite — built into the tier price, never a separate line. It is
      // GAF's manufacturer (materials) warranty on the GAF shingles and
      // qualifying GAF accessories, NOT a workmanship warranty (GAF's
      // workmanship coverage is Golden Pledge, Master Elite only). Economy
      // keeps the maker's standard limited warranty; Beyond is TAMKO HailGuard.
      good: Object.freeze({
        label: 'Standard',
        warranty: Object.freeze({ transferable: false, transferWindowDays: 0, inspection: false, systemPlus: true })
      }),
      better: Object.freeze({
        label: 'Preferred',
        warranty: Object.freeze({ transferable: true, transferWindowDays: 30, inspection: false, systemPlus: true })
      }),
      best: Object.freeze({
        label: 'Elite',
        warranty: Object.freeze({ transferable: true, transferWindowDays: 0, inspection: true, systemPlus: true })
      }),
      // Beyond: Elite's workmanship terms, on TAMKO HailGuard — the only
      // shingle with a manufacturer hail warranty. No GAF System Plus (not a
      // GAF roof).
      beyond: Object.freeze({
        label: 'Beyond',
        warranty: Object.freeze({ transferable: true, transferWindowDays: 0, inspection: true, hailWarranty: true })
      })
    }),

    // tierLabel(key) -> the customer-facing name ('Standard'/'Preferred'/
    // 'Elite'). Falls back to a capitalized version of an unknown/legacy
    // key so a bad tier value degrades to something readable, not a throw.
    // builtin === true skips the company override (tenant-rules.js asks for
    // NBD's own wording that way, to tell "saved the same text" from "changed it").
    tierLabel: function (tier, builtin) {
      var tr = builtin === true ? null : _tenantRules();
      var own = tr && typeof tr.labelOverride === 'function' ? tr.labelOverride(tier) : null;
      if (own) return own;
      var t = CFG.TIER_DISPLAY[tier];
      if (t) return t.label;
      return tier ? String(tier).charAt(0).toUpperCase() + String(tier).slice(1) : '';
    },

    // tierWarrantyText(key) -> the one sentence every generator should
    // print for that tier's workmanship guarantee (lifetime + transferability
    // model, replacing the 5/10/20-year scheme the audit found in 8+ places).
    // Kept as one formatted string, not just the raw object, so the wording
    // only ever needs to change here.
    tierWarrantyText: function (tier, builtin) {
      // A company's own warranty sentence (tenant-rules.js) wins; a company
      // that has not written one gets a neutral sentence, never NBD's
      // lifetime ladder below (2026-10-04). NBD: null → unchanged.
      var tr = builtin === true ? null : _tenantRules();
      var own = tr && typeof tr.warrantyTextOverride === 'function' ? tr.warrantyTextOverride(tier) : null;
      if (own != null) return own;
      var t = CFG.TIER_DISPLAY[tier];
      if (!t) return 'Lifetime workmanship warranty.';
      var w = t.warranty;
      if (w.workmanshipYears) {
        return w.workmanshipYears + '-year workmanship (labor) warranty; the shingle manufacturer\'s standard limited warranty applies. No system warranty.';
      }
      var parts = ['Lifetime workmanship warranty'];
      if (!w.transferable) {
        parts.push('does not transfer on sale of property');
      } else if (w.transferWindowDays) {
        parts.push('transferable to one subsequent owner within ' + w.transferWindowDays + ' days of sale');
      } else {
        parts.push('fully transferable — follows the property through all subsequent owners');
      }
      if (w.inspection) parts.push('annual courtesy inspection included');
      if (w.systemPlus) parts.push(CFG.SYSTEM_PLUS_TEXT);
      if (w.hailWarranty) parts.push('plus TAMKO\'s HailGuard hail warranty on the shingles (manufacturer terms apply)');
      return parts.join('; ') + '.';
    },

    // tierWarrantyBlurb(key) -> just the differentiator phrase (no "Lifetime
    // workmanship warranty" prefix), for compact spots — tier cards, badges —
    // where the duration is already stated once elsewhere on the page.
    tierWarrantyBlurb: function (tier, builtin) {
      var tr = builtin === true ? null : _tenantRules();
      var own = tr && typeof tr.warrantyBlurbOverride === 'function' ? tr.warrantyBlurbOverride(tier) : null;
      if (own != null) return own;
      var t = CFG.TIER_DISPLAY[tier];
      if (!t) return '';
      var w = t.warranty;
      if (w.workmanshipYears) return w.workmanshipYears + '-year labor warranty';
      if (w.hailWarranty) return 'Fully transferable + annual inspection + hail warranty';
      var sp = w.systemPlus ? ' + GAF System Plus' : '';
      if (!w.transferable) return 'Non-transferable' + sp;
      if (w.transferWindowDays) return 'Transferable to 1 subsequent owner' + sp;
      return (w.inspection ? 'Fully transferable + annual inspection' : 'Fully transferable') + sp;
    },

    // ── Workmanship warranty by JOB TYPE (2026-09-25, Jo-confirmed) ──
    // The tier-display block above is ROOFING's guarantee ladder. Job
    // Templates cover eleven trades, and every one of their estimates was
    // saving tier 'better' by default, so gutter, repair and inspection
    // paperwork printed "Preferred" and a LIFETIME workmanship warranty
    // while NBD's written proposals say 2 years
    // (documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md). Each Job
    // Template now declares a `warrantyKind` (job-templates-data.js — explicit
    // data, reviewed per template), and this table turns a kind into years:
    //   gutter_system   — a NEW gutter system
    //   guard_only      — leaf protection over existing gutters
    //   install_default — every other install/replacement (soffit & fascia,
    //                     ventilation, flashing, exterior, specialty); matches
    //                     Jo's written proposals
    //   repair          — 1 year, but ONLY when the rep ticks the per-estimate
    //                     "1-year workmanship warranty" box. Off by default:
    //                     some repairs get no warranty, depending on severity.
    //                     Temporary emergency work (tarp, stopgap, board-up)
    //                     is this kind too: none by default, rep's choice.
    //   none            — inspections, documentation, cleaning, washing and
    //                     moss treatment (no workmanship to warrant, no box)
    //   roof            — NOT a year count: roofing keeps the tier wording
    //                     above (tierWarrantyText) byte-for-byte.
    // Defaults only — tenant-overridable later. The sentence is built by
    // NBDCustomerEstimateRows.estimateWarranty(), which reads this table and
    // carries a copy for pages that don't load this file (customer.html);
    // tests/job-template-honest-paperwork.test.js pins the two together.
    WORKMANSHIP_WARRANTY: Object.freeze({
      gutter_system:   Object.freeze({ years: 5 }),
      guard_only:      Object.freeze({ years: 2 }),
      install_default: Object.freeze({ years: 2 }),
      repair:          Object.freeze({ years: 1, optIn: true }),
      none:            Object.freeze({ years: 0 }),
      roof:            Object.freeze({ tierWording: true })
    }),

    // Deposit rule thresholds (Jo, 2026-09-25). Read by deposit-rule.js — the
    // ONE function every quote, contract, invoice, portal and deal-room
    // deposit comes from (the app had a 50/50, a 25%, a $0 and a "Fifty
    // percent" deposit live at once). Cash under $2,000: no deposit; cash
    // $2,000+: 50% at signing, rounded to the nearest $25; insurance: the
    // deductible + the ACV payment (not a threshold, so not configured here).
    // Defaults only — tenant-overridable later. deposit-rule.js carries a copy
    // for pages that don't load this file (customer.html);
    // tests/deposit-rule.test.js pins the two together.
    DEPOSIT_RULE: Object.freeze({
      CASH_NO_DEPOSIT_UNDER_CENTS: 200000,
      CASH_DEPOSIT_PCT: 50,
      CASH_DEPOSIT_ROUND_TO_CENTS: 2500
    }),

    // Source-of-truth marker — engines log this to Sentry on
    // load so we can correlate "classic engine ran but V2 config
    // didn't load" cases if they ever happen.
    _version: '2026-10-02',
    // Tier-rate generation. A device's saved Settings tier rates are honoured
    // only if saved under THIS version, so a device that once saved
    // 545/595/660 falls back to the rates above instead of quietly quoting
    // the old prices (estimate-builder-v2.js loadSettings). Bump it whenever
    // TIER_RATES change.
    _ratesVersion: '2026-10-02',
    _loadedFrom: 'estimate-config.js'
  });

  if (typeof window !== 'undefined') {
    window.NBD_ESTIMATE_CONFIG = CFG;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CFG;
  }
})();
