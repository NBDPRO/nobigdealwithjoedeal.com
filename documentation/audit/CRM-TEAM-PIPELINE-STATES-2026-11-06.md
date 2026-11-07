# Team roster states; pipeline stage removal guard — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/team-pipeline-states-2026-11-06.test.js`. It passes 9/9 on this branch, and 5 checks
fail against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ST-F38 | `dashboard-team-tab.js` `loadTeamMembers` | The roster had no loading row, and a failed read only reached `console.warn`. The Team panel looked empty either way. | "Loading your team…" shows while it reads, and a failed read says "Could not load your team. Check your connection and open Team again." |
| ST-F51 | `pipeline-builder.js`, the ✕ "remove from this pipeline" action | Unlike 🗑 delete, it had no occupancy check, so the leads on that stage dropped into the pipeline's first (New) column. | The same `canDeleteStage` guard as delete. It refuses while leads haven't loaded, and refuses (with a count) while leads are still on the stage. |

Not done here: **ST-F25** (a failed My Skin load leaves the controls dead). Falling back to a default config would let the next change overwrite the real saved skin, so the safe fix is a disabled "couldn't load" state. Left for its own change.

`team-roles` (17), `pipeline-builder-delete` (21) and `pipeline-builder-hydration` (53) pass.
