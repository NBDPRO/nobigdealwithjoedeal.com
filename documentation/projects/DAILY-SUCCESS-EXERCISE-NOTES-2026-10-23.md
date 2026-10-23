# Daily Success: per-exercise notes in the workout coach (2026-10-23)

Second of five queued tracker features (the first was the end-of-day review).

## What shipped
- Each lift card in the coach has a "Note for next time" field. The next time that lift is on the screen, the card shows
  "📝 Last time (Oct 20): left shoulder off at RPE 8" under the existing Last-time line.
- Notes are capped at 160 characters, control characters stripped, escaped on render. Saved on `change` (leaving the field),
  never per keystroke, so a phone keyboard is not fought. Works fully offline; no voice, no network at write time.
- Storage `nbd_ds_coach_notes`: `{ exId: { 'YYYY-MM-DD': text } }`, six dated notes per lift, 200 lifts. Synced through the
  existing settings path (`userSettings.dsCoachNotes`, one `SETTINGS` row; no rules change).
- Files: `js/exercise-notes-logic.js` (pure), `noteHtml` + an `exnote` branch in `onField` in `js/workout-coach.js`, two CSS
  lines in `css/workout-coach.css`. Test: `tests/tracker-exercise-notes-2026-10-23.test.js`.

## Decisions
- "Last time" is the newest note dated before today, so a note typed today never hides an older one until it is itself history.
- Clearing the field removes only today's note; earlier notes stay.
- Notes follow the lift id, so swapping to another lift shows that lift's own history, not the old one's.
