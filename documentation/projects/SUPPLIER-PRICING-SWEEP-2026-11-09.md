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

## Related

- [CATALOG-UNDER-COST-2026-08-19](../audit/CATALOG-UNDER-COST-2026-08-19.md),
  the earlier under-cost audit.
- `scripts/merge-catalog-costs.js` and
  `tests/merge-catalog-costs-2026-11-09.test.js`, the apply tool and its guard.
