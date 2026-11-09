/**
 * tests/customer-calls-review-2026-11-06.test.js — PR steward review of #2946
 * (calls matched by number on the customer card).
 *
 * 1. A by-number row has no leadId, and callCenterAction 'move' refuses such a
 *    call ("not filed on a customer"), so it must not offer "Wrong customer →
 *    move to…". A filed call keeps it.
 * 2. On a cold load window._customerId lands before window._leadDoc, so
 *    leadDigits() was '' and the by-number query was skipped. The loader now
 *    waits for the lead doc (then loads anyway after ~12 s).
 * Real renderPhoneCall and the real wait() loop in a vm. Zero deps.
 * Run: node tests/customer-calls-review-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'customer-calls.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('NO MOVE ON A BY-NUMBER ROW');
{
  const s = SRC.indexOf('  function renderPhoneCall(c) {');
  const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n  }\n', s) + 4) : '';
  ok('renderPhoneCall found (positive control)', fn.length > 500);
  const sb = { chip: (t) => '<span>' + t + '</span>', esc: (x) => String(x == null ? '' : x), fmtPhone: (d) => d || '', isViewer: () => false, briefGate: () => '', Array, Date, String };
  vm.createContext(sb);
  vm.runInContext(fn + '\nglobalThis.__r = renderPhoneCall;', sb);
  const filed = sb.__r({ _id: 'c1', leadId: 'L1', startedAtMs: 1, direction: 'inbound' });
  const byNum = sb.__r({ _id: 'c2', _byNumber: true, startedAtMs: 1, direction: 'inbound' });
  ok('a filed call still offers "Wrong customer → move to…" (positive control)', /data-calls-act="pc-moveopen"/.test(filed));
  ok('a call matched only by number does not', !/data-calls-act="pc-moveopen"/.test(byNum));
  ok('…but keeps ✓ Handled (the server allows it on an unfiled call)', /data-calls-act="pc-handled"/.test(byNum));
}

console.log('WAIT FOR THE LEAD DOC');
{
  const s = SRC.indexOf('  var tries = 0;\n  (function wait() {');
  const blk = s >= 0 ? SRC.slice(s, SRC.indexOf('\n  })();\n', s) + 8) : '';
  ok('the wait loop is found (positive control)', /function wait\(\)/.test(blk));
  const timers = [];
  let loads = 0;
  const win = { db: {}, auth: { currentUser: { uid: 'u' } }, _customerId: 'L1', getDocs() {}, collection() {} };
  const sb = { window: win, load: () => { loads++; }, setTimeout: (f) => { timers.push(f); } };
  vm.createContext(sb);
  vm.runInContext(blk, sb);
  ok('filed calls load straight away (positive control)', loads === 1, String(loads));
  for (let i = 0; i < 3 && timers.length; i++) timers.shift()();
  ok('…and it keeps watching for the lead doc', loads === 1 && timers.length === 1);
  win._leadDoc = { phone: '5135550100' };
  while (timers.length) timers.shift()();
  ok('when the lead doc lands it loads again, so by-number calls appear', loads === 2, String(loads));
  // Never polls forever: with no lead doc at all it stops after the cap.
  const t2 = []; let l2 = 0;
  const sb2 = { window: { db: {}, auth: { currentUser: { uid: 'u' } }, _customerId: 'L1', getDocs() {}, collection() {} }, load: () => { l2++; }, setTimeout: (f) => { t2.push(f); } };
  vm.createContext(sb2);
  vm.runInContext(blk, sb2);
  let n = 0;
  while (t2.length && n < 500) { t2.shift()(); n++; }
  ok('with no lead doc ever, the watch stops after the cap (no endless polling)', t2.length === 0 && n < 100 && l2 === 1, n + ' ticks, ' + l2 + ' loads');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
