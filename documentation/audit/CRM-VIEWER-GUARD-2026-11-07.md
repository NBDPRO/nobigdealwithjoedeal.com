# Viewer guard on six customer write entry points — 2026-11-07

Part of the [overnight CRM audit](CRM-AUDIT-HARNESS-2026-11-06.md), finding CU-F19.

Under Jo's 2026-09-25 decision, the viewer role is read-only everywhere (`role-gate.js`). Most customer-page save functions start with `NBDRole.guard()`, which tells a viewer "Your role is view-only" and writes nothing. Six of them didn't:

- `openEventModal`
- `applyBulkPhotoUpdate`
- `applyBulkPhotoDelete`
- `quickSaveMeta`
- `deletePhoto` (all five in `customer-tasks-ui.js`)
- `toggleHomeownerShare` (`customer-documents.js`)

A viewer who reached one of them through the keyboard, a menu rendered before claims resolved, or a control the CSS hides got a raw error. The Firestore rules still refused the write, so nothing was ever saved.

All six now start with the same one-line guard their neighbours use. For every other role it returns true and nothing changes.

`tests/viewer-guard-customer-2026-11-07.test.js` runs each shipped function with a viewer guard and a trap on the page and the database. The suite passes 6/6, and all 6 checks fail on main.
