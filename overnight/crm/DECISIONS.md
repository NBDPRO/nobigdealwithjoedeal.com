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

## D-005 — inventory and static audit in one pass (09:00 ET)
Phase 1 (inventory) and the static half of Phase 2 run together per slice: the agent reading a file to list its
features is the one best placed to score theme/tenant/hygiene/integrity/perf/tests on it, and a second read
pass would double the cost. Harness-only columns (Reach, Mobile, A11y) come from scripts/audit/sweep.sh.
Slices: pipeline (PL), customer (CU), estdocs (ED), settings (ST), views+satellites (VW), data+functions (DT),
orchestrator (OR). The audit still completes before any fix starts.

## D-006 — seed finding #6 (tear-off × layers) is NOT the bug the brief describes (09:10 ET)
Verified in code: LAB TO1 / TO2 / TO3 are separate catalog codes "Tear Off 1/2/3 Layer Comp Shingles" with
their own per-SQ rates (estimate-catalog-xactimate.js:795-801, estimate-labor-catalog.js:91-92), and a
dedicated "Two-Layer Tear-Off Reroof" job template exists (job-templates-data.js:183). The layer count is
priced by WHICH code is on the estimate, so QTY 'sq' is correct; the brief's fix `sq * tearOffLayers` would
charge a 2-layer roof twice (TO2 rate × 2). Not applying it.
The real, narrower defect: the line-item builder shows a Layers select (estimate-v2-ui.js:1105 #v2layers →
tearOffLayers) whose value no QTY formula reads, so changing it does nothing on that path, while the per-SQ
engine charges TEAR_OFF_EXTRA_PER_SQ for layers > 1. Whether Layers should swap TO1→TO2/TO3, warn, or be
hidden on the line-item path changes a price → NEEDS_JOE (recommendation: warn + offer the swap; never
silent). The comment "Tear-off labor lines (scale by layers)" at estimate-logic-engine.js:737 is misleading
and is a Tier A comment fix.
