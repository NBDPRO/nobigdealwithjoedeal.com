# Tracker branch rebase check — 2026-10-18

Phase 0 housekeeping of BUILD-PLAN-2026-10-18 (PR 2523): get the stale personal-tracker branches onto `main`.

**Result: nothing to port.** Every branch was squash-merged under a different SHA, so `git cherry` still shows `+` (patch ids differ) even though the work is on `main`.

| Branch | `git cherry` | On main as | Notes |
|---|---|---|---|
| `fix/daily-tracker-phase0` | 3 `+` | #1878 (sync fixes), #1880 (tab tap) | Every added line is on main except two since renamed/extended (`NBDDsCloud` now also exports `pushWorkout`; `ds-sync-logic.js` export list grew). |
| `feat/tracker-weight-history` | 1 `+` | #1892 | Only difference: `workout-coach.css` cache-bust `?v=2` → `?v=3`. |
| `feat/tracker-sunday-review` | 2 `+` | #2033 | Only differences: script cache-bust `?v=1` → `?v=3`, export lists extended. |
| `feat/tracker-money-tab` | 2 `+` | #2039 | `my_money` tool description reworded since. |
| `feat/tracker-food-log` | 0 | #1894 | Already merged. |
| `feat/jobs-calendar` | 0 | #1922 | Already merged. |
| `feat/daily-ledger` | 7 `+` | #2381 | Out of scope. Merged 2026-10-12; the `+` are stacked-PR restack commits. |
| `feat/labels-p2c-personal-capture` | 7 `+` | #2386 | Out of scope. Merged 2026-10-12; same restack pattern. |

How checked: for each non-merge commit, every added line (longer than 8 characters) was looked up in the file on `origin/main`. Then the four tracker suites were run on current `main`: daily-success-sync 60/0, tracker-weight-history 34/0, tracker-sunday-review 33/0, tracker-money 27/0.

Lesson: `git cherry` after a squash merge is a false "unmerged". Match by PR title or content before porting (see the squash-merge ancestry note in the memory index).

**Safe to delete** (Jo's call; not done here): the eight remote branches above.
