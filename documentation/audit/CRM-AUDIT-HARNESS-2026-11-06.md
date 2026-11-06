# CRM audit harness — 2026-11-06

A reusable local harness for auditing the NBD Pro CRM end to end, built for the 2026-11-06 full-coverage
CRM audit (working files: [overnight/crm/HARNESS.md](../../overnight/crm/HARNESS.md),
[overnight/crm/SCORECARD.md](../../overnight/crm/SCORECARD.md)).

## What it is
- `scripts/audit/emulators.js` — starts Auth + Firestore + Storage + Hosting emulators (never Functions:
  the functions emulator can read real Twilio/Resend secrets). On Jo's machine port 8080 is taken by
  another local app, so it starts from a throwaway copy of `firebase.json` with only the Firestore port
  moved (default 8085). `firebase.json` itself is untouched.
- `scripts/audit/seed-audit-tenants.js` — two synthetic tenants. Tenant A "Demo Roofing Co"
  (`owner@a.test`, `rep@a.test`): 26 leads across 18 stages and all 14 source values, tasks, documents,
  estimates, expenses in cents, 6 `phone_calls` (two matched by phoneDigits only), 2 `thursday_calls`,
  knocks. Tenant B "Other Contractor LLC" (`owner@b.test`): 5 leads and its own brand, no NBD
  credentials. Refuses to run without loopback emulator hosts. `--reset`, `--check`.
- `scripts/audit/harness.js` — Playwright login + route sweep: console errors, page errors, failed
  requests, 390px and 1440px screenshots, axe WCAG A/AA, overflow at 390px, small tap targets, small
  inputs. Blocks every non-loopback host except the Firebase SDK and font CDNs.
- `scripts/audit/run-gates.sh` — the CI gate list in one PASS/FAIL table.

## Gotchas found while building it
- The client hard-codes the Firestore emulator at `127.0.0.1:8080` (`docs/pro/js/nbd-emulator-connect.js`).
  Moving the port needs a network-level re-route (Playwright `context.route` + `route.continue({url})`);
  an in-page `fetch`/XHR patch misses the SDK's channel requests and the app sits "offline" with 0 leads.
- In Git Bash, `/pro/...` arguments are rewritten to `C:/Program Files/Git/pro/...`; run with
  `MSYS_NO_PATHCONV=1` and pass output dirs as `C:/...` paths.
- Functions-backed features (AI, Stripe, e-sign callables, call-recording playback) can't run here; their
  "works" checks come from unit tests.
