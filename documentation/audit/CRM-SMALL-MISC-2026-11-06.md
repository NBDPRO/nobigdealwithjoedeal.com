# Small fixes: prospect age, persona team default — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/small-misc-2026-11-06.test.js`. It passes 10/10 on this branch, and 3 checks fail
against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| VW-F03 | `prospects.js` `ageInDays` | Only a Timestamp, `_seconds` or `Date` counted. A lead whose `createdAt` is an ISO string or an epoch-ms number (CSV imports, older writers) had no age: it showed no age chip and vanished whenever an age filter was set. | Strings and numbers are parsed too. Garbage or a missing date still reads as no age. |
| ST-F57 | `ai-texting-persona.js` `isOwner` | The "use as the team default" option was hidden from a `company_admin`, although `firestore.rules` `cpCanWrite` lets that role write the company profile (the same predicate as `upgrade-price-settings.js` `canEdit`). | A `company_admin` sees it. Sales reps and viewers still don't. |

Checked, not changed: **ED-F21** (the retired orange triplet `232,114,12`) has no remaining occurrences on main; #2943 removed them.
