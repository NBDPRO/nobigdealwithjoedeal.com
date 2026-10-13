# Docs to review: stage-triggered email drafts (2026-10-13)

Jo's ask: when a job hits a stage, draft the customer email that belongs to
that moment and park it on the customer card for review. **Nothing is sent
without Jo's tap.**

## What ships

| Stage event | Draft kind | sendEmail `kind` | Class |
|---|---|---|---|
| Contract signed / deal accepted | `schedule_confirm` | `appointment` | transactional |
| Crew scheduled | `crew_reminder` | `appointment` | transactional |
| Install complete | `warranty` | `document` | transactional |
| Install complete | `thank_you` (review ask) | none | **commercial** (blocked for unsubscribed) |
| Paid in full | `paid_receipt` | `receipt` | transactional |

Already existing, not duplicated: proposal (estimate shared), deposit invoice
draft (`deposit-draft.js`), final invoice draft (`draftFinalAtInstall`), the
"Request Review" task (`requestReviewTaskIfPaid`).

- Logic: `functions/doc-drafts-logic.js` (pure). I/O: `functions/doc-drafts.js`
  (create-only `leads/{id}/doc_drafts/ddraft_<lead>_<kind>_<job>`).
- Hook: `recordJobEvent` (job-spine.js), plus the lead trigger in
  `install-final-invoice.js` for Crew Scheduled (see below).
- Rules: `doc_drafts` read = owner / same-company staff / admin (never viewer);
  client update limited to `status, subject, body, sentAt, dismissedAt` and
  only while `status == 'draft'`; no client create or delete.
  Test: `tests/firestore-rules.doc-drafts.test.js` (emulator, own CI step).
- UI: `docs/pro/js/doc-drafts-ui.js`, lazy via `ScriptLoader.load` from
  `customer-bootstrap.module.js` (no boot tag). Edit, Send (email customers),
  Copy (Thumbtack / Yelp / phone-only), Mark sent, Dismiss. Send is blocked
  while a `[[placeholder]]` remains, on do-not-contact, and, for the review
  ask only, on unsubscribed / STOP. A draft is marked sent only when the
  platform delivered it (a mail-app handoff is not a confirmed send); the send
  leaves a `notes` timeline line.
- Tests: `tests/doc-drafts-2026-10-13.test.js`.

## Brief claims checked against origin/main

- **Wrong:** "recordJobEvent runs on ... `scheduled`". The event exists in
  `EVENT_TABLE` but nothing in `functions/` ever records it (a client stage
  move writes only the lead). Same gap `install-final-invoice.js` closed for
  `installed`. Crew-date drafts are therefore made by the existing lead trigger
  (`finalInvoiceOnInstall`) when a lead enters `crew_scheduled`.
- Right, with one extra: `functions/quiet-backfill.js` `isQuietBackfill(lead)` exists as named
  and is honored; the trigger also has its own `completedBackfill` entry check.
- Right: `deposit-draft.js` pattern, `sendEmail` takes no attachments, `to`
  must be on the record, transactional kinds list, `TIER_LABOR_YEARS` values,
  `lead.soldTier`.

## Warranty wording (decision for Jo)

The email states two separate warranties and says the signed paperwork
controls. The written labor term is stated **only for NBD with a `soldTier`**
(economy 1, good 5, better 10, best 20, beyond 20). Another company, or a job
with no sold tier (a repair), gets a `[[workmanship warranty term]]`
placeholder, so Send stays blocked until the rep fills it. Manufacturer line:
economy = standard limited, no system warranty; beyond = TAMKO HailGuard;
other tiers = "see your estimate and the manufacturer's paperwork" (it does not
name GAF System Plus, whose year counts GAF sets). The NBD Pledge sentence is
**not** in the email (it is a promise, not a written term). Source of truth
for the words: `estimate-config.js` `TIER_LABOR_YEARS` (copied, test-pinned)
and `warranty-cert.js`.

## Phase 2

Warranty certificate PDF attachment (needs a portal link or document row,
`sendEmail` takes no attachments); proposal-sent reminder; a dashboard badge
for queued drafts across customers (kept off `today-home.js` to stay clear of
the call-watch PRs).
