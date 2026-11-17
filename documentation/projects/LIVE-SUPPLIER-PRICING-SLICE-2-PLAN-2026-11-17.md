# Live supplier pricing, slice 2 plan: bring the receipts in (2026-11-17)

Status: **a plan, not built.** Nine questions at the bottom need Jo's answer
before code. This note carries no cost, price or account number.

- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md)
- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md)
  (slice 2 is described there; this note is its step-by-step checklist, which
  the design gives only for slice 1).

The file and line anchors below were read by a planning pass against the slice 1
branch on 2026-11-17 and were not re-checked one by one. Confirm each anchor
before relying on it; where a step says something was not read, it was not.

## Numbers Jo gave for later slices (2026-11-17, in chat)

| Setting | Value | Used from |
|---|---|---|
| Purchase sales tax applied to a supplier price going into the cost book | 7.8% | slice 3 (comparison), slice 4 (approval) |
| Price move that raises an alert | 5% | slice 3 |
| Margin floor a cost change is checked against | 30% (Jo, 2026-11-17, after first answering 20%; 35% is the target he prices toward, not the floor). A change that takes a product under it needs an explicit confirm; it is not a refusal | slice 4 |

The catalog's own price floor is a different thing and is still 20% after labor
(`tests/catalog-price-floor-2026-11-09.test.js`, set 2026-11-09). The 54 products
lifted then sit at about 20%, so they are under this 30% line until their sells
are raised. Raising them is a separate pricing change that needs Jo's OK on a
private before-and-after list; it is not part of slice 2.

These are settings, not costs. They become `priceConfig/main` in slice 3.

## Slice 2 implementation checklist

Written for an engineer who has not read the recon. Read the design's sections
1.4, 1.6, 1.9, 3.1.2 and 5.3 first, and the "Update 2026-11-17" part of the lane
note. One PR, branched from the slice 1 branch (or `main` once slice 1 merges).
Slice 2 does three things: Home Depot receipt lines land in the ledger (a
dual-write beside the legacy call), a dry-run script copies the legacy
`priceBook/{companyId}` items in, and the ledger joins the company export. It
ships dark behind `supplierPricing`.

Not touched: `docs/pro/js/price-book.js`, the legacy `priceBook/{companyId}` doc
(the script only reads it), `tests/price-book-2026-10-02.test.js`,
`firestore.rules`, `catalogCosts`, `catalog-costs.js`, every estimate file, the
expense document shape. No new callable, no new rule, no new index. If a step
seems to need one, stop and ask.

Fixture rule: fictional suppliers, SKUs start `TEST-`, input prices multiples of
1111. In scanned files write the store as the id `homedepot`, never the label: a
real label within 200 characters of a money literal fails
`tests/price-fixture-privacy.test.js`. Never write `* 10000` in a `price-*.js`
file outside `price-logic.js`: the scan bans the substring `* 100`; use
`centsToMicros`.

### A. Before any code

1. Get Jo's answers to Q1 to Q9 below. The steps assume the recommended answer.
2. Keep this note linked from INDEX, and add a dated line to the lane note when
   the build starts.

### B. Tests first (watch them fail)

3. New `tests/price-ledger-migrate-2026-11.test.js` (bucket `node`; the
   `price-ledger-` prefix puts it in the privacy scan). Load
   `functions/price-logic.js` and the script's pure export with `require`; load
   `price-book.js` and `price-ledger.js` in a `vm`; reuse the fake Firestore idiom
   of `tests/price-ledger-server-2026-11.test.js`. At most 5 source-text
   assertions. Cases:
   - `legacyItemToLedger`: one legacy item gives one offer stub (id equals
     `keyFor`, `productId: null`, pack unknown) and one `paid` row per history
     entry, with `doc.type: 'receipt'`, `doc.ref` = the entry's `ref` or `''`,
     `statedUnit: null`, micros from cents; an entry with zero cents or a bad date
     is dropped.
   - Twin: receipts run through `purchasesFromHdReceipts` + `mergePurchases` then
     the migration, and the same receipts run through `recordHdReceipts`, give
     equal `obsIdFor` values; appended one after the other, the second is all
     `duplicate`.
   - Re-run adds nothing; a dry run produces zero writes; `--apply` without
     `--company`, and `--apply` without `--yes`, are refused.
   - Migration rows are stored `kind: 'paid'`, `attested: false`,
     `source.channel: 'legacy_pricebook'`, `locationId: null`.
   - `recordHdReceipts`: does nothing with the flag off; skips lines with no SKU;
     sends chunks of 500; resolves (never rejects) when the callable throws.
