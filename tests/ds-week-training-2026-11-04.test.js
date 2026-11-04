/**
 * tests/ds-week-training-2026-11-04.test.js
 *
 * The training half of the Sunday review: workouts in the review's week, the PRs set in it (each against the sessions before it),
 * hard sets per muscle this week vs last, and the scorecard lines. Drives the real coach logic.
 *
 * Run: node tests/ds-week-training-2026-11-04.test.js
 */
'use strict';

const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const W = require(path.join(DIR, 'week-training-logic.js'));
const C = require(path.join(DIR, 'workout-coach-logic.js'));

// Wiring checks read source text: strip comments first so a commented-out line can never satisfy one.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
// The review of Sunday 2026-11-01 covers the 7 finished days 2026-10-25 .. 2026-10-31.
const WIN = { from: '2026-10-25', to: '2026-10-31' };
let _n = 0;
function sess(date, exs, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 1000 + (++_n),
    exercises: exs.map(([exId, n, weight], i) => ({ exId, name: exId, slot: i, sets: Array.from({ length: n }, () => ({ weight: weight || 135, reps: 8, rpe: 8, done: true })) })),
  }, extra || {});
}
const run = (hist, o) => W.weekTraining(hist, WIN, Object.assign({ coach: C }, o || {}));

console.log('\n1. workouts and sets in the window');
{
  const hist = [
    sess('2026-10-30', [['bb_bench', 6]]),
    sess('2026-10-27', [['bb_bench', 4]]),
    sess('2026-10-21', [['bb_bench', 5]]),   // the week before
    sess('2026-11-01', [['bb_bench', 9]]),   // after the window: the review never counts it
    sess('2026-10-28', [['bb_bench', 3]], { finishedAt: 0 }), // never finished
  ];
  const t = run(hist, { target: 3 });
  ok('2 workouts in the window', t.workouts === 2, String(t.workouts));
  ok('10 hard sets this week', t.sets === 10, String(t.sets));
  ok('5 hard sets the week before', t.prevSets === 5, String(t.prevSets));
  ok('target passes through', t.target === 3);
  ok('chest row 10 vs 5', t.muscles.length === 1 && t.muscles[0].now === 10 && t.muscles[0].prev === 5 && t.muscles[0].delta === 5, JSON.stringify(t.muscles));
}

console.log('\n2. PRs are each session against the sessions before it');
{
  const hist = [
    sess('2026-10-29', [['bb_bench', 3, 185]]),  // beats 135 from earlier
    sess('2026-10-20', [['bb_bench', 3, 135]]),
    sess('2026-10-26', [['bb_squat', 3, 135]]),  // first time ever: not a record
  ];
  const t = run(hist);
  ok('one PR, the bench', t.prs.length === 1 && t.prs[0].name === 'bb_bench' && t.prs[0].date === '2026-10-29', JSON.stringify(t.prs));
  ok('PR text says what it beat', /est\. 1RM 234 \(was 171\)/.test(t.prs[0].text), t.prs[0] && t.prs[0].text);
  const old = run([sess('2026-10-20', [['bb_bench', 3, 185]]), sess('2026-10-29', [['bb_bench', 3, 135]])]);
  ok('a lighter session after the best is no PR', old.prs.length === 0);
}

console.log('\n3. empty and missing inputs');
{
  const t = run([]);
  ok('no sessions: not enough, nothing listed', !t.enough && t.workouts === 0 && !t.prs.length && !t.muscles.length);
  ok('no coach module: empty, no throw', !W.weekTraining([sess('2026-10-30', [['bb_bench', 6]])], WIN, {}).enough);
  ok('bad window: empty', !W.weekTraining([], { from: 'x', to: 'y' }, { coach: C }).enough);
  ok('no target set: null', run([sess('2026-10-30', [['bb_bench', 6]])]).target === null);
  const hist = [sess('2026-10-30', [['bb_bench', 6]])];
  const before = JSON.stringify(hist);
  run(hist);
  ok('never mutates the history', JSON.stringify(hist) === before);
}

console.log('\n4. scorecard lines');
{
  const hist = [sess('2026-10-29', [['bb_bench', 6, 185]]), sess('2026-10-20', [['bb_bench', 3, 135]])];
  const lines = W.scorecardLines(run(hist, { target: 3 }));
  ok('headline with target and delta', lines[0] === 'Training: 1/3 workouts · 6 hard sets (+3 vs last week)', lines[0]);
  ok('a PR line and a muscle line', lines.some((l) => /^ {2}PR bb_bench/.test(l)) && lines.some((l) => /sets \(\+3\)$/.test(l)), lines.join(' | '));
  ok('quiet week says so', W.scorecardLines(run([]))[0] === 'Training: no finished workouts this week');
}

console.log('\n5. wired into the review screen');
{
  const fs = require('fs');
  const ui = stripComments(fs.readFileSync(path.join(DIR, 'review-ui.js'), 'utf8'));
  const html = stripComments(fs.readFileSync(path.join(DIR, '..', 'index.html'), 'utf8'));
  ok('the sheet shows the training section', /trainingHtml\(w\) \+/.test(ui));
  ok('the copied scorecard and the bot snapshot both carry the training lines', (ui.match(/\.concat\(trainingLines\(x\.week\)\)/g) || []).length === 2);
  ok('the page loads the logic once, versioned', (html.match(/week-training-logic\.js\?v=\d+/g) || []).length === 1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
