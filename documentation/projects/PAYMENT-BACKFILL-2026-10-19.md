# Customer payment backfill (flag `paymentBackfill`), 2026-10-19

Why: checks, Zelle and cash from customers never reached the CRM, so finished
jobs, collected revenue and job profit are all wrong. This is the customer half
of [SUB-PAYMENTS-SORTER-2026-10-19](SUB-PAYMENTS-SORTER-2026-10-19.md) (the sub
half: what Jo paid out). Together a job shows what came in and what went out,
with a photo for each. Ships dark. Crews are independent subcontractors.

## What it is

An owner-only screen (Expenses, "Backfill customer payments"; owner = solo
operator, company_admin or platform admin; never a manager, rep or viewer):

1. **Paste or type.** CSV or tab-separated rows, with or without a header row:
   payer, address, phone (optional), payment date, amount, method (check, cash,
   Zelle, other), check / reference no., memo, job type (optional), source
   (optional). Or "type one payment" and it is appended to the list.
2. **Review.** Every row says one of: **New customer**, **Matches an existing
   customer: confirm**, **Possible duplicate payment**, **Already imported**, or
   **Needs a fix** (plain reasons). A customer is **never merged for you**: a
   match shows the candidates (same phone / same address / same name) and you tap
   "Same: <name>" or "Different customer". A possible duplicate (same amount
   within 7 days and the same customer or a close name, or the same check number)
   needs an explicit "create it anyway". A re-paste flags what is already
   imported (idempotent: a stable payment id, `bf_` + a hash of who, where, day,
   cents and check number).
3. **One tap per row creates**, in this order, and undoes itself if a step fails:
   - **the customer** exactly like the Add Lead form: `userId` / `companyId`,
     `meter: manual`, a minted customer id, stage **closed** (won), the job type
     you pick (a required choice, like the form), `source: 'Other'` and **no
     `confirmedSource`**, so the Lead Source Fixer still asks you (the paste's
     source column is kept only as a hint; Yelp / Thumbtack are never guessed);
   - **the job**: the lead is the job record (the server mirror makes `jobs/j1`
     from it); finished date = the payment date (`closedAt` / `completedAt`, noon),
     memo as scope / notes, job value = the payment in dollars;
   - **the payment** on the path the CRM already uses for a job with no invoice:
     `InvoicePipeline.jobValueInvoiceDoc` (a minimal invoice, line item
     "Backfilled payment: <memo>", `source: 'backfill'`) then `markPaid` (date =
     the check date, method, check number as the reference, memo, payer
     homeowner, payment id, proof). So **collected revenue, job profit, the Money
     dashboard and the agent tools count it** and a payment timeline note is
     written. Nothing is sent: `markPaid` only records, and a receipt is never
     emailed from here.
   - A matched customer you confirm gets the payment as another backfill invoice
     on their card; no second customer is made.
4. **Undo** (one tap, right after) and a later **void** (needs a note, from the job
   money view) are soft: `deleted: true`, `voidNote`, an `editLog` entry. Nothing
   is hard-deleted. Undo voids the invoice and, if this tap made it, the customer.
5. **Check vs CRM** (changes nothing): paste rows, see which payments are already
   in the CRM (same amount, +/- 7 days, the same customer or a close name).

## Photos of the checks (shared with the sub side)

`docs/pro/js/proof-photos.js` is the one component both halves use:

- images and PDFs only, 25 MB each, up to 6 per payment;
- every image is re-drawn on a canvas and saved as JPEG (max 2000 px): EXIF and
  GPS are dropped; an image the browser cannot decode is **refused**, never stored
  raw; a PDF is stored as is;
- stored under the **existing private Storage rules** (owner-only read):
  `payment-proofs/{uid}/{invoiceId}/...` for customer payments (the path the
  invoice proof already uses), `receipts/{uid}/sub-proofs/...` for sub payments.
  The doc keeps the path only (`proofStoragePath` + `proofName`, extra photos in
  `proofPaths`); no download URL or `?token=` link is stored anywhere;
