# "Never forget anything" reliability audit — 2026-10-12

*Reliability lane, requested by Jo: "the calls and 2-hour reminders along with
Thursday and automations and suggestions, I feel so secure in not forgetting
things. We should seriously put in some work on making this system extremely
robust." Scope: the whole chain from a recorded call to a thing Jo sees and
acts on. Every claim below is read from committed code (file:line on `main`
at 94e9ed3b); anything that needs the live project is marked **unverified**.
Companion: [CALL-CENTER-2026-10-01](../architecture/CALL-CENTER-2026-10-01.md),
[HEALTHCHECKS-SETUP](../runbooks/HEALTHCHECKS-SETUP.md),
[FIRESTORE-INDEX-COVERAGE](../runbooks/FIRESTORE-INDEX-COVERAGE.md),
[TWILIO-A2P-REGISTRATION](../runbooks/TWILIO-A2P-REGISTRATION.md).*

## 0. The finding in one paragraph

The chain is well built for **catching things** and weak at **making sure Jo
saw them**. Every hop writes a record; almost no hop checks that a human
received it. The reminder Jo thinks of as "every 2 hours" is a **one-shot**:
each person is pushed once, then never again unless a brand-new call arrives.
The push result is ignored, the thing that watches the pipeline is itself
watched by nothing independent, and the Home counter renders a failed read as
"nothing needs you". None of these is a bug in the sense of wrong output on a
good day; each is a way a good day becomes a bad day silently.

## 1. The chain, hop by hop

