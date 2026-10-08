// tests/e2e/phone-home-nav.spec.js — Home leads with the people who need Jo,
// field tools at the top of More, and a normal stage move is one tap
// (CRM phone audit 2026-10-07 #6, #7, #10; batch E, 2026-10-08).
//
// Installed iPhone app (standalone rules forced), 390 × 844, real taps, on
// the emulator:
//   - Home: the "N people need you" chip and today's appointments sit in the
//     FIRST screen (above the bottom nav); the widgets and the full
//     No-next-step list fold behind "More on Home" and open with one tap;
//   - More drawer: Call Center, Schedule, Close Board, Door-to-Door are the
//     first four items and all in view without scrolling;
//   - customer page: "→ Move to <next>" moves the stage with ONE tap (no
//     confirm), and the toast's Undo puts it back in Firestore;
//   - at 1440 the desktop Home is unchanged (no toggle, widgets showing).
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
async function seed(stamp) {
  const { db, auth } = admin();
  const user = await auth.getUserByEmail(creds.email);
  const uid = user.uid;
  const co = ((user.customClaims || {}).companyId) || uid;
  // A call that needs Jo (urgent, unknown number) — the needs-you chip.
  await db.doc('phone_calls/cube_e2ehomenav' + stamp).set({ userId: uid, companyId: co, phoneDigits: '5135550177', bucket: 'unknown', direction: 'inbound', status: 'stored', urgent: true, startedAtMs: Date.now() - 5 * 60000, summary: 'ZZHomeNav caller ' + stamp });
  // A cash lead one step from the next stage — the stage move.
  const lead = (await db.collection('leads').add({ userId: uid, companyId: co, e2eTestData: true, deleted: false, createdAt: new Date(), firstName: 'ZZHomeNav', lastName: 'Stage' + stamp, stage: 'inspected', jobType: 'cash', jobValue: 15000, phone: '5135550178', address: stamp + ' Undo Way, Mason, OH' })).id;
  return { db, uid, co, lead };
}
const initStorage = () => {
  try {
    localStorage.setItem('nbd-onboarding-complete', '1');
    localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
  } catch (e) { /* storage blocked */ }
};
const boxOf = (page, sel) => page.locator(sel).first().boundingBox();