- "View" fetches the file through the signed-in SDK and shows it from a `blob:` URL
  (never a download URL), for a path that matches the two private folders only; thumbnails show in the row and in the job money
  view; you can drop several files on the screen and assign each to a row, or add
  photos to a row directly;
- **the MICR line** (routing and account numbers) is never read: the component
  does not read pixels, does no OCR and logs no file name, size or URL. There is
  **no "Read the check for me" helper**: the only existing vision path is the
  receipt scanner, which sends the image to a server function and returns store
  fields (vendor, total), not payer / check number, so it was not reused.

## Job money (both halves side by side)

From a backfilled row ("Open job money"), a sub payment's job name, or the Sub
payments jobs list: **Customer payments** (date, method, check no., memo,
"Backfilled" tag, photos, a Void that needs a note) next to **Sub payments**
(payee, amount, method, note, photos), with Collected, Job costs and Profit so
far. Collected comes from the same invoice reader as the Money dashboard; if the
invoices did not load it says so and shows no profit rather than a wrong one.
Needs the `subPaymentsSorter` flag (the sub side) as well as the customer data.

## Safety: nothing can reach the customer

Checked on 2026-10-19 across every `leads/{id}` and `invoices/{id}` trigger and
every scheduled job that reads leads:

- **Quiet for good.** The created lead carries `completedBackfill` (quiet) and a
  `stageHistory` entry `backfill: true` (the existing "already completed" quiet
  mechanism), plus `paymentBackfill: true`. `functions/quiet-backfill.js`
  `isQuietBackfill` now returns true for `paymentBackfill` whatever the history
  says. Every after-install automation already asks it: the automatic review ask
  (email and text), the review nudge, the anniversary touch, the drafted thank-you
  / paperwork, the job-spine review task, the portal rating, the agent tools.
- **Invoices.** `functions/money-paper.js` `handle` returns at once for
  `source: 'backfill'` / `backfilled: true` (`isBackfillInvoice`): no spine stage
  move, no filed invoice or receipt PDF, no "paid but not closed" task, no
  out-of-band mark. Only the payment timeline note is still written. The invoice
  is `paid` with nothing owed, so the overdue reminder (open statuses only) never
  sees it.
- **Structurally unreachable otherwise:** no `assignedTo` (so no rep push), no
  `webLead` / `publicLeadKind` (so no lead alert, no web-lead measurement, no 24h
  follow-up, no ack email), no schedule date (no calendar event, no crew-date
  draft), no consent fields (the rules refuse them on a client create), no
  referral fields. `activeJobId`, `confirmedSource` and consent keys are refused by
  `firestore.rules` on a client create.
- The messaging kill switch is untouched; this code calls no messaging function.

## Rules (tightened after the independent security review, 2026-10-19)

- **Owner side only, at the rules layer.** The backfill markers (`source:
  'backfill'`, `backfilled`, `backfillKey` on an invoice, `paymentBackfill` on a
  lead) can only be written by a platform admin, a `company_admin` or a solo
  operator (`backfillWriterOk`). A sales rep or manager cannot mint a backfill
  invoice, set `paymentBackfill` to silence the automations, or flip an ordinary
  invoice into one. After create the markers are frozen (`backfillMarksFrozen`).
- **A void carries a note.** An invoice going `deleted: false -> true` needs a plain
  `voidNote` (1 to 300 characters), so no one can silently void an invoice.
- **Invoice money is no longer free-form.** A new invoice must carry no money (no
  `payments`, not `paid`, `amountPaid` 0): Record Payment appends afterwards. On update
  the `payments` list may keep its length (a proof, a receipt state), shrink (an Undo) or
  grow by exactly ONE entry that is valid (amount a positive number under 10 million, `at`
  a timestamp not in the future and not before 2015, method one of check / zelle / cash /
  card / ach / other) and `amountPaid` must rise by exactly that amount; `amountPaid`
  cannot move without the list changing. So a rep cannot create or edit an invoice into
  "paid" with nothing behind it. What the rules cannot stop: a rep recording a real-looking
  payment with a date in the past (Record Payment lets you log "a check I got yesterday").
  That is why the review-ask / referral / rating guards above key off the backfill marker
  and the real payment dates, not off anything a rep could type.
