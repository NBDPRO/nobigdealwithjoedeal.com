/**
 * smoke.test.js — dependency-free static smoke tests (orchestrator)
 *
 * The actual assertions live in tests/smoke/<domain>.test.js. This file
 * keeps the historical entry-point (`node tests/smoke.test.js`) so CI
 * and scripts/deploy-runbook.sh don't need to change.
 *
 * Each domain file exports `run(ctx)` and receives a fresh `{ assert,
 * section, getResults }` triple plus `bumpPassed/bumpFailed` hooks for
 * the rare orchestrator-level adjustments. All passes/failures funnel
 * into the same counter; the summary at the bottom mirrors what the
 * old monolithic file printed (TOTAL passed, TOTAL failed, failure list).
 *
 * Intentionally zero deps. Run:
 *   node tests/smoke.test.js
 *
 * Exit code 0 = pass, non-zero = fail. No framework needed.
 */

'use strict';

const { makeContext } = require('./smoke/_shared');

const ctx = makeContext();

const DOMAINS = [
  './smoke/dashboard.test.js',  // syntax checks + ScriptLoader/AdminManager front
  './smoke/auth.test.js',
  './smoke/functions.test.js',
  './smoke/estimates.test.js',
  './smoke/crm.test.js',
  './smoke/portal.test.js',
  './smoke/photo.test.js',
  './smoke/photo-vision-sanitizer.test.js',  // §3.2 unit tests — real fn calls
  './smoke/receipt-vision-sanitizer.test.js',  // Phase 2 receipt OCR — real fn calls
  './smoke/photo-report-pairs.test.js',      // §3.2 _buildPairs fixture tests
  './smoke/photo-damage-canon.test.js',      // /photos.damageType fold — real fn calls
  './smoke/maps.test.js',
  './smoke/reports.test.js',
  './smoke/security-guards.test.js',  // Audit #2: webhook-sig / billing-gate / SMS opt-out regression guards
  './smoke/phone-digits.test.js',  // inbound-SMS phoneDigits match key — unit + write/read guards
  './smoke/resend-error-surfacing.test.js',  // resend.emails.send() .error-check sweep — real fn calls + per-site guards
];

for (const mod of DOMAINS) {
  const m = require(mod);
  if (typeof m.run !== 'function') {
    throw new Error(mod + ' does not export run(ctx)');
  }
  m.run(ctx);
}

// ── Summary ─────────────────────────────────────────────────
const results = ctx.getResults();
console.log('\n' + '─'.repeat(50));
console.log(`${results.passed} passed, ${results.failed} failed`);
if (results.failed > 0) {
  console.log('\nFailures:');
  for (const f of results.failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
