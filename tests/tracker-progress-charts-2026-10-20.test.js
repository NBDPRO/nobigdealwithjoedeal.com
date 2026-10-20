/**
 * tests/tracker-progress-charts-2026-10-20.test.js
 *
 * Tracker revamp Phase 1 leftover: per-lift estimated-1RM chart and weekly
 * volume (docs/pro/daily-success/js/progress-charts-logic.js + -ui.js).
 * Synthetic data only.
 *
 * Run: node tests/tracker-progress-charts-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const P = require(path.join(DS, 'js', 'progress-charts-logic.js'));
const C = require(path.join(DS, 'js', 'workout-coach-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

// Wednesday 2026-10-21 so the current week starts Monday 2026-10-19.
const TODAY = '2026-10-21';
const sess = (date, exId, sets, extra) => Object.assign({
  id: 's' + date + exId, date, split: 'push', startedAt: 1, finishedAt: 2, mt: 2,
  exercises: [{ exId, name: exId, slot: 0, repRange: [5, 8], sets: sets.map(([weight, reps]) => ({ weight, reps, rpe: 8, done: true })) }],
}, extra);

console.log('\n1. the estimated 1RM line');
{
  const sessions = [
    sess('2026-08-03', 'bb_bench', [[185, 8]]),
    sess('2026-09-07', 'bb_bench', [[195, 5], [205, 5]]),
    sess('2026-09-21', 'bb_bench', [[185, 8]]),                       // a lighter day: not a PR
    sess('2026-10-05', 'bb_bench', [[215, 5], [185, 20]]),            // the 20-rep burnout must be ignored
    sess('2026-10-05', 'bb_bench', [[200, 5]], { id: 'second-same-day' }), // same day, worse: keeps the better
    sess('2026-10-12', 'back_squat', [[275, 5]]),
  ];
  const s = P.liftSeries('bb_bench', sessions);
  ok('one point per day, oldest first, only that lift', s.length === 4 && s[0].date === '2026-08-03' && s[3].date === '2026-10-05', JSON.stringify(s.map((x) => x.date)));
  ok('each point is the best set\'s Epley e1RM (185x8 = 234.3)', s[0].e1rm === C.e1rm(185, 8) && s[0].weight === 185 && s[0].reps === 8);
  ok('the best of a day\'s sets wins (205x5 beats 195x5)', s[1].e1rm === C.e1rm(205, 5) && s[1].e1rm > C.e1rm(195, 5));
  ok('sets over 12 reps never count (185 x 20 would be 308)', s[3].e1rm === C.e1rm(215, 5) && s[3].weight === 215);
  ok('PR flags: new bests only', s.map((x) => x.pr).join() === 'true,true,false,true', s.map((x) => x.pr).join());
  ok('a lift never done has no series', P.liftSeries('deadlift', sessions).length === 0);
  ok('unfinished, deleted and not-done sets are ignored', P.liftSeries('bb_bench', [
    sess('2026-10-01', 'bb_bench', [[300, 5]], { finishedAt: null }),
    sess('2026-10-02', 'bb_bench', [[300, 5]], { deleted: true }),
    { date: '2026-10-03', finishedAt: 2, exercises: [{ exId: 'bb_bench', sets: [{ weight: 300, reps: 5, done: false }] }] },
  ]).length === 0);
  ok('sinceYmd trims the window', P.liftSeries('bb_bench', sessions, { sinceYmd: '2026-09-15' }).length === 2);
  const sum = P.liftSummary(s);
  ok('summary: first, latest, best, change and %', sum.count === 4 && sum.first === s[0].e1rm && sum.latest === s[3].e1rm && sum.best === s[3].e1rm
    && sum.change === Math.round((s[3].e1rm - s[0].e1rm) * 10) / 10 && sum.changePct > 0, JSON.stringify(sum));
  ok('summary of one session has no change; of none is empty', P.liftSummary([s[0]]).change === null && P.liftSummary([]).count === 0);

  console.log('\n2. which lifts get a chip');
  const many = [];
  for (let i = 0; i < 5; i++) many.push(sess('2026-09-' + String(10 + i).padStart(2, '0'), 'bb_bench', [[185, 8]]));
  for (let i = 0; i < 3; i++) many.push(sess('2026-10-' + String(1 + i).padStart(2, '0'), 'back_squat', [[225, 5]]));
  many.push(sess('2026-10-10', 'ohp', [[95, 8]]));
  many.push(sess('2025-01-01', 'deadlift', [[315, 5]]));              // a year ago: outside 180 days
  many.push(sess('2026-10-11', 'pullup', [['', 8]]));                  // bodyweight, no load: no 1RM to chart
  const top = P.topLifts(many, TODAY, 6, 180);
  ok('most-done first; names from the library', top[0].exId === 'bb_bench' && top[0].count === 5 && top[1].exId === 'back_squat' && /bench/i.test(top[0].name), JSON.stringify(top));
  ok('old lifts and loadless lifts get no chip', !top.some((t) => t.exId === 'deadlift' || t.exId === 'pullup'));
  ok('capped at n', P.topLifts(many, TODAY, 2, 180).length === 2);
}

console.log('\n3. weekly volume');
{
  const sessions = [
    sess('2026-10-19', 'bb_bench', [[100, 10], [100, 10]]),            // Monday this week: 2000
    sess('2026-10-21', 'back_squat', [[200, 5]]),                      // today: +1000
    sess('2026-10-18', 'bb_bench', [[100, 10]]),                       // Sunday = last week: 1000
    sess('2026-07-01', 'bb_bench', [[100, 10]]),                       // outside 12 weeks
    sess('2026-10-25', 'bb_bench', [[500, 10]]),                       // future: ignored
  ];
  ok('weeks run Monday to Sunday', P.weekStart('2026-10-18') === '2026-10-12' && P.weekStart('2026-10-19') === '2026-10-19' && P.weekStart('2026-10-21') === '2026-10-19');
  const w = P.weeklyVolume(sessions, TODAY, 12);
  ok('12 weeks ending with this one, zero weeks included', w.length === 12 && w[11].week === '2026-10-19' && w[0].week === '2026-08-03');
  ok('this week sums every session in it', w[11].lbs === 3000 && w[11].sets === 3, JSON.stringify(w[11]));
  ok('Sunday belongs to the week before; future and old sessions are excluded', w[10].lbs === 1000 && w.reduce((n, x) => n + x.lbs, 0) === 4000);
  ok('a quiet week is 0, not missing', w[5].lbs === 0);
}

console.log('\n4. the charts');
{
  const pts = [{ date: '2026-08-03', e1rm: 234, pr: true }, { date: '2026-09-07', e1rm: 239, pr: true }, { date: '2026-10-05', e1rm: 251, pr: true }];
  const svg = P.lineChart(pts, 'Estimated 1RM for <Bench> & co');
  ok('line chart: polyline, a dot per PR, labelled for screen readers', /polyline/.test(svg) && (svg.match(/pg-pr/g) || []).length === 3 && /role="img"/.test(svg));
  ok('the label is escaped (no raw < or & inside the attribute)', !/aria-label="[^"]*[<&](?!amp;|lt;|gt;)/.test(svg) && /&lt;Bench&gt; &amp; co/.test(svg));
  ok('one point is not a line', P.lineChart([pts[0]]) === '');
  const flat = P.lineChart([{ date: '2026-08-03', e1rm: 200 }, { date: '2026-08-10', e1rm: 200 }]);
  ok('a flat line does not divide by zero', /polyline/.test(flat) && !/NaN|Infinity/.test(flat));
  const bars = P.barChart(P.weeklyVolume([sess('2026-10-19', 'bb_bench', [[100, 10]])], TODAY, 12));
  ok('bar chart: one bar per week, the current week marked', (bars.match(/<rect/g) || []).length === 12 && /pg-bar now/.test(bars));
  ok('no volume anywhere draws nothing', P.barChart(P.weeklyVolume([], TODAY, 12)) === '');
}

console.log('\n5. wired into the page, safely');
{
  const html = fs.readFileSync(path.join(DS, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const at = (s) => html.indexOf(s);
  ok('logic loads before the ui, both after the coach and the weight card',
    at('js/progress-charts-logic.js') > at('js/tracker-history-ui.js') && at('js/progress-charts-ui.js') > at('js/progress-charts-logic.js'));
  ok('both are external deferred scripts (strict CSP, no inline)', /<script src="\/pro\/daily-success\/js\/progress-charts-logic\.js\?v=1" defer><\/script>/.test(html)
    && /<script src="\/pro\/daily-success\/js\/progress-charts-ui\.js\?v=1" defer><\/script>/.test(html));
  ok('the stylesheet version was bumped so phones refetch it', /workout-coach\.css\?v=([4-9]|\d\d)\b/.test(html));
  const ui = fs.readFileSync(path.join(DS, 'js', 'progress-charts-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no inline handlers or eval in the ui', !/\bon[a-z]+\s*=\s*["']/.test(code) && !/\beval\(|new Function/.test(code));
  ok('lift names (user data) are escaped into the chips', /esc\(l\.name\)/.test(code) && /esc\(l\.exId\)/.test(code));
  ok('it re-wraps the weight card\'s hooks without dropping their flags', /Object\.keys\(origFit\)\.forEach/.test(code) && /Object\.keys\(origDash\)\.forEach/.test(code));
  const css = fs.readFileSync(path.join(DS, 'css', 'workout-coach.css'), 'utf8');
  ok('the chip is a 36px+ tap target like the other chips', /\.pg-chip \{[^}]*min-height: 36px/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
