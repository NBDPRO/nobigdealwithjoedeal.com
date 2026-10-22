/**
 * tests/coach-rpe-2026-10-21.test.js
 *
 * RPE as a first-class number: target notes SAY when the last session's effort shaped the call (earned a jump at RPE 7.5, hold
 * after a grind), a lift's top-set RPE trend is shown on its card once three sessions have one, and none of it appears for
 * someone who never logs RPE. Pins the pure logic (baseTarget notes via targetFor, topRpe, rpeTrend, rpeTrendText) and the screen.
 *
 * Run: node tests/coach-rpe-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

let _n = 0;
// sets: [weight, reps, rpe?, warm?]
function bench(date, sets, exId) {
  return {
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: ++_n,
    exercises: [{ exId: exId || 'bb_bench', name: 'Bench', slot: 0, sets: sets.map(([weight, reps, rpe, warm]) => Object.assign({ weight, reps, done: true }, rpe ? { rpe } : {}, warm ? { warm: true } : {})) }],
  };
}
const RANGE = [5, 8];

console.log('\n1. targets explain the effort');
{
  const easy = C.targetFor('bb_bench', RANGE, [bench('2026-10-10', [[135, 8, 7], [135, 8, 7.5], [135, 8, 7]])]);
  ok('hit the top of the range at RPE ~7: the jump is earned and the note says at what RPE', easy.weight > 135 && /Earned it/.test(easy.note) && /at RPE 7\.2/.test(easy.note), easy.note);
  const grind = C.targetFor('bb_bench', RANGE, [bench('2026-10-10', [[135, 8, 8], [135, 8, 9], [135, 8, 9.5]])]);
  ok('a set at RPE 9.5+ holds the weight and says why', grind.weight === 135 && /Hold 135 lb/.test(grind.note) && /a set hit RPE 9\.5\+ \(a grind\)/.test(grind.note), grind.note);
  const low = C.targetFor('bb_bench', RANGE, [bench('2026-10-10', [[135, 4, 8], [135, 4, 8]])]);
  ok('missing the bottom of the range holds with the old reason, not the grind one', /Hold 135 lb — own the bottom of the range/.test(low.note) && !/grind/.test(low.note), low.note);
  const hard = C.targetFor('bb_bench', RANGE, [bench('2026-10-10', [[135, 8, 9], [135, 8, 9], [135, 8, 9]])]);
  ok('top reps but RPE 9 is NOT enough to add weight (the same rule as before), and the note shows the RPE', hard.weight === 135 && /RPE 9/.test(hard.note), hard.note);
  const none = C.targetFor('bb_bench', RANGE, [bench('2026-10-10', [[135, 8], [135, 8], [135, 8]])]);
  ok('control: with no RPE logged the note never mentions RPE, and the call is the same as ever (earned)', !/RPE/.test(none.note) && none.weight > 135 && /Earned it: \+\d+ lb \(last 135 × 8\/8\/8\)/.test(none.note), none.note);
  ok('control: a brand-new lift keeps its "find a weight" note', /RPE 7/.test(C.targetFor('bb_bench', RANGE, []).note));
  const warmOnly = C.targetFor('bb_bench', RANGE, [bench('2026-10-10', [[95, 8, 6, true], [135, 8, 7], [135, 8, 7], [135, 8, 7]])]);
  ok('a warm-up set\'s RPE is ignored (the working sets say RPE 7)', /at RPE 7\)/.test(warmOnly.note), warmOnly.note);
}

console.log('\n2. topRpe');
{
  const ex = (sets) => bench('2026-10-10', sets).exercises[0];
  ok('average RPE of the TOP-weight working sets, one decimal', C.topRpe(ex([[135, 8, 7], [135, 8, 8], [115, 10, 6]])) === 7.5);
  ok('lighter back-off sets and warm-ups are ignored', C.topRpe(ex([[45, 8, 5, true], [135, 8, 8], [95, 12, 5]])) === 8);
  ok('no RPE logged -> null (not 0)', C.topRpe(ex([[135, 8], [135, 8]])) === null);
  ok('an RPE on a lighter set only does not count for the top weight', C.topRpe(ex([[135, 8], [115, 8, 9]])) === null);
  ok('bodyweight (0 lb) lifts work: the top weight is 0', C.topRpe({ exId: 'pullup', sets: [{ weight: 0, reps: 8, rpe: 8, done: true }, { weight: 0, reps: 7, rpe: 9, done: true }] }) === 8.5);
  ok('an exercise with no working sets -> null', C.topRpe({ exId: 'bb_bench', sets: [] }) === null);
}

console.log('\n3. rpeTrend / rpeTrendText');
{
  const hist = [
    bench('2026-10-01', [[135, 8, 7]]), bench('2026-10-05', [[135, 8, 7.5]]), bench('2026-10-09', [[135, 8]]),   // this one logged no RPE
    bench('2026-10-13', [[135, 8, 8]]), bench('2026-10-17', [[135, 8, 8.5]]),
  ];
  const t = C.rpeTrend('bb_bench', hist, 6);
  ok('oldest first, only sessions that logged an RPE', t.map((x) => x.date + ':' + x.rpe).join() === '2026-10-01:7,2026-10-05:7.5,2026-10-13:8,2026-10-17:8.5', JSON.stringify(t));
  const many = Array.from({ length: 9 }, (_, i) => bench('2026-09-' + String(10 + i).padStart(2, '0'), [[135, 8, 7 + i * 0.1]]));
  ok('with no limit given the trend is the newest SIX (the default the screen relies on)', C.rpeTrend('bb_bench', many).length === 6 && C.rpeTrend('bb_bench', many)[5].date === '2026-09-18', JSON.stringify(C.rpeTrend('bb_bench', many).map((x) => x.date)));
  ok('the limit keeps the NEWEST n', C.rpeTrend('bb_bench', hist, 2).map((x) => x.rpe).join() === '8,8.5');
  ok('harder by a point or more reads "getting harder"', C.rpeTrendText(t) === 'RPE 7 → 7.5 → 8 → 8.5 (getting harder)', C.rpeTrendText(t));
  ok('easier by a point or more reads "getting easier"', /getting easier/.test(C.rpeTrendText([{ rpe: 9 }, { rpe: 8.5 }, { rpe: 8 }])));
  ok('within a point is "steady"', /\(steady\)/.test(C.rpeTrendText([{ rpe: 8 }, { rpe: 8.5 }, { rpe: 8 }])));
  ok('a half-point drift either way is still "steady" (it takes a full point to count)', /\(steady\)/.test(C.rpeTrendText([{ rpe: 8 }, { rpe: 8.2 }, { rpe: 8.5 }])) && /\(steady\)/.test(C.rpeTrendText([{ rpe: 8.5 }, { rpe: 8.2 }, { rpe: 8 }])));
  ok('exactly a full point counts: 7 -> 8 is harder, 8 -> 7 is easier', /getting harder/.test(C.rpeTrendText([{ rpe: 7 }, { rpe: 7.5 }, { rpe: 8 }])) && /getting easier/.test(C.rpeTrendText([{ rpe: 8 }, { rpe: 7.5 }, { rpe: 7 }])));
  ok('fewer than three points is not a trend: empty', C.rpeTrendText([{ rpe: 8 }, { rpe: 8.5 }]) === '' && C.rpeTrendText([]) === '' && C.rpeTrendText(undefined) === '');
  ok('another lift\'s sessions are not mixed in', C.rpeTrend('ohp', hist, 6).length === 0);
  ok('unfinished sessions are ignored', C.rpeTrend('bb_bench', [Object.assign(bench('2026-10-20', [[135, 8, 9]]), { finishedAt: 0 })], 6).length === 0);
}

console.log('\n4. the real screen');
{
  // every split has the same bench history, so Repeat opens the bench whatever is next in the rotation
  const dates = [['2026-10-01', 7], ['2026-10-05', 7.5], ['2026-10-09', 8], ['2026-10-13', 8.5]];
  // The newest session is a Push day (a different lift), so the NEXT split is S, whose bench sessions carry the efforts. Repeat opens S.
  const S = C.nextSplit([Object.assign(bench('2026-10-20', [[50, 8]], 'ohp'), { split: 'push' })], undefined);
  const mk = (list) => list.map(([d, r]) => Object.assign(bench(d, [[135, 8, r]]), { split: S })).concat([Object.assign(bench('2026-10-20', [[50, 8]], 'ohp'), { split: 'push' })]);
  const open = (hist) => { const x = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true }); x.click('repeat'); return x; };
  const h = open(mk(dates));
  ok('the lift card shows its RPE trend under the last-time line', /class="wc-last wc-rpe-trend">RPE 7 → 7\.5 → 8 → 8\.5 \(getting harder\)</.test(h.html()), (h.html().match(/wc-rpe-trend[^<]*/) || [''])[0]);
  const none = open(mk(dates.map(([d]) => [d, undefined])));
  ok('control: someone who never logs RPE sees no trend line and no RPE in the notes', !!none.live() && !/wc-rpe-trend/.test(none.html()) && !/at RPE/.test(none.html()));
  const two = open(mk(dates.slice(0, 2)));
  ok('control: two sessions with an RPE is not yet a trend', !/wc-rpe-trend/.test(two.html()));
  ok('the trend text goes through esc() (no raw interpolation)', /esc\(rt\)/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
