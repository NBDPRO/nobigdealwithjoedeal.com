# HARNESS — mode: FULL (2026-11-06 08:50 ET)

Logs in as a seeded user against local emulators, drives any CRM route, and records console errors,
page errors, failed requests, 390px + 1440px screenshots, axe-core WCAG A/AA, 390px horizontal overflow,
sub-44px tap targets and sub-16px inputs. Proven: owner@a.test → `#/crm` shows 25 live leads, 25 board
cards, brand "Demo Roofing Co".

## Three commands (repo root, Git Bash)

```bash
node scripts/audit/emulators.js                       # shell 1: auth+firestore+storage+hosting, NO functions
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/audit/seed-audit-tenants.js --reset
MSYS_NO_PATHCONV=1 node scripts/audit/harness.js --user owner@a.test --routes "/pro/dashboard.html#/crm,/pro/customer.html?id=audit-a-01" --out C:/Users/jonat/nbd-overnight-tools/runs/a
```

- `MSYS_NO_PATHCONV=1` stops Git Bash rewriting `/pro/...` routes into `C:/Program Files/Git/pro/...`.
  With it set, pass `--out` as a Windows path (`C:/...`), not `/c/...`.
- Users (password `Audit123!`): `owner@a.test` (company_admin, tenant A "Demo Roofing Co"),
  `rep@a.test` (sales_rep, tenant A), `owner@b.test` (company_admin, tenant B "Other Contractor LLC").
- Lead ids are stable: `audit-a-01` … `audit-a-26` (26 is soft-deleted), `audit-b-01` … `audit-b-05`.
- Other flags: `--routes-file`, `--no-axe`, `--no-shots`, `--wait <ms>`, `--eval "<js expr>"`.

## Why it differs from CI's rig (decisions D-001, D-003)
- Project id `nobigdeal-pro`, as CI uses: the client SDK config hard-codes it, so a `demo-` id would
  give the browser an empty database. Only local emulators run; the functions emulator is never started
  (it can read real Twilio/Resend secrets).
- Firestore runs on **8085**, not 8080: on this machine 8080 is held by another local app (open-webui).
  `emulators.js` writes a throwaway copy of firebase.json with only that port moved (firebase.json is
  untouched) and `harness.js` re-routes the page's hard-coded `127.0.0.1:8080` to 8085 with a Playwright
  network route. An in-page fetch/XHR patch did NOT work: the SDK's channel requests slipped past it.
- The page may only reach loopback plus gstatic/Google Fonts; every other host is aborted
  (Sentry, Google pixels, Maps) so nothing leaves the machine.

## What it can't reach (expected noise in results)
- Cloud Functions (no functions emulator): `claimInvite`, `integrationAvailability`, AI features, Stripe,
  e-sign callables, call-recording playback (`getThursdayRecording`) fail with CONNECTION_REFUSED.
  Score those surfaces' "Works" from unit tests or `?`.
- `/pro/nosw.txt` 404 is a deliberate service-worker probe on localhost.
- Hosting emulator on Windows serves no firebase.json headers (no CSP header, no redirects), so CSP is
  checked statically (`check-inline-html-scripts.js`, crm-audit), not by the browser here.
- axe runs with `bypassCSP: true` (axe is injected as a script).
