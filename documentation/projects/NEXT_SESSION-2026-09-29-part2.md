# NEXT_SESSION — 2026-09-29 (part 2)

The afternoon of 09-29. Jo said "keep sweeping autonomously, you pick the lane
order". All five lanes from [the morning brief](NEXT_SESSION-2026-09-29.md)
§3 are closed: four were built and one turned out not to be needed.

## §0 Read first

- **Google Calendar is built, but it does nothing until Jo presses Connect.**
  Go to Schedule → Google Calendar, enter the Google account email, and press
  Connect Google Calendar. The CRM's service account then creates an
  **NBD Jobs** calendar, shares it read-only with that account, and backfills
  it. The share invite arrives by email; Jo accepts it once.
- **The double-booking warning covers other NBD jobs from day one.** It covers
  Jo's own Google calendar only after Jo shares that calendar's free/busy
  with `717435841570-compute@developer.gserviceaccount.com`. The panel shows
  the exact clicks and has a Copy button.
- **The `tests/deploy-step` fake CLI changed in #1891.** It used to guess
  "retry" from the batch size (30 or fewer). Once there were 206 functions,
  the last 60-wide wave-1 chunk was only 26, so the fake healed a drop it
  should have kept. It now heals a name only if an earlier call already
  targeted it.
  - If that harness goes red again after functions are added, look at the
    fake before the deploy step.
  - It is safe to run locally: it aborts unless `npx` resolves to its fake,
    and it targets a nonexistent project.

## §1 Shipped (PR → what)

| PR | What |
|---|---|
| #1890 | **Refunds and lost chargebacks come off revenue on the day they happen**, in all four revenue readers. Won disputes and failed or canceled refunds don't count. `recordMoneyBack` updates in place by Stripe ref, and a dispute is recorded when it closes. |
| #1891 | **Google Calendar sync.** Jobs and adjuster meetings go to "NBD Jobs": multi-day jobs are opaque, and date-only events are transparent. It syncs on each lead write and reconciles daily at 05:45 ET. Kill switch: `GOOGLE_CALENDAR_SYNC_DISABLED`. The double-booking warning under the job date and time pickers **warns and never blocks**. Also the deploy-step harness fix (§0). |
| #1892 | **Tracker weight card and old-workout import.** The card reads the weight box on each day page and shows the latest reading, the 7-day average, and the change over 7 and 30 days, with a sparkline. The import moves old Exercise Log rows into Workout Coach sessions: preview first, idempotent (`imp_<pageId>`), with unrecognized names kept under their own names. |
| #1893 | **Home "needs you" strip:** Stripe payments that need a customer, and yard signs due today or late. Each is a tap to Money or Yard Signs, and each hides at zero. **Customer-page yard-sign chip** ("🪧 Sign out · 2 days overdue"). This handoff. |

**Lane 4 (tag Stripe customers with `nbd_lead_id`) was not needed.** Every
high-confidence or manual match already saves `leads.stripeCustomerId`, and
`matchLead` checks that link right after an explicit lead id. New CRM invoices
tag the Stripe customer at creation (#1884). No Stripe writes were added.

## §2 Open — Jo's hands

1. **Connect Google Calendar** (§0), then optionally share free/busy.
2. The **6 Stripe review items**. They now show on Home.
3. **ACH:** activate it in the Stripe dashboard (the API can't).
4. **Cash App Pay:** keep it or turn it off.
5. **Home Depot:** the unsure receipts, the missing leads, then the real
   import and the PO/Job names (morning brief §2.4).
6. **Food logging:** the default shipped in the evening (see §3.1). Jo can ask
   for barcode lookup if typing macros gets old.
7. **One Thursday test call from Jo's phone.** Stay on past the greeting and
   say a sentence. The dead air is fixed, but greet-by-name has never been
   seen working: the lookup endpoint got no requests after 09-27. Details are
   in [the Thursday note §11](../architecture/THURSDAY-BLAND-2026-09-26.md).
8. **Still open from before:** Insurance Claim Progress on cash jobs; old
   audit logs; the Bland balance; the `<` / `>` leads count (not approved).

## §3 Next build lanes

1. **Tracker Phase 2 (food): SHIPPED in the evening PR, on the default.**
   It adds the Food card (protein bar, favorites, "same as yesterday"); see
   the tracker plan's evening update. The follow-up is barcode lookup, only if
   Jo asks.
2. **Calendar:** after Jo connects, verify in production that one lead write
   produces one event, and that the 05:45 reconcile reports `unchanged` on a
   quiet day. Read `integrations/googleCalendar.lastSync`.
3. **Hume → Apple Health → Shortcut weight import**: an optional follow-up
   to the manual weight box.
4. **Old free-typed PR strings and diet rows** were not migrated. The coach
   recomputes PRs from sessions, so these are only worth doing if Jo asks.

## §4 Method notes from this session

- **Home is `view-home`, the widget grid**, not `view-dash`, which is the
  older overview template. A mount placed in `tpl-view-dash` never renders at
  boot.
- **The QA emulator worktree (`nbd-wt-qafix`) was running older
  `firestore.rules`** that predate `stripeLedger`, so the Stripe count read
  "permission denied" there. Copy the current `firestore.rules` into it (the
  emulator hot-reloads) before trusting a rules-shaped failure there.
- **A stacked PR chain re-resolves `FLOORS` once per merge.** The
  `resolve-floors.js` scratch script plus the full bucket (about 90 s) takes a
  few minutes each time.
- **The `@stranger` E2E shard timed out on onboarding**, three retries on one
  run, and passed on the PR's previous run with no relevant change in
  between. `gh run rerun --failed` cleared it, which matches the memory note
  on stranger flakes.
