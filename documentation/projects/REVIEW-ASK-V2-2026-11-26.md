# Review ask v2: text first, every company, job complete, one reminder (2026-11-26)

Jo asked for "an automatic review-request text after a job is done". Recon found that the automatic ask already exists (`functions/review-ask-auto.js` + `-logic.js`, 2026-10-15) and that its email has been live since then. This note records what was missing and what v2 changes. Everything ships **dark** behind `REVIEW_ASK_V2_ENABLED` (in `functions/.env.nobigdeal-pro`, `false`). With the flag off, v1 runs exactly as before: the live NBD email is unchanged.

Related: [REPUTATION-LOOP-2026-10-19](REPUTATION-LOOP-2026-10-19.md) (the review-gating audit and the review log the reminder reads), [JOB-COMPLETION-LOOP-RECON-2026-10-22](JOB-COMPLETION-LOOP-RECON-2026-10-22.md).

## v1 as it stands (unchanged)

- Daily at 10:00 ET. Asks every NBD customer who is paid in full, 3-21 days after the money was **received**, and only jobs paid in the last 7 days.
- One ask per job (a transaction claim on `reviewAutoAsk`). No rating gate, no incentive.
- Email is live. The text is dark and goes only to a customer with **no** email.
- Other companies are never asked (`not_nbd`). The link falls back to NBD's, which is written into the code.

## The five gaps, and what v2 does

| # | Gap | v2 |
|---|---|---|
| 1 | Email first; a text only when there is no email | **Text first**, then email. A text needs stored web-form consent, a number not on the STOP register, the declined-consent decision, the company's texting gate, and the SMS switch. Failing any of those means the email. Neither channel means skip (`no_channel`), and the ask is not used up. |
| 2 | NBD only; NBD's link, name and phone written into the code | Any company that opts in through `companyProfile/{companyId}.reviewAsk = { enabled: true, googleReviewUrl, signedBy? }`. The link, name, phone and email come from that profile. Another company's email: From is `"Its Name" <noreply@…>`, Reply-To is its business email, and the footer carries its own postal address. No profile link means no ask; there is no NBD fallback. |
| 3 | No reminder | **One** reminder, 7 days after the ask, on the same channel. Every check is re-read at send time: STOP, declined consent, unsubscribe, do not contact, lost/archived/deleted, still paid in full, still marked complete, the company's opt-in, and the send window. It is closed for good when a review is logged in `review_log/{leadId}`. It has its own claim (`reviewAutoAsk.reminder`) and send-once key (`review_ask_reminder_text`). A reminder more than 7 days overdue is dropped (`expired`), never sent late. |
| 4 | Trigger was "paid in full" only | Requires **paid in full AND job marked complete**: an `installCompletedAt` or `completedAt` stamp, or a stage history that passed Install Done or Final Photos. A customer who paid up front, and whom the payoff moved straight to Final Payment, is not asked until someone marks the install done. The rep nudge keeps that job (`willHandle` respects the rule under v2). |
| 5 | Other companies can't text | Every text goes from NBD's one registered A2P number. `sms_settings.registered` does not give a company its own number. So v2 texts only when the texting gate says the shared number is that company's own sender (`isNbd`). Every other company is emailed (`no_own_sender`). A real fix needs a sender number per company, which is follow-up work. |

## Files

- `functions/review-ask-v2-logic.js` holds the rules and the words. It is pure.
- `functions/review-ask-v2.js` holds `askOneV2` and `runReminders`. It is classified `commercial` in `email-suppression.js` SEND_PATHS and customer-guarded in `tests/messaging-senders-guarded-2026-10-19.test.js`.
- `functions/review-ask-auto.js` calls v2 only under the flag. Its cron runs the reminders after the asks and shares the run cap.
- `functions/review-ask-auto-logic.js` now exports `photoBlock`. `willHandle` also checks "marked complete" under v2.
- `tests/review-ask-v2-2026-11-26.test.js` has 65 checks (node bucket). It was written first and failed until the code existed. 7 of 7 mutants were caught: marked-complete, own-sender, text-first, review-seen, opt-in, expiry and the STOP line.

## Wording (reviewed by the compliance and lifecycle agents; not legal advice)

- **Text:** "Hi {first}, it's {signedBy with} {Company}. Thank you for choosing us. Would you leave us a Google review? {url} Reply STOP to opt out."
- **Reminder text:** "…{Company} here with one last note: if you have a minute, a Google review helps your neighbors pick a contractor. If you already left one, thank you. {url} Reply STOP to opt out."
- **Email:** the v1 words with the company's own name. The "fix it" line sits **below** the link: "If anything about the job isn't right, call us at {phone} or reply to this email. Either way, your review is welcome." The phrase "reply to this email" appears only when replies reach the company.
- **Reminder email:** ends "This is the only reminder we will send."

## Open questions for Jo (counsel / Twilio)

1. Counsel: does the stored web-form consent cover a review-request text, and is a review ask marketing under the TCPA? That decides how far a STOP reaches under FCC 26-67 (effective 2026-11-25). Is text-first acceptable? Both agents flagged this.
2. Twilio: do the approved A2P campaign's use case and sample messages include review requests?
3. Counsel: CAN-SPAM ad identification for the review email when there is no email-specific consent. Does "paid in full" as the trigger raise a selective-solicitation question?
4. Should a customer who texted STOP still get the **email**? It is lawful (separate channel), but some may read it as ignoring them. Today the first ask falls back to email; the reminder never switches channel.

## Not done (follow-ups)

- A sender number per company (Twilio subaccounts or campaigns). Until then, only NBD can text.
- A "customer replied" exit for the reminder (no reliable inbound signal per lead yet), and Comm Log (`sms_log`/`email_log`) rows for these sends.
- A Settings field for `companyProfile.reviewAsk`. Today it is set in the Firebase console. The dashboard script budget is nearly full.
- Customers whose time zone is unknown fall back to Eastern, and Pacific customers are outside the window at the 10:00 ET run. Both are existing v1 behaviour.
