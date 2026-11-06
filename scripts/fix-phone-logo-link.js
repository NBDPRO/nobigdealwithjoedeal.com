#!/usr/bin/env node
/**
 * scripts/fix-phone-logo-link.js — six hand-authored pages never linked
 * /assets/css/nbd-nav-logo-mobile.css, so on phones their header logo stayed 117x60 while the
 * other ~240 pages shrink it to 97x50 (the rule is `@media(max-width:768px){nav .nav-logo img{height:50px!important}}`).
 * Inserts the link right after each page's mobile-cta.css link (the sheet is cascade-safe wherever it sits).
 *
 *   node scripts/fix-phone-logo-link.js            # dry run
 *   node scripts/fix-phone-logo-link.js --apply    # write (each file's EOL preserved)
 *   node scripts/fix-phone-logo-link.js --check    # exit 1 if any listed page still lacks the link
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DOCS = path.resolve(__dirname, '..', 'docs');
const FILES = ['blog/roof-financing-cincinnati-explained.html', 'book/index.html', 'free-tools/index.html', 'roof-score.html', 'storm-check.html', 'storm-report.html'];
const LINK = '<link rel="stylesheet" href="/assets/css/nbd-nav-logo-mobile.css">';
const ANCHOR = /<link rel="stylesheet" href="\/assets\/css\/mobile-cta\.css[^"]*">/;
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
let pending = 0;
for (const f of FILES) {
  const full = path.join(DOCS, f);
  const src = fs.readFileSync(full, 'utf8');
  if (src.includes('nbd-nav-logo-mobile.css')) continue;
  const m = src.match(ANCHOR);
  if (!m) { console.error('no mobile-cta.css anchor in ' + f); pending++; continue; }
  pending++;
  if (apply) fs.writeFileSync(full, src.replace(ANCHOR, m[0] + LINK));
  if (!check) console.log((apply ? 'fixed ' : 'would fix ') + f);
}
if (check) { if (pending) { console.error('fix-phone-logo-link: ' + pending + ' page(s) still missing the link'); process.exit(1); } console.log('fix-phone-logo-link: clean'); }
