// tests/e2e/phone-oaks-intake.spec.js — the Oaks tenant site's quote form,
// on a phone, posting to OUR lead intake (2026-10-04).
//
// The Oaks site (docs/sites/oaks/) used to open the visitor's mail app, with a
// commented-out FormSubmit relay as the upgrade. It now posts through
// window.submitPublicLead (docs/assets/js/public-lead-submit.js) tagged
// siteKey 'oaks', so the lead lands in the Oaks company's CRM; the mail app is
// only a last resort when the intake fails.
//
// NOTHING IS REALLY SUBMITTED. Every request that leaves the local server is
// intercepted in the browser: submitPublicLead is fulfilled here (captured,
// never forwarded), the Turnstile script is replaced by a stub that hands back
// a fixed token, and anything else off-host is aborted and recorded. A public
// lead posted to a running functions emulator sends REAL alert SMS/email, so
// this spec refuses to run against anything but a local server, and it fails
// if the browser ever tried to reach a submitPublicLead it did not intercept.
//
// Phone scale: 390x844 with touch, the size Jo tests on. Tagged @shard2.
// Local run (from tests/, hosting emulator only — no functions):
//   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
//     npx firebase emulators:exec --only hosting --project nobigdeal-pro \
//     "PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 npx playwright test e2e/phone-oaks-intake.spec.js"
'use strict';

const { test, expect } = require('@playwright/test');

const BASE = process.env.PLAYWRIGHT_BASE_URL || '';
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(BASE);

const TURNSTILE_STUB = [
  'window.turnstile = {',
  '  render: function (box, o) { window.__oaksTs = o; window.__oaksTsKey = o.sitekey; return "w1"; },',
  '  reset: function () {},',
  '  execute: function () { setTimeout(function () { window.__oaksTs.callback("e2e-oaks-token-0123456789"); }, 20); }',
  '};',
].join('\n');

async function wire(page, { status }) {
  const seen = { leads: [], offHost: [], leaked: [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    if (u.pathname === '/submitPublicLead' && req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: {
        'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type' } });
    }
    if (u.pathname === '/submitPublicLead') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      seen.leads.push({ url: req.url(), method: req.method(), body });
      return route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(status === 200 ? { success: true, id: 'e2e-oaks' } : { error: 'Submission failed' }),
      });
    }
    if (u.hostname === 'challenges.cloudflare.com' && /\/turnstile\/v0\/api\.js/.test(u.pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: TURNSTILE_STUB });
    }
    seen.offHost.push(u.hostname);
    return route.abort();
  });
  // A request that reached the network without passing through the route
  // above would be a real submit — fail loudly if one ever appears.
  page.on('requestfinished', (req) => {
    if (/submitPublicLead/.test(req.url()) && !seen.leads.some((l) => l.url === req.url())) seen.leaked.push(req.url());
  });
  return seen;
}

async function fillForm(page) {
  const form = page.locator('form[data-orc-form]').first();
  await form.locator('input[name="first_name"]').fill('Pat');
  await form.locator('input[name="last_name"]').fill('Tester');
  await form.locator('input[name="email"]').fill('pat@nbd.test');
  await form.locator('input[name="phone"]').fill('(513) 555-0142');
  await form.locator('input[name="zip"]').fill('45122');
  await form.locator('select[name="service"]').selectOption('Roof Repair');
  await form.locator('textarea[name="message"]').fill('E2E — intercepted, never sent');
  return form;
}

test.describe('Oaks tenant site — quote form posts to our own intake @shard2', () => {
  test.skip(!LOCAL, 'local server only — a public lead must never be posted to a live intake');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('submit lands on submitPublicLead tagged for Oaks, with a Turnstile token', async ({ page }) => {
    const seen = await wire(page, { status: 200 });
    await page.goto('/sites/oaks/contact.html');
    await expect.poll(() => page.evaluate(() => typeof window.submitPublicLead)).toBe('function');

    const form = await fillForm(page);
    await form.locator('[type="submit"]').tap();
    await expect(form.locator('.orc-form-msg')).toContainText('request is in', { timeout: 15_000 });

    expect(seen.leaked).toEqual([]);
    expect(seen.leads).toHaveLength(1);
    const lead = seen.leads[0];
    expect(new URL(lead.url).hostname).toBe('us-central1-nobigdeal-pro.cloudfunctions.net');
    expect(lead.method).toBe('POST');
    expect(lead.body).toMatchObject({
      kind: 'contact', siteKey: 'oaks', source: 'tenant-site:oaks',
      firstName: 'Pat', lastName: 'Tester', email: 'pat@nbd.test', phone: '(513) 555-0142',
      zip: '45122', service: 'Roof Repair', nbd_hp: '', turnstileToken: 'e2e-oaks-token-0123456789',
    });
    expect(lead.body).not.toHaveProperty('companyId');
    expect(await page.evaluate(() => window.__oaksTsKey)).toBe('0x4AAAAAAEqcVVOXW3xyusXQ');
    // Nothing third-party besides the (stubbed) Turnstile script and the intake.
    expect(seen.offHost.filter((h) => !/^fonts\.(googleapis|gstatic)\.com$/.test(h))).toEqual([]);
    // The form fits the phone: no sideways scroll at 390px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('intake failure falls back to the mail app and never shows NBD’s number', async ({ page }) => {
    const seen = await wire(page, { status: 500 });
    await page.goto('/sites/oaks/contact.html');
    await expect.poll(() => page.evaluate(() => typeof window.submitPublicLead)).toBe('function');

    const form = await fillForm(page);
    await form.locator('[type="submit"]').tap();
    await expect(form.locator('.orc-form-msg')).toContainText('opened your email app', { timeout: 15_000 });
    await expect(form.locator('.orc-form-msg')).toContainText('(513) 827-5297');

    expect(seen.leaked).toEqual([]);
    expect(seen.leads).toHaveLength(1);
    await expect(page.locator('.nbd-lead-fallback')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toMatch(/859\) 420-7382|Call or text Joe/);
    // The visitor's typing is kept for a retry.
    await expect(form.locator('input[name="first_name"]')).toHaveValue('Pat');
  });
});
