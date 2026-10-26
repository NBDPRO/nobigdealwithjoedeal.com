/**
 * tests/orange-text-on-navy-2026-10-23.test.js - brand-orange TEXT on navy uses the on-dark orange.
 *
 * Overnight audit 2026-10-23: #BD5728 text on the navy (#12223D / #1B2B45) is
 * 3.0-3.5:1 (needs 4.5:1 for small text). DESIGN.md: #BD5728 is the brand
 * orange for fills and light backgrounds; #DD875F is the light orange for dark
 * backgrounds. Fixed here: /estimate (step label, progress label, consent
 * links, footer links via nbd-readability.css), /about (credential chip,
 * caption, "us" header, footer titles), the hail-season blog callout heading.
 * The rules were measured in Chromium (computed colour vs the effective
 * background) before and after; this test pins the rules so they cannot drift
 * back, and the ratio maths proves the old pairing really fails.
 *
 * Run: node tests/orange-text-on-navy-2026-10-23.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(hex(a)), y = lum(hex(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

console.log('orange text on navy');
ok('maths: brand orange on navy is below 4.5 (the old pairing fails)', ratio('#bd5728', '#12223d') < 4.5 && ratio('#bd5728', '#1b2b45') < 4.5);
ok('maths: the on-dark orange on navy clears 4.5', ratio('#dd875f', '#12223d') >= 4.5 && ratio('#dd875f', '#1b2b45') >= 4.5);

const est = read('docs/estimate.html'), about = read('docs/about.html'), blog = read('docs/blog/cincinnati-hail-season-2026.html'), rd = read('docs/assets/css/nbd-readability.css');
const L = 'var(--orange-light)';
ok('control: the rules exist at all (not a vacuous absence check)', /\.step-eyebrow\{/.test(est) && /\.cred\.hl \{/.test(about) && /\.callout h3\{/.test(blog) && /footer\.foot a,\.review-footer a\{/.test(rd));
ok('/estimate: step eyebrow, active progress label, consent links, footer links use the light orange',
  est.includes('.progress-label.active{color:' + L + ';}') && /\.step-eyebrow\{[^}]*color:var\(--orange-light\)/.test(est) && est.includes('.tcpa-check label a{color:' + L + ';') && est.includes('.foot a{color:' + L + ';'));
ok('/about: credential chip, photo caption, "us" header and footer titles use the light orange',
  /\.cred\.hl \{[^}]*color:var\(--orange-light\)/.test(about) && about.includes('.about-photo-caption span { color:' + L + '; }') && about.includes('.vs-header.us-h { color:' + L + '; }') && /\.footer-col \.footer-col-title \{[^}]*color: var\(--orange-light\)/.test(about));
ok('hail-season blog: callout headings use the light orange (both style blocks)', (blog.match(/\.callout h3\{[^}]*color:var\(--orange-light(?:,#dd875f)?\)/g) || []).length === 2 && !/\.callout h3\{[^}]*color:var\(--orange\)/.test(blog));
ok('nbd-readability.css: footer.foot / review-footer links and footer-bottom hover use #dd875f, not #bd5728', /footer\.foot a,\.review-footer a\{color:#dd875f!important\}/.test(rd) && /footer \.footer-bottom a:hover\{color:#dd875f!important\}/.test(rd) && !/footer\.foot a,\.review-footer a\{color:#bd5728/.test(rd));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
