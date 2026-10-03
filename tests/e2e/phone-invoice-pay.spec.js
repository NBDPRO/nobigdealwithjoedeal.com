// tests/e2e/phone-invoice-pay.spec.js — recording a payment on a phone.
//
// The money path Jo runs in the driveway: the homeowner hands over a check
// or Zelles part of it, and the rep logs it from the installed iPhone app.
// markPaidUI ("built for one hand on a phone") had unit coverage of its
// ledger math but no browser test at phone size. This walks it with real
// taps at 390 × 844, standalone rules forced:
//
//   invoice from an estimate → Record Payment: Zelle, part of the balance
//   → the invoice ledger, balance and payment history agree
//   → Record Payment again: the amount defaults to what is left; Check
//   → paid in full, balance $0.
//
// Every control the rep touches is hit-tested at its centre and is at least
// 44px tall; nothing on the sheet runs off the screen. Money is read back
// from the saved invoice, in cents.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

async function signIn(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) =>
    r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
  await loginAs(page, creds);
  await safeWaitForFunction(page, () => !!(window._user && window._user.uid), { timeout: 20_000 });
}

async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) {
          for (const inner of r.cssRules) css += inner.cssText + '\n';
        }
      }
    }
    const s = document.createElement('style');
    s.id = 'e2e-force-standalone';
    s.textContent = css;
    document.head.appendChild(s);
    return css.length;
  });
}

async function reachable(locator) {
  await locator.page().evaluate(() => {
    document.querySelectorAll('.toast-container .toast, #toast.toast').forEach((t) => t.remove());
  });
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (h === el || el.contains(h));
  });
}

// A customer + a Classic-shaped estimate ($9,240, no tax) of our own.
async function seedLeadAndEstimate(page) {
  return safeEvaluate(page, async () => {
    const stamp = Date.now();
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const last = 'Pay' + stamp;
    const add = async (coll, data, key, val) => {
      try { return (await fsMod.addDoc(fsMod.collection(db, coll), data)).id; } catch (e) {
        if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e;
        const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, coll), fsMod.where('userId', '==', uid), fsMod.where(key, '==', val)));
        return snap.docs[0] && snap.docs[0].id;
      }
    };
    const leadId = await add('leads', {
      firstName: '[E2E] Pay', lastName: last, address: stamp + ' Payment Pl, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7), email: 'e2e-pay-' + stamp + '@nbd.test',
      stage: 'closed', e2eTestData: true, userId: uid, companyId, createdAt: fsMod.serverTimestamp(),
    }, 'lastName', last);
    const estName = 'E2E pay ' + stamp;
    const estimateId = await add('estimates', {
      leadId, userId: uid, companyId, name: estName, title: estName, e2eTestData: true,
      lineItems: [{ desc: 'Full roof replacement', qty: 30, total: 9000 }, { desc: 'Ice and water shield', qty: 2, total: 240 }],
      grandTotal: 9240, total: 9240, taxRate: 0, createdAt: fsMod.serverTimestamp(),
    }, 'name', estName);
    if (typeof window.loadLeads === 'function') await window.loadLeads();
    return { leadId, estimateId };
  });
}

const invoiceDoc = (page, id) => safeEvaluate(page, async (invId) => {
  const s = await window.getDoc(window.doc(window.db, 'invoices', invId));
  const d = s.data() || {};
  return {
    total: d.total, depositAmount: d.depositAmount, amountPaid: d.amountPaid, balanceDue: d.balanceDue, status: d.status,
    payments: (d.payments || []).map((p) => ({ amount: p.amount, method: p.method, reference: p.reference || '' })),
  };
}, id);

const cents = (v) => Math.round(Number(v) * 100);

