# NEXT_SESSION 2026-11-19: repo, worktree and session cleanup

Not the live brief (see the **Current handoff** pointer in [INDEX](../INDEX.md)). This
records what the 11-19 cleanup session did and what it left for Joe.

## What was done (nothing was pushed or merged)

- **Sessions.** About 34 finished sessions were archived (scheduled Office sweep,
  Thumbtack watcher, Armory sweep and weekly-check runs, plus work sessions whose PRs were
  merged: #3035, #3139, #3184, #3198). None had unpushed work.
- **Branches.** 183 local branches whose PR was MERGED or CLOSED were deleted. Any that
  was not identical to its remote was first saved as `backup/2026-11-19/<name>` (about 41).
- **No-PR branches.** 85 more: 13 with an identical remote copy had the local copy
  deleted, 72 local-only ones were moved to `backup/2026-11-19/<name>` rather than deleted.
  Mostly September-October merge, restack and `tmp-*` leftovers.
- **Worktrees.** 67 down to about 13. Dirty old ones (`nbd-wt-restack-2438`, `rs-2443`,
  `rs-2448`, `rs-2449`, `rs-2450`, `shard`, `crm`, `visit-rec2`, `overnight`,
  `field-estimate`, `agent-a21d5938…`) were snapshotted first as
  `backup/2026-11-19/wt-<name>` (commit made with plumbing, no hooks). Their PRs
  (#2443, #2448, #2449, #2450) are merged and #2438 is closed.
- Left alone: worktrees on open PRs, and anything belonging to a live session that day.

## Recovering anything

`git branch --list 'backup/2026-11-19/*'` lists about 125 refs. Check one out or
`git branch <name> backup/2026-11-19/<name>`. Delete the whole namespace once Joe is sure
nothing is missed (suggest waiting a week, so about 2026-11-26).

## Open PRs, and why nothing was merged

Seven are **deliberate DRAFTS waiting on Joe's real-iPhone test** (the repo's hold
mechanism, see the held-PRs rule). A watcher or an un-draft would ship them untested, so
none was un-drafted or merged:

| PR | What | Status |
|----|------|--------|
| #3186 | real-iPhone checklist for Daily Success and Workout (docs) | draft, clean |
| #3193 | yesterday-is-blank banner, Days logged this week | draft, clean |
| #3199 | Sunday review suggests the promise audit | draft, clean |
| #3200 | Workout Progress card (est. 1RM, 12-week volume) | draft, clean |
| #3202 | thank-you letter prints on one page | draft, clean |
| #3203 | three-size format pass 2 + real-device checklist | draft, clean |
| #3208 | RPE history on the Progress card | draft, UNSTABLE (no failing or pending checks listed; look at which check) |

One more is not a draft:

- **#3145** sweep leftovers: auto-merge is armed, but it is **DIRTY** (merge conflict),
  idle since 2026-11-17. Needs a rebase on main before it can enter the queue.

## What waits on Joe

1. Run the iPhone checklist (#3186) and the print/device pass (#3203), then un-draft the
   PRs that pass.
2. Say whether to delete `backup/2026-11-19/*` (after about 2026-11-26).
3. Rebase or close #3145.

## Not done, on purpose

- No `--apply` prod script was run, no flags were touched, nothing was pushed to `main`.
- The 13 remaining worktrees and the main checkout were other sessions' work that day.
