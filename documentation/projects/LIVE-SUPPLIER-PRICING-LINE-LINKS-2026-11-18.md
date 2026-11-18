# Live supplier pricing: exact estimate-line links (2026-11-18)

Status: **built on branch `claude/supplier-pricing-line-links-2026-11-18`, ships dark
behind `supplierPricing`.** PR 2 of the plan Jo confirmed on 2026-11-18. This note
carries no cost, price or account number.

- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md) (the plan, "Update 2026-11-18 (later)")
- Slice 7: [LIVE-SUPPLIER-PRICING-SLICE-7-2026-11-18](LIVE-SUPPLIER-PRICING-SLICE-7-2026-11-18.md)

## Jo's decisions (2026-11-18, grilling round)

- A starter list of the estimate codes that clearly name one product; an
  "Estimate codes" box on each product where the owner or an admin adds or removes
  codes; their edits win.
- A code on more than one product counts as unlinked. A line never borrows another
  product's price.
- No automatic unit conversion: a linked pair in different units shows "the
  product is priced in another unit".

## What was built

| Piece | Where |
|---|---|
| `PL_LINE_STARTER` (45 codes, each one product; codes and product ids only), `sanitizeEstimateCodes`, `productEstimateCodes`, `lineCodeMap`; `materialsPricing` now prices a line only from the product its code is linked to | `functions/price-logic.js` SHARED block, copied into `docs/pro/js/price-logic.js` |
| `setEstimateCodes` save op (owner, company_admin): `productLinks/{productId}.estimateCodes` / `estimateCodesSet`, audited; `reset` goes back to the starter list | `functions/price-ledger-store.js`, `functions/price-ledger.js` |
| The Estimate codes box on the Stores & prices sheet: the product's codes, a warning when another product also claims one, a note when the estimate unit differs, Remove, Add code with suggestions from the catalog, Use the starter list | `docs/pro/js/price-offers-ui.js`, `docs/pro/css/price-ledger.css` |
| The materials list reads the links | `docs/pro/js/price-materials.js` |

The starter list leaves out codes where more than one product fits: RFG SYN, RFG
NAIL-C, RFG RIDG, RFG SKY-STD, RFG PWR, RFG SOLAR, RFG TURB, the ridge vents and
GTR GG-MESH. The 3-tab codes (RFG 3T20, RFG 3T25) both point at the one 3-tab
product.

A line's states on the materials list: priced; the estimate code is not linked to
a product; two products claim the code; the product has no supplier item yet; the
product is priced in another unit; no fresh supplier price.

## Found while building: 15 of the 45 starter links are in another unit

Underlayment (estimate per square, product per roll), starter and ridge (per foot
against per bundle), decking (per square foot against per sheet), step flashing,
H-clips and cap nails (each or per square against per box). As decided, those lines
say "priced in another unit" until fixed. Fixing one needs a ratio per code (for
example 1 roll = 10 squares): a new decision for Jo, asked after this PR.

## Tests

- `tests/price-logic-materials-2026-11.test.js` (42): the starter list is real
  (every code in the catalog, every product in the catalog); codes left out on
  purpose are out; a product's own list replaces its starter codes; a dropped code
  is unlinked; two claims map to null; reset; cleaning codes; a GAF HDZ line prices
  from GAF HDZ and never borrows a cheaper shingle's price; unlinked and conflicting
  codes.
- `tests/price-ledger-photos-2026-11.test.js` (27): the save op keeps the photo and
  approval markers on the same doc, audits, refuses bad codes and unknown products.
- The box was checked in a local harness at 375 px: the conflict warning, the
  suggestions, Add code sending a cleaned list. No sideways scroll.

## Not done

- Nobody has used it in the real dashboard.
- 74 estimate codes and every RoofIVent product start unlinked; Jo links what he uses.
