/**
 * tests/docgen-address-guard.test.js — the address-completeness gate on DocPreflight.
 *
 * WHY THIS EXISTS
 * ───────────────
 * DocPreflight marks `address` required, but `required` only asserts non-empty
 * (isEmpty). A Thumbtack lead that never shared its street arrives as
 * "Fairfield, OH 45014" — non-empty, so it passed the gate, and on 2026-08-18
 * five invoices generated carrying no street address at all ($4,636.25 across
 * five customers, names removed). A sixth class of damage —
 * pre-Wave-141 rows like "7003, Wrenfield Trace, O'Bannon Creek" — was also
 * sailing through. See documentation/audit/CRM-ADDRESS-INTEGRITY-2026-08-18.md.
 *
 * The fix adds validateAddressCompleteness() + FIELD_VALIDATORS to
 * doc-preflight.js and soft-blocks submit(): first click warns and re-renders
 * with "Generate Anyway", a second deliberate click proceeds. A genuinely
 * street-less lead is not a dead end, but a thin address can never leave
 * silently.
 *
 * This test evaluates the REAL validator lifted out of the shipped source
 * (not a copy) so the two cannot drift, then asserts the wiring is present.
 *
 * Run: node tests/docgen-address-guard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/doc-preflight.js'), 'utf8');

// ── Lift the real validator (regexes + function) out of the shipped file ──
const start = SRC.indexOf('var ADDR_HOUSE_NUMBER');
const endMarker = 'var FIELD_VALIDATORS';
const end = SRC.indexOf(endMarker);
const block = start >= 0 && end > start ? SRC.slice(start, end) : '';

console.log('ADDRESS GUARD — validator extraction');
ok('validator block found in doc-preflight.js', block.length > 0);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block + '\nthis.validateAddressCompleteness = validateAddressCompleteness;', sandbox);
const v = sandbox.validateAddressCompleteness;
ok('validateAddressCompleteness is callable', typeof v === 'function');

console.log('\nADDRESS GUARD — complete addresses pass');
ok('full OH address passes', v('100 Kentucky Ave, Cincinnati, OH 45223') === null);
ok('Ginkgo address passes', v('129 W Marrowbone Ave, Cincinnati, OH 45216') === null);
ok('KY address passes', v('1912 Ashgrove St, Covington, KY 41014') === null);
ok('ZIP+4 passes', v('26 Brambleton Ave, Loveland, OH 45140-1234') === null);

console.log('\nADDRESS GUARD — empty defers to `required`');
ok('empty string returns null (required owns it)', v('') === null);
ok('null returns null', v(null) === null);
ok('undefined returns null', v(undefined) === null);

console.log('\nADDRESS GUARD — the five invoices that shipped thin on 2026-08-18');
ok('Firman "Fairfield, OH 45014" flagged', /street number/.test(v('Fairfield, OH 45014') || ''));
ok('Customer "Batavia, OH 45103" flagged', /street number/.test(v('Batavia, OH 45103') || ''));
ok('Ivyson "Cincinnati, OH 45211" flagged', /street number/.test(v('Cincinnati, OH 45211') || ''));
ok('Customer "Alexandria, KY 41001" flagged', /street number/.test(v('Alexandria, KY 41001') || ''));
ok('Dogwoodson "Wrenmoor Ave, Cincinnati, OH" flagged', (v('Wrenmoor Ave, Cincinnati, OH') || '').length > 0);

console.log('\nADDRESS GUARD — pre-Wave-141 mangled rows');
ok('Cedarly mangled row flagged as mangled',
  /mangled/.test(v("7003, Wrenfield Trace, O'Bannon Creek") || ''));
ok('Larry mangled row flagged as mangled',
  /mangled/.test(v('5368, Fernbrook Valley Drive, The Village of Fernbrook Valley') || ''));
ok('Kevin Hazelton mangled row flagged as mangled',
  /mangled/.test(v('123, Wrenfield, Franklin County') || ''));

console.log('\nADDRESS GUARD — partial addresses name what is missing');
ok('Elmsworth "5007 Kestrelwood Ln" reports state + ZIP', /state/.test(v('5007 Kestrelwood Ln') || '') && /ZIP/.test(v('5007 Kestrelwood Ln') || ''));
ok('no ZIP is reported', /ZIP/.test(v('129 W Marrowbone Ave, Cincinnati, OH') || ''));
ok('no state is reported', /state/.test(v('129 W Marrowbone Ave, Cincinnati 45216') || ''));

console.log('\nADDRESS GUARD — wiring in doc-preflight.js');
ok('FIELD_VALIDATORS maps the address keys',
  /FIELD_VALIDATORS\s*=\s*\{[\s\S]*?address:\s*validateAddressCompleteness/.test(SRC) &&
  /projectAddress:\s*validateAddressCompleteness/.test(SRC) &&
  /propertyAddress:\s*validateAddressCompleteness/.test(SRC));
ok('collectSoftIssues() exists', /function collectSoftIssues\(/.test(SRC));
ok('submit() soft-blocks on the first attempt',
  /var soft = collectSoftIssues\(\);[\s\S]{0,400}?if \(soft\.length && !state\.softAck\)/.test(SRC));
ok('submit() returns without generating while unacknowledged',
  /if \(soft\.length && !state\.softAck\)[\s\S]{0,400}?renderModal\(\);[\s\S]{0,40}?return;/.test(SRC));
ok('button switches to "Generate Anyway" when issues are present',
  /state\.softIssues\.length \? 'Generate Anyway/.test(SRC));
ok('acknowledgement resets on every open() — cannot carry between documents',
  /state\.softAck = false;/.test(SRC) && /state\.softIssues = \[\];/.test(SRC));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
