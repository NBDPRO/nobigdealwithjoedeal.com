# Recent Google reviews, with dates, on every homeowner page — 2026-10-24

Jo, 2026-10-24: "Can we wire the reviews system for all homeowner pages to show the most recent ones? And their dates?"

## Before

- The reviews system already existed end to end: `getGoogleReviews` (`functions/google-reviews.js`) serves `/api/google-reviews`
  from the Places cache or the daily GBP full set, newest first (`functions/google-reviews-display.js`), and
  `docs/assets/js/google-reviews-widget.js` renders up to six cards into `[data-nbd-google-reviews]`.
- Only 20 of the ~250 homeowner pages had a container: the home page, `/review` and the 18 service hubs. The 44 area pages,
  48 our-work pages, 32 blog posts, 7 guides and the funnel pages (`/inspect`, `/estimate`, `/storm-check` …) showed no reviews.
- A card showed only Google's relative wording ("2 weeks ago"), never the date, although both server paths carry `time` (unix seconds).

## What changed

1. **One shared partial,** `site-src/partials/reviews-strip.html`: a "Recent Google reviews" section (container + the widget
   script, `defer`), with a link to `/review`. It writes no rating or count; every number comes from the live payload, so the
   honest-count rules (`no-hardcoded-rating-2026-10-16`, `homeowner-honesty-schema-reviews`) hold.
2. **Stamped on 229 pages** through `apply-partials.js`, as the last block inside `<main>`, before the footer. The 48 our-work
   detail pages carry it from the `build-projects.mjs` template. Four funnel pages that loaded the widget by hand for their
   trust line now load it through the partial (the hand-placed tag was removed, so nothing loads twice).
3. **Dates on every card.** The widget renders `<time datetime="2026-10-12">Oct 12, 2026</time> · 2 weeks ago`. A missing,
   unparseable or future `time` renders the relative wording alone, never a wrong day. The widget also guards against running
   twice on one page.
4. **Not on:** legal and utility pages (`/privacy`, `/terms`, `/sms-program`, `/search`, 404, offline), `/careers` and
   `/partners` (not written for homeowners), and the internal `/tools` hub. Each is named in the test, so adding one is a visible decision.

## Guard

`tests/reviews-strip-every-homeowner-page-2026-10-24.test.js` (node bucket): every homeowner page has one container and loads
the widget once; pages outside the hubs carry the partial rather than a hand copy; the named pages carry none; the widget's
`reviewDate()` and `renderReviewCard()` run against sample payloads (seconds, numeric strings, milliseconds, bad and future times).

## Checked by eye

Area, blog, guide, funnel and our-work pages at 390 px and 1280 px through the test hosting server with a stubbed payload:
six cards, dates on each, no sideways scroll, no console errors, one widget request per page.

## Open

- The strip uses inline style attributes (the widget already does; every public page's CSP allows them). If the marketing
  CSS ever drops `'unsafe-inline'` for styles, move the strip's rules into a stylesheet with the widget's.
- The Places path returns at most 5 reviews; the GBP sync provides the full set. "Most recent" is only as fresh as that
  sync (daily) while the Places cache (120 s) covers the rest.
