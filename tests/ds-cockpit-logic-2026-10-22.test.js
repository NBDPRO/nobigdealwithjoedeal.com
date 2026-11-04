/**
 * tests/ds-cockpit-logic-2026-10-22.test.js
 *
 * The Cockpit layout's tile row: workouts and hard sets this week, training streak, level. Combines the real coach logic and the real
 * XP logic; pins each tile's number and sub-line, the empty / missing-module cases, and that it never mutates the history.
 *
 * Run: node tests/ds-cockpit-logic-2026-10-22.test.js
 */
'use strict';

const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const CK = require(path.join(DIR, 'cockpit-logic.js'));
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const X = require(path.join(DIR, 'xp-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const TODAY = '2026-10-22';
let _n = 0;
function sess(date, exs, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 1000 + (++_n),
    exercises: exs.map(([exId, n], i) => ({ exId, name: exId, slot: i, sets: Array.from({ length: n }, () => ({ weight: 135, reps: 8, rpe: 8, done: true })) })),
  }, extra || {});
}
const tile = (r, id) => r.tiles.find((t) => t.id === id);
const run = (sessions, o) => CK.cockpit(sessions, TODAY, Object.assign({ coach: C, xp: X }, o || {}));

console.log('\n1. the tiles');
{
  const hist = [
    sess('2026-10-21', [['bb_bench', 6], ['incline_db', 3]]),   // this week: 9 sets
    sess('2026-10-19', [['bb_bench', 4]]),                      // this week: 4 sets
    sess('2026-10-13', [['bb_bench', 5]]),                      // last week: 5 sets
    sess('2026-09-01', [['bb_bench', 20]]),                     // long ago: neither week
  ];
  const r = run(hist);
  ok('four tiles in order: workouts, hard sets, training streak, level', r.tiles.map((t) => t.id).join() === 'sessions,sets,streak,level');
  ok('Workouts = finished sessions in the last 7 days (2), sub says the window', tile(r, 'sessions').value === '2' && tile(r, 'sessions').sub === 'last 7 days');
  ok('Hard sets = this week\'s working sets (13), with the change vs last week (+8)', tile(r, 'sets').value === '13' && tile(r, 'sets').sub === '+8 vs last week', JSON.stringify(tile(r, 'sets')));
  ok('a drop vs last week is shown with a minus', tile(run([sess('2026-10-21', [['bb_bench', 6]]), sess('2026-10-13', [['bb_bench', 9]])]), 'sets').sub === '-3 vs last week');
  ok('no change reads 0 (not +0)', tile(run([sess('2026-10-21', [['bb_bench', 6]]), sess('2026-10-13', [['bb_bench', 6]])]), 'sets').sub === '0 vs last week');
  ok('Training streak counts days in a row with a rest day bridged: 19, 21 then today open = 2', tile(r, 'streak').value === '2');
  ok('streak sub: "best N" when the best run is longer than the current one', tile(run([sess('2026-09-01', [['bb_bench', 2]]), sess('2026-09-02', [['bb_bench', 2]]), sess('2026-09-03', [['bb_bench', 2]]), sess('2026-10-21', [['bb_bench', 2]])]), 'streak').sub === 'best 3');
  ok('streak sub: "train soon" when one more empty day would break it', tile(CK.cockpit([sess('2026-10-20', [['bb_bench', 2]])], '2026-10-22', { coach: C, xp: X }), 'streak').sub === 'train soon');
  ok('streak sub: "on a roll" when current is the best and nothing is at risk', tile(run([sess('2026-10-21', [['bb_bench', 2]]), sess('2026-10-22', [['bb_bench', 2]])]), 'streak').sub === 'on a roll');
  const lv = X.levelFor(X.xpTotals(hist, { coach: C }).total);
  ok('Level tile = the XP module\'s level and progress (workout XP only)', tile(r, 'level').value === 'Lv ' + lv.level && tile(r, 'level').sub === lv.into + ' / ' + lv.need + ' XP', JSON.stringify(tile(r, 'level')));
}

console.log('\n2. behind, empty and missing pieces');
{
  const r = run([sess('2026-10-21', [['bb_bench', 6], ['incline_db', 3]])]);
  ok('behind lists the muscles that are zero or low this week (back and legs are untouched)', r.enough === true && r.behind.includes('back') && r.behind.includes('quads') && !r.behind.includes('chest'), r.behind.join());
  const empty = run([]);
  ok('no history: zeros, not enough, nothing behind, no NaN or undefined', empty.enough === false && empty.behind.length === 0 && tile(empty, 'sessions').value === '0' && tile(empty, 'sets').value === '0' && tile(empty, 'streak').value === '0' && tile(empty, 'streak').sub === 'start one today' && tile(empty, 'level').value === 'Lv 1' && !/NaN|undefined/.test(JSON.stringify(empty)));
  ok('with no sets in either week the sets tile just says "last 7 days" (no "0 vs last week" noise)', tile(empty, 'sets').sub === 'last 7 days');
  ok('a thin week (under 6 sets) is not "enough" so nothing is flagged behind', run([sess('2026-10-21', [['bb_bench', 3]])]).behind.length === 0);
  ok('missing the coach or XP module gives an empty row instead of throwing', CK.cockpit([], TODAY, { xp: X }).tiles.length === 0 && CK.cockpit([], TODAY, { coach: C }).tiles.length === 0 && CK.cockpit([], TODAY).tiles.length === 0 && CK.cockpit([], TODAY, undefined).tiles.length === 0);
  ok('unfinished and deleted sessions are not counted anywhere', tile(run([sess('2026-10-21', [['bb_bench', 6]], { finishedAt: 0 }), sess('2026-10-20', [['bb_bench', 6]], { deleted: true })]), 'sessions').value === '0');
  const dumb = run([sess('2026-10-21', [['bb_bench', 8]])], { equip: ['dumbbell'] });
  ok('equipment is passed through: with dumbbells only, a lift group you cannot train is never "behind"', !dumb.behind.includes('triceps') && !dumb.behind.includes('calves'), dumb.behind.join());
  const hist = [sess('2026-10-21', [['bb_bench', 6]])];
  const before = JSON.stringify(hist);
  run(hist);
  ok('read-only: the sessions are not mutated', JSON.stringify(hist) === before);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
