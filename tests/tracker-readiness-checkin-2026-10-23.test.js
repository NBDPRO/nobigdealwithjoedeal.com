/**
 * tests/tracker-readiness-checkin-2026-10-23.test.js
 *
 * Daily Success: the 10-second morning readiness check-in on the day page
 * (checkin-logic.js, checkin-ui.js). The scoring is the coach's existing
 * readiness(); this feeds the same store (nbd_ds_coach_ready) the coach reads.
 * Clock-dependent checks pass the hour in / fake Date - never the real clock.
 *
 * Run: node tests/tracker-readiness-checkin-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const K = require(path.join(DS, 'js', 'checkin-logic.js'));
const C = require(path.join(DS, 'js', 'workout-coach-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; }
}
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\s*\/\/.*$/gm, '');
const T = '2026-10-23';

console.log('\n1. three taps record into the coach\'s own store shape');
{
  let m = K.tap({}, T, 'sleep', 2);
  ok('one tap is a partial record', m[T].sleep === 2 && !K.isComplete(m[T]));
  m = K.tap(m, T, 'sore', 1); m = K.tap(m, T, 'energy', 3);
  ok('three taps complete it, in { sleep, sore, energy } shape', K.isComplete(m[T]) && JSON.stringify(Object.keys(m[T]).sort()) === '["energy","sleep","sore"]');
  ok('the coach reads it as a finished check-in (shared store)', C.readiness(m[T]).complete === true && C.readiness(m[T]).total === 6);
  ok('a rough set of taps reads as low readiness', C.readiness(K.tap(K.tap(K.tap({}, T, 'sleep', 1), T, 'sore', 1), T, 'energy', 1)[T]).level === 'low');
  ok('re-tapping a row changes only that row', K.tap(m, T, 'sleep', 3)[T].sore === 1);
  ok('does not mutate the old map', (() => { const o = {}; K.tap(o, T, 'sleep', 2); return Object.keys(o).length === 0; })());
}

console.log('\n2. bad input changes nothing (negative controls)');
{
  ok('score 0, 4 and text are refused', ['0', 4, 'x', null, -1].every((v) => Object.keys(K.tap({}, T, 'sleep', v)).length === 0));
  ok('an unknown row is refused', Object.keys(K.tap({}, T, 'mood', 2)).length === 0);
  ok('a bad date is refused', Object.keys(K.tap({}, 'today', 'sleep', 2)).length === 0);
  const full = { [T]: { sleep: 3, sore: 3, energy: 3 } };
  ok('skip never overwrites a finished check-in', K.isComplete(K.skip(full, T)[T]));
  ok('a tap after a skip starts a fresh record', K.tap(K.skip({}, T), T, 'sleep', 2)[T].skipped === undefined);
  ok('reset forgets only that day', (() => { const r = K.reset({ [T]: { sleep: 1, sore: 1, energy: 1 }, '2026-10-22': { sleep: 2, sore: 2, energy: 2 } }, T); return !r[T] && !!r['2026-10-22']; })());
  let big = {};
  for (let i = 0; i < 40; i++) big = K.tap(big, new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), 'sleep', 2);
  ok('only the last 30 days are kept, oldest dropped', Object.keys(big).length === 30 && !big['2026-09-01'] && !!big['2026-10-10']);
}

console.log('\n3. when it shows (never nags)');
{
  ok('today, morning, nothing yet: ask', K.state({}, T, T, 8) === 'ask');
  ok('exactly 5 pm goes quiet, 4 pm still asks', K.state({}, T, T, 17) === 'hidden' && K.state({}, T, T, 16) === 'ask');
  ok('late and unanswered: hidden, not nagging', K.state({}, T, T, 22) === 'hidden');
  ok('a past day never shows it', K.state({}, '2026-10-22', T, 8) === 'hidden');
  ok('skipped for the day: nothing shown, even in the morning', K.state({ [T]: { skipped: true } }, T, T, 8) === 'skipped');
  ok('partial taps keep the rows up', K.state({ [T]: { sleep: 2 } }, T, T, 8) === 'partial');
  ok('finished shows the result, even late', K.state({ [T]: { sleep: 2, sore: 2, energy: 2 } }, T, T, 23) === 'done');
  ok('the message names the level honestly', /rough day/.test(K.message(C.readiness({ sleep: 1, sore: 1, energy: 1 }))) && /steady day/.test(K.message(C.readiness({ sleep: 2, sore: 2, energy: 2 }))) && /good to go/.test(K.message(C.readiness({ sleep: 3, sore: 3, energy: 3 }))) && K.message(C.readiness({})) === '');
}

console.log('\n4. card rendering (vm, faked clock)');
{
  function run(hour, stored) {
    const store = Object.assign({}, stored || {});
    const FakeDate = class extends Date { getHours() { return hour; } };
    const win = { todayKey: () => T, toast() {}, NBDCoach: C };
    const ctx = {
      window: win, Date: FakeDate, console, pages: [{ dk: T }], cur: 0,
      document: { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(DS, 'js', 'checkin-logic.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(DS, 'js', 'checkin-ui.js'), 'utf8'), ctx);
    return win.NBDCheckinUI.cardHtml(T);
  }
  const ready = (o) => ({ nbd_ds_coach_ready: JSON.stringify({ [T]: o }) });
  ok('morning: three rows of three chips and a Not today link', (run(8).match(/data-ck-action="tap"/g) || []).length === 9 && /Not today/.test(run(8)));
  ok('evening, unanswered: nothing (negative control)', run(20) === '');
  ok('skipped: nothing (negative control)', run(8, ready({ skipped: true })) === '');
  ok('done: shows the readiness sentence and Change', /Readiness 9\/9 - good to go/.test(run(8, ready({ sleep: 3, sore: 3, energy: 3 }))) && /Change/.test(run(8, ready({ sleep: 3, sore: 3, energy: 3 }))));
  ok('a tapped chip shows as on', /ck-chip on" data-ck-action="tap" data-k="sleep" data-v="2"/.test(run(8, ready({ sleep: 2 }))));
  ok('corrupt storage does not throw', /Morning check-in/.test(run(8, { nbd_ds_coach_ready: '{nope' })));
}

console.log('\n5. wiring and house rules');
{
  const ui = stripComments(read('js', 'checkin-ui.js'));
  const lg = stripComments(read('js', 'checkin-logic.js'));
  const idx = read('index.html');
  const coach = read('js', 'workout-coach.js');
  ok('writes the exact key the coach reads', /KEY = 'nbd_ds_coach_ready'/.test(ui) && /const READY = 'nbd_ds_coach_ready'/.test(coach));
  ok('no inline handlers, no inline scripts, no body.className', !/\son[a-z]+=/i.test(ui) && !/<script/i.test(ui) && !/body\.className\s*=/.test(ui));
  ok('no network or storage in the pure logic', !/fetch\(|localStorage|XMLHttpRequest/.test(lg));
  ok('scripts load with defer; stylesheet linked', /checkin-logic\.js\?v=\d+" defer/.test(idx) && /checkin-ui\.js\?v=\d+" defer/.test(idx) && /css\/checkin\.css/.test(idx));
  const styles = idx.match(/<style[\s\S]*?<\/style>/g);
  ok('phone rules sit in the LAST style block', /\.ck-chip\{/.test(styles[styles.length - 1]) && !styles.slice(0, -1).some((b) => /\.ck-chip\{/.test(b)));
  ok('the coach row labels and the check-in labels agree', JSON.stringify(K.ROWS) === JSON.stringify([
    { k: 'sleep', label: 'Sleep', opts: ['Rough', 'OK', 'Good'] },
    { k: 'sore', label: 'Soreness', opts: ['Very sore', 'Some', 'Fresh'] },
    { k: 'energy', label: 'Energy', opts: ['Low', 'OK', 'High'] }]) && /label: 'Soreness', opts: \['Very sore', 'Some', 'Fresh'\]/.test(coach));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
