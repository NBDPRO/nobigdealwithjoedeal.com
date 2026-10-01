# Calendar hub plan — 2026-09-29

**Status (corrected 2026-09-30):** Phase 0 and Phase 2 are BUILT and live
(#1879, #1891, week-first scheduling the same evening; per-job events
2026-09-30). The updates below and at the end describe what shipped. Jo's §6
answers are recorded; Phase 1 (Cal.com ↔ Google) is Jo's settings click.

**Jo's ask (2026-09-29):** join his regular calendar, his Cal.com bookings and
his daily job schedule into one place, with "flawless running function with no
overlap or issues". The homeowner page should also show a scheduled block
("you're scheduled for this day / this window").

**Decision already made:** Google Calendar is the hub (Jo picked it over building
our own). Do not relitigate this.

> **Update 2026-09-29 (later) — Phase 2 built, a different route than §3 said.**
> No OAuth app (a calendar scope needs Google verification). The functions'
> service account OWNS an "NBD Jobs" calendar and shares it read-only with
> Jo's Google account; free/busy of Jo's main calendar is readable once Jo
> shares it ("See only free/busy") with the service-account email, which the
> Schedule view's Google Calendar panel shows. `functions/google-calendar.js`:
> setupGoogleCalendar, getGoogleCalendarStatus, getBusyTimes,
> onLeadCalendarWrite (per-lead, seconds), googleCalendarReconcile (nightly);
> the double-booking warning sits under both schedule pickers. Inert until
> Jo presses Connect. Requires the Calendar API enabled on the project.

## 1. Where things stand (recon, verified against the tree)

