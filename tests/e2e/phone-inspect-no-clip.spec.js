// @ts-check
/**
 * tests/e2e/phone-inspect-no-clip.spec.js — /inspect fits a phone screen
 * (2026-10-06, CRO review finding #1).
 *
 * At 375/390px the one-column hero grid computed to `411px`: the track was
 * `1fr` (= minmax(auto, 1fr)), so its floor was the min-content width of the
 * photo <input type=file> that js/intake-extras.js injects into the form.
 * body has overflow-x:clip, so nothing scrolled — the right 15-55px of the
 * hero copy, the inputs and the "Request Free Inspection" button were just cut
 * off. The fix is `minmax(0,1fr)` in the ≤880px block of docs/inspect.html.
 *
 * Asserts on the real rendered page, after the intake block has mounted:
 * the hero grid is no wider than the viewport, and the form panel, the photo
 * input, every visible form control and the Submit button end inside it.
 *
 * Local server only; every request off the local origin is aborted, so the
 * page can never reach the production lead gateway.
 */
const { test, expect } = require('@playwright/test');

const BASE = process.env.PLAYWRIGHT_BASE_URL || '';
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(BASE);

for (const [width, height] of [[375, 812], [390, 844]]) {
  test.describe(`phone /inspect fits ${width}px @shard2`, () => {
    test.skip(!LOCAL, 'local server only');
    test.use({ viewport: { width, height } });

    test(`hero + form are not clipped at ${width}px`, async ({ page }) => {
      const origin = new URL(BASE).origin;
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (!url.startsWith(origin)) return route.abort();
        if (/\/api\//.test(url)) return route.fulfill({ json: {} });
        return route.continue();
      });

      await page.goto('/inspect');
      // The overflow came from the injected intake block — wait for it.
      await expect(page.locator('#insPhotos')).toBeAttached({ timeout: 10_000 });
      await expect(page.locator('#inspectSubmit')).toBeVisible();

      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const right = (el) => (el ? Math.round(el.getBoundingClientRect().right) : null);
        const grid = document.querySelector('.hero-grid');
        const form = document.getElementById('inspectSubmit').closest('form');
        const controls = [...form.querySelectorAll('input,select,textarea,button')]
          .filter((el) => el.getClientRects().length && el.getBoundingClientRect().left >= 0)
          .map((el) => ({ id: el.id || el.name || el.type, right: right(el) }));
        return {
          vw,
          gridWidth: Math.round(grid.getBoundingClientRect().width),
          gridCols: getComputedStyle(grid).gridTemplateColumns,
          panelRight: right(document.querySelector('.form-panel')),
          photosRight: right(document.getElementById('insPhotos')),
          submitRight: right(document.getElementById('inspectSubmit')),
          heroRight: Math.max(...[...grid.children].map(right)),
          over: controls.filter((c) => c.right > vw),
        };
      });

      const why = JSON.stringify(m);
      expect(parseFloat(m.gridCols), why).toBeLessThanOrEqual(m.vw);
      expect(m.gridWidth, why).toBeLessThanOrEqual(m.vw);
      expect(m.heroRight, why).toBeLessThanOrEqual(m.vw);
      expect(m.panelRight, why).toBeLessThanOrEqual(m.vw);
      expect(m.photosRight, why).toBeLessThanOrEqual(m.vw);
      expect(m.submitRight, why).toBeLessThanOrEqual(m.vw);
      expect(m.over, why).toEqual([]);
    });
  });
}
