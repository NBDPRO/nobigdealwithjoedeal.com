/**
 * tests/zip-state-check-2026-10-07.test.js — the ZIP-vs-state matcher behind
 * audit-lead-addresses.js's report-only "ZIP/state MISMATCH" tally.
 *
 * The case that started it: a lead reading "Cincinnati, OH 46211". 462xx is
 * Indianapolis; the old audit only asked "is there a 5-digit ZIP?" and called
 * it ok. Ranges: OH 430–459, KY 400–427, IN 460–479; other states unchecked.
 *
 * Pure — loads scripts/_zip-state.js directly. Run:
 *   node tests/zip-state-check-2026-10-07.test.js
 */
'use strict';

const path = require('path');
const { zipStateCheck, RANGES } = require(path.join(__dirname, '..', 'scripts', '_zip-state.js'));

let passed = 0, failed = 0; const fails = [];
function eq(name, got, want) {
  if (got === want) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + ' (got ' + got + ', want ' + want + ')'); console.log('  ✗ ' + name + ' — got ' + got + ', want ' + want); }
}

console.log('\nThe motivating case');
eq('"Cincinnati, OH 46211" → mismatch', zipStateCheck('123 Example St, Cincinnati, OH 46211'), 'mismatch');
eq('"Cincinnati, OH 45211" → ok', zipStateCheck('123 Example St, Cincinnati, OH 45211'), 'ok');

console.log('\nRange edges');
eq('OH 43001 (low edge) → ok', zipStateCheck('Columbus, OH 43001'), 'ok');
eq('OH 45999 (high edge) → ok', zipStateCheck('Somewhere, OH 45999'), 'ok');
eq('OH 42999 → mismatch', zipStateCheck('Somewhere, OH 42999'), 'mismatch');
eq('OH 46000 → mismatch', zipStateCheck('Somewhere, OH 46000'), 'mismatch');
eq('KY 40001 → ok', zipStateCheck('Louisville, KY 40001'), 'ok');
eq('KY 41042 (Florence) → ok', zipStateCheck('Florence, KY 41042'), 'ok');
eq('KY 42799 → ok', zipStateCheck('Somewhere, KY 42799'), 'ok');
eq('KY 42800 → mismatch', zipStateCheck('Somewhere, KY 42800'), 'mismatch');
eq('KY with an OH ZIP (45211) → mismatch', zipStateCheck('Covington, KY 45211'), 'mismatch');
eq('IN 46000 → ok', zipStateCheck('Somewhere, IN 46000'), 'ok');
eq('IN 47999 → ok', zipStateCheck('Somewhere, IN 47999'), 'ok');
eq('IN 48000 → mismatch', zipStateCheck('Somewhere, IN 48000'), 'mismatch');
eq('IN with an OH ZIP → mismatch', zipStateCheck('Lawrenceburg, IN 45211'), 'mismatch');
eq('ranges are exactly OH/KY/IN', Object.keys(RANGES).sort().join(','), 'IN,KY,OH');

console.log('\nFormat tolerance');
eq('ZIP+4 → judged on the 5-digit part', zipStateCheck('1 Main St, Cincinnati, OH 45211-1234'), 'ok');
eq('lower-case state', zipStateCheck('1 Main St, Cincinnati, oh 46211'), 'mismatch');
eq('comma between state and ZIP', zipStateCheck('1 Main St, Cincinnati, OH, 45211'), 'ok');
eq('5-digit house number is not mistaken for the ZIP', zipStateCheck('10520 Main St, Cincinnati, OH 45242'), 'ok');
eq('5-digit house number + wrong ZIP still mismatches', zipStateCheck('45211 Main St, Cincinnati, OH 46211'), 'mismatch');

console.log('\nNot judged');
eq('other state → uncheckedState', zipStateCheck('1 Main St, Huntington, WV 25701'), 'uncheckedState');
eq('no ZIP → noPair', zipStateCheck('1 Main St, Cincinnati, OH'), 'noPair');
eq('no state → noPair', zipStateCheck('1 Main St, Cincinnati 45211'), 'noPair');
eq('"St 45211" is not a state → noPair', zipStateCheck('1 Main St 45211'), 'noPair');
eq('blank → noPair', zipStateCheck(''), 'noPair');
eq('null → noPair', zipStateCheck(null), 'noPair');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