| # | Hop | Code | Trigger | Writes |
|---|---|---|---|---|
| 1 | Cube ACR app on the phone uploads recordings | (external) | phone | Drive folder "Cube ACR" |
| 2 | **callCenterIngest** copies new recordings, matches lead by phone, buckets | `functions/call-center.js:~185` (`runIngest`) | every 30 min | `phone_calls/cube_*` (`status:'stored'`), `integrations/callCenter` (`lastRunAtMs`, cursor) |
| 3 | **callCenterTranscribe** Groq transcript + Haiku notes (promises, urgent, followUpDate, callType) | `call-center.js:~430` (`runTranscribe`) | every 30 min | `phone_calls` → `noted`/`personal`; `leads/*/tasks/cube-*`; `leads/*/activity/cube-*` |
| 3a | Urgent call → immediate push + bell | `call-center.js:299` (`pushUrgent`) | inside hop 3, 8–20 ET only | `urgentPushedAtMs`, `notifications` |
| 4 | **textInboxIngest / textInboxNotes** (texts) | `functions/text-inbox.js` | 30 min / 60 min | `phone_texts`, `phone_text_days`. **Dark** (see R8) |
| 5 | Actions: handled / unhandled / taskDone / snooze / attach / move / notpersonal | `call-center.js:847-` (`callAction`) | Jo taps | `handledAtMs`, `taskDone`, `snoozeUntilYmd`, `leadId` |
| 6 | Task tick mirror | `call-center.js:~962` (`onCallTaskWrite`) | Firestore trigger | `taskDone` on the call |
| 7 | "Needs you" rule (people, not calls) | `docs/pro/js/home-attention.js:100` `callNeedsYou`; server mirror `functions/call-watch-logic.js:51` | on Home render / callWatch run | none (read-only) |
| 8 | Home strip, Today list | `home-attention.js` `count()`; `today-home.js`; `today-plan.js` | Home open, 60 s throttle | none |
| 9 | **callWatch** 2-hourly alert | `functions/call-watch.js:63` (`runWatch`) | cron `0 8-20/2 * * *` ET | `notifications` (bell), push, `integrations/callWatch` |
| 10 | Push (FCM) | `functions/push-functions.js:128` (`sendPushNotification`) | called by 3a, 9 | `users/*/fcmTokens` pruned on rot |
| 11 | **callCenterSweep** "you said you'd…" email | `call-center.js:~637` | 07:15 / 15:15 ET (07:15 rides the 06:45 morning brief) | Resend email |
| 12 | **Thursday** (Bland) receptionist | `functions/integrations/thursday.js`, `thursday-logic.js` (`CALLER_TYPES`, `decideRoute`) | Bland webhook → Firestore trigger | `thursday_calls`, lead/task, email + push + Bland SMS (`notifyState`) |
| 13 | New-lead alerts + watchdog | `functions/lead-alert.js`, `lead-alert-watchdog.js` | lead-create triggers; every 10 min | `alert_outbox` (+ `smsDelivery`) |
| 14 | Follow-up rules | `lead-followup.js` (`leadFollowUpSweep`), `onFollowUpDue` push | cron | follow-up nudges |
| 15 | Agent inbox / suggestions | `functions/agent-mcp.js`; `suggestionPatch` (call-center.js) | bots / transcribe | inbox notes, "Looks like X" |
| 16 | Per-number labels (PR #2370, not yet on `main`) | `contact-labels-logic.js` on branch `feat/contact-labels-p1` | Jo labels a number | `contact_labels` |
| 17 | Cron liveness | `functions/integrations/heartbeat.js`, `heartbeat-plan.js` | every scheduled run | Healthchecks.io ping |

Settings that decide whether hops run at all (committed
`functions/.env.nobigdeal-pro`): `CALL_CENTER_INGEST_ENABLED`,
`CALL_CENTER_TRANSCRIBE_ENABLED`, `CALL_CENTER_SWEEP_ENABLED`,
`CALL_WATCH_ENABLED`, `MORNING_BRIEF_ABSORB_ENABLED`, `PROMISE_CLEANUP_ENABLED`
are all `true`. `TEXT_INBOX_ENABLED` and `TEXT_NOTES_ENABLED` are **absent**.

## 2. Failure-mode table

Severity = what is lost if it fires (H = a customer or promise never reaches
Jo, M = delayed or degraded, L = noise). Likelihood = how plausibly it fires
in a normal month. Risk number is the rank in section 5.

| # | Hop | How it drops or delays something | Evidence | Sev | Lik | Today's cover |
|---|---|---|---|---|---|---|
| R1 | 9 callWatch | **One-shot.** An item is told once; the next run only sees items newer than the last check. An unacknowledged urgent/promise is never re-pushed. | `call-watch-logic.js:101` (`arrived <= sinceMs` → skip); `call-watch.js:94,126` (`toldIds`) | H | H | Home count if Jo opens the app; 07:15/15:15 email for *noted* calls |
| R2 | 10 push | **Push result ignored.** `sendPushNotification` returns `{sent:0}` for "no tokens" or all-failed; callWatch and pushUrgent never read it. `urgentPushedAtMs` is stamped even at `sent:0`, and callWatch then skips that call as "already told". | `push-functions.js:137-140,243-245`; `call-watch.js:132`; `call-center.js:306-307`; `call-watch-logic.js:104`. Contrast `lead-alert.js:364` which does check `r.sent > 0` | H | M | Bell entry only (needs the app open) |
| R3 | 17 / 9 | **Nothing independent watches callWatch.** It shares check `call-followups` with `callCenterSweep` (12 h period): the sweep's 07:15/15:15 pings keep it green while callWatch is dead. A dry-run callWatch (gate unset) also pings success. | `heartbeat-plan.js:52,83-84`; `call-watch.js:110,139-155` | H | L-M | `HEALTHCHECKS_PING_KEY` + checks existing is **unverified** |
| R4 | 2/3/11 | **Jobs swallow their own failures.** Ingest, transcribe and sweep catch and `logger.warn` (not `error`, which the heartbeat counts); the run "succeeds". The shared `calls-texts-ingest` check is also fed every 10 min by `leadAlertWatchdog`, so a dead ingest never reddens it. Only callWatch's `pipelineProblems` notices (hop 9), which is R3's single point of failure. | `call-center.js:209,583,675`; `heartbeat-plan.js:75-78`; `heartbeat.js:144-150` | H | M | callWatch `ingest_stale` / `transcribe_stale` / `transcripts_behind` (`call-watch-logic.js:128-160`) |
| R5 | 8 Home | **A failed read renders as zero.** Both phone queries end `.catch(() => {})`; a missing index, rules/App Check denial, or offline read leaves `callRows` empty → "0 people need you" → the strip is hidden. `limit(200)` / `limit(100)` truncate silently. | `home-attention.js:194-197,238-246` (`el.hidden = !html`) | H | L | Indexes are in `firestore.indexes.json` and deployed with each merge (`firebase-deploy.yml:605`); live state **unverified** |
| R6 | 7 | **14-day window.** A call older than 14 days is never "needs you", whatever promise it carries. A no-customer call has no task either, so a promise or a far-future `followUpDate` expires silently. | `home-attention.js:67,99`; `call-watch-logic.js:23,55`; `call-center-logic.js` `collectSweepItems` (`TASK_WINDOW_MS`) | M | M | Lead tasks (customer calls only) |
| R7 | 9 | **A follow-up date arriving later is not pushed.** `followUpDate <= today` counts, but `newNeeds` only admits items that *arrived* after the last check, so "call back Friday" is never pushed on Friday. | `call-watch-logic.js:62,101` | M | H | Home count; morning brief / sweep `due` rows |
| R8 | 4 | **Texts are dark.** `TEXT_INBOX_ENABLED` / `TEXT_NOTES_ENABLED` are not in the committed env, so texted promises are never captured and `callWatch` skips the texts-stale check (`textNotes:false`). Also `cron-gates.js` lists `LEAD_FOLLOWUP_ENABLED` as default-off while `lead-followup.js:93` is default-on (health digest table misreports). | `.env.nobigdeal-pro`; `text-inbox.js:41,166`; `call-watch.js:98`; `cron-gates.js:25` | M | certain | none; by design until Jo flips it |
| R9 | 3/7 | **AI miss = no signal.** A call on a known customer needs Jo only through urgent / a `who:'jo'` promise / a due date the *model* extracted (`if (c.leadId) return false`). No manual "I promised something" capture. A call that fails 3 transcribe strikes stays `stored` (counted in `transcripts_behind`, never a needs-you row). A call the model labels `spam`/`personal` is excluded for good. | `home-attention.js:99-104,126`; `call-center-logic.js:317-318` | M | M | `transcripts_behind` alert; "not personal" undo |
| R10 | 16 | **Label `hide` beats urgent and promise.** In PR #2370 `if (pol === 'hide') return false` runs before the `urgent`/`promised` tests, and only Home applies labels (callWatch mirror does not), so Home and the 2-hourly alert diverge. A masked/proxy number labelled "hide" can swallow several different customers. | branch `feat/contact-labels-p1`, `home-attention.js` `callNeedsYou` hunk | M | L-M | `hiddenPeople` count is shown; label failure falls back to the old rule (safe direction) |
| R11 | 3a / 9 | **Quiet hours.** An urgent call after 20:00 ET is held to the 08:00 run (up to ~11 h). By design (`inWatchHours`), but a leak at 9 pm is the case Jo most wants. | `call-center.js:300-301`; `call-watch-logic.js:247-250` | M | M | none |
| R12 | 12 Thursday | Webhook that **never arrives** (Bland down, signature drift) leaves no row, so nothing alerts; there is no reconcile against Bland's call list. `spam`/`silent`/`test` are `log_only` + `reviewed:true`, never notified, so a mis-typed real caller is quiet. Notify channels are recorded in `notifyState` but nothing reads them for a missing success. | `thursday-logic.js:56-58,668-694`; `thursday.js:405-425` | M | L | stuck/failed Thursday calls in callWatch problems; extraction failure still emails (`thursday.js:505-515`) |
| R13 | 9 | callWatch's Thursday read is `where companyId == OWNER .limit(300)` with **no orderBy**; past 300 rows the *recent* ones are not guaranteed. `status == 'stored'` read caps at 200. | `call-watch.js:78-79` | M | L | none |
| R14 | 13 SMS | Twilio is a **trial / unregistered (30034, 21608)**: texts accepted, never delivered. | `call-watch-logic.js:168-210`; `lead-alert.js:362-385` | M | certain (until A2P) | `smsDelivery` stamped from Twilio; `sms_undelivered` problem; red banner; watchdog treats only email/push `sent` or `delivered` as reached. Residual: callWatch never texts at all |
| R15 | 5 | **"Handled" is one tap per person and clears a stated promise** (it sets `handledAtMs`, which beats `promised`); "snooze" on a no-task call only parks it in the sweep, Home still counts it (noise, not loss). A deleted lead task counts as "kept". | `call-center.js:847-850,977` ; `call-watch-logic.js:53` | M | M | the lead task (if one exists) stays on Today |
| R16 | 10 | FCM `successCount>0` means *accepted*, not shown: a phone with notifications off, or a tab nobody opens, counts as reached. Token rot is pruned only after a failure. | `push-functions.js:194-223` | M | M | none beyond R2 |
| R17 | all | Time zones: server uses `America/New_York` consistently; Home's `startOfDay` is device-local. Harmless while Jo's phone is on Eastern; wrong on a trip. | `home-attention.js:55` vs `:68` | L | L | — |
| R18 | 13/9 | Health surfaces fail quiet by design (`alert-health-banner.js` "renders nothing" on any error) — the watcher of the alerts can be dark without saying so. | `alert-health-banner.js:21-24,119-124` | L | L | — |

## 3. What already protects us (keep it)

- **Pipeline-health problems** in callWatch: ingest stale (>75 min), transcribe
  stale, transcripts waiting >6 h (names the daily cap), texts stale, Thursday
  stuck >30 min / failed, `sms_undelivered` from Twilio's own verdicts
  (`call-watch-logic.js:128-210`). Standing problems repeat at most every 6 h.
- **Ingest resilience**: newest 3 day-folders first, too-large files skipped
  not retried, cursor advances only past fully filed days, 40 files a run
  (`call-center.js:36-47`, `:170-190`).
- **Idempotency**: deterministic ids (`cube_<driveId>`, `cube-<callId>` task
  via `create()`), so re-runs never duplicate or un-tick.
- **People, not calls** on every surface (`callerKey`), shared rule between
  Home, Call Center and callWatch (a test runs both on the same rows).
- **Lead-alert watchdog** (`lead-alert-watchdog.js`): alerts on a *missing
  success*, re-sends by email + push once per lead, fails the heartbeat if the
  re-send also reaches nobody. The model every other hop should copy.
- **Heartbeat wrapper** counts `logger.error` during a run and pings `/fail`
  (`heartbeat.js:141-190`); `tests/cron-heartbeat.test.js` pins plan ↔ crons.
- **Urgent immediate push** + bell, once per call (`urgentPushedAtMs`).
- **Nightly promise cleanup** only marks kept on quoted later evidence.
- Index coverage test pins prod queries to `firestore.indexes.json`
  (`tests/firestore-index-coverage-2026-10-04.test.js`).

## 4. Gaps that need adding (ranked in section 5)

1. **Independent dead-man for the watcher.** Something other than callWatch
   must say "callWatch (or ingest) has not run". → *built in this lane*.
2. **Delivery truth for the call alerts.** A push that reached 0 devices must
   not count as told, and must fail loudly. → *built in this lane*.
3. **Read failures must not look like zero** on Home. → *built in this lane*.
4. **Escalation ladder** for an unacknowledged urgent / Jo-promise: push →
   +2 h push → +4 h email (Resend, internal) → next morning's brief at the
   top. Needs an "acknowledged" signal (opened the card, handled, or a
   notification-click write from the service worker).
5. **Daily "nothing fell through" ledger** at ~20:30 ET: recordings seen vs
   noted vs open vs handled, items older than N days still open, a zero-calls
   day flagged as an anomaly (a quiet phone is also what a dead ingest looks
   like). Email + a doc Jo can open.
6. **Canaries**: each morning, assert ingest ran in the last hour, the newest
   recording is < N h old, and a synthetic `phone_calls` fixture classifies
   into "needs you" by the same rule (catches rule drift between Home and
   callWatch the way the existing test does for code, but live).
7. **Health panel** in the CRM (one card, green/amber/red): last ingest,
   last transcribe, last callWatch, push tokens on file + last delivered,
   SMS delivery rate, unreviewed Thursday calls, open people > 2 days.
8. **Manual "I promised" capture** on any call card (one tap → creates the
   task) so an AI miss (R9) is a 5-second fix, not a permanent hole.
9. **Make promises not expire**: an open Jo-promise stays "needs you" past 14
   days until handled (R6), and a due `followUpDate` is re-told on its day
   (R7).
10. **Thursday reconcile**: nightly compare Bland's own call list to
    `thursday_calls`; alert on a call Bland took that we never stored (R12).

## 5. Ranked: silent-loss risk × likelihood

1. **R1 one-shot alert, no escalation** — every unacknowledged item.
2. **R2 push result ignored** — an urgent call "told" to nobody.
3. **R3 nothing independent watches callWatch** — the whole safety net can be off.
4. **R4 jobs swallow failures; shared checks stay green** — ingest can die quietly.
5. **R5 failed read renders as zero** — Home says all clear.
6. **R7 follow-up day never pushed** — every dated promise.
7. **R6 14-day expiry** — promises with no customer fall off the world.
8. **R9 AI miss / 3-strike calls** — no human-visible "unreviewed" bucket.
9. **R8 texts dark** — the promise channel nobody is capturing.
10. **R10 label `hide` over urgent/promise** — before #2370 merges.

R11 (quiet hours) and R12 (Thursday reconcile) are the next two; R11 needs a
decision from Jo, not code.

## 6. Built from this audit (Stage 2)

PR #2372: pipeline dead-man (R3/R4). Further PRs are listed in the session report.

Three independent PRs, each with a test that was reverted-to-fail first.
Links are in the PR list at the top of the session handoff / this branch's PR
body. They address R3 + R4 (pipeline dead-man), R2 (push delivery truth) and
R5 (Home read failure). R1, R6, R7 are the recommended next tranche; they
need Jo's wording decisions (how loud, how often).

## 6b. Leads from an outside pass, checked against our code

A Grok research pass proposed eight patterns. Verified against the tree
(treated as leads, not facts):

| Lead | Verdict in our code | Where it lands |
|---|---|---|
| **Ack-timeout re-trigger** ("got it" must not silence forever) | **True.** `handled` sets `handledAtMs` once and nothing ever clears it except Jo's manual `unhandled` (`call-center.js:847-850`); a call-level "Handled" also beats a stated Jo-promise (`home-attention.js:99`). The alert side is worse: a *push* is never tracked as seen at all (R1, R2, R16). Resolve (task done) and acknowledge (told) are the same bit. | Escalation ladder (this lane): an item stays "open" until handled/done/snoozed-with-date; an unresolved urgent/promise is re-told on a short ladder. Handled stays Jo's explicit resolve. |
| Forced next action on promise capture | Our capture is the model's `promises[]` only (R9). | Lane `feat/promise-capture` (not duplicated here). |
| Delivery-receipt loop on outbound texts | Delivery verdicts exist for *alerts* (`smsDelivery`, `callWatch.deliveryBySid`) but nothing re-surfaces an undelivered *customer* text on Today. Twilio is trial / no A2P, so every customer text is currently undelivered. | Backlog item 3; depends on A2P (Jo). |
| Overdue items rescheduled not deleted, "missed N times" | Snooze moves the date and keeps `snoozedFromDue` (good); no counter. Deleted lead task = "kept" (R15) is the dangerous inverse. | Small follow-up: stop treating a deleted task as kept. |
| Digest that is itself an item until reviewed | Sweep/brief emails are fire-and-forget. | Backlog item 5. |
| Backup person, auto hand-back | Not present. | Lane `feat/away-mode-backup`. |
| Voice/photo promise stamp | Not present. | Lane `feat/promise-capture`. |
| "Waiting on them" badge + nudge | Not present. | Lane `feat/promise-capture`. |

Trap list kept: no multi-level routing for a solo operator (the ladder is
push, second push, email, morning brief — four rungs, no more); nothing
auto-archives (overdue items resurface, they are never dropped); push is
never trusted alone (R2: a second channel or a digest always follows).

### Helper interfaces other lanes can call

- `functions/call-watch-logic.js`: `callNeedsYou(c, now, ctx)`, `callerKey(c)`,
  `newNeeds(...)`, `alertFor(needs, problems, now)` — pure, no I/O.
- `functions/pipeline-deadman.js`: `deadManProblems({watch, cc, now, gates})`
  → `[{key, text, repeatMs}]`; `run({db, nowMs, live, env, notify})`.
  Status lands on `integrations/pipelineHealth` (read it for a health panel).
- `functions/push-functions.js`: `sendCustomNotification(uid, title, body, data)`
  returns `{sent, failed, errors}` — **callers must read `sent`** (R2).

## 6c. Status 2026-10-12 (end of the reliability lane)

Shipped (each with a test shown to fail without it): pipeline dead-man +
36 h no-recording canary (R3/R4), a push that reached 0 devices is not "told"
(R2), Home warns on a failed calls read (R5), short re-tell ladder (R1, with
the label rule), follow-up date pushed on its day (R7), a deleted task is not
"kept" (R15), the 8 PM ledger, the health strip + the daily self-test canary,
the `pushUrgent` label rule, and the 45-day promise window with one "old
promises" review row (R6). Escalation email rung: see the PR list.
How to verify the heartbeat end of this chain: the "Verify the never-forget
chain is actually watched" section of
[HEALTHCHECKS-SETUP](../runbooks/HEALTHCHECKS-SETUP.md).

### Deferred, with exactly what unblocks it: delivery-receipt loop on customer texts

"After an outbound text, if there is no carrier delivery or reply within X
hours, the item reappears on Today as retry-or-call." Not built, because today
it would fire on **every** customer text: Twilio is a trial account and the
number is not A2P registered (30034 / 21608), so 0 of the customer texts the
CRM sends are delivered (`smsProblems`, `alert_outbox.smsDelivery`). It
becomes worth building when, in order:

1. **A2P is approved.** Brand (Low-Volume Standard) and campaign approved in the
   Twilio console - [TWILIO-A2P-REGISTRATION](../runbooks/TWILIO-A2P-REGISTRATION.md);
   the account is upgraded off trial. Observable: a test text to Jo's cell shows
   `delivered` (not `undelivered:30034`) in `alert_outbox.smsDelivery`.
2. **The line is live.** `TWILIO_INBOUND_ENABLED=true` and the number's webhooks
   point at `/api/twilio/*` - [TWILIO-LINE-GO-LIVE](../runbooks/TWILIO-LINE-GO-LIVE.md) -
   so delivery callbacks and customer replies are recorded (the loop's two exits).
3. **Customer sends carry the message id.** The send paths that text customers
   must store `smsSid` on the thing they record (lead alerts already do), so
   `deliveryBySid` can stamp the verdict on the same row.
4. **Then the loop is small**: callWatch already reads Twilio's last-day
   deliveries; an undelivered customer text with no reply after N hours becomes
   a `needs you` item ("text did not arrive: retry or call") under the same
   people-not-calls rule. Until step 1, the existing `sms_undelivered`
   problem and the red banner are the honest signal.

## 7. Questions for Jo

- **Urgent after 8 pm?** Keep "tell me at 8 am", or push urgent calls any hour?
- **Escalation channel** while SMS is blocked: email at +4 h, and is that
  email address the right one (jd@ marketing vs info@)?
- **Healthchecks.io**: is `HEALTHCHECKS_PING_KEY` set and are the 19 checks
  created? The dead-man below ends in a heartbeat `/fail`; it is only as good
  as that email arriving.
- **Label "hide"**: should a hidden number still break through for an urgent
  call or a promise Jo made (recommended, like "quiet")?
- **Promise lifetime**: should a Jo-promise stay open past 14 days?

## Update 2026-10-13 (lifecycle audit)

Re-checked against `main` at 5f1534a8; full write-up in
[NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13](NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md).

- **Live gates.** `MORNING_BRIEF_ENABLED` and `MORNING_BRIEF_ABSORB_ENABLED`
  are now `true` (section 1 above and the `morning-brief.js` header said the
  brief was off). `TEXT_INBOX_ENABLED` / `TEXT_NOTES_ENABLED` and
  `AWAY_MODE_ENABLED` are still absent: texts and away mode are dark.
- **Section 6c's four rungs.** "push, second push, email, morning brief" - the
  brief lists the sweep's items only, so an urgent call on a filed customer with
  no follow-up task is on the ladder and on Home but **not** in the brief or the
  sweep (F5). The ladder email no longer says otherwise.
- **The email rung depends on a reached push** (F2): the rung advances only
  when the previous push reached a device, so with no phone token the email
  never goes. R2's "fail loudly" (the `throw` + heartbeat) is the only cover.
- **R1 / R7 closed, with a seam:** a call told while its transcript was still
  pending used up its tell id (F3, fixed 2026-10-13).
- **Not covered by anything above:** promise tasks created through the sheet
  have no server-side due-day signal (F1).
