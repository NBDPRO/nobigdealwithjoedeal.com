# Overnight 2026-11-06: /inspect header says the brand once (DRAFT, needs Jo's yes)

The `/inspect` topbar showed the logo image (which already reads "NO BIG DEAL ... Home Solutions") and then repeated "NO BIG DEAL / Home Solutions" as text
beside it; every other tool and booking page shows the logo alone. `tests/audit-small-fixes-2026-11-04.test.js` pinned that on purpose (empty logo alt, text carries
the name). This draft drops the text block and gives the image `alt="No Big Deal Home Solutions"`, so the link's accessible name is unchanged. The test keeps its
positive control and its negative assertion, restated for the new truth (name through the image alt; no separate wordmark repeating it). Measured at 390 and 1280 px:
one logo plus the call button, no overflow, axe `link-name`, `image-alt` and `image-redundant-alt` clean; every test referencing `/inspect` passes. It is a draft because it
changes the highest-converting page's header and rewrites a deliberate earlier test; close it to keep the old header. Back to [INDEX](../INDEX.md).
