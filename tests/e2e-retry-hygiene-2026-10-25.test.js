/**
 * tests/e2e-retry-hygiene-2026-10-25.test.js — why the @shard2 leg kept
 * dying at its 25-minute cap after the Island fix (#2731): a CI retry of any
 * spec that saves a lead through _saveLead found the previous attempt's lead.
 *
 *   LeadDedup.normName strips digits, so 'InPath1761380000' and
 *   'InPath1761380400' are the SAME name, and both sit on '1 Storm Row …',
 *   the same street prefix: "Same name on the same street" opens the
 *   possible-duplicate modal, which awaits a click nobody makes. Every retry
 *   then ran to its full test timeout (3 × 240 s in mission-control alone).
 *
 *   1. the login fixture answers that modal on the emulators ("Create anyway"
 *      — a rep's real choice, dedup itself untouched) from an init script, so
 *      it survives the page.reload() specs do after saving
 *   2. mission-control resets the saved Mission state when it picks the layout:
 *      the shard shares one rep, and a previous attempt's Leads layer toggle
 *      came back ON through layoutState (the day-route aria-pressed failure)
 *
 * Run: node tests/e2e-retry-hygiene-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\n0. the trap is real: LeadDedup matches a retry\'s lead by name + street');
{
  const w = {}; global.window = w; global.document = { createElement() { return { style: {}, querySelectorAll() { return []; }, querySelector() { return { addEventListener() {} }; }, addEventListener() {} }; }, body: { appendChild() {} } };
  require(path.join(ROOT, 'docs/pro/js/lead-dedup.js'));
  const prev = { id: 'p1', firstName: 'ZZMC', lastName: 'InPath1761380000', address: '1 Storm Row 380000, Mason, OH 45040', phone: '5133800001' };
  const next = { firstName: 'ZZMC', lastName: 'InPath1761380400', address: '1 Storm Row 380400, Mason, OH 45040', phone: '5133804001' };
  const m = w.LeadDedup.findDuplicates(next, [prev]);
  ok('a retry\'s lead is a medium match on the previous attempt\'s lead', m.length === 1 && m[0].confidence === 'medium', JSON.stringify(m.map((x) => x.reason)));
  ok('…by name on the same street (digits stripped from the name)', m.length === 1 && /same street/i.test(m[0].reason));
  delete global.window; delete global.document;
}

console.log('\n1. the login fixture answers the modal on the emulators');
{
  const A = read('tests/e2e/fixtures/auth.js');
  const fn = A.slice(A.indexOf('async function loginAs('), A.indexOf('\n}\n', A.indexOf('async function loginAs(')));
  ok('loginAs arms the dedup answer from an init script (survives reloads)', /addInitScript\(/.test(fn) && /nbd-dedup-overlay/.test(fn));
  ok('it clicks Create anyway, the rep\'s own choice; dedup itself is untouched', /nbd-dedup-create/.test(fn) && !/LeadDedup\s*=/.test(fn));
  ok('emulator-only: gated on the localhost base URL', /localhost\|127\\\.0\\\.0\\\.1/.test(fn.slice(0, fn.indexOf('addInitScript'))));
  ok('it is armed before the first navigation', fn.indexOf('addInitScript') < fn.indexOf("page.goto('/pro/login.html')"));
  ok('it counts what it answered so a spec can tell', /__nbdDedupAutoCreated/.test(fn));
}

console.log('\n2. mission-control starts from a fresh saved state on every attempt');
{
  const S = read('tests/e2e/mission-control.spec.js');
  const picks = S.match(/LayoutEngine\.saveUser\(\{ id: 'mission'[^\n]*/g) || [];
  ok('three tests pick the Mission layout', picks.length === 3, String(picks.length));
  ok('every pick resets layoutState.mission (tab, mode, layers)', picks.length === 3 && picks.every((p) => /layoutState/.test(p)));
  ok('the fresh state turns the Leads layer OFF so the day-route toggle flips it ON', /leads: false/.test(S) && /FRESH_MISSION/.test(S));
}

console.log('\n3. the suite is in the CI manifest');
{
  const M = read('tests/ci-manifest.json');
  ok('ci-manifest lists this file', M.indexOf('e2e-retry-hygiene-2026-10-25.test.js') !== -1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('  failed: ' + fails.join('; ')); process.exit(1); }
