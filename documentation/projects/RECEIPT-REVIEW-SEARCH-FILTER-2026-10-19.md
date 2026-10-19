# Receipt import review: search, filters, type-ahead job picker (2026-10-19)

Jo did a live Home Depot import (about 44 rows) and said the flow works. His
only asks: when a row's best-match jobs don't show, stop scrolling a long list;
more search and filtering; a rounder, softer look. Matching and import logic
were **not** changed.

## What changed on screen (Expenses › Import Home Depot › Review)

- **Job picker is now type-ahead.** Tap a row's job button: a sheet opens with a
  search box. Type any words (customer name, street, NBD-####, stage). Every
  word must match (any order, any case). Up / Down move, Enter picks, Esc
  closes. The row's best matches stay pinned on top, then jobs used recently
  this session, then everything else. "No job (overhead / shop)" is the first
  entry when the box is empty. Bottom sheet on a phone.
- **Filter bar above the table.** Search across PO / job name, item
  description, SKU, store name / number, amount and the assigned job's
  customer. Filters: show (all / no job yet / has a job / selected / not
  selected / already imported), store, date from / to, min / max dollars, and a
  sort. Counts "N of M shown", the dollars shown, and the dollars selected.
  **Clear filters** resets. Filters are remembered for the browser session only
  (`sessionStorage`); nothing is written to Firestore.
- **Select shown / Deselect shown** and **Assign shown to a job...**: pick one
  job, an explicit confirm says how many receipts and how many dollars, and
  which rows are left alone (already imported, or matched to a *different* job
  by a customer # or a remembered name). Nothing is saved until Import.
- **Softer look:** 14px cards, pill buttons and tags, 44px touch targets,
  theme tokens only. Under 480px each receipt is a card (no sideways scroll).
  Transitions only when the device allows motion.

## Gate

Behind the **existing** `receiptSorterQueue` flag (no new flag). Flag off: the
old table renders byte-for-byte as before (the branch is one early return in
`hd-import.js` `renderReview`). Jo flips the flag in the Firebase console.
Lowe's review (`lowes-import.js`) and the card-by-card sorter
(`receipt-sorter.js`) were not touched.

## Files

`docs/pro/js/receipt-filter-logic.js` (pure, unit-tested),
`docs/pro/js/receipt-review-ui.js`, `docs/pro/css/receipt-review.css`, loaded by
the `expenses` bundle in `script-loader.js`; tests in
`tests/receipt-filter-logic-2026-10-19.test.js` (break-tested: each mutation of
the AND rule, pinning, date / amount bounds, the bulk skip rules, the flag and
the reduced-motion guard turns it red).

## Not verified

Run in headless Chromium against a stub page (real CSS + JS, 80 synthetic jobs,
12 receipts) at 1280 and 390 wide: no sideways scroll, no control under 44px.
**Not** run on a real iPhone or against live data.
