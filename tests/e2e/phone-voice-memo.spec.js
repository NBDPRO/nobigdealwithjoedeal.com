// tests/e2e/phone-voice-memo.spec.js — the card-detail Voice Memo button on a
// phone (390x844), 2026-10-04.
//
// transcribeVoiceMemo used Deepgram only, whose key was the deploy stub, so
// in prod the button always toasted "Voice transcription not configured".
// The callable now uses Groq (the provider dictate already uses); its server
// behaviour is pinned in tests/voice-memo-groq-2026-10-04.test.js. This spec
// pins the client half on a phone: a real tap records from Chrome's fake
// microphone, a second tap stops it, the clip goes to transcribeVoiceMemo
// with this lead's id, and the rep sees "Memo saved". The callable is
// answered by page.route, so no transcription vendor is ever called (in CI
// a callable can resolve to production — ci-e2e-calls-production-functions).
//
// One login, one seeded lead (tagged e2eTestData, deleted in afterAll).
// Tagged @audit to ride the authed emulator job's audit shard.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(process.env.PLAYWRIGHT_BASE_URL || '');

// A fake microphone so MediaRecorder records for real (phone-chrome.spec.js
// idiom; keeps the config's pinned-Chromium escape hatch).
test.use({
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

test.describe.serial('phone voice memo @audit', () => {
  test.describe.configure({ timeout: 90_000 });
  let creds = null;
  let ctx;
  let page;
  let leadId = null;
  const calls = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    try { creds = requireTestUser(); } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[phone-voice-memo] ' + e.message);
      return;
    }
    const u = testInfo.project.use || {};
    ctx = await browser.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://nobigdealwithjoedeal.com',
      serviceWorkers: 'block',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: UA,
      permissions: ['microphone'],
      ...(LOCAL ? { bypassCSP: true } : {}),
      ...(u.proxy ? { proxy: u.proxy } : {}),
      ...(u.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    });
    page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
        const today = new Date().toISOString().split('T')[0];
        localStorage.setItem('nbd_proactive_overdue_scan', today);
        localStorage.setItem('nbd_proactive_pending_estimate_scan', today);
      } catch (e) { /* storage blocked */ }
    });
    // Answer the callable in its wire format and record what the client sent.
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    await page.route('**/transcribeVoiceMemo', (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      let body = null;
      try { body = JSON.parse(route.request().postData() || 'null'); } catch (_) { /* recorded as null */ }
      calls.push(body && body.data);
      return route.fulfill({
        status: 200, headers: cors, contentType: 'application/json',
        body: JSON.stringify({ result: { success: true, transcript: 'Check the ridge vent on the north side.', confidence: null, words: 8 } }),
      });
    });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => window._user && window._user.uid && typeof window._loadLeads === 'function'
      && typeof window.addDoc === 'function' && window._leadsLoaded, { timeout: 60_000 });
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

    const stamp = Date.now();
    leadId = await safeEvaluate(page, async (s) => {
      const uid = window._user.uid;
      const companyId = (window._userClaims && window._userClaims.companyId) || uid;
      const ref = await window.addDoc(window.collection(window.db, 'leads'), {
        firstName: '[E2E] Memo', lastName: String(s), address: `${String(s).slice(-3)} Memo Ln, Milford, OH`,
        phone: '513' + String(s).slice(-7), stage: 'new', deleted: false, userId: uid, companyId,
        createdAt: window.serverTimestamp(), e2eTestData: true,
      });
      await window._loadLeads();
      return ref.id;
    }, stamp);
    expect(leadId, 'seeded lead has an id').toBeTruthy();
  });

  test.afterAll(async () => {
    if (page && leadId) {
      await safeEvaluate(page, async (id) => {
        try { await window.deleteDoc(window.doc(window.db, 'leads', id)); } catch (_) { /* best effort */ }
      }, leadId).catch(() => {});
    }
    if (ctx) await ctx.close();
  });

  test('tap Voice Memo, tap again to stop: the clip goes to transcribeVoiceMemo for this lead and the rep sees "Memo saved"', async () => {
    test.skip(!creds, 'no test user');
    await safeWaitForFunction(page, () => typeof window.goTo === 'function', { timeout: 30_000 });
    await safeEvaluate(page, () => window.goTo('crm'));
    await safeWaitForFunction(page, () => typeof window.openCardDetailModal === 'function' && !!document.getElementById('cardDetailModal'), { timeout: 30_000 });
    await safeWaitForFunction(page, () => !!window.NBDVoiceMemo && typeof window.NBDVoiceMemo.recordForLead === 'function', { timeout: 30_000 });
    await safeEvaluate(page, (id) => window.openCardDetailModal(id), leadId);
    await safeWaitForFunction(page, () => document.getElementById('cardDetailModal').classList.contains('open'), { timeout: 10_000 });

    const btn = page.locator('.cd-voice-btn[data-fn="cdaVoiceMemo"]');
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeVisible();
    // Reachable by a finger at 390px: the button itself is what a tap lands on.
    const hit = await btn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { ok: !!h && (h === el || el.contains(h)), right: r.right, vw: innerWidth };
    });
    expect(hit.ok, 'Voice Memo button is the tap target at 390px').toBe(true);
    expect(hit.right, 'Voice Memo button fits the 390px screen').toBeLessThanOrEqual(hit.vw);

    await btn.tap();
    await expect(btn, 'first tap starts recording').toHaveClass(/recording/, { timeout: 10_000 });
    await page.waitForTimeout(1_500); // a clip long enough to pass the client's 1KB floor
    await btn.tap();
    await expect(btn, 'second tap stops; the button settles once the memo is saved').not.toHaveClass(/recording/, { timeout: 20_000 });

    expect(calls.length, 'exactly one transcribeVoiceMemo call for one memo').toBe(1);
    const sent = calls[0] || {};
    expect(sent.leadId, 'the memo is filed on THIS lead').toBe(leadId);
    expect(typeof sent.audioBase64 === 'string' && sent.audioBase64.length > 1000, 'a real recorded clip was uploaded').toBe(true);
    expect(sent.mimeType, 'the recorder\'s mime type rides along (Groq names the upload from it)').toMatch(/^audio\/(webm|mp4)/);
    await expect(page.getByText('Memo saved').first(), 'the rep is told the memo was saved').toBeVisible({ timeout: 5_000 });
  });
});
