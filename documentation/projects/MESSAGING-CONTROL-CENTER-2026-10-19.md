# Messaging Control Center (flag `messagingControlCenter`), 2026-10-19

Why: Twilio's A2P campaign went Verified on 2026-10-19, so texts really deliver now.
Twilio's console shows carrier delivery. It does not show which CRM automation sent
a text and why, the consent behind it, what a gate refused, email, queue backlogs,
or whether anything went to a person who never agreed. This is a read-only,
masked, owner/admin-only view that answers those, built on the ledgers the senders
already write. Ships dark.

## What it is

- **View:** CRM sidebar / More menu, "Messaging" (`#/messaging`). Hidden unless the
  flag is on AND the reader is owner / admin / company_admin (a solo owner with no
  role claim counts, same rule as the Live feature flags panel). `viewer`,
  `sales_rep` and `manager` never see the entry; the callable re-checks.
- **Server:** callable `messagingCenter` (`functions/messaging-center.js`, pure logic in
  `messaging-center-logic.js`). All reads go through the admin SDK because the rules
  deny clients most of these collections. It **writes nothing**.
- **Watch:** `messagingWatch`, hourly at :05 ET. Same thresholds as the banner. One
  create-only Agent-inbox `report` per alert per day (`agent_inbox/msgwatch_<alert>_<day>`),
  one bell, and a push to the owner (max 3 pushes a day). Never a customer. NBD tenant only.
  Dry run (logs counts only) while the flag is off.
- **Client:** `docs/pro/js/messaging-center.js` + `css/messaging-center.css` (lazy
  ScriptLoader bundle `messaging`), and a 1 KB deferred `messaging-nav.js` that only
  un-hides the two menu entries.

## Sections on the page

Red alert banner; Needs a look; Status strip (kill switch, canary, texting master
switch, A2P registered, last send, per-automation ON/OFF with risk); What was sent
(today / 7d / 30d by channel and by automation); Delivery outcomes (7d) with carrier
error codes; Blocked by a gate (30d, by reason); STOP / opt-outs (last 4 only);
Queue backlog (oldest first); Recent messages (channel filter); Coverage; How to
read this; a link to Twilio's own Messaging logs.

Each row: automation, channel, name + masked recipient (last 4 / `p***@g***.com`),
template id, first line (<= 80 chars, any number or address typed into a reply is
masked again), time, outcome, gate result and why.

## Where the data comes from (no second log)

| Automation | Ledger read |
|---|---|
| Rep text, offline outbox, door-knock, AI reply (S1-S4) | `sms_log` (tenant `companyId`, last 30 days) |
| Storm alerts (S5/S6) | `storm_alerts_sent` claims + `storm_alert_subscribers` (number, `tcpaConsent`) |
| Missed-call text (S8) | `missed_call_autotext` claims + the lead |
| Estimate-request ack text/email, 20-48h follow-up (S7, E1, E2) | `ackSmsSentAt` / `ackEmailSentAt` / `followUpEmailSentAt` on the four public lead collections |
| Review ask text/email (S9, E6) | `leads.reviewAutoAsk` (status `sent`) |
| New-lead alerts to the owner (S10, E13, P6) | `alert_outbox` (sms + `smsDelivery`, email, push legs) |
| Rep-sent email (E7) | `email_log` |
| STOP / DNC | `sms_dnc` + `sms_opt_outs` (global register) |
| Bounces / complaints | `email_suppressions` (source bounce / complaint) |
| Queues | `email_queue` (NBD only) + pending `draft_*` in `agent_inbox` |
| Switches | `sms_settings/{tenant}`, `integrations/sms.a2pApproved`, flag readout from `flags-registry.js`, `messaging_controls/global` |

Indexes added: `sms_log` and `email_log` on (`companyId`, `date` desc). A source that
fails (for example while an index builds) shows "unavailable" under Coverage and the
rest of the page still renders.

## Alert thresholds (one config object: `THRESHOLDS` in `messaging-center-logic.js`)

Error rate over 10% in the last hour (min 5 sends); more than 30 customer messages in
an hour; more than 150 in the local day; 3x volume spike vs the prior week's usual
hour (min 10); any automated text with no consent record; any HIGH-risk automation
firing; any text sent after the number opted out; any text from an automation outside
the registered A2P campaign (review asks, missed-call text). Dedupe: one inbox report
per alert per local day.

## Gate result on each row

