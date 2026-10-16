// @ts-check
// Public /pro/ surface smoke tests. These never require auth so they
// can run against production without credentials — ideal for catching
// "the whole app 404'd" regressions from a bad Pages deploy.
//
// Scope:
//   - /pro/login.html renders the Firebase-backed login form
//   - /pro/pricing.html renders 3 tier cards + subscribe CTAs
//   - /pro/instant-estimate.html (if present) renders the lead-magnet
//
// What we DON'T test here: any flow that requires `auth.currentUser`.
// Authenticated flows live in tests/e2e/pro-authed.spec.js (gated by a
// PLAYWRIGHT_TEST_USER secret that we haven't wired yet).

const { test, expect } = require('@playwright/test');

test.describe('Login page', () => {
  test('renders the email + password form', async ({ page }) => {
    await page.goto('/pro/login.html');
    await expect(page).toHaveTitle(/NBD Pro|Login|Sign/i);
    // Firebase Auth form uses standard input types; assert by type
    // rather than selector so a visual-refactor doesn't break us.
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
  });

  test('no console errors at load', async ({ page }) => {
    const errors = [];
    // 2026-09-14: offline-manager.js's nosw kill-switch (docs/pro/README-
    // killswitch.md) HEAD-checks /pro/nosw.txt on every load of a page that
    // registers the service worker, login.html included. That file exists
    // ONLY when someone has deliberately pulled the emergency kill-switch —
    // absent in every normal run, here and in production. A fetch() that
    // resolves 404 doesn't throw (the code already catches and degrades
    // gracefully), but Chromium still logs "Failed to load resource...404"
    // to the console for ANY non-2xx resource load, application code aside
    // — there's no way to suppress that browser-native entry without
    // dropping the existence check the kill-switch depends on. Track the
    // response directly so exactly this many "Failed to load resource"
    // console entries are tolerated; a genuinely unrelated 404 (broken
    // script/image/etc) still fails the test below.
    let expectedResourceFailures = 0;
    page.on('response', (res) => {
      if (res.status() === 404 && res.url().endsWith('/pro/nosw.txt')) expectedResourceFailures++;
    });
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('/pro/login.html');
    await page.waitForLoadState('networkidle');
    // Allow CSP violations in Report-Only to pass through; only hard
    // runtime errors should fail the build.
    const hard = errors.filter(e => !/Report Only|favicon|Service Worker registration/i.test(e));
    const resourceLoadFailures = hard.filter(e => /Failed to load resource.*404/i.test(e));
    const other = hard.filter(e => !/Failed to load resource.*404/i.test(e));
    expect(other).toEqual([]);
    expect(resourceLoadFailures.length, 'unexplained 404 console entries beyond the known nosw.txt check')
      .toBeLessThanOrEqual(expectedResourceFailures);
  });
});

test.describe('Pricing page', () => {
  test('renders all three tier CTAs', async ({ page }) => {
    await page.goto('/pro/pricing.html');
    // Each tier has a "Subscribe" or "Free Trial" CTA; two at minimum
    // (starter + growth). Enterprise is typically a Contact link.
    const ctas = page.locator('a.cta-primary');
    await expect(ctas.first()).toBeVisible();
    expect(await ctas.count()).toBeGreaterThanOrEqual(2);
  });

  test('subscribe click routes to login when signed out', async ({ page }) => {
    // Intercept the confirm() dialog that fires when user isn't signed in.
    page.on('dialog', d => d.dismiss());
    await page.goto('/pro/pricing.html');
    // Just verify the subscribe function is wired — click doesn't need
    // to complete; we only care that window.subscribe exists.
    // pricing-page.module.js assigns window.subscribe AFTER a top-level
    // `await connectEmulatorsIfLocal(...)` (dynamic SDK imports on 127.0.0.1),
    // and a module with top-level await does not hold back the load event that
    // goto() waits for. Reading it right after goto() raced that await and
    // failed on a slow runner (main run 38972362040). Wait for the module to
    // finish instead; a page that never wires subscribe still fails here.
    await page.waitForFunction(() => typeof window.subscribe === 'function', null, { timeout: 10_000 }).catch(() => {});
    const hasSubscribe = await page.evaluate(() => typeof window.subscribe === 'function');
    expect(hasSubscribe).toBe(true);
  });
});

test.describe('Instant Estimate lead magnet', () => {
  test('loads without redirecting to login', async ({ page }) => {
    const resp = await page.goto('/pro/instant-estimate.html');
    // If the page exists, it must serve 200 and NOT redirect to login.
    // If it doesn't exist on this build, skip rather than fail.
    if (!resp || resp.status() === 404) {
      test.skip(true, 'instant-estimate.html not present on this build');
      return;
    }
    expect(resp.status()).toBe(200);
    expect(page.url()).not.toContain('/login');
  });
});
