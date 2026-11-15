# Functions deploy skip: session note (2026-11-14)

**Why:** ten security fixes merged one at a time on 2026-11-14, and each deploy spent most of its time
redeploying every Cloud Function (strict step 16m23s in run 43634215715). The coordinating session's merge plan
counts about 46 more PRs waiting, 27 of them page-only. Joe approved
building a skip as its own reviewed PR, not for the merges already planned.

**What changed:** a push skips the functions deploy when no function input changed since the last
successful functions deploy. How it works, how to force a deploy, how to read a run and how to recover:
[FUNCTIONS-DEPLOY-SKIP](../runbooks/FUNCTIONS-DEPLOY-SKIP.md). [SECRET_ROTATION](../runbooks/SECRET_ROTATION.md)
now says a rotation needs a `scope=functions` dispatch.

## Verified before designing
- The strict step names every export in `--only functions:NAME` (chunks of 60). The workflow's own note
  (on firebase-tools `planner.ts` `toSkipPredicate`) says that is what disables the skip-unchanged logic; this
  session did not re-read firebase-tools' source. The export grep finds 339 functions. Concurrency group `firebase-deploy`, `cancel-in-progress: false`.
- Step timings, run 43634215715: strict 16m23s, tolerant 1m03s, stub secrets 54s, smoke gate 11s,
  API check 10s, fleet check 5s, hosting live about 2 minutes after the job starts. Only the strict, tolerant
  and stub-secrets steps are skipped, so a page-only deploy should go from about 23 to about 5 minutes,
  plus about half a minute for the new plan job. That figure is not measured yet.
- Nothing under `functions/` requires a file outside it. `firebase.json` has one codebase (`source:
  functions`) and no predeploy hooks. The only `.env` file is `functions/.env.nobigdeal-pro`.
- The Actions API returns per-step name, status, conclusion and start time for every attempt
  (`jobs?filter=all`), plus `path`, `head_repository` and `head_branch` on each run. A read-only dry run of
  the script against the live history picked run 43647640760 (#3043) as the marker, and said "skip" for
  #3044, which only changes tests.

## Design decisions
- **The marker is read, never written.** It comes from the run history: the newest started strict step
  (success, a push or dispatch run of this workflow in this repo, on main, ancestor of HEAD). No tag or ref
  is written, so the deploy job keeps its read-only token.
- **All or none.** The deploy steps skip only on the plan job's explicit `false`. A failed plan job, an
  error, a missing marker or a non-ancestor marker all mean deploy.
- **The `force_functions` input:** `scope=all` and `scope=functions` already always deploy functions (the
  requirement), so this input deploys functions on any scope. A repository variable, `NBD_FUNCTIONS_SKIP=0`,
  turns the skip off with no revert.

## Security review (nbd-security-reviewer), and what was fixed
No Critical or High. Fixed in this PR:
- M1: a re-run of an old run beyond the first 100 runs could hide. The script now pages the whole 35-day
  re-run window, and treats a window it cannot read in full as doubt.
- M2: a fork's `pull_request` run of its own copy of the workflow, on a branch named main, could pose as
  the marker. Only push and dispatch runs from this repo, of this workflow path, are trusted.
- L1: removed a test that asserted case-sensitive GitHub expression comparison.
- L2: added the secret-rotation note.

Left open, all of them older than this change: the deploy job has no protected `environment:`; `npx
firebase-tools` is not pinned.

- After review: the current run's own earlier attempts now count as history, so "Re-run all jobs" after a
  failed strict step deploys.

## What only a real deploy can show
See the PR body: the skip run's real duration, the summary rendering, the plan job on a real push, and a
functions change still deploying. The first push after this merges changes the workflow and the script, so it
DEPLOYS functions; the first real skip is the next page-only push after that.
