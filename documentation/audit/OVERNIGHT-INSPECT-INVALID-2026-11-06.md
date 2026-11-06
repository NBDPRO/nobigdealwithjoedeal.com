# Overnight 2026-11-06: /inspect marks every invalid field

Submitting `/inspect` (the main lead form) empty on a phone showed one error message under the name field and a red-ish
focus ring on that field only. `inspect-form.js` already sets `aria-invalid="true"` on every bad field (name, address,
phone), but nothing styled it, so the address and phone looked fine. `docs/inspect.html` now styles
`.form-row input[aria-invalid="true"]` with the page's existing error colour (`#7f1d1d`, already used for the error text),
and `inspect-form.js` (v=9) clears `aria-invalid` on a field as soon as the person edits it; submit re-checks. Measured with
Playwright: after an empty submit all three fields are `true` with a `rgb(127, 29, 29)` border; typing in the name flips only that
one to `false`. The two tests that pin the script's cache-buster (`inspect-cro-draft`, `inspect-error-placement`) now expect v=9
(same assertion shape). `/free-roof` has the same silent-field gap, but its handler is a generated extract (`inline/0a394536a8.js`,
"do not edit by hand"), so it is left alone. Back to [INDEX](../INDEX.md).
