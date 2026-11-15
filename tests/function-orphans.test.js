/**
 * tests/function-orphans.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Proves scripts/check-function-orphans.js can go RED.
 *
 * The check it guards is the one that did not exist when eight retired
 * functions sat deployed for four months. A detector for that failure which
 * is itself only known-green would be the same joke told twice — so every
 * verdict below is driven from a fixture with a known answer, including the
 * two "I could not tell" cases, which must NOT look like success.
 *
 * Runs on fixtures via --expected-from / --deployed-from, so it needs neither
 * gcloud nor a loadable functions/ tree and belongs in the REQUIRED
 * unit-suite job rather than an advisory one.
 *
 * Run: node tests/function-orphans.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-function-orphans.js');
const FIX = path.join(__dirname, 'fixtures', 'function-orphans');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}

/** Run the checker on fixtures; returns {status, report}. Never throws. */
function run(deployedFixture, extra = [], expectedFixture = 'expected.txt') {
  const argv = [
    SCRIPT,
    '--expected-from', path.join(FIX, expectedFixture),
    '--deployed-from', path.join(FIX, deployedFixture),
    '--json',
    ...extra,
  ];
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, argv, { encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout || '';
    status = typeof e.status === 'number' ? e.status : 1;
  }
  let report = null;
  try { report = JSON.parse(stdout); } catch (e) { /* exit-2 paths print to stderr */ }
  return { status, report };
}

console.log('FUNCTION ORPHAN DETECTOR — proving it can go red');
console.log('='.repeat(64));

// ── The clean case must be clean ────────────────────────────────────────
// Without this, a checker that reports findings unconditionally passes every
// other assertion here.

check('O1  a fleet matching the code exits 0 with no findings', () => {
  const { status, report } = run('deployed-clean.txt');
  assert.strictEqual(status, 0, 'a matching fleet must exit 0');
  assert.deepStrictEqual(report.orphans, []);
  assert.deepStrictEqual(report.missing, []);
  assert.strictEqual(report.failed, false);
});

// ── THE REGRESSION: the exact 2026-09-04 failure ────────────────────────

check('O2  a deployed function with no export is caught as an ORPHAN', () => {
  const { status, report } = run('deployed-with-orphan.txt');
  assert.strictEqual(status, 1, 'an orphan must fail the check');
  assert.deepStrictEqual(report.orphans, ['sendEstimateEmail'],
    'the fixture uses a real name from the incident this check exists for');
  assert.deepStrictEqual(report.missing, []);
});

check('O3  an exported trigger that is not deployed is caught as MISSING', () => {
  const { status, report } = run('deployed-missing.txt');
  assert.strictEqual(status, 1);
  assert.deepStrictEqual(report.missing, ['stormWatch']);
  assert.deepStrictEqual(report.orphans, []);
});

check('O4  both directions are reported together, not one at a time', () => {
  const { status, report } = run('deployed-both.txt');
  assert.strictEqual(status, 1);
  assert.deepStrictEqual(report.orphans, ['ghostOne']);
  assert.deepStrictEqual(report.missing, ['stormWatch']);
});

check('O5  --orphans-only suppresses MISSING but still catches orphans', () => {
  const { status, report } = run('deployed-both.txt', ['--orphans-only']);
  assert.strictEqual(status, 1);
  assert.deepStrictEqual(report.orphans, ['ghostOne']);
  assert.deepStrictEqual(report.missing, [], '--orphans-only must drop the MISSING half');
});

check('O6  --orphans-only on a missing-only fleet is clean', () => {
  const { status, report } = run('deployed-missing.txt', ['--orphans-only']);
  assert.strictEqual(status, 0);
  assert.strictEqual(report.failed, false);
});

// ── "I could not tell" must never read as "clean" ───────────────────────
// This is the crm-audit.js lesson: it reported success over an audit of
// nothing for its entire life. Exit 2, distinct from both 0 and 1.

