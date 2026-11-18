# Live supplier pricing, slice 4: approve a supplier price into the cost book (2026-11-17)

Status: **built on branch `claude/supplier-pricing-slice-4-2026-11-17` (2026-11-17),
ships dark behind `supplierPricing`.** Jo said "Build slice 4" after answering
the plan's eight questions, each with the recommended answer. This note carries
no cost, price or account number.

- Plan, with Jo's answers: [LIVE-SUPPLIER-PRICING-SLICE-4-PLAN-2026-11-17](LIVE-SUPPLIER-PRICING-SLICE-4-PLAN-2026-11-17.md)
- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md)
- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md) (section 6)
- Slice 3: [LIVE-SUPPLIER-PRICING-SLICE-3-2026-11-17](LIVE-SUPPLIER-PRICING-SLICE-3-2026-11-17.md)

## What Jo sees (flag on, owner or company admin)

- **Update my cost** under a supplier item's price on a product's Stores &
  prices sheet, and on each Compare suppliers alert that names a product.
- A panel with one line per tier the item is for: was, now (the price per
  catalog unit with his purchase tax added), the change, and the margin after
  labor before and after. Each line has a tick. Lines that can not be approved
  say why in plain words.
- **Approve**. Going under the margin floor (his estimate floor in Company
  Settings) or above the sell asks "Approve anyway?" first.
- Above the items: a note on any tier whose cost is above its sell, and the last
  approved change per tier with **Undo**.
- **Good / Better / Best ticks** on the add-item, link and pack-size forms (Good
  by default).
- The Product Library margin moves at once on that device and on his other
  devices the next time they load. No quote, estimate, sell or labor changes.

## What was built

| Piece | Where |
|---|---|
| Money at the book boundary (`microsToCostBookDollars`, `dollarsToMicros`, `bookMicros`), the floor setting (`marginFloorTenths`), margin after labor, which prices can be approved (`approvalSource`), the lines (`proposalLines`), the confirm check (`costGuardRefusal`), `changeTenths` / `tenthsText` | `functions/price-logic.js` SHARED block, copied byte for byte into `docs/pro/js/price-logic.js` |
| `approveCost` and `undoCost` save ops, one transaction each; `linkOffer` takes `tiers` | `functions/price-ledger-store.js` |
| The callable returns `applied`, refusals in plain words (a stale one as `aborted`) | `functions/price-ledger.js` |
| Unit and sells of the published catalog for the server (no cost, no labor), with `--check` | `scripts/build-product-seed-public.js` → `functions/product-seed-public.json` |
| Rules: `priceBook/{companyId}/productLinks/{productId}` read like offers (`plMember`), no client write | `firestore.rules` |
| A save writes only what changed, one field path each (Q6); `noteApproved` | `docs/pro/js/catalog-costs.js` |
| `applyApprovedCost`; `saveProduct` passes the copy it replaces | `docs/pro/js/product-library.js` |
| `approveCost`, `undoCost`, `observation`, `productLinks`, `syncApplied` (other devices) | `docs/pro/js/price-ledger.js` |
| The panel, the notes and Undo, the tier ticks | `docs/pro/js/price-offers-ui.js`, `docs/pro/css/price-ledger.css` |
| Update my cost on alerts | `docs/pro/js/price-compare-ui.js` |

The rules for an approval, as built:

- The server rebuilds every line from the stored offer, the price row, the cost
  book, the product (the company's own library row, else the published catalog
  file) and the company profile. A line is written only if it still matches what
  the person saw (`changed` otherwise) and its guards pass. All the ticked lines
  or none.
- It writes `catalogCosts.costs.<productId>.cost.<tier>` and nothing else in that
  document, one `priceAudit` row (`cost_change_applied`, from and to, the guard,
  both confirms, a note) and `productLinks/{productId}` (`applied.<tier>`,
  `preferredOfferId`), in the same transaction.
- Approvable: a paid receipt or invoice within 60 days, a quote, contract or
  price sheet still good, a portal or account price within 7 days; entered by an
  owner or admin (attested); a net or account price; not delivered; not flagged
  as a unit swap; the pack size confirmed and still on the product's unit; a tax
  rate set; a cost book that holds costs.
- Undo: only the last approved change on a tier, only while the book still holds
  that value. It puts the old cost back (or removes a tier the approval created)
  and is logged as `cost_change_undone`. It does not ask about the floor: it puts
  back what was there.
- Other devices apply an approval once, after their book loads, and only while
  the book still holds the approved value, so a later edit wins.

Where the build departs from the plan:

- All lines or none: if one ticked line is refused, nothing is written and the
  screen says why. The plan said `applied` and `refused` side by side.
- No tax rate set blocks every line, also for a price that already includes tax
  (the design's rule: the rate must be chosen before anything is approved).
- A product with no sell on a tier can still be approved; it shows no margin and
  runs no floor or sell check.
- The server reads the company's own library row for the sell. When that differs
  from what the device showed, the server asks for the confirm and the screen
  asks "Approve anyway?" before sending again.
- `linkOffer` now takes `tiers`: items from store receipts have no supplier
  account, so `upsertOffer` would refuse them.
- No new callable: both ops sit on `priceLedgerSave`.

## Tests

- New: `tests/price-change-approve-2026-11.test.js` (the logic and both store
  ops against an in-memory Firestore: stale input, all-or-none, only the one
  path, the guards and confirms, created entries, racing approvals, undo, the
  seed file) and `tests/price-change-devices-2026-11.test.js` (the real browser
  files in a vm: the per-change save, `applyApprovedCost`, `noteApproved`, the
  other-device pass, flag off). Both in the node bucket.
- Extended: `tests/price-ledger-server-2026-11.test.js` (the callable refuses a
  manager, a rep and a viewer; every refusal has a message),
  `tests/firestore-rules.price-ledger.test.js` (section 12, `productLinks`;
  329 passed on the emulator).
- Break-tested: removing the `before` argument, the "book still holds it" check,
  the server's `changed` check, the attested check and the floor confirm each
  made a test fail.
- The rule-e estimate suites ran with no change.

## Not done

- Nobody has used it in the real dashboard. The panel was driven in a local
  harness page at 375 px with the real files and stubbed data: open the sheet,
  Update my cost, untick a tier, Approve (the floor confirm, only the ticked line
  sent), Undo, the tier ticks on the pack form. No sideways scroll.
- Jo has to set his purchase tax rate (Supplier Price Compare) and his margin
  floor before anything can be approved, if they are not set yet.
- Product photos moved to their own slice (Q7).
