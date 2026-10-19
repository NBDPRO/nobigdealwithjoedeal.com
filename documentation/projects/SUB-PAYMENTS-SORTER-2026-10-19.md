# Sub payments sorter (flag `subPaymentsSorter`), 2026-10-19

Why: 20 of 21 finished jobs read about 100% margin because the pay to the
independent subs was never logged. A scan review found checks to one sub
totaling $5,340 on a single job with $0 costs in the CRM, and sub payments
(cash, check, Zelle) that sit in the books with no job. This is the receipt
sorter's idea applied to sub and labor pay: two flags that meet in the middle.
Ships dark. Crews are independent subcontractors: nothing here says employee,
payroll or in-house.

Builds on, and does not replace:
[JOB-COST-AUDITOR-2026-10-19](JOB-COST-AUDITOR-2026-10-19.md) (flag
`jobCostAuditor`) and [CASH-PAYOUTS-LOG-2026-10-19](CASH-PAYOUTS-LOG-2026-10-19.md)
(flag `cashPayoutsLog`). Both keep working with this flag off.

## The two flags

- **A. This JOB has no sub / labor cost.** The auditor's "No labor / sub cost
  logged" queue, exposed as `NBDJobCostAuditor.noSubQueue()` (same load, same
  rules; nothing drawn). The sorter's "Jobs with no sub" tab lists those jobs
  with collected, costs and margin; "Log sub payment" opens the one-thumb sheet
  already tied to that job. The auditor's own job sheet gets the same button
  while this flag is on.
- **B. This PAYMENT has no job.** Every live `/expenses` row with category
  `subcontractor`, `costType: direct`, no `leadId`, no `jobId` and not answered
  "Not a job cost": cash payouts, and any check or Zelle entered without a job.
  Search (payee, note, amount), filter (method, sub, no proof), sort. Each card
  shows payee, amount, date, method, note and the proof photos.
  - **Pick job** (one tap): up to five *likely* jobs, each with the reason, then a
    free search by customer or address. Nothing is ever assigned for you.
  - **Not a job cost** (overhead): sets `costType: overhead` + `notJobCost: true`
    plus an `editLog` entry, so it never comes back; "Put back as a job cost"
    undoes it.

## How a job is suggested (pure, `suggestJobs`)

Needs at least one of the first two signals; the third only boosts.

| signal | score |
|---|---|
| payment date inside the job's work window (`scheduledDate`..`scheduledEndDate`, 3 days grace) | +50 |
| payment date up to 14 days outside the window | +30 minus days |
| the same sub (roster id, name key or alias) was paid on that job before | +25 |
| the job has no sub cost yet | +15 |

Deleted and prospect leads are never offered. Dates are read as calendar days
(never `new Date('YYYY-MM-DD')`, which is UTC midnight).

## The sheet (Direction A, and "Log a sub payment" anywhere)

Job (locked when you came from a job), who (roster chips, past payees, **+ Add
new sub** inline: name, trade, optional phone kept private), amount, date, four
method pills (Cash, Check, Zelle, Other; nothing is pre-picked), "What was it
for?" (shingles, a part, tear-off labor), and photos or a PDF of the check, Zelle
screenshot or receipt. A payment with no job is allowed on purpose: it lands in
queue B and the counter.

## Where it lives (no new collection)

An `/expenses` doc like the cash payout log: `category: 'subcontractor'`,
`costType: 'direct'`, `auditKind: 'sub'`, `source: 'sub_payments'`, `supplier`
(the roster spelling), `subId`, `leadId` / `jobId`, `paymentMethod`, `note`,
`amountCents` (int), `proofPaths` (list of Storage paths), `notJobCost`,
`editLog` (max 25: `{at, by, what, source: 'sub-payments', note}`). Void =
`deleted: true` + `deletedAt` + a required note; no hard delete anywhere. So job
profit, the Expenses by-job table, the auditor and the agent `job_profit` tool
count it with no change. Edit / void / assign / add proof only on your own rows
(the existing expense rules); another writer's row says "fix it in Expenses".
Viewer is read only (sees the payment tabs, no buttons); sales reps see nothing.

## Proof photos

