// @ts-check
/**
 * Visual regression baseline.
 *
 * For each route + viewport pair below, Playwright takes a full-page
 * screenshot and diffs it against a committed baseline at
 * tests/e2e/visual-regression.spec.js-snapshots/{name}.png.
 *
 * First run on a new baseline: `npm --prefix tests run test:e2e:update`
 * (sets PLAYWRIGHT_UPDATE_SNAPSHOTS=1) writes the baseline images.
 * Subsequent runs compare against the committed baselines and fail
 * the build if any pixel differs beyond the configured threshold.
 *
 * The snapshots cover only PUBLIC pages (login, register, pricing,
 * landing). Authenticated screens require a signed-in session and
 * live in pro-authed.spec.js — visual regression for those is a
 * follow-up after the dev Firebase project lands (Joe-action #19).
 *
 * Why pixel-diff and not a string match
 *   - Catches CSS regressions like the "toolbar still tight" issue
 *     where the deployed CSS is correct but the rendered output
 *     doesn't match what we expected.
 *   - One screenshot covers font load, layout, animations, color,
 *     spacing simultaneously — no need to write 30 string assertions.
 *
 * Tuning
 *   - The pixel-diff threshold is generous (0.2 = 20% per-pixel
 *     tolerance) to absorb font subpixel rendering jitter across
 *     CI environments. Tighten when we have a dev Firebase project
 *     pinning Chromium versions.
 *   - We mask high-entropy regions (timestamps, dynamic counters)
 *     with the `mask` option to avoid false-positive flakes.
 */

const { test, expect } = require('@playwright/test');

const VIEWPORTS = [
  { name: 'mobile-375',  width: 375,  height: 812  },
  { name: 'tablet-768',  width: 768,  height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 800 },
];

const PAGES = [
  { path: '/pro/login',    name: 'login' },
  { path: '/pro/register', name: 'register' },
  { path: '/pro/pricing',  name: 'pricing' },
  { path: '/',             name: 'landing' },
];

// Same-origin /api/* responses these pages render, pinned to fixed payloads.
//
// WHY (2026-09-13): CI serves docs/ from the hosting emulator, but
// `emulators:exec --only hosting` leaves firebase.json's function rewrites
// pointing at PRODUCTION. When the Places secrets went live (~22:31Z), prod
// /api/google-reviews began returning real reviews, the landing page rendered
// five live review cards instead of the "Read our reviews on Google" fallback,
// and the page grew 1337px at mobile-375. Every commit's visual job went red
// with no code change (d7506665, docs-only). A baseline blessed against live
// Google data would break again with the next review.
//
// `{ reviews: [], total: 0 }` renders google-reviews-widget.js's fallback card
// (renderAll → renderFallback) and hydrates no rating hooks. That is the state
// the committed baselines were captured in, so no re-bless is needed. What the
// live cards look like is not a pixel-baseline question; their content is
// Google's.
const PINNED_API = {
  '/api/google-reviews': { reviews: [], total: 0 },
};
// Same default as playwright.config.js `use.baseURL`.
const SITE_ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'https://nobigdealwithjoedeal.com').origin;

for (const page of PAGES) {
  test.describe('visual regression: ' + page.name, () => {
    for (const vp of VIEWPORTS) {
      test(page.name + ' @ ' + vp.name, async ({ page: pw }) => {
        // Any same-origin /api/* call without a pinned payload fails the test
        // by name, instead of surfacing later as an unexplained pixel diff
        // driven by production data.
        const unpinned = [];
        await pw.route(
          (url) => url.origin === SITE_ORIGIN && url.pathname.startsWith('/api/'),
          (route) => {
            const p = new URL(route.request().url()).pathname;
            if (Object.prototype.hasOwnProperty.call(PINNED_API, p)) {
              return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PINNED_API[p]) });
            }
            unpinned.push(p);
            return route.continue();
          },
        );
        await pw.setViewportSize({ width: vp.width, height: vp.height });
        await pw.goto(page.path, { waitUntil: 'networkidle' });
        expect(unpinned, 'unpinned /api/* calls hit production during a visual test; add a fixed payload to PINNED_API').toEqual([]);
        // Wait for fonts to settle — 'networkidle' alone fires before
        // late font swaps land.
        await pw.evaluate(() => document.fonts && document.fonts.ready);
        // Disable animations + transitions during the screenshot so
        // mid-flight CSS effects don't randomize the diff.
        await pw.addStyleTag({
          content: '*, *::before, *::after { transition: none !important; animation: none !important; }'
        });
        // ...and freeze JS-driven content, which no CSS override can stop.
        //
        // WHY (2026-09-20): the homepage announcement bar rotates every 4s via
        // a bare `setInterval` in assets/js/inline/72f02d79d0.js — it moves
        // `.active` across four `.ann-slide`s. The style tag above does not
        // touch it, so two captures of the SAME commit differ by whichever
        // slide happened to be showing: identical page height, ~1KB of pixels.
        // Found on PR #1684, where landing--tablet-768 came back byte-stable in
        // 3 of 4 attempts and different in the 4th. Blessing the majority would
        // have committed a baseline that ~1 run in 4 could not match, and a
        // gate that reddens at random is a gate everyone learns to ignore.
        //
        // Clearing the timers rather than masking the bar keeps it INSIDE the
        // comparison, so a real regression in it is still caught. Parking the
        // rotator on slide 0 makes the frozen state the same one every run
        // instead of whichever slide won the race.
        await pw.evaluate(() => {
          const highest = setInterval(() => {}, 1 << 30);
          for (let i = 1; i <= highest; i++) { clearInterval(i); clearTimeout(i); }
          document.querySelectorAll('.ann-slide').forEach((s, i) => {
            s.classList.toggle('active', i === 0);
            s.classList.remove('exit');
          });
          // WHY (2026-11-26): the homepage hero's background loop (hero-video.js) starts on load + an idle slot,
          // which clearing timers does not stop, so every capture caught a different frame. On PR #3287 the three
          // CI captures of one commit differed by ~5% of pixels, over the 2% ratio. Pause every hero loop and
          // drop `is-playing`: the video goes back to opacity 0 and the hero shows its still photo, which is
          // exactly what reduced-motion and Save-Data visitors get. Transitions are off (style tag above), so the
          // fade-out is instant. play() is stubbed first because hero-video.js may still be waiting on its idle
          // callback (not a timer, so the loop above does not cancel it) and would start the loop after this.
          HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
          document.querySelectorAll('video[data-hero-video]').forEach((v) => {
            v.pause();
            v.classList.remove('is-playing');
          });
        });
        await expect(pw).toHaveScreenshot(page.name + '--' + vp.name + '.png', {
          fullPage:        true,
          maxDiffPixelRatio: 0.02,
          // Mask any element that legitimately changes between runs
          // (live timestamps, "as of" counters, ad creatives, etc.).
          // Add selectors here as flakes show up — easier than chasing
          // false positives in PR review.
          mask: [
            pw.locator('.live-timestamp'),
            pw.locator('[data-mask-visual]'),
          ],
        });
      });
    }
  });
}
