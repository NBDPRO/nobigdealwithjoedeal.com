# Promise capture + Waiting-on-them (2026-10-12)

Two slices of Jo's "never forget anything" chain
(calls -> Today -> 2-hourly reminders -> Thursday -> automations -> one-tap
suggestions). Other lanes own contact labels / callWatch-reads-labels and the
reliability ladder (heartbeat, ack-timeout, escalation, canary, digest); this
lane touches neither `functions/call-watch*` nor push delivery.

**Status:** design (stage 1). Build follows in a second PR.

## The problem in one line

"Handled" asks nothing. A call row can be ticked off with a promise still
sitting in Jo's head, and the system never learns what was owed, to whom, by
when. Meanwhile "waiting on a customer / adjuster / supplier" has no home: it
is either a task nobody opens or nothing.

## 1. Promise capture - the forced next action

### Chips

When Jo handles a call row (Today, the Call Center card) or taps **Promise**
on a customer page, one sheet offers one-tap chips:

| Chip | `promiseKind` | Default due |
|---|---|---|
| Call back | `callback` | today |
| Send estimate | `estimate` | tomorrow |
| Text by 5pm | `text` | today (`dueBy` 17:00) |
| Order materials | `order` | tomorrow |
| Check on permit | `permit` | +3 days |
| Waiting on them | `waiting` | nudge after the Waiting setting (see 2) |
| Nothing owed | - | no task; this is today's plain Handled |

