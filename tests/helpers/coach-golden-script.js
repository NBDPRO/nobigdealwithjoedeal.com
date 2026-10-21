/**
 * tests/helpers/coach-golden-script.js — a fixed, fully scripted workout driven
 * through the REAL Workout Coach screen with a frozen clock, and a digest of
 * everything observable about it that is NOT markup: the live session after
 * every tap, the rest-timer text, the toasts and the saved session. It never
 * pairs two exercises, so it is the "non-superset path". The superset PR
 * recorded this digest BEFORE it touched the logger; the test pins that the
 * digest is unchanged after.
 *
 * Re-bless on purpose only (a deliberate change to the plain logger):
 *   node tests/helpers/coach-golden-script.js     (prints the new digest)
 */
'use strict';

const crypto = require('crypto');
const { makeHarness } = require('./coach-ui-harness.js');

let _n = 0;
function sess(date, split, exs) {
  return {
    id: 'g' + (++_n), date, split, startedAt: 1, finishedAt: 100 + (++_n),
    exercises: exs.map(([exId, slot, sets]) => ({
      exId, name: exId, slot,
      sets: sets.map(([weight, reps, rpe]) => ({ weight, reps, rpe, done: true })),
    })),
  };
}
const bench = (date, w) => sess(date, 'push', [['bb_bench', 0, [[w, 8, 7], [w, 8, 7], [w, 8, 7], [w, 8, 7]]]]);
const HIST = [bench('2026-10-12', 175), bench('2026-10-14', 180), bench('2026-10-16', 185), sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];

function run() {
  const h = makeHarness({ storage: { nbd_ds_workouts: HIST }, today: '2026-10-20', freeze: true });
  const snaps = [];
  const rest = () => { const m = h.html().match(/<div class="wc-rest"[^>]*>([\s\S]*?)<\/div>/); return m ? m[1] : null; };
  const snap = (label) => snaps.push(JSON.stringify([label, h.live(), rest(), h.toasts.length]));
  const step = (label, fn) => { fn(); snap(label); };

  step('freshness', () => h.click('set-freshness', { val: 'steady' }));
  step('start', () => h.click('start'));
  const x0 = () => h.live().exercises[0];
  const firstWork = () => x0().sets.findIndex((s) => !s.warm);
  step('warm-up 1 done', () => h.click('done', { i: 0, s: 0 }));
  step('warm-up 2 done', () => h.click('done', { i: 0, s: 1 }));
  step('bench w1 weight', () => h.field('weight', 0, firstWork(), '190'));
  step('bench w1 reps', () => h.field('reps', 0, firstWork(), '8'));
  step('bench w1 rpe', () => h.field('rpe', 0, firstWork(), '7.5'));
  step('bench w1 done', () => h.click('done', { i: 0, s: firstWork() }));
  step('bench w1 untick', () => h.click('done', { i: 0, s: firstWork() }));
  step('bench w1 done again', () => h.click('done', { i: 0, s: firstWork() }));
  step('bench add set', () => h.click('add-set', { i: 0 }));
  step('ex1 set1 reps', () => h.field('reps', 1, 0, '10'));
  step('ex1 set1 done', () => h.click('done', { i: 1, s: 0 }));
  step('ex2 set1 done (empty reps -> target)', () => h.click('done', { i: 2, s: 0 }));
  step('ex2 set2 done', () => h.click('done', { i: 2, s: 1 }));
  step('ex2 set3 done', () => h.click('done', { i: 2, s: 2 }));
  step('open swap on ex3', () => h.click('swap', { i: 3 }));
  step('swap ex3', () => { const m = h.html().match(/data-coach-action="swap-to" data-i="3" data-ex="([a-z_]+)"/); if (m) h.click('swap-to', { i: 3, ex: m[1] }); });
  step('reroll', () => h.click('reroll'));
  step('switch to pull (armed)', () => h.click('split', { split: 'pull' }));
  step('switch to pull (confirm)', () => h.click('split', { split: 'pull' }));
  step('pull ex0 reps', () => h.field('reps', 0, 0, '7'));
  step('pull ex0 done', () => h.click('done', { i: 0, s: 0 }));
  step('skip rest', () => h.click('skip-rest'));
  step('finish', () => h.click('finish'));
  snaps.push(JSON.stringify(['saved', h.saved()[0]]));
  snaps.push(JSON.stringify(['toasts', h.toasts]));
  return { digest: crypto.createHash('sha1').update(snaps.join('\n')).digest('hex'), steps: snaps.length };
}

module.exports = { run, HIST };
if (require.main === module) console.log(JSON.stringify(run()));
