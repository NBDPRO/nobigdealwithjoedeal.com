# CRM views P3, batch D — 2026-11-06

This batch is part of the [overnight CRM audit](CRM-AUDIT-HARNESS-2026-11-06.md) and has four fixes. Each fix has checks in `tests/views-p3d-2026-11-06.test.js` that run the shipped function. The suite passes 16/16 with the fixes and fails all 16 against main.

| Finding | What was wrong | Fix |
|---|---|---|
| PL-F28 | The pipeline list view read `Number(l.jobValue)`, so a legacy `'$45,000'` showed "—" and sorted as 0. The board read 45000 through the money reader (`crm-list-view.js`). | The list view uses the same money reader the board uses (`NBDCustomerEstimateRows.moneyValue`, with the same fallback). It applies to the sort, the table and the phone cards. |
| VW-F166 | If the saved AI texting persona failed to load, defaults showed silently, and Save then wrote them over the stored persona (`ai-texting-persona.js`). | A failed load is recorded, and the tab says so. Save is refused with a reason until the page reloads. |
| VW-F15 | Every Call Center action (Handled, attach) re-rendered the list, which destroyed a recording that was playing. Recording blob URLs were never freed (`call-center-view.js`). | `render()` lifts any player out before the rebuild and puts the same element back into the call's new row, so playback continues. The blob URLs are revoked on `pagehide`. |
| VW-F56 | Docs template rows and category headers were mouse-only `<div data-action>`. The fill modal had no Escape, focus trap or focus return, its labels were not tied to their fields, and the × had no name (`dashboard-ui.js`, `document-generator.js`). | Rows and headers are now in the Tab order, and Enter or Space opens them. Headers get `role="button"`. Rows hold their own Blank button, so they get no role, which avoids nesting one button inside another. The fill modal calls `nbdOverlay.attach`, so Escape does what Cancel does, and every label has a `for=`. |

**Not changed:** the "Joe Classic" persona preset label, which every company sees (the other half of VW-F166). The label is product copy, so it is left for Jo. There are no new inline styles (the ratchet is still 2079), and the boot budget is unchanged because every file here loads deferred or lazily.
