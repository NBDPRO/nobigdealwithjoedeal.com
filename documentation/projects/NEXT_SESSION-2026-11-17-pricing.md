# NEXT SESSION, 2026-11-17: after the pricing day

**Start here.** This is the pricing lane's brief for 11-17. The same day's repo
sweep has its own brief, [NEXT_SESSION-2026-11-17-repo-sweep](NEXT_SESSION-2026-11-17-repo-sweep.md),
which stays the record for that lane (its open items are not repeated here).

This note carries no price, cost, margin or account number. Private files are
named by path only; they live outside the repo.

## 1. Merged on 11-17 (pricing lane)

| PR | What |
|---|---|
| #3125 | Supplier pricing lane plan (docs) |
| #3130 | Supplier price ledger, slice 1: offers, dated observations, the "Stores & prices" sheet. Dark behind `supplierPricing` |
| #3134 | Catalog sells raised to a 30% margin floor after labor (82 SKUs, 238 tier sells, DATA_VERSION 8) |
| #3144 | Slice 2: Home Depot receipt lines into the ledger (`hd_csv`), unlinked offers, Unlinked items list, ledger in the company export, `scripts/migrate-price-book-v2.js` |
| #3146 | `scripts/import-line-costs.js` (a company's own line costs into `catalogCosts/{companyId}.xactCosts`) and [ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17](ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md) |
| #3148 | Estimate margin shown before sales tax, with the company's floor and target bands; the Company Settings "Estimate Margin Floor" panel (off unless set) |
| #3149 | The margin floor gate and "Use this price" (line-item) in the V2 builder |
| #3151 | Part three: per-square Use this price, the job templates send gate, the Under floor tag, costs for owner and admins only |
| #3153 | Finish: fees charged at face count as cost; a deal link checks every package; fix, the deal link carried pre-raise prices |

The plan notes: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md) (lane),
[LIVE-SUPPLIER-PRICING-SLICE-2-PLAN-2026-11-17](LIVE-SUPPLIER-PRICING-SLICE-2-PLAN-2026-11-17.md)
(slice 2, Jo's answers and the later decisions), [ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17](ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md) (the floor).

## 2. Production changes made with Jo's OK (not code)

- **The old price book copied into the ledger** (`migrate-price-book-v2.js --apply --yes`,
  Jo's OK in chat for that run): 122 unlinked offers, 131 `paid` rows, unattested,
  channel `legacy_pricebook`, no unit. Verified by a read-only count. The run is
  recorded in `system/script_migrations`; a second `--apply` is refused. Backup on
  Jo's PC under the worktree's `.local/` (gitignored).
- **`feature_flags/{Jo's uid}.supplierPricing = true`** (Jo's OK in chat). The
  `_default` doc leaves it off for everyone else.

## 3. In flight

- **Slice 3** (import a supplier price sheet, suggested links, supplier comparison,
  on-screen alerts, quote expiry, tax and alert threshold as a company setting) is
  being built in its own session with Jo's decisions as its brief. It writes
  `LIVE-SUPPLIER-PRICING-SLICE-3-2026-11-17.md`. Not built here.

## 4. Waiting on Jo

1. Set the margin floor: Company Settings → Estimate Margin Floor (Jo chose 30
   floor, 35 target). Nothing warns or gates until it is set.
2. Fill in labor (and check ten pre-filled material costs) in the line-cost sheet
   on his PC (`Documents/NBD-Money/NBD_line_costs_to_fill_2026-11-17.csv`), then a
   dry run and his OK before `import-line-costs.js --apply --yes`. Until then the
   line-item builder prices from the published starter baseline.
3. Send the SRS and QXO API request emails: unsent drafts in his iCloud Mail
   (business mail is iCloud, not the connected Gmail).
4. After slice 3 deploys: approve each rep's price sheet preview before it loads.
5. A QXO "password changed" email arrived on 11-17; Jo to confirm it was him.

## 5. Decided, not built (in order)

- Slice 4: approve a price into the cost book, line by line, with the margin check.
- The next line-cost sheet: the other 98 line types the templates use, most used
  first, once the 41-line sheet is loaded.
- Server-side enforcement of the margin gate and the cost hiding: when Jo has a
  rep who is not him. Today both are screen-level only.
- RoofIVent: parked until a library product can be added to an estimate; then the
  part at MSRP plus install as its own charge.
- Revisit the 35% target on 2026-12-17, only useful if job costs are logged by then.

## 6. Things that cost time today

- On this Windows machine `run-test-manifest.js --bucket node` stops at its
  8-minute budget around 800 suites; run the rest one by one.
- A repo hook blocks force-pushes and `git reset --hard`: after a squash merge,
  merge `origin/main` into the next branch with a normal merge commit.
- Squash merges of stacked PRs leave conflicts on the cache-key lines and
  `FLOORS`; once, git's merge also duplicated a whole function block in
  `estimate-v2-ui.js` (caught by `check-js-syntax`). Re-run the estimate suites
  after every merge of main.
- Something other than the session merged `origin/main` into a pushed branch in
  the same worktree mid-run; check `git reflog` before pushing.
- Flaky CI jobs, unrelated to pricing: E2E `@shard3` (the phone-numbers
  "decision saved for the week" test) and the Pro demo zero-network walk. Re-run
  the failed jobs once before investigating.
- The ADC credentials on Jo's PC expire; `gcloud auth application-default login`
  as the owner of `nobigdeal-pro` fixes a dry run that fails with `invalid_grant`.
- The classic estimator's "cost basis" is built from catalog SELL prices
  (`window.R`), so its margin is not a real margin; it shows no floor band and does
  not gate the print. New estimates cannot start in it.
