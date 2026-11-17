# Live supplier pricing: design spec

Date 2026-11-17. Repo state: `main` 46348a4. Owner decisions: Jo, 2026-11-17 (in chat).
Status: design only. Nothing in the repo was changed to write this.
Filed 2026-11-17 with the lane note [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md). Slice 0 (that note, its INDEX line and the dated update on the 10-02 plan; checklist steps 2 and 3) is done in the same PR.
Revision 2 (2026-11-17): three reviews applied. Every blocker and major finding was re-checked against the repo at 46348a4 before it was adopted. Section 11 lists what was not adopted and why; section 12 is the slice 1 checklist.

Reading rules for this document:

- Every number in an example is synthetic (multiples of 1111) and every product, SKU and supplier in an example is fictional. Keep it that way in fixtures (section 7).
- "Ledger" means the new dated price history. "Cost book" means `catalogCosts/{companyId}`. "Legacy doc" means the single document `priceBook/{companyId}`.
- A citation `file:line` was checked against the repo at 46348a4 unless marked "(recon)".

## 0. Decisions in one table

| # | Decision | Why |
|---|---|---|
| D1 | All new tenant price data lives in subcollections under `priceBook/{companyId}/…`, one document per offer / observation / alert, the meters included. The legacy doc stays untouched until slice 14. | 1 MiB limit and whole-doc rewrite race (price-book.js:97-114); one root to export and erase; new sibling rule blocks do not touch the pinned `priceBook` block. |
| D2 | Every write to the ledger goes through a Cloud Function (admin SDK). Rules grant reads only. The server, not the caller, decides a row's `kind`, `compare`, `attested` and `source` from where the row came from and who sent it (section 1.6). | Append-only history, server-stamped author and time, one validation path. A typed row is only as strong as the person who typed it, so the row records that. |
| D3 | Evidence level L1-L5 is computed at read time from stored facts (kind, dates), never stored as truth. Inside one offer the newest row wins, never the cheapest. | A paid price drops from L1 to L3 at 60 days and a quote expires; a stored level would go stale. Lowest-wins on a history hides every price increase until the old row ages out. |
| D4 | Offers and their `latest` summary: owner, company_admin, manager, sales_rep read. Raw observations, alerts, imports, config, meters: owner, company_admin, manager. Audit: owner, company_admin. Viewer and the access-code role `member`: nothing. | A rep needs a price and a store on the materials list. The paper trail (invoice numbers, account prices, quotes) is owner business. Tighter than the legacy doc, which stays as pinned. |
| D5 | Photos are copied server-side into tenant Storage (`product-photos/{companyId}/…`), re-encoded, read through the signed-in SDK as `blob:`. No CSP host is added. | The CSP set is pinned (tests/csp-hardening-2026-10-05.test.js) and has 17 variants; hotlinks break and tell the retailer who is looking. |
| D6 | Approval patches `catalogCosts.costs.<productId>.cost.<tier>` only (margin displays). Patching `xactCosts` / `jtCosts` (which re-price new quotes) is a later, separately flagged slice. | No estimate line carries a `materialId` (recon, estimate-logic-engine.js:372-406), so `costs.<id>` moves no customer total. `xactCosts` is cost-plus and does. |
| D7 | ABC API prices carry `compare:false`. They are excluded from every cross-supplier figure, from the supplier-disagree check, and from every cost-book proposal, until ABC answers in writing. The tenant's own ABC invoices and quotes stay comparable, and each offer stores a separate `bestComparable` so an API row can not push them out. | ABC API terms (research). A "was / now" against a cost that came from another supplier is a comparison too. |
| D8 | Public shelf prices may be cached cross-tenant in `retail_shelf_cache` (server-only). Account, quote, contract and paid prices never leave `priceBook/{companyId}`. | A shelf price is not tenant cost data; sharing it cuts vendor spend. The solar cache is the model for tenant-scoped data (solar-measure.js:381-385), not the parcel cache. |
| D9 | Money: integer micro-dollars per stated unit in the ledger (`priceMicros`; 1 cent = 10000) and per catalog unit (`catalogMicros`); integer cents for vendor responses and the meters; dollars as floats only at the two existing boundaries (cost book values, product sells). | Supplier documents state unit prices with three and four decimals and per hundred / per thousand, which whole cents can not hold. Micros are integers, so the CLAUDE.md invariant (no float money math) holds; ai-spend.js already uses micros. |
| D10 | Per-tenant secrets (later slices) go in Secret Manager, one secret per tenant per supplier; Firestore holds only the secret's name. A pilot credential that is one tenant's own account is bound to that tenant in two places: the server-only config doc and a server-side param. The adapter refuses unless both agree. | No per-tenant credential store exists today (recon). A hand-edited doc alone would let a copied config hand tenant two tenant one's account prices. |
| D11 | A cost-book proposal is raised only from current own-account evidence (L1, or L2 from the tenant's own account), one alert per product, proposed from one source offer. A shelf price never proposes on its own. Evidence that goes stale opens a "get a new quote" alert, never a cost change. | Review findings: per-offer alerts never settle when two suppliers price one product; a 72-hour shelf price must not outrank a paid invoice. |

## 1. Data model

### 1.1 Collections

| Path | One doc is | Writer | Client read | First slice |
|---|---|---|---|---|
| `priceBook/{companyId}` | legacy items map (unchanged) | browser (hd-import.js) | every member (pinned) | exists |
| `priceBook/{companyId}/supplierAccounts/{supplierId}` | one supplier or retailer the tenant buys from | `priceLedgerSave` | staff and sales_rep | 1 |
| `priceBook/{companyId}/priceOffers/{offerId}` | one supplier item (a SKU at a supplier), its link to a product, its unit conversion, its photo, its server-kept `latest` summary | `priceLedgerSave` (named fields only); `latest`, `nextCheckMs` by the server only | staff and sales_rep | 1 |
| `priceBook/{companyId}/priceObservations/{obsId}` | one observed price, dated and sourced. Append-only | `priceLedgerRecord`, live check, adapters | owner, company_admin, manager | 1 |
| `priceBook/{companyId}/priceAudit/{auditId}` | one applied or refused change, link, unit verification or void. Append-only | server | owner, company_admin | 1 |
| `priceBook/{companyId}/priceMeter/{meterId}` | a counter: `rows_<YYYY-MM-DD>` (rows recorded that UTC day, slice 1), `check_<YYYY-MM>` (live-check spend, slice 5) | server | owner, company_admin, manager | 1 |
| `priceBook/{companyId}/priceAlerts/{alertId}` | one open question for the owner and its decision | server | owner, company_admin, manager | 3 |
| `priceBook/{companyId}/priceImports/{batchId}` | one imported file | `priceLedgerRecord` | owner, company_admin, manager | 3 |
| `priceBook/{companyId}/priceConfig/main` | thresholds, tax rate, floor, auto-apply rule | `priceLedgerSave` | owner, company_admin, manager | 3 |
| `priceBook/{companyId}/productLinks/{productId}` | per-product extras: photo, preferred offer, last applied cost marker, estimate line codes | `priceLedgerSave`, `priceAlertDecide` | staff and sales_rep | 4 |
| `priceBook/{companyId}/priceNotices/{noticeId}` | a manufacturer increase notice the tenant logged | `priceLedgerSave` | staff and sales_rep | 8 |
| `priceBook/{companyId}/priceRollups/{YYYY-MM}` | server-kept monthly median per category, for the Trends tab | server | owner, company_admin, manager | 8 |
| `priceBook/{companyId}/leadSkus/{leadId}` | SKU, name, quantity and date bought for one lead. No price | server | staff and sales_rep | 14 |
| `integrations/pricing/companies/{companyId}` | server-only switches, caps, credential references | Jo by hand; link functions | none (default deny) | 5 |
| `price_check_global/{day_YYYY-MM-DD}` | platform-wide live-check counter | server | none | 5 |
| `retail_shelf_cache/{cacheId}` | one public shelf price, cross-tenant, with TTL | server | none | 5 |
| `price_index_ref/{seriesId}` | one BLS PPI series (public data) | `ppiSync` | any signed-in user | 8 |
| Storage `product-photos/{companyId}/{ownerId}/{sha}.webp` | one re-encoded product photo | server | staff and sales_rep | 4 |

"Staff and sales_rep" is the rule helper `plMember` (section 2.1): the owner, or a token with the tenant's `companyId` claim and role `company_admin`, `manager` or `sales_rep`.

Subcollection names carry a `price` prefix on purpose: `orders` is already read as a collection group (production.js:178-201), and a generic name such as `observations` or `alerts` invites a collision later.

The tenant is resolved on the server by section 3.1.1, never from request data and never by a bare `claims.companyId || uid`.

### 1.2 Supplier registry (public code, no prices)

`functions/price-logic.js` and its client twin export `SUPPLIERS`:

| id | label | type | sku kinds | url hosts allowed |
|---|---|---|---|---|
| `homedepot` | Home Depot | retail | store_sku, internet_sku | homedepot.com |
| `lowes` | Lowe's | retail | item_number, model | lowes.com |
| `menards` | Menards | retail | store_sku | menards.com |
| `abc` | ABC Supply | distributor | item_number | abcsupply.com |
| `srs` | SRS Distribution | distributor | item_number | roofhub.pro, srsdistribution.com |
| `qxo` | QXO (Beacon) | distributor | item_number | qxo.com |
| `gulfeagle` | Gulfeagle Supply | distributor | item_number | gulfeaglesupply.com |
| `mbs` | Modern Builders Supply | distributor | item_number | modernbuilderssupply.com |
| `other` | Other (legacy) | either | none | any https |
| `other_<slug>` | tenant-named | either | none | any https |

This is a list of integrations the product knows, not a tenant's choice. Which ones a tenant uses is `supplierAccounts`. The three hard-coded store lists (price-book.js:25, production-logic.js:183, materials-list.js:23-24) are replaced by tenant data in slice 7. The legacy id `gulfeagle` is kept; the label changes to the supplier's own spelling. `other` exists because the legacy doc has that store (price-book.js:25); new accounts use `other_<slug>` (`slug` = `[a-z0-9]{2,24}`).

### 1.3 `supplierAccounts/{supplierId}`

| Field | Type | Notes |
|---|---|---|
| `supplierId` | string | registry id, equals the doc id |
| `label` | string ≤ 60 | required for `other_*` |
| `type` | `'retail'` or `'distributor'` | from registry |
| `active` | bool | |
| `locations` | array ≤ 20 of `{ id, label, storeNumber, branchNumber, zip, preferred }` | `id` = slug, stable. Exactly one `preferred:true` when the list is not empty |
| `accountRef` | string ≤ 40 or null | last 4 characters only, for display. The full account number is in the server-only config |
| `rep` | `{ name, phone, email }` or null | each ≤ 120 |
| `terms` | `{ deliveryFeeCents, minOrderCents, quoteValidDays }` or null | integers. `quoteValidDays` (1 to 365, default 30) is how long a quote with no printed end date counts as valid (section 1.6) |
| `link` | `{ status, mode, linkedAtMs, lastOkAtMs, lastErrorCode }` | server-only (slice 11). `status`: `none`, `pending`, `linked`, `error`, `revoked`. `mode`: `none`, `own_account`, `oauth`, `integration_key` |
| `preferredFor` | array ≤ 16 of NBD_CATEGORIES keys | drives "where to buy" (slice 7) |
| `updatedAt`, `updatedBy` | timestamp, uid | |

Example (`priceBook/c_demo/supplierAccounts/other_testco`):

```json
{ "supplierId": "other_testco", "label": "Testco Supply", "type": "distributor", "active": true,
  "locations": [{ "id": "main", "label": "Testco Springfield", "storeNumber": null, "branchNumber": "000", "zip": "00000", "preferred": true }],
  "accountRef": "0000", "rep": { "name": "Pat Example", "phone": "555-0100", "email": "pat@example.com" },
  "terms": { "deliveryFeeCents": 0, "minOrderCents": 0, "quoteValidDays": 30 },
  "link": { "status": "none", "mode": "none", "linkedAtMs": null, "lastOkAtMs": null, "lastErrorCode": null },
  "preferredFor": ["roofing_shingles"] }
```

Credentials (house pattern, extended; nothing here is built before slice 5):

- Non-secret, server-only: `integrations/pricing/companies/{companyId}`, the same shape of path as `integrations/receiptInbox/companies/{companyId}` (functions/receipt-inbox.js:72). Default deny already covers it (firestore.rules:4981-4983); section 2 names it.

```json
{ "enabled": false, "paused": false,
  "retail": { "enabled": false, "vendor": "fixture", "monthlyCountCap": 300, "monthlyCapCents": 2500, "refreshOfferCap": 40 },
  "suppliers": { "abc": { "mode": "own_account", "secretRef": "ABC_API_CLIENT", "accountNumber": "0000000", "shipTo": "0000000", "branch": "000" } },
  "updatedAt": "<timestamp>" }
```

- Secrets, pilot: platform secrets through `defineSecret` (functions/integrations/_shared.js:31-84): `RETAIL_DATA_API_KEY`, `ABC_API_CLIENT_ID`, `ABC_API_CLIENT_SECRET`, later `SRS_API_CLIENT_ID`, `SRS_API_CLIENT_SECRET`.
- Own-account binding (D10). A platform secret that is really one tenant's own distributor account is bound twice: (1) that tenant's config doc names the `secretRef`; (2) a server param `<SUPPLIER>_OWN_ACCOUNT_COMPANY_ID` (for example `ABC_OWN_ACCOUNT_COMPANY_ID`, a non-secret line in `functions/.env.nobigdeal-pro`, changed only by a PR) names the one companyId allowed to use it. `adapter.configured(ctx)` returns false, with zero network calls, unless the calling `companyId` equals the param and that tenant's config names the secret. Test (slice 11): a second tenant whose config doc names the same `secretRef` gets `not_configured` and the fake fetch is never called. Enabling a tenant is a hand edit by Jo, the call-center precedent (firestore.rules:4966-4975), plus that PR.
- Secrets, per tenant (slice 12): Secret Manager secret `tenant-<sha256(companyId)[0:16]>-<supplierId>`; the config doc stores `secretName` only. Needs `@google-cloud/secret-manager` and a console grant Jo makes by hand (the deploy account can not enable APIs, firebase-deploy.yml:706-709 (recon)). No secret value is ever written to Firestore, a log or the browser.
- The unused seam `suppliers/{id}/private/{doc}` (firestore.rules:2222-2225) stays unused: `suppliers` is 1099 tracking with a closed key list.

### 1.4 `priceOffers/{offerId}`

`offerIdFor(supplierId, sku, title, purchaseUnit)`, defined on its own terms:

1. `raw = String(sku).trim()`; `clean = raw.replace(/[^A-Za-z0-9-]/g, '')`.
2. `raw` empty: `<supplierId>_x<sha1(lowercased title + '|' + purchaseUnit)[0:10]>`.
3. `clean === raw`: `<supplierId>_<clean>`.
4. Otherwise (stripping changed the SKU): `<supplierId>_<clean>-h<sha1(raw)[0:6]>`, so `12/34` and `1234` stay two offers with two histories.

`supplierId` is used as given (it may contain `_`). The raw `sku` is always stored on the doc. Relation to the legacy `keyFor` (price-book.js:28-32): for the five legacy store ids (`homedepot`, `lowes`, `menards`, `gulfeagle`, `other`) and a SKU already made of `[A-Za-z0-9-]`, `offerIdFor(store, sku) === keyFor(store, sku)`; that equality is tested for those five and claimed for nothing else. `keyFor` returns null for an empty SKU and can not produce an `other_<slug>` id; `offerIdFor` covers both.

| Field | Type | Notes |
|---|---|---|
| `v` | 1 | |
| `supplierId`, `sku` | string | `sku` ≤ 40, raw |
| `skuKind` | `store_sku`, `item_number`, `internet_sku`, `mfr_part`, `none` | |
| `altIds` | `{ upc, model, internetSku, mfrPart }` | each string ≤ 40 or null. `upc` digits only, 8 to 14 |
| `title` | string ≤ 160 | supplier text. Data, always escaped |
| `brand` | string ≤ 60 or null | |
| `url` | https string ≤ 500 or null | host must match the registry row |
| `productId` | string or null | null = not linked yet (legacy rows start here). Must match `/^[A-Za-z0-9_-]+$/` (product-library.js:248) |
| `variant` | `{ color, size, style }` | each ≤ 60 or null. One offer is one variant |
| `tiers` | subset of `['good','better','best']` | which cost tiers this exact item prices. Default `['good']` |
| `match` | `exact`, `equivalent`, `comparable` | grade of the product link, from the sweep rules |
| `pack` | object, section 5.2 | purchase unit and conversion |
| `photo` | `{ path, w, h, source, sourceUrl, addedAtMs, addedBy }` or null | slice 4. `source`: `own`, `manufacturer_program`, `retailer_ref`, `distributor_api` |
| `watch` | bool | included in the scheduled refresh (slice 6) |
| `active` | bool | soft delete |
| `latest` | object, below | server-only |
| `nextCheckMs` | int or null | server-only (slice 6). `0` when `watch` is true and the offer was never checked, the next due time after a check, `null` when not watched. A top-level field so the refresh query can order by it: an order-by on a missing or null nested field would skip never-checked offers |
| `createdAt`, `createdBy`, `updatedAt`, `updatedBy` | | |

`latest` (the cheap read), rebuilt by `summarize` and never incremented:

| Field | Type |
|---|---|
| `best` | `{ obsId, kind, priceMicros, per, statedUnit, catalogMicros, taxIncluded, locationId, observedAtMs, validThroughMs, compare, attested }` or null. The offer's current row by the per-offer ranking in section 1.6 |
| `bestComparable` | same shape, the current row among `compare:true` rows only, or null. Every cross-supplier figure, the materials list and every proposal read this one, never `best` (D7) |
| `lastPaid` | `{ obsId, priceMicros, per, statedUnit, catalogMicros, observedAtMs, locationId }` or null |
| `shelf` | newest `live_shelf` row, `{ obsId, priceMicros, statedUnit, catalogMicros, observedAtMs, locationId }`, or null. Shown as "shelf today" with its age; never ranked with paperwork (slice 5) |
| `prevBest` | `{ priceMicros, catalogMicros, observedAtMs }` or null: the row `best` replaced |
| `lastCheck` | `{ state, atMs, obsId, sourceAgeMs, availability }` or null (slice 5). `state`: `priced`, `call_branch`, `not_found`, `unavailable` |
| `recent` | array ≤ 8 of `{ ms, m, k, cmp }` (time, catalogMicros or null, kind, compare) for a sparkline. A cross-supplier chart drops `cmp:false` points |
| `count` | int, non-voided observations among the newest 200; `countCapped: true` when there are more |
| `unitState` | `ok`, `needs_unit`, `unit_changed` (section 5.2) |
| `nextReviewMs` | int or null: the earliest moment any current row changes level (every boundary in the table in section 1.6) |
| `updatedAtMs` | int |

Example (`priceBook/c_demo/priceOffers/other_testco_TEST-0001`):

```json
{ "v": 1, "supplierId": "other_testco", "sku": "TEST-0001", "skuKind": "item_number",
  "altIds": { "upc": "000000000017", "model": "TS-100", "internetSku": null, "mfrPart": null },
  "title": "Testco Example Architectural Shingle, Slate", "brand": "Testco", "url": null,
  "productId": "shingle_001", "variant": { "color": "Slate", "size": null, "style": null },
  "tiers": ["good"], "match": "exact",
  "pack": { "purchaseUnit": "BDL", "catalogUnit": "SQ", "num": 1, "den": 3, "status": "known",
            "basis": "manufacturer_spec", "verified": true, "verifiedBy": "u_owner", "verifiedAtMs": 1700000000000, "note": "3 bundles per square" },
  "photo": null, "watch": false, "active": true, "nextCheckMs": null,
  "latest": { "best": { "obsId": "o_1", "kind": "quote", "priceMicros": 11110000, "per": 1, "statedUnit": "BDL", "catalogMicros": 33330000,
                         "taxIncluded": false, "locationId": "main", "observedAtMs": 1700000000000, "validThroughMs": 1702592000000,
                         "compare": true, "attested": true },
              "bestComparable": "<same row>", "lastPaid": null, "shelf": null, "prevBest": null, "lastCheck": null,
              "recent": [{ "ms": 1700000000000, "m": 33330000, "k": "quote", "cmp": true }], "count": 1, "countCapped": false,
              "unitState": "ok", "nextReviewMs": 1702592000000, "updatedAtMs": 1700000000000 } }
```

Two server writers touch an offer document, so the rule is fixed here:

- `priceLedgerSave` ops write named field paths with `update()` (or `create()` for a new offer). They never send `latest`, `nextCheckMs`, `createdAt` or `createdBy`, and never do a whole-document `set()`.
- `recomputeLatest` is the only writer of `latest`. It runs in a transaction that reads the offer and queries that offer's newest 200 observations inside the transaction, calls `summarize`, and writes `latest` (and `nextCheckMs` when a check happened). Nothing in `latest` is an increment, so two appends that interleave both end with a summary built from a full read.

### 1.5 `productLinks/{productId}` (slice 4 and later)

Product-level data can not go on the product row: a write through `saveProduct()` marks the row user-edited forever and blocks later seed fixes (product-library.js:146-148, :184), and the seed file is public.

| Field | Type | Notes | Slice |
|---|---|---|---|
| `productId` | string | doc id | 4 |
| `preferredOfferId` | string or null | the one offer cost proposals for this product come from (section 6) | 4 |
| `applied` | `{ <tier>: { atMs, dollars, auditId, obsObservedAtMs } }` | server-only. The last approved cost per tier; what tells a device to update its local product (section 6 step 8) | 4 |
| `photo` | same shape as an offer photo, or null | | 4 |
| `lineCodes` | array ≤ 12 of `{ code, map, field, num, den, source }` | product to estimate-line mapping (section 6). `map`: `xactCosts` or `jtCosts`. `source`: `starter` or `owner` | 10 |
| `updatedAt`, `updatedBy` | | | |

There is no stored "best across suppliers". It is derived wherever it is shown, by the shared pure function `bestForProduct(offers, nowMs, taxBps)` over each linked offer's `latest.bestComparable`. One less thing to keep in step.

### 1.6 `priceObservations/{obsId}`

Append-only. A correction is a void plus a new row; `voided*` are the only fields that ever change.

| Field | Type | Set by | Notes |
|---|---|---|---|
| `v` | 1 | server | |
| `offerId` | string | caller | must exist (slice 2 adds creating a minimal unlinked offer from a stub) |
| `supplierId`, `productId`, `match` | | server | copied from the offer at write time |
| `locationId` | string or null | caller | must be a `locations[].id` of that supplier account, or null |
| `kind` | `paid`, `quote`, `contract`, `price_sheet`, `portal_read`, `manual`, `api_account`, `live_shelf` | server, from the caller's `kind` and the provenance rule below | |
| `claimedKind` | same enum or null | server | what the caller asked for, when the server downgraded it |
| `priceMicros` | int > 0, ≤ 100000000000 | caller | the price exactly as stated, in micro-dollars, for `per` of `statedUnit` |
| `per` | 1, 100 or 1000 | caller | "per each", "per C", "per M" |
| `statedUnit` | unit enum (section 5.2), or null | caller, normalised by the server | the unit the document states. Never converted. null only under the no-unit rule in section 5.3, and hashed as an empty string |
| `uomRaw` | string ≤ 20 | caller | the supplier's own unit text, verbatim |
| `qty`, `extCents` | number or null, int or null | caller | quantity and extended amount when the document gives them. When only an extension is given, `priceMicros = round(extCents * 10000 / qty)` and the row is flagged `derived_unit_price` |
| `currency` | `'USD'` | server | |
| `priceType` | `net`, `list`, `account`, `promo`; `shelf` from an adapter only | caller | |
| `taxIncluded` | bool | caller, required | no default |
| `delivered` | bool or null | caller | null = not stated |
| `pack` | `{ num, den, purchaseUnit, catalogUnit, verified }` or null | server | snapshot of the offer's conversion |
| `catalogMicros` | int or null | server | price per ONE catalog unit, computed straight from the stated price (section 5.1). null when the conversion is unknown or the unit does not fit |
| `observedOn` | `'YYYY-MM-DD'` | caller | the date printed on the document, or the day the person read the price. A calendar date, so no time zone is involved. Not after tomorrow, not before 2000-01-01. A live check uses the UTC date of the fetch |
| `observedAt` | timestamp | server | `observedOn` at 12:00 UTC; for a live check the fetch time |
| `validThroughOn`, `validThroughMs` | date or null, int or null | caller, server | the end date as printed; `validThroughMs` = the end of that date UTC plus 12 hours, so the quote is still valid on its last day in every US time zone |
| `levelAtWrite` | 1 to 5 | server | audit only. Never read to rank |
| `doc` | `{ type, ref, importId, expenseId, storagePath, leadId }` | `type`, `ref` from the caller; the rest from the server | `type`: `receipt`, `invoice`, `quote`, `price_sheet`, `contract`, `portal`, `api`, `none`. `ref` ≤ 80. There is no line number: two lines for one SKU at one price on one document are one price fact |
| `source` | `{ channel, adapter, actor: { type, uid, role, fn } }` | server | `channel`: `manual`, `hd_csv`, `supplier_csv`, `ai_read`, `legacy_pricebook`, `retail_vendor`, `abc_api`, `srs_api`, `qxo_api` |
| `attested` | bool | server | true when an owner or company_admin sent the row, or the server itself read the source (an adapter; a stored file it read in slice 9; an expense id it verified). A manager's typed or imported row is `false` |
| `compare` | bool | server | false for `abc_api` (D7), from the adapter's capability. Every caller-sent row is `true` |
| `flags` | array of `unit_suspect`, `unit_mismatch`, `stated_per_catalog_unit`, `derived_unit_price`, `tax_unknown`, `stale_source` | server | |
| `supersedes` | obsId or null | server | set on a re-recorded row whose twin was voided |
| `voided`, `voidedBy`, `voidedAtMs`, `voidReason` | | `priceLedgerSave` `voidObservation` | |
| `note` | string ≤ 200 | caller | |
| `createdAt` | server timestamp | server | |

Anything else a caller sends (`compare`, `attested`, `source`, `latest`, `levelAtWrite`, `catalogMicros`, `productId`, `supplierId`, `match`, `pack`) is ignored, with a test for each.

Provenance rule (who may create which kind):

| Origin | Kinds accepted | Result |
|---|---|---|
| `priceLedgerRecord`, typed (`channel: 'manual'`), owner or company_admin | `paid`, `quote`, `contract`, `price_sheet`, `portal_read`, `manual` | stored as typed, `attested: true` |
| `priceLedgerRecord`, typed, manager | same list | stored as `kind: 'manual'` with `claimedKind` kept, `attested: false`. It shows in the history and never ranks above paperwork. An owner or company_admin can confirm it (`confirmObservation`, slice 3), which voids it and writes its twin as the claimed kind, attested by that person |
| `priceLedgerRecord`, an import batch (slice 3) | `paid`, `quote`, `contract`, `price_sheet` | stored as the batch says; `attested` by role as above |
| any caller | `api_account`, `live_shelf` | refused (`bad_kind`). Only the server adapters write these, through `appendObservations` with `origin: 'adapter'` |

`obsId`:

- A row read from a document (channels `hd_csv`, `supplier_csv`, `ai_read`, `legacy_pricebook`): `obsIdFor(row) = sha1(offerId | kind | doc.type | doc.ref | observedOn | statedUnit | per | priceMicros)[0:28]`. An import must carry a document reference; when the document has none the import screen builds one, `<docType>-<docDateOn>-<locationId or 'all'>`, so two branches' undated price sheets do not collide and the same sheet re-issued a month later is a new row (its `observedOn` differs).
- The row is written with `create()`. If the id exists and that row is not voided, the new row is a duplicate. If the id exists and that row is voided, the new row is written as `<id>-r<n>` (the first free `n` from 1 to 9) with `supersedes` set. So a void followed by a corrected re-import lands, and a plain re-import still adds nothing. The stated unit is part of the hash, so a line re-recorded with the right unit gets a new id anyway.
- A typed entry or a live check: an auto id.
- The migration (section 1.9) and `recordHdReceipts` call the same function with the same inputs (`kind: 'paid'`, `doc.type: 'receipt'`, the receipt reference, the receipt date, the stated unit, the unit price), so a legacy row and the same purchase re-read from the Home Depot CSV are one observation.

Example:

```json
{ "v": 1, "offerId": "other_testco_TEST-0001", "supplierId": "other_testco", "productId": "shingle_001", "locationId": "main",
  "kind": "quote", "claimedKind": null, "priceMicros": 11110000, "per": 1, "statedUnit": "BDL", "uomRaw": "BD", "qty": 30, "extCents": null,
  "currency": "USD", "priceType": "account", "taxIncluded": false, "delivered": null,
  "pack": { "num": 1, "den": 3, "purchaseUnit": "BDL", "catalogUnit": "SQ", "verified": true }, "catalogMicros": 33330000,
  "observedOn": "2023-11-14", "observedAt": "<timestamp>", "validThroughOn": "2023-12-14", "validThroughMs": 1702592000000,
  "match": "exact", "levelAtWrite": 1,
  "doc": { "type": "quote", "ref": "TEST-Q-0001", "importId": null, "expenseId": null, "storagePath": null, "leadId": null },
  "source": { "channel": "manual", "adapter": null, "actor": { "type": "user", "uid": "u_owner", "role": "owner", "fn": "priceLedgerRecord" } },
  "attested": true, "compare": true, "flags": [], "supersedes": null, "voided": false, "note": "" }
```

Evidence level (pure function `evidenceLevel(obs, nowMs, quoteValidDays)`, mapping the agreed ladder at SUPPLIER-PRICING-SWEEP-2026-11-09.md:44-49 onto the kinds; `quoteValidDays` comes from the supplier account, default 30):

| Level | Rule | Boundary that feeds `nextReviewMs` |
|---|---|---|
| L1 | `paid` and age ≤ 60 days; `quote` / `price_sheet` / `contract` with `validThroughMs` ≥ now; the same three with no end date and age ≤ `quoteValidDays` | `observedAt` + 60 days; `validThroughMs`; `observedAt` + `quoteValidDays` |
| L2 | `portal_read` or `api_account`, age ≤ 7 days (the tenant's own account price, read by a person or by an API) | `observedAt` + 7 days |
| L3 | `paid` and age > 60 days | none |
| L4 | `quote` / `price_sheet` / `contract` past its end date, or undated and older than `quoteValidDays` | none |
| L5 | `manual`; `portal_read` or `api_account` older than 7 days; `live_shelf` at any age (the ladder's "public web price") | for `live_shelf`, `observedAt` + 72 hours, when the "shelf today" figure stops being shown as current |

Every kind and age has exactly one level; a test walks each boundary one millisecond either side.

Ranking is two separate steps.

Step A, inside one offer (`currentRows`, `bestForOffer`). Voided rows and rows with `catalogMicros == null` never rank.

1. Keep only the newest row (by `observedAt`, then `createdAt`) for each (`kind`, `locationId`) pair. An older row of the same kind at the same branch is history, whatever its price.
2. Pass 1 admits the tenant's own paperwork and account prices, by kind: `paid`, `quote`, `contract`, `price_sheet`, `portal_read`, `api_account`. `live_shelf` and `manual` are never in pass 1, at any age. Pass 2 runs only when pass 1 is empty and admits everything.
3. Inside a pass: lower level first, then the newer `observedAt`. Price is never a tie-break inside an offer.

So "paid 59 days ago, low" against "paid yesterday, high" gives yesterday's row; a newer quote from the same supplier replaces the older still-valid one; a two-day-old shelf price never outranks a 61-day-old paid receipt. `bestComparable` is the same procedure over `compare:true` rows.

Step B, across the offers linked to one product (`bestForProduct`): take each offer's `bestComparable`, drop rows whose tax basis is unknown (section 5.3), then order by level, then match grade (exact, equivalent, comparable), then lowest tax-free `catalogMicros`. This is the only place "lowest wins", which is how the sweep used it (one snapshot across suppliers). `disagree(offers)` uses the same input set, so an ABC API row can never open `supplier_disagree`.

### 1.7 `priceAlerts/{alertId}` (slice 3)

`alertId`:

- `price_change_<productId>`: one open alert per product, because the thing that changes is one cost-book field per product and tier. Two suppliers' offers for one product never raise two competing alerts.
- Every other type: `<type>_<offerId>`.

A newer finding rewrites the open alert and logs the old one in `priceAudit` as `alert_superseded`.

| Field | Type |
|---|---|
| `type` | `price_change`, `requote` (current evidence went stale), `quote_expiring`, `quote_expired`, `needs_unit`, `unit_changed`, `unit_suspect`, `supplier_disagree`, `shelf_moved`, `cost_above_sell`, `below_floor`, `not_found` |
| `state` | `open`, `approved`, `partly_approved`, `dismissed`, `snoozed`, `superseded` |
| `productId`, `offerId`, `supplierId` | for `price_change`, `offerId` is the source offer |
| `obsId` | the observation the proposal is built from |
| `title` | string ≤ 160, built by the server from escaped fields |
| `lines` | array ≤ 3, one per tier of the source offer (below). Empty for types that propose nothing |
| `context` | array ≤ 6 of `{ offerId, supplierId, catalogMicros, kind, observedAtMs }`: the other offers' `bestComparable` rows, for the person to see. Never a proposal, never an ABC API row |
| `dueMs` | int or null (quote expiry) |
| `snoozeUntilMs` | int or null |
| `decision` | `{ by, atMs, note, auditId }` or null |
| `createdAtMs`, `updatedAtMs` | |

A line (a proposed cost-book change, approved one at a time):

```json
{ "key": "costs.shingle_001.cost.good", "map": "costs", "id": "shingle_001", "tier": "good",
  "fromMicros": 22220000, "exTaxMicros": 33330000, "taxBps": 0, "toMicros": 33330000, "deltaBps": 5000,
  "state": "open", "blocked": null,
  "guard": { "sellOk": true, "floorOk": false, "floorBps": 2222, "marginBps": 1111 },
  "appliedAtMs": null, "appliedBy": null }
```

`toMicros` is always a whole number of cents (section 5.1), so what the alert shows is exactly what would be written. `blocked` is null or one of `needs_tax_rate`, `below_one_cent`, `unit_changed`, `no_cost_book`; a blocked line is shown and can not be approved.

### 1.8 `priceImports/{batchId}`, `priceAudit/{auditId}`, `priceConfig/main`

`batchIdFor = sha256(file bytes | supplierId | docType | JSON of the column mapping)[0:28]` (slice 3). The import doc is written first with `state: 'running'` and finished with `state: 'done'` and the counts. Sending the same batch again resumes it: rows that already exist are counted as duplicates, missing rows are written, the counts are rewritten. A file imported with the wrong column mapping or the wrong supplier has a different `batchId` when it is imported again with the right one; a batch whose rows were all voided can be sent again and its rows land as `-r<n>` revisions.

```json
{ "state": "done", "supplierId": "other_testco", "locationId": "main", "docType": "quote", "docRef": "TEST-Q-0001", "docDateOn": "2023-11-14",
  "validThroughOn": "2023-12-14", "fileName": "quote.csv", "fileHash": "<sha256>", "storagePath": null,
  "rows": 40, "written": 36, "duplicates": 0, "rejected": 4, "unlinked": 12, "needsUnit": 3,
  "preset": "generic_csv", "createdAtMs": 1700000000000, "createdBy": "u_owner" }
```

`priceAudit` row (slice 4 shape; slice 1 writes only `offer_linked`, `conversion_verified`, `observation_voided`):

```json
{ "type": "cost_change_applied", "actor": { "type": "user", "uid": "u_owner", "role": "owner" }, "atMs": 1700000000000,
  "alertId": "price_change_shingle_001", "obsIds": ["o_1"],
  "patch": [{ "path": "costs.shingle_001.cost.good", "fromDollars": 22.22, "toDollars": 33.33, "created": false }],
  "guard": { "sellOk": true, "floorOk": true, "floorBps": 2222, "confirmAboveSell": false, "confirmBelowFloor": false },
  "rule": null, "note": "" }
```

Types: `cost_change_applied`, `cost_change_refused`, `alert_dismissed`, `alert_superseded`, `offer_linked`, `conversion_verified`, `observation_voided`, `observation_confirmed`, `auto_rule_changed`, `auto_applied`. The top-level `audit_log` is platform-admin read only (firestore.rules:4420-4423), so the owner's trail has to be tenant-scoped.

`priceConfig/main` (slice 3):

```json
{ "alertThresholdBps": 222, "floorBps": null, "purchaseTaxBps": null, "quoteWarnDays": 7,
  "autoApply": { "enabled": false, "capBps": 0 },
  "updatedAtMs": 0, "updatedBy": null }
```

- `purchaseTaxBps: null` means "not chosen yet". No line can be approved until the owner chooses a value; `0` is a real choice and means "my cost book is before tax" (section 5.3).
- `floorBps: null` means no floor is set. NBD's floor is NBD's value: it is written to NBD's doc at pilot enablement, never a code default (CLAUDE.md: read tenant values).
- The shipped default for `alertThresholdBps` is 200; the example above shows a synthetic value.

### 1.9 The legacy doc: keep, dual-write, migrate, retire

| Step | Slice | What |
|---|---|---|
| Keep | 1 | `priceBook/{companyId}` and price-book.js are not edited. Every pinned test stays green |
| Dual-write | 2 | hd-import.js `doImport` keeps the pinned call `NBDPriceBook.record(…purchasesFromHdReceipts(saved))` (tests/price-book-2026-10-02.test.js:85-87) and adds, after it, a best-effort `NBDPriceLedger.recordHdReceipts(saved)` that carries the store number the legacy path drops |
| Migrate | 2 | `scripts/migrate-price-book-v2.js --company <id>`: dry run by default, writes a `.local/` backup. Offer id = `offerIdFor(item.store, item.sku)` from the raw `sku` the legacy item stores (equal to the legacy map key for a clean SKU). Observation id = `obsIdFor` with `kind: 'paid'`, `doc.type: 'receipt'`, `doc.ref` = the history row's `ref` or `''`, `observedOn` = its `date`, `statedUnit: null`, `priceMicros = cents * 10000`. A re-run adds nothing. Each legacy item becomes an unlinked offer with pack unknown; each history row a `paid` observation with `source.channel: 'legacy_pricebook'`, `locationId: null`, `attested: false`. Legacy `other` items stay under supplier `other`. `--apply` needs Jo's OK for that run (CLAUDE.md rule f) |
| Dual-read | 2 to 13 | New screens read the ledger. The old "Price book" modal and `hdSkusForLead` (production.js:212-227) keep reading the legacy doc |
| Retire | 14 | Stop the legacy write. `hdSkusForLead` today gives every member, a sales_rep included, the SKUs bought for a lead and never a price; observations are staff-only, so it can not read them. Instead the server keeps `priceBook/{companyId}/leadSkus/{leadId}` = `{ items: [{ supplierId, sku, title, qty, on }] }` (≤ 200 items, no price), filled by `appendObservations` from rows that carry `doc.leadId` and back-filled by a script. Delete price-book.js and the `priceBook/{companyId}` single-doc rule only after a prod check that the ledger holds every legacy row |

The Home Depot CSV states a unit price per item with no unit column. Both the legacy migration and `recordHdReceipts` pass `statedUnit: null`, so their ids match and the twin rule holds; the no-unit rule in section 5.3 decides when such a row gets a per-catalog-unit price, and the offer's pack stays `unknown` until a person sets it.

Pinned tests that move in slice 14, each in that PR: tests/price-book-2026-10-02.test.js (A merge rules become ledger-logic tests; C import wiring; D rule-text equality is deleted with the block; E viewer); tests/production-flow-2026-10-04.test.js:340-356; tests/firestore-rules.test.js section 44 (:3158-3186); tests/firestore-rules.cross-tenant.test.js:984, :1014; tests/merge-leftovers-guard-2026-10-05.test.js:125; the suite's row in tests/source-pin-baseline.json (dropped with `node tests/source-pin-ratchet.test.js --lower`).

### 1.10 Size, read cost, offline, indexes

- Size: an offer is about 1.5 KB, an observation about 0.7 KB. No document grows with history (`recent` is capped at 8).
- Reads: the Stores sheet reads the offers of one product (`where productId == x`, equality only) and, for staff, the newest 50 observations of one offer. The materials list reads offers with `productId in [...]` in chunks of 30. The Trends tab reads `priceRollups` (12 small docs), never raw observations. No screen reads the whole ledger. If a tenant passes about 1500 offers, add a server-kept index doc per 2000 offers; not built now.
- Offline: Firestore persistence is on (nbd-auth.js:341-343), so offers already read are available offline with their dates. Writes need a connection by design (D2); the entry form says so and keeps what was typed.
- Indexes (firestore.indexes.json), each landing with the slice whose query needs it. scripts/check-firestore-indexes.js:23-27 says a composite is needed only when a query combines more than one field and one is an order-by, inequality or array-contains; an equality-only query needs none.

| Slice | Entry | Query |
|---|---|---|
| 1 | composite, collection scope: `priceObservations` (`offerId` ASC, `observedAt` DESC) | history, and `recomputeLatest` |
| 3 | `fieldOverrides`: `priceOffers`, field `latest.nextReviewMs`, COLLECTION_GROUP scope ascending (a single-field collection-group index is a field override, not a composite; the file's section starts at :1307) | daily watch |
| 3 | composite, collection scope: `priceAlerts` (`state` ASC, `updatedAtMs` DESC) | alerts inbox |
| 5 | `fieldOverrides` TTL: `retail_shelf_cache.expireAt`, `indexes: []` (the pattern at :1378-1402) | none |
| 6 | composite, COLLECTION_GROUP scope: `priceOffers` (`watch` ASC, `nextCheckMs` ASC) | weekly refresh. Test: a watched, never-checked offer (`nextCheckMs: 0`) is in the first page |

### 1.11 Shared versus tenant-private

| Data | Home | Why |
|---|---|---|
| Public shelf price at a store (anonymous, no login) | `retail_shelf_cache/{sha1(vendor|supplierId|storeId|sku)}` = `{ supplierId, storeId, sku, priceCents, uomRaw, title, url, imageUrl, fetchedAtMs, vendor, expireAt }` | Not a tenant's cost. One lookup can serve two tenants at one store. The cache write refuses any `priceType` other than `shelf` |
| The same price as a tenant saw it | a `live_shelf` observation copied into the tenant's ledger | The tenant's history must not depend on a cache that expires |
| Account price, quote, contract, price sheet, invoice, receipt | `priceBook/{companyId}/…` only | Cost data. Never pooled, never keyed without the tenant |
| BLS PPI series | `price_index_ref` | Public statistics |

During the pilot one tenant is enabled, so the cache is single-tenant in practice. Before a second tenant is enabled, re-read the chosen vendor's terms on serving more than one end user (section 10).

## 2. Security rules

### 2.1 Blocks to add (firestore.rules, directly after the `priceBook` block at :3024-3029)

```
    // ── PRICE LEDGER (2026-11, flag supplierPricing) ───────────────────
    // Dated, sourced price history under priceBook/{companyId}/…. Every write
    // is a Cloud Function (admin SDK). A browser only reads.
    // Offers (and their latest summary): the owner, company_admin, manager,
    // sales_rep. Observations, alerts, imports, config, meters: owner /
    // company_admin / manager. Audit: owner / company_admin. A viewer, the
    // access-code role `member`, a token with no role, another tenant: nothing.
    // The claim branch is an ALLOWLIST of roles, read with .get('role','') so
    // a role-less token is a clean deny, not an evaluation error.
    function plRole() { return request.auth.token.get('role', ''); }
    function plClaim(companyId) { return request.auth.token.get('companyId', '') == companyId; }
    function plMember(companyId) {
      return isAuth() && notViewer()
        && (ownsTenantByUid(companyId)
            || (plClaim(companyId) && plRole() in ['company_admin', 'manager', 'sales_rep']));
    }
    function plStaff(companyId) {
      return isAuth() && notViewer()
        && (ownsTenantByUid(companyId)
            || (plClaim(companyId) && plRole() in ['company_admin', 'manager']));
    }
    function plAdmin(companyId) {
      return isAuth() && notViewer()
        && (ownsTenantByUid(companyId)
            || (plClaim(companyId) && plRole() == 'company_admin'));
    }
    // slice 1
    match /priceBook/{companyId}/supplierAccounts/{supplierId} { allow read: if plMember(companyId); allow write: if false; }
    match /priceBook/{companyId}/priceOffers/{offerId}         { allow read: if plMember(companyId); allow write: if false; }
    match /priceBook/{companyId}/priceObservations/{obsId}     { allow read: if plStaff(companyId);  allow write: if false; }
    match /priceBook/{companyId}/priceMeter/{meterId}          { allow read: if plStaff(companyId);  allow write: if false; }
    match /priceBook/{companyId}/priceAudit/{auditId}          { allow read: if plAdmin(companyId);  allow write: if false; }
    // slice 3
    match /priceBook/{companyId}/priceAlerts/{alertId}         { allow read: if plStaff(companyId);  allow write: if false; }
    match /priceBook/{companyId}/priceImports/{batchId}        { allow read: if plStaff(companyId);  allow write: if false; }
    match /priceBook/{companyId}/priceConfig/{docId}           { allow read: if plStaff(companyId);  allow write: if false; }
    // slice 4
    match /priceBook/{companyId}/productLinks/{productId}      { allow read: if plMember(companyId); allow write: if false; }
    // slice 5 (server-only; the default deny already covers them, named so the intent is on the page)
    match /retail_shelf_cache/{cacheId}                        { allow read, write: if false; }
    match /price_check_global/{dayId}                          { allow read, write: if false; }
    match /integrations/pricing/companies/{companyId}          { allow read, write: if false; }
    // slice 8
    match /priceBook/{companyId}/priceNotices/{noticeId}       { allow read: if plMember(companyId); allow write: if false; }
    match /priceBook/{companyId}/priceRollups/{monthId}        { allow read: if plStaff(companyId);  allow write: if false; }
    match /price_index_ref/{seriesId}                          { allow read: if isAuth();            allow write: if false; }
    // slice 14
    match /priceBook/{companyId}/leadSkus/{leadId}             { allow read: if plMember(companyId); allow write: if false; }
```

(In the file each block is written on separate lines in the house style; they are folded here to keep the table readable.)

A block lands with the slice that first writes its collection, and that slice's PR adds the block's emulator cases. Slice 1 adds the helpers and the five blocks marked slice 1, which are exactly the collections slice 1 writes. Until its slice, a path falls to the default deny (firestore.rules:4980-4983), and the suite asserts that (section 2.4, case 10).

The meters sit inside the tenant tree, so `allow read` needs no `resource.data` lookup (a `get` on a month with no doc is a clean "not found" for staff, not a permission error) and erasure is one recursive delete.

Shape validation: none in rules, because no client writes. It lives in the pure sanitizers (`sanitizeOffer`, `sanitizeObservation`, section 3.4), which is where the tests are.

### 2.2 Pinned rule text

- tests/price-book-2026-10-02.test.js:96-100 captures `match /priceBook/{companyId} {` up to the first line that is exactly four spaces and `}`, and requires it to equal the `catalogCosts` body. The new blocks start `match /priceBook/{companyId}/…`, which that regex does not match, and they are siblings, not nested, so the captured body is unchanged. Do not nest them inside the `priceBook` block: a nested block would be captured and break the pin.
- `catalogCosts` (:3005-3011) and `productLibrary` (:3292-3297) are not edited. The server becomes a writer of `catalogCosts` in slice 4 through the admin SDK; it re-implements the role split with `requireTeamAdmin` (functions/handlers/_shared.js:268-327).
- Deliberate re-pin: none before slice 14.

### 2.3 Roles (decided)

| Caller | Legacy doc | Offers + latest price | Observations, alerts, imports, config, meters | Audit | Writes (through callables only) |
|---|---|---|---|---|---|
| owner: no role claim, uid is the company id, and no company doc names someone else | read, write | read | read | read | everything |
| owner after a hand-off, or any `company_admin` with the companyId claim | read, write | read | read | read | everything |
| `manager` with the companyId claim | read | read | read | no | record observations only (stored as `manual` when typed, section 1.6) |
| `sales_rep` with the companyId claim | read | read | no | no | none |
| `viewer` | read (pinned, unchanged) | no | no | no | none |
| `member` (the access-code role, functions/handlers/_shared.js:220) | per the legacy rule | no | no | no | none |
| a token with the companyId claim and no role, or an unknown role | per the legacy rule | no | no | no | none |
| platform `admin` | per the legacy rule | own tenant only, as an owner would | own tenant only | own tenant only | own tenant only. The callables take no target company |
| removed former owner (claims stripped, company doc names a new owner) | no | no | no | no | none (the ghost guard, section 3.1.1) |
| other tenant, anonymous provider | no | no | no | no | none |

The viewer line is tighter than today's price book on purpose. A viewer already reads `catalogCosts`; that is a separate decision and is not reopened here.

### 2.4 Emulator suite

`tests/firestore-rules.price-ledger.test.js` (bucket `wired-individually`, its own step in .github/workflows/ci.yml copied from :717-721, project id `nbd-priceledger-test`). Docs are seeded with the admin context. Each case names the slice that adds it; a case for a later slice's collection is added in that slice's PR.

| # | Case | Slice |
|---|---|---|
| 1 | Owner (uid-keyed), company_admin, manager, sales_rep read an offer and a supplier account. Viewer, `member`, a role-less token with the claim, and another company are denied | 1 |
| 2 | Owner, company_admin, manager read an observation and a meter doc; reading a meter doc that does not exist is not a permission error for them. sales_rep, viewer, `member` are denied | 1 |
| 2b | The same for an alert, an import and config | 3 |
| 3 | Only owner and company_admin read audit | 1 |
| 4 | Every role, the platform admin included, is denied create, update and delete on every path that exists in that slice | 1, extended each slice |
| 5 | Hand-off, three shapes, as tests/firestore-rules.cross-tenant.test.js:1004-1006 models them: a removed former owner (no claims) reads nothing; a former owner demoted to sales_rep reads offers only; a former owner kept as company_admin reads as any company_admin. The new owner (company_admin claim, different uid) reads everything | 1 |
| 6 | An anonymous-provider token reads nothing | 1 |
| 7 | `retail_shelf_cache`, `price_check_global`, `integrations/pricing/companies/{id}`: every client denied, read and write | 1 (default deny), 5 (named blocks) |
| 8 | The legacy `priceBook/{companyId}` doc still behaves as section 44 of tests/firestore-rules.test.js says (one assertion each way, so a rules typo that leaks into the legacy block is caught here too) | 1 |
| 9 | A collection-group read of `priceObservations` by a client is denied | 1 |
| 10 | Paths not added yet (`priceAlerts`, `priceImports`, `priceConfig`, `productLinks`, `priceNotices`, `priceRollups`, `leadSkus`) are denied to everyone, the owner included. Each line is deleted by the slice that adds the block | 1 |

Storage: `tests/storage-rules.product-photos.test.js` (slice 4), modelled on storage-rules.sub-papers.test.js, with the hand-off case (section 4.5).

## 3. Server

### 3.1 Functions

All `us-central1`, `cors: CORS_ORIGINS`, `enforceAppCheck: true`, wrapped in `withSentry` and in `require('./tenant-guard').wrapCallable` (the pattern at functions/opp-decide.js:214-215).

| Name | Type | Slice | Who | Input | Output | Limits |
|---|---|---|---|---|---|---|
| `priceLedgerSave` | onCall | 1 | owner, company_admin | `{ op, data }`. Slice 1 ops: `upsertSupplierAccount`, `upsertOffer`, `linkOffer`, `verifyPack`, `archiveOffer`, `voidObservation`. Later: `setConfig`, `confirmObservation` (3), `setProductLink` (4), `saveNotice` (8) | `{ ok, id }` | 60 per minute per uid |
| `priceLedgerRecord` | onCall | 1 | owner, company_admin, manager | `{ rows: [row] (1..500) }`; from slice 3 also `batch: import header` | `{ results: [{ i, status, obsId?, reason? }], written, duplicates, rejected, needsUnit, alertsOpened }` (`alertsOpened` is always 0 before slice 3) | 20 per minute per uid; 500 rows per call; 5000 rows per company per UTC day |
| `priceAlertDecide` | onCall | 4 | owner, company_admin | `{ alertId, action: 'approve' or 'dismiss' or 'snooze', lineKeys: [..], expect: { key: fromMicros }, confirmBelowFloor, confirmAboveSell, note, snoozeDays }` | `{ ok, applied: [{ key, dollars }], refused: [{ key, reason }], auditId }` | 30 per minute |
| `productPhotoSave` | onCall | 4 | owner, company_admin | `{ target: 'offer' or 'product', id, dataUrl }` (≤ 3 MB, as uploadCompanyLogo, functions/tenant-ops.js) | `{ ok, path, w, h }` | 20 per hour |
| `priceCheckNow` | onCall | 5 | owner, company_admin, manager | `{ offerIds: [1..10], locationId?, force? }` | `{ results: [{ offerId, state, priceCents, statedUnit, fetchedAtMs, sourceAgeMs, cached, availability, url }], skipped?, dryRun?, spentCents, capCents }` | 10 per minute per uid; monthly count and cents caps per company; global daily cap |
| `priceRefreshCron` | onSchedule | 6 | server | none | log only | weekly per offer, `refreshOfferCap` per company, `maxInstances: 1`, no retry |
| `priceLedgerDailyWatch` | onSchedule | 3 | server | none | log only | no vendor call. Re-ranks offers whose `latest.nextReviewMs` passed; opens `quote_expiring`, `quote_expired`, `requote` |
| `supplierDocRead` | onCall | 9 | owner, company_admin, manager | `{ storagePath }` under the caller's own `receipts/{uid}/inbox/` | draft rows for the import screen | the receipt-inbox gates and meter |
| `ppiSync` | onSchedule | 8 | server | none | log only | one BLS request a day |
| `supplierLinkStart`, `supplierLinkFinish` | onCall, onRequest | 12 | owner | OAuth authorization code with PKCE | link status | later |

#### 3.1.1 Who is calling, and for which tenant

One helper, `priceCaller(request, need)` in `functions/price-ledger.js` (exported as a test seam, not re-exported from index.js). Every new callable uses it, in this order. No step is skipped and no callable computes `claims.companyId || uid` itself.

| # | Step | Refusal |
|---|---|---|
| 1 | Signed in | `unauthenticated` |
| 2 | `assertNotGhost(request)` (functions/tenant-guard.js; applied by `wrapCallable` on the export). A token with no companyId claim whose uid names a company that now belongs to someone else is a former owner, not a solo owner | `permission-denied`, zero writes |
| 3 | `assertNotViewer(request.auth.token)` | `permission-denied`, zero writes |
| 4 | `callableRateLimit(request, name, n, 60000)` | `resource-exhausted` |
| 5 | A subordinate role (`member`, `manager`, `sales_rep`, `viewer`) with no companyId claim is an access-code or invited user, never an owner (the check at functions/handlers/_shared.js:286) | `permission-denied` |
| 6 | `need: 'admin'` (Save, Decide, PhotoSave): `requireTeamAdmin(request)` with no target company. It returns the companyId, refuses managers, and checks the Auth account is enabled | `permission-denied` |
| 6 | `need: 'staff'` (Record, CheckNow, DocRead): allow when `claims.role === 'manager'` and `claims.companyId` is set (companyId = that claim), then `assertCallerAccountEnabled(uid)`; otherwise fall through to `requireTeamAdmin(request)`. `member`, `sales_rep`, `viewer` are refused. There is no house helper for "owner, company_admin or manager" today (requireTeamAdmin refuses managers), so this is new code with its own tests | `permission-denied` |
| 7 | The flag: read `feature_flags/_default` and `feature_flags/{uid}` (as functions/opp-access.js:62-63); `price-logic.js` exports its own `flagOn(flagsDefault, flagsMine)` with the semantics of opp-rules.js:29-32 (only the boolean `true` turns it on). A failed read refuses | `failed-precondition` ("not switched on for this account"), or `unavailable` on a read error |

It returns `{ uid, companyId, role }`, where `role` is `owner`, `company_admin`, `manager` or `admin`. The platform admin acts on their own tenant only; no callable accepts a company id in its data.

Slice 1 has no kill switch and no entitlement gate: typing your own prices spends nothing on a vendor, and the flag (per person, set by a platform admin, firestore.rules:4623-4626) is the allowlist. The live check (slice 5) adds the kill switch, the entitlement and the cap reservation after step 7, in the receipt-inbox order (functions/receipt-inbox.js:91-129).

The flag is per person. Each owner, company_admin or manager who should use the screens or record prices needs `feature_flags/{their uid}.supplierPricing = true`.

#### 3.1.2 The write path (`appendObservations`)

`functions/price-ledger-store.js` is the only file that touches Firestore for the ledger. Every writer (the callable, the live check, the crons, the adapters, the migration script) calls `appendObservations(db, companyId, rows, ctx)`, where `ctx = { origin: 'callable' | 'adapter' | 'migration', actor, adapter?, batch?, nowMs }`.

Input row from a caller (everything else is ignored, section 1.6):

| Field | Type | Required |
|---|---|---|
| `offerId` | string | yes |
| `kind` | one of the six caller kinds | yes |
| `priceMicros` | int | yes |
| `per` | 1, 100, 1000 | default 1 |
| `statedUnit`, `uomRaw` | strings | `statedUnit` or `uomRaw` required (the null-unit rule in section 5.3 is for server-read retail rows only) |
| `qty`, `extCents` | number, int | no |
| `priceType` | `net`, `list`, `account`, `promo` | yes |
| `taxIncluded` | bool | yes |
| `delivered` | bool or null | no |
| `locationId` | string or null | no |
| `observedOn` | `YYYY-MM-DD` | yes |
| `validThroughOn` | `YYYY-MM-DD` or null | no |
| `doc` | `{ type, ref }` | no |
| `note` | string | no |

Algorithm:

1. Count: in one transaction on `priceMeter/rows_<UTC day>`, refuse the whole call (`resource-exhausted`) when `rows + n > 5000`, else add `n`. The count is not given back for duplicates or rejects.
2. Sanitize each row with `sanitizeObservation(row, ctx)`. A bad row is `rejected` with a reason and does not stop the others.
3. Load the offers the rows name with `getAll`, in chunks of 100. A row whose offer does not exist is `rejected: 'unknown_offer'` (slice 2 adds: when the row carries an `offer: { supplierId, sku, title }` stub, create a minimal unlinked offer with pack unknown).
4. Derive the server fields per row: kind by the provenance rule, `attested`, `compare`, pack snapshot, `catalogMicros`, `observedAt`, `validThroughMs`, `levelAtWrite`, flags (`suspectUnitSwap` against the offer's `latest.best`), id.
5. Write the observations one document each with `create()`, through a `BulkWriter` whose error handler does not retry `ALREADY_EXISTS`. For an id that exists: read it; not voided means `duplicate`; voided means write the `-r<n>` revision. One duplicate never fails another row. From slice 3 the import doc is written first (`state: 'running'`).
6. For each offer that got at least one new row: `recomputeLatest(db, companyId, offerId, nowMs)`, one transaction per offer (section 1.4), at most 10 running at once.
7. From slice 3: `detectChange` for each product whose offers were touched, and the import doc is finished (`state: 'done'`).
8. Return one result per input row, in order.

The call is not atomic across rows, by design: 500 rows, their offers and the summaries do not fit one transaction. What makes that safe: every step is idempotent. A retry of the same rows finds the written ones as duplicates, writes the missing ones, and recomputes the summaries from a full read. A crash between step 5 and step 6 leaves a stale `latest`, which the next append to that offer, or the daily watch (slice 3), repairs.

Tests (slice 1, with a fake Firestore): two interleaved appends on one offer end with `latest` built from both rows; a batch with one existing row writes the rest; a retry of a half-written call writes only the missing rows; void then re-record gives `-r1`.

Flags (all off by default):

| Flag | System | Registered in | Gates |
|---|---|---|---|
| `supplierPricing` | Firestore client flag (`feature_flags/_default` + `feature_flags/{uid}`) | `FIRESTORE_FLAGS` in functions/flags-registry.js:281-286, `file: 'price-logic.js'`; client `NBDFlags.enabled('supplierPricing')` | The screens, and server-side every ledger callable (step 7 above) |
| `PRICE_LEDGER_WATCH_ENABLED` | env, polarity `enabled` | functions/cron-gates.js and functions/flags-registry.js | `priceLedgerDailyWatch` writes; off = counts logged, nothing written |
| `RETAIL_PRICE_CHECK_ENABLED` | env | same two | `priceCheckNow` real vendor calls; off = dry run `{ skipped, dryRun }` |
| `PRICE_REFRESH_ENABLED` | env | same two | `priceRefreshCron` |
| `PPI_SYNC_ENABLED` | env | same two | `ppiSync` |
| `SUPPLIER_DOC_READER_ENABLED` | env | same two | `supplierDocRead` |
| `priceCheckDisabled`, `priceCheckDailyCap` | `feature_flags/global` kill switch and number | functions/integrations/killswitch.js (:82-119 pattern) | stops live checks without a deploy |
| `integrations/pricing/companies/{id}.enabled`, `.retail.enabled`, `.paused` | per tenant, server-only | hand edit by Jo | the pilot allowlist for vendor calls. The client flag only shows a screen; it is never the gate for spend (functions/receipt-inbox.js:120-122) |

Registration checklist for every new function (each is a CI gate):

| Where | What | Gate |
|---|---|---|
| `functions/price-ledger.js` (and later `functions/price-check.js`, `functions/price-crons.js`) | a literal `exports.name = onCall(` in `functions/*.js` | deploy grep and tests/functions-lazy-load-2026-10-04.test.js:127-139 |
| functions/index.js | by-name re-export (the modules also export test seams; index.js:1166-1169 is the model) | same |
| functions/FUNCTIONS_INDEX.md | a row. `priceLedgerSave`, `priceLedgerRecord`, `priceAlertDecide`, `productPhotoSave` under `## ADMIN (role check required)` with the role gate named; the crons under `## SCHEDULED CRONS` | tests/smoke/dashboard.test.js:860-988 |
| functions/function-map.json | `node scripts/gen-function-map.js`, then `--check` | lazy-load suite :99-108 |
| tests/viewer-callables.test.js | a `VERDICTS` entry (`refused` for all of these) and a handler row like :392 | :709-746 |
| crons only | `require('./integrations/heartbeat').onSchedule`; a `PLAN` row in functions/integrations/heartbeat-plan.js joining the shared check `daily-syncs` (no new check: 20 is the cap, :33); the runbook table in documentation/runbooks/HEALTHCHECKS-SETUP.md | tests/cron-heartbeat.test.js |
| env flags | cron-gates.js row with the exact file name; flags-registry.js row with `group`, `meaning`, `doc`, `dark: true`; the two count pins (tests/cron-gate-drift.test.js:93 is 48 today, tests/flags-registry-drift.test.js:96 is 56 today) | both drift suites |
| Firestore flag | `FIRESTORE_FLAGS` row; edit the exact-list assertion (tests/flags-registry-drift.test.js:103) and add a "code agrees" assertion for `price-logic.js` beside the one at :107-108 | same suite |
| secrets | `defineSecret` in functions/integrations/_shared.js `SECRETS`; never a `.value() ||` fallback | tests/secret-stub-guard.test.js |
| tests | each new `tests/*.test.js` in tests/ci-manifest.json through `node scripts/index-anchor.js manifest --test <file> --bucket node` or `--bucket wired-individually`. The tool only places into array buckets: `smoke` is an object whose values are mandatory documentation lines (scripts/run-test-manifest.js:552), so no new suite here goes in `smoke`. Then `FLOORS` (section 8.0) | `node scripts/run-test-manifest.js --check` |
| after the first deploy | `gcloud functions describe` for each new name | a new function can be dropped on its first deploy (firebase-deploy.yml:1167-1184 (recon)) |

### 3.2 Spend caps and rate limits (live checks)

| Guard | Default | Where |
|---|---|---|
| Per uid | 10 calls per minute, 10 offers per call | `callableRateLimit` |
| Per company per month | 300 lookups and 2500 cents | `priceBook/{companyId}/priceMeter/check_<YYYY-MM>` = `{ count, cents, updatedAt }` (inside the tenant tree, D1), reserved in a transaction before the vendor call, settled after, released when the vendor refused (functions/receipt-inbox.js:193-210) |
| Global per day | `priceCheckDailyCap` (default 1000) | counter doc `price_check_global/day_<YYYY-MM-DD>` (its own server-only collection) |
| Scheduled refresh | 40 watched offers per company, each at most once in 7 days | config doc |
| Cache before spend | shelf: 6 hours on demand, 7 days for the refresh. Account API: skip when the offer's last `api_account` observation is under 4 hours old, unless `force` | `retail_shelf_cache`, or the ledger itself |
| Price table | `capabilities.unitCostMicros.{ search, item, price }` per adapter | recorded on the meter. ai-spend.js prices only models (ai-spend.js:60-72 (recon)), so it is not used |
| Entitlement | paid plan, verified email. A new `assertPaidFeature(db, auth, label)` built on `aiEntitlementForUid` (functions/ai-gate.js:63-88), with its own message. Fails closed | before the rate limit |

### 3.3 Adapter interface

One shape for retail data vendors and distributor APIs. Files: `functions/integrations/price-adapter.js` (types, registry, shared fetch with `AbortSignal.timeout`, classification of HTTP errors as solar-measure.js:315-321), `price-adapter-fixture.js`, later `price-adapter-<vendor>.js`, `price-adapter-abc.js`, `price-adapter-srs.js`, `price-adapter-qxo.js`. These are plain modules; no function is defined in them.

```js
/** @typedef {Object} PriceAdapter
 *  @property {string} id            'fixture' | 'retail_<vendor>' | 'abc' | 'srs' | 'qxo'
 *  @property {'retail_vendor'|'distributor_api'} kind
 *  @property {string[]} suppliers   registry ids it can serve
 *  @property {Capabilities} capabilities
 *  @property {(env) => boolean} configured          false when its secret is the '__unset__' stub
 *  @property {(ctx, q: {supplierId, query, limit}) => Promise<{ok:true, items: ItemRef[]} | Fail>} search
 *  @property {(ctx, q: {supplierId, sku}) => Promise<{ok:true, item: Item} | Fail>} getItem
 *  @property {(ctx, q: {supplierId, sku, uom?, qty?}) => Promise<{ok:true, quote: PriceQuote} | Fail>} getPrice
 */
// Capabilities
{ search: true, getItem: true, getPrice: true, batchPrice: 1,
  availability: 'none' | 'sellable' | 'stock',
  images: false, accountPricing: false,
  comparisonAllowed: true,          // false for the ABC API (D7)
  vendorCacheMs: null,              // 14400000 for SRS (prices cached 4 hours)
  rateLimitPerSec: 5,
  unitCostMicros: { search: 0, item: 0, price: 0 } }
// ctx
{ companyId, location: { id, storeNumber, branchNumber, zip }, account: { number, shipTo } | null,
  credentials, fetchImpl, nowMs, logger }
// Item
{ supplierId, sku, skuKind, title, brand, altIds: { upc, model, internetSku, mfrPart }, url, imageUrl, uomRaw, attributes: {} }
// PriceQuote
{ state: 'priced' | 'call_branch' | 'not_sold_here' | 'not_found',
  priceCents: int | null, listCents: int | null, currency: 'USD', uomRaw: string | null, priceType: 'shelf' | 'account' | 'promo',
  fetchedAtMs, sourceAgeMs: int | null, validForMs: int | null,
  availability: { state: 'unknown' | 'sellable' | 'in_stock' | 'out_of_stock' | 'call_branch', qty: int | null },
  url }
// Fail (never thrown for a missing key; integrations/_shared.js:160-162)
{ ok: false, provider, reason: 'not_configured' | 'auth' | 'rate_limited' | 'timeout' | 'vendor_error' | 'bad_request',
  code, status, retryAfterMs }
```

Edge cases, each with a fixture test:

| Case | Rule |
|---|---|
| Price 0, null or negative (ABC and SRS both return 0 for an item a branch has not priced) | `state: 'call_branch'`, `priceCents: null`. No observation is written. `latest.lastCheck.state = 'call_branch'`. The screen says "Call the branch for this price" |
| ABC availability | It means the branch can sell the item, not that it is in stock. `availability.state = 'sellable'`; the label is "Sold at this branch (not a stock count)" |
| SRS "Call branch for availability" | `availability.state = 'call_branch'` |
| Vendor-cached price | `sourceAgeMs` carries the vendor's cache age when stated (SRS up to 4 hours), else null. The screen shows "as of <time>", or "age not stated". The observation's `observedAt` is `fetchedAtMs - (sourceAgeMs or 0)` |
| Our own cache hit | `cached: true`; `observedAt` is the original fetch time, never the time of the click |
| Unit returned differs from the offer's purchase unit | Observation written with `flags: ['unit_mismatch']`, `catalogMicros: null`; alert `needs_unit` |
| No unit returned (the usual case for a retail vendor) | `uomRaw: null`. The row is read as the offer's `purchaseUnit` only for an exact-SKU `getPrice` on an offer whose pack is `verified`; otherwise `catalogMicros: null` and `needs_unit` (section 5.3, rule 3) |
| Cents and micros | An adapter returns whole cents. `appendObservations` stores `priceMicros = centsToMicros(priceCents)`, kind `live_shelf` or `api_account`, `attested: true`, and `compare` from `capabilities.comparisonAllowed` |
| 401 or 403 | `reason: 'auth'`; `supplierAccounts.link.status = 'error'`; no retry |
| 429 | `reason: 'rate_limited'`; honour `retryAfterMs` once, inside the function timeout |
| Timeout | `AbortSignal.timeout(12000)`; `reason: 'timeout'`; the reservation is released |
| Not found | `state: 'not_found'`; alert `not_found` only after two misses seven days apart |
| Retail promo or sale price | `priceType: 'promo'`, `listCents` kept; shown as the shelf price, never eligible for a cost proposal, not even by the owner's "Use this price" tap |
| Text fields from the vendor | clipped (title 160, brand 60), control characters stripped, stored as data. Never logged, never put in a prompt |

Fixture adapter: `price-adapter-fixture.js` reads `tests/fixtures/pricing/*.json` through an injected loader and is the only adapter registered until a vendor is chosen. It is how slice 5 ships with no key. Every fixture, for this adapter and for a real vendor's adapter later, is hand-built in the response shape with `TEST-` SKUs and synthetic prices (section 7); a recorded real response is never tracked.

### 3.4 Pure logic (no Firestore, unit-tested)

Each export is listed with the slice that first needs it. Nothing is built before something reads it.

| Module | Exports | Client twin |
|---|---|---|
| `functions/price-logic.js` | Slice 1: `SUPPLIERS`, `UNITS`, `CATALOG_UNIT_OF`, `NO_PURCHASE_TWIN`, `normaliseUom`, `sameUnit`, `validPack`, `suggestPack`, `moneyTextToMicros`, `centsToMicros`, `microsToCents`, `toCatalogMicros`, `suspectUnitSwap`, `KINDS`, `CALLER_KINDS`, `evidenceLevel`, `currentRows`, `bestForOffer`, `offerIdFor`, `obsIdFor`, `sanitizeSupplierAccount`, `sanitizeOffer`, `sanitizeObservation`, `summarize` (builds `latest`), `FLAG_NAME`, `FLAG_DEFAULT`, `flagOn`. Slice 2: `legacyItemToLedger`. Slice 3: `batchIdFor`, `applyTaxMicros`, `removeTaxMicros`, `bestForProduct`, `disagree`. Slice 4: `microsToCostBookDollars`, `dollarsToMicros`, `bookMicros` | `docs/pro/js/price-logic.js`, a byte-identical SHARED block (the receipt-inbox-logic pattern, functions/receipt-inbox-logic.js:29, :513), with a parity test |
| `functions/price-change-logic.js` | Slice 3: `detectChange(product, offers, link, book, cfg, nowMs)`, `quoteExpiryState(obs, nowMs, warnDays)`, `proposalSource`, `proposalLines`. Slice 4: `sellGuard`, `marginFloorCheck`, `buildCostBookPatch(alert, lineKeys, expect, liveBook, sells, units, cfg)`. Slice 13: `autoApplyEligible` | none (server only) |
| `functions/price-import-logic.js` (slice 3) | `detectPreset`, `mapColumns`, `parseRows`, `rowToObservationInput`, presets `generic_csv`, later one per supplier export | `docs/pro/js/price-import-logic.js`, same SHARED block rule |
| `functions/price-index-logic.js` (slice 8) | `monthlyMedianByCategory`, `rebase`, `changeOver` | client twin |
| `functions/price-ledger-store.js` | Slice 1: `appendObservations`, `recomputeLatest`, `writeAudit`, `saveOps` (the Save ops as functions of `(db, companyId, data, caller)`). Slice 3: `openAlert`, `writeImport` | none |

`comparableSet` from the first draft is gone: the D7 rule is carried by `latest.bestComparable` (built in `summarize` from the `compare` field every row already has), and `bestForProduct`, `disagree`, `proposalSource` take that as input.

## 4. Client

### 4.1 Files

| File | Slice | Role |
|---|---|---|
| `docs/pro/js/price-logic.js` | 1 | shared pure logic |
| `docs/pro/js/price-ledger.js` | 1 | `window.NBDPriceLedger`: `enabled()`, `offersFor(productIds)`, `history(offerId)`, `saveOffer`, `record`, `recordHdReceipts`, `suppliers()`. There is no shared callable helper in the repo; it copies the lazy `httpsCallable` pattern at docs/pro/js/receipt-inbox.js:113-121. Never throws into a caller. `recordHdReceipts` arrives in slice 2 |
| `docs/pro/js/price-offers-ui.js` + `docs/pro/css/price-ledger.css` | 1 | the "Stores & prices" sheet: offers, unit conversion, typed price, history |
| `docs/pro/js/price-import-logic.js`, `price-import.js` | 3 | supplier import screen |
| `docs/pro/js/price-alerts.js` | 3, 4 | alerts inbox and line-by-line approval |
| `docs/pro/js/price-index.js` | 8 | index and trends |
| `docs/pro/js/materials-list.js` (edit) | 7 | real prices, where to buy |

### 4.2 Loading

- `estimates` bundle (docs/pro/js/script-loader.js:264-277): append `'js/price-logic.js?v=1', 'css/price-ledger.css?v=1', 'js/price-ledger.js?v=1', 'js/price-offers-ui.js?v=1'` after `'js/price-book.js?v=2'`. The order pinned at tests/price-book-2026-10-02.test.js:117 (product-library, then price-book.css, then price-book.js) is untouched.
- `expenses` bundle (:136-146): append `'js/price-logic.js?v=1', 'js/price-ledger.js?v=1'` after `'js/price-book.js?v=2'` in slice 2. A file in two bundles must be added to the allowlist at tests/merge-leftovers-guard-2026-10-05.test.js:125.
- New lazy bundle `pricing` for import, alerts and index; `VIEW_BUNDLES.pricing = ['estimates', 'pricing']` (:605-610). Nothing is eager, so tests/dashboard-boot-budget-2026-10-03.test.js is not touched.
- Cache keys: every edit to script-loader.js bumps `script-loader.js?v=227` in docs/pro/dashboard.html:146 and docs/pro/customer.html:2892 together. An edit to product-library.js bumps its key in the loader (16 to 17). `DATA_VERSION` is not bumped (no seed change); tests/catalog-sell-refresh-2026-11-09.test.js:131-144 checks `>=`, so a higher key passes.

### 4.3 Entry points

| Screen | Entry | Slice |
|---|---|---|
| Stores & prices sheet | a ghost button on each product card, `data-prl-action="openProduct" data-prl-id`, rendered by product-library.js only when the flag is on. Not inside the product modal: its class counts are pinned (tests/ui-primitives-2026-10-01.test.js:161-171) | 1 |
| Price history | inside the sheet, per offer: newest 50 rows with kind, level badge, date, branch, document reference, and "as of" age | 1 |
| Unlinked items | header button beside "Price book" (product-library.js:708, markup pinned, left alone): legacy and imported offers with no product, each with "Link to a product" | 2 |
| Supplier import | view `pricing`, tab Import: pick supplier and branch, pick a file, map columns, preview with both unit readings, commit | 3 |
| Alerts inbox | view `pricing`, tab Alerts, plus a count chip on the Product Library header | 3 |
| Materials list | the existing modal (materials-list.js:107-130) | 7 |
| Index | view `pricing`, tab Trends | 8 |

### 4.4 Conventions

- Events: one document-level click delegate keyed on `data-prl-action`, dispatching only names that exist on the module (the guard at product-library.js:1220-1233). `pb`, `pl`, `ml` and `sp` are taken; `prl` was not found in docs/pro at 46348a4. CSS class prefix `.prl-`.
- Escaping: every supplier- or retailer-supplied string goes through the five-character escaper (price-book.js:117), including into attributes. `url` is rendered only when it parses as `https:` on an allowed host, with `rel="noopener noreferrer"`.
- DESIGN.md: rep-dashboard surface, theme tokens only (`--orange`, `--bg`, `--s`, `--br`, `--t`, `--m`, `--green`, `--red`, `--gold`, `--blue`), no hex where a token exists; `.ui-*` primitives; money in `.ui-money`; up and down arrows and "below floor" in `--ui-danger-text` / `--ui-success-text` / `--ui-warn-text`; one filled orange button per region, the rest `.btn-ghost`; `.modal` (bottom sheet on phones) with `role="dialog"`, `aria-modal`, Escape to close; 44 px targets; nothing scrolls sideways at 360 px; motion through `--ui-dur-*` only; no inline `style` attribute (tests/inline-style-ratchet-2026-10-01.test.js); CSS loaded as a late stylesheet. Check in `nbd-original` and one light theme.
- Every price on screen shows its source and date. A missing price shows "No price yet", never 0 (the "Cost not set" rule, product-library.js:484-496). No price is invented or interpolated (the removed widget at widgets.js:518-534 is the precedent).
- Client files are scanned by tests/catalog-cost-privacy.test.js. Do not write a numeric literal beside a key named `cost`, `contractor`, `materialCost`, `laborCost`, `overheadMultiplier` or `profitMarginPct`, and no `Cents: <digit>` literal (the rule at tests/price-book-2026-10-02.test.js:101).

### 4.5 Photos and CSP (decided: copy in, no allowlist)

- Storage path: `product-photos/{companyId}/{offerId or productId}/{sha256[0:32]}.webp`, written only by the server after a `sharp` re-encode (functions/photo-reencode.js:38-49: proves the bytes are an image, strips EXIF) to at most 640 px.
- storage.rules block (after the sub-papers block at :350-360; helper `isCompanyMember` at :70-73):

```
    // ── PRODUCT PHOTOS (price ledger, 2026-11) ──
    // product-photos/{companyId}/{ownerId}/{file}: a re-encoded product picture
    // shown ONLY inside the signed-in CRM. Server-written (admin SDK). Read by
    // the company's members through getBlob (a blob: URL), never a ?token= link.
    match /product-photos/{companyId}/{ownerId}/{file} {
      allow read: if isCompanyMember(companyId)
        && !(request.auth.token.get('role', '') in ['viewer', 'member']);
      allow write: if false;
    }
```

- Hand-off: `isCompanyMember`'s solo branch is claim-only (storage.rules:64-73: no companyId claim, no subordinate role, uid equals the company id), so a removed former owner whose claims were stripped still passes it; Storage rules here use claims, never a Firestore lookup. `tests/storage-rules.product-photos.test.js` carries that case and pins what happens. It is accepted in writing: the exposure is the same as the other company-keyed prefixes, the files are product pictures with no price, and the Firestore side (where the prices are) refuses that person. If Jo wants it closed, the fix is a lookup in this one rule.
- Display: `getBlob(ref(storage, path))` then `URL.createObjectURL` (the sub-papers pattern, storage.rules:347-349). `img-src` already admits `blob:` and NBD's bucket, so firebase.json is not edited and tests/csp-hardening-2026-10-05.test.js is not re-pinned. Never `getDownloadURL`.
- Sources, in order: the tenant's own photo (`productPhotoSave`, slice 4); a file the tenant downloaded under its own manufacturer programme login and uploaded; a retailer image fetched server-side from the price vendor's response (`source: 'retailer_ref'`, slice 6, only for a tenant whose config sets `retail.photos: true`); distributor API images stay off until that distributor's terms are read. Photos are tenant-scoped, never a shared library: programme licences are per contractor.
- `scripts/check-storage-prefix-registry.js` models uid-keyed prefixes; a company-keyed prefix is outside it (sub-papers is not in the registry either). Erasure is handled in section 7.

## 5. Units and money

### 5.1 The one rule

| Value | Representation | Where |
|---|---|---|
| A supplier's price as stated | integer micro-dollars (`priceMicros`) for `per` of `statedUnit` | ledger, imports, fixtures |
| A price per catalog unit | integer micro-dollars (`catalogMicros`; 1 cent = 10000) | ledger, alerts, ranking, index |
| A vendor response, a meter, an extended amount | integer cents | adapters, cache, `priceMeter`, `extCents` |
| A cost-book value | dollars, float (existing; nothing in the repo rounds it today). This system writes whole cents only | written only by `buildCostBookPatch` through `microsToCostBookDollars` |
| A product sell | dollars, float (existing) | read only, through `dollarsToMicros` |

Boundaries, each one function in `price-logic.js`, each tested:

- `moneyTextToMicros(text)`: a decimal string (`"11.1111"`) to micros by digit arithmetic, up to six decimals, no float. The typed-entry form and the import parser use it; nothing parses a price with `parseFloat`.
- `centsToMicros(c) = c * 10000`; `microsToCents(m) = Math.round(m / 10000)` (display and vendor responses).
- `toCatalogMicros(priceMicros, per, statedUnit, pack)`:
  - pack unknown: `null`.
  - `statedUnit` is the offer's `purchaseUnit`: `Math.round(priceMicros * pack.den / (pack.num * per))`.
  - `statedUnit` is the catalog unit (`sameUnit(statedUnit, pack.catalogUnit)`): `Math.round(priceMicros / per)`, flag `stated_per_catalog_unit`. It is never routed through a purchase-unit price, so a price stated as 11110000 per square stays exactly that.
  - anything else: `null`, flag `unit_mismatch`.
  - Bounds: `priceMicros ≤ 10^11`, `num ≤ 100000`, `den ≤ 10000`; the intermediate product is checked with `Number.isSafeInteger` and an unsafe one returns `null`.
- `applyTaxMicros(m, bps) = Math.round(m * (10000 + bps) / 10000)`; `removeTaxMicros(m, bps) = Math.round(m * 10000 / (10000 + bps))`. Round trip within one micro (slice 3).
- `microsToCostBookDollars(m) = Math.round(m / 10000) / 100`; `dollarsToMicros(d) = Math.round(d * 1000000)`; `bookMicros(m) = dollarsToMicros(microsToCostBookDollars(m))`, the value as the cost book would hold it (slice 4).

Rounding rule for change detection: both sides are compared as whole cents. `detectChange`, `proposalLines` and the `expect` guard compare `bookMicros(proposed)` with `dollarsToMicros(bookValue)`. Without that, a price such as 124900 micros per square foot rounds to 12 cents in the book and re-raises the same alert for ever. A proposal whose `microsToCostBookDollars` value is 0 is blocked (`below_one_cent`): a zero would be read as a real cost (product-library.js:492-496) and shown as 100% margin. Test: approve, recompute, no new alert.

No other file converts money. A lint-style test greps the new files for `/ 100`, `* 100`, `parseFloat(` and `toFixed(` outside `price-logic.js`.

### 5.2 Conversion model

Stated and purchase units (`UNITS`): `BDL` bundle, `RL` roll, `BX` box, `PC` piece, `EA` each, `SHT` sheet, `SQ` square, `LF`, `SF`, `GAL`, `PAIL`, `TUBE`, `BAG`, `CTN` carton, `PLT` pallet, `LB`.

Catalog units are the keys of `NBD_UNITS` (product-data.js:26-43), and they are not the same strings: the catalog says `BDNL` for a bundle and has `CT`, which is "Container", not carton. So unit equality is never a string compare. `CATALOG_UNIT_OF` is the explicit map:

| Purchase unit | Catalog unit |
|---|---|
| `BDL` | `BDNL` |
| `RL`, `BX`, `PC`, `EA`, `SQ`, `LF`, `SF`, `GAL`, `TUBE`, `BAG` | the same key |
| `SHT`, `PAIL`, `CTN`, `PLT`, `LB` | none (always needs a ratio) |

`NO_PURCHASE_TWIN = ['CT', 'HR', 'RM', 'JOB', 'DAY']`: `CT` is reachable only through a ratio (for example `PAIL` to `CT`); an offer can not be linked to a product priced per `HR`, `RM`, `JOB` or `DAY`. `sameUnit(purchaseUnit, catalogUnit)` is `CATALOG_UNIT_OF[purchaseUnit] === catalogUnit`. A test walks every `NBD_UNITS` key and requires it to be either the image of exactly one purchase unit or in `NO_PURCHASE_TWIN`, so a new catalog unit fails the test until it is placed.

`pack` on an offer:

| Field | Meaning |
|---|---|
| `purchaseUnit` | what the supplier sells one of |
| `catalogUnit` | the linked product's `unit` at the time the pack was set |
| `num`, `den` | positive integers: one purchase unit = `num / den` catalog units |
| `status` | `known` or `unknown` |
| `basis` | `manufacturer_spec`, `supplier_doc`, `owner_entered`, `seed_coverage`, `same_unit` |
| `verified`, `verifiedBy`, `verifiedAtMs` | an owner or company_admin confirmed it |
| `note` | free text ≤ 80 |

| Case | purchaseUnit | catalogUnit | num / den |
|---|---|---|---|
| Shingles, 3 bundles per square | BDL | SQ | 1 / 3 |
| Shingles, 5 bundles per square | BDL | SQ | 1 / 5 |
| Shingle product the tenant prices per bundle | BDL | BDNL | 1 / 1 |
| Underlayment roll, product priced per square | RL | SQ | 10 / 1 |
| Underlayment roll, product priced per roll (16 seed products are; `under_001` is one) | RL | RL | 1 / 1 |
| Drip edge, 10 ft piece | PC | LF | 10 / 1 |
| Ridge cap bundle covering 25 LF | BDL | LF | 25 / 1 |
| Starter, 120 LF per bundle | BDL | LF | 120 / 1 |
| Box of coil nails, catalog per box | BX | BX | 1 / 1 |
| Step flashing, bundle of 100 pieces | BDL | EA | 100 / 1 |

Unknown conversion: `status: 'unknown'`, `num: null`, `den: null`. Then `catalogMicros` is null on every observation, the row can not rank, can not raise a price proposal and can not auto-apply; it raises one `needs_unit` alert per offer (slice 3) and shows "needs a unit" on the sheet (slice 1). Nothing is guessed.

Suggestion (`suggestPack(purchaseUnit, catalogUnit, coverage)`), shown as a suggestion, `verified: false`, saved only when a person taps to accept it:

- `sameUnit(purchaseUnit, catalogUnit)`: suggest 1 / 1 with `basis: 'same_unit'`. Coverage is ignored: a roll bought for a product priced per roll is 1 to 1, and suggesting `sqPerRoll` there is the ten-times error recorded at product-library.js:1316-1322.
- Units differ and the product's `coverage` has the matching key (`BDL` to `SQ`: 1 / `bundlesPerSq`; `RL` to `SQ`: `sqPerRoll` / 1): suggest it with `basis: 'seed_coverage'`.
- Otherwise: no suggestion; the person types the ratio.

The three coverage tables in the code disagree (materials-list.js:28-45, maps-routing.js:3352-3358 (recon), product-library.js:1324-1336), so none of them is trusted silently.

A product's unit can change (the product modal writes `product.unit`, and `shingle_001` already offers `SQ` and `BDNL`). `pack.catalogUnit` is a snapshot, so it is re-checked:

- Slice 1 (client): the sheet has the product in hand. When `pack.catalogUnit` differs from the product's current `unit`, it shows "The product's unit changed. Set the pack size again" and hides every per-catalog-unit figure for that offer.
- Slice 3 (server): `recomputeLatest` resolves the product's current unit (`productLibrary/{companyId}.items[id].unit` when the tenant holds the row (recon), else the generated `functions/product-seed-public.json`, section 6). A mismatch sets `latest.unitState: 'unit_changed'`, opens `unit_changed`, and the offer stops ranking across suppliers and proposing.
- Slice 4 (server): `priceAlertDecide` checks again inside the transaction and refuses the line with `unit_changed`. So a per-square cost can never be written into a product that is now priced per bundle.

A later change to an offer's `pack` does not rewrite old observations (they keep their snapshot). `recomputeLatest` re-derives `catalogMicros` for the summary from the current pack and each row's stated price, and the change is logged as `conversion_verified`.

### 5.3 Per-bundle versus per-square, and tax

The sweep already recorded a supplier answering per bundle when asked per square. Guards, at import and at manual entry:

1. Unit is required per row. An import column must be mapped to the unit; a unit string that `normaliseUom` does not know makes the row `needs_unit`. There is no default unit. `normaliseUom` reads "per C", "/C", "per 100" as `per: 100` and "per M", "/M", "per 1000" as `per: 1000`; a per-hundred or per-thousand price with no base unit is `needs_unit`.
2. The stated unit must be the offer's `purchaseUnit` or the offer's catalog unit; anything else is `unit_mismatch` with `catalogMicros: null`. The stated price and unit are stored as stated either way.
3. No unit at all (a null `statedUnit`) is accepted only from a source that looked up an exact SKU at a retail supplier (the Home Depot CSV, the legacy migration, a retail vendor's `getPrice` by SKU), and then it is read as the offer's `purchaseUnit` only when the offer's pack is `verified`. Otherwise the row is stored with `catalogMicros: null` and counts as `needs_unit`.
4. `suspectUnitSwap(newCatalogMicros, referenceMicros, pack)`: when the new price divided by the reference is within 15% of `num/den` or `den/num`, the row gets `unit_suspect`, opens an alert that says "This looks like a per-<unit A> price entered as per-<unit B>", and can not become a proposal until a person confirms or voids it. The reference is the offer's previous best, else the linked product's current cost, else (first price, no cost) the product's sell: then the flag is raised when the price is above the sell or below 5% of it. The ratio check is skipped when `num/den` is within 15% of 1 (for example 6 / 5), where it would fire on ordinary price moves.
5. The preview shows two columns for every row before commit: the price as stated, and the same price per catalog unit. The commit button is disabled while any selected row is `needs_unit`.

`uomRaw` keeps the supplier's own text so a later reader can see what the document said.

Cost basis (Jo, 2026-08-19, documentation/audit/CATALOG-UNDER-COST-2026-08-19.md:108-110): the cost book holds the bare supplier price plus sales tax; delivery is carried at job level; waste is applied to quantity. So (slice 3 onward):

- Comparison basis is tax-free. A row with `taxIncluded: false` is used as is. A row with `taxIncluded: true` is divided back with `removeTaxMicros(catalogMicros, purchaseTaxBps)`; when the tenant has not chosen a rate, that row gets `tax_unknown` and is left out of `bestForProduct`, `disagree` and proposals (it still shows in its own offer's history). A tax-in price is never compared with a tax-out one.
- A proposal is `bookMicros(applyTaxMicros(taxFreeMicros, purchaseTaxBps))`.
- `purchaseTaxBps` is a required, explicit choice. While it is null, alerts still open but every line is `blocked: 'needs_tax_rate'` and `priceAlertDecide` refuses. `0` is allowed and means "my cost book is before tax". There is no "before tax" proposal that can be approved by accident.
- `delivered: true` rows are shown but never proposed (the delivery share can not be separated).

## 6. How a price reaches a quote

```
observation  ->  recomputeLatest (per offer, newest wins)  ->  detectChange (per product, one source offer)
     ->  alert price_change_<productId> (lines per tier)  ->  owner approves a line  ->  guards
     ->  one field path in catalogCosts  ->  priceAudit row + productLinks.applied  ->  devices
```

| Step | Rule |
|---|---|
| 1. Land | Every observed price is written, whatever its source. Nothing is dropped for being higher or lower |
| 2. Summarize | `summarize` rebuilds the offer's `latest` (section 1.6, step A) |
| 3. Detect (slice 3) | Per linked product. The source is ONE offer: `productLinks.preferredOfferId` when set, else the winner of `bestForProduct`. The source row is that offer's `bestComparable`. It proposes only when all hold: its level now is L1, or L2 from `portal_read` / `api_account`; kind is not `live_shelf` or `manual`; `priceType` is `net` or `account` (never `list`, `promo`, `shelf`); `compare` is true; the pack is known and `unitState` is `ok`; no `unit_suspect`; not `delivered: true`; the tax basis is known. Then the proposed value (section 5.3) is compared, in whole cents, with the current cost-book value of each target; a line is raised when they differ by at least `alertThresholdBps` (default 200) or there is no cost yet |
| 3b. What does not propose | A `live_shelf` row opens `shelf_moved` ("shelf price at <store> is now X; your cost is Y; last paid Z on <date>") with no line. The owner may tap "Use this price" on it, which builds one line through the same guards and is audited as `evidence: 'shelf'`; nothing proposes it automatically and it never auto-applies. Evidence that decays (a quote expires, a paid price passes 60 days, an account read passes 7 days) and leaves no L1 or L2 row opens `requote` / `quote_expired`; it never proposes moving the cost to the older row. An ABC API row (`compare:false`) never proposes: when it is the only current evidence on the preferred offer, the ABC tab shows it with "not used for cost changes until ABC answers" and nothing is raised |
| 4. Alert | One open `price_change_<productId>`, with one line per tier in the source offer's `tiers` (`costs.<productId>.cost.<tier>`). The other offers of that product appear as `context`. Approving a line can not make another supplier's offer re-raise the same field, because only the source offer proposes |
| 5. Approve (slice 4) | `priceAlertDecide`, owner or company_admin, one line key at a time, each with `expect[key]` = the `fromMicros` the person saw |
| 6. Guards | (a) `purchaseTaxBps` is chosen. (b) The live cost-book value, in whole cents, still equals `expect` (else `refused: 'changed'`, the alert is rebuilt). (c) The product's current unit still equals `pack.catalogUnit` (else `unit_changed`). (d) Sell against cost: the tenant's sell for that product and tier, from `productLibrary/{companyId}.items[id]` when the tenant holds the row, else the seed sell. A cost above the sell is not written unless the call carries `confirmAboveSell: true`; then it is written, audited, and a `cost_above_sell` alert stays open on the product until the sell is at or above the cost. This matches what the same person can already do in the product modal ("Save anyway?", product-library.js:1000-1004); refusing outright would leave the book at a too-low cost exactly when margin is negative. (e) Floor: when `floorBps` is set, `sell * (10000 - floorBps) / 10000 >= cost + labor.perUnit` (the formula at tests/catalog-price-floor-2026-11-09.test.js:238-260); a line under the floor needs `confirmBelowFloor: true` and the audit row records it. A sell is never changed |
| 7. Patch | One transaction: read the alert, `catalogCosts/{companyId}` and the product link; write the field path `costs.<id>.cost.<tier>` only (never the whole entry, never `labor`, never another map); write the audit row; set `productLinks/{id}.applied.<tier>`; mark the line. Uses an update-time precondition, the same protection as scripts/merge-catalog-costs.js:394-399. Missing pieces: no `catalogCosts` doc, or an empty `costs` map, is refused with `no_cost_book` ("Open the Product Library once on the owner's device so your costs are saved, then approve"), because a server-created first entry would make the client's one-time `adoptLocal` skip for good (catalog-costs.js:429). A doc with costs but no entry for this product: the one-tier entry is created (the client tolerates a partial entry per tier, catalog-costs.js:202-206) and the audit row says `created: true`. This differs from the merge script, which skips such a SKU (scripts/merge-catalog-costs.js:160-164); here a person asked for it |
| 8. Devices | Below |

Step 8, in full. Today a cost changed on one device does not reach a product that another device has edited: `applyCostSeed` returns early when `updatedAt !== createdAt` and the product has any cost or labor (product-library.js:161-162), and every save stamps `updatedAt` (:184). Then a later save from that device writes its old cost back, because `recordProduct` (catalog-costs.js:569-575) calls `writeEntries` (:373-416), which replaces `costs.<id>` whole. An approval would visibly do nothing for exactly the products the owner maintains. Slice 4 fixes both halves:

- `_productLib.applyApprovedCost(id, tier, dollars)`: sets the local product's `pricing[tier].cost`, saves the store, re-renders. It does not stamp `updatedAt` (the same reasoning as `applyCostSeed`, product-library.js:146-148).
- `NBDCatalogCosts.noteApproved(id, tier, dollars)`: updates the in-memory book and its cache for that one path. No re-read. The first draft's `refresh()` is dropped: a forced `hydrate` swaps the whole book and re-registers job-template items (catalog-costs.js:482-505), which could re-price new lines in an estimate open in the same session.
- The approving device calls both with the `applied` list the callable returns.
- Other devices: after `NBDCatalogCosts.hydrate()`, `price-ledger.js` reads `productLinks` and, for each `applied.<tier>` whose `atMs` is newer than the marker that device stored for that path (localStorage), calls `applyApprovedCost` and stores the marker. A later deliberate edit on that device wins and is written to the book as today.
- `recordProduct` writes only what the person changed in that save: one path per tier whose cost differs from the product as the modal opened it (`costs.<id>.cost.<tier>`), `deleteField()` for a tier the person cleared, and `costs.<id>.labor` when labor changed. A name-only save writes no cost path, so it can not revert an approved cost. The CLEAR tests (tests/catalog-cost-seed.test.js:565-584) keep asserting the behaviour: a cleared tier is absent from the book, other SKUs untouched, the `setDoc` fallback for a first write.
- A device where the flag is off never reads `productLinks`. It keeps showing its own local cost for an edited product, which is today's behaviour for any cost edit made elsewhere; the per-tier write is what stops it undoing an approval.

Tests (slice 4): an edited product with a local cost shows the approved cost after the approval and after a reload on a second device; a later name-only save does not revert it; `xactCost()`, `jobItem()` and `laborOp()` answers are unchanged by `noteApproved`.

Public seed facts on the server: the functions bundle does not contain `docs/`. Slice 3 adds a generated `functions/product-seed-public.json` (`{ id: { unit, sell: { good, better, best } } }`: units and retail sells only, both already public) built by `scripts/build-product-seed-public.js`, with a `--check` gate and a line in the `DATA_VERSION` checklist.

What each cost-book map does, and what this system writes:

| Map | Drives | Written by approval |
|---|---|---|
| `costs.<productId>.cost.<tier>` | Product Library margin displays only. No customer total | Yes, slice 4 |
| `xactCosts.<code>` | sell and margin of every NEW line-item line (cost-plus) and the internal margin of per-SQ quotes | Slice 10 only: behind `priceConfig.quoteCosts: true`, needs a `productLinks.lineCodes` row, shows the old and new per-unit retail before the tap, writes `materialCost` only, and only when a full entry exists (a lone `materialCost` is ignored, catalog-costs.js:674-682); when none exists it offers to create the entry from the published `laborCost` and the new material figure |
| `jtCosts.<key>` | sell of Job Template custom lines | Slice 10, same rules, `materialCost` only |
| `laborOps`, `v2Costs` | they do feed pricing (estimate-labor-catalog.js:205 reads `laborOp`; estimate-builder-v2.js:782-800 reads `v2Costs` into the catalog) | Never: labor and the V2 catalog are not supplier prices |
| `defaults`, any `labor` block | policy | Never |
| any sell (`product-data.js`, `productLibrary`, `TIER_RATES`, `companyProfile.pricing`) | customer prices | Never, in any slice |

`functions/catalog-cost-logic.js` `validateCostOverlay` (:236-245) is run only by the import and extract scripts under `scripts/`; no function calls it at runtime. Slice 4's guards are their own code with their own tests and reuse its rule (cost > 0, sell ≥ cost unless confirmed), not its call.

The product to line-code mapping (slice 10): a code-to-product map already exists, `PRODUCT_MAP` in product-library.js:1324-1336 (estimate rate keys to product ids with a unit conversion, exported as `NBD_ESTIMATE_PRODUCT_MAP`). Slice 10 builds `productLinks.lineCodes` on top of it and adds a test that the two never disagree on a conversion for the same product; it does not ship a second, independent table. The unused `materialId` path in the engine (estimate-logic-engine.js:372-406) is not switched on.

Saved and signed work never moves: reopened rows keep their saved cost (estimate-v2-ui.js:4881-4900) and the signed price wins (functions/signed-price.js:6-21). Nothing here touches either.

Opt-in auto-apply (slice 13, off by default, `priceConfig.autoApply`): `autoApplyEligible` requires all of:

- `enabled`, and the target is a `costs.*` path (never `xactCosts` or `jtCosts`);
- the row is a normal proposal source (step 3) and `evidenceLevel(row, now) === 1`, so a 61-day-old paid row is refused;
- kind `paid` or `quote`; `priceType` `net` or `account`;
- `attested: true`: an owner or company_admin sent it, or the server read the document itself. A manager-typed or manager-imported row never auto-applies and always stays an alert;
- it is the newest non-voided row for its offer, and its `observedAt` is later than `productLinks.applied.<tier>.obsObservedAtMs`, so an old invoice imported late can not move a cost backwards;
- `match === 'exact'`; `pack.verified`; `unitState` `ok`; `compare === true`; no flags;
- the change is inside `capBps` in either direction; the sell and floor guards pass without a confirm.

Anything else stays an alert. Each automatic change writes `auto_applied` to the audit and a line in the alerts inbox, and can be undone from there.

Scope now: steps 1 to 8 for `costs.*`. Later: `xactCosts`, `jtCosts`, auto-apply.

## 7. Privacy and terms guards, as code

| Guard | Test or mechanism |
|---|---|
| No cost figure in the repo | `tests/price-fixture-privacy.test.js` (bucket `node`: a pure file scan). Scope is an explicit list, never the glob `tests/price-*`: every file under `tests/fixtures/pricing/`, and the suites whose names start `price-logic-`, `price-ledger-`, `price-import-`, `price-change-`, `price-check-`, `price-index-`, `price-fixture-`, plus `firestore-rules.price-ledger.test.js`. One assertion keeps the list honest: every `tests/price-*.test.js` on disk is either in scope or is exactly `price-book-2026-10-02.test.js`, the pinned legacy suite, which holds non-synthetic cents beside real store ids (:40, :105-108) and is not edited before slice 14. Rules in scope: suppliers only from a fictional allowlist (`Testco Supply`, `Example Depot`) or a registry id used as an id; SKUs match `/^TEST-/`; every INPUT money literal (values of `priceMicros`, `priceCents`, `extCents`, `listCents`, a sell or cost in dollars) is a multiple of 1111 once its decimal point is removed; no real registry label within 200 characters of a money literal. Derived values (a rounding result such as 92583) are computed in the test from the function under test's inputs, or sit on a line that ends `// derived`; the scan skips those lines. No `.csv`, `.xlsx` or `.pdf` is tracked under `tests/fixtures/pricing/` unless it passes the same scan. `.local/` stays ignored |
| Vendor fixtures | Hand-built in the vendor's response shape, with `TEST-` SKUs, fictional titles and synthetic prices. A recorded real response is real shelf prices on real products; it may be kept only under `.local/`, never tracked. The 20-SKU accuracy script reads its SKU list from, and writes its results to, `.local/` or a Drive sheet, never a tracked path |
| No cost under docs/ | The new client files are in the strict scope of tests/catalog-cost-privacy.test.js by default (it scans every published file unless listed in `STRICT_EXEMPT`, :170-190). Slice 1 adds one assertion to the new privacy suite: no `docs/pro/js/price-*.js` or `docs/pro/css/price-*.css` path appears in `STRICT_EXEMPT`. The pinned suite itself is not edited |
| Documentation | Notes carry counts, dates and rules only (the sweep note's rule). The vault note for each slice is checked by the same scan when it sits under `documentation/projects/LIVE-SUPPLIER-PRICING-*` |
| ABC API: no comparison | Server: `appendObservations` stamps `compare` from `adapter.capabilities.comparisonAllowed`; a caller can not set it, and a caller can not create an `api_account` row at all. `summarize` keeps `bestComparable` beside `best`. `bestForProduct`, `disagree`, `proposalSource` and the index input read only `bestComparable` / `compare:true` rows. Tests (slice 3, then 11): a product with an ABC API price below a Testco quote still shows Testco as best across suppliers; the tenant's own ABC invoice still ranks across suppliers when a newer ABC API row exists on the same offer; an ABC API row never opens `supplier_disagree` and never produces a proposal line; the ABC row appears only in the ABC tab; the index excludes every `*_api` channel. The switch to lift it is one constant per adapter, changed only with the written answer on file. Known limit: rules let every staff member and sales_rep read all offers of a product, so the separation is in what the screens compute and show, not in who can read; ABC's clause is about comparison tools, and the data is the tenant's own account |
| No pooling | `price-ledger-store.js` builds every path from the `companyId` argument and a test asserts no function accepts a path. The retail cache write refuses `priceType != 'shelf'` and any call that carries account credentials. An own-account credential is pinned to one tenant in two places (section 1.3). Emulator cross-tenant denies (section 2.4). No collection-group client read |
| Photos internal only | Storage rule (section 4.5); a test asserts no file under `docs/` outside `docs/pro/` and no file under `functions/` that renders a customer document (`render-pdf.js`, `customer-estimate-rows.js`, the document generator files, portal handlers) contains `product-photos/`; `photo.path` is absent from every estimate save payload (a test on `_buildSavePayload`) |
| Retailer text is data | Sanitizers clip and strip; UI escapes (a test like tests/escape-user-text-sinks-2026-09-29.test.js lists the new sinks); the AI document reader (slice 9) keeps the receipt-inbox contract (functions/receipt-inbox-logic.js:55-59): fixed prompt, no tools, the document is quoted as data, every field re-validated, no number that is not in the document. No vendor or supplier string is ever interpolated into a prompt's instruction text; a test asserts the prompt template has no `${` outside the data block |
| Logs | Structured event names and counts only. No price, SKU, account number or vendor body beyond a 300-character status string (measurement.js:92-142 pattern) |
| Erasure | `OWNER_KEYED_DOCS` (functions/integrations/user-owned.js:296-307) lists no company-keyed doc, so `priceBook`, `catalogCosts` and `productLibrary` are outside the registry today. Slice 1 adds `COMPANY_KEYED_TREES = ['priceBook']` to user-owned.js and one step to `confirmAccountErasure` in functions/integrations/compliance.js: in the solo path (the code after the member branch at :727-750, where `scope.mode === 'solo'`), after the owner-keyed docs loop (:911-914) and before the `if (failures.length)` check (:932), `try { await db.recursiveDelete(db.doc('priceBook/' + scope.companyId)); } catch (e) { fail('recursiveDelete', 'priceBook', e); }`, run only when `scope.companyId` is the erasing uid's own company. A failure makes the erasure partial and retryable, like every other step. That one call removes everything slice 1 creates, the meters included. A member's own erasure deletes nothing in this tree, and the uid in `createdBy` and audit rows is kept: the trail belongs to the company (assumption; confirm against the retention posture in compliance.js). Later slices add their own lines: `integrations/pricing/companies/{companyId}` (5), the Storage prefix `product-photos/{companyId}/` (4), the tenant's secrets (12). Tests that move in slice 1: tests/r4-erasure-export-honesty-2026-10-06.test.js (a failing `priceBook` delete is a partial erasure) and tests/account-erasure-billing.test.js if its stub counts steps. Whether `catalogCosts` and `productLibrary` are erased today is outside this spec; report it as a finding |
| Export | Not in `exportMyData`: that callable is per uid with no role check (functions/integrations/compliance.js:168-186), so adding the tree there would hand observations and audit to a sales_rep or viewer. The ledger goes into `exportCompanyData` (functions/tenant-ops.js:259, already gated by `requireTeamAdmin`, capped by `EXPORT_LIMIT` with a truncation note in the README). Slice 2 adds `supplierAccounts`, `priceOffers` and `priceObservations` to `buildCompanyExport`, each capped at `EXPORT_LIMIT` and named in `truncated` when cut; later collections join in the slice that creates them. Tests: a manager's, a sales_rep's and a viewer's `exportMyData` output contains no `priceBook` key; `exportCompanyData` refuses a manager |
| Flags off | A test asserts every new env gate is read as `=== 'true'` and that the dry-run branch writes nothing (the cron-gate pattern) |

## 8. Slices

### 8.0 Files parallel work fights over, and how to edit each

| File | Rule |
|---|---|
| `tests/ci-manifest.json` | never by hand: `node scripts/index-anchor.js manifest --test <file>.test.js --bucket node` (or `--bucket wired-individually`). Hash-placed slot, documentation/runbooks/PARALLEL-PR-HYGIENE.md. The tool can not place into `smoke` (an object, not an array); nothing in this plan needs `smoke` |
| `FLOORS` (scripts/run-test-manifest.js:483) | after adding suites run `node scripts/run-test-manifest.js --check`; when stale it prints the exact replacement line. Paste it and add one dated history line above, "MEASURED via --check". On a conflict re-run and re-paste; never merge the numbers by hand |
| `tests/source-pin-baseline.json` | do not edit. A new suite may hold at most 5 source-text assertions (tests/source-pin-ratchet.test.js `NEW_SUITE_CAP`); load code in a `vm` and assert behaviour instead. A suite that loses pins: `node tests/source-pin-ratchet.test.js --lower`. `--rebaseline` needs Jo's OK |
| `?v` cache keys | script-loader.js key in dashboard.html:146 and customer.html:2892 move together; on a rebase conflict take main's number plus one |
| `documentation/INDEX.md` | `node scripts/index-anchor.js index --section "<heading>" --line "- [..](..) …"`; never a second handoff list |
| `functions/function-map.json` | regenerate (`node scripts/gen-function-map.js`); on conflict regenerate again |
| `functions/FUNCTIONS_INDEX.md` | add rows in the middle of a section, not at its end |
| count pins 48 and 56 (cron-gate-drift :93, flags-registry-drift :96) | bump by the number of gates the PR adds; on a rebase, recount from the registry |
| `firestore.rules`, `storage.rules` | new blocks only, placed as stated; no edit to an existing block |

Gates for every slice: `node scripts/check-js-syntax.js`, `node scripts/check-inline-html-scripts.js`, `node scripts/run-test-manifest.js --check`, `node scripts/run-test-manifest.js --bucket node`, `node tests/smoke.test.js`, `node scripts/check-vault-index.js` (when a note changed), `node scripts/pr-preflight.js`. Rules slices add the emulator run with the proxy scrubbed (CLAUDE.md). Each slice writes or updates a dated note under `documentation/projects/` linked from INDEX.

### Slice 0. The decision on record (docs only)

- Goal: reverse the 2026-10-02 decision in writing so code can cite it.
- Files: new `documentation/projects/LIVE-SUPPLIER-PRICING-2026-11-17.md` (Jo's four decisions, the constraints, this plan's slice list, no figures); a dated update at the top of `documentation/projects/STORE-PRICE-BOOK-PLAN-2026-10-02.md` and of the stale line in `SUPPLIER-PRICING-SWEEP-2026-11-09.md:103`; INDEX line through index-anchor.
- Tests first: none. Gates: `check-vault-index.js`.
- Jo sees: the note. Dark: everything. Slice 1 may carry this note in its own PR (the flag registry row needs the doc to exist).

### Slice 1. Ledger core (buildable today, no credentials, no customer total moves)

- Goal: a product can carry supplier items with a link and a unit conversion, a typed price lands in a dated history, and the owner can read it.
- Built: the slice 1 exports of `price-logic.js` (section 3.4), `priceLedgerSave` (six ops), `priceLedgerRecord` (typed rows only: `channel: 'manual'`), the five rule blocks and one index, the "Stores & prices" sheet, the erasure line.
- Not built, on purpose (each lands with the slice that first reads it): `priceConfig` and `setConfig`, tax handling, `bestForProduct` / `disagree`, `productLinks`, alerts and `detectChange` (`alertsOpened` is always 0), imports and `batchIdFor`, `legacyItemToLedger`, `latest.lastCheck` / `shelf` / `nextCheckMs` (always null), the `integrations/pricing` block, the collection-group indexes, the export.
- What is NOT touched: `catalogCosts`, the legacy doc, price-book.js, hd-import.js, catalog-costs.js, every estimate file, the product modal, tests/catalog-cost-privacy.test.js. No estimate suite can move.
- The exact file list, tests and commands are section 12.
- Jo sees (with `feature_flags/{his uid}.supplierPricing = true`, which he sets): a "Stores & prices" button on each product; a sheet where he adds a store or supplier, a SKU, a link, the pack size (with the suggested ratio to accept or change), types a price with its kind, date and valid-through date, and reads the history with level badges. The sheet re-ranks the rows it has read with the shared function, so a level that decayed shows at once; the stored `latest` catches up when the daily watch lands in slice 3.
- Dark: the flag is off for everyone by default; the callables refuse when it is off.
- Hot files: ci-manifest (four suites: two `node` logic and server suites, one `node` privacy suite, one `wired-individually` emulator suite), FLOORS, script-loader key, function-map, FUNCTIONS_INDEX, flags-registry-drift assertion.

### Slice 2. Bring the receipts in

- Goal: Home Depot history appears in the ledger with its store number; legacy items can be linked to products; the ledger is in the company export.
- Files: `scripts/migrate-price-book-v2.js` (dry run default, `.local/` backup), `functions/price-logic.js` (`legacyItemToLedger`), `functions/price-ledger-store.js` (the offer stub in step 3 of the write path; channel `hd_csv`), `docs/pro/js/hd-import.js` (one added best-effort call after the pinned one, plus reading the `Internet SKU` column into `altIds`), `docs/pro/js/price-ledger.js` (`recordHdReceipts`), `docs/pro/js/price-offers-ui.js` (Unlinked items list, Link to a product), `script-loader.js` (expenses bundle), `tests/merge-leftovers-guard-2026-10-05.test.js` (allowlist), `functions/tenant-ops.js` (`buildCompanyExport`).
- Tests first: `tests/price-ledger-migrate-2026-11.test.js` (legacy item to offer and observations; a legacy row and its CSV twin are one observation; re-run adds nothing; dry run writes nothing; refuses `--apply` without `--company`); an added case in the hd-import suite that the legacy call and its order are unchanged and the new call can not fail an import; the export tests in section 7.
- Jo sees: his Home Depot purchases under "Unlinked items", each linkable; after linking and setting the pack, "last paid" on the product sheet. He runs the migration himself, or approves that run in chat.
- Dark: same flag. The legacy modal is unchanged.

### Slice 3. Supplier quotes, price sheets, invoices (CSV), the per-product supplier view, expiry warnings

- Goal: scope item (a).
- Files: `functions/price-import-logic.js` + client twin, `docs/pro/js/price-import.js`, `docs/pro/js/price-alerts.js` (read-only inbox), `functions/price-change-logic.js` (`detectChange`, `proposalSource`, `proposalLines`, `quoteExpiryState`), `functions/price-crons.js` (`priceLedgerDailyWatch`), `priceLedgerSave` ops `setConfig` and `confirmObservation`, `scripts/build-product-seed-public.js` + `functions/product-seed-public.json`, rules blocks and emulator cases for `priceAlerts`, `priceImports`, `priceConfig`, the two indexes in section 1.10, heartbeat plan, cron-gates, flags-registry (one env gate: pins 48 to 49 and 56 to 57), HEALTHCHECKS runbook table.
- Tests first: column mapping and presets on synthetic CSVs; a row with no unit is `needs_unit`; per-hundred and per-thousand rows; the stated and per-catalog-unit preview values; the tax rules of section 5.3 (a tax-in row is never compared with a tax-out row; no rate means blocked lines); one `price_change` alert per product with two suppliers' offers, and approving-shaped input does not re-raise from the other offer; an ABC-shaped `compare:false` row never proposes and never opens `supplier_disagree`; a shelf-shaped row alone never opens a proposal; decay opens `requote`, never a cost line; expiry states at 8, 7, 0 and minus 1 days; the cron writes nothing when the gate is off; a re-import of a file with one new row writes one row; a voided batch can be re-imported; server unit-change check.
- Jo sees: an Import screen (supplier, branch, file, column mapping, preview, commit); on a product, one tab per supplier with the current price, its date, its validity and "expires in N days"; an Alerts list (read-only until slice 4). ABC, SRS, QXO, Gulfeagle and MBS all work through this path on day one.
- Dark: the flag for screens; the env gate for the cron.

### Slice 4. Approve a cost change, line by line; own photos

- Goal: decision 3 for the `costs.*` map.
- Files: `functions/price-change-logic.js` (guards and patch), `functions/price-ledger.js` (`priceAlertDecide`, `productPhotoSave`, op `setProductLink`), `docs/pro/js/price-alerts.js` (approve, dismiss, snooze), `docs/pro/js/product-library.js` (`applyApprovedCost`), `docs/pro/js/catalog-costs.js` (`noteApproved`; the per-change write in `recordProduct`), `docs/pro/js/price-ledger.js` (the `productLinks.applied` pass after hydrate), `storage.rules` (product-photos), the `productLinks` rules block and emulator cases, the Storage erasure line.
- Tests first: stale `expect` refused; no tax rate refused; unit changed refused; cost above sell needs `confirmAboveSell` and leaves `cost_above_sell` open; below floor needs the explicit confirm and is audited; only the named field path is written (labor, other tiers, other maps byte-identical before and after); a sell is never in a patch; no cost book refused; no entry creates one and says so; approve then recompute opens no new alert; two approvals racing leave one applied; viewer, rep and manager refused; the device tests in section 6 step 8; the storage rules suite with the hand-off case; tests/catalog-cost-seed.test.js extended for the per-change write, CLEAR cases still green.
- This is pricing-adjacent: run the full estimate suites named in CLAUDE.md rule e, expecting zero diffs, and say so in the PR.
- Jo sees: an alert with "was / now / change", the margin after the change, and Approve per line; the Product Library margin updates on that device at once and on his other devices at their next load; a photo on a product.
- Dark: the flag. No customer total changes (D6).

### Slice 5. Live check, dry

- Goal: scope item (b), first half, with no key.
- Files: `functions/integrations/price-adapter.js`, `price-adapter-fixture.js`, `functions/price-check.js` (`priceCheckNow`), `functions/paid-gate.js`, killswitch entry, the three server-only rule blocks, the TTL override, one env gate (pins 49 to 50, 57 to 58), a "Check today's price" button on an offer, the `latest.shelf` and `lastCheck` fields in `summarize`.
- Tests first: every row of the edge-case table in 3.3 against hand-built fixtures; reserve, settle, release; cap reached returns `resource-exhausted` before any fetch; dry run spends and writes nothing; cache hit keeps the original time; a `compare:false` adapter stamps the row; the cache refuses account prices; a shelf row is L5, shows as "shelf today", and never becomes `best` while any paperwork row exists; the ghost guard on `priceCheckNow` (a claim-less former owner spends nothing from the company's cap).
- Jo sees: the button, answering "Live checks are not switched on yet" in production, and a full answer against the fixture adapter in the emulator.
- Dark: env gate off, per-tenant `enabled` absent, client flag.

### Slice 6. The chosen retail vendor, the weekly refresh, retailer thumbnails

- Needs: Jo's 20-SKU result and one key (section 9). Then: `price-adapter-<vendor>.js` with fixtures hand-built in that vendor's response shape (section 7; a recorded response stays in `.local/`); `RETAIL_DATA_API_KEY`; `priceRefreshCron` (one env gate) with the `nextCheckMs` index and its never-checked test; optional thumbnail copy-in. Pilot: NBD only, by hand edit of its config doc and a flag PR to `functions/.env.nobigdeal-pro`.

### Slice 7. Materials list reads real prices and says where to buy

- Goal: scope item (c). Per line: the linked product's `bestComparable` per supplier (price, date, level), a purchase quantity and total, a store chosen by `supplierAccounts.preferredFor` and then `bestForProduct`; "No price yet" where there is none; the tenant's suppliers replace the two hard-coded names (materials-list.js:23-24); `MAT DEL` and other non-purchase codes leave the buy list. ABC API prices show only under ABC and are never ranked against another store.
- Quantity for a priced line comes from the offer, not from the list's own `RULES` (materials-list.js:28-45, whose `per` assumes 3 bundles per square, 10-ft pieces, 10-square rolls): convert the line quantity to the product's catalog unit, then `buyQty = ceil(catalogQty * den / num)` purchase units from the offer's pack, and the total is `buyQty * priceMicros / per`, in integers, shown through `microsToCents`. `RULES.per` is used only for lines with no price. When the line's unit can not be converted to the product's catalog unit, the line shows "No price yet". Until slice 10 gives exact line-to-product links, a line is priced only when its sub-category resolves to exactly one linked product; otherwise it shows the estimate's own cost as the fallback, labelled.
- Tests first: an offer whose pack differs from the rule (a 12-ft piece, a 4-square roll) gives the offer's quantity and total; two linked products in one sub-category give "No price yet".
- Tests that move: tests/materials-list-2026-10-02.test.js (store grouping and the total); tests/production-flow-2026-10-04.test.js stays (orders still carry no money; the copied text still has no prices).

### Slice 8. Price index and trends

- Goal: scope item (d). `ppiSync` (BLS API v2, one POST a day, last 12 months re-pulled, one env gate) into `price_index_ref`; `price-index-logic.js`; a server-kept `priceRollups/{YYYY-MM}` (monthly median per category, rebuilt by the daily watch for the months it touched); the Trends tab: category tabs, two lines rebased to 100 (national PPI, my cost), markers from `priceNotices`, top SKUs by spend, and the two action lists (quotes expiring, estimates priced before the latest increase). The tenant line is built from receipts, invoices and quotes only: every `*_api` and `live_shelf` row is excluded (D7 and research). The tab reads rollups, never raw observations.

### Later slices (order fixed, detail when reached)

| # | Slice | Blocked on |
|---|---|---|
| 9 | PDF and photo import through `supplierDocRead` (line schema with item number, quantity, unit, unit price; draft rows only) | nothing external; AI spend gates |
| 10 | Line-code map (built on `PRODUCT_MAP`) and approval into `xactCosts` / `jtCosts` | Jo's OK per CLAUDE.md rule e; estimate suites; a decision on a floor for cost-plus lines |
| 11 | ABC adapter, own account, client credentials, with the two-place tenant pin | Jo's sandbox and production credentials |
| 12 | Per-tenant secrets and ABC OAuth per tenant | ABC aggregator approval; Secret Manager grant |
| 13 | Opt-in auto-apply | six weeks of approved changes to set a sensible cap |
| 14 | Retire the legacy doc (`leadSkus` replaces `hdSkusForLead`'s source) | prod parity check |
| 15 | SRS adapter (SIPS) | SRS credentials and an Integration Key |
| 16 | QXO adapter | QXO's written OK for a multi-tenant product; their Q1 2027 replatform |
| 17 | "And more": per-store purchase orders from the list, delivery and proof-of-delivery filing, invoice against order check, manufacturer increase calendar prompts, Menards | each its own decision |

## 9. Jo's to-do list (only he can do these)

| # | Action | What to send or do | What comes back |
|---|---|---|---|
| 1 | ABC developer portal, Individual Business track | Sign up at the ABC Partner Developer Portal with the business email; create an organisation and an app; accept the API terms | Sandbox client id and secret the same day. Then "Production Request" with the ABC account number and the email of a myABCsupply user on that account: 1 to 2 business days by ABC's guide |
| 2 | ABC API Support, in writing | Four questions: (a) may a contractor's own cost book show an ABC API price beside his other suppliers' prices for the same item; (b) may item images be cached and shown inside a logged-in tool; (c) any fee; (d) is a small multi-tenant CRM accepted on the Third-Party Aggregator track, and what the demo needs | A written answer. Until (a) is yes, D7 stands |
| 3 | SRS | Email the SIPS API support address in the SIPS docs: company name, use case (CRM for roofing contractors: account pricing, invoices, later ordering), technical contact, environment QA. Separately check Roof Hub, Integrations, for an Integration Key, or ask the branch | QA client id, secret and base URL; the account number and key |
| 4 | QXO | The API request form as an existing QXO.com customer, for internal use. Ask the rep: is a paid multi-tenant product allowed, and does the API survive the Q1 2027 replatform | Access for NBD's own use, and a written position on tenants |
| 5 | Gulfeagle (Sharonville) and MBS (Cincinnati) reps | Ask each: can price sheets come as a spreadsheet on a schedule, can invoices be exported as CSV or PDF from the portal, do quotes state a valid-through date and a unit per line, and is the price delivered or picked up | A sample file each. Keep them out of the repo |
| 6 | One sample export from each portal | myABCsupply, Roof Hub (Billtrust), QXO.com, the Gulfeagle portal, Lowe's Pro purchase history: one invoice as PDF and, where offered, CSV; one emailed quote per supplier | The column layouts the import presets are written against. Upload through the CRM or keep in `.local/`; never commit |
| 7 | Retail vendor free tiers | Create free accounts: SerpApi (250 searches a month), OpenWeb Ninja (100 a month), Unwrangle trial, Bright Data (5000 records a month), Oxylabs trial, Apify (5 dollars credit). Re-check each price page first | Keys for the test only. Give them to the test script through the environment, never a file in the repo |
| 8 | The 20-SKU accuracy test | Pick 20 items he really buys, 10 at his Home Depot store and 10 at his Lowe's: two shingle bundles, one synthetic underlayment roll, one ice and water roll, drip edge 10 ft, coil nails box, cap nails, a pipe boot, ridge vent, roof cement tube, OSB sheet, two lumber sizes, a caulk, plus six of his choice. For each: store number, SKU or item number, and a same-day photo of the shelf tag | A sheet per vendor: price equal to the tag or not, whether the store id changed the answer, UPC and model present or not, failures out of 20, seconds per lookup, image link present. The vendor decision follows from it. The SKU list, the tag photos and the result sheet hold real prices: they live in `.local/` or a Drive sheet, never in a tracked file |
| 9 | Home Depot and Lowe's official asks | Pro Desk or Pro Xtra account manager: who handles the software integration Jobber and JobTread use, and can Preferred Pricing be exported. Lowe's: register the business on developer.lowes.com, or ask the Pro rep for the partner team | A contact or a no. Free, and the only route to contract pricing |
| 10 | Store and branch facts | For each supplier NBD uses: branch or store number, zip, the preferred one, and which categories he buys where | The first `supplierAccounts` rows, typed into the new screen |
| 11 | Decisions | (a) NBD's floor, to be written to NBD's config; (b) NBD's purchase tax rate for the cost basis: required before any cost change can be approved (0 means the cost book is before tax); (c) the alert threshold (2% proposed); (d) whether managers may record prices (proposed yes; a manager's typed price is a note until he or a company admin confirms it); (e) whether sales reps may see supplier prices on offers (proposed yes, R13); (f) whether a floor applies to cost-plus lines when slice 10 comes | Values for `priceConfig/main` |
| 12 | Switches, each by him or approved per run | Set `feature_flags/{uid}.supplierPricing` for himself and for each admin or manager who should use it (the flag is per person); approve the migration `--apply`; hand edit `integrations/pricing/companies/{NBD}`; `firebase functions:secrets:set RETAIL_DATA_API_KEY`; the flag PRs to `functions/.env.nobigdeal-pro`; later the Secret Manager grant in the console | The pilot is on for one tenant |
| 13 | BLS | Register a free BLS API v2 key | `BLS_API_KEY` for slice 8 |
| 14 | Optional | A lawyer's view on showing retailer thumbnails inside a logged-in tool, before slice 6 turns them on | Yes or no for `retail.photos` |

## 10. Open risks and assumptions

Risks:

| # | Risk | Handling |
|---|---|---|
| R1 | The retail data vendors scrape. Retailer terms forbid automated access; the route is a grey area and can break (Buildertrend's Home Depot price sync was retired 2026-07-17) | Pilot, one tenant, flag off by default, caps, a deep link beside every price, the adapter swappable. A shelf price is L5, is shown as its own "shelf today" figure, never proposes a cost on its own and never auto-applies |
| R2 | ABC's comparison clause may cover even a per-supplier view inside a cost book | D7 until the written answer; the adapter is not built before it |
| R3 | The shared shelf cache may breach the chosen vendor's terms once a second tenant is on | Re-read the terms before enabling tenant two; the cache key can take a tenant prefix with one line |
| R4 | First server writer of `catalogCosts`; a stale device can overwrite an approved cost, and an edited product does not pick up a cost changed elsewhere | Section 6 step 8: per-change client writes, `applyApprovedCost`, the `productLinks.applied` marker, update-time precondition on the server |
| R5 | `costs.*` approvals change no quote, which may read as "it did nothing" | The alert says which screens the change affects. Slice 10 is the one that reaches quotes, deliberately late |
| R6 | Unit data is thin: `coverage` is null on 55 seed rows and three coverage tables disagree; catalog and purchase unit names differ | Unknown is a first-class state; an explicit unit map; nothing converts without a person's confirmation; the product's current unit is re-checked before anything is written |
| R7 | The engine's quantity rules are still wrong in seven known ways (sweep note :98-113), so accurate prices times wrong quantities still mis-size an order | Out of scope here; listed in the slice 7 note as a dependency for a trustworthy basket |
| R8 | Markup, overhead and profit are per user, and Job Templates ignore them, so slice 10 would re-price differently by entry point | Must be settled before slice 10 |
| R9 | Count pins and shared lists make these PRs collide with parallel work | Section 8.0; one gate per PR where possible |
| R10 | A new callable can be dropped on its first deploy | Verify with `gcloud` after each slice that adds one |
| R11 | Tenant erasure does not cover company-keyed cost docs today | Slice 1 covers the new tree and reports `catalogCosts` / `productLibrary` as a finding |
| R12 | Legacy history rows have no branch and no unit | Migrated as `paid`, pack unknown, `locationId: null`, not attested; they show as "last paid" but can not propose a cost until a person sets and verifies the unit |
| R13 | Read exposure: a sales rep sees the best price per offer, including an account price | Decided (D4), and flagged for Jo. If he wants reps to see no cost, change `plMember` to `plStaff` on `priceOffers` and `supplierAccounts`: two lines, one test |
| R14 | The write path is not atomic across the rows of one call | Every step is idempotent and `latest` is always rebuilt from a full read (section 3.1.2); tested with interleaved and half-written calls |
| R15 | A manager can still import a CSV whose rows say `paid` | Such rows are `attested: false`: they can raise an alert, which an owner or company_admin approves line by line seeing who imported it, and they can never auto-apply |
| R16 | Slice 1 has no server check that a product's unit changed after the pack was set | Slice 1 writes nothing to the cost book and the sheet checks it on screen; the server check lands in slice 3, before the first proposal exists |

Assumptions I made:

1. `manager` may record observations but not approve, link or configure; a manager's typed row is stored as `manual` until an owner or company_admin confirms it. Jo did not say.
2. The alert threshold defaults to 2% and the unit-swap band to 15%. Both are tenant settings or constants in one file.
3. A live shelf price is the ladder's L5 "public web price" at any age. An account price read by a person or an API is L2 for 7 days. The sweep note has no row for either age.
4. A proposal may come from L1 evidence or from a fresh L2 own-account price. One reviewer asked for L1 only; an account price returned by a distributor's API is the price the tenant will be invoiced, so it is allowed to propose (never to auto-apply).
5. Cost basis includes sales tax (the 2026-08-19 rule) and the tenant must choose its rate before anything can be approved.
6. A cost above the sell can be approved with an explicit confirm, as the product modal already allows, and leaves a `cost_above_sell` alert open.
7. The owner may tap "Use this price" on a shelf alert. That is an owner approving one line, which decision 3 allows; nothing does it automatically.
8. The pilot's ABC credentials are NBD's own and are pinned to NBD's companyId in two places.
9. Secret Manager, not KMS envelope encryption, for per-tenant secrets. It needs a dependency and a console grant.
10. The research facts (vendor prices, API terms, rate limits) were read from search extracts only; every one must be re-read on the live page before code depends on it.
11. Whether NBD has `xactCosts` in prod is unknown from the repo; slice 10 must read it first.
12. The `prl` prefix and the collection names are free at 46348a4; re-grep before use.
13. Heartbeat: the new crons join the shared `daily-syncs` check rather than taking a new one.
14. When a solo owner erases the account, the whole price ledger goes with it; a member's erasure removes nothing from it.

## 11. Review findings not adopted

47 findings came back (5 blockers, 26 major, 16 minor). Each blocker and major was checked against the repo at 46348a4 and every one held, so none is rejected outright. Five were adopted in a different form from the fix proposed:

| Finding | Proposed | What the spec does instead, and why |
|---|---|---|
| Level decay (major): "raise `price_change` proposals only from L1 evidence" | L1 only | L1, or L2 from the tenant's own account (`portal_read`, `api_account`, at most 7 days old). A distributor API's account price is the reason decision 2 exists; shutting it out of proposals would make slices 11, 15 and 16 display-only. It still never auto-applies, and an ABC API row still never proposes (D7). The flapping the finding describes is gone either way, because a row that decays never proposes |
| Rounding (major): "alternatively allow four decimals in the book for SF, LF and EA units" | either fix | The first fix only: both sides compared in whole cents, and a value that rounds to zero is blocked. Four-decimal book values would be a second money format in a document other code already reads |
| Units (blocker), part (b): "have the server resolve the product's current unit, needed from slice 1" | server resolver and a generated seed file in slice 1 | The explicit unit map and the corrected suggestion rule are in slice 1. The server resolver and its generated file land in slice 3, with the first code that can propose a cost; slice 4 re-checks inside the approval transaction. In slice 1 nothing is written to the cost book, the pack can only be set by an owner or company_admin who has the product on screen, and the sheet hides per-catalog-unit figures when the units no longer match. This keeps slice 1 small, which the task requires, and is listed as R16 |
| obsId (major): include `observedOn` and `locationId`, and `doc.line` | hash of offer, kind, doc type, ref, line, date, price | The date and the stated unit are in the hash. `doc.line` and `locationId` are left out: the legacy doc has neither, so including them would break the "legacy row and its CSV twin are one observation" test the same finding asks for. Two branches' price sheets are kept apart by putting the branch in the generated document reference |
| Export (major): "export the tree only when the caller is the tenant's owner" inside `exportMyData` | a role gate inside the per-uid export | The ledger is kept out of `exportMyData` altogether and added to `exportCompanyData`, which is already gated by `requireTeamAdmin` and already has a cap with a truncation note. One fewer role gate to get wrong |

Not changed, and noted where it lives: rules let every staff member and sales_rep read all offers of a product, so the ABC separation is enforced in what the server computes and the screens show, not in who can read (section 7, ABC row). The reviewer raised it as part (d) of a finding whose other parts were adopted.

## 12. Slice 1 implementation checklist

Written for an engineer who has not read the recon. Read sections 1.2 to 1.6, 2, 3.1 and 5 of this document first. Everything below is one PR on a feature branch (CLAUDE.md rule c); nothing here needs a credential, and nothing here can change a customer total: no estimate file, `catalogCosts`, `catalog-costs.js`, `price-book.js`, `hd-import.js` or the legacy `priceBook/{companyId}` doc is touched. If a step seems to need one of those, stop and ask.

Fixture rule for every file you write: fictional suppliers (`Testco Supply`, `Example Depot`), SKUs that start `TEST-`, and every input price a multiple of 1111 (for example `priceMicros: 11110000`). A derived expected value is computed in the test, or its line ends `// derived`.

### A. Before any code

1. Branch from `main`. Re-grep that nothing took the names since 46348a4: `grep -rn "data-prl-action\|priceOffers\|priceObservations\|supplierPricing" docs functions firestore.rules` must return nothing.
2. Create `documentation/projects/LIVE-SUPPLIER-PRICING-2026-11-17.md`: Jo's four decisions of 2026-11-17, the constraints, the slice list from section 8, the rules of sections 1.6 and 2.3. Counts, dates and rules only; no price, no cost. The flag registry test requires this file to exist.
3. Link it: `node scripts/index-anchor.js index --section "Projects & planning" --line "<the INDEX line for LIVE-SUPPLIER-PRICING-2026-11-17>"`. Add a dated update line at the top of `documentation/projects/STORE-PRICE-BOOK-PLAN-2026-10-02.md` saying the "no paid data service" decision was reversed on 2026-11-17, with a relative link to the new note.

### B. Tests first (write all four, watch them fail, then write code)

4. `tests/fixtures/pricing/ledger-basic.json`: one supplier account, two offers (one `BDL` to `SQ` at 1/3, one with pack unknown), eight observation inputs covering each caller kind.
5. `tests/price-logic-2026-11.test.js` (bucket `node`). Load `functions/price-logic.js` with `require`, and `docs/pro/js/product-data.js` and `docs/pro/js/price-book.js` in a `vm` for `NBD_UNITS` and `keyFor`. At most 5 source-text assertions (the source-pin ratchet). Cases:
   - Units: every `NBD_UNITS` key is the image of exactly one purchase unit in `CATALOG_UNIT_OF` or is in `NO_PURCHASE_TWIN`; `sameUnit('BDL','BDNL')` true; `sameUnit('CTN','CT')` false; `normaliseUom` for bundle, roll, "per C", "/M", and an unknown string (null).
   - Money: `moneyTextToMicros` for 0, 2, 4 and 6 decimals and for junk; `toCatalogMicros` for every row of the table in section 5.2; a price stated per catalog unit comes back unchanged with `stated_per_catalog_unit`; `per: 100`; unknown pack gives null; a mismatched unit gives null with `unit_mismatch`; an unsafe integer gives null.
   - `suggestPack`: `RL` to `RL` with `sqPerRoll` present suggests 1/1; `BDL` to `SQ` with `bundlesPerSq` suggests 1/that; `PC` to `LF` suggests nothing.
   - `evidenceLevel`: one millisecond either side of 60 days (paid), `validThroughMs`, `quoteValidDays` for an undated quote, 7 days (`portal_read`); `live_shelf` and `manual` are L5 at any age; every kind returns a level.
   - Ranking: paid 59 days ago (low) against paid yesterday (high) gives yesterday; a newer quote replaces an older still-valid one from the same supplier and branch; a two-day-old `live_shelf` never beats a 61-day-old paid row; `manual` never beats paperwork; `bestComparable` ignores a `compare:false` row and `best` does not; voided and null-`catalogMicros` rows never rank.
   - `suspectUnitSwap` at 3 to 1 and 1 to 3; skipped for a 6/5 pack; with no reference, flagged when above the sell.
   - Ids: `offerIdFor(store, sku) === keyFor(store, sku)` for the five legacy stores with clean SKUs; `12/34` and `1234` give different ids; an empty SKU gives the hashed form; an `other_testco` id keeps its underscore. `obsIdFor` changes with `observedOn`, with `statedUnit` and with `priceMicros`, and not with `qty`.
   - Sanitizers: each bad field of an offer, an account and an observation is refused with a reason; a `url` on the wrong host is refused; unknown keys are dropped.
   - `summarize`: `recent` capped at 8 with `cmp`; `nextReviewMs` is the earliest boundary; `count` capped at 200 with `countCapped`; `lastPaid`; `prevBest`.
   - `flagOn`: only the boolean `true`; a string does not turn it on.
   - Parity: the text between `// ---- BEGIN SHARED` and `// ---- END SHARED ----` is byte-identical in `functions/price-logic.js` and `docs/pro/js/price-logic.js`.
6. `tests/price-ledger-server-2026-11.test.js` (bucket `node`). Copy the stubbing approach of `tests/receipt-inbox-server-2026-11-04.test.js` (fake Firestore, fake Auth, fake rate limiter). Cases, each asserting the number of writes:
   - Gates, on both callables: unauthenticated; a ghost (no claims, `companies/{uid}.ownerId` is someone else) refused with zero writes; viewer refused with zero writes; rate limit; a subordinate role with no companyId claim; `sales_rep` and `member` refused; flag off; flag read error.
   - Roles: manager refused on `priceLedgerSave` and allowed on `priceLedgerRecord`; owner and company_admin allowed on both; the platform admin acts on their own tenant; a `companyId` in the request data is ignored.
   - Provenance: a manager's typed `paid` row is stored as `manual` with `claimedKind: 'paid'` and `attested: false`; an owner's is stored as `paid`, `attested: true`; `live_shelf` and `api_account` from a caller are refused; caller-sent `compare`, `attested`, `source`, `latest`, `levelAtWrite`, `catalogMicros`, `productId` are ignored.
   - Limits: 501 rows refused; the 5000-a-day counter refuses the call that would pass it.
   - Write path: unknown offer rejected, other rows written; a duplicate row does not fail its neighbours; a retry of a half-written call writes only the missing rows; two interleaved appends on one offer leave `latest` built from both; void then re-record gives `-r1` with `supersedes`.
   - Save ops: `upsertOffer` on an existing offer sends field paths and never `latest`; `linkOffer`, `verifyPack` and `voidObservation` each write one `priceAudit` row; `voidObservation` rebuilds `latest`.
7. `tests/firestore-rules.price-ledger.test.js` (bucket `wired-individually`). Copy the harness of `tests/firestore-rules.receipt-inbox.test.js`; project id `nbd-priceledger-test`. Cases 1, 2, 3, 4, 5, 6, 7, 8, 9 and 10 of section 2.4 (the "slice 1" rows).
8. `tests/price-fixture-privacy.test.js` (bucket `node`). The scan in section 7, first row, with scope prefixes `price-logic-`, `price-ledger-`, `price-import-`, `price-change-`, `price-check-`, `price-index-`, `price-fixture-`, plus `firestore-rules.price-ledger.test.js` and `tests/fixtures/pricing/`. Also assert: every `tests/price-*.test.js` on disk is in scope or is exactly `price-book-2026-10-02.test.js`; no `docs/pro/js/price-*.js` or `docs/pro/css/price-*.css` appears in `STRICT_EXEMPT` of `tests/catalog-cost-privacy.test.js` (read that file as text; do not edit it); no new file outside `functions/price-logic.js` and its client twin contains `/ 100`, `* 100`, `parseFloat(` or `toFixed(`.

### C. Server

9. `functions/price-logic.js`: the slice 1 exports in section 3.4, all pure, the shared part between the two SHARED marker comments (copy the marker text from `functions/receipt-inbox-logic.js:29` and `:513`). `FLAG_NAME = 'supplierPricing'`, `FLAG_DEFAULT = false`. The file must contain the string `'supplierPricing'` (the registry test greps for it).
10. `functions/price-ledger-store.js`: `appendObservations`, `recomputeLatest`, `writeAudit`, `saveOps`, exactly as section 3.1.2 and the two bullet rules at the end of section 1.4. Every path is built from the `companyId` argument; no function takes a path.
11. `functions/price-ledger.js`: `priceCaller` (section 3.1.1) and the two callables. Each export is a literal `exports.priceLedgerSave = onCall(OPTS, withSentry('priceLedgerSave', require('./tenant-guard').wrapCallable(handler)))` (and the same for `priceLedgerRecord`); check the nesting order against `functions/opp-decide.js:214-215` and `functions/receipt-inbox.js:84-86`. `OPTS`: `region: 'us-central1'`, `cors: CORS_ORIGINS`, `enforceAppCheck: true`. No kill switch and no entitlement gate in this slice.
12. `functions/index.js`: by-name re-exports of the two callables only, next to the receipt-inbox block (:1164-1169).
13. `functions/FUNCTIONS_INDEX.md`: two rows in the middle of `## ADMIN (role check required)`, naming the gate (owner / company_admin for Save; owner / company_admin / manager for Record), the flag, and "ships dark".
14. `node scripts/gen-function-map.js`, then `node scripts/gen-function-map.js --check`.
15. `functions/flags-registry.js`, `FIRESTORE_FLAGS` (:281-286): add `{ name: 'supplierPricing', default: false, dark: true, file: 'price-logic.js', doc: 'documentation/projects/LIVE-SUPPLIER-PRICING-2026-11-17.md', meaning: '<20 to 260 characters>' }`.
16. `tests/flags-registry-drift.test.js`: change the exact-list assertion at :103 to the three names, and add one assertion that `price-logic.js` exports `FLAG_NAME === 'supplierPricing'` and `FLAG_DEFAULT === false`. The env-flag count pin (56) does not move.
17. `tests/viewer-callables.test.js`: one handler row for each callable (model: :392) and `priceLedgerSave: 'refused', priceLedgerRecord: 'refused'` in `VERDICTS` (model: :473).
18. Erasure: in `functions/integrations/user-owned.js` add and export `COMPANY_KEYED_TREES = ['priceBook']` beside `OWNER_KEYED_DOCS` (:296-307). In `functions/integrations/compliance.js`, `confirmAccountErasure`, solo path: after the owner-keyed docs loop (:911-914) and before `if (failures.length)` (:932), add the `recursiveDelete` step from section 7 using the existing `fail(step, target, e)` helper (:772), only when `scope.mode === 'solo'`. Extend `tests/r4-erasure-export-honesty-2026-10-06.test.js`: the tree is deleted on a clean run, and a failing delete gives a partial erasure. Run `node tests/account-erasure-billing.test.js` and fix a step count if it pins one. Do not touch `exportMyData`.

### D. Rules and index

19. `firestore.rules`: directly after the `priceBook` block (ends :3029), as new sibling blocks, add the comment, the five helpers (`plRole`, `plClaim`, `plMember`, `plStaff`, `plAdmin`) and the five blocks marked "slice 1" in section 2.1, each written on separate lines in the house style. Do not nest them inside `match /priceBook/{companyId} {` and do not edit that block.
20. `firestore.indexes.json`, in `indexes`: `{ "_comment": "Price ledger (2026-11): one offer's history, newest first.", "collectionGroup": "priceObservations", "queryScope": "COLLECTION", "fields": [{ "fieldPath": "offerId", "order": "ASCENDING" }, { "fieldPath": "observedAt", "order": "DESCENDING" }] }`. No other index in this slice.
21. `.github/workflows/ci.yml`: a step copied from :717-721, named "Run price-ledger rules tests under emulator", project `nbd-priceledger-test`, file `firestore-rules.price-ledger.test.js`.

### E. Client

22. `docs/pro/js/price-logic.js`: an IIFE that exposes `window.NBDPriceLogic`, with the SHARED block copied byte for byte from the server file.
23. `docs/pro/js/price-ledger.js`: `window.NBDPriceLedger` = `enabled()` (the pattern at `docs/pro/js/cash-payouts.js:47`, flag `supplierPricing`), `suppliers()`, `offersFor(productIds)`, `history(offerId)` (Firestore reads; a permission error returns an empty list), `saveOffer`, `saveAccount`, `linkOffer`, `verifyPack`, `archiveOffer`, `voidObservation`, `record(rows)`. There is no shared callable helper in the repo: copy the lazy `httpsCallable` pattern at `docs/pro/js/receipt-inbox.js:113-121`. Never throws into a caller. Prices are turned into `priceMicros` with `NBDPriceLogic.moneyTextToMicros`, never `parseFloat`.
24. `docs/pro/js/price-offers-ui.js` and `docs/pro/css/price-ledger.css`: the "Stores & prices" sheet (section 4.3 rows 1 and 2, section 4.4 conventions). One document-level click delegate on `data-prl-action`; CSS prefix `.prl-`; no inline `style` attribute; every supplier string through the five-character escaper; `url` rendered only when it parses as `https:` on the registry host. The sheet shows a level badge per row (computed now with `evidenceLevel`), the price as stated and per catalog unit, "needs a unit" when the pack is unknown, and "The product's unit changed" when `pack.catalogUnit` differs from the product's current `unit`. A manager sees the entry form with the note "Saved as a note until an owner confirms it".
25. `docs/pro/js/product-library.js`: in the card footer (:677-680) add one ghost button, `data-prl-action="openProduct" data-prl-id="<escaped id>"`, class only, rendered only when `window.NBDPriceLedger && window.NBDPriceLedger.enabled()`. Nothing inside the product modal changes. If the cards are drawn before the flag resolves, `price-ledger.js` asks for one re-render through `window._productLib.render` (:1159-1160).
26. `docs/pro/js/script-loader.js`, `estimates` bundle (:264-277): after `'js/price-book.js?v=2'` add `'js/price-logic.js?v=1'`, `'css/price-ledger.css?v=1'`, `'js/price-ledger.js?v=1'`, `'js/price-offers-ui.js?v=1'`; bump `'js/product-library.js?v=16'` (:273) to `?v=17`. Then bump `script-loader.js?v=227` to `228` in both `docs/pro/dashboard.html:146` and `docs/pro/customer.html:2892`. On a rebase conflict take main's number plus one.

### F. Register the suites

27. `node scripts/index-anchor.js manifest --test price-logic-2026-11.test.js --bucket node`
28. `node scripts/index-anchor.js manifest --test price-ledger-server-2026-11.test.js --bucket node`
29. `node scripts/index-anchor.js manifest --test price-fixture-privacy.test.js --bucket node`
30. `node scripts/index-anchor.js manifest --test firestore-rules.price-ledger.test.js --bucket wired-individually`
31. `node scripts/run-test-manifest.js --check`. When it says `FLOORS` is stale it prints the replacement line: paste it at `scripts/run-test-manifest.js:483` and add one dated history line above it ending "MEASURED via --check". Never use `--bucket smoke` with index-anchor: that bucket is an object and the tool refuses it.

### G. Commands to run before the PR

```bash
node tests/price-logic-2026-11.test.js
node tests/price-ledger-server-2026-11.test.js
node tests/price-fixture-privacy.test.js
node tests/price-book-2026-10-02.test.js            # the pinned legacy suite, must be unchanged and green
node tests/flags-registry-drift.test.js
node tests/viewer-callables.test.js
node tests/functions-lazy-load-2026-10-04.test.js
node tests/r4-erasure-export-honesty-2026-10-06.test.js
node tests/account-erasure-billing.test.js
node tests/catalog-cost-privacy.test.js
node tests/firestore-index-coverage-2026-10-04.test.js
node tests/merge-leftovers-guard-2026-10-05.test.js
node tests/inline-style-ratchet-2026-10-01.test.js
node tests/source-pin-ratchet.test.js
(cd tests && env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npx firebase-tools emulators:exec --only firestore --project nbd-priceledger-test 'node firestore-rules.price-ledger.test.js')
node scripts/gen-function-map.js --check
node scripts/check-js-syntax.js
node scripts/check-inline-html-scripts.js
node scripts/check-site-integrity.js --quiet
node scripts/check-vault-index.js
node scripts/run-test-manifest.js --check
node scripts/run-test-manifest.js --bucket node
node tests/smoke.test.js
node scripts/pr-preflight.js
```

The `--bucket node` run includes every estimate suite named in CLAUDE.md rule e. They must pass with no change; if one moves, this slice touched something it must not, so stop.

### H. PR body and after merge

32. In the PR body: "ships dark behind `supplierPricing`; no estimate, cost-book or legacy price-book file changed"; the list of the four new suites; the two cache-key bumps; the assumptions in section 10 that the code relies on (1, 3, 14).
33. Do not commit lockfile drift from `tests/` (CLAUDE.md). No secret, no `.env` change, no `--apply` script in this slice.
34. After the deploy: `gcloud functions describe priceLedgerSave --region us-central1` and the same for `priceLedgerRecord` (a new function can be dropped on its first deploy). Then Jo sets `feature_flags/{his uid}.supplierPricing = true` and types his first store and price.
