#!/usr/bin/env node
/**
 * scripts/check-function-orphans.js — deployed functions vs. the code that
 * claims to define them.
 * ═══════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04)
 *
 * Eight Cloud Functions were retired from source on 2026-08-06 and 2026-08-11
 * and never undeployed. They served frozen code for four months, across many
 * green deploys, and were found by hand:
 *
 *   sendEstimateEmail, sendTeamInviteEmail, sendDripEmail,
 *   auditCustomerDataIntegrity, backfillCustomerData, migratePinsToKnocks,
 *   triggerProcessRecording, reprocessRecording
 *
 * Nothing noticed, because nothing looked. firebase-deploy.yml's comment
 * claimed "--force auto-confirms deletion of orphan functions" — but Firebase
 * only DETECTS an orphan on an unfiltered `deploy --only functions`, and every
 * deploy here names its targets explicitly (`--only functions:NAME`). Anything
 * absent from that list is never considered.
 *
 * One of the eight even carried a source comment asserting its "Prod instance
 * deleted via console". It had not been. That is the failure mode this closes:
 * a claim about production, believed because nobody could cheaply check it.
 *
 * WHAT IT COMPARES, AND WHY THAT DERIVATION IS TRUSTWORTHY
 *
 * EXPECTED — the exports of functions/index.js (the deploy entry point per
 * firebase.json `source` + package.json `main`) that carry a `__endpoint`
 * property. firebase-functions v2 stamps `__endpoint` on exactly the exports
 * it will deploy; plain helpers and test hooks do not get one.
 *
 * Validated against production on 2026-09-04: 171 exports carry `__endpoint`
 * and exactly 171 functions are deployed, matching name-for-name with zero
 * drift in either direction. The 19 exports WITHOUT `__endpoint` (postSlack,
 * getUserFCMTokens, the `_`-prefixed test hooks, …) are correctly excluded —
 * a plain `Object.keys()` would have reported all 19 as missing deployments
 * and trained everyone to ignore this check on day one.
 *
 * DEPLOYED — `gcloud functions list`. The deploy workflow already runs
 * `gcloud auth activate-service-account`, so this is available in CI.
 *
 * IT REPORTS BOTH DIRECTIONS
 *
 *   ORPHAN  — deployed, no `__endpoint` export. Dead code serving traffic.
 *   MISSING — has an `__endpoint` export, not deployed. A deploy that silently
 *             skipped something, which is the other half of the same blind
 *             spot (the 2026-09-03 handoff flagged functions appearing in no
 *             deploy log and could not tell staleness from absence).
 *
 * USAGE
 *   node scripts/check-function-orphans.js                     # both checks
 *   node scripts/check-function-orphans.js --quiet
 *   node scripts/check-function-orphans.js --json
 *   node scripts/check-function-orphans.js --orphans-only      # ignore MISSING
 *   node scripts/check-function-orphans.js --deployed-from f   # test fixture
 *
 * Exit 0 clean · 1 findings · 2 could not determine an answer.
 * Exit 2 matters: "I could not read either list" must never look like "clean".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const JSON_OUT = args.includes('--json');
const ORPHANS_ONLY = args.includes('--orphans-only');
const REGION = argValue('--region') || 'us-central1';
const PROJECT = argValue('--project') || process.env.NBD_PROJECT || 'nobigdeal-pro';
const DEPLOYED_FROM = argValue('--deployed-from');
const EXPECTED_FROM = argValue('--expected-from');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

/**
 * Deliberate exceptions. Each entry needs a reason and a date, because an
 * unexplained allowlist is how this check becomes decorative — the same way
 * the deploy comment it replaces did.
 *
 * Empty on purpose right now: after the 2026-09-04 cleanup the fleet matches
 * the code exactly, so there is nothing legitimate to excuse.
 */
const ALLOW_ORPHANS = {
  // 'someFunction': '2026-01-01 — why this deployed function has no export',
  // nightlyFirestoreBackup was carried here on 2026-09-05 while its code was
  // removed but the function was still deployed (the CLI skips deletes whenever
  // any function in a run fails, and onRepSignup fails every deploy by design).
  // Jo deleted the function AND its Cloud Scheduler job by hand the same day,
  // so the carve-out has done its job and is removed — leaving it would mask
  // the next real orphan, which is the one thing this file exists to catch.
};
const ALLOW_MISSING = {
  // 'onRepSignup' is NOT listed here on purpose: it IS deployed. It sits in
  // the deploy workflow's NBD_DEPLOY_SKIP_LIST (a retry carve-out), which is a
  // different thing from being absent, and conflating the two is exactly the
  // confusion this check exists to remove.
};

// ── Sources ─────────────────────────────────────────────────────────────

/**
 * Exports carrying `__endpoint`, collected by loading the real entry point in
 * a CHILD process.
 *
 * A child, not a require() here, for two reasons: index.js loads the whole
 * Cloud Functions surface and writes JSON log lines to stdout (which would
 * corrupt our own --json output), and a module that throws at load time must
 * fail this check cleanly rather than take the checker down with it.
 */
