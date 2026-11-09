/**
 * tests/supplier-sweep-data-fixes-2026-11-09.test.js
 *
 * Public-data fixes the 2026-11-09 supplier pricing sweep found: manufacturer
 * spec facts, never prices.
 *
 * Owens Corning Berkshire (shingle_008) ships 5 bundles per square (OC product
 * data: 5 bundles of 9 shingles, ~99.5 SF per square, so ~20 SF per bundle).
 * The catalog said 4.
 *
 * The sweep's other public fix, coil-nail and step-flashing lines on the
 * Designer / Luxury Shingle template, lives in
 * tests/designer-nail-step-flashing-2026-11-09.test.js (it moved the pinned
 * totals in tests/system-plus-standard-and-up-2026-10-05.test.js).
 *
 * Pure Node. Run: node tests/supplier-sweep-data-fixes-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PRO_JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; }
}

function load(files) {
  const win = {};
  win.window = win;
  const sandbox = { window: win, Date, Math, JSON, Set, Object, console: { log() {}, warn() {} } };
  files.forEach((f) => vm.runInNewContext(fs.readFileSync(path.join(PRO_JS, f), 'utf8'), sandbox, { filename: f }));
  return win;
}

console.log('\nOC Berkshire bundles per square');
{
  const win = load(['product-data.js']);
  const p = (win.NBD_PRODUCTS || []).find((x) => x.id === 'shingle_008');
  ok('shingle_008 is Owens Corning Berkshire', !!p && /Berkshire/.test(p.name));
  ok('bundlesPerSq is 5 (OC spec: 5 bundles of 9 shingles per square)', !!p && p.coverage && p.coverage.bundlesPerSq === 5);
  ok('no tier carries a cost key (public file)', !!p && Object.values(p.pricing).every((t) => !('cost' in t)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
