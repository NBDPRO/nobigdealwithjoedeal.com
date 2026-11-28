/**
 * tests/ds-review-audit-suggest-2026-11-18.test.js
 *
 * Sunday review, promise audit (Joe, 2026-11-18, Q1 and Q2): under the "kept" and "bailed" boxes the sheet suggests a line made from the
 * week's floors. NBDReview.auditSuggest(rows) is the rule, over the rows weekFloors() already returns:
 *   kept   = floors hit 6 or 7 days out of 7 (the sheet already colours those green),
 *   bailed = floors hit 3 days or fewer     (the sheet already colours those red),
 *   anything in between is suggested for neither.
 * Text is "<floor label> <hit>/<of>", comma separated, in the floors' own order. It is only ever a suggestion: nothing is written until Joe taps Use
 * (that part is in ds-review-audit-ui-2026-11-18.test.js).
 *
 * Run: node tests/ds-review-audit-suggest-2026-11-18.test.js
 */
'use strict';
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const R = require(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'review-logic.js'));
const row = (label, hit, of) => ({ id: label.toLowerCase(), label, hit, of: of == null ? 7 : of });

console.log('\n1. the rule');
ok('review-logic exposes auditSuggest', typeof R.auditSuggest === 'function');
if (typeof R.auditSuggest === 'function') {
  const s = R.auditSuggest([row('Sleep 7+ hrs', 7), row('Workout complete', 6), row('Protein', 4), row('1 Big Task', 3), row('Journaled', 0)]);
  ok('7/7 and 6/7 are kept', s.kept === 'Sleep 7+ hrs 7/7, Workout complete 6/7', JSON.stringify(s));
  ok('3/7 and 0/7 are bailed', s.bailed === '1 Big Task 3/7, Journaled 0/7', JSON.stringify(s));
  ok('4/7 and 5/7 are in the middle: neither list', !/Protein/.test(s.kept + s.bailed) && R.auditSuggest([row('A', 5)]).kept === '' && R.auditSuggest([row('A', 5)]).bailed === '');
  ok('the edges: 6 is kept, 5 is not; 3 is bailed, 4 is not', R.auditSuggest([row('A', 6)]).kept === 'A 6/7' && R.auditSuggest([row('A', 5)]).kept === '' && R.auditSuggest([row('A', 3)]).bailed === 'A 3/7' && R.auditSuggest([row('A', 4)]).bailed === '');
  ok('a floor never lands in both lists', (() => { const t = R.auditSuggest([row('A', 7), row('B', 0)]); return t.kept === 'A 7/7' && t.bailed === 'B 0/7'; })());
  ok('floors keep their own order', R.auditSuggest([row('Z', 7), row('A', 7)]).kept === 'Z 7/7, A 7/7');
  ok('no rows (no floors set): two empty strings', JSON.stringify(R.auditSuggest([])) === JSON.stringify({ kept: '', bailed: '' }));
  ok('garbage rows are skipped, not thrown on', (() => { try { const t = R.auditSuggest([null, {}, { label: 'X' }, { label: 'Ok', hit: 7, of: 7 }, { label: '', hit: 7, of: 7 }]); return t.kept === 'Ok 7/7' && t.bailed === ''; } catch (_) { return false; } })());
  ok('not an array is not a throw', JSON.stringify(R.auditSuggest(null)) === JSON.stringify({ kept: '', bailed: '' }) && JSON.stringify(R.auditSuggest(undefined)) === JSON.stringify({ kept: '', bailed: '' }));
  ok('works on the real weekFloors rows', (() => {
    const floors = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];
    const pages = []; for (let i = 11; i <= 17; i++) pages.push({ dk: '2026-11-' + i, suf: 1, data: Object.assign({ 'floormet-a': '1' }, i <= 12 ? { 'floormet-b': '1' } : {}) });
    const w = R.weekFloors(pages, floors, '2026-11-18', 500);
    const t = R.auditSuggest(w.rows);
    return t.kept === 'Alpha 7/7' && t.bailed === 'Beta 2/7';
  })());
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
