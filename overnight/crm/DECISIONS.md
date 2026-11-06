# DECISIONS

## D-001 — emulator project id (2026-11-06 08:50 ET)
The brief says EMULATOR_PROJECT=demo-nbd-audit. The repo already has a CI-proven hermetic rig
(`tests` npm script `test:e2e:authed:emu`, `scripts/seed-emulator.js`, `tests/e2e/fixtures/seed-emulator.js`,
`docs/pro/js/nbd-emulator-connect.js`). The client SDK config hard-codes projectId `nobigdeal-pro`
and nbd-emulator-connect points every page at the local emulators whenever the host is localhost —
so the emulator namespace must be `nobigdeal-pro` or the browser reads an empty database.
Decision: run the emulators exactly like CI: `--only auth,firestore,storage,hosting --project nobigdeal-pro`.
No functions emulator (memory: the functions emulator can read real Twilio/Resend secrets and once sent a
real text). Nothing here contacts the production project: Auth/Firestore/Storage/Hosting emulators are local
processes. Every script I write still refuses to run without FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST.

## D-002 — no localStorage flag needed
The brief's step 5b (add an emulator-connect file gated on localStorage) is unnecessary: nbd-emulator-connect.js
already exists, gated on hostname only. Not adding a second mechanism.

## D-003 — Firestore emulator on 8085 (08:50 ET)
Port 8080 is held by Jo's local open-webui (python, `open-webui serve --port 8080`). Not stopping a user app.
scripts/audit/emulators.js runs the emulators from a throwaway copy of firebase.json with only the Firestore
port moved; scripts/audit/harness.js re-routes the browser's hard-coded :8080 to :8085 at the network layer.
No app code changed for the harness.

## D-004 — STOP_AT
Launched 08:38 ET on 2026-11-06, so the brief's 06:30 ET hard stop is 2026-11-07 06:30; wrap-up 05:45.
