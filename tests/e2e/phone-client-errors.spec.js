// tests/e2e/phone-client-errors.spec.js — a phone error reaches the server (2026-10-04).
//
// Installed-iPhone size, 390 × 844. An uncaught error thrown in the signed-in
// dashboard produces exactly ONE POST to /api/client-error, even when the same
// error fires twice. The request is intercepted in the browser, so nothing
// reaches production. The payload carries page / build / a uid HASH, and
// never the raw uid or the user's email.
//
// The reporter is off on 127.0.0.1 and under automation by design (CI E2E
// calls production functions), so the spec opts in with
// window.__NBD_CLIENT_ERRORS_LOCAL before the page loads.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

test.describe('phone: client error reporting @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('a thrown error in the page produces one /api/client-error call', async ({ page }) => {
    test.setTimeout(120_000);
    const reports = [];
    await page.route('**/api/client-error', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        try { reports.push(JSON.parse(req.postData() || '{}')); } catch (_) { reports.push({ unparsable: req.postData() }); }
      }
      await route.fulfill({ status: 204, body: '' });
    });
    await page.addInitScript(() => {
      window.__NBD_CLIENT_ERRORS_LOCAL = true;
      try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (_) {}
    });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.NBDClientErrors && typeof window.NBDClientErrors.report === 'function'), null, { timeout: 60_000 });
    const uid = await safeEvaluate(page, () => window._user.uid);

    // The same uncaught error, twice (one bug, one report).
    await page.evaluate(() => {
      const boom = () => { throw new TypeError('e2e client-error marker for jo@example.com'); };
      setTimeout(boom, 0);
      setTimeout(boom, 50);
    });

    const mine = () => reports.filter((r) => /e2e client-error marker/.test(r.message || ''));
    await expect.poll(() => mine().length, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(1500);
    expect(mine().length, 'the repeat is deduped — still one call').toBe(1);

    const r = mine()[0];
    expect(r.kind).toBe('error');
    expect(r.page).toBe('dashboard');
    expect(r.build).toMatch(/^loader-\d+$/);
    expect(r.uidHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.online).toBe(true);
    expect(typeof r.standalone).toBe('boolean');
    expect(r.message, 'the email in the message is scrubbed').toContain('[email]');
    const raw = JSON.stringify(r);
    expect(raw.includes(uid), 'the raw uid is never sent').toBe(false);
    expect(raw.includes(creds.email), 'the user email is never sent').toBe(false);
    expect(raw.includes('jo@example.com')).toBe(false);
  });
});