check('O7  an EMPTY deployed list exits 2, not 0', () => {
  const { status, report } = run('empty.txt');
  assert.strictEqual(status, 2,
    'an empty fleet listing means the query failed — reporting it clean is the '
    + 'exact false-green this repo keeps finding');
  assert.strictEqual(report, null, 'exit-2 must not emit a success-shaped JSON report');
});

check('O8  an EMPTY expected list exits 2, not 0', () => {
  const { status } = run('deployed-clean.txt', [], 'empty.txt');
  assert.strictEqual(status, 2,
    'zero exports with __endpoint means the probe failed, not that the code is empty');
});

check('O9  an unreadable input exits 2 CLEANLY, not with a stack trace', () => {
  // First cut crashed with an uncaught ENOENT here. It "failed", but it
  // printed a stack trace where an operator needs a verdict, and a crash is
  // not distinguishable from a checker that is itself broken.
  const { status } = run('does-not-exist.txt');
  assert.strictEqual(status, 2, 'a missing input is "could not determine", not a finding and not a pass');
});

// ── Exit code and report must agree ─────────────────────────────────────

check('O10 report.failed always agrees with the exit code', () => {
  for (const [f, expectFailed] of [
    ['deployed-clean.txt', false],
    ['deployed-with-orphan.txt', true],
    ['deployed-missing.txt', true],
    ['deployed-both.txt', true],
  ]) {
    const { status, report } = run(f);
    assert.strictEqual(report.failed, expectFailed, f + ': failed flag');
    assert.strictEqual(status === 1, expectFailed, f + ': exit code');
  }
});

check('O11 the JSON report carries the counts it compared', () => {
  const { report } = run('deployed-clean.txt');
  assert.strictEqual(report.expected, 4);
  assert.strictEqual(report.deployed, 4);
  assert.ok(report.project && report.region, 'project/region must be reported for auditability');
});

// ── Source contracts ────────────────────────────────────────────────────

const SRC = fs.readFileSync(SCRIPT, 'utf8');

check('O12 expected-set derivation filters on __endpoint, not Object.keys', () => {
  // Validated against prod 2026-09-04: 171 __endpoint exports == 171 deployed.
  // A bare Object.keys() also returns 19 helpers and test hooks, which would
  // have reported 19 false MISSING on day one and trained everyone to ignore
  // this check immediately.
  assert.ok(/__endpoint/.test(SRC), 'must filter exports on the firebase-functions endpoint marker');
  assert.ok(
    !/Object\.keys\(m\)\s*\.sort\(\)/.test(SRC),
    'must not take every export as deployable',
  );
});

check('O13 the export probe runs in a CHILD process', () => {
  // index.js writes JSON log lines to stdout; requiring it in-process would
  // corrupt --json output, and a load-time throw would take the checker down.
  assert.ok(/execFileSync\(process\.execPath/.test(SRC));
});

check('O14 allowlists exist, are documented, and are currently empty', () => {
  assert.ok(/ALLOW_ORPHANS/.test(SRC) && /ALLOW_MISSING/.test(SRC));
  const orphanBlock = SRC.slice(SRC.indexOf('const ALLOW_ORPHANS'), SRC.indexOf('const ALLOW_MISSING'));
  assert.ok(
    // Only the six RETIRE-NOOP-FUNCTIONS-2026-11-15 entries (each dated) may be
    // listed; delete them, and this exception, once functions:delete is confirmed.
    (orphanBlock.replace(/\/\/.*$/gm, '').match(/^\s*'?[A-Za-z]\w*'?:/gm) || [])
      .every((l) => /^\s*(auditUsers|auditCompanies|auditAccessCodes|auditSubscriptions|imageProxy|setStorageCors):/.test(l)),
    'an entry was added to ALLOW_ORPHANS — it needs a dated reason, and this '
      + 'assertion is the prompt to write one',
  );
});

// ── Report ──────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.message}`);
  console.log('');
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`PASSED — ${passed} assertions; the detector goes red on both directions`);
process.exit(0);