- **A backfill invoice is the owner side's to edit or void**: a manager cannot (rules +
  test), a manager can still edit an ordinary invoice.
- **Sub-payment proof paths** (`expenses.proofPaths`): each entry must be a string
  in the writer's own `receipts/{uid}/sub-proofs/` folder; a URL, a number or another
  user's folder is refused (checked entry by entry, up to 10).
- **Storage:** `payment-proofs/**` and `receipts/{uid}/sub-proofs/**` now accept only
  `image/jpeg|png|webp|heic|heif` and `application/pdf` (no Word, text or CSV);
  other `receipts/` files keep their wider list. The EXIF strip is client-side
  (a canvas re-draw before upload); there is no server-side strip for receipts to
  reuse, so it is not enforced by the bucket.
- Rules tests: viewer denied, rep denied on every marker, company_admin and solo
  allowed, frozen markers, void note, cross-tenant read / write denied (Firestore and
  both Storage folders), and a company_admin cannot void another writer's expense.

## Security review fixes (same day)

- **Same customer + a backfilled payment.** A backfill invoice can land on a real,
  unfinished customer. Its payment date must not open customer-facing clocks:
  `review-ask-auto-logic.receivedMs` now ignores backfill invoices (so no review-ask
  window, no auto-ask email, no referral "paid" date), `referral-rewards.projectClosed`
  refuses a `paymentBackfill` customer at any stage (it only skipped `install_complete`
  before), and the portal rating card and its server gate refuse a customer who has a
  backfill invoice (`hasBackfillInvoice`). Tests use the real eligibility functions with
  a paid-stage customer who has an email and a backfill payment dated 5 days ago.
- **Lead cap.** The backfill creates leads with `meter: 'import'` (the one-time
  onboarding allowance), not `'manual'`, so a pasted batch cannot use up the monthly
  cap real leads need.
- **No tokenised URLs.** Photos are fetched with the signed-in SDK (`getBlob`) and shown
  from a `blob:` URL, like the call recordings; `getDownloadURL` is no longer used for
  proofs: not in `proof-photos.js` and not in the invoice's own "View" proof button
  (`invoice-pipeline.js viewProofUI`), so this code produces no `?token=` link. The upload
  itself still leaves a download token in the object's metadata, as every Storage upload
  does. The repo has a token-clearing pattern only for photos (`image-pipeline.js`), none
  for receipts or proofs, so those tokens stay; the bucket rules keep the objects
  owner-read and nothing here ever reads or stores the token. A small
  `onObjectFinalized` function that strips it from `payment-proofs/` and
  `receipts/*/sub-proofs/` is the clean follow-up.
- **Same-day identical payments.** Two genuine payments with the same payer, day, amount
  and check number used to share a payment id, and the ledger's dedupe would have dropped
  the second silently. The second identical row in a paste now gets key `<key>-2` (and so
  on): it is flagged "possible duplicate" and needs the explicit "different payment" tap,
  and when created it is a separate payment. After create the screen reads the invoice
  back and refuses to say "created" if the payment did not land.
- **Record Payment's picker** now refuses what the bucket refuses (GIF, AVIF, Word, text)
  with a plain reason; it takes JPEG, PNG, WebP, HEIC and PDF.
- **Portal rating.** The rating card, the Google review link and the rating gate are all
  withheld from a customer whose job is not paid in full by REAL payments (an old
  backfilled check beside real paid money does not block; a backfill-only customer does).
  The rep's review nudge uses the same rule and never dates itself from a backfill
  payment. Tested against the real `submitCustomerRating` handler (409 not-complete).
