# Second integrity pass: stale address on contracts, re-uploaded files, a lying stage select, blanked profiles — 2026-11-06

From the 2026-11-06 full CRM audit (CU-F04, CU-F02, PL-F08, ST-F06; scorecard on the `crm/2026-11-06-tooling`
branch). All Tier A — no values, prices or schema change.

- **CU-F04 — contract carried the old address.** `customer-edit-modal.js saveCustomerEdits` updated only
  `window._currentLead`. Portal-link helpers, the documents module and snooze replace `_currentLead` with a copy,
  after which `window._leadDoc` — what the document generator and pre-flight read — kept the old name, address and
  phone. Edit Info now updates both (the stage-gate save already did).
- **CU-F02 — a failed file re-uploaded the others.** `uploadDocuments` had one try around the batch: the first
  refused file stopped it, files that had gone up stayed queued, and a retry uploaded them again. Now every file
  is attempted, finished ones leave the queue, and the rep sees "Uploaded N of M … tap Upload to retry the rest".
- **PL-F08 — the list-view stage select lied.** `moveCard` resolves `undefined` when it refuses (read-only lead,
  a missing required field) or the rep cancels the Lost picker, without re-rendering; the select kept showing the
  new stage. It now snaps back unless the move resolved `true`.
- **ST-F06 — a failed profile read blanked the profile.** Settings → Profile read `users/{uid}` inside a silent
  `catch {}`; after a failed read, Save wrote the empty Phone / Google review / Cal.com / Role boxes over the
  stored values (the homeowner portal's "Call your rep" number and the review-nudge link). Save now writes only
  the display name when the profile wasn't loaded, and says so.

`tests/integrity-2-guards-2026-11-06.test.js` runs the real code for all four: 16/16; against main 13 fail and the
positive controls pass.
