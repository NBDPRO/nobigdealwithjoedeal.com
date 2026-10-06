/**
 * tenant-rules.js — per-company BUSINESS RULES (2026-10-04, tenant-ready).
 *
 * WHY: NBD's own rules were fixed in estimate-config.js and deposit-rule.js —
 * five tiers named Economy/Standard/Preferred/Elite/Beyond, Beyond locked to
 * TAMKO HailGuard, Economy never a 3-tab, a lifetime-workmanship warranty
 * ladder, a 50%-over-$2,000 deposit, 7% fallback tax and permit costs for
 * seven Ohio/Kentucky counties. Every other company that signed up inherited
 * all of it, and none of it could be changed.
 *
 * Now each company keeps its own copy in companyProfile/{companyId}:
 *   businessRules.tiers.enabled      ['good','better','best', …] (the internal
 *                                    keys never change — only which are offered)
 *   businessRules.tiers.labels       { good: 'Standard', … } customer-facing names
 *   businessRules.tiers.notes        { good: 'Architectural shingle', … } rep-facing card notes
 *   businessRules.tiers.warranty     { good: '<sentence>', … } the warranty sentence
 *   businessRules.tiers.shingleLocks { beyond: { onlyCodes:[…], onlyName }, economy: { no3Tab:true } }
 *   businessRules.deposit            { noDepositUnderCents, depositPct, roundToCents }
 *   pricing.tierRates / pricing.fallbackTaxRate / pricing.permits   (existing
 *                                    company pricing, edited in Settings → Estimates)
 *
 * DEFAULTS — the rule Jo set (2026-10-04): every setting defaults to NBD's
 * current values FOR NBD ONLY. Any other company starts NEUTRAL:
 *   three tiers (good/better/best) with plain names, no warranty promise (a
 *   neutral sentence pointing to the written agreement), no shingle locks, no
 *   deposit until they set one, 0% fallback tax and $0 permit rows until they
 *   enter theirs. Tier RATES keep the published starter rates so an estimate
 *   is never $0 — the setup checklist flags them until the company sets its own.
 *
 * NBD IS BYTE-IDENTICAL: for the platform tenant every accessor below returns
 * null ("no override — use estimate-config / deposit-rule as before") unless
 * NBD itself saved a businessRules value. estimate-config.js's tierLabel /
 * tierWarrantyText / tierWarrantyBlurb / checkTierShingles / tierOrder and
 * deposit-rule.js's config() ask here first and fall through on null.
 *
 * KENTUCKY: nothing here touches the Kentucky insurance holds. Those stay keyed
 * to the PROPERTY's state in ky-insurance-law.js / deposit-rule.js, for every
 * tenant — a company setting can never switch them off.
 *
 * WHO IS NBD: the companyId claim (or uid for a solo owner) equals the NBD
 * owner uid. When the identity is not known yet (pre-auth, unit sandboxes) the
 * company-profile brand decides, the same _isNbdBrand test company-profile.js
 * uses — so a page that never signs in still renders NBD exactly as before.
 */
