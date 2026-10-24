/**
 * tests/footer-title-orange-on-navy-2026-10-24.test.js
 *
 * Public-page contrast sweep, 2026-10-24 (continues orange-text-on-navy-2026-10-23):
 *   1. 64 pages styled their footer column titles `color:var(--orange)` inline:
 *      brand orange on the navy footer reads 3.45:1 at 12px. They read the
 *      light brand orange now (6.3:1). Pages that load nbd-readability.css
 *      override the title to white anyway; this pins the inline rule itself.
 *   2. The guides' skip link: `.g-page a{color:var(--orange-dark)}` outranked
 *      `.g-skip{color:#fff}`, so the focused "Skip to content" was dark orange
 *      on orange (1.3:1).
 *   3. The blog mid-post CTA eyebrow ("Got a question?"), brand orange on its
 *      navy card (3.45:1).
 * Run: node tests/footer-title-orange-on-navy-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 800) : '')); }
}
const PAGES = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!(d === path.join(ROOT, 'docs') && ['pro', 'sites', 'admin', 'dev', 'assets'].includes(e.name))) walk(p); }
    else if (e.name.endsWith('.html')) PAGES.push(p);
  }
})(path.join(ROOT, 'docs'));
const bare = [];
let light = 0;
for (const f of PAGES) {
  const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of src.matchAll(/\.footer-col-title[^{]*\{([^}]*)\}/g)) {
    if (/color:\s*var\(--orange\)/.test(m[1])) bare.push(path.relative(ROOT, f));
    if (/color:\s*var\(--orange-light/.test(m[1])) light++;
  }
}
ok('no public page styles .footer-col-title with the plain brand orange on the navy footer', bare.length === 0, [...new Set(bare)].slice(0, 6).join(', '));
ok('the inline footer-title rules read the light orange (' + light + ' rules)', light >= 90, String(light));
const guide = fs.readFileSync(path.join(ROOT, 'docs/assets/css/nbd-guide.css'), 'utf8');
ok('nbd-guide.css keeps the skip link white under .g-page a', /\.g-page a\.g-skip\{color:#fff\}/.test(guide));
ok('…declared after the .g-page a rule it has to beat', guide.indexOf('.g-page a.g-skip{') > guide.indexOf('.g-page a{color:var(--orange-dark)'));
const guides = PAGES.filter((f) => /\/guides\/[a-z0-9-]+\.html$/.test(f));
ok('every guide page loads nbd-guide.css?v=5 or later', guides.every((f) => { const m = /nbd-guide\.css\?v=(\d+)/.exec(fs.readFileSync(f, 'utf8')); return m && +m[1] >= 5; }));
const bmc = fs.readFileSync(path.join(ROOT, 'docs/assets/css/blog-midpost-cta.css'), 'utf8');
ok('the blog mid-post CTA eyebrow reads the light orange on its navy card', /\.bmc-eyebrow\{[^}]*color:var\(--orange-light,#dd875f\)/.test(bmc));
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