Every chip except **Nothing owed** then asks for a date: Today / Tomorrow /
+3 days / +1 week / Pick (a date input). The default above is pre-selected, so
the common path is two taps (chip, Save). A one-line **why** is pre-filled
from the call's summary or Jo's own promise text and editable ("quoted $14k,
said I'd text the number Friday").

**Nothing owed** is the only way to close a call with no promise, and it is
explicit, so "handled" can no longer mean "I forgot to say what I owe".

### Data shape - the existing task, not a new store

A promise is a normal task: `leads/{leadId}/tasks/{id}`, so the bell, the
customer timeline, the overdue push, the One Task Load (`tasksQuery`), the
rules and the index all already apply. Extra fields, all optional on old
tasks (an old task without them is exactly what it was):

```
kind:           'promise'
promiseKind:    'callback'|'estimate'|'text'|'order'|'permit'|'waiting'
text:           'Call back - <why>'      // the legacy field every surface reads
why:            string <= 140
dueDate:        'YYYY-MM-DD'             // local day, like every task
dueBy:          'HH:MM' | null           // "by 5pm" is a label, not a timer
madeAt / madeBy / madeYmd
source:         'call' | 'text' | 'today' | 'customer'
sourceCallId:   'cube_...' | 'txt_...' | null
missCount:      n    // times it was moved while already overdue
rescheduleCount:n
outcome:        'kept' | 'dead'          // with done:true + completedAt
// waiting only:
waitingOn:      'customer'|'adjuster'|'supplier'|'other'
waitingSince:   'YYYY-MM-DD'
nudgeCount:     n    lastNudgedYmd
```

Task id for a call-born promise is `promise-<callId>` (idempotent: a double
tap or second device writes once; choosing again from the same call edits it).
A customer-page promise gets an auto id.

### One server action, not a parallel store

`callCenterAction` gains **`promise`** `{ id, kind, dueYmd, why, waitingOn? }`
(same audience as the other actions: the call's owner, an admin, company_admin
/ manager of the call's company; viewers and reps refused). It:

1. validates kind (the six above), date (today .. +120 days), trims `why`;
2. call is filed on a customer -> writes the task above onto that lead
   (tenant stamps from the lead), marks the call handled, and retires the
   call's own generic `cube-<id>` / `sms-<id>` follow-up task as
   `supersededBy: promise-<id>` so the person is not owed twice;
3. call is NOT filed (unknown number) -> there is no lead to hang a task on,
   so the promise rides on the call doc (`promise{...}` + `snoozeUntilYmd`)
   and the call stays unhandled: it returns to Today on its date, tagged.
   `waiting` needs a customer and is refused with "File this call first".

Rescheduling / keeping / waiting actions on a task promise are plain client
writes on the task (owner / company staff already may), from a pure logic
module that has a server twin and a parity test (the `today-plan.js` /
`morning-brief-logic.js` convention).

### No dismissing without a new date

An open promise has exactly two exits:

* **Kept it** - `done:true, outcome:'kept'`.
* **Move it** - a new date (Tomorrow / +3d / +1wk / Pick). Moving a promise
  that is already overdue adds one to `missCount`; the new date must be a
  real date on or after today and not the date it already has.

There is no "Handled", no "Dismiss", no "x" on a promise row. The customer
task list refuses to delete an open promise (it says why and offers the two
exits). Overdue promises are **never auto-deleted or auto-archived** - nothing
in this slice has a sweep.

### On Today

A promise due today or overdue is its **own item**, in its own section
("Promises", above Calls owed - it is the thing Jo said out loud), one row per
person like every Today section:

```
Dana Whitfield                         missed 2 times
  Send estimate - due today - quoted $14k, text the number Friday
  [Kept it] [Tomorrow] [+3 days] [+1 wk] [Pick]   Call  Text  Open
```

* A person is listed once: their open calls merge into the promise row (the
  existing "promised" merge), so "N things today" still counts things, not
  the same customer three times.
* Promises **ignore snooze and labels**. A lead snoozed from the bell still
  shows its promise. A number Jo labelled `hide` keeps its promise row,
  tagged "number hidden", because the promise is Jo's, not the caller's.
* "missed N times" shows from the first miss and is red from the second.
* A failed task read is not "zero promises": the existing Today `ready()`
  gate (`_leadsLoaded` + `NBDTasks.loaded()`) already holds the list on
  "Loading your day" rather than painting empty over a failed load.

## 2. Waiting-on-them

"Waiting on them" is `promiseKind:'waiting'` with `waitingOn` and
`waitingSince`. It is *not owed today*, so it stays off the to-do sections
until it ripens:

* **Ripens** when `today - waitingSince >= N` days. N defaults to 3 and is a
  setting (`userSettings/{uid}.promiseSettings.waitingDays`, 1 to 14, a
  stepper in the Waiting group header on Today).
* A ripe item sits in a **Waiting** group on Today (own section, below Money,
  above Stalled), badged "Waiting on customer - 5 days", with its why.
* The task's `dueDate` is set to `since + N` at creation so the older
  surfaces (bell, overdue push) ripen on the same default.

One-tap actions:

| Action | Effect |
|---|---|
| **Nudge** | Opens a DRAFT text (customer, adjuster) or email from a fixed template through `NBDPhoneShare.share` - Messages / Mail with the words already written, sent by Jo's own thumb. It runs the server's "ok to text?" check first (STOP register, Do Not Text, consent, hours). Jo confirms "did it go out?"; only then `nudgeCount++`, `lastNudgedYmd`. Never auto-sends, never writes a send record itself. |
| **Still waiting** | `waitingSince = today` (clock resets, dated), `dueDate = today + N`. |
| **Mark dead** | `done:true, outcome:'dead'`. Distinct from kept, so a dead end is not counted as a kept promise. |

The nudge words are fixed templates with a merge field for first name and
company, and obey the Kentucky wording rules (no claim handling / negotiating,
no coverage / deductible talk, no price) - the same forbidden-word list
`functions/pixel-draft-logic.js` pins, asserted on every template by test. The
adjuster template names only the claim number the lead already carries.

## UI states

* Sheet (phone, 390px): bottom sheet, 44px chips, two steps (chip -> date
  + why -> Save), Esc / backdrop / back-chip to cancel; the chosen chip is
  `aria-pressed`. Desktop: same sheet, centred.
* Offline / failed write: the sheet stays open with the reason, the call row
  does not disappear; a promise that did not save is never shown as saved.
* Viewer: no chips, no buttons (read-only role everywhere).
* Empty: no Promises / Waiting section renders.

## Deferred (named so nobody thinks they were forgotten)

* **Waiting derived from claim state** (`supplementStatus`, "adjuster
  inspection pending", an estimate sent but unopened) - this slice only
  waits on what Jo marked. The estimate rows already have their own section.
* **Auto-capture from the transcript** - `promises[]` the AI already extracts
  still feed the existing "Said you'd do" deck; turning them into dated
  promise tasks automatically is the one-tap-suggestions lane.
* **callWatch / 2-hourly reminders naming the promise** - belongs to the
  reliability lane (it owns `functions/call-watch*` and the ladder). The
  task is a plain task with a `dueDate`, so the existing task-overdue path
  already reaches the bell and push.
* **Supplier phone book** for the supplier nudge (today: the share sheet
  lets Jo pick the contact; no number is stored).
* **Server-side refusal to delete an open promise** (rules). The UI blocks it
  and the owner can still hard-delete from the console; a rules clause
  would need a `kind` read on delete and is a separate review.
* **Waiting count in the "N things today" headline.** Left out on purpose
  (it is not owed today); one-line switch if Jo wants it in.

## Decisions for Jo

1. Should ripe Waiting items count in "N things today"? (Built: no.)
2. Default Waiting threshold 3 days - right?
3. Handling a call on **Today** now always goes through the chip sheet
   ("Nothing owed" is one extra tap). The Call Center card keeps its direct
   Handled and gains a **Promise** button beside it, and the swipe deck is
   unchanged. Want Handled forced through the sheet there too?
4. Unfiled (unknown-number) calls: promise rides on the call and returns on
   its date. OK, or require filing on a customer first?

## Update 2026-10-13 (lifecycle audit) - the "overdue push" does not exist

The Deferred list above says a promise task "is a plain task with a
`dueDate`, so the existing task-overdue path already reaches the bell and
push". Checked against the code:

- the task-overdue notice is a **client** bell doc written by
  `docs/pro/js/tasks.js` while Today renders (the app has to be open), and
  there is no server trigger that turns a `notifications` doc into a push;
- no scheduled function reads `leads/*/tasks` due dates (the only
  collection-group task readers are the calendar feed, the Google Calendar
  mirror, the morning brief's *event* tasks and the game);
- a call handled through the sheet is `handledAtMs`-closed, so callWatch, the
  sweep, the brief, the 8 pm ledger and the away list all drop it.

So a promise captured through the Handled sheet on a filed customer is
**silent server-side on its due day**, and the ledger reads "0 open". Waiting
items are the same. Reproduced in the volume simulation
(`tests/needs-you-volume-sim-2026-10-13.test.js`, finding F-PROMISE-TASK-SILENT)
and written up with options in
[NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13](../audit/NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md)
(F1, section 4.1). A promise riding on an *unfiled* call is not affected: the
call stays open and callWatch tells it on its date.

## Update 2026-10-13 (promise channel PR) - the server channel exists now

The gap above is closed: callWatch reads open promise tasks and ripe Waiting
items (one row per person), sends ONE "N promises due today" push, lists them in
the 06:45 brief + 15:15 sweep, counts them in the 20:00 ledger and the away cover
list, and feeds the same 3-rung ladder; a failed read says "could not check".
Details and before / after numbers:
[PROMISE-CHANNEL-AND-PARKED-RULE-2026-10-13](../audit/PROMISE-CHANNEL-AND-PARKED-RULE-2026-10-13.md).
