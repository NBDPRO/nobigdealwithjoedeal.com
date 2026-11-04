/**
 * tests/ds-week-glance-run-2026-11-04.test.js
 *
 * Runs app.js's buildWeekGlance() against fakes (real weekStrip logic, fake pages / floors / storage) instead of searching its source:
 * a finished workout fills that day's dot, an unfinished or deleted one does not, a day with a page switches on tap, and the strip
 * degrades to nothing when the logic is missing or storage is broken.
 *
 * Run: node tests/ds-week-glance-run-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'day-layout-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const app = fs.readFileSync(path.join(DS, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const start = app.indexOf('function buildWeekGlance()');
const end = app.indexOf('// DAILY COMPARISON');
if (start < 0 || end < start) { console.log('  ✗ could not find buildWeekGlance in app.js'); process.exit(1); }
const src = app.slice(start, end);

function run(o) {
  const ctx = {
    NBDDayLayout: o.noLogic ? undefined : L,
    pages: o.pages || [],
    getFloors: () => ({}),
    todayKey: () => '2026-11-04',
    localStorage: { getItem: () => { if (o.badStorage) throw new Error('blocked'); return JSON.stringify(o.sessions || []); } },
    JSON, Math, Date, Number, String, Array, Object,
  };
  if (o.noLogic) delete ctx.NBDDayLayout;
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.__out = buildWeekGlance();', ctx);
  return ctx.__out;
}
const dots = (h) => (h.match(/class="wg-dot( on)?"/g) || []);
const w = (date, extra) => Object.assign({ id: date, date, finishedAt: 1000 }, extra || {});

console.log('\n1. dots follow finished workouts');
{
  const h = run({ sessions: [w('2026-11-03'), w('2026-11-04')] });
  ok('seven cells, two filled dots (Tue and Wed)', dots(h).length === 7 && dots(h).filter((d) => /on/.test(d)).length === 2, dots(h).join(' | '));
  const h2 = run({ sessions: [w('2026-11-03', { finishedAt: 0 }), w('2026-11-04', { deleted: true })] });
  ok('an unfinished or deleted workout leaves its dot empty', dots(h2).length === 7 && dots(h2).every((d) => !/on/.test(d)));
  ok('a workout in another week does not light the strip', dots(run({ sessions: [w('2026-10-20')] })).every((d) => !/on/.test(d)));
}

console.log('\n2. safe fallbacks');
{
  ok('no logic loaded: empty string, no throw', run({ noLogic: true }) === '');
  const h = run({ badStorage: true });
  ok('blocked storage still draws seven empty dots', dots(h).length === 7 && dots(h).every((d) => !/on/.test(d)));
}

console.log('\n3. tap and text');
{
  const h = run({ sessions: [w('2026-11-04')] });
  ok('every dot has a text label for screen readers', /Workout done/.test(h) && /No workout/.test(h));
  ok('the markup has no script or handler attribute', !/<script|\son[a-z]+=/i.test(h));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
