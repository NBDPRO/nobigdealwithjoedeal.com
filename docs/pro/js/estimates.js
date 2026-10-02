// ============================================================
// NBD Pro — estimates.js
// Inline estimate builder (original), calculations, tier pricing
// Extracted from dashboard.html for maintainability
// ============================================================
//
// ── PRICING MODEL (Estimate Builder v2, 2026-04-23) ──────────
// Per the locked site-wide spec, customer price = SQ × TIER_RATE
// plus itemized add-ons (permit, dump, extra tear-off layers,
// gutters, valley metal, etc). The previous cost-plus-markup
// sum-of-line-items model under-priced jobs by roughly $10K at
// Better tier — a 39-SQ Better job quoted $12,672 vs the correct
// $23,205 (39 × $595).
//
// The itemized line items produced by getLineItems() are retained
// but are now the internal cost basis used by the "Internal View"
// toggle to surface markup + margin; they no longer drive the
// customer-facing grand total.
//
// ── Source of truth: estimate-config.js (Rock 2 PR 3) ─────────
// These constants are now mirrored in window.NBD_ESTIMATE_CONFIG
// so estimates.js (classic) and estimate-builder-v2.js read from
// the same place. Inline fallbacks preserve historical values if
// estimate-config.js fails to load — the page still prices, and
// the warn surfaces a Sentry breadcrumb.
let _NBD_EST_DELEGATE; // module-local (globals Tranche 1 — was window.*)
const _NBD_CFG = (typeof window !== 'undefined' && window.NBD_ESTIMATE_CONFIG) || null;
if (!_NBD_CFG && typeof console !== 'undefined') {
  try { console.warn('[estimates.js] NBD_ESTIMATE_CONFIG missing — using inline fallbacks. Check that estimate-config.js loaded before estimates.js.'); } catch (_) {}
}
const TIER_RATES        = (_NBD_CFG && _NBD_CFG.TIER_RATES)         || { economy: 440, good: 550, better: 660, best: 770, beyond: 880 };
const JOB_MINIMUM_CENTS = (_NBD_CFG && _NBD_CFG.JOB_MINIMUM_CENTS)  || 250000; // $2,500
const ROUND_TO_CENTS    = (_NBD_CFG && _NBD_CFG.ROUND_TO_CENTS)     || 2500;   // Nearest $25

// Customer-facing tier name (GBB audit, 2026-09-09: this file independently
// invented a THIRD tier vocabulary — "Standard Reroof/Reroof Plus/Full
// Redeck" — shown on the same printed estimate as the literal words "Good—"/
// "Better—"/"Best—" two paragraphs apart). Internal good/better/best keys
// (TIER_RATES above) never change; every customer-facing render below reads
// this instead of inventing its own label.
const TIER_DISPLAY = (_NBD_CFG && _NBD_CFG.TIER_DISPLAY)
  || { economy: { label: 'Economy' }, good: { label: 'Standard' }, better: { label: 'Preferred' }, best: { label: 'Elite' }, beyond: { label: 'Beyond' } };
function tierLabel(tier) {
  return (TIER_DISPLAY[tier] && TIER_DISPLAY[tier].label) || tier;
}

// Ohio + Northern Kentucky county sales tax rates. Insurance mode hides
// the line; Cash mode shows it and adds to total. Canonical table lives
// in estimate-config.js keyed by county slug (PR 3b); classic keys by
// bare county name, so derive that map from each entry's `name`. Inline
// fallback preserves historical values if the config didn't load.
const COUNTY_TAX_RATES = (_NBD_CFG && _NBD_CFG.COUNTY_TAX)
  ? Object.fromEntries(Object.values(_NBD_CFG.COUNTY_TAX).map(c => [c.name, c.rate]))
  : {
      Hamilton: 0.0780, Butler: 0.0725, Warren: 0.0675, Clermont: 0.0725,
      Kenton:   0.0600, Boone:  0.0600, Campbell: 0.0600,
    };
const DEFAULT_TAX_RATE = (_NBD_CFG && _NBD_CFG.DEFAULT_TAX_RATE) || 0.0700; // fallback

// Permit cost by city. Values are editable at runtime via estData.permitCost
// override (so these are just defaults). Canonical costs live in
// estimate-config.js keyed by county slug; classic keys by CITY, so derive
// city→cost through PERMIT_CITY_TO_COUNTY (the D-1 unify basis, Joe
// 2026-06-09 — each city's default is its primary county's cost; Loveland
// spans 3 counties → Hamilton primary, rep can override). Inline fallback
// preserves historical values if the config didn't load.
const PERMIT_COSTS = (_NBD_CFG && _NBD_CFG.PERMIT_COSTS_BY_COUNTY && _NBD_CFG.PERMIT_CITY_TO_COUNTY)
  ? Object.fromEntries(Object.entries(_NBD_CFG.PERMIT_CITY_TO_COUNTY).map(([city, slug]) => [
      city,
      (_NBD_CFG.PERMIT_COSTS_BY_COUNTY[slug] || {}).cost || _NBD_CFG.DEFAULT_PERMIT_COST || 150,
    ]))
  : {
      Cincinnati: 185, Hamilton: 150, Fairfield: 150, Mason: 165,
      'West Chester': 150, Milford: 170, Loveland: 185,
      'Fort Thomas': 130, Covington: 125, Florence: 135, Newport: 130,
    };
const DEFAULT_PERMIT_COST = (_NBD_CFG && _NBD_CFG.DEFAULT_PERMIT_COST) || 150;
// Fallbacks below mirror what's in estimate-config.js — if that file
// fails to load, the inline values preserve historical behavior.
const DEFAULT_DUMP_FEE             = (_NBD_CFG && _NBD_CFG.DEFAULT_DUMP_FEE)              || 550;  // editable per-estimate
const LAYER_TEAROFF_PER_SQ_CENTS   = (_NBD_CFG && _NBD_CFG.TEAR_OFF_EXTRA_PER_SQ_CENTS)   || 5000; // +$50/SQ per extra layer
const CUT_UP_WASTE_BONUS           = (_NBD_CFG && _NBD_CFG.CUT_UP_ROOF_WASTE_BONUS)       || 0.03; // +3% for cut-up roof

// All dollar math stays in cents internally to avoid float drift.
const _toCents   = (d) => Math.round(d * 100);
const _fromCents = (c) => c / 100;
const _roundUpTo = (cents, step) => Math.ceil(cents / step) * step;
const _applyJobMin = (cents) => Math.max(cents, JOB_MINIMUM_CENTS);
const _roundNearest25 = (cents) => Math.round(cents / ROUND_TO_CENTS) * ROUND_TO_CENTS;

// ── Deprecation telemetry (Rock 2 PR 2) ─────────────────────────
// Every classic pricing-math function below is duplicated by
// EstimateBuilderV2. We warn once per page load when a deprecated
// path runs so we can see in field logs which classic surfaces are
// still hot before deleting them. console.warn passes through
// console-quiet.js (Sentry needs warnings).
//
// 2026-08-31: console.warn alone never reaches Sentry as an event —
// the SDK only records it as a breadcrumb attached to *error* events
// (no captureConsoleIntegration is configured), so the wizard-deletion
// gate ("zero warns in the prod log") could never observe its signal.
// We now also ship each warn as a real Sentry warning event when the
// SDK is loaded. Volume is bounded: once per page load per function
// name, and only when a deprecated path actually runs.
//
// Migration plan: docs/dev/estimate-engines-audit.md
const _deprecationsWarned = new Set();
function _warnDeprecatedOnce(name, replacement) {
  if (_deprecationsWarned.has(name)) return;
  _deprecationsWarned.add(name);
  const msg =
    '[estimates.js DEPRECATED] ' + name + ' is duplicated by ' + replacement +
    '. Migration plan: docs/dev/estimate-engines-audit.md';
  try {
    console.warn(msg);
  } catch (_) {}
  try {
    if (window.Sentry && typeof window.Sentry.captureMessage === 'function') {
      window.Sentry.captureMessage(msg, 'warning');
    }
  } catch (_) {}
}

// DEFAULT_RATES / PRODUCT_MAP / syncRatesFromProductLibrary moved to
// product-library.js (Rock 2 PR 6). It is the only writer of window.R,
// which eager property-intel.js reads, so it must not depend on the
// classic engine surviving. The map is re-exported as
// window.NBD_ESTIMATE_PRODUCT_MAP for getProductName() below.

