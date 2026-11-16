# NEXT_SESSION 2026-11-14: money path (wave 1)

The money-path lane only. This is not the live brief; see the Current handoff pointer in [INDEX](../INDEX.md).

## What this lane did
A read-only review on 2026-11-14 found 12 problems on the lead → estimate → signed proposal → invoice → payment path. All 12 were verified, and each fix went into a small draft PR with a test that failed first. Joe then added four items (Save Again, managers deleting leads, Connect refunds, and a round of answers to the open decisions). Every PR touching rules, payments, signing, portal or Stripe was reviewed with `nbd-security-reviewer`, and every diff with `silent-failure-hunter`. Findings were fixed or turned into Joe's decisions.

| Area | PR |
|---|---|
| Overpayment asks first | #3059 |
| Owner-only Reverse payment (server callable; negative entry, never a delete); no payment Undo; platform admin can't edit money; an invoice with money is voided, not deleted | #3064 |
| Reopened estimate keeps its minimum charge; photo/note don't re-price | #3054 |
| Reopened tier cards and pitch default | #3057 |
| Portal shows the signed price | #3052 (merge before #3055) |
| Contract bills the price it was sent at | #3055 |
| Invoices bill every approved supplement or refuse | #3060 |
| Money dashboard "couldn't load" | #3051 |
| Remote-signing save failure | #3053 |
| Honest payment and signing copy | #3056 |
| Save Again updates; Save as copy | #3067 |
| Connect refund reopens what's owed | #3077 |
| Managers can't delete leads; lead Archive | #3082, #3090 |

**How it shipped (2026-11-15/16).** The 14 PRs were merged as four bundles, and each bundle's PRs were closed as superseded once it was live:
- Money A, signing: #3099
- Money B, payments: #3100
- Money C, invoices and lead rules: #3101
- Money D, estimates: #3104

Three rules PRs followed:
- **#3108 (live hotfix).** After Money B, Record payment was refused on the live site for a platform-admin owner and a solo owner. The invoice update rule went over Firestore's 1,000-expression limit; no single check refused it. A pure payment append is now one list comparison.
- **#3109.** The five server-only money keys are frozen (`invoiceServerOnlyKeys()`). A browser records up to the 14th payment, so line 15 is always free for Reverse (Joe: "Yes, keep 15").
- **The payment-edit budget PR (this note's PR).** A proof photo, deposited-to and receipt-sent on one entry now fit for solo and admin owners. Payments are checked five slots at a time, the owner branch is tried before the admin branch, and a refused receipt-sent is shown to the user.

## Rules every later change must keep
- **Which payment a reversal cancels comes only from frozen fields.** `firestore.rules` `payKept` lets an invoice editor rewrite every key of a `payments[]` entry except `amount`, `at`, `method` and `recordedBy`. Never trust `paymentId`, `reverses`, `reversal` or `reason` for that decision (see `functions/reversal-pairs.js`).
- **Revenue readers count negative ledger entries.** `collected-revenue.js` and its mirrors must stay in step (`tests/money-field-contract.test.js`).
- **The invoice update rule runs against Firestore's 1,000-expression limit.** Going over refuses the write with no rule at fault: that is how Record payment broke in production.
  - The BUDGET GUARD in `tests/firestore-rules.test.js` reloads the rules with 100 dummy `didNotChange` keys. It replays the costliest everyday writes (an admin owner's first payment, a solo owner's 14th payment and proof photo on a backfill invoice, re-recording after a Reverse). If it fails, make the new check cheaper. Don't lower the floor.
  - Measure a new clause by padding that list until the write fails; each dummy key costs about one expression.
  - The same write costs more for a solo owner (no role claim) or a platform-admin owner than for a rep, so test those callers.
  - A rules-checked reversal ran past the limit, which is why reversal is a callable.
- **A browser appends up to the 14th payment.** Line 15 is the owner's Reverse (`functions/payment-reversal.js` refuses at 15 lines). Same-length edits still take the 15-slot check.
- **A new callable needs the full registration.** That means:
  - `exports.X = onCall(` in its module, because the deploy workflow greps for that shape;
  - `functions/index.js` and `FUNCTIONS_INDEX.md`;
  - `node scripts/gen-function-map.js`;
  - a verdict in `tests/viewer-callables.test.js`;
  - words in `docs/pro/demo-sdk/firebase-functions.js`.

## Money-rules follow-ups (found in review, not done)
These were already in the rules before this lane; they need their own PR.
- **`balanceDue` isn't checked** on a browser invoice update. A rep can zero it to drop an invoice from A/R, or change it to move the synthetic Collected remainder. The fix needs care: deposit credit lines legitimately make it differ from `total − amountPaid`.
- ~~Some server-only fields are still writable on update~~: done in #3109, which freezes all of `invoiceServerOnlyKeys()` after the budget work freed room.
- **No Void control** for an ordinary invoice: only the payment-backfill tool voids. The customer page's "Total paid" card is `total - balanceDue`, which caps at the total, ignores reversals and isn't refreshed by Reverse.
- **Send receipt:** a quick double tap can email twice, because the button isn't disabled while sending. A `mailto:` receipt counts as sent.
- **The Record payment sheet's error toast didn't show** on customer.html when the write was refused live (2026-11-15). Find why.
- **Leaving `'paid'`:** a rep can move a legacy invoice out of `'paid'`. `invoiceCarriesMoney` now covers the legacy shapes, so it can't then be deleted.

## On this Windows machine
- **Line endings:** files are CRLF in the working tree (`core.autocrlf=true`). Edit with the Edit tool or a script that keeps CRLF. A hook checks this, and `C:/Users/jonat/.claude/hooks/fix-eol.js` repairs it.
- **Known failures:** six `call-*-2026-11-09` node suites fail on a clean main here.
- **Rules emulator:** port 8080 is taken by another app on this machine, so run the emulator from a scratch `firebase.json` on another port. `RULES_PATH` points `firestore-rules.test.js` at another rules file; the supplements suite reads `../firestore.rules` itself.
- **Test runner:** `run-test-manifest.js --bucket node` stops at its 8-minute cap, so run the suites in parallel.
- **Flaky under load:** `sms-outbox-client` and `county-tenant-policy`.