function readExpected() {
  if (EXPECTED_FROM) return readListFile(EXPECTED_FROM, 'expected');

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-orphan-')), 'expected.json');
  const probe = [
    // A project id is required before firebase-functions will initialise.
    "process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || " + JSON.stringify(PROJECT) + ";",
    "const fs = require('fs');",
    "const m = require('./index.js');",
    "const keys = Object.keys(m).filter((k) => m[k] && m[k].__endpoint);",
    "fs.writeFileSync(" + JSON.stringify(out) + ", JSON.stringify(keys.sort()));",
  ].join('\n');

  try {
    execFileSync(process.execPath, ['-e', probe], {
      cwd: FUNCTIONS_DIR,
      stdio: 'ignore',
      timeout: 180000,
    });
  } catch (e) {
    fail(2, 'could not load functions/index.js to enumerate exports: '
      + (e && e.message ? e.message.split('\n')[0] : e)
      + '\n       (run `npm install` in functions/ if dependencies are missing)');
  }
  if (!fs.existsSync(out)) fail(2, 'the export probe produced no output');
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

/** Deployed function names, from gcloud or a fixture. */
function readDeployed() {
  if (DEPLOYED_FROM) return readListFile(DEPLOYED_FROM, 'deployed');
  // Windows ships gcloud as a .cmd shim: the bare name is ENOENT (execFileSync
  // does no PATHEXT resolution) and `.cmd` is EINVAL without a shell, which
  // Node 20+ requires for batch files. CI is Linux and takes neither branch.
  const win = process.platform === 'win32';
  const GCLOUD = win ? 'gcloud.cmd' : 'gcloud';
  // `--format json` rather than `--format value(name.basename())` on purpose:
  // the parentheses in a value() expression are cmd.exe metacharacters, so the
  // projection would be mangled under shell:true. Basenames are derived below.
  try {
    const out = execFileSync(GCLOUD, [
      'functions', 'list',
      '--project', PROJECT,
      '--regions', REGION,
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 180000, shell: win, maxBuffer: 256 * 1024 * 1024 });
    const rows = JSON.parse(out || '[]');
    return rows
      .map((f) => String(f.name || '').split('/').pop())
      .filter(Boolean)
      .sort();
  } catch (e) {
    fail(2, 'could not list deployed functions via gcloud: '
      + (e && e.message ? e.message.split('\n')[0] : e)
      + '\n       (needs gcloud auth — the deploy workflow runs '
      + '`gcloud auth activate-service-account` before this step)');
  }
  return [];
}

/**
 * Read a fixture/override list, failing with exit 2 rather than an uncaught
 * ENOENT. A checker that dies on a bad path prints a stack trace where an
 * operator needs a verdict — and in CI an unreadable input must be
 * distinguishable from a clean fleet.
 */
function readListFile(p, what) {
  try {
    return parseList(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(2, 'could not read the ' + what + ' list from ' + p + ': '
      + (e && e.code ? e.code : (e && e.message) || e));
  }
  return [];
}

/** Accepts a newline list or a JSON array. */
function parseList(text) {
  const t = String(text).trim();
  if (t.startsWith('[')) return JSON.parse(t);
  return t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
}

function fail(code, msg) {
  console.error('check-function-orphans: ' + msg);
  process.exit(code);
}

// ── Compare ─────────────────────────────────────────────────────────────

const expected = readExpected();
const deployed = readDeployed();

// Reporting "clean" over an empty list is how crm-audit.js passed for its
// entire life. Neither side can legitimately be empty here.
if (expected.length === 0) fail(2, 'zero exports carry __endpoint — refusing to report a clean fleet over nothing');
if (deployed.length === 0) fail(2, 'zero deployed functions returned — refusing to report a clean fleet over nothing');

const expectedSet = new Set(expected);
const deployedSet = new Set(deployed);

const orphans = deployed.filter((n) => !expectedSet.has(n) && !(n in ALLOW_ORPHANS));
const missing = ORPHANS_ONLY ? [] : expected.filter((n) => !deployedSet.has(n) && !(n in ALLOW_MISSING));

const failed = orphans.length > 0 || missing.length > 0;

if (JSON_OUT) {
  console.log(JSON.stringify({
    project: PROJECT,
    region: REGION,
    expected: expected.length,
    deployed: deployed.length,
    orphans,
    missing,
    allowedOrphans: Object.keys(ALLOW_ORPHANS),
    allowedMissing: Object.keys(ALLOW_MISSING),
    failed,
  }, null, 2));
} else {
  console.log('check-function-orphans: ' + PROJECT + ' / ' + REGION);
  console.log('  ' + expected.length + ' export(s) with __endpoint · ' + deployed.length + ' deployed');
  console.log('─'.repeat(64));

  if (orphans.length) {
    console.log('\nORPHANED — deployed, but nothing in functions/ exports them.');
    console.log('Retiring an export does not undeploy it. Delete each with:');
    for (const n of orphans) {
      console.log('  gcloud functions delete ' + n + ' --region=' + REGION + ' --project=' + PROJECT);
    }
  }

  if (missing.length) {
    console.log('\nMISSING — exported with a trigger, but not deployed.');
    console.log('A deploy skipped these, or they have never shipped:');
    for (const n of missing) console.log('  ' + n);
  }

  if (!QUIET && !failed) console.log('\nFleet matches the code exactly — no orphans, nothing missing.');
  if (failed) {
    console.log('\n' + orphans.length + ' orphan(s), ' + missing.length + ' missing');
  }
}

process.exit(failed ? 1 : 0);
