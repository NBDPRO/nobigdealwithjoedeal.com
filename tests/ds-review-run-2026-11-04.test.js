/**
 * tests/ds-review-run-2026-11-04.test.js
 *
 * Runs review-ui.js (the Sunday review) in a vm against a fake page, with the real review / training / coach logic and fake storage,
 * instead of searching its source: the copied scorecard carries the Training lines when workouts exist, drops them when none do or
 * when the training modules are missing, and a broken workouts store never breaks the scorecard.
 *
 * Run: node tests/ds-review-run-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const src = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

// Wednesday 2026-11-04: the review covers the week that just finished, Mon 2026-10-26 .. Sun 2026-11-01.
function boot(o) {
  const store = Object.assign({}, o.storage || {});
  const win = {
    todayKey: () => '2026-11-04',
    prompt: () => {}, toast: () => {},
  };
  const doc = {
    readyState: 'complete', body: { classList: { add() {}, remove() {} } },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
  };
  const ctx = {
    window: win, document: doc, pages: [], getFloors: () => [],
    localStorage: { getItem: (k) => { if (o.badStorage && k === 'nbd_ds_workouts') throw new Error('blocked'); return k in store ? store[k] : null; }, setItem: (k, v) => { store[k] = v; } },
    navigator: {}, console, JSON, Math, Date, Number, String, Array, Object, Map, Set, Promise, setTimeout, clearTimeout,
  };
  win.window = win;
  Object.assign(win, ctx);
  ctx.window = win;
  vm.createContext(ctx);
  const load = (f) => vm.runInContext(src(f), ctx, { filename: f });
  load('review-logic.js');
  if (!o.noTraining) { load('workout-coach-logic.js'); load('week-training-logic.js'); }
  if (win.NBDCoach === undefined && ctx.NBDCoach !== undefined) win.NBDCoach = ctx.NBDCoach;
  load('review-ui.js');
  return win;
}
const sess = (date, n) => ({
  id: 's' + date, date, split: 'push', startedAt: 1, finishedAt: 2000,
  exercises: [{ exId: 'bb_bench', name: 'Bench', slot: 0, sets: Array.from({ length: n }, () => ({ weight: 135, reps: 8, rpe: 8, done: true })) }],
});
const withWorkouts = { nbd_ds_workouts: JSON.stringify([sess('2026-10-29', 5)]) };

console.log('\n1. the scorecard carries the training lines');
{
  const w = boot({ storage: withWorkouts });
  ok('the review UI mounted', !!w.NBDReviewUI && typeof w.NBDReviewUI.scorecard === 'function');
  let text = '';
  try { text = w.NBDReviewUI.scorecard(); } catch (e) { text = 'THREW ' + e.message; }
  ok('the scorecard has the Training line and the muscle line', /^Training: 1 workouts · 5 hard sets \(\+5 vs last week\)$/m.test(text) && /^ {2}Chest: 5 sets \(\+5\)$/m.test(text), text.slice(0, 300));
}

console.log('\n2. no workouts, or no training modules');
{
  const none = boot({ storage: {} }).NBDReviewUI.scorecard();
  const mod = boot({ storage: withWorkouts, noTraining: true }).NBDReviewUI.scorecard();
  const withT = boot({ storage: withWorkouts }).NBDReviewUI.scorecard();
  ok('with no workouts it says so', /^Training: no finished workouts this week$/m.test(none), none);
  ok('without the training modules the Training section is simply absent', !/^Training:/m.test(mod) && mod.length > 0, mod);
  ok('with workouts the Training section is present', /^Training: \d+ workouts/m.test(withT));
}

console.log('\n3. a broken store');
{
  let text = null;
  try { text = boot({ storage: withWorkouts, badStorage: true }).NBDReviewUI.scorecard(); } catch (e) { text = null; }
  ok('blocked workouts storage still gives a scorecard', typeof text === 'string' && text.length > 0);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
