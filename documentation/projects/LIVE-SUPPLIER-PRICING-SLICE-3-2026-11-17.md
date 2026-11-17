# Live supplier pricing, slice 3: supplier files, compare suppliers, alerts (2026-11-17)

Status: **built on branch `claude/supplier-pricing-slice-3-d1af71` (2026-11-17),
ships dark behind `supplierPricing`.** This note carries no cost, price or
account number.

- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md)
- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md)
  (its section 8 "Slice 3" is larger; Jo cut it down, below)
- Slice 2: [LIVE-SUPPLIER-PRICING-SLICE-2-PLAN-2026-11-17](LIVE-SUPPLIER-PRICING-SLICE-2-PLAN-2026-11-17.md)

## Jo's decisions (2026-11-17, in chat)

Slice 3 is deliberately smaller than the design's: no nightly server job, no
stored alert inbox, no cost-book change.

1. **Import screen** (owner and company admins, flag on): supplier, CSV file
   (Excel saved as CSV), kind of document (quote, price sheet, invoice). A quote
   needs its good-through date. Sales tax asked once per file, no default.
   Column matching, preview with counts (rows, new items, need a unit,
   skipped), save through `priceLedgerRecord`. New item numbers become unlinked
   offers. Only the rows, the file name and the date are kept; the file is not.
   500 rows a call.
2. **Suggested links** on Unlinked items: SKU match first, else name match;
   one tap links, the picker still offers another product. Nothing links
   without the tap.
3. **Comparison:** every supplier's current price side by side per catalog
   unit on a product's Stores & prices sheet; a "Compare suppliers" button in
   the Product Library header with the count of open alerts.
4. **Alerts, on screen:** a price move (newest price at least the threshold
   above what was last paid that supplier for the item) and a cheaper supplier
   (another supplier at least the threshold under the usual one). Usual
   supplier = the one paid most recently, unless an account's `preferredFor`
   names the product's category.
5. **Tax-included comparison:** a before-tax price gets the company's rate
   added (integer micros). Only fresh prices count (paid within 60 days, a quote
   still good, a portal price within 7 days); older ones are greyed and never
   alert. Items with no confirmed pack size are counted, not compared. Delivery
   fee and minimum order are shown beside the price, never folded in.
6. **Seen marks:** one shared list for the owner and company admins; an alert
   comes back when a newer price arrives.
7. **Quote expiry:** "good for N more days", a warning in the last 7 days,
   "expired" after.
8. **Settings:** tax rate and alert threshold per company, off unless set
   (Jo's values, 7.8% and 5%, are his to type in; nothing in the code supplies
   them).
9. **Not in slice 3:** approving a price into the cost book (slice 4), a
   nightly job, storing files.

## What was built

| Piece | Where |
|---|---|
| CSV reading, column guessing, the import rows and preview counts, tax, settings, quote expiry, the comparison, both alerts, seen marks, suggested links | `functions/price-logic.js` SHARED block, copied byte for byte into `docs/pro/js/price-logic.js` |
| `csv_import` channel (owner / company_admin; paperwork kinds only; a quote needs good-through; a document reference is required; unit text nobody knows is kept as stated with no unit) | `functions/price-ledger.js`, `price-logic.js` `sanitizeObservation`, `NULL_UNIT_CHANNELS` |
| `markSeen` op, `priceBook/{companyId}/priceConfig/seen` (`marks: { alertId: { o: obsId, at } }`, capped at 2000) | `functions/price-ledger-store.js` |
| Rules: `priceConfig/{docId}` read by owner / company_admin, no client write | `firestore.rules` |
| Import prices screen | `docs/pro/js/price-import.js` (new) |
| Compare suppliers list, count, side-by-side block | `docs/pro/js/price-compare-ui.js` (new) |
| Suggested links, expiry badge, side-by-side block on the sheet | `docs/pro/js/price-offers-ui.js` |
| Two header buttons (owner / admins, flag on) | `docs/pro/js/product-library.js` |
| Supplier Price Compare panel, `companyProfile.pricing.supplierCompare: { purchaseTaxPct, alertPct }` | `docs/pro/dashboard.html`, `docs/pro/js/dashboard-bootstrap.module.js` |

Choices made where the decisions were silent:

- **A unit nobody knows** (for example "ZZ") is saved as printed, with no unit,
  and counted as "needs a unit" (design 5.3), not skipped.
- **No-unit rows from a distributor** stay without a per-unit price even after
  the pack is confirmed (design 5.3 rule 3 trusts a no-unit row only from a
  retail store). Re-import with the unit column mapped.
- **Price move** compares the offer's current best price with its last paid
  row; it needs the last paid row's tax basis, which `latest.lastPaid` now
  carries (`taxIncluded`). Summaries written before this slice gain it on the
  next price for that item.
- **With no tax rate set,** prices that all share one tax basis are still
  compared; a mix is not, and the screen says so.
- **The usual supplier's price** is its lowest fresh price when it has several
  items for one product.
- An offer from a store with no registry SKU kind (an `other_*` supplier) now
  stubs as `item_number` instead of `none`.

## Tests

- New: `tests/price-import-2026-11.test.js` (CSV, columns, setup refusals, rows
  and counts, server acceptance on `csv_import`, the browser's 500-row chunks in
  a vm), `tests/price-change-2026-11.test.js` (tax round trip, settings, expiry
  at 8 / 7 / 0 / -1 days, comparison, both alerts, seen marks, suggestions, the
  side-by-side block's HTML in a vm). Both registered in the node bucket.
- Extended: `tests/price-ledger-server-2026-11.test.js` (`csv_import` and
  `markSeen`), `tests/firestore-rules.price-ledger.test.js` (section 11).

## Not done

- Nobody has used the screens in the real dashboard. They were driven in a
  local harness page at phone width (375 px) with the real files and stubbed
  data: a CSV picked, the header row found, the preview counts, save, Unlinked
  items with a suggestion, the side-by-side block and Compare suppliers. No
  sideways scroll. Two fixes came out of it: the preview table wrapped mid-word,
  and a price-move alert was labelled "tax included" when no tax was added.
- The two reps' price sheets (SRS, QXO) are **not loaded**. After the deploy
  Jo loads each through Import prices, and only after his OK on its preview.
- Jo still has to type his tax rate and alert threshold under Company
  Settings → Supplier Price Compare; until then alerts are off.