| Source | Where it lives today | Reaches Jo's phone calendar? |
|---|---|---|
| Cal.com bookings | `calcomWebhook` → `appointments/{id}` + a lead ([CALCOM-INTEGRATION](../audit/CALCOM-INTEGRATION-2026-08-25.md)) | Only through the ICS feed |
| Job install dates | `leads.scheduledDate` (a `YYYY-MM-DD` string with **no time and no window**), written from the customer page and `crm-stages.js` | Only through the ICS feed |
| Deal-room install date | `deals.scheduledInstallDate`, **never copied** to the lead | No |
| Adjuster meetings | Insurance-claim fields with **no date field at all** | No |
| Customer-page events | Merged into the Schedule view (#1860) | No |
| Jo's own Google calendar | Not read anywhere in the CRM | Yes (it *is* his calendar) |
| Yard-sign pickups | `yardSigns.dueAt` (#1874) | No; the daily push is the reminder |

There is already a working one-way bridge: `functions/calendar-feed.js`, a
secret `.ics` URL per rep that iOS subscribes to. Its limits:

- **Google refreshes subscribed ICS calendars only every 12–24 h.** A job moved at
  noon can still show the old day that evening.
- **Cal.com can't see ICS events as busy.** It checks conflicts against calendars
  it's *connected* to. So a customer can book an inspection on top of an install
  day. This is the "overlap" Jo is worried about, and today nothing prevents it.

The homeowner portal (`docs/pro/js/portal.js` `_scheduleLine`) already says
"Crew arrives Tuesday, October 6". It has no time window because the data has
none.

## 2. Target shape

```
             ┌──────────── Google Calendar (hub) ────────────┐
Cal.com ───► │  Jo's primary cal   ◄── Cal.com writes bookings │
 (checks     │  "NBD Jobs" cal     ◄── CRM pushes jobs (API)   │ ──► iPhone / any device
  busy on    │                                               │
  both)      └──────────────▲────────────────────────────────┘
                            │ free/busy read
                     CRM Schedule view (shows conflicts before you save)
```

- **Cal.com ↔ Google:** use Cal.com's built-in Google Calendar connection. It
  checks Jo's primary *and* "NBD Jobs" calendars for conflicts and writes each
  booking to Google. This is a settings change in Cal.com that Jo makes himself.
  No code.
- **CRM → Google:** a Cloud Function writes install days, adjuster meetings and
  other dated events into a dedicated **"NBD Jobs"** calendar through the Google
  Calendar API. It updates within seconds, not the next day. A separate calendar
  keeps CRM-owned events apart from Jo's personal ones, so a sync bug can never
  touch his personal events, and he can hide or show the calendar with one toggle.
- **Google → CRM:** read-only free/busy. The Schedule view and the date picker
  warn "Jo is busy 1–3 pm (Google)" *before* a job is saved over something.
  Event details are never copied into Firestore; only busy blocks are read.
- **Homeowner portal:** shows the date **and** a window ("Tuesday, Oct 6 ·
  arrival 8–10 am"). The window comes from new lead fields, never from Google.

## 3. Build phases (each ships alone, each is useful alone)

**Phase 0 — data fixes. No Google involved. Worth doing even if nothing else ships.**
1. Add arrival-window fields to the lead: `scheduledWindow: 'am' | 'pm' | 'all_day' | {start:'08:00', end:'10:00'}`.
   `scheduledDate` stays the single source for the day.
2. Sync `deals.scheduledInstallDate` → `leads.scheduledDate` in the existing
   deal-room sync. Only fill an empty field; never overwrite a date Jo typed.
3. Add an adjuster-meeting date and time to the insurance claim, so it shows on
   the Schedule view and in the ICS feed.
4. Portal: show the window next to the date. Keep `_scheduleLine`'s
   "past dates claim nothing" rule.
5. Tests: pure window formatter and deal→lead sync, both red-first.

**Phase 1 — Cal.com ↔ Google (Jo, about 5 minutes, no code).** In Cal.com, go to
Settings → Calendars → connect Google. Check conflicts against the primary
calendar (and "NBD Jobs" once it exists). Add bookings to the primary calendar. I
can walk through it in Jo's Chrome, but connecting accounts means granting OAuth,
which is Jo's click.

**Phase 2 — CRM → "NBD Jobs" (the main build).**
- OAuth: Jo authorizes a Google Calendar scope once from Settings →
  Integrations. The refresh token goes in Secret Manager or an encrypted
  per-user doc; never on the client.
- `onLeadScheduleWrite` trigger: when `scheduledDate`, the window, the stage or
  `deleted` changes, upsert or delete one Google event keyed by a stable id
  (`nbd-<leadId>-install`). Stable ids make retries idempotent, so there are no
  duplicate events.
- A nightly reconcile cron re-pushes anything whose `googleSyncedAt` is older than
  its `updatedAt`. This covers missed triggers.
- Kill switch plus a healthcheck row, same pattern as the other crons.

**Phase 3 — Google free/busy → CRM.** A callable `getBusy(from, to)` backs the
Schedule view overlay and the conflict warning in the date picker. Busy blocks
only; no titles are stored.

**Phase 4 — polish.** Yard-sign pickups as optional all-day events in "NBD Jobs";
crew-facing views; per-rep calendars for team tenants.

## 4. "No overlap" — what actually guarantees it

- Cal.com refuses a slot that's busy on either Google calendar (Phase 1 + 2).
- The CRM warns before saving a job on a busy day (Phase 3).
- Nothing can promise that a *human* won't double-book on purpose. The warning
  is a warning; Jo can still override it (rain days happen).

## 5. Risks and traps

- **OAuth verification:** a Google Calendar scope on a public OAuth app needs
  Google review. Keeping the app in "testing" with Jo as the only test user
  avoids that for the solo case. Multi-tenant rollout is a separate decision.
- **Time zones:** `scheduledDate` is a local date string. Never build it with
  `new Date('YYYY-MM-DD')` (UTC midnight; see the portal's comment). Every date
  sent to Google goes through one tested helper.
- **Deletes:** a soft-deleted lead must delete its Google event.
  [lead-artifact-cleanup](../../functions/lead-artifact-cleanup.js) is the place
  to hook this, so a purge can't strand events.
- **Keep the ICS feed:** it stays as the no-OAuth fallback and for team members
  who won't connect Google.

## 6. Questions for Jo (answer these before Phase 2)

1. **Arrival windows:** use AM/PM/all-day buttons, or exact times like "8–10"?
2. **Which events go to Google?** Recommended: install days, adjuster meetings
   and inspections. Optional: yard-sign pickups, follow-up reminders.
3. **The "NBD Jobs" calendar:** one for you now, or one per rep from the start?
4. **Conflict rule:** should the CRM *block* saving on a busy day, or just warn?
   Recommended: warn.

Phase 0 can start on a yes to this plan. It doesn't depend on any of the
answers above.

### Jo's answers (2026-09-29) — do not relitigate

1. **Windows depend on the job.** Large projects start early and run 1–2 days.
   Repairs, inspections and similar jobs take minutes to hours and can land at
   almost any time. So the model is **start time + length**, not AM/PM buckets:
   `scheduledStart` (`'07:00'`, optional) plus either `scheduledDurationMin` (for
   short jobs) or `scheduledEndDate` (for multi-day projects). Presets: "Full
   project" pre-fills 7:00 am and 1–2 days; "Repair / inspection" asks for a time
   and a length in minutes or hours. `scheduledDate` stays the day the job starts.
2. **Almost everything Jo needs to remember goes to Google.** That means install
   days, repairs, inspections, adjuster meetings and yard-sign pickups, and
   follow-ups when they carry a time.
3. **One "NBD Jobs" calendar, just for Jo, for now.**
4. **Warn; don't block.** When a customer books through Cal.com, the conflict
   must never be silent. The default setup already stops Cal.com offering a slot
   that's busy on either Google calendar. If a conflict still happens (for
   example, a job moved onto an existing booking later), the CRM alerts Jo, and
   Jo contacts the customer to reschedule. Any automatic "we may need to move
   your time" message to the customer is a separate decision, because the CRM
   never texts or emails homeowners on its own without Jo's say-so.

## Update 2026-09-29 (evening) — Plan Jobs + week-first scheduling

Google Calendar went live with **1 event**, which was correct: 1 of 247 leads
had a job date. Jo hadn't been scheduling in the CRM and asked for a fast way
to fill in the next month. Jo also asked to **book a week first and set the
day later**, with the homeowner told "the week of…".

- **Plan Jobs** is a new panel on the Schedule view (`js/schedule-planner.js`,
  with rules in `schedule-planner-logic.js`).
  - **Needs a date** lists committed jobs (Contract Signed through
    Installing, plus approved service and warranty visits) that have no
    date. A switch shows every open lead, and a search box narrows either
    list.
  - **Next 30 days** holds scheduled jobs, so they can be moved in place.
  - Each row sets a **Week of** *or* a **Date** + start + days. A save
    writes only the schedule fields, validated by
    `NBDScheduleWindow.check`.
  - Anything typed but not saved survives a background refresh.
- **`scheduledWeek`** is a new lead field holding the week's Monday, set
  only while there is no day. Setting a day clears it.
  - **Rules:** `scheduleWindowOk` shape-checks it.
  - **Google:** a **free** all-day Mon–Fri bar, "📆 Week of: name", on the
    job's own event id, so setting the day updates that event in place.
    `WATCHED` includes the new field.
  - **Portal:** "Your project is scheduled for the week of October 5 — We'll
    confirm your exact day as that week's schedule comes together, and we'll
    reach out before the crew arrives." It shows only while there's no day,
    and never once the week has passed.
  - **Now covered everywhere (follow-up PR, same evening):**
    - The customer page Edit modal (`#editScheduledWeek`) and the dashboard
      lead editor (`#lScheduledWeek`) set a week too, with the same rule: a
      day clears the week.
    - The .ics subscribe feed shows the Mon–Fri week bar. `normalizeLeadWeek`
      in `calendar-feed-logic.js` is shared with the Google sync, and it uses
      the job's own UID and event id.
    - `mondayOf` moved into the shared `schedule-window.js`, with both copies
      byte-identical.
- Tests: [schedule-planner](../../tests/schedule-planner-2026-09-29.test.js)
  (40 checks, including the portal wording run in a vm sandbox). The rules
  suite passed in full.
- Verified on the emulator:
  - Choosing Thu Oct 8 saved week-of Oct 5 and moved the row to Next 30
    days.
  - Refining to Oct 7, 2 days, 7:30 stored the end date Oct 8 and cleared
    the week.
  - The panel fits at 375px.

## Update 2026-09-30 — events per JOB (multi-job)

A customer can now have more than one job
([CRM-JOBS-AND-MONEY-PAPER-PLAN](CRM-JOBS-AND-MONEY-PAPER-PLAN-2026-09-30.md)).
Google events were keyed per LEAD, so a second job's date had nowhere to go.

- The customer's **active job** keeps the per-lead event ids (its fields live
  on the lead), so every existing event is untouched.
- Every **other** job with a date gets its own events, keyed by lead + job
  (`eventIdFor(kind, leadId, jobId)`; `/` can't occur in a doc id, so no
  collisions), titled "🔨 Name — <job title>", at the job's own property.
  Built from the lead with the job's fields laid over it
  (`jobs-logic.js jobView`, the same overlay the pipeline cards use).
- **`onJobCalendarWrite`** (`leads/{id}/jobs/{jobId}`) syncs those; the
  lead trigger re-syncs both jobs when a promotion swaps `activeJobId`; the
  nightly reconcile reads jobs by collection group.
- The double-booking check still skips the job being edited, but the same
  customer's OTHER job now counts as a clash.
- Found on the way: the job field list carried `adjusterMeetingTime`, a field
  nothing writes; the app writes `adjusterMeetingStart`, `adjusterName`,
  `adjusterPhone`. Fixed in both copies, so the mirror carries them and a
  promotion no longer leaves the old claim's adjuster on the card.
- The .ics subscribe feed is per job too (follow-up PR, same day): a
  customer's other job is fed in as the lead with that job's fields laid over
  it, id `leadId/jobId` (its own UID, `lead-<leadId>/<jobId>`), titled
  "Name — <job title>". The jobs read has its own try/catch, so a failure
  serves the customers' events instead of 503-ing the whole feed.
- Tests: [google-calendar-sync](../../tests/google-calendar-sync-2026-09-29.test.js)
  §7 (57 checks); break-tested ids, busy, overlay and the promotion swap.

## Update 2026-09-30 (late) — yard-sign pickups go to Google (§6 answer 2)

- **`onYardSignCalendarWrite`** (`yardSigns/{signId}`): a sign that is out
  (or scheduled) gets one all-day **FREE** event, "🪧 Pick up yard sign —
  <address>", on its New York pickup day. It's a to-do, so it never blocks
  Cal.com or trips the double-booking warning.
- Picked up, missing, removed or dateless → the event goes away.
- An overdue sign's reminder sits on **today**, "(overdue since …)". The
  nightly reconcile moves it each morning, so it never strands on a past day.
- The id is `nbds` + hex(signId), because Google ids allow only `[a-v0-9]`.
- The reconcile reads owner signs too. That is required, because `planSync`
  deletes every managed event it doesn't want. Break-tested: dropping signs
  from the reconcile wipes the reminder.
- **Superseded the same night — see the next update.** "Follow-ups when they carry a time": Lead
  follow-ups are date-only, so nothing qualifies. D2D knocks do carry
  `followUpDate` + `followUpTime`, but a re-knock writes a NEW knock doc and
  leaves the old follow-up behind. Pushing them needs a "latest knock per
  address wins" rule first, or Google fills with stale follow-ups. That's a
  decision for Jo.
- Tests: §8 of the same suite (16 checks).

## Update 2026-09-30 (night) — timed D2D follow-ups, the newest knock per door

Jo, 2026-09-30: "yes only the latest knock".

- **`onKnockCalendarWrite`** (`knocks/{knockId}`): the newest knock at a door
  decides that door's follow-up. "Newest" means the largest `createdAt`.
  - If the newest knock carries a follow-up date **and** a time, the door gets
    a 30-minute **BUSY** "📞 Follow up — <homeowner> · <address>" event at that
    New York time.
  - If the newest knock has no timed follow-up, the event goes away. A
    superseded follow-up never resurfaces.
- **Keyed per door:** `nbdk` + sha1 of the tracker's own `normalizeAddress`
  (lowercase, trim, collapsed spaces). A re-knock moves the event in place.
- **Spelling variants:** the trigger reads knocks by exact address, so the
  nightly reconcile is what merges spelling variants of one door.
- An address edit re-syncs both doors.
- Address-less (GPS-only) knocks are skipped.
- Date-only follow-ups stay off Google, per §6.2. They still get the morning
  push (`onFollowUpDue`).
- The reconcile reads owner knocks too (same `planSync` reason as the signs).
- Tests: §9 (16 checks). Break-tested: flipping "newest" reddens 6 checks,
  and dropping knocks from the reconcile reddens the reconcile check.
