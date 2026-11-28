# @stranger shard flake: provision "times out" after Finish (2026-11-27)

The Authed E2E `@stranger` shard went red on 2026-11-26 on at least five
unrelated PRs (#3261, #3264, #3266, #3281, and #3266's merge-queue run). The
report blamed `tests/e2e/stranger.spec.js:195` (provision):
`page.waitForURL(/\/pro\/dashboard/)` timed out after the onboarding Finish
click, on every retry.

## What actually happened (4 job logs read, same shape in all)

1. **Provision passed on the first attempt.** The progress lines show tests
   7 to 11 running after it.
2. **The first real failure was `publish`** (`stranger.spec.js:293`):
   `publishTenantSite` wrote `companies/{id}.sitePublished: true` (the spec's
   admin poll saw it), but `#cp-site-status` kept "Your site is private" for
   15 s (screenshot: status text private).
3. The journey is `describe.serial`, so Playwright retried **all of it** in a
   new worker against the **same emulator**. Provision registered a new user,
   but the wizard derived the seal from "[E2E] Stranger Roofing 17…": the
   initials E, S, R and the first digit of the stamp, "ESR1", on every attempt.
   `reserveCompanyPrefix` refused it ("Those initials are already used by
   another company", seen in the retry's page snapshot), and `finish()`
   correctly held the wizard. So provision timed out on retry 1 and retry 2,
   and the report listed only those failures.

## Fixes (one PR)

- **Product: the site panel painted a stale read after Publish**
  (`docs/pro/js/dashboard-bootstrap.module.js`, `_loadSiteSlug` and
  `_callPublishTenantSite`). Two holes:
  - the panel discarded the callable's own `{ published }` answer and
    re-read the doc, and that read can be the device's cached copy (getDoc
    resolves `fromCache` when the SDK thinks it is offline, which
    `company-profile.js` already refuses for the same reason). The verdict
    now wins.
  - opening the tab starts a load behind a slow `_loadCompanyProfile`; if
    it resolved after Publish's load it repainted "private". A sequence
    guard now lets only the newest load paint.
  Test first: `tests/site-publish-panel-stale-read-2026-11-27.test.js` runs
  the panel code extracted verbatim; 4 checks red on `origin/main`, 8/8 green
  with the fix. Shipped bytes +215 B (355 B left under 2620 KB, no raise).
- **Test: unique seal per attempt** (`stranger.spec.js`). The spec types a
  seal of four base-36 digits from the stamp, so a retry never collides. The
  product refusal was correct. A Finish that never redirects now reports
  `#wizErr` in the failure instead of a bare timeout.

## Local proof (Joe's machine, full emulator rig incl. functions)

Each run is a fresh Playwright process (new stamp) against ONE emulator
session, the same shape as a CI serial retry.

- **Before** (`origin/main`'s spec, provision only, 2 runs): run 1 passed,
  run 2 `TimeoutError: page.waitForURL` at Finish, the CI symptom exactly.
- **After** (this branch, full journey, 4 runs): provision and publish passed
  in all 4; runs 2-4 passed 6/6. Run 1 failed in `public face`: the
  `leadBridgeContact` Firestore trigger for its microsite lead only fired
  during run 2, more than 45 s later. A cold first-trigger delay in the local
  emulator, not seen in any of the four CI logs; not touched here.

### Why run 1's bridge was late (emulator mechanics, not product code)

- **Trigger delivery is serial.** Across 604 background executions in the
  local log (and every CI log checked), no Firestore trigger ever began while
  another was running. firebase-tools 15.28.2's own work queue allows 50 at
  once (`workQueue.js` `DEFAULT_MAX_PARALLEL`), so the Firestore emulator is
  what hands events over one at a time, waiting on each response.
- **Each trigger's first call boots a worker that loads ALL of
  `functions/index.js`** (~300 exports). Measured here: 2.5-5 s alone, ~7 s
  with 16 at once, ~15 s with 32 at once. CI's boots: median 0.6-1.0 s, max
  1.9 s.
- So one cold boot delays every event behind it. Run 1 did 32 cold boots
  (runs 2-4: 4, 0, 0); the `contact_leads` event queued behind them and its
  two triggers (`leadAlertContact`, `leadBridgeContact`) only started during
  run 2. In a passing CI job the first microsite lead took 10.9 s from submit
  to bridge and the second 92 ms: about 4x margin under the spec's 45 s wait in
  CI, none on this Windows box.
- Production is unaffected: deployed functions get their own instances and
  events are not serialized behind other functions' cold starts.

Port 8080 had to be freed first (a local open-webui server holds it and the
client hard-codes the Firestore emulator there).

## Not root-caused

Which of the two panel holes fired in CI is not pinned down: no trace exists
for the first-attempt publish failure, because traces are recorded on first
retry only. Both are closed.