// startNewEstimate() + showNewEstimateChooser() moved to estimate-entry.js
// (Rock 2 PR 6) — pure V2 routing, not part of the classic engine.

function startNewEstimateOriginal() {
  // Rock 2 PR 5: no UI path reaches this for NEW estimates anymore (V2-only
  // per Jo, 2026-07-04). Reachable only via console/legacy bookmarks; the
  // warn tells us if anything real still lands here before final deletion.
  _warnDeprecatedOnce('startNewEstimateOriginal', 'openEstimateV2Builder');
  const list    = document.getElementById('est-list');
  const builder = document.getElementById('est-builder');
  if (!builder) { console.warn('Estimate builder not in DOM'); return; }
  if (list)    list.style.display='none';
  builder.style.display='flex';
  builder.style.flexDirection='column';
  estCurrentStep=0; selectedTier=null; estData={};
  window._estLinkedLeadId = null;
  window._editingEstimateId = null;
  const titleEl = document.getElementById('estBuilderTitle');
  if (titleEl) titleEl.textContent = 'New Estimate';
  showEstStep(1);
  const note = document.getElementById('drawImportNote');
  if (note) note.style.display='none';
  ['estAddr','estOwner','estParcel','estYear','estRawSqft','estRidge','estEave','estHip'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const pipes = document.getElementById('estPipes');
  if (pipes) pipes.value='4';
  updateEstCalc();
}

function cancelEstimate() {
  const list    = document.getElementById('est-list');
  const builder = document.getElementById('est-builder');
  if (list)    list.style.display='block';
  if (builder) builder.style.display='none';
  window._editingEstimateId = null;
  window._estLinkedLeadId = null;
  // Reset shared state so the next New Estimate / Edit starts clean.
  // Without this, builder state (selected tier, estData) bleeds into
  // the next session — the underlying mechanism behind the silent
  // corruption bug fixed in viewEstimate (Audit 2026-05-19).
  selectedTier = null;
  estData = {};
  estCurrentStep = 0;
}

function showEstStep(n) {
  [1,2,3,4].forEach(i=>{
    const step = document.getElementById('estStep'+i);
    if (step) step.style.display=i===n?'block':'none';
    const sEl=document.getElementById('estS'+i);
    if (sEl) sEl.className='est-step'+(i<n?' done':i===n?' active':'');
  });
  estCurrentStep=n;
}

function estNext(from) {
  if(from===1){
    const rawEl = document.getElementById('estRawSqft');
    const rawVal = rawEl ? parseFloat(rawEl.value) : NaN;
    if(!rawVal || rawVal <= 0 || isNaN(rawVal)){showToast('Enter a valid square footage (greater than 0)','error');return;}
    if(rawVal > 100000){showToast('Square footage seems too high — please double-check','error');return;}
    updateEstCalc(); showEstStep(2);
  } else if(from===2){
    const ridge=parseFloat(document.getElementById('estRidge')?.value)||0;
    const eave=parseFloat(document.getElementById('estEave')?.value)||0;
    if(ridge < 0 || eave < 0){showToast('Measurements cannot be negative','error');return;}
    updateEstCalc(); calcTierPrices(); showEstStep(3);
  } else if(from===3){
    if(!selectedTier){showToast('Select a tier/package','error');return;}
    if(!estData.prices||!estData.prices.good){showToast('Calculate pricing first','error');return;}
    buildReview(); showEstStep(4);
  }
}
function estBack(from){ showEstStep(from-1); }

// Map pitch → recommended waste factor. Steeper roofs lose more material
// to cuts; this mirrors the IKO/Owens-Corning shingle waste tables and
// is what every experienced estimator does in their head. The "cut-up
// roof" checkbox adds another +3% per spec for dormers/valleys/etc.
/** @deprecated Use EstimateBuilderV2.wasteFactorForPitch — see docs/dev/estimate-engines-audit.md */
function recommendedWasteForPitch(pitchFactor) {
  // D-2 unify (Joe 2026-06-09): delegate to the validated V2 waste table so a
  // classic estimate gets the SAME waste as V2 for the same pitch. classic
  // passes the slope-area FACTOR (√(1+(rise/run)²)); V2 keys on the rise/run
  // RATIO, so convert: ratio = √(factor²−1). Falls back to the legacy table
  // only if the V2 engine isn't loaded.
  const pf = Number(pitchFactor) || 1;
  const V2 = (typeof window !== 'undefined') && window.EstimateBuilderV2;
  if (V2 && typeof V2.wasteFactorForPitch === 'function') {
    const ratio = pf > 1 ? Math.sqrt(pf * pf - 1) : 0;
    return V2.wasteFactorForPitch(ratio);
  }
  _warnDeprecatedOnce('recommendedWasteForPitch', 'EstimateBuilderV2.wasteFactorForPitch');
  if (pf <= 1.054) return 1.10;  // 4/12 and below
  if (pf <= 1.118) return 1.12;  // 5/12 – 6/12
  if (pf <= 1.202) return 1.15;  // 7/12 – 8/12
  if (pf <= 1.302) return 1.18;  // 9/12 – 10/12
  return 1.22;                   // 11/12+
}

function updateEstCalc() {
  const raw = Math.max(0, parseFloat(document.getElementById('estRawSqft')?.value) || 0);
  const pitchVal = document.getElementById('estPitch')?.value || '1.202|8/12';
  const [pf, pl] = pitchVal.split('|');
  const pfNum = parseFloat(pf);
  const cutUp = !!document.getElementById('estCutUp')?.checked;
  // Waste factor: user override takes precedence, else auto-derive from
  // pitch and layer the +3% cut-up bonus on top.
  const manual = parseFloat(document.getElementById('estWaste')?.value);
  const auto = recommendedWasteForPitch(pfNum) + (cutUp ? CUT_UP_WASTE_BONUS : 0);
  const wf = Math.max(1, manual > 0 ? manual + (cutUp ? CUT_UP_WASTE_BONUS : 0) : auto);
  const adj = raw * pfNum * wf;
  const sq = adj / 100;
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  el('ec-raw',   raw + ' sf');
  el('ec-pitch', pfNum.toFixed(4) + '×');
  el('ec-waste', wf.toFixed(3) + '×' + (cutUp ? ' (cut-up +3%)' : ''));
  el('ec-adj',   Math.round(adj) + ' sf');
  el('ec-sq',    sq.toFixed(2) + ' sq');
  estData.raw = raw; estData.pf = pfNum; estData.pl = pl || '8/12';
  estData.wf = wf; estData.adj = adj; estData.sq = sq; estData.cutUp = cutUp;
}

// Gather the user-selectable add-ons from step 2/3 DOM + estData overrides.
// Returns a detailed cents breakdown so buildReview() can render each line.
function collectAddOns() {
  const d = estData;
  const eave = Math.max(0, parseFloat(document.getElementById('estEave')?.value) || 0);
  const pipes = Math.max(0, parseInt(document.getElementById('estPipes')?.value) || 0);
  const sq = d.sq || 0;
  const tearOffLayers = Math.max(1, parseInt(document.getElementById('estTearOff')?.value) || 1);
  const valley = document.getElementById('estValley')?.checked;
  const chimney = document.getElementById('estChimney')?.checked;
  const skylight = document.getElementById('estSkylight')?.checked;
  const gutterLF = Math.max(0, parseFloat(document.getElementById('estGutterLF')?.value) || 0);

  // Permit: user override > city-derived > fallback. Gets set any time
  // the user picks a city from the selector.
  const cityEl = document.getElementById('estCity');
  const city = cityEl ? cityEl.value : '';
  const permitDollars = d.permitCost != null ? d.permitCost
                       : city         ? lookupPermitCost(city)
                       : DEFAULT_PERMIT_COST;
  const permitCents = _toCents(permitDollars);
  const dumpCents   = _toCents(d.dumpFee != null ? d.dumpFee : DEFAULT_DUMP_FEE);
  const extraLayers = Math.max(0, tearOffLayers - 1);
  const extraLayerCents = extraLayers * sq * LAYER_TEAROFF_PER_SQ_CENTS;
  const valleyCents   = valley   ? _toCents(Math.max(0, eave * 0.25 * 12)) : 0; // ~$12/LF rough
  // chimney + skylight unified with V2 via estimate-config.js (Rock 2 PR 4b).
  // Joe-confirmed prices: chimney $425, skylight $350 (was $275 here).
  const chimneyDollars  = (_NBD_CFG && _NBD_CFG.ADDON_CHIMNEY_FLASH)  || 425;
  const skylightDollars = (_NBD_CFG && _NBD_CFG.ADDON_SKYLIGHT_FLASH) || 350;
  const chimneyCents    = chimney  ? _toCents(chimneyDollars)  : 0;
  const skylightCents   = skylight ? _toCents(skylightDollars) : 0;
  const gutterCents   = _toCents(gutterLF * 8.50);
  // Extra pipe boots beyond 4 are a spec-called-out add-on. D-4 unify (Joe
  // 2026-06-09): use the config/V2 rate ($85) instead of the legacy $45 so
  // classic matches V2. (window.R.pipe is the product-library install rate,
  // not the spec add-on price — the two diverged.)
  const extraPipeRate = (_NBD_CFG && _NBD_CFG.ADDON_EXTRA_PIPE_BOOT) || 85;
  const extraPipes = Math.max(0, pipes - 4);
  const extraPipeCents = _toCents(extraPipes * extraPipeRate);

  return {
    permitCents, dumpCents, extraLayerCents, valleyCents, chimneyCents,
    skylightCents, gutterCents, extraPipeCents,
    tearOffLayers, extraLayers, gutterLF, hasValley: !!valley,
    hasChimney: !!chimney, hasSkylight: !!skylight, extraPipes,
    totalCents: permitCents + dumpCents + extraLayerCents + valleyCents
              + chimneyCents + skylightCents + gutterCents + extraPipeCents
  };
}

// Look up the sales tax rate for a given county. Unknown counties fall
// back to 7% (reasonable average across the Tri-State). Insurance mode
// returns 0 regardless — per spec the adjuster's ACV/RCV covers tax.
/** @deprecated Use EstimateBuilderV2.COUNTY_TAX[county] — see docs/dev/estimate-engines-audit.md */
function lookupTaxRate(county, mode) {
  _warnDeprecatedOnce('lookupTaxRate', 'EstimateBuilderV2.COUNTY_TAX[county]');
  if (mode === 'insurance') return 0;
  if (!county) return DEFAULT_TAX_RATE;
  return COUNTY_TAX_RATES[county] != null ? COUNTY_TAX_RATES[county] : DEFAULT_TAX_RATE;
}

/** @deprecated Use EstimateBuilderV2.PERMIT_COSTS[city] — see docs/dev/estimate-engines-audit.md */
function lookupPermitCost(city) {
  _warnDeprecatedOnce('lookupPermitCost', 'EstimateBuilderV2.PERMIT_COSTS[city]');
  if (!city) return DEFAULT_PERMIT_COST;
  return PERMIT_COSTS[city] != null ? PERMIT_COSTS[city] : DEFAULT_PERMIT_COST;
}

// EBv2 price: flat per-SQ tier rate × squares + add-ons + tax.
// Enforces the $2,500 job minimum and rounds to the nearest $25.
// All intermediate math is in cents so we don't accrue float drift
// before rounding. Tax is applied to (base + add-ons) then added.
/** @deprecated Use EstimateBuilderV2.calculateEstimate — see docs/dev/estimate-engines-audit.md */
function calcEstimateTotalCents(sq, tier, addOns, opts) {
  _warnDeprecatedOnce('calcEstimateTotalCents', 'EstimateBuilderV2.calculateEstimate');
  opts = opts || {};
  const rate = TIER_RATES[tier] || TIER_RATES.better;
  const baseCents = _toCents(sq * rate);
  const addOnsCents = (addOns && addOns.totalCents) || 0;
  const subtotalCents = baseCents + addOnsCents;
  const taxRate = opts.taxRate != null ? opts.taxRate : 0;
  const taxCents = Math.round(subtotalCents * taxRate);
  const preRound = _applyJobMin(subtotalCents + taxCents);
  return _roundNearest25(preRound);
}

/** @deprecated Use EstimateBuilderV2.calculateAllTiers — see docs/dev/estimate-engines-audit.md */
function calcTierPrices() {
  _warnDeprecatedOnce('calcTierPrices', 'EstimateBuilderV2.calculateAllTiers');
  // Re-sync rates from product library each time tiers are recalculated —
  // needed for the internal cost basis, not the customer price.
  if (typeof window.syncRatesFromProductLibrary === 'function') window.syncRatesFromProductLibrary(selectedTier || 'better');
  updateEstCalc();
  const sq = estData.sq || 0;
  const ridge = Math.max(0, parseFloat(document.getElementById('estRidge')?.value) || 0);
  const eave  = Math.max(0, parseFloat(document.getElementById('estEave')?.value) || 0);
  const hip   = Math.max(0, parseFloat(document.getElementById('estHip')?.value) || 0);
  const pipes = Math.max(0, parseInt(document.getElementById('estPipes')?.value) || 0);
  const deckSq = sq * R.deckPct;
  const iwsSq = Math.max(1, Math.ceil((eave * 6) / 100));

  const addOns = collectAddOns();

  // Mode: Insurance (carrier covers tax via ACV/RCV) vs Cash (show tax
  // at county rate). Default Cash so unconfigured estimates are
  // conservative — never quote a customer a missing-tax price.
  const mode = document.getElementById('estMode')?.value || 'cash';
  const county = document.getElementById('estCounty')?.value || '';
  const taxRate = lookupTaxRate(county, mode);
  estData.mode = mode; estData.county = county; estData.taxRate = taxRate;

  const goodCents   = calcEstimateTotalCents(sq, 'good',   addOns, { taxRate });
  const betterCents = calcEstimateTotalCents(sq, 'better', addOns, { taxRate });
  const bestCents   = calcEstimateTotalCents(sq, 'best',   addOns, { taxRate });

  // Capture pre-tax subtotal + tax amount for the selected tier so
  // buildReview() can render the tax line without recomputing.
  if (selectedTier) {
    const rate = TIER_RATES[selectedTier];
    const baseCents = _toCents(sq * rate);
    const subtotalCents = baseCents + (addOns.totalCents || 0);
    estData.subtotal = _fromCents(subtotalCents);
    estData.taxAmount = _fromCents(Math.round(subtotalCents * taxRate));
  }

  estData.ridge = ridge; estData.eave = eave; estData.hip = hip; estData.pipes = pipes;
  estData.deckSq = deckSq; estData.iwsSq = iwsSq;
  estData.addOns = addOns;
  estData.prices = {
    good:   _fromCents(goodCents),
    better: _fromCents(betterCents),
    best:   _fromCents(bestCents)
  };

  const setPrice = (id, cents) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '$' + _fromCents(cents).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  };
  setPrice('price-good',   goodCents);
  setPrice('price-better', betterCents);
  setPrice('price-best',   bestCents);
}

