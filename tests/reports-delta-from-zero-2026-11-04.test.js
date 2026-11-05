/**
 * tests/reports-delta-from-zero-2026-11-04.test.js
 *
 * THE BUG: Reports → Performance Dashboard's _delta(cur, prev) returned 100
 * whenever the previous period was zero, so a first-ever month of revenue
 * showed "$20k ↑ +100%" — read as "doubled" when nothing came before
 * (OVERNIGHT-SITE-PROGRAM-2026-10-26, "Found while fixing").
 *
 * THE FIX: a change from zero has no percentage. _delta returns NaN and
 * _deltaBadge already draws nothing for a non-finite value.
 *
 * Runs the REAL _delta / _deltaBadge lifted out of the file into a vm.
 * Positive control: an ordinary change still draws its badge.
 *
 * Zero deps. Run: node tests/reports-delta-from-zero-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/reports-dashboard.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const ctx = {};
vm.createContext(ctx);
const code = ['_delta', '_deltaBadge'].map((n) => extractFn(SRC, n)).join('\n')
  + '\nglobalThis.badge = function (c, p) { return _deltaBadge(_delta(c, p)); };';
ok('both functions found in the source', code.indexOf('function _delta(') !== -1 && code.indexOf('function _deltaBadge(') !== -1);
vm.runInContext(code, ctx);

ok('positive control: 150 vs 100 draws "+50%"', ctx.badge(150, 100).indexOf('+50%') !== -1, ctx.badge(150, 100));
ok('positive control: 50 vs 100 draws a down badge', ctx.badge(50, 100).indexOf('-50%') !== -1 || ctx.badge(50, 100).indexOf('↓') !== -1, ctx.badge(50, 100));
ok('20000 vs 0 draws no badge (no "+100%")', ctx.badge(20000, 0) === '', ctx.badge(20000, 0));
ok('20000 vs undefined draws no badge', ctx.badge(20000, undefined) === '', ctx.badge(20000, undefined));
ok('0 vs 0 draws no badge', ctx.badge(0, 0) === '', ctx.badge(0, 0));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
