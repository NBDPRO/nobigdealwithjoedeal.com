// tests/e2e/phone-quick-wins.spec.js — the 2026-10-07 CRM phone audit's
// quick wins + "Record payment one tap from Home", on the installed iPhone app
// (390 × 844, standalone rules forced), on the emulator:
//
//   - Home "Money to collect" → ONE tap opens the Record payment sheet for that
//     invoice (was: land at the top of the customer page, ~12 screens above the
//     button, 17 swipes in the audit's walk);
//   - the sheet is solid (it had no background on customer.html) and Save is
//     green, not Cancel's navy;
//   - with an iPhone keyboard's worth of screen gone (844 → 508) the amount
//     field and Save are both on screen, Save not covering the field;
//   - a fresh device opens the CRM on All; a saved view still wins;
//   - Presentation mode is not a 🎤; Schedule's targets are all ≥ 44px.
//
// Nothing here sends anything: every Cloud Function call is answered locally
// and counted, and the test fails if a send function was called.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }
const EMU = !!process.env.FIRESTORE_EMULATOR_HOST;

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
    if (document.getElementById('e2e-force-standalone')) return -1;
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
    }
    const s = document.createElement('style'); s.id = 'e2e-force-standalone'; s.textContent = css; document.head.appendChild(s);
    return css.length;
  });
}
async function stubFunctions(page) {
  const calls = [];
  await page.route(/(127\.0\.0\.1:5001|cloudfunctions\.net|\.run\.app)\//, (route) => {
    calls.push(route.request().url());
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'stubbed (phone quick wins)' } }) });
  });
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  return calls;
}
const sends = (calls) => calls.filter((u) => /sendEmail|sendSMS|sendSms|send-email|send-sms/i.test(u));

