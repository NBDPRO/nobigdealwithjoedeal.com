/**
 * tests/e2e/layouts.spec.js — the layout system end to end on the emulators
 * (2026-10-11, D0 + D2 of the style integration).
 *
 * Classic is what everyone gets: data-layout="classic", --tap 56px, and the
 * Appearance tab's Layouts panel says so. A second layout (registered by an
 * init script, because the real ones arrive in later slices) can be TRIED for
 * 30 seconds with a Keep / Revert bar, KEPT (userSettings.layout.byDevice is
 * written, and the pre-paint stamp brings it back on reload before the app
 * boots), and REVERTED. Glove mode flips --tap to 64px. A company LOCK, set
 * through the real picker + the real rules, wins over the user's choice and
 * disables the picker's buttons.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const REGISTER = () => {
  // A second layout with no script/css of its own: enough to exercise
  // apply / preview / keep / lock without waiting for the real layouts.
  const t = setInterval(() => {
    if (window.LayoutRegistry && window.LayoutEngine) {
      clearInterval(t);
      window.LayoutRegistry.register({ id: 'ztest', name: 'Z Test Layout', surfaces: ['phone', 'tablet', 'desktop'], blurb: 'e2e' });
    }
  }, 5);
};

// The Layouts panel lives on Settings > Appearance, and the picker folds every non-featured layout
// (ztest among them) under a closed "More layouts" group. A layout change repaints the Settings view
// (the Appearance tab is not sticky across it), so each step that clicks a ztest card opens the panel
// again rather than assuming the last one's state (CI 2026-10-25: the second "Try it" after a revert
// waited 180 s on a card that was in the DOM but under an inactive tab).
async function openPicker(page) {
  await safeEvaluate(page, () => { window.goTo && window.goTo('settings'); });
  await page.locator('#stab-appearance').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#stab-appearance').click();
  await page.locator('#layoutsPanelBody .lp-card').first().waitFor({ state: 'visible', timeout: 15_000 });
  await safeEvaluate(page, () => window.LayoutRegistry.get('ztest') && window.NBDLayoutPicker.render());
  const more = page.locator('#layoutsPanelBody .lp-more');
  await expect(more).toHaveCount(1);
  if (!(await more.evaluate((d) => d.open))) await more.locator('summary').click();
  await expect(page.locator('.lp-card[data-layout-id="ztest"]')).toBeVisible();
}

async function resetSettings(email) {
  const { initializeApp, getApps } = require('firebase-admin/app');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const uid = (await require('firebase-admin/auth').getAuth().getUserByEmail(email)).uid;
  await getFirestore().doc('userSettings/' + uid).set({ layout: FieldValue.delete() }, { merge: true });
  await getFirestore().doc('companies/' + uid + '/settings/layout').delete().catch(() => {});
  return uid;
}

test.describe.serial('Layouts @shard2', () => {
  // A failure half-way (after the company lock is saved) must not leave the
  // lock on the shared test rep: every later spec in the shard would run
  // under a locked 'ztest' layout and fail for a reason that is not theirs.
  test.afterEach(async () => {
    await resetSettings(requireTestUser().email).catch(() => {});
  });

  test('classic by default; try, keep, reload, revert; glove; company lock', async ({ page }) => {
    test.setTimeout(180_000);
    const creds = requireTestUser();
    await resetSettings(creds.email);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.addInitScript(REGISTER);
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window.LayoutEngine && window.LayoutEngine.prefs().hydrated && window.LayoutRegistry.get('ztest')), null, { timeout: 30_000 });

    // ── Classic, tap token ──
    const base = await safeEvaluate(page, () => ({
      layout: document.documentElement.getAttribute('data-layout'),
      tap: getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(),
      cur: window.LayoutEngine.current(),
    }));
    expect(base.layout).toBe('classic');
    expect(base.tap).toBe('56px');
    expect(base.cur.source).toBe('classic');

    // ── the picker (lazy) ──
    await openPicker(page);
    const classicCard = page.locator('.lp-card[data-layout-id="classic"]');
    await expect(classicCard).toContainText('In use');

    // ── try it: applies on this screen, shows the bar, does not save ──
    await page.locator('.lp-card[data-layout-id="ztest"] [data-lp="try"]').click();
    await expect(page.locator('#lpPreviewBar')).toContainText('Z Test Layout');
    expect(await safeEvaluate(page, () => document.documentElement.getAttribute('data-layout'))).toBe('ztest');
    expect(await safeEvaluate(page, async () => {
      const s = await window.getDoc(window.doc(window.db, 'userSettings', window._user.uid));
      return !!(s.exists() && s.data().layout && s.data().layout.byDevice && s.data().layout.byDevice.desktop);
    })).toBe(false);

    // ── revert ──
    await page.locator('#lpPreviewBar [data-lp="revert"]').click();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'classic', null, { timeout: 10_000 });
    await expect(page.locator('#lpPreviewBar')).toHaveCount(0);

    // ── try then KEEP: written for THIS device only ──
    await openPicker(page);
    await page.locator('.lp-card[data-layout-id="ztest"] [data-lp="try"]').click();
    await page.locator('#lpPreviewBar [data-lp="keep"]').click();
    await safeWaitForFunction(page, async () => {
      const s = await window.getDoc(window.doc(window.db, 'userSettings', window._user.uid));
      const l = s.exists() && s.data().layout;
      return !!(l && l.byDevice && l.byDevice.desktop === 'ztest' && l.byDevice.phone === null);
    }, null, { timeout: 15_000 });
    expect(await safeEvaluate(page, () => JSON.parse(localStorage.getItem('nbd_layout_resolved')).byDevice.desktop)).toBe('ztest');

    // ── reload: the stamp is on <html> before the app's own scripts run ──
    await page.addInitScript(() => {
      // An init script can run before <html> exists, so observe the document.
      // The first non-empty value is the pre-paint stamp (the engine's own
      // apply() comes much later, after auth).
      window.__firstLayout = null;
      new MutationObserver(() => {
        const v = document.documentElement && document.documentElement.getAttribute('data-layout');
        if (window.__firstLayout === null && v) window.__firstLayout = v;
      }).observe(document, { attributes: true, attributeFilter: ['data-layout'], subtree: true });
    });
    await page.reload();
    expect(await safeEvaluate(page, () => window.__firstLayout)).toBe('ztest');
    await safeWaitForFunction(page, () => !!(window.LayoutEngine && window.LayoutEngine.prefs().hydrated), null, { timeout: 30_000 });
    expect(await safeEvaluate(page, () => window.LayoutEngine.current().id)).toBe('ztest');

    // ── glove mode ──
    await safeEvaluate(page, () => { window.goTo && window.goTo('settings'); });
    await page.locator('#stab-appearance').click();
    await page.locator('#lpGlove').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#lpGlove').check();
    await safeWaitForFunction(page, () => getComputedStyle(document.documentElement).getPropertyValue('--tap').trim() === '64px', null, { timeout: 10_000 });
    await page.locator('#lpGlove').uncheck();
    await safeWaitForFunction(page, () => getComputedStyle(document.documentElement).getPropertyValue('--tap').trim() === '56px', null, { timeout: 10_000 });

    // ── company lock through the real picker and the real rules ──
    await page.locator('.lp-card[data-layout-id="classic"] [data-lp="use"]').click();   // the user picks Classic...
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'classic', null, { timeout: 10_000 });
    // data-layout flips the moment the choice is APPLIED; the picker then repaints
    // its whole panel when the save lands (state.busy -> false). Edit the admin
    // form before that and the repaint puts the <select> back to "Classic (no
    // default)" under the Save click, so the lock never reaches ztest. Wait for
    // the repaint, not a timer.
    await safeWaitForFunction(page, () => !!(window.NBDLayoutPicker && window.NBDLayoutPicker._state && window.NBDLayoutPicker._state.busy === false), null, { timeout: 15_000 });
    await page.locator('.lp-admin summary').click();
    await page.locator('#lpCompanyDefault').selectOption('ztest');
    await page.locator('#lpCompanyLock').check();
    await page.locator('[data-lp="save-company"]').click();
    // ...but the locked company layout wins over the user's choice.
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'ztest', null, { timeout: 15_000 });
    expect(await safeEvaluate(page, () => window.LayoutEngine.current().source)).toBe('company-lock');
    await expect(page.locator('.lp-lock')).toContainText('Z Test Layout');
    await expect(page.locator('.lp-card[data-layout-id="classic"] [data-lp="use"]')).toBeDisabled();
    const stored = await safeEvaluate(page, async () => {
      const s = await window.getDoc(window.doc(window.db, 'companies', window._user.uid, 'settings', 'layout'));
      return s.exists() ? s.data() : null;
    });
    expect(stored.locked).toBe(true);
    expect(stored.defaultByDevice.desktop).toBe('ztest');
    expect(stored.updatedBy).toBeTruthy();

    // lift the lock: the user's own choice (classic) is back. The admin block
    // stayed open across the repaint.
    await expect(page.locator('.lp-admin')).toHaveAttribute('open', '');
    await page.waitForTimeout(800);   // let the save's own repaint settle before editing the form
    await page.locator('#lpCompanyLock').uncheck();
    await page.locator('[data-lp="save-company"]').click();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'classic', null, { timeout: 15_000 });
    expect(await safeEvaluate(page, () => window.LayoutEngine.current().source)).toBe('user');
  });
});
