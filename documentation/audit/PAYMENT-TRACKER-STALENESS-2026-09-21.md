# Payment tracker staleness — 2026-09-21

> Read-only finding from the same-day gutter-cleaning-category work
> (`documentation/projects/` handoff, published in
> [PR #1704](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1704)).
> Recorded because it changes how future sessions should verify payment
> status before publishing a `/our-work` card — the internal tracker is
> not reliable evidence on its own.

## What happened

A background research pass on two candidate jobs (Customer DU — gutter
cleaning, Customer C — downspout connector repair) found both
listed as **unpaid** in the "NBD MASTER Jobs Done Audit 2026" Google
Sheet (docId `1Z4TqLtuAE1q6Mcq68NUtOO-q4nS7kcdvQrUHCVFQ72Y`) — Customer DU's
row read `Paid = "NO"`, `Outstanding = "$225.00"`; Customer C's the same
pattern for $125.00. Neither customer's Drive Docs folder had a receipt,
and a Gmail search for "Customer DU" returned zero threads. Per this
session's own established discipline (verify a sweep's characterization
against real documents, not just folder presence — see the Customer AD
false positive in `PHOTO-SWEEP-2026-09-21.md`), this read as a genuine
block: two jobs that looked done were actually still outstanding.

**They weren't.** Querying Stripe directly (live account
`acct_1TBe1s3O36Xz6RgK`, via `GetInvoicesSearch` / `GetInvoicesInvoice`)
showed both invoices `status: "paid"`, `amount_remaining: 0`, with real
`paid_at` timestamps: Customer DU's `NBD-2026-0903-XXXX` paid 2026-09-10
01:00 UTC, Customer C's `NBD-2026-0902-XXXX` paid 2026-09-09 17:23 UTC —
both **before** the master spreadsheet was apparently last touched. The
spreadsheet is stale, not Stripe.

## Why this matters going forward

- **Stripe is the authoritative payment source for this business, not
  the master jobs-done spreadsheet.** The spreadsheet is a manually
  maintained tracker and can lag actual payment by days; it should be
  treated as a lead/index, never as proof of non-payment.
- Both invoices are collected via `send_invoice` with Zelle/check as the
  stated alternative payment methods (see the invoice footer text) — a
  manual mark-as-paid in Stripe for an out-of-band payment does not
  reliably generate a Gmail receipt thread, so **an empty Gmail search is
  not evidence of non-payment either.**
- The working verification order for a candidate `/our-work` job going
  forward: (1) read the actual invoice/receipt PDF in Drive, (2) if
  payment status is ambiguous or contradicts the sweep's premise, query
  Stripe directly by invoice number (`GetInvoicesSearch` with
  `number:'<NBD-invoice-no>'`) or by the Stripe invoice ID if the
  customer's internal notes doc has one — **before** concluding a job is
  blocked on payment and reporting that upward.

## Outcome

Both jobs published: `cincinnati-oh-gutter-cleaning-2026` (Customer DU, the
first card in the new `gutter-cleaning` category, see
[services/gutter-cleaning](../../site-src/partials/) and
[PR #1703](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1703))
and `cincinnati-oh-downspout-connector-repair-2026` (Customer C), in
[PR #1704](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1704).
