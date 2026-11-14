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
| Managers can't delete leads; lead Archive | #3082 (+ an archive branch) |

## Rules every later change must keep
- **Which payment a reversal cancels comes only from frozen fields.** `firestore.rules` `payKept` lets an invoice editor rewrite every key of a `payments[]` entry except `amount`, `at`, `method` and `recordedBy`. Never trust `paymentId`, `reverses`, `reversal` or `reason` for that decision (see `functions/reversal-pairs.js`).
- **Revenue readers count negative ledger entries.** `collected-revenue.js` and its mirrors must stay in step (`tests/money-field-contract.test.js`).
- **The invoice update rule sits at Firestore's 1,000-expression limit.** `tests/firestore-rules.test.js` pins a 12-payment append. Measure any new clause with the emulator. A rules-checked reversal ran past the limit, which is why reversal is a callable.
- **A new callable needs the full registration.** That means:
  - `exports.X = onCall(` in its module, because the deploy workflow greps for that shape;
  - `functions/index.js` and `FUNCTIONS_INDEX.md`;
  - `node scripts/gen-function-map.js`;
  - a verdict in `tests/viewer-callables.test.js`;
  - words in `docs/pro/demo-sdk/firebase-functions.js`.

## On this Windows machine
- **Line endings:** files are CRLF in the working tree (`core.autocrlf=true`). Edit with the Edit tool or a script that keeps CRLF. A hook checks this, and `C:/Users/jonat/.claude/hooks/fix-eol.js` repairs it.
- **Known failures:** seven node suites fail on a clean main here (`photo-exif-capture` and six `call-*-2026-11-09`).
- **Test runner:** `run-test-manifest.js --bucket node` stops at its 8-minute cap, so run the suites in parallel.
- **Flaky under load:** `sms-outbox-client` and `county-tenant-policy`.
