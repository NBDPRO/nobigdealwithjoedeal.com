# Daily Success: 60-second end-of-day review (2026-10-22)

First of five queued tracker features (queue brief from the Calendar/tracker plans session; recon in the shared side-session notes).

## What shipped
- A **Day wrap-up** card on each day page, just under the Daily Log section. Three optional answers: how the body feels
  (Rough / Okay / Strong), one business win or next action, tomorrow's one non-negotiable. Text is capped at 140 characters.
- **Never nags.** From 5 pm on *today's* page the questions show inline; at any other time (and on every past day) it is one
  quiet link, "Wrap up the day". "Not tonight" is remembered per date and the prompt does not come back; the link turns into
  "Add a day wrap-up anyway". No popup, no notification, nothing required, one answer is enough to save.
- **Storage:** `nbd_ds_eod` (`{ 'YYYY-MM-DD': { body, win, tomorrow, at } }`, last 120 days), device-local first, then the
  existing settings sync to `userSettings.dsEod` (one `SETTINGS` row in `ds-firebase-sync.js`; no rules change, userSettings
  already takes arbitrary fields). Works offline; no voice, no network at write time.
- **Weekly review:** the Sunday sheet shows "Day wrap-ups" (days answered of 7, body average, each win) for the seven finished
  days, and the copyable scorecard carries the same lines. Skips and today are excluded.
- Files: `js/eod-logic.js` (pure), `js/eod-ui.js`, `css/eod.css`, phone rules in the last `<style>` block of `index.html`;
  small edits to `review-logic.js` / `review-ui.js` (scorecard feed). Test: `tests/tracker-eod-review-2026-10-22.test.js`.

## Decisions
- Separate key rather than folding into `nbd_ds_reviews`: review-ui rewrites that store as `{goal, weeks}` and would drop an
  extra field.
- The prompt hour (17) lives in `PROMPT_HOUR`; tests fake `Date`, never the real clock.
- ~~Not done on purpose: surfacing "tomorrow's non-negotiable" on the next day's page. Cheap follow-up if Jo wants it.~~
  **Built 2026-11-09** (flow batch 3, audit Q12). See the update below.

## Update 2026-11-18: carry-forward is built

Found stale while planning the next Daily Success builds; checked in a phone-sized browser with a fixed clock (Wed 7:30 am, last
night's answer seeded), not only in the source.

- `NBDEod.carryForward(map, todayDk)` (`js/eod-logic.js`) returns yesterday's answered "tomorrow" text, or '' (only yesterday counts as
  last night; a skipped night has nothing to carry).
- On today's page, when the "Today's non-negotiable" box is empty, `carryHint` (`js/eod-ui.js`) shows "From last night: ..." with a
  **Use it** button. It never fills the box by itself; Use types it in and saves it like typing (the box is marked dirty, saved after
  800 ms).
- The Next-Up strip also queues it: `carry: From last night: ...` comes second, right after the Morning check-in, and its button fills the
  box even while the hint is hidden. Without a carried answer the queue has one item fewer.
- Shipped in [flow batch 3](SESSION-2026-11-09-ds-flow-batch-3.md) (#3032); the test is `tests/ds-flow-batch-3-2026-11-09.test.js`.
- One quirk, not a bug: the hint sits in the Mindset section, which is collapsed by default on a phone, so it is only visible after opening
  that section. The Next-Up strip is the path that surfaces it without opening anything.
