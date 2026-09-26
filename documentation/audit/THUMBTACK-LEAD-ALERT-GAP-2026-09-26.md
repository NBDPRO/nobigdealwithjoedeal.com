# Thumbtack leads paged nobody — 2026-09-26

**Finding.** From the day the Thumbtack webhook went live (2026-08-16) until
this fix, no Thumbtack lead sent Joe a text, an email or a push. Every one
reached the CRM pipeline, and nothing said so. The architecture doc claimed
the opposite, so nobody checked.

**Why it matters.** The August lead-channel audit traced every Thumbtack
loss to reply speed. Leads answered in 2–9 minutes were won; leads answered
in hours were lost to a pro who replied in minutes
([THUMBTACK-WEBHOOK-2026-08](../architecture/THUMBTACK-WEBHOOK-2026-08.md),
§Why this exists). The webhook was built to fix that, and the alert was the
half that never shipped.

## Evidence (read-only prod check, `nobigdeal-pro`, 2026-09-26)

A scratch script used the admin SDK through `scripts/_admin.js` and read
only. It printed counts, ids and dates, never contact details.

| What | Count |
|---|---|
| `alert_outbox` rows, all time | 4 (from 2026-07-12) |
| …with `collection` or `leadId` naming Thumbtack | **0** |
| `thumbtack_leads` docs | 77 (74 real, 3 test deliveries), 2026-08-16 → 2026-09-26 |
| `leads` with `publicLeadKind == 'thumbtack'` | 74. Every real lead was bridged |

**Positive control.** The ledger is not simply empty. The contact form took
3 leads in the same window and `alert_outbox` has exactly 3 `contact_leads`
rows. The other row is a Cal.com booking (`collection: 'leads'`). The
estimate, inspect, free-roof and storm forms took no new leads in the window.
So the ledger records alerts that fire. The Thumbtack alert never fired.

For scale: 74 Thumbtack leads against 3 contact-form leads and 3 Cal.com
bookings. Thumbtack is the busiest channel by a wide margin, and it was the
only one with no alert.

## Mechanism — three silent paths

1. **No trigger on `thumbtack_leads`.** `functions/lead-alert.js` exported
   onCreate alerts for `contact_leads`, `estimate_leads`, `inspect_leads`,
   `free_roof_entries` and `storm_alert_subscribers`. Web-form leads alert
   from those public collections, and the bridge only mirrors them into
   `leads`. `thumbtack_leads` had a bridge (`leadBridgeThumbtack`) and no
   alert.
2. **The `leads/{leadId}` trigger filtered Thumbtack out.** `leadAlertCalcom`
   sees every lead create and returned early unless
   `publicLeadKind === 'calcom_booking' && webLead === true`. The bridged
   Thumbtack doc is `publicLeadKind: 'thumbtack'`, `webLead: false`.
3. **Push skipped it too.** `push-functions.js` needs an `assignedTo` that
   `mapPublicLeadToLead` never sets.

**How it went unnoticed.** The architecture doc said a bridged Thumbtack lead
"inherits … the alert triggers for free". The 2026-09-05 wave-2 mapping pass
caught that
([WAVE2-IMPLEMENTATION-MAPS-2026-09-05](WAVE2-IMPLEMENTATION-MAPS-2026-09-05.md),
"Handoff item 10"), but it was recorded as a correction for a *future*
inbound-webhook build. Nobody treated it as a live outage, and the doc stayed
wrong for three more weeks.

## The fix

The fix is in `functions/lead-alert.js`. The existing `leads/{leadId}`
trigger now sends one kind of lead to a new branch, `onThumbtackLeadAlert`:

- **Gate** (`isBridgedThumbtackLead`): all of the following must hold.
  - `publicLeadKind === 'thumbtack'`
  - `publicLeadCollection === 'thumbtack_leads'`
  - `publicLeadId` is non-empty
  - **the doc id equals `bridgeDocId('thumbtack_leads', publicLeadId)`**

  That id is written once, by the bridge's `create()`. A copy, a hand-typed
  "Thumbtack" lead, or a doc carrying another raw lead's id fails the gate. A
  restore is an update, not a create, so it cannot re-fire. `backfilledBy`
  is skipped, matching the Cal.com branch.