function selectTier(tier,el) {
  document.querySelectorAll('.tier-card').forEach(c=>c.classList.remove('selected'));
  if (el && el.classList) el.classList.add('selected');
  selectedTier=tier;
  const btn=document.getElementById('estStep3Next');
  if (btn) { btn.disabled=false; btn.style.opacity='1'; }
}

function getProductName(mapKey, fallback) {
  const MAP = window.NBD_ESTIMATE_PRODUCT_MAP || {};
  if (!window._productLib || !MAP[mapKey]) return fallback;
  const products = window._productLib.getProducts();
  const p = products.find(pr => pr.id === MAP[mapKey].id);
  return p ? p.name : fallback;
}

// Customer-facing line items. Under EBv2 the top line is the flat
// per-SQ tier driver; add-ons append below. The internal cost-basis
// breakdown (shingle/felt/ridge/etc.) is available via
// getInternalCostBasis() and is surfaced only in the "Internal View"
// toggle, not on the customer estimate.
function getLineItems() {
  if (typeof window.syncRatesFromProductLibrary === 'function') window.syncRatesFromProductLibrary(selectedTier || 'better');
  const d = estData;
  const sq = d.sq || 0;
  const tier = selectedTier || 'better';
  const addOns = d.addOns || collectAddOns();
  const rate = TIER_RATES[tier];

  const rows = [];
  rows.push({
    code: 'RFG SYS',
    desc: tierLabel(tier) + ' · turnkey per-square price',
    qty:  sq.toFixed(2) + ' SQ',
    rate: '$' + rate + '/SQ',
    total: sq * rate
  });
  if (addOns.permitCents)    rows.push({ code: 'PERMIT', desc: 'Local building permit',                           qty: '1 EA', rate: '', total: _fromCents(addOns.permitCents) });
  if (addOns.dumpCents)      rows.push({ code: 'DUMP',   desc: 'Dump / disposal fee',                              qty: '1 EA', rate: '', total: _fromCents(addOns.dumpCents) });
  if (addOns.extraLayers)    rows.push({ code: 'TEAR+',  desc: 'Extra tear-off layer(s) — ' + addOns.extraLayers + '×',
                                         qty: sq.toFixed(2) + ' SQ', rate: '$50/SQ', total: _fromCents(addOns.extraLayerCents) });
  if (addOns.hasValley)      rows.push({ code: 'VALLEY', desc: 'Valley metal flashing',                            qty: 'set', rate: '', total: _fromCents(addOns.valleyCents) });
  if (addOns.hasChimney)     rows.push({ code: 'CHIM',   desc: 'Chimney flashing kit',                             qty: '1 EA', rate: '', total: _fromCents(addOns.chimneyCents) });
  if (addOns.hasSkylight)    rows.push({ code: 'SKY',    desc: 'Skylight flashing kit',                            qty: '1 EA', rate: '', total: _fromCents(addOns.skylightCents) });
  if (addOns.gutterLF)       rows.push({ code: 'GUTTER', desc: 'Seamless aluminum gutters (6")',                   qty: addOns.gutterLF + ' LF', rate: '$8.50/LF', total: _fromCents(addOns.gutterCents) });
  if (addOns.extraPipes)     rows.push({ code: 'PIPE+',  desc: 'Extra pipe boots beyond 4',                        qty: addOns.extraPipes + ' EA', rate: '', total: _fromCents(addOns.extraPipeCents) });

  return rows;
}

