# Infra / CI-speed lane — 2026-10-04

*Branch `chore/infra-ci-speed`. Eight under-the-hood items from the
2026-10-04 audit, all approved by Jo. Linked from [INDEX](../INDEX.md).
Runbooks written: [MERGE-QUEUE](../runbooks/MERGE-QUEUE.md),
[DEPLOY-VERIFICATION](../runbooks/DEPLOY-VERIFICATION.md),
[FIRESTORE-INDEX-COVERAGE](../runbooks/FIRESTORE-INDEX-COVERAGE.md); updated:
[HEALTHCHECKS-SETUP](../runbooks/HEALTHCHECKS-SETUP.md).*

## 1. Merge queue

- Found while writing the commands: the repo was owned by a personal account
  (`gh api users/jdealtia-sys --jq .type` → `User`), and GitHub only offers
  merge queues on organization-owned repos. The coordinator moved it to
  `NBDPRO` and enabled ruleset 24456328 the same day, and `ci.yml` on main
  already carried `merge_group:` — this branch's own copy of the trigger was
  stacked as a **duplicate key** by the rebase (a clean text merge, exactly
  the class the queue exists to stop) and was removed; the guard test now
  pins unique triggers.
- `tests/merge-queue-ready-2026-10-04.test.js`: `merge_group` present, no
  `if:` keyed on event name / PR context anywhere in `ci.yml` (a skipped
  required check wedges the queue), every context in the runbook's JSON is a
  check name `ci.yml` really produces (matrix expanded).
- **Open:** the live ruleset requires 5 of the 6 authed-E2E shards —
  `@shard2` is missing. Command to add it is in the runbook.

## 2. E2E spec list

`tests/e2e/authed-specs.txt`, one spec per line, run by
`tests/e2e/fixtures/run-authed-specs.js` (Node, so CR from a CRLF checkout and
shell differences can't leak into Playwright's argv). The old one-line list
carried `roof-rep.spec.js` twice. `run-test-manifest.js` reads the list with
the runner's own parser and fails on: a spec in no list/script/workflow and
not in `UNWIRED_SPECS`; an undated `UNWIRED_SPECS` reason; duplicates; a
listed spec with no CI shard tag; the npm script no longer calling the runner.

Local note: on Windows `firebase emulators:exec` runs its script through
cmd, so `VAR=x cmd` inside the quoted script fails there (it always did —
CI's Linux sh is fine). Set the env vars outside `emulators:exec` locally.

## 3. Deploy verification

`/version.json` (`{sha, short, ref, run, deployedAt}`) is stamped on the
runner before *Deploy Hosting*; a final `verify-live` job (after a successful
deploy only) proves the release landed and compares live vs `origin/main`
over the workflow's own `paths:` list — main moving only under `scripts/**`
or `documentation/**` is "nothing to deploy", green. Real drift with no other
deploy queued → re-dispatch once (`reconcile=true`); a reconcile run that
still finds drift fails red, never loops. Decision logic is the pure
`decide()` in `scripts/verify-live-deploy.js`.

## 4. Lazy-loaded functions

`functions/index.js` now has a `FUNCTION_TARGET` fast path: a running
instance requires only its own module (looked up in the generated
`functions/function-map.json`) and returns before the full load. Deploy and
emulator *discovery* run without `FUNCTION_TARGET` and take the unchanged
full path.

- Discovery manifest (firebase-functions' own `FUNCTIONS_MANIFEST_OUTPUT_PATH`
  pass — what `firebase deploy` runs) before vs after: **byte-identical**,
  237 endpoints. The deploy workflow's export grep yields the same 237.
- Per cold start: **avg 11.7, max 19 of 183** functions/ modules (was all 183).
- The emulator sets `FUNCTION_TARGET` per worker, so the functions-booting E2E
  shards (`@stranger`, `@gauntlet`) exercise the fast path.
- **Follow-up (deliberately not in this PR):** memory settings. Measure
  cold-start RSS per function now that each loads one module, then trim the
  256MiB+ floors.

## 5. Index coverage

`scripts/check-firestore-indexes.js` scans 249 literal queries (267 incl.
dynamic) in `functions/` + `docs/pro/js`. First run found **one real missing
index**: the Voice Intel tab's `leads/{id}/recordings` listener
(`userId ==`, `orderBy recordedAt desc`) had only a `COLLECTION_GROUP` index;
a `COLLECTION`-scope one was added. Also added for item 8: `pins`
(`userId`/`companyId`, `createdAt desc`). Alert JSON for FAILED_PRECONDITION
written, **not created**.

## 6. Heartbeats

35 crons, 20 free checks. `functions/integrations/heartbeat-plan.js` maps
every cron to a check: 9 dedicated (same slug as before), 9 shared groups —
18 checks. A shared check still turns red on any member's `/fail` ping; it
cannot see one member silently stopping. CI fails on an unplanned cron.
Jo's to-do: create the 18 checks in the runbook table; delete the 18 old
slugs listed there if he created them.

## 7. Firebase JS SDK self-hosted — 12.19.0

`docs/assets/vendor/firebase/12.19.0/` (app, app-check, auth, firestore,
functions, storage, messaging + the two compat files the messaging SW
imports), copied from the npm `firebase` package root with the inner gstatic
import rewritten to `./firebase-app.js` (two copies of firebase-app = two app
registries). 263 references in 103 files rewritten (incl. the admin vault,
which was on 10.8.0); `/assets/vendor/firebase/**` is cached immutably.

- All 297 named imports the site uses exist in 12.19.0 (pinned by
  `tests/firebase-sdk-vendored-2026-10-04.test.js`).
- Cost: firestore 12.19 is 178 KB gzipped vs 112 KB in 10.12.2 (+67 KB once,
  then cached immutably and by the service worker).
- `pro/sw.js` (owned by the offline-safety lane) already treats same-origin
  JS network-first with cache — the vendored SDK is now cacheable offline;
  nothing in sw.js changed here.

## 8. Lighter startup

- `loadLeads` no longer reads photos. The boot read was unbounded (every
  photos doc in both scopes) and fed a kanban that **draws no thumbnails** —
  `crm-pipeline.js` builds a `.kc-photos` strip and never inserts it (dead
  since a refactor; mobile CSS hides `.kc-photos` anyway). So there is no
  "visible card" thumbnail to lazy-load; photos now load per lead on demand
  (`docs/pro/js/photo-cache.js`, `NBDPhotoCache.ensure`) when a surface for
  that lead asks: job-detail hero + Photos tab, doc preflight (waits once),
  inspection report (waits once). Command-palette thumbs appear once a lead
  has been opened.
- Pins: newest 1,500 per scope by `createdAt`, with a failed-precondition
  fallback (index building) and a count check for legacy no-`createdAt` pins.
  Zones: 300 per scope.
- Measured: unbounded boot reads 3 → 0 (static ratchet in
  `tests/dashboard-boot-budget-2026-10-03.test.js`); runtime twin in
  `tests/e2e/boot-weight.spec.js` "boot reads" counts the SDK's own
  Listen-channel queries — see the E2E record below.

## E2E record

(filled in below after the local emulator runs)
