# Promise window on the server (QA finding H2) - 2026-10-13

Source: the never-forget QA sweep of 2026-10-13, finding H2 (its
FINDINGS note, qa/never-forget-2026-10-13/, lands with PR #2404 and is linked
from INDEX.md there; a relative link would be broken until it merges)
(lands with PR #2404; mark H2 fixed there when both are in). Context:
[PROMISE-CAPTURE-2026-10-12](../projects/PROMISE-CAPTURE-2026-10-12.md),
[NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12](NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12.md).

## What was wrong

Jo's rule (2026-10-12): an open promise of his stays "needs you" to **45
days**, then rolls into ONE "N old promises to review" chip on Home. The rule
function (`callNeedsYou`) existed on both sides and already agreed. What the
server **fed** it did not: `callWatch`, the 8 pm ledger and away mode's
`loadOpenItems` all queried `startedAtMs >= now - 14 days`. A 20-day-old
promise was on Home, absent from the rule's input on the server, so the ledger
said "nothing fell through", the re-tell ladder had pruned it at day 14, and
the away backup was never told. The fake db in every earlier test ignored
`where()`, which is how the window bug stayed green.

## What changed

- `functions/call-watch-logic.js`: `PROMISE_WINDOW` is exported next to
  `CALL_WINDOW`. New `openJoPromise`, `isOldPromise`, `oldPromiseCount`
  (mirrors of the Home functions; same PEOPLE count via `callerKey`, text days
  excluded as on Home).
- `functions/call-watch.js` and `functions/away-mode.js` `loadOpenItems` query
  `PROMISE_WINDOW`. Same `(userId, startedAtMs DESC)` composite index, a wider
  range: **no `firestore.indexes.json` change**. The Thursday 14-day filter is
  unchanged (a Thursday call is not a promise).
- The 20:00 run reads promises past 45 days with one more query on the same
  index (`startedAtMs < now - 45d`, newest 300) and the ledger adds
  "N old promises to review" (not counted as people, same as Home) and is no
  longer "clear". A failed read becomes a warning line, never silence; a read
  that hit the 300 cap says only the newest older calls were checked.
- `pipeline-canary.js` queries the same range as callWatch so a missing index
  on the real shape is caught.
- **Kept promises stop nagging at once.** `callNeedsYou` / `reasonFor` (both
  sides) used any Jo promise inside 14 days and `!keptAtMs` only past 14; a
  promise stamped kept by promise-cleanup nagged for up to 14 days. Both now
  use the open-promise test. Doc-level and per-promise: a call with one kept
  and one open promise still needs Jo.

## Invariants kept (and tested)

- Jo's own reply (a newer outbound call to that number) neither clears a live
  promise nor reopens an old one: the window anchors on the promise's own call
  `startedAtMs`, and `reachIndex` only ever affects missed calls.
- A promise surfaces through `hide` / `quiet` labels (unchanged branch).
- A failed read never hides (ledger warning above; Home's `callsFailed`).
- Home and server rule parity: 0 differences over 1,616 rows (age 0-100 days x
  promise shape x urgent x handled), plus old-promise counts.
- The two window numbers cannot drift silently: the test reads
  `home-attention.js`'s `CALL_WINDOW` / `PROMISE_WINDOW` literals and compares
  them to the server's exports. (A browser IIFE and a CJS module cannot share
  one file under the strict CSP, so a source-level pin is the single-source.)

## Behaviour to know about

- **callWatch tells a promise at arrival, then via the re-tell ladder.** The
  ladder now keeps a told promise for 45 days instead of 14, but it is
  capped at 3 tells (`LADDER_MAX`); after that the morning brief carries it.
  Promises that fell out at day 14 before this deploy are not in the ladder
  state, so they are **not** re-pushed after deploy (no burst).
- The ledger's `oldOpen` ("waiting more than 3 days") now includes 4-45 day
  promises, so it will read higher than before. That is the point.

## Still open (not fixed here; from the same sweep)

- Home reads by row cap (200 calls / 100 text days), not by date: with >200
  calls inside 45 days, Home can miss a promise the server (which reads by
  date) now correctly counts, so the ledger can show a person Home does not.
  The server is the safer side; the Home read should move to a date range.
- A texted promise past 45 days appears nowhere (both sides skip
  `channel: 'text'` in the old-promise row).
- Away mode ignores labels (`loadOpenItems` passes no `ctx.labels`).
- Old-promise read is capped at 300 rows past 45 days.

## Evidence

`tests/promise-window-server-2026-10-13.test.js` (19 checks, in the CI
manifest). Reverting each fix reddens the matching check: the callWatch query
(ledger, ladder, source pin), the away query, the kept rule (parity fuzz +
both sides), the ledger line, and the failed-read warning.
