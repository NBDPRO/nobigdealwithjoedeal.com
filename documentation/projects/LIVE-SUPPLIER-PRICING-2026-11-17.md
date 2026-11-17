# Live supplier pricing: decisions, recon and handoff (2026-11-17)

Jo, 2026-11-17: "make CRM pricing live with my suppliers and be able to live
check supplies like Home Depot and Lowe's pricing for items as well as SKUs
and photos and more. Let's build big here."

This session did the recon and the design. **No code was written and nothing
in production changed.** This note is the lane handoff: start slice 1 from
the checklist in section 12 of the design.

- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md)
  (data model, rules, server, client, units, slices, the slice 1 checklist).
- Earlier plan this supersedes in part:
  [STORE-PRICE-BOOK-PLAN-2026-10-02](STORE-PRICE-BOOK-PLAN-2026-10-02.md).
- Latest pricing work before this:
  [SUPPLIER-PRICING-SWEEP-2026-11-09](SUPPLIER-PRICING-SWEEP-2026-11-09.md).

As in the sweep note, **this note carries no cost, labor or margin figure**.
Dollar amounts below are vendors' published service prices, not material costs.

## Jo's decisions (2026-11-17, in chat)

| Question | Decision |
|---|---|
| Home Depot / Lowe's live shelf prices | **Reverses the 2026-10-02 "no paid data service, never scraping" decision.** A paid third-party product-data service is allowed as a pilot: NBD only, behind a flag that is off by default, called only from a Cloud Function, after a 20-product accuracy test on free tiers. We never scrape the retailers ourselves. |
| Distributors | Everything, now and later: structured import of quotes, price sheets and invoices for all five immediately; ABC, SRS and QXO API access applied for in parallel. |
| What a new price may change | Delegated to the session, decided: every price lands in a dated history and raises an alert; an owner or company admin approves a cost-book change line by line. Auto-apply is a later opt-in rule, off by default, for exact-match, unit-verified, paid-or-quoted prices inside an owner-set cap. A sell price is never changed automatically. |
| What to build | All of it, foundation first: supplier import, live check, materials list with real prices, a price index screen, "and more". |
| ABC and comparison | Jo does not want to raise the comparison question with ABC. The session's position: the ABC application wording states the use accurately, and ABC **API** prices stay in a per-supplier view (out of side-by-side comparison and out of cost proposals) until the API terms are read in full. Prices from Jo's own ABC quotes and invoices are his records and compare freely. |

## What exists today (recon, repo at 46348a4)

- **Product library:** 276 products (188 base + 88 RoofIVent), spec and retail
  sell only. No store SKU, link, UPC, model number or photo on any product;
  133 of the 188 base rows have an empty `sku`. Phase 2 of the 10-02 plan
  (Stores section + photo field) was never built.
- **Price book:** one document per company (`priceBook/{companyId}`, an
  `items` map), not the subcollection the 10-02 plan describes. One writer:
  the Home Depot Pro Xtra import, and only when the Details CSV is supplied.
  The viewer is read-only. No manual entry, no Lowe's lines (its export is
  order-level), no distributor, no product link (`productId` is never set).
- **Materials list:** reads neither the price book nor the product library.
  Purchase units come from a hard-coded table; "where to buy" is a fixed rule.
- **Server:** no function reads or writes a price anywhere. The CRM's content
  security policy allows no retailer or supplier host for calls or images.
- **Costs and quotes:** `catalogCosts.costs.<productId>` feeds Product Library
  margin displays only. Quotes price cost-plus from `xactCosts` / `jtCosts` /
  `laborOps` / `v2Costs`, and no estimate line carries a product id, so there
  is no map from a product to an estimate line. A write to those maps moves
  every new quote with no review step.
- **The 20% floor** is a decision plus pinned sells; nothing enforces it on a
  write, and its margin test is skipped in CI.
