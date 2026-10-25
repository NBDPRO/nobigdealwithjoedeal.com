/**
 * tests/ds-layout-cockpit-2026-10-25.test.js
 *
 * The Cockpit layout: the Today bar as one dense HUD of eight tiles (today's floors, calories, protein, workout, then the training
 * week from cockpit-logic.js: workouts, hard sets vs last week, streak, level) and a line naming the muscles that are behind. Pins
 * the renderer (cockpit-ui.js, run in a vm), the Today-bar branch in app.js, the ready flag, the scripts and the scoped CSS.
 *
 * Run: node tests/ds-layout-cockpit-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const CK = require(path.join(DS, 'js', 'cockpit-logic.js'));
const C = require(path.join(DS, 'js', 'workout-coach-logic.js'));
const X = require(path.join(DS, 'js', 'xp-logic.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('js/app.js'), CSS = read('css/layouts.css'), INDEX = read('index.html'), UI = read('js/cockpit-ui.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

// run the renderer in a vm with the real logic modules on window
const sandbox = { window: {}, console };
sandbox.window.NBDCockpit = CK;
vm.createContext(sandbox);
vm.runInContext(UI.replace(/\(function \(\) \{/, '(function () {').replace('window.NBDCockpitUI = { html };', 'window.NBDCockpitUI = { html };'), sandbox);
const html = (o) => sandbox.window.NBDCockpitUI.html(o);
let _n = 0;
const sess = (date, exs) => ({ id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 2, exercises: exs.map(([exId, n], i) => ({ exId, name: exId, slot: i, sets: Array.from({ length: n }, () => ({ weight: 135, reps: 8, rpe: 8, done: true })) })) });
const TODAY = '2026-10-25';
const hist = [sess('2026-10-24', [['bb_bench', 6], ['incline_db', 3]]), sess('2026-10-16', [['bb_bench', 5]])];

console.log('\n1. the HUD markup');
{
  const h = html({ summary: { floors: '3/5', allMet: false, cal: '1,240', protein: '95', workout: true }, targets: { calories: 2400, protein: 150 }, sessions: hist, today: TODAY, coach: C, xp: X });
  const tiles = h.match(/<div class="ck-t[^"]*">/g) || [];
  ok('eight tiles: four for today, four for the week', tiles.length === 8, String(tiles.length));
  ok('today: floors 3/5, calories of 2,400, protein 95 g of 150 g, workout Done', /Floors<\/span><b class="ck-v">3\/5/.test(h) && /of 2,400/.test(h) && /95 g<\/b>/.test(h) && /of 150 g/.test(h) && /Workout<\/span><b class="ck-v">Done/.test(h));
  ok('the week: 1 workout, 9 hard sets +4 vs last week, a streak, a level', /Workouts<\/span><b class="ck-v">1/.test(h) && /Hard sets<\/span><b class="ck-v">9<\/b><small class="ck-s">\+4 vs last wk/.test(h) && /Streak<\/span>/.test(h) && !/Training streak/.test(h) && /Lv \d/.test(h));
  ok('a done workout and a live streak are marked ok', /class="ck-t ok"><span class="ck-l">Workout/.test(h) && /class="ck-t ok"><span class="ck-l">Streak/.test(h));
  ok('the behind line names muscles with their labels, never ids', /Behind this week: /.test(h) && /Hams &amp; glutes|Shoulders/.test(h) && !/hams,|quads,/.test(h));
  ok('no inline style attribute anywhere', !/style="/.test(h));
  const none = html({ summary: {}, targets: {}, sessions: [], today: TODAY, coach: C, xp: X });
  ok('no data: dashes and "no target", never NaN or undefined', /no target/.test(none) && !/NaN|undefined/.test(none) && (none.match(/<div class="ck-t/g) || []).length === 8);
  ok('all floors met flags the floors tile ok and says all met', /class="ck-t ok"><span class="ck-l">Floors<\/span><b class="ck-v">5\/5<\/b><small class="ck-s">all met/.test(html({ summary: { floors: '5/5', allMet: true }, sessions: [], today: TODAY, coach: C, xp: X })));
  ok('without the coach or xp module the day tiles still render (four tiles, no behind line)', (() => { const h2 = html({ summary: { floors: '1/2' }, sessions: hist, today: TODAY }); return (h2.match(/<div class="ck-t/g) || []).length === 4 && !/Behind/.test(h2); })());
  const evil = html({ summary: { floors: '<img src=x onerror=1>', cal: '"', protein: '' }, targets: {}, sessions: [], today: TODAY, coach: C, xp: X });
  ok('page text is escaped', !/<img src=x/.test(evil) && /&lt;img/.test(evil));
}

console.log('\n2. wiring');
{
  ok('Cockpit is ready to pick; Classic still the default', L.byId('cockpit').ready === true && L.DEFAULT === 'classic' && L.normLayout('cockpit') === 'cockpit');
  ok('updateTodayBar renders the HUD only in the Cockpit layout and toggles the class', /cockpit=ui==='cockpit'/.test(APP) && /bar\.classList\.toggle\('today-cockpit',cockpit\)/.test(APP) && /if\(cockpit&&window\.NBDCockpitUI\)/.test(APP));
  ok('it hands the HUD the same summary, the food targets, the sessions, the real coach and xp modules', /NBDCockpitUI\.html\(\{summary:s,targets:tg2,sessions:sessions,today:todayKey\(\),coach:window\.NBDCoach,xp:window\.NBDXp\}\)/.test(APP));
  ok('the Rings branch and the classic bar are untouched', /if\(rings\)\{/.test(APP) && /tb-i/.test(APP));
  ok('xp-logic, cockpit-logic and cockpit-ui load deferred, after the coach logic', ['xp-logic.js', 'cockpit-logic.js', 'cockpit-ui.js'].every((f) => new RegExp('<script src="/pro/daily-success/js/' + f.replace('.', '\\.') + '\\?v=\\d+" defer></script>').test(INDEX)) && INDEX.indexOf('workout-coach-logic.js') < INDEX.indexOf('cockpit-ui.js'));
  const ck = CSS.slice(CSS.indexOf('Cockpit:'), CSS.indexOf('Log Book:'));
  const rules = ck.split('\n').filter((l) => /\{/.test(l) && !/^@media/.test(l.trim()));
  ok('every Cockpit rule is scoped to [data-ui="cockpit"] (Classic can never be restyled)', rules.length >= 8 && rules.every((l) => /^\[data-ui="cockpit"\]/.test(l.trim())), rules.filter((l) => !/^\[data-ui="cockpit"\]/.test(l.trim())).join(' | '));
  ok('tile parts are plain blocks (the bar\'s own span rule gives flex children 100% and collapsed the values)', /\.ck-l, \[data-ui="cockpit"\] \.ck-v, \[data-ui="cockpit"\] \.ck-s \{ display: block; flex: none;/.test(ck));
  ok('the HUD is static (not sticky), four tiles a row, two on the narrowest phones', /today-cockpit \{ position: static;/.test(ck) && /repeat\(4, minmax\(0, 1fr\)\)/.test(ck) && /max-width: 360px\) \{ \[data-ui="cockpit"\] \.ck-grid \{ grid-template-columns: repeat\(2/.test(ck));
  ok('no font under 11 px in the HUD', !/font-size: (10|9|8)px/.test(ck));
  ok('layouts.css cache version bumped', /layouts\.css\?v=\d+/.test(INDEX));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
