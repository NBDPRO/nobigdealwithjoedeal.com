// @ts-check
/**
 * tests/e2e/phone-estimate-funnel.spec.js — a phone visitor finishes the
 * /estimate instant-estimate funnel with NO text code (2026-10-03).
 *
 * The funnel produced 3 leads ever: Submit stayed disabled until a texted code
 * was verified, and the Twilio trial delivered 0 texts. This drives the real
 * page at 390x844 end to end — address the map can't find → "use as typed" →
 * project → ballpark → first name + phone + consent → Submit → the results
 * screen's optional "help Joe prepare" answers — and checks what was POSTed.
 *
 * 2026-10-13 (Twilio A2P 30909): the phone field and the SMS consent box now
 * sit on step 1. The first assertions below run with NO interaction — they are
 * what a campaign reviewer who opens /estimate sees on first paint.
 *
 * EVERY network call off the local server is intercepted here. The page's
 * gateway URL is the PRODUCTION Cloud Functions host; an unintercepted submit
 * would file a real lead and page Jo (memory: an emulator submitPublicLead once
 * sent him a real SMS + email). So: the spec refuses to run against anything
 * but a local server, routes are installed before the first navigation, and
 * any request that reaches no stub is aborted and fails the test.
 */
const { test, expect } = require('@playwright/test');

const BASE = process.env.PLAYWRIGHT_BASE_URL || '';
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(BASE);
const GRANT = 'c'.repeat(48);

// Stand-ins for the CDN modules the page imports (firebase) and loads
// (Turnstile). The fake Turnstile hands back a token, like the invisible widget.
const FIREBASE_APP = 'export function initializeApp() { return {}; }';
const FIREBASE_FNS = 'export function getFunctions() { return {}; }\n' +
  'export function httpsCallable(f, name) { return async () => { (window.__callables = window.__callables || []).push(name); return { data: { success: true } }; }; }';
const TURNSTILE = 'window.turnstile = { render: function (el, cfg) { window.__tcfg = cfg; return 1; }, execute: function () { var c = window.__tcfg; setTimeout(function () { c.callback("e2e-turnstile-token"); }, 10); }, reset: function () {} };';

