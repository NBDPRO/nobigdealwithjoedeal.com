# Customer page keyboard and labels (CU-F15) — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06. The harness and the findings index ship in
[NBDPRO/nobigdealwithjoedeal.com#2938](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2938).
Test: `tests/customer-keyboard-2026-11-06.test.js`. It passes 12/12 on this branch. Against main's
code, 7 checks fail; the other 5 are positive controls and a still-labelled check.

| Where | What was wrong | Fix |
|---|---|---|
| `customer-tasks-ui.js` `showPhotoActions` / `_closePhotoActionPopup` | The photo quick-edit popup was a hand-built dialog with no Esc, no focus move and no focus return. | It is `role="dialog" aria-modal="true"` with a name. Focus goes to its close button, and Esc closes it. Every close path (×, Esc, backdrop) returns focus to whatever opened it, if it is still on the page. |
| `customer.html` `#docDropZone`, `customer-photo-report-generator.js` | The drop zone is the only way to pick documents to upload, and a keyboard couldn't reach it. | It is now `role="button" tabindex="0"` with an `aria-label`, and Enter / Space open the file picker. |
| `customer.html` Edit Customer | "Additional Service Locations" was a second `<label for="editDamageType">`, so the Damage Type input had two labels and the list had none. | It is now a `<div class="ui-label">` that names the list (`role="group" aria-labelledby`), because `customer-a11y-structure.test.js` requires every `<label>` to carry a `for=`. `ui-primitives-2026-10-01.test.js` counts `for="edit…"` labels; its expected value moves from 14 to 13 to match, with the assertion unchanged. |

Found but not a bug: `#docDropZone` is wired twice, in both `customer-photo-report-generator.js` and `customer-bootstrap.module.js`, so a drop calls `addDocumentsToQueue` twice. That function already dedupes on name + size + lastModified, so nothing is queued twice. The duplicate wiring is left alone.

Still open from CU-F15:
- The document prerequisite dialog (`customer-tasks-ui.js` ~2491-2521).
- The secure-link `_dlg` dialogs (`customer-documents.js` ~836-885).

Both should move to `nbdModal`. That is a bigger change, and those files have other open PRs.
