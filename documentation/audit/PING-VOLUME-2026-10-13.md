# Ping volume: one card per person, bell-only low value, one digest per change (2026-10-13)

Jo said "we can do all 10" of the ranked fix list in
[NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13](NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md).
This note is server item **7**, ping volume: audit **F4** (a repeat caller
multiplies pings), **F6** (a quiet week is not quiet; a hang-up number pushes every
run), **F7** (the same promise emailed twice a day), **F8** (Thursday at night and
the duplicate), and the "two pushes at 08:00" item left by
[PROMISE-CHANNEL-AND-PARKED-RULE-2026-10-13](PROMISE-CHANNEL-AND-PARKED-RULE-2026-10-13.md).
Stacked on that branch (PR #2444).

## Before / after (the deterministic volume harness)

`node tests/needs-you-volume-sim-2026-10-13.test.js --table`, same seeds, same
simulated clock, every sender stubbed. "Before" is the harness at the base of
this branch (promise channel included).

| Scenario (Jo ignores everything = the ceiling) | Before | After |
|---|---|---|
| **Repeat caller**: one customer, 6 calls in a day (2 urgent, 2 promise, 2 missed) | day 0: **2** immediate urgent pushes; **7 pushes + 4 emails** for that one person (3 of them ladder emails) | day 0: **1** immediate urgent push; **3 pushes + 1 alert email** (the design: 3 + 1). Re-tells the card folded on day 0 wait and resume on day 1, so the person's busiest day is **4 pushes + 3 emails** (was 7 + 4); 8 pushes over the 4-day run (was 10); never 2 alert emails in a day (4 over the run before). Their brief and 15:15 digest emails are the same as before |
| **Quiet week**: 6 calls + 2 texts a day, 1 promise, 1 urgent in the week | pushes/day max **6** (typ 5); **13 of 35** watch pushes were only about an unknown number / missed call; 36 pushes in the week | pushes/day max **5** (typ 3); **0 of 22** watch pushes are low-value-only; 23 pushes in the week. The 43 bells are unchanged: nothing is dropped from the bell |
| **One unlabelled number hangs up every 20 min**, 3 days | **5 pushes in a day**, 15 in 3 days | **0 pushes**; the number is belled **once a day** (3 in 3 days); the next morning's brief carries ONE line ("(513) 555-0137 called 24 times in the last day (hung up each time) and is not labelled. Not pushed.") and it stays open on Home / the ledger |
| **Same open promise**, never handled, 29 days listed | **57** emails (brief 06:45 + sweep 15:15, every day) | **29** (the brief once a day; the 15:15 sweep only when the list changed) |
| **Thursday call at 22:40, not urgent** | her push + email (+ SMS) at **22:40**, then callWatch pushed it again at 08:00 | **0** pings at night; callWatch tells it at the **08:00** run, once |
| **Thursday call at 22:30, urgent** (active leak, customer in danger) | push + email at 22:30; callWatch repeated it at 08:00 | push + email at 22:30 (unchanged); callWatch does **not** repeat it |
| **Thursday call at 14:10** | her push + email, then callWatch "not reviewed" at 16:00 (3 pings) | her push + email, no repeat (2) |
| **08:00 with an overnight urgent call AND a promise due today** | **2** pushes | **1** push: "1 person needs you · 1 promise due today" (both bells still written) |
| **Storm week** (40 calls, 20 texts, 12 promises, 5 callbacks, 4 Thursday a day) | pushes/day max **19** (7 watch + 8 urgent + 4 Thursday); 126 in the week; worst person **12** (7 push + 5 email); 87 emails (46 ladder) | max **18** (7 + 8 + 3); 117 in the week; worst person **8** (4 push + 4 email: her own push and email count); 79 emails (45 ladder) |

Honest reading of the storm row: **the storm week is arrival-dominated**. Every
2-hour run has a new person, so one watch push per run and one immediate push per
urgent caller remain. This change removes repeats, low-value buzz and duplicates;
it does not lower a day where 40 different people call. If Jo wants the storm
number down, that is a different rule (a storm digest mode), not this one.

## The one rule: the person card

`functions/ping-volume-logic.js` (pure). A person (customer, else the number) has
**one card a day**:

- pushed at most **3 times** (`PERSON_PUSH_DAY_MAX`) plus **one** final sticky rung
  per day, emailed at most **once** (the ladder email), however many calls;
- a **new arrival of a kind of need that person was already pushed about today**
  (a second urgent call, a third promise) is **folded**: it is on the bell, Home,
  the ledger and the brief, and the next re-tell names it ("+1 more call");
- a **new kind** of need (a promise after the urgent push, urgent after a routine
  call) **always pushes**, however full the card is;
- the card is **per ET day and per episode**: once Jo handles anything of that
  person, earlier pushes belong to a closed episode and a new call pushes at once;
- a push that **reached 0 devices does not count** (the next run tries again);
  stamps are written after the send;
- a **re-tell the card folded does not climb a rung** and is not re-belled every run:
  it waits, un-climbed, until the card has room (the next ET day at the latest), so
  the ladder never spends its rungs without telling anybody. A kind with no ladder
  (a known customer's missed call) is capped at the same 3 pushes, not folded.

Kinds: `urgent`, `promise`, `due`, `insurance`, `missed` (a known customer),
`low`, `thursday`, `hidden`. State: `integrations/callWatch.personPings` (callWatch
is its only writer; pruned to today). The immediate urgent push reads the call
rows instead (it cannot share that document: callWatch rewrites it whole).

### Applied where

| Rule | Where |
|---|---|
| **(a) F4** second urgent call of an open urgent person: no new push | `call-center.js pushUrgent`: looks for another open call of the same person (`leadId`, else number), pushed as urgent **today**, not folded, still `callNeedsYou`; stamps the new call `urgentPushedAtMs` = the carrier's time, `urgentFoldedAtMs`, `urgentFoldedInto` so callWatch does not tell it as new and the ladder climbs both calls in step. A failed sibling read pushes as before (a warn says why). |
| **(a)** repeat re-tells / new arrivals at the watch | `call-watch.js` + `planPush`: the push names only the people who **earned** it; the bell lists everyone from the run |
| **(a)** one ladder email per person per day | `call-watch.js`: `mailRetells` skips a person stamped `emailedYmd` today. The F2 "phone did not get it" email keeps its own once-per-item rule (an outage, and a changed set may mail again) |
| **(b) F6** low-value-only runs | `planPush`: `low` items stay on the bell, never push. A run with nothing else and no pipeline problem is `bellOnly` (counted in the run result) |
| **(b)** one bell per number per day | `lowBellYmd`; the number's later items the same day are dropped from the alert (still open everywhere else) |
| **(b)** the summary line | `gatherSweepWithPromises` adds `quietLines` (unlabelled numbers with 2+ open unknown / missed calls in 36 h); the 06:45 brief ("Repeat unknown numbers") and the 15:15 email render it; a failed read prints "Could not check repeated unknown-number calls just now." |
| **(c) F7** digest once per change | `integrations/digestSig` `{ ymd, sig, n, atMs, by }`: the brief stamps what it listed, the 15:15 sweep skips when `digestSig(items)` equals today's stamp. A list with the "could not check" warning is never stamped and always sent; a failed signature read sends |
| **(d) F8** Thursday quiet hours | `thursday.js notifyAll`: non-urgent `email` / `push` / `sms` are `held:quiet-hours` from 21:00 to 07:59 ET; `route.urgent` (her emergency path) is never held |
| **(d)** no repeat of a delivered call | `call-watch-logic.js newNeeds`: a Thursday row whose `notifyState.push` was sent is not told again; a row whose push failed, was skipped or was held still is |
| **(e)** one push at 08:00 | `call-watch.js`: alert + promise push in one run = one push (`mergePush`), clickUrl Home; both bells kept; one result drives both "reached" flags |

## Never dropped (what each fold leaves behind)

| Folded / held thing | Still reaches Jo through |
|---|---|
| second urgent call (folded) | Home strip + Call Center (the person is one row), the carrier's re-tell text "+1 more call", rung-3 email, brief/sweep (36 h urgent window), ledger count |
| repeat same-kind arrival at the watch | its bell, Home, the ledger, the next brief |
| unknown number / missed call, no customer | its first bell of the day, Home, the 20:00 ledger, the repeat-number line in the brief |
| held Thursday call at night | callWatch's **08:00** run (bell + push), the Thursday inbox in the Call Center |
| 15:15 sweep skipped | the 06:45 brief that listed the same thing (and Today, Home) |
| promise-channel promise folded into a person card | its bell (always written), the brief row, the ledger, the ladder entry (marked told) |

## Tests

- `tests/ping-volume-2026-10-13.test.js` (88 checks, CI node bucket): kinds, the
  card (fold / new kind / re-tell / sticky once / immediate push counted / handled
  starts fresh), `applyRun` (an unreached push counts for nothing), digest
  signature, Thursday hold at 21:00 / 22:00 / 23:00 / 00:00 / 03:00 / 07:59 vs
  08:00 / 12:00 / 20:59 and the urgent exception on the real `notifyAll`,
  `runWatch` end to end (bell-only, merged push incl. the unreached case, one
  ladder email a day), `pushUrgent` fold with 6 controls, `runSweep` dedupe with 4
  controls, the brief's stamp and summary line. **Every absence assertion has a
  presence control** built from the same fixture with one field changed.
- Harness scenarios B / C / D / H / I / J / Q + invariants (no watch run sends two
  pushes; nobody is pushed more than 5 times a day in any scenario).
- Break-tested: 22 one-line mutations, the last 7 after the review round (a held re-tell still climbing, a folded call never told when its carrier leaves, the Thursday hold ignoring the flag, a bell-only run overwriting lastPush, no-ladder kinds folded to nothing, every low number marked belled, a held re-tell re-belled every run) plus the first 15 (low-value push-worthy, no fold, no new-kind
  exemption, an unreached push counted, pushUrgent never folds, Thursday never held
  / emergency held too, sweep never deduped / stamp missing / brief stamp missing,
  callWatch repeats Thursday, no merge, no once-a-day email, low number belled every
  run, handled person keeps the old card) each turned a NAMED check red.
- Existing suites updated for the new, intended behaviour (not weakened):
  `needs-you-lifecycle-fixes` (an unknown number is now bell-only; the promise
  push is the first push), `push-urgent-label-rule` (the sibling read also warns),
  `thursday-pipeline.integration` (a night run may read `held:quiet-hours` where it
  read `skipped`).

## Review round (silent-failure hunter, same day) - fixed before the PR

| Finding | Fix |
|---|---|
| Re-tells the card suppressed still advanced their rung, so a call could reach rung 3 having told nobody | `carriedRetells`: only a re-tell whose person was named by a push that reached (or whose email went) climbs; the rest hold and are not re-belled |
| A folded urgent call had no surface of its own if its carrier was handled / snoozed 20 minutes later (first re-tell up to 2 h on) | `newNeeds` `carrierGone`: told once as news (`#carrier`) the run after its carrier leaves the list |
| Thursday's night hold assumed callWatch was live | held only when `CALL_WATCH_ENABLED === 'true'` |
| A bell-only run overwrote `lastPush`, hiding "the last alert reached 0 phones" from the 20:00 ledger | `lastPush` is written only by a run that buzzed |
| "Folded into the next re-tell" was untrue for kinds with no ladder (a known customer's missed call, a hidden number back) | those kinds are capped at 3 pushes a day, not folded to nothing |
| `lowBellYmd` was set for numbers past the bell's 5-line cap | only the 5 the bell names are marked belled |
| Comment on the fold-stamp failure said "never silent" while the push may fold | comment corrected (the bell is the surface) |

Not changed, said here so nobody finds it later:

- **A repeat-number summary rides only with another brief / sweep** (a day with no
  promise and nothing else does not email just for a robocaller); the 20:00 ledger
  counts the open number and Home keeps it. A list that is unchanged but whose
  repeat count grew does not re-mail at 15:15 (the brief carries the new count next
  morning). The "could not check repeated numbers" line is advisory and also rides
  only with another section; the failed read is logged.
- **A held Thursday call from a number Jo hid / quieted, or parked**, is told by
  nothing in the morning (callWatch's Thursday block drops those by the same label
  rule as before; her own push used to ignore labels). That matches the label's
  meaning; say so if her night calls should break through a quiet label.
- A Thursday call whose own push was delivered leaves no callWatch bell or ledger
  line (by design: "not told twice"); a push nobody saw has no backup but her email
  and the Thursday inbox.

## Left / decisions for Jo

1. **A new lead who rings from an unknown number is now bell-only.** Jo asked for
   "unknown-number / missed-call only, no promise, no urgent, no known customer" to
   be bell-only, and that is literally what ships. A *noted* call the AI calls a
   `lead` (callType `lead`) is still just "unknown number". If you want a single
   push for a prospective new customer, it is one line in `kindOf` (treat a
   `noted` unknown call with `callType: 'lead'` as `other`); it would put about a
   third of the quiet-week unknown-number buzz back.
2. **A held Thursday call's email is not sent later.** Her email, push and SMS are
   all held at night; callWatch's 08:00 bell + push carries the call and the Thursday
   inbox has the detail, but the email itself never goes. Releasing the held email at
   08:00 is a small follow-up if you would rather have it.
3. **The numbers**: 3 pushes + 1 sticky + 1 email per person per day, one bell per
   unlabelled number per day. `PERSON_PUSH_DAY_MAX` is one constant.
4. **Digest**: the brief still goes every day an item is open (that is the daily
   reminder); only the same-day 15:15 repeat is dropped. "Once per change across
   days" would make a week-old promise go silent after its first email, which is the
   F7 option C trade-off, so it was not done.
5. **A folded urgent call writes no bell of its own** (the person's earlier urgent
   bell and Home row are the record). Say so if you want one bell per call.
6. **Attentive-Jo sim**: people who only ever reached the bell (low value, folded
   repeats) are never "seen" by the model's push-driven Jo, so `open@end` for the
   attentive storm week reads 26 instead of 7. They are still on Home, the ledger
   and the brief; a real Jo opening Home is not modelled.

## Not run / unverified

- No emulator suite was run here (`thursday-pipeline.integration` was edited: one
  regex). No browser, no production data, no real send, no FCM. "Reached" is
  `sent !== 0`, as everywhere else.
- Whether a same-tag replacement push is silent on an installed iPhone web app is
  unverified, which is why the collapse is a **suppression**, not a "replace the
  card" push: it does not depend on it.
- The sibling lookup is two equality filters (`userId` + `leadId` or
  `phoneDigits`), which Firestore serves without a composite index;
  `firestore.indexes.json` is unchanged (`check-firestore-indexes` still reports
  only the existing `sms-functions.js` finding).