// The Record Payment sheet, as a thumb meets it.
async function checkSheet(page) {
  // The sheet pops in with a scale animation; boxes measured mid-animation read
  // ~10% small (44px fields measured 40). Measure once it has settled.
  await page.waitForFunction(() => {
    const m = document.getElementById('nbd-markpaid-modal');
    return !!m && document.getAnimations().every((an) => an.playState !== 'running' || !(an.effect && an.effect.target && m.contains(an.effect.target)));
  }, null, { timeout: 5_000 });
  const r = await page.evaluate(() => {
    const m = document.querySelector('#nbd-markpaid-modal .modal');
    const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const ctl = Array.from(m.querySelectorAll('button, input')).filter(vis);
    return {
      small: ctl.filter((el) => el.getBoundingClientRect().height < 44).map((el) => (el.id || el.dataset.method || el.textContent.trim().slice(0, 20)) + ' ' + Math.round(el.getBoundingClientRect().height) + 'px'),
      wide: Array.from(m.querySelectorAll('*')).filter((el) => vis(el) && el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.tagName + '#' + el.id),
      sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  expect(r.small, 'every control on the sheet is a thumb target').toEqual([]);
  expect(r.wide, 'nothing runs off the right edge').toEqual([]);
  expect(r.sideways, 'no sideways scroll').toBe(false);
}

test.describe('phone invoice: record payments, installed iPhone app @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('Zelle part, then Check the rest — ledger, balance and history agree to the cent', async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const { estimateId } = await seedLeadAndEstimate(page);
    expect(estimateId, 'a seeded estimate').toBeTruthy();
    expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
    await safeWaitForFunction(page, () => !!(window.InvoicePipeline && window.getDoc), { timeout: 20_000 });
    const invoiceId = await safeEvaluate(page, (id) => window.InvoicePipeline.createInvoiceFromEstimate(id), estimateId);
    expect(invoiceId, 'an invoice was created').toBeTruthy();
    await page.evaluate((id) => { const m = document.getElementById('nbd-invoice-detail-modal'); if (m) m.remove(); void id; }, invoiceId);
    const start = await invoiceDoc(page, invoiceId);
    expect(cents(start.total), 'invoice total = the estimate').toBe(924000);

    const ZELLE = 400000;
    await test.step('Record Payment: Zelle, part of the balance', async () => {
      await page.evaluate((id) => { window.InvoicePipeline.markPaidUI(id); }, invoiceId);
      const sheet = page.locator('#nbd-markpaid-modal .modal');
      await expect(sheet).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#nbd-mp-amount'), 'the amount defaults to the balance').toHaveValue('9240.00');
      await checkSheet(page);
      const zelle = page.locator('#nbd-markpaid-modal .nbd-mp-method[data-method="zelle"]');
      expect(await reachable(zelle), 'Zelle is reachable').toBe(true);
      await zelle.tap();
      await expect(zelle).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#nbd-mp-ref-label')).toHaveText('Zelle confirmation #');
      await page.locator('#nbd-mp-amount').fill('4000');
      await page.locator('#nbd-mp-ref').fill('ZL-77');
      const save = page.locator('#nbd-mp-save');
      await save.scrollIntoViewIfNeeded();
      expect(await reachable(save), 'Save payment is reachable').toBe(true);
      await save.tap();
      await expect(page.locator('#nbd-markpaid-modal'), 'the sheet closes once saved').toHaveCount(0, { timeout: 20_000 });
      const d = await invoiceDoc(page, invoiceId);
      expect(d.payments, 'one Zelle payment on the ledger').toEqual([{ amount: 4000, method: 'zelle', reference: 'ZL-77' }]);
      expect(cents(d.amountPaid), 'amount paid').toBe(ZELLE);
      expect(cents(d.balanceDue), 'balance = total − paid').toBe(924000 - ZELLE);
      expect(d.status, 'not paid yet').not.toBe('paid');
    });

    await test.step('the invoice detail shows the payment and the balance', async () => {
      await page.evaluate((id) => window.InvoicePipeline.showInvoiceDetailModal(id), invoiceId);
      const detail = page.locator('#nbd-invoice-detail-modal');
      await expect(detail.locator('.invoice-detail')).toBeVisible({ timeout: 15_000 });
      await expect(detail, 'payment history lists the Zelle payment').toContainText(/Zelle/);
      await expect(detail).toContainText('$4,000');
      // Balance Due is the part owed after the deposit (invoice-pipeline.js
      // paymentSummaryRows, 2026-09-14 convention): Deposit due (remaining) +
      // Balance Due = what is still owed, which is the saved balanceDue.
      const txt = await detail.locator('.invoice-detail').innerText();
      const row = (re) => { const m = re.exec(txt); return m ? cents(m[1].replace(/,/g, '')) : null; };
      const depLeft = row(/Deposit due \(remaining\):?\s*\$([\d,]+\.\d\d)/);
      const balance = row(/Balance Due:?\s*\$([\d,]+\.\d\d)/);
      expect(depLeft, 'the unpaid part of the deposit is shown').not.toBeNull();
      expect(balance, 'Balance Due is shown').not.toBeNull();
      const dep = cents((await invoiceDoc(page, invoiceId)).depositAmount);
      expect(dep, 'the invoice carries a deposit (50% rule)').toBeGreaterThan(ZELLE);
      expect(depLeft, 'deposit remaining = deposit − the Zelle payment').toBe(dep - ZELLE);
      expect(balance, 'Balance Due = total − deposit').toBe(924000 - dep);
      expect(depLeft + balance, 'together: what is still owed').toBe(924000 - ZELLE);
      // Jo 2026-10-02: the bold Total owed line says it in one number.
      expect(row(/Total owed:?\s*\$([\d,]+\.\d\d)/), 'Total owed = what is still owed').toBe(924000 - ZELLE);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      expect(wide, 'the detail does not scroll sideways').toBe(false);
      await page.evaluate(() => { const m = document.getElementById('nbd-invoice-detail-modal'); if (m) m.remove(); });
    });

    await test.step('Record Payment again: defaults to what is left; Check pays it off', async () => {
      await page.evaluate((id) => { window.InvoicePipeline.markPaidUI(id); }, invoiceId);
      await expect(page.locator('#nbd-markpaid-modal .modal')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#nbd-mp-amount'), 'the amount defaults to the remaining balance').toHaveValue('5240.00');
      await checkSheet(page);
      const check = page.locator('#nbd-markpaid-modal .nbd-mp-method[data-method="check"]');
      await check.tap();
      await expect(check).toHaveAttribute('aria-pressed', 'true');
      await page.locator('#nbd-mp-ref').fill('1042');
      const save = page.locator('#nbd-mp-save');
      await save.scrollIntoViewIfNeeded();
      expect(await reachable(save)).toBe(true);
      await save.tap();
      await expect(page.locator('#nbd-markpaid-modal')).toHaveCount(0, { timeout: 20_000 });
      const d = await invoiceDoc(page, invoiceId);
      expect(d.payments.map((p) => p.method), 'Zelle then Check').toEqual(['zelle', 'check']);
      expect(cents(d.amountPaid), 'paid in full').toBe(924000);
      expect(cents(d.balanceDue), 'nothing owed').toBe(0);
      expect(d.status).toBe('paid');
    });
  });
});
