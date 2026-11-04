/**
 * tests/ds-heatmap-2026-11-04.test.js
 *
 * The 12-month activity heatmap: a Monday-first grid ending on today's week, shaded by hard sets per day, counting only finished
 * undeleted workouts. Drives the real coach logic. Also pins that the card is wired in without inline style or handlers.
 *
 * Run: node tests/ds-heatmap-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const H = require(path.join(DIR, 'js', 'heatmap-logic.js'));
const C = require(path.join(DIR, 'js', 'workout-coach-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const TODAY = '2026-11-04'; // a Wednesday
let _n = 0;
function sess(date, n, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 1000 + (++_n),
    exercises: [{ exId: 'bb_bench', name: 'bb_bench', slot: 0, sets: Array.from({ length: n }, () => ({ weight: 135, reps: 8, rpe: 8, done: true })) }],
  }, extra || {});
}
const run = (hist, o) => H.heatmap(hist, TODAY, Object.assign({ coach: C }, o || {}));
const cellOf = (h, date) => { for (const col of h.weeks) for (const c of col) if (c && c.date === date) return c; return null; };

console.log('\n1. the grid');
{
  const h = run([]);
  ok('52 weekly columns of 7', h.weeks.length === 52 && h.weeks.every((c) => c.length === 7));
  ok('the last column is today\'s week, Monday first', h.weeks[51][0].date === '2026-11-02' && h.weeks[51][2].date === TODAY);
  ok('days after today are null', h.weeks[51][3] === null && h.weeks[51][6] === null);
  ok('the first column starts 51 weeks before that Monday', h.weeks[0][0].date === '2025-11-10', h.weeks[0][0].date);
  ok('month labels run in order from the first column', h.months[0].col === 0 && h.months.every((m, i, a) => !i || m.col > a[i - 1].col));
  ok('nothing logged: zero totals', h.workouts === 0 && h.activeDays === 0 && h.sets === 0);
}

console.log('\n2. shading and totals');
{
  const hist = [
    sess('2026-11-03', 6), sess('2026-11-03', 5),   // two workouts, 11 sets, one day
    sess('2026-10-20', 20),
    sess('2026-10-01', 30),
    sess('2026-09-01', 1),
    sess('2026-10-15', 12, { deleted: true }),      // deleted
    sess('2026-10-16', 12, { finishedAt: 0 }),      // never finished
    sess('2024-01-01', 12),                         // older than the grid
    sess('2026-11-05', 12),                         // in the future
  ];
  const h = run(hist);
  ok('two workouts on one day add up', cellOf(h, '2026-11-03').sets === 11 && cellOf(h, '2026-11-03').workouts === 2);
  ok('level thresholds: 1 / 11 / 20 / 30 sets', cellOf(h, '2026-09-01').level === 1 && cellOf(h, '2026-11-03').level === 2 && cellOf(h, '2026-10-20').level === 3 && cellOf(h, '2026-10-01').level === 4);
  ok('a quiet day is level 0', cellOf(h, '2026-10-10').level === 0);
  ok('4 training days, 5 workouts', h.activeDays === 4 && h.workouts === 5, h.activeDays + '/' + h.workouts);
  ok('deleted, unfinished, old and future sessions are ignored', !cellOf(h, '2026-10-15').workouts && !cellOf(h, '2026-10-16').workouts && h.sets === 11 + 20 + 30 + 1, String(h.sets));
  ok('best week is the biggest column sum', h.bestWeek === 30, String(h.bestWeek));
  const warm = sess('2026-11-04', 0);
  ok('a finished workout with no hard sets still marks the day (level 1)', cellOf(run([warm]), TODAY).level === 1 && cellOf(run([warm]), TODAY).workouts === 1);
  ok('a one-set workout is still level 1, not 0', H.levelFor(0) === 0 && cellOf(run([sess('2026-11-04', 1)]), TODAY).level === 1);
}

console.log('\n3. missing inputs and purity');
{
  ok('no coach: empty, no throw', H.heatmap([sess(TODAY, 3)], TODAY, {}).weeks.length === 0);
  ok('bad date: empty', H.heatmap([], 'nope', { coach: C }).weeks.length === 0);
  ok('weeks option sizes the grid', run([], { weeks: 8 }).weeks.length === 8);
  const hist = [sess('2026-11-03', 6)];
  const before = JSON.stringify(hist);
  run(hist);
  ok('never mutates the history', JSON.stringify(hist) === before);
}

console.log('\n4. wired in, CSP-safe');
{
  const ui = fs.readFileSync(path.join(DIR, 'js', 'heatmap-ui.js'), 'utf8');
  const pg = fs.readFileSync(path.join(DIR, 'js', 'progress-charts-ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  ok('the grid has a text label for screen readers', /role="img" aria-label="/.test(ui));
  ok('the grid keeps its real size inside a scroll box (labels stay readable)', /class="hm-scroll"><svg class="hm-svg" width=/.test(ui));
  ok('no inline style or handler in the card', !/style=|\son[a-z]+=/.test(ui));
  ok('the Progress card appends it, and refresh redraws only the progress part', /function cardHtml\(\) \{ return progressHtml\(\) \+ heat\(\); \}/.test(pg) && /outerHTML = progressHtml\(\)/.test(pg));
  ok('loaded once each, versioned, before the Progress card script', (html.match(/heatmap-logic\.js\?v=\d+/g) || []).length === 1 && (html.match(/heatmap-ui\.js\?v=\d+/g) || []).length === 1 && at('heatmap-ui.js') < at('progress-charts-ui.js'));
  ok('stylesheet linked once', (html.match(/css\/heatmap\.css\?v=\d+/g) || []).length === 1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
