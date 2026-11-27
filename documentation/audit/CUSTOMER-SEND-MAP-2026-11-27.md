# Customer send map: every email and text that can reach a customer (2026-11-27)

A read-only map of every path that can send an email or a text to a customer,
what switches hold it, and what is live right now. Two mappers (email, SMS)
read the code on `origin/main` (23a1c9792). Two verifiers then re-checked them.
Where a verifier corrected a row, this note uses the verifier's reading.
Nothing in the code or in production was changed by this work.

Related: [MESSAGING-HARDENING-2026-10-19](MESSAGING-HARDENING-2026-10-19.md)
built the kill switch, the canary and the per-automation keys this note reads.

## What is live right now, and why

Production values, read back on 2026-11-27:

| Setting | Value |
|---|---|
| `messaging_controls/global` customerSendsEnabled (the master) | true |
| `messaging_controls/global` emailEnabled | true |
| `messaging_controls/global` smsEnabled | false |
| `messaging_controls/global` canary | false |
| `messaging_controls/global` otpEnabled | true |
| `messaging_controls/automations` | only `twilioInbound` is true |
| `sms_settings/<NBD>` enabled | false |

**The master fix.** The master switch had been "off" since about October. The
field was saved in the console with a leading space, so the code read it as
missing, and missing means off. Another session fixed it on 2026-11-27.

What that means today:

- **Email is live** for every path that only needs the master and email
  switches. Canary is off, so these go straight to customers. The switch is
  platform-wide, so other companies' rep emails resume too.
- **Every automatic email that has its own automations key is still held**,
  because no email automation key is on.
- **No business-line text (Twilio) goes to a customer.** `smsEnabled` and
  `sms_settings` are both off.
- **Phone verification codes are live.** They need only the master and
  `otpEnabled`, and both are on. (The SMS mapper assumed `otpEnabled` was
  absent; the read-back says it is true.)
- **Texts from a rep's own phone** that go through the server check are held
  by `sms_settings`. Plain "Text" links are not held by anything.

Side effects of the master being off for about six weeks:

- E-sign reminders that failed 5 times during the pause stopped for good. The
  rest will now go out at their next in-window hour, including reminders for
  envelopes whose first link email never went.
- Requests that were held during the pause are never retried and no screen
  shows them: "Email My Estimate", storm report copies, guide copies and Pro
  welcome emails.
- Signed copies were the only customer email going out during the pause.

## Email paths

"Tap" means a person pressed a button. "Auto" means a trigger or schedule.

