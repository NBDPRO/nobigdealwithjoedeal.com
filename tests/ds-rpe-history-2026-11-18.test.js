/**
 * tests/ds-rpe-history-2026-11-18.test.js
 *
 * RPE history on the Progress card (Joe, 2026-11-18): under a lift's estimated-1RM line, "Top-set RPE 7 → 7.5 → 8 (getting harder)".
 * NBDProgress.rpeLine(exId, sessions) is the rule. It reuses the coach's own trend (workout-coach-logic.js rpeTrend / rpeTrendText), so the
 * Progress card and the lift card in the coach never disagree:
 *   - the last 6 finished sessions of THAT lift that logged an RPE on their top-weight working sets, oldest first;
 *   - '' until three sessions logged one (two points are not a trend), and '' for someone who never logs RPE ("no RPE, no mention");
 *   - warm-ups, unfinished and deleted workouts, and other lifts never count.
 * The screens are checked in a browser in ds-rpe-history-ui-2026-11-18.test.js.
 *
 * Run: node tests/ds-rpe-history-2026-11-18.test.js
 */
'use strict';
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const P = require(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'progress-charts-logic.js'));
const set = (w, r, rpe, warm) => Object.assign({ weight: w, reps: r, rpe, done: true }, warm ? { warm: true } : {});
const sess = (date, exId, sets, extra) => Object.assign({ id: 's-' + date + exId, date, split: 'push', startedAt: 1, finishedAt: 2000, exercises: [{ exId, name: exId, slot: 0, sets }] }, extra || {});
const bench = (date, rpe, extra) => sess(date, 'bb_bench', [set(135, 8, rpe), set(135, 8, rpe), set(135, 8, rpe)], extra);

console.log('\n1. the rule');
ok('NBDProgress exposes rpeLine', typeof P.rpeLine === 'function');
if (typeof P.rpeLine === 'function') {
  const four = [bench('2026-10-20', 7), bench('2026-10-27', 7.5), bench('2026-11-03', 8), bench('2026-11-10', 8.5)];
  ok('four sessions with RPE: the trend, oldest first, getting harder', P.rpeLine('bb_bench', four) === 'Top-set RPE 7 → 7.5 → 8 → 8.5 (getting harder)', P.rpeLine('bb_bench', four));
  ok('it matches the coach lift card word for word', (() => { const C = require(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'workout-coach-logic.js')); return P.rpeLine('bb_bench', four) === 'Top-set ' + C.rpeTrendText(C.rpeTrend('bb_bench', four, 6)); })());
  ok('getting easier and steady read as such', P.rpeLine('bb_bench', [bench('2026-10-20', 9), bench('2026-10-27', 8.5), bench('2026-11-03', 8)]).endsWith('(getting easier)') && P.rpeLine('bb_bench', [bench('2026-10-20', 8), bench('2026-10-27', 8), bench('2026-11-03', 8.5)]).endsWith('(steady)'));
  ok('two sessions with RPE is not a trend: empty', P.rpeLine('bb_bench', four.slice(0, 2)) === '');
  ok('three is the first trend', P.rpeLine('bb_bench', four.slice(0, 3)) === 'Top-set RPE 7 → 7.5 → 8 (getting harder)', P.rpeLine('bb_bench', four.slice(0, 3)));
  ok('never logged an RPE: empty (no RPE, no mention)', P.rpeLine('bb_bench', [bench('2026-10-20', ''), bench('2026-10-27', ''), bench('2026-11-03', ''), bench('2026-11-10', '')]) === '');
  ok('sessions without an RPE are skipped, the ones with one still count', P.rpeLine('bb_bench', [bench('2026-10-13', 7), bench('2026-10-20', ''), bench('2026-10-27', 7.5), bench('2026-11-03', ''), bench('2026-11-10', 8)]) === 'Top-set RPE 7 → 7.5 → 8 (getting harder)');
  ok('only the last 6 sessions with an RPE', (() => { const many = []; for (let i = 0; i < 8; i++) many.push(bench('2026-10-' + String(10 + i).padStart(2, '0'), 7 + (i % 3) * 0.5)); return P.rpeLine('bb_bench', many).split('→').length === 6; })());
  ok('another lift\'s RPE is never mixed in', P.rpeLine('bb_squat', four) === '' && P.rpeLine('bb_bench', four.concat([sess('2026-11-11', 'bb_squat', [set(185, 5, 9), set(185, 5, 9)])])) === P.rpeLine('bb_bench', four));
  ok('warm-up sets do not set the top-set RPE', P.rpeLine('bb_bench', [sess('2026-10-20', 'bb_bench', [set(45, 10, 6, true), set(135, 8, 7)]), sess('2026-10-27', 'bb_bench', [set(45, 10, 6, true), set(135, 8, 7.5)]), sess('2026-11-03', 'bb_bench', [set(45, 10, 6, true), set(135, 8, 8)])]) === 'Top-set RPE 7 → 7.5 → 8 (getting harder)');
  ok('a deleted or unfinished workout does not count', P.rpeLine('bb_bench', four.slice(0, 2).concat([bench('2026-11-03', 8, { deleted: true }), bench('2026-11-10', 8.5, { finishedAt: 0 })])) === '');
  ok('garbage in gives an empty line and no throw', (() => { try { return P.rpeLine('bb_bench', null) === '' && P.rpeLine('', [bench('2026-10-20', 7)]) === '' && P.rpeLine(undefined, undefined) === ''; } catch (_) { return false; } })());
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
