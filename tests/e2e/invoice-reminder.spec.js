/**
 * tests/e2e/invoice-reminder.spec.js — the Money view's one-tap overdue
 * reminder, on the emulators at phone width (2026-10-01).
 *
 * An overdue invoice in the Collections queue shows "Remind"; the sheet
 * shows the real message, fits a 390px screen, and "Text it" records
 * lastReminderAt on the invoice. NBDComms.sendSMS is STUBBED in the page —
 * the real one calls the production sendSMS function, and a test must never
 * text anyone.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

let _db = null;
function adb() {
  if (_db) return _db;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _db = getFirestore();
  return _db;
}

test.describe.serial('Money: one-tap overdue reminder @shard2', () => {
  test('Remind opens a phone-fit sheet with the real message; Text it sends through NBDComms and stamps the invoice', async ({ page }) => {
    test.setTimeout(120_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    // Belt and braces: no request may reach a real Cloud Function from this test.
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid) && typeof window.goTo === 'function', null, { timeout: 20_000 });
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, companyId: (window._userClaims && window._userClaims.companyId) || window._user.uid }));

    const s = Date.now();
    const db = adb();
    const ref = await db.collection('invoices').add({
      createdBy: who.uid, companyId: who.companyId, status: 'sent', e2eTestData: true,
      nbdInvoiceNumber: 'NBD-500-ZZ' + String(s).slice(-4), total: 1450, balanceDue: 1450,
      dueDate: new Date(Date.now() - 16 * 86400000), createdAt: new Date(),
      customerName: 'ZZ_QA Remind' + s, customerPhone: '5135550' + String(s).slice(-3), customerEmail: 'delivered@resend.dev',
      stripePaymentLink: 'https://buy.stripe.com/test_zzqa',
    });

    await safeEvaluate(page, () => window.goTo('money'));
    const remind = page.locator('[data-target="NBDInvoiceReminder.open"][data-arg="' + ref.id + '"]');
    await expect(remind, 'the overdue invoice offers Remind').toBeVisible({ timeout: 25_000 });
    const rb = await remind.boundingBox();
    expect(rb && rb.height >= 44, 'Remind is thumb-size: ' + JSON.stringify(rb)).toBe(true);

    // Stub the sender (never the real one) and record what it was asked to send.
    await safeEvaluate(page, () => {
      window.__zzSent = [];
      window.NBDComms = window.NBDComms || {};
      window.NBDComms.sendSMS = async (o) => { window.__zzSent.push(o); return { success: true, mode: 'platform' }; };
    });
    await remind.click();
    const sheet = page.locator('#nbdInvReminder');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#nbdInvReminderText')).toHaveValue(/invoice NBD-500-ZZ\d{4} for \$1,450\.00 was due .*You can pay here: https:\/\/buy\.stripe\.com\/test_zzqa/);
    const panel = sheet.locator(':scope > div');
    const pb = await panel.boundingBox();
    expect(pb && pb.x >= 0 && pb.x + pb.width <= 390, 'the sheet fits a 390px screen: ' + JSON.stringify(pb)).toBe(true);

    await page.locator('#nbdInvReminderText').fill('ZZ_QA edited reminder ' + s);
    await sheet.locator('[data-inv-rem="sms"]').click();
    await expect(sheet, 'the sheet closes on send').toHaveCount(0, { timeout: 10_000 });
    const sent = await safeEvaluate(page, () => window.__zzSent);
    expect(sent.length, 'exactly one text, through NBDComms').toBe(1);
    expect(sent[0].message, 'the EDITED message is what went').toBe('ZZ_QA edited reminder ' + s);
    expect(sent[0].to).toBe('5135550' + String(s).slice(-3));

    await expect.poll(async () => { const d = (await ref.get()).data(); return !!d.lastReminderAt && d.reminderCount === 1 && d.lastReminderMethod === 'sms'; },
      { message: 'the invoice records the reminder', timeout: 10_000 }).toBe(true);
    await expect(page.locator('#view-money'), 'the queue now says when it was reminded').toContainText('reminded today', { timeout: 15_000 });
  });
});