test.describe('phone estimate funnel — no text code @shard3', () => {
  test.skip(!LOCAL, 'local server only — this spec must never drive the live funnel');
  test.use({ viewport: { width: 390, height: 844 } });

  test('a visitor completes the funnel with first name + phone + consent', async ({ page }) => {
    const posts = { submitPublicLead: [], updatePublicLeadIntake: [] };
    const unexpected = [];
    const origin = new URL(BASE).origin;

    await page.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.startsWith(origin)) {
        if (/\/api\/google-reviews/.test(url)) return route.fulfill({ json: { rating: 5, total: 29, reviews: [] } });
        // The SDK is same-origin since 2026-10-04 (/assets/vendor/firebase/<ver>/) — stub it here.
        if (/\/assets\/vendor\/firebase\/[\d.]+\/firebase-app\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_APP });
        if (/\/assets\/vendor\/firebase\/[\d.]+\/firebase-functions\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_FNS });
        return route.continue();
      }
      const fn = (url.match(/cloudfunctions\.net\/([A-Za-z]+)/) || [])[1];
      if (fn === 'submitPublicLead' || fn === 'updatePublicLeadIntake') {
        posts[fn].push(JSON.parse(req.postData() || '{}'));
        return route.fulfill({ json: fn === 'submitPublicLead' ? { success: true, id: 'e2e-lead-1', photoToken: GRANT } : { success: true, crm: true } });
      }
      if (fn) return route.fulfill({ status: 404, json: {} }); // saveFunnelProgress / publicFunnelAI / publicRoofMeasure
      if (/nominatim\.openstreetmap\.org/.test(url)) return route.fulfill({ json: [] }); // the map finds nothing
      if (/gstatic\.com\/firebasejs\/.*firebase-app\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_APP });
      if (/gstatic\.com\/firebasejs\/.*firebase-functions\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_FNS });
      if (/challenges\.cloudflare\.com\/turnstile/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: TURNSTILE });
      if (/googletagmanager\.com|fonts\.(googleapis|gstatic)\.com|clarity\.ms/.test(url)) return route.fulfill({ body: '' });
      unexpected.push(url);
      return route.abort();
    });

    await page.goto('/estimate');

    // First paint, no clicks: the opt-in is on screen, unchecked, with the
    // disclosure and BOTH policy links beside it.
    await expect(page.locator('#step1')).toHaveClass(/active/);
    const consent = page.locator('#tcpaConsent');
    await expect(page.locator('#phoneNumber')).toBeVisible();
    await expect(consent).toBeVisible();
    await expect(consent).not.toBeChecked();
    const consentLabel = page.locator('label[for="tcpaConsent"]');
    await expect(consentLabel).toBeVisible();
    await expect(consentLabel).toContainText('Message frequency varies');
    await expect(consentLabel).toContainText('Message & data rates may apply');
    await expect(consentLabel).toContainText('Reply STOP to opt out, HELP for help');
    await expect(consentLabel).toContainText('Consent is not a condition of purchase');
    await expect(consentLabel.locator('a[href="/privacy#sms-terms"]')).toBeVisible();
    await expect(consentLabel.locator('a[href="/terms"]')).toBeVisible();
    const box = await consent.boundingBox();
    const labelBox = await consentLabel.boundingBox();
    expect(Math.max(box.height, labelBox.height), 'consent tap target >= 44px').toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 'no sideways scroll on first paint').toBeLessThanOrEqual(0);

    // Continue without consent is refused and does not tick the box for them.
    await page.locator('#addressInput').fill('12 Nowhere Rd, Mason OH');
    await page.locator('#firstName').fill('Pat');
    await page.locator('#phoneNumber').fill('5135550100');
    await page.locator('#step1 [data-step="2"]').click();
    await expect(page.locator('#step1')).toHaveClass(/active/);
    await expect(consent).not.toBeChecked();
    await expect(page.locator('#tcpaConsent-err')).toBeVisible();

    // Step 1 — an address the map cannot match.
    await consent.check();
    await page.locator('#step1 [data-step="2"]').click();
    const useTyped = page.locator('#btnUseTyped');
    await expect(useTyped).toBeVisible({ timeout: 10_000 });
    await useTyped.click();

    // Step 3 (the satellite step is skipped for a typed address).
    await expect(page.locator('#step3')).toHaveClass(/active/);
    await page.locator('#step3 [data-group="service"] .tile[data-value="roof-repair"]').click();
    await page.locator('#step3 [data-group="timeline"] .tile[data-value="few-weeks"]').click();
    await page.locator('#btnStep3').click();

    // Step 4 → 5.
    await expect(page.locator('#step4')).toHaveClass(/active/);
    await page.locator('#step4 [data-step="5"]').click();
    await expect(page.locator('#step5')).toHaveClass(/active/);

    // Step 5 — no code to wait for, and nothing asked twice: the recap names
    // who it is going to and Submit is already live (consent was given on step 1).
    await expect(page.locator('#btnSendCode')).toBeHidden();
    await expect(page.locator('#otpSkip')).toBeHidden();
    await expect(page.locator('#step5 .nbd-trust-line')).toContainText('on Google · Fully insured · Joe on every roof');
    await expect(page.locator('#contactRecap')).toContainText('Pat');
    await expect(page.locator('#contactRecap')).toContainText('(513) 555-0100');
    await expect(page.locator('#step5 #phoneNumber')).toHaveCount(0);
    const submit = page.locator('#btnSubmit');
    await expect(submit).toBeEnabled();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'no sideways scroll on the contact step at 390px').toBeLessThanOrEqual(0);
    await submit.click();

    // Results.
    await expect(page.locator('#stepResults')).toHaveClass(/active/, { timeout: 15_000 });
    expect(posts.submitPublicLead.length).toBeGreaterThanOrEqual(1);
    const lead = posts.submitPublicLead[0];
    expect(lead).toMatchObject({ kind: 'estimate', firstName: 'Pat', phone: '(513) 555-0100', tcpaConsent: true, wantsFollowUp: true, address: '12 Nowhere Rd, Mason OH' });
    expect(lead.turnstileToken).toBe('e2e-turnstile-token');
    expect(lead.scheduling).toBeUndefined();

    // The optional questions, saved onto the same lead with the grant.
    const follow = page.locator('#estFollowUp');
    await expect(follow).toBeVisible();
    await page.locator('#estIBestTime').selectOption('Evening');
    await page.locator('#btnFollowUp').click();
    await expect(page.locator('#btnFollowUp')).toHaveText('Sent ✓');
    expect(posts.updatePublicLeadIntake).toEqual([{ token: GRANT, bestTime: 'Evening' }]);

    // Step analytics reached GA's queue.
    const events = await page.evaluate(() => (window.dataLayer || [])
      .map((a) => Array.prototype.slice.call(a))
      .filter((a) => a[0] === 'event')
      .map((a) => [a[1], a[2] || {}]));
    const steps = events.filter((e) => e[0] === 'funnel_step').map((e) => e[1].step);
    expect(steps).toEqual(expect.arrayContaining([1, 3, 4, 5, 6]));
    expect(events.some((e) => e[0] === 'funnel_address_unmatched' && e[1].reason === 'no_match')).toBe(true);

    expect(unexpected, 'every off-box request was stubbed').toEqual([]);
  });
});
