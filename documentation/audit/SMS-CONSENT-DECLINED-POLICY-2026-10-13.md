# SMS consent DECLINED policy (C-7, option A) — 2026-10-13

Status: built on branch `feat/sms-consent-declined-policy`, stacked on
[#2433](HANDLE-AND-OPTOUT-CONTROLS-2026-10-13.md) (the audit that found C-7).
Decision: Jo, 2026-10-13, **option A** of M-7. Not legal advice; the
counsel questions at the bottom are open.

## What changed

A lead whose form left the texting box **unchecked** (`tcpaConsent === false`)
is now refused by the server, at one decision
(`functions/sms-consent-declined.js` `decide()`), unless that number texted
this company inside **N = 7 days**.

| Rule | Behaviour |
|---|---|
| STOP / Do Not Text | Unchanged and first. Opted-out reads as `opted_out`, never as consent |
| Reply to the customer's own text | Allowed for 7 days from the newest qualifying inbound; each new inbound restarts it |
| Campaign text (`source` review_request, referral_code, winback, ...) | Refused even with a fresh inbound |
| Inbound that does not open the window | STOP, a plain-English stop, a *possible* STOP ("thanks but stop"), a bare HELP, anything before the lead existed, another tenant's thread, an outbound row, a group text |
| A LATER yes for the same number in the same tenant | Counts only with the server's own `tcpaConsentAt` and only if newer than the newest decline (`consent_on_other_record`). An old yes followed by a newer no, or an unstamped `true` (hand-typed, imported, spoofed on a public form), is not evidence |
| Number-level | Matched on normalised 10 digits inside the caller's tenant (the lead query is tenant-scoped, a full page is "unknown"), so a request with no `leadId`, a duplicate card, or a `crew` label cannot sidestep it. Another tenant's decline is invisible |
| Unknown is not consent | A read error, or a full page of rows with no inbound among them, refuses with `consent_check_unverified` (503) |
| Door-knock text | Exempt: the knock's own `smsConsent === true` is an express yes at the door |
| Email | Untouched |

Refusals carry a machine code on the row: HTTP 403 `consent_declined` (and a
visible `failed` row in the Comm Log with `failureReason: consent_declined`),
AI draft `failureReason`, device-check `code: 'declined'` + `detail`.

## The part the audit did not name: the decline never reached the lead

`lead-bridge-logic.js` copied `tcpaConsent` onto the CRM lead only when `=== true`
("silently absent rather than stamped false"). So even the two old readers of
`false` (device check, bot drafts) had nothing to read in production. The bridge
now carries a stored `false`; an absent field stays absent; no consent *record*
is invented for a decline. **Leads bridged before this change carry no flag** —
they are "never recorded", not "declined". A backfill from the raw
`estimate_leads` / `inspect_leads` / `storm_leads` docs is possible (they hold
the boolean) but is a production write: not done, needs Jo.

## Why 7 days

No primary source gives a number of days for answering a consumer's own text.
Twilio's messaging policy lets you "respond in an exchange" and treats the
inbound as consent for that exchange; CTIA's language is "responds quickly";
the only hard time figure in 47 CFR 64.1200 is the 5-minute opt-out
confirmation. The FCC 3-month inquiry / 18-month transaction
established-business-relationship windows govern telemarketing calls and are not
a basis for texts, so 30+ days reads as a back door. 72 hours is the most
conservative defensible figure but is too tight for scheduling an inspection and
sending the estimate they asked for. 7 days, rolling. One constant:
`DECLINED_REPLY_WINDOW_DAYS`. Evidence trail: the compliance-reference run
2026-10-13 (secondary sources for FCC 12-143 / 15-72 and CTIA — primary PDFs
did not render; re-check by hand).

## Send paths

| Path | Covered by |
|---|---|
| CRM manual send `sendSMS` | `complianceGate` -> `decide` (kind from the client's `source`) |
| Offline outbox replay `sendQueuedSMS` | same `complianceGate` |
| Approved AI reply `onAiDraftApproved` | `decide`, kind `reply`; fails the draft with the code |
| Device hand-off `phoneTextAction check` (Jo's own phone: deal links, share, review asks, Messages fallback) | `okToText` -> `decide` |
| Door-knock `sendD2DSMS` / `sendSMS`+knockId | exempt, knock's explicit yes |
| Lead ack text (`lead-alert.js`) | already stricter: `smsAckGate` needs `tcpaConsent === true` |
| Storm alerts (`storm-sms-guard.js`) | already stricter: subscriber `tcpaConsent === true` (own signup consent) |
| Bot drafts (`agent-mcp`, `pixel-draft`) | draft only, refuse a declined lead outright; Jo sends through the device check |
| Staff alerts to Jo, verification codes | not customer messages |

`tests/sms-consent-declined-2026-10-13.test.js` keeps a ledger of every
`messages.create` in `functions/`; a new sender fails the test until classified.

## Review round (2026-10-13, silent-failure-hunter + vacuous-test-auditor + compliance reference)

Fixed: tenant-scoped lead scan (an unscoped `limit(10)` could drop this
tenant's declined lead); supersede is newer-and-stamped only; `incomingSMS`
thread-start reads skip a refused row (a never-sent attempt could win a
cross-tenant reply); refused texts are labelled "Not sent - consent declined" in
the Inbox, mobile card and Comm Log and get no "They replied STOP" button; the
offline tray names the reason; one refusal row per 10-minute burst; `crew` label
no longer skips the check; follow-up labels (`estimate_followup`,
`smart-followup-sms`, `d2d-followup-sms`) are campaigns. Tests now cover every
label, the handler's source passthrough, full pages, uid-only and future-dated
inbound; break-tests recorded in the PR.

Known and left: a text typed in the owner's own phone cannot be stopped by any
server (the device check only answers); an unlabelled device-path campaign text
rides the window (counsel question: default unlabelled to "automated" for a
declined number?); the inbound-text window is never closed by a "no thanks"
reply that is not stop-worded; KY insurance-job claim wording is not checked by
this gate (the bot-draft path has `CLAIM_PROMISE`, sendSMS and AI drafts do not
- see kentucky-insurance-job-law); invoice reminders inside the window are
treated as replies.

## UI

`docs/pro/js/customer-consent-declined-banner.js` (customer page): "Consent
declined - texting blocked unless they text first", the 7-day reply rule, and
**Call instead / Email instead** anchors (44 px). No control on it sends.

## Needs Jo / counsel

- Deploy `firestore.indexes.json` (new `phone_texts` composite) before relying
  on phone-backup texts as the window; until then only business-line inbound
  (`sms_log`) opens it and a miss answers `consent_check_unverified`.
- The `source` label is client-supplied and cannot be authenticated; it can only
  make the policy stricter. The inbound requirement is what protects a request
  with no label.
- Counsel: is a reply inside the window "informational" in a roofing context
  (estimate delivery, appointment reminders, invoice reminders, review asks)?
  Does an express "no" change the analysis versus a silent lead? Is N defensible
  as a rolling window? KY/OH telemarketing and mini-TCPA rules (the empty slot).
- Backfill of `tcpaConsent:false` onto leads bridged before this change
  (production write).
- Pending: whether `possible_stop` should hold ALL outbound until a person reads
  it (the compliance run suggested it; today it only suppresses AI drafts).
