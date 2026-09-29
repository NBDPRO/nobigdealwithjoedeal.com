# Calendar hub plan — 2026-09-29

**Status:** plan only. Nothing here is built yet. It needs Jo's sign-off on the
§6 questions before any code is written.

**Jo's ask (2026-09-29):** join his regular calendar, his Cal.com bookings and
his daily job schedule into one place, with "flawless running function with no
overlap or issues". The homeowner page should also show a scheduled block
("you're scheduled for this day / this window").

**Decision already made:** Google Calendar is the hub (Jo picked it over building
our own). Do not relitigate this.

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
