# Promise channel, one parked rule, email when no push lands (2026-10-13)

Jo said "we can do all 10" of the ranked fix list in
[NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13](NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md).
This note is the record of server items **1** (F1, the promise / Waiting channel)
and **2** (F2, the email rung behind a dead push; F5, an urgent filed call with no
task). A sibling lane owns ping volume (F4 / F6 / F7 / F8) and the owner
notification gateway; nothing here changes how many alerts one *call* makes.

## Before / after (the deterministic volume harness)

`node tests/needs-you-volume-sim-2026-10-13.test.js`, same seeds, same clock.

| Scenario | Before | After |
|---|---|---|
| **N** a promise "Call back in 2 days" taken through the Handled sheet, Jo never opens the app | pings after capture **0**; ledger on the due day **open 0** | due day: **1** push at **08:00 ET** ("1 promise due today"), **1** brief row, ledger **open 1, clear false**; nothing before the due day |
| **O** one person owed 3 things on the same day | (no signal at all) | **1** push, **1** brief row listing all 3, ledger counts **1** person |
| **P** the task read fails on the due day | (no read existed) | ledger shows a "could not check" warning, never clear; no invented push |
| **G** dead push token, urgent call open, 2 days | 13 push attempts, **0 emails** | 13 attempts (it keeps trying), **exactly 1** email "Your phone did not get the alert", then silent |
| **G** control, live token | 1 rung-3 email | 1 rung-3 email, 0 "did not get it" emails |
| **H** urgent call on a filed customer, no task, never handled | brief / sweep email days **0** | listed in the brief / sweep for its 36 h (**2** digest days) |
| Storm week / quiet week / repeat caller / spam burst / night | pushes, bells, emails per day as in the audit | **unchanged** (storm: 19 pushes max, 16 bells, 13 emails; the volume lane is not touched). The only movement is F5: the repeat-caller attentive run lists the urgent filed call once in the brief |

## What was built

### 1. One parked rule - `parkedUntil(row, now, opts)` (`functions/call-watch-logic.js`)

Snooze was five mechanisms. One function now answers "is this parked, and until
when" and every server surface asks it; `docs/pro/js/home-attention.js` mirrors it
and `tests/never-forget-client-2026-10-13.test.js` fuzzes both (snooze fields were
added to the fuzz rows, `parkedUntil` is in the shared-surface list).

| Mechanism | Where it lives | In the rule |
|---|---|---|
| Call snooze | `snoozeUntilYmd` on the call / text day | yes |
| Task snooze | the follow-up task's due date moved (`snoozedFromDue`); callWatch mirrors it as `taskSnoozed` + `taskDueYmd` | yes; **and** `callCenterAction` `snooze` now stamps the call too, so Home / ledger / brief / away (which read only the call row) see it (audit F9a) |
| "Tomorrow" / a promise moved to a date | `dueDate` on a `kind:'promise'` task | yes (a date ahead is parked, due today is owed) |
| "Later" in the swipe deck | in-session reorder only (`catchup-logic`) | deliberately absent: it never parks anything server-side |
| "Keep hidden" | a label baseline (`ackAtMs`) for `resurfacedNumbers` | deliberately apart: a different question (may this number come back), not a date |

Used by: `callNeedsYou` (so the ledger, away list, ladder, newNeeds all inherit
it), the ladder (`taskDue` option keeps its old "task dated ahead" behaviour), the
sweep (it already read `snoozeUntilYmd`), the promise channel (`dueItems`), the
Thursday tell (a non-urgent Thursday call from a parked number waits; urgent
breaks through). **Behaviour change to know:** a snoozed person no longer counts
on the Home strip or in the 20:00 ledger until the snooze ends (they already did
not show on Today). Legacy task-only snoozes written before this PR carry no call
stamp; callWatch still sees them (reconcile), the brief / away list do not until
the next snooze.

### 2. The task channel (F1) - no new function, no new index

- `functions/promise-channel.js` reads `collectionGroup('tasks').where('userId',
  '==', owner)` - the equality-only query the morning brief, the calendar feed and
  the game card already run, served by the existing single-field
  COLLECTION_GROUP index. Kind / done / date are judged in memory, so
  `firestore.indexes.json` is unchanged. The owner's leads behind due tasks are
  fetched by id (`getAll`).
