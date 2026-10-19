# Receipt sorter, piece 1: keep line items + review state (2026-10-18)

Part of the receipt-sorter build ([audit](RECEIPT-CAPTURE-AUDIT-2026-10-18.md); piece 3 is the Copy PO name button, its own PR).

**What changed (Home Depot import, `docs/pro/js/hd-import.js`):**
- Each saved expense now keeps its readable line items (`items[]`: sku, description, quantity, unit price in cents; at most 40 per receipt, description clipped to 120 characters) instead of only a 500-character note. The review queue and the materials-list check need them.
- `reviewState`: `assigned` (a job was chosen), `overhead` (explicit "No job", a shop word, or a tool buy), `unsorted` (nobody decided). `suggested` is reserved for the queue (piece 4). `matchEvidence[]` records why the importer proposed what it did.
- **Duplicate rows in one export:** the same online order can list twice (one row per register) with identical money. Before this change both rows were importable, so that purchase counted twice. Now identical-money rows collapse to one; same order number with different money (a split shipment) stays, under a key that adds the transaction id.

**Rules (`firestore.rules`, `validExpenseMoney`):** `items` must be a list of at most 60; `reviewState` must be one of the four words. Rules tests (create, update, cross-tenant read and re-sort) pass on a local emulator; reverting the rule turns the first of them red.

**Tests:** `tests/hd-import-2026-09-29.test.js` section 5 (items kept and capped, no negative money, review states, duplicate order collapse, split shipment kept); break-test: removing the dedupe reddens both duplicate assertions.

No new flag: the write is the same user-pressed Import, with extra fields. The writer that sorts receipts (piece 4) is flag-gated.
