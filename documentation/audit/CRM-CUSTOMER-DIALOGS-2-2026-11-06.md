# Customer page dialogs, part 2 (CU-F15) — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)). Part 1 was
[CRM-CUSTOMER-KEYBOARD-2026-11-06](CRM-CUSTOMER-KEYBOARD-2026-11-06.md).
Test: `tests/customer-dialogs-keyboard-2026-11-06.test.js`. It passes 11/11 on this branch, and 7
checks fail against main's code.

| Where | What was wrong | Fix |
|---|---|---|
| `customer-documents.js` `_dlg` (Send securely options; the one-time code) | The dialogs were marked `role="dialog" aria-modal="true"` but had no name, no Esc, no focus move and no focus return. Tab walked out into the page behind. | Each dialog is named by its heading and focus starts on its first control. Tab stays inside it. Esc closes it as Cancel: it resolves `null`, as Cancel already did, and `sendSecurely` ignores the code dialog's value. Focus goes back to the button that opened it. |
| `customer-tasks-ui.js` document prerequisite dialog ("Can't Generate …") | It was not announced as a dialog, and had no Esc, no initial focus and no focus return. | It is now a named modal dialog with focus on "Got It". Esc, Got It and a backdrop tap close it and return focus to the opener. "Preview blank template" and "Fix →" still close it and move on, as before. |

Not changed:
- What any button does.
- The secure-link flow and its server calls.
