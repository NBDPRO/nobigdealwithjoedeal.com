# Overnight 2026-11-06: /pro tour panels are not `<article>`

The last axe finding on the public NBD Pro pages was on `/pro/` (the landing page): `aria-allowed-role`, "ARIA role tabpanel is not allowed for
given element" on `#step-estimate`. The five "one job, start to finish" tour panels were `<article class="pl-step" role="tabpanel">`, and `article`
does not allow that role. They are now `<div class="pl-step" role="tabpanel">` (same classes, ids and `aria-labelledby`; no CSS or script selects on
the `article` tag; both elements are block-level, so nothing renders differently). axe at 390 and 1280 px: `/pro/` is clean. Together with the contrast
change this leaves every public Pro page axe-clean apart from `region` best-practice notes. Back to [INDEX](../INDEX.md).
