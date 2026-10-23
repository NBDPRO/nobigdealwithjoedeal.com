# CI runner minutes and why Actions backs up — 2026-10-23

Measured on the last 40 completed `ci.yml` runs (jobs API, 2026-10-22 22:00 UTC to 2026-10-23 06:00 UTC; three fetches failed with a 5xx and were skipped, so n is 37 per job). Read-only; nothing in the workflow changed in this note's PR.

## What the numbers say

1. **No recent run ended `success`.** Of the last 60 `ci.yml` runs: 44 `cancelled`, 1 `failure`, 15 still running. Every push and merge-group run has the same shape: 22-23 jobs green and exactly **one** cancelled. That one is `Authed E2E (emulators, @shard2)`: it hit its 25-minute cap in **37 of 37** samples (median 25.3 min). It is not a required check, so merges are not blocked, but it makes every run's conclusion `cancelled` and burns 25 runner-minutes per run.
2. **A run costs about 105 runner-minutes** (median across the sample; range 90-133 for runs that were not cut short). A docs-only PR costs the same: `ci.yml` has no `paths:` filter, so all 24 jobs run.
3. **57 % of those minutes are on jobs that are not required.** Medians, required (the 16 in the ruleset): about 42 min. Not required: about 56 min (`@shard2` 25.3, `@shard3` 13.9, Pro demo walk 7.3, QC render sweep 4.9, emulator suites 2.5, mobile realtime 0.8, brand tokens 0.7, dependency audit 0.4).
4. **Each merged PR runs the full workflow at least three times**: the PR run, the merge-queue run, and the push-to-main run (plus one more per extra push to the PR). About 300+ runner-minutes per merged PR, about 165 of them on non-required jobs (56 min x 3). Overnight with ~30 PRs that is ~9,000 minutes.
5. **The backlog is queue wait, not slow jobs.** Time from run creation to the first job starting (median): PR runs 20 min, merge-queue runs 18 min, push-to-main runs 53 min. Median worst-job queue wait: 50 / 42 / 70 min. All 16 required checks finished a median 53 min after the PR run was created, 50 min for a merge-queue run, 82 min for a push run. Each run submits 24 jobs at once; GitHub's concurrent-job limit for the account is far below what a dozen live runs ask for.
6. Job durations (median / max, minutes): `@shard2` 25.3 / cap; `@shard3` 13.9; `@audit` 10.1; Pro demo walk 7.3 (max 15.6); Firestore rules 5.3; QC sweep 4.9; unit manifest 4.8; referral 4.6; `@stranger` 3.1; `@gauntlet` 2.9; `@shard1` 2.4; everything else under 2.5. Setup (install) is a small part of the fast jobs, so extra caching would save little.

## Why merge-group runs sit queued

Merge-group and push runs use a unique concurrency group per run (by design, so a queue run is never cancelled), so they never cancel each other and every one waits for runners behind the PR runs. All 12 merge-group runs in the sample ended `cancelled` with 22-23 jobs green and 1-2 cancelled; in the 10 with exactly one cancelled job it is `@shard2`. I did not break out the 2 runs with two cancelled jobs, so those are not proven to be the shard2 cap alone.

## Ranked recommendations (none shipped here: each changes which checks run or needs Jo)

1. **Make `@shard2` finish or stop running it on every event (largest win: ~25 min x ~3 runs per merged PR, about 75 runner-min).** Fixing the six specs that fail on their first attempt (`call-center-view`, `crew-calendar`, `focus-mode`, `inbox-layout` iPhone-dark, `layouts`, `mission-control`) and the retries that hang for the full 240-300 s test timeout is the real fix; see [shard2-e2e-never-finishes-2026-10-20](shard2-e2e-never-finishes-2026-10-20.md). Do **not** just lower its `timeout-minutes`: a repaired shard2 is estimated at 16-18 min, so a cap below that would need undoing. Until then a deliberate stopgap is Jo's call: run `@shard2` and `@shard3` on `pull_request` only (not `merge_group` or `push`), saving about 78 runner-min per merged PR (2 runs x (25 + 14)).
2. **Do not run the non-required jobs in the merge queue and on push** (same idea, bigger): QC sweep, Pro demo walk, mobile realtime and the two non-required shards produce no gate there. Needs Jo, because it changes what runs.
3. **A docs-only fast path, done safely.** ci.yml's own comment (lines 28-33) records that a job-level `if:` reports SKIPPED, which branch protection treats as a pass, but a skipped matrix job reports one unexpanded name instead of the shard names, so the required `@shard1` etc. checks would never report and the PR would block forever. So the filter must be per step inside each job (the job still runs and reports success in about 20-30 s): a `changes` job outputs `docs_only`, and each heavy job guards its install/test steps with `if: needs.changes.outputs.docs_only != 'true'`. Required check names are unchanged. Cuts a docs-only PR from ~105 to ~10 runner-min. Needs Jo (changes which tests run on which diffs; define "docs-only" as `documentation/**`, `*.md` only, never `docs/` which is the site).
4. **Drop the push-to-main run's duplication of the merge-queue run** (same tree, tested seconds earlier): keep only the deploy workflow's own checks. Needs Jo; the main-run is currently the "record of what deployed".
5. **Rebalance `@shard3` / `@audit`** (13.9 / 10.1 min): fine as they are today (well under 25); only worth touching once shard2 is fixed.
6. Caches (Playwright browsers, node_modules): measured setup is small, so low value; skipped.

## What was not verified

- Concurrent-runner limit: inferred from queue waits, not read from the account's plan.
- The three failed API fetches could shift the medians by a point or two.
- Per-job minutes use started-to-completed time, so a job that was cancelled mid-run counts for the time it ran.

## Update 2026-10-23 (later): the merge queue waits for the WHOLE run, and the first fix shipped

**The queue waits for non-required jobs.** Merge time vs the merge-group run's end (run id, PR, run end, mergedAt, UTC): 39903380661 / #2667 / 05:51:15 / 05:51:07; 39908054031 / #2684 / 06:45:49 / 06:46:18; 39911789761 / #2685 / 07:27:26 / 07:25:02; 39916101707 / #2688 / 07:55:50 / 07:52:52. Each merged within about 3 minutes of its run ending, and each of those runs ended at the non-required `@shard2`'s 25-minute cap (22-23 jobs green, `@shard2` cancelled). Created-to-end for the 24 completed merge-group runs sampled was 41-80 minutes. Some PRs merged earlier because a later group in the stacked queue carried them.

**Shipped (#2697): `@shard2` and `@shard3` run on `pull_request` only.** A matrix `exclude` expression keyed on `github.event_name` drops them on merge_group and push; the five required legs keep their names. Evidence: the PR run listed 24 jobs (all 7 Authed E2E legs); a throwaway push-event probe run listed 22 and only the 5 required legs; #2697's own queue run (39941491714) listed 22 jobs; #2696's queue run (39943047142, 11:00:27 to 11:30:37, 30 min) had no shard2/shard3 jobs and was the first run in the sample to conclude `success`. A guard in `tests/merge-queue-ready-2026-10-04.test.js` fails if the exclude could ever drop a required leg.

**Public-surface E2E is required and was wedging.** In 3 of 3 sampled cancellations its `Install Playwright chromium + webkit` step ran the full 20-minute job cap (runs 39902211462, 39910356722, 39917577938). Fixed in #2715 with a per-attempt cap of 3 minutes and up to 3 attempts. The same install step exists in `esign-suites` (also required), `mobile-realtime`, `pro-demo`, `qc-render-sweep`, `visual-regression` and the E2E matrix; not changed yet.
