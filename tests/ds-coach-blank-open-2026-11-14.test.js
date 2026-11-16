/**
 * tests/ds-coach-blank-open-2026-11-14.test.js
 *
 * Audit 2026-11-14 bug #1: the Workout button on the Today bar, Next Up, Jump,
 * and the layout cards all call window.NBDCoachUI.open(). With no live workout
 * the overlay opened with empty innerHTML: a blank black screen. Opening the
 * coach with nothing to show must start today's workout (same as the card's
 * Start button); with a live workout it must resume that one, not replace it.
 *
 * Run: node tests/ds-coach-blank-open-2026-11-14.test.js
 */
'use strict';

const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n1. NBDCoachUI.open() with no live workout (Today bar / Next Up / Jump)');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
  ok('control: nothing is live before the tap', h.live() === null);
  h.sandbox.NBDCoachUI.open();
  ok('the overlay is open', h.isOpen());
  ok('it is not blank: the workout logger is drawn', h.html() !== '' && /class="wc-set/.test(h.html()), JSON.stringify(h.html().slice(0, 80)));
  ok('a real live workout was started and saved', !!h.live() && h.live().exercises.length > 0);
}

console.log('\n2. a live workout is resumed, not replaced');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
  h.click('start');
  const id = h.live().id;
  h.click('close');
  h.sandbox.NBDCoachUI.open();
  ok('same workout id after reopening', h.live() && h.live().id === id);
  ok('logger drawn', /class="wc-set/.test(h.html()));
}

console.log('\n3. a stale "Resume workout" tap (live discarded elsewhere) is not blank either');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
  h.click('open');
  ok('the overlay shows a workout, not an empty box', /class="wc-set/.test(h.html()), JSON.stringify(h.html().slice(0, 80)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
