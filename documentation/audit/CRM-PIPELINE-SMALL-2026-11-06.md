# Pipeline small fixes — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/pipeline-small-2026-11-06.test.js`. It passes 9/9 on this branch, and 4 checks fail
against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| PL-F19 | `crm-pipeline.js`, legacy drop handler (used when the stage list loses its load race) | The handler lacked the `e.stopPropagation()` the new-system handler has. A drop also reached the board-level delegated handler, so `moveCard` ran twice: the second time without the job id, and a Lost move opened the reason picker twice. | Same `stopPropagation()` as the new path. |
| PL-F29 | `kanban-context-menu.js` long press | The long press arms a `{ once, capture }` click suppressor so the card doesn't also open. iOS often sends no click after a long press, so the suppressor stayed armed and swallowed the rep's next real tap on that card. | It is disarmed 400 ms after the finger lifts (`touchend` / `touchcancel`), however long the hold. |
| PL-F24 | `dashboard.html` `#nav-admin` | Team Manager was the one sidebar item without `role="button" tabindex="0"`, so a keyboard couldn't reach it. | Added, same as its siblings. |

Checked and not changed: **PL-F20** (goTo's secondary-toolbar highlight reads `onclick`). No `.crm-sec-btn` element exists anywhere in `docs/pro`, so the loop runs over nothing. It is dead code, not a visible bug; it's mentioned here and left in place, per the change-discipline rule.
