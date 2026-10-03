/**
 * tests/css-no-js-escapes-2026-10-03.test.js — no JS string escapes in CSS.
 *
 * The reskin moves inline styles out of JS strings into stylesheets. The
 * source text of a style inside a single-quoted JS string writes a quote as
 * \' — and copying that verbatim into CSS gave
 *   font-family: \'Barlow Condensed\',sans-serif;
 * which in CSS names a font WITH literal quote characters, so the text fell
 * back to sans-serif (expenses.css, maps-routing-view.css, 2026-10-03). The
 * per-screen swap proof missed it because it compared against the same raw
 * text instead of the runtime style.
 *
 * Fails on a backslash before a quote anywhere in docs/pro/css/*.css outside
 * a comment. Legitimate CSS escapes (\201C, \f101) are not quotes.
 *
 * Zero deps. Run: node tests/css-no-js-escapes-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'docs', 'pro', 'css');
let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, why) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (why ? ' — ' + why : '')); console.log('  ✗ ' + name); }
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const ESC_QUOTE = /\\['"]/;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.css')).sort();
ok('found the CRM stylesheets', files.length > 20, 'expected docs/pro/css/*.css');

const hits = [];
for (const f of files) {
  stripComments(fs.readFileSync(path.join(DIR, f), 'utf8')).split(/\r?\n/).forEach((line, i) => {
    if (ESC_QUOTE.test(line)) hits.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 100));
  });
}
ok('no \\\' or \\" (a JS string escape) in any docs/pro/css rule', hits.length === 0,
  'unescape it — CSS reads \\\'Barlow Condensed\\\' as a font named with quote marks:\n      ' + hits.join('\n      '));

// Positive control: the detector must catch the exact 2026-10-03 shape.
ok('detector catches the original defect',
  ESC_QUOTE.test(".exx-x { font-family: \\'Barlow Condensed\\',sans-serif; }"));
ok('detector ignores a quote-free CSS escape (\\201C)',
  !ESC_QUOTE.test('.q::before { content: "\\201C"; }'));

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
