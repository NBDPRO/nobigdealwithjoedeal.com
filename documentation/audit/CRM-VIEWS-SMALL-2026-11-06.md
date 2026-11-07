# Three small view fixes — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/views-small-2026-11-06.test.js`. It passes 11/11 on this branch, and 5 checks fail
against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| VW-F14 | `call-center-view.js` `matchesSearch` | A number typed with its country code ("+1 513…", or "1 (513)…") is 11 digits and never matched the 10-digit `phoneDigits` the server files. | A leading `1` is dropped from an 11-digit query, using the same rule as the file's `digits10`. |
| VW-F17 | `referral-rewards-ui.js` mark paid | Marking a referral bonus paid answered "yes", and marked it paid, when neither `nbdConfirm` nor `window.confirm` existed. | That fallback now answers "no" (fail closed). `nbdConfirm` and a real confirm still decide as before. The `nbdConfirm \|\|` shape `pwa-confirm-guard` expects is kept. |
| VW-F58 | `rep-report-generator.js` "Enrich data" | The summary was shown in a native `alert()`, beyond the three alerts allowed. | The summary rides the success toast. |

All ten call-center suites, `pwa-confirm-guard` and the a11y sweeps still pass.
