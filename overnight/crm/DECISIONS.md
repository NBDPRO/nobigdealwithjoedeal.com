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

## D-007 — local node-bucket gate was incomplete; replaced (11:20 ET)
scripts/run-test-manifest.js --bucket node has an 8-minute wall-clock budget (sized for CI's 10-minute job). On
this laptop it stops at ~650/836 suites with "RUNNER ERROR: wall-clock budget exhausted" — my run-gates grep only
read the ✗ lines, so ~184 suites never ran locally on every branch. PR #2941 went red in CI on
system-plus-standard-and-up (golden template totals) that had never run here. Every earlier "same as baseline"
was therefore true but incomplete. Fix: scripts/audit/run-node-parallel.js runs ALL node-bucket suites, 6 at a
time, no budget (139 s). Baseline on main: 827/835, the same 8 environmental failures. Re-running every PR branch
with it; PR bodies corrected where needed.

## D-008 — merge queue (12:33 PM ET)
Auto-merge was enabled on every crm/2026-11-06-* PR by the jdealtia-sys account (not this session) within
minutes of opening; #2938-#2945 reached the merge queue. Asked Jo; his answer: decide, weighing landing the work
against several sessions sharing the queue. Decision: leave the Tier A PRs queued (each passed the full local
gate run and is independently mergeable); pull ONLY the two MONEY/LOGIC PRs (#2941 ice & water — changes Best
template totals by -$3,850/job at default measurements; #2942 estimate-settings restore) out of the queue,
disable their auto-merge, and convert them to drafts with a HOLD note (memory: a watcher once re-queued a held
non-draft PR). Fully reversible. The tooling branch is locked while #2938 is queued; my local tooling commit
(run-node-parallel.js, seed direction fix, state through #2952) will go in a follow-up PR once #2938 lands.

## D-009 — proposals, not built overnight (Tier C or data-safety)
- **ST-F11** (brand contact fields can't be cleared): a blank is omitted from the merge write. Making blanks clear means writing deletes into companyProfile; that is a data-shape change, proposed with an explicit "Clear" control instead of treating blank as clear.
- **ST-F62** (free email signup can strand an account): if a step after createUserWithEmailAndPassword fails, the retry hits email-already-in-use. Auth-flow change (Tier C); proposal: resume from the existing user (sign in with the same credentials, then finish the users/companies writes idempotently).
- **VW-F156** (every deploy force-reloads open dashboard tabs within ~60 s with no unsaved-input check): service-worker update policy (Tier C); proposal: defer the reload until the tab is hidden or idle and no form is dirty, with a "New version — reload" toast.
- **ST-F35** (AI usage panel is device-local and its copy says charges pass "to your key"): copy fix proposed; dashboard.html is in several open PRs tonight, so it waits.

## D-010
**VW-F111 (refer.html default title) not built overnight.** The suggested fix, a neutral default title and hero copy, also changes NBD's own referral landing page, which is customer-facing brand copy. The other route is portal.js always appending &co= for non-NBD tenants, with a fallback name when the company name is blank. That one leaves NBD untouched and is the better fix, but it is a portal change that needs its own test. Proposed for a later session; nothing is customer-visible today for NBD.

## D-011
**Unbounded reads (VW-F167, VW-F103, VW-F104, VW-F16, VW-F60, VW-F07, DT-F08) not capped overnight.** Adding limit() to these reads changes what is true, not only how fast it is. A handled-numbers read capped at N treats handled number N+1 as unhandled, so the call resurfaces as needing attention. The leaderboard, KPI and photo counts would undercount, and the Agent Inbox would hide pending items with no notice. A real fix needs server-side rollups (count docs) or cursor pagination with a "showing first N" line. Proposed for a later session, test-first, per read.

## D-012
**Native-dialog fallbacks (VW-F10, VW-F105, ST-F16) left as they are.** Each one is the sanctioned `window.nbdConfirm || confirm` pattern the brief allows. The real gap is VW-F159: nbdConfirm only exists in standalone mode, and the fix belongs in standalone-compat.js, which is parser-blocking and at the boot budget. Native **prompt()** callers (VW-F57, PL-F18, CU-F13, ED-F22) need a shared, deferred, non-blocking prompt helper first. That is a design task for a fresh session, not an overnight patch.

## D-013
**CU-F19 split from PL-F23/PL-F27.** The viewer guards live on the customer page, which the dashboard boot budget does not count, so they ship in their own PR. PL-F23 and PL-F27 add about 440 shipped bytes to dashboard-bootstrap, while main has 184 bytes left. They are held in draft #2994 for Jo's budget call (NEEDS_JOE #24).
