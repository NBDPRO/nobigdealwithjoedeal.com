// tests/e2e/estimate-send.spec.js — Send for review + estimate follow-ups on
// Jo's iPhone (390 × 844), 2026-10-03.
//
//   1. Customer page: an attached estimate PDF (the Drive-import shape — a
//      Storage download-token URL and nothing else) shows "📤 Send for
//      review". A real tap mints the tracked link (createEstimateReviewLink,
//      answered in the browser), opens the share sheet (navigator.share,
//      stubbed: it records and resolves) with the link written in, and only
//      THEN stamps lead.lastSharedAt + sharedDocId. The share text never
//      carries the Storage token URL.
//   2. Home: a lead whose estimate went out 3 days ago and was never opened
//      is on the "Estimate follow-ups" card; Follow up opens the share sheet
//      with the pre-written message and, once shared, the lead is stamped and
//      leaves the card.
//
// Nothing here can text or email anyone: the share sheet is a stub and the
// two callables are answered by page.route (no functions emulator).
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _db = null;
function adb() {
  if (_db) return _db;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _db = getFirestore();
  return _db;
}
async function hits(locator) {
  await locator.page().evaluate(() => document.querySelectorAll('.toast-container .toast, #toast.toast, [id^="toast-"]').forEach((t) => t.remove()));
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !!h && (h === el || el.contains(h)), right: r.right, w: window.innerWidth, docW: document.documentElement.scrollWidth };
  });
}

const REVIEW_TOKEN = 'ESTREVIEWTOKEN0000000001';
const REVIEW_URL = 'https://nobigdealwithjoedeal.com/report/' + REVIEW_TOKEN;

