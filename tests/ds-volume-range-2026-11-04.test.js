/**
 * tests/ds-volume-range-2026-11-04.test.js
 *
 * The volume map over a week / 30 days / 90 days / all time: hard sets per muscle as a weekly average against the 10-20 band, with the
 * window before it as the comparison. Drives the real coach logic; 'week' must equal the coach's own volumeMap.
 *
 * Run: node tests/ds-volume-range-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const V = require(path.join(DS, 'js', 'volume-range-logic.js'));
const C = require(path.join(DS, 'js', 'workout-coach-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const TODAY = '2026-11-04';
let _n = 0;
function sess(date, exs, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 1000 + (++_n),
    exercises: exs.map(([exId, n], i) => ({ exId, name: exId, slot: i, sets: Array.from({ length: n }, () => ({ weight: 135, reps: 8, rpe: 8, done: true })) })),
  }, extra || {});
}
const run = (hist, range, o) => V.volumeRange(hist, TODAY, range, Object.assign({ coach: C }, o || {}));
const row = (v, m) => v.rows.find((r) => r.muscle === m);

console.log('\n1. week is the coach\'s own volume map');
{
  const hist = [sess('2026-11-03', [['bb_bench', 12], ['bb_row', 4]]), sess('2026-10-30', [['bb_squat', 8]]), sess('2026-10-28', [['bb_bench', 5]])];
  const w = run(hist, 'week'), m = C.volumeMap(hist, TODAY);
  ok('same muscles, this-week and last-week numbers', JSON.stringify(w.rows.map((r) => [r.muscle, r.now, r.prev, r.status])) === JSON.stringify(m.rows.map((r) => [r.muscle, r.now, r.prev, r.status])));
  ok('same enough flag and total', w.enough === m.enough && w.total === m.nowTotal);
}

console.log('\n2. longer windows are weekly averages');
{
  const hist = [sess('2026-11-03', [['bb_bench', 12]]), sess('2026-10-20', [['bb_bench', 8]]), sess('2026-09-01', [['bb_bench', 20]])];
  const d30 = run(hist, '30d'), d90 = run(hist, '90d');
  ok('30d: 20 sets over 30 days = 4.7 a week, under the band', row(d30, 'chest').total === 20 && row(d30, 'chest').now === 4.7 && row(d30, 'chest').status === 'under', JSON.stringify(row(d30, 'chest')));
  ok('90d includes the September session: 40 sets, 3.1 a week', row(d90, 'chest').total === 40 && row(d90, 'chest').now === 3.1);
  ok('the window before is the comparison (none before 30d ago here)', row(d30, 'chest').prev === 0 && row(d30, 'chest').delta === 4.7);
  const busy = run([sess('2026-11-03', [['bb_bench', 16]]), sess('2026-10-27', [['bb_bench', 16]]), sess('2026-10-20', [['bb_bench', 16]]), sess('2026-10-13', [['bb_bench', 16]])], '30d');
  ok('64 sets in 30 days (14.9 a week) is in the band', row(busy, 'chest').now === 14.9 && row(busy, 'chest').status === 'in', JSON.stringify(row(busy, 'chest')));
  const over = run([sess('2026-11-03', [['bb_bench', 30]])], 'week');
  ok('over the band reads over', row(over, 'chest').status === 'over');
  const edge = (n) => row(run([sess('2026-11-03', [['bb_bench', n]])], 'week'), 'chest').status;
  ok('the band edges are inside it: 9 under, 10 in, 20 in, 21 over', edge(9) === 'under' && edge(10) === 'in' && edge(20) === 'in' && edge(21) === 'over');
  ok('an untrained muscle reads none', row(d30, 'legs') ? row(d30, 'legs').status === 'none' : row(d30, 'quads').status === 'none');
}

console.log('\n3. all time spans first workout to today');
{
  const hist = [sess('2026-11-03', [['bb_bench', 12]]), sess('2026-09-01', [['bb_bench', 20]])];
  const a = run(hist, 'all');
  ok('65 days, 9.3 weeks, 32 sets = 3.4 a week, no comparison', a.days === 65 && a.weeks === 9.3 && row(a, 'chest').total === 32 && row(a, 'chest').now === 3.4 && row(a, 'chest').prev === null && row(a, 'chest').delta === null && !a.hasPrev, JSON.stringify([a.days, a.weeks, row(a, 'chest')]));
  ok('a first workout today counts as one week, not a divide by zero', run([sess(TODAY, [['bb_bench', 10]])], 'all').weeks === 1 && row(run([sess(TODAY, [['bb_bench', 10]])], 'all'), 'chest').now === 10);
  ok('deleted and unfinished sessions do not stretch the span', run([sess('2025-01-01', [['bb_bench', 9]], { deleted: true }), sess('2025-01-02', [['bb_bench', 9]], { finishedAt: 0 }), sess('2026-11-03', [['bb_bench', 12]])], 'all').days === 2);
}

console.log('\n4. missing inputs and purity');
{
  ok('no coach, bad range, bad date: empty, no throw', !V.volumeRange([], TODAY, 'week', {}).enough && !run([], 'forever').enough && !V.volumeRange([], 'x', 'week', { coach: C }).enough);
  ok('nothing logged: not enough', !run([], '90d').enough);
  ok('four ranges offered, in order', V.RANGES.map((r) => r.id).join() === 'week,30d,90d,all');
  const hist = [sess('2026-11-03', [['bb_bench', 12]])];
  const before = JSON.stringify(hist);
  run(hist, '90d');
  ok('never mutates the history', JSON.stringify(hist) === before);
}

console.log('\n5. wired into the coach card');
{
  const ui = fs.readFileSync(path.join(DS, 'js', 'workout-coach.js'), 'utf8');
  const html = fs.readFileSync(path.join(DS, 'index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  ok('chips use the delegated coach action, 44px chip class, no inline style', /data-coach-action="vol-range"/.test(ui) && /pg-chip/.test(ui) && !/volumeHtml[\s\S]{0,2500}style=/.test(ui));
  ok('the click is handled and redraws the card', /case 'vol-range':/.test(ui));
  ok('logic loaded once, versioned, before the coach screen', (html.match(/volume-range-logic\.js\?v=\d+/g) || []).length === 1 && at('volume-range-logic.js') < at('workout-coach.js'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