(function () {
  'use strict';

  var OWNER_UID = (typeof window !== 'undefined' && window.__NBD_OWNER_UID) || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  var NBD_LEGAL = 'No Big Deal Home Solutions';
  var TIER_KEYS = ['economy', 'good', 'better', 'best', 'beyond'];

  // ── Neutral (non-NBD) defaults ─────────────────────────────────────────
  var NEUTRAL = Object.freeze({
    enabled: Object.freeze(['good', 'better', 'best']),
    labels: Object.freeze({ economy: 'Economy', good: 'Good', better: 'Better', best: 'Best', beyond: 'Premium' }),
    notes: Object.freeze({ economy: 'Entry-level system', good: 'Standard system', better: 'Upgraded system', best: 'Premium system', beyond: 'Top-of-line system' }),
    // A warranty is a promise only the contractor can make. Until a company
    // writes its own, documents print this neutral sentence (no "lifetime",
    // no transferability, no inspection — all of those were NBD's terms).
    warrantyText: 'The shingle manufacturer’s standard limited warranty applies to the materials. Workmanship warranty terms are as stated in your written agreement.',
    warrantyBlurb: '',
    deposit: Object.freeze({ CASH_NO_DEPOSIT_UNDER_CENTS: 0, CASH_DEPOSIT_PCT: 0, CASH_DEPOSIT_ROUND_TO_CENTS: 2500 }),
    fallbackTaxRate: 0,
    permitCost: 0
  });

  // NBD's own card notes — byte-identical to estimate-v3-wizard.js TIER_NOTES
  // (tests/tenant-ready-2026-10-04.test.js pins the two together). Shown in
  // the editor for NBD; the V3 cards keep reading their own copy.
  var NBD_NOTES = Object.freeze({
    economy: 'Builder-grade shingle · 1-yr labor warranty',
    good: 'Architectural shingle',
    better: 'Upgraded system · most popular',
    best: 'Premium system',
    beyond: 'TAMKO HailGuard — locked · hail warranty'
  });

  function _w() { return (typeof window !== 'undefined') ? window : {}; }

  function _profile() {
    var w = _w();
    return w._companyProfile || null;
  }

  function _rawRules() {
    var p = _profile();
    var r = p && p.businessRules;
    return (r && typeof r === 'object') ? r : {};
  }

  // The signed-in company key, synchronously: companyId claim → uid. null
  // when nobody is signed in yet.
  function companyKey() {
    var w = _w();
    try {
      var c = w._userClaims || {};
      if (c.companyId) return String(c.companyId);
    } catch (_) { /* ignore */ }
    try {
      var u = (w.auth && w.auth.currentUser) || w._user || null;
      if (u && u.uid) return String(u.uid);
    } catch (_) { /* ignore */ }
    return null;
  }

  function isPlatformTenant() {
    var key = companyKey();
    if (key) return key === OWNER_UID;
    // Identity unknown: fall back to the brand (NBD defaults until a tenant
    // brand is loaded) — exactly how company-profile.js renders pre-auth.
    var p = _profile();
    var b = p && p.brand;
    return !b || !b.legalName || b.legalName === NBD_LEGAL;
  }

  function _str(v, max) {
    return (typeof v === 'string') ? v.trim().slice(0, max || 200) : '';
  }

  // ── Tiers ──────────────────────────────────────────────────────────────
  function _cfg() { return _w().NBD_ESTIMATE_CONFIG || null; }

  // Enabled tiers, always in canonical cheapest-first order, never empty.
  function tierOrder() {
    var raw = _rawRules().tiers || {};
    var en = Array.isArray(raw.enabled) ? raw.enabled.filter(function (t) { return TIER_KEYS.indexOf(t) !== -1; }) : null;
    if (en && en.length) return TIER_KEYS.filter(function (t) { return en.indexOf(t) !== -1; });
    if (isPlatformTenant()) {
      var cfg = _cfg();
      return (cfg && Array.isArray(cfg.TIER_ORDER)) ? cfg.TIER_ORDER.slice() : TIER_KEYS.slice();
    }
    return NEUTRAL.enabled.slice();
  }

  // Override-or-null helpers: null means "use estimate-config's own answer".
  // NBD's built-in wording (estimate-config.js, company override skipped).
  function _builtin(method, tier) {
    var cfg = _cfg();
    return (cfg && typeof cfg[method] === 'function') ? cfg[method](tier, true) : null;
  }

  function labelOverride(tier) {
    var raw = (_rawRules().tiers || {}).labels || {};
    var v = _str(raw[tier], 40);
    if (v) return v;
    if (isPlatformTenant()) return null;
    return NEUTRAL.labels[tier] || null;
  }
  function noteFor(tier) {
    var raw = (_rawRules().tiers || {}).notes || {};
    var v = _str(raw[tier], 80);
    if (v && !(isPlatformTenant() && v === NBD_NOTES[tier])) return v;
    if (isPlatformTenant()) return null;
    return NEUTRAL.notes[tier] || '';
  }
  // A saved sentence that is just NBD's own built-in one (NBD pressed Save
  // without changing it) is NOT an override — so NBD's short card blurbs
  // keep coming from estimate-config, unchanged.
  // NBD's built-in sentences BEFORE GAF System Plus joined Standard/Preferred/
  // Elite (2026-10-05). NBD saving one of these meant "keep the built-in", so
  // it must follow the built-in forward — not freeze the old wording (without
  // System Plus) as if it were a company-written override.
  var LEGACY_BUILTIN_WARRANTY = {
    good: 'Lifetime workmanship warranty; does not transfer on sale of property.',
    better: 'Lifetime workmanship warranty; transferable to one subsequent owner within 30 days of sale.',
    best: 'Lifetime workmanship warranty; fully transferable — follows the property through all subsequent owners; annual courtesy inspection included.'
  };
  var LEGACY_BUILTIN_BLURB = {
    good: 'Non-transferable', better: 'Transferable to 1 subsequent owner', best: 'Fully transferable + annual inspection'
  };
  function _ownWarranty(tier) {
    var raw = (_rawRules().tiers || {}).warranty || {};
    var v = _str(raw[tier], 400);
    if (!v) return '';
    if (isPlatformTenant() && (v === _builtin('tierWarrantyText', tier) || v === LEGACY_BUILTIN_WARRANTY[tier])) return '';
    return v;
  }
  function warrantyTextOverride(tier) {
    var v = _ownWarranty(tier);
    if (v) return v;
    if (isPlatformTenant()) return null;
    return NEUTRAL.warrantyText;
  }
  function warrantyBlurbOverride(tier) {
    var v = _ownWarranty(tier);
    // A company that adopted NBD's own sentence for this tier gets NBD's
    // short blurb with it, not a truncation.
    if (v && v === _builtin('tierWarrantyText', tier)) return _builtin('tierWarrantyBlurb', tier);
    // …and one that adopted NBD's pre-System-Plus sentence keeps that
    // sentence's own short blurb (it says nothing about System Plus).
    if (v && v === LEGACY_BUILTIN_WARRANTY[tier]) return LEGACY_BUILTIN_BLURB[tier];
    // A company-written sentence is its own blurb (cards print it short).
    if (v) return v.length > 90 ? v.slice(0, 87).replace(/\s+\S*$/, '') + '…' : v;
    if (isPlatformTenant()) return null;
    return NEUTRAL.warrantyBlurb;
  }

  // Shingle lock for a tier, in estimate-config's TIER_SHINGLE_RULES shape
  // ({ onlyCodes, onlyName } / { forbidSubs }), or:
  //   undefined → no override, estimate-config's rule stands (NBD default)
  //   null      → explicitly no rule for this tier
  function shingleRuleOverride(tier) {
    var raw = (_rawRules().tiers || {}).shingleLocks;
    if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, tier)) {
      var r = raw[tier];
      if (!r || typeof r !== 'object') return null;
      var codes = Array.isArray(r.onlyCodes) ? r.onlyCodes.map(function (c) { return _str(c, 60); }).filter(Boolean) : [];
      var out = {};
      if (codes.length) { out.onlyCodes = codes; out.onlyName = _str(r.onlyName, 60) || codes.join(', '); }
      if (r.no3Tab === true) out.forbidSubs = ['shingles-3tab'];
      return (out.onlyCodes || out.forbidSubs) ? out : null;
    }
    if (isPlatformTenant()) return undefined;
    return null; // a new company has no shingle locks until it sets one
  }

  // ── Deposit ────────────────────────────────────────────────────────────
  // deposit-rule.js config() shape, or null for "use the configured rule".
  function depositConfig() {
    var raw = _rawRules().deposit;
    if (raw && typeof raw === 'object') {
      var under = Number(raw.noDepositUnderCents);
      var pct = Number(raw.depositPct);
      var round = Number(raw.roundToCents);
      return {
        CASH_NO_DEPOSIT_UNDER_CENTS: (isFinite(under) && under >= 0) ? Math.round(under) : 0,
        CASH_DEPOSIT_PCT: (isFinite(pct) && pct >= 0 && pct <= 100) ? Math.round(pct) : 0,
        CASH_DEPOSIT_ROUND_TO_CENTS: (isFinite(round) && round >= 1) ? Math.round(round) : 2500
      };
    }
    if (isPlatformTenant()) return null;
    return Object.assign({}, NEUTRAL.deposit);
  }

  // ── Tax + permits base (before the company's own pricing overlay) ──────
  // null for NBD (estimate-config's 7% / county table stand).
  function neutralFallbackTaxRate() {
    return isPlatformTenant() ? null : NEUTRAL.fallbackTaxRate;
  }
  function neutralPermitCost() {
    return isPlatformTenant() ? null : NEUTRAL.permitCost;
  }

  // Has the company set its own package prices? (setup checklist)
  function ratesSet() {
    var p = _profile();
    var r = p && p.pricing && p.pricing.tierRates;
    if (!r || typeof r !== 'object') return false;
    return Object.keys(r).some(function (k) { var n = Number(r[k]); return r[k] !== '' && r[k] != null && isFinite(n) && n > 0; });
  }

  // Lower-case file-name prefix for the company's own CSV / ZIP exports
  // (2026-10-04): 'nbd' for NBD (unchanged file names), otherwise the
  // company's name as a slug — a contractor's export is named after the
  // contractor, never "nbd-leads-…".
  function filePrefix() {
    if (isPlatformTenant()) return 'nbd';
    var p = _profile();
    var b = (p && p.brand) || {};
    var s = String(b.displayName || b.legalName || p && p.businessName || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return s || 'company';
  }

  // Everything resolved, for the Settings editor.
  function resolved() {
    var cfg = _cfg() || {};
    var platform = isPlatformTenant();
    var out = { platform: platform, enabled: tierOrder(), tiers: {}, deposit: null };
    TIER_KEYS.forEach(function (t) {
      var lab = labelOverride(t);
      var war = warrantyTextOverride(t);
      var sh = shingleRuleOverride(t);
      if (sh === undefined) sh = (cfg.TIER_SHINGLE_RULES && cfg.TIER_SHINGLE_RULES[t]) || null;
      out.tiers[t] = {
        label: lab != null ? lab : (typeof cfg.tierLabel === 'function' ? cfg.tierLabel(t) : t),
        note: noteFor(t) || (platform ? NBD_NOTES[t] : '') || '',
        warranty: war != null ? war : (typeof cfg.tierWarrantyText === 'function' ? cfg.tierWarrantyText(t) : ''),
        onlyCodes: (sh && sh.onlyCodes) ? sh.onlyCodes.slice() : [],
        onlyName: (sh && sh.onlyName) || '',
        no3Tab: !!(sh && sh.forbidSubs && sh.forbidSubs.indexOf('shingles-3tab') !== -1)
      };
    });
    var dep = depositConfig();
    out.deposit = dep || Object.assign({}, cfg.DEPOSIT_RULE || { CASH_NO_DEPOSIT_UNDER_CENTS: 200000, CASH_DEPOSIT_PCT: 50, CASH_DEPOSIT_ROUND_TO_CENTS: 2500 });
    return out;
  }

  var API = {
    OWNER_UID: OWNER_UID,
    TIER_KEYS: TIER_KEYS.slice(),
    NEUTRAL: NEUTRAL,
    NBD_NOTES: NBD_NOTES,
    companyKey: companyKey,
    isPlatformTenant: isPlatformTenant,
    tierOrder: tierOrder,
    labelOverride: labelOverride,
    noteFor: noteFor,
    warrantyTextOverride: warrantyTextOverride,
    warrantyBlurbOverride: warrantyBlurbOverride,
    shingleRuleOverride: shingleRuleOverride,
    depositConfig: depositConfig,
    neutralFallbackTaxRate: neutralFallbackTaxRate,
    neutralPermitCost: neutralPermitCost,
    ratesSet: ratesSet,
    filePrefix: filePrefix,
    resolved: resolved
  };

  if (typeof window !== 'undefined') window.NBDTenantRules = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
