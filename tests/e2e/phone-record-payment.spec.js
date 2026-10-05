// tests/e2e/phone-record-payment.spec.js — Record payment on a won job that
// has NO invoice and NO estimate, on a phone (390 × 844, standalone rules).
//
// The 2026-10-03 prod audit: 30 jobs at install or later, 4 with invoices,
// 0 check / Zelle / cash payments ever recorded — Mark Paid needed an
// existing invoice and making one needed an estimate. Here the customer page's
// one Record payment sheet does it all:
//
//   the sheet says "no invoice, no estimate" and asks the rep to CONFIRM the
//   job total (the lead's jobValue is only a suggestion) → the invoice is
//   created → the $3,000 Zelle is recorded on it (status partial, $5,200
//   owed) → Total Paid on the page is $3,000 (revenue = collected, dated
//   today) → one "Payment received" line on the timeline.
//
// Nothing may email or text anyone: every Cloud Function call is intercepted
// and the receipt box is left unticked (the lead's address is Resend's test sink).
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

test.describe('phone record payment: a won job with no invoice @shard2', () => {
  test.skip(!creds, 'needs PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD');
  test.use(IPHONE);
  test.setTimeout(150_000);

  test('Record payment → invoice created, payment recorded, revenue updates, timeline line appears', async ({ page }) => {
    // Every Cloud Function call (sendEmail, sendSMS, createStripePaymentLink…)
    // is answered here and counted — nothing leaves the machine.
    const fnCalls = [];
    await page.route(/(127\.0\.0\.1:5001|cloudfunctions\.net|\.run\.app)\//, (route) => {
      fnCalls.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, result: { success: true } }) });
    });
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid), { timeout: 20_000 });

    const uid = await page.evaluate(() => window._user.uid);
    const companyId = await page.evaluate(() => (window._userClaims && window._userClaims.companyId) || window._user.uid);
    const stamp = Date.now();
    const lead = {
      firstName: '[E2E] Paid', lastName: 'NoInvoice' + stamp, address: stamp + ' Gutter Ln, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7), email: 'delivered@resend.dev', stage: 'install_complete', jobType: 'cash', jobValue: 8200,
      e2eTestData: true, userId: uid, companyId,
    };
    const leadId = await safeEvaluate(page, async (lead) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      return (await fs.addDoc(fs.collection(db, 'leads'), Object.assign({ meter: 'manual' }, lead, { createdAt: fs.serverTimestamp() }))).id;
    }, lead);

    await page.goto('/pro/customer.html?id=' + leadId);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 25_000 });
    await forceStandalone(page);
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

    // No invoice yet — but the panel offers Record payment.
    const open = page.locator('#invoiceList [data-rp-open]');
    await expect(open).toHaveCount(1, { timeout: 25_000 });
    await expect(page.locator('#invoiceList')).toContainText('No invoices yet');
    await open.scrollIntoViewIfNeeded();
    const ob = await open.boundingBox();
    expect(ob && ob.height >= 44 && ob.x >= 0 && ob.x + ob.width <= 390).toBeTruthy();
    await open.click();

    const sheet = page.locator('#nbd-recordpay-modal');
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect(sheet.locator('[data-rp-target="jobValue"]')).toContainText('Confirm the job total');
    // jobValue is a SUGGESTION in an editable field, never used unconfirmed.
    await expect(sheet.locator('#nbd-rp-total')).toHaveValue('8200.00');
    // The receipt email is OPT-IN here (old checks must not surprise customers).
    await expect(sheet.locator('#nbd-rp-receipt')).not.toBeChecked();

    // Every target is thumb-sized and nothing runs off a 390px screen.
    const small = await page.evaluate(() => [...document.querySelectorAll('#nbd-recordpay-modal button, #nbd-recordpay-modal input:not([type=checkbox]), #nbd-recordpay-modal label.ipx-rp-confirm')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ t: (el.textContent || el.id || '').trim().slice(0, 30), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.height < 44 || x.r.left < 0 || x.r.right > 390).map((x) => x.t + ':' + Math.round(x.r.height)));
    expect(small).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('record-payment-sheet-390.png') });

    // Saving without confirming the total is refused (nothing written).
    await sheet.locator('[data-method="zelle"]').click();
    await sheet.locator('#nbd-rp-amount').fill('3000');
    await sheet.locator('#nbd-rp-ref').fill('ZE2E' + String(stamp).slice(-4));
    await sheet.locator('#nbd-rp-save').click();
    await expect(sheet).toBeVisible();
    const none = await safeEvaluate(page, async (leadId) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const snap = await fs.getDocs(fs.query(fs.collection(window.db, 'invoices'), fs.where('leadId', '==', leadId), fs.where('createdBy', '==', window._user.uid)));
      return snap.size;
    }, leadId);
    expect(none).toBe(0);

    await sheet.locator('label.ipx-rp-confirm').filter({ hasText: 'This is the job total' }).click();
    await sheet.locator('#nbd-rp-save').click();
    await expect(sheet).toHaveCount(0, { timeout: 20_000 });

    // The invoice exists, carries the payment, and is part paid.
    const inv = await safeEvaluate(page, async (leadId) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const snap = await fs.getDocs(fs.query(fs.collection(window.db, 'invoices'), fs.where('leadId', '==', leadId), fs.where('createdBy', '==', window._user.uid)));
      return snap.docs.map((d) => {
        const x = d.data();
        const p = (x.payments || [])[0] || {};
        const at = p.at && p.at.toDate ? p.at.toDate() : new Date(p.at);
        return { id: d.id, status: x.status, total: x.total, balanceDue: x.balanceDue, amountPaid: x.amountPaid, terms: x.terms,
          source: x.source, n: (x.payments || []).length, method: p.method, payer: p.payer, paymentId: p.paymentId, amount: p.amount,
          atToday: at.toDateString() === new Date().toDateString() };
      });
    }, leadId);
    expect(inv.length).toBe(1);
    expect(inv[0]).toMatchObject({ status: 'partial', total: 8200, balanceDue: 5200, amountPaid: 3000, terms: 'Net 7.', source: 'record_payment',
      n: 1, method: 'zelle', payer: 'homeowner', amount: 3000, atToday: true });

    // The list repainted: one invoice, part paid, Send balance offered; Total Paid is the cash.
    await expect(page.locator('#invoiceList .invoice-item')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('#invoiceList .invoice-status')).toHaveText('partial');
    await expect(page.locator('#invoiceList [data-send-balance]')).toHaveCount(1);
    const paidTile = page.locator('#invoiceList .summary-item').filter({ hasText: 'Total Paid' }).locator('.summary-value');
    await expect(paidTile).toHaveText('$3,000.00');
    const owedTile = page.locator('#invoiceList .summary-item').filter({ hasText: 'Total Owed' }).locator('.summary-value');
    await expect(owedTile).toHaveText('$5,200.00');
    await page.locator('#invoiceList').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('record-payment-after-390.png') });

    // Revenue = collected, by payment date: the dashboard's ONE revenue rule
    // (collected-revenue.js) counts this $3,000 today.
    await page.goto('/pro/dashboard.html');
    await safeWaitForFunction(page, () => !!(window.NBDRevenue && typeof window.NBDRevenue.loadInvoices === 'function' && window._user), { timeout: 30_000 });
    // loadInvoices resolves [] (uncached) while the dashboard is still booting
    // its auth/db, so poll until the load lands.
    await expect.poll(() => safeEvaluate(page, async (leadId) => {
      const invs = await window.NBDRevenue.loadInvoices({ force: true });
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return window.NBDRevenue.collectedBetween(invs, start.getTime(), Date.now() + 1000, (id) => id === leadId).total;
    }, leadId), { timeout: 20_000 }).toBe(3000);

    // One timeline line for the payment, at the payment's own id.
    const note = await safeEvaluate(page, async ({ leadId, invId, pid }) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const snap = await fs.getDocs(fs.query(fs.collection(window.db, 'notes'), fs.where('leadId', '==', leadId)));
      const pay = snap.docs.filter((d) => (d.data() || {}).type === 'payment');
      return { n: pay.length, id: pay[0] && pay[0].id, text: pay[0] && pay[0].data().text };
    }, { leadId, invId: inv[0].id, pid: inv[0].paymentId });
    expect(note.n).toBe(1);
    expect(note.id).toBe('pay-' + inv[0].id + '-' + inv[0].paymentId);
    expect(note.text).toContain('Payment received: $3,000.00 by Zelle');

    await page.goto('/pro/customer.html?id=' + leadId);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 25_000 });
    await expect(page.locator('#timelineList')).toContainText('Payment received: $3,000.00 by Zelle', { timeout: 25_000 });

    // Nothing was emailed or texted: the lead HAS an email, the receipt box was left
    // unticked, and no send function was called.
    expect(fnCalls.filter((u) => /sendEmail|sendSMS|sendSms|send-email|send-sms/i.test(u))).toEqual([]);
  });
});
