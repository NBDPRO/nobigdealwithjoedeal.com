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
