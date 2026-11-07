# Customer page hardening: photo URL, document drops — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/customer-hardening-2026-11-06.test.js`. It passes 10/10 on this branch, and 7 checks
fail against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| CU-F16 | `customer-tasks-ui.js` `showPhotoActions` | The photo quick-edit popup concatenated `photo.url` into `<img src="...">` unescaped. A stored URL containing a quote could break out of the attribute (`x" onerror="…`). | Same rule the photo grid already uses: `http(s)` only, escaped with the file's own `nbdEscFn()`. The image also gets `alt=""`. |
| CU-F22 | `customer-photo-report-generator.js` `addDocumentsToQueue` | The Files modal checked file type only through the input's `accept=` attribute, which a drag-and-drop bypasses, and it had no size cap. | Before queueing, files are checked against the same type list as `accept=` (pdf, doc(x), xls(x), jpg/jpeg, png) and the same 20 MB cap as `customer-dnd-upload.js`. Skipped files are named in one toast, and the return value counts only what was queued. |

Not changed:
- What uploads or renders for valid files.
- The signed-doc upload busy state (the other half of CU-F22), which is left for its own change.
