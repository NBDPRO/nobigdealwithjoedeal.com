/**
 * tests/ds-rest-alert-2026-11-14.test.js
 *
 * Audit 2026-11-14 #11: the rest-timer alert.
 *   - Nothing kept the screen on, so the phone auto-locked mid-rest and the page's timers stopped: no alert until Jo
 *     unlocked it. Now a screen wake lock is held while a rest runs (released when it ends or is skipped, taken again
 *     when the app comes back mid-rest). Where the browser has no wake lock nothing changes.
 *   - After a reload the rest is restored, but the beep needs an audio context unlocked by a tap, and only a set's
 *     checkmark did that, so a restored rest ended silently on iPhone (no vibration API there). Now the first tap
 *     anywhere after a restore unlocks the sound.
 * This cannot alert through a locked phone: a web page has no background alarm. The wake lock keeps it from locking.
 *
 * Run: node tests/ds-rest-alert-2026-11-14.test.js
 */
'use strict';
const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function fakeWakeLock(h) {
  const log = { requests: 0, releases: 0 };
  h.sandbox.navigator.wakeLock = { request: async (type) => { log.requests++; log.type = type; return { released: false, release: async function () { this.released = true; log.releases++; }, addEventListener() {} }; } };
  return log;
}
function fakeAudio(h) {
  const log = { made: 0 };
  h.sandbox.AudioContext = class { constructor() { log.made++; this.state = 'running'; this.currentTime = 0; this.destination = {}; } createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: {} }; } createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } };
  return log;
}

(async () => {
  console.log('\n1. the screen stays on while a rest runs');
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
    const wl = fakeWakeLock(h); fakeAudio(h);
    h.click('start');
    ok('control: no wake lock before any rest', wl.requests === 0);
    h.click('done', { i: 0, s: 0 }); await flush();
    const resting = !!h.store.get('nbd_ds_coach_rest');
    ok('control: ticking a set started a rest', resting);
    ok('a screen wake lock is requested while it runs', wl.requests === 1 && wl.type === 'screen', JSON.stringify(wl));
    h.click('skip-rest'); await flush();
    ok('...and released when the rest is skipped', wl.releases === 1, JSON.stringify(wl));
  }
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
    fakeAudio(h);
    h.click('start');
    let threw = null;
    try { h.click('done', { i: 0, s: 0 }); await flush(); } catch (e) { threw = e; }
    ok('a browser with no wake lock still runs the rest (no error)', !threw && !!h.store.get('nbd_ds_coach_rest'), String(threw));
  }

  console.log('\n2. a rest restored after a reload can still beep');
  {
    const until = Date.now() + 90000;
    const h = makeHarness({ storage: { nbd_ds_workouts: [], nbd_ds_coach_rest: { until, label: 'Bench' } }, today: '2026-11-14' });
    const au = fakeAudio(h);
    ok('control: nothing unlocked the sound yet after the reload', au.made === 0);
    h.click('nothing-in-particular');   // Jo taps anywhere on the page
    ok('the first tap anywhere unlocks the sound for the restored rest', au.made === 1, JSON.stringify(au));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