Handled by the shared `proof-photos.js` (also used by the customer side, see
[PAYMENT-BACKFILL-2026-10-19](PAYMENT-BACKFILL-2026-10-19.md)); thumbnails show on
the cards and in the job money view. Stored at `receipts/{uid}/sub-proofs/{ts}_{i}_{name}.jpg|pdf`: the **existing
receipts rules** (owner-only read, owner write, images + PDF, 25 MB), so no
`storage.rules` change. Every image is re-drawn on a canvas and saved as JPEG
(max 2000 px): that drops EXIF, GPS included. A photo the browser cannot decode
is refused rather than uploaded raw. A PDF is stored as is. The expense doc keeps
only the path; "View" asks Storage for a short-lived URL on demand and opens it
in a new tab. No URL, no `?token=` link is written to any doc or page, and a path
that does not match `receipts/{uid}/sub-proofs/...` is never opened.
Limit: because receipts are owner-read, only the person who uploaded a proof can
open it (a company admin cannot open a rep's photo). Same as receipts today.

## Sub roster and names

`companies/{tenant}/subs` (the existing roster) gains an optional `aliases`
list. `payeeKey` lower-cases, drops anything in brackets, dots, punctuation and a
trailing LLC / Inc / Co, so "CA Roofing" and "CA Roofing (Alex)" are **one sub**
in totals. Looser matches ("CA Roofing Alex", a roster pair that look alike, two
unlisted spellings of one payee) are only **suggestions** with "Same sub" /
"Not the same"; nothing combines until you tap, and combining only adds an alias
(a duplicate roster sub is set `active: false`, never deleted, old rows keep
working). Edit a sub inline (name, trade, phone); a renamed sub keeps its old
spelling as an alias.

## Per-sub view and counters

Per sub: total paid, payments, payments without proof, with no job, by job, by
month, spellings seen, newest payments. Expenses panel counters: **jobs with no
sub cost**, **payments with no job**, **payments with no proof** (each opens its
list). The jobs counter is a dash until the collected money is known (it never
shows a fake 0); it fills in when the invoices are already loaded, or when the
sorter is opened.

## Rules

`firestore.rules` `validExpenseMoney`: `proofPaths` must be a list of at most 10,
`notJobCost` a bool. Cases in `tests/firestore-rules.test.js` ("Sub payments
sorter"). Roster writes use the existing `subs` rule (`subWriteOk` has no key
allow-list, so `aliases` is accepted).

## Turn it on

Firebase console, Firestore, `feature_flags/_default`: add `subPaymentsSorter`
(boolean) = `true` (or the same field on `feature_flags/{your uid}` to try it
alone). Reload Pro, Expenses: a "Sub payments" card and button appear. Direction
A also needs the auditor code, not its flag. The assistant cannot write
production flags and this PR wrote none.

## Tests

- `tests/sub-payments-2026-10-19.test.js` (node bucket): names, roster
  resolution, merge suggestions (never merges), which rows are in play, counters,
  per-sub view, queue search / filters, job suggestions (window, near, history,
  no-signal, deleted, cap, never assigns), the payment document (cents, local
  date, proof paths), patches (assign, not a job cost + undo, proof, void, log
  cap), UI flag / role / counters in a vm sandbox, source wiring. Mutation-checked:
  22 mutants of the logic and UI, all killed (two survived the first pass and
  drove tighter checks).
- `tests/firestore-rules.test.js`: proof list bound, bool type, writer-only
  changes, cross-tenant denied. The `proofPaths` bound was removed once to prove
  the new cases fail.
- Browser pass (Chromium, 375 px, stubbed Firebase): panel, jobs tab, add a new
  sub inline, photo through the real file chooser, saved doc shape and upload
  path, pick job from a suggestion, not a job cost, void needs a note, by-sub
  view, no sideways scroll, 44 px targets.

## Not done / follow-ups

- Existing rows keep `supplier` as typed; only totals and groups resolve names.
  Rewriting old rows to a `subId` needs the writer (or an admin script, dry run
  first).
- Tapping a thumbnail opens the full file in a new tab (no in-app zoom).
- A company admin cannot attach a proof to, or assign, a rep's payment (expense
  rules limit updates to the writer or platform admin).
- The agent `job_profit` tool and the 1099 view do not read `proofPaths` yet.
- A payment's amount and date cannot be edited here; void it and log it again
  (the note keeps the trail), or fix it in Expenses.
