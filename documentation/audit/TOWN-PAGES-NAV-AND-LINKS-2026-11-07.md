# Town pages: title-case nav and browser-default blue links (2026-11-07)

Found in a 1440 px screenshot of `/services/roof-replacement-mason-oh`.

## 1. Header nav was title case on 124 pages

The 124 `/services/<service>-<town>` pages carry an inline `.nav-links a` rule
with no `text-transform`, so the header read "Services  About Joe  Reviews"
while every other page type reads "SERVICES  ABOUT JOE  REVIEWS". The 45
`/areas/<town>` pages had the same bug and were fixed on 2026-11-06 with
`scripts/fix-area-nav-case.js`. A site-wide sweep (every non-CRM page at 1440)
shows these 124 were the only ones left; it is the same at 390 px.

## 2. Source links were the browser's default blue

The local-facts copy on both town page types links its sources (Wikipedia,
Census, NOAA storm events, city permit reports). Those anchors had no colour
rule, so they rendered in default `rgb(0,0,238)` blue: on the cream
`.local-box` panels, in the why-cards, the storm section, and, worst, inside
the dark photo hero, where blue on navy is hard to read. 124 of the 169 pages
had at least one. After the specific selectors below, 18 pages (the
roof-inspection and siding town pages) still had some in a generic
`.section-inner p` pattern, so that selector was added too.

## Fix

One scoped block at the end of `docs/assets/css/service-revamp.css` (loaded by
both page types; `nbd-nav-base.css` is byte-guarded by `ensure-nav-css.js`, so
it is not touched):

- `.nav-links > li > a { text-transform: uppercase }`. Pages that already
  uppercase are unaffected.
- classless anchors in `.local-box`, `.why-card`, `.why-section p`,
  `.storm-section`, `.sec-desc` and `.section-inner p`: `#A14A22` (the site's
  link colour on light) with an underline;
- classless anchors in `.combo-hero-content p`: `#DD875F` with an underline.

No markup changed. Before the generic `.section-inner p a` selector went in I
tallied its current colour site-wide: of 625 links, 590 were already `#A14A22`
and 33 were default blue (the ones being fixed); the other two are on
`/the-pledge/`, which does not load this stylesheet, so they cannot change.

## Checked

Zero plain default-blue links left on all 169 town pages (was 124 pages);
every non-CRM page's desktop nav is uppercase; screenshots of the nav, a
local-facts panel and the hero.
