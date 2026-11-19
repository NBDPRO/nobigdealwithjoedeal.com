/**
 * tests/call-center-paren-numbers-2026-11-18.test.js — functions/call-center-logic.js
 * parseCubeAcrName for a Cube ACR name whose only "label" is the number in
 * US format: "2026-11-11 13-12-10 (phone) (513) 555-0199 ↗.m4a".
 *
 * 2026-11-18: that form parsed with phoneDigits '' and the number as the
 * contact name, so those calls never matched a lead, and the re-upload guard
 * (start second + number) missed them: 7 duplicate calls were filed and had
 * to be removed by hand.
 *
 * Names and numbers are invented (555 exchange).
 * Run: node tests/call-center-paren-numbers-2026-11-18.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const p = L.parseCubeAcrName('2026-11-11 13-12-10 (phone) (513) 555-7290 ↗.m4a');
ok('"(513) 555-7290" is read as the number', p && p.phoneDigits === '5135557290', JSON.stringify(p));
ok('...not as a contact name', p && p.contactName === '' && p.savedContact === false, JSON.stringify(p && { n: p.contactName, s: p.savedContact }));
ok('...direction kept', p && p.direction === 'outbound');
const raw = L.parseCubeAcrName('phone_20261111-131210_5135557290.m4a');
ok('it agrees with the phone\'s own name for the same call (start + number)', p && raw && p.startedAtMs === raw.startedAtMs && p.phoneDigits === raw.phoneDigits);
const named = L.parseCubeAcrName('2026-04-02 15-24-50 (phone) Jo Phone 2025 ((513) 555-2406) ↗.m4a');
ok('a contact name with a "(513) ..." number parses with a clean name', named && named.phoneDigits === '5135552406' && named.contactName === 'Jo Phone 2025', JSON.stringify(named && { d: named.phoneDigits, n: named.contactName }));
const plus = L.parseCubeAcrName('2026-11-17 15-05-11 (phone) +1 904-555-5490 ↙.m4a');
ok('a "+1 ..." bare number still parses', plus && plus.phoneDigits === '9045555490' && plus.contactName === '');
const vo = L.parseCubeAcrName('2026-11-05 10-00-00 (phone) Private Caller ↙.m4a');
ok('a contact with no number stays a name', vo && vo.contactName === 'Private Caller' && vo.phoneDigits === '');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
