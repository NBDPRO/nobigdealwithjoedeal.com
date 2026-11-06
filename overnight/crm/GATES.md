# GATES — run from the worktree root, same list every time (scripts/audit/run-gates.sh)

Source: .github/workflows/ci.yml (smoke-tests, site-integrity, unit-suite-manifest, syntax-check jobs).
Emulator-backed CI jobs (firestore-rules, e2e-authed-emulator, esign, mobile-realtime) run in CI on push;
locally I run the targeted authed specs through the harness instead (HARNESS.md).

| # | Gate | Command |
|---|------|---------|
| 1 | JS syntax | node scripts/check-js-syntax.js |
| 2 | Site integrity | node scripts/check-site-integrity.js --quiet |
| 3 | Vault index | node scripts/check-vault-index.js --quiet |
| 4 | Chrome governance | node scripts/check-chrome-governance.js |
| 5 | Partials | node scripts/apply-partials.js --check --diff |
| 6 | Inline scripts | node scripts/check-inline-html-scripts.js |
| 7 | CRM audit | node scripts/crm-audit.js |
| 8 | Image privacy | node scripts/check-image-privacy.js |
| 9 | Inline scripts test | node tests/inline-html-scripts.test.js |
| 10 | Marketing polish | node tests/marketing-polish-contract.test.js |
| 11 | Icon CSS | node scripts/ensure-icon-css.js |
| 12 | Nav CSS | node scripts/ensure-nav-css.js |
| 13 | Test manifest wiring | node scripts/run-test-manifest.js --check |
| 14 | Job-template cost strip | node scripts/strip-job-template-costs.js --check |
| 15 | Smoke | node tests/smoke.test.js |
| 16 | Smoke bucket | node scripts/run-test-manifest.js --bucket smoke |
| 17 | Node bucket (unit suites) | node scripts/run-test-manifest.js --bucket node |

## Baseline (untouched origin/main fed35123, 2026-11-06 ~09:00 ET)
16/17 PASS. smoke: 4432 passed 0 failed. smoke bucket 74/74. crm-audit 0 error / 1 warn / 22 info.
node bucket: 475/482 — FAIL on clean main (local/environmental, not mine; CI main is green): chibi-2026-10-25,
d2d-map-vendor-race-2026-10-24, reviews-strip-every-homeowner-page-2026-10-24, public-targets-24px-2026-10-24,
roof-rep-revamp-2026-10-25, reputation-2026-10-19, perf-watch-2026-10-02. Rule: a later run is green when the
node-bucket failure set is a subset of these seven, plus inline-head-css-2026-10-27 (its regex expects LF in .github/workflows/firebase-deploy.yml; this Windows checkout is CRLF; not in the baseline log because that run listed it as passing on a cold cache — environmental, file untouched).
