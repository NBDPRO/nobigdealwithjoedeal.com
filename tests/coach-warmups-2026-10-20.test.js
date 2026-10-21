/**
 * tests/coach-warmups-2026-10-20.test.js
 *
 * Workout Coach warm-up sets (tracker ideas #3). The first heavy compound of
 * a day gets warm-up rows (bar, then 40 / 60 / 80% of the first working set,
 * rounded down to makeable plate weights) flagged `warm: true`.
 *
 * HARD REQUIREMENT pinned here: a warm-up set must never count toward
 * workingSets(), volume(), est. 1RM, PRs, targets, variety, the old-page rows
 * from toPageRows(), the Progress card (liftSeries / topLifts / weeklyVolume)
 * or the finished-workout check. Every guard has a negative control: the very
 * same set WITHOUT the warm flag does change the number.
 *
 * Run: node tests/coach-warmups-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const P = require(path.join(DIR, 'progress-charts-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let _n = 0;
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets]) => ({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps, rpe, warm]) => Object.assign({ weight, reps, rpe, done: true }, warm ? { warm: true } : {})),
    })),
  };
}
const strip = (s) => JSON.parse(JSON.stringify(s), (k, v) => v); // deep copy
const unflag = (s) => { const c = strip(s); c.exercises.forEach((x) => x.sets.forEach((st) => { delete st.warm; })); return c; };

console.log('\n1. warmupSets: the rows');
{
  const w = C.warmupSets('bb_bench', 225);
  ok('225 lb bench: bar, 90, 135, 180', same(w.map((r) => r.weight), [45, 90, 135, 180]), JSON.stringify(w));
  ok('reps taper 8 / 5 / 3 / 2', same(w.map((r) => r.reps), [8, 5, 3, 2]));
  const all = [135, 185, 225, 275, 315, 95, 155];
  let bad = 0;
  for (const target of all) {
    const rows = C.warmupSets('bb_bench', target);
    let prev = 0;
    for (const r of rows) {
      const p = C.platesPerSide(r.weight);
      if (!(r.weight > prev && r.weight < target) || p.remainder !== 0 || p.achieved !== r.weight) bad++;
      prev = r.weight;
    }
  }
  ok('every row is strictly rising, below the work weight, and loads exactly on the plates', bad === 0, bad + ' bad');
  ok('a 35 lb bar starts at 35', C.warmupSets('bb_bench', 135, { bar: 35 })[0].weight === 35);
  const db = C.warmupSets('db_bench', 80);
  ok('dumbbell lift: no bar row, steps of 5 (30 / 45 / 60)', same(db.map((r) => r.weight), [30, 45, 60]), JSON.stringify(db));
  ok('weight at or under the bar -> none', C.warmupSets('bb_bench', 45).length === 0 && C.warmupSets('bb_bench', 40).length === 0);
  ok('no weight (new lift) -> none', C.warmupSets('bb_bench', null).length === 0 && C.warmupSets('bb_bench', 0).length === 0 && C.warmupSets('bb_bench', '').length === 0);
  ok('a non-compound (cable fly) -> none', C.warmupSets('cable_fly', 100).length === 0);
  ok('a light dumbbell weight (under 20) -> none', C.warmupSets('db_bench', 15).length === 0);
  ok('unknown exercise -> none', C.warmupSets('nope', 200).length === 0);
}

console.log('\n2. warm-ups never count (each guard has a negative control)');
{
  // Working 135 x 5; warm-up flagged at 225 x 10 — heavier + higher volume than the work.
  const withWarm = sess('2026-10-18', 'push', [['bb_bench', 0, [[225, 10, 5, true], [135, 5, 8]]]]);
  const noFlag = unflag(withWarm);
  const exW = withWarm.exercises[0], exN = noFlag.exercises[0];

  ok('workingSets drops the warm-up', C.volume(withWarm).sets === 1);
  ok('control: unflagged, the same set is a working set', C.volume(noFlag).sets === 2);

  ok('volume() = working only (135 x 5 = 675)', C.volume(withWarm).lbs === 675);
  ok('control: unflagged volume includes it (675 + 2250)', C.volume(noFlag).lbs === 2925);

  ok('est. 1RM (bestE1rm) ignores it', C.bestE1rm('bb_bench', [withWarm]) === C.e1rm(135, 5));
  ok('control: unflagged, the 225 x 10 set sets the best', C.bestE1rm('bb_bench', [noFlag]) === C.e1rm(225, 10));

  const prior = [sess('2026-10-10', 'push', [['bb_bench', 0, [[135, 5, 8]]]])];
  ok('detectPRs: a heavier warm-up is not a PR', C.detectPRs(withWarm, prior).length === 0);
  ok('control: unflagged, it IS a PR', C.detectPRs(noFlag, prior).length === 1);

  const warmOnly = sess('2026-10-18', 'push', [['bb_bench', 0, [[225, 10, 5, true]]]]);
  ok('detectPRs: a warm-up-only exercise yields no PR', C.detectPRs(warmOnly, prior).length === 0);
  ok('historyOf skips a warm-up-only appearance', C.historyOf('bb_bench', [warmOnly]).length === 0);
  ok('control: unflagged, it is in the history', C.historyOf('bb_bench', [unflag(warmOnly)]).length === 1);

  const t = C.targetFor('bb_bench', [5, 8], [withWarm]);
  ok('targetFor builds from the working sets (135), not the warm-up', t.weight === 135, JSON.stringify(t));
  const tc = C.targetFor('bb_bench', [5, 8], [noFlag]);
  ok('control: unflagged, the target is built off the 225 set', tc.weight > 200, JSON.stringify(tc));
  ok('targetFor on a warm-up-only history says "New"', /^New/.test(C.targetFor('bb_bench', [5, 8], [warmOnly]).note));

  ok('variety() does not count a warm-up-only exercise', C.variety([warmOnly], '2026-10-20', 28).total === 0);
  ok('control: unflagged, variety counts it', C.variety([unflag(warmOnly)], '2026-10-20', 28).total === 1);

  const rows = C.toPageRows(withWarm);
  ok('toPageRows (old Exercise Log): 1 set, 5 reps, 135 lb', rows.length === 1 && rows[0].sets === '1' && rows[0].reps === '5' && rows[0].weight === '135', JSON.stringify(rows));
  ok('toPageRows: a warm-up-only exercise writes no row', C.toPageRows(warmOnly).length === 0);
  const rowsN = C.toPageRows(noFlag);
  ok('control: unflagged rows show 2 sets and 225 lb', rowsN[0].sets === '2' && rowsN[0].weight === '225');

  // Progress card
  const series = P.liftSeries('bb_bench', [withWarm]);
  ok('Progress liftSeries: the point is the 135 x 5 set', series.length === 1 && series[0].weight === 135 && series[0].reps === 5, JSON.stringify(series));
  ok('control: unflagged, the point is 225 x 10... capped by the 12-rep rule, so 225', P.liftSeries('bb_bench', [noFlag])[0].weight === 225);
  ok('Progress topLifts ignores a warm-up-only lift', P.topLifts([warmOnly], '2026-10-20', 6).length === 0);
  ok('control: unflagged, it is listed', P.topLifts([unflag(warmOnly)], '2026-10-20', 6).length === 1);
  ok('Progress liftSeries: warm-up-only lift has no points', P.liftSeries('bb_bench', [warmOnly]).length === 0);
  const tot = (w) => ({ lbs: w.reduce((n, x) => n + x.lbs, 0), sets: w.reduce((n, x) => n + x.sets, 0) });
  const wk = tot(P.weeklyVolume([withWarm], '2026-10-20', 2));
  const wkN = tot(P.weeklyVolume([noFlag], '2026-10-20', 2));
  ok('Progress weeklyVolume: lbs/sets are working-only', wk.lbs === 675 && wk.sets === 1, JSON.stringify(wk));
  ok('control: unflagged weekly volume is bigger', wkN.lbs === 2925 && wkN.sets === 2, JSON.stringify(wkN));
  ok('exercise object untouched (flag kept on the saved set)', exW.sets[0].warm === true && exN.sets[0].warm === undefined);
}

console.log('\n3. buildSession puts warm-ups on the first compound only');
{
  const hist = [sess('2026-10-18', 'push', [['bb_bench', 0, [[185, 5, 8], [185, 5, 8], [185, 5, 8]]]])];
  const b = C.buildSession('push', hist, { today: '2026-10-20', seed: 1, warmups: true });
  const first = b.exercises[0];
  const warm = first.sets.filter((s) => s.warm);
  ok('anchor is the held bench with a 185 target', first.exId === 'bb_bench' && first.target.weight === 185);
  ok('warm-ups: 45 / 70 / 110 / 145, ahead of the work', same(warm.map((s) => s.weight), [45, 70, 110, 145]) && first.sets.slice(0, 4).every((s) => s.warm));
  ok('working sets unchanged (4 at 185)', first.sets.filter((s) => !s.warm).length === 4 && first.sets.filter((s) => !s.warm).every((s) => s.weight === 185));
  ok('warm rows carry a planned rep count and start undone', warm.every((s) => s.plan > 0 && s.done === false && s.reps === ''));
  ok('no other slot gets warm-ups', b.exercises.slice(1).every((x) => !x.sets.some((s) => s.warm)));
  const off = C.buildSession('push', hist, { today: '2026-10-20', seed: 1 });
  const off2 = C.buildSession('push', hist, { today: '2026-10-20', seed: 1, warmups: false });
  ok('default (no option) builds NO warm-ups and the old set counts', off.exercises.every((x) => !x.sets.some((s) => s.warm)) && off.exercises[0].sets.length === 4);
  ok('warmups:false is identical to the default build', same(off, off2));
  ok('with warm-ups the working part equals the default build', same(first.sets.filter((s) => !s.warm), off.exercises[0].sets));
  const fresh = C.buildSession('push', [], { today: '2026-10-20', seed: 1, warmups: true });
  ok('a brand-new lift (no target weight) gets none', fresh.exercises.every((x) => !x.sets.some((s) => s.warm)));
}

console.log('\n4. the real screen: warm-ups are rows, never work');
{
  const hist = [sess('2026-10-18', 'push', [['bb_bench', 0, [[185, 5, 8], [185, 5, 8], [185, 5, 8]]]]), sess('2026-10-19', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-20' });
  h.click('start');
  let live = h.live();
  const x0 = live.exercises[0];
  const nWarm = x0.sets.filter((s) => s.warm).length;
  ok('start builds the live session with 4 warm-up rows on the bench', x0.exId === 'bb_bench' && nWarm === 4);
  ok('the header counts working sets only (0/' + live.exercises.reduce((n, x) => n + x.sets.filter((s) => !s.warm).length, 0) + ')', /<small>0\/\d+ sets<\/small>/.test(h.html()));
  const totalAll = live.exercises.reduce((n, x) => n + x.sets.length, 0);
  ok('control: the total shown is NOT the raw row count', !new RegExp('0/' + totalAll + ' sets').test(h.html()));
  ok('warm rows are labelled W in the screen', (h.html().match(/<span class="wc-n">W<\/span>/g) || []).length === 4);

  h.click('done', { i: 0, s: 0 }); h.click('done', { i: 0, s: 1 });
  ok('ticking two warm-ups leaves the counter at 0 working sets done', /<small>0\/\d+ sets<\/small>/.test(h.html()));
  h.click('finish');
  ok('finish with only warm-ups refuses ("Log at least one set first")', h.toasts.includes('Log at least one set first') && h.saved().length === 2);

  // now one real working set
  const wi = x0.sets.findIndex((s) => !s.warm);
  h.field('reps', 0, wi, '5'); h.field('weight', 0, wi, '185');
  h.click('done', { i: 0, s: wi });
  ok('a working set done moves the counter to 1', /<small>1\/\d+ sets<\/small>/.test(h.html()));
  h.click('finish');
  const saved = h.saved();
  ok('finish saved a new session', saved.length === 3 && saved[0].exercises.length >= 1);
  const ex = saved[0].exercises[0];
  const kept = ex.sets.filter((s) => s.warm);
  ok('the two ticked warm-ups are saved WITH warm:true', kept.length === 2 && kept.every((s) => s.warm === true && s.done === true), JSON.stringify(ex.sets));
  ok('saved volume counts only the working set (185 x 5)', C.volume(saved[0]).sets === 1 && C.volume(saved[0]).lbs === 925, JSON.stringify(C.volume(saved[0])));
  ok('saved old-page row is 1 set / 5 reps / 185', (() => { const r = C.toPageRows(saved[0])[0]; return r.sets === '1' && r.reps === '5' && r.weight === '185'; })());
  ok('no PR from the warm-ups (a 145 x 2 warm-up cannot beat 185 x 5)', C.detectPRs(saved[0], hist).length === 0);
  ok('next target still builds off the working weight', C.targetFor('bb_bench', [5, 8], saved).weight === 185);
}

console.log('\n5. swap keeps the math honest; the setting turns them off');
{
  const hist = [sess('2026-10-18', 'push', [['bb_bench', 0, [[185, 5, 8], [185, 5, 8], [185, 5, 8]]], ['db_bench', 1, [[70, 8, 8]]]]), sess('2026-10-19', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist } });
  h.click('start');
  h.click('swap-to', { i: 0, ex: 'db_bench' });
  const x = h.live().exercises[0];
  ok('swapping the anchor to dumbbell bench regenerates warm-ups for it', x.exId === 'db_bench' && x.sets.some((s) => s.warm), JSON.stringify(x.sets.map((s) => [s.weight, !!s.warm])));
  ok('working set count is unchanged by the swap (4)', x.sets.filter((s) => !s.warm).length === 4);
  ok('warm weights are below the new target weight', x.sets.filter((s) => s.warm).every((s) => s.weight < x.target.weight));

  const off = makeHarness({ storage: { nbd_ds_workouts: hist } });
  off.click('set-warmups', { val: 'off' });
  off.click('start');
  ok('with warm-ups switched off there are none', off.live().exercises.every((e) => !e.sets.some((s) => s.warm)));
  ok('the setting is saved in the coach settings', off.settings() && off.settings().warmups === false);
}

console.log('\n6. wiring');
{
  ok('finish keeps the warm flag on saved sets', /st\.warm \? \{ warm: true \} : \{\}/.test(UI));
  ok('finish ignores warm-ups when deciding there was a set', /!st\.warm && \(st\.done \|\| parseFloat\(st\.reps\) > 0\)/.test(UI));
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
  const logicSrc = fs.readFileSync(path.join(DIR, 'workout-coach-logic.js'), 'utf8');
  ok('workingSets itself filters warm sets', /function workingSets[\s\S]{0,200}!s\.warm/.test(logicSrc));
  const progSrc = fs.readFileSync(path.join(DIR, 'progress-charts-logic.js'), 'utf8');
  ok('the Progress card has its own set filter and it drops warm sets too', /const done = [^\n]*!s\.warm/.test(progSrc));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
