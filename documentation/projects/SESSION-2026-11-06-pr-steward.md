# PR steward session — 2026-11-06 overnight (lane note)

An overnight merge-queue steward session. It reviewed every open PR to a written standard, put the
ones that passed through the merge queue in safe mode, held MONEY/LOGIC and rule-test changes for
Jo, and checked each deploy against `/version.json` and live canaries. It ran beside the CRM audit
session ([CRM-AUDIT-HARNESS-2026-11-06](../audit/CRM-AUDIT-HARNESS-2026-11-06.md)). The night's full
report (verdict per PR, merge log, live BEFORE → AFTER, what waits on Jo) is a GitHub issue titled
"PR steward 2026-11-06 — report". This note keeps what outlasts the night.

## What kept PRs out of the queue
| Cause | Seen on | Fix in this PR |
|---|---|---|
| Every PR inserts its `tests/ci-manifest.json` / `documentation/INDEX.md` line at the same "latest" spot, so each merge knocks the next PR out (adjacency conflict) | 11 CRM PRs (all after manifest line 715) | `scripts/index-anchor.js` places each line by a hash of its own text; `pr-preflight --open-prs` names the PRs you'd collide with |
| Review blockers found by eye: retired hexes, inline handlers, EOL damage, lock drift, screenshot size | earlier nights; none tonight | `scripts/pr-preflight.js` scans them before push |
| Required visual baseline not re-blessed after an intended homepage change, or re-blessed out of order | #2922 after #2927 (11-05/06) | [VISUAL-BASELINE-REBLESS](../runbooks/VISUAL-BASELINE-REBLESS.md) |
| Runner backlog: required checks queued 30–90 min; a deploy run sat queued 90+ min | most PRs | none possible in-repo; one push per fix (runbook) |
| Tests that grep source text instead of running the code (they pass while the behaviour is wrong) | parts of #2949, #2950, #2952 | review practice: prefer vm-run tests (as #2941, #2944, #2947 and #2948 did) |

## Tools added
- `scripts/pr-preflight.js`: read-only. Runs the CLAUDE.md gates a branch needs plus the steward's
  blocker scans. `--open-prs` checks for shared-list collisions. See
  [PARALLEL-PR-HYGIENE](../runbooks/PARALLEL-PR-HYGIENE.md).
- `scripts/index-anchor.js`: adds an INDEX or manifest line at a hashed, collision-resistant slot.
  Idempotent and EOL-safe. Guarded by `tests/index-anchor-2026-11-06.test.js`.
- `scripts/branch-sprawl-report.js`: classifies every remote branch (keep: default / backup /
  open-PR / active; merged; squash-merged; stale) and prints a dry-run `git push origin --delete`
  list. **It has no delete mode.** Run it after `git fetch --prune origin`.

## Proposals (owner decisions; not built)
- A required CI check running `pr-preflight --no-gates`.
- PR template fields: risk label; a "touches money / rules / functions / workflows" box; "synthetic
  data only, screenshots ≤ 200 KB".
- A stale-PR policy: a draft untouched for 14 days gets a comment; at 30 days, close it with the
  branch kept.
- The merge queue's batch settings can stay as they are (build 3, ALLGREEN): adjacency conflicts,
  not batch size, were what failed.
