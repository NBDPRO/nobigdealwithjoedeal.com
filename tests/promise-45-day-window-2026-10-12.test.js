#!/usr/bin/env node
/**
 * Jo, 2026-10-12: a promise he made stays on "needs you" past the 14-day
 * window up to 45 days, then rolls into ONE "old promises" review row instead
 * of silently dropping. Home (home-attention.js) and callWatch
 * (call-watch-logic.js) must agree.
 * Run: node tests/promise-45-day-window-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const D = 86400000;
const NOW = Date.parse('2026-10-12T16:00:00Z');
const joP = [{ who: 'jo', text: 'send the quote' }];
const row = (o) => Object.assign({ id: 'c', leadId: 'L1', startedAtMs: NOW - D, status: 'noted', phoneDigits: '8595550101' }, o);

console.log('A. the window, Home and callWatch agree');
[
  ['a 10-day-old promise', row({ startedAtMs: NOW - 10 * D, promises: joP }), true],
  ['a 30-day-old promise (was dropped at 14)', row({ startedAtMs: NOW - 30 * D, promises: joP }), true],
  ['a 44-day-old promise', row({ startedAtMs: NOW - 44 * D, promises: joP }), true],
  ['a 46-day-old promise rolls off the live list', row({ startedAtMs: NOW - 46 * D, promises: joP }), false],
  ['a 30-day-old URGENT call with no promise stays 14 days', row({ startedAtMs: NOW - 30 * D, urgent: true }), false],
  ['a 20-day-old promise already marked kept', row({ startedAtMs: NOW - 20 * D, promises: [{ who: 'jo', text: 'x', keptAtMs: NOW - D }] }), false],
  ['a 20-day-old promise, handled', row({ startedAtMs: NOW - 20 * D, promises: joP, handledAtMs: NOW - D }), false],
  ['a 20-day-old promise, task done', row({ startedAtMs: NOW - 20 * D, promises: joP, taskDone: true }), false],
  ['a 20-day-old promise on a spam call', row({ startedAtMs: NOW - 20 * D, promises: joP, callType: 'spam' }), false],
  ['a 20-day-old promise THEY made (not Jo)', row({ startedAtMs: NOW - 20 * D, promises: [{ who: 'them', text: 'call back' }] }), false],
].forEach(([label, c, want]) => {
  const h = HA.callNeedsYou(c, NOW), s = W.callNeedsYou(c, NOW);
  ok(label + ' -> ' + want, h === want && s === want, 'home=' + h + ' server=' + s);
});
const hidden = { '8595550101': { kind: 'spam', policy: 'hide' } };
ok('a hidden number still surfaces an old promise (a promise ALWAYS surfaces)',
  HA.callNeedsYou(row({ startedAtMs: NOW - 30 * D, promises: joP }), NOW, { labels: hidden }) === true && W.callNeedsYou(row({ startedAtMs: NOW - 30 * D, promises: joP }), NOW, { labels: hidden }) === true);

console.log('B. the old-promises review row');
const rows = [
  row({ id: 'a', startedAtMs: NOW - 60 * D, promises: joP }),
  row({ id: 'b', startedAtMs: NOW - 70 * D, promises: joP }),                         // same person
  row({ id: 'c', leadId: null, phoneDigits: '5135550177', startedAtMs: NOW - 80 * D, promises: joP }),
  row({ id: 'd', startedAtMs: NOW - 20 * D, promises: joP }),                          // still live, not "old"
  row({ id: 'e', startedAtMs: NOW - 90 * D, promises: joP, handledAtMs: NOW - 50 * D }), // handled
];
ok('counts PEOPLE (two calls from one customer = one row), excludes live + handled', HA.oldPromiseCount(rows, NOW) === 2, String(HA.oldPromiseCount(rows, NOW)));
ok('they are NOT in "people need you" (no double count)', HA.callersNeedingYou(rows, NOW) === 1);
ok('the strip names them: "N old promises to review"', /2 old promises to review/.test(HA.stripHtml({ oldPromises: 2 })) && /data-target="calls"/.test(HA.stripHtml({ oldPromises: 2 })));
ok('...and nothing when there are none', HA.stripHtml({ oldPromises: 0 }) === '');

console.log('C. wiring');
const cc = fs.readFileSync(path.join(ROOT, 'docs/pro/js/call-center-view.js'), 'utf8');
ok('the Call Center has an "Old promises" filter using the same predicate', /\['oldpromises', 'Old promises'/.test(cc) && /HA\.isOldPromise\(c, Date\.now\(\)\)/.test(cc));
const ha = fs.readFileSync(path.join(ROOT, 'docs/pro/js/home-attention.js'), 'utf8');
ok('Home computes it from the rows it already loaded (no extra read)', /out\.oldPromises = oldPromiseCount\(callRows, Date\.now\(\)\)/.test(ha));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
