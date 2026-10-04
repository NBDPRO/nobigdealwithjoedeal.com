/**
 * tests/report-claim-wording-2026-10-04.test.js — generated CRM reports use
 * Kentucky-compliant claim wording, and AI captions can't smuggle claim
 * advice onto the homeowner's PDF.
 *
 * THE DEFECT
 *  - The Storm Damage report (inspection-report-engine.js) printed an
 *    "Insurance Recommendation" page reading "File Insurance Claim: YES" — the
 *    contractor advising the insured to file — plus a contractor-branded
 *    "Adjuster Meeting Notes" worksheet. KRS 367.628(1)(a)1 bars a residential
 *    contractor from representing the insured on the claim.
 *  - AI photo analysis/captions (Claude Vision) flowed into every report
 *    unchecked. tests/claim-wording.test.js only scanned static docs/.
 *
 * THE FIX
 *  - The page is "Findings & Next Steps": "Damage consistent with hail was
 *    observed … The homeowner may contact their insurer; whether to file a
 *    claim is the homeowner's decision." The adjuster worksheet is gone from
 *    the homeowner report (the claim card already records the meeting).
 *  - docs/pro/js/claim-wording-filter.js — the SAME rules as the static gate
 *    (moved there; the gate requires it) plus report-only phrasings — runs
 *    over every report string before rendering.
 *
 * WHY THIS EXECUTES: the real filter + the real engine run in a vm, a
 * storm-damage report is generated from a fixture whose rep notes and AI
 * captions are full of banned phrasing, and the OUTPUT HTML is scanned.
 * Run: node tests/report-claim-wording-2026-10-04.test.js
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

// ── 1. The filter catches the banned phrases ────────────────────────────
console.log('\n1. filter catches banned report phrasings');
const BANNED = [
  'File Insurance Claim: YES',
  'We recommend filing an insurance claim.',
  'The homeowner should file a claim with their carrier right away.',
  'An insurance claim is strongly recommended.',
  'Insurance will cover a full replacement.',
  'Your carrier is going to pay for the new roof.',
  'This roof qualifies for an insurance claim.',
  'We can get your claim approved.',
  'We will handle the insurance claim for you.',
  'I negotiate with your adjuster on your behalf.',
  'We can waive your deductible.',
  'You could get a free roof.',
  'Insurance claim experts on every job.',
];
for (const s of BANNED) {
  ok('caught: "' + s + '"', CW.scanText(s).length > 0, 'scan: ' + JSON.stringify(CW.scanText(s)));
  ok('dropped: "' + s + '"', CW.cleanText(s) === '', 'clean: ' + JSON.stringify(CW.cleanText(s)));
}

console.log('\n2. observation-only wording passes untouched');
const ALLOWED = [
  'Damage consistent with hail was observed at this property.',
  'The homeowner may contact their insurer; whether to file a claim is the homeowner’s decision.',
  'Granule loss and bruising on the south slope; soft spots under the shingle mat.',
  'Claim number: 4471-22.',
  'No contractor can legally waive, absorb, or cover your deductible for you.',
  'Replace the pipe boot on the north slope.',
];
for (const s of ALLOWED) {
  ok('passes: "' + s.slice(0, 60) + '"', CW.cleanText(s) === s, 'clean: ' + JSON.stringify(CW.cleanText(s)) + ' scan: ' + JSON.stringify(CW.scanText(s)));
}
const mixed = 'Hail bruising on 9 shingles in the test square. We recommend filing a claim. Replace the ridge cap.';
ok('only the offending sentence is dropped from a mixed caption',
  CW.cleanText(mixed) === 'Hail bruising on 9 shingles in the test square. Replace the ridge cap.',
  JSON.stringify(CW.cleanText(mixed)));
const deep = CW.cleanDeep({ photos: [{ url: 'https://x/claim-recommended.jpg', aiAnalysis: { observations: ['Insurance will pay for this.', 'Cracked shingle.'] } }] });
ok('cleanDeep filters nested AI observations', deep.photos[0].aiAnalysis.observations[0] === '' && deep.photos[0].aiAnalysis.observations[1] === 'Cracked shingle.');
ok('cleanDeep leaves URL keys alone', deep.photos[0].url === 'https://x/claim-recommended.jpg');
ok('the public-site gate and the runtime filter share ONE rule list',
  /require\([^)]*claim-wording-filter\.js'\)/.test(read('tests/claim-wording.test.js'))
  && !/const RULES = \[/.test(read('tests/claim-wording.test.js')));

// ── 3. A generated Storm Damage report contains none ────────────────────
console.log('\n3. generated Storm Damage report HTML');
function loadEngine(withFilter) {
  const window = {
    _leads: [{ id: 'lead-1', name: 'Pat Homeowner', address: '1 Main St, Florence KY', claimNumber: 'C-1' }],
    showToast() {},
  };
  const sandbox = { window, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  if (withFilter) vm.runInContext(read('docs/pro/js/claim-wording-filter.js'), sandbox);
  vm.runInContext(read('docs/pro/js/inspection-report-engine.js'), sandbox);
  return window.InspectionReportEngine;
}
const FIXTURE = {
  stormDate: '2026-05-01', stormType: 'Hail', hailSize: '1.25 in',
  roofDamage: { present: true, description: 'Hail hits on every slope. Insurance will cover a full replacement.' },
  notes: 'Strong hail case. We recommend filing an insurance claim today. We will handle the claim for you.',
  recommendations: {
    fileClaim: true, // a draft saved before the fix
    estimatedScope: 'Full tear-off, 28 SQ. This roof qualifies for an insurance claim.',
    nextSteps: 'Homeowner should file a claim with State Farm. Schedule the build after.',
  },
  photos: [{
    url: 'https://example.test/p1.jpg',
    description: 'South slope hail hits. File Insurance Claim: YES',
    aiAnalysis: { severity: 'severe', observations: ['Circular bruising consistent with hail.', 'Recommend filing a claim — the insurer will approve a new roof.', 'Granule loss.'] },
  }],
};
const E = loadEngine(true);
ok('engine loads with the filter', !!E && typeof E.generateReport === 'function');
const html = E.generateReport('lead-1', 'storm-damage', JSON.parse(JSON.stringify(FIXTURE))) || '';
ok('a report was generated', html.length > 1000, 'len ' + html.length);
const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const hits = CW.scanText(text);
ok('BUG GUARD: the generated report contains NO banned claim wording (all rules)', hits.length === 0,
  hits.map((h) => h.rule + ': ' + h.sentence.slice(0, 120)).join('\n      '));
ok('no "File Insurance Claim" field', !/File Insurance Claim/i.test(text));
ok('no "Insurance Recommendation" page', !/Insurance Recommendation/i.test(text));
ok('no "Adjuster Meeting Notes" page in the homeowner report', !/Adjuster Meeting/i.test(text) && !/Adjuster Name/i.test(text));
ok('states the observation instead', /Damage consistent with hail was observed at this property\./.test(text));
ok('…and that the claim is the homeowner’s decision', /The homeowner may contact their insurer; whether to file a claim is the homeowner’s decision\./.test(text));
ok('clean AI observations still print', /Circular bruising consistent with hail\./.test(text) && /Granule loss\./.test(text));
ok('clean rep text still prints', /Full tear-off, 28 SQ\./.test(text) && /Schedule the build after\./.test(text));
ok('the rep draft itself is not mutated (filter returns a copy)',
  /Insurance will cover/.test(FIXTURE.roofDamage.description));

const html2 = E.generateReport('lead-1', 'storm-damage', { stormType: 'Wind', recommendations: { damageObserved: false } }) || '';
ok('no damage observed → says so, no insurer line', /No damage consistent with wind was observed during this inspection\./.test(html2) && !/contact their insurer/.test(html2));

console.log('\n4. filter missing → AI text is omitted, never printed unchecked');
const E2 = loadEngine(false);
const html3 = E2.generateReport('lead-1', 'storm-damage', JSON.parse(JSON.stringify(FIXTURE))) || '';
ok('AI observations are not printed without the filter', !/insurer will approve/.test(html3) && !/AI Assessment/.test(html3));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