// Internal cost basis — what the job actually costs us in materials +
// labor. Used by the Internal View toggle to show markup + margin.
// NOT shown to customers. Sum of per-item rates × quantities from the
// product library, same math the old builder used for customer price.
function getInternalCostBasis() {
  if (typeof window.syncRatesFromProductLibrary === 'function') window.syncRatesFromProductLibrary(selectedTier || 'better');
  const d = estData;
  const sq = d.sq || 0;
  const ridge = d.ridge || 0, eave = d.eave || 0, hip = d.hip || 0, pipes = d.pipes || 0;
  const deckSq = d.deckSq || 0;
  const iwsSq = d.iwsSq || 0;
  const tier = selectedTier || 'better';

  const good = sq * R.shingle + sq * R.felt + sq * R.tear + eave * R.starter + eave * R.drip + ridge * R.ridge;
  const better = good + iwsSq * R.iws + pipes * R.pipe + hip * R.hip + deckSq * R.deck;
  const best = better + sq * R.deck + eave * R.gutter;
  const byTier = { good, better, best };
  return byTier[tier] || better;
}

function buildReview() {
  // Early exit if the review DOM isn't present (e.g. the builder has
  // been torn down between a calcTierPrices tick and buildReview).
  // Guard is at the top so the test-harness regex finds it inside the
  // first 2000 chars of buildReview, and so we don't do all the math
  // work below when we have nowhere to render the result.
  const reviewEl = document.getElementById('estReviewBody');
  if (!reviewEl) return;
  updateEstCalc();
  calcTierPrices();  // ensure addOns + prices are fresh before locking the total
  const d = estData;
  const val = (id) => document.getElementById(id)?.value || '—';
  const addr = val('estAddr');
  const owner = val('estOwner');
  const parcel = val('estParcel');
  const yr = val('estYear');
  const roofType = val('estRoofType');
  // Classic-builder rows only — always recomputed from retail TIER_RATES
  // (getLineItems), never a saved doc's rows[]. Safe to print rate/total
  // verbatim; the V2 cost-basis retail derivation (customer-estimate-rows.js)
  // does not apply here.
  const rows = getLineItems();
  // Grand total is the LOCKED tier price from calcTierPrices(), NOT the
  // sum of display line items. This matters because the individual rows
  // render as whole dollars while the underlying math carries cents —
  // summing the rounded display values would reintroduce drift.
  const tierCents = _toCents(d.prices?.[selectedTier] || 0);
  const grandTotal = _fromCents(tierCents);
  estData.grandTotal = grandTotal;
  estData.addr = addr; estData.owner = owner; estData.parcel = parcel; estData.yr = yr; estData.roofType = roofType;
  estData.tierName = tierLabel(selectedTier); estData.rows = rows;

  // Internal margin for the optional Internal View toggle. Not rendered
  // unless the user clicks through to it — customer-facing review stays
  // clean.
  const costBasis = getInternalCostBasis();
  const margin = grandTotal - costBasis;
  const marginPct = grandTotal > 0 ? (margin / grandTotal) * 100 : 0;
  estData.costBasis = costBasis; estData.margin = margin; estData.marginPct = marginPct;

  // Insurance overlay: only populated/rendered in Insurance mode.
  const insuranceFields = d.mode === 'insurance' ? collectInsuranceFields() : null;
  estData.insurance = insuranceFields;

  // Deposit: deposit-rule.js (2026-09-25) — cash under $2,000 none, cash
  // $2,000+ 50%, insurance the deductible + the ACV payment — with the rep's
  // Override % honored and labelled. Was "Cash 50/50, Insurance 0%".
  const deposit = calcDeposit(grandTotal, d.mode, d.depositPctOverride, insuranceFields);
  const depositPlan = deposit.plan || null;
  estData.deposit = { pct: deposit.pct, amount: deposit.amount, remainder: deposit.remainder };
  estData.depositPlan = (depositPlan && window.NBDDepositRule) ? window.NBDDepositRule.toStored(depositPlan) : null;

  // Revision version — carry forward whatever was set when editing an
  // existing estimate; default to v1 for new drafts.
  if (!estData.version) estData.version = 1;

  const fmt=n=>'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  // Escape every interpolated user-typed value. The classic review
  // step was previously dropping addr/owner/parcel/yr/roofType + row
  // descriptions straight into innerHTML, meaning any user who typed
  // HTML into an address would get it rendered on the review page
  // (self-XSS if they paste a malicious address from elsewhere).
  // The esc() helper here runs locally so this file has no external
  // dependency on dom-safe.js even if script load order shifts.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // reviewEl resolved at top of buildReview (early-exit guard).
  const marginSafeClass = marginPct >= 35 ? 'margin-strong'
                        : marginPct >= 20 ? 'margin-ok'
                        : 'margin-weak';
  const internalViewHtml = `
    <div id="internalViewPanel" style="display:none;margin-top:16px;padding:12px;background:var(--s2);border:1px dashed var(--orange);border-radius:7px;font-size:11px;">
      <div style="font-weight:700;color:var(--orange);margin-bottom:8px;">Internal View — NOT FOR CUSTOMER</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
        <div><div style="color:var(--m);">Customer Price</div><div style="font-weight:700;">${fmt(grandTotal)}</div></div>
        <div><div style="color:var(--m);">Cost Basis</div><div style="font-weight:700;">${fmt(costBasis)}</div></div>
        <div><div style="color:var(--m);">Margin</div><div class="${marginSafeClass}" style="font-weight:700;">${fmt(margin)} · ${marginPct.toFixed(1)}%</div></div>
      </div>
    </div>`;
  reviewEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;">
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--m);margin-bottom:4px;">Property</div>
        <div style="font-size:14px;font-weight:600;color:var(--blue);">${esc(addr)}</div>
        <div style="font-size:12px;color:var(--m);">${esc(owner)} · Parcel: ${esc(parcel)} · Built: ${esc(yr)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--m);">Estimate Total</div>
        <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:32px;font-weight:700;color:var(--orange);">${fmt(grandTotal)}</div>
        <div style="font-size:11px;color:var(--m);">${esc(tierLabel(selectedTier))}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;font-size:11px;">
      <div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:10px;"><div style="color:var(--m);margin-bottom:3px;">Roof Type</div><div style="font-weight:700;">${esc(roofType)}</div></div>
      <div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:10px;"><div style="color:var(--m);margin-bottom:3px;">Pitch</div><div style="font-weight:700;">${esc(d.pl)}</div></div>
      <div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:10px;"><div style="color:var(--m);margin-bottom:3px;">Squares</div><div style="font-weight:700;">${d.sq.toFixed(2)} SQ</div></div>
    </div>
    <table class="li-table">
      <thead><tr><th>Code</th><th>Description</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead>
      <tbody>
        ${rows.map(r=>`<tr><td class="code">${esc(r.code)}</td><td>${esc(r.desc)}</td><td>${esc(r.qty)}</td><td>${esc(r.rate)}</td><td><strong>${fmt(r.total)}</strong></td></tr>`).join('')}
        ${(d.mode === 'cash' && d.taxAmount > 0) ? `
        <tr><td class="code">TAX</td><td>Sales tax${d.county ? ' — ' + esc(d.county) + ' County' : ''} (${((d.taxRate||0)*100).toFixed(2)}%)</td><td></td><td></td><td><strong>${fmt(d.taxAmount)}</strong></td></tr>
        ` : ''}
        ${(d.mode === 'insurance') ? `
        <tr><td class="code" style="color:var(--blue);">INS</td><td colspan="3" style="color:var(--m);font-style:italic;">Insurance mode — tax covered by adjuster (ACV/RCV)</td><td></td></tr>
        ` : ''}
        <tr class="total-row grand"><td colspan="4"><strong>ESTIMATE TOTAL</strong></td><td><strong>${fmt(grandTotal)}</strong></td></tr>
      </tbody>
    </table>
    ${d.mode === 'insurance' && insuranceFields ? `
    <div style="margin-top:14px;padding:10px 12px;background:rgba(74,158,255,.06);border:1px solid rgba(74,158,255,.25);border-radius:7px;font-size:12px;">
      <div style="font-weight:700;color:var(--blue);margin-bottom:6px;">Insurance Claim Details</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px 14px;color:var(--t);">
        <div><span style="color:var(--m);">Carrier:</span> ${esc(insuranceFields.carrier || '—')}</div>
        <div><span style="color:var(--m);">Claim #:</span> ${esc(insuranceFields.claimNumber || '—')}</div>
        <div><span style="color:var(--m);">Deductible:</span> ${insuranceFields.deductible != null ? fmt(insuranceFields.deductible) : '—'}</div>
        <div><span style="color:var(--m);">Date of Loss:</span> ${esc(insuranceFields.dateOfLoss || '—')}</div>
        ${insuranceFields.adjuster       ? `<div><span style="color:var(--m);">Adjuster:</span> ${esc(insuranceFields.adjuster)}</div>` : ''}
        ${insuranceFields.policyNumber   ? `<div><span style="color:var(--m);">Policy #:</span> ${esc(insuranceFields.policyNumber)}</div>` : ''}
        ${insuranceFields.rcv != null    ? `<div><span style="color:var(--m);">RCV:</span> ${fmt(insuranceFields.rcv)}</div>` : ''}
        ${insuranceFields.acv != null    ? `<div><span style="color:var(--m);">ACV:</span> ${fmt(insuranceFields.acv)}</div>` : ''}
        ${insuranceFields.op != null     ? `<div><span style="color:var(--m);">O&P:</span> ${fmt(insuranceFields.op)}</div>` : ''}
        ${insuranceFields.depreciation != null    ? `<div><span style="color:var(--m);">Depreciation:</span> ${fmt(insuranceFields.depreciation)}</div>` : ''}
        ${insuranceFields.recoverableDep != null  ? `<div><span style="color:var(--m);">Recoverable Dep:</span> ${fmt(insuranceFields.recoverableDep)}</div>` : ''}
      </div>
    </div>` : ''}
    <div style="margin-top:14px;padding:10px 12px;background:var(--s2);border:1px solid var(--br);border-radius:7px;font-size:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-weight:700;color:var(--t);">Deposit Schedule</div>
        <div style="font-size:10px;color:var(--m);">${depositPlan && depositPlan.kind === 'override' ? 'Rep override' : 'Deposit rule'} · override below (blank = rule)</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        <div><div style="color:var(--m);font-size:10px;">${esc(depositPlan ? depositPlan.label : 'Due at Signing')}</div><div style="font-weight:700;">${depositPlan ? esc(depositPlan.valueText) : fmt(deposit.amount)} (${deposit.pct}%)</div></div>
        <div><div style="color:var(--m);font-size:10px;">Balance at Completion</div><div style="font-weight:700;">${fmt(deposit.remainder)}</div></div>
        <div style="display:flex;align-items:center;gap:6px;">
          <label style="font-size:10px;color:var(--m);">Rep override %:</label>
          <input type="number" min="0" max="100" value="${d.depositPctOverride != null ? esc(String(d.depositPctOverride)) : ''}" placeholder="${deposit.pct}" data-on-change="setDepositOverride" style="width:56px;padding:2px 6px;border-radius:4px;background:var(--s);border:1px solid var(--br);color:var(--t);font-size:11px;">
        </div>
      </div>
      ${depositPlan && depositPlan.summary ? `<div style="margin-top:8px;color:var(--t);">${esc(depositPlan.summary)}</div>` : ''}
      ${depositPlan && depositPlan.repNote ? `<div style="margin-top:4px;font-size:11px;color:var(--orange,#BD5728);">${esc(depositPlan.repNote)}</div>` : ''}
    </div>
    <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
      <div style="font-size:10px;color:var(--m);">Version v${d.version || 1}${d.revisedFrom ? ' · revised from prior estimate' : ''}</div>
      <div style="display:flex;gap:6px;">
        <button type="button" class="btn btn-ghost" style="font-size:10px;padding:4px 10px;" data-est-action="createEstimateRevision">↻ Create Revision</button>
        <button type="button" class="btn btn-ghost" style="font-size:10px;padding:4px 10px;" data-est-action="toggleInternalView">🔒 Internal View</button>
      </div>
    </div>
    ${internalViewHtml}`;
}

