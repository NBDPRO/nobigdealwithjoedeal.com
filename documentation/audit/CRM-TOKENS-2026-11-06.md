# CRM orange tokens — 2026-11-06

This is part of the [overnight CRM audit](CRM-AUDIT-HARNESS-2026-11-06.md). It covers VW-F162 (part) and PL-F22.

The CRM's orange buttons were a hard-coded `#BD5728 → #A14A22` gradient. The affected places are the install-nudge buttons, the CSV import buttons, the duplicate-lead "Create" button and Photo AI's button. Another company's CRM showed NBD's orange on them. The gradient is now `var(--orange)` → `color-mix(in srgb, var(--orange) 85%, #000)`. **For NBD this produces the same pixels:** 85% of `#BD5728` toward black is exactly `#A14A22`, and the test asserts that.

PL-F22: the pipeline's hidden-stage banner and its focus glows fell back to `#ea580c` / `rgba(234,88,12,…)`, an orange from the family the palette retired. They now use `var(--orange,#BD5728)` and its `color-mix` tints.

`tests/crm-tokens-2026-11-06.test.js` passes 11/11, and 10 of the 11 checks fail on main. No inline style attributes are added, and the ratchet is still 2079.

**Not changed:**
- `email_system.js` (VW-F162's other half), which waits on #2981.
- The fill modal's fixed hexes (VW-F61), because #2985 edits the same function.
- The D2D and prospect disposition colours (VW-F20). Leaflet path styles can't take `var()`, so those need a resolved-colour helper.
- `ai-tool-finder` `activeColor` (VW-F106). That config is never read, so it is dead code, mentioned here and not deleted.
