/**
 * tests/county-tenant-policy.test.js — the canonical-7 county permit costs and
 * tax rates are PER-TENANT policy (migrated off per-device localStorage
 * 2026-07-29).
 *
 * BEFORE: the 14 county inputs in Settings → Estimates wrote only to
 * localStorage 'nbd_est_settings_v3'. The Firestore copy at
 * userSettings/{uid}.estimateSettingsV2 was WRITE-ONLY DEAD (nothing ever read
 * it back), so a second rep, a second device, or a cleared cache silently
 * priced off the factory tables — and nobody could tell, because the numbers
 * still looked plausible.
 *
 * AFTER: they live in companyProfile.pricing.{permits,countyTax,fallbackTaxRate}
 * and are overlaid onto resolved settings at CALL time by ONE helper
 * (_withTenantCounties) used by every county-resolving entry point — per-SQ
 * (applyCompanyPricing), the line-item generator, and getCountyTaxMap for
 * EstimateLogic / Job Templates — so one estimate cannot price differently
 * depending on which path computed it.
 *
 * Harness mirrors tests/custom-jurisdictions.test.js: vm-load the engine with a
 * `window` sandbox so the typeof-window-guarded overlay is live, plus a plain
 * require() as the no-window neutrality check (Node-side suites like
 * job-templates.test.js depend on that no-op).
 *
 * Run: node tests/county-tenant-policy.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; fails.push(name); }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error((label || 'value') + ' = ' + JSON.stringify(actual) + ' (expected ' + JSON.stringify(expected) + ')');
}
// Async twins run after every sync section, before the summary.
const pendingAsync = [];
function atest(name, fn) { pendingAsync.push([name, fn]); }
function asection(title) { pendingAsync.push([title, null]); }
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) throw new Error((label || 'value') + ' = ' + actual + ' (expected ~' + expected + ' ±' + tol + ')');
}

const ENGINE_SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/estimate-builder-v2.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');

// Live code only (PR #1662 review): blanks every comment and every string /
// template / regex literal body, so a source pin cannot be satisfied by a
// commented-out call (`// f();`, `/* f(); */`, a trailing `x(); // f();`) or by
// the name quoted in a log line. A regex literal is recognised by the previous
// significant character, which covers the pinned blocks; a regex after a
// keyword (`return /x/`) would be read as division.
function codeOnly(src) {
  let out = '', prev = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    const isRe = c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev));
    if (c === '"' || c === "'" || c === '`' || isRe) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') { i++; continue; }
        if (isRe ? (ch === '/' && !inClass) : ch === c) break;
        if (isRe && ch === '[') inClass = true;
        if (isRe && ch === ']') inClass = false;
      }
      out += c + c; i++; prev = c; continue;
    }
    out += c; i++;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

// Optional savedSettings simulates what THIS DEVICE has in localStorage, so the
// device-vs-tenant precedence can be exercised for real.
function loadEngine(companyProfile, savedSettings) {
  const win = {}; win.window = win;
  if (companyProfile !== undefined) win._companyProfile = companyProfile;
  if (savedSettings !== undefined) {
    const store = { nbd_est_settings_v3: JSON.stringify(savedSettings) };
    win.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
  }
  const sandbox = { window: win, localStorage: win.localStorage, console: { log() {}, warn() {}, error() {} } };
  vm.runInNewContext(ENGINE_SRC, sandbox, { filename: 'estimate-builder-v2.js' });
  if (!win.EstimateBuilderV2) throw new Error('engine did not attach to window');
  return win.EstimateBuilderV2;
}

const perSq = (EB2, county) => EB2.calculatePerSq({
  squares: 20, tier: 'good', mode: 'cash', layers: 1, county: county, city: county,
});

console.log('COUNTY TENANT POLICY — canonical overrides are company-wide');

// ── Precedence: tenant policy beats the device ────────────────────────────
console.log('\nPrecedence');
{
  // This device saved 999 for Hamilton; the company says 210. Company wins.
  const DEVICE = { permits: { 'hamilton-oh': { name: 'Hamilton County, OH', cost: 999 } }, countyTax: { 'hamilton-oh': 0.11 } };
  const TENANT = { pricing: { permits: { 'hamilton-oh': { name: 'Hamilton County, OH', cost: 210 } }, countyTax: { 'hamilton-oh': 0.0825 } } };

  test('tenant permit cost overrides the device value', () => {
    const EB2 = loadEngine(TENANT, DEVICE);
    eq(EB2.loadSettings().permits['hamilton-oh'].cost, 999, 'loadSettings stays PURE (device value)');
    const r = perSq(EB2, 'hamilton-oh');
    const permit = r.addOns.permit;
    eq(permit, 210, 'resolved permit');
  });

  test('tenant county tax rate overrides the device value', () => {
    const EB2 = loadEngine(TENANT, DEVICE);
    near(perSq(EB2, 'hamilton-oh').taxRate, 0.0825, 1e-9, 'resolved tax rate');
  });

  test('getCountyTaxMap agrees with the per-SQ path (no per-path drift)', () => {
    const EB2 = loadEngine(TENANT, DEVICE);
    near(EB2.getCountyTaxMap()['hamilton-oh'], 0.0825, 1e-9, 'getCountyTaxMap rate');
  });

  test('the line-item path resolves the same tenant permit', () => {
    const EB2 = loadEngine(TENANT, DEVICE);
    const items = EB2.generateLineItemsFromMeasurements({ squares: 20, county: 'hamilton-oh', city: 'hamilton-oh' });
    const line = (Array.isArray(items) ? items : []).find(l => /Building Permit/.test(l.name || ''));
    if (!line) throw new Error('no permit line generated');
    eq(Number(line.materialCost), 210, 'line-item permit cost');
    if (!/Hamilton County, OH/.test(line.name)) throw new Error('permit line lost its label: ' + line.name);
  });

  test('a county the tenant has NOT overridden keeps its config rate', () => {
    const EB2 = loadEngine(TENANT, DEVICE);
    near(perSq(EB2, 'butler-oh').taxRate, 0.0725, 1e-9, 'butler-oh untouched');
  });

  test('with NO tenant policy the device value still applies (nothing regressed)', () => {
    const EB2 = loadEngine({ pricing: {} }, DEVICE);
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 999, 'device permit stands');
  });
}

// ── Sanitization: a bad tenant value must never under-price ───────────────
console.log('\nSanitization (L-1 under-pricing class)');
{
  const bad = (permits, countyTax) => loadEngine({ pricing: { permits: permits, countyTax: countyTax } });

  test('blank permit cost is DROPPED — config $185 stands, never $0', () => {
    const EB2 = bad({ 'hamilton-oh': { name: 'Hamilton County, OH', cost: '' } });
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 185, 'permit');
  });
  test('garbage permit cost is DROPPED', () => {
    const EB2 = bad({ 'hamilton-oh': { name: 'Hamilton County, OH', cost: 'free' } });
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 185, 'permit');
  });
  test('negative permit cost is DROPPED', () => {
    const EB2 = bad({ 'hamilton-oh': { name: 'Hamilton County, OH', cost: -50 } });
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 185, 'permit');
  });
  test('a literal 0 permit IS honored (a jurisdiction that charges nothing)', () => {
    const EB2 = bad({ 'hamilton-oh': { name: 'Hamilton County, OH', cost: 0 } });
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 0, 'permit');
  });
  test('blank tenant NAME falls back to the base label (never "Building Permit — ")', () => {
    const EB2 = bad({ 'hamilton-oh': { name: '   ', cost: 240 } });
    const items = EB2.generateLineItemsFromMeasurements({ squares: 20, county: 'hamilton-oh', city: 'hamilton-oh' });
    const line = (Array.isArray(items) ? items : []).find(l => /Building Permit/.test(l.name || ''));
    if (!line || !/Hamilton County, OH/.test(line.name)) throw new Error('label lost: ' + (line && line.name));
    eq(Number(line.materialCost), 240, 'cost still applied');
  });
  test('blank tax rate is DROPPED — config rate stands, never 0%', () => {
    const EB2 = bad(undefined, { 'hamilton-oh': '' });
    near(perSq(EB2, 'hamilton-oh').taxRate, 0.078, 1e-9, 'tax rate');
  });
  test('a literal 0 tax rate IS honored (a tenant with no sales tax)', () => {
    const EB2 = bad(undefined, { 'hamilton-oh': 0 });
    eq(perSq(EB2, 'hamilton-oh').taxRate, 0, 'tax rate');
  });
  test("an '' county key never enters the maps (the NaN double-index hazard)", () => {
    const EB2 = bad({ '': { name: 'Nowhere', cost: 500 } }, { '': 0.5 });
    const s = EB2.getCountyTaxMap();
    if ('' in s) throw new Error("'' key leaked into the tax map");
  });
  test('a non-object permit entry is ignored', () => {
    const EB2 = bad({ 'hamilton-oh': 240 });
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 185, 'permit');
  });
}

// ── fallbackTaxRate (the blank-county rate) ───────────────────────────────
console.log('\nfallbackTaxRate');
{
  test('tenant fallback rate applies when no county is set', () => {
    const EB2 = loadEngine({ pricing: { fallbackTaxRate: 0.0625 } });
    near(perSq(EB2, '').taxRate, 0.0625, 1e-9, 'blank-county rate');
  });
  test('tenant fallback of 0 is honored (no sales tax)', () => {
    const EB2 = loadEngine({ pricing: { fallbackTaxRate: 0 } });
    eq(perSq(EB2, '').taxRate, 0, 'blank-county rate');
  });
  test('null / blank fallback is ignored — 7% config default stands', () => {
    near(perSq(loadEngine({ pricing: { fallbackTaxRate: null } }), '').taxRate, 0.07, 1e-9, 'null');
    near(perSq(loadEngine({ pricing: { fallbackTaxRate: '' } }), '').taxRate, 0.07, 1e-9, 'blank');
  });
  test('blank county still charges the $150 permit fail-safe (C-1 intact)', () => {
    eq(perSq(loadEngine({ pricing: { fallbackTaxRate: 0.05 } }), '').addOns.permit, 150, 'permit');
  });
}

// ── Coexistence with custom jurisdictions (#1133) ─────────────────────────
console.log('\nCoexistence with custom jurisdictions');
{
  const BOTH = { pricing: {
    permits:   { 'hamilton-oh': { name: 'Hamilton County, OH', cost: 210 } },
    countyTax: { 'hamilton-oh': 0.0825 },
    customJurisdictions: { 'custom-metro-nashville': { name: 'Metro Nashville, TN', cost: 200, rate: 0.0925 } },
  } };
  test('canonical override and custom jurisdiction both resolve', () => {
    const EB2 = loadEngine(BOTH);
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 210, 'canonical permit');
    eq(perSq(EB2, 'custom-metro-nashville').addOns.permit, 200, 'custom permit');
    near(perSq(EB2, 'custom-metro-nashville').taxRate, 0.0925, 1e-9, 'custom rate');
  });
  test('both appear in getCountyTaxMap', () => {
    const m = loadEngine(BOTH).getCountyTaxMap();
    near(m['hamilton-oh'], 0.0825, 1e-9, 'canonical');
    near(m['custom-metro-nashville'], 0.0925, 1e-9, 'custom');
  });
}

