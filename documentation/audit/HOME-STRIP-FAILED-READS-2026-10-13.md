# Home strip / Today: failed reads and the double-counted person (2026-10-13)

Closes two items the
[never-forget client findings](NEVER-FORGET-CLIENT-FINDINGS-2026-10-13.md) left
open under "Seen but not changed" / "Not fixed". Test:
`tests/home-strip-failed-reads-2026-10-13.test.js` (75 checks; the real browser
files run in a vm sandbox; the failing-first run on `main` reddens the
fix assertions while every positive control passes there, so the harness can
see the bug; each fix was also break-tested - neutering it reddens the intended
assertion and only that one).

## 1. A failed read is never a zero

| Read | Before | Now |
| --- | --- | --- |
| Stripe "needs a customer" (strip) | `.catch(() => {})` -> 0 -> strip hidden | `stripeFailed`: "Could not check Stripe payments just now - NOT an all-clear. Tap to try again" |
| Yard signs due (strip) | same | `signsFailed`, same wording |
| Review asks waiting (strip) | `loadInvoices().catch(() => null)` + a bare `catch`; no invoices = 0 asks | `reviewsFailed` when `NBDRevenue.cached()` is still null after the load (it never rejects; a real empty list is cached as `[]`), or the candidate computation throws |
| Today appointments | `console.warn` only, rows overwritten with whatever the lanes returned | `appts.failed`; a failed lane keeps the same-day rows already known and Today names it |
| Today money owed (invoices) | `loadInvoices().then(schedule)`, failure = no Money rows | `inv.failed` only when the read settled with nothing cached and nothing earlier to show |
| Today Stripe row | `HA.lastCounts.stripe || 0` | names a `stripeFailed` read |

Rules the tests pin:

- **pending is not failed**: the strip is only repainted when all reads have
  settled; Today only sets a failure after a settle; slow-read tests assert no
  banner while the promise is held.
- **cached-and-empty is not "none"**: a Firestore snapshot with
  `metadata.fromCache === true` and zero docs never reached the server, so it is
  unconfirmed (Stripe, yard signs, appointments). A non-empty cached snapshot is
  real data.
- every warning has a retry: the strip items carry `data-ha-retry` (one
  document delegate, CSP-safe); Today's banner carries
  `data-tp-act="retry" data-tp-key="reads"` which re-reads the strip and the
  failed appointments / invoices. Buttons are `.tp-btn` / `.ha-item`
  (44 px; measured at 390 px wide, no horizontal overflow).
- the headline says "Can't confirm your day yet" (not "Nothing due today")
  when the list is empty and any read failed.

Also (silent-failure review pass): the calls / texts / old-promise reads and
`NBDRevenue.loadInvoices` use the same cached-and-empty rule (the loader no
longer caches an offline empty snapshot as a real empty list); a throw inside
the strip's `count()` is shown as NOT an all-clear instead of leaving stale
rows; a needs-you / estimate / no-next-step rule that throws is named on Today;
a read still in flight shows "Checking your day" (never "Nothing on the
list"); the invoice rows are taken at settle so a data refresh dropping the
shared cache cannot blank Money.

Not changed (deliberately): the contact-labels load (`labels = null` falls back
to the OLD rule, which shows MORE, so it fails safe); a reload that fails AFTER
a good one keeps the last rows without a banner (stale, not empty - no age tag
yet).

## 2. One person = one row in "N things today"

Cause: `callerKey` (the server's rule, `functions/call-watch-logic.js`) keys a
call by customer id when filed, else by number. A customer's promise row and a
call from their number that is not filed on them were two keys, so two rows.

Fix, in `today-plan.js` only (the strip / Call Center / `callWatch` keep the
server's key - never forked, the parity fuzz in
`never-forget-client-2026-10-13.test.js` stays green): an unfiled call whose
10-digit number (leading 1 and punctuation normalised) belongs to **exactly one**
live customer is that customer's call.

- filed groups are processed first, so the order of `callGroups` never matters;
- it joins the customer's Promises / Promised row, or their Calls-owed row, as
  `phoneCalls` - **never hidden**: it renders as "Also an unfiled call from
  this number" inside the row with its own Handled (or Kept it / Move when it
  carries its own promise) under its own key `num:<digits>`;
- Handled on it hides only that call (session `handled` set), never the
  promise row;
- two customers sharing a number = no guess, separate rows; a call filed on a
  deleted / unknown lead id keeps its own row (only a call with NO customer id
  is "unfiled");
- a phone-matched call's id is kept OUT of the task row's `callIds`, so Done /
  Tomorrow on the task cannot quietly handle or snooze it; handling the host
  row's own call promotes a still-open rider to a row of its own;
- a resurfaced hidden number keeps its reason and Keep hidden button on the
  rider;
- with no promise or call row to join, the call becomes one row named for the
  customer and the lead is no longer ALSO listed as Stalled / an estimate
  follow-up.

Visible consequence worth knowing: the Home strip's "N people need you" still
counts by the server key, so a filed customer + an unfiled call from their
number reads 2 on the strip and 1 on Today. Changing the strip means changing
the server's `callerKey` and the 2-hourly push count together; that is a
decision, not a client patch.

## Unverified

- A real iPhone (installed app, daylight). Measured only: a Chromium page at
  390 x 844 with the real CSS and the real rendered markup (targets >= 44 px,
  no overflow) - not the authed dashboard through the emulator.
- Production behaviour of `metadata.fromCache` on the Home reads (the emulator
  and the fakes cover the logic; a real offline cold start was not exercised).
- A read that hangs forever still holds the strip's single-flight guard until
  the SDK gives up; no timeout was added (a timeout would turn "slow" into a
  false alarm).
