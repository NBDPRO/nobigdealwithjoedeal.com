# Handle and opt-out controls audit (2026-10-13)

Jo's ask, verbatim: *"look into the today and people need you to see where any
breaks / issues / fall off / repetition / spam / etc to make sure it flows as
perfectly as possible and option out / handle flows are built to their best
ability as well."* This note is lane **C** of three: the **controls** that let
Jo (or a customer) stop, handle, defer or route things. Lane A is the lifecycle
and volume simulation, lane B the phone UX walk.

Read-only recon at `origin/main` **5f1534a8** (after #2426), plus three small
fixes listed under [Fixed in this PR](#fixed-in-this-pr). Five parallel tracers
each walked one family of controls end to end (client handler, write, every
server and client reader). Every conclusion is labelled:

- **VERIFIED**: run in a vm-sandbox harness against the real function, or
  proven by an exhaustive grep for readers, or covered by a test I ran green.
- **LEAD**: read from code only. Treat as a hypothesis until a harness runs it.

Flags are read from the committed `functions/.env.nobigdeal-pro`; production
may differ. `CALL_WATCH`, `CALL_CENTER_SWEEP`, `MORNING_BRIEF` and
`MORNING_BRIEF_ABSORB` are on. `AWAY_MODE_ENABLED`,
`THURSDAY_LABEL_PLAYBOOKS_ENABLED`, `TEXT_INBOX_ENABLED` and
`TEXT_NOTES_ENABLED` are **absent** (dark / dry-run). Verify those four live
before telling Jo a feature is or is not working (see the memory rule about
INDEX handoff lines being snapshots).

## The answer in one screen

1. **No P0 in the customer-facing opt-out lane.** Every Twilio send path and
   every Resend path is classified and gated; a STOP is global per number,
   last-10-digit keyed, has no TTL, and survives lead deletion, merge and
   re-import (VERIFIED, stubbed harness over seven phone formats and two
   companies). The weak points are *where consent is checked* and *texts that
   leave from Jo's own phone*, not the gate.
2. **The owner-side "option out" is the weakest control family.** Settings →
   Notifications is read by four client generators and nothing on the server;
   `users/{uid}.notificationPrefs` has no writer at all; Away mode reads as
   cover while the notify tick is dark. A control that does nothing is worse
   than no control (C-2, C-3).
3. **The newest "handle" feature defeats the oldest promise.** A promise
   captured through the new Handled sheet moves the call to `handled` and
   puts the debt on a lead task that **no server job reads**. No push, no
   ladder rung, no sweep line, no ledger count. It lives only where Jo is
   already looking (C-1).
4. **"Snooze" is five mechanisms and each surface honours a different
   subset.** The strip, Call Center list, ledger, 15:15 sweep and away cover
   list still count a call Today shows as parked (C-5).
5. **A label can hide a real customer.** Capture-off, hide and quiet each
   have a path where a number that is (or becomes) a customer is silent, and
   nothing reconciles labels with leads (C-4).
6. Three small, clearly-wrong behaviours are fixed here, each failing-first
   (review "Don't ask this one", snoozed lead emailed "we haven't connected",
   four STOP phrasings that went to the AI draft step).

## 1. Control inventory (the matrix)

Columns: **Promise** = what the label or copy says. **Actually** = what the
code does. **Scope**, **Lasts**, **Undo**, **Does NOT stop**, **Audit**,
**Roles**. Evidence is `file:line` at 5f1534a8.

### 1a. Call and text level (Today, Home "needs you", Call Center)

| Control | Promise vs actually | Scope | Lasts | Undo | Does NOT stop | Audit | Roles |
|---|---|---|---|---|---|---|---|
| **Handled** on a Today call row (`today-home.js:276,527`) | Opens the promise sheet first; "Nothing owed" runs `callCenterAction handled` on every call id **open at paint time** (`promise-ui.js:406-420`). A saved promise runs `promise` on the first id, `handled` on the rest. | One person's open calls | `handledAtMs`, permanent until a *new* call or text | Call Center card "Not handled" only; none on Today | The lead's `cube-`/`sms-` task; a snoozed or task-future call of the same person (stays open, so the strip still counts the person, VERIFIED) | `handledBy`/`handledAtMs` overwritten; no history | viewer refused client + server (`call-center.js:909`); rep own calls; manager/company_admin company calls |
| **Handled / Not handled / Handled (all N)** Call Center card and deck (`call-center-view.js:289,326,390`) | Same action; group button is N sequential callables | Person's needs-you ids | as above | Per-call "Not handled"; deck swipe has Undo | partial failure leaves half done ("k saved, n did not") | same | same |
| **Kept it / Move** on a call-borne promise (`today-home.js:245,265`) | Kept it = `handled` on that **one** call id; Move counts a miss if already past due | One call id | `handledAtMs`, `promise.dueDate` | Move can be re-moved; no un-keep | The person's other open calls | `missCount`, `rescheduleCount` (good); no actor | as above |
| **Kept it / Move / Mark dead / Still waiting / Nudge** on a promise or waiting **task** (`promise-ui.js:121-141,453-482`) | Direct client `updateDoc` on `leads/{id}/tasks/{id}`; Mark dead = `done:true, outcome:'dead'` | One task | permanent | **None**; no confirm on Mark dead | The lead (stays open, falls to No-next-step); Nudge does not move `dueDate` so the row re-offers daily; "Still waiting" count never shown | `completedAt`/`updatedAt` only, no `by`, no reason; rules allow task hard-delete (`firestore.rules:850`) | not viewer; staff |
| **Tomorrow / Done / +1 week** on a Promised row (`today-home.js:311,458-475`) | Singular label, acts on **every due task of that person** incl. ones not shown (`bits.slice(0,3)` at :312) | Person | Task `dueDate`; call `snoozeUntilYmd` (max 30 d server) | None on Today | Strip, Call Center list, ledger, away cover list, sweep (urgent <36 h with a task) | `snoozedFromDue` only | as above |
| **Deck "Later"** (`triage-deck.js:139-143`) | Reorders only | This browser, this uid | localStorage, never expires | right-swipe clears | Everything; not a snooze | none | any |
| **Promise-deck Tomorrow / 3 days / Next week** (`call-center-view.js:808`) | `snooze` days 1/3/7 per item | Item | Firestore; wakes at the next 8-20 run | Deck Undo = `unsnooze` | same leak list as Tomorrow | none | not viewer |
| **Keep hidden** (`today-home.js:276,602`) | Rewrites the **number's label** with `ackAtMs = Date.now()` (client clock) | Number, tenant-wide | A baseline, not forever: the next call on a lead-matched or 3x/24 h number resurfaces it | **None** (`ack()` bypasses the undo bar) | n/a | `updatedBy`, no `ackBy` | owner, company_admin, manager (`firestore.rules:2511`); rep, viewer denied |
| **Let Thursday handle this number** (`thursday-handled.js:114-148`) | Writes `thursday_handled/{digits}`; Today shows a quiet recap | Number, tenant | permanent | "Take back" | **callWatch, away, ledger and sweep never read this doc**, so the per-call "Thursday took it" push still fires (VERIFIED, grep: only `thursday.js` and playbooks read it). Dark today. | `updatedBy` | owner + staff |
| **Reviewed / Mark all reviewed** (Thursday) | `thursdayCallAction mark_reviewed` | Call | `reviewed:true` | Server `mark_unreviewed` exists, **no UI** | The CRM task/lead `applyRoute` created for that call | `reviewedBy` | not viewer |
| **Ladder + email rung** (`call-watch-logic.js:413-448,531`) | Push at 0, +100 min, next run, then one email to Jo | Per item; email deduped per person | Dropped when the item leaves `callNeedsYou` or is snoozed | n/a | Missed calls and unknown numbers are told once only | `lastEmail`, `lastPush` | Jo only |
| **07:15 / 15:15 sweep, 06:45 brief** | Lists open "you said you'd" calls with a cube-/sms- task, or no-file promises | Jo's noted calls, 30 d | recomputed each run | n/a | Dated promise TASKS, waiting items, missed calls | none | Jo only |
| **20:00 ledger** | One bell per day, "nothing fell through" | People by `callNeedsYou` + resurfaced + old promises | daily | n/a | Thursday unreviewed, waiting items, dated promise tasks; counts snoozed people as open | `integrations/dailyLedger` | Jo only |
| **36 h no-recording alarm** (`pipeline-deadman.js:41,96`) | Bell + push, repeats every 6 h 08-20 ET | Pipeline | until a recording lands | n/a | n/a, **no ack or "until"**; the only pause is `integrations/callCenter.paused`, which has no writer in the app | `pipelineHealth` | Jo only |

### 1b. Task, lead and customer level

| Control | Promise vs actually | Scope | Lasts | Undo | Does NOT stop | Audit |
|---|---|---|---|---|---|---|
| **Snooze lead** (kanban menu, bell, feed, Hot Leads, Almost There, Stale Shares, cmd+K; `lead-snooze.js:107,291`) | Modal: "hide from the kanban + Hot Leads + Needs Attention". Also silently quiets bell task/stale rows, follow-up notices, estimate follow-ups, smart-followup, score alerts, inbox. **Client-only**: zero `functions/` code reads `snoozedUntil` (grep, VERIFIED) | Whole lead (all jobs) | Preset or custom date at 09:00 device-local, **no maximum** (`:431` rejects only the past) | "Wake up now", unsnooze; no undo toast, no bulk unsnooze | Server crons, Today Stalled + Calls rows, CRM banner/KPI, Home strip, OS overdue-task notification, bots, "they opened it" push, daily needs_field | `snoozeCount`, `snoozedReason`; **no `snoozedBy`/`snoozedAt`** |
| **Snooze N other leads** (`customer-sibling-snooze.js:121`) | Snapshot of currently-open siblings | One-off | as above | one at a time | A future lead for the same customer | none |
| **Push "Snooze 1h"** on newLead (`push-functions.js:105-111`) | Reads "snooze this notification"; hides the **whole lead** for 1 h, `snoozeCount+1`, never re-pings | Lead | 1 h | Wake now | n/a | as above |
| **Push "Snooze 1h"** on appointment / follow-up pushes (`push-functions.js:112-117`) | **Broken**: payloads carry no `leadId` (`:389-398,462-470`); `snooze('')` toasts "Nothing to snooze" (`push-actions.js:85`) | n/a | n/a | n/a | n/a | n/a |
| **followUp date** (Today Stalled +1 week, followup-deck, No-next-step) | "Followed up" records **no contact**; only writes `followUp` and bumps `updatedAt` | Lead | a date | deck undo; Today button none | Notices resume daily after the date | `updatedAt` only |
| **Estimate row Follow up / Fresh link** (`estimate-followups.js:329-336`) | Only exits are send or open; at 10+ days it recurs weekly forever (:93-100) saying "one more time" every time (:179) | Lead | `lastEstimateNudgeAt` | n/a | No "they said no / not now" button | `estimateNudgeCount` |
| **Review deck "Don't ask this one"** (`review-deck.js:85-88`) | `reviewAskDeclined:true`; client engine + deck honoured it, **server review nudge, bell and morning brief did not** | Lead | permanent, no UI to un-decline | none | (was) server nudge. **Fixed in this PR** | none |
| **Bell dismiss / restore / clear** (`notif-bell.js`) | Derived rows: localStorage `nbd_notif_dismissed_v1`, per device, wiped at logout (`nbd-auth.js:788-845`); ids collide (`task:<lead>:<task>` serves due-today and overdue) | Row | per device | Restore drawer | the next occurrence with the same id | none |
| **CRM "N Follow-ups Due" X** (`dashboard-actions.js:222`) | Code comment says "session dismiss"; actually `nbd_crm_followup_hidden='1'` with no expiry, per device | Device | forever | KPI pill | Today list unaffected | none |
| **Task hard-delete** (`tasks.js:141`; rules :850) | The overdue-invoice task has a deterministic id, so a delete re-creates it at 08:15 every day (`invoice-overdue.js:66-68`) | Task | n/a | none | n/a | none |

### 1c. Numbers, labels and screening

| Control | Promise vs actually | Scope | Lasts | Undo | Does NOT stop | Audit | Roles |
|---|---|---|---|---|---|---|---|
| **Label hide** (personal, spam) | Off Today, Home, badge; promise or due follow-up always breaks through; hidden urgent breaks through unless kind spam | Number, tenant (not per user) | forever, no expiry | 9 s undo bar, Remove label | Thursday loud notify; promises email urgent rung; **plain text from a hidden customer** (C-4) | last writer only (`updatedBy`), **not rendered in the UI**; no history subcollection (design promised one) | owner, company_admin, manager write; rep, viewer none |
| **Label quiet** (sub, supplier, recruiter) | Promise or due follow-up only; **urgent does not break through** | same | same | same | Urgent from a number that is on a customer (C-4) | same | same |
| **`capture:'off'`** (personal) | Stop copying/transcribing | Number | forever | Label removable; texts already dropped are **unrecoverable** (`text-inbox.js:122-123` advances the cursor past the skip) | Everything: `status:'personal'` makes `callNeedsYou` false and the valve skips it | none | staff, no owner confirm |
| **Suggestion Accept / Not this** | One tap for non-hiding kinds; hiding kinds open the sheet; dismissal remembered per (number, kind) | Number, tenant | permanent | Accept has undo; Not this none | "Remove label" re-suggests the same kind next load (no dismissal on removal) | `source` on the label | owner, staff |
| **Block list (spam + hide)** | List plus Copy; **no carrier action** (copy says so) | Number | n/a | Not spam | n/a | n/a | n/a |

### 1d. Owner and user notification controls

| Control | Promise vs actually | Persists | Honoured by | Ignored by |
|---|---|---|---|---|
| **Mode** Critical / Digest / Firehose ("How noisy should Joe be?") | Cosmetic server-side. **Digest queues nothing** (no caller passes channel `digest`) | localStorage + `userSettings.notifications` | 4 client generators (`crm-snooze.js:227,361,398`, `review-engine.js:343`, `tasks.js:23-30`) | Every server bell doc, push, email, SMS (`functions/` has no reader of `userSettings.notifications`) |
| **Triggers** overdue / hot / storm / approval / inbound / D2D / missing-field | `notifHot`, `notifStorm`, `notifInbound`, `notifD2d` have **no firing caller**. Needs-field and review-ask pass priority `normal`, so default Critical suppresses them whatever the toggle shows | same | `notifOverdue`, `notifNeedsField`, `notifApproval` partially | all server paths |
| **Channels** Push (default off) / Email (default on) / SMS ("coming soon", disabled) | Push: client `Notification()` only, while server FCM is live for every sender. Email: no caller. SMS: "coming soon" while lead-alert and storm-watch SMS to Jo's cell are live | same | n/a | all server senders |
| **`users/{uid}.notificationPrefs`** category gate | **No writer anywhere** (grep docs/functions/scripts); `isNotificationEnabled` is never false; `sendCustomNotification` skips it anyway | none | 6 native push types (no-op) | `sendCustomNotification` (9 callers: away, call-watch, call-center, lead-alert, estimate-view-alert, deal-acceptance, thursday, lead-alert-watchdog, social-studio) |
| **Push opt-in card** ("Turn on appointment reminders") | The token receives **every** push type; no in-app off; no `deleteToken`, no removal on logout or when removed from the team | token + 7-day snooze key (per device) | n/a | n/a |
| **Away mode + backup + hand-back** | Owner-only ON; owner or admin OFF; re-verifies the backup each tick; holds, never drops, at night; urgent still reaches a member | `away_mode`, `away_windows` (admin SDK) | Backup routing; Thursday approved wording | The owner's own ladder, bell, email rung, brief and lead alerts (nothing else reads `away_mode`). **Notify is dark**: `AWAY_MODE_ENABLED` absent |
| **Quiet hours 21:00-08:00 ET** (`away-mode-logic.js:52-53,87`) | Backup routing only; constant, not per user or company tz | constant | backup routing | everything else |
| **callWatch window 08-20 ET every 2 h** | No user switch, snooze or vacation; hard-wired to NBD's owner | constant | n/a | n/a |
| **Morning brief** (`morningBriefEnabled`) | **No UI.** Setting it false ends the absorb, so the 07:00, 07:15 and 08:15 emails come back as three emails instead of one | users doc | `morning-brief.js:228` | 15:15 sweep ignores it |
| **Weekly digest / dormant / review-ask toggles** | Persist only on "Save Profile" (toggle-and-leave loses it) | users doc | the crons (skip on `=== false`) | n/a |
| **Lead alert SMS/email/push to Jo** | No quiet hours, snooze, mode, trigger or daily cap **for NBD** (`lead-alert.js:403` cap is `!target.isNbd`) | constants | n/a | all switches |
| **Storm Watch to Jo** (`storm-watch.js:215-231`) | SMS + email once per 30-min poll with new events; no off, no quiet, no "mute this storm" | constants | n/a | all switches |
| **Storm Mode** (opt-in theme / banner / drafts) | Honest: polls only while a tab is open and visible; alerts nothing in the background; drafts idempotent by doc id | localStorage + `userSettings.stormMode` | n/a | n/a (not a notification path) |
| **Texting master switch** ("No text will go out until you turn it back on") | Copy is absolute; scope is customer texts only, **not** the system's own texts to Jo | `sms_settings/{companyId}` | all customer sends | Jo's own alert texts |

### 1e. Customer-facing opt-outs: sender x check matrix

Y enforced, N missing, n/a not applicable. VERIFIED unless noted.

| Path | STOP register | Company DNC | Consent flag | Email unsub | Quiet hrs | Master switch | Cap |
|---|---|---|---|---|---|---|---|
| sendSMS live (reps; review asks, invoice reminders, portal links, Ask Joe) `sms-functions.js:834` | Y | Y | **N** for a lead with `tcpaConsent===false` | n/a | Y | Y | Y 5/day |
| sendQueuedSMS (outbox replay) | Y | Y | **N** | n/a | Y (held 409) | Y | Y |
| sendD2DSMS / knock `:1332` | Y | Y | Y | n/a | Y | Y | Y |
| onAiDraftApproved `:2365` | Y, fails closed | Y | **N** | n/a | Y (held to pending) | Y | **N** (known) |
| /estimate ack `lead-alert.js:532` | Y | Y | Y | n/a | Y | Y | one shot |
| Storm texts `storm-sms-guard.js` | Y | Y | Y | n/a | Y | Y + storm | 24 h claim |
| phoneTextAction (7 device Messages hand-offs) | Y | Y | Y | n/a | Y | Y | n/a |
| Agent / bot / Pixel text drafts | Y at filing and send | Y | Y | n/a | Y at send | Y | N |
| **Blank `sms:` links, about 15 sites** | **N** | **N** | **N** | n/a | **N** | **N** | **N** |
| sendEmail commercial `email-functions.js:483-517` | n/a | n/a | n/a | Y + postal + List-Unsubscribe | n/a | n/a | 200/day |
| lead-followup, funnel-recovery emails | n/a | n/a | n/a | Y + footer + headers + postal | n/a | n/a | once |
| Lead ack email `lead-alert.js:262` (transactional) | n/a | n/a | n/a | not gated, no footer | n/a | n/a | once |
| Push to customers / outbound calls | none exist (staff-only push; Thursday is inbound-only) | | | | | | |
| Manual `tel:` calls | **no DNC flag or list exists** | | | | | | |

## 2. Findings, ranked

IDs are this note's (C-n). "Fixed" means fixed in this PR.

### P0 (a promise the product makes is defeated)

**C-1. A dated promise or waiting item on a lead has no server nudge.
VERIFIED (exhaustive reader grep).**
- `callAction 'promise'` on a lead-filed call writes `promise-<id>` on the
  lead, marks the call `handled`, and retires the generic task as superseded
  (`call-center.js:984-1008`). `callNeedsYou` is then false, so strip, ladder,
  ledger, away and callWatch drop the person; `collectSweepItems` skips
  handled calls and done tasks, so the sweep and the 06:45 brief drop it.
- Every server reader of lead tasks: `calendar-feed`, `game`,
  `google-calendar`, `morning-brief` (`type:'event'` only), `push-functions`
  (`eventAt` appointments only), `agent-mcp` (bots, not Jo). **None reads
  `kind:'promise'` or a waiting task's `dueDate`.** `task_overdue` is minted
  client-side inside `renderTodayTasks` (`tasks.js:242-268`) when the
  dashboard paints, and nothing turns it into a push.
- The design note assumed otherwise
  ([PROMISE-CAPTURE](../projects/PROMISE-CAPTURE-2026-10-12.md): "the existing
  task-overdue path already reaches the bell and push"). It does not.
- Effect: "Call back today" / "Send estimate tomorrow" appears nowhere unless
  Jo opens the CRM. Waiting items and nudges are the same. A promise riding on
  an **unfiled** call is fine (callWatch reads `call.promise`).
- Recommended: see M-1.

**C-2. The owner-side option-out is cosmetic. VERIFIED.**
- See 1d. Server senders never read the Notifications tab; `notificationPrefs`
  has no writer; Digest queues nothing and its copy ("no real-time
  interruptions") is false; four triggers fire nothing; SMS says "coming soon"
  while SMS alerts are live; the save path swallows a Firestore failure
  (`dashboard-bootstrap.module.js:6541`, `catch (e) {}`) and still toasts
  "saved".
- The only real "off" for push is revoking browser permission.

### P1

**C-3. Away mode reads as cover while dark. VERIFIED (tick harness).**
`AWAY_MODE_ENABLED` is absent, so `runAwayTick` is dry-run: 0 deliveries,
`backupState` stays `ok`, `lastTickAtMs` stays 0, so the "routing is behind"
warning (`away-mode-logic.js:455`, `d.lastTickAtMs && ...`) can never fire.
Home reads "Away until Wed 2 PM - backup: Sam R" with tone ok. If Jo turns it
on before the flip, he believes he is covered. Also (VERIFIED): turning Away on
re-tells the backup every open item (the window ledger starts empty); a backup
who tapped "I'm on it" is re-told up to twice more (`resolveBackupNotifications`
ignores `touches`; `ackedAtMs` is never populated, so `ackWindowMin` has no
acknowledge control); a broken standing backup is invisible when Away is off
(`statusLine` returns null); the label shows `untilMs` while the window ends at
the 21-day cap. LEAD: "I'm back" throws if the open-items read fails
(`away-mode.js:559`, no fallback), and an unreviewed hand-back is overwritten by
the next trip's.

**C-4. A label can hide a real customer. VERIFIED (harness).**
- **Capture-off on a number that is or becomes a customer** is silent forever:
  `status:'personal'` makes `callNeedsYou` false before any lead, promise or
  urgent check (`home-attention.js:179`, `call-watch-logic.js:88`), the valve
  skips `status==='personal'`, and nothing reconciles labels with leads (no
  trigger touches `contact_labels` when a lead, estimate or deposit appears).
  Texts already skipped are unrecoverable. A manager can set it with no owner
  confirm. The sheet also allows `kind=personal, policy=surface, capture=off`,
  and ingest ignores `policy`, so a "surface" label never surfaces.
- **`quiet` swallows urgent from a number on a customer**: `if (pol==='quiet')
  return promised||dueFu` runs before `c.urgent`, with no lead valve. Reachable
  by one tap: two AI `callType:sub` calls make Accept default to `sub`
  (quiet) (`contact-suggest-logic.js:105-111`).
- **A hidden customer's plain text is silently dropped**: voice resurfaces once
  (valve reason `lead`); text days are excluded (`home-attention.js:159`,
  `call-watch-logic.js:141`).
- LEAD: proxy / masked / pooled numbers (Thumbtack, a shared office): `matchLead`
  deletes a number with 3+ leads, so `leadId` is null and the lead valve never
  fires; labelling it hides every customer through it.
- Also: no history, "who or when" is never rendered, and the owner is not told
  when another user hides a number (the design promised
  `contact_labels/{digits}/history`; it does not exist).

**C-5. Snooze is honoured by some surfaces and ignored by most.
VERIFIED (harness; `today-plan`, `home-attention`, `call-watch-logic`,
`call-center-logic`).**
- An unfiled call with `snoozeUntilYmd` tomorrow: strip 1, Today 0, ladder 0.
  A lead call whose task moved to tomorrow: strip 1, Today 0. The Call Center
  "Needs attention" tab and deck never filter snoozed items
  (`call-center-view.js:153-159`). The ledger counts snoozed people as open;
  Away's cover list would route them to the backup after 2 h.
- The 07:15/15:15 sweep lists a snoozed **urgent** call <36 h that has a task
  (`call-center-logic.js:565-568` ignores the moved due date); the ladder
  honours it.
- A new inbound text does not clear a snooze (`reopenPatch` clears only
  `handledAtMs` and `taskDone`, `text-inbox-logic.js:236-247`): `newNeeds` pushes
  "urgent" and the tap lands on a Today that shows nothing.
- Today **Stalled** and **Calls owed** ignore the lead snooze while the bell
  honours it (`today-plan.js:148-160,412,655`); a snoozed lead that gets signed
  stays off the board until the date (`crm-pipeline.js:279-282`, no stage
  exemption, no max). The comment at `today-plan.js:39-41` claims one rule;
  there are two.
- Root cause and fix shape: M-1b (one shared "deferred" predicate).

**C-6. Server and client disagree about labels and Thursday-handled.
VERIFIED (harness).**
- Thursday `decideRoute` / `processCall` reads no label (`thursday-logic.js:
  678-733`): a spam-labelled `new_lead` call still creates a lead, a task and a
  loud push/email/SMS. Phase 4 of the routing tree ("downgrade notify for
  quiet/hide") is not built.
- An urgent or callback Thursday call from a hide/quiet number: Today shows it
  (`thursday-handled-logic.js:141-142`), the push and away list drop it
  (`call-watch-logic.js:280-281`, `away-mode.js:107-108`). The backup is never
  told.
- The promises email and morning brief ignore labels (`gatherSweep` takes none):
  an urgent noted call with `callType:'spam'` still produces `['urgent']` and
  can never be cleared by labelling.
- `thursday_handled` is read only by `thursday.js` and the playbooks, so the
  per-call "Thursday took it" push still fires for a "handled" number.
- Thursday unreviewed calls fall off Today at 3 days
  (`thursday-handled-logic.js:31,194`), including urgent ones; the ledger does
  not count Thursday at all; the Thursday section is not in `p.total`.
- Dark today (`THURSDAY_LABEL_PLAYBOOKS_ENABLED` absent) but wrong the day it
  is switched on. Fix shape: one server module that Today, callWatch, away,
  sweep and brief all import (M-5).

> **Update 2026-10-13 (later): C-7 is built** — option A, see
> [SMS-CONSENT-DECLINED-POLICY-2026-10-13](SMS-CONSENT-DECLINED-POLICY-2026-10-13.md).
> Two corrections to what is written below: the device hand-off check refused a
> declined lead *outright* (it did not honour an inbound window, so "mirrors the
> device hand-off path" was wrong), and the lead bridge never stamped
> `tcpaConsent:false` on the CRM lead at all, so no reader could see a decline.

**C-7. A consent flag declined on the form is not enforced on server sends.
VERIFIED (harness).** A lead with `tcpaConsent:false` got HTTP 200 and a Twilio
call from live `sendSMS`. Only `phone-text-check.js:119` and
`agent-mcp-logic.js:940` honour `declined`; `sendSMS`, `sendQueuedSMS` and
`onAiDraftApproved` do not. Options in M-7; needs Jo's decision.

**C-8. Opt-outs that do not land on the register depend on a human tap.
VERIFIED (code, grep).**
- Most texts still go from Jo's own phone. A STOP that lands there is recorded
  only by "They replied STOP" (`agent-inbox.js:284`,
  `customer-tasks-ui.js:1752`) on a *logged outbound row*, or by typing the
  number into Settings → Do Not Text. The customer card has no do-not-contact
  control, and `smsOptedOut` stamped on the lead (`twilio-line.js:229-231`) is
  read by nothing in `docs/pro/js`.
- Channel-neutral revocations ("do not contact me", "remove me", "leave me
  alone") write the **SMS** register only. lead-followup and funnel-recovery
  emails continue. A STOP never touches the email register and vice versa
  (VERIFIED, both directions).
- There is no voice Do-Not-Call flag or list for manual calls
  (`privacy.html:618` says a customer may phone to update preferences). There
  is no email re-subscribe path anywhere; the CRM button says "can't be undone".
- An incoming STOP is invisible on the lead: `incomingSMS` returns before the
  lead match, so no note, flag or timeline entry.

**C-9. About 15 blank `sms:` links are unchecked (documented residual,
VERIFIED by grep).** `call-center-view.js:267,271,811`, `claim-core.js:171`,
`close-board.js:869`, `crm-list-view.js:315`, `customer-estimate-hub.js:370`,
`customer-quick-action-bar.js:191`, `customer-tasks-ui.js:2795`,
`customer-phone-order.js:99,126`, `dashboard-actions.js:2332`,
`dashboard-widgets.js:1798`, `followup-deck.js:78`, `no-next-step.js:394`,
`layouts/kit.js:65`. A capture-phase delegate on every `a[href^="sms:"]`
already exists but only logs (`crm-snooze.js:539-600`); extending that one
delegate to call `NBDPhoneShare.checkText` and `preventDefault` on a "no" is
one change instead of fifteen.

**C-10. Some inbound texts reach no surface. VERIFIED (harness) / LEAD.**
- An unknown-number or customer question text with no promise and no urgency is
  not "needs you": text-day docs carry no `bucket` or `direction`
  (`text-inbox.js dayDoc`), so the `unknown` and `insurance` branches never
  fire. There is no "inbound text, no reply since" rule. VERIFIED.
- LEAD (flag-dependent): Twilio inbound to a matched lead gets one FCM push to
  `fcmTokens.limit(1)` (one device, no retry) and no needs-you row; unmatched
  texts land in `unmatched_sms`, platform-admin only, with no push, no bell and
  **no dismiss**. Texts from the phone backup (`phone_text_days`) get no
  opt-out processing at all.

**C-11. The 06:45 brief can swallow the morning promises list. LEAD (live
config).** `soft('promises', ...)` returns `[]` on any failure
(`morning-brief.js:181`), and `runSweep` returns `absorbed` for the 07:15 slot
from config alone (`call-center.js:722`). A failed `gatherSweep`, or a brief
that ends `rejected`, `no-key` or `nothing-today` (`:245`, fires when there are
no appointments and `sections.promises` is `[]`), loses the 07:15 email with
only a log line. The next send is the 15:15 sweep, eight hours later.

**C-12. Owner alert paths have no off, quiet, cap or snooze. VERIFIED (code).**
Lead alert (SMS + email + push), Storm Watch (SMS + email), estimate-view push
(6 h throttle per lead, ignores snooze), per-call urgent push (per call id, not
per person), watchdog re-send, Thursday SMS/email/push, inbound-customer-SMS
push. NBD is exempt from the tenant daily cap (`lead-alert.js:403`). Public
intake is 20/min/IP (`handlers/integrations.js:460`) with no daily or global
cap and Turnstile not required on main (#2414 open), so a distributed form
flood is one SMS + one email + one push per lead, at any hour. Tenant
`alertEmail/alertSms` are writable by owner or company_admin with no
verification on main (#2410 open) - an SMS/email relay on NBD's senders.

**C-13. Re-nag shapes. VERIFIED.**
- Overdue follow-up notices re-fire **every day**: the doc id is
  `follow_up_<uid>_<lead>_<local-day>` (`crm-snooze.js:158-170`), so a dismiss
  has no memory. A "+7 days" swipe session of 100 leads makes a day-8 wave of
  100 notices plus 100 Stalled rows.
- Bell dismissal ids collide across states (`notif-bell.js:317,380,409,453`):
  dismissing "task due today" also silences tomorrow's "overdue task" on that
  device.
- The ladder's **email rung repeats** when the rung-3 push reached 0 devices:
  `nextLadder` keeps the previous rung, so the next run sends the email again,
  up to about 7/day for one item (`call-watch.js:206-219`). A non-ladder item
  whose push reached 0 devices is marked told and never re-told.
- The 10+ day estimate follow-up recurs weekly forever, with the same copy.

**C-14. Today actions act on more than they show, and cannot be undone.
VERIFIED (read).** Done / Tomorrow loop `r.tasks` while the row shows three;
"Handled" on a promised call leaves the `cube-` task open, so the lead stays
under Promised until a second tap; no undo exists for Kept it, Mark dead, Mark
all reviewed, Keep hidden or Today Handled; Mark dead leaves the lead open and
asks no confirmation. Open tasks and waiting items survive **Lost**
(VERIFIED harness: a lost lead still shows `promised` and `waiting` rows).

### P1 fixed here

**C-15. A snoozed lead was emailed "we haven't managed to connect".
VERIFIED, fixed.** `leadFollowUpSweep` treats a card as untouched when
`stage==='new' && status==='new'` (`lead-followup.js:135-138`); a snooze changes
neither. Active in prod: the code runs unless `LEAD_FOLLOWUP_ENABLED==='false'`.
Now skips any card with `snoozedUntil` or `snoozeCount>0`. Related LEAD: the
gate registry lists it `polarity:'enabled'` (default off) while the code is
default-on, so the health digest's gate table can report it OFF while it runs.

**C-16. "Don't ask this one" was ignored by the server. VERIFIED, fixed.**
`reviewAskDue` (the one pure rule behind the 08:15 email, the bell and the
brief) now returns false for `reviewAskDeclined === true`.

**C-17. Four STOP phrasings went to the AI draft step. VERIFIED, fixed.**
Full-width "ＳＴＯＰ", whole-message spaced "S T O P", a **terminal** "do not call
or text me" (and "dont text or call me", "never call or text"), and a
**terminal** "delete my number" (optionally "from your list"). The two phrase
rules are end-anchored on purpose: the silent-failure review of this very diff
showed the first draft would have recorded an opt-out for "don't call or text
before 10am, I work nights", "don't call or text my husband" and "delete my
number 555-1234 and use 555-9999" - customers giving a when/who limit or a
correction, silenced with no bell and no draft. Each is now a pinned negative.

Still open (decision needed, pinned by an existing test): standalone "wrong
number" is deliberately not an opt-out; recommended `possible_stop` (a
reassigned number is a TCPA signal and `possible_stop` only suppresses the
draft and rings a bell). Also open: a spaced "S T O P" inside a longer message
("Not interested. S T O P" is still null, only whole-message letters collapse),
a bare "don't call me" (voice-only; left for a person), Spanish PARAR/BAJA,
"STOP2".

### P2 (selected; each marked)

- Inbound plain text after a STOP still gets an AI draft (VERIFIED, 1 draft);
  drafts pending at STOP time are not cancelled, they fail at approval. Noise.
- Review asks, portal links and invoice reminders carry no STOP line (only
  knocks, storm, ack and drafts do). Decide whether they are marketing.
- `storm_alert_subscribers.active` stays true after STOP, so "N subscribers in
  range" counts opted-out people (LEAD, `storm-watch.js:221`).
- `phone-share.js:~120` caches an OK for 120 s client-side. `kind` on
  `sendEmail` is client-supplied: a follow-up labelled `estimate` bypasses
  suppression, footer and postal address (trust boundary, not an exploit).
- `sendSMS` checks only `tenantKeyOf(decoded)`, not the lead's own tenant key
  as `phone-text-check.js` does, so a solo uid that later gains a `companyId`
  could split its DNC list (LEAD).
- Suggestions: the Thursday evidence read is `where(userId==uid).limit(150)`
  with no orderBy (an arbitrary 150; a non-owner gets none); dismissals are a
  whole-list `setDoc` from a 5-minute cache, so a stale device drops another's
  (LEAD); "Remove label" re-suggests the same kind.
- Label write from a stale device is denied (`createdAtMs` must be unchanged)
  with the toast "check your connection", then the local rollback shows `prev`
  until the next 60 s load (VERIFIED read). `checkTarget`'s `ownDigits` guard
  is dead code (never passed, `contact-labels.js:109`). `labelOf` slices the
  last 10 digits, so a foreign 12-digit number inherits a US label (harness
  true, rare).
- "Keep hidden" looks permanent but is a baseline that re-fires on every later
  call on a lead-matched number (no "keep hidden for this customer"); it stamps
  the **client** clock.
- Snooze/push: "Snooze 1h" on appointment and follow-up pushes does nothing
  (no `leadId`); push "Snooze 1h" on newLead hides the whole lead, not the
  notification; `snoozeCount` is bumped by 1 h push snoozes and the 30-day
  No-next-step loop, so "Snoozed 3x" measures taps, not indecision.
- "Ready for review" bell and the "they opened it" alert ignore snooze; agent
  MCP `overdueFollowups` ignores snooze, so bots file reminders on parked leads.
- Non-owner staff are blind on Home: Home and Today read `userId == uid`, so a
  manager sees "Nothing on the list" while their Call Center is full.
- Viewer role shows Snooze/Wake buttons on six surfaces (rules refuse the
  write, so the viewer gets an error toast).
- XP: `game-logic.js:75` awards task XP for any `done:true`, including
  `outcome:'dead'` and "Kept it"; `handled` earns 3 XP (cap 30/day) - dismissal
  is gamified.
- `inbound-sms-triage` / unmatched: no dismiss. 36 h alarm: no ack.

## 3. Behaviour checks Jo asked for

| Question | Answer |
|---|---|
| Does Keep hidden also stop the ladder email rung, ledger, morning brief, away cover list? | Ladder, ledger open-count, away list: **yes** (they run `callNeedsYou` with labels). Morning brief / 07:15 / 15:15 promises: **no** (`gatherSweep` takes no labels). Per-call Thursday loud notify: **no**. |
| Does a label hide STOP-keyword texts? | **No, opt-out is label-immune** (VERIFIED: no label read anywhere in `sms-functions.js`, `twilio-line.js`, `sms-stop-intent.js`). Texts that arrive through the phone backup are a separate store with no opt-out processing. |
| Does snooze silence the 36 h no-recording alarm? | No, and nothing does: the alarm has no ack. |
| Snoozed item whose promise date passes? | Plain tasks wait; **promise tasks ignore the snooze** (`today-plan.js:416-431`); follow-up dates bypass it; after expiry the overdue day-count includes the snoozed days. Expiry is an instant compared on read (no cron), presets resolve to 09:00 device-local, not company tz. |
| A customer texts STOP, then a rep texts from the CRM? | Refused 403 `opted_out` on live, queued, AI-draft approve; the draft goes `failed/opted_out` with zero Twilio calls. From Jo's own phone: the device hand-off asks the server first; the 15 blank links do not. |
| A number labelled spam that is a real customer? | Spam never breaks through on urgency; a promise or due follow-up does; voice resurfaces once via the valve; texts do not. Thursday's spam playbook ends the call and the label beats the lead match (dark). See C-4, C-6. |
| Away mode with the backup also away? | No concept: only the owner has Away, no second backup. After 3 tells the item is `exhausted` and silently skipped (`away-mode-logic.js:314`). |
| Away expires while a hand-back is pending? | The tick hands back even with the gate dark; the next trip's hand-back overwrites an unreviewed one (LEAD). |
| Multi-device? | Firestore-backed controls (handled, task outcome, labels, snooze, thursday_handled) sync; labels with a 60 s memo and no snapshot listener. Per device: bell derived dismissals, deck skips ("Later"), CRM follow-up banner hide, push opt-in snooze, `nbd_notif_settings` cache (and a second account on the same device inherits it, LEAD). |
| Roles? | viewer read-only everywhere (rules + `callAction`); rep own calls; manager/company_admin company calls; labels owner/company_admin/manager only; Do Not Text lift owner/company_admin with required reason; away ON owner only. Stale claims after a role change are not re-checked on the client (LEAD). |

What is **good** and should not regress: STOP is global, phone-format-proof,
cross-company-copied, never TTL'd; a lift is a marked-not-deleted record with a
required reason and history; every commercial email carries a footer, postal
address and one-click List-Unsubscribe and a gate error sends nothing; STOP and
START replies name the business; a possible-STOP never gets an AI draft; quiet
hours are homeowner-local on every path; the ladder, watchdog, dead-man and
storm drafts are bounded.

## 4. Missing controls (options and recommendation)

Ordered by value to Jo. Each states what it replaces.

**M-1. A server channel for promises, and one shared "deferred" predicate.**
- (a) Close C-1: add dated `promise-*` tasks and ripe waiting items to the
  07:15/15:15 sweep and the 06:45 brief, plus a callWatch rung for "promised
  today, not kept". The data and window helpers exist
  ([PROMISE-WINDOW-SERVER](PROMISE-WINDOW-SERVER-2026-10-13.md)).
- (b) Close C-5: one `isDeferred(entity, now)` (client mirror + server module)
  that Today Stalled, Calls rows, strip, Call Center, ledger, sweep urgent
  branch, away, `agent-mcp-logic`, `lead-followup`, `dormant-leads`, `tasks.js`
  and estimate-view-alert all call, plus a vm test that enumerates every
  surface against one snoozed lead. **Recommend both; (a) first.**

**M-2. "I've got this" with an until-date and an actor, person-level.** One
write on the person key (`lead:` / `num:`), read by the same helper as M-1b,
replacing the call/task dual representation. Answers "stop reminding me about
this for a week" for a *person* (today it exists only for a whole lead, and
not for a task, an estimate row, a money row or a notification). Options:
(A) reuse the call lane's `snooze` pattern on tasks (move `dueDate`, keep
`snoozedFromDue`, add `snoozedBy/At/count`); (B) separate `snoozedUntil` on the
task (keeps the true due date for miss stats). **Recommend A.**

**M-3. "Mute this customer's alerts, keep the job."** Does not exist. Options:
(A) a `snoozeScope` on the existing snooze ("hide from board and quiet alerts"
vs "quiet alerts only, keep on board"), written to every open lead sharing
`customerId`; (B) a `quietUntil` on the customer so future leads inherit;
(C) time-boxed labels (`untilMs`). **Recommend A now, B as follow-up.**
Promise-wins and urgent-from-lead still break through.

**M-4. Honest owner notification gateway.** One place all nine
`sendCustomNotification` callers pass `category` and `urgency` to, honouring
`userSettings.notifications` (keys already written by the UI), plus
`alertSnoozeUntilMs` ("snooze all alerts 2 h / until tomorrow", urgent calls
break through), one quiet window in company tz for SMS and email, a daily cap
and a 10-minute burst collapse for NBD too. Make `critical` real server-side;
make `digest` queue to the 07:00 / 15:00 sends. **Recommend A: gateway first**
(one function change gives parity for nine callers); until then, label the tab
honestly ("applies to this screen only").

**M-5. One server module for "who needs me".** `needsYou(call,label)`,
`thursdayTier(call,label,handled)`, `sweepFilter` exported from
`contact-labels.js`; callWatch, away, sweep, brief and Thursday all import it;
a parity test pins client against server. Closes C-6 and the promises-email
label gap.

**M-6. Label safety rails.** (a) Lead/label reconciliation trigger: when a
lead, estimate or deposit appears on a number labelled hide/spam/quiet or
capture-off, file **one** Today row "This number you labelled X just became a
customer - Keep / Relabel". (b) Owner confirm for staff doing `capture:'off'`
or `spam`. (c) `history` subcollection and a rendered "set by / when". (d) A
"What labels hid this week" digest line on the ledger and brief, a Home chip,
and a Call Center "Hidden by label" filter (today hidden items can age past 14
days unseen). (e) "Hide for 7 days" auto-revert. **Recommend (a) and (d)
first.**

**M-7. Consent and revocation scope.** For C-7: (A) refuse in
`complianceGate` for `tcpaConsent:false` unless that number texted inbound
within N days (mirrors the device hand-off path; still lets reps answer a
customer who wrote first); (B) refuse outright; (C) warn only. **Recommend A.**
For C-8: a one-tap **"Do not text / call / email"** menu on the customer card
(wired to `addDnc`, `markEmailUnsubscribed`, and a new lead-level `doNotCall`
flag shown on `tel:` buttons), and on a channel-neutral phrase also suppress
that tenant's commercial email to the lead's address (bare STOP stays SMS-only,
the CTIA scope). Show a STOP/DNC badge by stamping `smsOptedOut` where the card
can read it. **Recommend all three.**

**M-8. Undo and terminal exits on every Today row.** Undo toast (6 s) for Kept
it, Mark dead, Handled, Keep hidden, Mark all reviewed; `outcomeBy/At`; a
reopen action for `done`/`dead`; "Not now (2 wk)" and "They said no -> Lost" on
estimate, Stalled and Waiting rows; auto-retire open tasks and waiting items on
a lost move; force a decision at `snoozeCount >= 3` instead of a badge.

**M-9. System alarms get an ack.** "Silence the recorder alarm until <date>" and
a UI writer for `integrations/pipelineHealth.ackUntilMs`, so a trip does not
need the ingest paused; cap the ladder email rung at one per item per day.

**M-10. One "I've got it, stop" budget.** An unhandled urgent promised call
costs about 3 pushes + 1 email on the ladder, 2 sweep emails a day, a ledger
bell nightly, plus the strip, Today and the Call Center badge. After M-2 every
one of those reads the same acknowledgement.

## 5. Fixed in this PR

All failing-first in
[`handle-optout-controls-2026-10-13.test.js`](../../tests/handle-optout-controls-2026-10-13.test.js)
(14 assertions red on the first run against unfixed code, 43 green after; every
fix has a positive control that stays green with its trigger removed, and the
STOP phrases carry a negative list of customer sentences that must NOT opt out):

| Fix | File | What |
|---|---|---|
| C-16 | `functions/review-request-nudge.js` | `reviewAskDue` returns false when `reviewAskDeclined === true` (lead and job paths) |
| C-15 | `functions/lead-followup.js` | the sweep skips a card with `snoozedUntil` or `snoozeCount>0` |
| C-17 | `functions/sms-stop-intent.js` | NFKC fold, whole-message spaced letters, terminal "delete my number", terminal "do not call or text me" |

Pinned deliberately (not a bug): `unsnooze` nulls `snoozedUntil` but never resets
`snoozeCount` (`lead-snooze.js:162`), so a card Jo snoozed once and woke is never
sent the apology email. It fails closed; the test records it as a decision.

Regression suites run green: `sms-stop-intent-2026-10-05` (93),
`r6-texting-trio` (45), `r6-texting` (72), `sms-dnc` (35),
`twilio-line-2026-10-06` (185), `email-unsubscribe` (138),
`review-anniversary-per-job` (25), `review-paid-in-full` (75),
`review-r4-dates-fixes` (80), `background-job-reliability` (27),
`gauntlet-regressions` (276), `ai-automations-server` (121).

Deliberately **not** fixed here (each needs a decision or a bigger slice): C-1
to C-14 above. The ones that are one-line but change behaviour Jo has seen: the
strip honouring snooze (changes the headline number), `wrong number` ->
`possible_stop` (flips a pinned test), the blank `sms:` delegate (touches every
text link).

## 6. Not verified

- Whether `TEXT_INBOX_ENABLED` / `TEXT_NOTES_ENABLED` are on in production (the
  text half of every call-level control may be dark).
- Whether the sign-out button calls `NBDAuth.logout` (which purges) or raw
  `signOut`, so cross-session survival of bell dismissals is partly a lead.
- Jo's `userSettings.notifications.mode`, which decides whether the daily
  needs_field notices are live.
- Production value of `brand.contact.mailingAddress` (a commercial email is
  blocked without it).
- Healthchecks.io re-alert cadence for the dead-man alarm.
- How reps' labels, snoozes and handled state behave for **other tenants**:
  every server reader is hard-wired to the NBD owner uid; other Pro tenants get
  client-side behaviour only.
- Legal characterisation: see section 8. This note is engineering analysis,
  not legal advice.

## 7. Related notes

[TEXTING-COMPLIANCE-2026-10-05](TEXTING-COMPLIANCE-2026-10-05.md) (the STOP /
DNC / lift design), [NEVER-FORGET-SERVER-FINDINGS-2026-10-13](NEVER-FORGET-SERVER-FINDINGS-2026-10-13.md),
[NEVER-FORGET-CLIENT-FINDINGS-2026-10-13](NEVER-FORGET-CLIENT-FINDINGS-2026-10-13.md),
[HOME-STRIP-FAILED-READS-2026-10-13](HOME-STRIP-FAILED-READS-2026-10-13.md),
[CONTACT-ROUTING-TREE](../projects/CONTACT-ROUTING-TREE-2026-10-12.md),
[THURSDAY-LABEL-PLAYBOOKS](../projects/THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md),
[PROMISE-CAPTURE](../projects/PROMISE-CAPTURE-2026-10-12.md),
[AWAY-MODE-BACKUP](../projects/AWAY-MODE-BACKUP-2026-10-12.md).

## 8. Compliance reference check (not legal advice)

Run through the `nbd-compliance-reference` agent on 2026-10-13. It could not
load eCFR (an unblock page) and read the Cornell LII mirror, 15 USC 7704, the
FTC CAN-SPAM guide and a law-firm note on the revoke-all waiver; it did not open
the FCC orders themselves. Re-check on the primary sources before relying on any
line below. KY/OH specifics come only from
[TEXTING-COMPLIANCE-2026-10-05](TEXTING-COMPLIANCE-2026-10-05.md); the OH and KY
telemarketing-hours slot is still empty and is a question for counsel.

| Design point | Where it sits |
|---|---|
| Revocation "by any reasonable method", honoured within 10 business days; words like stop / quit / cancel / unsubscribe reasonable per se (47 CFR 64.1200(a)(10)) | **At or above.** Phrase revocation is honoured immediately; the 10-day figure is a ceiling |
| Revoke-all: an opt-out in response to one type of message revokes consent for all robocalls and robotexts (waived until 2027-01-31 per the law-firm note; not confirmed against a later order) | An SMS-only register is at the line **today**; **below** once the waiver ends if more than one category of robotext is sent (C-8) |
| One confirmation text after opt-out, no marketing, ideally within 5 minutes ((a)(12)) | **At the line** provided the TwiML reply stays marketing-free and is the only extra message (it names the business since #2425) |
| Reply after an unchecked consent box (C-7) | **Unclear.** No express reply-to-inbound exemption was found in the rule text; informational vs marketing is the line. An N-day window from the last inbound text is a reasonable narrowing; N and the allowed content are counsel's call |
| Internal DNC for manual, human-dialed telemarketing calls, 5-year memory, written policy ((d)) | **No voice DNC exists (C-8): likely below** for telemarketing calls; informational calls (scheduling, job status) are likely outside. Whether (d) applies where an established business relationship exists (18 months purchase / 3 months inquiry) is unclear |
| CAN-SPAM: opt-out honoured within 10 business days, mechanism live 30 days | **At or above** (immediate, one-click, RFC 8058 headers) |
| A text STOP is not an email opt-out by statute; a "do not contact me" sent by email should be honoured as one | **Statute does not require** crossing the channels; honouring it is the safer course (M-7) |
| The "we haven't managed to connect" follow-up | Treat as **commercial** (transactional is read narrowly); the footer, postal address and unsubscribe it already carries are right |
| 8am-9pm recipient-local quiet hours apply to solicitations; purely informational messages are not telephone solicitations | NBD applies them to every automated text: **above the line** |

Questions to put to counsel, from the same check: single cross-channel
revocation flag and when revoke-all must be live; whether a manual sales call to
a past inquirer is inside (d) when an EBR exists and what the voice flag should
key on; the safe reply window and content after an inbound text with an
unchecked box; whether the web form's disclosure supports emailing the
follow-up; Ohio and Kentucky telemarketing, text and quiet-hour rules (the
TODO-JO slot).
