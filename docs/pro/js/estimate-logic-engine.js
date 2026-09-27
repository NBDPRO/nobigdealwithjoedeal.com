/*! © 2026 No Big Deal Home Solutions — All Rights Reserved. Proprietary; no license granted — see LICENSE at the repo root. https://nobigdealwithjoedeal.com */
// ============================================================
// NBD Pro — Estimate Logic Engine
//
// The heart of the 3-catalog linked model. Takes measurements
// from the drawing tool (or direct entry), a list of line items
// from the Xactimate catalog, and resolves each line to:
//
//   1. Live quantity   (via formula evaluator against measurements)
//   2. Live material cost (via NBD_PRODUCTS lookup)
//   3. Live labor cost    (via NBD_LABOR lookup)
//   4. Line subtotal      (qty × (matCost + labCost))
//   5. Ordering quantity  (in the vendor's packaging unit)
//
// If Joe updates a product cost in NBD_PRODUCTS or a crew rate
// in NBD_LABOR, every line item that references it recalculates
// automatically.
//
// Exposes window.EstimateLogic with these functions:
//
//   calcQuantity(formula, context)
//   resolveMaterial(materialId)
//   resolveLabor(laborId, measurements)
//   resolveLineItem(item, measurements, opts)
//   resolveEstimate(lineItems, measurements, settings)
//   inferLaborId(item)
//   convertToOrderingUnit(item, quantity)
//
// Safe formula evaluator — only whitelisted variables and Math
// functions are allowed. Formulas come from catalog data, not
// user input, so the risk surface is limited.
// ============================================================

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ═════════════════════════════════════════════════════════
  // 1. Measurement context — whitelisted variables for formulas
  // ═════════════════════════════════════════════════════════

  const MEASUREMENT_VARS = [
    // Roof geometry
    'rawSqft',          // Actual roof area (pitch applied)
    'sq',               // Adjusted squares (rawSqft × waste ÷ 100)
    'adjustedSqft',     // rawSqft × waste
    'pitchRatio',       // Rise/run (e.g., 8/12 = 0.667)
    'pitch',            // Numeric pitch rise (e.g., 8)
    'waste',            // Waste factor multiplier
    'stories',          // Number of stories
    'cutUpRoof',        // Boolean → 1 or 0
    // Linear dimensions
    'ridgeLf',
    'eaveLf',
    'rakeLf',
    'hipLf',
    'valleyLf',
    'wallLf',           // Roof-to-wall LF (headwall + sidewall combined)
    'guttersLf',        // Drawn / measured gutter-run LF; 0 = not measured (see GUTTER_LF)
    // Counts
    'pipes',
    'chimneys',
    'skylights',
    'structures',       // Number of roof structures (main house + garage)
    // Construction details
    'tearOffLayers',
    'deckReplacePct'    // Default 0.15 (15%)
  ];

  /**
   * Build a safe measurement context from raw inputs. Ensures
   * every variable exists with a numeric value, never undefined.
   */
  function buildContext(input) {
    input = input || {};
    const rawSqft = Number(input.rawSqft) || 0;
    const waste = Number(input.waste) || 1.17;
    const adjustedSqft = rawSqft * waste;
    const sq = adjustedSqft / 100;

    return {
      rawSqft:         rawSqft,
      sq:              sq,
      adjustedSqft:    adjustedSqft,
      pitchRatio:      Number(input.pitchRatio) || 0.667,
      pitch:           Number(input.pitch) || 8,
      waste:           waste,
      stories:         Number(input.stories) || 1,
      cutUpRoof:       input.cutUpRoof ? 1 : 0,
      ridgeLf:         Number(input.ridgeLf) || 0,
      eaveLf:          Number(input.eaveLf) || 0,
      rakeLf:          Number(input.rakeLf) || 0,
      hipLf:           Number(input.hipLf) || 0,
      valleyLf:        Number(input.valleyLf) || 0,
      wallLf:          Number(input.wallLf) || 0,
      // Finite and > 0, else 0 (not measured): the same test as
      // estimate-builder-v2.js _gutterLf, so every engine agrees on whether a
      // gutter footage is present.
      guttersLf:       (Number.isFinite(Number(input.guttersLf)) && Number(input.guttersLf) > 0) ? Number(input.guttersLf) : 0,
      pipes:           Number(input.pipes) || 0,
      chimneys:        Number(input.chimneys) || 0,
      skylights:       Number(input.skylights) || 0,
      structures:      Number(input.structures) || 1,
      tearOffLayers:   Number(input.tearOffLayers) || 1,
      deckReplacePct:  Number(input.deckReplacePct != null ? input.deckReplacePct : 0.15)
    };
  }

  // ═════════════════════════════════════════════════════════
  // 2. Safe formula evaluator (TWO-LAYER SANDBOX)
  //
  // Layer 1: Strict character/token whitelist. The formula
  //   source is validated against a regex of allowed tokens
  //   BEFORE being evaluated. Anything the whitelist doesn't
  //   recognize is rejected up-front. This blocks 'process.exit',
  //   'window.x', 'require("fs")', 'document.cookie',
  //   'fetch(...)', 'eval()', etc.
  //
  // Layer 2: safeEvalFormula() — a CSP-safe recursive-descent
  //   evaluator over the SAME bounded grammar, exposing only
  //   Math + math helpers + the whitelisted measurement vars,
  //   purely over numbers/booleans. Any runtime error is caught
  //   and returns 0. (Replaces new Function(), which prod CSP
  //   without 'unsafe-eval' makes throw.)
  //
  // Formulas come from the NBD_XACT_CATALOG data file. This
  // is the same trust boundary as any other code Joe ships,
  // but the two-layer check means a corrupted catalog or a
  // malicious user-entered override can't escape the sandbox.
  // ═════════════════════════════════════════════════════════

  // Allowed identifiers = measurement vars + math helpers
  const FORMULA_ALLOWED_IDENTIFIERS = new Set([
    // Math helpers exposed to formulas
    'Math', 'max', 'min', 'ceil', 'floor', 'round', 'abs', 'pow', 'sqrt',
    // Literal keywords allowed in expressions
    'true', 'false'
  ]);
  MEASUREMENT_VARS.forEach(v => FORMULA_ALLOWED_IDENTIFIERS.add(v));

  /**
   * Validates a formula against the strict whitelist.
   * Returns null if safe, or a string describing the violation.
   */
  function validateFormula(formula) {
    if (typeof formula !== 'string') return 'not a string';

    // Reject known attack tokens up-front for clearer error messages
    const dangerous = ['process', 'require', 'import', 'globalThis',
                       'window', 'document', 'self', 'top', 'parent',
                       'fetch', 'XMLHttpRequest', 'eval', 'Function',
                       'localStorage', 'sessionStorage', 'cookie',
                       'constructor', '__proto__', 'prototype'];
    for (const bad of dangerous) {
      // Match the token as a whole word (not a substring inside a var name)
      const re = new RegExp('(^|[^a-zA-Z0-9_])' + bad + '($|[^a-zA-Z0-9_])');
      if (re.test(formula)) {
        return 'blocked token: ' + bad;
      }
    }

    // Tokenize and check every identifier is in the whitelist.
    // Allowed characters outside of identifiers:
    //   digits, + - * / % ( ) , . ? :  < > = ! & |  and whitespace
    // (ternary ?, comparisons <, >, <=, >=, ==, !=, &&, || are all
    // fine because they operate on numbers only, never on objects)
    const tokenRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
    let m;
    while ((m = tokenRegex.exec(formula)) !== null) {
      const token = m[0];
      if (!FORMULA_ALLOWED_IDENTIFIERS.has(token)) {
        return 'unknown identifier: ' + token;
      }
    }

    // Reject any remaining suspicious characters outside the operator set
    // (block: [ ] { } ; \ ` " ' backtick which could open up object/string literals)
    if (/[\[\]{};\\`"']/.test(formula)) {
      return 'forbidden character';
    }

    return null;  // safe
  }

  const FORMULA_BLOCKED = new Set();

  // ─── CSP-safe arithmetic evaluator (V2-5 fix, estimate-qa-2026-06-08) ───
  // Replaces new Function(): prod CSP (script-src without 'unsafe-eval') makes
  // new Function THROW, which silently zeroed every formula-based line-item
  // quantity (drip-edge, ventilation, decking, dumpster sizing, …) — understating
  // the line-item total that is also the persisted CRM grandTotal. This evaluates
  // the SAME bounded grammar validateFormula already enforces, with identical JS
  // semantics, purely over numbers/booleans — no object/string/property access.
  // Grammar: numeric literals · whitelisted measurement vars · the 8 Math helpers
  // (bare `ceil(...)` or `Math.ceil(...)`) · + - * / % · unary + - ! · comparisons
  // < > <= >= == != === !== · && || · ternary ?: · parentheses.
  const FORMULA_HELPERS = {
    max: Math.max, min: Math.min, ceil: Math.ceil, floor: Math.floor,
    round: Math.round, abs: Math.abs, pow: Math.pow, sqrt: Math.sqrt
  };
  function safeEvalFormula(src, vars) {
    let i = 0;
    const ws = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++; };
    const at = (str) => { ws(); return src.startsWith(str, i); };
    function expr() { return ternary(); }
    function ternary() {
      const c = logicOr(); ws();
      if (src[i] === '?') {
        i++; const a = ternary(); ws();
        if (src[i] !== ':') throw new Error('expected :');
        i++; const b = ternary();
        return c ? a : b;
      }
      return c;
    }
    function logicOr() { let l = logicAnd(); while (at('||')) { i += 2; const r = logicAnd(); l = l || r; } return l; }
    function logicAnd() { let l = equality(); while (at('&&')) { i += 2; const r = equality(); l = l && r; } return l; }
    function equality() {
      let l = relational();
      while (true) { ws();
        if (src.startsWith('===', i)) { i += 3; l = (l === relational()); }
        else if (src.startsWith('!==', i)) { i += 3; l = (l !== relational()); }
        else if (src.startsWith('==', i)) { i += 2; l = (l == relational()); }   // intentional ==
        else if (src.startsWith('!=', i)) { i += 2; l = (l != relational()); }   // intentional !=
        else break;
      }
      return l;
    }
    function relational() {
      let l = additive();
      while (true) { ws();
        if (src.startsWith('<=', i)) { i += 2; l = (l <= additive()); }
        else if (src.startsWith('>=', i)) { i += 2; l = (l >= additive()); }
        else if (src[i] === '<') { i++; l = (l < additive()); }
        else if (src[i] === '>') { i++; l = (l > additive()); }
        else break;
      }
      return l;
    }
    function additive() {
      let l = multiplicative();
      while (true) { ws();
        if (src[i] === '+') { i++; l = l + multiplicative(); }
        else if (src[i] === '-') { i++; l = l - multiplicative(); }
        else break;
      }
      return l;
    }
    function multiplicative() {
      let l = unary();
      while (true) { ws();
        if (src[i] === '*') { i++; l = l * unary(); }
        else if (src[i] === '/') { i++; l = l / unary(); }
        else if (src[i] === '%') { i++; l = l % unary(); }
        else break;
      }
      return l;
    }
    function unary() {
      ws();
      if (src[i] === '-') { i++; return -unary(); }
      if (src[i] === '+') { i++; return +unary(); }
      if (src[i] === '!') { i++; return !unary(); }
      return primary();
    }
    function primary() {
      ws();
      if (src[i] === '(') { i++; const v = expr(); ws(); if (src[i] !== ')') throw new Error('expected )'); i++; return v; }
      // JS strict-mode decimal literals only: 0 · 0.5 · 5 · 5. · 5.5 · .5.
      // A leading 0 followed by a digit (legacy octal `010`) is a SyntaxError
      // in strict mode — the old new Function('"use strict";…') path threw and
      // returned 0, so we must NOT read `010` as decimal 10. The leading 0 here
      // matches as a lone `0`, leaving `10` to fail the trailing-input check.
      const num = /^(?:0(?:\.\d*)?|[1-9]\d*(?:\.\d*)?|\.\d+)/.exec(src.slice(i));
      if (num) { i += num[0].length; return parseFloat(num[0]); }
      const id = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(src.slice(i));
      if (id) {
        let name = id[0]; i += name.length;
        if (name === 'Math') {
          ws(); if (src[i] !== '.') throw new Error('expected . after Math'); i++;
          const m = /^[a-zA-Z]+/.exec(src.slice(i));
          if (!m) throw new Error('expected Math member'); name = m[0]; i += name.length;
        }
        ws();
        if (src[i] === '(') {
          i++; const args = []; ws();
          if (src[i] !== ')') { args.push(expr()); ws(); while (src[i] === ',') { i++; args.push(expr()); ws(); } }
          if (src[i] !== ')') throw new Error('expected )'); i++;
          const fn = FORMULA_HELPERS[name];
          if (typeof fn !== 'function') throw new Error('unknown function ' + name);
          return fn.apply(null, args);
        }
        if (name === 'true') return true;
        if (name === 'false') return false;
        if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
        throw new Error('unknown identifier ' + name);
      }
      throw new Error('unexpected token');
    }
    const out = expr(); ws();
    if (i < src.length) throw new Error('trailing input');
    return out;
  }

  function calcQuantity(formula, context) {
    if (formula == null) return 0;
    if (typeof formula === 'number') return formula;
    if (typeof formula !== 'string') return 0;

    const trimmed = formula.trim();
    if (!trimmed) return 0;

    // Shortcut: plain variable lookup
    if (/^[a-zA-Z_]\w*$/.test(trimmed) && MEASUREMENT_VARS.includes(trimmed)) {
      return Number(context[trimmed]) || 0;
    }
    // Shortcut: numeric literal
    const asNumber = Number(trimmed);
    if (!isNaN(asNumber)) return asNumber;

    // Layer 1: strict whitelist check
    if (FORMULA_BLOCKED.has(trimmed)) return 0;
    const violation = validateFormula(trimmed);
    if (violation) {
      console.warn('[EstimateLogic] Formula rejected (' + violation + '):', trimmed);
      FORMULA_BLOCKED.add(trimmed);
      return 0;
    }

    // Layer 2: CSP-safe evaluation (V2-5 — see safeEvalFormula above).
    // Replaces new Function(), which prod CSP (no 'unsafe-eval') makes throw —
    // silently zeroing every formula-based line quantity. Same bounded grammar,
    // identical JS numeric/boolean semantics, no eval.
    try {
      const vars = {};
      MEASUREMENT_VARS.forEach(v => { vars[v] = Number(context[v]) || 0; });
      const result = safeEvalFormula(trimmed, vars);
      return Number(result) || 0;
    } catch (e) {
      console.warn('[EstimateLogic] Formula eval error:', trimmed, e.message);
      FORMULA_BLOCKED.add(trimmed);
      return 0;
    }
  }

  // ═════════════════════════════════════════════════════════
  // 3. Material & Labor resolvers
  // ═════════════════════════════════════════════════════════

  /**
   * Resolve a material ID against NBD_PRODUCTS.
   * Returns { id, name, cost, unit, pricing, source } or null.
   */
  function resolveMaterial(materialId, tier) {
    if (!materialId) return null;
    tier = tier || 'better';
    const products = window.NBD_PRODUCTS || [];
    const product = products.find(p => p.id === materialId);
    if (!product) {
      console.warn('[EstimateLogic] Material not found:', materialId);
      return null;
    }
    const tierPricing = product.pricing && product.pricing[tier];
    // `cost` is absent until catalog-costs.js hydrates the private half of the
    // catalog (product-data.js publishes retail `sell` only — it is served
    // unauthenticated from a public repo). Number(undefined) is NaN, and NaN
    // propagates silently through every downstream margin/total, so coerce a
    // missing cost to 0 — the same value this returned for a tier with no
    // pricing block before the split.
    const rawCost = tierPricing ? Number(tierPricing.cost) : 0;
    return {
      id: product.id,
      name: product.name,
      unit: product.unit,
      cost: Number.isFinite(rawCost) ? rawCost : 0,
      sell: tierPricing ? Number(tierPricing.sell) : 0,
      manufacturer: product.manufacturer,
      sku: product.sku,
      category: product.category,
      source: 'NBD_PRODUCTS'
    };
  }

  /**
   * Resolve a labor ID against NBD_LABOR.
   * Returns { id, name, rate, unit, source } or null.
   */
  function resolveLabor(laborId) {
    if (!laborId) return null;
    const labor = window.NBD_LABOR;
    if (!labor) return null;
    const entry = labor.get(laborId);
    if (!entry) {
      console.warn('[EstimateLogic] Labor not found:', laborId);
      return null;
    }
    return {
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      rate: Number(entry.rate),
      crewSize: entry.crewSize,
      hoursPerUnit: entry.hoursPerUnit,
      category: entry.category,
      requiresSafety: entry.requiresSafety,
      source: 'NBD_LABOR'
    };
  }

  // ═════════════════════════════════════════════════════════
  // 4. Labor inference — map line item subcategory/code to a
  //    default labor action. Explicit laborId on the item always
  //    wins; this is the fallback.
  // ═════════════════════════════════════════════════════════

  const LABOR_BY_SUB = {
    // Shingles & membrane
    'shingles-3tab':     'LAB INST-SH',
    'shingles-arch':     'LAB INST-SH',
    'shingles-designer': 'LAB INST-SH',
    'shingles-impact':   'LAB INST-SH',
    'shingles-cool':     'LAB INST-SH',
    'metal':             'LAB INST-MT',
    'wood':              'LAB INST-WD',
    'tile':              'LAB INST-TL',
    'slate':             'LAB INST-TL',   // Same productivity as tile
    'low-slope':         'LAB INST-MB',

    // Underlayment
    'underlayment':      'LAB INST-UDL',

    // Accessories
    'starter':           'LAB INST-STR',
    'ridge':             'LAB INST-RC',
    'hip':               'LAB INST-RC',
    'drip-edge':         'LAB INST-DE',
    'rake':              'LAB INST-DE',
    'gutter-apron':      'LAB INST-DE',
    'transition':        'LAB INST-FL',

    // Flashing
    'flashing':          'LAB INST-FL',
    'valley':            'LAB INST-VM',

    // Ventilation
    'ventilation':       'LAB INST-BV',   // Overridden per-code for power/turbine

    // Decking
    'decking':           'LAB INST-OSB',  // Overridden per-code for plywood

    // Fasteners — no labor (included in install)
    'fasteners':         null,

    // Gutters
    'gutters':           'LAB INST-GTR5', // Overridden for 6"
    'downspout':         'LAB INST-DSP',
    'guards':            'LAB INST-GG',
    'drainage':          'LAB INST-DSP',

    // Fascia / soffit
    'fascia':            'LAB INST-FSC',
    'soffit':            'LAB INST-SFT',
    'trim':              'LAB INST-FSC',
    'repair':            'LAB CARP-HR',

    // Labor categories are the labor catalog themselves
    'labor-teardown':    null,  // Item IS the labor
    'labor-install':     null,
    'labor-detail':      null,
    'labor-overhead':    null,
    'labor-adder':       null,
    'labor-carpentry':   null,
    'labor-cleanup':     null,
    'labor-documentation':null,
    'labor-supervision': null,
    'labor-emergency':   null,
    'labor-qc':          null,

    // Disposal, permits, warranty — no labor
    'disposal':          null,
    'permits':           null,
    'warranty':          null,

    // Interior
    'interior-drywall':  'LAB DW-PATCH',
    'interior-ceiling':  'LAB CLG-TX',
    'interior-paint':    'LAB PNT-RM',
    'interior-texture':  'LAB CLG-TX',
    'interior-flooring': 'LAB FLR-RPR',

    // Landscape / emergency / equipment — mostly no labor or
    // self-contained
    'landscape-protection':null,
    'emergency':         null,
    'equipment':         null,
    'code-upgrade':      'LAB INST-FL',  // Generic install
    'specialty':         'LAB DTL-HR'
  };

  // Per-code overrides for items where the subcategory default
  // doesn't fit. Highest priority.
  const LABOR_BY_CODE = {
    'RFG PIPE-STD':    'LAB INST-PB',
    'RFG PIPE-LD':     'LAB INST-PB',
    'RFG PIPE-RTR':    'LAB INST-PB',
    'RFG CHIM-STD':    'LAB INST-CHM',
    'RFG CHIM-SAD':    'LAB INST-CHM',
    'RFG SKY-STD':     'LAB INST-SKY',
    'RFG SKY-CUS':     'LAB INST-SKY',
    'RFG KICK':        'LAB INST-KICK',
    'RFG STPF-AL':     'LAB INST-STP',
    'RFG STPF-CU':     'LAB INST-STP',
    'RFG CNTR':        'LAB INST-CTR',
    'RFG HDWL':        'LAB INST-CTR',
    'RFG SDWL':        'LAB INST-CTR',
    'RFG RIDG-VNT':    'LAB INST-RV',
    'RFG RIDG-VNT-PL': 'LAB INST-RV',
    'RFG RIDG-VNT-PR': 'LAB INST-RV',
    'RFG BFL':         'LAB INST-RV',
    'RFG BOX-STD':     'LAB INST-BV',
    'RFG BOX-PRE':     'LAB INST-BV',
    'RFG PWR':         'LAB INST-PWR',
    'RFG SOLAR':       'LAB INST-PWR',
    'RFG TURB':        'LAB INST-TRB',
    'RFG TURB14':      'LAB INST-TRB',
    'RFG GBL':         'LAB INST-GBL',
    'RFG GBL-OCT':     'LAB INST-GBL',
    'RFG GBL-RND':     'LAB INST-GBL',
    'RFG HIP-VNT':     'LAB INST-RV',
    'RFG SFT-C':       'LAB INST-SFTC',
    'RFG SFT-I':       'LAB INST-SFTC',
    'RFG SMT':         'LAB INST-SMT',
    'RFG IWS':         'LAB INST-IWS',
    'RFG IWS-HT':      'LAB INST-IWS',
    'RFG IWS-FC':      'LAB INST-IWS',
    'RFG RNB-MEM':     'LAB INST-IWS',
    'RFG VB-SYN':      'LAB INST-UDL',
    'RFG PLY12':       'LAB INST-PLY',
    'RFG PLY58':       'LAB INST-PLY',
    'RFG PLY34':       'LAB INST-PLY',
    'RFG TG34':        'LAB INST-PLY',
    'RFG BRD':         'LAB CARP-HR',
    'RFG STRUCT':      'LAB STR-HR',
    'RFG ROTR':        'LAB CARP-HR',
    'RFG CLIPS':       'LAB INST-CLIPS',
    'RFG FBLK':        'LAB CARP-HR',
    'GTR 5K-AL':       'LAB INST-GTR5',
    'GTR 5K-ST':       'LAB INST-GTR5',
    'GTR 5K-CU':       'LAB INST-GTR5',
    'GTR 6K-AL':       'LAB INST-GTR6',
    'GTR 6K-ST':       'LAB INST-GTR6',
    'GTR 6K-CU':       'LAB INST-GTR6',
    'GTR HR-AL':       'LAB INST-GTR5',
    'GTR HR-CU':       'LAB INST-GTR5',
    'GTR BOX-AL':      'LAB INST-GTR6',
    'CUP IWS-E':       'LAB INST-IWS',
    'CUP DRPE':        'LAB INST-DE',
    'CUP KICK':        'LAB INST-KICK',
    'CUP HC':          'LAB CARP-HR',
    'SPC CRK':         'LAB INST-CHM',
    'SPC DRM':         'LAB DTL-HR',
    'SPC CUP-I':       'LAB DTL-HR',
    'SPC CHM-C':       'LAB INST-CHM',
    'SPC CHM-CR':      'LAB INST-CHM'
  };

  function inferLaborId(item) {
    if (!item) return null;
    // Explicit field on the item always wins
    if (item.laborId) return item.laborId;
    // Per-code override
    if (LABOR_BY_CODE[item.code]) return LABOR_BY_CODE[item.code];
    // Subcategory default
    if (item.sub && LABOR_BY_SUB[item.sub] !== undefined) return LABOR_BY_SUB[item.sub];
    // Category default
    if (item.category && LABOR_BY_SUB[item.category] !== undefined) return LABOR_BY_SUB[item.category];
    // Fallback: no linked labor
    return null;
  }

  // ═════════════════════════════════════════════════════════
  // 5. Quantity formula inference
  //
  // Most items follow a predictable pattern based on their unit
  // and subcategory. Explicit qtyFormula on the item always wins.
  // ═════════════════════════════════════════════════════════

  // Gutter footage: ONE number per job (Jo, 2026-09-25, Draw-tool decision 2).
  // When gutter runs were drawn or measured (guttersLf > 0), those feet size
  // every gutter-footage line. When they were not, eave length stands in, as
  // it always has. Guards follow the same number.
  //
  // This used to be plain 'eaveLf' for 'gutters' and 'guards', while the per-SQ
  // engine (estimate-builder-v2.js calculatePerSq) and its generated line-item
  // scope price gutters from guttersLf. So one job with 81.8 LF of gutter and
  // 120 LF of eave had two gutter footages: 120 LF on its catalog scope lines
  // and 81.8 LF on its per-SQ quote. The measured feet were silently ignored
  // on the catalog side.
  //
  // QTY_BY_SUB.gutters is also the CATEGORY fallback for gutter lines with no
  // table entry of their own (hangers, end caps, miters, splash blocks, the
  // underground drain). Those have always been sized off eaveLf as a stand-in
  // for gutter footage, so they now read the real footage too. An explicit
  // quantity still wins everywhere: a rep's edit, or a template's stated
  // scope such as a 20 LF section repair, is never replaced by house footage.
  // With guttersLf absent, blank, non-numeric or <= 0 (buildContext stores 0
  // for all of them), this evaluates to exactly eaveLf, so estimates without
  // a gutter measurement are unchanged.
  const GUTTER_LF = 'guttersLf > 0 ? guttersLf : eaveLf';

  const QTY_BY_SUB = {
    'shingles-3tab':     'sq',
    'shingles-arch':     'sq',
    'shingles-designer': 'sq',
    'shingles-impact':   'sq',
    'shingles-cool':     'sq',
    'metal':             'sq',
    'wood':              'sq',
    'tile':              'sq',
    'slate':             'sq',
    'low-slope':         'sq',
    'underlayment':      'sq',
    'starter':           'eaveLf',
    'ridge':             'ridgeLf',
    'hip':               'hipLf',
    'drip-edge':         'eaveLf + rakeLf',
    'rake':              'rakeLf',
    'gutter-apron':      'eaveLf',
    'valley':            'valleyLf',
    'flashing':          'wallLf',            // Generic wall-linear flashing
    'ventilation':       'max(1, Math.ceil(adjustedSqft / 300))',
    'decking':           'adjustedSqft * deckReplacePct',
    'fasteners':         'sq',
    'gutters':           GUTTER_LF,
    'downspout':         'stories * 10',      // ~10 LF per story
    'guards':            GUTTER_LF,
    'fascia':            'eaveLf + rakeLf',
    'soffit':            'eaveLf',
    'labor-teardown':    'sq',
    'labor-install':     'sq',
    'labor-overhead':    '1',
    'labor-adder':       'sq',
    'disposal':          '1',
    'permits':           '1',
    'warranty':          '1',
    'code-upgrade':      'sq',
    'landscape-protection':'1',
    'emergency':         '1',
    'equipment':         '1'
  };

  const QTY_BY_CODE = {
    // Ridge vents follow ridge length, not per-300-SF rule
    'RFG RIDG-VNT':    'ridgeLf',
    'RFG RIDG-VNT-PL': 'ridgeLf',
    'RFG RIDG-VNT-PR': 'ridgeLf',
    'RFG HIP-VNT':     'hipLf',
    'RFG BFL':         'ridgeLf',
    'RFG SFT-C':       'eaveLf',
    'RFG SFT-I':       'max(1, Math.ceil(eaveLf / 4))',
    'RFG SMT':         'eaveLf',
    // Flashing & penetrations by count
    // Step flashing runs along wall-to-roof intersections. Using
    // ridgeLf + hipLf was a regression — ridge seams use ridge cap
    // and hip seams use hip cap, neither needs step flashing. If
    // wallLf is 0 the line correctly resolves to 0 (no walls, no
    // step flashing). User can still override via the pencil.
    'RFG STPF-AL':     'wallLf',
    'RFG STPF-CU':     'wallLf',
    'RFG CHIM-STD':    'chimneys',
    'RFG CHIM-SAD':    'chimneys',
    'RFG SKY-STD':     'skylights',
    'RFG SKY-CUS':     'skylights',
    'RFG PIPE-STD':    'pipes',
    'RFG PIPE-LD':     'pipes',
    'RFG PIPE-RTR':    'pipes',
    'RFG KICK':        'max(1, structures)',
    // Ventilation rules
    'RFG BOX-STD':     'max(1, Math.ceil(adjustedSqft / 300))',
    'RFG BOX-PRE':     'max(1, Math.ceil(adjustedSqft / 300))',
    'RFG PWR':         '1',
    'RFG SOLAR':       '1',
    'RFG TURB':        'max(1, Math.ceil(adjustedSqft / 600))',
    'RFG TURB14':      'max(1, Math.ceil(adjustedSqft / 800))',
    'RFG GBL':         '2',
    'RFG GBL-OCT':     '2',
    'RFG GBL-RND':     '2',
    'RFG CUP':         '1',
    // Underlayment specifics
    'RFG IWS':         'max(sq * 0.10, eaveLf * 3 / 100)', // 10% of sq OR 3ft band at eaves
    'RFG IWS-FC':      'sq',                                // full coverage
    // Decking replacement
    'RFG OSB716':      'adjustedSqft * deckReplacePct',
    'RFG OSB12':       'adjustedSqft * deckReplacePct',
    'RFG OSB58':       'adjustedSqft * deckReplacePct',
    'RFG PLY12':       'adjustedSqft * deckReplacePct',
    'RFG PLY58':       'adjustedSqft * deckReplacePct',
    'RFG PLY34':       'adjustedSqft * deckReplacePct',
    // H-clips — ~2 per linear foot of eave (typical spacing)
    'RFG CLIPS':       'eaveLf * 2',
    // Structural — manual entry
    'RFG STRUCT':      '0',
    'RFG ROTR':        '0',
    // Hurricane clips — ~1 per rafter, roughly eaveLf / 1.5
    'CUP HC':          'Math.max(10, Math.ceil(eaveLf / 1.5))',
    'CUP IWS-E':       'eaveLf',
    'CUP DRPE':        'eaveLf + rakeLf',
    'CUP KICK':        'max(1, structures)',
    'CUP VNT-R':       '1',
    'CUP FNR':         'sq',
    'CUP DCK-R':       'adjustedSqft',
    'CUP RB':          'adjustedSqft',
    // Tear-off labor lines (scale by layers)
    'LAB TO1':         'sq',
    'LAB TO2':         'sq',
    'LAB TO3':         'sq',
    'LAB TO-TL':       'sq',
    'LAB TO-MT':       'sq',
    'LAB TO-WD':       'sq',
    'LAB TO-SL':       'sq',
    // Adders apply per SQ
    'LAB ADR-2S':      'stories > 1 ? sq : 0',
    'LAB ADR-SS':      'pitch >= 8 ? sq : 0',
    'LAB ADR-VS':      'pitch >= 12 ? sq : 0',
    'LAB ADR-CU':      'cutUpRoof ? sq : 0',
    'LAB ADR-WK':      '0',        // Manual toggle
    'LAB ADR-OT':      '0',        // Manual hours
    // Overhead / docs — 1 per job
    'LAB MOB':         '1',
    'LAB DEMOB':       '1',
    'LAB JSP':         '1',
    'LAB CLN-M':       '1',
    'LAB PHOTO':       '1',
    'LAB WALK':        '1',
    'LAB SUP':         '1',
    // Emergency — manual
    'LAB WATR-D':      '0',
    'LAB TREE-R':      '0',
    // Detail hourly — manual
    'LAB DTL-HR':      '0',
    'LAB CARP':        '0',
    'LAB STR':         '0',
    'LAB BND-M':       '0',
    'LAB INST-SH':     'sq',
    'LAB INST-MT':     'sq',
    'LAB INST-MB':     'sq',
    'LAB INST-IWS':    'sq * 0.10',
    'LAB INST-FL':     'wallLf',
    'LAB INST-RC':     'ridgeLf + hipLf',
    'LAB INST-DE':     'eaveLf + rakeLf',
    // Disposal — based on job size
    'DSP 10YD':        'sq <= 15 ? 1 : 0',
    'DSP 20YD':        'sq > 15 && sq <= 25 ? 1 : 0',
    'DSP 30YD':        'sq > 25 && sq <= 40 ? 1 : 0',
    'DSP 40YD':        'sq > 40 ? 1 : 0',
    'DSP HAUL':        '0',
    'DSP DBR-H':       '0',
    'DSP TARP':        '0',
    'DSP OVER':        '0',
    // Fasteners
    'RFG NAIL-C':      'sq',
    'RFG NAIL-CAP':    'sq',
    'RFG NAIL-R':      'sq',
    'RFG NAIL-LUMA':   'sq',
    'RFG NAIL-SS':     'sq',
    'RFG SCRW-M':      'sq * 80',   // ~80 screws per SQ for metal
    'RFG CAP-P':       'sq * 40'    // ~40 cap nails per SQ for IWS
  };

  function inferQtyFormula(item) {
    if (!item) return '0';
    if (item.qtyFormula) return item.qtyFormula;
    if (QTY_BY_CODE[item.code]) return QTY_BY_CODE[item.code];
    if (item.sub && QTY_BY_SUB[item.sub]) return QTY_BY_SUB[item.sub];
    if (item.category && QTY_BY_SUB[item.category]) return QTY_BY_SUB[item.category];
    // Default by unit
    if (item.unit === 'SQ') return 'sq';
    if (item.unit === 'LF') return 'eaveLf';
    if (item.unit === 'SF') return 'adjustedSqft';
    if (item.unit === 'EA') return '1';
    if (item.unit === 'JOB') return '1';
    if (item.unit === 'DAY') return '1';
    if (item.unit === 'HR') return '0';
    return '0';
  }

  // ═════════════════════════════════════════════════════════
  // 6. Line item resolver — takes a catalog item + measurements
  //    and returns a fully-resolved line ready for rollup.
  // ═════════════════════════════════════════════════════════

  function resolveLineItem(item, measurements, opts) {
    opts = opts || {};
    const context = measurements && measurements.__resolved ? measurements : buildContext(measurements);
    const tier = opts.tier || 'better';

    // 1. Quantity — per-line override wins over formula. This is how
    //    the V2 Builder supports "Edit qty" on each scope item, and
    //    how presets that carry baked-in quantities (e.g. a tiny
    //    patch) can bypass the measurement-based formulas entirely.
    //    Override must be a finite non-negative number; anything else
    //    falls back to the formula path so we never silently NaN.
    const formula = item.qtyFormula || inferQtyFormula(item);
    let quantity;
    const rawOverride = (item._qtyOverride != null ? item._qtyOverride : item.qtyOverride);
    const numOverride = Number(rawOverride);
    if (rawOverride !== undefined && rawOverride !== null && rawOverride !== '' && Number.isFinite(numOverride) && numOverride >= 0) {
      quantity = numOverride;
    } else {
      quantity = calcQuantity(formula, context);
    }

    // 2. Material cost — explicit cost wins, otherwise lookup via materialId
    let matCostPerUnit;
    let matSource = null;
    if (item.materialCost != null) {
      matCostPerUnit = Number(item.materialCost);
      matSource = 'explicit';
    } else if (item.materialId) {
      const mat = resolveMaterial(item.materialId, tier);
      if (mat) {
        matCostPerUnit = mat.cost;
        matSource = 'NBD_PRODUCTS:' + item.materialId;
      } else {
        matCostPerUnit = 0;
      }
    } else {
      matCostPerUnit = 0;
    }

    // 3. Labor cost — explicit cost wins, otherwise lookup via laborId
    let labCostPerUnit;
    let labSource = null;
    const laborId = item.laborId || inferLaborId(item);
    if (item.laborCost != null) {
      labCostPerUnit = Number(item.laborCost);
      labSource = 'explicit';
    } else if (laborId) {
      const lab = resolveLabor(laborId);
      if (lab) {
        labCostPerUnit = lab.rate;
        labSource = 'NBD_LABOR:' + laborId;
      } else {
        labCostPerUnit = 0;
      }
    } else {
      labCostPerUnit = 0;
    }

    // 4. Roll up
    const materialTotal = quantity * matCostPerUnit;
    const laborTotal    = quantity * labCostPerUnit;
    const lineTotal     = materialTotal + laborTotal;

    return {
      code:           item.code,
      name:           item.name,
      description:    item.description || item.desc || '',
      category:       item.category,
      subcategory:    item.sub,
      unit:           item.unit,
      quantity:       quantity,
      qtyFormula:     formula,
      qtyOverridden:  (rawOverride !== undefined && rawOverride !== null && rawOverride !== '' && Number.isFinite(numOverride) && numOverride >= 0),
      materialCostPerUnit: matCostPerUnit,
      laborCostPerUnit:    labCostPerUnit,
      unitCost:       matCostPerUnit + labCostPerUnit,
      materialTotal:  materialTotal,
      laborTotal:     laborTotal,
      lineTotal:      lineTotal,
      laborId:        laborId,
      materialId:     item.materialId || null,
      matSource:      matSource,
      labSource:      labSource,
      // PRESENTATION ONLY — the engine never reads it back and no math above
      // branches on it. It marks a line whose cost basis this tenant has not
      // set (job-template custom items whose catalogCosts/{companyId}.jtCosts
      // entry is missing), so the UI can render "—" rather than "$0.00".
      // The line still carries an EXPLICIT materialCost/laborCost of 0, which
      // is what keeps labSource 'explicit' and stops inferLaborId (computed at
      // :803, BEFORE the laborCost != null test) resolving a public NBD_LABOR
      // rate for it. See docs/pro/js/job-templates.js:customLineItem.
      costUnset:      !!item.costUnset,
      tier:           item.tier || tier,
      codeRefs:       item.codeRefs || {},
      reason:         item.reason || '',
      insuranceDefault: !!item.insuranceDefault,
      requiresPhoto:    !!item.requiresPhoto,
      // A fixed CUSTOMER price per unit, O&P included (catalog 'MAT DEL',
      // 2026-09-27). null = the usual cost-plus retail. resolveEstimate reads it.
      fixedRetail:    (item.fixedRetail != null && item.fixedRetail !== '' && Number.isFinite(Number(item.fixedRetail)) && Number(item.fixedRetail) >= 0)
        ? Number(item.fixedRetail) : null,
      tags:           item.tags || []
    };
  }

  // ═════════════════════════════════════════════════════════
  // 7. Full estimate rollup — takes a list of line items +
  //    measurements + settings (OH&P, tax, minimum job) and
  //    returns the complete breakdown.
  // ═════════════════════════════════════════════════════════

  function resolveEstimate(lineItems, measurements, settings) {
    settings = settings || {};
    const context = buildContext(measurements);
    context.__resolved = true;

    const tier = settings.tier || 'better';
    const mode = settings.mode || 'cash';
    const overheadPct = Number(settings.overheadPct != null ? settings.overheadPct : 0.10);
    const profitPct   = Number(settings.profitPct != null ? settings.profitPct : 0.10);
    const materialMarkupPct = Number(settings.materialMarkupPct != null ? settings.materialMarkupPct : 0.25);
    // A minimum job charge is an OPT-IN business rule, not a default.
    //
    // This used to fall back to 2500 whenever the caller passed nothing — and
    // most callers pass nothing, because job-templates.js only sets
    // settings.minJobCharge when a template explicitly carries one
    // (job-templates.js:1009) and estimate-v2-ui.js only forwards
    // state.minJobCharge when it is non-null (state default: null).
    //
    // The result: a scope that never asked for a floor got one anyway. A
    // $555 pipe-boot repair priced out at $2,500, which is not a rounding
    // problem — it is a quote no homeowner accepts, on a business whose own
    // rate card has invoiced $125 and $225 jobs.
    //
    // The presets that genuinely want a floor set it themselves and still do:
    // 'small-repair' 2500, 'shingle-patch' 500 ("a trip charge, not a
    // job-level min"). The per-SQ replacement engine in estimate-builder-v2.js
    // keeps its own MIN_JOB_CHARGE default untouched — an undersized ROOF
    // REPLACEMENT is the case the floor was designed for, and that path is
    // where it still applies.
    const minJobCharge = Number(settings.minJobCharge != null ? settings.minJobCharge : 0);
    const roundTo      = Number(settings.roundTo || 25);

    // Resolve each line
    const resolved = (lineItems || []).map(item => resolveLineItem(item, context, { tier, mode }));

    // Roll up totals — and stamp each line's RETAIL price alongside its cost
    // basis. Material carries the shop markup; labor is priced as-is (its
    // margin comes through O&P), so Σ retailTotal == retailBeforeOHP exactly.
    // Customer-facing consumers (invoice items, server-rendered quote, saved
    // rows) must read retailTotal/retailPerUnit — lineTotal is the INTERNAL
    // cost and printing it exposes the margin (money-math sweep 2026-07-18).
    //
    // A line with a FIXED customer price (fixedRetail — catalog 'MAT DEL',
    // $150 per job, Jo 2026-09-27) is the one exception to cost-plus: its
    // row carries fixedRetail / (1 + overhead + profit), so once the O&P rows
    // are added it foots to exactly fixedRetail, whatever the markup ladder.
    // Its COST still counts in materialCost / hardCost — the margin report
    // books what the trip costs, not what is charged. The identity
    // Σ retailTotal == retailBeforeOHP still holds (materialRetail is derived
    // from it below).
    let materialCost = 0;
    let laborCost = 0;
    let retailSum = 0;
    const ohpFactor = 1 + overheadPct + profitPct;
    resolved.forEach(line => {
      materialCost += line.materialTotal;
      laborCost    += line.laborTotal;
      if (line.fixedRetail != null && ohpFactor > 0) {
        line.retailPerUnit = line.fixedRetail / ohpFactor;
        line.retailTotal   = line.quantity * line.fixedRetail / ohpFactor;
      } else {
        line.retailPerUnit = line.materialCostPerUnit * (1 + materialMarkupPct) + line.laborCostPerUnit;
        line.retailTotal   = line.materialTotal * (1 + materialMarkupPct) + line.laborTotal;
      }
      retailSum += line.retailTotal;
    });

    const hardCost       = materialCost + laborCost;
    const retailBeforeOHP = retailSum;
    const materialRetail = retailBeforeOHP - laborCost;

    const overhead = retailBeforeOHP * overheadPct;
    const profit   = retailBeforeOHP * profitPct;
    const subtotal = retailBeforeOHP + overhead + profit;

    // Tax (insurance hides tax).
    // Tax rates come from (in priority order):
    //   1. settings.countyTax — explicitly passed by caller
    //   2. EstimateBuilderV2 live settings — fallback for UI flows
    //      that don't pass countyTax through
    //   3. settings.fallbackTaxRate or 7% — last resort
    // getCountyTaxMap (county-jurisdiction settings, 2026-07-29) is the
    // jurisdictions-overlaid map (loadSettings().countyTax + the tenant's
    // customJurisdictions); prefer it when the loaded engine exports it and
    // keep the plain loadSettings read as the fallback for older stubs.
    const countyTaxMap = (settings.countyTax && typeof settings.countyTax === 'object')
      ? settings.countyTax
      : (window.EstimateBuilderV2
          ? (typeof window.EstimateBuilderV2.getCountyTaxMap === 'function'
              ? (window.EstimateBuilderV2.getCountyTaxMap() || {})
              : (window.EstimateBuilderV2.loadSettings().countyTax || {}))
          : {});
    // Blank-county fallback. Two bugs lived on this line:
    //   1. `settings.fallbackTaxRate || 0.07` swallowed an explicit 0, so a
    //      tenant that owes NO sales tax still got 7% — phantom tax on
    //      customer-facing paper.
    //   2. No caller passes fallbackTaxRate (estimate-v2-ui and job-templates
    //      send only {tier, mode, county}), so the tenant's company-wide rate
    //      never reached this path at all: the per-SQ quote used 9.25% while
    //      the catalog / Job-Template scope for the same customer used 7%.
    // Resolve it the same way the county map is resolved — from the engine.
    const _fbSetting = (settings.fallbackTaxRate != null && settings.fallbackTaxRate !== '' && Number.isFinite(Number(settings.fallbackTaxRate)))
      ? Number(settings.fallbackTaxRate)
      : null;
    const _fbTenant = (_fbSetting == null
      && typeof window !== 'undefined' && window.EstimateBuilderV2
      && typeof window.EstimateBuilderV2.getFallbackTaxRate === 'function')
      ? Number(window.EstimateBuilderV2.getFallbackTaxRate())
      : null;
    const fallbackRate = (_fbSetting != null) ? _fbSetting
      : (Number.isFinite(_fbTenant) ? _fbTenant : 0.07);
    const taxRate = (mode === 'insurance')
      ? 0
      : (countyTaxMap[settings.county || ''] != null
          ? Number(countyTaxMap[settings.county])
          : fallbackRate);
    const tax = subtotal * taxRate;

    let total = subtotal + tax;
    total = Math.round(total / roundTo) * roundTo;

    let minJobApplied = false;
    if (total < minJobCharge) {
      total = minJobCharge;
      minJobApplied = true;
    }

    const margin = total - hardCost;
    const marginPct = total > 0 ? (margin / total) * 100 : 0;

    return {
      method: 'line-item',
      context,
      tier,
      mode,
      lines: resolved,
      lineCount: resolved.length,
      materialCost,
      materialRetail,
      laborCost,
      hardCost,
      retailBeforeOHP,
      overhead,
      overheadPct,
      profit,
      profitPct,
      materialMarkupPct,
      subtotal,
      taxRate,
      tax,
      total,
      minJobApplied,
      minJobCharge,
      // How many resolved lines carry no tenant cost basis. Additive and
      // presentation-only — nothing above reads it, so Σ retailTotal ==
      // retailBeforeOHP still holds and no downstream consumer
      // (estimate-finalization, estimate-supplement, invoice-pipeline,
      // profit-tracker) sees a shape change. It exists so a caller can say
      // "3 items need a cost" without re-walking lines[].
      costUnsetCount: resolved.reduce(function (n, l) { return n + (l.costUnset ? 1 : 0); }, 0),
      internal: {
        materialCost,
        laborCost,
        hardCost,
        margin,
        marginPct
      }
    };
  }

  // ═════════════════════════════════════════════════════════
  // 8. Packaging / ordering unit converter
  //
  // When Joe needs to place an order, each line item's selling
  // unit (SQ, LF, EA) converts to the vendor's packaging unit
  // (Box, Bundle, Roll, etc.) so the purchase order is in the
  // quantities suppliers actually ship.
  // ═════════════════════════════════════════════════════════

  function convertToOrderingUnit(item, quantity, materialInfo) {
    // Try to pull packaging from the item itself first
    const pack = (item && item.packaging) || (materialInfo && materialInfo.packaging);
    if (!pack) {
      return { qty: quantity, unit: item.unit, converted: false };
    }

    const coverage = Number(pack.coverage);
    if (!coverage || coverage <= 0) {
      return { qty: quantity, unit: item.unit, converted: false };
    }

    const boxes = Math.ceil(quantity / coverage);
    return {
      qty: boxes,
      unit: pack.unit || 'Box',
      converted: true,
      perUnit: coverage,
      costPerUnit: pack.costPerBox || null,
      totalCost: pack.costPerBox ? boxes * pack.costPerBox : null
    };
  }

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════
  window.EstimateLogic = {
    MEASUREMENT_VARS,
    LABOR_BY_SUB,
    LABOR_BY_CODE,
    QTY_BY_SUB,
    QTY_BY_CODE,

    buildContext,
    calcQuantity,
    resolveMaterial,
    resolveLabor,
    inferLaborId,
    inferQtyFormula,
    resolveLineItem,
    resolveEstimate,
    convertToOrderingUnit
  };

  console.log('[EstimateLogic] 3-catalog linked engine ready.');
})();
