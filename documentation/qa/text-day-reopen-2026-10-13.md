# Handled text day re-opens on a new inbound text (QA H1, 2026-10-13)

Finding H1 of the never-forget sweep (PR #2404,
`documentation/qa/never-forget-2026-10-13/FINDINGS.md` once it lands):
a text day Jo marked Handled swallowed every later text from that number the
same day.

## Cause

`textInboxNotes` (`runTextNotes` in `functions/text-inbox.js`) re-notes a
conversation-day whenever its signature changes, writing the same
`phone_text_days/txt_<digits>_<ymd>` doc with `{ merge: true }`. The write
never touched `handledAtMs`, so the stamp from the morning's Handled tick
survived the 3 pm re-note. Every reader (`callNeedsYou` in
`functions/call-watch-logic.js`, `docs/pro/js/home-attention.js`, the 8 pm
ledger, away mode) tests `c.handledAtMs`, so all of them went quiet together.

## Fix

`reopenPatch(prev, day, nowMs)` in `functions/text-inbox-logic.js`: when the
existing day doc has `handledAtMs` and the regrouped day holds an
**inbound** message sent **strictly after** that stamp, the re-note also
writes `handledAtMs: null, handledBy: null, reopenedAtMs: <now>`.

Left handled on purpose:

- Jo's own outbound reply (it changes the signature and re-notes the day, so
  the summary stays current, but he is the one who just answered).
- An inbound text that predates the stamp (he had seen it).
- Send-status rows. The SMS backup parser keeps only `type` 1 (received) and
  2 (sent); draft / outbox / failed / queued rows never become `phone_texts`,
  so no delivery echo can change a day's signature.

Whether the re-opened day then *shows* is still the shared rule's decision on
the new note (urgent, a promise from Jo, a due follow-up, unknown number). A
filed customer replying "thanks" clears the stamp and stays off the list.

## Counting

Callers and the ledger key people by `callerKey` (lead, else last 10 digits),
so a re-opened text day plus an open call from the same number is one person.

## Evidence

`tests/text-day-reopen-2026-10-13.test.js` (20 checks, in `ci-manifest.json`).
Failed 5 of the first 7 checks before the fix. Break-tests, each reddening a
different assertion set: neuter the helper (7 re-open checks), accept any
direction (outbound-stays-handled + helper), ignore the stamp time
(predates-stamp + at-the-stamp), stop calling the helper from `runTextNotes`
(the 7 end-to-end re-open checks, helper unit checks stay green).

## Not covered

- A day Jo closed by *ticking its follow-up task* (`taskDone: true`) is a
  different state and is still not re-opened by a later inbound text.
- A day filed as a promise via the Promise button (`promiseTaskId` set) is
  re-opened like any handled day; the promise task is tracked separately and
  the person still counts once.
- Re-opening waits for the 2 h quiet window plus the hourly notes run, so a
  new text can take up to ~3 h to reach the list.
- Clearing `handledAtMs` removes that day's "handled" event from the
  gamification feed (`game-logic.js`); re-handling it earns it again.