test.describe('phone: Home leads with people who need you; field tools pinned; one-tap stage move @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.describe.configure({ mode: 'serial' });
  const stamp = Date.now();
  let seeded = null;

  test.describe('390 installed app', () => {
    test.use(IPHONE);

    test('Home: needs-you chip and appointments in the first screen; the rest behind More on Home', async ({ page }) => {
      test.setTimeout(150_000);
      seeded = await seed(stamp);
      await page.addInitScript(initStorage);
      await loginAs(page, creds);
      expect(await forceStandalone(page)).toBeGreaterThan(200);
      await safeEvaluate(page, () => window.goTo('home'));
      await safeEvaluate(page, () => window.scrollTo(0, 0));
      const chip = page.locator('#homeAttention [data-target="calls"]');
      await expect(chip, 'the needs-you chip shows').toBeVisible({ timeout: 30_000 });
      await expect(chip).toHaveText(/\d+ (people need|person needs) you/);
      await expect(page.locator('#todayPlan .tp-title')).toHaveText(/things? today|Nothing/, { timeout: 30_000 });
      await safeEvaluate(page, () => window.scrollTo(0, 0));
      const nav = await boxOf(page, '#mobile-nav');
      const fold = nav ? nav.y : 844;
      const c = await chip.boundingBox();
      expect(c.y + c.height, 'the needs-you chip is above the bottom nav on the first screen').toBeLessThanOrEqual(fold);
      expect(Math.round(c.height), 'the chip is thumb-sized').toBeGreaterThanOrEqual(44);
      // The Today card starts in the first screen (appointments are its first section).
      const plan = await boxOf(page, '#todayPlan');
      expect(plan.y, 'the Today list starts in the first screen').toBeLessThan(fold - 120);
      // Folded: widgets and the long No-next-step list wait behind one tap.
      await expect(page.locator('#widgetGrid')).toBeHidden();
      await expect(page.locator('#homeWeekReviewBtn'), 'the header\'s extra links fold away on a phone').toBeHidden();
      const toggle = page.locator('#homeMoreToggle');
      await toggle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const t = await toggle.boundingBox();
      expect(Math.round(t.height)).toBeGreaterThanOrEqual(44);
      await toggle.tap();
      await expect(page.locator('#widgetGrid'), 'one tap opens the rest of Home').toBeVisible();
      await expect(page.locator('.home-more-acts [data-target="weekreview"]')).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('home-more-open-390.png') });
      const sx = await safeEvaluate(page, () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sx, 'no sideways scroll').toBeLessThanOrEqual(0);
    });

    test('More: Call Center, Schedule, Close Board, Door-to-Door first and in view', async ({ page }) => {
      test.setTimeout(120_000);
      await page.addInitScript(initStorage);
      await loginAs(page, creds);
      expect(await forceStandalone(page)).toBeGreaterThan(200);
      await page.locator('#mni-more').tap();
      await expect(page.locator('#mobile-more-menu')).toHaveClass(/\bopen\b/);
      const first = await safeEvaluate(page, () => [...document.querySelectorAll('#mobile-more-menu .mm-item')].slice(0, 4).map((e) => e.dataset.target));
      expect(first).toEqual(['calls', 'schedule', 'closeboard', 'd2d']);
      for (const tg of first) {
        const b = await boxOf(page, `#mobile-more-menu .mm-item[data-target="${tg}"]`);
        expect(b && b.y >= 0 && b.y + b.height <= 844, tg + ' is in view without scrolling').toBe(true);
        expect(Math.round(b.height), tg + ' is thumb-sized').toBeGreaterThanOrEqual(44);
      }
      await page.locator('#mobile-more-menu .mm-item[data-target="calls"]').tap();
      await expect.poll(() => safeEvaluate(page, () => (document.querySelector('.view.active') || {}).id || '')).toBe('view-calls');
    });

    test('customer page: one tap moves the stage (no confirm); Undo puts it back', async ({ page }) => {
      test.setTimeout(150_000);
      if (!seeded) seeded = await seed(stamp);
      const { db, lead } = seeded;
      await page.addInitScript(initStorage);
      let dialogs = 0;
      page.on('dialog', (d) => { dialogs++; d.accept().catch(() => {}); });
      await loginAs(page, creds);
      await page.goto('/pro/customer.html?id=' + lead);
      await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 30_000 });
      expect(await forceStandalone(page)).toBeGreaterThan(0);
      const btn = page.locator('#stageProgressBtn');
      await expect(btn).toBeVisible({ timeout: 20_000 });
      await btn.scrollIntoViewIfNeeded();
      await btn.tap();
      await expect.poll(async () => ((await db.doc('leads/' + lead).get()).data() || {}).stage, { message: 'one tap moved the stage', timeout: 15_000 }).not.toBe('inspected');
      const moved = ((await db.doc('leads/' + lead).get()).data() || {}).stage;
      await expect(page.locator('.sa-btn-ok'), 'no confirm modal').toHaveCount(0);
      expect(dialogs, 'no native confirm').toBe(0);
      const undo = page.locator('#toastContainer button', { hasText: 'Undo' });
      await expect(undo, 'the toast offers Undo').toBeVisible({ timeout: 5_000 });
      await page.screenshot({ path: test.info().outputPath('stage-moved-undo-390.png') });
      await undo.tap();
      await expect.poll(async () => ((await db.doc('leads/' + lead).get()).data() || {}).stage, { message: 'Undo puts the stage back', timeout: 15_000 }).toBe('inspected');
      await expect.poll(() => safeEvaluate(page, () => window._currentStage)).toBe('inspected');
      await expect(btn).toContainText(/Move to/);
      expect(moved).not.toBe('inspected');
    });
  });

  test('1440: the desktop Home is unchanged (no toggle; widgets and header links show)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(initStorage);
    await loginAs(page, creds);
    await safeEvaluate(page, () => window.goTo('home'));
    await expect(page.locator('#widgetGrid')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#homeMoreToggle')).toBeHidden();
    await expect(page.locator('#homeWeekReviewBtn')).toBeVisible();
    await expect(page.locator('.home-more-acts')).toBeHidden();
  });
});
