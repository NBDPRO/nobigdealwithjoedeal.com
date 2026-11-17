# Supplier pricing sweep, 2026-11-09

A review of NBD's catalog cost book against current supplier paperwork and the
public web. **This note carries no cost, labor or margin figure on purpose**:
the repo is public, and those numbers belong to one tenant
(`catalogCosts/{companyId}`, see `functions/catalog-cost-logic.js`). Every
number below is a count, a date or a quantity rule.

## What was swept

**Jo's own paperwork (214 rows), the master supplier pricing workbook v4 (built
2026-11-04) and the documents behind it:**

- SRS Distribution: two written quotes dated 2026-10-23 (valid to 2026-11-22)
  and two paid invoices (2026-10-19, 2026-10-27).
- ABC Supply (Erlanger branch): portal reads on 2026-11-03/04 (one branch, one
  day, not a quote) and a credit memo (2026-10-19).
- The RoofIVent contract price list (runs 2026-03-18 to 2027-05-01; it matches
  the October invoices).
- Home Depot Pro Xtra, Lowe's and Menards receipts.
- Older material, ranked lower: the expired May ABC quote and SRS price sheet,
  and Gulfeagle tickets from June to September (OCR scans, no price list).
- Crew order quantities on five real jobs (15 to 22 SQ, May to October), used
  for the quantity rules below.

**Public web sweep (297 rows):** Home Depot and Lowe's search-result snippets,
plus other sellers kept as sanity checks only. The retailer and distributor
sites themselves could not be fetched from the session, so no web price was
checked live or localised to a store.

**Coverage, 276 catalog SKUs:**

| | Count |
|---|---:|
| Priced from new evidence | 185 |
| Carry the historical seed cost (no usable evidence) | 91 |
| Match: exact / equivalent / comparable / none | 120 / 34 / 31 / 91 |
| Evidence level chosen: L1 / L2 / L3 / L4 / L5 | 136 / 3 / 11 / 3 / 32 |
| Flagged for review | 180 |
| Tiers the validator refuses (proposed cost above the public sell price) | 36 tiers on 17 SKUs |

## How evidence was ranked

Each row was converted to the catalog unit (per SQ, LF, EA, roll ...) or
dropped if it could not be. Then:

1. **Level.** L1 = paid within 60 days, a valid written quote, or a contract.
   L2 = a portal read. L3 = older paid (age marked). L4 = an expired quote
   (floor or trend only). L5 = a public web snippet (low confidence).
2. **Match.** Exact, then equivalent, then comparable. A comparable stand-in
   (for example a successor product for a discontinued line) is used only
   when nothing better exists, and the SKU is flagged.
3. **Lowest cost per catalog unit** breaks ties.

Pass 1 uses only Jo's own paperwork (L1 to L4); pass 2, only when pass 1 is
empty, admits everything, so an own-paperwork comparable beats a web snippet.
Upgraded grades (better/best tiers) got no invented number: where Drive had no
own-grade evidence they keep the higher of the new cost and the historical tier
cost, flagged. Labor blocks and `defaults` were not touched (materials only).

A SKU is flagged when the source is low confidence, only comparables exist,
suppliers disagree by more than 20%, sell is below cost on any tier, or a
carried cost sits more than 20% below every sanity price.

## Where the private files live

A private scratch folder on the session machine; Jo holds the master workbook
in Drive. Nothing from that folder is committed. It holds the proposal in the
importer's shape, a fallback version that keeps the historical cost on the
refused tiers, the per-SKU change list with sources, the below-cost report, the
template and quantity findings, the labor proposal and the supplier asks.

## The safe apply path

NBD already has a cost book (the 2026-07-30 cutover).
`scripts/import-catalog-costs.js` refuses it without `--force`, and `--force`
would overwrite every SKU edited in the Product Library since then (Firestore
deep-merges nested maps). Do **not** use the importer for this. Two safe routes:

