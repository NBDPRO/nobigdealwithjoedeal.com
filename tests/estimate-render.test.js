/**
 * tests/estimate-render.test.js — full estimate-output render integration test.
 *
 * Loads docs/pro/js/estimate-finalization.js into a vm (with a window stub +
 * window._brand()) and renders the three customer-facing estimate exports —
 * Insurance Scope, Retail Quote, Internal View — for NBD and for a tenant
 * (Oaks). Asserts the active tenant's brand actually lands in the output HTML.
 * This is the render-verify that proves estimate-finalization.js is tenant-aware
 * the same way docgen-render.test.js proves it for the doc generator.
 *
 * Contract (mirrors brand-sweep-2026-06-07 + docgen-render):
 *   - NBD shows 'No Big Deal' + orange #BD5728.
 *   - Oaks shows 'Oaks Roofing & Construction' + accent #C2410C, uses its
 *     docPrefix (OAK-) on the estimate number, its seal (ORC) on signatures,
 *     and does NOT leak 'No Big Deal' / '#BD5728' / 'Joe Deal' / 'Joe's'.
 * An Oaks failure is a real tenant-brand leak — an export hardcoding an NBD
 * literal instead of resolving it from window._brand().
 *
 * NBD byte-identical is enforced separately (HEAD-vs-worktree diff at build
 * time); here we additionally assert NBD's exact literals are still present.
 *
 * Run: node tests/estimate-render.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/estimate-finalization.js'), 'utf8');

// Load estimate-finalization.js into a fresh vm with window._brand() returning
// `brand` (or omit the resolver entirely when brand === undefined → NBD path).
function loadFin(brand) {
  const win = {};
  win.window = win;
  if (brand !== undefined) win._brand = () => brand;
  const sandbox = {
    window: win,
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Set,
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'estimate-finalization.js' });
  return win.EstimateFinalization;
}

// Fixed date so fmtDate() is deterministic. Estimate number is pinned so the
// Date.now() fallback never fires (it is the only source of non-determinism).
const FIXED = new Date('2026-06-07T12:00:00Z');

function fixture() {
  return {
    estimate: {
      total: 18500, subtotal: 17000, materialRetail: 9000, laborCost: 6000,
      materialCost: 7000, hardCost: 15000, overhead: 1000, profit: 1000,
      overheadPct: 0.10, profitPct: 0.10, taxRate: 0.0675, tax: 1147,
      tier: 'best', mode: 'retail', minJobApplied: false, deposit: 9250,
      internal: { margin: 3500, marginPct: 18.9 },
      lines: [
        { code: 'RFG-01', name: 'Architectural Shingles', category: 'roofing', quantity: 32, unit: 'SQ',
          materialCostPerUnit: 120, laborCostPerUnit: 80, lineTotal: 6400,
          reason: 'Full replacement required', codeRefs: { oh: '1507.2', irc: 'R905' },
          requiresPhoto: true, matSource: 'catalog', labSource: 'crew-rate' },
        { code: 'LBR-01', name: 'Tear-off & Disposal', category: 'labor', quantity: 32, unit: 'SQ',
          materialCostPerUnit: 0, laborCostPerUnit: 45, lineTotal: 1440, codeRefs: {} },
        { code: 'WAR-01', name: 'System Warranty Registration', category: 'warranty', quantity: 1, unit: 'EA',
          materialCostPerUnit: 0, laborCostPerUnit: 0, lineTotal: 0, codeRefs: {} }
      ]
    },
    meta: {
      customer: { name: 'Jane Homeowner', address: '123 Main St, Goshen OH', phone: '513-555-0100', email: 'jane@example.com' },
      claim: { carrier: 'State Farm', number: 'CLM-99', adjuster: 'Bob A.', dateOfLoss: '2026-04-01',
               deductible: 1000, acv: 14000, recoverableDepreciation: 4500 },
      estimate: { date: FIXED, number: null, preparedBy: null, revision: 'A', inspectionDate: FIXED },
      tiers: { good: { total: 15000 }, better: { total: 16500 }, best: { total: 18500 } }
    }
  };
}

// Render one export for a brand. Wrapped so a render throwing in the vm
// surfaces as a readable assertion failure rather than crashing the run.
function renderFmt(brand, fmt) {
  const fin = loadFin(brand);
  try {
    const f = fixture();
    const res = fin.formatEstimate(f.estimate, fmt, f.meta);
    return (res && res.html) || 'RENDER_ERROR: no html';
  } catch (e) {
    return 'RENDER_ERROR: ' + (e && e.message);
  }
}

const NBD_BRAND = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
const OAKS_BRAND = {
  legalName: 'Oaks Roofing & Construction',
  displayName: 'Oaks Roofing & Construction',
  seal: 'ORC',
  docPrefix: 'OAK',
  tagline: 'Roofing, Siding, Gutters',
  logoUrl: 'https://nobigdealwithjoedeal.com/sites/oaks/logo-orange.svg',
  colors: { primary: '#333333', secondary: '#1A1A1A', accent: '#C2410C', ink: '#222222' },
  contact: { phone: '(513) 827-5297', email: 'joe@oaksrfc.com', website: 'oaksroofingandconstruction.com', address: 'Goshen, OH' }
};

// The three customer-facing estimate exports. `nbdName` is the exact NBD name
// literal each export must keep; every export themes the orange accent and
// carries the doc-number prefix + signature seal.
const FORMATS = [
  { label: 'insurance-scope', fmt: 'insurance-scope' },
  { label: 'retail-quote',    fmt: 'retail-quote' },
  { label: 'single-quote',    fmt: 'single-quote' },
  { label: 'internal-view',   fmt: 'internal-view' },
];

for (const t of FORMATS) {
  console.log('\nESTIMATE RENDER — ' + t.label + ' (full render, both tenants)');

  // ── NBD: exact orange + the NBD name present, byte-identical literals ──
  const n = renderFmt(NBD_BRAND, t.fmt);
  const nOk = typeof n === 'string' && n.indexOf('RENDER_ERROR') !== 0 && n.length > 500;
  ok(t.label + ' / NBD: renders HTML (no error)', nOk);
  ok(t.label + ' / NBD: shows "No Big Deal"', /No Big Deal/.test(n));
  ok(t.label + ' / NBD: orange #BD5728 accent present', /#BD5728/i.test(n));

  // ── Oaks: tenant name + accent present; NBD identity fully absent ──
  const o = renderFmt(OAKS_BRAND, t.fmt);
  const oOk = typeof o === 'string' && o.indexOf('RENDER_ERROR') !== 0 && o.length > 500;
  ok(t.label + ' / Oaks: renders HTML (no error)', oOk);
  // Name is HTML-escaped on output ('&' → '&amp;'), which is correct/safe —
  // a browser renders it as "Oaks Roofing & Construction". Match either form.
  ok(t.label + ' / Oaks: shows "Oaks Roofing & Construction"', /Oaks Roofing &(amp;)? Construction/.test(o));
  ok(t.label + ' / Oaks: burnt-orange #C2410C (tenant accent)', /#c2410c/i.test(o));
  ok(t.label + ' / Oaks: does NOT leak orange #BD5728', !/#BD5728/i.test(o));
  ok(t.label + ' / Oaks: does NOT leak "No Big Deal"', !/No Big Deal/.test(o));
  ok(t.label + ' / Oaks: does NOT leak "Joe Deal"', !/Joe Deal/.test(o));
  ok(t.label + ' / Oaks: does NOT leak "Joe\'s"', !/Joe's/.test(o));
}

// ════════════════════════════════════════════════════════════════════
// Per-export specifics — doc-number prefix (docPrefix) and signature seal.
// The estimate number on these two exports falls back to `<prefix>-<ts>`
// only when meta.estimate.number is null; the fixture leaves it null so the
// prefix is observable. Oaks must use OAK- and its seal ORC, NBD keeps NBD-.
// (internal-view has no estimate number, so it is covered by the leak checks
//  above only.)
// ════════════════════════════════════════════════════════════════════
console.log('\nESTIMATE RENDER — doc-number prefix + signature seal');

const insNbd  = renderFmt(NBD_BRAND, 'insurance-scope');
const insOak  = renderFmt(OAKS_BRAND, 'insurance-scope');
ok('insurance-scope / NBD: estimate # uses NBD- prefix', /Estimate #NBD-/.test(insNbd));
ok('insurance-scope / Oaks: estimate # uses OAK- prefix (docPrefix)', /Estimate #OAK-/.test(insOak));
ok('insurance-scope / NBD: "Prepared By" shows Joe Deal — NBD', /Joe Deal — NBD/.test(insNbd));
ok('insurance-scope / Oaks: "Prepared By" shows ORC seal', /class="v">ORC</.test(insOak));

const retNbd  = renderFmt(NBD_BRAND, 'retail-quote');
const retOak  = renderFmt(OAKS_BRAND, 'retail-quote');
ok('retail-quote / NBD: estimate # uses NBD- prefix', /Estimate #NBD-/.test(retNbd));
ok('retail-quote / Oaks: estimate # uses OAK- prefix (docPrefix)', /Estimate #OAK-/.test(retOak));
// GBB audit 2026-09-09 (documentation/audit/GBB-TIER-SOURCE-OF-TRUTH-2026-09-09.md
// §3/§8 PR3): was "10-year" — contradicted the tier cards above it on the same
// document, one of 8 independent warranty-duration schemes found live at once.
// Jo, 2026-10-06 (final): NBD prints the NBD Pledge (a promise) + the written
// labor warranty by package (1 to 20 years) — never "lifetime". Another
// company never gets NBD's terms: its written agreement governs.
ok('retail-quote / NBD: the NBD Pledge + written labor warranty by package, no "lifetime"',
  /NBD Pledge:<\/strong> for as long as you own the home, we'll come back and make it right/.test(retNbd) && /Written labor warranty by package — 1 to 20 years/.test(retNbd) && !/lifetime/i.test(retNbd));
ok('retail-quote / Oaks: no NBD Pledge, no "lifetime" labor warranty', !/Pledge|lifetime/i.test(retOak) && /Workmanship warranty terms as stated in your written agreement/.test(retOak));

// single-quote = retail quote WITHOUT the Good/Better/Best cards. The fixture's
// meta.tiers has a Better card at $16,500; retail-quote renders it, single-quote
// strips it (only the one "Your Investment" headline = estimate.total $18,500).
const sglNbd = renderFmt(NBD_BRAND, 'single-quote');
ok('retail-quote SHOWS the Better-tier card ($16,500)', /16,?500/.test(retNbd));
ok('single-quote OMITS the tier cards (no $16,500 Better card)', !/16,?500/.test(sglNbd));
ok('single-quote keeps the single "Your Investment" headline', /Your Investment/.test(sglNbd));
ok('single-quote estimate # uses NBD- prefix', /Estimate #NBD-/.test(sglNbd));

const intNbd  = renderFmt(NBD_BRAND, 'internal-view');
const intOak  = renderFmt(OAKS_BRAND, 'internal-view');
ok('internal-view / NBD: banner shows "Joe\'s Eyes Only"', /Joe's Eyes Only/.test(intNbd));
ok('internal-view / Oaks: banner shows "Internal Use Only" (no Joe)', /Internal Use Only/.test(intOak) && !/Joe's Eyes Only/.test(intOak));

// ════════════════════════════════════════════════════════════════════
// Never-drop-a-line (2e): a line whose category isn't in CAT_ORDER (custom
// or future-catalog) must still render — both the Xactimate scope table and
// the retail-quote bullet list — so the visible scope always reconciles to the
// rolled-up total instead of silently dropping a billed line.
// ════════════════════════════════════════════════════════════════════
console.log('\nESTIMATE RENDER — never-drop off-CAT_ORDER line (2e)');
function fixtureWithCustomCat() {
  const f = fixture();
  f.estimate.lines.push({
    code: 'CUSTOM-1', name: 'Cricket Framing (custom)', category: 'structural',
    quantity: 1, unit: 'EA', materialCostPerUnit: 200, laborCostPerUnit: 300,
    lineTotal: 500, reason: 'Diverter cricket behind chimney', codeRefs: {}
  });
  return f;
}
function renderCustom(brand, fmt) {
  const fin = loadFin(brand);
  try {
    const f = fixtureWithCustomCat();
    const res = fin.formatEstimate(f.estimate, fmt, f.meta);
    return (res && res.html) || 'RENDER_ERROR: no html';
  } catch (e) { return 'RENDER_ERROR: ' + (e && e.message); }
}
const insCustom = renderCustom(NBD_BRAND, 'insurance-scope');
ok('insurance-scope: custom-category line still appears in scope table', /Cricket Framing \(custom\)/.test(insCustom));
ok('insurance-scope: off-list category gets a titleized section header (Structural)', /Structural/.test(insCustom));
const retCustom = renderCustom(NBD_BRAND, 'retail-quote');
ok('retail-quote: custom-category line still appears in bullet list', /Cricket Framing \(custom\)/.test(retCustom));
// Sanity: a normal estimate (all CAT_ORDER categories) is unchanged by the
// catch-all — no spurious "Other"/titleized section leaks in.
const insNormal = renderFmt(NBD_BRAND, 'insurance-scope');
ok('insurance-scope: normal estimate has no stray Structural section', !/Structural/.test(insNormal));

// ════════════════════════════════════════════════════════════════════
// B-8 (Jo-approved): line items priced at RETAIL so the scope reconciles.
// A consistent mini-estimate (markup 25%) — assert the visible line totals are
// retail, the category subtotals + grand "Line Item Total" reconcile, the O&P
// ladder lands on Subtotal, and the OLD cost-basis line total is gone.
//   Line A (roofing): 10 SQ × $100 mat + $50 lab → retail = 1000×1.25 + 500 = 1,750
//   Line B (labor):   10 SQ × $0 mat  + $45 lab → retail = 0 + 450 = 450
//   Line Item Total = 2,200 ; +Overhead 220 +Profit 220 = Subtotal 2,640
// ════════════════════════════════════════════════════════════════════
console.log('\nESTIMATE RENDER — line items at retail, scope reconciles (B-8)');
function reconFixture() {
  return {
    estimate: {
      materialMarkupPct: 0.25,
      materialCost: 1000, materialRetail: 1250, laborCost: 950,
      retailBeforeOHP: 2200, overhead: 220, profit: 220,
      overheadPct: 0.10, profitPct: 0.10, subtotal: 2640,
      taxRate: 0, tax: 0, total: 2650, tier: 'better', mode: 'retail',
      lines: [
        { code: 'A', name: 'Architectural Shingles', category: 'roofing', quantity: 10, unit: 'SQ',
          materialCostPerUnit: 100, laborCostPerUnit: 50, materialTotal: 1000, laborTotal: 500, lineTotal: 1500, codeRefs: {} },
        { code: 'B', name: 'Tear-off', category: 'labor', quantity: 10, unit: 'SQ',
          materialCostPerUnit: 0, laborCostPerUnit: 45, materialTotal: 0, laborTotal: 450, lineTotal: 450, codeRefs: {} }
      ]
    },
    meta: { customer: { name: 'Jane', address: '1 St' }, claim: {}, estimate: { date: FIXED, number: null } }
  };
}
function renderRecon() {
  const fin = loadFin(NBD_BRAND);
  try {
    const f = reconFixture();
    const res = fin.formatEstimate(f.estimate, 'insurance-scope', f.meta);
    return (res && res.html) || 'RENDER_ERROR: no html';
  } catch (e) { return 'RENDER_ERROR: ' + (e && e.message); }
}
const recon = renderRecon();
ok('B-8: line A shows RETAIL total $1,750.00 (not cost $1,500.00)', /1,750\.00/.test(recon));
ok('B-8: cost-basis line total $1,500.00 is gone', !/1,500\.00/.test(recon));
ok('B-8: grand "Line Item Total" row present', /Line Item Total/.test(recon));
ok('B-8: Line Item Total = $2,200.00 (= 1,750 + 450 category subtotals)', /2,200\.00/.test(recon));
ok('B-8: Overhead $220.00 + Profit $220.00 on the ladder', (recon.match(/220\.00/g) || []).length >= 2);
ok('B-8: Subtotal $2,640.00 = Line Item Total + O&P', /2,640\.00/.test(recon));
ok('B-8: RCV $2,650 present (fmtMoneyBig)', /\$2,650/.test(recon));
ok('B-8: stale "Material Cost"/"Labor Cost" aggregate rows removed', !/>Material Cost</.test(recon) && !/>Labor Cost</.test(recon));

// Pass-through line (e.g. $75 measurement report): carries only lineTotal/
// unitPrice + category 'Services', no material/labor basis. It must render at
// FACE ($75) — not $0 — and stay in the Line Item Total so the scope still sums
// to RCV. (Regression guard for the B-8 helper fallback.)
function reconWithPassThru() {
  const f = reconFixture();
  f.estimate.lines.push({
    code: 'SVC RPT', name: 'Aerial Measurement Report', quantity: 1, unit: 'ea',
    unitPrice: 75, lineTotal: 75, category: 'Services', source: 'passthru'
  });
  // getCurrentEstimate adds the face amount onto subtotal+total:
  f.estimate.subtotal = 2640 + 75;   // 2,715
  f.estimate.total = 2650 + 75;      // 2,725
  return f;
}
function renderReconPT() {
  const fin = loadFin(NBD_BRAND);
  try { const f = reconWithPassThru(); return (fin.formatEstimate(f.estimate, 'insurance-scope', f.meta).html) || ''; }
  catch (e) { return 'RENDER_ERROR: ' + (e && e.message); }
}
const reconPT = renderReconPT();
ok('B-8 passthru: $75 service line renders at FACE (not $0)', /75\.00/.test(reconPT));
ok('B-8 passthru: Services section present', /Services/.test(reconPT));
ok('B-8 passthru: Line Item Total = $2,275.00 (2,200 + 75)', /2,275\.00/.test(reconPT));
ok('B-8 passthru: Subtotal $2,715.00 = Line Item Total + O&P', /2,715\.00/.test(reconPT));

// Min-job floor: when RCV is raised to the shop minimum, show the adjustment so
// Subtotal → RCV stays an honest ladder (no unexplained jump).
function reconMinJob() {
  return {
    estimate: {
      materialMarkupPct: 0.25, materialCost: 80, materialRetail: 100, laborCost: 0,
      retailBeforeOHP: 100, overhead: 10, profit: 10, overheadPct: 0.10, profitPct: 0.10,
      subtotal: 120, taxRate: 0, tax: 0, total: 2500, minJobApplied: true, tier: 'better', mode: 'retail',
      lines: [{ code: 'A', name: 'Patch', category: 'roofing', quantity: 1, unit: 'SQ',
        materialCostPerUnit: 80, laborCostPerUnit: 0, materialTotal: 80, laborTotal: 0, lineTotal: 80, codeRefs: {} }]
    },
    meta: { customer: { name: 'Jane', address: '1 St' }, claim: {}, estimate: { date: FIXED, number: null } }
  };
}
const reconMin = (function () { const fin = loadFin(NBD_BRAND); const f = reconMinJob(); try { return fin.formatEstimate(f.estimate, 'insurance-scope', f.meta).html || ''; } catch (e) { return 'RENDER_ERROR: ' + e.message; } })();
ok('B-8 min-job: "Minimum Job Charge Adjustment" row present', /Minimum Job Charge Adjustment/.test(reconMin));
ok('B-8 min-job: adjustment $2,380.00 (2,500 − 120) shown', /2,380\.00/.test(reconMin));
ok('B-8 min-job: RCV $2,500', /\$2,500/.test(reconMin));
ok('B-8 normal: no spurious min-job row', !/Minimum Job Charge Adjustment/.test(recon));

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
