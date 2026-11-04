/**
 * tests/coach-overlay-keyboard-2026-10-24.test.js
 *
 * Overnight audit 2026-10-23 (pass 1, "Workout coach keyboard (390)", Medium):
 * Enter on START TODAY'S WORKOUT opened #wcOverlay, but focus stayed behind it,
 * Tab walked the page underneath, and Escape did nothing. #2667 added
 * role="dialog"; this pins the rest of the dialog contract on the REAL screen
 * file (tests/helpers/coach-ui-harness.js):
 *   - aria-modal="true" and focusable (tabindex -1)
 *   - opening moves focus to the first control inside
 *   - Tab / Shift+Tab wrap inside it, and a Tab from outside lands inside
 *   - Escape closes it (same as the Close button: the workout stays saved)
 *   - closing gives focus back to the button that opened it, or to the
 *     re-drawn button with the same action
 *
 * Run: node tests/coach-overlay-keyboard-2026-10-24.test.js
 */
'use strict';

const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ov = (h) => h.sandbox.document.getElementById('wcOverlay');

console.log('\n1. opening');
{
  const h = makeHarness({ fitness: true });
  const opener = h.pageButton('start');
  h.focusOn(opener);
  h.click('start');
  ok('control: START opened the overlay with a live workout', h.isOpen() && !!h.live());
  ok('the overlay is a modal dialog (aria-modal="true")', ov(h).getAttribute('aria-modal') === 'true' && ov(h).getAttribute('role') === 'dialog');
  ok('it can take focus itself (tabindex -1)', ov(h).tabIndex === -1);
  const f = h.focusables();
  ok('control: the overlay has controls to focus', f.length > 2, String(f.length));
  ok('focus moved inside, to its first control', h.active() === f[0], h.active() && (h.active().tag + ' ' + JSON.stringify(h.active().dataset)));
}

console.log('\n2. Tab stays inside');
{
  const h = makeHarness({ fitness: true });
  h.focusOn(h.pageButton('start'));
  h.click('start');
  const f = h.focusables();
  h.focusOn(f[f.length - 1]);
  let ev = h.key('Tab');
  ok('Tab on the last control wraps to the first', h.active() === f[0] && ev.defaultPrevented);
  ev = h.key('Tab', { shiftKey: true });
  ok('Shift+Tab on the first control wraps to the last', h.active() === f[f.length - 1] && ev.defaultPrevented);
  h.focusOn(f[1]);
  ev = h.key('Tab');
  ok('control: Tab in the middle is left to the browser', !ev.defaultPrevented && h.active() === f[1]);
  const behind = h.pageButton('repeat');
  h.focusOn(behind);
  ev = h.key('Tab');
  ok('a Tab while focus is behind the overlay lands inside it', h.active() === f[0] && ev.defaultPrevented);
}

console.log('\n3. Escape and closing');
{
  const h = makeHarness({ fitness: true });
  const opener = h.pageButton('start');
  h.focusOn(opener);
  h.click('start');
  const liveBefore = JSON.stringify(h.live());
  const ev = h.key('Escape');
  ok('Escape closes the overlay', !h.isOpen() && ev.defaultPrevented);
  ok('...and the workout in progress is still saved (Escape is the Close button)', JSON.stringify(h.live()) === liveBefore && !!h.live());
  ok('focus goes back to the button that opened it', h.active() === opener);
  const ev2 = h.key('Escape');
  ok('control: Escape with the overlay closed does nothing', !ev2.defaultPrevented);
}
{
  const h = makeHarness({ fitness: true });
  const opener = h.pageButton('start');
  h.focusOn(opener);
  h.click('start');
  opener.gone = true;                        // the card was re-drawn under the overlay
  const redrawn = h.pageButton('start');
  h.click('close');
  ok('if the opener was re-drawn, focus goes to the new button with the same action', h.active() === redrawn);
}
{
  const h = makeHarness({ fitness: true });
  h.focusOn(h.pageButton('start'));
  h.click('start');
  h.click('close');
  const reopener = h.pageButton('open');
  h.focusOn(reopener);
  h.click('open');
  ok('re-opening (Resume) moves focus inside again', h.isOpen() && h.active() === h.focusables()[0]);
  const f = h.focusables();
  h.focusOn(f[f.length - 1]);
  h.click('settings');                       // a re-render while open must not reset the opener
  h.key('Escape');
  ok('after re-renders inside, closing still returns focus to the Resume button', h.active() === reopener);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
