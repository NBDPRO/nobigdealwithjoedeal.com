# Benefit strip under the hero stacked in a jagged column on desktop (2026-11-07)

Found in a 1440 px screenshot of `/services/roof-care-plan`: the four benefit
items under the hero (Yearly Inspection, Touch-Ups Included, Priority After
Storms, Condition Report) stacked vertically, each centered at a different
x, burning about 350 px of height.

Cause: six service pages put the `.trust-item` blocks directly inside
`.trust-bar` with no `.trust-bar-inner` wrapper (`financing`,
`fire-water-smoke-damage`, `hail-damage-insurance-claim`, `roof-care-plan`,
`roof-cleaning-soft-wash`, `roof-inspection`). The flex row lives on
`.trust-bar-inner`, so without it the items were plain blocks. The other service
pages have the wrapper and show one row.

Fix: a `min-width: 901px` rule at the top of
`docs/assets/css/service-mobile-polish.css` that makes a wrapper-less
`.trust-bar` a flex row (`:not(:has(.trust-bar-inner))`), content width capped
near 1120 px. Phones keep the stacked list, which reads fine there. No markup
changed. Measured on all six pages at 1440, 1024 and 390: one row at 1440 and
1024, four rows at 390 (unchanged), no horizontal overflow. Strip height at
1440 drops from about 350 px to 81 to 117 px.
