// tests/e2e/roof-rep.spec.js — Roof Rep, the NBD Pro sales game (Jo, 2026-10-03).
//
// Phone first (installed iPhone app, 390 × 844), then desktop:
//   - the More drawer and the sidebar both carry the Roof Rep tab;
//   - a new career opens on Big Dave's tutorial; nothing overflows sideways;
//     every tab and the day controls are reachable 44-px targets;
//   - play a day: start it, knock a door, call it a day (CRM log + summary);
//   - the career lands on roofRep/{uid} and the crew-board row on
//     roofRepScores/{uid} (stamped with the rep's own company), and a reload
//     with localStorage wiped comes back on day 2 — from Firestore;
//   - desktop: the sidebar tab opens the game; "← CRM" goes back.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
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
async function reachable(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.height >= 44 && !!h && (h === el || el.contains(h));
  });
}
async function pageErrors(page) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  return errs;
}

test.describe('Roof Rep @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');

  test.describe('phone', () => {
    test.use(IPHONE);
    test('More drawer tab; tutorial; a full day; career saves to Firestore and survives a wiped reload', async ({ page }) => {
      test.setTimeout(180_000);
      const errs = await pageErrors(page);
      await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (_) {} });
      await loginAs(page, creds);
      await safeWaitForFunction(page, () => !!window._user, null, { timeout: 60_000 });
      const uid = await safeEvaluate(page, () => window._user.uid);
      await expect(page.locator('#mm-roofrep')).toHaveAttribute('href', '/pro/roof-rep.html');
      await Promise.all([adb().doc('roofRep/' + uid).delete(), adb().doc('roofRepScores/' + uid).delete()]);

      await page.goto('/pro/roof-rep.html');
      await page.evaluate(() => { try { localStorage.removeItem('roofrep.save.v2'); } catch (_) {} });
      await page.reload();
      await expect(page.locator('#ovCard h2')).toHaveText('WELCOME TO THE CREW', { timeout: 30_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.click('#tutS');
      await expect(page.locator('#ov')).toBeHidden();

      for (const tab of ['street', 'today', 'train', 'locker', 'crew']) expect(await reachable(page.locator('[data-tab="' + tab + '"]')), tab + ' tab').toBe(true);
      expect(await reachable(page.locator('.rr-back'))).toBe(true);
      await page.click('[data-tab="today"]');
      await expect(page.locator('#startBtn')).toBeVisible();
      expect(await reachable(page.locator('#startBtn'))).toBe(true);
      await page.click('#startBtn');
      await expect(page.locator('#p-street')).toBeVisible();

      // Knock the top-left door: the rep walks over and someone (or something) answers.
      const box = await page.locator('#world').boundingBox();
      await page.mouse.click(box.x + box.width * 56 / 320, box.y + box.height * 40 / 200);
      await expect(page.locator('#talk .who')).not.toHaveText('Maple Court', { timeout: 10_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

      // Call it a day → CRM log (when a lead changed) → summary.
      await page.click('#endBtn');
      await page.click('#edYes');
      for (let i = 0; i < 3; i++) {
        if (await page.locator('#lgDone').isVisible().catch(() => false)) { await page.click('#lgDone'); continue; }
        if (await page.locator('#nextDay').isVisible().catch(() => false)) break;
        await page.waitForTimeout(500);
      }
      await expect(page.locator('#nextDay')).toBeVisible({ timeout: 10_000 });
      await page.click('#nextDay');

      await expect.poll(async () => { const s = await adb().doc('roofRep/' + uid).get(); return s.exists ? s.data().save.day : 0; }, { timeout: 20_000 }).toBe(2);
      const claims = await page.evaluate(() => window.RoofRepNet && window.RoofRepNet.companyId);
      await expect.poll(async () => { const s = await adb().doc('roofRepScores/' + uid).get(); return s.exists ? s.data().days : -1; }, { timeout: 20_000 }).toBe(1);
      expect((await adb().doc('roofRepScores/' + uid).get()).data().companyId ?? null).toBe(claims ?? null);

      await page.evaluate(() => { try { localStorage.removeItem('roofrep.save.v2'); } catch (_) {} });
      await page.reload();
      await expect(page.locator('#hDay')).toHaveText(/^2\b/, { timeout: 30_000 });
      expect(errs, errs.join(' | ')).toEqual([]);
    });
  });

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 860 } });
    test('the sidebar tab opens the game; ← CRM goes back', async ({ page }) => {
      test.setTimeout(120_000);
      const errs = await pageErrors(page);
      await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('roofrep.save.v2', JSON.stringify({ v: 2, day: 1, xp: 0, tutored: true, streets: {}, agenda: [], avatar: {} })); } catch (_) {} });
      await loginAs(page, creds);
      const tab = page.locator('#nav-roofrep');
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.click();
      await expect(page).toHaveURL(/\/pro\/roof-rep(\.html)?$/);
      await expect(page.locator('#hDay')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
      await page.click('.rr-back');
      await expect(page).toHaveURL(/\/pro\/dashboard(\.html)?/);
      expect(errs, errs.join(' | ')).toEqual([]);
    });
  });
});