- **PR #2941** (ice & water quantities) was closed unmerged on 2026-11-09. The
  sweep note still says `estimate-logic-engine.js` is "held for PR #2941";
  that hold no longer has an open PR behind it. The seven quantity-rule
  findings in the sweep note are still unapplied.

Recon findings outside this lane, not fixed here:

- `catalogCosts`, `priceBook` and `productLibrary` are not in the tenant
  erasure registry (`functions/integrations/user-owned.js`).
- `scripts/merge-catalog-costs.js` writes a full backup of the private cost
  book to `.local/` on every Firestore-backed run, dry runs included.
- A non-admin's Home Depot import creates expenses but silently records
  nothing in the price book (rules allow only owner / company admin writes).
- A Home Depot receipt imported from the Summary file alone can never gain
  SKU prices from a later import that includes the Details file.
- `catalog-costs.js` still has one historical sell / cost example in its
  header comment, in a public file.

## What the outside world offers

**Limit on all of this:** the session could not open supplier or vendor pages
directly (network policy), so every fact is from search extracts of the named
pages. Re-read prices and terms on the live pages before signing anything.

| Source | Route | Access |
|---|---|---|
| ABC Supply | API: account pricing by branch, catalog with image links, availability, ordering, order status, invoices | Self-serve developer portal with a sandbox. "Individual business" track for one's own account (production review quoted at 1-2 business days); a separate aggregator track (OAuth per contractor) for a multi-tenant product. Terms reportedly forbid direct price comparison tools and repackaging data as market intelligence. |
| SRS Distribution | SIPS partner API (Roof Hub): branch products and prices, orders, delivery status, proof of delivery | By email request to SRS API support; each contractor links with a Roof Hub account number and Integration Key. |
| QXO (was Beacon) | Product, pricing, order, account, delivery-tracking and invoice APIs | Request form for existing customers. Licence limits use to internal systems and forbids charging for access, so the multi-tenant product needs a separate agreement. Replatform targeted for Q1 2027. |
| Gulfeagle, MBS | No API found | Quotes, price sheets and invoices by import. |
| Home Depot | No public API. A private partner integration exists (Jobber, JobTread; Buildertrend's price sync was retired 2026-07-17). | Ask the Pro Desk. Purchase-history export is the durable official route. |
| Lowe's | A developer hub exists (catalog feed, price and availability APIs) | Organisation registration; appears gated to approved partners. |
| Menards | Nothing official | Paid data services only. |
| Paid retail data services | Home Depot: SerpApi, Traject BigBox, Unwrangle, OpenWeb Ninja. Lowe's: Unwrangle, Oxylabs, Bright Data, Apify actors. Menards: Oxylabs, Bright Data, an Apify actor. | Self-serve keys. Estimated about $10-35 a month weekly, $40-65 nightly, for 300 products at two retailers on the cheapest pairing. All are scraping-based: the retailers' terms prohibit automated access and image reuse, so this is a grey area and can break. |
| Price index | BLS Producer Price Index series, free through the BLS API and FRED, monthly, national (asphalt shingle manufacturing `PCU324122324122`, prepared asphalt roofing `WPU1361`, residential construction goods `WPUIP2311001`, and others) | Free registration key. Manufacturer price-increase letters are published by distributors as dated PDFs. |

Photos, safest first: the tenant's own uploads; images delivered through the
tenant's own distributor API account; a retailer thumbnail only inside the
logged-in CRM. Never on a public page or a customer document.

## The design in short

- New tenant price data lives in subcollections under `priceBook/{companyId}/`
  (supplier accounts, offers, observations, alerts, imports, audit). The
  legacy single document stays as pinned until a later slice retires it.
- Every write goes through a Cloud Function; rules grant reads only. The
  server decides a row's kind and source.
- Evidence level L1-L5 (the sweep's ranking) is computed at read time from
  stored facts. Inside one offer the newest row wins; lowest wins only across
  suppliers. A shelf price is shown separately and never proposes a cost.
- Money is integers. Pack conversion is an explicit ratio that is either
  known or unknown; an unknown conversion never ranks or proposes.
- Approval patches `catalogCosts.costs.<productId>.cost.<tier>` only (margin
  displays). Patching the maps that price quotes is slice 10, with a new
  product-to-line-code map, Jo's OK and the rule-e suites.
- Photos are re-encoded into tenant Storage; no CSP host is added.

The design was attacked by three reviewers (data and rules; money and units;
repo gates). 47 findings, 5 of them blockers, all checked against the repo
and adopted (5 in a different form, listed in the design's section 11).

## Slices

| # | Slice |
|---|---|
| 0 | This note and the dated update on the 10-02 plan (done in this PR). |
| 1 | Ledger core: supplier accounts, offers (SKU, link, unit conversion), typed prices into a dated append-only history, the "Stores & prices" sheet; two callables behind the per-person flag `supplierPricing`. No credentials; no cost-book or estimate file touched. |
| 2 | Receipts in: Home Depot import dual-write with store number, the legacy price-book migration script (dry run by default), an Unlinked items list. |
| 3 | Supplier quotes, price sheets and invoices by CSV for the five distributors; per-product supplier tabs; quote-expiry warnings from a daily watch. |
| 4 | Approve a cost change line by line (owner / company admin), with an audit row; the tenant's own product photos. |
| 5 | Live check, dry: the vendor-adapter interface and a fixture adapter, spend caps and a kill switch. |
| 6 | The chosen retail vendor adapter and the weekly refresh; NBD-only pilot. |
| 7 | Materials list reads real prices and says where to buy. |
| 8 | Price index and trends (BLS series, own cost history, manufacturer notices). |
| 9 | PDF and photo import of supplier documents (AI reader, draft rows only). |
| 10 | Line-code map and approval into the maps that price quotes. Needs Jo's OK. |
| 11-12 | ABC adapter (own account), then per-tenant secrets and ABC OAuth. |
| 13 | Opt-in auto-apply, off by default. |
| 14 | Retire the legacy price-book document. |
| 15-16 | SRS and QXO adapters. |
| 17 | Later: purchase orders per store, delivery and proof-of-delivery filing, invoice-against-order check, Menards. |

## Waiting on Jo

Outside actions (none blocks slice 1):

1. **ABC Supply:** sign up on the partner developer portal, individual
   business track. Needs the ABC account number and the myABCsupply login
   email. Keep the API Terms of Use text; the comparison clause decides D7.
2. **SRS:** email API support for QA access; check Roof Hub for an
   Integration Key under Integrations.
3. **QXO:** the API request form, as an existing customer, internal use.
4. **Home Depot / Lowe's:** ask the Pro Desk about the software integration
   Jobber and JobTread use; register on the Lowe's developer hub.
5. **Pilot list:** 20 products bought often at Home Depot and Lowe's, with the
   usual store for each chain. A local session was started on 2026-11-17 to
   export both purchase histories with browser control and produce this list;
   its files stay outside the repo.

Design decisions that are Jo's call (defaults are in the design, section 10):

- Whether sales reps may see a supplier's latest price (the design says yes,
  for the materials list; viewers no).
- Whether managers may record prices (the design: yes, held as a note until
  an owner or company admin confirms; never approve or configure).
- NBD's purchase tax rate, floor value and alert threshold. Needed before
  slice 4, not before.
- Cost above the sell price at approval: explicit confirm (the design) or a
  hard refusal.

## Related

- [STORE-PRICE-BOOK-PLAN-2026-10-02](STORE-PRICE-BOOK-PLAN-2026-10-02.md)
- [SUPPLIER-PRICING-SWEEP-2026-11-09](SUPPLIER-PRICING-SWEEP-2026-11-09.md)
- [RECEIPT-CAPTURE-AUDIT-2026-10-18](RECEIPT-CAPTURE-AUDIT-2026-10-18.md)
- [CATALOG-UNDER-COST-2026-08-19](../audit/CATALOG-UNDER-COST-2026-08-19.md)