4. Extend `tests/price-ledger-server-2026-11.test.js`:
   - Channel: `channel: 'hd_csv'` accepted; any other value falls back to
     `manual`; a caller can not send `legacy_pricebook`.
   - Null unit: refused as `needs_unit` on `manual`; accepted on `hd_csv`, stored
     with `catalogMicros: null` and counted in `needsUnit` while the pack is
     unverified; after `verifyPack`, `latest.lastPaid.catalogMicros` is set.
   - Stub: an unknown offer with a valid stub creates one unlinked offer (pack
     unknown, `skuKind: 'store_sku'`, `altIds.internetSku`); two rows for one new
     SKU create it once; a stub whose id is not `offerIdFor(supplierId, sku)` is
     `bad_offer`; a stub on `manual` is still `unknown_offer`; an existing offer is
     never overwritten.
   - Store number: a row with `storeNumber` matching an account location gets
     that `locationId`; no match gives `null`, not `unknown_location`.
   - Role: per Q2.
5. Extend `tests/price-logic-2026-11.test.js`: the null-unit helper for every
   combination (channel, retail or not, pack verified or not); parity still holds.
6. `tests/hd-import-2026-09-29.test.js`: `parseDetails` reads `Internet SKU` and
   `attachDetails` carries it; `expenseDoc(...).items` is unchanged. `doImport` is
   not exported, so pin the wiring by source text, as the pinned price-book suite
   does: the new call sits after `NBDPriceBook.record`, inside a `try`. The cap of
   5 source-text assertions applies to this suite; its current count was not
   measured, so run the ratchet.
7. Export, in `tests/r4-erasure-export-honesty-2026-10-06.test.js`: the three
   ledger files and counts are in the zip; a failed ledger read fails the export;
   a capped one is named in `truncated`. Its fake database has no
   `collection().limit()`, so extend the stub. Two other suites also call
   `buildCompanyExport` (`tests/tenant-ready-2026-10-04.test.js`,
   `tests/sec-photo-path-confinement-2026-10-06.test.js`); their fakes were not
   read, so run both and extend them if they throw. The design also wants
   "`exportMyData` has no `priceBook` key" and "`exportCompanyData` refuses a
   manager"; no existing `exportMyData` behaviour test was found to extend.

### C. Server

8. `functions/price-logic.js`, inside the SHARED block, ES5 style:
   - `NULL_UNIT_CHANNELS = ['hd_csv', 'legacy_pricebook']`.
   - `sanitizeObservation`: today it refuses every row with no unit. When
     `ctx.channel` is in the list and both unit fields are empty, keep
     `statedUnit: null`, `per: 1`. Also pass through `storeNumber` (text, 20
     characters at most) and an `offer` stub `{ supplierId, sku, title,
     internetSku }` for those channels only.
   - `catalogMicrosFor(row, offer)`: when `statedUnit` is null, the row's channel
     is in the list, the supplier is retail and `offer.pack.verified === true`,
     read the price as per `pack.purchaseUnit`; otherwise defer to
     `toCatalogMicros`. Use it in `summarize`.
   - `stubOffer(stub)`: a minimal unlinked offer. `sanitizePack` refuses a null
     purchase unit, so the stub's pack is built here with every field null and
     `status: 'unknown'`.
   - `legacyPurchaseToRow({ store, sku, desc, cents, qty, date, ref })` and
     `legacyItemToLedger(key, item)`, the second built on the first. Copy the
     block byte for byte into `docs/pro/js/price-logic.js`; add the names to
     `module.exports`.
