# Speed audit, 2026-11-04 (Lighthouse + Search Console)

Jo asked whether to work through a generic 21-item "your site is slow" checklist. The decision was to measure first and
fix only what the numbers show. This note is that measurement.

## Search Console field data

Core Web Vitals (apex URL-prefix property `https://nobigdealwithjoedeal.com/`) shows **"Not enough usage data in the
last 90 days" on both mobile and desktop.** No real-visitor data exists yet, so this lab run is the only signal.
Re-check once traffic grows.

## Lighthouse 12.6.0, live site, phone mode (simulated slow 4G), two runs per page

| Page | Perf | A11y | BP | SEO | FCP | LCP | TBT | CLS | Weight |
|---|---|---|---|---|---|---|---|---|---|
| Homepage | 82 / 77 | 100 | 96 | 100 | 1.6 s | 2.6 s | 391 ms | 0 | 1.26 MB |
| /inspect | 92 / 91 | 99 | 96 / 93 | 100 | 1.2 s | 2.1 s | 133 ms | 0 | 482 KB |
| /areas/milford-oh | 86 / 84 | 100 | 96 | 100 | 1.2 s | 1.9 s | 507 ms | 0 | 1.80 MB |
| Blog post (adjuster visit) | 99 / 98 | 100 | 96 | 100 | 1.3 s | 1.9 s | 92 ms | 0 | 321 KB |
| /our-work | 85 / 86 | 100 | 96 | 100 | 1.6 s | 2.8 s | 147 ms | 0 | 1.35 MB |
| CRM sample `/pro/explore/dashboard` | 55 / 52 | 96 | 96 | 54 (noindex, expected) | 11.8 s | 23.8 s | 0 ms | 0.012 | 615 KB, **653 requests** |

The homeowner pages are in good shape: LCP is under 2.5 s on four of five, there's no layout shift, and accessibility
and SEO are at 99 to 100. Every item from the checklist that's server-side (load balancer, CDN, connection pooling,
DB indexes, payload compression) is already covered by Firebase Hosting and Firestore.

## What is actually slow, ranked

1. **Google Analytics (`gtag.js`, 177 KB) on every homeowner page.** 250 to 500 ms of main-thread time per page
   (Our Work 503 ms, homepage 293 ms), and it's the "72 KB unused JavaScript" item on each page. It's the largest
   cause of TBT. Fix: load gtag after the page has loaded and gone idle, or on first interaction. The trade-off:
   a visitor who leaves within the first second or two isn't counted. **Jo's call.**
2. **Google review avatars load eagerly on every page.** `google-reviews-widget.js:100` builds five
   `lh3.googleusercontent.com` avatars, each served at 128 px for a 40 px slot and as JPEG, far below the fold. That's
   about 110 KB wasted per page view, on every page with the reviews strip. Fix: `loading="lazy"`, `decoding="async"`,
   `width`/`height`, and request `=s80` (2x of 40 px) instead of `=s128`. Safe, small.
3. **Project photos are bigger than their display size.** Our Work could save 621 KB (four gallery images, each about
   77 KB served for a slot that needs about 12 KB), and the Milford town page 194 KB. Fix: `srcset`/`sizes` in the
   `build-projects.mjs` card templates, plus smaller variants in the photo pipeline
   ([PUBLISH-PROJECT](../runbooks/PUBLISH-PROJECT.md)). Medium.
4. **The CRM loads 475 scripts and 155 stylesheets as separate files.** That's 169 KB of JS, but 653 requests, which
   at phone latency is what pushes the sample dashboard's first paint to 11.8 s. The real signed-in CRM loads the same
   files. The sample also bounces `/pro/explore/dashboard` → `/pro/explore?next=…` → back (about 4.3 s of redirects
   on a first visit, while the demo service worker installs). Fixing the request count means bundling, which is a
   real project with this repo's strict CSP, `window.*` globals and lazy bundles, so it needs its own plan. Related:
   perf-1 (CRM Home reflows at boot, [overnight program](OVERNIGHT-SITE-PROGRAM-2026-10-26.md)).
5. **Small items:**
   - The Google Fonts stylesheet blocks render on the CRM (594 ms).
   - The TAMKO badge is a 17 KB PNG that could be WebP (13 KB saved).
   - /inspect has an image whose alt repeats its caption (`image-redundant-alt`).
   - The CRM sample has a contrast failure on `#notifBadge` and one 404 in its console.

**Not a problem:** the "Content security policy" issue on every page is the `Content-Security-Policy-Report-Only`
header trialling a stricter `style-src`. It reports inline `style=""` attributes without blocking them, so nothing
is broken.

## How to re-run

`npx --yes lighthouse@12.6.0 <url> --form-factor=mobile --only-categories=performance,accessibility,best-practices,seo
--chrome-flags="--headless=new" --output=json`, two runs per page, median. Scores move ±5 between runs (the
homepage went 82 then 77).