| Path | Trigger | Tap or auto | Gates | State now |
|---|---|---|---|---|
| Rep email (`sendEmail`): invoice, follow-up, review request, portal link, email modal | Rep taps Send | Tap | Sign-in; recipient on the record; do-not-contact (fails closed); suppression + postal address for commercial kinds; rate limits; master + email + canary | **Live** |
| Draft send (Docs to review, stage drafts) | Rep taps Send on a draft | Tap | Draft-bound recipient; opt-out checks; rate limits; claim; master + email + canary | **Live** |
| Remote signing link (`createSignRequest`) | Rep sends for signature | Tap | Sign-in and tenancy; master + email + canary | **Live** |
| Report / document share link | Rep taps share or email | Tap | Recipient and volume check; master + email + canary | **Live** |
| E-sign link: first send, resend, next signer | Rep sends; or a signer finishes | Tap (or homeowner action) | Signer email on the record; master + email + canary | **Live** |
| E-sign **signed copy** (PDF attached) | Last signer submits | Auto (homeowner action) | Only `legalCopiesEnabled` (absent = on). Ignores master, email and canary | **Live** (was live all through the pause) |
| `esignReminderSweep` signing reminders | Every hour | Auto | Env on by default; **no automations key, no maxPerRun**; max 3 reminders, 2 days apart; live link; 8am-8pm signer time; master + email + canary; up to 200 envelopes a run | **Live** |
| "Email My Estimate" (`estimateEmail`) | Homeowner asks on /estimate | Auto (on request) | Env on by default; no automations key; Turnstile; rate limits; daily caps; master + email; canary = not sent | **Live** for new requests |
| Storm report copy (`stormReportEmail`) | Homeowner asks on /roof-check | Auto (on request) | No env flag; no automations key; suppression; caps; master + email; canary = not sent | **Live** for new requests |
| Guide copy (`guideCopyEmail`) | Homeowner asks for a guide | Auto (on request) | No env flag; no automations key; suppression; master + email; canary = not sent | **Live** for new requests |
| Pro playbook welcome | Contractor prospect signs up | Auto | No env flag; no automations key; suppression + postal; cap; master + email; canary = not sent | **Live** |
| Storm tips manual Send | Owner presses Send | Tap | Env on; consenting subscribers only; suppression + postal; master + email + canary; up to 200 per send | **Live** |
| Lead acknowledgement | Public form submitted | Auto | `leadAckEmail` key; master + email; 1 per person per 24 h; canary | Held (key off) |
| Lead follow-up (`leadFollowUpSweep`) | Every 3 h | Auto | Env on; `leadFollowupEmail` key; skips under canary; send window; suppression; max 5 a run | Held (key off) |
| Funnel abandon recovery | Hourly | Auto | Env off; `funnelRecoveryEmail` key | Held (env and key off) |
| Google review ask (v1, v2 when on) | Daily 10:00 ET | Auto | Env on (v2 env off); `reviewAskAutoEmail` key; skips under canary; paid 3-21 days ago; one per job; max 5 a day | Held (key off) |
| Review ask for other companies | Daily | Auto | Env off; `reviewAskTenantEmail` key; per-company approval | Held (env and key off) |
| Portal moments (booked, build day, job done) | Lead or appointment changes | Auto | Env on; `portalMomentEmail` key; one-time claim; suppression; daily cap; **no canary check** | Held (key off) |
| Storm tips schedule | Daily 11:00 ET | Auto | Env on; `stormTipsEmail` key; max 5 a day; send window | Held (key off) |
| Lead-alert address confirmation (to staff, not a customer) | Owner taps | Tap | Rate limits; the customer switch | Live (it was blocked during the pause) |
| Rep's own mail app (`mailto:`): nbd-comms fallback, email modal fallback, Agent inbox "Open in Mail", and direct mailto links in about 33 CRM files | Person taps | Tap | **No server switch** | Always works |
| Stripe receipts or invoice reminders | Stripe | Auto (outside our code) | Stripe dashboard settings only | Not verified |
| Cal.com booking confirmations | Cal.com | Auto (outside our code) | Cal.com settings | Outside the switch |

Not customer email, and not held by the customer switch on purpose: the
`email_queue` worker (Pro billing, trial ending, tenant welcome, erasure
confirmation, owner alerts), team invites, rep digests, the morning brief and
owner alert emails.

## SMS paths

| Path | Trigger | Tap or auto | Gates | State now |
|---|---|---|---|---|
| CRM Text button and every other `sendSMS` caller (Ask Joe confirm card, invoice pipeline, portal link helper, review engine, smart follow-up, D2D follow-up) | Rep taps Send | Tap | Sign-in; viewer refused; STOP + do-not-text (fails closed); `sms_settings`; master + SMS; consent; quiet hours; paid plan; rate limits; canary at send | Refused (`sms_settings` off) |
| Offline outbox replay | Device comes back online | Tap (queued earlier) | Same as above; items older than 15 min are held for a rep | Refused, kept in the outbox |
| `sendD2DSMS` endpoint | No screen calls it (direct POST only) | Tap | Same as above plus door consent and NBD-only knocks | Refused |
| Approved AI reply draft | Rep taps Approve | Tap | STOP + do-not-text; `sms_settings`; master + SMS; consent; stale after 24 h; quiet hours; canary at send | Refused (marked failed) |
| Close-board deal-accept link | Rep taps | Tap | Uses the business line only when `integrations/sms.a2pApproved` and the `a2pServerTexts` automations key are on; otherwise hands off to the rep's phone | Goes from the rep's phone |
| Own-phone hand-offs: Agent inbox draft text, share links (deal, estimate, document, sign, portal, care plan), the nbd-comms Messages fallback | Person taps; the phone's Messages app opens with the text filled in | Tap | STOP + do-not-text; consent; quiet hours; `sms_settings`. **Ignores the master and the canary** | Held (`sms_settings` off) |
| Plain "Text" links (Call Center card, quick action bar, CRM list, Today home, follow-up deck, dashboard widgets) | Person taps and types | Tap | **None on the server** | Always works |
| Missed-call auto-text | Call Center import, every 30 min | Auto | Env flags already **on**; `missedCallAutotext` key; master + SMS; consent; 8am-9pm; 24 h cooldown; one per call; max 5 a run | Held (key and SMS off) |
| Lead acknowledgement text | Public form submitted | Auto | Env off; `leadAckSms` key; consent; quiet hours; one per lead | Held |
| Review ask by text (v1 and v2) | Daily 10:00 ET | Auto | Env flags off; `reviewAskAutoText` key; skips under canary | Held |
| Storm Watch subscriber texts | Every 30 min | Auto | Env off; `stormText` key; double opt-in; quiet hours; cooldown | Held |
| NWS storm alert texts | Every 30 min | Auto | Env off; `stormNwsText` key; double opt-in; caps | Held |
| Storm opt-in confirmation text | Every 30 min | Auto | Env off; `stormConfirmText` key; consent; one ask only | Held |
| Storm "YES" thank-you (reply from `incomingSMS`) | Subscriber texts YES | Auto reply | `sms_settings` + master + SMS. No automations key, no canary | Dormant: the number points at a webhook that never sends (per the go-live runbook; not checkable from the repo) |
| STOP / HELP / START replies | Customer texts a keyword | Auto reply | None of the switches, by design (carrier rules) | Twilio's console opt-out handles it |
| Phone verification code (Twilio Verify) | Visitor asks for a code on a public form | Tap (visitor) | App Check; rate limits; master + `otpEnabled`; canary = refused | **Live** |
| Owner alerts by text (not customers) | Lead, storm and call triggers | Auto | Internal alert switch; always to the owner phone | Live, unaffected |