9. `functions/price-ledger-store.js`:
   - Pass `ctx.channel` to the sanitizer.
   - For a missing offer whose row has a stub and whose channel allows it, check
     `offerId === L.offerIdFor(stub.supplierId, stub.sku)`, `create()` the stub
     (tolerating already-exists), and use it. No supplier account is required here
     (unlike `upsertOffer`).
   - Resolve `storeNumber` to a `locations[].id` first; no match is `null`.
   - `deriveObservation`: use `catalogMicrosFor`; when `ctx.origin ===
     'migration'` keep `kind: 'paid'`, `attested: false`, actor type `script`.
     Today `attested` follows the caller's role and the id is hashed after the
     kind is decided, so this branch is what keeps a migrated row and its
     re-imported twin on one id.
   - The daily cap and the 500-row limit for a migration: see Q5.
10. `functions/price-ledger.js` `priceLedgerRecord`: `channel` is hard-coded to
    `manual` today. Read `request.data.channel` and allow only `'manual'` and
    `'hd_csv'`. Apply Q2. Update the header comment and the row in
    `functions/FUNCTIONS_INDEX.md`.

### D. Client

11. `docs/pro/js/hd-import.js`: `parseDetails` adds `internetSku` from the
    `Internet SKU` column and `attachDetails` copies it onto the item (leave
    `lineItems` alone). In `doImport`, leave the legacy price-book call exactly as
    it is and add one guarded call after it:
    `NBDPriceLedger.recordHdReceipts(...)`, inside a `try`, with no change to the
    toast text.
12. `docs/pro/js/price-ledger.js`: add `recordHdReceipts(receipts)`. Return at
    once unless `enabled()` and the Q2 role check passes. For each receipt and
    item build the purchase with the same expression the legacy path uses,
    convert with `legacyPurchaseToRow`, add the store number and the stub with
    `internetSku`. Send through the existing `priceLedgerRecord` callable with
    `channel: 'hd_csv'`, 500 rows a call. Never throws. Add `unlinked()`:
    offers where `productId` is null, limit 200 (equality only, no index).
13. `docs/pro/js/price-offers-ui.js`: an `openUnlinked` action listing unlinked
    offers (supplier, SKU, title, last paid as stated, date), each with "Link to
    a product" for the owner or a company admin, through a product picker. The
    click delegate lets only `openProduct` run with no sheet open: add
    `openUnlinked`. Use `catalogMicrosFor` where the per-catalog-unit price is
    shown. Whether `packFields` accepts a null purchase unit was not checked.
14. `docs/pro/js/product-library.js`: after the pinned "Price book" header
    button (its markup is pinned; do not edit it) add a ghost button
    `data-prl-action="openUnlinked"`, rendered only when the flag is on.
15. `docs/pro/js/script-loader.js`: add `price-logic.js` and `price-ledger.js` to
    the `expenses` bundle after `price-book.js`. Bump the keys of `hd-import.js`,
    `product-library.js` and the three ledger files, using the same key in both
    bundles, then bump the `script-loader.js` key in `dashboard.html` and
    `customer.html` together.
16. `tests/merge-leftovers-guard-2026-10-05.test.js`: add
    `'/pro/js/price-logic.js'` and `'/pro/js/price-ledger.js'` to the allowlist of
    files that may sit in two bundles (it is an exact-set check).

### E. The migration script

17. `scripts/migrate-price-book-v2.js`, modelled on
    `scripts/backfill-lead-jobs.js` (dry run by default, `--company` required,
    `--apply` needs `--yes`, a run-once guard) and on the `.local/` backup in
    `scripts/merge-catalog-costs.js` (`.local/` is ignored by git). Export a pure
    `plan(items)` for the test. Read `priceBook/{company}.items`, map with
    `legacyItemToLedger`, call `appendObservations` with `{ origin: 'migration',
    channel: 'legacy_pricebook' }`. Print counts only: no price, SKU or
    description. Agents never run `--apply` (CLAUDE.md rule f).

### F. Export

18. `functions/tenant-ops.js` `buildCompanyExport`: read
    `priceBook/{companyId}/supplierAccounts`, `priceOffers` and
    `priceObservations`, each capped at `EXPORT_LIMIT`; a failed read fails the
    export; a full page puts the name in `truncated`. Add them to the files,
    counts and README the export already writes.

### G. Register the suite