Consent basis (website form tick, storm signup, customer texted first, rep-initiated,
or none), inside 8am-9pm recipient time (Kentucky must hold in Eastern AND Central),
not sent after the number's STOP, and whether the automation is inside the registered
campaign. Rep-typed texts need no stored consent (the sender doesn't require it) so a
missing tick on those is a warning, not a red item.

## Honest gaps (read before trusting a zero)

1. **Refusals that write no row are invisible.** STOP, do-not-text, quiet hours, the
   master switch and daily caps answer the caller with an error and store nothing. The
   "Blocked" table counts only refusals that left a row (`consent_declined`, a carrier
   21610, an email `suppressed` / `blocked_no_postal_address`). The real fix is one
   shared ledger written by every sender (`messaging_events`), which touches the send
   paths another session is hardening right now, so it is a follow-up, not part of
   this read-only PR.
2. Carrier delivery verdicts (`delivered` / `undelivered`) reach `sms_log` only when the
   Twilio status callback is on (`TWILIO_INBOUND_ENABLED`, dark). Until then SMS rows
   read "sent" (provider accepted). `alert_outbox` rows carry `smsDelivery` already.
3. Kill switch and canary read "unknown": `messaging_controls/global` does not exist on
   `main` yet. The page reads it loosely if it appears (`killSwitch`/`kill`/`paused`/
   `enabled`, `canary`/`canaryMode`/`mode`) and never creates it. Re-point
   `controlsFrom()` when that session's field names are final.
4. Not visible at all: Twilio Verify OTP texts (Twilio's own log), the abandoned-estimate
   recovery email (claim doc only, dark), outbound voice (none exists).
5. Optional agent MCP tool `messaging_status` was not built; the overview JSON is
   already masked and the tool would be a thin wrapper (follow-up).

## Turn it on

Firebase console > Firestore > `feature_flags` > `_default` > add field
`messagingControlCenter` (boolean) = `true`. Reload Pro. Owner/admin sees
"Messaging" in the sidebar (or More menu on the phone). To try it for one person,
set it on `feature_flags/{uid}` instead. Off = no menu entry, the callable answers
`{enabled:false}`, the watch is a dry run. The assistant cannot write production flags.

## Tests

`tests/messaging-center-2026-10-19.test.js` (node bucket): masking, normalisers,
aggregation, needs-a-look, thresholds (edges, min-sample, config override), role
matrix (server and client in step), the callable and the watch against an in-memory
Firestore (role gate before any read, flag gate, tenant scope, read-only, dedupe,
no spam), client rendering (escaping, no style attrs / handlers), wiring.
Mutation-checked: each guard was broken and the named assertion went red.

## Review fixes (2026-10-19, same day, follow-up PR)

An independent review of the first version found these; each was confirmed against `main` and PR #2572 and fixed, with a test that can fail:

- **Kill switch reads like #2572 defines it, fail closed.** `messaging_controls/global` absent, unreadable, or `customerSendsEnabled` not exactly `true` shows red "CUSTOMER SENDS OFF" (absent vs unreadable are different words). Each channel (SMS, email, verification codes) and canary is shown. Until the kill-switch code is part of the deployment (`require.resolve('./messaging-controls')`), the strip says "NOT ENFORCED YET" in amber instead of a false red. Each automation shows its **effective** state (env flag AND master AND channel AND `messaging_controls/automations.<key> === true`) and the reason it is off.
- **A failed source can no longer look healthy.** Critical sources that fail turn on a red "Some data could not be read" banner, "Needs a look" says "Cannot say", and the hourly watch files a deduped "monitor is blind" report. A flag read that fails makes the watch error (heartbeat red) instead of silently dry-running.
- **Newest rows first, caps reported.** Every range query now orders newest-first; a source that returns exactly its limit is shown as "capped" in Coverage. New indexes: `missed_call_autotext`, `leads` (companyId / userId + reviewRequestedAt), `sms_dnc`, `email_suppressions`, `agent_inbox`. The review-ask query is now tenant-scoped.
- **Hardening reasons mapped** (`no_consent_on_file`, `customer_sends_off`, `messaging_paused`, ...) to Blocked reasons, so refusals no longer inflate the error rate.
- **Coverage lists every inventory sender** (seen / partly / NOT SEEN) and says customer email is only partly visible. "Voice is always 0" removed.
- **Storm claims:** a claim is created before the send, so "claimed" is unconfirmed (not "sent"); a missing subscriber or lead record is consent **unknown**, never "none", so a failed lookup cannot raise a false no-consent alert.
- Customer messages and internal owner alerts are counted separately (same population as the alert thresholds); kill switch / canary use dedicated wording and colours; canary rows are marked; the "Blocked" table shows "not recorded" for reasons that write no row; alerts re-fire per incident size, not per day; the HIGH-risk alert ignores the email automations that are live by design; the bell write is its own create-only write; multi-zone quiet hours for KY, TN, IN, FL, MI, TX; 7 and 8 digit numbers are masked (dates are not).
- `feature-flags.js`: a denied per-user flags doc no longer throws away a readable `_default`, and `NBDFlags.isLoaded()` lets the view say "flags could not be read" instead of "off".

**Disproved:** "nbd:flags-loaded is never dispatched" is wrong: `feature-flags.js` dispatches it after every successful load. Not changed: short codes are shown whole (the masked last 4 of a 5-digit code is the whole code; nothing sensitive).

**Still true:** refusals that write no row (STOP, DNC, quiet hours, master switch, daily cap) are not countable until a shared sender ledger exists. PR #2572 also edits `controlsFrom` in this file's first version; this PR replaces that function wholesale, so #2572 should take this version on rebase.
