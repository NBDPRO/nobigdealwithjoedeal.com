// @ts-check
/**
 * tests/e2e/phone-receipt-sorter.spec.js — the receipt sorter queue fits a phone
 * and does what its buttons say (2026-10-18).
 *
 * Loads the real css + logic + UI files into a blank page with a stubbed CRM
 * (flag on, three synthetic receipts, three synthetic leads, a spy for
 * updateDoc). No server and no network: nothing can reach the real CRM.
 *
 *   1. at 360px and 412px nothing in the sheet passes the viewport's right edge
 *      (Jo's phone-scale rule) and every button is thumb-sized (>= 44px tall);
 *   2. Assign writes the sort result for THAT receipt and job, with its
 *      evidence, and nothing else;
 *   3. Undo puts the receipt back to unsorted;
 *   4. the remembered job names are saved once, at the end, and only for
 *      assignments that were not undone (a remembered name later counts as an
 *      exact match, so a wrong-then-undone tap must never leave one behind).
 *
 * Tagged @phonefit like phone-fit.spec.js.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'docs', 'pro');

const STUB = () => {
  window.__writes = []; window.__saved = null;
  window.NBDFlags = { enabled: (n) => n === 'receiptSorterQueue' };
  window._user = { uid: 'u1' }; window.db = {}; window.doc = (d, c, i) => c + '/' + i;
  window.updateDoc = async (ref, p) => { window.__writes.push({ ref, p }); };
  window.showToast = () => {};
  window._leads = [
    { id: 'a', customerId: 'NBD-0042', firstName: 'Robert', lastName: 'Smith', address: '12 Ashgrove Ave, Town, OH', damageType: 'Roof Repair', scheduledDate: '2026-09-20' },
    { id: 'b', customerId: 'NBD-0043', firstName: 'Sam', lastName: 'Smith', address: '40 Birch Ln, Town, OH' },
    { id: 'c', customerId: 'NBD-0044', firstName: 'Lora', lastName: 'Mueller', address: '6389 Muellers Lake Ln, Milford, OH' }];
  const mk = (id, po, d, items) => ({ id, poJobName: po, storeNumber: '3844', date: new Date(d + 'T12:00:00'), amountCents: 16700, taxCents: 1000, supplier: 'Home Depot', category: 'materials', costType: 'direct', source: 'import_homedepot', reviewState: 'unsorted', items: items || [{ desc: 'GAF Timberline HDZ Shingles Charcoal Very Long Product Name For Wrapping Test', qty: 12, unitCents: 3500 }, { desc: 'Roofing Nails', qty: 2, unitCents: 900 }] });
  const E = [mk('e1', 'Bob Smith', '2026-09-22'), mk('e2', '6389 Muellers Lake Ln', '2026-09-23'), mk('e3', '', '2026-09-24', [])];
  window.Expenses = { list: () => E, refresh() {} };
  window.NBDHdImport = { loadAliases: async () => ({}), saveAliases: async (a) => { window.__saved = a; } };
};

async function boot(page) {
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#0b1426"></body></html>');
  await page.evaluate(STUB);
  await page.addStyleTag({ path: path.join(ROOT, 'css', 'receipt-sorter.css') });
  await page.addScriptTag({ path: path.join(ROOT, 'js', 'receipt-sorter-logic.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'js', 'receipt-sorter.js') });
  await page.evaluate(() => window.NBDReceiptSorter.open());
  await page.waitForSelector('.rs-sheet');
}

for (const width of [360, 412]) {
  test.describe(`receipt sorter at ${width}px @phonefit @audit`, () => {
    test.use({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true });

    test('nothing passes the right edge and every button is thumb-sized', async ({ page }) => {
      await boot(page);
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const off = [];
        document.querySelectorAll('.rs-overlay *').forEach((el) => { const b = el.getBoundingClientRect(); if (b.width && b.right > vw + 0.5) off.push(el.className + ':' + Math.round(b.right)); });
        const small = [...document.querySelectorAll('.rs-btn, .rs-x, .rs-pick select')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.className);
        return { off, small, scrollW: document.querySelector('.rs-overlay').scrollWidth, vw };
      });
      expect(r.off, 'elements past the right edge').toEqual([]);
      expect(r.scrollW).toBeLessThanOrEqual(r.vw);
      expect(r.small, 'buttons under 44px tall').toEqual([]);
    });

    test('Assign writes the sort result, Undo reverses it, names are remembered once', async ({ page }) => {
      await boot(page);
      // newest first: the blank-PO card has no candidate; skip it
      await expect(page.locator('.rs-po')).toContainText('(blank)');
      await page.click('[data-rs-action="skip"]');
      await expect(page.locator('.rs-po')).toContainText('6389 Muellers Lake Ln');
      await expect(page.locator('.rs-why')).toContainText('House number and street');
      await page.click('[data-rs-action="assign"]');
      let w = await page.evaluate(() => window.__writes);
      expect(w).toHaveLength(1);
      expect(w[0].ref).toBe('expenses/e2');
      expect(w[0].p.leadId).toBe('c');
      expect(w[0].p.reviewState).toBe('assigned');
      expect(w[0].p.matchEvidence.join(' ')).toContain('House number and street');
      await page.click('[data-rs-action="undo"]');
      w = await page.evaluate(() => window.__writes);
      expect(w).toHaveLength(2);
      expect(w[1].p.reviewState).toBe('unsorted');
      expect(w[1].p.leadId).toBeNull();
      // nothing is remembered while the only assignment is undone
      await page.click('[data-rs-action="skip"]');
      await page.click('[data-rs-action="overhead"]');
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.__saved)).toBeNull();
    });

    test('a kept assignment is remembered when the sheet ends', async ({ page }) => {
      await boot(page);
      await page.click('[data-rs-action="skip"]');
      await page.click('[data-rs-action="assign"]');
      await page.click('[data-rs-action="overhead"]');
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.__saved)).toEqual({ '6389 muellers lake ln': 'c' });
    });
  });
}