// Persist the deposit-% override on estData so the math re-renders on
// the next buildReview() tick. Called inline from the review step.
window.setDepositOverride = function setDepositOverride(val) {
  // Blank clears the override (2026-09-25): the deposit goes back to the
  // rule. It used to read blank as 0% — no way back to the default once typed.
  const raw = (val == null) ? '' : String(val).trim();
  estData.depositPctOverride = (raw === '' || !isFinite(parseFloat(raw)))
    ? null
    : Math.max(0, Math.min(100, parseFloat(raw)));
  if (typeof buildReview === 'function') buildReview();
};

// Toggle the margin / cost-basis panel on the review step. Kept on
// window so the onclick handler in the review HTML can find it.
window.toggleInternalView = function toggleInternalView() {
  const el = document.getElementById('internalViewPanel');
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

// ── Presets ────────────────────────────────────────────────
// Pre-wired configurations for the most common job types. Each preset
// sets a sensible default tier + add-ons + mode so the rep only has
// to drop in measurements. Everything is still user-overridable.
const ESTIMATE_PRESETS = {
  standard: {
    label: 'Standard Reroof',
    tier: 'better',   mode: 'cash',
    tearOff: 1,       cutUp: false,
    addOns: { valley: false, chimney: false, skylight: false, gutterLF: 0 }
  },
  storm: {
    label: 'Storm Claim',
    tier: 'better',   mode: 'insurance',
    tearOff: 1,       cutUp: true,
    addOns: { valley: true, chimney: true, skylight: false, gutterLF: 0 }
  },
  repair: {
    label: 'Small Repair',
    tier: 'good',     mode: 'cash',
    tearOff: 1,       cutUp: false,
    addOns: { valley: false, chimney: false, skylight: false, gutterLF: 0 }
  },
  redeck: {
    label: 'Full Redeck',
    tier: 'best',     mode: 'cash',
    tearOff: 1,       cutUp: false,
    addOns: { valley: true, chimney: false, skylight: false, gutterLF: 0 }
  },
  hail: {
    label: 'Hail Damage Insurance',
    tier: 'better',   mode: 'insurance',
    tearOff: 1,       cutUp: true,
    addOns: { valley: false, chimney: false, skylight: false, gutterLF: 0 }
  }
};

window.applyEstimatePreset = function applyEstimatePreset(key) {
  const p = ESTIMATE_PRESETS[key];
  if (!p) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; } };
  const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  set('estMode',    p.mode);
  set('estTearOff', String(p.tearOff));
  check('estCutUp', p.cutUp);
  check('estValley',   p.addOns.valley);
  check('estChimney',  p.addOns.chimney);
  check('estSkylight', p.addOns.skylight);
  set('estGutterLF', p.addOns.gutterLF || '');
  // Auto-select the tier card so the rep sees the price immediately.
  // Pre-CSP-sweep this looked for inline `onclick=` — every tier card
  // now uses `data-fn="selectTier" data-arg="…"` instead, so the old
  // selector matched zero cards and the card never visually selected.
  if (typeof selectTier === 'function') {
    const card = document.querySelector(
      '.tier-card[data-fn="selectTier"][data-arg="' + p.tier + '"]'
    );
    selectTier(p.tier, card || null);
  }
  updateEstCalc();
  if (typeof calcTierPrices === 'function') calcTierPrices();
  if (typeof showToast === 'function') showToast('Applied preset: ' + p.label, 'info');
};