// ── Node neutrality: no window → no overlay (other suites depend on this) ──
console.log('\nNode neutrality');
{
  test('a plain require() (no window) prices off the config tables', () => {
    const EB2 = require(path.join(__dirname, '..', 'docs/pro/js/estimate-builder-v2.js'))
      || (typeof global !== 'undefined' && global.EstimateBuilderV2);
    const api = EB2 && EB2.calculatePerSq ? EB2 : (global.window && global.window.EstimateBuilderV2);
    if (!api || typeof api.calculatePerSq !== 'function') { console.log('    (engine not require-able standalone — covered by job-templates.test.js)'); return; }
    eq(api.calculatePerSq({ squares: 20, tier: 'good', mode: 'cash', layers: 1, county: 'hamilton-oh', city: 'hamilton-oh' }).addOns.permit, 185, 'config permit');
  });
  test('the overlay is guarded by typeof window (source pin)', () => {
    if (!/function _withTenantCounties[\s\S]{0,400}typeof window !== 'undefined'/.test(ENGINE_SRC)) {
      throw new Error('_withTenantCounties must read companyProfile behind a typeof-window guard');
    }
  });
}

// ── Three-way parity on the BLANK-county path ─────────────────────────────
// Adversarial review of PR #1139 proved the gap this closes: getCountyTaxMap
// carries only .countyTax, no caller passes fallbackTaxRate, and
// estimate-logic-engine's `settings.fallbackTaxRate || 0.07` swallowed an
// explicit 0 — so a tenant at 9.25% got 7% on catalog / Job-Template scopes
// (~$675 eaten on a $30k job) while their per-SQ quote showed the right number,
// and a tenant owing NO tax got 7% PHANTOM tax on customer-facing paper.
// The canonical-county half already agreed, which is why 30/30 passed without
// catching this.
console.log('\nBlank-county three-way parity (per-SQ = V2 line-item = EstimateLogic)');
{
  const LOGIC_SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/estimate-logic-engine.js'), 'utf8');
  // Both engines in ONE window, the way a real page loads them.
  function loadBoth(companyProfile) {
    const win = {}; win.window = win;
    win._companyProfile = companyProfile;
    const sandbox = { window: win, console: { log() {}, warn() {}, error() {} } };
    vm.runInNewContext(ENGINE_SRC, sandbox, { filename: 'estimate-builder-v2.js' });
    vm.runInNewContext(LOGIC_SRC, sandbox, { filename: 'estimate-logic-engine.js' });
    if (!win.EstimateBuilderV2 || !win.EstimateLogic) throw new Error('engines did not both attach');
    return win;
  }
  // One flat line item so the tax math is easy to reason about; the assertion is
  // on taxRate, which is what diverged.
  const ITEM = [{ code: 'RFG-SHNG', name: 'Shingles', qty: 20, unit: 'SQ', materialCostPerUnit: 100, laborCostPerUnit: 0 }];
  const MEAS = { squares: 20 };

  const threeWay = (profile) => {
    const win = loadBoth(profile);
    const EB2 = win.EstimateBuilderV2;
    const perSqRate = EB2.calculatePerSq({ squares: 20, tier: 'good', mode: 'cash', layers: 1, county: '', city: '' }).taxRate;
    const lineRate = EB2.calculateLineItem({ squares: 20, tier: 'good', mode: 'cash', county: '', city: '' }).taxRate;
    // EXACTLY what estimate-v2-ui / job-templates pass: no fallbackTaxRate.
    const logicRate = win.EstimateLogic.resolveEstimate(ITEM, MEAS, { tier: 'good', mode: 'cash', county: '' }).taxRate;
    return { perSqRate, lineRate, logicRate };
  };

  test('a tenant fallback of 9.25% reaches ALL THREE paths', () => {
    const r = threeWay({ pricing: { fallbackTaxRate: 0.0925 } });
    near(r.perSqRate, 0.0925, 1e-9, 'per-SQ');
    near(r.lineRate, 0.0925, 1e-9, 'V2 line-item');
    near(r.logicRate, 0.0925, 1e-9, 'EstimateLogic (catalog / Job Templates)');
  });
  test('a tenant with NO sales tax gets 0% everywhere — never phantom 7%', () => {
    const r = threeWay({ pricing: { fallbackTaxRate: 0 } });
    eq(r.perSqRate, 0, 'per-SQ');
    eq(r.lineRate, 0, 'V2 line-item');
    eq(r.logicRate, 0, 'EstimateLogic (this is the phantom-tax case)');
  });
  test('with no tenant policy all three still agree on the 7% config default', () => {
    const r = threeWay({ pricing: {} });
    near(r.perSqRate, 0.07, 1e-9, 'per-SQ');
    near(r.lineRate, 0.07, 1e-9, 'V2 line-item');
    near(r.logicRate, 0.07, 1e-9, 'EstimateLogic');
  });
  test('an explicitly PASSED fallbackTaxRate of 0 is honored (no || swallow)', () => {
    const win = loadBoth({ pricing: { fallbackTaxRate: 0.0925 } });
    const r = win.EstimateLogic.resolveEstimate(ITEM, MEAS, { tier: 'good', mode: 'cash', county: '', fallbackTaxRate: 0 });
    eq(r.taxRate, 0, 'caller-supplied 0 must win over the tenant value');
  });
  test('the engine exposes a resolved fallback rate for outside consumers', () => {
    const win = loadBoth({ pricing: { fallbackTaxRate: 0.0625 } });
    near(win.EstimateBuilderV2.getFallbackTaxRate(), 0.0625, 1e-9, 'getFallbackTaxRate');
    near(loadBoth({ pricing: {} }).EstimateBuilderV2.getFallbackTaxRate(), 0.07, 1e-9, 'config default');
  });
}

// ── Rate bounds (an owner typo must not invert the tax) ───────────────────
console.log('\nRate bounds');
{
  test('a NEGATIVE county tax rate is rejected (it would SUBTRACT tax)', () => {
    const EB2 = loadEngine({ pricing: { countyTax: { 'hamilton-oh': -0.05 } } });
    near(perSq(EB2, 'hamilton-oh').taxRate, 0.078, 1e-9, 'config rate stands');
  });
  test('a rate > 1 is rejected (a percent pasted where a decimal belongs)', () => {
    const EB2 = loadEngine({ pricing: { countyTax: { 'hamilton-oh': 9.25 } } });
    near(perSq(EB2, 'hamilton-oh').taxRate, 0.078, 1e-9, 'config rate stands');
  });
  test('a negative fallback rate is rejected', () => {
    const EB2 = loadEngine({ pricing: { fallbackTaxRate: -0.05 } });
    near(perSq(EB2, '').taxRate, 0.07, 1e-9, 'config fallback stands');
  });
  test('the two sanitizers agree: both reject negatives', () => {
    const EB2 = loadEngine({ pricing: {
      countyTax: { 'hamilton-oh': -0.05 },
      permits: { 'hamilton-oh': { name: 'Hamilton County, OH', cost: -50 } },
    } });
    near(perSq(EB2, 'hamilton-oh').taxRate, 0.078, 1e-9, 'tax');
    eq(perSq(EB2, 'hamilton-oh').addOns.permit, 185, 'permit');
  });
  test('the 15 money inputs carry min="0" on the dashboard', () => {
    const ids = ['permHamOh','permButOh','permWarOh','permCleOh','permKenKy','permBooKy','permCamKy',
                 'taxHamOh','taxButOh','taxWarOh','taxCleOh','taxKenKy','taxBooKy','taxCamKy','defTaxRate'];
    for (const page of ['docs/pro/dashboard.html']) {
      const src = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
      for (const id of ids) {
        const m = src.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
        if (!m) throw new Error(page + ': input #' + id + ' not found');
        if (!/\bmin="0"/.test(m[0])) throw new Error(page + ': #' + id + ' has no min="0" — ' + m[0]);
      }
    }
  });
}

