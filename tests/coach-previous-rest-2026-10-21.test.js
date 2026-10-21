/**
 * tests/coach-previous-rest-2026-10-21.test.js
 *
 * Workout Coach, Strong-style: each working set shows what you did on that set last time ("Previous 185x5"), and the rest
 * timer can beep (iPhone Safari has no navigator.vibrate) as well as vibrate, switchable in the coach settings. Pins the
 * pure logic and drives the real screen file through the DOM stub, including the timer callback, a fake AudioContext and
 * a fake navigator.vibrate.
 *
 * Run: node tests/coach-previous-rest-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
let _n = 0;
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets]) => ({ exId, name: (C.BY_ID[exId] || {}).name || exId, slot, sets: sets.map(([weight, reps, rpe, warm]) => Object.assign({ weight, reps, rpe, done: true }, warm ? { warm: true } : {})) })),
  };
}
const bench = (date, sets) => sess(date, 'push', [['bb_bench', 0, sets]]);

console.log('\n1. previousSets / prevText');
{
  const hist = [bench('2026-10-10', [[175, 5, 8]]), bench('2026-10-14', [[95, 8, 5, true], [185, 5, 8], [185, 5, 8], [180, 4, 9]])];
  const p = C.previousSets('bb_bench', hist);
  ok('the most recent finished session, working sets in order, warm-ups out', JSON.stringify(p) === JSON.stringify([{ weight: 185, reps: 5 }, { weight: 185, reps: 5 }, { weight: 180, reps: 4 }]), JSON.stringify(p));
  ok('never-logged lift -> empty list', C.previousSets('back_squat', hist).length === 0 && C.previousSets('bb_bench', []).length === 0);
  ok('an unfinished session is not "previous"', C.previousSets('bb_bench', [Object.assign(bench('2026-10-15', [[225, 5, 8]]), { finishedAt: 0 }), bench('2026-10-14', [[185, 5, 8]])])[0].weight === 185);
  ok('text: weight x reps', C.prevText({ weight: 185, reps: 5 }) === '185×5' && C.prevText({ weight: 52.5, reps: 8 }) === '52.5×8');
  ok('text: bodyweight is reps only', C.prevText({ weight: 0, reps: 8 }) === '8 reps');
  ok('text: nothing -> empty', C.prevText(undefined) === '');
}

console.log('\n2. rest alert settings');
{
  ok('four modes, both is the default', JSON.stringify(C.REST_ALERTS) === JSON.stringify(['both', 'sound', 'vibrate', 'off']) && C.normRestAlert(undefined) === 'both' && C.normRestAlert('nonsense') === 'both');
  ok('the plan per mode', JSON.stringify(C.restAlertPlan('both')) === '{"sound":true,"vibrate":true}' && JSON.stringify(C.restAlertPlan('sound')) === '{"sound":true,"vibrate":false}' && JSON.stringify(C.restAlertPlan('vibrate')) === '{"sound":false,"vibrate":true}' && JSON.stringify(C.restAlertPlan('off')) === '{"sound":false,"vibrate":false}');
  ok('control: a garbage mode behaves like both (never silently off)', JSON.stringify(C.restAlertPlan('xyz')) === '{"sound":true,"vibrate":true}');
}

console.log('\n3. the real screen: Previous per set');
{
  const hist = [bench('2026-10-12', [[185, 5, 8], [185, 5, 8], [180, 4, 9]]), bench('2026-10-16', [[190, 5, 8], [185, 5, 8], [185, 4, 9]]),
    sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-20' });
  h.click('set-freshness', { val: 'steady' });
  h.click('start');
  const bi = h.live().exercises.findIndex((e) => e.exId === 'bb_bench');
  ok('the bench is on', bi >= 0);
  const html = h.html();
  ok('its working sets show what you did last time, set by set', /Previous 190×5/.test(html) && /Previous 185×5/.test(html) && /Previous 185×4/.test(html), (html.match(/Previous [^<]*/g) || []).join(' | '));
  ok('warm-up rows have no Previous line', (function () { const x = h.live().exercises[bi]; const warm = x.sets.filter((s) => s.warm).length; const prevCount = (html.match(/class="wc-prev"/g) || []).length; return warm >= 0 && prevCount === 3; })(), String((html.match(/class="wc-prev"/g) || []).length));
  ok('a lift with no history shows none (squat day lift never logged here)', (function () { const g = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-20' }); g.click('start'); return !/class="wc-prev"/.test(g.html()); })());
  ok('Previous is read-only text: it never changes a number', /class="wc-prev">Previous /.test(html) && !/data-coach-field="[a-z]*"[^>]*class="wc-prev"/.test(html));
}

console.log('\n4. the rest timer alert (real screen, fake clock, fake audio, fake vibrate)');
{
  function run(mode) {
    const hist = [bench('2026-10-16', [[185, 5, 8], [185, 5, 8], [185, 5, 8]]), sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
    const h = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach: mode ? { restAlert: mode } : {} }, today: '2026-10-20' });
    const log = { ctx: 0, resumed: 0, osc: 0, vib: [], tick: null, unlockedBeforeTap: null };
    h.sandbox.setInterval = (fn) => { log.tick = fn; return 1; };
    h.sandbox.navigator.vibrate = (p) => { log.vib.push(p); return true; };
    h.sandbox.AudioContext = class {
      constructor() { log.ctx++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
      resume() { log.resumed++; this.state = 'running'; }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() { log.osc++; }, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
    h.click('set-freshness', { val: 'steady' });
    h.click('start');
    log.unlockedBeforeTap = log.ctx;
    const bi = h.live().exercises.findIndex((e) => e.exId === 'bb_bench');
    const wi = h.live().exercises[bi].sets.findIndex((s) => !s.warm);
    h.field('reps', bi, wi, '5'); h.click('done', { i: bi, s: wi });
    const RealDate = h.sandbox.Date;
    h.sandbox.Date = class extends RealDate { static now() { return RealDate.now() + 10 * 60 * 1000; } };   // ten minutes later
    if (log.tick) log.tick();
    return log;
  }
  const both = run(undefined);
  ok('the audio context is created only inside the set tap, never at page load', both.unlockedBeforeTap === 0 && both.ctx === 1 && both.resumed === 1, JSON.stringify([both.unlockedBeforeTap, both.ctx, both.resumed]));
  ok('default (both): vibrates and beeps twice when rest ends', both.vib.length === 1 && both.osc === 2, JSON.stringify([both.vib, both.osc]));
  const snd = run('sound');
  ok('sound only: two beeps, no vibration', snd.osc === 2 && snd.vib.length === 0, JSON.stringify([snd.osc, snd.vib]));
  const vib = run('vibrate');
  ok('vibrate only: vibrates, no beep', vib.vib.length === 1 && vib.osc === 0, JSON.stringify([vib.vib, vib.osc]));
  const off = run('off');
  ok('off: silent', off.vib.length === 0 && off.osc === 0, JSON.stringify([off.vib, off.osc]));
  ok('it only fires once per rest (the timer ticks every second)', (function () { const l = run(undefined); l.tick && l.tick(); l.tick && l.tick(); return l.osc === 2 && l.vib.length === 1; })());
  const noAudio = (function () {
    const h = makeHarness({ storage: { nbd_ds_workouts: [bench('2026-10-16', [[185, 5, 8]]), sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])] }, today: '2026-10-20' });
    let tick = null; h.sandbox.setInterval = (fn) => { tick = fn; return 1; };
    h.click('set-freshness', { val: 'steady' }); h.click('start'); const bi = h.live().exercises.findIndex((e) => e.exId === 'bb_bench'); const wi = h.live().exercises[bi].sets.findIndex((s) => !s.warm);
    h.field('reps', bi, wi, '5'); h.click('done', { i: bi, s: wi });
    const RD = h.sandbox.Date; h.sandbox.Date = class extends RD { static now() { return RD.now() + 6e5; } };
    try { tick && tick(); return true; } catch (e) { return false; }
  })();
  ok('a browser with no AudioContext and no vibrate does not break the timer', noAudio === true);
  ok('settings text and the chips exist in the screen file', /When the rest timer ends/.test(UI) && /restalert', 'both', 'Sound \+ vibrate'/.test(UI) && /iPhone Safari cannot vibrate a web page/.test(UI));
  ok('choosing a mode is saved', (function () { const g = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-20' }); g.click('set-restalert', { val: 'sound' }); return (g.settings() || {}).restAlert === 'sound'; })());
  ok('a bad value cannot be saved (falls back to both)', (function () { const g = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-20' }); g.click('set-restalert', { val: 'loud' }); return (g.settings() || {}).restAlert === 'both'; })());
}

console.log('\n5. wiring');
{
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
  ok('audio is unlocked at the top of the checkmark tap', /case 'done': \{\r?\n\s+unlockAudio\(\);/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