- **Payment key** is now about 85 bits (a 53-bit hash plus FNV-1a), and a resumed run
  also checks the amount before reusing an earlier invoice.
- **No hard delete** anywhere in the backfill, sub sorter or job money view (tested).
  The rules still allow an owner or company_admin to delete invoices, leads and
  expenses globally; changing that is out of scope here.
- There is no CSV or spreadsheet export in these screens, so no formula-injection
  surface; if one is added, neutralise cells starting with `= + - @`.

## Turn it on

Firestore `feature_flags/_default` (or `feature_flags/{uid}`): `paymentBackfill: true`
for the backfill screen, `subPaymentsSorter: true` for the sub side and the job
money view. Both default off. The assistant cannot write production flags.

## Tests

- `tests/payment-backfill-2026-10-19.test.js` (node bucket, 105 checks): parsing,
  dates / money / methods, names and addresses, customer matching (never a merge),
  payment key and duplicates (7 / 8 day boundary), the five statuses, the lead /
  invoice / payment documents, the shared photo component (decode failure refuses),
  the quiet rule through the real review-ask and doc-draft eligibility, the real
  `money-paper` `handle` skipping a backfill invoice, flag and role gates, source
  wiring. **29 mutants all killed** (six survived the first pass and drove tighter
  checks).
- `tests/firestore-rules.test.js`: the backfill lead / invoice cases above.
- Browser pass (Chromium, 375 px, real `invoice-pipeline.js` and
  `collected-revenue.js` over an in-memory Firestore): paste, Check vs CRM writes
  nothing, review statuses, job-type refusal, photo through the file chooser,
  create (lead, invoice, payment, proof path, JPEG upload, timeline note, collected
  revenue counts it), re-paste says already imported, matched customer gets the
  payment and no second lead, undo voids both and collected returns to $0, job
  money view, no sideways scroll, 44 px targets.

## Not done / follow-ups

- No address geocoding or map pin on a backfilled customer (the Add Lead form does
  both). The customer card works without them.
- A repeat customer's *second job* is not created: a confirmed match adds the
  payment to the existing card. A real second job still goes through "Add a job".
- The payment timeline note of an undone payment stays on a voided customer.
- Photos that failed to upload are reported on the row ("add them from the job");
  re-adding them from the job money view is not built (use the invoice's Attach
  proof).
- "Read the check for me" is skipped on purpose (see above).
- The backfilled customers use the one-time import allowance (1000 leads), not the
  monthly cap.

## Round 3 and 4: the invoice "paid" bypass (2026-10-20, follow-up PR #2579)

#2578 merged at its `ecfe221e` head, so the round-2 commit (`6ff282b9`) shipped in this follow-up together with these fixes.
A rep could still create a draft invoice and then update `{status: 'paid', balanceDue: 0, paidAt: <5 days ago>}` with
`amountPaid` and `payments` untouched; `receivedMs` falls back to `paidAt`, which would have opened the review-ask window.
`firestore.rules` now (all on `/invoices` update unless said otherwise):

- **Becoming paid.** An invoice may only BECOME `paid` with a payment entry behind it and `amountPaid` covering the total, judged against
  the total it HAD (so lowering or omitting `total` in the same update does not help), or when the send lock restores a `paid` it was
  `sending` from. `sendingPriorStatus: 'paid'` is refused at create and can only be written on an invoice that is already paid.
- **The total** is the owner side's to change once an invoice has left draft or carries a payment (a draft with no payment can still be re-priced).
- **Dates.** `paidAt` and `lastPaymentAt` change only on a valid one-entry append (or a one-entry undo), and only to the newest remaining
  entry's `at`; a same-length update cannot move `amountPaid`, `paidAt` or `lastPaymentAt`.
