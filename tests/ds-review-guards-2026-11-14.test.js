/**
 * tests/ds-review-guards-2026-11-14.test.js
 *
 * Audit 2026-11-14 #12, the Sunday review:
 *   - Miss tax charged Sundays. The floor streak treats Sunday as "not required" (review-logic floorStreak), but the
 *     week's miss tax billed every floor missed on Sunday at $5. Now Sunday misses are free; hits still count.
 *   - The old "Set calories to N" button cut 200 with none of the guards the weekly-targets proposal has (a 1,500
 *     floor, 4+ food-logged days, not already over target), and it reopened the review on the new target, so each tap
 *     offered another -200. It is gone; the guarded "Accept" proposal under it is the one path.
 *
 * Run: node tests/ds-review-guards-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const R = require(path.join(DIR, 'review-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const F = [{ id: 'f1', label: 'A' }, { id: 'f2', label: 'B' }];
const page = (dk, met) => ({ id: dk, dk, suf: 1, data: Object.fromEntries(met.map((id) => ['floormet-' + id, '1'])) });

console.log('\n1. miss tax: Sundays are free, like the streak');
{
  // review on Sunday 2026-11-15: the week is Sun 11-08 .. Sat 11-14
  const days = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
  const all = days.map((dk) => page(dk, ['f1', 'f2']));
  const offSunday = all.map((p) => (p.dk === '2026-11-08' ? page(p.dk, []) : p));
  const w = R.weekFloors(offSunday, F, '2026-11-15', 500);
  ok('control: the Sunday misses are still shown as misses', w.misses === 2, JSON.stringify(w));
  ok('a week that only skipped Sunday owes nothing', w.missTaxCents === 0, String(w.missTaxCents));
  const offMonday = all.map((p) => (p.dk === '2026-11-09' ? page(p.dk, []) : p));
  ok('control: the same two misses on a Monday cost $10', R.weekFloors(offMonday, F, '2026-11-15', 500).missTaxCents === 1000);
  ok('a Sunday with NO page is not taxed either', R.weekFloors(all.filter((p) => p.dk !== '2026-11-08'), F, '2026-11-15', 500).missTaxCents === 0);
}

console.log('\n2. the unguarded calorie cut is gone');
{
  const UI = fs.readFileSync(path.join(DIR, 'review-ui.js'), 'utf8');
  ok('no "Set calories to" button in the review', !/data-rv-action="cut"/.test(UI) && !/Set calories to/.test(UI));
  ok('control: the guarded weekly-targets proposals are still rendered', /actsHtml\(\)/.test(UI) && /data-rv-action="accept"/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