// ── Persistence contract (settings panel save / load / reset) ─────────────
console.log('\nPersistence contract (dashboard-bootstrap)');
{
  test('SAVE writes the county maps + fallback to companyProfile.pricing', () => {
    if (!/pricing\.permits = patch\.permits/.test(BOOT)) throw new Error('permits not persisted per-tenant');
    if (!/pricing\.countyTax = patch\.countyTax/.test(BOOT)) throw new Error('countyTax not persisted per-tenant');
    if (!/pricing\.fallbackTaxRate = patch\.fallbackTaxRate/.test(BOOT)) throw new Error('fallbackTaxRate not persisted per-tenant');
  });
  test('the per-tenant write is gated on hydration (no wipe from a stale page)', () => {
    // Superseded by the countyReady assertions below — profileReady alone was
    // the PR-#1139 review blocker, because it does not prove the inputs came
    // from the profile. Kept as the outer guarantee: the write is conditional.
    if (!/if \(countyReady\) \{[\s\S]{0,220}pricing\.permits = patch\.permits/.test(BOOT)) {
      throw new Error('county persistence must sit behind a hydration gate');
    }
  });
  test('the county maps are FULL-REPLACED at their dot paths (merge would resurrect)', () => {
    if (!/'pricing\.permits'\] = patch\.permits/.test(BOOT)) throw new Error('permits not full-replaced');
    if (!/'pricing\.countyTax'\] = patch\.countyTax/.test(BOOT)) throw new Error('countyTax not full-replaced');
  });
  test('RESET clears the tenant county policy, not just localStorage', () => {
    const i = BOOT.indexOf('const _resetEstimateDefaultsV2');
    const block = BOOT.slice(i, BOOT.indexOf('\n  };', i));
    if (!/'pricing\.permits': \{\}/.test(block)) throw new Error('reset does not clear permits');
    if (!/'pricing\.countyTax': \{\}/.test(block)) throw new Error('reset does not clear countyTax');
    if (!/'pricing\.fallbackTaxRate': null/.test(block)) throw new Error('reset does not clear fallbackTaxRate');
    if (!/window\._companyProfileLoaded === true/.test(block)) throw new Error('reset must gate on a hydrated profile');
  });
  test('reset warns that county rates are company-wide before wiping them', () => {
    const i = BOOT.indexOf('const _resetEstimateDefaultsV2');
    if (!/COMPANY-wide/.test(BOOT.slice(i, i + 600))) throw new Error('confirm() copy must say the reset hits every rep');
  });
  test('the panel DISPLAYS resolved (tenant) values but SAVES from pure device settings', () => {
    if (!/const s = _v2ReadResolvedSettings\(\);/.test(BOOT)) throw new Error('load must read the resolved settings');
    if (!/function _v2ReadResolvedSettings/.test(BOOT)) throw new Error('missing resolved-settings bridge');
    const si = BOOT.indexOf('window._saveEstimateDefaultsV2');
    const save = BOOT.slice(si, si + 4000);
    if (/_v2ReadResolvedSettings\(\)/.test(save)) throw new Error('the SAVE path must use the PURE read, or the overlay is written back as device state');
  });
  test('a rules denial is reported as permission, not as a network blip', () => {
    if (!/function _pricingDenied/.test(BOOT)) throw new Error('missing _pricingDenied helper');
    if (!/owner or company admin/i.test(BOOT)) throw new Error('denied copy must name who can change company pricing');
  });

  // ── The stale-input clobber (PR #1139 review blocker) ───────────────────
  // profileReady only proves the profile is hydrated AT SAVE TIME. It does not
  // prove the 14 inputs were painted FROM it — and publishing pre-hydration
  // inputs is a dot-path full-replace of company money with factory values.
  test('county persistence requires PANEL hydration, not just profile hydration', () => {
    // …for the tenant the save writes to (second review of #1774; the
    // behaviour is pinned by the Save All vm tests below).
    if (!/const countyReady = profileReady && _countyInputsResolved && paintedHere\(_countyInputsKey\);/.test(BOOT)) {
      throw new Error('missing the countyReady gate');
    }
    if (!/_countyInputsResolved = !!s && window\._companyProfileLoaded === true;/.test(BOOT)) {
      throw new Error('_loadEstimateDefaultsV2 must record whether the inputs came from a hydrated profile');
    }
  });
  test('every county write site is gated on countyReady, never bare profileReady', () => {
    // 3 sites: the pricing payload, the dot-path replace, the in-memory sync.
    const gated = (BOOT.match(/if \(countyReady\) \{/g) || []).length;
    if (gated < 3) throw new Error('expected 3 countyReady-gated write sites, found ' + gated);
    const si = BOOT.indexOf('window._saveEstimateDefaultsV2');
    const save = BOOT.slice(si, si + 6000);
    if (/if \(profileReady\) \{\s*\n\s*pricing\.permits/.test(save)) {
      throw new Error('a county write is still gated on bare profileReady');
    }
  });
  test('a skipped county save says so instead of claiming every estimate updated', () => {
    if (!/countySaveSkipped/.test(BOOT)) throw new Error('missing countySaveSkipped flag');
    if (!/\(jurSaveSkipped \|\| countySaveSkipped\)/.test(BOOT)) throw new Error('the skip must reach the message');
    // 2026-09-25 (lane profretry): the skip is a WARNING now, not a "✓ saved"
    // in success green — the behavioural twin below runs the real save.
    if (!/were NOT saved for your company/.test(BOOT)) throw new Error('skip copy must say the company rates were NOT saved');
  });
  test('the landing handler repaints every company input, not just the jurisdiction rows', () => {
    // Was the 500ms rehydrate poll; since 2026-09-25 (lane profretry) a
    // landing arrives as 'nbd:company-profile-loaded'. Since the PR #1774
    // review it repaints the COMPANY half of the panel only (the per-device
    // half keeps the rep's typing) — the behavioural twin is the "Profile boot
    // retry: a late landing" section below.
    const i = BOOT.indexOf('function _jurProfileLanded() {');
    if (i < 0) throw new Error('_jurProfileLanded not found');
    const block = BOOT.slice(i, BOOT.indexOf('\n  }', i));
    // A DIRECT call (Globals Tranche 3 T3-C, 2026-09-18): these are
    // module-scope declarations, off window — a window.X() read here would
    // throw inside the handler and leave the inputs stale. codeOnly(): a
    // commented-out call must not satisfy the pin (PR #1662 review).
    if (!/(?:^|[^.\w$])_repaintCompanyFromProfile\(\)/.test(codeOnly(block))) {
      throw new Error('the landing must repaint the company inputs or the 14 county inputs stay stale forever');
    }
    const r = BOOT.indexOf('function _repaintCompanyFromProfile() {');
    if (r < 0) throw new Error('_repaintCompanyFromProfile not found');
    if (!/(?:^|[^.\w$])_paintCompanyEstimateInputs\(\)/.test(codeOnly(BOOT.slice(r, BOOT.indexOf('\n  }', r))))) {
      throw new Error('_repaintCompanyFromProfile must re-run _paintCompanyEstimateInputs');
    }
  });
  test('reset treats NOT_FOUND as success (a tenant with no profile has nothing to clear)', () => {
    const i = BOOT.indexOf('const _resetEstimateDefaultsV2');
    const block = BOOT.slice(i, BOOT.indexOf('\n  };', i));
    if (!/not-found\|NOT_FOUND/i.test(block)) throw new Error('reset must not report NOT_FOUND as a failure');
  });
}

// ── Globals Tranche 3 T3-C (2026-09-18): the panel loader is registry-only ──
// _loadEstimateDefaultsV2 moved off window into dashboard-bootstrap.module.js's
// __NBD_CALL_REGISTRY. Its three callers are the ONLY things that ever paint
// this panel: switchSettingsTab (ui.js) on tab open, the rehydrate poll, and
// reset. Any of them left reading window silently no-ops (or throws in a
// timer), the inputs keep factory/device values, and the next Save publishes
// them company-wide — the stale-input clobber pinned above.
console.log('\nGlobals Tranche 3 T3-C: the panel loader is registry-only');
{
  const UI = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/ui.js'), 'utf8');
  const BARE_CALL = /(?:^|[^.\w$])_loadEstimateDefaultsV2\(\)/;

  test('the loader is a module-scope declaration, never re-exposed on window', () => {
    if (!/\n  function _loadEstimateDefaultsV2\(\) \{/.test(BOOT)) throw new Error('missing the top-level function declaration');
    for (const [label, src] of [['dashboard-bootstrap.module.js', BOOT], ['ui.js', UI]]) {
      if (/\b(?:window|globalThis|self)\s*\.\s*_loadEstimateDefaults(?:V2)?\b/.test(src)) {
        throw new Error(label + ' still reads or writes window._loadEstimateDefaults[V2]');
      }
      if (/\b(?:window|globalThis|self)\s*\[\s*['"`]_loadEstimateDefaults/.test(src)) {
        throw new Error(label + ' still reaches it through window[...] bracket access');
      }
    }
  });
  test('the registry maps _loadEstimateDefaultsV2 to the loader binding of the same name', () => {
    const m = BOOT.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/);
    if (!m) throw new Error('dashboard-bootstrap registry block not found');
    // Evaluate the literal (repo source, in a bare vm sandbox) with every free
    // identifier resolving to a name tag: survives shorthand/reformatting,
    // still proves key -> same-named binding.
    const scope = new Proxy({}, {
      has: () => true,
      get: (_, k) => (k === Symbol.unscopables ? undefined : { binding: String(k) }),
    });
    const reg = vm.runInNewContext('with (scope) { ({' + m[1] + '}); }', { scope });
    const v = reg._loadEstimateDefaultsV2;
    if (!v || v.binding !== '_loadEstimateDefaultsV2') {
      throw new Error('_loadEstimateDefaultsV2 is not registered to its own binding (got ' + JSON.stringify(v) + ')');
    }
    // My Jurisdictions' "↻ Try again" (2026-09-25): a registry-only call too.
    const t = reg._retryJurisdictions;
    if (!t || t.binding !== '_retryJurisdictions') {
      throw new Error('_retryJurisdictions is not registered to its own binding (got ' + JSON.stringify(t) + ')');
    }
  });
  test('reset repaints through a direct call, not a window read', () => {
    const i = BOOT.indexOf('const _resetEstimateDefaultsV2');
    const end = BOOT.indexOf('\n  };', i);
    if (i < 0 || end < 0) throw new Error('reset function not found');
    if (!BARE_CALL.test(codeOnly(BOOT.slice(i, end)))) throw new Error('reset must repaint the panel via _loadEstimateDefaultsV2()');
  });

  // Behavioral twins of the poll and reset pins: the real functions run in a
  // vm with stubbed globals, so they also catch shapes no regex can see, e.g.
  // `if (false) { _loadEstimateDefaultsV2(); }` or the call moved into the
  // tenant-only branch.
  // (The rehydrate-poll twin that stood here moved to the async "Profile boot
  // retry" section below with the poll itself, 2026-09-25.)
  test('reset really repaints the panel (device-only reset, profile not hydrated)', () => {
    const i = BOOT.indexOf('const _resetEstimateDefaultsV2');
    const end = BOOT.indexOf('\n  };', i);
    if (i < 0 || end < 0) throw new Error('reset function not found');
    const log = { loads: 0, toasts: 0 };
    // afterEvaluate drains the context's microtasks before runInContext
    // returns, so the async reset finishes inside this synchronous test. The
    // stubs are built INSIDE the context so their promises use its queue.
    const ctx = vm.createContext({ log }, { microtaskMode: 'afterEvaluate' });
    vm.runInContext(
      'var window = { nbdConfirm: function () { return Promise.resolve(true); },' +
      ' EstimateBuilderV2: { getDefaultSettings: function () { return {}; }, saveSettings: function () {} },' +
      ' _companyProfileLoaded: false };' +
      'function _loadEstimateDefaultsV2() { log.loads++; }' +
      'function showToast() { log.toasts++; }' +
      'function _pricingDenied() { return false; }', ctx);
    vm.runInContext(BOOT.slice(i, end + 5) + '\n_resetEstimateDefaultsV2();', ctx);
    eq(log.toasts, 1, 'reset ran to completion (toasts)');
    eq(log.loads, 1, 'loader calls after reset');
  });

  // switchSettingsTab, run for real against a stub DOM.
  function runEstimatesTab(win) {
    const start = UI.indexOf('function switchSettingsTab(tab) {');
    const end = UI.indexOf('window.switchSettingsTab = switchSettingsTab;', start);
    if (start < 0 || end < 0) throw new Error('switchSettingsTab not found in ui.js');
    const ctx = vm.createContext({
      window: win,
      document: { querySelectorAll: () => [], getElementById: () => null },
    });
    vm.runInContext(UI.slice(start, end), ctx);
    ctx.switchSettingsTab('estimates');
  }
  test('opening Estimates with the engine already loaded paints via the registry', () => {
    let calls = 0;
    runEstimatesTab({ EstimateBuilderV2: {}, __NBD_CALL_REGISTRY: { _loadEstimateDefaultsV2: () => { calls++; } } });
    eq(calls, 1, 'registry loader calls (synchronous branch)');
  });
  test('opening Estimates cold loads the bundle, then paints via the registry', () => {
    let calls = 0, bundle = null;
    runEstimatesTab({
      ScriptLoader: { loadBundle: (n) => { bundle = n; return { then: (cb) => cb() }; } },
      __NBD_CALL_REGISTRY: { _loadEstimateDefaultsV2: () => { calls++; } },
    });
    eq(bundle, 'estimates', 'bundle requested');
    eq(calls, 1, 'registry loader calls (lazy-bundle branch)');
  });
  test('a stale window copy is never called; no registry entry is a silent no-op', () => {
    let stale = 0;
    runEstimatesTab({ EstimateBuilderV2: {}, _loadEstimateDefaultsV2: () => { stale++; }, __NBD_CALL_REGISTRY: {} });
    runEstimatesTab({ EstimateBuilderV2: {}, _loadEstimateDefaultsV2: () => { stale++; } });
    eq(stale, 0, 'window._loadEstimateDefaultsV2 calls');
  });
}

// ── Profile boot retry (2026-09-25, lane profretry) ─────────────────────────
// The boot companyProfile read gave up on a cold Firestore channel ("client is
// offline" three times inside ~2.4s) and nothing asked again, so
// _companyProfileLoaded stayed unset all session: My Jurisdictions sat on
// "Loading…", and Save All left county rates and jurisdictions out under a
// "✓ saved". These run the REAL code — company-profile.js's
// _ensureCompanyProfile, the My Jurisdictions waiter and _saveEstimateDefaultsV2
// — in a vm, and pin the invariant that makes a retry safe: only a successful
// doc read ever sets the flag, and nothing is published company-wide from a
// panel that was not painted from it.
const CP_SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/company-profile.js'), 'utf8');
const FS_IMPORT_RE = /import\((['"])\/assets\/vendor\/firebase\/[\d.]+\/firebase-firestore\.js\1\)/g;
const flushTimers = () => new Promise((r) => setTimeout(r, 150));
// Await p, or fail naming what never settled.
const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' never settled')), ms))]);

