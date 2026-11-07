# Customer page failure states — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/customer-states-2026-11-06.test.js`. It passes 10/10 on this branch, and 6 checks
fail against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| CU-F09 | `customer-photo-report-generator.js` `loadNotes` | A failed notes read only logged, and the panel kept "No notes yet", so a rep could think the lead had no notes. | The panel says "Could not load notes. Refresh to try again." An empty read still says "No notes yet". |
| CU-F10 | `customer-documents.js` e-sign envelopes | A failed read left the signature-request list blank. | One line in `#esignEnvelopeList`: "Could not load signature requests. Refresh to try again." |
| CU-F18 | `customer-bootstrap.module.js` | Opening `customer.html` with no `?id=` returned silently, leaving "Loading..." on an `opacity:0` page. | It shows the page's own error card ("No customer selected", with Back to Dashboard) and makes the page visible. |
| CU-F17 | `customer-realtime.module.js` Messages | After one send error the status line stayed red, so a later "Sent ✓" showed in red. The error colours were a bare `#fca5a5`. | Each send clears the colour. Errors use `var(--ui-danger-text, #fca5a5)`. DESIGN.md → Color says red text must use `--ui-danger-text`, because plain red on navy is under 4.5:1 (corrected after the steward review). The old value stays as the fallback. |

Not done here:
- CU-F08 (the Calls section): the calls code has an open PR (#2946).
- The rest of CU-F17 (a snapshot error wipes `#repMsgEmpty`).
