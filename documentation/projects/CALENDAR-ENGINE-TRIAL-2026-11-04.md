# Calendar engine trial — EventCalendar, 2026-11-04

**Status:** trial only. Nothing in the CRM uses this yet. The trial page runs
on sample data and is not linked from anywhere.

**Why:** the GitHub repo sweep (`documentation/audit/GITHUB-REPO-SWEEP-2026-11-04.md`, [PR #2832](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2832))
ranked [vkurko/calendar](https://github.com/vkurko/calendar) ("EventCalendar")
as the calendar engine to try. It's MIT, has free resource-timeline (crew)
views, ships as a standalone file, and has no framework. FullCalendar was
rejected: it injects `<style>` tags and needs a per-response nonce, and its
resource views are paid.

## What main already has (so this is NOT a greenfield calendar)

- **Schedule view** (`dashboard.html` `#view-schedule`): Today timeline (`smart-calendar.js`), Plan Jobs list (`schedule-planner.js`), ICS feed, Google "NBD Jobs" sync, and Cal.com setup.
- **Crew layout** (`js/layouts/crew.js`, ~1,000 lines, [CREW-CALENDAR-LANE](CREW-CALENDAR-LANE-2026-10-12.md)) is an optional layout. It has crew lanes, drag with Undo, rain hatching, warnings and the drawer.
- **What's missing** is a plain month / week / day / list view of **jobs + adjuster meetings + Cal.com bookings together** in the default Schedule view. That's the gap the engine would fill.

## What was added (branch `feat/calendar-trial-eventcalendar`)

| File | What |
|---|---|
| `docs/assets/vendor/event-calendar/` | v5.18.1 standalone build, byte-identical to npm (`event-calendar.min.js` sha256 `31318d0a…3810`, `.css` `d01c61b0…584c`; npm integrity `sha512-DtVr1lcy…GAsjwQ==`), plus the MIT `LICENSE.txt`. About 133 KB min / 44 KB gzipped. |
| `docs/pro/js/schedule-ec-events.js` | Pure adapter: leads, adjuster meetings and appointments become events. It reuses `NBDScheduleWindow` and follows the `.ics` / Google feed rules exactly. |
| `tests/schedule-ec-events-2026-11-04.test.js` | 33 checks. They run the same fixtures through the adapter **and** `functions/calendar-feed-logic.js` and compare day and time, including DST days, midnight crossings, deleted, cancelled and contradictory windows, and the week plan. Pinned to `Pacific/Auckland`. Break-tested: dropping the exclusive all-day end and halving the default appointment length reddened 5 checks. |
| `docs/pro/calendar-trial.html` + `js/calendar-trial.js` + `css/calendar-trial.css` | The sandbox page at `/pro/calendar-trial`. It has `noindex`, and dragging only reports what *would* save. |

## Results

**CSP (the deciding question):** passed under both policies. It was served with
the real `/pro` header from `firebase.json` by a small static server, because
the hosting emulator ignores headers.

- **Bundle audit:** no `eval`, no `new Function`, no `<style>` injection, and no `style="…"` in its templates. Styles are set through the CSSOM (`el.style.setProperty`), which `style-src` does not govern.
- **Network:** its only `fetch` is for remote event sources, which we don't use.
- **innerHTML:** used only for its own compiled templates and for the `html` content option, which we never pass. Titles go in through `textContent` / `domNodes`.
- **Enforced `/pro` policy:** zero `securitypolicyviolation` events across Month, Week, Day, List and Crews.
- **Stricter Report-Only policy** (`style-src 'self'`, no `'unsafe-inline'`), *enforced* in the test: also zero violations, and it renders normally. So it won't block the planned CSP tightening.
- **Trusted Types:** it creates its own `svelte-trusted-html` policy when available. We don't set `trusted-types` today. If we ever do, that policy name must be allow-listed.

**Phone (375 px):** no sideways scroll on the page. List view is the right
phone default and opens on it. Week view at phone width is cramped (seven
columns of about 30 px), so on phones offer Day and List only.

**Drag:**
- Mouse drag works in week and crew views.
- **A multi-day project moved one day keeps its length and its 7 am start, and a crew change sets `subId`.** That's the same field set the crew layout writes.
- iPhone touch was not tested here (no real device). The daylight iPhone test still applies before any drag ships.

**Crews view:** `resourceTimelineWeek` with `slotDuration: {days: 1}` gives a
lane per sub and a column per day, much like the crew layout's board. The
default hourly slots make one day several screens wide, so always set day
slots.

## Bugs the trial caught (keep these in any real build)

1. **Date read-back trap.** EventCalendar parses our wall-clock strings as *browser-local* time and returns ordinary local `Date`s. Reading them with `getUTC*` turned a 1 pm drop into 18:00 on an EST machine. Use the local getters. This is the same family as the `new Date('YYYY-MM-DD')` trap.
2. **A custom event body loses the time label**, and the library passes all-day events a "12:00 AM" `timeText` anyway. Show the time only when `!event.allDay`.
3. **Crew timeline needs day slots** (see above).

## Recommendation

Adopt it for **the missing combined view**: a Month / Week / List panel in the
Schedule view, read-only at first. Every event comes from `schedule-ec-events.js`,
so the board can't disagree with Jo's phone.

**Don't** rebuild the crew layout on it. That layout already has rain,
warnings, permits, Undo and the drawer, and it works. Revisit only if
maintaining `crew.js` becomes a cost.

Next steps, in order:
1. Mount a read-only panel in `#view-schedule` (lazy-load the vendor files only when the view opens).
2. Feed it real `leads` and `appointments` and CRM-booked events (`leads/{id}/tasks` type `event`; mirror `leadEventToAppointment`).
3. Tap an event to open the customer.
4. Drag only after the iPhone daylight test, writing through `NBDScheduleWindow.check` like Plan Jobs.

## Open

- The page loads the library from `/assets/vendor/`, which also serves public pages. That's fine, but keep it out of any homeowner page.
- Bump by hand (no Dependabot for vendored files). Check the changelog for CSP regressions on each bump.
