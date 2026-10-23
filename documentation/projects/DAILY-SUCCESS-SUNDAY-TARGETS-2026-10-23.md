# Daily Success: the Sunday review that acts (2026-10-23)

Fifth of five queued tracker features (built before the CRM-dependent fourth).

## What shipped
- The Sunday review sheet gets a **Next week's targets** block between the weigh-in and the accountability questions. It
  *proposes* from the week's real numbers and says why; every proposal has an explicit **Accept** button. Nothing is applied
  until that tap, and a proposal can only be applied once per sheet opening.
- **Workouts per week** (new coach setting `workoutsPerWeek`, 1 to 7):
  - no target yet and some workouts done: propose the week's count (clamped 2 to 6);
  - hit the target and floors are 70% or better (or unknown): propose one more (max 6);
  - missed by 2 or more: propose one less (min 2); a miss by one leaves it alone.
  The coach card now shows "Week: n/target workouts" (rolling 7 days) once a target exists.
- **Daily calories**: only when the existing weigh-in rule already says to cut. It then proposes the rule's number, unless
  fewer than 4 days of food were logged (note: log more first), the week averaged more than 150 over the target (note: hit the
  target first, lowering it will not help), or the number would fall under 1,200 (note: talk to a professional).
- **Floors** are advice only (a note under 60%); the floor list is never edited from here.
- Accepting writes `nbd_ds_coach` (workouts) or the calorie target in `nbd_ds_food` (same write the existing "Set calories"
  button makes), through the usual settings sync. Protein targets and favorites are preserved.

## Decisions
- Proposals are computed once when the sheet opens and held, so accepting a target does not immediately propose the next step.
- The coach's `settings()` now carries `workoutsPerWeek`; without that, saving any other coach setting would have dropped it.
- The existing "Set calories to N" button is left as it was (no refactor); the Accept row is the same number with the reasoning.
- No invented numbers: every figure comes from the inputs or the weigh-in rule; thin data produces a note, not a target.

Files: `js/weekly-targets-logic.js` (pure), edits to `js/review-ui.js`, `js/workout-coach.js`, `css/review.css`. Test:
`tests/tracker-sunday-targets-2026-10-23.test.js` (40 checks, 12 mutants killed).
