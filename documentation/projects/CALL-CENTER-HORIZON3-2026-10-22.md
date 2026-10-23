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
