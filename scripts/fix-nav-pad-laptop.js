#!/usr/bin/env node
/**
 * scripts/fix-nav-pad-laptop.js — links /assets/css/nav-pad-laptop.css (last in <head>) on the 18 service hub
 * pages whose header sits 24 px in from the edge at 1025-1440 px, against 16 px on the 184 standard pages.
 *
 *   node scripts/fix-nav-pad-laptop.js            # dry run
 *   node scripts/fix-nav-pad-laptop.js --apply    # write (each file's EOL preserved)
 *   node scripts/fix-nav-pad-laptop.js --check    # exit 1 if a listed page lacks the link
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DOCS = path.resolve(__dirname, '..', 'docs');
const PAGES = ['commercial-roofing', 'emergency-roof-tarping', 'financing', 'fire-water-smoke-damage', 'gutter-cleaning', 'gutter-replacement',
  'hail-damage-insurance-claim', 'interior-repair', 'roof-care-plan', 'roof-cleaning-soft-wash', 'roof-inspection', 'roof-repair', 'roof-replacement',
  'shed-roof-replacement', 'siding-repair', 'siding-replacement', 'storm-damage', 'wood-siding-repair'].map((s) => 'services/' + s + '.html').concat(['careers.html', 'partners.html']);
const LINK = '<link rel="stylesheet" href="/assets/css/nav-pad-laptop.css">';
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
let pending = 0;
// scripts/hero-video.mjs owns the <link> that closes <head> on pages with a hero clip (it fails if anything follows it),
// so on those pages the link goes just BEFORE hero-video.css; everywhere else, just before </head>.
const HV_RE = /<link rel="stylesheet" href="\/assets\/css\/hero-video\.css\?v=\d+">/;
function placed(src) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const without = src.split(LINK + eol).join('').split(LINK).join('');
  const m = without.match(HV_RE);
  if (m) return without.replace(HV_RE, () => LINK + eol + m[0]);
  return without.replace('</head>', () => LINK + eol + '</head>');
}
for (const rel of PAGES) {
  const f = path.join(DOCS, rel);
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes('</head>')) { console.error('no </head> in ' + rel); pending++; continue; }
  const next = placed(src);
  if (next === src) continue;
  pending++;
  if (apply) fs.writeFileSync(f, next);
}
if (check) { if (pending) { console.error('fix-nav-pad-laptop: ' + pending + ' of ' + PAGES.length + ' page(s) lack the link'); process.exit(1); } console.log('fix-nav-pad-laptop: clean'); }
else console.log((apply ? 'fixed ' : 'would fix ') + pending + ' of ' + PAGES.length + ' page(s)');
