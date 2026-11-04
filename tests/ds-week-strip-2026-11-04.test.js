/**
 * tests/ds-week-strip-2026-11-04.test.js
 *
 * The "this week at a glance" strip on the day page: seven days Monday..Sunday of the week holding today, each with its page, floors met,
 * a shade level and (new) whether a workout was finished that day. Pins the pure weekStrip() and the wiring in app.js / css / index.html.
 *
 * Run: node tests/ds-week-strip-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'day-layout-logic.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const FLOORS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
const page = (dk, met) => ({ dk, data: Object.fromEntries(met.map((id) => ['floormet-' + id, '1'])) });
const sess = (date, extra) => Object.assign({ id: date, date, finishedAt: 1000 }, extra || {});
const TODAY = '2026-11-04'; // Wednesday; the strip is Mon 2026-11-02 .. Sun 2026-11-08

console.log('\n1. the seven days');
{
  const s = L.weekStrip([], FLOORS, [], TODAY);
  ok('seven cells, Monday first, labelled M T W T F S S', s.length === 7 && s.map((c) => c.label).join('') === 'MTWTFSS' && s[0].dk === '2026-11-02' && s[6].dk === '2026-11-08');
  ok('only today is flagged today', s.filter((c) => c.isToday).length === 1 && s[2].isToday);
  ok('day numbers are the dates', s.map((c) => c.day).join() === '2,3,4,5,6,7,8');
  const sun = L.weekStrip([], FLOORS, [], '2026-11-08');
  ok('on a Sunday the week still starts the Monday before', sun[0].dk === '2026-11-02' && sun[6].isToday);
  const mon = L.weekStrip([], FLOORS, [], '2026-11-02');
  ok('on a Monday it starts that day', mon[0].dk === '2026-11-02' && mon[0].isToday);
  const edge = L.weekStrip([], FLOORS, [], '2026-12-31');
  ok('it crosses a month and year boundary', edge[0].dk === '2026-12-28' && edge[6].dk === '2027-01-03', edge[6].dk);
  ok('bad date: empty', L.weekStrip([], FLOORS, [], 'nope').length === 0 && L.weekStrip([], FLOORS, [], undefined).length === 0);
}

console.log('\n2. pages, floors and shading');
{
  const pages = [page('2026-11-02', ['a', 'b', 'c', 'd']), page('2026-11-03', ['a', 'b']), page('2026-11-04', ['a']), page('2026-11-05', [])];
  const s = L.weekStrip(pages, FLOORS, [], TODAY);
  ok('all floors = full', s[0].level === 'full' && s[0].met === 4 && s[0].total === 4);
  ok('half or more = half', s[1].level === 'half' && s[1].met === 2);
  ok('some = some', s[2].level === 'some' && s[2].met === 1);
  ok('a page with nothing met = none, but it still has a page', s[3].level === 'none' && s[3].pageIdx === 3);
  ok('a day with no page has no index and shows none', s[4].pageIdx === -1 && s[4].level === 'none' && s[4].met === 0);
  ok('page index points into the pages list', s[1].pageIdx === 1 && s[2].pageIdx === 2);
  ok('no floors set: no shading, no divide by zero', L.weekStrip(pages, [], [], TODAY).every((c) => c.level === 'none' && c.total === 0));
  ok('only "1" counts as met', L.weekStrip([{ dk: '2026-11-02', data: { 'floormet-a': '0', 'floormet-b': 'true' } }], FLOORS, [], TODAY)[0].met === 0);
  ok('junk pages are skipped', L.weekStrip([null, 5, { dk: '2026-11-02' }], FLOORS, [], TODAY)[0].pageIdx === 2 && L.weekStrip(null, FLOORS, [], TODAY).length === 7);
}

console.log('\n3. the workout dot');
{
  const sessions = [sess('2026-11-02'), sess('2026-11-04'), sess('2026-11-03', { deleted: true }), sess('2026-11-05', { finishedAt: 0 }), sess('2026-10-30'), sess('2026-11-09')];
  const s = L.weekStrip([], FLOORS, sessions, TODAY);
  ok('finished workouts light their day only', s.map((c) => (c.trained ? 1 : 0)).join('') === '1010000', s.map((c) => (c.trained ? 1 : 0)).join(''));
  ok('a workout counts even with no page that day', s[0].pageIdx === -1 && s[0].trained);
  ok('no sessions or junk sessions: no dots, no throw', L.weekStrip([], FLOORS, null, TODAY).every((c) => !c.trained) && L.weekStrip([], FLOORS, [null, 5], TODAY).every((c) => !c.trained));
  const pagesBefore = JSON.stringify([page('2026-11-02', ['a'])]);
  const pg = [page('2026-11-02', ['a'])];
  L.weekStrip(pg, FLOORS, sessions, TODAY);
  ok('never mutates its inputs', JSON.stringify(pg) === pagesBefore);
}

console.log('\n4. wired into the page');
{
  const app = read('js/app.js'), html = read('index.html'), css = read('css/week-strip.css');
  const fn = app.slice(app.indexOf('function buildWeekGlance()'), app.indexOf('// DAILY COMPARISON'));
  ok('the strip is drawn from weekStrip(), not its own date maths', /NBDDayLayout\.weekStrip\(pages,getFloors\(\),sessions,todayKey\(\)\)/.test(fn) && !/new Date\(/.test(fn));
  ok('each day carries the dot, filled on a workout, with a text label', /class="wg-dot\$\{c\.trained\?' on':''\}"/.test(fn) && /Workout done/.test(fn) && /No workout/.test(fn));
  ok('the day still switches to its page on tap', /data-action="switch-to" data-page-idx="\$\{c\.pageIdx\}"/.test(fn));
  ok('it does nothing if the logic did not load', /typeof NBDDayLayout==='undefined'\|\|!NBDDayLayout\.weekStrip\)return ''/.test(fn));
  ok('the dot has no inline style (class + stylesheet)', !/wg-dot[^>]*style=/.test(fn) && /\.wg-dot\.on \{/.test(css));
  ok('the stylesheet is linked once and the logic was version-bumped so phones refetch it', (html.match(/css\/week-strip\.css\?v=\d+/g) || []).length === 1 && /day-layout-logic\.js\?v=([3-9]|\d\d)\b/.test(html));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
