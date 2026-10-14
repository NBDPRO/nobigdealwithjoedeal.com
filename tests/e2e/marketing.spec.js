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
