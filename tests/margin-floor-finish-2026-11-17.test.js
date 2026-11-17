/**
 * tests/margin-floor-finish-2026-11-17.test.js
 *
 * The last margin floor changes (Jo, 2026-11-17; plan:
 * documentation/projects/ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md):
 *   - fees charged at face (measurement report, e-sign fee, permit upcharge)
 *     count as cost: they are money passed through, like sales tax
 *   - a deal link checks EVERY package it offers, not only the chosen one,
 *     and asks once for any below the floor
 *   - fix: the deal link read its prices before the gate, so after "Use this
 *     price" it still carried the old, lower prices
 *
 * Runs the real engines in a vm. Costs are the published starter baseline.
 * Run: node tests/margin-floor-finish-2026-11-17.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  — ' + JSON.stringify(detail) : '')); }
}

function makeSandbox() {
  const byId = {};
  const el = (tag) => ({
    tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; }, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, remove() {},
  });
  const document = { head: el('head'), body: el('body'), createElement: el, getElementById: (id) => byId[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = { localStorage, document };
  win.window = win;
  const sandbox = { window: win, document, localStorage, navigator: { userAgent: 'node' }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' } };
  vm.createContext(sandbox);
  return { win, sandbox, store };
}
const FILES = [
  'docs/pro/js/estimate-config.js', 'docs/pro/js/ky-insurance-law.js', 'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js', 'docs/pro/js/roofivent-catalog.js', 'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js', 'docs/pro/js/estimate-catalog-xactimate.js', 'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js', 'docs/pro/js/job-templates.js', 'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/margin-floor.js', 'docs/pro/js/estimate-finalization.js', 'docs/pro/js/estimate-v2-ui.js',
];
function stack(o) {
  o = o || {};
  const env = makeSandbox();
  env.store.nbd_est_settings_v3 = JSON.stringify({ roundTo: 25 });
  env.win._companyProfile = o.floor ? { pricing: { marginFloor: { floorPct: o.floor, targetPct: o.floor + 5 } } } : undefined;
  env.win._userClaims = o.claims || {}; env.win._user = { uid: 'u1' };
  env.asked = []; env.toasts = [];
  env.answers = (o.answers || []).slice();
  env.win.nbdConfirm = async (m) => { env.asked.push(m); return env.answers.length ? env.answers.shift() : false; };
  env.win.nbdPrompt = async () => '';
  env.win.showToast = (m, k) => env.toasts.push([m, k]);
  FILES.forEach((f) => vm.runInContext(read(f), env.sandbox, { filename: path.basename(f) }));
  env.V2 = env.win.EstimateV2UI._test; env.MF = env.win.NBDMarginFloor;
  const st = env.V2.getState();
  st._reopenedClean = false; st._reopenedDoc = null;
  st.mode = o.mode || 'line-item'; st.jobMode = 'cash'; st.tier = o.tier || 'better'; st.county = '';
  st.measurements = Object.assign({}, st.measurements, { rawSqft: 2000, pitch: 6 });
  st.scope = ['RFG 240-GAF-HDZ', 'RFG SYN', 'LAB TO1'].map((code) => ({ code }));
  st.passThru = o.passThru || []; st.upgrades = []; st.minJobCharge = null;
  env.st = st;
  env.est = () => env.V2.effectiveEstimate();
  env.setFloor = (f) => { env.win._companyProfile = { pricing: { marginFloor: { floorPct: f, targetPct: f + 5 } } }; };
  return env;
}
const FEE = { code: 'SVC MEASURE-RPT', desc: 'Measurement report', amount: 75, source: 'passthru' };

(async () => {
  console.log('\nFees charged at face count as cost');
  {
    const none = stack(), fee = stack({ passThru: [FEE] });
    const e0 = none.est(), e1 = fee.est();
    ok('the estimate carries what it passes through, in dollars', e1.passThroughCost === 75 && (e0.passThroughCost || 0) === 0, [e0.passThroughCost, e1.passThroughCost]);
    const j0 = fee.MF.jobFromEstimate(e0), j1 = fee.MF.jobFromEstimate(e1);
    ok('the fee is in the price and in the cost, so the margin dollars do not move', j1.preTaxCents - j0.preTaxCents === 7500 && j1.costCents - j0.costCents === 7500, [j0, j1]);
    const m0 = fee.MF.marginOf(j0).pct, m1 = fee.MF.marginOf(j1).pct;
    ok('a fee at face lowers the margin percentage a little, as it should', m1 < m0, [m0, m1]);
    const saved = fee.V2.buildSavePayload(e1, fee.st);
    const replay = fee.V2.reconstructEstimateFromSaved(saved);
    ok('a reopened estimate counts the same fee from its saved rows', replay && replay.passThroughCost === 75, replay && replay.passThroughCost);
    ok('a saved shape with no fee field counts nothing extra', fee.MF.jobFromEstimate({ mode: 'cash', grandTotal: 1000, taxAmount: 0, hardCost: 600 }).costCents === 60000);
  }

  console.log('\nA deal link checks every package it offers');
  {
    // Per-square: the link offers every package. Find a floor the chosen package clears and a cheaper one does not.
    const probe = stack({ mode: 'per-sq', tier: 'best', floor: 1 });
    const views = probe.V2.offeredPackageViews(probe.est());
    const byTier = {}; views.forEach((p) => { byTier[p.tier] = p.view.marginPct; });
    const tiers = Object.keys(byTier);
    ok('every offered package is judged, the chosen one first', views.length >= 3 && views[0].tier === 'best' && tiers.indexOf('good') !== -1, byTier);
    const lowTier = tiers.filter((t) => t !== 'best').sort((a, b) => byTier[a] - byTier[b])[0];
    const floor = Math.round(((byTier.best + byTier[lowTier]) / 2) * 2) / 2;
    ok('a floor exists that the chosen package clears and another does not', byTier.best > floor && byTier[lowTier] < floor, [byTier, floor]);

    const rep = stack({ mode: 'per-sq', tier: 'best', floor, claims: { companyId: 'co', role: 'sales_rep' } });
    const single = await rep.V2.floorGate(rep.est());
    ok('the single-package check (send for signature) passes: the chosen package clears', single === true && rep.toasts.length === 0);
    const all = await rep.V2.floorGate(rep.est(), null, { allPackages: true });
    const msg = (rep.toasts[0] || [''])[0];
    ok('the deal link stops a rep and names the package under the floor', all === false && msg.toLowerCase().indexOf(lowTier) !== -1 && /under your company floor/.test(msg) && /save it as a draft/.test(msg), msg);

    const own = stack({ mode: 'per-sq', tier: 'best', floor, answers: [true] });
    const ro = await own.V2.floorGate(own.est(), null, { allPackages: true });
    const note = own.V2.floorConfirm();
    ok('the owner is asked once, and the note keeps the lowest margin and the packages', ro === true && own.asked.length === 1 && note && Math.abs(note.marginPct - Math.round(byTier[lowTier] * 10) / 10) < 0.051 && Array.isArray(note.packages) && note.packages.some((p) => p.tier === lowTier), note);
    const again = await own.V2.floorGate(own.est(), null, { allPackages: true });
    ok('asked once: the confirm stands for the same packages', again === true && own.asked.length === 1);
  }

  console.log('\nThe deal link carries the raised price');
  {
    const src = read('docs/pro/js/estimate-v2-ui.js');
    const fn = src.slice(src.indexOf('async function _prepareDealLink('));
    const gate = fn.indexOf('_floorGate(estimate, say, { allPackages: true })');
    const reread = fn.indexOf('prices = _dealPricesFor(estimate);', gate);
    const save = fn.indexOf('await save()');
    ok('it gates every package, then re-reads the estimate and its prices, then saves', gate !== -1 && reread > gate && save > reread, [gate, reread, save]);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
