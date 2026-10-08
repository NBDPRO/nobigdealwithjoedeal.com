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
*(Updated 2026-10-07: "remove" is now **Lift** with a required reason, and the
entry is kept as history. A STOP the company recorded from its own phone can be
lifted too. A STOP texted to NBD's number still can't. See the "Closed
2026-10-07" note under Still open.)*

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
  - **Closed 2026-10-07 (`feat/sms-lift-manual-stop`, Jo said yes):** the
    owner or a company_admin can now **Lift** one of their company's own
    entries in Settings → AI Texting → Do Not Text. Liftable: a manual add, or
    a STOP the company recorded from its own phone (`owner_phone`, or an older
    entry with the CRM's "They replied STOP" note). A short sheet asks for a
    **required reason** ("Homeowner said on 10/8 call texts are fine"). The
    entry is **marked lifted, never deleted** (`lifted`, `liftedAt`,
    `liftedBy`, `liftedRole`, `liftReason`). Each lift and reinstatement is
    appended to the entry's `history`, which is the audit record. A lifted
    entry blocks nothing; a new STOP or "don't text" on that number puts it
    back in force.
  - **Stays locked:** a STOP the homeowner texted to NBD's number
    (`stopLine: 'twilio'`, or an older one nobody can attribute) shows "Opted
    out by text — only their START reply lifts it" and the server refuses to
    lift it. Other companies' entries are never touched.
  - **Server-enforced:** `manageSmsCompliance` `liftDnc` runs
    `requireTeamAdmin`, so reps, managers and viewers are refused. The old
    `removeDnc` name now does the same lift and needs a reason, so nothing
    deletes an entry any more. `sms_dnc` stays admin-SDK only in the rules.
  - If the number is also in the global register (a STOP to NBD's number),
    the lift answers `stillBlocked` and the page says only their START lifts
    that.
  - Tests: `tests/sms-lift-stop-2026-10-07.test.js` (role matrix through the
    real `requireTeamAdmin`, eligibility, audit record, other companies,
    reinstatement, the page's sheet and escaping).

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

## Update 2026-10-07 — review round 6 (R6-3-1, R6-3-2)

**Correction to "Paths covered" above:** not every browser sender went through
sendSMS. Several opened Messages from Jo's own phone with the text written in
and no check at all. That was R6-3-2, now fixed. The two fixes:

- **R6-3-1, a STOP inside a longer reply.** "Not interested. Stop.", "No thanks
  stop" and "I no longer want texts from you" are now opt-outs. The rule: a
  STOP-family word that is its own clause, the first word, the last word after
  courtesy words, or within three words of a refusal. A STOP word the
  classifier can't read safely ("thanks but stop") gets a new answer,
  `possible_stop`. It is not an opt-out, but incomingSMS writes no AI draft for
  it and gives the rep a high-priority bell and a flagged note. The NBD text
  line flags its note, bell and inbox item the same way. "Can you stop by
  tomorrow" and "I'll stop at the store" are still ordinary messages.
- **R6-3-2, pre-filled texts from the phone.** Seven hand-offs now ask the
  server first (`NBDPhoneShare.checkText` → `phoneTextAction`: STOP, Do Not
  Text, consent, the texting switch, 8am–9pm homeowner time):
  - Text Portal
  - the dashboard portal-link share
  - Text Booking Link
  - the V2 estimate share box (its 💬 Text link and its automatic hand-off)
  - Care Plan "Text it"
  - the kanban booking text (`sendBookingSMS`)
  - `sendFollowUpSMS` and `CustomerPortal.shareSMS` (nothing calls these two today)

  A "no", or a check that can't run, shows the reason and opens nothing.
- **Still unchecked, lower risk.** About a dozen blank "💬 Text" links open
  Messages to the customer with no text written in. The rep types the message.
  They are in call-center-view, claim-core, close-board (rep card),
  crm-list-view, customer-estimate-hub, customer-quick-action-bar,
  dashboard-actions, dashboard-widgets, followup-deck, no-next-step and
  today-home.
- The `sms:` fallbacks in `portal-link-helpers.js` and the D2D tracker run only
  when NBDComms is missing.
- The Pending-texts hand-off in `sms-outbox.js` is R6-3-4, which is still open.

Tests: `tests/r6-texting-2026-10-07.test.js`, plus the R6 sections added to
`close-flow-2026-10-03` (V2 share box) and `twilio-line-2026-10-06`.