// company-profile.js in a vm. getDoc outcomes come from `reads`, one per call
// ('offline' | 'denied' | 'hang' | 'ok' | 'cache' | 'pending'), then `rest`.
// 'cache' is what the real SDK hands back offline once a merge write is
// pending: the doc as the DEVICE sees it — only the written field —
// fromCache and hasPendingWrites both true. 'pending' is the acked-write race
// back online: fromCache false, hasPendingWrites true, same partial doc.
// Timers run at ms/1000, except delays listed in `park`, which end only when
// the run is kicked.
function loadProfileModule(opts) {
  opts = opts || {};
  const script = (opts.reads || []).slice();
  const st = { rest: opts.rest || 'ok', blockCache: !!opts.blockCache };
  const park = new Set(opts.park || []);
  const log = { reads: 0, sets: [], events: 0, refs: [] };
  const store = {};
  // blockCache: this tenant cache can be neither read nor written (storage
  // blocked, quota full) — what the PR #1774 review used to reach the wipe.
  const isCache = (k) => String(k).indexOf('nbd_company_profile_v1') === 0;
  const blocked = (k) => { if (st.blockCache && isCache(k)) throw new Error('QuotaExceededError'); };
  const localStorage = {
    getItem: (k) => { blocked(k); return (k in store ? store[k] : null); },
    setItem: (k, v) => { blocked(k); store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const listeners = {};
  const win = {
    localStorage,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent(ev) { if (ev.type === 'nbd:company-profile-loaded') log.events++; (listeners[ev.type] || []).forEach((f) => f(ev)); return true; },
    db: { name: 'db' },
    _userClaims: opts.noKey ? undefined : (opts.claims || { companyId: 'c1' }),
    _user: opts.signedIn ? { uid: 'u1' } : undefined,
    auth: opts.auth,
    __nbdCompanyProfileWanted: opts.wanted === true ? true : undefined,
  };
  let loaded;
  // Every write to the flag is recorded: the invariant is about WHO sets it.
  Object.defineProperty(win, '_companyProfileLoaded', { get() { return loaded; }, set(v) { log.sets.push(v); loaded = v; } });
  win.window = win;
  const fail = (m, code) => Promise.reject(Object.assign(new Error(m), { code }));
  const fsStub = {
    doc: (...a) => a.slice(1).join('/'),
    setDoc: () => Promise.resolve(),
    getDoc: (ref) => {
      log.reads++;
      log.refs.push(ref);
      const r = script.length ? script.shift() : st.rest;
      if (typeof r === 'function') return r(ref); // a read the test settles itself
      if (r === 'offline') return fail('Failed to get document because the client is offline.', 'unavailable');
      if (r === 'denied') return fail('Missing or insufficient permissions.', 'permission-denied');
      if (r === 'hang') return new Promise(() => {});
      if (r === 'none') return Promise.resolve({ exists: () => false, data: () => undefined, metadata: { fromCache: false, hasPendingWrites: false } });
      if (r === 'cache' || r === 'pending') {
        return Promise.resolve({ exists: () => true, data: () => ({ aiTexting: { enabled: true } }), metadata: { fromCache: r === 'cache', hasPendingWrites: true } });
      }
      return Promise.resolve({ exists: () => true, data: () => ({ pricing: { customJurisdictions: { 'custom-x': { name: 'X', cost: 1, rate: 0.01 } } } }), metadata: { fromCache: false, hasPendingWrites: false } });
    },
  };
  const parked = [];
  const setT = (fn, ms) => {
    if (park.has(ms)) { const h = { parked: true }; parked.push(h); return h; }
    return setTimeout(fn, Math.max(1, Math.round((ms || 0) / 1000)));
  };
  const clearT = (h) => { if (h && h.parked !== undefined) h.parked = false; else clearTimeout(h); };
  const sandbox = {
    window: win, localStorage, console: { log() {}, warn() {}, error() {} },
    setTimeout: setT, clearTimeout: clearT, Date, Math, JSON, Promise,
    CustomEvent: function (type) { this.type = type; },
    __fsImport: async () => fsStub,
  };
  const src = CP_SRC.replace(FS_IMPORT_RE, '__fsImport()');
  if (src === CP_SRC) throw new Error('harness: no firestore import was rerouted');
  vm.runInNewContext(src, sandbox, { filename: 'company-profile.js' });
  return { win, log, st, store, parkedCount: () => parked.filter((h) => h.parked).length };
}

asection('\nProfile boot retry: _ensureCompanyProfile (company-profile.js)');
atest('a boot read that gave up is retried until it lands, and only that read sets the flag', async () => {
  const m = loadProfileModule({ reads: ['offline', 'offline', 'offline', 'offline', 'offline', 'offline', 'offline'] });
  await m.win._loadCompanyProfile(); // the boot read
  eq(m.win._companyProfileLoaded, undefined, 'flag after the boot read gave up');
  eq(m.log.reads, 3, 'boot read tries');
  eq(await m.win._ensureCompanyProfile(), true, 'ensure');
  eq(m.win._companyProfileLoaded, true, 'flag once a read landed');
  eq(JSON.stringify(m.log.sets), '[true]', 'writes to _companyProfileLoaded');
  eq(m.log.reads, 8, 'reads (3 boot + 3 in attempt 1 + attempt 2 landing on its 2nd try)');
  eq(m.log.events, 1, "'nbd:company-profile-loaded' dispatches");
  eq(m.win._companyProfile.pricing.customJurisdictions['custom-x'].name, 'X', 'the landed doc is the profile');
});
atest('a channel that stays offline gives up WITHOUT ever setting the flag; the next call starts a fresh run', async () => {
  const m = loadProfileModule({ rest: 'offline' });
  eq(await m.win._ensureCompanyProfile(), false, 'ensure while offline');
  eq(m.log.sets.length, 0, 'writes to _companyProfileLoaded');
  eq(m.log.reads, 18, 'reads (six attempts x three tries)');
  eq(m.log.events, 0, 'landing events');
  m.st.rest = 'ok';
  eq(await m.win._ensureCompanyProfile(), true, 'a fresh run once the channel is back');
  eq(m.log.reads, 19, 'reads after the fresh run');
  eq(JSON.stringify(m.log.sets), '[true]', 'writes to _companyProfileLoaded');
});
atest('permission denied stops after one read (a retry cannot fix it)', async () => {
  const m = loadProfileModule({ rest: 'denied' });
  eq(await m.win._ensureCompanyProfile(), false, 'ensure');
  eq(m.log.reads, 1, 'reads');
  eq(m.log.sets.length, 0, 'writes to _companyProfileLoaded');
});
atest('no signed-in tenant: nothing to read, resolves false at once', async () => {
  const m = loadProfileModule({ noKey: true });
  eq(await m.win._ensureCompanyProfile(), false, 'ensure');
  eq(m.log.reads, 0, 'reads');
});
atest('one run at a time, and a call during a backoff delay kicks the next read now', async () => {
  const m = loadProfileModule({ reads: ['offline', 'offline', 'offline'], park: [1000, 2000, 4000, 8000, 15000] });
  const first = m.win._ensureCompanyProfile();
  await flushTimers();
  eq(m.log.reads, 3, 'attempt 1 ran its three tries');
  eq(m.parkedCount(), 1, 'runs waiting out a backoff delay');
  eq(m.win._companyProfileLoaded, undefined, 'flag while waiting');
  const second = m.win._ensureCompanyProfile(); // opening the tab / pressing Save
  eq(await within(second, 1000, 'the kicked run'), true, 'the kicked read');
  eq(await within(first, 1000, 'the first caller'), true, 'the first caller shares the run');
  eq(m.log.reads, 4, 'reads (one more, no stacked run)');
});
atest('company-profile.js arriving AFTER the boot asked starts the read itself (the typeof guard had skipped it)', async () => {
  // The dashboard's auth callback can run before this deferred file does;
  // its typeof guard then skipped the boot read and nothing ever read the
  // profile. Now the boot leaves __nbdCompanyProfileWanted; loaded after:
  const m = loadProfileModule({ signedIn: true, wanted: true, reads: ['offline', 'offline', 'offline'] });
  await flushTimers();
  eq(m.win._companyProfileLoaded, true, 'flag, with nobody calling _loadCompanyProfile');
  eq(m.log.reads, 4, 'reads (a failed first attempt, then the retry)');
  eq(m.log.events, 1, 'landing events');
  eq(m.win.__nbdCompanyProfileWanted, false, 'the request is consumed (started once)');
  // Signed in (nbd-auth.js sets window._user early) but the boot has not
  // asked: the boot will make the read itself, so none starts here.
  const idle = loadProfileModule({ signedIn: true });
  await flushTimers();
  eq(idle.log.reads, 0, 'reads when the boot has not asked (it reads itself; no double read)');
});
atest('a snapshot of the device\'s local copy never counts as loaded (offline + a pending merge write, then the acked-write race)', async () => {
  // PR #1774 review: offline, getDoc resolves from the SDK's local view, and
  // a merge write issued before hydration puts a PARTIAL doc there. Taking it
  // marked the profile loaded with no customJurisdictions, and Save All then
  // full-replaced the company's list with nothing.
  const m = loadProfileModule({ reads: ['cache', 'cache', 'cache', 'pending'] });
  const CK = 'nbd_company_profile_v1:c1'; // company-profile.js's _cacheKeyFor('c1')
  m.store[CK] = JSON.stringify({ pricing: { customJurisdictions: { 'custom-cached': { name: 'Cached', cost: 2, rate: 0.02 } } } });
  const cacheBefore = m.store[CK];
  await m.win._loadCompanyProfile(); // the boot read, offline with the write pending
  eq(m.win._companyProfileLoaded, undefined, 'flag after the boot read got only local-copy snapshots');
  eq(m.log.sets.length, 0, 'writes to _companyProfileLoaded');
  eq(m.log.reads, 3, 'boot read tries (each local-copy snapshot is retried)');
  eq(m.log.events, 0, 'landing events');
  eq(m.win._companyProfile.aiTexting && m.win._companyProfile.aiTexting.enabled, undefined, 'the partial doc never became the profile');
  eq(!!m.win._companyProfile.pricing.customJurisdictions['custom-cached'], true, 'the profile is still this tenant\'s cached copy');
  eq(m.store[CK], cacheBefore, 'the tenant cache is untouched by a rejected snapshot');
  // Back online: the acked write's partial doc races the watch update first,
  // then a clean server snapshot lands.
  eq(await m.win._ensureCompanyProfile(), true, 'ensure');
  eq(m.log.reads, 5, 'reads (the pending-write snapshot refused, then the server copy)');
  eq(JSON.stringify(m.log.sets), '[true]', 'writes to _companyProfileLoaded');
  eq(m.win._companyProfile.pricing.customJurisdictions['custom-x'].name, 'X', 'the SERVER doc is the profile');
});
atest('a getDoc that never settles does not stall the run', async () => {
  const m = loadProfileModule({ reads: ['hang'] });
  eq(await m.win._ensureCompanyProfile(), true, 'ensure');
  eq(m.log.reads, 2, 'reads');
});

// PR #1774 second review: the flag must also mean "the profile in memory IS
// this tenant's server copy". Every re-read reset it to defaults + the tenant
// cache before its getDoc, so a re-read that failed left that copy under a
// true flag — bare defaults when the cache was missing and unwritable — and
// Save All full-replaced the company's jurisdictions with nothing.
const CK1 = 'nbd_company_profile_v1:c1'; // company-profile.js's _cacheKeyFor('c1')
const cjOf = (win) => Object.keys((win._companyProfile.pricing && win._companyProfile.pricing.customJurisdictions) || {}).sort().join(',');
asection('\nProfile boot retry: "loaded" means the server copy is what is in memory');
atest('a re-read that fails keeps the server copy — never the cache (stale, or missing and unwritable) or bare defaults', async () => {
  const m = loadProfileModule();
  await m.win._loadCompanyProfile();
  eq(m.win._companyProfileLoadedKey(), 'c1', 'loaded key after the server read');
  eq(cjOf(m.win), 'custom-x', 'jurisdictions after the server read');
  // The tenant cache is gone and cannot be written (storage blocked / quota).
  delete m.store[CK1];
  m.st.blockCache = true;
  m.st.rest = 'offline';
  await m.win._loadCompanyProfile(); // Settings > Company Profile, a document generator…
  eq(m.win._companyProfileLoaded, true, 'flag after the failed re-read');
  eq(cjOf(m.win), 'custom-x', 'jurisdictions in memory after the failed re-read (missing cache)');
  // A cache older than the server copy is not put in its place either.
  m.st.blockCache = false;
  m.store[CK1] = JSON.stringify({ pricing: { customJurisdictions: { 'custom-old': { name: 'Old', cost: 9, rate: 0.09 } } } });
  await m.win._loadCompanyProfile();
  eq(cjOf(m.win), 'custom-x', 'jurisdictions in memory after the failed re-read (stale cache)');
  eq(JSON.stringify(m.log.sets), '[true]', 'writes to _companyProfileLoaded');
  // …and a re-read that lands still replaces it.
  m.st.rest = 'ok';
  await m.win._loadCompanyProfile();
  eq(cjOf(m.win), 'custom-x', 'jurisdictions after a re-read landed');
  eq(JSON.parse(m.store[CK1]).pricing.customJurisdictions['custom-x'].name, 'X', 'the landed copy is cached again');
});
atest('a save builds on the server copy in memory, not on a cache it cannot read', async () => {
  const m = loadProfileModule();
  await m.win._loadCompanyProfile();
  delete m.store[CK1];
  m.st.blockCache = true;
  await m.win._saveCompanyProfile({ businessName: 'Acme Roofing' }); // Settings > Company Profile's Save
  eq(m.win._companyProfile.businessName, 'Acme Roofing', 'the save is in memory');
  eq(cjOf(m.win), 'custom-x', 'the saved jurisdictions survive a save the cache could not take');
  // Control: before any server copy landed, the save still builds on this
  // tenant's cache (unchanged).
  const n = loadProfileModule();
  n.store[CK1] = JSON.stringify({ pricing: { customJurisdictions: { 'custom-cached': { name: 'C', cost: 1, rate: 0.01 } } } });
  await n.win._saveCompanyProfile({ businessName: 'B' });
  eq(cjOf(n.win), 'custom-cached', 'unloaded: the save builds on the tenant cache');
});
atest('the server has no doc: the defaults are the profile, and the stale cache goes', async () => {
  const m = loadProfileModule({ reads: ['none'] });
  m.store[CK1] = JSON.stringify({ pricing: { customJurisdictions: { 'custom-refused': { name: 'R', cost: 1, rate: 0.01 } } } });
  await m.win._loadCompanyProfile();
  eq(m.win._companyProfileLoaded, true, 'flag (a server answer, even "no doc", is definitive)');
  eq(cjOf(m.win), '', 'jurisdictions in memory');
  eq(CK1 in m.store, false, 'the tenant cache is removed');
});

// …and which tenant: an account switch in the same tab never reset the flag,
// so Save All could full-replace the NEW account's company with the old
// account's rows, or with nothing.
asection('\nProfile boot retry: an account switch forgets the profile, and never writes across');
atest('_resetCompanyProfile: the flag goes false, the profile back to defaults, the loaded key to null', async () => {
  const m = loadProfileModule();
  await m.win._loadCompanyProfile();
  m.win._resetCompanyProfile();
  eq(m.win._companyProfileLoaded, false, 'flag after the reset');
  eq(m.win._companyProfileLoadedKey(), null, 'loaded key after the reset');
  eq(cjOf(m.win), '', 'the previous account\'s jurisdictions in memory');
  eq(JSON.stringify(m.log.sets), '[true,false]', 'writes to _companyProfileLoaded');
  eq(await m.win._ensureCompanyProfile(), true, 'the next account\'s read');
  eq(m.log.events, 2, 'landing events (one per account)');
});
atest('a read already out when the account changed lands nothing', async () => {
  let release;
  const m = loadProfileModule({ reads: [() => new Promise((r) => { release = r; })] });
  const p = m.win._loadCompanyProfile();
  await flushTimers();
  eq(typeof release, 'function', 'the read is out');
  m.win._resetCompanyProfile(); // the account changes while it is out
  release({ exists: () => true, data: () => ({ pricing: { customJurisdictions: { 'custom-prev': { name: 'Prev', cost: 1, rate: 0.01 } } } }), metadata: { fromCache: false, hasPendingWrites: false } });
  await p;
  eq(m.win._companyProfileLoaded === true, false, 'flag after the previous account\'s read came back');
  eq(cjOf(m.win), '', 'the previous account\'s doc never became the profile');
  eq(m.log.events, 0, 'landing events');
  eq(await m.win._ensureCompanyProfile(), true, 'this account\'s read then lands');
});
atest('the key changed under the tab: the other tenant\'s copy is dropped even when the new read fails', async () => {
  const m = loadProfileModule();
  await m.win._loadCompanyProfile();
  m.win._userClaims = { companyId: 'c2' };
  m.st.rest = 'offline';
  await m.win._loadCompanyProfile();
  eq(m.log.refs[m.log.refs.length - 1], 'companyProfile/c2', 'the read went to the new tenant');
  eq(m.win._companyProfileLoaded, false, 'flag');
  eq(m.win._companyProfileLoadedKey(), null, 'loaded key');
  eq(cjOf(m.win), '', 'c1\'s jurisdictions are not c2\'s profile');
});
atest('claims left over from the previous account never pick the key', async () => {
  // The dashboard refreshes _userClaims only after its boot awaits; its
  // profile read runs before that, right after the switch.
  const userB = { uid: 'uB', getIdTokenResult: async () => ({ claims: { companyId: 'cB', user_id: 'uB' } }) };
  const m = loadProfileModule({ claims: { companyId: 'cA', user_id: 'uA' }, auth: { currentUser: userB } });
  eq(await m.win._resolveCompanyKey(), 'cB', 'key with the previous account\'s claims still in window._userClaims');
  m.win._userClaims = { companyId: 'cB2', user_id: 'uB' };
  eq(await m.win._resolveCompanyKey(), 'cB2', 'control: this account\'s claims are used');
  m.win._userClaims = { companyId: 'c9' };
  eq(await m.win._resolveCompanyKey(), 'c9', 'control: claims without a uid are trusted, as before');
});
atest('a save for another tenant than the loaded one forgets that copy instead of relabelling it, and asks for this one', async () => {
  // Second review of #1774: the company changed under the tab, and an
  // ungated save (Settings > Company Profile) put c2's cache into memory
  // under a flag that still named c1's server copy.
  const m = loadProfileModule();
  await m.win._loadCompanyProfile();
  eq(m.win._companyProfileLoadedKey(), 'c1', 'loaded key before');
  m.win._userClaims = { companyId: 'c2' }; // the account's company changed
  await m.win._saveCompanyProfile({ businessName: 'Typed' });
  eq(m.log.sets[1], false, 'the flag goes down on the save (writes: ' + JSON.stringify(m.log.sets) + ')');
  await flushTimers();
  eq(m.log.refs[m.log.refs.length - 1], 'companyProfile/c2', 'this tenant\'s profile is read');
  eq(m.win._companyProfileLoadedKey(), 'c2', 'loaded key once it lands');
  eq(m.log.events, 2, 'landing events (one per tenant)');
  // Control: a save for the loaded tenant keeps its server copy and the flag.
  const c = loadProfileModule();
  await c.win._loadCompanyProfile();
  await c.win._saveCompanyProfile({ businessName: 'Typed' });
  await flushTimers();
  eq(JSON.stringify(c.log.sets), '[true]', 'control: writes to _companyProfileLoaded');
  eq(c.log.reads, 1, 'control: reads');
  eq(c.win._companyProfile.businessName, 'Typed', 'control: the save is in memory');
});

// The My Jurisdictions waiter (dashboard-bootstrap), real code in a vm.
function loadJurWaiter() {
  const i = BOOT.indexOf('  let _jurRowsResolved = false;');
  const fnStart = BOOT.indexOf('function _renderJurisdictionRows() {', i);
  const end = BOOT.indexOf('\n  }', fnStart);
  if (i < 0 || fnStart < 0 || end < 0) throw new Error('jurisdictions waiter not found');
  const attrs = {};
  const host = {
    innerHTML: '', rows: 0, appendChild() { this.rows++; },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
  };
  const listeners = {};
  const log = { ensure: 0, loads: 0 };
  let run = null, finish = null;
  const win = {
    _companyProfileLoaded: false,
    _companyProfile: { pricing: { customJurisdictions: { 'custom-a': { name: 'A', cost: 5, rate: 0.01 } } } },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    _ensureCompanyProfile() {
      log.ensure++;
      if (!run) run = new Promise((r) => { finish = (v) => { run = null; r(v); }; });
      return run;
    },
  };
  const ctx = vm.createContext({ window: win, document: { getElementById: (id) => (id === 'jurRows' ? host : null) }, _renderJurisdictionRow: () => ({}), Promise, showToast() {}, clearTimeout() {} });
  // The company half of the panel (it repaints these rows among the rest).
  ctx._paintCompanyEstimateInputs = () => { log.loads++; ctx._renderJurisdictionRows(); };
  ctx._companyInputsEdited = () => [];
  ctx._loadEstimateDefaultsV2 = () => { log.full = (log.full || 0) + 1; ctx._paintCompanyEstimateInputs(); };
  // The county half's paint record lives above this slice (loadPanel runs it).
  vm.runInContext('var _countyInputsResolved = false; var _countyInputsKey = null;', ctx);
  vm.runInContext(BOOT.slice(i, end + 4), ctx);
  const announce = () => { win._companyProfileLoaded = true; (listeners['nbd:company-profile-loaded'] || []).forEach((f) => f()); };
  return {
    ctx, host, log,
    resolved: () => vm.runInContext('_jurRowsResolved', ctx),
    land: () => { announce(); if (finish) finish(true); },
    giveUp: () => { if (finish) finish(false); },
    announce,
  };
}

asection('\nProfile boot retry: My Jurisdictions asks, and says when it cannot');
atest('the tab asks for the read, and repaints the company inputs when it lands', async () => {
  const w = loadJurWaiter();
  w.ctx._renderJurisdictionRows();
  eq(w.host.getAttribute('data-jur-wait'), 'loading', 'placeholder state');
  if (!/Loading your saved jurisdictions/.test(w.host.innerHTML)) throw new Error('no loading line');
  eq(w.log.ensure, 1, 'reads asked for on paint');
  eq(w.resolved(), false, '_jurRowsResolved on the loading line');
  w.ctx._renderJurisdictionRows(); // the rep reopens the tab: ask again (a kick)
  eq(w.log.ensure, 2, 'reads asked for after reopening');
  await flushTimers();
  eq(w.log.loads, 0, 'repaints before the profile lands');
  w.land();
  await flushTimers();
  eq(w.log.loads, 1, 'company-input repaints once it lands');
  eq(w.log.full || 0, 0, 'whole-panel repaints (the per-device inputs are left alone)');
  eq(w.host.hasAttribute('data-jur-wait'), false, 'loading state cleared');
  eq(w.host.rows, 1, 'saved rows painted');
  eq(w.resolved(), true, '_jurRowsResolved after the repaint');
});
atest('a run that gives up says so and offers Try again; a landing after that still repaints', async () => {
  const w = loadJurWaiter();
  w.ctx._renderJurisdictionRows();
  w.giveUp();
  await flushTimers();
  eq(w.host.getAttribute('data-jur-wait'), 'failed', 'state after the run gave up');
  if (!/did not load/.test(w.host.innerHTML)) throw new Error('the rep is not told the list did not load');
  if (!/data-action="call" data-fn="_retryJurisdictions"/.test(w.host.innerHTML)) throw new Error('no Try again wired to _retryJurisdictions');
  eq(w.resolved(), false, '_jurRowsResolved on the failure message');
  eq(w.log.loads, 0, 'repaints');
  w.announce(); // lands later through another read (online event, a document generator)
  eq(w.log.loads, 1, 'repaints on the later landing');
  eq(w.host.rows, 1, 'saved rows painted');
});
atest('Try again asks again with only the jurisdiction box reloading, never the whole panel', async () => {
  // It re-ran _loadEstimateDefaultsV2, which also put back every per-device
  // input over unsaved typing (PR #1774 review follow-up).
  const w = loadJurWaiter();
  w.ctx._renderJurisdictionRows();
  w.giveUp();
  await flushTimers();
  eq(w.host.getAttribute('data-jur-wait'), 'failed', 'state after the run gave up');
  const asked = w.log.ensure;
  w.ctx._retryJurisdictions();
  eq(w.host.getAttribute('data-jur-wait'), 'loading', 'state after Try again');
  eq(w.log.ensure, asked + 1, 'reads asked for by Try again');
  eq(w.log.full || 0, 0, 'whole-panel repaints');
  w.land();
  await flushTimers();
  eq(w.host.rows, 1, 'saved rows painted once it lands');
  eq(w.log.full || 0, 0, 'whole-panel repaints after the landing');
});

// The whole Estimates panel painter (dashboard-bootstrap), real code in a vm:
// _loadEstimateDefaultsV2 and both its halves, My Jurisdictions and the
// landing handler, over a stub DOM where every id resolves to an input.
function loadPanel() {
  const start = BOOT.indexOf('  let _countyInputsResolved = false;');
  const fnStart = BOOT.indexOf('function _renderJurisdictionRows() {', start);
  const end = BOOT.indexOf('\n  }', fnStart);
  if (start < 0 || fnStart < 0 || end < 0) throw new Error('Estimates panel painter not found');
  const els = {};
  const mk = (id) => {
    const attrs = {};
    let html = '';
    return {
      id, value: '', textContent: '', style: {}, rows: 0,
      get innerHTML() { return html; }, set innerHTML(v) { html = String(v); this.rows = 0; },
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
      hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
      appendChild() { this.rows++; },
    };
  };
  const byId = (id) => (els[id] = els[id] || mk(id));
  const listeners = {};
  const log = { ensure: 0, toasts: [], upgRenders: 0 };
  let finish = null;
  // st.key: the tenant whose server copy company-profile.js says is loaded
  // (null: the older stand-in with no key, which every earlier test uses).
  const st = { key: null };
  const win = {
    _companyProfileLoaded: false,
    _companyProfile: { pricing: {} },
    NBD_ESTIMATE_CONFIG: { ADDON_STEEP_PER_SQ: 25 },
    NBDUpgradePriceSettings: { render() { log.upgRenders++; } },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    _companyProfileLoadedKey: () => (win._companyProfileLoaded === true ? st.key : null),
    _ensureCompanyProfile() {
      log.ensure++;
      return new Promise((r) => { finish = r; });
    },
  };
  // What getResolvedCountySettings returns: this device's settings, with the
  // tenant's county policy overlaid once the profile has landed (the landed
  // profile's own Hamilton permit when it carries one).
  const device = { tierRates: { good: 545 }, costBasis: { good: 0 }, fallbackTaxRate: 0.07, permits: { 'hamilton-oh': { cost: 100 } }, countyTax: { 'hamilton-oh': 0.07 } };
  const resolved = () => (win._companyProfileLoaded === true
    ? Object.assign({}, device, { permits: (win._companyProfile.pricing && win._companyProfile.pricing.permits) || { 'hamilton-oh': { cost: 150 } }, countyTax: { 'hamilton-oh': 0.078 } })
    : device);
  const ctx = vm.createContext({
    window: win, Promise,
    document: { getElementById: byId, createElement: () => ({ setAttribute() {}, innerHTML: '' }) },
    _v2ReadResolvedSettings: resolved,
    showToast: (m, k) => log.toasts.push({ m: String(m), k }),
    clearTimeout() {}, setTimeout() { return 0; },
  });
  vm.runInContext(BOOT.slice(start, end + 4), ctx);
  return {
    ctx, byId, log,
    val: (id) => String(byId(id).value),
    type: (id, v) => { byId(id).value = v; },
    // The profile lands (any reader's read): the company's values arrive.
    // key/pricing: whose profile it is, and what it holds (default: the
    // keyless stand-in with company A's values).
    land: (key, pricing) => {
      win._companyProfileLoaded = true;
      st.key = key == null ? null : key;
      win._companyProfile = { pricing: pricing || { addonPrices: { steepPerSq: 30 }, customJurisdictions: { 'custom-a': { name: 'A', cost: 5, rate: 0.01 } } } };
      (listeners['nbd:company-profile-loaded'] || []).forEach((f) => f());
      if (finish) finish(true);
    },
    // company-profile.js's _resetCompanyProfile (an account switch).
    reset: () => { win._companyProfileLoaded = false; st.key = null; win._companyProfile = { pricing: {} }; },
    flag: (name) => vm.runInContext(name, ctx),
  };
}

asection('\nProfile boot retry: a late landing keeps the rep\'s typing, and says what it replaced');
atest('the per-device inputs keep unsaved typing; the company inputs take the company values, and the rep is told', async () => {
  // PR #1774 review: a landing can now arrive any time (the online event,
  // another panel's read, the retry schedule). It re-ran the whole loader,
  // so a rep's unsaved tier rate 777 and cost 321 came back as 545 and 0,
  // with no word.
  const p = loadPanel();
  p.ctx._loadEstimateDefaultsV2(); // the tab opens before the profile landed
  eq(p.byId('jurRows').getAttribute('data-jur-wait'), 'loading', 'jurisdictions while unloaded');
  eq(p.val('v2rateGood'), '545', 'tier rate as painted');
  eq(p.val('taxHamOh'), '7.00', 'county tax as painted (device value)');
  eq(p.flag('_countyInputsResolved'), false, '_countyInputsResolved before the landing');
  p.type('v2rateGood', '777');
  p.type('v2costGood', '321');
  p.type('taxHamOh', '9.99'); // company-wide, and not saveable yet
  p.land();
  await flushTimers();
  // Package prices are COMPANY-wide since 2026-10-04 (tenant-ready): a
  // landing paints the company's rate over unsaved typing, like the county
  // inputs, and the rep is told. Cost basis stays per device.
  eq(p.val('v2rateGood'), '545', 'the tier rate shows the company value after the landing');
  eq(p.val('v2costGood'), '321', 'the rep\'s unsaved cost basis after the landing');
  eq(p.val('taxHamOh'), '7.80', 'county tax shows the company value');
  eq(p.val('permHamOh'), '150', 'permit cost shows the company value');
  eq(p.val('v2addonSteep'), '30', 'add-on rate shows the company value');
  eq(p.byId('jurRows').hasAttribute('data-jur-wait'), false, 'jurisdiction loading state cleared');
  eq(p.byId('jurRows').rows, 1, 'saved jurisdiction rows painted');
  eq(p.flag('_countyInputsResolved'), true, '_countyInputsResolved after the landing');
  eq(p.flag('_jurRowsResolved'), true, '_jurRowsResolved after the landing');
  const msg = p.byId('v2save-msg');
  eq(msg.getAttribute('data-kind'), 'warn', 'panel message kind');
  // Two now: the county tax AND the package price (company-wide since 2026-10-04).
  if (!/replaced 2 county, tax or add-on rates you had changed/.test(msg.textContent)) throw new Error('panel message: ' + msg.textContent);
  eq(p.log.toasts.length, 1, 'toasts');
  eq(p.log.toasts[0].k, 'info', 'toast kind');
});
atest('control: a landing with no company input changed says nothing, and still keeps device typing', async () => {
  const p = loadPanel();
  p.ctx._loadEstimateDefaultsV2();
  p.type('v2costGood', '321'); // a per-device input (tier rates are company-wide now)
  p.land();
  await flushTimers();
  eq(p.val('v2costGood'), '321', 'the rep\'s unsaved cost basis after the landing');
  eq(p.val('taxHamOh'), '7.80', 'county tax shows the company value');
  eq(p.log.toasts.length, 0, 'toasts');
  eq(p.byId('v2save-msg').getAttribute('data-kind'), null, 'panel message kind');
});

// Second review of #1774: the panel's paint recorded THAT it came from a
// loaded profile, never WHOSE. Same account, its company changed under the tab
// (claims), a re-read loaded the new company — and the panel kept the old
// one's rows and rates, which Save All then full-replaced onto the new one.
const PROF_V = { addonPrices: { steepPerSq: 33 }, permits: { 'hamilton-oh': { cost: 303 } }, customJurisdictions: { 'custom-v': { name: 'Victor', cost: 3, rate: 0.03 } } };
const PROF_X = { addonPrices: { steepPerSq: 34 }, permits: { 'hamilton-oh': { cost: 404 } }, customJurisdictions: { 'custom-x1': { name: 'Xray', cost: 4, rate: 0.04 }, 'custom-x2': { name: 'Xylo', cost: 5, rate: 0.05 } } };
asection('\nProfile boot retry: the panel records WHOSE profile it was painted from');
atest('another company\'s profile landing repaints a panel painted for the old one, and says what it replaced', async () => {
  const p = loadPanel();
  p.land('cV', PROF_V);
  p.ctx._loadEstimateDefaultsV2(); // the tab paints company V
  eq(p.val('permHamOh'), '303', 'permit as painted for V');
  eq(p.byId('jurRows').rows, 1, 'V\'s rows');
  eq(p.flag('_countyInputsKey'), 'cV', 'county inputs painted for');
  eq(p.flag('_jurRowsKey'), 'cV', 'rows painted for');
  p.type('v2addonSteep', '99'); // a company-wide edit, over V's rates
  p.land('cX', PROF_X); // the claims changed; a re-read loaded company X
  await flushTimers();
  eq(p.val('permHamOh'), '404', 'permit shows X\'s');
  eq(p.val('v2addonSteep'), '34', 'add-on rate shows X\'s');
  eq(p.byId('jurRows').rows, 2, 'X\'s rows painted');
  eq(p.flag('_countyInputsKey'), 'cX', 'county inputs painted for');
  eq(p.flag('_jurRowsKey'), 'cX', 'rows painted for');
  const msg = p.byId('v2save-msg');
  eq(msg.getAttribute('data-kind'), 'warn', 'panel message kind');
  if (!/replaced a county, tax or add-on rate you had changed/.test(msg.textContent)) throw new Error('panel message: ' + msg.textContent);
});
atest('control: a landing for the company the panel was painted for leaves typing alone', async () => {
  const p = loadPanel();
  p.land('cX', PROF_X);
  p.ctx._loadEstimateDefaultsV2();
  p.type('v2addonSteep', '77');
  p.land('cX', PROF_X); // another read of the same company (a document generator's)
  await flushTimers();
  eq(p.val('v2addonSteep'), '77', 'the rep\'s unsaved add-on rate');
  eq(p.log.toasts.length, 0, 'toasts');
});
atest('an account switch takes the old company\'s values off the panel; the new account\'s landing repaints it', async () => {
  // Second review of #1774, minor: after a same-tab switch the tab kept the
  // previous company's rows, rates and upgrade typing on screen.
  const p = loadPanel();
  p.land('cV', PROF_V);
  p.ctx._loadEstimateDefaultsV2();
  const upgBefore = p.log.upgRenders;
  p.reset(); // _bindCachesToSession: company-profile.js forgets the profile…
  p.ctx._forgetEstimatePanelPaint(true); // …and the panel its paint
  eq(p.byId('jurRows').getAttribute('data-jur-wait'), 'loading', 'jurisdictions back on the loading line');
  eq(p.byId('jurRows').rows, 0, 'the previous company\'s rows on screen');
  eq(p.val('permHamOh'), '100', 'permit shows this device\'s value, not the previous company\'s');
  eq(p.val('v2addonSteep'), '25', 'add-on rate shows the config default, not the previous company\'s');
  eq(p.log.upgRenders, upgBefore + 1, 'upgrade panel repainted (to its loading line)');
  eq(p.flag('_countyInputsResolved'), false, '_countyInputsResolved');
  if (p.log.ensure < 1) throw new Error('the new account\'s profile was not asked for');
  p.land('cB', PROF_X);
  await flushTimers();
  eq(p.byId('jurRows').hasAttribute('data-jur-wait'), false, 'loading state cleared');
  eq(p.byId('jurRows').rows, 2, 'the new company\'s rows');
  eq(p.val('permHamOh'), '404', 'the new company\'s permit');
  eq(p.flag('_jurRowsKey'), 'cB', 'rows painted for');
  eq(p.log.toasts.length, 0, 'toasts (nothing typed was replaced)');
});
atest('control: a panel never painted, or a sign-out, repaints nothing', async () => {
  const p = loadPanel();
  p.ctx._forgetEstimatePanelPaint(true);
  eq(p.byId('jurRows').hasAttribute('data-jur-wait'), false, 'never painted: no loading line');
  eq(p.log.ensure, 0, 'never painted: no read asked for');
  const q = loadPanel();
  q.land('cV', PROF_V);
  q.ctx._loadEstimateDefaultsV2();
  q.reset();
  q.ctx._forgetEstimatePanelPaint(false); // signed out: the page is leaving
  eq(q.val('permHamOh'), '303', 'nothing repainted on a sign-out');
  eq(q.flag('_jurRowsResolved'), false, 'but the paint is forgotten');
  eq(q.flag('_jurRowsKey'), null, 'rows painted for');
});

// _saveEstimateDefaultsV2, real code in a vm. `_collectJurisdictionRows`
// returns {} — what the loading line collects to — so a gate that let it
// through would full-replace the company's list with nothing.
function loadSave(state) {
  if (BOOT.indexOf('  let _v2SaveMsgTimer = null;') < 0) throw new Error('the Save All message timer is gone');
  const fnStart = BOOT.indexOf('window._saveEstimateDefaultsV2 = async function() {');
  const end = BOOT.indexOf('\n  };', fnStart);
  if (fnStart < 0 || end < 0) throw new Error('_saveEstimateDefaultsV2 not found');
  const raw = BOOT.slice(fnStart, end + 5);
  const src = raw.replace(FS_IMPORT_RE, '__fsImport()');
  if (src === raw) throw new Error('harness: no firestore import was rerouted');
  const log = { company: [], replace: [], userSettings: 0, collected: 0, repaint: 0, kick: 0, toasts: [], fades: 0, resets: 0, timers: [], marked: 0 };
  const msg = { style: {}, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const win = {
    _companyProfileLoaded: state.loaded,
    _companyProfile: { pricing: { customJurisdictions: { 'custom-a': { name: 'A', cost: 5, rate: 0.01 } } } },
    _db: { name: 'db' }, _user: { uid: 'u1' },
    _resolveCompanyKey: async () => 'c1',
    _saveCompanyProfile: async (o) => {
      log.company.push(JSON.parse(JSON.stringify(o)));
      // companyHangs: offline — the merge write is queued, never acked.
      if (state.companyHangs) await new Promise(() => {});
      // switchDuringWrite: another account signs in while the write is out.
      if (state.switchDuringWrite) state.loadedKey = 'cOther';
    },
  };
  // state.loadedKey: which tenant's server copy company-profile.js says is in
  // memory (absent: the older file without _companyProfileLoadedKey).
  if ('loadedKey' in state) {
    win._companyProfileLoadedKey = () => (win._companyProfileLoaded === true ? state.loadedKey : null);
    win._resetCompanyProfile = () => { log.resets++; win._companyProfileLoaded = false; };
  }
  // state.upgChanges: upgrade-price edits made in that panel since its paint.
  if (state.upgChanges) {
    win.NBDUpgradePriceSettings = { collect: () => ({ map: {}, changes: state.upgChanges, errors: [] }), markSaved() { log.marked++; } };
  }
  // Which tenant the panel's company half was painted for (second review of
  // #1774): by default the one loaded now — the panel painted from it.
  const paintKey = (k) => JSON.stringify(k !== undefined ? k : (state.loadedKey !== undefined ? state.loadedKey : null));
  const slice = (head) => {
    const s = BOOT.indexOf(head);
    const e = BOOT.indexOf('\n  }', s);
    if (s < 0 || e < 0) throw new Error('not found: ' + head.trim());
    return BOOT.slice(s, e + 4);
  };
  const ctx = vm.createContext({
    window: win, console: { warn() {}, log() {} },
    document: { getElementById: (id) => (id === 'v2save-msg' ? msg : null) },
    _v2ReadSettings: () => ({}), _v2WriteSettings: () => {},
    _collectJurisdictionRows: () => { log.collected++; return {}; },
    _loadEstimateDefaultsV2: () => { log.repaint++; },
    _renderJurisdictionRows: () => { log.kick++; },
    _pricingDenied: () => false,
    showToast: (m, k) => log.toasts.push({ m: String(m), k }),
    // The 5s fade is the one the tests count; any other timer (the "still
    // sending" notice) is kept for a test to fire.
    setTimeout: (fn, ms) => { if (ms === 5000) log.fades++; else log.timers.push({ fn, ms }); return 1; }, clearTimeout: () => {},
    __fsImport: async () => ({
      doc: (...a) => a.slice(1).join('/'),
      // userSettingsHangs: offline — the write is queued, never acked.
      setDoc: () => { log.userSettings++; return state.userSettingsHangs ? new Promise(() => {}) : Promise.resolve(); },
      updateDoc: async (ref, data) => { log.replace.push({ ref, keys: Object.keys(data).sort() }); },
    }),
  });
  vm.runInContext('var _countyInputsResolved = ' + !!state.county + '; var _jurRowsResolved = ' + !!state.jur + '; var _v2SaveMsgTimer = null;'
    + ' var _countyInputsKey = ' + paintKey(state.countyKey) + '; var _jurRowsKey = ' + paintKey(state.jurKey) + ';', ctx);
  vm.runInContext(slice('  function _loadedProfileKey() {') + '\n' + slice('  function _showCompanyWritePending() {'), ctx);
  vm.runInContext(src, ctx);
  return { save: () => win._saveEstimateDefaultsV2(), log, msg, win };
}

asection('\nProfile boot retry: Save All never publishes an unhydrated panel, and says so');
atest('boot read gave up, tab painted unhydrated: NO company write at all, a warning that stays, and a fresh ask', async () => {
  const s = loadSave({ loaded: false, county: false, jur: false });
  await s.save();
  eq(s.log.replace.length, 0, 'full-replace (updateDoc) writes');
  eq(s.log.company.length, 0, 'company-profile merge writes');
  eq(s.log.collected, 0, 'jurisdiction rows collected');
  eq(s.log.userSettings, 1, 'the per-user settings write still happens');
  eq(s.win._companyProfileLoaded, false, 'the save never touches the flag');
  eq(s.msg.attrs['data-kind'], 'warn', 'message kind');
  if (!/NOT saved for your company/.test(s.msg.textContent) || !/have not loaded/.test(s.msg.textContent)) throw new Error('message: ' + s.msg.textContent);
  eq(s.log.fades, 0, 'fade timers on a warning');
  eq(s.log.toasts.length, 1, 'toasts');
  eq(s.log.toasts[0].k, 'info', 'toast kind');
  if (/✓/.test(s.log.toasts[0].m)) throw new Error('toast still claims success: ' + s.log.toasts[0].m);
  eq(s.log.kick, 1, 'asks for the profile again');
  eq(s.log.repaint, 0, 'repaints');
});
atest('profile landed after the tab painted: still no company write; the tab repaints with company values', async () => {
  const s = loadSave({ loaded: true, county: false, jur: false });
  await s.save();
  eq(s.log.replace.length, 0, 'full-replace (updateDoc) writes');
  eq(s.log.company.length, 0, 'company-profile merge writes');
  eq(s.log.collected, 0, 'jurisdiction rows collected');
  eq(s.log.repaint, 1, 'repaints');
  eq(s.msg.attrs['data-kind'], 'warn', 'message kind');
  if (!/now shows the company's saved values/.test(s.msg.textContent)) throw new Error('message: ' + s.msg.textContent);
});
atest('control: a panel painted from the hydrated profile DOES publish (the gate is not just shut)', async () => {
  const s = loadSave({ loaded: true, county: true, jur: true });
  await s.save();
  eq(s.log.collected, 1, 'jurisdiction rows collected');
  eq(s.log.replace.length, 1, 'full-replace writes');
  eq(s.log.replace[0].keys.join(','), 'pricing.countyTax,pricing.customJurisdictions,pricing.permits', 'replaced paths');
  eq(s.log.company.length, 1, 'company-profile merge writes');
  eq(Object.keys(s.log.company[0].pricing).sort().join(','), 'addonPrices,countyTax,customJurisdictions,fallbackTaxRate,permits,tierRates', 'merged pricing keys');
  eq(s.msg.attrs['data-kind'], 'ok', 'message kind');
  eq(s.log.fades, 1, 'a clean save fades');
  eq(s.log.toasts[0].k, 'success', 'toast kind');
});
atest('the profile in memory is ANOTHER tenant\'s (account switched in this tab): no company write at all, it is forgotten, and asked for again', async () => {
  // Painted, resolved and "loaded" — but for cA, while this save resolves c1.
  const UPG = { fascia_wrap: { cents: 975, enabled: true } };
  const s = loadSave({ loaded: true, county: true, jur: true, loadedKey: 'cA', upgChanges: UPG });
  await s.save();
  eq(s.log.replace.length, 0, 'full-replace (updateDoc) writes');
  eq(s.log.company.length, 0, 'company-profile merge writes (add-on, county, upgrade prices)');
  eq(s.log.collected, 0, 'jurisdiction rows collected');
  eq(s.log.resets, 1, 'the other tenant\'s profile is forgotten');
  eq(s.log.kick, 1, 'this tenant\'s profile is asked for');
  eq(s.log.repaint, 0, 'no repaint from the other tenant\'s profile');
  eq(s.msg.attrs['data-kind'], 'warn', 'message kind');
  if (!/NOT saved for your company/.test(s.msg.textContent)) throw new Error('message: ' + s.msg.textContent);
  if (!/upgrade price changes were not saved/.test(s.msg.textContent)) throw new Error('the held-back upgrade edits are not mentioned: ' + s.msg.textContent);
  eq(s.log.userSettings, 1, 'this device\'s own settings are still saved');
});
atest('control: loaded for THIS tenant, the same save publishes, upgrade edits included', async () => {
  const UPG = { fascia_wrap: { cents: 975, enabled: true } };
  const s = loadSave({ loaded: true, county: true, jur: true, loadedKey: 'c1', upgChanges: UPG });
  await s.save();
  eq(s.log.replace.length, 1, 'full-replace writes');
  eq(s.log.replace[0].ref, 'companyProfile/c1', 'the full-replace lands on this tenant');
  eq(s.log.company.length, 1, 'company-profile merge writes');
  eq(JSON.stringify(s.log.company[0].pricing.upgradePrices), JSON.stringify(UPG), 'upgrade edits in the write');
  eq(s.log.resets, 0, 'nothing forgotten');
  eq(s.msg.attrs['data-kind'], 'ok', 'message kind');
});
atest('the panel was painted for ANOTHER tenant than the one loaded and written: nothing company-wide goes out, and the tab repaints', async () => {
  // Second review of #1774 (reproduced on the rig): the same account's
  // company changed under the tab, a re-read loaded the new company (c1), and
  // the panel still showed the old one's (cV) rows and rates. The loaded key
  // matched the write — so Save All published cV's rows onto c1 as a full
  // replace, under a "✓ saved".
  const s = loadSave({ loaded: true, county: true, jur: true, loadedKey: 'c1', countyKey: 'cV', jurKey: 'cV' });
  await s.save();
  eq(s.log.replace.length, 0, 'full-replace (updateDoc) writes');
  eq(s.log.company.length, 0, 'company-profile merge writes');
  eq(s.log.collected, 0, 'jurisdiction rows collected');
  eq(s.log.repaint, 1, 'repaints (from this tenant\'s loaded profile)');
  eq(s.log.resets, 0, 'the loaded profile IS this tenant\'s: nothing to forget');
  eq(s.msg.attrs['data-kind'], 'warn', 'message kind');
  if (!/NOT saved for your company/.test(s.msg.textContent)) throw new Error('message: ' + s.msg.textContent);
  eq(s.log.userSettings, 1, 'this device\'s own settings are still saved');
});
atest('each half is checked on its own: rows painted for this tenant publish, county inputs painted for another do not', async () => {
  const s = loadSave({ loaded: true, county: true, jur: true, loadedKey: 'c1', countyKey: 'cV', jurKey: 'c1' });
  await s.save();
  eq(s.log.replace.length, 1, 'full-replace writes');
  eq(s.log.replace[0].keys.join(','), 'pricing.customJurisdictions', 'replaced paths (no county maps)');
  eq(Object.keys(s.log.company[0].pricing).sort().join(','), 'customJurisdictions', 'merged pricing keys (no add-on or county rates)');
  eq(s.msg.attrs['data-kind'], 'warn', 'message kind');
});
atest('offline with the profile loaded: the rep is told the company rates are still sending, not left with nothing', async () => {
  // Second review of #1774: the loaded path awaited the company merge write,
  // which settles only on the server's ack — no message at all until reconnect.
  const s = loadSave({ loaded: true, county: true, jur: true, loadedKey: 'c1', companyHangs: true });
  s.save(); // never settles while offline
  await flushTimers();
  eq(s.log.company.length, 1, 'the company write was issued');
  const pending = s.log.timers.filter((t) => t.ms === 2500);
  eq(pending.length, 1, '"still sending" timers');
  eq(s.msg.style.display, undefined, 'nothing shown before the notice is due');
  pending[0].fn();
  eq(s.msg.style.display, 'block', 'the message is shown');
  eq(s.msg.attrs['data-kind'], 'pending', 'message kind');
  if (!/Still sending/.test(s.msg.textContent) || !/Saved on this device/.test(s.msg.textContent)) throw new Error('message: ' + s.msg.textContent);
});
atest('a write that lands after another account signed in reconciles nothing into that account\'s profile or upgrade baseline', async () => {
  const UPG = { fascia_wrap: { cents: 975, enabled: true } };
  const s = loadSave({ loaded: true, county: true, jur: true, loadedKey: 'c1', upgChanges: UPG, switchDuringWrite: true });
  await s.save();
  eq(s.log.replace.length, 1, 'the full-replace still went to the tenant it was for');
  eq(s.log.replace[0].ref, 'companyProfile/c1', 'full-replace target');
  eq(Object.keys(s.win._companyProfile.pricing.customJurisdictions).join(','), 'custom-a', 'the in-memory profile after the switch');
  eq(s.log.marked, 0, 'upgrade baseline updates');
  // Control: no switch — the saved rows and upgrade entries are reconciled.
  const c = loadSave({ loaded: true, county: true, jur: true, loadedKey: 'c1', upgChanges: UPG });
  await c.save();
  eq(Object.keys(c.win._companyProfile.pricing.customJurisdictions).join(','), '', 'control: the in-memory profile takes the saved rows');
  eq(c.log.marked, 1, 'control: upgrade baseline updates');
});

// _resetEstimateDefaultsV2, real code in a vm.
function loadReset(state) {
  const i = BOOT.indexOf('const _resetEstimateDefaultsV2 = async function() {');
  const end = BOOT.indexOf('\n  };', i);
  if (i < 0 || end < 0) throw new Error('_resetEstimateDefaultsV2 not found');
  const raw = BOOT.slice(i, end + 5);
  const src = raw.replace(FS_IMPORT_RE, '__fsImport()');
  if (src === raw) throw new Error('harness: no firestore import was rerouted');
  const log = { replace: [], resets: 0, loads: 0, toasts: [] };
  const win = {
    nbdConfirm: () => Promise.resolve(true),
    EstimateBuilderV2: { getDefaultSettings: () => ({}), saveSettings() {} },
    _companyProfileLoaded: true,
    _companyProfile: { pricing: { permits: { 'hamilton-oh': { cost: 303 } }, countyTax: { 'hamilton-oh': 0.073 } } },
    _db: { name: 'db' }, _user: { uid: 'u1' },
    _resolveCompanyKey: async () => state.companyKey,
    _companyProfileLoadedKey: () => (win._companyProfileLoaded === true ? state.loadedKey : null),
    _resetCompanyProfile: () => { log.resets++; win._companyProfileLoaded = false; },
  };
  const ctx = vm.createContext({
    window: win, console: { warn() {}, log() {} },
    _loadEstimateDefaultsV2: () => { log.loads++; },
    showToast: (m, k) => log.toasts.push({ m: String(m), k }),
    _pricingDenied: () => false,
    __fsImport: async () => ({
      doc: (...a) => a.slice(1).join('/'),
      updateDoc: async (ref, data) => {
        log.replace.push({ ref, keys: Object.keys(data).sort() });
        if (state.switchDuringWrite) state.loadedKey = 'cOther';
      },
    }),
  });
  vm.runInContext(src + '\nwindow.__reset = _resetEstimateDefaultsV2;', ctx);
  return { reset: () => win.__reset(), log, win };
}
const hamPermit = (win) => { const p = win._companyProfile.pricing.permits['hamilton-oh']; return p ? p.cost : null; };
atest('Reset to Defaults: loaded for another tenant than it would clear — it clears nothing company-wide, forgets that copy, and says so', async () => {
  // Second review of #1774 (reproduced on the rig): gated on the flag only,
  // it cleared the NEW company's county rates, then wrote {} into the OLD
  // company's in-memory copy under a flag still naming it.
  const r = loadReset({ loadedKey: 'cV', companyKey: 'cX' });
  await r.reset();
  eq(r.log.replace.length, 0, 'company-wide county wipes');
  eq(r.log.resets, 1, 'the other tenant\'s copy is forgotten');
  eq(hamPermit(r.win), 303, 'the other tenant\'s in-memory permit is not written');
  eq(r.log.loads, 1, 'the panel repaints (and so asks for this tenant\'s profile)');
  eq(r.log.toasts[0].k, 'info', 'toast kind');
  if (!/NOT reset/.test(r.log.toasts[0].m)) throw new Error('toast: ' + r.log.toasts[0].m);
});
atest('control: Reset to Defaults loaded for the tenant it clears does clear it', async () => {
  const r = loadReset({ loadedKey: 'cX', companyKey: 'cX' });
  await r.reset();
  eq(r.log.replace.length, 1, 'company-wide county wipes');
  eq(r.log.replace[0].ref, 'companyProfile/cX', 'wipe target');
  eq(r.log.replace[0].keys.join(','), 'pricing.countyTax,pricing.fallbackTaxRate,pricing.permits,pricing.tierRates', 'wiped paths');
  eq(hamPermit(r.win), null, 'this tenant\'s in-memory permits are cleared');
  eq(r.log.resets, 0, 'nothing forgotten');
  eq(r.log.toasts[0].k, 'success', 'toast kind');
});
atest('Reset to Defaults: a wipe that lands after another account signed in clears nothing in that account\'s memory', async () => {
  const r = loadReset({ loadedKey: 'cX', companyKey: 'cX', switchDuringWrite: true });
  await r.reset();
  eq(r.log.replace.length, 1, 'the wipe went to the tenant it was for');
  eq(hamPermit(r.win), 303, 'the in-memory profile after the switch');
});
atest('offline: the warning shows at once, not when the per-user settings write is finally acked', async () => {
  // PR #1774 review: Save All awaited that setDoc, which settles only on the
  // server's ack, so with no signal the rep saw nothing at all until the
  // connection came back.
  const s = loadSave({ loaded: false, county: false, jur: false, userSettingsHangs: true });
  await within(s.save(), 1000, 'Save All with the per-user write unacked');
  eq(s.log.userSettings, 1, 'the per-user settings write was still issued');
  eq(s.msg.attrs['data-kind'], 'warn', 'message kind');
  eq(s.msg.style.display, 'block', 'the message is shown');
});

// The dashboard's account-change hook, real code in a vm: _bindCachesToSession
// and the panel's _forgetEstimatePanelPaint.
function loadSessionBinder() {
  const slice = (head) => {
    const s = BOOT.indexOf(head);
    const e = BOOT.indexOf('\n  }', s);
    if (s < 0 || e < 0) throw new Error('not found: ' + head.trim());
    return BOOT.slice(s, e + 4);
  };
  const log = { resets: 0, leads: 0, analytics: 0, repaints: 0 };
  const win = { _resetCompanyProfile: () => { log.resets++; } };
  const ctx = vm.createContext({
    window: win, _clearAnalyticsCardCaches: () => { log.analytics++; }, _resetLeadsCache: () => { log.leads++; },
    // The panel's company half (loadPanel runs the real one).
    _paintCompanyEstimateInputs: () => { log.repaints++; },
  });
  vm.runInContext('var _sessionUid; var _jurRowsResolved = true; var _countyInputsResolved = true;'
    + ' var _jurRowsKey = "cA"; var _countyInputsKey = "cA"; var _companyInputIds = ["defTaxRate"];', ctx);
  vm.runInContext(slice('  function _bindCachesToSession(uid) {') + '\n' + slice('  function _forgetEstimatePanelPaint(repaint) {'), ctx);
  return { bind: (uid) => ctx._bindCachesToSession(uid), log, flag: (n) => vm.runInContext(n, ctx) };
}
atest('an account change in the tab forgets the company profile and the Estimates panel\'s paint', async () => {
  const b = loadSessionBinder();
  b.bind('uA'); // the page's first auth tick
  b.bind('uA'); // a token refresh
  eq(b.log.resets, 0, 'profile resets without an account change');
  eq(b.flag('_jurRowsResolved'), true, '_jurRowsResolved without an account change');
  b.bind('uB'); // login.js signed in over the session in another tab
  eq(b.log.resets, 1, 'profile resets on the switch');
  eq(b.log.leads, 1, 'the leads cache is reset too (unchanged)');
  eq(b.flag('_jurRowsResolved'), false, '_jurRowsResolved after the switch');
  eq(b.flag('_countyInputsResolved'), false, '_countyInputsResolved after the switch');
  eq(b.flag('_jurRowsKey'), null, 'rows painted for, after the switch');
  eq(b.flag('_countyInputsKey'), null, 'county inputs painted for, after the switch');
  // Second review of #1774: the painted panel goes back to its loading
  // state for the new account (the real repaint is pinned by loadPanel above).
  eq(b.log.repaints, 1, 'panel repaints on the switch');
  b.bind(null); // a sign-out: the page leaves for the login screen
  eq(b.log.resets, 2, 'profile resets on the sign-out');
  eq(b.log.repaints, 1, 'panel repaints on the sign-out');
});

// A promise that never settles (e.g. a retry run that is never woken) empties
// the event loop and Node would exit 0 mid-list, with the summary unprinted:
// that is a failure, never a pass.
let asyncDone = false;
process.on('beforeExit', () => {
  if (asyncDone) return;
  console.log('  ✗ an async test never settled (a promise hung) — failing the suite');
  process.exit(1);
});
(async () => {
  for (const [name, fn] of pendingAsync) {
    if (!fn) { console.log(name); continue; }
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; fails.push(name); }
  }
  asyncDone = true;
  console.log('\n──────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
