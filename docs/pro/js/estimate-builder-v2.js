/*! © 2026 No Big Deal Home Solutions — All Rights Reserved. Proprietary; no license granted — see LICENSE at the repo root. https://nobigdealwithjoedeal.com */
// ============================================================
// NBD Pro — Estimate Builder v2 Pricing Engine
// Locked spec: memory/site_wide_spec_20260410.md
//
// Two pricing modes, both locked to the same spec:
//   1. PER-SQ MODE:    Flat per-SQ rates ($545/$595/$660) +
//                      smart add-ons. Fastest for cash jobs.
//   2. LINE-ITEM MODE: Full material + labor breakdown with
//                      overhead + profit (OH&P) markup.
//                      Matches Xactimate-style insurance
//                      supplements.
//
// User picks mode per estimate. Pure JS — no DOM, no Firebase.
// Safe to import anywhere.
// ============================================================

(function () {
  'use strict';

  // ═════════════════════════════════════════════════════════
  // SECTION 1 — Locked Spec Constants (Per-SQ mode)
  // ═════════════════════════════════════════════════════════
  //
  // Source of truth: estimate-config.js (Rock 2 PR 3).
  // Browser path uses window.NBD_ESTIMATE_CONFIG; Node tests
  // require('./estimate-config') — module.exports is the same
  // frozen object. Inline fallbacks preserve historical values
  // if the config module isn't reachable (e.g., a partial
  // deploy). Engine still prices on stale-but-correct numbers
  // and surfaces a Sentry breadcrumb so we know.

  let _NBD_CFG = (typeof window !== 'undefined' && window.NBD_ESTIMATE_CONFIG) || null;
  if (!_NBD_CFG && typeof require === 'function') {
    try { _NBD_CFG = require('./estimate-config'); } catch (_) { _NBD_CFG = null; }
  }
  if (!_NBD_CFG && typeof console !== 'undefined') {
    try { console.warn('[EstimateBuilderV2] NBD_ESTIMATE_CONFIG missing — using inline fallbacks. Check that estimate-config.js loaded first.'); } catch (_) {}
  }

  // Per-SQ flat rates (Joe's contractor pricing)
  const TIER_RATES = (_NBD_CFG && _NBD_CFG.TIER_RATES) || {
    economy: 440,  // Economy-grade architectural (never 3-tab), 1-yr labor
    good:    550,  // Standard system + standard accessories
    better:  660,  // Upgraded materials + system warranty
    best:    770,  // Impact-rated + workmanship warranty package
    beyond:  880   // TAMKO HailGuard only
  };
  // A device's saved tier rates must carry this to be honoured (loadSettings).
  const TIER_RATES_VERSION = (_NBD_CFG && _NBD_CFG._ratesVersion) || '2026-10-02';
  // Every tier, cheapest first (estimate-config.js TIER_ORDER).
  const TIER_ORDER = (_NBD_CFG && _NBD_CFG.TIER_ORDER) || ['economy', 'good', 'better', 'best', 'beyond'];

  // Cost basis per SQ (Internal-view margin calc). SHIPPED AS ZEROS on
  // purpose (2026-08-10): this file is world-readable (docs/ is the hosting
  // root AND the repo is public), and the previous defaults were the shop's
  // REAL per-SQ costs sitting next to the public tier rates — the same
  // confidentiality class the 2026-06 catalog scrub removed for 187 SKUs
  // (see tests/catalog-cost-privacy.test.js, which now pins these at 0).
  // Real cost basis is tenant data: set it in Estimate Settings (the
  // v2cost* fields) and it merges in via loadSettings(). A zero basis means
  // "not configured" — the margin fields come back null and the Internal
  // View shows an em-dash, never a fake 100% margin.
  const DEFAULT_COST_BASIS = {
    economy: 0,
    good:    0,
    better:  0,
    best:    0,
    beyond:  0
  };

  // Add-on COST ratio (Internal-view margin calc, 2026-08-19).
  //
  // What this replaces: a single blanket `addOnsTotal * 0.4`, i.e. "every
  // add-on carries a 60% margin". Two of the fifteen are third-party
  // PASS-THROUGHS and carry none — the permit is remitted to the jurisdiction
  // in full, and the dump fee is the hauler's invoice. LINE-ITEM mode has
  // always costed both at face value: generateLineItemsFromMeasurements sets
  // the permit line's materialCost to the permit fee itself, and the CATALOG
  // entries below carry `cost` equal to the fee for 'dump-fee' and
  // 'permit-fee'. Per-SQ was the outlier, and on a job carrying both it
  // assumed well under half their real cost — overstating margin by several
  // hundred dollars in the view the shop prices against. Nothing the homeowner
  // is charged changes; this is the internal number only.
  //
  // The other twelve are real work (steep/story/cut-up/access labour,
  // flashing, valley metal, gutters, extra boots) and keep 0.4 — the
  // pre-existing figure, unchanged, now named instead of inline. It is still
  // an ASSUMPTION: no measured cost basis for per-SQ add-on work exists
  // anywhere in the repo, and none was invented here.
  //
  // Per-key overrides live in settings (`addonCostRatios`), the same home as
  // costBasis and for the same reason — a shop's real ratios are tenant data
  // and this file is world-readable. Nothing sensitive is published here: that
  // a permit is remitted in full is a fact about permits, not about NBD.
  const ADDON_COST_PASS_THROUGH = ['permit', 'dumpFee'];
  const DEFAULT_ADDON_COST_RATIO = 0.4;

  /** Cost-to-charge ratio for one per-SQ add-on. Tenant override wins. */
  function _addonCostRatio(s, key) {
    const raw = s && s.addonCostRatios ? s.addonCostRatios[key] : undefined;
    // Same rule as applyCompanyPricing's sane(): a blank or missing editor
    // field ('' / null / undefined / NaN) is DROPPED so the default stands,
    // but a literal 0 IS honored. Number('') and Number(null) are both 0, so
    // testing finiteness alone would read an empty field as "this add-on costs
    // nothing" — understating cost, which is the very defect being fixed here.
    if (raw === '' || raw == null) return _addonCostRatioDefault(key, s);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return _addonCostRatioDefault(key, s);
    return n;
  }

  function _addonCostRatioDefault(key, s) {
    if (key === 'matDelivery') return _matDeliveryCostRatio(s);
    return ADDON_COST_PASS_THROUGH.indexOf(key) >= 0 ? 1 : DEFAULT_ADDON_COST_RATIO;
  }

  const MIN_JOB_CHARGE          = (_NBD_CFG && _NBD_CFG.JOB_MINIMUM_DOLLARS)            || 2500;  // Kicks in below ~4.5 SQ
  const ROUND_TO                = (_NBD_CFG && _NBD_CFG.ROUND_TO_DOLLARS)               || 25;    // Round grand total to nearest $25
  const TEAR_OFF_EXTRA_PER_SQ   = (_NBD_CFG && _NBD_CFG.TEAR_OFF_EXTRA_PER_SQ_DOLLARS)  || 50;    // $50/SQ per extra layer
  const DEFAULT_DUMP_FEE        = (_NBD_CFG && _NBD_CFG.DEFAULT_DUMP_FEE)               || 550;   // Flat default
  const CUT_UP_ROOF_WASTE_BONUS = (_NBD_CFG && _NBD_CFG.CUT_UP_ROOF_WASTE_BONUS)        || 0.03;  // +3% waste for cut-up roofs

  // Permit costs by county (7 jurisdictions from the spec). Canonical table
  // is estimate-config.js PERMIT_COSTS_BY_COUNTY (PR 3b) — same slug →
  // {name, cost} shape, read directly. Inline fallback preserves historical
  // values if the config didn't load.
  const PERMIT_COSTS = (_NBD_CFG && _NBD_CFG.PERMIT_COSTS_BY_COUNTY) || {
    'hamilton-oh': { name: 'Hamilton County, OH', cost: 185 },
    'butler-oh':   { name: 'Butler County, OH',   cost: 150 },
    'warren-oh':   { name: 'Warren County, OH',   cost: 165 },
    'clermont-oh': { name: 'Clermont County, OH', cost: 170 },
    'kenton-ky':   { name: 'Kenton County, KY',   cost: 125 },
    'boone-ky':    { name: 'Boone County, KY',    cost: 135 },
    'campbell-ky': { name: 'Campbell County, KY', cost: 130 }
  };

  // C-1 (estimate-remediation-2026-06-09): permit fail-safe. When the job's
  // jurisdiction isn't in PERMIT_COSTS (county left blank or off-list), V2 used
  // to charge $0 permit — silently under-quoting a real cost and leaving an
  // incomplete insurance scope. Fall back to the same default the classic engine
  // uses (estimates.js DEFAULT_PERMIT_COST = 150). It is rep-overridable on the
  // estimate, so a job that genuinely needs no permit can still be zeroed out.
  const DEFAULT_PERMIT_COST = (_NBD_CFG && _NBD_CFG.DEFAULT_PERMIT_COST) || 150;

  // Sales tax by county. Canonical table is estimate-config.js COUNTY_TAX
  // (PR 3b, slug → {name, rate}); V2 keys rates by the same slug, so map
  // each entry to its rate. Inline fallback preserves historical values.
  const COUNTY_TAX = (_NBD_CFG && _NBD_CFG.COUNTY_TAX)
    ? Object.fromEntries(Object.entries(_NBD_CFG.COUNTY_TAX).map(([slug, c]) => [slug, c.rate]))
    : {
        'hamilton-oh': 0.0780,
        'butler-oh':   0.0725,
        'warren-oh':   0.0675,
        'clermont-oh': 0.0725,
        'kenton-ky':   0.0600,
        'boone-ky':    0.0600,
        'campbell-ky': 0.0600
      };
  const FALLBACK_TAX_RATE = (_NBD_CFG && _NBD_CFG.DEFAULT_TAX_RATE) || 0.07;

  // Per-SQ mode add-on unit prices.
  // chimneyFlash + skylightFlash are unified with classic via
  // estimate-config.js (Rock 2 PR 4b — chimney $425, skylight $350,
  // Joe-confirmed). The other two (valleyMetalLf, guttersLf) remain engine-local pending
  // a separate decision; Joe flagged them as "low margin" so the
  // value drift isn't material yet.
  const ADDON_PRICES = {
    chimneyFlash:   (_NBD_CFG && _NBD_CFG.ADDON_CHIMNEY_FLASH)  || 425,
    skylightFlash:  (_NBD_CFG && _NBD_CFG.ADDON_SKYLIGHT_FLASH) || 350,
    valleyMetalLf:  8.50,
    guttersLf:      8.50,
    // When pipe count > 4. Unified with classic via config (D-4, $85).
    extraPipeBoot:  (_NBD_CFG && _NBD_CFG.ADDON_EXTRA_PIPE_BOOT) || 85,
    // Per-SQ complexity adders (Phase 1, Joe-confirmed 2026-06-08; config-backed
    // so they don't drift via stale localStorage). Pitch tiers STACK; story +
    // access tiers REPLACE; cut-up labor is on top of the +3% material waste.
    steepPerSq:            (_NBD_CFG && _NBD_CFG.ADDON_STEEP_PER_SQ)            || 25,   // 8/12+
    verySteepPerSq:        (_NBD_CFG && _NBD_CFG.ADDON_VERY_STEEP_PER_SQ)       || 45,   // 12/12+
    extremeSteepPerSq:     (_NBD_CFG && _NBD_CFG.ADDON_EXTREME_STEEP_PER_SQ)    || 75,   // 16/12+
    twoStoryPerSq:         (_NBD_CFG && _NBD_CFG.ADDON_TWO_STORY_PER_SQ)        || 15,
    threeStoryPerSq:       (_NBD_CFG && _NBD_CFG.ADDON_THREE_STORY_PER_SQ)      || 30,
    cutUpPerSq:            (_NBD_CFG && _NBD_CFG.ADDON_CUTUP_PER_SQ)            || 15,
    accessModeratePerSq:   (_NBD_CFG && _NBD_CFG.ADDON_ACCESS_MODERATE_PER_SQ)  || 15,
    accessDifficultPerSq:  (_NBD_CFG && _NBD_CFG.ADDON_ACCESS_DIFFICULT_PER_SQ) || 35,
    // Material delivery + fuel surcharge — FLAT per JOB, never per SQ. A
    // delivery trip does not scale with roof size, and amortising a flat fee
    // into costBasis[tier] (a per-SQ number) is exact at exactly one job size
    // — see documentation/audit/CATALOG-UNDER-COST-2026-08-19.md finding 1.
    // $150 per job (Jo, 2026-09-27; was 412.50).
    matDelivery:    (_NBD_CFG && _NBD_CFG.ADDON_MAT_DELIVERY)    || 150
  };

  // ═════════════════════════════════════════════════════════
  // SECTION 2 — Line-Item Material Catalog
  // ═════════════════════════════════════════════════════════
  // Each entry defines material cost + install labor cost.
  // Tier variants let the engine swap shingles/underlayment
  // when the user toggles Good/Better/Best.
  //
  // cost       = unit material cost (what Joe pays supplier)
  // labor      = install labor per unit
  // unit       = 'SQ' | 'LF' | 'EA' | 'JOB' | 'SF'
  // category   = for grouping in the line-item view
  // ═════════════════════════════════════════════════════════

  const CATALOG = {
    // ── SHINGLES (tier-dependent) ──
    'shingle-good': {
      code: 'RFG-SHNG', name: 'Architectural Shingles 30yr',
      category: 'shingles', unit: 'SQ',
      cost: 115.00, labor: 65.00
    },
    'shingle-better': {
      code: 'RFG-SHNG', name: 'Architectural Shingles Lifetime',
      category: 'shingles', unit: 'SQ',
      cost: 135.00, labor: 65.00
    },
    'shingle-best': {
      code: 'RFG-IMPCT', name: 'Impact-Rated Shingles Class 4 · 50yr',
      category: 'shingles', unit: 'SQ',
      cost: 175.00, labor: 75.00
    },

    // ── UNDERLAYMENT (tier-dependent) ──
    'underlayment-good': {
      code: 'RFG-FELT', name: 'Synthetic Underlayment',
      category: 'underlayment', unit: 'SQ',
      cost: 22.00, labor: 12.00
    },
    'underlayment-better': {
      code: 'RFG-FELT', name: 'Premium Synthetic Underlayment',
      category: 'underlayment', unit: 'SQ',
      cost: 28.00, labor: 12.00
    },
    'underlayment-best': {
      code: 'RFG-FELT', name: 'High-Temp Synthetic Underlayment',
      category: 'underlayment', unit: 'SQ',
      cost: 38.00, labor: 12.00
    },

    // ── ICE & WATER SHIELD ──
    'ice-water': {
      code: 'RFG-IWS', name: 'Ice & Water Shield',
      category: 'underlayment', unit: 'SQ',
      cost: 85.00, labor: 22.00
    },

    // ── STARTER STRIP ──
    'starter-strip': {
      code: 'RFG-STRT', name: 'Starter Strip Shingles',
      category: 'accessories', unit: 'LF',
      cost: 1.85, labor: 0.80
    },

    // ── DRIP EDGE ──
    'drip-edge': {
      code: 'RFG-DRPE', name: 'Drip Edge Aluminum',
      category: 'metal', unit: 'LF',
      cost: 1.95, labor: 0.65
    },

    // ── RIDGE / HIP CAP ──
    'ridge-cap-good': {
      code: 'RFG-RIDG', name: 'Ridge Cap Shingles',
      category: 'accessories', unit: 'LF',
      cost: 4.25, labor: 1.85
    },
    'ridge-cap-best': {
      code: 'RFG-RIDG', name: 'Premium Ridge Cap (Impact-Rated)',
      category: 'accessories', unit: 'LF',
      cost: 5.85, labor: 1.85
    },

    // ── RIDGE VENT ──
    'ridge-vent': {
      code: 'RFG-VENT', name: 'Ridge Vent — Continuous',
      category: 'ventilation', unit: 'LF',
      cost: 3.25, labor: 1.50
    },
    'ridge-vent-premium': {
      code: 'RFG-VENT', name: 'RoofIVents 50yr Ridge Vent',
      category: 'ventilation', unit: 'LF',
      cost: 6.50, labor: 1.50
    },

    // ── PIPE BOOTS ──
    'pipe-boot-standard': {
      code: 'RFG-PIPE', name: 'Pipe Boot / Plumbing Flashing',
      category: 'flashing', unit: 'EA',
      cost: 18.00, labor: 28.00
    },
    'pipe-boot-premium': {
      code: 'RFG-PIPE', name: 'GAF Masterflow Pivot Boot 50yr',
      category: 'flashing', unit: 'EA',
      cost: 42.00, labor: 28.00
    },

    // ── FLASHING ──
    'chimney-flashing': {
      code: 'RFG-CHIM', name: 'Chimney Flashing Kit',
      category: 'flashing', unit: 'EA',
      cost: 125.00, labor: 160.00
    },
    'skylight-flashing': {
      code: 'RFG-SKY', name: 'Skylight Flashing Kit',
      category: 'flashing', unit: 'EA',
      cost: 165.00, labor: 185.00
    },
    'valley-metal': {
      code: 'RFG-VLY', name: 'Valley Metal W-Profile',
      category: 'metal', unit: 'LF',
      cost: 3.85, labor: 4.65
    },
    'step-flashing': {
      code: 'RFG-STPF', name: 'Step Flashing',
      category: 'flashing', unit: 'LF',
      cost: 2.25, labor: 2.50
    },

    // ── DECKING ──
    'osb-decking': {
      code: 'RFG-DECK', name: 'OSB Decking 7/16" — Replacement',
      category: 'decking', unit: 'SF',
      cost: 0.85, labor: 0.85
    },

    // ── NAILS / FASTENERS ──
    'nails-standard': {
      code: 'RFG-NAIL', name: 'Coil Roofing Nails',
      category: 'fasteners', unit: 'SQ',
      cost: 4.50, labor: 0
    },
    'nails-lumanail': {
      code: 'RFG-NAIL-LUMA', name: 'LumaNails Ring-Shank Fasteners',
      category: 'fasteners', unit: 'SQ',
      cost: 7.50, labor: 0,
      packaging: { unit: 'Box', coverage: 10, costPerBox: 75 }
    },

    // ── LABOR-ONLY LINES ──
    'tear-off': {
      code: 'RFG-TEAR', name: 'Tear Off Existing Roof Covering',
      category: 'labor', unit: 'SQ',
      cost: 0, labor: 65.00
    },
    'tear-off-extra-layer': {
      code: 'RFG-TEAR', name: 'Tear Off Additional Layer',
      category: 'labor', unit: 'SQ',
      cost: 0, labor: 50.00
    },

    // ── DISPOSAL / DUMP ──
    'dump-fee': {
      code: 'HAUL-DUMP', name: 'Dumpster & Haul-Away',
      category: 'disposal', unit: 'JOB',
      cost: 550.00, labor: 0
    },

    // ── PERMIT ──
    'permit-fee': {
      code: 'PERMIT', name: 'Building Permit',
      category: 'permit', unit: 'JOB',
      cost: 185.00, labor: 0
    },

    // ── GUTTERS ──
    'gutters-5in': {
      code: 'GUT-5IN', name: 'Seamless Aluminum Gutters 5"',
      category: 'gutters', unit: 'LF',
      cost: 4.85, labor: 3.65
    },
    'gutters-6in': {
      code: 'GUT-6IN', name: 'Seamless Aluminum Gutters 6"',
      category: 'gutters', unit: 'LF',
      cost: 5.45, labor: 4.05
    }
  };

  // Economy and Beyond shingles (2026-10-02). Copies of the Good / Best
  // entries' published starter figures under the tier's own name — no new
  // cost literals (the starter baseline is a counted ledger, see
  // tests/catalog-cost-privacy.test.js). Economy is Jo's pick of an
  // economy-grade architectural (never a 3-tab); Beyond is TAMKO HailGuard
  // only, the one shingle with a manufacturer hail warranty.
  CATALOG['shingle-economy'] = Object.assign({}, CATALOG['shingle-good'], {
    code: 'RFG-SHNG', name: 'Architectural Shingles — Economy Grade (never 3-tab)'
  });
  CATALOG['shingle-beyond'] = Object.assign({}, CATALOG['shingle-best'], {
    code: 'RFG-IMPCT', name: 'TAMKO HailGuard Class 4 (manufacturer hail warranty)'
  });

  // Tier → material variant picker
  const TIER_MATERIAL_MAP = {
    economy: {
      shingle:     'shingle-economy',
      underlayment:'underlayment-good',
      ridgeCap:    'ridge-cap-good',
      ridgeVent:   'ridge-vent',
      pipeBoot:    'pipe-boot-standard',
      nails:       'nails-standard'
    },
    good: {
      shingle:     'shingle-good',
      underlayment:'underlayment-good',
      ridgeCap:    'ridge-cap-good',
      ridgeVent:   'ridge-vent',
      pipeBoot:    'pipe-boot-standard',
      nails:       'nails-standard'
    },
    better: {
      shingle:     'shingle-better',
      underlayment:'underlayment-better',
      ridgeCap:    'ridge-cap-good',
      ridgeVent:   'ridge-vent',
      pipeBoot:    'pipe-boot-standard',
      nails:       'nails-standard'
    },
    best: {
      shingle:     'shingle-best',
      underlayment:'underlayment-best',
      ridgeCap:    'ridge-cap-best',
      ridgeVent:   'ridge-vent-premium',
      pipeBoot:    'pipe-boot-premium',
      nails:       'nails-lumanail'
    },
    beyond: {
      shingle:     'shingle-beyond',
      underlayment:'underlayment-best',
      ridgeCap:    'ridge-cap-best',
      ridgeVent:   'ridge-vent-premium',
      pipeBoot:    'pipe-boot-premium',
      nails:       'nails-lumanail'
    }
  };

  // ═════════════════════════════════════════════════════════
  // SECTION 3 — OH&P Markup Defaults
  // ═════════════════════════════════════════════════════════
  const DEFAULT_OVERHEAD_PCT = 0.10;  // 10% overhead
  const DEFAULT_PROFIT_PCT   = 0.10;  // 10% profit
  const DEFAULT_MATERIAL_MARKUP_PCT = 0.25; // 25% baked into materials

  // Material-delivery COST. Neither shipped bucket fits, and a fixed FRACTION
  // of the charge does not fit either: the charge is shop-editable
  // (applyCompanyPricing merges companyProfile.pricing.addonPrices) and the
  // add-on reducer scales the ratio by the CHARGED cents, so a shop that
  // lowered the price would silently book less cost than the supplier bills.
  // A delivery invoice does not shrink because the shop discounted the job.
  // So cost is PINNED to the baseline the charge was built from and the ratio
  // is derived per call: in integer cents it lands dead on the baseline at any
  // charge, and a charge of 0 books 0 because the reducer skips zero-charge
  // keys. Nothing about NBD is published — the baseline is the already-public
  // 'MAT DEL' figure divided back out by two already-published rates.
  // Tenant escape hatch, unchanged: settings.addonCostRatios.matDelivery.
  //
  // Declared HERE, not beside ADDON_COST_PASS_THROUGH where it reads more
  // naturally: the three rates above are declared ~290 lines below that block,
  // so a top-level const there would throw a TDZ ReferenceError at load.
  //
  // 2026-09-27: the default CHARGE dropped to $150 (Jo). The baseline used to
  // be derived from that default (charge / chain), which would have quietly
  // cut the modelled delivery cost with the price. It is now pinned to the
  // line-item 'MAT DEL' retail figure the charge was originally built from,
  // so the cost the margin report books is unchanged whatever is charged.
  const MAT_DELIVERY_MARKUP_CHAIN =
    (1 + DEFAULT_MATERIAL_MARKUP_PCT) * (1 + DEFAULT_OVERHEAD_PCT + DEFAULT_PROFIT_PCT);
  const MAT_DELIVERY_LINE_RETAIL = 412.50; // 'MAT DEL' at the default ladder — a published retail figure
  const MAT_DELIVERY_BASELINE = MAT_DELIVERY_LINE_RETAIL / MAT_DELIVERY_MARKUP_CHAIN;

  /** Default cost/charge ratio for material delivery: baseline / what we charge. */
  function _matDeliveryCostRatio(s) {
    const charged = Number(s && s.addonPrices ? s.addonPrices.matDelivery : NaN);
    if (!Number.isFinite(charged) || charged <= 0) return 1 / MAT_DELIVERY_MARKUP_CHAIN;
    return MAT_DELIVERY_BASELINE / charged;
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 4 — Pure Helpers
  // ═════════════════════════════════════════════════════════

  function parsePitch(pitch) {
    if (pitch == null || pitch === '') return 0.667;
    if (typeof pitch === 'number') return pitch;
    const parts = String(pitch).split('/');
    if (parts.length === 2) {
      const rise = parseFloat(parts[0]);
      const run  = parseFloat(parts[1]) || 12;
      return run > 0 ? rise / run : 0.667;
    }
    const n = parseFloat(pitch);
    return isNaN(n) ? 0.667 : n;
  }

  function wasteFactorForPitch(pitchRatio) {
    if (pitchRatio <= 0.33) return 1.12;
    if (pitchRatio <= 0.50) return 1.15;
    if (pitchRatio <= 0.75) return 1.17;
    if (pitchRatio <= 1.00) return 1.20;
    return 1.25;
  }

  function extraPipeBootCharge(pipeCount, unitPrice) {
    const rate = unitPrice != null ? Number(unitPrice) : ADDON_PRICES.extraPipeBoot;
    return pipeCount > 4 ? (pipeCount - 4) * rate : 0;
  }

  function roundToNearest(value, step) {
    const s = step || ROUND_TO;
    return Math.round(value / s) * s;
  }

  // ── Cents helpers (2026-08-07) ──────────────────────────────
  // All money math in both calculation paths runs in INTEGER CENTS and
  // converts back to dollars only at the return boundary — mirroring the
  // classic engine's discipline (estimates.js _toCents/_fromCents). Before
  // this, subtotal/tax/overhead/profit/deposit were raw float products and
  // were PERSISTED un-rounded (estimate-v2-ui save path), so stored docs
  // carried $x.xx000000004-class artifacts into the portal/invoice/Stripe
  // readers. Settings and inputs stay in dollars (the public contract and
  // every tenant override are dollar-denominated); conversion happens at
  // calculation entry. For integer cents c, c/100 is the exact same double
  // as the 2-dp decimal literal, so returned dollars are exactly 2-dp.
  const _toCents = (d) => Math.round((Number(d) || 0) * 100);
  const _fromCents = (c) => c / 100;
  function _roundToNearestCents(cents, stepCents) {
    const s = stepCents > 0 ? stepCents : ROUND_TO_CENTS_DEFAULT;
    return Math.round(cents / s) * s;
  }
  // Canonical integer defaults from estimate-config's _CENTS twins (published
  // for exactly this purpose — "the 100x unit-mismatch trap" note there).
  const MIN_JOB_CHARGE_CENTS_DEFAULT = (_NBD_CFG && _NBD_CFG.JOB_MINIMUM_CENTS) || _toCents(MIN_JOB_CHARGE);
  const ROUND_TO_CENTS_DEFAULT       = (_NBD_CFG && _NBD_CFG.ROUND_TO_CENTS)    || _toCents(ROUND_TO);

  // Deposit (2026-09-25): the ONE rule lives in deposit-rule.js
  // (window.NBDDepositRule) — cash under $2,000 no deposit, cash $2,000+ 50%
  // at signing ($25-rounded), insurance = the deductible + the ACV payment.
  // This used to be its own copy ("cash 50%, insurance $0 down") and was one
  // of five deposit answers live at once. Kept as a thin adapter because the
  // classic builder and the engine results below still read the legacy
  // {pct, amount, remainder} shape; `plan` carries the rule's full answer.
  //   opts.overridePct  — an existing rep override (classic "Override %")
  //   opts.deductible / opts.acv — insurance claim figures, when known
  //   opts.roundTo      — the tenant's rounding step, dollars
  // No rule loaded (a vm sandbox that loads only this file) → zeros and a
  // null plan: the engine still prices, and no deposit is invented here.
  function _depositRule() {
    if (typeof window !== 'undefined' && window.NBDDepositRule) return window.NBDDepositRule;
    if (typeof require === 'function') {
      try { return require('./deposit-rule.js'); } catch (_) { /* browser / sandbox */ }
    }
    return null;
  }
  function calcDeposit(total, mode, opts) {
    const o = opts || {};
    const rule = _depositRule();
    const totalCents = (Number(total) > 0) ? _toCents(total) : 0;
    if (!rule || !(totalCents > 0)) {
      return { pct: 0, amount: 0, remainder: _fromCents(totalCents), plan: null };
    }
    const input = {
      totalCents,
      mode,
      deductible: o.deductible,
      acv: o.acv,
      overridePct: o.overridePct,
      roundToCents: (Number(o.roundTo) > 0) ? _toCents(o.roundTo) : undefined
    };
    // Kentucky hold (2026-09-27): only when the caller knows the address.
    if (Object.prototype.hasOwnProperty.call(o, 'address')) input.address = o.address;
    const plan = rule.compute(input);
    return { pct: plan.pct, amount: _fromCents(plan.depositCents), remainder: _fromCents(plan.balanceCents), plan };
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 5 — Settings (localStorage, immutable updates)
  // ═════════════════════════════════════════════════════════

  // v3 (estimate-qa-2026-06-08): bumped so legacy v2 snapshots — which carried
  // stale pricing (the L-1 chimney-$285 bug) — are dropped. Pricing now resolves
  // from estimate-config.js + companyProfile, never from a saved snapshot.
  const SETTINGS_KEY = 'nbd_est_settings_v3';

  function getDefaultSettings() {
    return {
      // Shared
      mode: 'per-sq',                  // default mode
      minJobCharge: MIN_JOB_CHARGE,
      dumpFee: DEFAULT_DUMP_FEE,
      permits: JSON.parse(JSON.stringify(PERMIT_COSTS)),
      countyTax: Object.assign({}, COUNTY_TAX),
      fallbackTaxRate: FALLBACK_TAX_RATE,
      internalView: false,
      roundTo: ROUND_TO,

      // Per-SQ mode
      tierRates:  Object.assign({}, TIER_RATES),
      costBasis:  Object.assign({}, DEFAULT_COST_BASIS),
      addonCostRatios: {},             // per-add-on cost/charge overrides (tenant data)
      tearOffExtraPerSq: TEAR_OFF_EXTRA_PER_SQ,
      addonPrices: Object.assign({}, ADDON_PRICES),

      // Line-item mode
      // Repair minimum: 0 = no floor, and that is the correct default. The
      // per-SQ minJobCharge above exists for an undersized ROOF REPLACEMENT;
      // applying it to a hand-built repair is what quoted a $555 pipe-boot
      // job at $2,500 (#1470). A tenant who wants a trip charge on small
      // work sets this one deliberately.
      minRepairCharge: 0,
      overheadPct: DEFAULT_OVERHEAD_PCT,
      profitPct: DEFAULT_PROFIT_PCT,
      materialMarkupPct: DEFAULT_MATERIAL_MARKUP_PCT,
      catalog: JSON.parse(JSON.stringify(CATALOG))   // Copy so per-user edits don't mutate constants
    };
  }

  function loadSettings() {
    try {
      const raw = typeof localStorage !== 'undefined'
        ? localStorage.getItem(SETTINGS_KEY)
        : null;
      // loadSettings() STAYS PURE — no tenant overlay here, by contract
      // (tests/custom-jurisdictions.test.js: "getCountyTaxMap does not bake the
      // overlay into loadSettings"). The county overlay is applied at CALC time
      // so a late-arriving companyProfile is honored, and the cost overlay
      // rides exactly the same rule for exactly the same reason: a cost book
      // that lands after boot must still reach the next price. Both are applied
      // at the two pricing entry points below.
      if (!raw) return getDefaultSettings();
      const saved = JSON.parse(raw);
      const defaults = getDefaultSettings();
      // Saved tier rates count only when saved under the current rate
      // generation (estimate-config.js _ratesVersion). 2026-10-02: the five-
      // tier repricing would otherwise be silently overridden on every device
      // that ever pressed Save with the old 545/595/660.
      const savedRates = (saved.tierRatesVersion && saved.tierRatesVersion === TIER_RATES_VERSION) ? (saved.tierRates || {}) : {};
      // Merge conservatively so any new fields always exist
      const merged = Object.assign({}, defaults, saved, {
        tierRates:   Object.assign({}, defaults.tierRates, savedRates),
        costBasis:   Object.assign({}, defaults.costBasis, saved.costBasis || {}),
        addonCostRatios: Object.assign({}, defaults.addonCostRatios, saved.addonCostRatios || {}),
        permits:     Object.assign({}, defaults.permits, saved.permits || {}),
        countyTax:   Object.assign({}, defaults.countyTax, saved.countyTax || {}),
        catalog:     Object.assign({}, defaults.catalog, saved.catalog || {})
      });
      // L-1 kill (estimate-qa-2026-06-08): ADD-ON PRICES (the chimney-$285 bug)
      // come from estimate-config.js + the shop-wide companyProfile override only,
      // NEVER from a saved localStorage snapshot. Forcing them is non-breaking
      // because add-on prices have no localStorage editor (tier rates / dump fee
      // keep their existing Settings editor; companyProfile still overrides ALL of
      // them at calc time via applyCompanyPricing).
      merged.addonPrices = Object.assign({}, defaults.addonPrices);
      return merged;
    } catch (e) {
      console.warn('Failed to load estimate settings, using defaults:', e);
      return getDefaultSettings();
    }
  }

  function saveSettings(next) {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return true;
    } catch (e) {
      console.warn('Failed to save estimate settings:', e);
      return false;
    }
  }

  function updateSettings(patch) {
    const current = loadSettings();
    const next = Object.assign({}, current, patch);
    saveSettings(next);
    return next;
  }

  // Shop-wide pricing override (estimate-qa-2026-06-08). companyProfile.pricing
  // (Firestore, per-tenant) wins over the config-default settings, resolved AT
  // CALC TIME so a post-boot _loadCompanyProfile arrival is honored. Inverse of the
  // L-1 trap: config default < shop override, never < a stale localStorage snapshot.
  // In Node (no window) there's no companyProfile → settings (= config) stand.
  function applyCompanyPricing(s) {
    const cp = (typeof window !== 'undefined' && window._companyProfile && window._companyProfile.pricing) || null;
    if (!cp) return s;
    // Only overlay FINITE-NUMBER overrides. A blank/garbage editor field ('' / null
    // / NaN) must NOT silently zero a charge (the L-1 under-pricing class) — it's
    // dropped so the config rate stands. A literal numeric 0 IS honored (a shop
    // intentionally making an add-on free).
    const sane = (obj) => {
      const o = {};
      Object.keys(obj || {}).forEach(k => {
        const n = Number(obj[k]);
        if (obj[k] !== '' && obj[k] != null && Number.isFinite(n)) o[k] = n;
      });
      return o;
    };
    const out = Object.assign({}, s);
    if (cp.tierRates   && typeof cp.tierRates   === 'object') out.tierRates   = Object.assign({}, s.tierRates,   sane(cp.tierRates));
    if (cp.addonPrices && typeof cp.addonPrices === 'object') out.addonPrices = Object.assign({}, s.addonPrices, sane(cp.addonPrices));
    if (cp.dumpFee != null && cp.dumpFee !== '' && Number.isFinite(Number(cp.dumpFee)))                         out.dumpFee = Number(cp.dumpFee);
    if (cp.tearOffExtraPerSq != null && cp.tearOffExtraPerSq !== '' && Number.isFinite(Number(cp.tearOffExtraPerSq))) out.tearOffExtraPerSq = Number(cp.tearOffExtraPerSq);
    // County policy (canonical overrides + custom jurisdictions) rides the same
    // at-CALC-time overlay so a late-arriving companyProfile is honored.
    return _withTenantCounties(out);
  }

  // ── Per-tenant COUNTY policy ────────────────────────────────────────────
  // One overlay for everything county-shaped in companyProfile.pricing:
  //   permits:   { '<slug>': { name, cost } }   canonical-7 permit overrides
  //   countyTax: { '<slug>': <decimal> }        canonical-7 tax overrides
  //   fallbackTaxRate: <decimal>                blank-county fallback
  //   customJurisdictions: { 'custom-<slug>': { name, cost, rate } }
  //
  // Why it exists: these used to persist ONLY in per-device localStorage
  // ('nbd_est_settings_v3'), and the Firestore copy at
  // userSettings/{uid}.estimateSettingsV2 was never read back — so a second rep,
  // a second device or a cleared cache silently priced off the factory tables.
  //
  // Applied at EVERY county-resolving entry point (per-SQ via
  // applyCompanyPricing, the line-item generator, and getCountyTaxMap for
  // EstimateLogic/Job Templates) so one estimate cannot price differently
  // depending on which path computed it. Read at CALL time behind the same
  // typeof-window guard as applyCompanyPricing — in Node (no window) this is a
  // no-op by construction, so the harnesses' neutral-county behavior is intact.
  /**
   * Overlay the tenant's own package costs onto a settings catalog copy.
   *
   * CATALOG's published cost/labor figures are a STARTER BASELINE, not any
   * company's real numbers. They stay published because nothing else prices a
   * per-tier package — strip them and a tenant with no cost book cannot
   * produce an estimate at all. What makes a published baseline safe is the
   * tenant's actual figures being different (rotation), not the baseline being
   * hidden; it is readable at every past commit regardless. See
   * documentation/projects/PHASE2-PUBLISHED-COST-BASIS-BRIEF-2026-08-18.md.
   *
   * Applied at the same choke point as _withTenantCounties so every pricing
   * path inherits it, and applied to a COPY — `settings.catalog` is already a
   * per-user deep copy in localStorage, and mutating the shared CATALOG
   * constant would leak one tenant's costs into the next account on a shared
   * device.
   *
   * The book WINS over a saved local catalog on cost/labor only. That is the
   * point: per-device cost drift is the exact problem the company book exists
   * to end. Every other field the user may have edited (names, units) survives.
   */
  function _withTenantCosts(s) {
    if (!s || !s.catalog || typeof s.catalog !== 'object') return s;
    let costs = null;
    try {
      const cc = (typeof window !== 'undefined') && window.NBDCatalogCosts;
      costs = (cc && typeof cc.v2Costs === 'function') ? cc.v2Costs() : null;
    } catch (e) { return s; }
    if (!costs) return s;

    let touched = false;
    const catalog = {};
    Object.keys(s.catalog).forEach((k) => {
      const spec = s.catalog[k];
      const entry = costs[k];
      if (!spec || !entry || typeof entry !== 'object') { catalog[k] = spec; return; }
      const cost = Number(entry.cost);
      const labor = Number(entry.labor);
      // A corrupted book must not price work: fall through to the baseline
      // rather than writing NaN into a customer total.
      if (!Number.isFinite(cost) || !Number.isFinite(labor) || cost < 0 || labor < 0) { catalog[k] = spec; return; }
      catalog[k] = Object.assign({}, spec, { cost: cost, labor: labor });
      touched = true;
    });
    return touched ? Object.assign({}, s, { catalog: catalog }) : s;
  }

  function _withTenantCounties(s) {
    const cp = (typeof window !== 'undefined' && window._companyProfile && window._companyProfile.pricing) || null;
    const tj = _tenantJurisdictions();
    if (!cp && !Object.keys(tj.permits).length && !Object.keys(tj.countyTax).length) return s;

    // countyTax entries are bare DECIMALS; a blank/garbage field is DROPPED so
    // the config rate stands (never coerced to 0 — the L-1 under-pricing class),
    // but a literal 0 IS honored (a tenant with no sales tax).
    //
    // Range 0..1 is enforced, matching _tenantJurisdictions' rate guard:
    //   - a NEGATIVE rate would SUBTRACT tax from the customer total (an owner
    //     typo of -5 became -0.05 company-wide, and permits already rejected
    //     n < 0, so the two sanitizers disagreed);
    //   - a rate > 1 is a percent pasted where a decimal belongs (9.25 meaning
    //     9.25%, which would tax at 925%).
    const saneRate = (v) => {
      if (v === '' || v == null) return null;
      const n = Number(v);
      return (Number.isFinite(n) && n >= 0 && n <= 1) ? n : null;
    };
    const saneRates = (obj) => {
      const o = {};
      Object.keys(obj || {}).forEach(k => {
        if (!k) return; // '' is reserved for the Other option (NaN double-index)
        const n = saneRate(obj[k]);
        if (n != null) o[k] = n;
      });
      return o;
    };
    // permits entries are OBJECTS ({name, cost}): an entry survives only with a
    // finite cost >= 0, and a blank tenant NAME falls back to the base label —
    // that string prints on customer paper as "Building Permit — <name>", so a
    // tenant must not be able to blank it into "Building Permit — ".
    const sanePermits = (obj, base) => {
      const o = {};
      Object.keys(obj || {}).forEach(k => {
        if (!k) return;
        const e = obj[k];
        if (!e || typeof e !== 'object') return;
        const n = Number(e.cost);
        if (e.cost === '' || e.cost == null || !Number.isFinite(n) || n < 0) return;
        const baseName = (base && base[k] && base[k].name) || '';
        const name = (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : baseName;
        if (!name) return; // no label anywhere → leave the base row alone
        o[k] = { name: name, cost: n };
      });
      return o;
    };

    const out = Object.assign({}, s);
    // Order matters: canonical tenant overrides first, then custom
    // jurisdictions (custom-* keys can never collide with a canonical slug).
    out.permits   = Object.assign({}, s.permits,   cp ? sanePermits(cp.permits, s.permits) : {}, tj.permits);
    out.countyTax = Object.assign({}, s.countyTax, cp ? saneRates(cp.countyTax) : {},            tj.countyTax);
    if (cp) {
      const fb = saneRate(cp.fallbackTaxRate);
      if (fb != null) out.fallbackTaxRate = fb;
    }
    return out;
  }

  // The tenant-resolved blank-county fallback rate, for consumers that compute
  // tax OUTSIDE this engine (estimate-logic-engine's resolveEstimate). Returns a
  // finite decimal always — the caller must not have to re-implement the
  // 0-is-legitimate check.
  function getFallbackTaxRate() {
    const r = _withTenantCounties(loadSettings()).fallbackTaxRate;
    return Number.isFinite(Number(r)) ? Number(r) : FALLBACK_TAX_RATE;
  }

  // Per-tenant custom jurisdictions (Settings → Estimates → My Jurisdictions).
  // companyProfile/{companyId}.pricing.customJurisdictions is a map of
  //   'custom-<slug>' → { name, cost, rate }   (rate is a DECIMAL, 0.0925)
  // read at CALL time behind the same typeof-window guard as
  // applyCompanyPricing — in Node (no window) this is a no-op by construction,
  // so the harnesses' neutral-county behavior is untouched. Only sane entries
  // survive: name must be a non-empty string; cost a finite number >= 0; rate a
  // finite decimal 0..1. '' slugs are skipped ('' is reserved for the Other
  // option — the countyTax double-index would read NaN off a '' key).
  function _tenantJurisdictions() {
    const cj = (typeof window !== 'undefined'
      && window._companyProfile
      && window._companyProfile.pricing
      && window._companyProfile.pricing.customJurisdictions) || null;
    const permits = {};
    const countyTax = {};
    if (cj && typeof cj === 'object') {
      Object.keys(cj).forEach(slug => {
        if (!slug) return;
        const e = cj[slug];
        if (!e || typeof e !== 'object') return;
        const name = (typeof e.name === 'string') ? e.name.trim() : '';
        if (!name) return;
        // Blank/garbage numbers are DROPPED (not zeroed) so the engine's
        // defaults stand — same L-1 rationale as applyCompanyPricing's sane().
        const cost = Number(e.cost);
        if (e.cost != null && e.cost !== '' && Number.isFinite(cost) && cost >= 0) {
          permits[slug] = { name: name, cost: cost };
        }
        const rate = Number(e.rate);
        if (e.rate != null && e.rate !== '' && Number.isFinite(rate) && rate >= 0 && rate <= 1) {
          countyTax[slug] = rate;
        }
      });
    }
    return { permits, countyTax };
  }

  // The tenant-overlaid tax map (loadSettings().countyTax + the tenant's
  // canonical-county overrides + custom jurisdictions). Consumed by
  // EstimateLogic's resolveEstimate fallback so the JT / live V2 line-item
  // paths tax every county exactly like the per-SQ path does.
  // loadSettings itself stays PURE — the settings panel's save spread must
  // never bake tenant values into localStorage.
  function getCountyTaxMap() {
    return _withTenantCounties(loadSettings()).countyTax;
  }

  // The tenant-overlaid settings the SETTINGS PANEL should display: county
  // policy is company-wide now, so the 14 permit/tax inputs must show what the
  // company uses, not whatever this device last saved. Everything else is
  // untouched device state.
  function getResolvedCountySettings() {
    return _withTenantCounties(loadSettings());
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 6 — Shared prep step (measurements → geometry)
  // ═════════════════════════════════════════════════════════

  function prepGeometry(input, settings) {
    const rawSqft = Math.max(0, Number(input.rawSqft) || 0);
    const pitchRatio = parsePitch(input.pitch);

    let waste = (input.wasteFactorOverride != null)
      ? Number(input.wasteFactorOverride)
      : wasteFactorForPitch(pitchRatio);
    if (input.cutUpRoof) waste += CUT_UP_ROOF_WASTE_BONUS;

    const adjustedSqft = rawSqft * waste;
    const sq = adjustedSqft / 100;

    return { rawSqft, pitchRatio, waste, adjustedSqft, sq };
  }

  // Gutter footage this engine prices: a finite guttersLf above zero, else 0
  // (no gutters). Both gutter sites below read it, and "present" means the same
  // thing as EstimateLogic's GUTTER_LF ('guttersLf > 0 ? guttersLf : eaveLf'),
  // so a job's gutters come from one number on every path (Jo, 2026-09-25,
  // Draw-tool decision 2). The per-SQ quote never falls back to eaveLf: with no
  // gutter measurement it carries no gutter add-on, as before.
  //
  // It used to be a bare truthiness test. A negative figure then priced as a
  // gutter CREDIT on the per-SQ quote, and a non-numeric one reached the
  // generated scope as a NaN quantity.
  function _gutterLf(input) {
    const n = Number(input && input.guttersLf);
    return (Number.isFinite(n) && n > 0) ? n : 0;
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 7 — PER-SQ MODE calculation
  // ═════════════════════════════════════════════════════════

  function calculatePerSq(input) {
    const s = applyCompanyPricing(input.settingsOverride || loadSettings());
    const tier = input.tier || 'better';
    const mode = input.mode || 'cash';
    const g = prepGeometry(input, s);
    const sq = g.sq;

    // Base from per-SQ flat rate. Money runs in integer cents from here to
    // the return boundary (2026-08-07) — see the cents-helpers note above.
    const rate = Number(s.tierRates[tier]) || TIER_RATES[tier];
    const baseTotalCents = _toCents(sq * rate);

    // Add-ons — each is a customer-visible line, so each rounds to a cent
    // at its own boundary (matches what renders on the estimate).
    const addOnsCents = {
      permit: 0, dumpFee: 0, matDelivery: 0, tearOffExtra: 0, extraPipeBoots: 0,
      valleyMetal: 0, chimneyFlash: 0, skylightFlash: 0, gutters: 0,
      // Phase 1 per-SQ complexity adders (estimate-qa-2026-06-08)
      steep: 0, verySteep: 0, extremeSteep: 0, story: 0, cutUpLabor: 0, access: 0
    };

    const permitKey = input.city || input.county || '';
    const permitInfo = s.permits[permitKey];
    addOnsCents.permit = _toCents(permitInfo ? Number(permitInfo.cost) : DEFAULT_PERMIT_COST); // C-1: never $0 for an unknown/blank jurisdiction
    addOnsCents.dumpFee = _toCents(input.dumpFeeOverride != null ? input.dumpFeeOverride : s.dumpFee);

    // Flat per JOB, like the permit and the dump fee — never x sq. Per-SQ is
    // the reroof model and every reroof draws material, so this is
    // unconditional; a rep can zero it per estimate (customer hauls their own,
    // supplier waives the trip). `!= null` admits a literal 0 and rejects
    // undefined — same rule as dumpFeeOverride above.
    addOnsCents.matDelivery = _toCents(
      input.matDeliveryOverride != null ? input.matDeliveryOverride : s.addonPrices.matDelivery
    );

    const layers = Math.max(1, Number(input.tearOffLayers) || 1);
    if (layers > 1) {
      addOnsCents.tearOffExtra = _toCents((layers - 1) * sq * Number(s.tearOffExtraPerSq));
    }

    addOnsCents.extraPipeBoots = _toCents(extraPipeBootCharge(
      Number(input.pipes) || 0,
      s.addonPrices.extraPipeBoot
    ));

    if (input.hasChimneyFlash)  addOnsCents.chimneyFlash  = _toCents(s.addonPrices.chimneyFlash);
    if (input.hasSkylightFlash) addOnsCents.skylightFlash = _toCents(s.addonPrices.skylightFlash);

    if (input.valleyMetalLf) {
      addOnsCents.valleyMetal = _toCents(Number(input.valleyMetalLf) * Number(s.addonPrices.valleyMetalLf));
    }

    const gutterLf = _gutterLf(input);
    if (gutterLf) {
      const gRate = (input.guttersRatePerLf != null)
        ? Number(input.guttersRatePerLf)
        : Number(s.addonPrices.guttersLf);
      addOnsCents.gutters = _toCents(gutterLf * gRate);
    }

    // ── Phase 1 complexity adders (estimate-qa-2026-06-08, Joe-confirmed) ──
    // Roof PITCH adders STACK (mirror the line-item LAB ADR-SS/VS gates).
    // g.pitchRatio = rise/12, so 8/12=0.667, 12/12=1.0, 16/12=1.333.
    if (g.pitchRatio >= (8 / 12))  addOnsCents.steep        = _toCents(sq * Number(s.addonPrices.steepPerSq));
    if (g.pitchRatio >= (12 / 12)) addOnsCents.verySteep    = _toCents(sq * Number(s.addonPrices.verySteepPerSq));
    if (g.pitchRatio >= (16 / 12)) addOnsCents.extremeSteep = _toCents(sq * Number(s.addonPrices.extremeSteepPerSq));

    // STORIES — tiered (a 3-story job pays the 3-story rate, NOT 2-story + 3-story).
    const stories = Number(input.stories) || 1;
    if (stories >= 3)       addOnsCents.story = _toCents(sq * Number(s.addonPrices.threeStoryPerSq));
    else if (stories === 2) addOnsCents.story = _toCents(sq * Number(s.addonPrices.twoStoryPerSq));

    // CUT-UP cutting labor — on TOP of the +3% material waste already applied in
    // prepGeometry (waste = material, this = labor). Mirrors line-item LAB ADR-CU.
    if (input.cutUpRoof) addOnsCents.cutUpLabor = _toCents(sq * Number(s.addonPrices.cutUpPerSq));

    // ACCESS — tiered (standard $0 / moderate / difficult). Crane/boom jobs use
    // real equipment line items, never a per-SQ guess.
    if (input.accessLevel === 'difficult')     addOnsCents.access = _toCents(sq * Number(s.addonPrices.accessDifficultPerSq));
    else if (input.accessLevel === 'moderate') addOnsCents.access = _toCents(sq * Number(s.addonPrices.accessModeratePerSq));

    const addOnsTotalCents = Object.keys(addOnsCents).reduce((sum, k) => sum + (addOnsCents[k] || 0), 0);

    // Subtotal + tax (insurance hides tax)
    const subtotalCents = baseTotalCents + addOnsTotalCents;
    const taxRate = (mode === 'insurance')
      ? 0
      : (s.countyTax[input.county || ''] != null
          ? Number(s.countyTax[input.county])
          : Number(s.fallbackTaxRate));
    const taxCents = Math.round(subtotalCents * taxRate);

    // Grand total
    const roundToCents = _toCents(s.roundTo) || ROUND_TO_CENTS_DEFAULT;
    let totalCents = _roundToNearestCents(subtotalCents + taxCents, roundToCents);

    // Minimum job
    let minJobApplied = false;
    const minJobCents = _toCents(s.minJobCharge) || MIN_JOB_CHARGE_CENTS_DEFAULT;
    if (totalCents < minJobCents) {
      totalCents = minJobCents;
      minJobApplied = true;
    }

    // Internal margin view. costPerSq 0 = tenant hasn't configured a cost
    // basis (the shipped default — see DEFAULT_COST_BASIS): margin fields go
    // null so the UI can say "set cost basis" instead of showing 100%.
    const costPerSq = Number(s.costBasis[tier]) || DEFAULT_COST_BASIS[tier];
    const costConfigured = costPerSq > 0;
    const materialLaborCostCents = _toCents(sq * costPerSq);
    // Per-add-on, not one blanket ratio — pass-throughs cost what they charge.
    // See ADDON_COST_PASS_THROUGH for why, and for what is still assumed.
    const addOnCostCents = costConfigured
      ? Object.keys(addOnsCents).reduce(function (sum, k) {
          const chargedCents = addOnsCents[k] || 0;
          return chargedCents ? sum + Math.round(chargedCents * _addonCostRatio(s, k)) : sum;
        }, 0)
      : 0;
    const totalCostCents = materialLaborCostCents + addOnCostCents;
    const marginCents = costConfigured ? totalCents - totalCostCents : null;
    const marginPct = costConfigured && totalCents > 0 ? ((totalCents - totalCostCents) / totalCents) * 100 : (costConfigured ? 0 : null);

    // Deposit — deposit-rule.js via calcDeposit (2026-09-25).
    const depositInfo = calcDeposit(_fromCents(totalCents), mode, {
      overridePct: input.depositOverridePct,
      deductible: input.deductible,
      acv: input.acv,
      roundTo: s.roundTo
    });
    const deposit = depositInfo.amount;

    // Return boundary: exact 2-dp dollars (integer cents / 100).
    const addOns = {};
    for (const k of Object.keys(addOnsCents)) addOns[k] = _fromCents(addOnsCents[k]);

    return {
      method: 'per-sq',
      rawSqft: g.rawSqft,
      pitchRatio: g.pitchRatio,
      waste: g.waste,
      adjustedSqft: g.adjustedSqft,
      sq,
      tier, mode, rate,
      baseTotal: _fromCents(baseTotalCents),
      addOns,
      addOnsTotal: _fromCents(addOnsTotalCents),
      subtotal: _fromCents(subtotalCents),
      depositPct: depositInfo.pct,
      depositRemainder: depositInfo.remainder,
      taxRate,
      tax: _fromCents(taxCents),
      total: _fromCents(totalCents),
      minJobApplied,
      deposit,
      internal: {
        costPerSq,
        materialLaborCost: _fromCents(materialLaborCostCents),
        addOnCost: _fromCents(addOnCostCents),
        totalCost: _fromCents(totalCostCents),
        margin: marginCents == null ? null : _fromCents(marginCents),
        marginPct
      }
    };
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 8 — LINE-ITEM MODE calculation
  // ═════════════════════════════════════════════════════════

  /**
   * Auto-build a line-item list from measurements + tier.
   * User can edit, add, or remove items before final calc.
   */
  function generateLineItemsFromMeasurements(input, settings) {
    // The permit line this builds reads s.permits, so it is a county-resolving
    // entry point too and must see the tenant's county policy — otherwise the
    // generated scope prices the permit off this DEVICE's numbers while the
    // per-SQ total uses the company's. Idempotent when the caller already
    // passed overlaid settings (calculateLineItem does).
    const s = _withTenantCosts(_withTenantCounties(settings || loadSettings()));
    const g = prepGeometry(input, s);
    const tier = input.tier || 'better';
    const map = TIER_MATERIAL_MAP[tier] || TIER_MATERIAL_MAP.better;
    const cat = s.catalog || CATALOG;

    const items = [];

    // Helper to push an item from the catalog
    function addFromCatalog(catKey, qty, descOverride) {
      if (qty == null || qty <= 0) return;
      const spec = cat[catKey];
      if (!spec) return;
      items.push({
        catalogKey: catKey,
        code: spec.code,
        name: descOverride || spec.name,
        category: spec.category,
        unit: spec.unit,
        qty: Number(qty),
        materialCost: Number(spec.cost),
        laborCost: Number(spec.labor)
      });
    }

    // Shingles — by SQ
    addFromCatalog(map.shingle, g.sq);

    // Underlayment — by SQ
    addFromCatalog(map.underlayment, g.sq);

    // Ice & water shield — 5 SQ standard (eave + valleys)
    addFromCatalog('ice-water', 5);

    // Tear-off — always 1 layer by SQ
    addFromCatalog('tear-off', g.sq);
    // Extra layers
    const layers = Math.max(1, Number(input.tearOffLayers) || 1);
    if (layers > 1) {
      items.push({
        catalogKey: 'tear-off-extra-layer',
        code: 'RFG-TEAR',
        name: `Tear Off Additional Layer(s) × ${layers - 1}`,
        category: 'labor',
        unit: 'SQ',
        qty: g.sq * (layers - 1),
        materialCost: 0,
        laborCost: Number(cat['tear-off-extra-layer']?.labor || 50)
      });
    }

    // Starter strip — eave LF
    if (input.eaveLf) addFromCatalog('starter-strip', Number(input.eaveLf));

    // Drip edge — eave LF
    if (input.eaveLf) addFromCatalog('drip-edge', Number(input.eaveLf));

    // Ridge cap — ridge LF
    if (input.ridgeLf) addFromCatalog(map.ridgeCap, Number(input.ridgeLf));

    // Hip cap — hip LF (uses same material as ridge)
    if (input.hipLf) addFromCatalog(map.ridgeCap, Number(input.hipLf), 'Hip Cap Shingles');

    // Ridge vent — if ridge LF and vented
    if (input.ridgeLf && input.hasRidgeVent !== false) {
      addFromCatalog(map.ridgeVent, Number(input.ridgeLf));
    }

    // Pipe boots — 1 per pipe
    const pipes = Math.max(0, Number(input.pipes) || 0);
    for (let i = 0; i < pipes; i++) {
      addFromCatalog(map.pipeBoot, 1, `${cat[map.pipeBoot]?.name || 'Pipe Boot'} #${i + 1}`);
    }

    // Valley metal
    if (input.valleyMetalLf) addFromCatalog('valley-metal', Number(input.valleyMetalLf));

    // Chimney / skylight flashing
    if (input.hasChimneyFlash) addFromCatalog('chimney-flashing', 1);
    if (input.hasSkylightFlash) addFromCatalog('skylight-flashing', 1);

    // Decking — 15% default partial replacement
    const deckPct = input.deckReplacePct != null ? Number(input.deckReplacePct) : 0.15;
    if (deckPct > 0) {
      addFromCatalog('osb-decking', g.adjustedSqft * deckPct, `OSB Decking — ${Math.round(deckPct * 100)}% Replacement`);
    }

    // Nails / fasteners
    addFromCatalog(map.nails, g.sq);

    // Dump fee (once per job)
    addFromCatalog('dump-fee', 1);

    // Permit (from city lookup if available)
    const permitKey = input.city || input.county || '';
    const permitInfo = s.permits[permitKey];
    // C-1: always include a permit line. When the jurisdiction is unknown/blank
    // the line was silently omitted (→ $0 permit); fall back to a default cost +
    // label instead so the per-SQ tier and the scope both reflect a real permit.
    // Blank county is the COMMON case for off-list tenants (neutral "Other /
    // My county" default, first-run audit 2026-07-28) and this string lands on
    // customer paper — keep the fallback label presentable.
    items.push({
      catalogKey: 'permit-fee',
      code: 'PERMIT',
      name: `Building Permit — ${permitInfo ? permitInfo.name : 'Local Jurisdiction'}`,
      category: 'permit',
      unit: 'JOB',
      qty: 1,
      materialCost: permitInfo ? Number(permitInfo.cost) : DEFAULT_PERMIT_COST,
      laborCost: 0
    });

    // Gutters — optional add-on, from the job's measured gutter footage only
    // (see _gutterLf). This generated scope has no eave-sized gutter line, so
    // the gutters are priced once.
    const gutterLf = _gutterLf(input);
    if (gutterLf) {
      addFromCatalog('gutters-6in', gutterLf);
    }

    return items;
  }

  /**
   * Calculate a line-item estimate.
   * Input can pass explicit `lineItems` OR measurements (which
   * will auto-generate them).
   */
  function calculateLineItem(input) {
    // Line-item mode prices off the catalog (material+labor) + OH&P, not the per-SQ
    // tierRates/addonPrices, so applyCompanyPricing is intentionally NOT applied here.
    // ONLY the tenant jurisdictions overlay applies (permits/countyTax — a Node
    // no-op), so custom counties price the permit line + cash tax on this path too.
    const s = _withTenantCosts(_withTenantCounties(input.settingsOverride || loadSettings()));
    const tier = input.tier || 'better';
    const mode = input.mode || 'cash';
    const g = prepGeometry(input, s);

    // Build line items if not provided
    const items = (input.lineItems && input.lineItems.length)
      ? input.lineItems
      : generateLineItemsFromMeasurements(input, s);

    // Markup controls (allow per-estimate override)
    const overheadPct = Number(
      input.overheadPct != null ? input.overheadPct : s.overheadPct
    );
    const profitPct = Number(
      input.profitPct != null ? input.profitPct : s.profitPct
    );
    const materialMarkupPct = Number(
      input.materialMarkupPct != null ? input.materialMarkupPct : s.materialMarkupPct
    );

    // Roll up item totals. Money runs in integer cents from here to the
    // return boundary (2026-08-07) — each line rounds at its own boundary,
    // matching what renders on the printed scope.
    let materialCostCents = 0;
    let laborCostCents = 0;
    const itemsWithTotals = items.map(it => {
      const qty = Number(it.qty) || 0;
      const matUnit = Number(it.materialCost) || 0;
      const labUnit = Number(it.laborCost) || 0;
      const matTotalCents = _toCents(qty * matUnit);
      const labTotalCents = _toCents(qty * labUnit);
      materialCostCents += matTotalCents;
      laborCostCents += labTotalCents;
      return Object.assign({}, it, {
        materialTotal: _fromCents(matTotalCents),
        laborTotal: _fromCents(labTotalCents),
        lineTotal: _fromCents(matTotalCents + labTotalCents)
      });
    });

    // Material markup (bakes into retail)
    const materialRetailCents = Math.round(materialCostCents * (1 + materialMarkupPct));
    const hardCostCents = materialCostCents + laborCostCents;
    const retailBeforeOHPCents = materialRetailCents + laborCostCents;

    // Overhead + profit (OH&P) — calculated on retail before OH&P
    const overheadCents = Math.round(retailBeforeOHPCents * overheadPct);
    const profitCents = Math.round(retailBeforeOHPCents * profitPct);

    // Subtotal
    const subtotalCents = retailBeforeOHPCents + overheadCents + profitCents;

    // Tax (insurance hides tax)
    const taxRate = (mode === 'insurance')
      ? 0
      : (s.countyTax[input.county || ''] != null
          ? Number(s.countyTax[input.county])
          : Number(s.fallbackTaxRate));
    const taxCents = Math.round(subtotalCents * taxRate);

    // Grand total
    const roundToCents = _toCents(s.roundTo) || ROUND_TO_CENTS_DEFAULT;
    let totalCents = _roundToNearestCents(subtotalCents + taxCents, roundToCents);

    // Minimum job
    let minJobApplied = false;
    const minJobCents = _toCents(s.minJobCharge) || MIN_JOB_CHARGE_CENTS_DEFAULT;
    if (totalCents < minJobCents) {
      totalCents = minJobCents;
      minJobApplied = true;
    }

    // Margin view (internal)
    const marginCents = totalCents - hardCostCents;
    const marginPct = totalCents > 0 ? (marginCents / totalCents) * 100 : 0;

    // Deposit — deposit-rule.js via calcDeposit (2026-09-25).
    const depositInfo = calcDeposit(_fromCents(totalCents), mode, {
      overridePct: input.depositOverridePct,
      deductible: input.deductible,
      acv: input.acv,
      roundTo: s.roundTo
    });
    const deposit = depositInfo.amount;

    // Return boundary: exact 2-dp dollars (integer cents / 100).
    const materialCost = _fromCents(materialCostCents);
    const laborCost = _fromCents(laborCostCents);
    const hardCost = _fromCents(hardCostCents);

    return {
      method: 'line-item',
      rawSqft: g.rawSqft,
      pitchRatio: g.pitchRatio,
      waste: g.waste,
      adjustedSqft: g.adjustedSqft,
      sq: g.sq,
      tier, mode,

      items: itemsWithTotals,
      materialCost,
      materialRetail: _fromCents(materialRetailCents),
      laborCost,
      hardCost,
      retailBeforeOHP: _fromCents(retailBeforeOHPCents),

      overheadPct,
      overhead: _fromCents(overheadCents),
      profitPct,
      profit: _fromCents(profitCents),
      materialMarkupPct,

      subtotal: _fromCents(subtotalCents),
      depositPct: depositInfo.pct,
      depositRemainder: depositInfo.remainder,
      taxRate,
      tax: _fromCents(taxCents),
      total: _fromCents(totalCents),
      minJobApplied,
      deposit,

      internal: {
        materialCost,
        laborCost,
        hardCost,
        margin: _fromCents(marginCents),
        marginPct
      }
    };
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 9 — Unified dispatcher
  // ═════════════════════════════════════════════════════════

  /**
   * Main entry point — picks the right calculation path.
   *
   * input.method = 'per-sq' | 'line-item'  (default 'per-sq')
   */
  function calculateEstimate(input) {
    input = input || {};
    const method = input.method || 'per-sq';
    if (method === 'line-item') return calculateLineItem(input);
    return calculatePerSq(input);
  }

  /**
   * Calculate all three tiers at once for the tier card view.
   * Works with either method.
   */
  function calculateAllTiers(input) {
    const out = {};
    TIER_ORDER.forEach(function (t) { out[t] = calculateEstimate(Object.assign({}, input, { tier: t })); });
    return out;
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 10 — Presets
  // ═════════════════════════════════════════════════════════
  const PRESETS = {
    'standard-reroof': {
      name: 'Standard Reroof',
      description: 'Tear-off + architectural shingles, cash job',
      defaults: { method: 'per-sq', tier: 'better', mode: 'cash', tearOffLayers: 1, cutUpRoof: false }
    },
    'storm-claim': {
      name: 'Storm Claim',
      description: 'Insurance claim, full line-item scope',
      defaults: { method: 'line-item', tier: 'better', mode: 'insurance', tearOffLayers: 1, hasChimneyFlash: true }
    },
    'small-repair': {
      name: 'Small Repair',
      description: 'Minor repair — min job charge applies',
      defaults: { method: 'per-sq', tier: 'good', mode: 'cash', tearOffLayers: 1 }
    },
    'full-redeck': {
      name: 'Full Redeck',
      description: 'Full decking replacement + best tier',
      defaults: { method: 'line-item', tier: 'best', mode: 'cash', tearOffLayers: 1, deckReplacePct: 1.0 }
    },
    'hail-damage-insurance': {
      name: 'Hail Damage Insurance',
      description: 'Impact shingles + full warranty package',
      defaults: {
        method: 'line-item', tier: 'best', mode: 'insurance', tearOffLayers: 1,
        hasChimneyFlash: true, hasSkylightFlash: true
      }
    }
  };

  // ── Custom presets (save-your-own) ──
  // Spec gap closed: users can capture their current estimate config
  // as a named preset. Stored in localStorage under a stable key so
  // they survive reloads. Built-ins above always take priority on key
  // collision — custom presets cannot overwrite the spec'd ones.
  const CUSTOM_PRESETS_KEY = 'nbd_est_custom_presets_v1';

  function loadCustomPresets() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CUSTOM_PRESETS_KEY) : null;
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }

  function saveCustomPreset(name, defaults) {
    if (!name || typeof name !== 'string') throw new Error('preset name required');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('preset name required');
    // Slugify for the key. Built-in keys can't be overwritten.
    const key = 'custom-' + trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (PRESETS[key]) throw new Error('that name conflicts with a built-in preset');
    const presets = loadCustomPresets();
    presets[key] = {
      name: trimmed,
      description: 'Custom preset',
      defaults: Object.assign({}, defaults || {}),
      savedAt: new Date().toISOString()
    };
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
      }
    } catch (_) {}
    return key;
  }

  function deleteCustomPreset(key) {
    const presets = loadCustomPresets();
    if (!presets[key]) return false;
    delete presets[key];
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
      }
    } catch (_) {}
    return true;
  }

  function getAllPresets() {
    // Built-ins first; customs cannot collide thanks to the 'custom-' prefix.
    return Object.assign({}, PRESETS, loadCustomPresets());
  }

  // ═════════════════════════════════════════════════════════
  // SECTION 11 — Public API
  // ═════════════════════════════════════════════════════════
  const EstimateBuilderV2 = {
    // Constants
    TIER_RATES,
    DEFAULT_COST_BASIS,
    ADDON_COST_PASS_THROUGH,
    DEFAULT_ADDON_COST_RATIO,
    MIN_JOB_CHARGE,
    PERMIT_COSTS,
    COUNTY_TAX,
    ADDON_PRICES,
    CATALOG,
    TIER_MATERIAL_MAP,
    PRESETS,
    // Custom-preset API (spec: "save your own preset")
    loadCustomPresets,
    saveCustomPreset,
    deleteCustomPreset,
    getAllPresets,
    DEFAULT_OVERHEAD_PCT,
    DEFAULT_PROFIT_PCT,
    DEFAULT_MATERIAL_MARKUP_PCT,

    // Settings
    getDefaultSettings,
    loadSettings,
    saveSettings,
    updateSettings,
    getCountyTaxMap,
    getResolvedCountySettings,
    getFallbackTaxRate,

    // Calculation
    calcDeposit,
    calculateEstimate,
    calculateAllTiers,
    calculatePerSq,
    calculateLineItem,
    generateLineItemsFromMeasurements,

    // Helpers
    parsePitch,
    wasteFactorForPitch,
    extraPipeBootCharge,
    roundToNearest,
    prepGeometry
  };

  if (typeof window !== 'undefined') {
    window.EstimateBuilderV2 = EstimateBuilderV2;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EstimateBuilderV2;
  }
})();
