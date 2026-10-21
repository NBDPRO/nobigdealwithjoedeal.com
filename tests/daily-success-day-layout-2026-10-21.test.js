/**
 * tests/daily-success-day-layout-2026-10-21.test.js
 *
 * The day page on a phone is a stack of collapsible sections with a sticky "Today" bar on top. Food and Fitness start
 * open, everything else starts collapsed, Jo's own open/closed choices always win, and larger screens keep every
 * section open. Pins the pure logic (day-layout-logic.js) and the wiring in app.js / index.html.
 *
 * Run: node tests/daily-success-day-layout-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DIR, 'js', 'day-layout-logic.js'));
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('js/app.js'), HTML = read('index.html');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const SECTIONS = ['intel', 'pipeline', 'mindset', 'regiment', 'diet', 'fitness', 'pr', 'log', 'goals', 'habits'];

console.log('\n1. which sections start collapsed');
{
  ok('Food (diet) and Fitness are the only sections open by default', JSON.stringify(L.OPEN_BY_DEFAULT) === JSON.stringify(['diet', 'fitness']));
  const phone = SECTIONS.filter((s) => L.sectionCollapsed({}, s, true));
  ok('on a phone with no saved choices, the other eight start collapsed', phone.length === 8 && !phone.includes('diet') && !phone.includes('fitness'), phone.join(','));
  ok('on a larger screen nothing starts collapsed (as before)', SECTIONS.every((s) => !L.sectionCollapsed({}, s, false)));
  ok('a saved "closed" wins even for Food', L.sectionCollapsed({ diet: true }, 'diet', true) === true && L.sectionCollapsed({ diet: true }, 'diet', false) === true);
  ok('a saved "open" wins even for Habits on a phone', L.sectionCollapsed({ habits: false }, 'habits', true) === false);
  ok('a choice for one section does not leak to another', L.sectionCollapsed({ habits: false }, 'goals', true) === true);
  ok('garbage saved state falls back to the defaults', L.sectionCollapsed(null, 'diet', true) === false && L.sectionCollapsed('x', 'log', true) === true && L.sectionCollapsed(undefined, 'log', true) === true);
  ok('the default list names real sections in the page (data-sec)', L.OPEN_BY_DEFAULT.every((s) => new RegExp('data-sec="' + s + '"').test(APP)));
  ok('control: every section in the page is covered by this table', (APP.match(/data-sec="([a-z]+)"/g) || []).map((m) => m.slice(10, -1)).sort().join(',') === SECTIONS.slice().sort().join(','));
}

console.log('\n2. the Today bar numbers');
{
  const s = L.todaySummary({ hit: 2, total: 5, cal: '1,240', protein: '98', workout: true });
  ok('floors, percent, calories, protein, workout', s.floors === '2/5' && s.floorsPct === 40 && s.cal === '1,240' && s.protein === '98' && s.workout === true && s.allMet === false, JSON.stringify(s));
  ok('an empty day shows em dashes, not 0 or NaN', (function () { const e = L.todaySummary({ hit: 0, total: 5, cal: '—', protein: '—' }); return e.cal === '—' && e.protein === '—' && e.floors === '0/5' && e.workout === false; })());
  ok('all floors met is flagged', L.todaySummary({ hit: 5, total: 5 }).allMet === true);
  ok('control: zero floors configured is not "all met"', L.todaySummary({ hit: 0, total: 0 }).allMet === false && L.todaySummary({ hit: 0, total: 0 }).floorsPct === 0);
  ok('hit can never exceed total', L.todaySummary({ hit: 9, total: 5 }).floors === '5/5');
  ok('big numbers get thousands separators; decimals round', L.todaySummary({ cal: '12345.6' }).cal === '12,346');
  ok('junk input does not throw', (function () { try { return L.todaySummary(null).floors === '0/0' && L.todaySummary({ hit: 'x', total: 'y', cal: {} }).cal === '—'; } catch (e) { return false; } })());
  const sessions = [{ date: '2026-10-21', finishedAt: 5 }, { date: '2026-10-20', finishedAt: 5 }, { date: '2026-10-22', finishedAt: 0 }, { date: '2026-10-19', finishedAt: 5, deleted: true }];
  ok('workoutDone: a finished session on that day', L.workoutDone(sessions, '2026-10-21') === true);
  ok('...not an unfinished one, a deleted one, or another day', L.workoutDone(sessions, '2026-10-22') === false && L.workoutDone(sessions, '2026-10-19') === false && L.workoutDone(sessions, '2026-10-18') === false);
  ok('...and bad input is "no"', L.workoutDone(null, '2026-10-21') === false && L.workoutDone([null, 5], '2026-10-21') === false);
}

console.log('\n3. wiring');
{
  ok('the logic script loads before app.js', HTML.indexOf('js/day-layout-logic.js') > -1 && HTML.indexOf('js/day-layout-logic.js') < HTML.indexOf('js/app.js"></script>'));
  ok('the day page renders the bar first in its column', /wrap\.innerHTML=`<div class="today-bar" id="today-bar"><\/div> \$\{buildCover/.test(APP));
  ok('collapsed state is decided by the helper (phone = max-width 768)', /NBDDayLayout\.sectionCollapsed\(st,card\.dataset\.sec,phone\)/.test(APP) && /matchMedia\('\(max-width:768px\)'\)/.test(APP));
  ok('a corrupt saved state cannot break page render (try/catch around the parse)', /let st=\{\};try\{st=JSON\.parse\(localStorage\.getItem\('nbd_collapsed'\)/.test(APP));
  ok('the bar refreshes on render, on macro change and on a floor tick', (APP.match(/updateTodayBar\(\);/g) || []).length >= 3);
  ok('the bar reads the existing Floor card and macro summary (it cannot disagree with them)', /#day-score-card \.dsc-item/.test(APP) && /#day-score-card \.dsc-dot\.hit/.test(APP) && /txt\('ms-cal'\)/.test(APP) && /txt\('ms-p'\)/.test(APP));
  ok('the bar is sticky under the tab row, with banner and phone offsets', /\.today-bar\{position:sticky;top:106px;/.test(HTML) && /body\.has-banner \.today-bar\{top:148px;\}/.test(HTML) && /\.today-bar\{top:150px;/.test(HTML) && /body\.has-banner \.today-bar\{top:246px;\}/.test(HTML));
  ok('control: 100px phone header + 46px tab row + 4px gap = 150px; with the 96px banner = 246px', 100 + 46 + 4 === 150 && 150 + 96 === 246);
  ok('the bar text is readable (>= 12px, light text on the dark bar)', /\.today-bar\{[^}]*font-size:14px;/.test(HTML) && /\.today-bar\{top:150px;font-size:13px;/.test(HTML));
  ok('no inline handlers were added', !/\son[a-z]+=/i.test((APP.match(/bar\.innerHTML='[^']*'/g) || []).join('')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
