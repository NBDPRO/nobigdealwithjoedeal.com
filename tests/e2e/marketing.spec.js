// @ts-check
// Marketing (top-of-funnel) smoke tests. Verifies the homepage, privacy
// page, and service pages load — the pages that drive SEO + paid traffic.

const { test, expect } = require('@playwright/test');

test('Homepage renders hero + nav', async ({ page }) => {
  await page.goto('/');
  // Hero H1 is the conversion anchor — if it's missing, design is broken.
  await expect(page.locator('h1').first()).toBeVisible();
  // Nav exists with at least 1 anchor to /pro (CTA to the product). The
  // footer links the canonical "/pro" (trailingSlash: false) since 2026-10-14.
  const proLinks = page.locator('a[href="/pro"], a[href^="/pro/"]');
  expect(await proLinks.count()).toBeGreaterThanOrEqual(1);
});

test('Privacy page loads', async ({ page }) => {
  const resp = await page.goto('/privacy');
  expect(resp?.status()).toBe(200);
  await expect(page.locator('h1')).toBeVisible();
});

test('robots.txt exists and disallows nothing critical', async ({ request }) => {
  const r = await request.get('/robots.txt');
  if (r.status() === 404) {
    test.skip(true, 'robots.txt not present');
    return;
  }
  const body = await r.text();
  // A Disallow: / rule would tank SEO for the whole site — loud alarm.
  expect(body).not.toMatch(/^Disallow:\s*\/\s*$/m);
});

// Accessibility (axe-core, 2026-10-16): the two pages that book inspections.
// Fails on serious/critical WCAG 2.x A/AA violations; moderate/minor ones are
// attached to the report. axe is injected as a script, so THIS block's context
// bypasses the page CSP (fixtures/axe.js). Third-party requests are cut so
// the scan never waits on Turnstile, GA or Clarity.
test.describe('accessibility: homepage and /inspect (axe)', () => {
  const { expectNoSeriousA11y } = require('./fixtures/axe');
  test.use({ bypassCSP: true });
  for (const [label, url, ready] of [
    ['homepage', '/', 'h1'],
    ['inspect', '/inspect', '#inspectSubmit'],
  ]) {
    for (const [w, h] of [[1280, 800], [390, 844]]) {
      test(`${label} at ${w}px has no serious or critical axe violations`, async ({ page, baseURL }, testInfo) => {
        await page.setViewportSize({ width: w, height: h });
        const origin = new URL(baseURL || 'http://127.0.0.1:5000').origin;
        await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
        await page.goto(url);
        await expect(page.locator(ready).first()).toBeVisible();
        await page.waitForLoadState('load');
        await expectNoSeriousA11y(page, testInfo, { label: label + '-' + w });
      });
    }
  }
});