1. **By hand in the Product Library**, SKU by SKU, from the reviewed list.
2. **`scripts/merge-catalog-costs.js`** (added with this note). It writes only
   `costs.<id>.cost.<tier>` for the SKUs you name (and optionally
   `xactCosts.<code>.materialCost`), never labor, `laborOps`, `jtCosts`,
   `v2Costs`, `defaults` or an unnamed SKU:
   - Offline review, no credentials:
     `node scripts/merge-catalog-costs.js --company <id> --in <proposal.json> --only @approved.txt --live <exported-doc.json>`
   - Dry run against the live doc (writes a timestamped backup to `.local/`):
     the same without `--live`.
   - The write, Jo only: add `--yes`, and pass `--expect <the backup you reviewed>`
     so any SKU edited after the review is skipped instead of reverted.
   - A tier whose new cost is above its public sell price is refused and never
     written. Decide those first: raise the sell price, or leave the tier out.

The refused tiers, the Gulfeagle evidence level (L3 vs L1), the grade tiers
with no own-grade evidence and one bundle-size confirmation are decisions for
Jo, listed in the private summary.

## Quantity-rule findings (need `estimate-logic-engine.js`)

Engine quantities were compared with what the crew actually ordered on five
jobs. These are rules, not prices. They all live in
`docs/pro/js/estimate-logic-engine.js` (`QTY_BY_CODE` / `QTY_BY_SUB`), which is
**held for PR #2941**, so none is changed here.

| Line | Engine today | What the crew orders | Proposed rule |
|---|---|---|---|
| Step flashing (`RFG STPF-AL`) | one piece per LF of wall | whole bundles of 100; one or two per job | about 2.2 pieces per LF of wall (5-5/8 in exposure), rounded up to whole bundles; at least one bundle when there is any wall |
| Starter (`RFG STRT`) | eaves only | eaves and rakes, in whole bundles | (eave LF + rake LF), rounded up to whole starter bundles (GAF System Plus and wind ratings want rake starter) |
| Ice & water (`RFG IWS`) | the larger of a share of the roof and one eave course | adds valleys; more on low-slope tie-ins | add a valley term (valley LF x 3 ft) and a second eave course where the overhang is over 12 in |
| Synthetic underlayment (`RFG SYN`) | squares of roof, unrounded | whole rolls | round up to whole 10 SQ rolls after laps (a roll covers about 9 SQ net) |
| Ridge cap (`RFG RIDG-ARC`) | ridge LF | whole bundles, more on hipped roofs | (ridge LF + hip LF), rounded up to whole 25 LF bundles |
| Cap nails (`RFG CAP-P`) | 40 per SQ | one box of 2,000 per job | about 100 per SQ (12 in on laps, 24 in in the field), or one box per 20 SQ |
| Drip edge vs gutter apron (`RFG DRPE-AL`, `RFG GAPR`) | drip edge on eaves + rakes; no apron on the reroof templates | drip edge on rakes and unguttered eaves, gutter apron on guttered eaves | drip edge = rakes + eaves without gutters; add a gutter-apron line for guttered eaves. Same metal, so mostly a scope fix |

Two template findings were checked and **not** applied:

- **Designer / Luxury Shingle template** (`jt_sp_designer_shingle_full`) has no
  coil-nail and no step-flashing line. Adding them (bare codes, no qty, like
  `jt_fr_asphalt_better`) moves the pinned totals in
  `tests/system-plus-standard-and-up-2026-10-05.test.js`, so it needs a PR that
  re-pins those with Jo's OK.
- **Asphalt Reroof Good template** still defaults to GAF Timberline HD, which
  is discontinued. The xactimate catalog (`estimate-catalog-xactimate.js`) has
  no Timberline NS code to point it at, and none was invented. Adding an NS
  line item is its own change.

One public spec fix was applied: Owens Corning Berkshire is 5 bundles per
square in `product-data.js` (it said 4).

## Supplier asks (from the gaps list)

Names and documents only; the details are in the private file.

**Update 2026-11-17:** these asks went out between 11-12 and 11-17 on one
shared request sheet. Status is in "Update 2026-11-17" below.

- **ABC Supply, Erlanger branch:** send Jo's drafted request (Drive, dated
  2026-11-03, unsent) for a written quote with a valid-through date, delivery
  and fuel surcharge, adding the GAF shingle and underlayment lines, TAMKO
  Heritage / Titan XT / StormFighter / HailGuard with current starter and hip &
  ridge, OC and CertainTeed lines if still sold, flashing metals, OSB, and
  Velux flashing kits and deck-mount skylights.
