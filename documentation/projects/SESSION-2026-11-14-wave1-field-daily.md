# Session 2026-11-14: wave-1 field (phone) and daily-screen fixes

Joe asked for fixes to two read-only reviews of NBD Pro, with tests that fail first:
- **Phone in the field:** 14 findings.
- **Daily-use screens:** 13 findings.

Every finding was checked in the code before it was fixed. Only one was partly unreal: field #9. A shot taken while the photos bundle was loading was already safe; the real loss was when that load *failed*, and that case is fixed.

Each fix has a test that runs the real code (a VM plus the shared fake DOM in `tests/lib/nbd-os-home-harness.js`) and was seen failing on `main` first. Each branch also had a silent-failure review, and every real issue it found was fixed in the same branch.

## Draft PRs (merge order: see `merge-plan-2026-11-14.md` in the session notes)

| PR / branch | Findings |
|---|---|
| #3061 `fix/field-deploy-reload` | field #3: a new deploy defers its reload while a modal, typed text or a recording is live (`safe-reload.js`, injected by both service-worker scripts). |
| #3062 `fix/field-lost-captures` | field #1, #2, #7, #8, #9. |
| #3078 `fix/offline-saves` | field #4, #5, #6 and daily #6. |
| #3081 `fix/daily-tasks-fresh` | daily #1, #2, #3. |
| #3086 `fix/customer-page-tasks-search` | daily #4, #8. |
| `fix/daily-polish` | daily #5, #7, #9, #11, #12, #13 and field #11. |
| `fix/tasks-load-recent` (stacked on #3081) | daily #10. |
| `fix/field-modes` (stacked on `fix/daily-polish`) | field #10, #12. |
| `fix/touch-targets` | field #13. |
| `fix/offline-banner-weak-signal` | field #14. |

What each one does:
- **field #1, #2, #7, #8, #9:** a voice clip is kept in IndexedDB with Retry; picked photos go through the queue; one bad photo no longer blocks the rest; thumbnail decode has an error path and a timeout; Field shots are held until the photo tools load.
- **field #4, #5, #6 and daily #6:** new lead, notes, "I'm on site" and customer task/event saves return offline through `NBDOfflineSync.settle`, with busy guards.
- **daily #1, #2, #3:** tasks refresh after boot and from the calendar; a failed "+ Add" keeps its text; a dismissed alert returns after a reschedule; task loads are single-flight.
- **daily #4, #8:** search on a customer page reaches every customer; the Open tasks block offers Done, Reschedule and Delete.
- **daily #5, #7, #9, #11, #12, #13 and field #11:** STOP list newest first (new index), "What's new" hidden when empty, stage filter kept on tab return, Google Calendar line only when synced, estimate search, list sort kept, Field shutter count.
- **daily #10:** open tasks plus the last 30 days of done ones, with a legacy `status:'open'` read (six indexes).
- **field #10, #12:** Field camera Photo mode by default; "+ Lead" and a stage select in Field.
- **field #13:** 44 px tap targets on the customer page and 11 px phone nav labels (check on a real phone; list in the PR).
- **field #14:** the offline banner also shows on weak signal and when saves wait to sync.

## Decisions Joe made (2026-11-14)
- Build the four leftover field items and the bounded task load. The task load uses 30 days.
- **Boot byte budget:** there are no per-PR raises; the conductor raises the ceiling once in its own PR. Until that lands, `dashboard-boot-budget-2026-10-03` is red on these branches.
- **Accepted as built:**
  - the customer ID is deferred on a slow connection
  - the generic "refused when it synced" toast
  - dismissed alerts show once more after the id change

## Know before touching
- **Shared files.** `layouts/field.js` is shared by #3062, #3078, `fix/daily-polish` and `fix/field-modes`, and `customer-tasks-ui.js` by #3078 and #3086. Expect conflicts when these merge one after another.
- **Indexes.** The new indexes must deploy before the bounded task load and the STOP list use them. Until they build, both fall back to the old reads on `failed-precondition` only.
- **Security review.** It found no change in who can read what. It lists emulator cases worth adding for the new STOP-list and task queries; they are in the PR bodies.
