/**
 * tests/views-small-2026-11-06.test.js — CRM audit 2026-11-06, three small view fixes.
 *
 * VW-F14 call-center-view.js matchesSearch: "+1 513…" is 11 digits and never
 *        matched the 10-digit phoneDigits the server files.
 * VW-F17 referral-rewards-ui.js: marking a referral bonus paid answered "yes"
 *        when neither nbdConfirm nor window.confirm existed. Fail closed.
 * VW-F58 rep-report-generator.js: "Enrich data" summary was a native alert().
 * Zero deps. Run: node tests/views-small-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

console.log('CALL CENTER NUMBER SEARCH (VW-F14)');
{
  const SRC = read('call-center-view.js');
  const s = SRC.indexOf('  function matchesSearch(c, L) {');
  const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n  }\n', s) + 4) : '';
  ok('matchesSearch found (positive control)', /phoneDigits/.test(fn));
  const sb = { state: { q: '' }, labelFor: () => null, leadName: () => '' };
  vm.createContext(sb);
  vm.runInContext(fn + '\nglobalThis.__m = matchesSearch;', sb);
  const call = { phoneDigits: '5135550142', contactName: 'Sam' };
  sb.state.q = '513-555-0142';
  ok('a 10-digit query matches (positive control)', sb.__m(call, {}) === true);
  sb.state.q = '+1 513 555 0142';
  ok('the same number typed with +1 matches', sb.__m(call, {}) === true);
  sb.state.q = '1 (513) 555-0142';
  ok('…and with a bare leading 1', sb.__m(call, {}) === true);
  sb.state.q = '+1 999 555 0142';
  ok('a different number still does not match', sb.__m(call, {}) === false);
}

console.log('REFERRAL MARK PAID FAILS CLOSED (VW-F17)');
{
  const SRC = read('referral-rewards-ui.js');
  const m = SRC.match(/const _ask = window\.nbdConfirm\s*\n\s*\|\| \(\(m\) => Promise\.resolve\(typeof window\.confirm === 'function' \? window\.confirm\(m\) : (true|false)\)\);/);
  ok('the confirm fallback is found (positive control)', !!m);
  const sb = { window: {} };
  vm.createContext(sb);
  if (m) vm.runInContext(m[0] + '\nglobalThis.__ask = _ask;', sb);
  let answer = 'unset';
  if (sb.__ask) sb.__ask('Mark paid?').then((v) => { answer = v; });
  setImmediate(() => {
    ok('with no confirm dialog at all, it answers "no" (nothing is marked paid)', answer === false, String(answer));
    const sb2 = { window: { confirm: () => true } };
    vm.createContext(sb2);
    if (m) vm.runInContext(m[0] + '\nglobalThis.__ask = _ask;', sb2);
    sb2.__ask('Mark paid?').then((v) => {
      ok('a real confirm still decides (positive control)', v === true);
      rest();
    });
  });
}

function rest() {
  console.log('ENRICH SUMMARY (VW-F58)');
  const SRC = read('rep-report-generator.js');
  const s = SRC.indexOf("summary.knocksGeocoded > 0 ?");
  const blk = s >= 0 ? SRC.slice(s, s + 900) : '';
  ok('the enrich summary block is found (positive control)', /lines\.push\('Warnings: '/.test(blk));
  ok('no native alert() for the summary', !/window\.alert\(lines/.test(blk));
  ok('the summary rides the success toast', /showToast\('\\u2713 Data enriched \\u2014 ' \+ lines\.join\(/.test(blk));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
