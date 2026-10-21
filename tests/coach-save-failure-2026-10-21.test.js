/**
 * tests/coach-save-failure-2026-10-21.test.js
 *
 * Found by the independent silent-failure review: finishing a workout cleared the live
 * session even when the device refused the write, and a rejected cloud push was unhandled;
 * a bodyweight lift (logged at 0 lb) never earned a live Rep PR because its best 1RM is 0;
 * and the section toggle wrote storage unguarded. Drives the real coach screen.
 *
 * Run: node tests/coach-save-failure-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const APP = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const stripC = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

function started(hist) {
  const h = makeHarness({ storage: { nbd_ds_workouts: hist || [] }, today: '2026-10-21' });
  h.click('set-freshness', { val: 'steady' });
  h.click('start');
  const live = h.live();
  const wi = live.exercises[0].sets.findIndex((s) => !s.warm);
  h.field('weight', 0, wi, '135'); h.field('reps', 0, wi, '10'); h.click('done', { i: 0, s: wi });
  return h;
}

console.log('\n1. A failed save keeps the workout open');
{
  const h = started();
  const real = h.sandbox.localStorage.setItem;
  h.sandbox.localStorage.setItem = (k, v) => { if (k === 'nbd_ds_workouts') throw new Error('QuotaExceededError'); return real(k, v); };
  h.click('finish');
  ok('the live session is still there', !!h.live());
  ok('nothing was recorded as saved', h.saved().length === 0);
  ok('Jo is told, in plain words', h.toasts.some((t) => /couldn't save this workout/i.test(t)), h.toasts.join('|'));
  ok('the summary screen was not shown', !/wc-prs|Workout done|wc-summary/.test(h.html()) || h.live() !== null);
  h.sandbox.localStorage.setItem = real;
  h.click('finish');
  ok('once storage works again, finishing saves it', h.saved().length === 1 && h.live() === null);
}

console.log('\n2. A rejected or throwing cloud push does not break finishing');
{
  const h = started();
  h.sandbox.NBDDsCloud = { pushWorkout: () => Promise.reject(new Error('offline')) };
  h.click('finish');
  ok('saved on the device despite a rejected push', h.saved().length === 1 && h.live() === null);
  const h2 = started();
  h2.sandbox.NBDDsCloud = { pushWorkout: () => { throw new Error('boom'); } };
  h2.click('finish');
  ok('saved on the device despite a throwing push', h2.saved().length === 1 && h2.live() === null);
  setImmediate(() => {
    ok('no unhandled rejection escaped', unhandled.length === 0, String(unhandled[0]));
    part3();
  });
}

function part3() {
  console.log('\n3. Bodyweight live Rep PR');
  const sess = (date, sets) => ({ id: 'b' + date, date, split: 'pull', startedAt: 1, finishedAt: 2,
    exercises: [{ exId: 'pullup', name: 'Pull-up', slot: 0, sets: sets.map(([weight, reps]) => ({ weight, reps, done: true })) }] });
  const prior = [sess('2026-10-10', [[0, 8]])];
  const live = (reps) => ({ exId: 'pullup', sets: [{ weight: 0, reps, done: true }] });
  const r = C.livePR(live(10), prior);
  ok('more bodyweight reps than ever earns a live Rep PR', !!r && r.kind === 'reps', JSON.stringify(r));
  ok('equal reps does not', C.livePR(live(8), prior) === null);
  ok('no history still earns nothing', C.livePR(live(10), []) === null);
  const weighted = [sess('2026-10-10', [[25, 8]])];
  ok('weighted pull-ups: the 1RM path still works', !!C.livePR({ exId: 'pullup', sets: [{ weight: 45, reps: 5, done: true }] }, weighted));

  console.log('\n4. Section toggle storage is guarded');
  const src = stripC(APP);
  const m = src.match(/function toggleSection[\s\S]*?\n\}/);
  const body = m ? m[0] : '';
  ok('toggleSection found', !!body);
  ok('the read is inside try/catch', /try\{st=JSON\.parse\(localStorage\.getItem\('nbd_collapsed'\)/.test(body.replace(/\s/g, '')) || /try\s*\{\s*st\s*=\s*JSON\.parse/.test(body));
  ok('the write is inside try/catch', /try\s*\{\s*localStorage\.setItem\('nbd_collapsed'/.test(body));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
