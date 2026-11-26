# Review ask S3: carrier and complaint health, auto-pause (2026-11-26)

Slice S3 of [the review-ask guardrail plan](REVIEW-ASK-MULTITENANT-GUARDRAIL-PLAN-2026-11-26.md) (§G3, §5 row S3).
It serves NBD's [review ask v2](REVIEW-ASK-V2-2026-11-26.md) texts first and the email-only company ask (S1 + S2).
It ships **dark** behind `REVIEW_ASK_HEALTH_ENABLED=false`.

Code: `functions/review-ask-health-logic.js` (pure), `functions/review-ask-health.js`.
Tests: `tests/review-ask-health-2026-11-26.test.js`, plus rules section 65 (three more collections).

## Jo's decisions (2026-11-26, "OK all seven")

1. **Where NBD's pause lives.** NBD's pause is `review_ask_tenants/{NBD uid}.paused`. `manageReviewAskTenant` may `get` / `pause` / `unpause` NBD (nothing else). An NBD pause stops NBD's review **texts** (the v2 ask and the reminder). The live jd@ review **email** keeps going; its complaints and bounces are still counted and alerted. For other companies (email only today) a pause stops their review email (S2's `tenantReady` already checks `paused`).
2. **Heartbeat.** The text pre-flight refuses while any review text sent 1 hour to 7 days ago has had **no** status callback at all.
3. **STOP attribution.** A STOP from a number that got a review text in the last 14 days counts for that company, once per inbound MessageSid.
4. **Email signals.** Only review-ask email counts (the unsubscribe token's source is `review-ask-auto` or `review-ask-tenant`). Only complaints and PERMANENT bounces count.
5. **Thresholds.** The §G3 proposals, as named constants (`THRESHOLDS`). **D2 is still open**: Jo sets the real values later.
6. **No global pause in S3.** Only NBD texts today; the pause for every non-NBD text sender waits for S5.
7. **Alert bucket.** Pause alerts get their own bucket: a day ledger at `system/ownerNotify_review_ask` (4 a day) and their own hourly internal-alert allowance. The morning flush covers it too.

## How it works

- **Before every review text**, `recordTextSend` writes `review_ask_sends/{32-hex id}` (company, sender `nbd`, hashed number, template; never the phone or the body) and a heartbeat entry. The text carries `statusCallback` = `https://nobigdealwithjoedeal.com/api/review-ask/status?s=<id>`. No row, no text. If Twilio refuses the text, the heartbeat entry is removed.
- **`reviewAskTextStatus`** (Hosting rewrite `/api/review-ask/status`):
  1. It reads the send row (a bad id gets 400, an unknown one 404).
  2. It verifies X-Twilio-Signature with **that row's sender's** token, then the AccountSid and the MessageSid. A company subaccount has no token yet, so it gets 403. Nothing is written before this point.
  3. One transaction per (send, status) writes the mark, counts a listed code, and clears the heartbeat.
- **Counted codes**, per company per ET day (`review_ask_health/{companyId}_{ymd}`): 30007, 30003, 30005, 30006, 21610, 30034, `stops`, `complaints`, `bounces`, and the `textSends` / `emailSends` denominators. The marks in `review_ask_counted` make each signal count once: `{sendId}_{status}`, `stop_{MessageSid}`, `resend_{svixId}`.
- **Pause thresholds**, rolling 7 days:
  - Always, at any volume:
    - any 30034;
    - any 30007;
    - 2 or more STOPs;
    - 3 or more unreachable (30003 / 30005 / 30006);
    - 1 complaint.
  - Once there are 20 or more sends:
    - 30007 at 2 or more, or above 1%;
    - opt-outs (STOPs + 21610) above 3%;
    - unreachable above 10%;
    - bounces above 5% (with 20 or more emails).
- **A pause** does four things: it sets `paused`, `pausedReason` (`health_<reason>`), `pausedBy` (`system:reviewAskHealth`) and `rampStage: 1`; it writes an `auto_pause` row to `review_ask_audit`; it calls `notifyOwner` (severity `alert`, key `review_ask_pause_<companyId>`, bucket `review_ask`); and its alert text names the company by id plus a fixed reason, never a company-written name. It alerts only when the company goes from not paused to paused.
- **Only a platform admin clears it** (`manageReviewAskTenant` unpause, `role == 'admin'`). Every new collection falls under the rules' catch-all deny, and section 65 now covers `review_ask_health`, `review_ask_counted` and `review_ask_heartbeat` too.
- **Hooks** (each one best-effort, never throws, writes nothing while dark):
  - `incomingSMS` and `twilioSmsWebhook` call `noteStop`, after the opt-out register write;
  - `resendWebhook` calls `noteEmailEvent`, after the suppression record;
  - the v1/v2 email send and S2's company send call `noteEmailSend`.

## Flag off (today)

- `reviewAskTextStatus` answers 200 and writes nothing.
- The counters write nothing.
- `textHealthOk` returns `health_dark`, so **no review text is sent** and v2 falls back to its email (fails closed).
- v1 and the live jd@ email behave exactly as before.

## Turn-on steps (none done; Jo's call)

1. Deploy.
2. Check that `https://nobigdealwithjoedeal.com/api/review-ask/status` answers a POST with 200 (dark).
3. Set `REVIEW_ASK_HEALTH_ENABLED=true` and deploy. On its own this sends nothing: the v2 text flags are still off.
4. When Jo turns the v2 texts on (`REVIEW_ASK_V2_ENABLED`, `REVIEW_ASK_AUTO_TEXT_ENABLED`, automations `reviewAskAutoText`), start with automations `maxPerRun: 1`.
5. Within an hour of the first text, check that its `review_ask_sends` row has `callbacks >= 1` and `review_ask_heartbeat/{NBD uid}.pending` is empty. If the callback never comes, the pre-flight stops further texts by itself (`callbacks_missing`).
6. To clear a pause: `manageReviewAskTenant { companyId, action: 'unpause' }` as platform admin, after reading the `auto_pause` audit row.

## Open / later

- **D2:** the real thresholds.
- **S4 / S5:** subaccount tokens from Secret Manager in `signerFor`; the global pause on account-level signals (30034, suspension); inbound STOP on subaccount numbers.
- Exclusion-rate tracking (G5) is not in S3.
