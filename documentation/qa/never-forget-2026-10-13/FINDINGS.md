# Never-forget QA sweep — 2026-10-13

Adversarial audit of the never-forget chain on `main` after #2400: Today
(Promises, Waiting-on-them, labels + suggestions), `callWatch` /
`functions/call-watch-logic.js` and its Home mirror, the re-tell ladder, the
8 pm ledger, `leadAlertWatchdog`, and the pipeline-health callable. Context:
[NEXT_SESSION-2026-10-13](../../projects/NEXT_SESSION-2026-10-13.md) and
[NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12](../../audit/NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12.md).

Items marked **lead** were found by reading and not reproduced — verify
before building on them.

## Verified clean

- **The two rule copies agree.** `callNeedsYou` in
  `functions/call-watch-logic.js` vs `docs/pro/js/home-attention.js`: 0
  differences over 200,000 fuzzed rows, 0 over 20,000 `resurfacedNumbers`
  cases. Bugs below are in what each side is *fed*, not in the rule.
- No missing composite index across call-watch, away-mode, pipeline-health,
  dead-man, promise-cleanup and the watchdog.
- Hour-24 / ET / quiet-hours handling is sound.

## Fixed in the PR that carries this note

1. **8 pm ledger false-green.** A hidden number that came back (3+ calls in
   24 h) is a person on Home, but the ledger said "nothing fell through". The
   ledger now counts it.
2. **Re-noted text day swallowed.** `textInboxNotes` re-writes the same doc
   id and `toldIds` dropped the escalation (10:00 "who is this" told, 15:00
   urgent never told). A text day is now told once per reason.
3. **Cross-tenant forged `taskDone`** (`mirrorCallTask`). Any signed-in user
   could tick a task named `sms-txt_<digits>_<ymd>` on their own lead and mark
   Jo's unfiled text day kept. The task's lead must now belong to the call's
   tenant.
4. **`labelFor` regex.** `/D/g` stripped the letter D, not non-digits; the
   urgent-push label lookup would miss any formatted number (latent).
5. **Twilio delivery GET had no timeout.** A hung socket could eat the whole
   120 s run before an alert was written.

Each fix has a check that reddens when the fix is reverted.

## Open findings, ranked

### High

- **H1 (verified).** A handled text day swallows every later text from that
  number the same day: `text-inbox.js:189,211` re-notes the doc but never
  clears `handledAtMs`.
- **H2 (verified).** The 45-day promise window exists only on the client.
  callWatch, the ledger and away mode read 14 days, so a 20-day-old promise
  shows on Home while the ledger says clear. A fix must also keep Jo's own
  reply from reopening the row.
- **H3 (lead).** A call-riding `c.promise` on an unfiled call is invisible
  after day 14 everywhere except Today.
- **H4 (lead).** A promise saved from a call's sheet is not on Today until a
  leads refresh.

### Medium

- A promise stamped kept still nags for 14 days.
- A snoozed item is never re-told when its snooze ends.
- `thursday_calls` is read with `.limit(300)` and no `orderBy`.
- `handled` keys collide between the Calls row and the Promise row.
- A texted promise past 45 days appears nowhere.
- Home reads by row cap (200 calls) rather than by date.
- The Call Center hides failed reads.
- Away mode ignores labels.
- Dead-man gaps; the watchdog claims a lead before re-sending.
- Waiting items ripen without regard to the "Nudge me on" date.

### Security, outside the chain (leads from the independent review)

- **S1, high, unverified.** Any signed-in tenant may be able to make NBD's
  Resend/Twilio send alerts to arbitrary recipients via `leadAlertCalcom`.
  Needs an emulator reproduction before anyone fixes it (never POST the
  emulator gateway with alerts on — it sends real SMS/email).
- Former-owner uid branch in the label / away rules after an ownership
  hand-off.
- Label `ackAtMs` is unbounded: a huge value permanently disables "hidden
  number came back" for that number.

## Update 2026-10-13 (client lane)

The client-side open findings (H4, Home reads by row cap, the Call Center and
Today hiding failed reads, Waiting ripening without the Nudge date, Waiting
counting tasks not people, the `handled` key collision) were each reproduced
with a failing test and fixed — see
[NEVER-FORGET-CLIENT-FINDINGS-2026-10-13](../../audit/NEVER-FORGET-CLIENT-FINDINGS-2026-10-13.md).
"Kept it" on a texted day surviving a re-note is the server lane's fix (verified
there; the client has no write path). The "Not run" list below is the original
sweep's; the emulator Playwright pass for the client items ran 390 x 844.

## Not run

Playwright / authed E2E, the Thursday integration suites, a live browser
pass, anything against production data.