test.describe('phone quick wins: Record payment from Home, CRM default, header, Schedule @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('Home → Record payment in one tap: solid sheet, green Save, Save above the keyboard, payment recorded', async ({ page }) => {
    test.skip(!EMU, 'seeds an owed invoice through the admin SDK: emulator mode only');
    test.setTimeout(150_000);
    const { db, auth } = admin();
    const user = await auth.getUserByEmail(creds.email);
    const uid = user.uid;
    const co = ((user.customClaims || {}).companyId) || uid;
    const s = Date.now();
    const leadId = (await db.collection('leads').add({ userId: uid, companyId: co, e2eTestData: true, deleted: false, createdAt: new Date(),
      firstName: 'ZZPay', lastName: 'Home' + s, stage: 'install_complete', jobType: 'cash', phone: '5135550161', email: 'delivered@resend.dev' })).id;
    const invId = 'e2e-qw-inv-' + s;
    await db.doc('invoices/' + invId).set({ createdBy: uid, userId: uid, companyId: co, leadId, status: 'sent', total: 4321, balanceDue: 4321, amountPaid: 0,
      payments: [], invoiceNumber: 'E2E-QW-' + s, createdAt: new Date(), dueDate: new Date(Date.now() - 3 * 86400000) });

    const calls = await stubFunctions(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
      } catch (e) { /* storage blocked */ }
    });
    await loginAs(page, creds);
    await safeEvaluate(page, () => window.goTo && window.goTo('home'));
    await forceStandalone(page);
    const row = page.locator('#todayPlan [data-tp-sec="money"] [data-tp-row]', { hasText: 'ZZPay Home' + s });
    await expect(row, 'the owed invoice is on Money to collect').toHaveCount(1, { timeout: 40_000 });
    const go = row.locator('a.tp-go');
    await expect(go).toHaveText(/Record payment/);
    expect(await go.getAttribute('href')).toBe('/pro/customer.html?id=' + encodeURIComponent(leadId) + '&pay=' + invId);
    // Today repaints its list on every data event: measure through the locator
    // (re-resolved), never a stale element handle.
    await expect.poll(() => go.evaluate((el) => Math.round(el.getBoundingClientRect().height)).catch(() => 0),
      { message: 'Record payment is thumb-sized' }).toBeGreaterThanOrEqual(44);

    // ONE tap → the customer page opens with the sheet already up.
    await go.tap();
    await page.waitForURL(/\/pro\/customer/, { timeout: 30_000 });
    const sheet = page.locator('#nbd-recordpay-modal');
    await expect(sheet, 'the Record payment sheet opens without scrolling or another tap').toBeVisible({ timeout: 30_000 });
    expect(page.url(), '&pay is dropped (a reload never reopens the sheet)').not.toContain('pay=');
    await forceStandalone(page);
    await expect(sheet.locator('[data-rp-target="existing"]')).toContainText('$4,321.00 owed');
    await expect(sheet.locator('#nbd-rp-amount')).toHaveValue('4321.00');

    // Solid card; Save is not Cancel's colour.
    const look = await safeEvaluate(page, () => {
      const alpha = (c) => { const m = c.match(/[\d.]+/g) || []; return /rgba|\//.test(c) ? Number(m[3]) : 1; };
      const card = document.querySelector('#nbd-recordpay-modal .modal');
      const cs = getComputedStyle(card);
      return { bg: cs.backgroundColor, alpha: alpha(cs.backgroundColor), pad: parseFloat(cs.paddingTop),
        save: getComputedStyle(document.getElementById('nbd-rp-save')).backgroundColor,
        cancel: getComputedStyle(document.getElementById('nbd-rp-cancel')).backgroundColor };
    });
    expect(look.alpha, 'the sheet has a solid background (was transparent: the page showed through) ' + look.bg).toBeGreaterThan(0.95);
    expect(look.pad).toBeGreaterThanOrEqual(12);
    expect(look.save, 'Save payment is visually distinct from Cancel').not.toBe(look.cancel);
    await page.screenshot({ path: test.info().outputPath('qw-record-payment-sheet-390.png') });

    // The keyboard takes ~336px of an 844px iPhone: the field and Save both show.
    await sheet.locator('[data-method="zelle"]').tap();
    const amt = sheet.locator('#nbd-rp-amount');
    await amt.tap();
    await amt.fill('1000');
    await page.setViewportSize({ width: 390, height: 508 });
    await page.waitForTimeout(400);
    await amt.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    await page.waitForTimeout(300);
    const kb = await safeEvaluate(page, () => {
      const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
      return { save: r('nbd-rp-save'), amount: r('nbd-rp-amount'), vh: innerHeight };
    });
    expect(kb.save.top >= 0 && kb.save.bottom <= kb.vh, 'Save is on screen above the keyboard ' + JSON.stringify(kb)).toBe(true);
    expect(kb.amount.top >= 0 && kb.amount.bottom <= kb.save.top + 1, 'the amount field is on screen and not under Save ' + JSON.stringify(kb)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('qw-record-payment-keyboard-390.png') });
    await sheet.locator('#nbd-rp-save').tap();
    await expect(sheet).toHaveCount(0, { timeout: 20_000 });
    await page.setViewportSize({ width: 390, height: 844 });

    await expect.poll(async () => {
      const d = (await db.doc('invoices/' + invId).get()).data() || {};
      return [d.status, d.amountPaid, d.balanceDue, (d.payments || []).length].join('|');
    }, { message: 'the $1,000 Zelle landed on THAT invoice', timeout: 20_000 }).toBe('partial|1000|3321|1');
    expect(sends(calls), 'recording a payment sends nothing').toEqual([]);
  });

  test('a fresh device opens the CRM on All; a saved view still wins', async ({ page }) => {
    test.setTimeout(120_000);
    await stubFunctions(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        if (!sessionStorage.getItem('qw-keep-view')) localStorage.removeItem('nbd_kanban_view');
      } catch (e) { /* storage blocked */ }
    });
    await loginAs(page, creds);
    // A user whose saved choice lives on the server (prefs-sync) would get it
    // back; the test account has none, so this is the fresh-device default.
    await safeEvaluate(page, () => window.goTo('crm'));
    await page.waitForSelector('#kanbanBoard .kanban-col', { state: 'attached', timeout: 30_000 });
    await expect.poll(() => safeEvaluate(page, () => ((document.querySelector('#kanbanViewSwitcher .kview-btn.active') || {}).dataset || {}).view),
      { message: 'the All tab is active on a device with no saved view (was Insurance: 2 of 14 leads)' }).toBe('simple');
    expect(await safeEvaluate(page, () => window._currentViewKey)).toBe('simple');

    await safeEvaluate(page, () => { sessionStorage.setItem('qw-keep-view', '1'); localStorage.setItem('nbd_kanban_view', 'cash'); });
    await page.reload();
    await page.waitForFunction(() => !!(window._user && window.goTo), null, { timeout: 30_000 });
    await safeEvaluate(page, () => window.goTo('crm'));
    await page.waitForSelector('#kanbanBoard .kanban-col', { state: 'attached', timeout: 30_000 });
    await expect.poll(() => safeEvaluate(page, () => window._currentViewKey), { message: 'a saved choice still wins' }).toBe('cash');
  });

  test('Presentation mode is not a mic; every Schedule target is 44px', async ({ page }) => {
    test.setTimeout(120_000);
    await stubFunctions(page);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* storage blocked */ } });
    await loginAs(page, creds);
    await safeEvaluate(page, () => window.goTo('schedule'));
    await page.waitForTimeout(3000);
    await forceStandalone(page);
    const small = await safeEvaluate(page, () => {
      const root = document.getElementById('view-schedule');
      const out = [];
      root.querySelectorAll('a[href], button, input:not([type=hidden]), select, label, [data-action], [data-sc-action]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') return;
        if (el.tagName === 'LABEL' && !el.querySelector('input')) return;
        if (el.tagName === 'INPUT' && el.closest('label')) return;   // the label is the target
        if (Math.round(r.height) < 44) out.push((el.innerText || el.value || el.id || el.className || '').toString().trim().replace(/\s+/g, ' ').slice(0, 30) + ':' + Math.round(r.height));
      });
      return out;
    });
    expect(small, 'Schedule targets under 44px at 390').toEqual([]);

    const leadId = await safeEvaluate(page, () => ((window._leads || [])[0] || {}).id || null);
    test.skip(!leadId, 'the test account has no lead to open');
    await page.goto('/pro/customer.html?id=' + encodeURIComponent(leadId));
    await page.waitForFunction(() => document.documentElement.style.opacity === '1', null, { timeout: 30_000 });
    const label = (await page.locator('#presentationModeBtn').textContent()) || '';
    expect(label, 'the Presentation button is not a mic (it read as voice notes)').not.toContain('🎤');
    expect(label).toContain('🖥');
  });
});