- **SRS Distribution:** re-issue both October quotes before they lapse on
  2026-11-22, with the hold terms in writing, and add the TAMKO lines, GAF
  Timberline NS, ice & water, Velux kits, Tyvek HomeWrap, DuPont flashing
  tapes, trim coil, OSB, and the box and bath vents. Also ask for net terms.
- **QXO / Beacon** and **MBS Supply:** a written contractor price sheet with a
  valid-through date for the core roofing list; from QXO also the line items
  behind the October ice & water invoice.
- **Gulfeagle (Sharonville):** a written price list for the same core list.
- **Siding:** a James Hardie, LP SmartSide, Alside, Mastic or Royal sheet; there
  is none in Drive.
- **Crew and gutter subcontractor:** written rate sheets (labor is mostly lump
  sums today).
- **RoofIVent:** freight per order, which the contract price does not include.

## Update 2026-11-09 (later): the 20% price floor

Jo's call (2026-11-09): every tier of every catalog SKU clears a 20% margin
after labor on the live cost book. Branch `price-floor`; no figure below is a
cost or a margin.

- **Sells (public):** 54 SKUs in `docs/pro/js/product-data.js` had a thin
  tier; 160 tier sells went up, none went down. Each tier rises to the
  smallest whole-dollar (or half-dollar) sell that clears the floor, and a
  tier above a lifted one rises by at least as much, so every SKU keeps its
  good/better/best gaps (the #3021 ladder). The list of SKUs and their prior
  retail sells is in `tests/catalog-price-floor-2026-11-09.test.js`.
- **Devices:** `product-library.js` DATA_VERSION 6 -> 7, with the paired
  cache keys (product-data.js ?v=5, product-library.js ?v=16) and
  script-loader.js ?v=216 on dashboard.html and customer.html.
- **Stand-in costs:** the three stand-ins (TAMKO hip & ridge, TAMKO starter,
  soffit intake vent) were corrected from the exact-product supplier rows in
  the sweep, in a new private import file (v3) in the session scratchpad. Not
  imported anywhere; applying it is Jo's step. Their sells were not lowered.
- **Ridge/hip coverage:** the evidence states the ridge cap's spec, 25 LF per
  bundle (GAF Seal-A-Ridge), so the rate stays 25; the catalog text no longer
  says "about 25".
- **Not changed, for Jo:** RoofIVent sells are the manufacturer's MSRP and
  were left alone, although none clears the floor after labor; a few labor-
  heavy SKUs rose sharply and their carried labor blocks are worth a look;
  `maps-routing.js` sizes hip & ridge with its own 31.7 LF per bundle.
- **Guard:** the new suite checks the raised sells, the ladder gaps,
  DATA_VERSION and the ridge coverage from public data. Its margin check runs
  only when `NBD_PRIVATE_COST_BOOK` points at a private cost-book file, and
  names SKU and tier only.

## Update 2026-11-17: supplier price requests sent

Session of 2026-11-12 to 11-17. As above, **no cost figure**: counts, dates
and names of suppliers only. Nothing in the repo, the cost book or the catalog
changed in this session; this update is the only edit.

**One request sheet for every supplier.** The same 78 lines in the same order
(shingles, starter and ridge cap, ridge vent, underlayment, ice & water,
flashing metals, vents and boots, fasteners and deck, siding and trim,
gutters, low-slope, account terms), one yellow price cell per line, shingles
asked per square. Each supplier got a copy addressed to its rep, so the
answers line up row for row.

| Supplier | What went out | Came back |
|---|---|---|
| QXO / Beacon | The sheet (dated 11-06), then a follow-up for the blanks, the account terms and the unit question | 35 of 78 lines priced; no account terms |
| SRS Distribution | The sheet with 35 of 78 lines prefilled from the two 2026-10-23 quotes, asking the rep to confirm and fill the rest | A reply reached Jo on 11-17; not yet read into the comparison |
| MBS Supply | The sheet with the rep's texted prices filled in (11-12) | Texted prices for 16 items on 11-12 (3 shingle lines, 13 accessories), no brands or terms; the rest is promised |
| ABC Supply, Erlanger | The blank sheet (11-12). This replaces the 2026-11-03 draft, which was never sent | Nothing yet |
| Gulfeagle, Sharonville | The blank sheet (by 11-17). The contact there changed in November | Nothing yet |

**What the answers show so far (may be wrong until confirmed):**

- QXO's shingle prices read as per bundle, not per square as asked; the
  follow-up asks. Every comparison below assumes three bundles a square.
- Of QXO's 35 priced lines, 25 match a line in master workbook v4: 11 below
  the best price on file, 1 level, 13 above. The other 10 are brands the
  master does not carry.
- SRS and QXO split the lines they both priced about evenly (13 each way).
  The one consistent gap is hip & ridge, where QXO is lower on all three
  brands; that is either real or a different bundle size, and it decides
  which of the two is cheaper on the workbook's 13-line sample job.
- MBS is low on its entry shingle line, ice & water, box vent and roll ridge,
  and the highest of all four on drip edge, gutter apron and valley metal.
- ABC cannot be judged yet: its only current numbers are the 11-03 portal
  reads, not a quote on the account.
- Gulfeagle has no written price at all; the summer tickets are the reason to
  ask, not a price to use.

**Still open:**

- The SRS quotes lapse **2026-11-22**. Read the rep's returned sheet first.
- No supplier has given delivered cost on the sheet except SRS (delivery and
  freight per order are on its quotes), so no comparison here is delivered.
- Siding (James Hardie, LP): SRS routes both through the manufacturer's rep
  as special orders; that request is in the SRS cover note.
- Master workbook v4 was **not** updated. The returned sheets are the input
  for a v5; the history rule in v4 (append, never overwrite) applies.
- Crew and gutter-subcontractor rate sheets and RoofIVent freight: not asked
  this session.

**Where the files are.** The request sheets and the comparisons were built in
the session scratchpad and handed to Jo as downloads; none is committed, in
Drive or in the vault unless Jo saved it. The session could read Drive and
Gmail but not iCloud mail or the local vault on Jo's PC, which is where the
master workbook and supplier replies live.

## Update 2026-11-17 (later): the PR #2941 hold

PR #2941 was closed unmerged on 2026-11-09, so "held for PR #2941" above no
longer points at an open PR. The seven quantity-rule findings are still
unapplied. The live supplier pricing lane starts at
[LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md).

## Update 2026-11-17 (later): the floor moves from 20% to 30%

Jo set the margin floor after labor at 30% (35% is the target, not the
floor). Built on branch `claude/catalog-30pct-floor-2026-11-17`:

- **What moved:** retail sells only, on 82 `product-data.js` SKUs (238 tier
  sells). 135 tiers were under 30% on the live cost book; 103 more move only
  to keep their good/better/best gap above a lifted tier. No sell went down.
  The SKUs and their before and after retail sells are listed in
  `tests/catalog-price-floor-30-2026-11-17.test.js`.
- **Devices:** `DATA_VERSION` 8, with `product-data.js?v=6`,
  `product-library.js?v=18` and `script-loader.js?v=229`. Same migration
  rules as versions 6 and 7: rows a user edited, added, archived or deleted
  are kept as they are.
- **Not covered:** RoofIVent SKUs (`roofivent-catalog.js`) stay at MSRP. Most
  of them sit under 30% after labor; that needs its own decision from Jo.
- **Not checked in CI:** the margin itself. It needs the private cost book
  (`NBD_PRIVATE_COST_BOOK`); the list was computed from the live book on
  2026-11-17 and is kept outside the repo.
- The 20% suite's exact pin is now a lower bound; the 30% suite holds the
  exact sells.

## Related

- [CATALOG-UNDER-COST-2026-08-19](../audit/CATALOG-UNDER-COST-2026-08-19.md),
  the earlier under-cost audit.
- `scripts/merge-catalog-costs.js` and
  `tests/merge-catalog-costs-2026-11-09.test.js`, the apply tool and its guard.
