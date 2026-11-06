#!/usr/bin/env node
/**
 * scripts/fix-pro-public-contrast.js — links docs/pro/css/pro-public-contrast.css (last in <head>) on the four
 * public NBD Pro pages whose navy theme failed axe's contrast and link-distinction rules.
 *
 *   node scripts/fix-pro-public-contrast.js            # dry run
 *   node scripts/fix-pro-public-contrast.js --apply    # write (each file's EOL preserved)
 *   node scripts/fix-pro-public-contrast.js --check    # exit 1 if a listed page lacks the link
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PAGES = ['how-to', 'register', 'pricing', 'terms'].map((n) => path.resolve(__dirname, '..', 'docs', 'pro', n + '.html'));
const LINK = '<link rel="stylesheet" href="css/pro-public-contrast.css">';
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
let pending = 0;
for (const f of PAGES) {
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('pro-public-contrast.css')) continue;
  if (!src.includes('</head>')) { console.error('no </head> in ' + path.basename(f)); pending++; continue; }
  pending++;
  if (apply) {
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(f, src.replace('</head>', () => LINK + eol + '</head>'));
  }
}
if (check) { if (pending) { console.error('fix-pro-public-contrast: ' + pending + ' of ' + PAGES.length + ' page(s) lack the link'); process.exit(1); } console.log('fix-pro-public-contrast: clean'); }
else console.log((apply ? 'fixed ' : 'would fix ') + pending + ' of ' + PAGES.length + ' page(s)');
