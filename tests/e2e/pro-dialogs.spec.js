// @ts-check
// In-tab dialogs (docs/pro/js/nbd-dialog.js and the standalone-compat.js twin).
// A native confirm/alert/prompt sits outside the DOM and freezes agent tools;
// these must be real elements with clickable buttons. Public pages only, no auth.
// Run against a local serve (the files must be deployed to exist on prod):
//   PLAYWRIGHT_BASE_URL=http://localhost:5000 npx playwright test pro-dialogs

const { test, expect } = require('@playwright/test');

// pricing.html loads nbd-dialog.js; login.html loads standalone-compat.js.
for (const pagePath of ['/pro/pricing.html', '/pro/login.html']) {
  test.describe('dialogs on ' + pagePath, () => {
    test.beforeEach(async ({ page }) => {
      const native = [];
      page.on('dialog', (d) => { native.push(d.type()); d.dismiss().catch(() => {}); });
      // @ts-ignore
      page.__native = native;
      await page.goto(pagePath);
      await page.waitForFunction(() => typeof window.nbdConfirm === 'function');
    });

    test('nbdConfirm is a DOM dialog; Confirm resolves true, Cancel false', async ({ page }) => {
      await page.evaluate(() => { window.__r = window.nbdConfirm('Void this link?'); });
      const dlg = page.locator('#nbd-dialog');
      await expect(dlg).toBeVisible();
      await expect(dlg.locator('[role="dialog"]')).toHaveAttribute('aria-modal', 'true');
      await expect(dlg).toContainText('Void this link?');
      await page.locator('#nbd-dialog-confirm').click();
      expect(await page.evaluate(() => window.__r)).toBe(true);
      await expect(dlg).toHaveCount(0);

      await page.evaluate(() => { window.__r = window.nbdConfirm('Again?'); });
      await page.locator('[data-testid="nbd-dialog-cancel"]').click();
      expect(await page.evaluate(() => window.__r)).toBe(false);
    });

    test('Escape cancels, Enter confirms, Enter on Cancel does not confirm', async ({ page }) => {
      await page.evaluate(() => { window.__r = window.nbdConfirm('Esc?'); });
      await expect(page.locator('#nbd-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => window.__r)).toBe(false);

      await page.evaluate(() => { window.__r = window.nbdConfirm('Enter?'); });
      await expect(page.locator('#nbd-dialog')).toBeVisible();
      await page.locator('#nbd-dialog-confirm').focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.__r)).toBe(true);

      await page.evaluate(() => { window.__r = window.nbdConfirm('Cancel focused?'); });
      await expect(page.locator('#nbd-dialog')).toBeVisible();
      await page.locator('#nbd-dialog-cancel').focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.__r)).toBe(false);
    });

    test('nbdPrompt returns the typed text; alert() is a DOM dialog, not native', async ({ page }) => {
      await page.evaluate(() => { window.__r = window.nbdPrompt('Name?', 'abc'); });
      await page.locator('#nbd-dialog-input').fill('xyz');
      await page.locator('#nbd-dialog-confirm').click();
      expect(await page.evaluate(() => window.__r)).toBe('xyz');

      await page.evaluate(() => { window.alert('Saved'); });
      // Pages with showToast show a toast instead; either way no native dialog.
      await page.waitForTimeout(150);
      // @ts-ignore
      expect(page.__native).toEqual([]);
    });
  });
}
