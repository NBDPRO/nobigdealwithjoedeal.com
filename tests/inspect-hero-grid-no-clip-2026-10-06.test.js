/**
 * tests/inspect-hero-grid-no-clip-2026-10-06.test.js — /inspect's one-column
 * phone grid must be able to shrink below its content's min-content width.
 *
 * At ≤880px docs/inspect.html collapses .hero-grid to one column. With a bare
 * `1fr` track (= minmax(auto, 1fr)) the photo <input type=file> injected by
 * js/intake-extras.js pushed the track to 411px on 375/390px phones; body's
 * overflow-x:clip then cut off the hero copy, inputs and Submit button
 * (CRO review 2026-10-06, finding #1). The track floor must be 0.
 *
 * Static guard; the rendered check is tests/e2e/phone-inspect-no-clip.spec.js
 * (@shard2). Zero deps. Run: node tests/inspect-hero-grid-no-clip-2026-10-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'inspect.html'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

// The body of the first @media(max-width:880px){...} block (one level of nesting).
const at = html.search(/@media\s*\(\s*max-width\s*:\s*880px\s*\)\s*\{/);
let block = '';
if (at >= 0) {
  let i = html.indexOf('{', at) + 1, depth = 1;
  const start = i;
  for (; i < html.length && depth; i++) { if (html[i] === '{') depth++; else if (html[i] === '}') depth--; }
  block = html.slice(start, i - 1);
}
ok('docs/inspect.html has its @media(max-width:880px) block', block.length > 0);

const rules = [...block.matchAll(/(?:^|[}\s])\.hero-grid\s*\{([^}]*)\}/g)].map((m) => m[1]);
const cols = rules.map((r) => (/grid-template-columns\s*:\s*([^;]+)/.exec(r) || [])[1]).filter(Boolean).map((s) => s.trim());
ok('the phone block sets .hero-grid grid-template-columns exactly once', cols.length === 1, JSON.stringify(cols));
const v = cols[cols.length - 1] || '';
ok('the phone track has a 0 floor (minmax(0, …)), not a bare/auto fr track',
  /^minmax\(\s*0(px)?\s*,\s*1fr\s*\)$/.test(v), v);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
