# Daily Success: morning readiness check-in (2026-10-23)

Third of five queued tracker features. Recon came first because readiness already existed.

## What already existed (not touched)
- `workout-coach-logic.js`: `readiness(rec)` (sleep / soreness / energy, each 1 to 3; total 4 or less is low, 8 or more is good),
  `applyReadiness` (a rough day drops one set on lifts with 3+ untouched working sets and holds a weight that was about to go
  up) and `undoReadiness`. Good days change nothing.
- `workout-coach.js`: the three-row check-in at the top of the coach screen, stored in `nbd_ds_coach_ready`
  (`{ 'YYYY-MM-DD': { sleep, sore, energy } }`, this device only). Starting a workout the same day carries the stored answer over.
- `layout-logic.js`: only a blurb on the unbuilt Cockpit layout.

## What was missing, and now shipped
- The check-in only appeared once a workout was already open. Now a **Morning check-in** card sits under the Today bar on
  today's page: three rows of three chips, a "Not today" link, 10 seconds. It writes the coach's own store in the same shape, so
  the coach applies a rough-day plan when the workout starts. No second copy of the scoring.
- Never nags: shown only on today's page before 5 pm (the day wrap-up takes the evening); unanswered it just disappears;
  "Not today" is remembered for the date; after the three taps it shows one sentence ("Readiness 6/9 - steady day. Your plan
  stays as it is.") with a Change link. Nothing blocks and nothing changes until a workout is started.
- Files: `js/checkin-logic.js` (pure), `js/checkin-ui.js`, `css/checkin.css`, phone rules in the last `<style>` block. Test:
  `tests/tracker-readiness-checkin-2026-10-23.test.js`, including a check that the row labels match the coach's.

## Notes
- Device-only, like the coach's own store: it is not added to the settings sync (the original design kept it local).
- A workout already in progress still shows its own in-coach check-in; this card does not rewrite a live session.
