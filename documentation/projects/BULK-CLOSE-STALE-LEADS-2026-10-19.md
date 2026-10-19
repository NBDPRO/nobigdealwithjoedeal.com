# Clean up stale leads (2026-10-19)

**Why:** 86 leads sat in stage `new`; 40 were Thumbtack leads nobody touched for 30+ days. They clutter the pipeline and agents cannot change a stage, so this is a UI action. It ships **dark**.

**Flag:** `bulkCloseStaleLeads` in `feature_flags/_default` (or per user in `feature_flags/{uid}`). Absent or false = no button, no modal, nothing runs. There is no flag registry to edit: the flag is only read (`NBDFlags.enabled`). Turn it on by setting `bulkCloseStaleLeads: true` there, then reload the CRM (flags are cached up to 10 minutes).

**What it does (flag on, not a viewer):**
- CRM board toolbar gets **Clean up stale leads**. The modal lists leads in stage `new` with no activity for N days (14 / 30 / 60 / 90, default 30), optionally for one source (menu shows how many are stale per source).
- "No activity" = the newest of `updatedAt`, `stageStartedAt`, `lastContactedAt`, `lastActivityAt`, `createdAt`. Never listed: deleted leads, prospects, leads snoozed into the future or with a follow-up date today or later, leads with no usable date at all.
- Preview table: name, source, created, last activity, age. Every row is checked by default; uncheck any. Under 480px the table becomes one card per lead (no sideways scroll). Nothing is written until **Close N leads…** then **Yes, close N leads** (a two-step confirm that names the count and the reason).
- Each checked lead goes to **Lost** with reason `Stale - no response` (`lostReasonKey: no_response`, an existing reason key) through `window.moveCard`, the same per-lead path as "Mark lost" and the No-next-step bulk lost: a transaction with the stale-write guard, `stage` + `stageRole` + `closedAt` + `lostReason`, a `stageHistory` entry (who, when, reason) and a "Stage moved to Lost" activity note. Done in chunks of 25 with a progress line. A raw 500-doc `writeBatch` was deliberately not used: it would skip the race guard, the history and the note.
- Review hardening: the confirm step freezes the list that was previewed (a lead that becomes stale, or active again, while the modal is open is not closed); each toast Undo is bound to its own batch; Undo stamps updatedAt with the server time; rows with an estimate, task, notes or logged contact start UNCHECKED and say why (Select all still includes them).
- Soft change only: nothing is deleted and no write sets `deleted`.
- **Undo** (this session only, kept in memory): a toast button right after, and an "Undo it" button in the modal. It puts back each lead's previous stage, stageRole, stageStartedAt, closedAt and updatedAt, clears the lost fields, appends an undo entry to `stageHistory` and files a note. A lead that someone moved or re-lost for another reason since is left alone and counted. After a page reload Undo is gone: reopen the lead and move it back, or use the stage history.

**Permissions:** viewers never see it. A lead is listed only if the user may change it (own lead, or same company for manager / company_admin, the rule `commitBulkLeadOp` and No-next-step use). The list comes from `window._leads`, already tenant-scoped.

**Files:** `docs/pro/js/stale-leads-cleanup.js`, `docs/pro/css/stale-leads-cleanup.css`, `docs/pro/dashboard.html` (button + tags), `tests/stale-leads-cleanup-2026-10-19.test.js` (registered in `tests/ci-manifest.json`; 13 mutations tried, all caught), `tests/dashboard-boot-budget-2026-10-03.test.js` (+1 deliberate script tag).
