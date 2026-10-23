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
- Not done on purpose: surfacing "tomorrow's non-negotiable" on the next day's page. Cheap follow-up if Jo wants it.