- `functions/promise-channel-logic.js` (pure): owed = open promise dated today or
  earlier; ripe = open Waiting item whose nudge date has come; done / kept / dead /
  deleted drop out; a moved date is simply re-judged. **One row per PERSON**, key
  `lead:<id>` (the same key a filed call gets, so a person with an open call and a
  due promise is one person). Labels: a promise always surfaces (hide / quiet do
  not drop it, a hidden personal number's breaks through); a number labelled
  **spam** does not. Tenant: only the owner's leads; a deleted lead's tasks are off.
- **callWatch** (the existing 2-hourly function) reads it every run. The first run
  with an untold person sends ONE push "N promises due today" (N = people) plus a
  bell (`promise_due`) - this is the 08:00 ET run in normal operation; if that run
  fails or reaches nobody, the next run does it. A push that reached 0 devices does
  not count as told (the person gets `n:0`, tried again). After the push the person
  is a ladder candidate (`promise:<leadId>`, signature = the set of due task ids +
  dates): rung 2 / rung 3 re-tells through the normal alert, rung 3 sticky + the
  ladder email, then silence. A changed set of due tasks (new item, date moved
  back into today) is a **new** tell.
- **Morning brief** and the **15:15 sweep** list them through
  `gatherSweepWithPromises` (a "Promised" row, opens the customer; one row per
  person - a person already in the list gains the promise text instead of a second
  row). The deck (`callPromisesList`) keeps plain `gatherSweep`: its rows are calls
  it can swipe.
- **20:00 ledger**: due people are counted as open people, deduped against open
  calls; the title can never read "nothing fell through" while one exists.
- **Away cover list** (`loadOpenItems`): the backup sees them too.
- **Fail closed**: a failed task read is carried as `failed`: the ledger, the
  brief and the sweep email each say "could not check ... NOT an all-clear";
  callWatch records `promiseCheck.failedAtMs`; the away list throws like its call
  reads (the tick records the error, an expiring window treats every touched item
  as still open).

### 3. F2 - email when no push reaches a phone

On the first run a push (the alert, or the promise push) returns `sent: 0`, the
high-value items it carried go in ONE email to Jo's own inbox, through the same
`email` helper the ladder email uses (the same `users/{owner}.email`; **no new
recipient path**, nothing a tenant can write - when PR #2410 merges, NBD's own
tenant is explicitly *not* routed through `alert-recipients.js`, so this stays as
is). Once per item: `integrations/callWatch.unreachedEmailed` (a promise's key
carries its signature, so a changed set may mail again; entries expire after 14
days). The run still fails loud afterward (heartbeat) as before.

### 4. F5 - urgent, filed, no task

`collectSweepItems` lists an urgent call (36 h window) on a filed customer with no
follow-up task, so the brief / sweep match the ladder email's wording. (Creating a
task at transcription - option B in the audit - was **not** done: it would add a
"Promised follow-up" row to Today for every urgent call; Jo's call.)

## Tests

- `tests/promise-channel-2026-10-13.test.js` (76 checks, in the CI node bucket):
  parked rule, server/client reader parity, who is owed, ladder rungs, unreached
  email, ledger, sweep, brief, snooze stamping, away, Thursday, and `runWatch`
  end to end with stubbed senders (one push, idempotent, dead token = one email,
  failed read). Every absence assertion has a presence control.
- Volume harness: scenarios N (assertions), O, P, and the F2 / F5 assertions in
  G / H; the "one `promise_due` push per day" invariant over every run.
- Existing suites touched only to give their fakes a `collectionGroup` (the
  channel fails closed, so a fake without one now correctly reads as "could not
  check"): call-center-sweep, call-center-action, never-forget-server,
  promise-window-server.

## Left / decisions for Jo

1. **Daily nag vs ladder.** A promise overdue for weeks is pushed at most 3 times
   (then brief + ledger + Today carry it), like a call. If Jo wants a push every
   morning while a promise is overdue, that is a one-line change in
   `promiseFresh` (call-watch.js) - but it is the F7 "twice a day for a month"
   problem again.
2. **Two pushes at 08:00.** A call alert and the promise push can land in the same
   run (two pushes). Merging them is the ping-volume lane's.
3. **Staff-owned leads.** The read is `userId == owner`, like the brief; a promise
   task on a lead whose `userId` is a rep, not the owner, is not seen (a
   `companyId` read needs its own collection-group index - not added without Jo).
4. **F7** (the same open promise listed in the brief *and* the 15:15 sweep) now
   applies to promise tasks too.
5. Task creation for urgent calls (F5 option B) - see above.

## Update 2026-10-13 (ping volume PR)

Items 2 and 4 above are done in [PING-VOLUME-2026-10-13](PING-VOLUME-2026-10-13.md):
a call alert and the promise push of one run are now ONE push, and the 15:15 sweep
is skipped when its list equals the morning's (so an unchanged promise is mailed
once a day, not twice). A promise is also subject to the person card: it always
pushes as a NEW kind, and a second promise from a person already pushed about a
promise today is folded (its bell and brief row remain).
