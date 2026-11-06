#!/usr/bin/env node
/**
 * scripts/fix-region-landmarks.js — give two chrome blocks a landmark role so axe's
 * `region` rule ("all content should be contained by landmarks") passes:
 *   - the sticky mobile Call/Text strip: `aria-label="Quick contact options"` sat on a bare
 *     <div> (an aria-label on a role-less div is ignored) -> add role="region".
 *   - the top announcement bar `<div class="ann-bar" id="annBar">` -> role="region"
 *     aria-label="Announcements".
 * Touches docs/**.html, site-src/partials/mobile-cta.html and the case-page template in
 * scripts/build-projects.mjs. Text-only edits (newlines untouched, so every file keeps its EOL).
 *
 *   node scripts/fix-region-landmarks.js            # dry run
 *   node scripts/fix-region-landmarks.js --apply    # write
 *   node scripts/fix-region-landmarks.js --check    # exit 1 if any block still lacks the role
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');

const RULES = [
  { name: 'cta-strip', find: /(?<!role="region" )aria-label="Quick contact options"/g, to: 'role="region" aria-label="Quick contact options"', todo: /(?<!role="region" )aria-label="Quick contact options"/ },
  { name: 'ann-bar', find: /<div class="ann-bar" id="annBar">/g, to: '<div class="ann-bar" id="annBar" role="region" aria-label="Announcements">', todo: /<div class="ann-bar" id="annBar">/ },
];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (p.endsWith('.html')) out.push(p);
  }
  return out;
}
const files = walk(path.join(ROOT, 'docs'), []).concat([path.join(ROOT, 'site-src', 'partials', 'mobile-cta.html'), path.join(ROOT, 'scripts', 'build-projects.mjs')]);

let changed = 0; let pending = 0; const counts = {};
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8'); let next = src;
  for (const r of RULES) {
    if (r.todo.test(next)) { pending++; counts[r.name] = (counts[r.name] || 0) + 1; next = next.replace(r.find, r.to); }
  }
  if (next !== src) { changed++; if (apply) fs.writeFileSync(f, next); }
}
if (check) {
  if (pending) { console.error('fix-region-landmarks: ' + pending + ' block(s) still missing the landmark role ' + JSON.stringify(counts)); process.exit(1); }
  console.log('fix-region-landmarks: clean'); process.exit(0);
}
console.log((apply ? 'fixed ' : 'would fix ') + changed + ' file(s) ' + JSON.stringify(counts));
