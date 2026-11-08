/**
 * tests/st-f70-2026-11-08.test.js — the Pricing page's primary buy button
 * keeps legible white text on hover (CRM audit ST-F70, 2026-11-08).
 *
 * docs/pro/pricing.html hovered .cta-primary to #ff8420, an off-palette bright
 * orange: white text on it is about 2.4:1, under WCAG AA, on the page's main
 * purchase button. It now hovers to the locked brand hover #A14A22 (DESIGN.md
 * "Color": brand #BD5728, hover/deep #A14A22), the value the same page's
 * .pro-nav-cta:hover already uses.
 *
 * Reads the real stylesheet block and computes WCAG contrast.
 * Run: node tests/st-f70-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const HTML = fs.readFileSync(path.join(ROOT, 'docs/pro/pricing.html'), 'utf8').replace(/\r\n/g, '\n');
const DESIGN = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8');

function lum(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

console.log('\nPRICING: the buy button hover');
const base = HTML.match(/\.cta-primary\{background:(#[0-9A-Fa-f]{6});color:(#[0-9A-Fa-f]{3,6});\}/);
const hover = HTML.match(/\.cta-primary:hover\{background:(#[0-9A-Fa-f]{6});\}/);
ok('control: the .cta-primary rule and its hover are found', !!base && !!hover, (base && base[0]) + ' / ' + (hover && hover[0]));
ok('control: DESIGN.md still names #A14A22 as the brand hover', /#A14A22/i.test(DESIGN));
const hv = hover ? hover[1] : '#000000';
ok('the hover is the locked brand hover #A14A22', hv.toUpperCase() === '#A14A22', hv);
ok('the off-palette #ff8420 is gone from pricing.html', !/#ff8420/i.test(HTML));
ok('the retired oranges #E8720C / #F08030 are not reintroduced', !/#E8720C|#F08030/i.test(HTML));
const fg = base ? (base[2].length === 4 ? '#' + base[2].slice(1).split('').map((ch) => ch + ch).join('') : base[2]) : '#ffffff';
const cr = contrast(fg, hv);
ok('white text on the hover meets WCAG AA (4.5:1)', cr >= 4.5, cr.toFixed(2) + ':1');

ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"st-f70-2026-11-08.test.js"') >= 0);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
