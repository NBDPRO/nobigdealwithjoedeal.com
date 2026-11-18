# Live supplier pricing, slice 7: the materials list at your own suppliers (2026-11-18)

Status: **built on branch `claude/supplier-pricing-slice-7-2026-11-18`, ships dark
behind `supplierPricing`.** This note carries no cost, price or account number.

- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md)
- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md) (section 8, slice 7)

## Jo's decisions (2026-11-18, in chat; each the recommended answer)

- Supplier prices on the list are seen by the owner, company admins and managers.
  A rep still sees the list: quantities and where to buy, no supplier price.
- Each line uses the supplier the company set as usual for that kind of product,
  else the cheapest fresh price. The quantity comes from the item's confirmed pack
  size. The company's own suppliers replace the two built-in store names. A line
  with no price says "No price yet".
- (Slice 5, Check today's price, waits until a store-price service is chosen.)

## What Jo sees (flag on)

The 🧾 Materials list on an estimate opens as before, then repaints by his own
suppliers: each line with what to buy at that supplier (bundles, rolls, pieces),
the supplier's price per unit, when it was paid or quoted, "your usual supplier"
where that applies, and the line total; at the bottom the total at his suppliers
for the priced lines and how many lines are not priced yet (with what the
estimate assumed for them). Copy list still copies no prices, now grouped by his
suppliers. With the flag off nothing changes.

## How a line is priced

- The line's catalog sub-category (and, for underlayment, its code) says which
  library products it can be: architectural, designer, impact or 3-tab shingles,
  synthetic, ice & water or felt, starter, ridge and hip, drip edge and rake,
  valley, transition, decking, fasteners, gutters, downspouts, guards. Anything
  else (labor, ventilation, boots…) is never priced here.
- Priced only when **exactly one** of those products has a supplier item linked:
  none is "no supplier item linked yet", more than one is "more than one product
  matches this line". Never a guess.
- The estimate's unit must be the product's unit (a product priced per roll is
  not priced from a per-square line).
- Only fresh prices count (paid within 60 days, a quote still good, an account
  price within 7 days), per catalog unit, tax added as on Compare suppliers.
- Quantity: whole purchase units from the item's pack size, rounded up. Total:
  the per-unit price times what is bought, in integer micros, shown in cents.

## What was built

| Piece | Where |
|---|---|
| `materialProductsFor`, `priceMaterialLine`, `materialsPricing` | `functions/price-logic.js` SHARED block, copied into `docs/pro/js/price-logic.js` |
| The supplier view, its body and the copy button; wraps `NBDMaterials.open` | `docs/pro/js/price-materials.js` (new) |
| Loads it only with the flag on (bundle `supplierpricing`) | `docs/pro/js/dark-features.js` |

`docs/pro/js/materials-list.js` is **not edited**: it loads on every dashboard
boot and the boot script budget had no room (`tests/dashboard-boot-budget-2026-10-03.test.js`;
the standing rule is no per-PR raise). The new file loads lazily, and fetches the
estimates bundle (the ledger) if the page has not loaded it yet.

## Tests

- New `tests/price-logic-materials-2026-11.test.js` (29): products per line, the
  exactly-one rule, usual supplier versus cheapest, stale prices, unit mismatch,
  pack-size quantities (12-ft pieces, 4-square rolls, exact multiples), tax, the
  regrouping with no built-in store name, labels when the company has none, the
  copy text without prices, staff versus rep display, escaping.
- `tests/dark-features-lazy-2026-11-08.test.js`: seven flag bundles now.
- Unchanged and green: `materials-list-2026-10-02`, `production-flow-2026-10-04`,
  the dashboard boot budget.

## Not done

- Nobody has opened it in the real dashboard. It was driven in a local harness
  page at 375 px (stubbed data): the owner view, a rep's view (no dollar figure),
  the copy text. No sideways scroll.
- Most of Jo's products will show "No price yet" until his supplier price sheets
  are loaded and their items linked with confirmed pack sizes.
- Two architectural shingles both linked to items make every architectural line
  "more than one product matches". Exact line-to-product links are slice 10.
