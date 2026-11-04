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
2. The screen calls `submitInboxReceipt`. Gates in order: signed in, not a viewer, `aiDisabled` kill switch, 20 reads a minute, the path must be the caller's own inbox folder, config `paused`, `RECEIPT_INBOX_ENABLED`, the company is switched on (`enabled: true` in its server-only config), same-file check, inbox cap, then a reservation on the company meter (below).
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

- Inbox cap $10 a month per COMPANY (`receiptInboxMeter/{companyId}__{YYYY-MM}.inboxUsd`, separate from the shared `visionUsd`), count cap 300 a month, hard stop AT the cap. Before each read a transaction books $0.25 on the meter and re-checks the cap, so parallel taps cannot overshoot; after the read the booking is settled to the real cost (released when the provider refused the call, kept when billing is unknown). Company members can read the meter; only the function writes it.
- Server-side switch: the reader runs only for a company whose config doc says `enabled: true`. The client `receiptInbox` flag only shows the screen; it is not a gate.
- Per-company config at `integrations/receiptInbox/companies/{companyId}`: `enabled`, `paused`, `monthlyCapUsd` (never above $50), `monthlyCountCap`, `cardMap` (last 4 digits to a paid-from word). That path is server only (no rules match, so default deny).
- The existing `aiDisabled` kill switch stops this reader like every other AI caller (see `documentation/runbooks/SPEND_KILLSWITCH.md`).
- Client flag `receiptInbox` in `feature_flags` (default off) is read by PR B.

## Not in phase 1

Drive watch, backlog seed, email-in and the Scan-with-AI tax fix are separate work. The Scan-with-AI tax double count needs Jo's OK after he sees a real receipt.

## Known limits

- Team members: the receipt picture and the draft belong to the uploader's uid (Storage is keyed by uid). An owner cannot open a member's inbox receipt.
- Nothing here was run against a real receipt, the real model or a phone. Reader accuracy on credit memos, delivery tickets and noisy copies is untested.

## Update 2026-11-04 (security review)

A read-only security review of PR A found the cap was per uid (a company of N seats got N x $10, and a stranger could open accounts for more), nothing on the server limited the reader to approved companies, and the cap was check-then-spend (20 parallel taps at $9.99 all passed). Fixed on this branch: the company meter, the `enabled` allowlist, the reserve-then-settle transaction, settling before the AI spend log (a failing log can no longer leave a call unmetered), and concurrency 4 instead of 20 (a 1GiB instance holding 20 HEIC decodes could run out of memory). Each new check in `tests/receipt-inbox-server-2026-11-04.test.js` section K was shown to go red with its guard removed.

Not changed, for Jo to decide: a document the reader calls personal is still deleted by the server (text printed on a document can steer that verdict; the alternative is to mark it and let the person confirm), and the UI must escape the read vendor / PO / line text (PR B).

Turning it on for NBD: deploy, set `RECEIPT_INBOX_ENABLED=true`, then add `enabled: true` to `integrations/receiptInbox/companies/{NBD companyId}` and flip the `receiptInbox` client flag.
