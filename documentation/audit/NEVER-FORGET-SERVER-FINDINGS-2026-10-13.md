# Never-forget: the server-side open findings, verified and fixed (2026-10-13)

Source: the open findings in the
[never-forget QA sweep](../qa/never-forget-2026-10-13/FINDINGS.md). Several
were "leads from reading, not reproduced", so every item below was first run
as a **failing test** on `main`, and only what reproduced was fixed. Earlier
fixes in the same chain: the 45-day server window
([PROMISE-WINDOW-SERVER-2026-10-13](PROMISE-WINDOW-SERVER-2026-10-13.md)) and
the handled-text-day reopen
([text-day-reopen-2026-10-13](../qa/text-day-reopen-2026-10-13.md)).

Tests: `tests/never-forget-server-2026-10-13.test.js` (54 checks, in the CI
manifest), the new (C2) block of
`tests/lead-alert-watchdog-2026-10-07.test.js`, and the rules cases appended
to `tests/firestore-rules.contact-labels.test.js` (96 checks).

## Verdicts

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | H3 - a call-riding `promise` on an unfiled call invisible after day 14 | **Verified, fixed.** #2407 only widened the query; the rule still read such a promise through the 14-day follow-up-date branch | `ridingPromiseOpen`: a `promise{kind:'promise'}` on the call doc is an open Jo promise once its date has come (not `done`, not kept; Kept it = Handled). `openJoPromise(c, now)` on both sides |
| 2 | A snoozed item never re-told when its snooze ends | **Verified, fixed.** The ladder dropped the item for the snooze and nothing re-armed it (a promise with no urgent push had no ladder seed) | `snoozeWakeYmd`: the day a call-level (`snoozeUntilYmd`) or task-level (follow-up task due date moved by a snooze) snooze ends is told once (`#wake:<ymd>` tell id) |
| 3 | `thursday_calls` read with `.limit(300)` and no `orderBy` | **Verified, fixed.** With more than 300 rows the arbitrary 300 are the OLD ones; the newest unreviewed call vanished from callWatch and the cover list | `readThursday`: dated window on the deployed `(companyId, startedAt DESC)` index + a null-`startedAt` equality read. **No new composite index.** Every writer (`buildPendingCallDoc`, webhook, `scripts/thursday-backfill.js`) stores `startedAt` (a Date or null), so null is the only "missing" |
| 4 | `handled` keys collide between the Calls row and the Promise row | **Verified, NOT fixed here (client).** `today-plan.js`: the Calls row key (`g.key`, `lead:<id>`) and the promised row key (`'lead:' + leadId`) share one namespace and one session `handled` Set, so Handled on a person's call hides that person's later-due promise row until reload. Repro: a plan with `handled = {lead:L1}` and a due promise task for L1 returns 0 promise rows, 1 without the key | Handed to the client lane: give promise rows their own key prefix (or make `handled` per row kind) |
| 5 | A texted promise past 45 days appears nowhere | **Verified, fixed.** `isOldPromise` excluded `channel:'text'` on both sides | Text days count (PEOPLE, same key); the 8 pm ledger reads old text days too; its failed read is a warning, never an all-clear |
| 6 | Away mode ignores labels | **Verified, fixed.** `loadOpenItems` passed no `ctx.labels` | Same `callNeedsYou` / `reasonFor` with the tenant's labels (`contact-labels.loadLabels`): hidden personal breaks through, spam does not, quiet needs a promise; Thursday rows from a hidden / quiet number stay out like callWatch. A failed labels read shows everyone |
| 7a | The watchdog claims a lead before re-sending | **Verified, fixed.** The claim was created first, never released; an alert that threw aborted the whole run and left a claim with no verdict, so that lead was never tried again | The claim now starts `resendReached:false, attempts:1`; a failed or throwing re-send is retried (max 3 attempts, 30 min apart, inside the 6 h lookback). A throw is contained (the other leads still go; counted unresolved so the heartbeat still fails). A claim with no verdict (older build, overlapping run) still blocks |
| 7b | Dead-man gaps | **Not reproduced.** No concrete gap was demonstrable: the slot math held over 48,000 timestamps across a DST year, a callWatch that fails before its state write is caught as not-running, and a missed 20:00 slot trips `callwatch_not_running`. One known soft spot is unchanged: an unreadable newest-call query says nothing (documented fail-quiet in `pipeline-deadman.js`) | none |
| 8 | Label `ackAtMs` unbounded | **Verified, fixed.** A huge value made `base` unreachable, so "hidden number came back" never fired for that number | `firestore.rules`: `ackAtMs` / `updatedAtMs` must be numbers in `[0, now + 1 day]`. Server: `saneStampMs` drops anything beyond now + 1 day to 0 in the one shared loader and in `resurfacedNumbers`. Old poisoned docs heal on read |
| 9 | Former-owner uid branch after a hand-off | **Verified, fixed.** `contact_labels`, `contact_suggestions`, `thursday_handled`, `away_mode`, `away_windows` used `request.auth.uid == companyId`; the former owner kept read AND write | Those uid branches are `ownsTenantByUid(...)` (the same helper `subs` etc. already use), so they follow `companies/{id}.ownerId` |
| 10 | A day closed by ticking its task (`taskDone`) is not reopened by a later inbound text | **Verified, fixed.** Also: `reconcileTaskDone` would silently re-close a reopened day from the still-done task | One rule with #2406: a new INBOUND text strictly after the close stamp (Handled's `handledAtMs`, or the task's `completedAt`; the later of the two) reopens; Jo's own outbound does not. The follow-up task is reopened with it only when the new note needs Jo (a "thanks" does not resurrect a to-do) and never if it was superseded by a dated promise task. A reopened day carries `reopenedAtMs`; reconcile and the task-write mirror ignore a tick that predates it |
| 11 | H1 side effect: a kept promise resurrected by a "thanks" | **Verified, fixed.** Re-notes regenerate `promises` from the model and dropped `keptAtMs` | `carryKept`: a regenerated Jo promise that matches a previous one (same words, or >= 0.6 word overlap) inherits its kept fields; if the day was closed AFTER the previous note, an unmarked match is kept at the closing time. An unmatched promise is NEW and stays open. Kept promises do not make a new follow-up task |

