# Crew Calendar (layout L06) — build log, 2026-10-12

Lane "crew-calendar" of the CRM style roadmap. Spec: Grok's Drive doc "NBD CRM
custom layouts" (L06), verified against the tree; foundation and conventions:
[CRM-LAYOUTS-LANE-2026-10-11](CRM-LAYOUTS-LANE-2026-10-11.md). The schedule
model it sits on: [CALENDAR-HUB-PLAN-2026-09-29](CALENDAR-HUB-PLAN-2026-09-29.md)
(job = start day + length; warn, never block).

## What it is

Layout id `crew`, picked in Settings > Appearance > Layouts like the others
(lazy: `js/layouts/crew.js` + `css/layouts/crew.css` + the shared kit load only
while it is active; the registry entry in `layout-system.js` is the only
always-loaded change, 11 lines). Every surface; on a phone it opens on the Day
view and the week grid scrolls sideways inside its own region.

| Piece | Behaviour |
| --- | --- |
| Lanes | one per active sub on the company roster (`companies/{tenant}/subs`, sorted by name); a crew named only in `lead.crew` text gets its own lane; "No crew yet" is always last. A retired sub only appears while a job still uses it |
| Blocks | one per scheduled job across its days (start + `scheduledEndDate`), clipped to the week, stacked in rows. Colour = `color-mix(<crew colour> 22%, var(--s))` + a solid 4px left edge. Flags in words: Double-booked, Rain, Showers, No permit |
| Move | pointer-event drag from anywhere (mouse) or the grip (touch, so the page still scrolls); arrow keys on a focused block (left/right = a day, up/down = a crew); the drawer's day / crew / start / days fields and Day earlier / later. A multi-day block is held by the day you grabbed. Every move shows an Undo toast |
| Unscheduled tray | exactly Plan Jobs' "Needs a date" rows + upcoming week-only plans (`NBDSchedulePlanner.rowsFor`), dragged onto a crew and day |
| Rain | days hatched from `getJobWeather` (weather.gov, already cached server-side; reached through `NBDProduction.loadWeather`). A day shows the WORST level across jobs. Owner / company_admin only, like the rest of that callable; for anyone else nothing is hatched |
| Drawer | schedule fields + warnings + Google busy check (`NBDGoogleCalendarUI.checkRow`), permit state, material orders (store, status, delivery, first items; no prices exist on orders), access/crew notes, Open customer, Navigate, "Rain day..." (the existing rain-push sheet) |
| Day | per-crew stops in time order with on-site minutes and straight-line miles between stops that have a GPS point |

## What it writes

ONE `updateDoc(leads/{id})` per move, of exactly the fields the Plan Jobs row
writes: `scheduledDate, scheduledStart, scheduledDurationMin, scheduledEndDate,
scheduledWeek` and, when the crew changes, `subId` + `crew`. Every window goes
through `NBDScheduleWindow.check` first (the gate firestore's
`scheduleWindowOk` mirrors), so `onLeadCalendarWrite` keeps syncing Google
Calendar unchanged. No new field, no new collection, no function.

## Warn, never block

A drop on a rain day, a weekend, a past day, a crew already on another job
those days, an expired or missing insurance certificate, an unfiled permit on
committed work, or a material delivery after the start day ALWAYS saves. The
reasons show in a notice under the top bar and in the drawer, and the Google
busy check is appended when the CRM can reach it. Two timed single-day jobs for
one crew that do not overlap in time (9 am and 2 pm) are not a clash.

## Left out, and why

- **Route map in Day view** — waits for the shared MapView component (the
  mission-control lane's PR had not landed on `origin/main` when this was
  built; no open PR named it). Day view says so on the page instead of
  growing a second map.
- **Drive time and billable hours** — no routing or time-clock source exists
  in the CRM. The Day view shows straight-line miles (haversine on the lead's
  `lat/lng`), labelled as such, and on-site time only for jobs that carry a
  length; jobs without one are counted ("+ 1 with no set length"), never guessed.
- **Editing permit and crew notes in the drawer** — shown read-only; they are
  edited where they live (the job's Production panel, `accessNotes`,
  `permit*`). "Crew notes" has no field of its own beyond `accessNotes`.
- **"Move to Crew Scheduled?" stage offer** — Plan Jobs offers it after a date
  save; the drag does not (a stage move is a separate decision, and the
  offer needs the lead's track). Use Plan Jobs or the pipeline.
- **A job's second and later jobs** (`leads/{id}/jobs`) are not drawn: the
  board is the lead's active job, like Plan Jobs.
- Copy says crew / sub everywhere; crews are independent subcontractors.

## Verification

- `tests/layout-crew-2026-10-12.test.js` (60 checks; pinned to
  `Pacific/Auckland`, injected `today`). Break-tested: removing the timed
  exception reddens only "a 9 am and a 2 pm job ... NOT a clash"; dropping the
  end-date shift reddens the three move-length checks; removing the weekend
  warning reddens the weekend check and "every warning still SAVES"; letting
  "No crew yet" flag conflicts reddens its own check.
- `tests/e2e/crew-calendar.spec.js` (@shard2): lanes, drag day + crew (length
  and 07:00 start kept), arrow key, tray drop, weekend drop warns and saves,
  drawer save, no "employee / in-house" copy, block text contrast above 4.5:1 on
  Daylight and Midnight, phone 390 opens on Day with 56px targets and no
  sideways page scroll.
