/**
 * tests/supplement-letter-claim-wording-2026-10-18.test.js — the insurance
 * supplement letter (docs/pro/js/estimate-supplement.js formatSupplementLetter)
 * runs the rep's free text through the Kentucky claim-wording filter.
 *
 * THE GAP (audit 2026-10-18): claim-wording-filter.js guarded the inspection
 * report and photo report, but the supplement letter — addressed to the
 * carrier's adjuster, on the contractor's letterhead, built from typed reasons
 * and justifications — printed whatever the rep wrote. "We will negotiate this
 * claim with your adjuster on your behalf" went straight onto the page.
 * tests/claim-wording.test.js scans only static docs/ (not docs/pro/).
 *
 * WHY THIS EXECUTES: the real filter and the real estimate-supplement.js run in
 * a vm; the letter HTML is generated from fixtures and the OUTPUT is scanned.
 * A positive control (clean text passes untouched) sits beside the absence
 * checks, and the "no filter" run must throw (fail closed).
 * Run: node tests/supplement-letter-claim-wording-2026-10-18.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const CW = require(path.join(ROOT, 'docs', 'pro', 'js', 'claim-wording-filter.js'));

function loadSupplement(withFilter) {
  const window = {};
  const sandbox = { window, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  if (withFilter) vm.runInContext(read('docs/pro/js/claim-wording-filter.js'), sandbox);
  vm.runInContext(read('docs/pro/js/estimate-supplement.js'), sandbox);
  return window.EstimateSupplement;
}

function fixture(over) {
  const s = {
    id: 'sup_test', version: 1, createdAt: '2026-10-18T12:00:00.000Z', parentEstimateId: 'est_1',
    reason: 'Rotted decking found under the south slope.',
    originalTotal: 14000, supplementMaterial: 400, supplementLabor: 300, supplementOverhead: 70,
    supplementProfit: 70, supplementTotal: 840, newGrandTotal: 14840, deltaPct: 6,
    addedItems: [{
      code: 'RFG-DECK', name: 'Replace rotted decking', quantity: 4, unit: 'SH',
      materialCostPerUnit: 50, laborCostPerUnit: 30, lineTotal: 320,
      justification: 'Three sheets were soft underfoot once the shingles came off.',
    }],
    modifiedItems: [{
      originalCode: 'RFG-RIDGE', name: 'Ridge cap', originalQuantity: 40, newQuantity: 52, deltaQuantity: 12,
      unit: 'LF', deltaLineTotal: 96, justification: 'The ridge is longer than the first measurement.',
    }],
  };
  return Object.assign(s, over || {});
}
const META = { customer: { name: 'Pat Homeowner', address: '1 Main St, Florence KY' },
  claim: { carrier: 'State Farm', number: 'C-1', adjuster: 'Alex Adjuster', dateOfLoss: '2026-05-01' } };
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ');

const S = loadSupplement(true);
ok('estimate-supplement.js loads in the sandbox', !!S && typeof S.formatSupplementLetter === 'function');

// ── 1. positive control: a clean supplement is untouched ─────────────────
console.log('\n1. clean supplement -> nothing removed (positive control)');
const clean = S.formatSupplementLetter(fixture(), META);
ok('a letter is generated', clean.html.length > 1000);
ok('wordingRemoved is empty for clean text', Array.isArray(clean.wordingRemoved) && clean.wordingRemoved.length === 0,
  JSON.stringify(clean.wordingRemoved));
ok('clean reason, justification and adjustment text all print',
  /Rotted decking found under the south slope\./.test(clean.html)
  && /Three sheets were soft underfoot/.test(clean.html)
  && /The ridge is longer than the first measurement\./.test(clean.html));
ok('the template text itself trips no rule', CW.scanText(textOf(clean.html)).length === 0,
  JSON.stringify(CW.scanText(textOf(clean.html))));

// ── 2. banned wording in every free-text field is dropped + reported ─────
console.log('\n2. banned wording is dropped and reported');
const BAD = {
  reason: 'We will negotiate this claim with your adjuster on your behalf.',
  add: 'Insurance will cover a full replacement. Three sheets were soft underfoot.',
  addName: 'Decking: we handle the insurance claim for you',
  mod: 'We recommend filing a claim for the extra ridge. The ridge is longer than measured.',
  modName: 'Ridge cap (assignment of benefits signed)',
  code: 'We can waive your deductible',
};
const dirty = fixture({
  reason: BAD.reason,
  addedItems: [Object.assign({}, fixture().addedItems[0], { justification: BAD.add, name: BAD.addName, codeRef: BAD.code })],
  modifiedItems: [Object.assign({}, fixture().modifiedItems[0], { justification: BAD.mod, name: BAD.modName })],
});
const out = S.formatSupplementLetter(dirty, META);
const outText = textOf(out.html);
const hits = CW.scanText(outText);
ok('BUG GUARD: the letter contains NO banned claim wording (all rules)', hits.length === 0,
  hits.map((h) => h.rule + ': ' + h.sentence.slice(0, 120)).join('\n      '));
ok('negotiate / on-your-behalf sentence is gone', !/negotiate/i.test(outText) && !/on your behalf/i.test(outText));
ok('"will cover a full replacement" is gone', !/will cover/i.test(outText));
ok('"handle the insurance claim for you" is gone', !/handle the insurance claim/i.test(outText));
ok('assignment of benefits is gone', !/assignment of benefits/i.test(outText));
ok('deductible waiver in a code reference is gone', !/waive/i.test(outText));
ok('the clean sentences next to banned ones still print',
  /Three sheets were soft underfoot\./.test(outText) && /The ridge is longer than measured\./.test(outText));
ok('an emptied reason falls back to the neutral default', /Additional work required/.test(out.html));
const fields = out.wordingRemoved.map((r) => r.field);
ok('every dirty field is reported back to the rep (not silent)',
  ['Supplement reason', 'Added item 1 name', 'Added item 1 justification', 'Added item 1 code reference',
    'Quantity adjustment 1 name', 'Quantity adjustment 1 justification'].every((f) => fields.indexOf(f) !== -1),
  JSON.stringify(fields));
ok('each report row carries the original text and the rule ids',
  out.wordingRemoved.length > 0
  && out.wordingRemoved.every((r) => typeof r.text === 'string' && r.text && Array.isArray(r.rules) && r.rules.length));
ok('the rep supplement object is not mutated', dirty.reason === BAD.reason && dirty.addedItems[0].justification === BAD.add);

// ── 3. fail closed ───────────────────────────────────────────────────────
console.log('\n3. filter missing -> no letter');
const S2 = loadSupplement(false);
let threw = null;
try { S2.formatSupplementLetter(fixture(), META); } catch (e) { threw = e; }
ok('formatSupplementLetter throws instead of printing unchecked text', !!threw && /claim-wording filter not loaded/i.test(threw.message));

// ── 4. wiring: the filter loads before the supplement on BOTH load paths ──
console.log('\n4. the filter is loaded wherever the supplement is');
const loader = read('docs/pro/js/script-loader.js');
const iF = loader.indexOf("'js/claim-wording-filter.js", loader.indexOf('estimates: ['));
const iS = loader.indexOf("'js/estimate-supplement.js");
ok('script-loader estimates bundle: filter precedes estimate-supplement.js', iF > 0 && iS > 0 && iF < iS);
const cust = read('docs/pro/customer.html');
const cF = cust.indexOf('/pro/js/claim-wording-filter.js');
const cS = cust.indexOf('/pro/js/estimate-supplement.js');
ok('customer.html: filter tag precedes the estimate-supplement.js tag', cF > 0 && cS > 0 && cF < cS);
ok('supplement-ui.js tells the rep what was removed',
  /wordingRemoved/.test(read('docs/pro/js/supplement-ui.js')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failed:\n - ' + fails.join('\n - ')); process.exit(1); }
