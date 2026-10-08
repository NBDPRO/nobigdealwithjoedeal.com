# Texting compliance fixes — 2026-10-05

Jo approved five fixes from the texting review (area 3 of the phased review,
read-only at `origin/main` 46ee490a). They shipped as three PRs. This note
covers what changed, where it is enforced, and what is still open.

## What changed

| # | Gap in the review | Fix | Enforced in |
|---|---|---|---|
| 1 | STOP was honoured only as an exact whole message. "Stop.", "Stop texting me", REVOKE and OPTOUT went to the AI draft step | Punctuation is stripped, REVOKE / OPTOUT are added, and revocation phrases count. Any opt-out is recorded and returns **before** the AI draft step | `functions/sms-stop-intent.js` (classifier), `incomingSMS` |
| DNC | No Do Not Call check existed anywhere | An **internal per-company Do Not Text list** (no paid registry). Two sources: STOP replies, copied to every company holding that number, and manual adds from the CRM | `sms_dnc/{companyId}__{key}`, checked inside `isOptedOut` (`functions/sms-optout.js`). `isOptedOut` now **requires** `opts.companyId` and rejects without it, so no path can skip the list |
| 2 | Door-knock texts had no consent, no STOP line, and two templates named no company | The knock needs `smsConsent === true`, for its own number and on the caller's own knock. The company is named and "Reply STOP to opt out." is added | `complianceGate` / `knockConsentRefusal` in `functions/sms-functions.js` (sendSMS+knockId and sendD2DSMS). The D2D tracker has an "OK to text" checkbox and an action |
| 3 | Quiet hours existed only on queue replays and storm texts, and in Eastern time for everyone | 8am–9pm in the **homeowner's** time zone on every path. The zone comes from tz, state, ZIP or address. A split state must clear every zone unless the ZIP narrows it. FL/OK/MD/WA end at 8pm | `functions/sms-send-window.js`. Live sends get 403 `quiet_hours`; queued sends are held; an approved AI reply goes back to pending with `heldReason` |
| 4 | Storm texts never checked consent | Only subscribers with `tcpaConsent === true` get them | claim transaction in `functions/storm-sms-guard.js` |
| 5 | There was no master switch, and every tenant texted under NBD's brand | A per-company switch is checked on every send. **NBD is on by default. Every other company fails closed** until `registered: true` (admin-SDK only) | `functions/sms-texting-gate.js`, `sms_settings/{companyId}` |

CRM: Settings → AI Texting → "Texting rules" (`docs/pro/js/sms-compliance-settings.js`).
It shows the switch to the owner / company_admin. A company without registration
sees "Texting needs registration — coming soon". It also holds the Do Not Text
list: anyone but a viewer can add a number, and the owner or a company_admin can
remove a manual entry. A STOP-reply entry can never be removed from the CRM; only
the homeowner's START reply lifts it. Server side, all of this goes through the
callable `manageSmsCompliance` (`functions/sms-dnc.js`).

## Paths covered

sendSMS (live), sendQueuedSMS, sendD2DSMS, the D2D tracker (sendSMS with
knockId), onAiDraftApproved, checkStormAlerts, stormWatch, and the /estimate
ack (`lead-alert.js`, off by default; it now also checks the STOP register and
the Do Not Text list). Every browser sender (review asks, invoice reminders,
Ask Joe, close board, portal links) goes through sendSMS.

## Still open (not in Jo's list)

**Update 2026-10-07 (review round 6, `fix/r6-texting-trio`):** three more
gaps closed. Tests: `tests/r6-texting-trio-2026-10-07.test.js`.

- **R6-3-3, AI reply sent twice.** `onAiDraftApproved` now claims the send on
  the draft before Twilio is called. Only a definite Twilio refusal (HTTP 4xx)
  is `failed`. Any other error is looked up at Twilio by number and text. If
  Twilio has it, the draft is `sent`; if not, the draft is `send_uncertain`.
  The panel shows "check before re-sending" and never re-queues it by itself.
  Only the rep can put it back (`send_uncertain → pending | dismissed` in
  `firestore.rules`).
- **R6-3-5, START lifting another company's STOP.** Each STOP now records
  which sender it was told to (`stopLine`). "They replied STOP" is that
  company's own Do Not Text entry (`owner_phone`), not the global register. A
  START to NBD's number lifts only that number's STOPs, plus NBD's own phone
  STOP (`sms-optout.js` `liftStopOnLine`). Older entries it can't attribute
  are kept and flagged (`startSeenAt`).
- **R6-3-6, no hours on the no-customer check.** `phoneTextAction`'s `number`
  path now applies 8am–9pm, Eastern when there is no location (the rule
  below). Only `crew` skips hours.
- **New open item:** an `owner_phone` STOP has no lift path yet. The CRM can't
  remove a stop_reply entry, and a START to NBD's number no longer lifts
  another company's entry. If a homeowner tells company A "you can text me
  again", A can't record it today.

- **Per-company A2P registration.** That is being designed separately. Until it
  exists, non-NBD companies cannot text at all.
- The STOP / HELP TwiML replies still say "NBD Pro" with Joe's number for every
  tenant (review #9).
- The AI-draft send has no 5/day per-recipient cap (review #5b).
- The quiet-hours location comes only from the record (state / ZIP / address /
  tz). A record with none of these uses Eastern. Area codes are not used.
  Texas's Sunday-noon rule is not modelled.
- Jo's own alert texts to his cell (new-lead SMS, storm-watch summary) are
  internal and are not gated by the switch.

## Tests

`tests/sms-stop-intent-2026-10-05`, `sms-dnc-2026-10-05`,
`sms-consent-quiet-switch-2026-10-05` and `sms-compliance-settings-ui-2026-10-05`
all drive the real handlers through `tests/lib/sms-compliance-world.js`.
Firestore rules sections 53 (`sms_dnc`) and 54 (`sms_settings`) cover client
read / create / update / delete.
