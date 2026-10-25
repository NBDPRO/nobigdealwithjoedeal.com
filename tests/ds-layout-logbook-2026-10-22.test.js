/**
 * tests/ds-layout-logbook-2026-10-22.test.js
 *
 * The Log Book layout: the coach screen as a plain, fast log with a Last / Best / Today row above each lift's sets. Pins the pure row
 * (snapshotRow), the real screen through the DOM stub (row only in Log Book, appears and goes away on a layout switch, escaped), and the
 * CSS (every Log Book rule is scoped, tap targets stay big).
 *
 * Run: node tests/ds-layout-logbook-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const C = require(path.join(DS, 'js', 'workout-coach-logic.js'));
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const UI = read('js/workout-coach.js');
const CSS = read('css/layouts.css');
const INDEX = read('index.html');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

let _n = 0;
function sess(date, split, exs, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets]) => ({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps, warm]) => ({ weight, reps, rpe: 8, done: true, warm: !!warm })),
    })),
  }, extra || {});
}

console.log('\n1. snapshotRow');
{
  const hist = [sess('2026-10-15', 'push', [['bb_bench', 0, [[95, 8, true], [135, 8], [145, 6], [145, 5]]]])];
  const r = C.snapshotRow('bb_bench', { weight: 150, reps: '5-8' }, hist);
  ok('Last is the TOP working set of the last session (heaviest, then most reps), not a warm-up', r.last === '145×6', r.last);
  ok('Best is the best estimated 1RM, rounded, as a string', r.best === String(Math.round(C.bestE1rm('bb_bench', hist))) && Number(r.best) > 145, r.best);
  ok('Today is the target weight x reps', r.today === '150×5-8', r.today);
  const none = C.snapshotRow('bb_bench', undefined, []);
  ok('a lift never logged: every cell is empty (the screen shows a dash), no NaN, no crash', none.last === '' && none.best === '' && none.today === '', JSON.stringify(none));
  const bw = C.snapshotRow('pullup', { weight: 0, reps: '6-10' }, [sess('2026-10-15', 'pull', [['pullup', 0, [[0, 8], [0, 7]]]])]);
  ok('bodyweight: Last reads "8 reps", Today reads "6-10 reps"', bw.last === '8 reps' && bw.today === '6-10 reps', JSON.stringify(bw));
  ok('an unfinished session is not "last time"', C.snapshotRow('bb_bench', null, [sess('2026-10-15', 'push', [['bb_bench', 0, [[135, 8]]]], { finishedAt: 0 })]).last === '');
  ok('another lift\'s history is not mixed in', C.snapshotRow('ohp', null, hist).last === '');
  const before = JSON.stringify(hist);
  C.snapshotRow('bb_bench', { weight: 1, reps: 1 }, hist);
  ok('read-only: the history is not mutated', JSON.stringify(hist) === before);
}

console.log('\n2. the real screen');
{
  const hist = Object.keys(C.SPLITS).map((k, i) => sess('2026-10-' + String(10 + i).padStart(2, '0'), k, [['bb_bench', 0, [[135, 8], [145, 6]]]]));
  const mk = () => makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true });

  const a = mk();
  a.click('repeat');
  ok('classic: no Log Book row, and none of its markup', !/wc-lbrow/.test(a.html()) && !/wc-lb-/.test(a.html()));

  const b = mk();
  b.setUi('logbook');
  b.click('repeat');
  const hb = b.html();
  ok('logbook: each lift has the row with Last / Best e1RM / Today', /class="wc-lbrow"/.test(hb) && /wc-lb-l">Last</.test(hb) && /wc-lb-l">Best e1RM</.test(hb) && /wc-lb-l">Today</.test(hb), (hb.match(/wc-lbrow[^]{0,400}/) || [''])[0]);
  ok('Last shows the top set (145×6) and Today the repeat target', /wc-lb-v">145×6</.test(hb) && /wc-lb-v">\d+(\.\d)?×[^<]+</.test(hb));
  ok('Best carries the unit', /wc-lb-v">\d+ lb</.test(hb));
  ok('one row per lift', (hb.match(/class="wc-lbrow"/g) || []).length === b.live().exercises.length);

  const c = mk();
  c.click('repeat');
  ok('before the switch the open workout has no row', !/wc-lbrow/.test(c.html()));
  c.setUi('logbook');
  ok('switching to Log Book re-draws the OPEN workout at once (row appears)', /wc-lbrow/.test(c.html()));
  c.setUi('classic');
  ok('switching back removes it', !/wc-lbrow/.test(c.html()));
  ok('and the workout itself is untouched by switching (same live session)', !!c.live() && c.live().exercises.length >= 1);

  const d = mk();
  d.click('start');
  d.setUi('logbook');
  ok('a brand-new lift shows dashes, never "undefined" or "NaN"', /wc-lb-v">—</.test(d.html()) && !/undefined|NaN/.test(d.html().slice(d.html().indexOf('wc-lbrow'))));

  const e = mk();
  e.setUi('logbook');
  ok('control: with no workout open a layout switch is harmless (nothing rendered, no throw)', e.html() === '' && e.live() === null);

  ok('the row goes through esc() and the layout is read only from the data-ui attribute', /wc-lb-v">' \+ \(v \? esc\(v\)/.test(UI) && /getAttribute\('data-ui'\)/.test(UI) && !/onclick=/.test(UI));
}

console.log('\n3. layout readiness and styles');
{
  ok('Log Book is ready to pick, Classic still the default', L.byId('logbook').ready === true && L.DEFAULT === 'classic' && L.normLayout('logbook') === 'logbook');
  ok('the other layouts are still not ready (Cockpit went ready 2026-10-25)', ['quest', 'arcade', 'onething', 'journal'].every((id) => L.byId(id).ready === false));
  const lbStart = CSS.indexOf('Log Book');
  const lb = CSS.slice(lbStart, CSS.indexOf('/* ', lbStart + 10) > -1 ? CSS.indexOf('/* ', lbStart + 10) : CSS.length); // just this layout's block
  const rules = lb.split('\n').filter((l) => /\{/.test(l));
  ok('every Log Book rule is scoped to [data-ui="logbook"] (Classic can never be restyled)', rules.length >= 6 && rules.every((l) => /^\[data-ui="logbook"\]/.test(l.trim())), rules.filter((l) => !/^\[data-ui="logbook"\]/.test(l.trim())).join(' | '));
  ok('in-workout inputs stay at least 48px tall', /\.wc-in, \[data-ui="logbook"\] \.wc-rpe \{ height: 48px/.test(lb));
  ok('no !important and no inline style in the layout styles or the row markup', !/!important/.test(CSS) && !/style=/.test(UI.slice(UI.indexOf('function logbookRowHtml'), UI.indexOf('function exerciseHtml'))));
  ok('the page loads the layout assets at bumped versions (so phones refetch)', /layouts\.css\?v=([2-9]|\d\d)/.test(INDEX) && /js\/layout-logic\.js\?v=([2-9]|\d\d)/.test(INDEX) && /js\/layout-ui\.js\?v=([2-9]|\d\d)/.test(INDEX));
  ok('layout-ui announces a switch so open screens can redraw', /nbd-layout/.test(read('js/layout-ui.js')) && /nbd-layout/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
