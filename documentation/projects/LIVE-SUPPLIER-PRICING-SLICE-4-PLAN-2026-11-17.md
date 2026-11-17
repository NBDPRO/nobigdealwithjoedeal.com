# Live supplier pricing, slice 4 plan: approve a supplier price into the cost book (2026-11-17)

Status: **plan only, not built.** Nothing in the code changed to write this.
The checklist assumes the recommended answer to every question at the bottom;
Jo's answers are recorded there when he gives them. This note carries no cost,
price or account number.

- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md)
- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md)
  (sections 1.5, 1.7, 1.8, 5.1, 5.3, 6 and 8 "Slice 4")
- Slice 2: [LIVE-SUPPLIER-PRICING-SLICE-2-PLAN-2026-11-17](LIVE-SUPPLIER-PRICING-SLICE-2-PLAN-2026-11-17.md)
- Slice 3: [LIVE-SUPPLIER-PRICING-SLICE-3-2026-11-17](LIVE-SUPPLIER-PRICING-SLICE-3-2026-11-17.md)

## Where slice 4 starts from (read on `main` b3876a7)

The design's slice 4 assumes things slice 3 did not build. The plan follows
what is on `main`, not the design:

| Design assumes | What `main` has | What this plan does |
|---|---|---|
| Stored alerts `priceAlerts/price_change_<productId>` with `lines` | No stored alerts. Alerts (`move_…`, `cheaper_…`) are worked out on screen by `supplierAlerts` in `price-logic.js`; the only stored thing is the shared seen list, `priceConfig/seen` | An approval is built from the stored offer at the moment of the tap and re-built by the server (Q1). No alert doc, no `priceAlertDecide` |
| Settings in `priceBook/{companyId}/priceConfig/main` (`purchaseTaxBps`, `floorBps`) | Tax rate and alert threshold in `companyProfile.pricing.supplierCompare` (`supplierCompareSettings`); the estimate margin floor in `companyProfile.pricing.marginFloor.floorPct` (`margin-floor.js`) | Read both from `companyProfile/{companyId}` (Q4). No `priceConfig/main` |
| `functions/product-seed-public.json` (units and sells for the server) | Not built | Built here: the server needs each product's unit and sell to run the guards |
| Comparison on a tax-free basis | `compareProduct` and `priceMoveAlert` compare tax-included (a before-tax price gets the company's rate) | Same: the proposed cost is the tax-included price, which is what the cost book holds (Jo, 2026-08-19) |
| `bookMicros`, `microsToCostBookDollars`, `dollarsToMicros` | Not in `price-logic.js` yet | Added here (design 5.1) |
| Offer `tiers` editable | `sanitizeOffer` keeps `tiers` (default `['good']`), but no screen sets them | Q3 |

Other facts the steps rely on (each read on `main`):

- `catalogCosts/{companyId}` is `{ costs: { <productId>: { cost: { good, better, best }, labor: { perUnit, … } } }, xactCosts, jtCosts, laborOps, v2Costs, defaults }`. Rules let the owner and company admins write it; nothing on the server writes it today.
- `docs/pro/js/catalog-costs.js` `recordProduct` calls `writeEntries('costs', { id: entry })`, which replaces `costs.<id>` whole. That is the "stale device writes its old cost back" hole (design R4, section 6 step 8).
- `docs/pro/js/product-library.js` `applyCostSeed` skips a product the person has edited (`updatedAt !== createdAt`) that has any cost or labor; `saveProduct` stamps `updatedAt`. Cloud rows (`productLibrary/{companyId}.items`) carry sells, never cost or labor (`cloudItem`).
- The catalog floor (DATA_VERSION 8) is 30% after labor: `(sell - cost - labor.perUnit) / sell`. The estimate floor is the company setting `companyProfile.pricing.marginFloor.floorPct`; with nothing set it is off.
- `price-fixture-privacy.test.js` scans tests by an explicit prefix list (`price-change-` is on it); a new `tests/price-*.test.js` with another prefix fails its honesty check. So the new suites are named `price-change-…`.
- `catalog-costs.js` and `product-library.js` load through `script-loader.js` (the Product Library bundle), not the dashboard boot, so the boot budget is not touched. Confirm with `tests/dashboard-boot-budget-2026-10-03.test.js`.

## What Jo sees when it is built

On a product's **Stores & prices** sheet, under each supplier's current price
that is fresh enough to trust, an **Update my cost** button (owner and company
admins, flag on). It opens a short panel, one line per tier the item is for:

- was (the cost book now), now (the new cost: the supplier's price per catalog
  unit with sales tax added), the change;
- the margin after labor at today's sell, before and after;
- a tick per line, and **Approve**.

A line that would take the margin under the company's floor, or the cost above
the sell, asks "Approve anyway?" before it saves. A line that can not be
approved says why (no tax rate set, the pack size is not confirmed, the
product's unit changed, the price is too old, no cost book yet). The same
button sits on each alert in **Compare suppliers** that names a product. The
Product Library margin moves at once on that device, and on his other devices
at their next load. No quote, estimate, sell or labor figure changes.

## Slice 4 implementation checklist

One PR, branched from `main`. Ships dark behind `supplierPricing`. Pricing
adjacent: rule e applies (the estimate suites run and must not move).

Not touched: any sell (`product-data.js`, `productLibrary` sells,
`TIER_RATES`, `companyProfile.pricing` other than reading it), `labor`,
`xactCosts`, `jtCosts`, `laborOps`, `v2Costs`, `defaults`, every estimate file,
`price-book.js` and the legacy doc, the `catalogCosts` and `productLibrary`
rule blocks, the pinned `priceBook` rule block, `tests/price-book-2026-10-02.test.js`.
If a step seems to need one of these, stop and ask.

Fixture rule (unchanged): fictional suppliers, SKUs start `TEST-`, input money
literals are multiples of 1111, derived values computed in the test or on a
line ending `// derived`. No `* 100`, `/ 100`, `parseFloat(` or `toFixed(` in a
new `price-*.js` file outside `price-logic.js`.

### A. Before any code

1. Get Jo's answers to Q1 to Q8 below.
   → verify: the "Jo's answers" section of this note is filled in.
2. Add a dated line to the lane note when the build starts.

### B. Tests first (watch each fail)

3. New `tests/price-change-approve-2026-11.test.js` (bucket `node`). Pure logic
   from `functions/price-logic.js` with `require`, the store against the fake
   Firestore idiom of `tests/price-ledger-server-2026-11.test.js`. At most 5
   source-text assertions. Cases:
   - Money: `microsToCostBookDollars`, `dollarsToMicros`, `bookMicros`; a value
     that rounds to zero cents is `below_one_cent`.
   - `approvalSource(offer, nowMs, account)`: a fresh paid, quote, price sheet,
     contract or portal row is allowed; `manual`, `live_shelf`, an unattested
     row, `priceType` `list` or `promo`, `compare: false`, `delivered: true`, a
     row past its freshness (61-day paid, expired quote) is refused with a
     named reason (Q2).
   - `proposalLines(input)`: one line per tier of the offer (Q3); `toCents` =
     whole cents of `applyTaxMicros` for a before-tax price, unchanged for a
     tax-in price; `fromCents` null when the book has no cost; a line equal to
     the book in whole cents is `no_change`; `blocked` is `needs_tax_rate` when
     the company has no tax rate, `needs_pack` when the pack is not verified,
     `unit_changed` when `pack.catalogUnit` is not the product's unit,
     `no_cost_book` when the book has no `costs`.
   - Guards: margin after labor uses `(sell - cost - labor) / sell` in whole
     cents and tenths of a percent; under the floor needs `confirmBelowFloor`;
     cost above the sell needs `confirmAboveSell`; no floor set means no floor
     check; missing labor per Q4.
   - Store `approveCost`: refused for the flag off, a manager, a sales rep, a
     viewer; stale `expect` (the book changed, or the offer's newest price
     changed) is `changed` and writes nothing; only `costs.<id>.cost.<tier>`
     changes (labor, the other tiers, every other map and product
     byte-identical before and after); no sell in any write; a product with no
     book entry gets a one-tier entry and the audit says `created: true`; an
     empty book is `no_cost_book`; the audit row and `productLinks/{id}.applied.<tier>`
     are written in the same transaction; two approvals racing on one path
     leave one applied and one `changed`; approving then rebuilding the line
     gives `no_change` (no flapping); a second tenant's book is never read.
4. New `tests/price-change-devices-2026-11.test.js` (bucket `node`): load
   `catalog-costs.js`, `product-library.js` and `price-ledger.js` in a `vm`.
   - `applyApprovedCost` sets the local tier cost without stamping `updatedAt`.
   - `noteApproved` changes that one path in the in-memory book and cache;
     `xactCost()`, `jobItem()` and `laborOp()` answers are unchanged.
   - A second device: after hydrate, an `applied` marker newer than its stored
     marker updates an edited product; an older one does nothing; with the flag
     off `productLinks` is not read.
   - A later name-only save from a stale device does not revert the approved
     cost (needs step 13).
5. Extend `tests/catalog-cost-seed.test.js` for the per-change write (step 13):
   a save writes one path per changed tier, `deleteField()` for a cleared tier,
   `labor` only when it changed, nothing for a name-only save; the CLEAR cases
   (other SKUs untouched, the `setDoc` fallback on a first write) stay green.
6. Extend `tests/firestore-rules.price-ledger.test.js` with a section 12:
   `productLinks/{productId}` read by owner, company_admin, manager and
   sales_rep; denied to viewer, `member`, a role-less claim, another company, a
   removed former owner; every client write denied. Remove `productLinks` from
   the "not added yet" list in case 10.
7. Extend `tests/price-ledger-server-2026-11.test.js`: the `approveCost` op is
   in `saveOps`, refuses a manager at the callable, maps every refusal to a
   plain message in `REASONS`.
8. New `scripts/build-product-seed-public.js --check` is run by a case in the
   approve suite: the generated file holds only `{ id: { unit, sell: { good,
   better, best } } }` and matches `product-data.js` (no `cost`, no `labor`).

### C. Server

9. `functions/price-logic.js`, SHARED block (ES5, copied byte for byte into
   `docs/pro/js/price-logic.js`, names added to `module.exports`):
   `microsToCostBookDollars`, `dollarsToMicros`, `bookMicros`,
   `approvalSource`, `proposalLines`, `marginAfterLabor`, `costGuards`. The
   screen and the server build lines with the same code.
10. `scripts/build-product-seed-public.js` writes
    `functions/product-seed-public.json` from `docs/pro/js/product-data.js`
    (units and retail sells only, both already public). Add it to the
    `DATA_VERSION` checklist comment in `product-library.js` only if that
    comment is the checklist (do not reword it otherwise).
11. `functions/price-ledger-store.js`: a new save op `approveCost`, data
    `{ productId, offerId, obsId, lines: [{ tier, expectFromCents, expectToCents }], confirmBelowFloor, confirmAboveSell, note }`.
    In one transaction read: the offer (must be linked to `productId`, active,
    `latest.bestComparable.obsId === obsId`), its supplier account (quote
    days), `catalogCosts/{companyId}`, `productLinks/{productId}`,
    `productLibrary/{companyId}.items[productId]` (else the seed file) for the
    unit and sell, `companyProfile/{companyId}` for the tax rate and floor.
    Rebuild each line with `proposalLines`; refuse a line whose rebuilt
    `from`/`to` differ from what the person saw (`changed`) or that is
    blocked; apply the guards. Write `costs.<id>.cost.<tier>` by field path
    only, the `priceAudit` row (`cost_change_applied`, from and to in dollars,
    `created`, the guard and both confirms, the note), and
    `productLinks/{id}.applied.<tier> = { atMs, dollars, auditId, obsObservedAtMs }`
    plus `preferredOfferId` (the offer approved from). Answer
    `{ ok, id: auditId, applied: [{ tier, dollars }], refused: [{ tier, reason }] }`.
    Logs: event names and counts only.
12. `functions/price-ledger.js`: list `approveCost` in the header, add its
    reasons to `REASONS` in plain words, and return `applied` / `refused` (today
    the callable returns only `{ ok, id }`). No new callable: an op on
    `priceLedgerSave` keeps the owner / company_admin gate, the flag and the
    rate limit, and avoids a first-deploy drop (design R10). Update the
    `priceLedgerSave` row in `functions/FUNCTIONS_INDEX.md`.
12b. Undo (Q8): a save op `undoCost` `{ productId, tier, auditId }`. Allowed
    only while `productLinks/{id}.applied.<tier>.auditId === auditId` and the
    book still holds that applied value in whole cents (else `changed`).
    Writes the audit row's `from` value back by the same field path (or
    `deleteField()` when the approval had created it), audit type
    `cost_change_undone`, clears `applied.<tier>`. Same transaction rules and
    tests as step 3 (undo after a later edit is refused; undo twice is refused).
    A cost above the sell is not stored as an alert: the sheet derives the
    "cost is above sell" warning (Q5) from the product each time it paints.

### D. Rules

13. `firestore.rules`: the `productLinks` block from design 2.1, placed after
    the `priceConfig` block, house style, `plMember` read, no client write.
    No other rule changes: the server writes `catalogCosts` with the admin SDK.

### E. Client

14. `docs/pro/js/catalog-costs.js` (Q6): `recordProduct(product, before)`
    writes only what changed against `before` (one `costs.<id>.cost.<tier>` path
    per changed tier, `deleteField()` for a cleared tier, `costs.<id>.labor`
    when labor changed). With no `before` (any other caller) it keeps today's
    whole-entry write. Add `noteApproved(id, tier, dollars)`: one path in the
    in-memory book and cache, no re-read, no `hydrate({ force })`.
15. `docs/pro/js/product-library.js`: `saveProduct` passes the stored copy it
    replaces as `before`; add `_productLib.applyApprovedCost(id, tier, dollars)`
    (sets `pricing[tier].cost`, saves the store, re-renders, no `updatedAt`).
16. `docs/pro/js/price-ledger.js`: `approveCost(data)` through the existing
    `priceLedgerSave` callable; after `NBDCatalogCosts.hydrate()`, with the flag
    on, read `productLinks` (equality-free collection read, cap 500) and apply
    each `applied.<tier>` newer than this device's localStorage marker for that
    path (try/catch around storage).
17. `docs/pro/js/price-offers-ui.js`: the **Update my cost** button under a
    fresh price (owner and company admins); the panel with was / now / change,
    margin before and after, a tick per line, the blocked reasons, Approve; the
    "Approve anyway?" confirm through `nbdConfirm`; on success call
    `noteApproved` and `applyApprovedCost` with the returned `applied` list and
    toast "Cost updated". Escape every supplier string. Per Q3, a tier choice on
    the link / pack form (Good, Better, Best; Good ticked by default) saved
    through `upsertOffer`'s existing `tiers`.
18. `docs/pro/js/price-compare-ui.js`: on an alert that names a product, an
    **Update my cost** button that opens the product's sheet at that offer
    (reuse step 17; no second panel).
19. `docs/pro/js/script-loader.js`: bump the `?v` keys of every changed file,
    the same key in both bundles; bump the `script-loader.js` key in
    `dashboard.html` and `customer.html` together.

### F. Register the suites

20. `node scripts/index-anchor.js manifest --test price-change-approve-2026-11.test.js --bucket node`
    and the same for `price-change-devices-2026-11.test.js`; then
    `node scripts/run-test-manifest.js --check` and paste the `FLOORS` line it
    prints with a dated history line above it.

### G. Commands to run

```bash
node tests/price-change-approve-2026-11.test.js
node tests/price-change-devices-2026-11.test.js
node tests/price-change-2026-11.test.js
node tests/price-logic-2026-11.test.js
node tests/price-ledger-server-2026-11.test.js
node tests/price-fixture-privacy.test.js
node tests/catalog-cost-seed.test.js
node tests/catalog-cost-privacy.test.js
node tests/catalog-price-floor-30-2026-11-17.test.js
node tests/price-book-2026-10-02.test.js        # pinned: unedited and green
node tests/dashboard-boot-budget-2026-10-03.test.js
node tests/merge-leftovers-guard-2026-10-05.test.js
node tests/inline-style-ratchet-2026-10-01.test.js
node tests/source-pin-ratchet.test.js
node scripts/build-product-seed-public.js --check
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npx firebase-tools emulators:exec --only firestore --project nbd-priceledger-test "node tests/firestore-rules.price-ledger.test.js"
node scripts/gen-function-map.js --check
node scripts/check-js-syntax.js
node scripts/check-inline-html-scripts.js
node scripts/check-vault-index.js
node scripts/run-test-manifest.js --check
node scripts/run-test-manifest.js --bucket node   # includes the rule-e estimate suites; zero diffs expected
node tests/smoke.test.js
node scripts/pr-preflight.js
```

On a Windows checkout the node bucket's 8-minute budget stops early: run the
remainder and the rule-e suites by name and let CI on Linux be the answer.

### H. PR body and after merge

21. PR body: ships dark; the only field ever written is
    `catalogCosts.costs.<id>.cost.<tier>`; no quote, sell or labor moves; the
    rule-e suites ran with zero diffs; the `recordProduct` change affects every
    cost save (flag or not) and why; Jo's answers.
22. After the deploy, Jo types his tax rate and floor if not yet set, approves
    one line on one product, opens the Product Library on a second device and
    checks the margin moved. Agents do not approve anything in production.

## Open questions for Jo

Each has a recommended answer; the checklist assumes it.

- **Q1. Where "Update my cost" lives.** Slice 3 shows alerts on screen and
  stores none. Recommended: the button sits under each fresh supplier price on
  a product's Stores & prices sheet, and on Compare suppliers alerts; the
  server rebuilds the change from the stored price when you tap Approve, so no
  alert list has to be kept in step. The other way is a stored list of pending
  changes (more parts, and it can go stale).
- **Q2. Which prices can be approved.** Recommended: only your own paperwork
  that is still fresh: a receipt or invoice paid within 60 days, a quote or
  price sheet still within its good-through date, a portal price within 7 days,
  from any supplier linked to the product (you pick). Never a manager's typed
  note, a list or promo price, or a delivered price. Only the owner and company
  admins can approve.
- **Q3. Which tier a price updates.** Each supplier item today is set for the
  Good tier only and no screen changes that. Recommended: add Good / Better /
  Best ticks to the item's link form (Good ticked by default); Update my cost
  shows one line per ticked tier, each approved on its own.
- **Q4. The floor and labor.** Recommended: use the margin floor you set for
  estimates (Company Settings, the 30% you chose) as the line, measured after
  labor from your cost book; no floor set means no floor check. A product with
  no labor in the cost book counts labor as zero and the panel says "no labor
  set".
- **Q5. Cost above the sell.** Recommended: the same as under the floor: ask
  "Approve anyway?", save it, and keep a "cost is above sell" warning on the
  product until the sell is raised. The sell is never changed for you.
- **Q6. Fix the cost save for everyone.** Today saving a product writes all
  three tier costs back, so an older phone can undo an approved cost.
  Recommended: from now on a save writes only the costs you changed in that
  save. This touches every cost save, flag on or off; what you see does not
  change.
- **Q7. Product photos.** The design puts "own photos" in slice 4. Recommended:
  move them to their own slice after this one, so slice 4 is only the cost
  change.
- **Q8. Undo.** Recommended: an **Undo** on the product's sheet for the last
  approved change per tier, while the cost book still holds that value; it
  writes the old cost back through the same checks and is logged.

## Jo's answers

Not answered yet.
