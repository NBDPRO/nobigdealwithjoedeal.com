// @ts-check
/**
 * tests/e2e/phone-receipt-health.spec.js — the Expenses "receipts all in?" panel
 * fits a phone (2026-10-18). Loads the real css + js into a blank page with
 * synthetic leads and expenses; no server, no network.
 *
 * At 360px and 412px: nothing passes the right edge, the controls are thumb
 * sized (>= 40px), and Copy PO name copies "NBD-#### Name" for that job.
 * Tagged @phonefit @audit like phone-fit.spec.js.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'docs', 'pro');

for (const width of [360, 412]) {
  test.describe(`receipt health panel at ${width}px @phonefit @audit`, () => {
    test.use({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true });

    test('fits, and Copy PO name copies the job number + name', async ({ page }) => {
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#0b1426;color:#fff"><div id="host" style="padding:16px"></div></body></html>');
      await page.evaluate(() => {
        window.__copied = null; window.__toast = null;
        window.showToast = (m) => { window.__toast = m; };
        window._leads = [
          { id: 'w1', stage: 'closed', firstName: 'Pat', lastName: 'Finished-With-A-Very-Long-Hyphenated-Surname', customerId: 'NBD-0001' },
          { id: 'a1', stage: 'contract_signed', firstName: 'Ann', lastName: 'Active', customerId: 'NBD-0010' },
          { id: 'a2', stage: 'install_in_progress', firstName: 'Bo', lastName: 'Builder', customerId: 'NBD-0011' }];
        window.NBDPoName = { copyFor: async (lead) => { window.__copied = lead.customerId + ' ' + lead.lastName; return window.__copied; } };
      });
      await page.addStyleTag({ path: path.join(ROOT, 'css', 'receipt-health.css') });
      await page.addScriptTag({ path: path.join(ROOT, 'js', 'receipt-health.js') });
      await page.evaluate(() => {
        document.getElementById('host').innerHTML = window.NBDReceiptHealth.panelHtml([{ reviewState: 'unsorted' }, { reviewState: 'unsorted' }], window._leads);
        document.querySelector('details').open = true;
      });
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const off = [];
        document.querySelectorAll('#host *').forEach((el) => { const b = el.getBoundingClientRect(); if (b.width && b.right > vw + 0.5) off.push(el.className + ':' + Math.round(b.right)); });
        const small = [...document.querySelectorAll('#host button, #host summary')].filter((b) => b.getBoundingClientRect().height < 40).map((b) => b.textContent.trim());
        return { off, small, scrollW: document.documentElement.scrollWidth, vw };
      });
      expect(r.off, 'elements past the right edge').toEqual([]);
      expect(r.scrollW).toBeLessThanOrEqual(r.vw);
      expect(r.small, 'controls under 40px tall').toEqual([]);
      await expect(page.locator('#host')).toContainText('COSTS MISSING');
      await expect(page.locator('#host')).toContainText('2');
      await page.locator('[data-rh-copy="a2"]').click();
      expect(await page.evaluate(() => window.__copied)).toBe('NBD-0011 Builder');
    });
  });
}
