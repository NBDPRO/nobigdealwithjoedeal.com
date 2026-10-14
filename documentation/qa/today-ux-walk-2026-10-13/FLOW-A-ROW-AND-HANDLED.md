# Today UX walk, fix A: the row and the Handled flow (2026-10-13)

Closes H1, M3, H3 and H4 of [FINDINGS](FINDINGS.md) (Jo: "we can do all 10").
Fix B (cold-boot banners, phone first screen, Undo on every action) is a
separate stacked PR. Server batching and label rails are other lanes.

## What changed

| Finding | Before | After |
|---|---|---|
| **H1** urgent call buried | A promise + an urgent missed call = one "Promised follow-ups" row with no urgent flag; Done wrote `handledAtMs` on both calls | Calls the row does not own ride inside it as their own call: `urgent`, `missed call`, count, and their own Handled. `callIds` (what Done / Tomorrow act on) is only calls carrying Jo's promise or whose `cube-` / `sms-` task is on the row |
| **M3** Done brings her back | "Done" on a row with another call riding in it read as "this person is done" | Label by what it closes: `Task done` (tasks on the row), `Promise done` (only the promised call), plain `Done` when nothing else rides in the row |
| **H3** Handled | Opened a sheet first; N serial writes; no busy state; error only on step 2 (`#prErr` missing on step 1); a second tap CLOSED the sheet mid-save | One tap handles every call of the person (parallel writes, one outcome), hides the row at once, 6 s Undo toast (`unhandled` per id). A failure names the count ("Only 1 of 2 calls saved") and puts the row back with the saved call not asked again. "I promised something" is the secondary button and opens the sheet |
| **H3** sheet | as above | busy state ("Saving..", chips disabled), error printed on step 1, a tap while saving is ignored (not a close), retry asks only for what did not save, rest-of-calls write failures after a saved promise are told |
| **H4** Call Center | Handled never re-read Home | `NBDHomeAttention.render(true)` after Handled / Not handled / Handled (all), plus an Undo toast; the deck has its own Undo (`quiet`, no second toast) |

## Decisions worth knowing

- **No batch callable.** `callCenterAction` takes one id (`functions/call-center.js`
  `callAction`); the server lane owns `functions/*`. The client sends the ids in
  parallel and reports one outcome. If the server lane adds `ids: []`, swap
  `setCalls()` in `today-home.js` and `nothingOwed()` in `promise-ui.js`.
- **A plain open call next to an unrelated due task is now a rider, not folded
  behind that task's Done.** `tests/today-plan-2026-10-03.test.js` encoded the
  old fold (`callIds[0] === 'cube_d1'` on a missed call); updated to the new
  contract, deliberately.
- **Riders are keyed `lead:<id>`** (the callerKey of the Calls-owed row it would
  have been), so handling the host row never hides it, and a handled host
  promotes it to its own row (existing promotion path).
- `ckept` ("Kept it" on a call promise) still has no Undo; that is fix B (M1).

## Evidence

- `tests/today-row-and-handled-flow-2026-10-13.test.js`: 59 checks, real files
  in a vm sandbox, failing first against the walk branch (every behaviour check red, the controls green).
  Break-tested: removing the stray fold reddens 14, the optimistic hide 3, the
  mirror rollback 2, the Undo toast 2, the busy guard (both layers) only
  together. Absence checks have positive controls (Done DOES handle the
  promise-carrying call; the stray's own Handled closes exactly that call).
- Emulator at 390x844 with the installed-app rules forced
  (`walk/flow.js all`, 16 of 16): Dana's row says urgent + missed call and
  Done leaves `cube_ux_dana_missed.handledAtMs` null while the promised call is
  handled; Handled is one tap with no sheet and an Undo that reopens the call in
  Firestore; a failed callable is told and the person returns; a Call Center
  Handled drops the strip count without a reload. Buttons measured at >= 44 px.
  Screens: `A-10..A-30-*.png`.

## Not verified

Real iPhone (daylight legibility, true safe-area, toast position over the
bottom nav, thumb reach of the new secondary button). Emulator functions only;
nothing touched production.
