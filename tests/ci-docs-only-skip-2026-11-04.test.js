/**
 * Docs-only PRs skip the OPTIONAL heavy CI jobs (2026-11-04).
 *
 * The free-plan runner pool runs ~20 jobs at once and one CI run is ~27 jobs, so a
 * docs-only PR used to hold the whole pool for its browser shards. A change-scope
 * job now decides heavy=true|false, and seven NON-required heavy jobs skip when a
 * PR touches only documentation.
 *
 * Pins:
 *   1. the classifier: docs-only means documentation/, root *.md, .obsidian/ only;
 *      docs/ (the live site), empty input and mixed changes all mean heavy.
 *   2. the gate fails open: `!= 'false'` plus `!cancelled()`, so a failed or
 *      silent change-scope job still runs the heavy jobs.
 *   3. NO required check (branch protection + merge-queue ruleset) is gated.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const { isDocsOnly } = require('../scripts/ci-change-scope.js');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  [' + detail + ']' : '')); }
}

function job(id) {
  const m = new RegExp('\\n  ' + id + ':\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)').exec(yml);
  return m ? m[1] : '';
}

console.log('\nCLASSIFIER');
ok('vault-only change is docs-only', isDocsOnly(['documentation/INDEX.md', 'documentation/audit/X.md']));
ok('root markdown is docs-only', isDocsOnly(['CLAUDE.md', 'README.md']));
ok('.obsidian config is docs-only', isDocsOnly(['.obsidian/app.json']));
ok('docs/ (the live site) is NOT docs-only', !isDocsOnly(['docs/index.html']));
ok('nested README outside documentation/ is NOT docs-only', !isDocsOnly(['functions/README.md']));
ok('mixed docs + code is NOT docs-only', !isDocsOnly(['documentation/INDEX.md', 'functions/index.js']));
ok('ci.yml itself is NOT docs-only', !isDocsOnly(['.github/workflows/ci.yml']));
ok('empty list fails open (heavy)', !isDocsOnly([]) && !isDocsOnly(['', '  ']));

console.log('\nCHANGE-SCOPE JOB');
const cs = job('change-scope');
ok('change-scope job exists', cs.length > 0);
ok('bounded by a timeout', /timeout-minutes: \d+/.test(cs));
ok('exposes a heavy output', /outputs:\n\s+heavy: \$\{\{ steps\.scope\.outputs\.heavy \}\}/.test(cs));
ok('full history so the base commit is present', /fetch-depth: 0/.test(cs));
ok('runs the classifier script', /node scripts\/ci-change-scope\.js/.test(cs));
ok('no base commit (push to main) means heavy=true', /heavy=true/.test(cs));

console.log('\nGATED JOBS (optional only)');
const GATED = ['emulator-orphan-suites', 'functions-audit', 'mobile-realtime-suite', 'pro-demo-zero-network',
  'public-e2e-webkit', 'qc-render-sweep', 'visual-brand-tokens'];
const GATE = "if: ${{ !cancelled() && needs.change-scope.outputs.heavy != 'false' }}";
for (const id of GATED) {
  const j = job(id);
  ok(id + ' needs change-scope', /\n    needs: change-scope\n/.test(j));
  ok(id + ' uses the fail-open gate', j.includes('\n    ' + GATE + '\n'), id);
}

console.log('\nREQUIRED CHECKS ARE NEVER GATED');
// Branch protection (7) + the main merge-queue ruleset (adds the E2E shards etc.).
const REQUIRED_JOBS = ['smoke-tests', 'site-integrity', 'unit-suite-manifest', 'syntax-check', 'firestore-rules',
  'referral-trigger', 'functions-parse', 'secret-scan', 'e2e-authed-emulator', 'esign-suites', 'public-e2e',
  'visual-regression'];
for (const id of REQUIRED_JOBS) {
  const j = job(id);
  ok(id + ' exists', j.length > 0);
  ok(id + ' is not gated on change-scope', !/change-scope/.test(j));
}
// Positive control: the job() extractor does see a gate where one exists.
ok('positive control: extractor sees the gate on qc-render-sweep', job('qc-render-sweep').includes(GATE));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
