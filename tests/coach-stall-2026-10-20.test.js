/**
 * tests/coach-stall-2026-10-20.test.js
 *
 * Workout Coach stall detection (tracker ideas #2). If an exercise's best has
 * not improved across its last 3 finished sessions, targetFor() reports a
 * `stall`; the screen shows it on that exercise and offers a 10% deload or a
 * swap. Nothing changes a number until Jo taps. Pins the real logic and drives
 * the real screen file through the DOM stub.
 *
 * Run: node tests/coach-stall-2026-10-20.test.js
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
// exs: [exId, slot, [[weight, reps, rpe, warm?], ...], extra?]
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets, extra]) => Object.assign({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps, rpe, warm]) => Object.assign({ weight, reps, rpe, done: true }, warm ? { warm: true } : {})),
    }, extra || {})),
  };
}
const bench = (date, sets, extra) => sess(date, 'push', [['bb_bench', 0, sets, extra]]);
const stallOf = (sessions, id) => C.stallFor(id || 'bb_bench', sessions);

console.log('\n1. what counts as a stall');
{
  const flat = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 5, 8]]), bench('2026-10-07', [[185, 5, 8]])];
  const s = stallOf(flat);
  ok('185 x 5 three sessions running is a stall', !!s && s.sessions === 3);
  ok('it names the best', s.label === '185 × 5' && s.best.weight === 185 && s.best.reps === 5, JSON.stringify(s));

  const up = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 6, 8]]), bench('2026-10-07', [[185, 7, 8]])];
  ok('control: one more rep each time is NOT a stall', stallOf(up) === null);
  const heavier = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 5, 8]]), bench('2026-10-07', [[190, 5, 8]])];
  ok('control: a heavier last session is NOT a stall', stallOf(heavier) === null);
  const mid = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 6, 8]]), bench('2026-10-07', [[185, 5, 8]])];
  ok('control: an improvement in the middle session means not stalled', stallOf(mid) === null);
  ok('two sessions are not enough', stallOf(flat.slice(1)) === null && stallOf([]) === null);

  const slide = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 4, 9]]), bench('2026-10-07', [[175, 5, 8]])];
  ok('going backwards counts as stalled too', !!stallOf(slide));
  ok('only the LAST 3 matter (an old climb does not hide a stall)', !!stallOf([bench('2026-09-20', [[135, 5, 8]]), bench('2026-09-25', [[165, 5, 8]])].concat(flat)));

  const sets = [bench('2026-10-01', [[185, 5, 8], [185, 4, 9]]), bench('2026-10-04', [[185, 5, 8], [175, 6, 8]]), bench('2026-10-07', [[185, 5, 8]])];
  ok('compares each session by its BEST set', !!stallOf(sets));
  const bw = [sess('2026-10-01', 'pull', [['pullup', 0, [[0, 8, 8]]]]), sess('2026-10-04', 'pull', [['pullup', 0, [[0, 8, 8]]]]), sess('2026-10-07', 'pull', [['pullup', 0, [[0, 8, 8]]]])];
  const b = stallOf(bw, 'pullup');
  ok('bodyweight lifts stall on reps and offer no deload weight', !!b && b.label === '8 reps' && b.deloadWeight === null, JSON.stringify(b));
  ok('control: bodyweight with a rep more is fine', stallOf([bw[0], bw[1], sess('2026-10-07', 'pull', [['pullup', 0, [[0, 9, 8]]]])], 'pullup') === null);
}

console.log('\n2. the deload weight');
{
  const flat = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 5, 8]]), bench('2026-10-07', [[185, 5, 8]])];
  ok('185 -> 165 (10% off, rounded DOWN to loadable plates)', stallOf(flat).deloadWeight === 165);
  const p = C.platesPerSide(165);
  ok('and 165 is loadable exactly', p.remainder === 0);
  const db = [0, 1, 2].map((i) => sess('2026-10-0' + (1 + i), 'push', [['db_bench', 0, [[70, 8, 8]]]]));
  const d = stallOf(db, 'db_bench');
  ok('a dumbbell lift rounds to its own step (70 -> 65)', d && d.deloadWeight === 65, JSON.stringify(d));
  ok('the deload is always lighter than the lift', [95, 135, 225, 315].every((w) => {
    const h = [1, 2, 3].map((i) => bench('2026-10-0' + i, [[w, 5, 8]]));
    const x = stallOf(h); return x && x.deloadWeight < w && x.deloadWeight > 0;
  }));
}

console.log('\n3. warm-ups and deloads');
{
  const warmBoost = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 5, 8]]), bench('2026-10-07', [[300, 5, 5, true], [185, 5, 8]])];
  ok('a heavy warm-up does not hide a stall', !!stallOf(warmBoost));
  const unflagged = warmBoost.map((s) => JSON.parse(JSON.stringify(s)));
  unflagged[2].exercises[0].sets.forEach((st) => { delete st.warm; });
  ok('control: the same set unflagged DOES look like progress', stallOf(unflagged) === null);
  const warmOnly = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 5, 8]]), bench('2026-10-07', [[135, 5, 5, true]])];
  ok('a warm-up-only appearance is not a session of that lift', stallOf(warmOnly) === null);

  const stalled = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 5, 8]]), bench('2026-10-07', [[185, 5, 8]])];
  const after = stalled.concat([bench('2026-10-10', [[165, 8, 7]], { deload: true })]);
  ok('after a saved deload the stall clears', stallOf(after) === null);
  const two = after.concat([bench('2026-10-13', [[170, 8, 7]]), bench('2026-10-16', [[170, 8, 7]])]);
  ok('...and still clear two sessions later', stallOf(two) === null);
  const three = two.concat([bench('2026-10-19', [[170, 8, 7]])]);
  ok('...and can flag again after 3 fresh sessions', !!stallOf(three));
  const noMark = stalled.concat([bench('2026-10-10', [[165, 8, 7]])]);
  ok('control: without the deload mark, the lighter session still reads as stalled', !!stallOf(noMark));
}

console.log('\n4. targetFor reports it, never changes the numbers');
{
  const flat = [bench('2026-10-01', [[185, 5, 8]]), bench('2026-10-04', [[185, 5, 8]]), bench('2026-10-07', [[185, 5, 8]])];
  const t = C.targetFor('bb_bench', [5, 8], flat);
  const lastOnly = C.targetFor('bb_bench', [5, 8], flat.slice(2));
  ok('stalled history carries target.stall', t.stall && t.stall.deloadWeight === 165);
  ok('weight, reps and note are exactly what the last session alone gives', t.weight === lastOnly.weight && t.reps === lastOnly.reps && t.note === lastOnly.note, JSON.stringify([t, lastOnly]));
  ok('control: a healthy lift has no stall key at all', !('stall' in C.targetFor('bb_bench', [5, 8], flat.slice(2))));
  ok('a never-done lift has no stall key', !('stall' in C.targetFor('bb_bench', [5, 8], [])));
  const built = C.buildSession('push', flat.concat([sess('2026-10-08', 'legs', [['back_squat', 0, [[225, 5, 8]]]])]), { today: '2026-10-20', seed: 1, freshness: 'steady' });
  ok('buildSession carries it onto the exercise target without touching its sets', built.exercises[0].exId === 'bb_bench' && built.exercises[0].target.stall && built.exercises[0].sets.every((s) => s.weight === 185));
}

console.log('\n5. the real screen');
{
  const hist = [bench('2026-10-12', [[185, 5, 8]]), bench('2026-10-14', [[185, 5, 8]]), bench('2026-10-16', [[185, 5, 8]]),
    sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-20' });
  h.click('set-freshness', { val: 'steady' });
  h.click('start');
  let x = h.live().exercises[0];
  ok('the bench is back on, with the stall note on its card', x.exId === 'bb_bench' && /wc-stall/.test(h.html()) && /Same best \(185 × 5\) for 3 sessions/.test(h.html()));
  ok('both options are offered, with the deload number shown', /Deload to 165 lb/.test(h.html()) && />Swap it</.test(h.html()));
  ok('NOTHING changed yet: working sets still 185', x.sets.filter((s) => !s.warm).every((s) => s.weight === 185) && x.target.weight === 185);
  ok('other lifts show no banner', (h.html().match(/class="wc-stall"/g) || []).length === 1);

  h.click('deload', { i: 0 });
  x = h.live().exercises[0];
  ok('Deload sets the working sets to 165', x.sets.filter((s) => !s.warm).length === 4 && x.sets.filter((s) => !s.warm).every((s) => s.weight === 165));
  ok('the target note says it is a deload, and the stall note is gone', /^Deload: 165 lb/.test(x.target.note) && x.deload === true && !/wc-stall"/.test(h.html()));
  ok('warm-ups were re-made under the new weight', x.sets.some((s) => s.warm) && x.sets.filter((s) => s.warm).every((s) => s.weight < 165));
  ok('the exercise count and order are unchanged', h.live().exercises[0].exId === 'bb_bench');

  const wi = x.sets.findIndex((s) => !s.warm);
  h.field('reps', 0, wi, '8'); h.click('done', { i: 0, s: wi });
  h.click('finish');
  const saved = h.saved()[0];
  ok('the saved bench is marked deload:true', saved.exercises[0].deload === true);
  const all = h.saved();
  ok('the lift is no longer flagged as stalled', C.stallFor('bb_bench', all) === null);

  // a second run where Jo ignores it
  const h2 = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-20' });
  h2.click('set-freshness', { val: 'steady' });
  h2.click('start');
  const wi2 = h2.live().exercises[0].sets.findIndex((s) => !s.warm);
  h2.field('reps', 0, wi2, '5'); h2.click('done', { i: 0, s: wi2 });
  ok('once a set is logged the banner stops nagging', !/class="wc-stall"/.test(h2.html()) || (h2.html().match(/class="wc-stall"/g) || []).length === 0);
  h2.click('deload', { i: 0 });
  ok('and a late Deload tap does nothing', h2.live().exercises[0].sets.filter((s) => !s.warm).every((s) => s.weight === 185));
}

console.log('\n6. wiring');
{
  ok('deload is only ever applied from a tap (case \'deload\')', /case 'deload'/.test(UI));
  ok('finish keeps the deload mark', /x\.deload \? \{ deload: true \} : \{\}/.test(UI));
  ok('swap and avoid pass the plate settings so deload weights are loadable', (UI.match(/\{ plates: /g) || []).length >= 2);
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
