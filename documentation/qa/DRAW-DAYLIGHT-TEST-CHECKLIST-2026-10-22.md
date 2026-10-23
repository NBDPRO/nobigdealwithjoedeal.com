# Draw tool: daylight iPhone test checklist (2026-10-22)

For Jo. About 30 minutes, outside, on the installed home-screen app, in direct sun. Background and the reasoning are in [FIELD-TO-ESTIMATE-RECON-2026-10-22](../projects/FIELD-TO-ESTIMATE-RECON-2026-10-22.md) section 2.

**Set up (2 min).** Pull to refresh, then close and reopen the app. Draw → ☰ Tools → below Controls → switch on **Crosshair drawing (beta)**. Signing out resets the switch. Stand where you can see a real house. Brightness full.

Write pass or fail beside each:

1. Aim: can you see the crosshair and the snap ring in full sun, and read Add / Confirm?
2. Place, move, confirm: Add a corner, drag it to the true corner using the magnifier. Does the magnifier clear your thumb? Is 4x enough to see the roof edge?
3. Double tap Add fast: one point, not two.
4. Close a facet: is the area about length x width?
5. Second facet: the first must not double (the old 1,075 to 2,150 bug).
6. Lines: ridge, hip, valley, eave each get their own colour and feet.
7. Gutters: draw two runs; the second starts fresh, not chained to the first.
8. Edit mode: move a corner; undo, redo.
9. Structures: add a garage tab, draw it, go back; the house drawing is still there.
10. Cross-check against a vendor measure, if the lead has one.
11. Generate Estimate: rake lands as rake, valley as valley, drawn gutter feet price gutters once.
12. Lock the phone mid-drawing, switch apps and back, rotate: the drawing survives.
13. Glare, gloves, wet screen: any missed or wrong-button tap?
14. Measure step of the estimate wizard: tap the area field; it stays visible above the keyboard.
15. After 30 minutes: crosshair or tap-to-place?

**Go-live:** if 1 to 9 and 11 pass, set `CROSSHAIR_DEFAULT_ON = true` in `docs/pro/js/draw-reticle.js` (anyone who chose Off stays off). Any fail goes back as a note with its number.
