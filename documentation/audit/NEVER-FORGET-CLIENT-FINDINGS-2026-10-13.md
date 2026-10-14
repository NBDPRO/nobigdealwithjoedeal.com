# Never-forget sweep — the CLIENT-side open findings (2026-10-13)

Companion to the server lane's `NEVER-FORGET-SERVER-FINDINGS-2026-10-13` (on
branch `fix/never-forget-server-findings`; link it here once that PR lands)
and the sweep's list,
[FINDINGS](../qa/never-forget-2026-10-13/FINDINGS.md). Scope: files under
`docs/pro/` (Home strip, Today, Call Center, the promise sheet, Waiting). Every
item was **reproduced with a failing test first**; what a test could not show
is listed at the bottom as unverified. Tests:
`tests/never-forget-client-2026-10-13.test.js` (70+ checks, browser files run in
a vm sandbox with a where()-honouring Firestore fake) and
`tests/e2e/never-forget-client.spec.js` (390 x 844, standalone rules, emulator).

## Verdicts

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | **H4** a promise saved from a call's sheet is not on Today until a leads refresh | **Verified, fixed** — two causes | (a) `promise-ui.js` never told the task cache / the call row what the server wrote: now `mirrorSaved` pushes the task into `window._taskCache` (keeping miss history), stamps the covered calls handled, patches an unfiled call's `promise` + `followUpDate`, then fires `nbd:data-refreshed`. (b) the optimistic "handled" set was keyed `lead:<id>`, the same key as the promise row of that customer, so the freshly saved promise was hidden **until the next page load**. Promised rows are now keyed `prom:<id>`; `today-home.js` no longer remembers a saved-promise call as "handled". |
| 2 | Home reads by row cap (200 calls) not by date | **Verified, fixed** | `home-attention.js` reads `startedAtMs >= now - 45 d` (the server's `PROMISE_WINDOW`) newest first, capped at 600 calls / 300 text days as a safety bound only; a hit cap says "Showing only your newest N calls" on the strip. Open promises past 45 days come from their own bounded read (300), whose failure is its own warning. Same `(userId, startedAtMs DESC)` index as before; no index change. |
| 3 | The Call Center hides failed reads | **Verified, fixed** (and Today had the same bug) | `call-center-view.js` records every failed source (your calls / your team's calls / your texts / your team's texts / the "said you'd do" list) and renders "Could not load … this is NOT an all-clear" + Try again above the list; the empty-attention message no longer says "Nothing needs you" then. Before, only the first calls read set `state.error`, and only when nothing else loaded. A newest-300 read that hits its cap inside the 45-day window says so. Today now shows the same banner (and no "Nothing on the list. Go knock some doors.") when Home's calls read failed. |
| 4 | Waiting items ripen without regard to "Nudge me on" | **Verified, fixed** | `isRipe` honors the item's date (`dueDate <= today`); the N-day clock only applies to an item with no date. Picking a date a week out no longer shows it at day 3; picking "Today" no longer waits 3 days. |
| 5 | Promise / Waiting counts must count people; keep the Home mirror in lockstep | **Counts: fixed. Mirror: verified clean + one gap closed** | Promises were already one row per person (pinned). Waiting was one row per task (header "2" for one customer with two items): now one row per person with its items inside; the pending line counts customers. Mirror: a seeded fuzz (~4,000 rows: labels, reach, kept stamps, texts, buckets, future label stamps, rider promises) found **0 differences** between `functions/call-watch-logic.js` and `home-attention.js` for `callNeedsYou`, `callerKey`, `reachIndex`, `resurfacedNumbers`, `oldPromiseCount`. The server lane's branch adds `saneStampMs` (future label stamps ignored) without a Home twin — added here, so a hostile stamp cannot park a number on Home while the server pushes it. The fuzz feature-detects the server lane's new exports (`ridingPromiseOpen`, `saneStampMs`) and covers them as soon as they exist. |
| 6 | "Kept it" on a texted-day promise should survive regeneration | **Verified server-side; deferred to the server lane (done there)** | Reproduced on `main`: a re-note replaces `promises[]` wholesale (`text-inbox.js` `promises: notes.promises`), so a `keptAtMs` stamp is lost and the next "thanks" re-opens "you promised something". The client has no write path (`phone_text_days` is `allow write: if false`) and its rule was already correct. The server lane's `carryKept` (branch `fix/never-forget-server-findings`) is the fix; nothing for the client to do. |

Also fixed on the way (same root cause class as H4):

- `NBDHomeAttention.render(true)` asked for while a read was in flight was
  **silently dropped**, leaving the strip and Today on stale rows for up to a
  minute after a promise or Handled. It is now remembered and run once the
  first read ends.
- The "handled keys collide between the Calls row and the Promise row" finding
  (Medium list) is item 1(b).

## Review pass (silent-failure hunt on the first cut) — all fixed, each with a check

- Today painted "Nothing on the list. Go knock some doors." in the 1.5 s before
  Home's first calls read (and forever if that render bailed): now "Checking
  your calls…" / "Can't confirm your day yet".
- Today showed only `callsFailed`; a capped read (600 calls / 300 text days /
  300 old calls) or a failed old-promise read was strip-only: Today now shows a
  "partial list - not an all-clear" banner for all of them.
- The old-promise read hitting its cap, and a page without `orderBy`/`limit`,
  were silent: both are now warnings (`oldCapped`, `callsFailed`).
- `promise-ui.js` save: Cancel / Escape / the backdrop stay live while the
  callable is in flight and `close()` nulls the sheet state, so the success path
  threw **after the server had saved**; it now works from a snapshot.
- The mirror patched Home's row but not the Call Center's own copy of the call;
  both are patched. A promise saved server-side that cannot be found locally
  asks the task loader to re-read instead of staying off Today.
- The Call Center dropped a reload requested while one was in flight (the same
  bug as Home's forced refresh); and a data layer that never came up (gave up
  after 30 s) rendered "No calls yet".
- The session's "handled" memory hid a person for the rest of the session even
  when they rang again: it now remembers *when*, and a call newer than that
  brings the row back.
- `resurfacedNumbers` was handed the new old-promise rows (80-day-old calls
  would re-open a hidden number); Home feeds it only what the server does.

Seen but not changed (pre-existing, outside the finding list): Stripe and
yard-sign reads on the Home strip still swallow their errors into `0`; a
secondary call failing after the primary promise saved reports total failure
(safe direction: the promise is already saved, a retry re-sends it).

## Decisions worth Jo's eye (all reversible)

1. **The waiting stepper changed meaning.** "after N days" used to move every
   item's threshold. With the date honored, an item's own "Nudge me on" date
   wins, so the stepper (relabelled "new items: nudge after N days") sets the
   default for new items and "Still waiting", and is the clock only for an item
   with no date. If Jo would rather the stepper also move existing items, the
   rule needs a "default vs picked date" marker the call-sheet path does not
   write today.
2. **Waiting rows are per person.** Each item keeps its own Nudge / Still
   waiting / Mark dead (they can go to different recipients). One customer with
   an adjuster and a supplier item is one row, two lines.
3. **Read caps.** 600 calls / 300 text days / 300 old calls on Home; 300 on the
   Call Center. Both say when they hit.

## Not fixed / observed

- The optimistic `handled` set is session-long: a row Jo acts on stays hidden
  until a reload even if the same key legitimately returns later. Only the
  cross-row collision was fixed (keys are now per section).
- A person with a promise on a filed customer **and** an unfiled call from the
  same number is two rows (two keys) in "N things today". Counting by phone
  would need a merge that could hide an open call; left as is.
- The server lane flagged "dead-man gaps" as not reproduced; nothing client-side.

## Unverified

- A real iPhone (installed app, daylight): only the 390 x 844 standalone
  harness ran. New surfaces: the Waiting person row with three buttons per
  item, the read-failed banners on Today and the Call Center, the strip's
  "Showing only your newest N" line.
- Production data volumes (the caps were chosen, not measured).
- The emulator never enforces indexes. The new read shapes equal the server's
  deployed ones (`callWatch` reads `userId ==` + `startedAtMs >=`/`<` +
  `orderBy startedAtMs desc` on both collections), so they should be fine.

## Reproducing item 6 on `main`

`tests/text-day-reopen-2026-10-13.test.js` has the harness (`handledDayDb`,
`runTextNotes`). Seed a handled day whose `promises` carry
`keptAtMs`, add a new inbound text, let the stubbed model return the same
promise unstamped: `promises` comes back without `keptAtMs`,
`handledAtMs` is cleared, `callNeedsYou` is true with reason "you promised
something".

## Update 2026-10-13 (later): two "not changed" items closed

The Stripe / yard-sign reads that swallowed errors into `0`, and the filed-promise + unfiled-call double row, are fixed in 
[HOME-STRIP-FAILED-READS-2026-10-13](HOME-STRIP-FAILED-READS-2026-10-13.md). The "Seen but not changed" and "Not fixed" bullets above describe the state before that PR.

## Update 2026-10-13 (lifecycle audit): two corrections

- "Open promises past 45 days come from their own bounded read" is true for
  **calls only**: `home-attention.js` reads `phone_calls` past the window,
  not `phone_text_days`. The server ledger does count texted old promises
  (server findings, item 5), so Home's "N old promises" chip and the 8 pm
  ledger can differ once texts are on (they are dark today).
- The strip counts a person Jo **snoozed** (`callNeedsYou` never reads the
  snooze); Today hides them. And a plain Call Center "Handled" leaves the
  call's follow-up task, so the person returns on Today as a Promised
  follow-up. Both reproduced in
  [NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13](NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md)
  (F9a / F9b); the control questions belong to the snooze / handle lane.