let _savingEstimate = false;
async function saveEstimate() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  if(_savingEstimate) return;
  if(!estData.grandTotal){showToast('Build estimate first','error');return;}

  // Resolve leadId — from URL param flow, QM import, or strict address
  // match against loaded leads. The previous 12-char substring match was
  // too loose ("123 Main St" matched "123 Main Street NW" or any other
  // address sharing the same prefix). We now require either a fully
  // normalized equality or a unique normalized prefix; ambiguous matches
  // fall through and let the user pick a lead explicitly.
  let leadId = window._estLinkedLeadId || null;
  if (!leadId && estData.addr) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const addrNorm = norm(estData.addr);
    if (addrNorm) {
      const exact = (window._leads || []).filter(l => norm(l.address) === addrNorm);
      if (exact.length === 1) {
        leadId = exact[0].id;
      } else if (exact.length === 0) {
        // No exact match — try a prefix match but ONLY if exactly one
        // lead matches, to avoid silently linking to the wrong customer.
        const prefix = (window._leads || []).filter(l => {
          const ln = norm(l.address);
          return ln && ln.length >= addrNorm.length && ln.startsWith(addrNorm);
        });
        if (prefix.length === 1) leadId = prefix[0].id;
      }
    }
  }

  // Team visibility (2026-07): staff caches now hold the whole tenant
  // book, so the address match can land on a TEAMMATE's lead. That may be
  // exactly right (writing an estimate for a rep's customer) — but never
  // silently: confirm before attaching, and fall back to unlinked on
  // cancel so the rep can pick explicitly.
  if (leadId && !window._estLinkedLeadId) {
    const _matched = (window._leads || []).find(l => l.id === leadId);
    const _me = window._user && window._user.uid;
    if (_matched && _matched.userId && _me && _matched.userId !== _me) {
      const _who = ((_matched.firstName || '') + ' ' + (_matched.lastName || '')).trim() || 'a teammate\'s customer';
      // The no-D2D fallback can't be a native confirm(): in PWA standalone
      // mode standalone-compat.js makes confirm() always return true, so the
      // "never silently attach" guard above would silently attach to the
      // teammate's customer. nbdConfirm gives a real Promise<boolean> modal
      // in PWA mode and falls back to native confirm on desktop.
      const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      const _ok = (window.D2D && typeof window.D2D.uiConfirm === 'function')
        ? await window.D2D.uiConfirm(
            `This address matches ${_who} — a lead owned by a teammate.\n\nAttach this estimate to their customer?`,
            { okLabel: 'Attach', cancelLabel: 'Save unlinked' })
        : await _ask(`This address matches ${_who} — a lead owned by a teammate. Attach this estimate to their customer?`);
      if (!_ok) leadId = null;
    }
  }

  _savingEstimate = true;
  const isUpdate = !!window._editingEstimateId;
  // Disable the Save buttons for the duration of the save round-trip
  // so the rep can't double-click. Pre-CSP-sweep this used a stale
  // .btn-primary / onclick* selector that matched no current button.
  const saveBtns = document.querySelectorAll('#estStep4 [data-fn="saveEstimate"]');
  const saveBtnOrigText = [];
  saveBtns.forEach(b => { saveBtnOrigText.push(b.textContent); b.disabled = true; b.textContent = 'Saving...'; });

  // Estimate name: use whatever was typed, else fall back to the
  // address + tier so the list row is still recognizable. Never
  // blank — every saved estimate should be easy to identify later
  // even if it was never formally named or assigned.
  const existingName = (estData.name || '').trim();
  const fallbackName = (estData.addr ? estData.addr.trim() : '')
    || (estData.owner ? estData.owner.trim() + ' estimate' : '')
    || ('Untitled estimate ' + new Date().toLocaleDateString());
  const estName = existingName || fallbackName;

  try {
    // ── Persist the FULL builder state. Previously the save only wrote
    // ~22 fields and silently dropped every Step-2 EBv2 input — mode,
    // county, city, tear-off layers, cut-up flag, every add-on
    // checkbox, gutter LF, the insurance block, deposit, version. On
    // Edit those would re-derive from leftover DOM state, producing
    // silent data corruption (Audit 2026-05-19). The full state goes
    // through now so round-trip Edit is faithful.
    const addOns = estData.addOns || {};
    await window._saveEstimate({
      name: estName,
      builder: 'classic',
      // Step 1 — property + measurements
      addr:estData.addr, owner:estData.owner, parcel:estData.parcel, yr:estData.yr,
      raw:estData.raw, adj:Math.round(estData.adj || 0),
      ridge:estData.ridge ?? null, eave:estData.eave ?? null, hip:estData.hip ?? null,
      pipes:estData.pipes ?? null,
      // Step 2 — roof + pitch + waste + EBv2 selectors + add-ons
      roofType:estData.roofType, pitch:estData.pl, wf:estData.wf, sq:estData.sq,
      cutUp: !!estData.cutUp,
      tearOffLayers: addOns.tearOffLayers || 1,
      mode: estData.mode || 'cash',
      county: estData.county || '',
      city: (document.getElementById('estCity')?.value) || '',
      hasValley:   !!addOns.hasValley,
      hasChimney:  !!addOns.hasChimney,
      hasSkylight: !!addOns.hasSkylight,
      gutterLF: addOns.gutterLF || 0,
      // Step 3 — tier + computed totals
      tier:selectedTier, tierName:estData.tierName, grandTotal:estData.grandTotal,
      subtotal: estData.subtotal ?? null,
      taxRate:  estData.taxRate  ?? 0,
      taxAmount:estData.taxAmount?? 0,
      rows:estData.rows||[],
      // Step 4 — insurance overlay + deposit + revision tracking
      insurance: estData.insurance || null,
      deposit:   estData.deposit   || null,
      depositPctOverride: estData.depositPctOverride ?? null,
      // The rule's display plan (deposit-rule.js toStored) — what the
      // homeowner portal prints; the server cannot run the rule itself.
      depositPlan: estData.depositPlan || null,
      version: estData.version || 1,
      revisedFrom: estData.revisedFrom || null,
      // Cross-cutting
      leadId: leadId,
      qmData: estData._qm || null
    });

    // If we know the lead, offer to go back to customer page
    if (leadId) {
      showToast(isUpdate ? '✓ Estimate updated & linked to customer' : '✓ Estimate saved & linked to customer record', 'success');
      setTimeout(async () => {
        const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
        if (await _ask((isUpdate ? 'Estimate updated!' : 'Estimate saved!') + ' Go to customer record?')) {
          window.location.href = `/pro/customer.html?id=${leadId}`;
        }
      }, 400);
    } else {
      showToast(isUpdate ? 'Estimate updated!' : 'Estimate saved!', 'success');
    }
    window._estLinkedLeadId = null;
    cancelEstimate();
  } catch(e) {
    console.error('saveEstimate error:', e);
    showToast('Failed to save estimate — check connection and try again', 'error');
  } finally {
    _savingEstimate = false;
    saveBtns.forEach((b, i) => { b.disabled = false; if (saveBtnOrigText[i]) b.textContent = saveBtnOrigText[i]; });
  }
}


