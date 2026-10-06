# NEXT_SESSION — 2026-09-29

> **Update 2026-09-29 (afternoon):** all five §3 lanes are closed. See
> [NEXT_SESSION-2026-09-29-part2](NEXT_SESSION-2026-09-29-part2.md), which is
> now the current brief. §2 here is carried there, with Connect Google
> Calendar added.

The 09-28/29 marathon: a CRM sweep, then Jo's asks one at a time: Home Depot,
yard signs, calendar, the tracker, and full Stripe. **Everything below is merged
and deployed** unless it says otherwise.

## §0 Read first

- **Stripe is now the ledger of record for card money.**
  - What happens: every Stripe event feeds `stripeLedger/` and books onto CRM
    invoices by customer.
  - Details:
    [STRIPE-FULL-INTEGRATION-2026-09-29](STRIPE-FULL-INTEGRATION-2026-09-29.md)
    (design, the rollout order, and the follow-ups).
  - The live `invoiceWebhook` endpoint (`we_1TtvCO…`) now sends 14 events
    (Jo approved the change, 09-29).
  - The backlog was applied on 09-29 after a dry run:
    - **3 booked:** Customer CG $1,050, Customer DU $225, Customer C $125.
    - **6 in Jo's review list:** Customer Z, Customer EH and Customer AZ are name-only
      suggestions (their CRM phones differ from the Stripe ones, and their CRM
      addresses are a city only); Customer BM, Akins and Customer AG have no lead.
- **Jo's decisions, 09-29 (recorded in memory as
  `calendar-and-tracker-decisions-2026-09-29`):**
  - Calendar: job windows are a start time plus a length (multi-day
    projects); almost everything goes to Google; one "NBD Jobs" calendar for
    Jo; conflicts warn, never block.
  - Workouts: the coach should push variety.
  - Health: weight only, from the Hume scale.
  - Tracker history: migrate the old pages.
  - Food: **unanswered**.
- **"Do anything we need; I'll accept your suggestions" (Jo, 09-29).** Still
  applies: production writes need an explicit ask (see memory).
- **The claudeProxy rate-limit alarm Jo forwarded was Jo's own phone** (the
  smart-followup AI burst), not an attack. It was fixed in #1888. How to tell
  next time: `claudeProxy:uid` means one signed-in user; an attack shows up as
  an `…:ip` namespace.

## §1 Shipped (PR → what)

| PR | What |
|---|---|
| #1860–#1872 | CRM sweep fixes; BUG-LOG R14-17..27 |
| #1873 | Home Depot Pro Xtra import + attaching a receipt to any expense ([runbook](../runbooks/HOME-DEPOT-EXPENSES.md)) |
| #1874 | Yard Signs: map, photo, 1/2-week pickup, 07:30 push, QR-lead attribution |
| #1875 / #1877 | customerId minted server-side for bridged leads; the client platform veto |
| #1876 | [calendar hub plan](CALENDAR-HUB-PLAN-2026-09-29.md) + [tracker plan](DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md) (with Jo's answers) |
| #1878 / #1880 | Tracker Phase 0: tombstones, newer-mt wins, chunked sync, settings on `userSettings`, escaping, **the tab-tap wipe of the Exercise Log** |
| #1879 | Calendar Phase 0: arrival window, deal install date → lead, adjuster meeting, ICS times, portal window |
| #1881 | Install/completion dates no longer show a day early in ET |
| #1882 | Record Payment: Check/Zelle/Cash/ACH/Other, reference, date received, photo/PDF proof |
| #1883 / #1887 | Stripe ledger (+ out-of-band amount at API 2023-10-16, the invoice phone/address fallback) |
| #1884 (+#1885 folded in) | Platform CRM invoices → real Stripe Invoices; Money → Stripe panel, review list, customer payments |
| #1886 | Workout Coach (tracker Phase 1) |
| #1888 | Smart-followup AI burst: de-dupe in-flight calls, cap concurrency at 2, fingerprint cache, 429 backoff |

## §2 Open — Jo's hands

1. The **6 Stripe review items** (Money → Stripe → Needs review).
2. **ACH:** Stripe → Settings → Payment methods → ACH Direct Debit. It is
   `available:false` on the account; the API can't turn it on.
3. **Cash App Pay:** keep it or turn it off. It fraud-declined one customer
   twice before they paid with Link.
4. **Home Depot:** the unsure receipts (about a dozen whose PO/Job field holds a street,
   a surname or nothing usable — list in Jo's private notes,
   the 5 blank ones including the $30.74 rental); whether to create leads for
   the jobs that are missing; then the real import and the PO/Job names.
5. **Food logging preference** (tracker Phase 2).
6. **Calendar Phase 1:** connect Google in Cal.com (Jo's click).
7. **Still open from before:** Insurance Claim Progress on cash jobs; old
   public audit run logs; the Bland balance; the production count of leads
   whose fields contain `<` or `>` (not approved).

## §3 Next build lanes (in order)

1. **Refunds and disputes in revenue.** `collected-revenue.js` `paymentsOf()`
   and its three copies skip amounts ≤ 0. Change all four together, and handle
   the synthetic-remainder math. Refunds are already recorded
   (`invoices.refunds[]`).
2. **Calendar Phase 2:** CRM → Google "NBD Jobs" via OAuth plus free/busy
   warnings. Plan §3. It needs Jo's OAuth consent.
3. **Tracker Phase 2+:** food (awaiting Jo's answer), the Hume weight trend,
   and migrating old pages into coach sessions (dry-run first).
4. **Stripe customer metadata:** write `nbd_lead_id` onto matched Stripe
   customers during the backfill (a Stripe write).
5. **The customer-page Yard Signs chip**, and a Home widget for the Stripe
   review count.

## §4 Method notes from this session

- **Run the FULL node bucket before pushing** (`timeout 580 node
  scripts/run-test-manifest.js`). Targeted runs missed `viewer-callables` and
  `secret-stub-guard` on #1883. `run-test-manifest.js --help` *runs every
  suite* once classification is clean, so always wrap it in `timeout`.
- **Parallel PRs all bump `FLOORS`**, so each merge makes the next PR DIRTY.
  Fold related PRs together (#1885 into #1884), and keep fix-only follow-ups
  free of new test files: #1887 needed no floor change and merged in parallel.
- **A "failed" CI check was twice a runner crash** (shutdown signal; the
  storage-emulator download). Read the job log before touching code, then
  `gh run rerun --failed` once the run completes.
- **Dry-run against live data before applying.** The first preview caught two
  real bugs that the synthetic tests couldn't (the `amount_paid:0` shape, the
  missing invoice phone).
