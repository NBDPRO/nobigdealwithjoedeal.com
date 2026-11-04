# Call Center Horizon 3 - build log (2026-10-22)

Part of [the Daily Success roadmap](DAILY-SUCCESS-ROADMAP-2026-10-21.md), Horizon 3. One small PR per step, in order.
Code: `docs/pro/js/call-center-filters-logic.js` (pure) and `docs/pro/js/call-center-view.js`.

## Step 1 - status filters (this PR)

Five chips under the date / direction rows: **Unhandled, Handled, Urgent, Has promise, Missed** (plus "Any status").
**Jo has not confirmed this exact set**; it is the first cut and the list lives in one array (`STATUSES`) so it is a
one-line change.

Definitions (all in the pure module, all tested with a control for each):

| Status | Rule |
|---|---|
| Unhandled | not handled, not `status: personal`, not `taskDone`, not `callType: spam` (the closed half of Needs attention, without its reasons) |
| Handled | `handledAtMs` set |
| Urgent | `urgent === true` |
| Has promise | `promises` is a non-empty array (either side's promise) |
| Missed | inbound call (not a text day) where `answered === false`, or `durationSec` is a number under 15 |

Choices worth knowing:

- **Unknown length is not missed.** `durationSec` is `null` when no sidecar was read (`functions/call-center.js`), and
  `Number(null)` is `0`, which would have called every un-timed call missed. The test pins `null`, missing, `''` and `false`.
- 15 s is the server's own `SHORT_CALL_SEC`; a test pins that the two stay equal.
- A text day has no direction or length, so it can be handled / unhandled but is never missed.
- Status is a fifth field on the one saved-filter record (`nbd_cc_filters`); an old record without it loads as "Any status".
- Unchanged on purpose: the sidebar badge and "One at a time" ignore filters; Needs attention counts people, not rows.

## Step 2 - saved views

Two buttons above the When chips: **Missed today** (Today + Missed) and **Unhandled this week** (Last 7 days + Unhandled).

- **Not a second saved thing.** A view is a named set of filters; tapping one writes the same one record (`nbd_cc_filters`)
  the chips write. The button shows as pressed whenever the record equals the view (`matchView`), including after a reload.
  Touch any chip and the view button un-presses while the rest of the filter stays.
- A view keeps Jo's chosen order (sort) and replaces the range, dates, direction and status. Tapping the view that is on
  turns off just that view's range and status (order and nothing else changes).
- A view opens the **All** tab: Needs attention groups by person and hides handled / short calls a view may want.
- Views ignore nothing that must not be narrowed: the sidebar badge and "One at a time" still show the real open list.
- Definitions live in the pure module (`VIEWS`); adding a third view is one array entry plus a test row.
- The screen test fakes `Date` (3 PM New York, 2026-10-21), so it cannot fail at midnight-3am ET.

## Step 3 - the call-to-job loop (recon first: most of it already shipped)

Recon of `origin/main` before building found the loop was largely there, so this PR closes the gaps instead of rebuilding it:

| Asked for | State on main |
|---|---|
| Match a call to a lead by `phoneDigits` (never `leadId`, null on every observed call) | **Shipped.** `leadForNumber` checks `phoneDigits`, `phone`, `phone2`, `altPhone`, `mobilePhone`, `secondaryPhone`; 3+ customers = relay line, no suggestion |
| Suggested lead, one-tap attach | **Shipped.** "Looks like X - File on X" on the card and in the "Said you'd do" deck; `callCenterAction` `attach` |
| A call's promises / `followUpDate` become a reminder | **Shipped, server side.** Attaching a noted call writes the timeline entry and a follow-up task (`leads/{id}/tasks/cube-<callId>`, `buildFollowUpTask`, createIfAbsent; only calls from the last 14 days). The 📌 Promise sheet writes a promise task the same way |

Gaps closed here (client only - **no server, rules or auth change, so no security review was needed**):

1. **A shared number was matched to the first customer silently.** Two customers on one number (a couple, a duplicate lead)
   showed "this number is already on them" and a one-tap button for whichever lead came first, in the card AND the deck.
   Now the card says "This number is on 2 customers - which one?" with a button per customer, and fileTarget / the deck
   suggest nobody. The "+ New lead" duplicate guard is unchanged (a shared number still blocks a third lead).
2. **Filing did not say what it would do.** The card now shows "Reminder: <what> (<who>) · due <date>" before the tap, and the
   status line repeats it after. That text is a mirror of `buildFollowUpTask` (title, due date, priority, the 14-day window),
   pinned equal to the server's function over a 13-case matrix, so the screen cannot promise a reminder the server will not make.
   A call older than 14 days, a caller-only promise, a text day or a call whose notes are not written yet show no reminder line.

New pure module `docs/pro/js/call-center-loop-logic.js` (`candidatesForNumber`, `followUpPreview`); it never writes or sends.

**Not built, on purpose: a second path into the Agent inbox.** `agent_inbox` is create:false for clients (rules), so a call -> inbox item
needs a new Cloud Function, and the item would then wait for Jo to approve what Jo already approved by tapping File / Promise (the
real task is written immediately, on his tap). That is more server surface and one more tap for no new capability. If Jo wants the
inbox review step anyway (for example for a teammate's calls), that is a new callable and needs the security reviewer first - flagged
as an open question, not started.

Still true: nothing is sent to a customer, no prod write from a script, the sidebar badge and "One at a time" ignore filters.

## Follow-up (2026-10-23, overnight-audit finding): "Missed" was not real - now "Short calls"

The audit was right. The status chip and the saved view were called **Missed**, but they can only see "an inbound call under 15 s with a
known duration":

- Nothing in `functions/` writes `answered` on a `phone_calls` doc (grep: no writer). The `answered === false` branch in `isMissed`
  is dormant until one exists.
- `phone_calls` is built from Cube ACR **recordings** (a Drive folder). A call nobody picked up often has no recording, so it never
  becomes a row at all. The people Jo most wants to see are exactly the ones the chip cannot show.

So the labels were relabelled honestly: chip **Short calls**, view **Short calls today**. The ids stay (`missed`, `missed-today`) so a
record saved in someone's browser keeps working, and a test pins both the new words and the unchanged ids.

**Real missed-call source: what would have to exist.** Two candidates, neither built:

1. **The NBD Twilio line (`functions/twilio-line.js` voice dial-status).** It already computes `callOutcome(DialCallStatus)` =
   answered / missed with the caller, duration and CallSid, and files a note on a matched lead, a `missed_call` notification, or an
   Agent-inbox item for an unknown number. It does **not** write `phone_calls`. A server change there (and in `call-center.js`)
   could write a `phone_calls` row with `answered: true|false`, `source: 'twilio_line'` for each forwarded call. That covers calls to
   the business number only, not calls to Jo's personal cell.
2. **Jo's personal cell.** Cube ACR only records conversations. A missed call there leaves nothing on his phone's recorder; the only
   copy is the carrier / phone call log. Nothing in the CRM reads it today.

Either is a server change to a webhook or an ingest path (security review before it ships), so it is a separate decision for Jo, not part
of this PR. Until then "Short calls" is the true statement of what the chip does.

Same PR, two small honesty fixes:

- **Handled on Needs attention was always empty** (that tab never holds a handled call). The chip is now disabled there with the reason,
  and a saved "Handled" that lands on Needs attention shows the reason and an "Open All" button instead of "Nothing needs you".
- **If the filter module fails to load, the bar no longer vanishes silently.** It shows "Filters could not load, so the list below is NOT
  filtered. Reload the page to try again." (`role="alert"`).
