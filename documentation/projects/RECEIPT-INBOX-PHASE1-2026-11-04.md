# Receipt and job-cost inbox, phase 1 (2026-11-04)

Status: built, DARK, draft PRs, nothing merged, nothing deployed. Design and Jo's ten answers live in the vault note "Design - Receipt and Job-Cost Inbox 2026-11-04" (Money folder, outside the repo). This note records what the server half (PR A) does so the next session does not have to re-derive it.

## What PR A ships

- `functions/receipt-inbox-logic.js`: pure logic. Prompt and request body, the sanitizer, credit handling, reconcile, warnings, status, duplicate keys, the "looks like an existing cost" search, the related-cost search for a credit, the cap check, the paid-from suggestion, the form mapper and the plain-language money line. The block between the SHARED markers is meant to be mirrored byte-for-byte into the screen (PR B).
- `functions/receipt-inbox.js`: the callable `submitInboxReceipt({ storagePath })`.
- `firestore.rules`: `receipt_inbox/{id}`. Server creates; a browser can only DECIDE (approve / skip / not a business receipt / undo a skip).
- `functions/flags-registry.js`: `RECEIPT_INBOX_ENABLED` (dark; unset = dry run).
- Tests: `tests/receipt-inbox-logic-2026-11-04.test.js`, `tests/receipt-inbox-server-2026-11-04.test.js`, `tests/firestore-rules.receipt-inbox.test.js`, storage cases in `tests/storage-rules.test.js`, plus the existing guard lists (`ai-disabled-coverage`, `viewer-callables`, `ai-automations-server`, `flags-registry-drift`).

## How a receipt flows

1. The signed-in person uploads a photo or PDF to `receipts/{uid}/inbox/{ts}_{name}` (the existing private `receipts/{uid}/**` Storage rule already covers it: owner only, image or PDF, under 25 MB).
2. The screen calls `submitInboxReceipt`. Gates in order: signed in, not a viewer, `aiDisabled` kill switch, 20 reads a minute, the path must be the caller's own inbox folder, config `paused`, `RECEIPT_INBOX_ENABLED`, same-file check, inbox cap.
3. Unset `RECEIPT_INBOX_ENABLED` is a DRY RUN: the call validates and reports spend and cap, reads no file, calls no AI, writes nothing.
4. Same file twice: the draft id is `{companyId}__rcpt_<sha256 of the bytes>`, so a second upload of the same file returns the existing draft before any AI money is spent. It is company scoped (the older `visionCache` is keyed by bytes alone).
5. The reader (Claude Haiku 4.5) gets no tools and a fixed prompt that says the file is data. Its JSON is re-validated field by field; a job id, "approve" or any extra key in the reply is dropped. The server never picks a job.
6. A document the reader calls personal is dropped: the file is deleted from Storage and only the hash, the status `not_business` and a counter (`skippedPersonal`) are kept. Restaurant meals and fuel are NOT treated as personal by the reader; Jo decides those on the card.
7. Otherwise a draft is filed with status `ready` or `needs_look`. Nothing counts toward any total until the person approves that one row on the screen (PR B), which creates one expense through the normal `createExpense` path.

## Money rules in the mapper

- `amountCents` = total minus tax, `taxCents` = tax (same as the Home Depot import). A document with no tax line saves tax 0 and notes "Tax not shown".
- A negative total is a credit memo: positive cents plus `documentType: credit`, `entryType: credit`. Credits are only offered when the `costCredits` flag is on (checked on the screen; the server just reads the document).
- Paid-from is a suggestion from the card's last 4 digits (3537 = Business debit card), never a default. Unknown card = blank.

## Caps and switches

- Inbox cap $10 a month per user (`userCostMeter/{uid}__{YYYY-MM}.inboxUsd`, separate from the shared `visionUsd`), count cap 300 a month, hard stop AT the cap. Optional per-company override at `integrations/receiptInbox/companies/{companyId}`: `paused`, `monthlyCapUsd` (never above $50), `monthlyCountCap`, `cardMap` (last 4 digits to a paid-from word). That path is server only (no rules match, so default deny).
- The existing `aiDisabled` kill switch stops this reader like every other AI caller (see `documentation/runbooks/SPEND_KILLSWITCH.md`).
- Client flag `receiptInbox` in `feature_flags` (default off) is read by PR B.

## Not in phase 1

Drive watch, backlog seed, email-in and the Scan-with-AI tax fix are separate work. The Scan-with-AI tax double count needs Jo's OK after he sees a real receipt.

## Known limits

- Team members: the receipt picture and the draft belong to the uploader's uid (Storage is keyed by uid). An owner cannot open a member's inbox receipt.
- Nothing here was run against a real receipt, the real model or a phone. Reader accuracy on credit memos, delivery tickets and noisy copies is untested.

## What PR B ships (the screen)

- `docs/pro/js/receipt-inbox.js` + `docs/pro/css/receipt-inbox.css`: the "Receipt inbox" button (Expenses toolbar, flag `receiptInbox`), the capture / upload buttons, the list of waiting drafts with the month's AI spend, and the one-row approval card. Loaded by `script-loader.js` after the receipt sorter.
- `docs/pro/js/receipt-inbox-logic.js`: the screen copy of the logic. Its SHARED block is byte-identical to the server file (a test fails on drift); the rest ranks jobs with the existing receipt sorter (`NBDReceiptSorterLogic.rank`) on the PO text and adds the ship-to address as a weaker, suggestion-only signal.
- `docs/pro/js/expenses.js`: `createExpense` accepts `source: 'inbox'` and the fields that ride with it (`externalRef`, `inboxId`, `docNumber`, `orderNumber`, `paymentLast4`, `poJobName`, `reviewState`, `matchEvidence`), returns the new row id when asked (`returnId`), and an inbox "Overhead" pick saves `costType: overhead` (what the sorter does). Nothing changes for a manual save.
- `firestore.indexes.json`: `receipt_inbox` (`ownerUid` asc, `receivedAt` desc) for the list query.

How it behaves: opening, listing, picking a job, editing a field, and reading do not write any expense. Approve is disabled until THIS receipt has a job, Overhead or Park as unsorted picked by a person (even an exact customer-number match is shown, never pre-picked), the total and date are valid, a cost has a paid-from when `costsPaidFrom` is on, a credit has `costCredits` on, and a "looks like an existing cost" match has been acknowledged. One tap creates one expense through `createExpense`, then marks that draft approved (the rules check the expense exists, is the caller's, and carries the draft's `inboxId`). If the second write fails the screen says the cost WAS added and a retry never adds a second one. There is no approve-all and no auto-approve.

Left for later (phase 2+): Drive watch, backlog seed, email-in, remembered job names from the inbox, the vendor-fits-the-job warning, the "same vendor and day already on another job" warning. The Scan-with-AI tax double count is a separate PR that needs Jo's OK.
