# Estimate margin floor: findings and the agreed plan (2026-11-17)

Status: **a plan Jo agreed in chat on 2026-11-17. The floor warning is not
built.** The line-cost importer (step 3 below) is built on branch
`claude/line-cost-import-2026-11-17`. This note carries no cost, price or
margin figure of the company's; the figures are in a private report on Jo's PC.

- Lane: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md)
- The catalog floor that prompted it:
  [SUPPLIER-PRICING-SWEEP-2026-11-09](SUPPLIER-PRICING-SWEEP-2026-11-09.md)
  (30%, DATA_VERSION 8, PR #3134).

## What the check found (read-only, 2026-11-17)

The 30% catalog floor does not, by itself, make an estimate clear 30%.

- **Catalog sells reach an estimate only through the classic estimator**, and
  only for the nine products in `PRODUCT_MAP` (`docs/pro/js/product-library.js`).
- **The line-item engine prices cost-plus** (`estimate-logic-engine.js`
  `resolveEstimate`, and the same ladder in `estimate-builder-v2.js`): material
  cost plus the material markup, labor at cost, then overhead and profit on
  top. Labor only ever picks up overhead and profit, so the more labor in a
  line, the thinner it is. At the shipped defaults a labor-heavy line can not
  reach 30%.
- **The company's cost book holds no line costs** (`xactCosts`). So the
  line-item builder and the job templates price every coded line from the
  published starter baseline, and the margin they show is a margin over that
  baseline, not over what the company pays. No screen writes `xactCosts`, and
  `scripts/merge-catalog-costs.js --xact` only updates the material cost of an
  entry that already exists.
- **The on-screen margin counts sales tax as margin**: `marginPct` is
  `(total - hardCost) / total`, and `total` includes tax.
- **The per-square builder** measures margin against the cost per square the
  owner entered (`costBasis`). Jo's blanket answer recorded those as including
  labor, tear-off and dump fees; that was not checked.
- **RoofIVent**: no estimate path reads a `riv_*` catalog row. RoofIVent reaches
  a customer price through one hard-coded line in `estimate-builder-v2.js` and
  one catalog item (`RFG RIDG-VNT-PR`).
- The CRM held two saved estimates, so which estimator the quotes really come
  from could not be measured.
- The built-in presets use 41 line types; templates and presets together use
  139 of the catalog's 278; another 49 are reachable only as a brand swap.

## The rule Jo agreed

- Floor 30%, target 35%, measured before sales tax:
  (price - material - labor) / price.
- On the **job total**, on **cash** jobs. Insurance scopes are left out and
  keep 10% overhead and 10% profit.
- Measured on the price the customer pays: after a minimum charge, after a
  discount.
- A **per-company setting, off unless set**. NBD's values are 30 and 35; no
  other tenant gets them.

## What the builders will do (not built)

- Every cash estimate is checked, whichever builder made it: per-square,
  line-item, job templates, classic.
- Under the floor: a warning and an explicit confirm, with the price that
  reaches the floor and a one-tap "Use this price". Not a block.
- Anyone saves a draft under the floor; only the owner or a company admin
  finalizes or sends one.
- Confirming under the floor keeps a private note on the estimate: who, when,
  the margin. Never customer-facing.
- One set of margin bands everywhere: at or above the target, between floor
  and target, under the floor. The classic estimator's 20% band goes.
- The margin display stops counting sales tax as margin.
- A job with a line that has no cost says the margin is unknown and does not
  warn.
- Saved estimates are left alone until one is opened and saved again.
- The markup settings stay as they are until the company's real costs are in.

## Real costs first

1. A private sheet of the 41 preset line types for Jo to fill in: material cost
   (sales tax included, as in the cost book) and labor cost (what is paid out
   per unit to a crew or sub). Material is pre-filled where a line maps to a
   cost-book product through `PRODUCT_MAP` or an exact product name, marked to
   be checked. Written 2026-11-17, outside the repo.
2. The other 98 used line types follow.
3. `scripts/import-line-costs.js` loads the sheet into
   `catalogCosts/{companyId}.xactCosts`: dry run by default, `--company` and
   `--in` required, `--apply` needs `--yes`, one bad row stops the run, an
   existing line cost is not replaced without `--force`, a `.local/` backup
   before any write, counts and codes only. The write is Jo's run, or one he
   approves in chat for that run. Suite: `tests/line-cost-import-2026-11-17.test.js`.
4. The 84 custom template lines wait; they are entered in the Job Templates
   editor, which already has the fields.

## Order

1. The cost sheet (done).
2. The floor warning, as its own PR after slice 2 of the pricing lane merges.
3. The importer (built; waits for the filled-in sheet).

## Not decided, not done

- RoofIVent pricing is parked until a library product can be added to an
  estimate. Jo's decision for then: the part at MSRP, install as its own charge.
- A screen for line costs. The importer is the route for now.
- Whether the markup settings change once real costs are in.
