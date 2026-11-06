#!/usr/bin/env node
/**
 * scripts/fix-blog-nav-fit.js — links /assets/css/blog-nav-fit.css (last in <head>) on every page that
 * carries the nav-blog partial, so the nine-item desktop header stops wrapping (see that stylesheet).
 *
 *   node scripts/fix-blog-nav-fit.js            # dry run
 *   node scripts/fix-blog-nav-fit.js --apply    # write (each file's EOL preserved)
 *   node scripts/fix-blog-nav-fit.js --check    # exit 1 if a nav-blog page lacks the link
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DOCS = path.resolve(__dirname, '..', 'docs');
const LINK = '<link rel="stylesheet" href="/assets/css/blog-nav-fit.css">';
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}
let pending = 0; let total = 0;
for (const f of walk(DOCS, [])) {
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes('<!-- nbd:partial nav-blog')) continue;
  total++;
  if (src.includes('blog-nav-fit.css')) continue;
  if (!src.includes('</head>')) { console.error('no </head> in ' + path.relative(DOCS, f)); pending++; continue; }
  pending++;
  if (apply) {
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(f, src.replace('</head>', () => LINK + eol + '</head>'));
  }
}
if (check) { if (pending) { console.error('fix-blog-nav-fit: ' + pending + ' of ' + total + ' nav-blog page(s) lack the link'); process.exit(1); } console.log('fix-blog-nav-fit: clean (' + total + ' pages)'); }
else console.log((apply ? 'fixed ' : 'would fix ') + pending + ' of ' + total + ' nav-blog page(s)');