- **Send**: `alertJoe('leads', …, { label: 'Thumbtack', source: '', ack: false })`.
  - The email goes to `ALERT_EMAILS` and the SMS to Joe's cell, through
    `resolveAlertTarget`. The lead's `companyId` is NBD's uid, so the target
    is Joe.
  - The message body is the bridge's `notes`: service, description, lead
    cost and questionnaire answers.
  - An `alert_outbox` row is written under `collection: 'leads'` with the
    CRM lead id.
- **No homeowner ack.** Thumbtack already messaged the customer and never
  passes an email address, and this path has no consent-bearing collection
  to text on.
- **Email body.** The alert email's value cells gained `white-space:pre-line`,
  so a multi-line questionnaire keeps its line breaks. Single-line values
  render the same as before.

**Why the leads trigger and not a new one on `thumbtack_leads`.**
- The bridge is already the filter: it drops Thumbtack's "Test this webhook"
  deliveries, and its `create()` makes a re-delivery a no-op. So a lead pages
  only if it is a real card in the pipeline.
- The trigger is already deployed with the alert secrets.
- A **new or renamed export is a second deploy target**, and the deploy never
  deletes retired functions. A rename would have left the old
  `leadAlertCalcom` live beside the new one, so every lead would page twice.

The export name stays and a comment explains why.

**Not retroactive.** The 74 leads before this deploy were never alerted and
will not be.

## Verification

- `tests/lead-alert-thumbtack.test.js`: **46 assertions**, in the manifest,
  with FLOORS bumped. It uses the Module._load stub harness from
  `lead-alert-calcom.test.js`. Fixtures go through the real
  `normalizeLead`/`leadNotes` → `mapPublicLeadToLead`/`bridgeDocId`, so a
  change to either shape reaches the test.
  - (a) one email + one SMS to Joe, with the right content, and one ledger row
  - (b) the homeowner is never emailed, texted or stamped, even with an email
    or `tcpaConsent` on the doc and `LEAD_ACK_SMS_ENABLED=true`
  - (c) seven look-alikes send nothing
  - (d) wiring: nothing listens on `thumbtack_*`; exactly one trigger listens
    on `leads/{leadId}`; the export set is unchanged; the bridge still skips
    `isTest` and still uses `create()`
- `tests/lead-alert-calcom.test.js` passes unchanged (56).
- **Break-tests.** Each mutation reddened only the intended assertions, and
  the Cal.com suite stayed green under every one:

| Mutation | Red |
|---|---|
| remove the Thumbtack dispatch | 16: all of (a), and "Joe was still alerted" ×3 in (b) |
| drop the bridge-id equality | 2: the two "different doc id" look-alikes |
| drop `ack: false` | 2: "no email to the homeowner" and "no ack stamp", on the with-email case |
| drop the `backfilledBy` skip | 1: the backfill look-alike |
| drop the `publicLeadCollection` check | 1: the collection-mismatch look-alike |
| `origin/main`'s pre-fix `lead-alert.js` | 16, the same as the dispatch removal |

## Docs corrected in place

- [THUMBTACK-WEBHOOK-2026-08](../architecture/THUMBTACK-WEBHOOK-2026-08.md):
  - a dated correction at the top
  - the §What-it-can line, the diagram and the §Architecture paragraph now
    match the code
  - the 2026-09-20 "Known live gap" (`leadCost` not written at ingest) is
    marked resolved by PR #1681
  - new files listed
- `functions/FUNCTIONS_INDEX.md`: the `leadAlertCalcom` row now describes
  both branches.

## Open

- **SMS delivery still depends on the Twilio A2P 10DLC campaign.** This is
  the same caveat as every lead alert (see the `lead-alert.js` header). Email
  is the reliable half. After the first real Thumbtack lead post-deploy,
  check its `alert_outbox` row: `emailStatus` should be `sent`, and
  `smsStatus` shows whether texts are landing.
- **Any future marketplace** added to `EXTERNAL_SOURCE_COLLECTIONS` needs its
  own alert branch. Being bridged does not mean being alerted.
- **Cal.com: 3 booking leads, 1 outbox row.** The `leadAlertCalcom` Cal.com
  branch only landed on 2026-09-13, and backfilled bookings are skipped by
  design. That probably explains the gap, but it was not verified in this
  session.
