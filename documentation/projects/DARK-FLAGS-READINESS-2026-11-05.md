# Dark features: what is built, what each flag does, what to check before flipping (2026-11-04)

Source: the feature notes under `documentation/projects/` and `functions/flags-registry.js` on `origin/main`, read this evening.

**What I could not see:** which flags are already ON in production. `feature_flags/_default` lives in Firestore and I have no prod access. Open it in the Firebase console first and tick off what is already on. I also did not run any feature; this is from the notes and the registry, not from using the screens.

## How to flip and undo

- **Client flags** (the `camelCase` ones): Firebase console, Firestore, `feature_flags/_default` (everyone) or `feature_flags/{your uid}` (just you). Set the field to the boolean `true`. To undo, set it to `false` or delete the field. The CRM caches flags for up to 10 minutes, so reload to see a change. A per-uid override on your own account is the safest first step.
- **Server gates** (`UPPER_CASE_ENABLED`): set in `functions/.env.nobigdeal-pro` and deployed, so turning one on or off is a PR plus a deploy. Off means a dry run (logs only, nothing stored, nothing sent).
- **Global brakes that already exist:** `messaging_controls/global` (texting) and the `aiDisabled` kill switch (AI calls).

## Tier 1: lead response and estimate follow-up (closest to revenue)

| Flag | What it does | Check before flipping | Needs |
|---|---|---|---|
| `speedToLead` | One-tap "Replied" on a lead, matches your outbound calls to leads, shows median and p90 reply time by source. Sends nothing. | Open it on your own uid, tap Replied on one test lead, confirm the call matching picks up a real call. | Nothing blocking. |
| `leadSourceFixer` | Lets you confirm the real source of each lead (the intake source is often wrong), so "where customers came from" uses your answer. | Answer a few cards, check the Lead Sources table changes. | Nothing blocking. |
| `estimateFollowBoard` | Groups open estimates, "opened but silent" first, then by value, with a projected total. Files drafts only. | The note says **"flag stays off until counsel answers"** its questions on follow-up wording. | Counsel's answers. |
| `followUpBoard` | One screen ranking who needs you next (promised estimates, silent leads). Every button files a draft for you to edit and send. | Counsel should read the `fu_new_checkin` wording first. Supersedes the older board. | Counsel read. |
| `thumbtackOpportunities` | Shortlists Thumbtack opportunities and drafts a first reply for your approval. Reads nothing from Thumbtack, sends nothing. | Needs its server pieces (merged); check the second flag in its note. | Review the note's flag table. |
| `bulkCloseStaleLeads` | A one-time clean-up button for stale `new` leads (86 sat there, 40 untouched Thumbtack leads). | It changes stages for many leads at once. Use on one test batch first. | Your judgment on which leads. |

## Tier 2: money accuracy (so margins and the monthly close are real)

| Flag | What it does | Check before flipping |
|---|---|---|
| `jobCostAuditor` | Flags finished jobs whose margin looks too good (20 of 21 read about 100%). | Safe to read-only review first. |
| `subPaymentsSorter` + `cashPayoutsLog` | Log crew and sub pay per job, including cash. The auditor works without them but is more accurate with them. | Turn on together; check one job. |
| `paymentBackfill` | Paste in checks, Zelle and cash payments that never reached the CRM. | **Silences automations on backfilled invoices** per its note, and needs `subPaymentsSorter`. Read its duplicate rules first. |
| `depositedToField` | Optional "deposited to" account on a payment, for bank reconciliation. | Tiny; off means payment writes are unchanged. |
| `costCredits` | Credits, refunds and returns as negative costs (the ABC Supply credit memo case). | Gates creating credits only; existing credits keep netting out either way. |
| `monthClose` | Monthly close panel: collected, costs, bank gap, tax set-aside on net profit. | Check the tax set-aside figure against your CPA's method before relying on it. |
| `receiptSorterQueue` | Receipt review queue; ranks likely jobs, never auto-picks. | Note says it has not run on real receipts yet; do a dry run first. |
| `lowesImport` | Lowe's Pro purchases as job expenses, like the Home Depot import. | Same review-table pattern as the HD import. |
| `subPaperwork` | Tracks sub W-9s and insurance certificates. | Read-only card. |

## Tier 3: reputation, messaging, documents

| Flag | What it does | Check before flipping |
|---|---|---|
| `reputationLoop` | Who was asked for a review, what was posted, what needs a reply. Sends nothing public. | Alerts go to the owner only. |
| `messagingControlCenter` | One screen for texting switches and the A2P status. | A2P went Verified on 2026-10-19, so texts really deliver. Owner and admin only. |
| `secureDocLink` (client) + `SECURE_DOC_LINK_ENABLED` | Password-protected tracked document link. The server master switch is already ON in the env file (merged #2798). | Per the note, test on your own lead with your own phone and email, including a scanner mailbox. |
| `DOC_LINK_FOLLOWUP_ENABLED` | Hourly: an inbox note 24 hours after a customer first opens a secure link. | Turn on only after the link itself has been tested. |
| `thursdayLabelPlaybooks` | Per-label caller playbooks for Thursday, the AI receptionist. | Check the wording before callers hear it. |

## Server gates, all currently OFF (dry run)

`TEXT_INBOX_ENABLED`, `TEXT_NOTES_ENABLED`, `AWAY_MODE_ENABLED`, `MORNING_BRIEF_DELTA_ENABLED`, `COMPANY_DOC_EXPIRY_ENABLED`, `SUB_PAPERWORK_WATCH_ENABLED`, `OWNER_WEEKLY_DIGEST_ENABLED`, `DOC_LINK_FOLLOWUP_ENABLED`, `CARE_PLAN_MODE`, `SOCIAL_GBP_ENABLED`. These write inbox notes, never anything to customers. Three wait on A2P approval: `TWILIO_INBOUND_ENABLED`, `MISSED_CALL_AUTOTEXT_ENABLED`, `REVIEW_ASK_AUTO_TEXT_ENABLED`. The note says A2P is now verified, so those three may be ready to consider.

## Not on this page yet

`receiptInbox` and `RECEIPT_INBOX_ENABLED` (PRs #2792 and #2793 are still in the queue), the lien clock (`lienClock`, only described in the contract-strengthening plan), and the storm radar swaths (#2840).

## If I had to pick three to flip first

1. `speedToLead` (your own uid): cheapest, no wording risk, and Thumbtack bills per lead reply.
2. `leadSourceFixer`: your own answers drive the marketing decisions.
3. `jobCostAuditor`: read-only, and it shows which finished jobs have fake margins.