There is no picture-message (MMS) sender anywhere.

## What each remaining switch would wake up

| Switch | What starts |
|---|---|
| `sms_settings/<NBD>` enabled, alone | The own-phone hand-offs open again. Business-line texts stay refused (`smsEnabled` is off). |
| `smsEnabled` true, alone | Nothing. `sms_settings` still refuses first. |
| `sms_settings` + `smsEnabled` both on | Rep-tapped business-line texts: the Text button and every `sendSMS` caller, outbox items under 15 min old, approved AI drafts. With canary off they reach customers. |
| `a2pServerTexts` key (with `a2pApproved`) | The deal-accept link goes from the business line instead of the rep's phone. |
| `missedCallAutotext` key | Missed-call texts, up to 5 a run, as soon as SMS is on. Its env flag is already on, so this key is the **only** step left. |
| `leadAckSms`, `reviewAskAutoText`, `stormText`, `stormNwsText`, `stormConfirmText` keys | Nothing yet: each also needs an env flag that is off. |
| `leadAckEmail` key | An instant acknowledgement email for each new form submission. |
| `leadFollowupEmail` key | Up to 5 "we haven't connected yet" emails every 3 hours. |
| `reviewAskAutoEmail` key | Up to 5 Google review asks a day. |
| `portalMomentEmail` key | Booked / build day / job done emails, one per moment, no run cap. |
| `stormTipsEmail` key | Up to 5 scheduled storm-tips emails a day. |
| `funnelRecoveryEmail`, `reviewAskTenantEmail` keys | Nothing yet: their env flags are off. |
| canary true | Business-line texts and switch-held emails go to the owner instead (see below). |
| `legalCopiesEnabled` false | No effect while the master is on and canary is off (see finding 1). |

## The canary

When canary is on, the switch sends a copy to the owner instead of the
customer. Texts go to `messaging_controls/internal.ownerPhone` with a
"[would send to ...]" prefix. Emails go to the owner email marked [CANARY].
With no owner email set (`messaging_controls/internal.ownerEmail` or
`OWNER_ALERT_EMAIL`), every email is refused instead (`canary_no_target`).

What it does not do well:

- **It burns one-time claims.** These paths claim before sending, so the
  owner gets the copy and the customer never gets that message later:
  missed-call texts (the 24 h cooldown and the per-call claim are spent), lead
  acknowledgements (text and email), Storm Watch and NWS texts, the storm
  opt-in confirmation (that subscriber can never be confirmed), and portal
  moment emails.
- **It counts e-sign reminders as failed tries.** After 5, reminders stop for
  good.
- **It leaves records that say "sent" to the customer.** The Comm Log and SMS
  log show the customer's number as texted. Rep emails log "sent" and toast
  "Email sent". Drafts are marked sent. Signing and share links return
  `emailed:true`. The lead ack stamps `ackEmailSentAt`.
- Paths that skip cleanly under canary, with nothing spent: review asks, lead
  follow-up, funnel recovery, and the on-request emails (estimate, storm
  report, guide, Pro welcome), which send nothing at all.

What it does not cover:

