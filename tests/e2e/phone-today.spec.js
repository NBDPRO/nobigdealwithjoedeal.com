// tests/e2e/phone-today.spec.js — ONE Home = "Today" on the installed iPhone
// app (2026-10-03 7am audit: the boot view and the phone Home tab were two
// different screens, the task list could boot empty, and calls / follow-ups
// were counted five different ways).
//
// Installed iPhone app (standalone rules forced), 390 × 844, real taps, on
// the emulator:
//   - boot lands on Today (#view-home with the #todayPlan list);
//   - the bottom-nav Home tab IS Today (not the KPI dashboard);
//   - a seeded overdue task, a call that needs Jo and an owed invoice each
//     appear exactly once;
//   - one tap on Done removes the task's row and ticks the task in Firestore.
// Nothing here calls a Cloud Function or sends anything to anyone.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _app = null;
function admin() {
  if (_app) return _app;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _app = { db: getFirestore(), auth: getAuth() };
  return _app;
}

async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
    }
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    return css.length;
  });
}
const localYmd = (offsetDays) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const activeView = (page) => page.evaluate(() => (document.querySelector('.view.active') || {}).id || '');

test.describe('phone: ONE Home = Today @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('boot lands on Today; Home tab = Today; task, call and invoice once each; Done removes a row', async ({ page }) => {
    test.setTimeout(150_000);
    const { db, auth } = admin();
    const user = await auth.getUserByEmail(creds.email);
    const uid = user.uid;
    const co = ((user.customClaims || {}).companyId) || uid;
    const s = Date.now();
    const base = { userId: uid, companyId: co, e2eTestData: true, createdAt: new Date(), deleted: false };
    // An overdue task (stamped like every task after tasks-stamp.js / migration 007).
    const leadT = (await db.collection('leads').add(Object.assign({}, base, { firstName: 'ZZToday', lastName: 'Task' + s, stage: 'contacted', phone: '5135550141' }))).id;
    await db.doc('leads/' + leadT + '/tasks/tt' + s).set({ text: 'Call back about the gutters', dueDate: localYmd(-2), done: false, userId: uid, companyId: co, leadId: leadT, createdAt: new Date() });
    // A call that needs Jo: an urgent call from a number on no customer.
    const callId = 'cube_e2etoday' + s;
    await db.doc('phone_calls/' + callId).set({ userId: uid, companyId: co, phoneDigits: '5135550142', bucket: 'unknown', direction: 'inbound', status: 'stored', urgent: true, startedAtMs: Date.now() - 10 * 60000, summary: 'ZZCaller leak over the kitchen' + s });
    // An owed invoice on another customer.
    const leadI = (await db.collection('leads').add(Object.assign({}, base, { firstName: 'ZZOwed', lastName: 'Invoice' + s, stage: 'install_complete', phone: '5135550143' }))).id;
    await db.collection('invoices').add({ createdBy: uid, userId: uid, companyId: co, leadId: leadI, status: 'sent', total: 1234, balanceDue: 1234, invoiceNumber: 'E2E-' + s, createdAt: new Date() });

    await page.addInitScript(() => {
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
      } catch (e) { /* storage blocked */ }
    });
    await loginAs(page, creds);
    expect(await forceStandalone(page)).toBeGreaterThan(200);

    // 1. Boot lands on Today.
    await expect.poll(() => activeView(page), { message: 'the boot view is Home/Today' }).toBe('view-home');
    const plan = page.locator('#view-home #todayPlan');
    await expect(plan).toBeVisible({ timeout: 30_000 });
    await expect(plan.locator('.tp-title')).toHaveText(/things? today|Nothing due today/, { timeout: 30_000 });

    // 2. Each seeded thing appears exactly once.
    const rowWith = (text) => plan.locator('[data-tp-row]', { hasText: text });
    await expect(rowWith('ZZToday Task' + s), 'the overdue task is on Promised follow-ups').toHaveCount(1, { timeout: 30_000 });
    await expect(rowWith('ZZCaller leak over the kitchen' + s), 'the call that needs Jo is on Calls owed').toHaveCount(1, { timeout: 30_000 });
    await expect(rowWith('ZZOwed Invoice' + s), 'the owed invoice is on Money to collect').toHaveCount(1, { timeout: 30_000 });
    expect(await plan.locator('[data-tp-sec="promised"]').getByText('ZZToday Task' + s).count()).toBe(1);
    expect(await plan.locator('[data-tp-sec="calls"]').getByText('ZZCaller leak over the kitchen' + s).count()).toBe(1);
    await expect(plan.locator('[data-tp-sec="money"]')).toContainText('$1,234 owed');

    // 3. The Home tab IS Today.
    await safeEvaluate(page, () => window.goTo('crm'));
    await expect.poll(() => activeView(page)).toBe('view-crm');
    await page.locator('#mni-dash').tap();
    await expect.poll(() => activeView(page), { message: 'the Home tab opens Today, not the KPI dashboard' }).toBe('view-home');
    await expect(page.locator('#mni-dash')).toHaveClass(/active/);
    await expect(rowWith('ZZToday Task' + s)).toHaveCount(1, { timeout: 15_000 });

    // 4. One tap on Done removes the row and ticks the task.
    const done = rowWith('ZZToday Task' + s).locator('[data-tp-act="done"]');
    await expect(done).toBeVisible();
    const box = await done.boundingBox();
    // Sub-pixel layout can report 43.99997 for a 44px min-height.
    expect(Math.round(box.height), 'Done is thumb-sized').toBeGreaterThanOrEqual(44);
    await done.tap();
    await expect(rowWith('ZZToday Task' + s), 'one tap removes the row').toHaveCount(0, { timeout: 5_000 });
    await expect.poll(async () => ((await db.doc('leads/' + leadT + '/tasks/tt' + s).get()).data() || {}).done, { message: 'the task is ticked in Firestore' }).toBe(true);

    // The KPI dashboard is still one tap away under More.
    await safeEvaluate(page, () => window.goTo('dash'));
    await expect.poll(() => activeView(page)).toBe('view-dash');
  });
});
