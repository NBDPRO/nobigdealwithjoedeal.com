# Customer card: duplicate uploads, wrong-photo edits and a dead task writer — 2026-11-06

From the 2026-11-06 full CRM audit (CU-F01, CU-F03, DT-F10; scorecard on the `crm/2026-11-06-tooling` branch).

## Script order is the root of two of them
On `customer.html`, `customer-bootstrap.module.js` (type="module", line ~2883) and the deferred
`customer-tasks-ui.js` (line ~2899) execute in document order, so whichever defines a `window.*` function LAST
wins. Two functions were defined in both:
- **`openDocUploadModal` / `closeDocUploadModal` (CU-F01, P2).** The module's version clears the upload queue on
  open and on every dismiss; `customer-tasks-ui.js` overwrote it with a bare open. After a successful upload,
  reopening Files showed the same files again and Upload filed them a second time. `customer-tasks-ui.js` now only
  installs its copy when none exists.
- **`toggleTask` (DT-F10).** The module's copy wrote the RETIRED top-level `/tasks` store; it only lost because the
  other file loads later. Removed so a script-order change (e.g. a joined bundle) can never revive it.

## Wrong photo (CU-F03, P2)
The photo quick-edit popup (`quickSetPhase`, `quickSetSeverity`, `quickSaveMeta`) wrote through
`_allPhotos[_quickEditPhotoIdx]`. A photo-list refresh while it was open reordered the list, so the phase, damage
tags or cover photo landed on a different photo. It now resolves the photo by the id captured at open.

## Proof
`tests/customer-files-guards-2026-11-06.test.js` loads the real `customer-tasks-ui.js` after a stand-in for the
module's opener (page order) and runs the real `quickSetPhase` against a reordered list: 13/13; on main 8 fail —
the phase lands on the wrong photo. Local harness: on `customer.html` the live opener is the queue-clearing one,
`toggleTask` writes `leads/{id}/tasks`, no page errors.
