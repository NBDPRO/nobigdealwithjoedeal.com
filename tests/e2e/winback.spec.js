/**
 * tests/e2e/winback.spec.js — the Past Customers (win-back) view on the
 * emulators at phone width (2026-10-01).
 *
 * A customer whose won job closed 5 months ago is on the list; "Reach out"
 * opens a sheet with a drafted check-in that ends "Reply STOP to opt out.";
 * "Text it" goes through NBDComms (STUBBED — the real one calls the
 * production sendSMS function) and stamps lastWinbackAt, after which the
 * customer drops off the list for the cooldown.
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

test.describe.serial('Past Customers: win-back list @shard2', () => {
  test('a finished customer is listed; Reach out drafts a check-in; Text it sends through NBDComms and takes them off the list', async ({ page }) => {
    test.setTimeout(120_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid) && typeof window.goTo === 'function', null, { timeout: 20_000 });
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, companyId: (window._userClaims && window._userClaims.companyId) || window._user.uid }));

    const s = Date.now();
    const closed = new Date(); closed.setMonth(closed.getMonth() - 5);
    // Created through the app (the path every other spec uses, so the lead has
    // every field the dashboard's load + filters expect), then back-dated.
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function', null, { timeout: 20_000 });
    const id = await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZWB', lastName: 'Past' + st, address: '7 Winback Way, Mason, OH 45040',
      phone: '5135559' + String(st).slice(-3), email: 'delivered@resend.dev', stage: 'closed', e2eTestData: true }), s);
    expect(id, 'lead saved').toBeTruthy();
    const db = adb();
    const ref = db.doc('leads/' + id);
    await ref.update({ stage: 'closed', stageRole: 'won', closedAt: closed });
    void who;

    // The dashboard loads leads at boot, so reload to pick up the admin write.
    await page.reload();
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid) && typeof window.goTo === 'function', null, { timeout: 20_000 });
    await page.waitForFunction((lid) => (window._leads || []).some((l) => l && l.id === lid), ref.id, { timeout: 25_000 });
    await safeEvaluate(page, () => window.goTo('winback'));
    const reach = page.locator('[data-wb-action="reach"][data-wb-id="' + ref.id + '"]');
    await expect(reach, 'the finished customer is on the list').toBeVisible({ timeout: 25_000 });
    const rb = await reach.boundingBox();
    expect(rb && rb.height >= 44 && rb.x + rb.width <= 390, 'Reach out is thumb-size and on screen: ' + JSON.stringify(rb)).toBe(true);

    await safeEvaluate(page, () => {
      window.__zzSent = [];
      window.NBDComms = window.NBDComms || {};
      window.NBDComms.sendSMS = async (o) => { window.__zzSent.push(o); return { success: true, mode: 'platform' }; };
    });
    await reach.click();
    const sheet = page.locator('#nbdWinbackSheet');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    const panel = await sheet.locator(':scope > div').boundingBox();
    expect(panel && panel.x >= 0 && panel.x + panel.width <= 390, 'the sheet fits a 390px screen: ' + JSON.stringify(panel)).toBe(true);
    const ta = page.locator('#nbdWinbackText');
    await expect(ta, 'the sheet shows a drafted message').toBeVisible({ timeout: 10_000 });
    const draft = await ta.inputValue();
    expect(draft, 'greets by first name').toMatch(/ZZWB/);
    expect(draft, 'ends with the opt-out line').toMatch(/Reply STOP to opt out\.$/);
    expect(draft, 'never mentions money or claims').not.toMatch(/\$|insurance claim|negotiat/i);

    await sheet.locator('[data-wb-send="sms"]').click();
    await expect.poll(async () => (await safeEvaluate(page, () => (window.__zzSent || []).length)), { message: 'one text through NBDComms', timeout: 10_000 }).toBe(1);
    const sent = await safeEvaluate(page, () => window.__zzSent[0]);
    expect(sent.to).toBe('5135559' + String(s).slice(-3));
    expect(sent.source).toBe('winback');

    await expect.poll(async () => { const d = (await ref.get()).data(); return !!d.lastWinbackAt && d.winbackCount === 1; },
      { message: 'the lead records the reach-out', timeout: 10_000 }).toBe(true);
    await expect(reach, 'reached just now → off the list for the cooldown').toHaveCount(0, { timeout: 15_000 });
  });
});
