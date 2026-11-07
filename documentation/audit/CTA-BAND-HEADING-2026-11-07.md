# Mid-page call-to-action band: heading was 17px on every service page (2026-11-07)

Overnight visual pass, 2026-11-07. Swept all 331 public pages at 320, 375, 768
and 1280 px: no horizontal overflow anywhere, and the only small tap targets
are inline citation links inside sentences (NOAA, Census, Terms), which are
exempt from the target-size rule. Then looked at screenshots page by page.

## Finding

The "Skip the runaround" band on the 18 service pages that carry
`.service-midpage-cta` rendered its Bebas Neue heading at about 17 px. The
global `main h3, section h3` rule in `docs/assets/css/nbd-readability.css`
sets `font-size` with `!important`, which beat the band's own clamp
(1.75 rem to 2.5 rem, no `!important`). On a phone the heading read like body
copy under the eyebrow.

Four pages (`financing`, `emergency-roof-tarping`, `fire-water-smoke-damage`,
`roof-care-plan`) still carry the older inline-styled version of the band, which
also had dark orange (`#BD5728`) on navy for the eyebrow and heading accent and
two buttons of different widths.

## Fix

Appended to `docs/assets/css/service-mobile-polish.css` (loaded by all 18
pages): the heading restores the clamp with `!important`; the four old bands
get the light orange (`#DD875F`, the value the `.svc-mid` pages already use),
equal 52 px buttons, and full-width stacked buttons on phones. No markup
changed, no copy changed.

Measured: heading 28 px on a 390 px phone and 40 px at 1280, up from 16.8 and
17.3.

## Not done

- The phone emoji on the old bands' call button renders dull red on orange.
  Fixing it means swapping it for an icon, which is a markup change on four
  pages; left for a later pass.
