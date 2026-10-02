# Store price book + per-job materials list — plan (2026-10-02)

Jo, 2026-10-02:
- "I want to go on Home Depot live to shop pricing on all of our product
  library … almost clone it to a degree: all kinds of item options with SKU
  for Home Depot, possibly Lowe's, photos, descriptions, quantity values,
  correct options and price correct — at least for all of the items in our
  industry."
- "Every single job … generates me a recommended materials list with guessed
  or assumed pricing, material quantities, and where to buy them."
- "Possibly Menards."

## Decisions (Jo, 2026-10-02)

| Question | Answer |
| --- | --- |
| Where prices come from | **Jo's own purchase history + manual entry with store links**, and "you can help me drive it". No paid data service. **Never scraping or bulk-crawling retailer sites**: that breaks their terms and gets blocked. Claude helps fill entries one item at a time. |
| Where materials are bought | **Gulf Eagle Supply** (roofing distributor), other roofing distributors, **Home Depot** (Pro Xtra), **Lowe's**, **Menards** |
| Photos | Shown **inside the logged-in CRM only**. Also uses **manufacturer media-kit** images. Never on the public site. |

## What already exists (recon 2026-10-02)

- **`docs/pro/js/product-data.js`** holds the product library seed: ~276
  items. Each item has `unit`, `unitOptions` and `coverage` (e.g.
  `bundlesPerSq: 3`, `sqPerRoll: 10`, `"10 ft per piece"`), plus
  `colors`, `sizes`, `manufacturer` and a single `sku`.
  - It is **public**, so it carries spec and retail `sell` only.
  - Costs live in `catalogCosts/{companyId}`; see `catalog-costs.js`.
  - The company library is `productLibrary/{companyId}`.
- **`docs/pro/js/estimate-catalog-xactimate.js`** is the estimate engine's
  catalog (`RFG 240-GAF-HDZ`, `RFG SYN`, …). Its quantities are in
  estimate units (SQ, LF, EA), **not purchase units**.
- **`docs/pro/js/hd-import.js`** reads the Pro Xtra Summary and Details
  CSVs and creates expenses. The Details CSV has `SKU Number`,
  `SKU Description`, `Quantity` and `Net Unit Price`.
  - **It drops the SKU number and does not keep line items.** It only
  writes a short note.
- **No materials list, takeoff or purchase list exists anywhere** (grep,
  2026-10-02).

## Data model

**Spec stays public; prices stay private.**

- **Per-store offers on a product** (public-safe: no price):
  `stores: { homedepot: { sku, url }, lowes: { sku, url }, menards: { sku, url }, gulfeagle: { sku } }`,
  plus `photo` (a store or manufacturer URL, rendered in the CRM only) and
  `options`.
- **Price book**, `priceBook/{companyId}/items/{store}_{sku}`:
  - `{ store, sku, desc, lastPaidCents, lastPaidDate, history: [last 10 {cents, date, qty, jobId}], source: 'receipt' | 'manual', productId? }`.
  - Firestore only, company-scoped. **It is cost data, so it never goes
    under `docs/`** (`tests/catalog-cost-privacy.test.js`).
- **Purchase-unit conversion** reads each product's `coverage`.
  - Examples: SQ ÷ `sqPerRoll` → rolls; SQ × `bundlesPerSq` → bundles;
    LF ÷ 10 → pieces; LF ÷ LF-per-bundle → bundles.
  - Always round **up** to whole units.

## Phases

1. **Price book from receipts.**
   - `hd-import.js` keeps the `SKU Number` and line items, and on save
     upserts `priceBook` entries (last paid, history).
   - A "Price book" tab in the product library lists them. Each entry can be
     linked to a product, and a link stays.
   - Lowe's, Menards and Gulf Eagle get manual entries (SKU, URL, price,
     date). Gulf Eagle invoices are a later CSV/PDF import if Jo can export
     them.
2. **Store SKUs, links and photos on products.**
   - The product editor gets a Stores section (SKU + link per store) and a
     photo field.
   - Claude helps fill these one item at a time with Jo, starting with the
     items on real jobs.
3. **Recommended materials list per job.**
   - From the estimate's scope (V2/V3 engine quantities), map each line to
     its product, convert it to purchase units and add waste.
   - Each line shows **quantity to buy**, **assumed price** (last paid →
     manual → "set a price") with its date, and **where to buy** (the
     cheapest known store, or Jo's preferred one per item).
   - The output is a page on the customer and job, plus a printable or
     texted list grouped by store.
   - Internal only: these are cost figures.
4. **Later.** "Mark ordered / delivered" feeds the existing
   `materials_ordered` / `materials_delivered` stages, and actual receipts
   are compared against the list.

## Open questions for Jo

- Which items to fill first: the top 30 from real jobs, or a full
  category?
- Does Gulf Eagle offer an invoice export (CSV or emailed PDFs)?
- Preferred store per category (e.g. shingles → Gulf Eagle, sundries → HD)?
