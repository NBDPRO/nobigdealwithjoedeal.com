# Today UX walk, fix B: cold boot, phone first screen, Undo (2026-10-13)

Closes H7, H2/M12, M1 and M4 of [FINDINGS](FINDINGS.md). Stacked on
[fix A](FLOW-A-ROW-AND-HANDLED.md). Server batching and label rails stay with
the other lanes.

## What changed

| Finding | Before | After |
|---|---|---|
| **H7** false banners on cold boot | The first read at boot is an empty snapshot from the cache (or asked before the db / company claim exists, or answered for the old scope). `loadInvoices` opened a 30 s failure window and every caller got `[]`: "invoices did not load" on the strip, "could not load ... money owed" on Today, Money rows missing | `NBDRevenue.status()`: `ok` / `checking` / `failed` / `unknown`. The first unconfirmed answer is `checking` for a 2 s window with ONE quiet re-ask (2.5 s, `nbd:invoices-settled`); only a real error, or an answer still unconfirmed after the window, is `failed`. The strip (`home-attention.js`) and Today (`today-home.js`: invoices, appointments, calls, Stripe) use the same rule and say "Checking..." meanwhile. A real error is named at once |
| **H2** first screen has no work | Welcome + NEW ESTIMATE, strip chips that repeat Today, 3 suggestion chips, then the first row at y=840 (list bottom 956) | Strip items Today lists (`data-ha-dup`: Stripe, people) hide on a phone while Today is on the page; whole strip hides when only those remain; one suggestion, below the work, never the `lead` evidence ("Looks like Customer" on a customer); the welcome block becomes one line once rows exist. First row at y=364, bottom 479 |
| **M1** no Undo | Done / Tomorrow / +1 week / Kept it / Move / Still waiting / Mark dead were unrecoverable; Mark dead had no confirm; the row slid away at once | Each has a 6 s Undo that writes the previous values back (the task's own old counters and dates, null where it had none; calls via `unhandled` / `unsnooze`); Mark dead asks first; the row holds ~240 ms (faded) while the list is inert, and a second tap while it holds sends nothing |
| **M4** handled set | Hid by key until reload: a later call / new promise / next day's due row stayed hidden; Kept it on one call hid the whole person | The set stores each row's facts (`rowSig`); a row whose facts changed (new call id, task id/date, amount, follow-up) comes back. Kept it handles only that call, with Undo |

## Decisions and limits

- **Call-borne Move has no Undo**: the server's `promiseMove` counts a reschedule
  (and a miss when late) and refuses a past date, so there is no inverse a client
  can call. The Move sheet is already a deliberate two-step. A task Move (Today
  Promises) does have one.
- **A cold boot is not 4 of 9 any more**, but "checking" is a window, not magic:
  a phone that stays offline names the failure after about 2.5 s, same words as
  before.
- **Boot budget raised +10 KB deliberately** (`tests/dashboard-boot-budget`, own
  line): ~14.7 KB of deferred code in files already loaded, no new tag.
- The strip's hidden duplicates are CSS-only (phone widths); desktop unchanged.
  The strip's navigation to the Call Center / Money from those two chips is gone
  on a phone; Today's own banners and "Open the Call Center" remain.

## Evidence

Measured at 390x844 standalone on the emulator (`walk/flow.js`; PR-A build =
before, this branch = after):

| Metric | Before (fix A build) | After |
|---|---|---|
| First real section (Appointments) top | y = 805 | y = 329 |
| First real row top / bottom | 840 / 956 (under the fold) | 364 / 479 |
| Welcome header height | 96 px | 44 px |
| Suggestion chips on the first screen | 3 (first at y=441) | 0 (one chip, y=3242, after the work) |
| Cold boots painting a false "NOT an all-clear" at any moment | 5 of 6 | 0 of 8 |
| ...persisting at 14 s | 0 | 0 |

- `tests/today-boot-phone-undo-2026-10-13.test.js`: 81 checks, real files in a vm
  sandbox with a fake clock + timers; every absence check has a positive control
  (a real error is named at once; unconfirmed past the window is named; a failed
  read is never marked duplicate). 25 mutations break-tested, the which-assertion
  list is in the PR.
- The walk found two more boot paths while measuring (asked before the db / company
  claim existed; scope changed mid-flight): both pinned by their own check.
- `walk/flow.js B-undo`: Done -> toast -> Undo reopens the task in Firestore;
  70 ms after a tap the list has not shifted; a double tap acted on nobody else.
- Screens: `B-40` (before), `B-41` (after), `B-50` (Undo toast).

## Not verified

Real iPhone (daylight legibility of the one-line header, toast over the bottom
nav, thumb reach, safe-area); a Firestore "unavailable" error at boot on a real
device (the emulator produced the empty-cache and not-ready paths; an
`unavailable` rejection is treated as a real failure, named at once, as before).
