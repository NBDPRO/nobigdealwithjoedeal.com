# Today / "people need you" — phone UX walk, 2026-10-13

Method: emulator with only the callables Today uses loaded (no alerting
triggers; `CLOUDSDK_CONFIG` empty so nothing could reach production), seeded
busy-Tuesday tenant, Playwright at 390x844 @2x, iPhone UA, standalone rules
forced, notch insets emulated, real taps. Four click-path traces ran first.
**R** = reproduced, **C** = code-verified only. Screens and the walk rig are
in this folder (`walk/`). Sibling audit: NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13
(lifecycle + volume, PR #2430).

## Update 2026-10-13 (fix A, stacked PR)

H1, M3, H3 and H4 are fixed: see [FLOW-A-ROW-AND-HANDLED](FLOW-A-ROW-AND-HANDLED.md).
The text below is the walk as it found things.

## Fixed in the PR that carries this note

- **F1 (was High): false "could not load today's appointments" on every load.**
  The `repUid` appointments lane is permission-denied by `firestore.rules` for
  everyone except platform admins, by design; #2426 turned that denial into a
  permanent "NOT an all-clear" banner that "Try again" cannot clear. A real
  failure of the `userId` lane is still named.
- **F2: the strip's "Tap to try again" on a failed invoice read was a no-op for
  30 s** (`loadInvoices` answers `[]` inside a failed window). A retry now
  forces the re-read; healthy renders do not.

Tests: `tests/today-ux-walk-2026-10-13.test.js` (9 checks; reverting the two
source edits turns 3 red, controls stay green). Cache-busters:
`today-home.js?v=13`, `home-attention.js?v=19`.

## Ranked findings

### High

- **H1 (R). An urgent missed call is buried in a "promised" row, and Done
  silently handles it.** A promise from two days ago plus an urgent missed call
  25 minutes ago shows as one "Promised follow-ups" row with no urgent/missed
  flag; Done wrote `handledAtMs` on both calls. The Call Center shows the same
  person correctly (URGENT, 2 open). Cause: `today-plan.js:520-530` folds the
  person's calls into the promised row's `callIds`; the promised renderer prints
  only tasks and "You said"; `act('done')` handles every id. Options: (a) show
  urgent/missed/count on the promised row; (b) keep an urgent/missed call as its
  own Calls-owed rider; (c) Done handles only calls whose own promise it is.
  **Recommend (a) + (c).**
- **H2 (R). The first phone screen has no work on it.** Header, welcome block and
  NEW ESTIMATE, strip chips, Today header and banners, up to 3 suggestion chips,
  then the first real section: first suggestion chip at y=522, first real section
  (Appointments) at y=886 on an 844 px screen; whole list ~3,760 px (~4.5
  screens). The strip's "7 people need you" / "2 Stripe payments" sit directly
  above rows listing the same people and item. Options: (a) hide strip items
  Today already lists on phone; (b) move suggestion chips to the bottom/behind
  one row; (c) collapse the welcome/NEW ESTIMATE block once rows exist.
  **Recommend (a) + (b), ~360 px saved.**
- **H3 (R). Handled fails silently, and a second tap makes it worse.** Handled
  opens the promise sheet; "Nothing owed" fires N serial `callCenterAction`
  calls (a 4-call person is 4 round trips). Callable down: the sheet stays open
  on step 1 with no message, the row stays, no toast (`#prErr` exists only on
  step 2). Second tap while saving: the sheet closes while all 4 writes still
  land, so a later failure has nowhere to show. No "Saving..." state, no Undo
  after success. Options: (a) paint busy + error on step 1; (b) one callable for
  all ids; (c) one-tap Handled with an Undo toast and "I promised something" as
  the secondary. **Recommend (a) now, (c) as the real fix.**
- **H4 (R). A Call Center "Handled" does not update Home or Today for up to 60 s
  and has no toast or Undo.** The Call Center `act()` never calls
  `NBDHomeAttention.render(true)`. Fix: one line after a successful act + an
  Undo toast (server already has `unhandled`).
- **H5 (R+C). One-tap Accept on Supplier / Sub / Job-seeker silently makes the
  number "quiet".** Toast reads "Labeled Supplier - Only if I promised". Quiet
  drops that number's urgent and missed calls (`home-attention.js:201`) and the
  chip copy doesn't say so; a homeowner mistyped as a supplier vanishes on one
  tap (only trace: "N people hidden by labels"). Options: (a) put the effect in
  the chip copy; (b) treat quiet like hide (opens the sheet); (c) let urgent
  through on quiet. **Recommend (c).**
- **H7 (R, root cause open). Cold boot paints two false "NOT an all-clear"
  banners** (strip: review asks "invoices did not load"; Today: "could not load
  ... money owed"), Money rows missing until a retry; 4 of 9 emulator boots.
  Cause: the first `getDocs` at boot returns an empty fromCache snapshot,
  `loadInvoices` records a 30 s failure, every caller in the window gets `[]`.
  F2 makes retry work; the boot false alarm is not fixed. Options: (a) don't
  count an empty-fromCache first read as a failure; re-ask after
  `nbd:data-refreshed` or a short timer before any banner; (b) shorten the window
  to ~3 s for that case; (c) "Checking..." for the first 5 s. **Recommend (a).**
  Two false red banners every morning trains Jo to ignore the real one.

### Medium

- **M1 (R). No Undo anywhere on Today; Mark dead has no confirm.** Done,
  Tomorrow, +1 week, Kept it, Move, Still waiting, Mark dead are unrecoverable;
  toasts stack and persist; the row is removed synchronously so the next person
  slides under the thumb and a double tap hits them (`today-home.js:477-478`).
  Recommend a 6 s Undo toast on every Today action (Label sheet has the pattern).
- **M2 (R). One person in up to three sections** (Calls owed, Money, Waiting;
  twice in the bell). `taken` isn't applied to money/waiting, so "things today"
  counts her twice; the header comment is wrong. Fold the invoice into the Calls
  row as a line.
- **M3 (R). Done on a row that carried an unfiled call brings the person
  straight back** (call promoted to Calls owed per #2426's never-hide rule, but
  reads as "Done didn't work"). Label buttons by what they close.
- **M4 (C). The session `handled` set hides things it should not**:
  `markHandled('prom:<lead>')` never undone on success, so a later call/newly
  saved promise for that customer disappears until reload; a "Tomorrow" row
  stays hidden tomorrow; `ckept` handles one call but hides the whole person
  (`today-home.js:574-578`). Key by row key + call ids/due date.
- **M5 (R). Seven counts, five units on one phone**: bell 9, CRM badge 8, strip
  7 people, Today 14 things, Call Center 7 / 7 / M / 18. Call Center says "last
  14 days" while promises run to 45. One noun ("people") on phone.
- **M6 (C). Snooze is honored by Today and the server but not the strip or Call
  Center** (`home-attention.js:177-216` has no `snoozeUntilYmd` branch). Fix with
  parity in the shared rule and its server twin.
- **M7 (C). "Later" in the deck is not a snooze**: reorders the queue, stores
  `nbd_triage_skips:<uid>` (wiped on sign-out), keyed by person so a new urgent
  call from a skipped person sorts last.
- **M8 (R+C). The bell is a fourth list and it repeats**: overdue task + "going
  cold" twice for the same person; a waiting item shows as a red "Overdue task";
  a person with an inspection today is "going cold"; "Clear all" left a badge of
  1; read state is `nbd_notif_*` in localStorage (wiped on sign-out). Make the
  bell an alert log only.
- **M9 (C). Thursday on Today**: items older than 3 days vanish with no "older"
  row; Reviewed is the only exit and doesn't close the task; a failed read is
  swallowed to empty (the only unnamed Today read); "Take back" on a
  quiet-labeled number deletes a nonexistent doc and toasts "Taken back"; the
  header can say "Nothing due today" above Thursday items.
- **M10 (C). The Inbox layout ignores contact labels** and keeps its own
  done-for-the-day memory (a 2 pm second call is invisible there); a fifth count.
- **M11 (C). Nudge leaves the item ripe** (`nudgePatch` writes only
  `nudgeCount`/`lastNudgedYmd`; `isRipe` reads `dueDate`), so it returns daily
  until "Still waiting". Estimate "Follow up" can send "...here it is again:"
  with no link when the link expired, then stamps the row.
- **M12 (R). Suggestion chips are noise**: three at once above the work; "Looks
  like Customer - this number is on customer Sam" suggests labeling a customer as
  a customer; "Not this" has no Undo and a pattern dismissal never expires. Cap
  at 1, below the sections; drop the `lead` evidence kind.
- **M13 (R). Calls roll off at 14 days with no action**: an urgent, unhandled,
  no-promise call from 16 days ago is on no surface. By design, but it is the one
  Jo would want asked about once - extend the old-promise row to "old urgent
  calls".

### Low

- Sheet step 1 has no Cancel; "Nothing owed" (the most common answer) is the
  weakest-looking button; urgent/missed/section titles are 11 px (contrast fine
  in dark theme, ~7:1 body / ~8:1 amber; sunlight not measured); "Keep hidden"
  gives no toast/Undo; "One at a time" and "See them in the Call Center"
  (`.tp-hd-btn`) are 32 px (every other Today control >= 44 px at 390);
  "See the list" lands on the default tab, not Labeled (C); the Away card wipes
  a half-typed note on its 60 s re-render (C); the Call Center nav badge is empty
  until opened once per session (C).

## The flow as a whole

- **Taps to clear a typical item:** call = 2 taps + a sheet, no Undo; promise =
  1; waiting = 1; invoice = 2. Handled is the most frequent action and the only
  one routed through a question - one-tap Handled with Undo makes the common case
  1 tap.
- **Order:** appointments first and Promises before Calls are right; but
  suggestions sit above everything (H2), an urgent call can hide in a promised
  row (H1), and Money/Waiting/Stalled are below the fold.
- **What held up:** failed reads are named, never zero, in every failure forced;
  one-person-one-row mostly holds; handled calls stay handled across reload;
  labels apply optimistically with rollback and a 9 s Undo.

## Verified OK (reproduced)

Handled call stays handled after reload and server-side; the strip recounts
immediately after a Today Handled (7 -> 6); row buttons wrap, never truncate, no
horizontal overflow at 390; a failed Handled callable loses nothing server-side
(the defect is Jo isn't told - H3); Still waiting moves `dueDate`/`waitingSince`;
Kept it writes `outcome:'kept'`; Mark dead writes `done` + `outcome:'dead'`.

## Unverified

Real iPhone (share sheet for Nudge/Estimate Follow up, `tel:`/`sms:` handoff,
true safe-area, keyboard resize of the promise sheet, daylight legibility);
Estimate "Follow up" result (code only); whether Jo's token role is `admin`
(if so F1 never showed for him - it does for any `company_admin`, e.g. `oaks`);
H7's frequency on a real device; production indexes; the logout wipe of `nbd_*`
(code, not a second login). Server ladder/volume and label/away policy belong to
the sibling audits; H5, M6, M9 are the user-facing half only.
