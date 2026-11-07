# Hero pill: the "●" dot sat alone on its own line on phones (2026-11-07)

Found while reading phone screenshots. `nbd-mobile.css` lets the eyebrow pill
above a service hero wrap (`flex-wrap: wrap !important`). The pill is
`inline-flex`, so its `::before` dot and its text are separate flex items, and
when the text is long the dot wrapped onto its own line above the words.

Three pages were affected at 390 px (pill height 59 / 59 / 45 px for what should
be two lines): `emergency-roof-tarping`, `fire-water-smoke-damage`,
`roof-cleaning-soft-wash`.

Fix: a phone-only rule at the end of `docs/assets/css/service-mobile-polish.css`
makes the pill `inline-block` (so short pills still hug their text), keeps the
dot inline with the first line, and rounds the corner to 16 px so a two-line
pill does not look like a capsule. Pill heights now 40 px on those three pages;
the single-line pills (financing, roof-care-plan) are unchanged at 26 px.
No markup or copy changed.