## Behaviour to know

- The Home mirror (`docs/pro/js/home-attention.js`) got the two rule edits
  (`ridingPromiseOpen`, texts in `isOldPromise`) so the two copies stay
  byte-for-byte equivalent in meaning; the parity fuzz (1,904 rows) pins it.
  Nothing else on the client changed.
- A reopened task-closed day still needs the client to show it: Today's call
  rows skip a row whose follow-up task is `done` (`today-plan.js`). The server
  reopens the task exactly when the new note needs Jo, so this works today;
  if the client ever stops reading the task, read `reopenedAtMs` instead.
- Promise matching is a similarity heuristic. A model rewording a promise past
  the 0.6 overlap makes it look NEW (it stays open: fail toward telling Jo).
- The daily self-test (`pipeline-canary.js`) now also runs the Thursday
  window read (8 checks, was 7), so a missing `(companyId, startedAt)` index
  is named in the dead-man instead of failing callWatch in production only
  (the emulator never enforces indexes).
- The watchdog's retries are visible: an exhausted claim stays on file with
  `resendReached:false` and `resendError`.

## Left for the client lane

- Item 4 above (handled-key namespace in `today-plan.js` / `today-home.js`).
- Home's own label reader could apply the same future-stamp clamp
  (`contact-labels-logic.js`); the rules now prevent new bad stamps and the
  server ignores old ones, but Home still trusts what it reads.
- Home reads by row cap, not date (carried from the H2 note).

## Evidence

A vacuous-test audit (100+ mutations) found the core checks sound and six
weak or vacuous ones (Thursday window not exercising order/limit, the away
Thursday label skip, a fresh tick closing a reopened day, the reworded-promise
match threshold, a comment-satisfiable source grep, the `updatedAtMs` clamp);
each now has a check that reddens on its mutation.

Reverting each fix reddens the matching check (and not a different one): the
new rules cases against the previous `firestore.rules` fail 15 of 96 (every
new deny, none of the allow controls); the watchdog block fails on a throw and
on the retry; the callWatch / away / text-notes sections each fail on their
own assertion. The old suites (call-watch, ladder, ledger, away mode, promise
window, text notes, push label rule, watchdog, dead-man) stay green.
