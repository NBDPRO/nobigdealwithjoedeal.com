/**
 * tests/ds-layout-rings-2026-10-22.test.js
 *
 * The Rings layout: the day page's Today bar drawn as four rings (floors, calories, protein, workout). Pins the pure ring math and
 * markup (day-layout-logic.js), the real updateTodayBar() from app.js run in a vm with a DOM stub (rings only in the Rings layout,
 * the old one-line bar untouched otherwise, targets read from the food log), and the CSS.
 *
 * Run: node tests/ds-layout-rings-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const DL = require(path.join(DS, 'js', 'day-layout-logic.js'));
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('js/app.js');
const FOOD = read('js/food-log.js');
const CSS = read('css/layouts.css');
const INDEX = read('index.html');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const by = (r, id) => r.rings.find((g) => g.id === id);

console.log('\n1. ringsFor');
{
  const r = DL.ringsFor({ hit: 3, total: 5, cal: '1,240', protein: '95', calTarget: 2400, proteinTarget: 150, workout: false });
  ok('four rings in order: floors, calories, protein, workout', r.rings.map((g) => g.id).join() === 'floors,cal,protein,workout');
  ok('floors: value 3/5, 60%, not done', by(r, 'floors').value === '3/5' && by(r, 'floors').pct === 0.6 && !by(r, 'floors').done);
  ok('calories: value as typed, fraction of target, sub says the target', by(r, 'cal').value === '1,240' && Math.abs(by(r, 'cal').pct - 1240 / 2400) < 1e-9 && by(r, 'cal').sub === 'of 2,400', JSON.stringify(by(r, 'cal')));
  ok('protein: fraction of target, sub in grams', Math.abs(by(r, 'protein').pct - 95 / 150) < 1e-9 && by(r, 'protein').sub === 'of 150 g' && !by(r, 'protein').done);
  ok('workout not done: dash, empty ring', by(r, 'workout').value === '—' && by(r, 'workout').pct === 0 && !by(r, 'workout').done);
  ok('not closed', r.closed === false);

  const over = DL.ringsFor({ hit: 1, total: 2, cal: '2,600', protein: '10', calTarget: 2400, workout: true });
  ok('calories over target: ring capped at 100% and flagged over (amber), never "done"', by(over, 'cal').pct === 1 && by(over, 'cal').over === true && by(over, 'cal').done === false);
  ok('exactly at the target is not over', DL.ringsFor({ cal: '2,400', calTarget: 2400 }).rings[1].over === false);

  const none = DL.ringsFor({ hit: 2, total: 4, cal: '800', protein: '50', workout: false });
  ok('no targets: rings stay empty and say "no target" (no NaN, no divide by zero)', by(none, 'cal').pct === 0 && by(none, 'cal').sub === 'no target' && by(none, 'protein').pct === 0 && by(none, 'protein').sub === 'no target');
  ok('zero, negative and junk targets count as no target', [0, -5, 'abc', null, undefined, NaN].every((t) => DL.ringsFor({ cal: '500', calTarget: t }).rings[1].sub === 'no target'));

  const closedIn = { hit: 5, total: 5, cal: '2,000', protein: '160', calTarget: 2400, proteinTarget: 150, workout: true };
  ok('closed: all floors + protein target met + workout', DL.ringsFor(closedIn).closed === true && by(DL.ringsFor(closedIn), 'protein').done === true);
  ok('not closed if any one is missing (floors / protein / workout)', DL.ringsFor(Object.assign({}, closedIn, { hit: 4 })).closed === false && DL.ringsFor(Object.assign({}, closedIn, { protein: '149' })).closed === false && DL.ringsFor(Object.assign({}, closedIn, { workout: false })).closed === false);
  ok('with no protein target, closed needs only floors + workout', DL.ringsFor({ hit: 3, total: 3, workout: true }).closed === true);
  ok('calories never gate closing (over or under)', DL.ringsFor(Object.assign({}, closedIn, { cal: '9,999' })).closed === true && DL.ringsFor(Object.assign({}, closedIn, { cal: '' })).closed === true);
  ok('control: zero floors defined is never "all met" and never closed', DL.ringsFor({ hit: 0, total: 0, workout: true }).closed === false);
  const dash = DL.ringsFor({ hit: 1, total: 2, cal: '—', protein: '—' });
  ok('an empty macro summary (an em dash) shows a dash and an empty ring', by(dash, 'cal').value === '—' && by(dash, 'cal').pct === 0 && by(dash, 'protein').value === '—');
  ok('no input at all does not throw', DL.ringsFor().rings.length === 4 && DL.ringsFor(null).rings.length === 4);
}

console.log('\n2. ringsHtml');
{
  const r = DL.ringsFor({ hit: 3, total: 5, cal: '1,240', protein: '150', calTarget: 2400, proteinTarget: 150, workout: false });
  const h = DL.ringsHtml(r);
  ok('four ring blocks inside one wrap', (h.match(/class="rg-r/g) || []).length === 4 && /^<div class="rg-wrap">/.test(h));
  ok('the floors arc is 60 of 100 (stroke-dasharray, an SVG attribute)', /stroke-dasharray="60 100"/.test(h), (h.match(/stroke-dasharray="[^"]*"/g) || []).join(' '));
  ok('a ring at zero draws no arc at all (no stray dot from the round cap)', (h.match(/class="rg-p"/g) || []).length === 3);
  ok('a done ring is marked done; an over ring is marked over', /rg-r done"[^>]*aria-label="Protein/.test(h) && /rg-r over/.test(DL.ringsHtml(DL.ringsFor({ cal: '3000', calTarget: 2400 }))));
  ok('each ring says what it is for a screen reader, with the target', /aria-label="Calories 1,240 of 2,400"/.test(h) && /aria-label="Floors 3\/5"/.test(h), (h.match(/aria-label="[^"]*"/g) || []).join(' | '));
  ok('no inline style anywhere (strict CSP)', !/style=/.test(h));
  ok('the closed note appears only when closed', !/rg-note/.test(h) && /rg-note">All rings closed</.test(DL.ringsHtml({ rings: r.rings, closed: true })) && /rg-wrap closed/.test(DL.ringsHtml({ rings: r.rings, closed: true })));
  const hostile = DL.ringsHtml({ rings: [{ id: 'x', label: '<img src=x onerror=alert(1)>', value: '"><script>', sub: "'", pct: 0.5, done: false, over: false }], closed: false });
  ok('control: label, value and sub are escaped (a hostile string cannot become markup)', !/<img|<script/.test(hostile) && /&lt;img/.test(hostile) && /&quot;&gt;&lt;script/.test(hostile));
  ok('out-of-range fractions are clamped (NaN-safe)', /stroke-dasharray="100 100"/.test(DL.ringsHtml({ rings: [{ id: 'a', label: 'A', value: '1', sub: '', pct: 7 }] })) && !/rg-p/.test(DL.ringsHtml({ rings: [{ id: 'a', label: 'A', value: '1', sub: '', pct: -3 }] })));
  ok('no result yet renders an empty wrap, not a crash', DL.ringsHtml(null) === '<div class="rg-wrap"></div>' && DL.ringsHtml({}) === '<div class="rg-wrap"></div>');
}

console.log('\n3. the real updateTodayBar() (extracted from app.js, run in a vm)');
{
  const from = APP.indexOf('function updateTodayBar(){');
  const to = APP.indexOf('// A layout switch redraws the bar at once.');
  ok('the function and the layout-switch listener are both in app.js', from > -1 && to > from && /window\.addEventListener\('nbd-layout',updateTodayBar\)/.test(APP));
  const fnSrc = APP.slice(from, to);
  function run(o) {
    const bar = { innerHTML: '', classes: new Set(), classList: { toggle(c, on) { if (on) bar.classes.add(c); else bar.classes.delete(c); } } };
    const els = { 'today-bar': bar, 'ms-cal': { textContent: o.cal || '' }, 'ms-p': { textContent: o.protein || '' } };
    const sandbox = {
      document: {
        documentElement: { getAttribute: (k) => (k === 'data-ui' ? (o.ui || null) : null) },
        getElementById: (id) => els[id] || null,
        querySelectorAll: (sel) => (sel === '#day-score-card .dsc-item' ? new Array(o.total || 0).fill({}) : sel === '#day-score-card .dsc-dot.hit' ? new Array(o.hit || 0).fill({}) : []),
      },
      localStorage: { getItem: (k) => (k === 'nbd_ds_workouts' ? JSON.stringify(o.sessions || []) : null) },
      pages: [{ dk: '2026-10-22' }], cur: 0,
      NBDDayLayout: DL,
      window: { NBDFoodLogUI: o.noTargets ? undefined : { targets: o.throwTargets ? () => { throw new Error('boom'); } : () => ({ calories: 2400, protein: 150 }) } },
      JSON, Math, Object, Array, String, Number, parseFloat, isFinite,
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nupdateTodayBar();', sandbox);
    return bar;
  }
  const done = [{ id: 's', date: '2026-10-22', finishedAt: 5 }];
  const classic = run({ hit: 2, total: 4, cal: '1,000', protein: '80', sessions: done });
  ok('classic: the old one-line bar is drawn exactly as before (floors / cal / protein / workout spans), no rings', /class="tb-i/.test(classic.innerHTML) && !/rg-/.test(classic.innerHTML) && !classic.classes.has('today-rings'));
  const rings = run({ ui: 'rings', hit: 2, total: 4, cal: '1,000', protein: '80', sessions: done });
  ok('rings: the bar holds the four rings and is marked today-rings', (rings.innerHTML.match(/class="rg-r/g) || []).length === 4 && rings.classes.has('today-rings'));
  ok('...with the day\'s real numbers (floors 2/4, calories against the food-log target, workout done)', /aria-label="Floors 2\/4"/.test(rings.innerHTML) && /aria-label="Calories 1,000 of 2,400"/.test(rings.innerHTML) && /aria-label="Protein 80 of 150 g"/.test(rings.innerHTML) && /aria-label="Workout Done"/.test(rings.innerHTML), (rings.innerHTML.match(/aria-label="[^"]*"/g) || []).join(' | '));
  const back = run({ ui: 'classic', hit: 2, total: 4 });
  ok('switching back to classic restores the one-line bar and drops the rings class', /class="tb-i/.test(back.innerHTML) && !back.classes.has('today-rings'));
  const nofood = run({ ui: 'rings', hit: 1, total: 2, cal: '500', protein: '20', noTargets: true });
  ok('the food log not loaded yet: rings still draw, with "no target"', /Calories 500 no target/.test(nofood.innerHTML));
  const boom = run({ ui: 'rings', hit: 1, total: 2, cal: '500', protein: '20', throwTargets: true });
  ok('a throwing targets() cannot blank the bar (rings draw with no target)', (boom.innerHTML.match(/class="rg-r/g) || []).length === 4 && /no target/.test(boom.innerHTML));
  const nobar = (() => { try { const s = { document: { getElementById: () => null }, NBDDayLayout: DL }; vm.createContext(s); vm.runInContext(fnSrc + '\nupdateTodayBar();', s); return true; } catch (e) { return false; } })();
  ok('control: no Today bar on the page (another tab) is a quiet no-op', nobar);
}

console.log('\n4. food log targets, readiness, styles, page');
{
  ok('food-log.js exposes targets() (protein falls back to body weight there, so the rings match the cards)', /function targets\(\) \{ return F\(\)\.targetsFor\(weight\(\), cfg\(\)\.targets\); \}/.test(FOOD) && /window\.NBDFoodLogUI = \{ refresh, cardHtml, targets \}/.test(FOOD));
  ok('Rings is ready to pick; Classic is still the default', L.byId('rings').ready === true && L.DEFAULT === 'classic');
  ok('a layout switch announces itself (the bar redraws at once)', /nbd-layout/.test(read('js/layout-ui.js')));
  const rg = CSS.slice(CSS.indexOf('Rings:'));
  const rules = rg.split('\n').filter((l) => /\{/.test(l));
  ok('every Rings rule is scoped to [data-ui="rings"] (Classic can never be restyled)', rules.length >= 8 && rules.every((l) => /^\[data-ui="rings"\]/.test(l.trim())), rules.filter((l) => !/^\[data-ui="rings"\]/.test(l.trim())).join(' | '));
  ok('the Rings bar is not sticky (a home, not a ribbon) and stays readable: labels at least 11px', /\.today-bar\.today-rings \{ position: static/.test(rg) && /\.rg-l \{[^}]*font-size: 11px/.test(rg));
  ok('no !important in the layout styles', !/!important/.test(CSS));
  ok('the page loads the changed assets at bumped versions (phones refetch)', /day-layout-logic\.js\?v=2/.test(INDEX) && /food-log\.js\?v=2/.test(INDEX) && /layouts\.css\?v=([3-9]|\d\d)/.test(INDEX));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
