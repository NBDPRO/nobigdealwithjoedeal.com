# Lead-task writer shape — 2026-09-26

**Status:** fixed in `fix/lead-task-writer-shape`. Prod census (read-only):
**0 rows need backfill.** The backfill script ships anyway, dry-run by default.

## The finding

Every task surface reads one shape from `leads/{leadId}/tasks`:
`{text, title, done, dueDate: 'YYYY-MM-DD' | '' | null}`.

| Reader | Reads |
|---|---|
| `docs/pro/js/tasks.js` `renderTaskList` / `renderTodayTasks` | `t.text` (label), `t.done`, `t.dueDate` (no dueDate → never in Today's Tasks) |
| `docs/pro/js/notif-bell.js` | `t.done`, `t.dueDate` (same early return on a falsy dueDate) |
| `docs/pro/js/activity-feed.js`, `ai.js` | `t.text` |
| `docs/pro/js/crm-pipeline.js` task badge | `t.done`, `t.dueDate` |
| `docs/pro/js/customer-bootstrap.module.js` `loadTimeline` (+ the second timeline ~3745) | `title \|\| text`, `done` |

Two client writers emitted `{title, body, status:'open', priority, …}` — no
`text`, no `done`:

1. **`docs/pro/js/voicemail.js` `writeActionItemTasks`** (the reported one) —
   also no `dueDate`. Each action item became a **blank row** in the lead's
   task modal, and never reached Today's Tasks or the bell at all.
2. **`docs/pro/js/tools.js` `_qaCreateEverything`** — the Quick Add
   "Reach out within 24h" task. **The sibling, and the more visible one**: it
   *did* carry a `dueDate`, so it showed in Today's Tasks as a blank line with a
   checkbox, then as a blank **OVERDUE** line, and its overdue notification
   (`tasks.js` → `createNotification`) read `"undefined" for <name>`.

`done` missing was *not* the "never-done" failure the first report guessed:
every reader tests `!t.done`, so a missing `done` reads as open, and ticking it
writes `done:true` normally. The damage was the label (and, for voicemail, the
missing due date). `status:'open'` was dead weight — no reader anywhere.

All other writers were already canonical: `customer-tasks-ui.js` (task + event),
`tasks.js`, `quick-capture.js`, `demo.js`, `stage-checklist.js`,
`functions/integrations/measurement.js`, `functions/portal.js` (homeowner callback request), `functions/seed-demo.js`, migration
006, and the pending Thursday/Bland writer in PR #1783.

## The fix

Both writers now emit `text` + `title` (mirrored), `done:false`, a
`YYYY-MM-DD` `dueDate`, `notes` (was `body`), `source` (was `sourceType`, now
matching `quick-capture`/`stage_entry`/`measurement`), and `leadId`.

- **Voicemail tasks are due today.** A judgment call: a customer left a
  voicemail asking for something, and with no due date the item is invisible
  on every surface that drives the day. Reverse it by writing `dueDate: ''` if
  Jo would rather they sit undated.
- **Quick Add's "tomorrow" is now a local date.** It used
  `toISOString().slice(0,10)` — UTC — so an evening Quick Add landed its
  24-hour task the day after tomorrow.

Rules needed no change: `leads/{id}/tasks` is not shape-validated
(`firestore.rules` ~433).

## Prod census (read-only, 2026-09-26)

`node scripts/backfill-lead-tasks-shape.js` (dry-run) against `nobigdeal-pro`:

```
scanned (all "tasks" groups)   : 18
top-level /tasks (skipped)     : 1
already canonical              : 17
no text                        : 0
  …of which carry sourceType   : 0
needed backfill                : 0
```

Positive control by an independent path (`listDocuments()` on `leads`, then each lead's `tasks` subcollection): **264 lead refs, 10 with tasks, 17 tasks** — the same 17 — by source: 11 unsourced (manual), 3 `stage_entry`, 2 `homeowner_callback`, 1 `measurement`. None without `text`; **no `voicemail` or `quick-add` rows at all.** (The 18th collection-group hit is the one legacy top-level `/tasks` doc.)

So neither writer has fired in prod yet (or its rows were since edited/deleted)
— the bug was caught before it reached a customer record. The script is kept
because both paths are live in the UI and the prod picture could change before
this deploys.

## Backfill script

`scripts/backfill-lead-tasks-shape.js` — `scripts/_admin.js` +
`_migration-guard.js` conventions: dry-run default, `--apply --yes`, run-once
marker (`--force` to repeat). Fills **missing** fields only, never overwrites:
`text ← title`, `done ← status in {done, completed, complete, closed}`,
`dueDate ← null` when absent, `notes ← body` when absent. An absent due date is
backfilled as `null`, **not** a date — inventing one would put an old voicemail
straight into Today's Tasks as OVERDUE and fire an overdue alert for it. Skips
Add-Event docs and the legacy top-level `/tasks` collection.

## Guard — `tests/lead-task-writer-shape.test.js` (node bucket)

1. **Executes** both fixed writers: the function source is extracted from the
   shipped file and run in a `vm` against a stub Firestore; the captured doc is
   checked (text, title mirror, `done === false`, `YYYY-MM-DD` due date, no
   `status`, local-date due day).
2. **Sweeps** every client `addDoc(collection(…'leads', X, 'tasks'), {…})` under
   `docs/pro/js` (7 today, floor ≥ 7 so it cannot go vacuous) and asserts each
   literal carries `text` and `done`, comments stripped first.
3. Unit-tests the backfill's pure `canonicalPatch`.

### Break-test

Reverting `voicemail.js` and `tools.js` to `origin/main` → **14 red, 18 green**:
all eight voicemail shape assertions, the four quick-add shape assertions, and
both sweep rows (`tools.js:617`, `voicemail.js:365`). The `canonicalPatch` block
stays green (it tests the script, not the writers), as does
"quick-add task: due tomorrow (local date)" — at the hour of the run UTC and
local dates agreed; that assertion only discriminates in the evening.

## Not done

- `customer-bootstrap.module.js` ~2347 still defines a `window.toggleTask` that
  updates the **top-level** `tasks/{id}`. It is dead: `customer.html` loads
  `customer-tasks-ui.js` (defer) after the module, and that file reassigns
  `window.toggleTask` to the `leads/{id}/tasks` version. Worth deleting so
  nobody "fixes" the wrong one; not touched here.
