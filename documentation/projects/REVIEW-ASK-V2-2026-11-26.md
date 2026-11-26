# Review ask v2: text first + one reminder, NBD only (2026-11-26)

Jo asked for "an automatic review-request text after a job is done". Recon found the automatic ask already exists (`functions/review-ask-auto.js` + `-logic.js`, 2026-10-15) and its email has been live since then. Jo's scope decision for this PR was **"Text first + reminder"**:
- NBD only.
- The paid-in-full trigger stays.
- The multi-company ask is a separate PR with heavy abuse guardrails (plan first).

Jo's hard requirement: "we need to ensure no user can abuse, manipulate, extort, or lose us our verification with twilio".

Everything ships **dark** behind `REVIEW_ASK_V2_ENABLED` (`functions/.env.nobigdeal-pro`, `false`). With the flag off, v1 runs exactly as before.

Related: [REPUTATION-LOOP-2026-10-19](REPUTATION-LOOP-2026-10-19.md) (the review-gating audit, and `review_log`, which the reminder reads), [JOB-COMPLETION-LOOP-RECON-2026-10-22](JOB-COMPLETION-LOOP-RECON-2026-10-22.md).

## v1 (unchanged)

- Runs daily at 10:00 ET. Asks NBD customers who are paid in full, 3-21 days after the money was received, and only jobs paid in the last 7 days.
- One ask per job (transaction claim `reviewAutoAsk`).
- **Email first**. The text (dark) goes only to customers with no email.
- No rating gate, no incentive.

## What v2 changes

1. **Text first.** A text goes when every check passes:
   - stored web-form consent;
   - not on the STOP register;
   - the declined-consent decision allows it;
   - NBD's texting gate and the SMS switch are on;
   - the number was not asked in the last 180 days.

   Otherwise v1's email (jd@, unsubscribe and postal-address footer, optional before/after photo). Neither channel → skip, and the ask is not used up.
2. **One reminder**, 7 days after the ask, on the same channel. Every check is re-read at send time:
   - STOP, declined consent, unsubscribe, do not contact, lost / archived / deleted;
   - an open warranty claim;
   - **still paid in full** (a refund or reopened balance ends it);
   - the send window.

   It is closed for good if a review is logged in `review_log/{leadId}`. Its own claim (`reviewAutoAsk.reminder`) and send-once key (`review_ask_reminder_text`) make sure a rerun never sends twice. A reminder more than 7 days overdue is dropped, never sent late. The wording says it is the last, and thanks anyone who already reviewed.

## Guards for NBD's A2P registration (each enforced in code and tested)

| Requirement | Enforcement | Test (`tests/review-ask-v2-2026-11-26.test.js`) |
|---|---|---|
| No other company's message from NBD's number | `planText` refuses a lead whose companyId is not NBD's (`not_nbd`). `sendCheckedText` re-checks just before Twilio. v1's `baseEligibility` also refuses. | A |
| Content matches the campaign | Two fixed templates, with nothing typed by a user except a first name stripped to letters. `smsContentOk()` runs before every text: exactly one URL, an allowlisted Google review shape (`g.page/r/<id>/review` or `search.google.com/local/writereview?placeid=`), no shorteners, ends with "Reply STOP to opt out.", at most 320 characters. A rep's saved link that is not a Google review page is replaced with NBD's. | C |
| Protect the recipient | One review ask per phone number per 180 days, across every lead (`review_ask_phones/{sha256}`: hashed, server-only, caught by the rules' catch-all deny). One ask plus one reminder. 8am-8pm in the customer's time. STOP honored. | D, F |
| No gating, conditions or incentives | The same words to everyone. No ask while money is owed or during an open warranty claim. The trigger is automatic, so nobody can fire it by hand. | B, C, E |
| Audit | Every ask and reminder writes a `review_requests` row with `triggeredBy: 'system:reviewAskAutoSweep'`. | G |
| Caps and kill switches | Existing `messaging_controls/automations` `maxPerRun` (shared by asks and reminders), the per-automation flags, the global switch and the canary. | existing suites |

**Not built here (multi-company PR):** auto-pause on carrier error, opt-out or complaint thresholds (30007, 21610, …). Error codes are labelled in `messaging-center-logic.js`, but nothing pauses on them yet. For this PR, texts go only from NBD's own number to NBD's consented customers, under the per-run cap.

## Files

- `functions/review-ask-v2-logic.js`: rules and words (pure).
- `functions/review-ask-v2.js`: `askOneV2` and `runReminders`. Classified `commercial` in SEND_PATHS and customer-guarded in `tests/messaging-senders-guarded-2026-10-19.test.js`.
- `functions/review-ask-auto.js`: calls v2 only under the flag. The cron runs reminders after the asks.
- `functions/review-ask-auto-logic.js`: `willHandle` hands an open-claim job back to the rep nudge under v2.
- `tests/review-ask-v2-2026-11-26.test.js` (55 checks, node bucket). 13 of 13 mutants were caught.

## Open questions for Jo (counsel / Twilio)

1. Counsel: does the stored web-form consent cover a review-request text? Is a review ask marketing under the TCPA (that decides how far a STOP reaches under FCC 26-67, effective 2026-11-25)? Is text-first acceptable? Both review agents flagged this.
2. Twilio: do the approved A2P campaign's use case and sample messages include review requests? If not, update the campaign **before** turning the text on.
3. Counsel: CAN-SPAM ad identification for the review email, and whether paid-in-full as the trigger raises a selective-solicitation question.
4. A customer who texted STOP still gets the first ask by **email** (lawful, separate channel). The reminder never switches channel. Keep that?

## Follow-ups

- The multi-company review ask: recon, a written guardrail plan, the security and compliance reviews, and Jo's OK before any code.
- A "customer replied" exit for the reminder, and Comm Log (`sms_log`/`email_log`) rows.