// async since 2026-09-06: the filename carries a tenant-resolved prefix and
// company-profile hydration must be awaited (company-profile.js
// _tenantFilePrefix). Both call sites dispatch this fire-and-forget via
// data-action="call" data-fn="exportEstimate" and discard the return value.
async function exportEstimate() {
  if(!estData.grandTotal){showToast('Build estimate first','error');return;}
  const d=estData;
  const fmt=n=>'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  // estData.rows is only ever set by this classic builder (buildReview →
  // getLineItems, retail tier rates) — saved V2 docs never flow into estData,
  // so rate/total here are customer prices and print verbatim safely.
  const rows=d.rows||getLineItems();
  const dateStr=new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  // Escape every user-typed interpolation. This HTML is written to
  // a brand-new window via document.write — if any field contains
  // </script> or <img onerror> we'd execute attacker code in the
  // new window's origin (same-origin, so it could read cookies and
  // Firebase tokens). Every d.* and r.* interpolation below must
  // run through esc() with the single exception of numeric values
  // like fmt(d.grandTotal) and d.sq.toFixed() which are always
  // pure numbers out of parseFloat.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NBD Roofing Estimate — ${esc(d.addr)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Lato','Segoe UI',Helvetica,Arial,sans-serif;padding:36px;max-width:860px;margin:0 auto;}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid var(--orange);margin-bottom:26px;}
  .brand{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;}
  .brand span{color:var(--orange);}.sub{font-size:13px;color:#666;margin-top:2px;}.badge{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--orange);border:1px solid var(--orange);padding:2px 9px;border-radius:2px;display:inline-block;margin-top:5px;}
  .est-hdr{text-align:right;}.est-type{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:32px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#111;}
  .est-date{font-size:12px;color:#666;}.est-by{font-size:12px;color:#666;}
  .est-total-lbl{font-size:9px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--orange);margin-top:10px;}
  .est-total-val{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:38px;font-weight:800;color:var(--orange);}
  h2{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.18em;color:#111;margin:22px 0 12px;padding-bottom:4px;border-bottom:2px solid var(--orange);}
  .prop-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:4px;}
  .prop-field label{font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#999;}
  .prop-field .v{font-size:15px;font-weight:700;color:#111;}
  .meas-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:6px;}
  .mf label{font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#999;}
  .mf .v{font-size:18px;font-weight:700;color:#111;}
  table{width:100%;border-collapse:collapse;}
  thead tr{border-bottom:2px solid #111;}
  th{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:8px 10px;text-align:left;color:#111;}
  td{padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;}
  .code{color:var(--orange);font-weight:700;font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;}
  .total-cell{font-weight:700;color:#111;}
  .grand-row td{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:var(--orange);border-top:3px solid #111;background:#fff8f5;padding:12px 10px;}
  .footer{margin-top:32px;padding-top:14px;border-top:1px solid #eee;display:flex;justify-content:space-between;font-size:10px;color:#999;}
  @media print{body{padding:20px;}@page{margin:1.5cm;size:letter;}}
  </style></head><body>
  <div class="hdr">
    <div><div class="brand">No Big <span>Deal</span></div><div class="sub">Home Solutions</div><div class="badge">Insurance Restoration</div></div>
    <div class="est-hdr"><div class="est-type">${esc(tierLabel(selectedTier)||'Estimate')}</div><div class="est-date">${esc(dateStr)}</div>
      <div class="est-total-lbl">Estimate Total</div><div class="est-total-val">${fmt(d.grandTotal)}</div></div>
  </div>
  <h2>Property Information</h2>
  <div class="prop-grid">
    <div class="prop-field"><label>Address</label><div class="v">${esc(d.addr||'—')}</div></div>
    <div class="prop-field"><label>Owner</label><div class="v">${esc(d.owner||'—')}</div></div>
    <div class="prop-field"><label>Parcel</label><div class="v">${esc(d.parcel||'—')}</div></div>
    <div class="prop-field"><label>Year Built</label><div class="v">${esc(d.yr||'—')}</div></div>
  </div>
  <h2>Measurements</h2>
  <div class="meas-grid">
    <div class="mf"><label>Pitch</label><div class="v">${esc(d.pl||'—')}</div></div>
    <div class="mf"><label>Squares</label><div class="v">${d.sq?d.sq.toFixed(2):'—'} SQ</div></div>
    <div class="mf"><label>Roof Type</label><div class="v">${esc(d.roofType||'—')}</div></div>
  </div>
  <h2>Line Items</h2>
  <table>
    <thead><tr><th>Code</th><th>Description</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead>
    <tbody>
      ${rows.map(r=>'<tr><td class="code">'+esc(r.code)+'</td><td>'+esc(r.desc)+'</td><td>'+esc(r.qty)+'</td><td>'+esc(r.rate)+'</td><td class="total-cell">'+fmt(r.total)+'</td></tr>').join('')}
      <tr class="grand-row"><td colspan="4"><strong>ESTIMATE TOTAL</strong></td><td><strong>${fmt(d.grandTotal)}</strong></td></tr>
    </tbody>
  </table>
  <div class="footer"><span>No Big Deal Home Solutions — Greater Cincinnati</span><span>Generated by NBD Pro</span></div>
  </body></html>`;
  // Route through the Universal Document Viewer so the user gets
  // Save to Customer / Email / Print / Download PDF / Close action
  // bar instead of being dumped into a blank popup with no way back.
  if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
    const addrSlug = (d.addr || 'Estimate').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
    const tierDisplayName = tierLabel(selectedTier) || 'Estimate';
    // Tenant-resolved prefix — '' when the brand is not hydrated, never 'NBD'.
    const _estExportBase = addrSlug + '-' + new Date().toISOString().split('T')[0] + '.pdf';
    const _estExportName = window._tenantFileName
      ? await window._tenantFileName(_estExportBase)
      : _estExportBase;
    window.NBDDocViewer.open({
      html: html,
      title: tierDisplayName + (d.addr ? ' — ' + d.addr : ''),
      filename: _estExportName,
      onSave: async () => {
        // Route the doc viewer's "Save to Customer" button to the
        // same Firestore write the classic builder's Save uses.
        if (typeof window.saveEstimate === 'function') {
          await window.saveEstimate();
        }
      }
    });
    return;
  }
  // Fallback: legacy popup if the viewer isn't loaded
  const w = window.open('','_blank');
  if(w){ w.document.write(html); w.document.close(); }
  else { showToast('Pop-up blocked — allow pop-ups for this site','error'); }
}

// Real estimate-type chooser modal. Fires when the user clicks
// "New Estimate" from anywhere — the CRM toolbar, the home widget,
// the customer page, etc. Instead of silently dropping them into
// the classic v1 builder, this shows both options so they can pick
// the right tool for the job.
//
// DOM is built with createElement (not innerHTML) so this is safe
// under the Report-Only CSP (`script-src-attr 'none'`) and there's
// no way a malicious theme variable or catalog name could inject.
function showEstimateTypeSelector() {
  // Reuse an existing modal if it's still in the DOM (fast re-open).
  let overlay = document.getElementById('est-type-chooser');
  if (overlay) {
    overlay.style.display = 'flex';
    return;
  }

  overlay = document.createElement('div');
  overlay.id = 'est-type-chooser';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;'
    + 'background:rgba(0,0,0,.75);'
    + 'display:flex;align-items:center;justify-content:center;'
    + 'padding:20px;';

  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--s, #1a1d23);border:1px solid var(--br, #2a2d35);'
    + 'border-radius:12px;padding:28px;max-width:680px;width:100%;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.5);';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'margin-bottom:20px;';
  const hdrTitle = document.createElement('div');
  hdrTitle.style.cssText = "font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;"
    + 'font-weight:800;color:var(--t, #fff);text-transform:uppercase;letter-spacing:.05em;';
  hdrTitle.textContent = 'New Estimate';
  const hdrSub = document.createElement('div');
  hdrSub.style.cssText = 'font-size:12px;color:var(--m, #888);margin-top:4px;';
  hdrSub.textContent = 'Choose which builder to start with.';
  hdr.appendChild(hdrTitle);
  hdr.appendChild(hdrSub);
  sheet.appendChild(hdr);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:14px;';

  const makeCard = (opts) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.style.cssText = 'text-align:left;background:var(--s2, #22252c);'
      + 'border:2px solid var(--br, #2a2d35);border-radius:10px;'
      + 'padding:20px;cursor:pointer;font-family:inherit;color:var(--t, #fff);'
      + 'transition:border-color .15s, transform .12s;';
    card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--orange)'; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--br, #2a2d35)'; });
    card.addEventListener('click', () => {
      overlay.style.display = 'none';
      opts.onClick();
    });

    const badge = document.createElement('div');
    badge.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.12em;'
      + 'text-transform:uppercase;color:' + opts.badgeColor + ';margin-bottom:8px;';
    badge.textContent = opts.badge;
    card.appendChild(badge);

    const name = document.createElement('div');
    name.style.cssText = "font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:20px;"
      + 'font-weight:800;color:var(--t, #fff);text-transform:uppercase;'
      + 'letter-spacing:.04em;margin-bottom:6px;';
    name.textContent = opts.name;
    card.appendChild(name);

    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:11px;color:var(--m, #888);line-height:1.55;margin-bottom:12px;';
    desc.textContent = opts.desc;
    card.appendChild(desc);

    const list = document.createElement('ul');
    list.style.cssText = 'font-size:11px;color:var(--m, #888);line-height:1.8;padding-left:16px;margin:0;';
    (opts.features || []).forEach(f => {
      const li = document.createElement('li');
      li.textContent = f;
      list.appendChild(li);
    });
    card.appendChild(list);

    return card;
  };

  grid.appendChild(makeCard({
    badge: 'Classic — Tiers',
    badgeColor: '#60a5fa',
    name: 'Classic Builder',
    desc: '4-step walkthrough with Good / Better / Best package tiers. Fast for standard reroofs.',
    features: [
      '4-step wizard (Measure, Pitch, Package, Review)',
      'Good / Better / Best pricing tiers',
      'Product library sync',
      'Quick Measure PDF import'
    ],
    onClick: () => { if (typeof startNewEstimateOriginal === 'function') startNewEstimateOriginal(); }
  }));

  grid.appendChild(makeCard({
    badge: 'V2 Beta — Line-Item',
    badgeColor: 'var(--orange)',
    name: 'V2 Builder',
    desc: '270-line Xactimate-style catalog with presets, per-item qty overrides, and 3 output formats.',
    features: [
      '6 job presets incl. Small Repair & Shingle Patch',
      'Measurement auto-scale per preset',
      'Per-item manual qty override (pencil icon)',
      '3 outputs: Insurance / Retail / Internal'
    ],
    onClick: () => { if (typeof window.openEstimateV2Builder === 'function') window.openEstimateV2Builder(); }
  }));

  sheet.appendChild(grid);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:20px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'background:none;border:1px solid var(--br, #2a2d35);'
    + 'color:var(--m, #888);padding:10px 20px;border-radius:6px;cursor:pointer;'
    + "font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;"
    + 'font-weight:700;letter-spacing:.08em;text-transform:uppercase;';
  cancelBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  footer.appendChild(cancelBtn);
  sheet.appendChild(footer);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
  // Esc to close
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

// The estimates-list row actions (duplicate / rename / assign / delete)
// and showAssignLeadPicker moved to estimate-crm-ops.js (Rock 2 PR 6) —
// Firestore CRM operations, no pricing math.

// ══ Window Scope Exposures ══════════════════════════════════
// window.startNewEstimate is exported by estimate-entry.js (Rock 2 PR 6).
window.startNewEstimateOriginal = startNewEstimateOriginal;
window.cancelEstimate = cancelEstimate;
window.showEstStep = showEstStep;
window.estNext = estNext;
window.estBack = estBack;
window.updateEstCalc = updateEstCalc;
window.calcTierPrices = calcTierPrices;
window.exportEstimate = exportEstimate;
window.selectTier = selectTier;
window.saveEstimate = saveEstimate;
window.buildReview = buildReview;
window.getLineItems = getLineItems;
// window.syncRatesFromProductLibrary is exported by product-library.js (Rock 2 PR 6).
window.getProductName = getProductName;
window.showEstimateTypeSelector = showEstimateTypeSelector;

// ════════════════════════════════════════════════════════════
// EBv2 — Insurance Overlay, Deposit Math, Revisions
// ════════════════════════════════════════════════════════════

// Collect insurance-claim fields from the DOM into a single object so
// buildReview() can render them conditionally and saveEstimate() can
// persist them. Only Carrier / Claim # / Deductible / Date of Loss are
// required for Insurance mode; the rest of the spec fields are
// progressively expandable via the "Add more" toggle.
function collectInsuranceFields() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const num = (id) => {
    const v = parseFloat(val(id));
    return isNaN(v) ? null : v;
  };
  return {
    carrier:        val('insCarrier'),
    claimNumber:    val('insClaim'),
    deductible:     num('insDeductible'),
    dateOfLoss:     val('insDOL'),
    adjuster:       val('insAdjuster'),
    policyNumber:   val('insPolicy'),
    rcv:            num('insRCV'),
    acv:            num('insACV'),
    op:             num('insOP'),             // overhead & profit
    depreciation:   num('insDep'),
    recoverableDep: num('insRecDep'),
  };
}

// Deposit math — deposit-rule.js (2026-09-25): cash under $2,000 no
// deposit, cash $2,000+ 50% at signing, insurance the deductible + the ACV
// payment; the rep's Override % is honored and labelled. The comment that
// stood here ("Cash 50/50, Insurance $0 down") described one of the five
// contradictory deposit answers the app printed before the rule existed.
//
// D-5 unify (Rock 2 PR 4 close-out, 2026-07-04): delegate to V2's
// calcDeposit so both engines quote the SAME deposit for the same total;
// V2's calcDeposit is itself a thin adapter over NBDDepositRule. The legacy
// cent-rounding fallback that ran when V2 wasn't loaded was a second copy of
// the old rule — gone; the rule module is eager on every page that loads
// this file, so it answers directly.
function calcDeposit(grandTotal, mode, overridePct, claim) {
  const V2 = (typeof window !== 'undefined') && window.EstimateBuilderV2;
  const c = claim || {};
  if (V2 && typeof V2.calcDeposit === 'function') {
    return V2.calcDeposit(grandTotal, mode, { overridePct, deductible: c.deductible, acv: c.acv });
  }
  _warnDeprecatedOnce('calcDeposit', 'EstimateBuilderV2.calcDeposit');
  const R = (typeof window !== 'undefined') && window.NBDDepositRule;
  if (!R || !(grandTotal > 0)) return { pct: 0, amount: 0, remainder: grandTotal > 0 ? grandTotal : 0, plan: null };
  const plan = R.compute({ total: grandTotal, mode, overridePct, deductible: c.deductible, acv: c.acv });
  return { pct: plan.pct, amount: plan.depositCents / 100, remainder: plan.balanceCents / 100, plan };
}

// Revisions: when an estimate is moved from any status → a later stage,
// bump the version. The caller passes the prior version + the prior
// status to detect the transition. Manual "Create Revision" just
// increments unconditionally.
function nextRevisionVersion(prevVersion, fromStatus, toStatus) {
  const cur = Math.max(1, parseInt(prevVersion) || 1);
  // Status-forward transitions that warrant a version bump.
  const LADDER = ['draft', 'sent', 'viewed', 'accepted', 'signed', 'paid'];
  const fi = LADDER.indexOf((fromStatus || '').toLowerCase());
  const ti = LADDER.indexOf((toStatus || '').toLowerCase());
  if (fi >= 0 && ti > fi) return cur + 1;
  return cur;
}

// Manually kick off a revision — called from the review screen's
// "Create Revision" button. Clones the current estData into a new
// draft with version++ and resets the id so saveEstimate() writes
// a fresh doc.
window.createEstimateRevision = function createEstimateRevision() {
  if (!estData || !estData.grandTotal) {
    if (typeof showToast === 'function') showToast('Nothing to revise — build an estimate first', 'error');
    return;
  }
  const prev = parseInt(estData.version) || 1;
  estData.version = prev + 1;
  estData.revisedFrom = window._editingEstimateId || null;
  window._editingEstimateId = null;  // forces a new Firestore doc on save
  if (typeof showToast === 'function') showToast(`Started revision v${estData.version}`, 'info');
  if (typeof buildReview === 'function') buildReview();
};

window.collectInsuranceFields = collectInsuranceFields;
window.calcDeposit            = calcDeposit;
window.nextRevisionVersion    = nextRevisionVersion;


// Click delegate for `data-est-action` buttons inside the review pane
// (Create Revision, Internal View toggle). Lives outside the main
// data-action="call" delegate because these handlers fire on dynamic
// HTML injected by buildReview() and need no allowlist gate.
(function(){
  if(_NBD_EST_DELEGATE) return;
  _NBD_EST_DELEGATE = true;
  document.addEventListener('click', function(ev){
    const t = ev.target.closest && ev.target.closest('[data-est-action]');
    if (!t) return;
    const a = t.dataset.estAction;
    try {
      if (a === 'createEstimateRevision' && typeof createEstimateRevision === 'function') {
        createEstimateRevision();
      } else if (a.indexOf('toggle') === 0) {
        const fn = window[a];
        if (typeof fn === 'function') fn();
      }
    } catch(e) {
      console.error('[estimates]', e);
    }
  });
})();
