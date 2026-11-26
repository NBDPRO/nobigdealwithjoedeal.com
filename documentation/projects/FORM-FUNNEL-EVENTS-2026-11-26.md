# Form funnel events: where homeowners drop off (2026-11-26)

Every step of the four public lead forms now sends a GA4 event, under one set
of names, so a single funnel report can show where people stop. Asked for by
Jo in the 18-improvement site sweep (lane: "inspect form step tracking").

## What was there before (audit)

| Form | Already sent | Missing |
|---|---|---|
| All forms (`public-lead-submit.js`) | `generate_lead` on a saved lead, `lead_submit_failed` on any failure (#3263) | the attempt itself, so saved/failed had no denominator |
| `/inspect` (`inspect-analytics.js`) | `inspect_form_start`, `inspect_form_error`, `contact_tap` | step views and completes, the thank-you "add details" step. **`inspect_form_error` had not fired for a validation error since 2026-10-26**: the error line moved under the first bad field, and the observer only watched the form's own children. Fixed here (`subtree: true`), with a test that fails on the old code. |
| Homepage + service/town quick form (`quick-lead-form.js`) | nothing but `generate_lead` | everything |
| `/storm-check` (`storm-check.js`) | `storm_check_complete` on the result | every step, every "pick an answer" stop |
| `/estimate` (`inline/4053149b2f.js`) | `funnel_step` per step view, `funnel_lead_save_failed` | step completes, validation stops, the step-1 save succeeding |

## The event list

Shared names, every form. `form` says which one: `inspect`, `quick`,
`storm_check`, `estimate`.

| Event | When | Params |
|---|---|---|
| `form_step_view` | a step is shown | `form`, `step` (number), `step_name` |
| `form_start` | first focus inside the form (not on /estimate: its step-1 view is the start) | `form` |
| `form_step_complete` | the visitor gets past a step | `form`, `step`, `step_name` (+ `answers`, `photos` counts on a details step) |
| `form_error` | a step refused to move on | `form`, `step`, `step_name`, `fields` = field ids or answer names that were missing, `submit`/`save` when the send failed |
| `lead_submit` | a new-lead send starts (every form, in `public-lead-submit.js`) | `lead_kind`, `lead_source` |
| `generate_lead` | the lead saved (unchanged) | `lead_kind`, `lead_source` |
| `lead_submit_failed` | the send failed (unchanged) | `lead_kind`, `lead_source`, `failure`, `http_status`, `server_reason`, `had_token` |

`lead_submit` follows the same "not a new lead" rule as `generate_lead`:
follow-up saves (`estimate_result`, `cta_click`, `email_estimate_request`) and
/estimate's step-1 updates (`leadToken`) send neither.

### Steps per form

| Form | Steps (`step`: `step_name`) |
|---|---|
| `inspect` | 1 `contact` (the form) → 2 `details` (optional, on the thank-you screen) |
| `quick` | 1 `contact`. The view fires when the form scrolls onto the screen, not on page load (the homepage form sits far down) |
| `storm_check` | 1 `address` → 2 `storm` → 3 `roof` → 4 `signs` → 5 `contact` (the lead saves here) → 6 `checking` → 7 `result` (`lead_saved` true/false) → 8 `details` (optional) |
| `estimate` | 1 `address` (contact is on this step; the lead saves when it completes) → 2 `confirm_home` → 3 `project` → 4 `ballpark` → 5 `contact` → 6 `results` |

Old names kept, so nothing already built on them breaks: `inspect_form_start`,
`inspect_form_error`, `contact_tap`, `funnel_step`, `funnel_lead_save_failed`,
`storm_check_complete`. New on /estimate: `funnel_lead_saved {at:'step1', created}`
next to `funnel_lead_save_failed`.

### No personal data

Events carry form names, step numbers, step names, field **ids** and counts.
Never a typed value: no names, phones, emails, addresses, notes. The tests
assert it (each suite fills the form with a name, phone and address and checks
no event contains them), and the browser walk below checked the same.

## Consent

Unchanged, and respected as it stands:

- GA4 has no consent banner or consent mode on the public site, and the
  privacy policy (§3 and "Do Not Track") says GA4 does not respond to DNT/GPC.
  These events go through the same `gtag` as everything else, so they follow
  exactly the same rule. If Jo wants GA4 to stop on GPC like Clarity does,
  that is a policy change of its own (privacy page + `ga-loader.js`).
- `ga-loader.js` fetches gtag.js on the first interaction or 3.5 s after load.
  Events queue in `dataLayer` until then and are replayed, so none are lost.
- Each event is also sent to Microsoft Clarity as a custom event
  (`clarity('event', name)`, name only) **when Clarity is loaded**. Today it is
  not: `clarity-loader.js` has no `PROJECT_ID`, and it stays off on DNT/GPC,
  off-domain and on /pro /admin /dev /sites. Once Jo sets the ID, replays can
  be filtered by these events (e.g. "sessions with `form_error`").

## Seeing the funnel in GA4

1. **Register the params once** (Admin → Data display → Custom definitions →
   Create custom dimension, scope **Event**): `form`, `step_name`, `fields`.
   `step` as a custom dimension too if you want it in tables. Skip any that
   already exist. GA4 only fills a custom dimension from the day it is
   created, so do this first.
2. **Funnel**: Explore → Funnel exploration. Add one step per row, each
   "Event name = `form_step_view`" with a parameter condition, for example for
   /storm-check: `form = storm_check` and `step_name = address`, then
   `storm`, `roof`, `signs`, `contact`, `result`. Leave "Make open funnel" off
   (a closed funnel) to see true drop-off. Breakdown by `Device category` shows phone
   vs desktop.
   - /inspect: `form_step_view (inspect, contact)` → `form_start (inspect)` →
     `lead_submit (lead_source=/inspect)` → `generate_lead (lead_source=/inspect)`
     → `form_step_view (inspect, details)` → `form_step_complete (inspect, details)`.
   - Quick form: `form_step_view (quick)` → `form_start (quick)` →
     `lead_submit` → `generate_lead`. Add `Page path` as a breakdown to compare
     the homepage with town and service pages.
3. **Why people stop**: Explore → Free form, rows `form`, `step_name`,
   `fields`, value Event count, filtered to `form_error`. On /inspect a row of
   `f-phone` means the phone number is what stopped them.
4. **Sends that failed**: compare `lead_submit` with `generate_lead` and
   `lead_submit_failed` by `lead_source` (failures carry `http_status` and
   `server_reason`).
5. **Checking a change live**: Reports → Realtime shows the event names within
   a minute. For one device step by step, Admin → DebugView with the Google
   Analytics Debugger extension turned on.

## Verified

Browser pane, local http-server on this branch, 2026-11-26. GA sending was
switched off in the page (`ga-disable-G-8PG7N9Q3DL`) and every lead, AI,
geocode and storm-data request was stubbed, so nothing reached production or
Jo's GA property. Walked each form through an error, a fix and a send:

- /inspect: `form_step_view 1` → `inspect_form_start` + `form_start` →
  `form_error (f-name,f-address,f-phone)` + `inspect_form_error` →
  `lead_submit` → `generate_lead` → `form_step_complete 1` →
  `form_step_view 2 details` → `form_step_complete 2 (answers:1)`.
- Homepage quick form: nothing until scrolled into view, then
  `form_step_view` → `form_start` → `form_error (phone)` → `lead_submit` →
  `generate_lead` → `form_step_complete`.
- /storm-check: all 8 steps in order, `form_error` for a missing address,
  `stormWhen,stormType` and `sc-firstName,sc-phone`, `lead_submit` /
  `generate_lead` at the contact step, `form_step_view 7 result lead_saved:true`.
- /estimate: `funnel_step` + `form_step_view` per step, `form_error` on step 1
  (empty fields, then `address_lookup`), `lead_submit` → `generate_lead` →
  `funnel_lead_saved {created:true}` on the step-1 save, and no second
  `lead_submit` on the final send (it updates the step-1 lead).
- No event in any walk contained the test name, phone or address.

Tests (each new check fails against the pre-change scripts):
`tests/lead-submit-failure-signal-2026-11-25.test.js` (`lead_submit`),
`tests/lead-form-feedback-2026-10-26.test.js` (quick form),
`tests/estimate-funnel-unblock-2026-10-03.test.js` (/estimate),
`tests/inspect-cro-light-2026-10-06.test.js` (/inspect, incl. the subtree fix).
/storm-check and inspect-form.js's step 1 complete / details step are covered
by the browser walk only.

## Notes

- `quick-lead-form.js` is referenced without a `?v=` on many pages, so repeat
  visitors can run the old copy for up to 24 h (`/assets/js/**` cache). The
  other edited scripts were re-versioned (`inspect-form.js?v=13`,
  `storm-check.js?v=11`, wizard loader `?v=11` → wizard `?v=12`).
- The step-3 button on /estimate stays disabled until service, home size and
  timeline are picked (`btnStep3`), so a `form_error` at step 3 is rare by
  design: a stall there shows as a view with no complete.
