/**
 * tests/ask-joe-watcher-removed-2026-10-03.test.js — the Ask Joe "proactive"
 * watcher is gone (Today home, 2026-10-03).
 *
 * docs/pro/js/ask-joe-proactive.js started a 5-minute setInterval two seconds
 * after every dashboard load, plus a timer for 7am, and both wrote alerts to a
 * localStorage queue (nbd_notification_queue) that NOTHING read — while
 * toasting "N overdue follow-ups" by a third follow-up rule (3 days
 * untouched). The Today list is the morning view now.
 *
 * Behavioural: the real file runs in a vm with recording timers, storage and
 * toasts, over a lead book that the old watcher WOULD have alerted on, and
 * the clock is fast-forwarded through every timer it schedules.
 * Break-test: against origin/main the interval, the queue writes and the
 * toast all appear.
 *
 * Run: node tests/ask-joe-watcher-removed-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/ask-joe-proactive.js'), 'utf8');

function run(readyState) {
  const timeouts = [], intervals = [], writes = [], toasts = [], docListeners = {};
  const store = {};
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const win = {
    _leads: [
      { id: 'a', firstName: 'Stale', stage: 'contacted', updatedAt: old, createdAt: old },
      { id: 'b', firstName: 'Quoted', stage: 'estimate_submitted', stageStartedAt: old, createdAt: old },
    ],
    showToast: (m) => toasts.push(m),
  };
  win.window = win;
  const ctx = {
    window: win,
    document: { readyState, addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); } },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { writes.push(k); store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1000 + intervals.length; },
    clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Object, Set, Map, Array, String, Number, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'ask-joe-proactive.js' });
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn());
  // Fast-forward: run every timer it schedules (bounded).
  for (let i = 0; i < 20 && timeouts.length; i++) timeouts.shift().fn();
  intervals.forEach((t) => t.fn());
  return { timeouts, intervals, writes, toasts, win };
}

for (const rs of ['complete', 'loading']) {
  console.log('\ndocument.readyState = ' + rs);
  const r = run(rs);
  ok('no repeating timer (the 5-minute watcher)', r.intervals.length === 0, r.intervals.map((t) => t.ms).join(','));
  ok('no scheduled work at all on page load (no 2 s kick-off, no 7am timer)', r.timeouts.length === 0);
  ok('nothing written to the dead notification queue', !r.writes.includes('nbd_notification_queue'), r.writes.join(','));
  ok('no once-a-day scan markers written', !r.writes.some((k) => /^nbd_proactive_/.test(k)), r.writes.join(','));
  ok('no "N overdue follow-ups" toast by a third rule', r.toasts.length === 0, r.toasts.join(' | '));
  ok('still not a window global (Globals Tranche 1)', r.win.AskJoeProactive === undefined);
}
const src = SRC.replace(/\/\/[^\n]*/g, '');
ok('the morning briefing builder is kept (on demand only)', /function buildMorningBriefing\(\)/.test(src));
ok('no queue / watcher code left behind', !/pushToQueue|startWatcher|runWatcherScan|setInterval|nbd_notification_queue/.test(src));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
