# Overnight 2026-11-06: town-page headers match the rest of the site (uppercase nav)

Reading 1440 px screenshots side by side showed the 45 `/areas/<town>` pages with a mixed-case desktop
header ("Services  About Joe  Reviews") while every other page type is uppercase ("SERVICES  ABOUT JOE
REVIEWS"). Cause: each town page carries its own inline `.nav-links a{...}` rule, and the uppercase
comes from a rule the town pages never had (computed `text-transform: none` there, `uppercase`
on `/about`, `/areas/`, `/blog/` and the service pages). `scripts/fix-area-nav-case.js` adds
`text-transform:uppercase` to that one rule on those 45 pages (dry run by default, `--apply`, `--check`;
keeps each file's line endings, idempotent). The inline rule sits outside every generator-owned region, so
`build-town-pages.mjs --check` is unaffected. Checked on `/areas/mason-oh` at 1025, 1100, 1280 and 1440 px:
the header stays 70 px tall, nothing wraps or overflows.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
