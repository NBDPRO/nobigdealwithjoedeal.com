#!/usr/bin/env node
/**
 * tests/push-optin-waits-for-calm-2026-11-19.test.js — the "Turn on
 * appointment reminders" card waits for a calm moment.
 *
 * Phone sweep 2026-11-19: the card landed 4 s after load on every layout, on
 * top of the first screen and the Record visit button. showWhenCalm now waits
 * for 15 s after load, 3 s with no input, the tab visible, and no dialog, tour
 * or layout offer up, re-checking every 1.5 s for 10 minutes.
 *
 * Behavior test: showWhenCalm is cut out of the shipped file and run against a
 * fake clock and DOM.
 *
 * Run: node tests/push-optin-waits-for-calm-2026-11-19.test.js
 */
const K = require('./lib/src-kit');
const src = K.read('docs/pro/js/push-registration.js');
const body = K.sliceFn(src, 'showWhenCalm');

let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failed++; }

function run(o) {
  const t0 = 1000000;
  const calls = { shown: 0, timers: [], selector: null };
  const doc = { hidden: !!o.hidden, querySelector: (s) => { calls.selector = s; return o.busy ? {} : null; } };
  const f = new Function('document', 'Date', 'setTimeout', 'showOptInCard', '_lastIn', body + '; return showWhenCalm;')(
    doc, { now: () => t0 + o.since }, (fn, ms) => calls.timers.push(ms), () => calls.shown++, t0 + o.since - o.idle);
  f(t0);
  return calls;
}

check('is calm after 15 s and 3 s idle: the card shows, nothing is re-queued', (() => { const c = run({ since: 20000, idle: 5000 }); return c.shown === 1 && c.timers.length === 0; })());
check('not before 15 s since load: waits and re-checks in 1.5 s', (() => { const c = run({ since: 4000, idle: 4000 }); return c.shown === 0 && c.timers.join() === '1500'; })());
check('not while the rep just touched the screen (under 3 s)', (() => { const c = run({ since: 20000, idle: 1000 }); return c.shown === 0 && c.timers.length === 1; })());
check('not while a dialog, the tour or the layout offer is up', (() => { const c = run({ since: 20000, idle: 5000, busy: true }); return c.shown === 0 && c.timers.length === 1 && /aria-modal/.test(c.selector) && /nbd-onb-skip/.test(c.selector) && /lo-banner/.test(c.selector); })());
check('not while the tab is hidden', (() => { const c = run({ since: 20000, idle: 5000, hidden: true }); return c.shown === 0 && c.timers.length === 1; })());
check('gives up after 10 minutes (no endless timer)', (() => { const c = run({ since: 700000, idle: 100, busy: true }); return c.shown === 0 && c.timers.length === 0; })());

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
