# Receipt sorter, piece 4: the review queue (2026-10-18)

Part of the receipt-sorter build ([audit](RECEIPT-CAPTURE-AUDIT-2026-10-18.md)). **Depends on piece 1** (kept line items, `reviewState`; PR #2532) **and piece 2** (company job-name memory; PR #2533). This branch contains both of their changes so it can be tested; enqueue them first, in that order.

**What it is:** Expenses › **Sort receipts (N)**. A full-screen sheet shows one unsorted receipt at a time: the **PO/Job name first and large**, then store #, date, total, and what was bought. Under it, the three most likely jobs, each with a plain-language list of why. One tap: **Assign to this job**, **Overhead / shop**, **Skip for now**, **Undo last**; a "Pick another job" menu covers the rest. A counter shows what is left.

**Flag:** `receiptSorterQueue` (`feature_flags/_default`, absent = off). Off = the button never renders and the files do nothing. The writer is the tap only; nothing is auto-saved.

**Matching (`receipt-sorter-logic.js`, pure):**
- HIGH, the only level that is "exact": the PO text carries the customer number (`NBD-####`), or a name this company assigned before (piece 2's memory).
- Suggestions: full name (45), last name only (28), first name only (12), business word (30); house number plus street (50), street only (30). Fuzzy: case, punctuation, nicknames (Bob/Robert), one typo or swapped letters in a long word (Meuller/Mueller).
- Extra evidence, only ever added on top of one of the above, never a reason on its own: the purchase date is inside the job's scheduled window (+12); the items look like the job's trade (roofing / siding / gutters, +10).
- Same trip (+25): receipts from the same store on the same day already assigned to that job. This one can stand alone as a weak suggestion.
- **Not used, because the data does not honestly support it today:** distance from the store to the job, amount vs the estimate's materials, call and visit notes.
- A close call between two jobs (within 6 points) is flagged and never auto-picked.

**Remembering names:** a PO name is saved to the company memory **once, when the sheet closes**, and only for assignments that were not undone. A remembered name later counts as an exact match, so an undone wrong tap must never leave one behind. Customer-number and shop-word names are not remembered.

**Writes (tap only):** `leadId`, `jobId`, `reviewState` (`assigned` / `overhead`), `costType`, `matchEvidence`, `sortedBy`, `sortedAt`. Assign makes a materials receipt a direct job cost; Overhead makes it overhead. Undo restores the previous values. Existing expense rules apply (owner or admin updates; tenant-scoped).

**Tests:** `tests/receipt-sorter-logic-2026-10-18.test.js` (29 checks, synthetic data; making a name match HIGH reddens four, including "a full-name match is only a suggestion"). `tests/e2e/phone-receipt-sorter.spec.js` (`@phonefit`, 360 and 412 px, no server: nothing past the right edge, buttons at least 44px, Assign/Undo write the right fields, a name is remembered only if its assignment was kept; dropping the undo clean-up reddens it). It was run on Chrome locally and passes.

**Not yet verified:** the sheet inside the real authed dashboard on an installed iPhone (daylight pass), and the flag turned on against real data. No real receipts have been written anywhere; the first real run is a dry-run read from this queue with Jo.
