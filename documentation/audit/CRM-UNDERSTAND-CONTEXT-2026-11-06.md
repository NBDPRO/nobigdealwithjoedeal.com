# "Understand" page pipeline context — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/understand-context-2026-11-06.test.js`. It passes 6/6 on this branch, and 5 checks
fail against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| DT-F18 | `docs/pro/js/pages/understand.js` `loadPipelineContext` | It read `leads/{uid}/leads`, a nested path that doesn't exist. The catch-all rule denied it, so the "Your pipeline" bar and the pipeline lines given to the AI were always empty. | It reads the flat `/leads` collection where `userId == uid`, the same model `project-codex-page.js` already uses. The read is capped at 1,000, and deleted leads are skipped. The figure stays labelled "pipeline value", a projected figure, not revenue. |

Not changed: company-wide context for team roles. This read matches the owner scope the page used before; widening it would change what the AI sees.
