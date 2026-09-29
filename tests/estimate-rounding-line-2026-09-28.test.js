/**
 * tests/estimate-rounding-line-2026-09-28.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Jo, 2026-09-28: "show the rounding line on proposals". The engine rounds
 * Subtotal + Tax to the nearest $25 (Math.round, so either way) and then
 * lifts it to the shop minimum. So a customer proposal printing
 * Subtotal / Tax / Total showed rows that didn't add up. It was off by as
 * much as $12.50 either way, or by the whole minimum-charge uplift. Only the
 * insurance scope explained a gap, and only when the minimum kicked in.
 *
 * Every customer surface that prints Subtotal + Tax + Total now prints the
 * difference as its own row:
 *   - the server-rendered Retail Quote PDF (estimate.hbs via
 *     estimate-v2-ui's payload builder);
 *   - the insurance scope (estimate-finalization formatInsuranceScope);
 *   - the Job Templates proposal preview (job-templates-ui).
 * The row reads "Rounding" (signed; a downward round prints "−$x") or, when
 * the minimum job charge lifted the total, "Minimum job charge adjustment".
 * If the rows already foot, no row is printed.
 *
 * Drives the real files: the vm-loaded client builders, and the real
 * Handlebars template with render-pdf's real helpers.
 * Run: node tests/estimate-rounding-line-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

// ── loaders (same shims as tests/estimate-v2-payload.test.js) ──
function loadV2() {
  const win = {}; win.window = win;
  win.EstimateLogic = { resolveEstimate: () => ({}), buildContext: (x) => x, MEASUREMENT_VARS: [] };
  win.EstimateBuilderV2 = { loadSettings: () => ({ countyTax: {} }), calculateAllTiers: () => ({}), calculatePerSq: () => ({}) };
  vm.runInNewContext(read('docs/pro/js/estimate-v2-ui.js'), {
    window: win, console: quiet,
    document: { createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), addEventListener() {}, getElementById: () => null, querySelector: () => null },
    Date, Math, JSON, Set, setTimeout, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
  }, { filename: 'estimate-v2-ui.js' });
  return win.EstimateV2UI._test;
}
function loadFin() {
  const win = {}; win.window = win;
  vm.runInNewContext(read('docs/pro/js/estimate-finalization.js'), { window: win, console: quiet, Date, Math, JSON, Set }, { filename: 'estimate-finalization.js' });
  return win.EstimateFinalization;
}
function loadJT() {
  const document = {
    getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    head: { appendChild() {} }, body: { appendChild() {} },
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const win = { localStorage, document }; win.window = win;
  const sb = { window: win, document, localStorage, navigator: { userAgent: 'node' }, console: quiet,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' } };
  vm.createContext(sb);
  vm.runInContext(read('docs/pro/js/job-templates-ui.js'), sb, { filename: 'job-templates-ui.js' });
  return win.JobTemplatesUI;
}

const T = loadV2();
const FIN = loadFin();
const JT = loadJT();

// Three shapes of the same ladder. Rounded to $25 (roundTo default):
//   down: 6,500.00 + 488.13 = 6,988.13 → 6,975  (−13.13)
//   up:   6,500.00 + 512.60 = 7,012.60 → 7,025  (+12.40)
//   min:  400 + 30.04 = 430.04 → 425 → lifted to 1,500 minimum (+1,069.96)
//   foot: 6,500 + 500 = 7,000 → 7,000 (no row)
const CASES = [
  { name: 'rounded down', subtotal: 6500, tax: 488.13, total: 6975, min: false, label: 'Rounding', text: '−$13.13' },
  { name: 'rounded up', subtotal: 6500, tax: 512.60, total: 7025, min: false, label: 'Rounding', text: '$12.40' },
  { name: 'minimum job charge', subtotal: 400, tax: 30.04, total: 1500, min: true, label: 'Minimum job charge adjustment', text: '$1,069.96' },
  { name: 'already foots', subtotal: 6500, tax: 500, total: 7000, min: false, label: null },
];
const lines = [{ code: 'GUT K5', name: 'Seamless 5" K-style gutter', category: 'gutters', quantity: 150, unit: 'LF', retailTotal: 6500 }];
const meta = { customer: { name: 'ZZ_QA Jane', address: '1 Main St' }, estimate: { date: '2026-09-28', number: 'EST-1' } };

// ── 1. server-rendered Retail Quote ──
console.log('\nRetail Quote PDF (estimate.hbs)');
const Handlebars = require(path.join(ROOT, 'functions/node_modules/handlebars'));
const R = require(path.join(ROOT, 'functions/render-pdf.js'));
R._registerPartialsOnce();
R._registerHelpersOnce();
const tpl = Handlebars.compile(read('functions/print/templates/estimate.hbs'));
const ROW = /<td class="num totals-label">(Rounding|Minimum job charge adjustment)<\/td>\s*<td class="num money">([^<]*)</;
for (const c of CASES) {
  const est = { method: 'line-item', tier: 'better', mode: 'retail', priceMode: 'line-item', lines,
    overhead: 0, profit: 0, subtotal: c.subtotal, tax: c.tax, taxRate: 0.07, total: c.total, minJobApplied: c.min };
  const p = T.buildEstimatePayload('retail-quote', est, meta);
  const html = tpl(Object.assign({ company: { footerName: 'NBD Co', seal: 'Estimate' } }, p));
  const m = ROW.exec(html);
  if (c.label) {
    ok(c.name + ': prints "' + c.label + ' ' + c.text + '"', !!m && m[1] === c.label && m[2] === c.text, m && (m[1] + ' ' + m[2]));
    const tfoot = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'));
    ok(c.name + ': the row sits between Tax and the table end', tfoot.indexOf('>Tax<') < tfoot.indexOf(c.label));
  } else {
    ok(c.name + ': no adjustment row', !m && p.rounding === 0);
  }
}

// ── 2. insurance scope ──
console.log('\nInsurance scope (formatInsuranceScope)');
for (const c of CASES) {
  const est = { method: 'line-item', tier: 'better', mode: 'insurance', lines, materialMarkupPct: 0, retailBeforeOHP: c.subtotal,
    overhead: 0, overheadPct: 0, profit: 0, profitPct: 0, subtotal: c.subtotal, tax: c.tax, taxRate: 0.07, total: c.total, minJobApplied: c.min };
  let html = '';
  try { html = FIN.formatEstimate(est, 'insurance-scope', { customer: { name: 'ZZ_QA Jane', address: '1 Main St' }, claim: {}, estimate: { date: '2026-09-28' } }).html || ''; }
  catch (e) { html = 'ERR ' + e.message; }
  const want = c.min ? 'Minimum Job Charge Adjustment' : 'Rounding';
  const re = new RegExp('>' + want + '<[\\s\\S]{0,200}?>([−]?\\$[\\d,]+\\.\\d\\d)<');
  const m = re.exec(html);
  if (c.label) {
    ok(c.name + ': prints "' + want + ' ' + c.text + '"', !!m && m[1] === (c.text.includes('.') ? c.text : c.text + '.00'), m ? m[1] : html.slice(0, 80));
  } else {
    ok(c.name + ': no adjustment row', !/>Rounding<|>Minimum Job Charge Adjustment</.test(html));
  }
}

// ── 3. Job Templates proposal preview ──
console.log('\nJob Templates preview (totalsAdjustmentRow)');
ok('hook is exposed', JT && typeof JT._totalsAdjustmentRow === 'function');
for (const c of CASES) {
  const html = JT._totalsAdjustmentRow({ subtotal: c.subtotal, tax: c.tax, total: c.total, minApplied: c.min });
  if (c.label) ok(c.name + ': "' + c.label + ' ' + c.text + '"', html === '<div class="r"><span>' + c.label + '</span><span>' + c.text + '</span></div>', html);
  else ok(c.name + ': no row', html === '');
}
ok('missing subtotal → no row (never invent a ladder)', JT._totalsAdjustmentRow({ total: 100, subtotal: null, tax: 0 }) === '');
ok('float noise under a cent → no row', JT._totalsAdjustmentRow({ subtotal: 0.1 + 0.2, tax: 0, total: 0.3 }) === '');
ok('preview no longer prints the amount-less "Minimum job charge applied" note',
  !/Minimum job charge applied/.test(read('docs/pro/js/job-templates-ui.js')));

// ── 4. customer page estimate preview (rep's screen, often shown to the homeowner) ──
console.log('\nEstimate preview sheet (estimate-preview.js)');
{
  const win = {}; win.window = win;
  vm.runInNewContext(read('docs/pro/js/estimate-preview.js'), { window: win, document: { getElementById: () => null, addEventListener() {}, removeEventListener() {} }, console: quiet, Math, JSON, Number, String, isFinite }, { filename: 'estimate-preview.js' });
  const EP = win.EstimatePreview;
  ok('hooks are exposed', EP && typeof EP._adjustmentRow === 'function' && typeof EP._normalize === 'function');
  const row = (est) => EP._adjustmentRow(EP._normalize(est));
  const txt = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('V2 doc rounded down → "Rounding −$13.13"', txt(row({ rows: [], subtotal: 6500, tax: 488.13, grandTotal: 6975 })) === 'Rounding −$13.13', txt(row({ rows: [], subtotal: 6500, tax: 488.13, grandTotal: 6975 })));
  ok('minimum lifted → "Minimum job charge adjustment $1,069.96"', txt(row({ rows: [], subtotal: 400, tax: 30.04, grandTotal: 1500, minJobApplied: true })) === 'Minimum job charge adjustment $1,069.96');
  ok('classic doc: tax read from taxAmount', EP._normalize({ lineItems: [], subtotal: 1000, taxAmount: 70, grandTotal: 1075 }).tax === 70);
  ok('classic doc: taxAmount counted in the ladder → "Rounding $5"', txt(row({ lineItems: [], subtotal: 1000, taxAmount: 70, grandTotal: 1075 })) === 'Rounding $5');
  ok('already foots → no row', row({ rows: [], subtotal: 6500, tax: 500, grandTotal: 7000 }) === '');
  ok('money prints cents when there are any ($4,271.61, not $4,272)', EP._money(4271.61) === '$4,271.61' && EP._money(4600) === '$4,600');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
