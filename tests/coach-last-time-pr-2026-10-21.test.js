/**
 * tests/coach-last-time-pr-2026-10-21.test.js
 *
 * Workout Coach: a read-only "Last time (Oct 14): 185x5, ..." line under each
 * lift's target, and a live trophy on the set that beats the lift's best
 * estimated 1RM (before the workout ends, not only in the summary). Neither
 * changes a number. Pins the real logic and drives the real screen file.
 *
 * Run: node tests/coach-last-time-pr-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

let _n = 0;
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets, extra]) => Object.assign({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps, rpe, warm]) => Object.assign({ weight, reps, rpe, done: true }, warm ? { warm: true } : {})),
    }, extra || {})),
  };
}
const bench = (date, sets) => sess(date, 'push', [['bb_bench', 0, sets]]);

console.log('\n1. lastTime');
{
  const hist = [bench('2026-10-04', [[175, 5, 8]]), bench('2026-10-14', [[185, 5, 8], [185, 5, 8], [185, 4, 9]])];
  const lt = C.lastTime('bb_bench', hist);
  ok('reads the most recent session', lt && lt.date === '2026-10-14');
  ok('text lists the working sets', lt.text === 'Last time (Oct 14): 185×5, 185×5, 185×4', lt && lt.text);
  ok('never-logged lift -> null', C.lastTime('back_squat', hist) === null && C.lastTime('bb_bench', []) === null);
  const warm = [bench('2026-10-14', [[95, 8, 5, true], [185, 5, 8]])];
  ok('warm-ups are left out', C.lastTime('bb_bench', warm).text === 'Last time (Oct 14): 185×5');
  const unfinished = [Object.assign(bench('2026-10-15', [[225, 5, 8]]), { finishedAt: 0 }), bench('2026-10-14', [[185, 5, 8]])];
  ok('an unfinished session is not "last time"', C.lastTime('bb_bench', unfinished).date === '2026-10-14');
  const bw = [sess('2026-10-14', 'pull', [['pullup', 0, [[0, 8, 8], [0, 7, 9]]]])];
  ok('bodyweight shows reps only', C.lastTime('pullup', bw).text === 'Last time (Oct 14): 8 reps, 7 reps', C.lastTime('pullup', bw).text);
  ok('decimal weights stay readable', C.lastTime('db_bench', [sess('2026-10-14', 'push', [['db_bench', 0, [[52.5, 8, 8]]]])]).text === 'Last time (Oct 14): 52.5×8');
}

console.log('\n2. livePR');
{
  const prior = [bench('2026-10-14', [[185, 5, 8]])];            // best e1rm 215.8
  const ex = (sets) => ({ exId: 'bb_bench', sets });
  const tick = (weight, reps, extra) => Object.assign({ weight, reps, done: true }, extra || {});
  ok('a heavier ticked set is a PR', (C.livePR(ex([tick(185, 5), tick(190, 5)]), prior) || {}).index === 1);
  ok('only the best set is flagged', (C.livePR(ex([tick(190, 5), tick(195, 5), tick(190, 5)]), prior) || {}).index === 1);
  ok('equal to the old best is NOT a PR', C.livePR(ex([tick(185, 5)]), prior) === null);
  ok('control: an unticked set never counts', C.livePR(ex([tick(200, 5, { done: false })]), prior) === null);
  ok('a warm-up never counts', C.livePR(ex([tick(300, 5, { warm: true })]), prior) === null);
  ok('no history -> no PR to beat', C.livePR(ex([tick(135, 5)]), []) === null);
  const r = C.livePR(ex([tick(190, 5)]), prior);
  ok('reports the old best to beat', r && Math.round(r.prev) === 216, JSON.stringify(r));
  ok('agrees with the end-of-workout detector', (function () {
    const s = bench('2026-10-20', [[190, 5, 8]]);
    return C.detectPRs(s, prior).length === 1 && C.livePR(s.exercises[0], prior) !== null;
  })());
}

console.log('\n3. the real screen');
{
  const hist = [bench('2026-10-12', [[185, 5, 8], [185, 5, 8]]), bench('2026-10-16', [[185, 5, 8], [185, 5, 8]]),
    sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-20' });
  h.click('set-freshness', { val: 'steady' });
  h.click('start');
  const bi = h.live().exercises.findIndex((e) => e.exId === 'bb_bench');
  const x = h.live().exercises[bi];
  ok('the bench is on', bi >= 0);
  ok('its card shows last time', /class="wc-last">Last time \(Oct 16\): 185×5, 185×5</.test(h.html()), h.html().match(/wc-last[^<]*/g));
  ok('no trophy before any set is ticked', !/wc-pr"/.test(h.html()));
  const wi = x.sets.findIndex((s) => !s.warm);
  h.field('weight', bi, wi, '200'); h.field('reps', bi, wi, '5'); h.click('done', { i: bi, s: wi });
  ok('ticking a heavier set shows the trophy right away', /wc-pr"/.test(h.html()) && (h.html().match(/class="wc-pr"/g) || []).length === 1);
  ok('the numbers are untouched', h.live().exercises[bi].sets[wi].weight === '200' || h.live().exercises[0].sets[wi].weight === 200);
  h.click('done', { i: bi, s: wi });
  ok('un-ticking removes it', !/class="wc-pr"/.test(h.html()));
}

console.log('\n4. wiring');
{
  ok('trophy is a plain span, no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
  ok('the screen only reads (lastTime / livePR)', /C\(\)\.lastTime\(/.test(UI) && /C\(\)\.livePR\(/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