- **Entries.** A new entry must be whole cents, dated not in the future and not before 2015, a known method, and **recorded by the caller**
  (`recordedBy == request.auth.uid`). Existing entries keep amount, date, method and recorder (a proof, receipt state or deposit account may
  change). `amountPaid` moves by exactly the entry's amount (half a cent of tolerance, no more).
- **Undo.** The list may shrink by ONE, only for the writer who recorded the newest payment or the owner side, and the money must follow
  (`amountPaid` down by exactly that amount, never "paid" unless the rest still covers the total, dates only unset, unchanged or the newest
  remaining entry's). The catch-up Undo still works.
- **Cap.** The per-entry checks cover the first 15 entries (a rules expression budget: 25 exceeded the 1000-evaluation limit). A list longer than
  15 can only be left exactly as it is (edits to other fields, a void and the server's own writes all still work); no client appends a 16th.
- What the rules cannot stop: a rep who records a REAL payment entry with a past date (Record Payment lets you log "a check I got yesterday")
  on an invoice whose total they re-priced while it was still a draft. That is why the review-ask, referral and rating guards also key off the
  backfill marker and the real payment dates.
- `isQuietBackfill` honours `paymentBackfill` on the LEAD (rules-locked to the owner side). `backfillKey` / `source: 'backfill'` are INVOICE
  markers (`isBackfillInvoice`, used by money-paper, `receivedMs`, the portal and the rep nudge). A `backfill.key` object on a lead is not a
  marker on purpose: any rep can write it, so honouring it would let a rep silence a customer.

Checked against the other invoice writers: the send lock and its restore, milestone and emergency flags, the Stripe link, proofs and receipt
state, deposit accounts, reminders and the catch-up Undo all still pass (rules tests). Older rules tests that asserted "set paid with no payment
entry" were changed to assert the entry is required. The backfill screen's read-back after `markPaid` is `paymentLanded(invoice, paymentId)` in
the logic file, tested directly. 22 rules mutants of the invoice money rules are all killed.

### Round 5 (PR #2580): three more variants, and what is left on purpose

- **The send lock holds the money.** While an invoice is `sending` its `payments` list cannot change at all (no undo, no append), so
  `paid -> sending -> undo -> paid` cannot revive a paid status with no money. The intact round trip (paid -> sending -> paid) still works.
- **No re-pricing through a status round trip.** An invoice goes back to `draft` only by the owner side, or as the send lock's restore of a
  draft it had. (The app writes `draft` only at create, so nothing legitimate is lost.)
- **Markers by key presence.** On create, the keys `backfilled`, `backfillKey`, `paymentBackfill` in ANY value or type (`'true'`, `1`,
  `false`, `''`), or `source` equal to "backfill" in any case, make the write owner-side only; they are frozen afterwards. Consumers
  (`isBackfillInvoice`, `hasBackfillInvoice`, `isQuietBackfill`) stay strict (`=== 'backfill'`, `=== true`) because only the owner side can
  write those keys at all, and the owner side writes the exact values.
- Tests added: cross-tenant manager append / tenant swap denied, same-tenant non-creator rep append denied, 15 -> 14 undo allowed, sub-cent
  tolerance documented (`100.000009` is inside the 0.001-cent allowance, `100.004` is not).

**Decisions left to the owner (not changed here):**
- *Hard delete.* The rules still let the creator (and a company_admin) hard-delete an invoice that has payments. The catch-up "Undo" does exactly
  that to an invoice it created, so a blanket `amountPaid == 0` rule would break it. Proposal for Jo: owner-side-only deletes of an invoice with
  payments, with catch-up Undo switched to a soft void; follow-up before either flag is turned on.
- *16 to 25 payments.* An invoice with more than 15 payments becomes append/undo-frozen (it can still be edited elsewhere and voided). Acceptable:
  a job with more than 15 separate payments is not a real case today.
- *Extra keys on a payment row and `balanceDue`* are not validated by the rules (low: nothing reads them for money; `amountPaid`, the entry
  amount, date, method and recorder are the validated fields).
