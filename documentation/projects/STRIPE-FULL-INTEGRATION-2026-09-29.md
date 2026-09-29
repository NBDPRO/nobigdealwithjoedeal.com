# Stripe full integration — 2026-09-29

**Jo's ask:** "full throttle auto integration — literally every transaction from
Stripe makes its way back to the CRM, recorded, linked to the customers in the
CRM under their names." Jo also approved changing the Stripe webhook settings
for this and turning on bank (ACH) payments.

## 1. What was actually true (live account, read-only, 2026-09-29)

- **Jo gets paid through Stripe *Invoices* built by hand in the Stripe
  dashboard**, not through the CRM. The Sept/Aug money that went through
  Stripe:
  - 8 paid customer invoices
  - 1 bare payment link
  - two of the invoices were "marked paid" in Stripe with no charge, i.e.
    Zelle or check
  - about **$6,525** in total
- **The CRM's own online-pay path has never been used for real.** It creates a
  Stripe *payment link* (`createStripePaymentLink`), not a Stripe Invoice. Only
  one CRM-made link exists in the account's whole history: a July test.
- **The plumbing works; the matching didn't exist.**
  - `invoiceWebhook` received every September payment. Cloud Run logs show
    six POSTs, all 200.
  - `STRIPE_INVOICE_WEBHOOK_SECRET` is a real `whsec_`, checked without
    printing it.
  - But the handler only credits payments carrying `metadata.invoiceId`,
    which only CRM-made links have. **None of the dashboard-invoice money
    reached CRM revenue** unless Jo marked it paid by hand.
- **Nothing read Stripe for reporting:** no balance, payouts or fees.
- **Refunds and disputes never lowered revenue.**
- **Mark Paid** offered only Cash/Check: no Zelle, no reference, no proof.
- **ACH (`us_bank_account`) is `available: false` on the account.** Stripe
  activates it only from the dashboard. It is Jo's click, not an API call.
- **Cash App Pay is on and flagged "high likelihood of fraud" twice** on one
  customer's $450 payment (Link then succeeded). Whether to turn it off is
  Jo's call.

## 2. What ships (PR: Stripe ledger)

`functions/stripe-ledger.js` + `stripe-ledger-logic.js` (pure):

- **`stripeLedger/{stripeObjectId}`** — one row per charge (including declined
  attempts), refund, dispute, payout, and invoice paid outside Stripe. Each row
  carries fee, net, method, the customer, and a match:
  `{leadId, invoiceId, method, confidence}`.
- **Matching**, in order:
  1. an explicit lead id
  2. a Stripe customer already linked to the lead
  3. email
  4. phone
  5. house number + street

  All of these book money automatically. A name alone only *suggests*: the row
  goes to `needsReview` and money is never booked on a name. Two leads sharing
  a key narrow by the next key.
- **Booking onto CRM invoices:** the linked invoice → the open invoice with an
  equal balance → the only open invoice. Otherwise a **mirror** CRM invoice is
  created from the Stripe invoice (`source:'stripe'`, real `in_…` id, hosted
  URL, PDF, NBD number) under the customer.
- **Never twice:**
  - `stripeCreditKeys` on each invoice make the webhook retry, the nightly
    reconcile, the backfill and manual assignment idempotent.
  - A payment Jo already recorded by hand (same amount, within 14 days) is
    linked, not added.
  - A CRM payment-link payment stays with the existing `paidIntentIds` path.
- **NBD Pro subscription charges** (contractors paying for the CRM) are
  labelled `platform_subscription` and never matched or reviewed.
- **Ways in:**
  - `invoiceWebhook` → `onEvent`, for every event.
  - `stripeLedgerSync`, an owner-only callable. **`dryRun` defaults to true.**
  - `stripeLedgerReconcile`, a daily 06:15 ET run over the last 4 days.
  - `assignStripeTransaction`, for the review list.
  - `getStripeOverview`, for balance and payouts.
- **Kill switch:** `STRIPE_LEDGER_DISABLED=true` (cron-gates registry), which
  covers the webhook path too.
- **Refunds** are recorded (ledger row + `invoices.refunds[]` +
  `refundedTotal`). The `payments[]` array that revenue reads is **not** yet
  adjusted — see §4.

## 3. Rollout order (must be followed)

1. Merge and deploy. The code must be live before Stripe sends it new events.
2. **Dry-run the backlog.** Call `stripeLedgerSync({dryRun:true})` and show Jo
   the preview: matched, would-create, needs-review.
3. On Jo's OK, run it for real with `dryRun:false`.
4. **Webhook endpoint** `we_1TtvCO…` (invoiceWebhook): add the events
   `onEvent` handles (`LEDGER_EVENTS` in `stripe-ledger.js`). Jo approved this
   write on 2026-09-29.
5. The UI (Money view Stripe panel, review list, customer payments) follows in
   its own PR.
6. "Send via Stripe": CRM invoices become real Stripe Invoices (ACH on once Jo
   activates it). This retires the payment link for Jo's own account; Connect
   tenants keep the link path.

## 4. Known follow-ups

- **Refunds and disputes in revenue.** `collected-revenue.js` `paymentsOf()`
  skips amounts ≤ 0, and three other revenue readers copy it (see its header).
  Modelling a refund means changing all four together, plus the "synthetic
  remainder" math. It's deliberately not half-done here.
- **Stripe customer metadata.** Write `nbd_lead_id` / `customerId` back onto
  matched Stripe customers so the match is explicit on Stripe's side too. This
  is a Stripe write; do it after the backfill.
- **The `stripeInvoiceId` field is overloaded.** CRM payment-link invoices
  store a `plink_` id there; ledger mirrors store a real `in_` id.

## 5. Update 2026-09-29: the UI (rollout step 5)

Built in `feat/stripe-ledger-ui`, stacked on this PR:

- **Money view → Stripe panel** (`docs/pro/js/stripe-ledger-panel.js`).
  - Shows the balance and payouts (`getStripeOverview`) and this month's
    Stripe gross, fees and net. The total counts `charge` rows only, so
    subscriptions and failed or pending charges are left out. Refunds show
    beside it, not netted in.
  - Shows the **Needs review** list, with "Assign to <name>" (two taps), a
    customer search and a count badge.
  - Shows recent transactions under the matched customer's name.
  - **Sync from Stripe** always runs `dryRun:true` first and shows a preview
    grouped by outcome. **Apply** is offered only after that.
- **Customer page** gets a Stripe Payments section
  (`stripe-ledger-customer.js`).
- Invoices with `source:'stripe'` get a **From Stripe** chip and Open in
  Stripe / PDF links, in the customer invoice list and in
  `invoice-pipeline.js`.
- The pure rules are in `stripe-ledger-ui-logic.js`. They are pinned by
  `tests/stripe-ledger-ui-2026-09-29.test.js`.
- Sales reps and viewers never see the panel. Managers can read it, but only
  the owner, company_admin or a platform admin get the write buttons
  (`role-gate.js`).

Found while building it. These are server-side and not fixed in the UI PR:

- `mirrorInvoice()` writes line items as `{rate, amount}`. The invoice detail
  renderer reads `{unitPrice, total}`, so a mirrored invoice shows $0.00 per
  line even though its totals are right.
- On this branch, `tests/viewer-callables.test.js` fails because the three new
  callables have no viewer verdict. `tests/secret-stub-guard.test.js` fails
  because `stripe-ledger.js` has a `.value() ||` fallback outside the
  allowlist.