- Own-phone hand-offs and plain `sms:` / `mailto:` links. A person's own phone
  or mail app sends straight to the customer.
- Signed copies, while `legalCopiesEnabled` is on.
- `incomingSMS` TwiML replies and STOP/HELP replies.
- Phone verification codes (refused under canary, not redirected).
- Stripe and Cal.com emails, and the `email_queue` worker.

## Findings

1. **Legal signed copies bypass the master by design.** The signed-copy email
   (`functions/esign-envelope.js:1270`, `legal:true`) ignores the master, the
   email switch and the canary. It even sends when the controls doc cannot be
   read. During the pause it was the only customer email going out. Setting
   `legalCopiesEnabled=false` does not stop it: it drops the copy back to the
   normal master + email + canary check. Now that the master is on and canary
   is off, there is no switch that stops only signed copies.
2. **`esignReminderSweep` is an automated customer email with no automations
   key and no maxPerRun.** It runs every hour across all companies, up to 200
   envelopes a run, on by default (`ESIGN_REMINDERS_DISABLED` unset). With the
   master fixed it is live again, including for envelopes whose first link
   email never went during the pause. Reminders are scheduled whenever emailing
   was requested, whether or not the email was delivered.
3. **Own-phone hand-offs open as soon as `sms_settings` is enabled, ignoring
   the master and the canary.** `functions/phone-text-check.js` uses
   `ignoreGlobal:true`. STOP, do-not-text, consent and quiet hours still apply.
   Turning on `sms_settings` before (or without) `smsEnabled` reopens these
   first. A person still sends each one.
4. **Plain `sms:` and `mailto:` links have no server gate at all.** No STOP
   register, do-not-contact, consent or switch check. That covers the "Text"
   links on many CRM screens and direct mailto links in about 33 CRM files.
   A person types and sends each one.
5. **Remote signing stamps "sent" before the email attempt.**
   `functions/remote-signing.js:696` marks the document "sent" before it tries
   to email. During the pause, documents were marked sent although no email
   went. Under canary it also returns `emailed:true`.
6. **The nbd-comms mailto fallback fires on most failures.** In
   `docs/pro/js/nbd-comms.js:452-480`, every failure except 401, 403 and
   `suppression_unverified` opens the rep's mail app with the email filled in.
   That includes 400, 402, 422 and the 503 `record_unverified`, which the
   server returns when it cannot read the lead record or the do-not-contact
   list. So a fail-closed do-not-contact check hands off to the rep's mail app
   for a customer who may be do-not-contact.

Smaller notes:

- Portal moment emails have no canary check, and any refusal after the claim
  also uses up that moment for good.
- Requests held during the pause are never retried, and no screen shows them.
- The `incomingSMS` storm "YES" reply skips the canary and has no automations
  key. It is dormant only because of Twilio console routing.
- `sendD2DSMS` has no client caller. D2D texts go through `sendSMS`.
- Whether Stripe emails homeowners receipts or reminders depends on dashboard
  settings. Not checked.
- The Twilio and Bland consoles, the prod `integrations/stormAlerts.enabled`
  value and any env vars set by hand on Cloud Run were not checked.

## Recommended next steps (options, not decisions)

- **Signed copies.** Keep as is (legal copies always go), or add a switch that
  stops only signed copies even with the master on.
- **E-sign reminders.** Add an automations key and a per-run cap, like the
  other automatic emails. Or leave them on and check the first runs since the
  fix. Or pause them with `ESIGN_REMINDERS_DISABLED` until reviewed.
- **Turning SMS on.** Enable `sms_settings` and `smsEnabled` together, so the
  own-phone hand-offs do not open on their own first. Optionally make the
  hand-offs respect the master too.
- **Canary.** If it is used before turning on an automation, set an owner email
  first, and know which paths it burns (see above). Or fix the burning paths
  (claim only after a real send) before relying on it.
- **Missed-call texts.** Treat the `missedCallAutotext` key as the live switch,
  since its env flag is already on.
- **Remote signing.** Stamp "sent" only after the email actually goes.
- **mailto fallback.** Stop the hand-off on the do-not-contact 503 and on the
  record errors, or leave it as a rep convenience.
- **Plain links.** Route them through the same server check as the share
  hand-offs, or accept them as the rep's own phone.
- **Held requests.** Show the held estimate, storm report and guide requests
  somewhere so they can be sent by hand, or let them go.
- **Stripe.** Check the dashboard email settings once.