19. `node scripts/index-anchor.js manifest --test price-ledger-migrate-2026-11.test.js --bucket node`,
    then `node scripts/run-test-manifest.js --check` and paste the `FLOORS` line
    it prints, with a dated history line above it.

### H. Commands to run

```bash
node tests/price-ledger-migrate-2026-11.test.js
node tests/price-ledger-server-2026-11.test.js
node tests/price-logic-2026-11.test.js
node tests/price-fixture-privacy.test.js
node tests/price-book-2026-10-02.test.js     # pinned: unedited and green
node tests/hd-import-2026-09-29.test.js
node tests/r4-erasure-export-honesty-2026-10-06.test.js
node tests/tenant-ready-2026-10-04.test.js
node tests/sec-photo-path-confinement-2026-10-06.test.js
node tests/merge-leftovers-guard-2026-10-05.test.js
node tests/viewer-callables.test.js
node tests/catalog-cost-privacy.test.js
node tests/inline-style-ratchet-2026-10-01.test.js
node tests/source-pin-ratchet.test.js
node scripts/migrate-price-book-v2.js --company c_demo   # expect a refusal or a dry run; never --apply
node scripts/gen-function-map.js --check
node scripts/check-js-syntax.js
node scripts/check-inline-html-scripts.js
node scripts/check-vault-index.js
node scripts/run-test-manifest.js --check
node scripts/run-test-manifest.js --bucket node
node tests/smoke.test.js
node scripts/pr-preflight.js
```

The rule-e estimate suites run inside `--bucket node` and must not move. On a
Windows checkout the runner's 8-minute budget stops before the bucket ends, and
six call-center suites fail for line-ending reasons that have nothing to do with
this lane: run the remainder separately and let CI on Linux be the answer.

### I. PR body and after merge

20. PR body: ships dark behind `supplierPricing`; the legacy doc, `price-book.js`
    and its suite unchanged; the cache-key bumps; Jo's answers to the questions
    below.
21. After the deploy Jo imports one Home Depot export with the flag on and opens
    Unlinked items. The migration `--apply --yes` is Jo's run, or one he approves
    in chat for that run.

## Open questions for Jo

- **Q1. Unit of a Home Depot row.** The design reads a no-unit retail row as the
  offer's purchase unit only when the pack is verified; otherwise it is stored
  with no per-catalog-unit price. So after linking, "last paid" shows the stated
  price, and the per-unit figure appears only after "Confirm pack size". OK?
  (The Home Depot Details export has no purchase-unit column.)
- **Q2. A manager's or rep's import.** Today a non-admin import saves expenses
  and records nothing in the price book. Recommended: the client skips the ledger
  call unless the person is the owner or a company admin, and the server refuses
  `hd_csv` from a manager. The cost: those receipts are marked imported and never
  reach the ledger (see Q4).
- **Q3. Route.** `recordHdReceipts` through `priceLedgerRecord` with a `channel`
  field (recommended; the design lists no new callable), or a separate callable?
- **Q4. Summary-only imports.** Receipts imported without the Details file have
  no items, and a later import with Details skips them as already imported.
  Recommended: send the ledger every reviewed receipt that has items, including
  already-imported ones (the ids make it safe to repeat). That is a wider change
  to `hd-import.js` than the design's "one added call". Or leave the gap.
- **Q5. Migration limits.** `appendObservations` meters 5000 rows a company a day
  and 500 a call. Should a migration skip the meter (recommended) or chunk and
  count?
- **Q6. Store number with no matching branch.** A stub offer needs no supplier
  account, so the branch is empty until Jo adds Home Depot with its stores. The
  number survives only inside the receipt reference (not for online orders). Is
  that enough, or add a field?
- **Q7. A legacy item's `productId`.** The field exists on the legacy doc and no
  code sets it: carry it to the offer, or always unlinked as the design says?
- **Q8. Script flags.** The design says `--apply`; the repo's scripts use
  `--apply --yes`. The checklist uses `--apply --yes`. Back up on every run, or
  only before a write?
- **Q9. Export.** Should the legacy `priceBook/{companyId}` doc and `priceAudit`
  join the export too? The design names only the three collections.
