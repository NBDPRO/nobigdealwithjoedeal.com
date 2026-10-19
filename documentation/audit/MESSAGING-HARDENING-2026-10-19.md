# Messaging hardening — Twilio A2P is Verified, so every outbound path is gated (2026-10-19)

Owner: Jo. Scope: every message the system can send to a **customer** (SMS, MMS, email, OTP code, Bland SMS), plus the internal alerts to Jo. Principle (Jo): **less is more; nothing is sent by surprise.** Every automated customer send is OFF until it is explicitly switched on, inside what the carriers approved.

Background: the read-only audit of the same date (private, `C:\Users\jonat\Documents\NBD-Messaging\messaging-inventory-2026-10-19.md`) found no single kill switch, a broken storm cap, an ungated NWS storm poller, dark flags that turn HIGH-risk when set, and already-live email automations. The A2P campaign (Low Volume Mixed) covers only: request confirmation, appointment confirmations/reminders, estimate/project updates, invoice/payment notices, and opt-in Storm Alerts (2-4 a season), to people who ticked the unchecked consent box on an NBD website form.

## What changed (one line each, with where)

| # | Change | Where |
|---|---|---|
| 1 | `STORM_MAX_SMS_PER_DAY=0` (and `_PER_RUN`) now mean **zero sends**. Same swallow-zero pattern fixed on `ESTIMATE_EMAIL_GLOBAL_CAP`, `PUBLIC_AI_DAILY_CAP`, `OTP_GLOBAL_DAILY_CAP`. A test scans all of `functions/` so `Number(process.env.X) \|\| default` cannot come back. | `functions/env-number.js` (`envCap`), `tests/messaging-zero-cap-2026-10-19.test.js` |
| 2 | The NWS half of `stormPoller` is **OFF by default**: needs env `STORM_NWS_TEXT_ENABLED=true` AND `messaging_controls/automations.stormNwsText=true` AND `integrations/stormAlerts.enabled===true` (absent is now OFF, it used to be ON). Off = it does not even fetch the NWS feed. **Double opt-in**: a subscriber is texted only after replying YES to a confirmation text (`smsConfirmedAt`); `tcpaConsent` alone is not enough. | `sms-functions.js` `runCheckStormAlerts`, `storm-sms-guard.js`, `storm-confirm.js`, `storm-poller.js` |
| 3 | **One master kill switch** `messaging_controls/global`, read fail-closed, 10 s cache, honoured by every sender (see table below). Jo-only callable `manageMessagingControls` (App Check, typed reason, append-only `messaging_controls_audit`). Internal alerts to Jo have their own switch + hourly cap. | `functions/messaging-controls.js`, `messaging-controls-fns.js`, `sms-texting-gate.js` |
| 4 | **Canary**: with `canary: true` every customer SMS/email is redirected to Jo's own phone/email (from `messaging_controls/internal`), original recipient shown as `[would send to X]`, cc/bcc dropped. No owner contact configured = nothing is sent at all. OTP is paused under canary (a code cannot be previewed). | `messaging-controls.js` (`guardSms`, `guardEmail`, `guardTwilio`, `guardResend`) |
| 5 | Dark automations need **both** the env flag and an explicit entry in `messaging_controls/automations`, a per-run cap (`maxPerRun`, default 5, 0 = none), a 7-day age limit for the review ask, and an idempotency key per (recipient, template, job). Covers: `LEAD_ACK_SMS_ENABLED`, `MISSED_CALL_AUTOTEXT_ENABLED`, `REVIEW_ASK_AUTO_TEXT_ENABLED` (+ the live review **email**, lead-ack **email**, 20-48 h follow-up **email**, funnel-recovery email), `STORM_TEXT_ENABLED`, `TWILIO_INBOUND_ENABLED`, `integrations/sms.a2pApproved` (server texts need `a2pServerTexts`). | `lead-alert.js`, `review-ask-auto.js`, `call-center.js` + `missed-call-autotext.js`, `lead-followup.js`, `funnel-recovery.js`, `storm-watch.js`, `twilio-line.js`, `estimate-send.js`, `deal-acceptance.js` |
| 6 | **OTP**: kill switch (`otpEnabled`), the shared STOP register / NBD Do Not Text list read **before** Verify, global/day cap (0 now works), **new per-IP/day cap** (15). Quiet hours deliberately NOT applied (see below). | `verify-functions.js`, `tests/otp-hardening-2026-10-19.test.js` |
| 7 | **Rep-typed/queued texts**: a text needs a consent basis: stored, server-stamped web-form consent for that number, or a customer text to us in the last 7 days (replies only; a campaign gets no inbound exemption). Otherwise **"Blocked: no consent on file."** (403, nothing sent). Owner-only override with a typed reason (5-300 chars) logged to `sms_consent_overrides`; never beats STOP or a declined form. Queued (offline) texts older than **24 h** are refused (even with "send now"); AI reply drafts generated more than **24 h** ago are not sent on an approval tap (they end "failed / stale_draft"). Agent-inbox drafts are never server-sent (they are an `sms:` link from Jo's phone). | `sms-consent-declined.js` (`consentBasis`), `sms-functions.js` (`complianceGate`, `onAiDraftApproved`), `sms-outbox-guard.js` |
| 8 | **STOP/HELP replied by exactly one system**: config constant `STOP_HELP_REPLIES_FROM` (`app` default, or `twilio`). The opt-out is always recorded by `incomingSMS` either way. **Jo to verify in Twilio which one is live** (below). | `sms-functions.js` `keywordResponse` |
| 9 | Hard-coded phone numbers removed from `lead-alert.js`, `storm-watch.js`, `verify-functions.js`, `integrations/thursday.js`, `integrations/thursday-logic.js`; `TWILIO_VOICE_FORWARD_TO` removed from the tracked `functions/.env.nobigdeal-pro`. The values now come from `messaging_controls/internal` (or the `JOE_NOTIFY_PHONE` secret / a hand-set Cloud Run env var). No value is printed anywhere in this PR. | see "Config you must create" |
| 10 | Template review list (do NOT edit legal wording) + a test that fails if a NEW template carries a banned phrase: [MESSAGING-TEMPLATE-REVIEW-2026-10-19](MESSAGING-TEMPLATE-REVIEW-2026-10-19.md). | `tests/outbound-template-banned-phrases-2026-10-19.test.js` |

## The switches (all in Firestore, admin-SDK only; clients cannot read or write them)

`messaging_controls/global` (**missing, unreadable, or any field not exactly `true` = customer sends OFF**):

| Field | Stops when not `true` |
|---|---|
| `customerSendsEnabled` | everything below (master) |
| `smsEnabled` | customer SMS/MMS (rep texts, queued, D2D, AI replies, storm, acks, review ask, missed-call text, storm confirmation) and Bland SMS to a customer |
| `emailEnabled` | customer email (CRM send, estimate/invoice mail, e-sign links, report links, lead ack, follow-up, funnel recovery, review ask, storm report, estimate email, pro-playbook welcome, alert-address confirmation) |
| `otpEnabled` | verification codes to a phone a visitor typed |
| `canary` | (when `true`) redirect instead of send, see above |

`messaging_controls/automations` (each exactly `true`; **absent = every automation OFF**): `leadAckSms`, `leadAckEmail`, `leadFollowupEmail`, `reviewAskAutoText`, `reviewAskAutoEmail`, `missedCallAutotext`, `stormText`, `stormNwsText`, `stormConfirmText`, `funnelRecoveryEmail`, `twilioInbound`, `a2pServerTexts`; plus `maxPerRun` (whole number 0-50, default 5).

`messaging_controls/internal`: `ownerPhone` (E.164), `ownerEmail`, `internalAlertsEnabled` (absent = ON). Internal alerts to Jo (new-lead text/email, storm watch, new-lead from the estimate funnel, Thursday call alert) use ONLY this, never the customer switch, and are rate-limited per hour (`INTERNAL_SMS_PER_HOUR` default 30, `INTERNAL_EMAIL_PER_HOUR` default 120, 0 = none).

Sender map (what a closed switch does):

| Path | Closed switch behaviour |
|---|---|
| Rep "Text" button, queued, D2D, AI-draft send, storm, acks, review ask, missed-call text | 403 / skipped; `sms-texting-gate.js textingStatus` asks the switch, and `guardTwilio` re-checks at the moment of the Twilio call (a flip landing in between still stops it) |
| CRM "Email" (invoice, estimate, docs), doc-draft send | 403 `messaging_paused`, logged as `blocked_paused`; draft claim released |
| E-sign link/reminder/signed copy, remote signing, report share, alert-address confirmation, pro-playbook welcome | `guardResend` returns a "not sent" Resend-style error; the existing failure handling applies (the signing link is still returned to the rep) |
| Customer-requested one-shot emails (estimate email, storm report) | dropped, logged `held_paused` (the trigger is one-shot; they are NOT queued) |
| Sweeps (follow-up, funnel recovery, review ask) | checked **before** claiming, so a pause never burns a lead's one-shot claim |
| OTP | "Text verification is paused right now. Please call (859) 420-7382." |
| Internal alerts to Jo | unaffected by the customer switch |
| Not covered on purpose | `emailQueueWorker` (dunning, trial, GDPR erasure, backups: account mail to contractors and Jo), team invites, rep digests, security notice to the account owner |

A structural test (`tests/messaging-senders-guarded-2026-10-19.test.js`) fails when any function calls Twilio or Resend without going through the guard, and when anything but `messaging-controls*.js` names the control docs.

## Security-review round (same day, after the first PR)

An independent review of PR #2572 found the following; each was confirmed against current `main` and fixed on the same branch.

| Finding | Fix |
|---|---|
| H1 canary failed OPEN (`canary` as `"true"`, `1` or absent meant LIVE) | Live only when `canary` is the boolean `false`. Absent / string / number / null = canary ON (redirect to the owner, or nothing if no owner contact). **A `messaging_controls/global` doc with no `canary` field is now canary, not live.** |
| H2 signed copies and e-sign reminders dropped silently under a pause | Signed copies are transactional/legal: they ignore the customer pause and canary and have their own narrow switch `legalCopiesEnabled` (default ON, only an explicit `false` stops them). A signed copy that still could not be emailed raises a high "Signed copy NOT emailed" bell. A reminder that did not go out no longer burns a reminder slot (retried daily, 5 misses then stops, audited). |
| H3 Storm "YES" hijack | The YES is a side effect AFTER the `sms_inbound_seen` claim; the inbound is still filed (note, AI draft, rep bell) and the one-line thank-you is added to the reply. Confirms only if the confirmation request is under 48 h old and nothing was texted to that number since. Replays of one MessageSid change nothing. |
| M1 consent evidence spoofable by a rep | `firestore.rules`: `tcpaConsent`, `tcpaConsentAt/Text/Source/Ip/Version` are frozen on lead update and refused on lead create (admin SDK / bridge only). Emulator test `firestore-rules.messaging-controls.test.js` (mutation-checked). Campaign vs reply: an unknown `source` label is now "automated" (no inbound exemption); an absent label (the plain Text button) is a reply. |
| M2 storm confirmation ignored the company texting switch | `sendPendingConfirmations` calls `textingStatus` first (fail closed). |
| M3 a pause burned one-shot claims | Pro-playbook welcome, storm report and estimate email check the pause BEFORE taking their claim and leave a visible marker (`welcomeSkipped: held_messaging_paused`, `reportEmailHeld`, `estimateEmailStatus: held_paused`). Playbook and portal copy no longer promise an email/signing link was already sent. |
| M4 voice regression | Dark voice reads the owner phone from `messaging_controls/internal` (public, non-sensitive; read failure = generic line, never an error). |
| M5 callable audit | Audit-first: an `intent` row is written before the flip and the flip does not happen if it fails; `before`/`after` logged; turning sends ON, an automation ON, or any owner-contact change needs a sign-in within 15 minutes (`auth_time`); a contact change queues a notice to the PREVIOUS owner email. **A flip made directly in the Firebase console is not audited by this code.** |
| M6 weak sender scanner | Site-by-site scanner (`tests/lib/sender-scan.js`): resolves each send's receiver to its nearest assignment, flags destructuring / aliasing / bracket access / bind / batch / raw `api.resend.com`+`api.twilio.com`, pins the exact number of raw (internal) sites per file, with negative fixtures that must fail. No parser is vendored, so this is a scanner, not an AST. |
| M7 no rules tests | `tests/firestore-rules.messaging-controls.test.js` (208 checks; wired into `ci.yml` and `firebase-deploy.yml`). |
| LOW | `maxPerRun` invalid values -> 0, ceiling 500; canary email drops customer unsubscribe `tags`; OTP refusal wording no longer reveals STOP status; internal-alert cap counts DISTINCT leads; `ignoreGlobal` callers pinned by a test; the business number literal is out of the new test fixtures. |

### Second review round (on PR #2574)

| Finding | Result |
|---|---|
| N1 dark voice leaked the number to an unsigned POST | Fixed: the owner phone is read only after the Twilio signature passes; an unsigned request gets the generic line and costs no read. Tested (unsigned dark and live: no number, zero reads). |
| N2 internal cap: denied lead got through on retry; marker never cleaned | Fixed: one transaction; the marker is written only when the count increments, so a denied lead stays denied; markers and counters carry `expireAt` (3 h) for a Firestore TTL policy (create one on `messaging_controls_counters.expireAt` to auto-clean). |
| H2 partial: reminders gave up silently; canary counted as sent | Fixed: giving up raises a high "E-sign reminders stopped" bell; a canary redirect is flagged `canary:true` by `guardResend` and `esign-io` treats it as NOT emailed. |
| M3 partial: canary consumed one-shot claims | Fixed: under canary the estimate email, storm report and pro-playbook welcome claim nothing, stamp nothing, send nothing. |
| H3 caveats | The logged confirmation text itself is ignored by the "newer outbound" check (send-then-YES test); a full page of 50 sms_log rows or a row with no usable date fails closed. |
| M1 | Rules tests added: delete-field, company_admin and manager on an own-tenant lead, another tenant, and forged/edited/deleted `sms_log` + `phone_texts` evidence rows (both are server-write-only). 249 checks. `consentBasis` reads only `leads.tcpaConsent*` (now frozen), `sms_log` and `phone_texts` (server-write-only). |
| N3 storm thank-you under a pause | The YES still confirms; the one-line thank-you text is sent only when texting is not paused. |
| N4 scanner labels | Every send site is already either guarded or pinned with a reason; a new site changes a count and fails. |
| N5 `notifyRep` wrap | Disproved: `notifyRep` already has its own try/catch and never throws. |
| N6 | `legalCopiesEnabled` added to the callable's fields and audit. |
| Canary matrix | absent / "true" / 1 / null / "false" / 0 / true: redirected for SMS and email; only `false` is live. |

### Third review round (on PR #2574)

| Finding | Result |
|---|---|
| A `email-queue-worker.js` sends raw | Exempt on purpose: every `email_queue` row is account mail to a contractor (dunning, trial, erasure, health) or to the owner, never a homeowner. The set of files that can queue a row is now pinned in `messaging-senders-guarded` (a new writer fails until reviewed). |
| B public-form flood starves the internal-alert cap | `internalAlertStatus` takes a `bucket`: public-form lead alerts (`lead-alert.js`, `verify-functions.js`) have their own hourly allowance, so a flood cannot use up the storm/call alert cap. The flood is still capped (the cost bound holds). |
| C claim consumed when canary/pause flips after the pre-check | `estimate-email`, `storm-report-email`, `pro-prospects` release the claim when the guard refuses or redirects to the owner, and never stamp "emailed". Test: the welcome flow with a canary flip between the pre-check and the send. |
| D `sms_log` rows without `toDigits` | Every current writer stamps `toDigits` and `date`; the YES check now ALSO queries by the E.164 `to`, so a row missing `toDigits` still blocks a YES (test mutation-checked). |
| E signature before `confirmFromReply` | Confirmed: 403 before any YES handling; a structural test pins the order. |
| F `toSms` can it be a customer? | No: it is `target.sms` only, which is the owner contact from config (NBD) or the verified tenant owner phone, else null; pinned by a structural test. |
| G canary email headers | `headers` (List-Unsubscribe / one-click) are dropped from the owner's canary copy. |

### Follow-up PR (after #2574 merged)

| Item | Result |
|---|---|
| B flood starves real lead alerts inside the lead bucket | `internalAlertStatus` takes a per-source pre-cap (`source` = the submitter's address; default 3 alerts per source per hour, `INTERNAL_PER_SOURCE_PER_HOUR`): a source over its share is refused WITHOUT spending the bucket, so 31 fakes from one address cost 3 slots and a real lead from another address is still alerted. A distributed flood from many addresses can still use the bucket (the cost cap holds). |
| C pause after the pre-check in `pro-prospects.js` | The pause now releases the claim and marks `welcomeSkipped: held_messaging_paused` instead of `send_failed` with the claim kept. |
| C caps spent before the guard | `estimate-email.js` (`spendCaps()`) and `storm-report-email.js` spend the per-recipient / global caps only AFTER `guardEmail` says the send is real; a late canary now releases the claim and sends nothing to anyone. |
| A enforce the `email_queue` exemption | `tests/email-queue-recipients-2026-10-19.test.js` pins every queued recipient expression with proof it is a platform address, the owner, or the account holder's own Auth email; the worker header states the rule. |
| CRLF regex | The `lead-source-fixer` "no boot-time reads" check normalises CRLF. |

**Not changed (decisions for Jo):** the personal/business email constants in `lead-alert.js`, `storm-watch.js`, `lead-digest.js`, `marketing-report.js`, `thursday.js`, `verify-functions.js`, `handlers/_shared.js` and `THURSDAY_NUMBER` stay in code: moving them to config would silence Jo's alert EMAILS (the most reliable channel) until `ownerEmail` is set, which is worse than a constant that is already public. Thursday: with `OWNER_NUMBERS_DEFAULT=[]`, Jo's own test calls count as leads if `messaging_controls/internal` is unreadable.

## IMPORTANT: merging deploys this, and customer sends default to OFF

Because the controls fail closed, **the moment this merges and deploys, every customer message stops** (rep texts, CRM emails, e-sign links, lead ack, follow-ups, OTP) until `messaging_controls/global` exists. That is the requested default. If you want customer email/CRM to keep working through the deploy, create the docs below **before** the merge deploys (Firestore console is instant; nothing needs a deploy).

## Jo: exact steps (Firebase console, project `nobigdeal-pro`, Firestore Database)

1. Create document `messaging_controls/internal` (collection `messaging_controls`, document id `internal`):
   - `ownerPhone` (string) = your cell in E.164 (e.g. `+1859…`)
   - `ownerEmail` (string) = the inbox the canary copies go to
   - `internalAlertsEnabled` (boolean) = `true`
   Without `ownerPhone` your new-lead alert TEXT stops (email + push still go) and Thursday cannot recognise your own test calls.
2. Create `messaging_controls/global` for the **canary test**:
   `customerSendsEnabled` = true, `smsEnabled` = true, `emailEnabled` = true, `otpEnabled` = **false**, `canary` = **true** (all booleans; `canary` must be written explicitly: absent now means canary ON, and ONLY the boolean `false` is live).
3. Do NOT create `messaging_controls/automations` yet: no automation sends.
4. Wait about 15 seconds (the controls are cached for 10 s).
5. Canary test (sends ONLY to you): on https://nobigdealwithjoedeal.com/inspect submit a request with **your own phone and email** and tick the text consent box (that creates a lead with stored consent). In the CRM open that lead, tap **Text**, send "canary test", then use **Email** on the same lead. Expected: a text on your phone starting `[would send to +1…]` and an email titled `[CANARY] …` with `[would send to …]` at the top. Nothing reaches the address you typed other than you.
6. If anything looks wrong: set `customerSendsEnabled` = false (or delete the doc). Effect within ~10 s.
7. **Go live later**: set `canary` = **false** (the boolean; the console field type must be boolean) and `otpEnabled` = true. Texts to people with no stored consent will answer "Blocked: no consent on file" (by design: text those from your own phone).
8. Automations later, one at a time, only inside the registered use case: set the entry in `messaging_controls/automations` (e.g. `leadAckSms` = true) **and** its env flag; leave `maxPerRun` at 5. Review requests, follow-up nudges, nurture and reactivation are NOT in what was registered with the carriers.

The callable `manageMessagingControls` (`get`, `set`, `setAutomations`, `setInternal`, owner uid only, reason required, audit-logged) exists for a future settings screen; there is no UI yet, so use the console.

## Verify in Twilio (I could not see these from the repo)

- Which webhook the live number uses and whether Messaging > Services > (the service) > Opt-Out Management (Advanced Opt-Out) is on. **If it is on, set the env var `STOP_HELP_REPLIES_FROM=twilio`** on `incomingSMS`'s Cloud Run service so the homeowner gets one reply, not two. If it is off, leave the default (`app`).
- That the sending number (`TWILIO_PHONE_NUMBER`) is in the approved campaign's Messaging Service sender pool (the code sends with `from:`, not a Messaging Service SID).
- The registered storm sample #2 contains "documents damage free before you call insurance": see the template review.

## Why OTP has no quiet-hours rule

A verification code is requested by the person at the keyboard right now. Federal quiet hours are about solicitations; a code the visitor just asked for is not one, and a 10pm block would only break the estimate form. What does apply: the owner's `otpEnabled` switch, the STOP register, the 10-minute and daily per-IP/per-phone caps and the global daily cap. Counsel can overrule this.

## Remaining risks (not fixed here)

| Risk | Detail | Suggested next step |
|---|---|---|
| Quiet-hours window | Code uses 8am-9pm recipient local; the compliance reference suggests a conservative 10am-8pm for Kentucky. | Counsel question 1, then one constant (`SEND_WINDOW`). |
| No UI for the switches or the consent override | Console only; the owner override has an API (`consentOverrideReason`) but the CRM has no field for it. | Settings screen + a prompt on the "no consent" refusal. |
| Customer-requested one-shot emails during a pause | Estimate email and storm-report email are dropped, not queued. | Decide whether to queue or show "we'll call you". |
| Registered sample vs. send wording | Storm text sample #2 (registered) carries wording flagged in the review list; the double-opt-in confirmation text is new wording close to registered sample #3. | Counsel + compare to the 10DLC registration before enabling `stormConfirmText`. |
| Thursday agent line `THURSDAY_NUMBER` and the public business number (859) 420-7382 | Business lines, published on the site, still constants. | None needed unless Jo wants them in config too. |
| Tenant owners' alert texts | A non-NBD tenant owner's lead-alert text goes out on NBD's campaign number; it now needs the customer SMS switch, but campaign scope for third-party tenants is unresolved. | Decide whether tenants may use the NBD number at all. |
| `emailQueueWorker`, team invites, digests | Treated as account/internal mail, not behind the customer switch. | Confirm that classification. |
| Cache | Controls are cached 10 s per instance, so a flip takes up to ~10 s (plus a cold instance). | Fine; lower `CACHE_MS` if wanted. |
| Canary consumes one-shot claims | A canary run stamps "ack sent"/claims for real leads, so those leads will not get the real message later. | Use test leads for the canary. |
| Prod flag values | Live env values of the Cloud Run services were not readable; only the repo env file. | Jo reads `LEAD_FOLLOWUP_ENABLED`, `REVIEW_ASK_AUTO_*`, `FUNNEL_RECOVERY_ENABLED` in the console. |

## Tests added

`messaging-zero-cap`, `messaging-controls` (fail-closed, cache, canary, internal alerts, callable), `messaging-send-gates` (kill switch, canary, consent basis, override, 24 h rules, STOP/HELP owner), `messaging-automations` (ack text/email, dedupe, internal alerts, helpers, sweep wiring), `otp-hardening`, `messaging-senders-guarded` (structural), `outbound-template-banned-phrases`, and a storm section 7 (default OFF, double opt-in, zero caps, confirmation flow). Older suites that pinned the previous defaults (storm "absent switch = on", ungated acks, hard-coded owner numbers, 7-day queue) were updated in place, noted in each.
