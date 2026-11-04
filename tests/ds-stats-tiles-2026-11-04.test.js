/**
 * tests/ds-stats-tiles-2026-11-04.test.js
 *
 * The Stats tile row: workouts all time, this month, the week streak (consecutive Monday-Sunday weeks that hit the weekly goal) and the
 * 30-day weight change. Also pins that the card is wired in without inline style or handlers.
 *
 * Run: node tests/ds-stats-tiles-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const S = require(path.join(DS, 'js', 'stats-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const TODAY = '2026-11-04'; // Wednesday; this week is Mon 2026-11-02 .. Sun 2026-11-08
const w = (date, extra) => Object.assign({ id: date, date, finishedAt: 1000 }, extra || {});
const tile = (r, id) => r.tiles.find((t) => t.id === id);
const run = (hist, o) => S.statsTiles(hist, TODAY, o);

console.log('\n1. the counts');
{
  const hist = [w('2026-11-03'), w('2026-11-02'), w('2026-10-28'), w('2026-10-14'), w('2026-09-01'),
    w('2026-10-30', { deleted: true }), w('2026-10-31', { finishedAt: 0 }), w('2026-11-09')];
  const r = run(hist);
  ok('workouts all time ignores deleted, unfinished and future', tile(r, 'workouts').value === '5', tile(r, 'workouts').value);
  ok('this month counts November only, named', tile(r, 'month').value === '2' && tile(r, 'month').sub === 'November');
  ok('four tiles in order', r.tiles.map((t) => t.id).join() === 'workouts,month,weekstreak,weight30');
  ok('enough once there is a workout', r.enough);
}

console.log('\n2. the week streak');
{
  const wk = (mon, n) => Array.from({ length: n }, (_, i) => w(S && mon.slice(0, 8) + String(Number(mon.slice(8)) + i).padStart(2, '0')));
  // weeks start Mon: 10-19, 10-26, 11-02 (this). Goal 2.
  const two = [...wk('2026-10-19', 2), ...wk('2026-10-26', 2), ...wk('2026-11-02', 2)];
  const a = S.weekStreak(two, TODAY, 2);
  ok('three weeks that hit 2 in a row, this one included', a.count === 3 && a.thisWeek === 2 && a.goal === 2, JSON.stringify(a));
  const inProg = S.weekStreak([...wk('2026-10-19', 2), ...wk('2026-10-26', 2), ...wk('2026-11-02', 1)], TODAY, 2);
  ok('a week still in progress does not break it and does not count yet', inProg.count === 2 && inProg.thisWeek === 1, JSON.stringify(inProg));
  const broke = S.weekStreak([...wk('2026-10-19', 2), ...wk('2026-10-26', 1), ...wk('2026-11-02', 2)], TODAY, 2);
  ok('a missed week breaks it: only this week counts', broke.count === 1, JSON.stringify(broke));
  ok('no goal set means one workout a week', S.weekStreak([w('2026-11-02'), w('2026-10-27')], TODAY, undefined).count === 2 && S.weekStreak([], TODAY, 0).goal === 1);
  ok('a goal of 3 needs 3', S.weekStreak(wk('2026-11-02', 2), TODAY, 3).count === 0);
  ok('Sunday belongs to the week that started Monday', S.weekStreak([w('2026-11-01'), w('2026-10-26')], TODAY, 2).count === 1 && S.weekStreak([w('2026-11-02'), w('2026-10-26')], TODAY, 2).count === 0);
  const junk = [w('2026-11-02'), w('2026-11-03', { deleted: true }), w('2026-11-04', { finishedAt: 0 }), w('2026-11-06')];
  ok('deleted, unfinished and future workouts never count toward a week', S.weekStreak(junk, TODAY, 2).thisWeek === 1 && S.weekStreak(junk, TODAY, 2).count === 0, JSON.stringify(S.weekStreak(junk, TODAY, 2)));
  ok('nothing logged: zero, no throw', S.weekStreak([], TODAY, 2).count === 0 && S.weekStreak(null, TODAY, 2).count === 0);
  ok('the tile shows streak and this week against the goal', tile(run(two, { target: 2 }), 'weekstreak').value === '3' && tile(run(two, { target: 2 }), 'weekstreak').sub === '2/2 this week');
}

console.log('\n3. weight');
{
  const hist = [w('2026-11-03')];
  ok('down 1.4 shows a real minus', tile(run(hist, { trend: { change30: -1.4 } }), 'weight30').value === '−1.4 lb');
  ok('up shows a plus', tile(run(hist, { trend: { change30: 2 } }), 'weight30').value === '+2.0 lb');
  ok('no change shows 0.0', tile(run(hist, { trend: { change30: 0 } }), 'weight30').value === '0.0 lb');
  ok('no trend: a dash and a nudge', tile(run(hist, {}), 'weight30').value === '—' && /weigh in/.test(tile(run(hist, {}), 'weight30').sub));
  ok('weight alone is enough to show the row', run([], { trend: { change30: -1 } }).enough && !run([], {}).enough);
}

console.log('\n4. purity and bad input');
{
  ok('bad date: empty', !S.statsTiles([], 'nope', {}).enough && S.statsTiles([], 'nope', {}).tiles.length === 0);
  const hist = [w('2026-11-03')];
  const before = JSON.stringify(hist);
  run(hist, { target: 3 });
  ok('never mutates the history', JSON.stringify(hist) === before);
}

console.log('\n5. wired in, CSP-safe');
{
  const ui = fs.readFileSync(path.join(DS, 'js', 'stats-ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(DS, 'index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  ok('no inline style or handler in the card', !/style=|\son[a-z]+=/.test(ui));
  ok('every value is escaped into the markup', (ui.match(/esc\(t\.(label|value|sub)\)/g) || []).length === 3);
  ok('loaded once each, deferred, after the Progress card script', (html.match(/<script src="\/pro\/daily-success\/js\/stats-logic\.js\?v=\d+" defer><\/script>/g) || []).length === 1
    && (html.match(/<script src="\/pro\/daily-success\/js\/stats-ui\.js\?v=\d+" defer><\/script>/g) || []).length === 1 && at('stats-ui.js') > at('progress-charts-ui.js'));
  ok('stylesheet linked once', (html.match(/css\/stats\.css\?v=\d+/g) || []).length === 1);
  const css = fs.readFileSync(path.join(DS, 'css', 'stats.css'), 'utf8');
  ok('no font under 11px', !/font-size:\s*(\d|10)px/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