test.describe('phone: Send for review + estimate follow-ups @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('Send for review stamps lastSharedAt only after the share sheet; the follow-up card lists a 3-day-old estimate', async ({ page }) => {
    test.setTimeout(180_000);
    const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    const calls = { mint: [], record: [] };
    await page.route(/createEstimateReviewLink/, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      calls.mint.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json',
        body: JSON.stringify({ result: { token: REVIEW_TOKEN, shareUrl: REVIEW_URL, expiresAt: Date.now() + 30 * 86400000, reused: false, a2pApproved: false } }) });
    });
    await page.route(/recordEstimateShared/, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      calls.record.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ result: { ok: true, spine: null } }) });
    });
    // The iPhone share sheet: record what Jo would send, resolve as if sent.
    await page.addInitScript(() => {
      window.__shares = [];
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shares.push(d); } });
      try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (_) {}
    });

    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid), null, { timeout: 60_000 });
    const uid = await safeEvaluate(page, () => window._user.uid);
    const db = adb();
    const stamp = Date.now();
    const D = 86400000;
    const leadA = 'e2e-esend-a-' + stamp;
    const leadB = 'e2e-esend-b-' + stamp;
    const path = 'docs/' + uid + '/' + leadA + '_1730000000000_Smith_Estimate.pdf';
    await db.doc('leads/' + leadA).set({
      userId: uid, companyId: uid, firstName: '[E2E] Sam', lastName: 'Send' + stamp, phone: '5135550100',
      address: '12 Wolfpen Rd, Milford, OH 45150', stage: 'inspected', jobType: 'cash', e2eTestData: true,
      createdAt: new Date(stamp - 5 * D), updatedAt: new Date(stamp - D),
    });
    await db.doc('leads/' + leadA + '/documents/doc-est').set({
      filename: 'Smith_Estimate.pdf', type: 'application/pdf', source: 'drive_import', size: 2048, userId: uid,
      url: 'https://firebasestorage.googleapis.com/v0/b/demo/o/' + encodeURIComponent(path) + '?alt=media&token=deadbeef-0000-4000-8000-000000000000',
      uploadedAt: new Date(stamp - 2 * D),
    });
    await db.doc('leads/' + leadB).set({
      userId: uid, companyId: uid, firstName: '[E2E] Pat', lastName: 'Follow' + stamp, phone: '5135550101',
      address: '14 Wolfpen Rd, Milford, OH 45150', stage: 'estimate_sent_cash', jobType: 'cash', e2eTestData: true,
      lastSharedAt: new Date(stamp - 3 * D), sharedDocId: 'doc-x',
      createdAt: new Date(stamp - 9 * D), updatedAt: new Date(stamp - 3 * D),
    });

    // ── 1. Customer page: Send for review ────────────────────────────────
    await page.goto('/pro/customer.html?id=' + leadA);
    const send = page.locator('#docList [data-doc-review="doc-est"]');
    await expect(send, 'the attached estimate PDF offers Send for review').toBeVisible({ timeout: 30_000 });
    await expect(send).toHaveText(/Send for review/);
    // Late panels keep pushing the page down for a while after hydration
    // (phone-customer.spec.js openCustomer): wait for a stable height, then
    // put the button mid-screen, clear of the bottom bar.
    await safeEvaluate(page, async () => {
      let last = -1, stable = 0;
      for (let i = 0; i < 25 && stable < 3; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const hgt = document.documentElement.scrollHeight;
        stable = hgt === last ? stable + 1 : 0;
        last = hgt;
      }
    });
    await send.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    const h = await hits(send);
    expect(h.ok, 'a finger on the button lands on it at 390').toBe(true);
    expect(h.right, 'the button is on screen').toBeLessThanOrEqual(390);
    expect(h.docW, 'the Files row does not widen the page').toBeLessThanOrEqual(390);
    const beforeShare = (await db.doc('leads/' + leadA).get()).data();
    expect(beforeShare.lastSharedAt, 'nothing stamped before Jo shares').toBeUndefined();

    await send.tap();
    await expect.poll(() => page.evaluate(() => window.__shares.length), { timeout: 15_000, message: 'the share sheet opened' }).toBe(1);
    const shared = await page.evaluate(() => window.__shares[0]);
    expect(calls.mint[0] && calls.mint[0].data, 'the link was minted for THIS document').toEqual({ leadId: leadA, documentId: 'doc-est' });
    expect(shared.text, 'the message carries the tracked link').toContain(REVIEW_URL);
    expect(shared.text, 'and never the Storage token URL').not.toMatch(/firebasestorage|alt=media|token=/);
    expect(shared.text, 'and greets the customer by first name').toMatch(/^Hi \[E2E\]/);
    expect(shared.text, 'no claim-handling wording').not.toMatch(/claim|insur|adjuster|negotiat/i);
    await expect.poll(async () => {
      const d = (await db.doc('leads/' + leadA).get()).data() || {};
      return !!d.lastSharedAt && d.sharedDocId === 'doc-est' && d.sharedLinkUrl === REVIEW_URL;
    }, { timeout: 15_000, message: 'lastSharedAt + sharedDocId stamped once shared' }).toBe(true);
    await expect.poll(() => calls.record.length, { timeout: 10_000 }).toBe(1);
    expect(calls.record[0].data).toMatchObject({ leadId: leadA, documentId: 'doc-est', token: REVIEW_TOKEN });

    // ── 2. Home: the follow-up card ──────────────────────────────────────
    await page.goto('/pro/dashboard.html');
    await safeWaitForFunction(page, () => !!(window._user && window.NBDEstimateFollowups && Array.isArray(window._leads) && window._leads.length), null, { timeout: 60_000 });
    await safeEvaluate(page, () => { if (typeof window.goTo === 'function') window.goTo('home'); });
    await safeWaitForFunction(page, () => { window.NBDEstimateFollowups.render(); const el = document.getElementById('homeEstimateFollowups'); return !!el && !el.hidden; }, null, { timeout: 30_000 });
    const row = page.locator('#homeEstimateFollowups .ef-row[data-lead-id="' + leadB + '"]');
    await expect(row, 'the 3-day-old estimate is on the card').toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('Sent 3d ago');
    await expect(row).toContainText('Not opened yet');
    await expect(page.locator('#homeEstimateFollowups .ef-row[data-lead-id="' + leadA + '"]'), 'a just-sent estimate is not due yet').toHaveCount(0);
    const fu = row.locator('[data-ef-send]');
    await fu.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    const fh = await hits(fu);
    expect(fh.ok, 'Follow up is tappable at 390').toBe(true);
    expect(fh.docW, 'the card does not widen the page').toBeLessThanOrEqual(390);
    await fu.tap();
    // window.__shares starts empty on each page load (the init script).
    await expect.poll(() => page.evaluate(() => window.__shares.length), { timeout: 15_000 }).toBe(1);
    const fuText = await page.evaluate(() => window.__shares[0].text);
    expect(fuText, 'the pre-written follow-up').toMatch(/^Hi \[E2E\], .*estimate/s);
    await expect.poll(async () => !!((await db.doc('leads/' + leadB).get()).data() || {}).lastEstimateNudgeAt,
      { timeout: 15_000, message: 'the nudge is recorded once shared' }).toBe(true);
    await expect(row, 'a followed-up lead leaves the card until the next step').toHaveCount(0);

    await db.doc('leads/' + leadA).delete().catch(() => {});
    await db.doc('leads/' + leadB).delete().catch(() => {});
  });
});
