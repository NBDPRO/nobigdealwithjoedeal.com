// tests/e2e/phone-close-flow.spec.js — closing a roof from the phone
// (2026-10-03). The installed iPhone app at 390 × 844, standalone rules
// forced on (same harness as phone-v3-wizard.spec.js).
//
//   1. The V3 wizard opened from a lead skips the Customer step; Finish
//      shows ONE primary, "Send to homeowner"; the rest is under More.
//   2. "Send to homeowner" SAVES the estimate first (lead gets the primary
//      estimate + job value), creates the deal, mints the link and opens the
//      share sheet — and the builder stays on screen. A second send updates
//      the same estimate instead of adding a copy.
//   3. "Sign on this phone" on a Kentucky insurance job with NO email: the
//      BoldSign button is hidden, and the accept page opens in-app with the
//      signature pad, the KRS 367.624 notices and Call / Text buttons.
//
// Nothing is sent from the server: the createDealAcceptToken callable and
// the /deal/<token> page are answered in the browser (the functions emulator
// is not started — submitDealAcceptance's alerts would be real), and
// navigator.share is recorded, not shown.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const SHOTS = process.env.NBD_E2E_SHOTS || '';

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

const DEAL_ROOM_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'pro', 'deal-room.js'), 'utf8');

async function signIn(page, token) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/renderPdf**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"status":"INTERNAL","message":"mocked"}}' }));
  // The accept-link callable, answered here (no functions emulator).
  await page.route('**/createDealAcceptToken**', (r) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    return r.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ result: { token, acceptUrl: 'http://127.0.0.1:5000/deal/' + token, expiresAt: Date.now() + 864e5 } }) });
  });
  await page.addInitScript(() => {
    try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ }
    // Record the share sheet instead of opening the OS one.
    window.__shared = [];
    navigator.share = (d) => { window.__shared.push(d); return Promise.resolve(); };
  });
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

async function seedLead(page, extra) {
  return safeEvaluate(page, async (x) => {
    const stamp = Date.now();
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const last = 'Close' + stamp;
    const lead = Object.assign({
      firstName: '[E2E] Close', lastName: last,
      address: stamp + ' Close Way, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7),
      email: 'e2e-close-' + stamp + '@nbd.test',
      stage: 'new', e2eTestData: true,
      userId: uid, companyId, createdAt: fsMod.serverTimestamp(),
    }, x || {});
    Object.keys(lead).forEach((k) => { if (lead[k] === null) delete lead[k]; });
    const id = (await fsMod.addDoc(fsMod.collection(db, 'leads'), Object.assign({ meter: 'manual' }, lead))).id; // server lead meter (firestore.rules leadMeterOk, 2026-10-04)
    if (typeof window.loadLeads === 'function') await window.loadLeads();
    for (let i = 0; i < 75 && !(window._leads || []).some((l) => l.id === id); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return { id };
  }, extra || null);
}

async function openWizard(page, arg) {
  await safeWaitForFunction(page, () => !!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function'), { timeout: 20_000 });
  await safeEvaluate(page, async (a) => {
    await window.ScriptLoader.loadBundle('estimates');
    window.openEstimateV2Builder(a);
  }, arg);
  await expect(page.locator('#estV2Modal.open.v3-on')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast-container .toast, #toast.toast').forEach((t) => t.remove()));
}
async function reachable(locator) {
  await clearToasts(locator.page());
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (h === el || el.contains(h));
  });
}
const tapNext = (page) => page.locator('#estV2Modal .v3-next').tap();
async function jumpTo(page, title) {
  await page.locator('#estV2Modal .v3-jump').tap();
  await page.locator('#estV2Modal .v3-sheet:not([hidden]) .v3-sheet-row').filter({ hasText: title }).tap();
  await expect(page.locator('#estV2Modal .v3-title')).toHaveText(title);
}
async function loadRoof(page) {
  await jumpTo(page, 'Package');
  await page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]').tap();
  await expect(page.locator('#estV2Modal .v3-pkg .v3-tier').first()).toBeVisible();
}
async function estimatesFor(page, leadId) {
  return safeEvaluate(page, async (id) => {
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'estimates'), fsMod.where('leadId', '==', id), fsMod.where('userId', '==', uid)));
    const lead = (await fsMod.getDoc(fsMod.doc(db, 'leads', id))).data() || {};
    return { ids: snap.docs.map((d) => d.id), primary: lead.primaryEstimateId || null, jobValue: lead.jobValue || null };
  }, leadId);
}

test.describe('phone close flow: send to homeowner + sign on this phone @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('wizard skips Customer; Finish has one primary; Send to homeowner saves, links, shares and stays', async ({ page }) => {
    test.setTimeout(180_000);
    const token = 'tok-e2e-send-' + Date.now();
    await signIn(page, token);
    const lead = await seedLead(page, { jobType: 'cash' });
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await openWizard(page, { leadId: lead.id });

    await test.step('opened from a lead: Customer is skipped; the lead\'s Cash job type is applied', async () => {
      await expect(page.locator('#estV2Modal .v3-title')).toHaveText('Measure');
      await expect(page.locator('#estV2Modal .v3-count')).toHaveText('2 / 10');
      await expect(page.locator('#v2jobCash')).toHaveClass(/active/);
      await page.locator('#v2rawSqft').fill('2400');
      await page.locator('#v2rawSqft').dispatchEvent('input');
    });

    await test.step('price it Per-SQ', async () => {
      await loadRoof(page);
      const perSq = page.locator('#v2modePerSq');
      await perSq.scrollIntoViewIfNeeded();
      await perSq.tap();
      await expect(perSq).toHaveClass(/active/);
    });

    await test.step('Finish: ONE primary; the rest under More', async () => {
      await jumpTo(page, 'Finish');
      const send = page.locator('#v2sendHoBtn');
      await expect(send).toBeVisible();
      expect(await reachable(send), 'Send to homeowner is not covered').toBe(true);
      expect((await send.boundingBox()).height, 'primary is thumb-sized').toBeGreaterThanOrEqual(52);
      for (const sel of ['#v2saveBtn', '#v2signBtn', '#v2signPhoneBtn', '[data-action="present"]', '.v2-export-btns']) {
        await expect(page.locator('#estV2Modal ' + sel).first(), sel + ' waits under More').toBeHidden();
      }
      const visibleButtons = await page.locator('#estV2Modal .v2-body button:visible').evaluateAll((els) => els.filter((e) => !e.closest('.v3-head')).map((e) => (e.textContent || '').trim()));
      expect(visibleButtons, 'Finish shows the primary + More, nothing else').toEqual(['📲 Send to homeowner', 'More ▾']);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'close-finish-390.png') });
      await page.locator('#estV2Modal .v3-more').tap();
      for (const sel of ['#v2saveBtn', '#v2signPhoneBtn', '#v2signBtn']) await expect(page.locator(sel)).toBeVisible();
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'close-finish-more-390.png') });
      await page.locator('#estV2Modal .v3-more').tap();
      await expect(page.locator('#v2saveBtn')).toBeHidden();
    });

    await test.step('Send to homeowner: saved → deal → link → share sheet, builder stays open', async () => {
      const before = await estimatesFor(page, lead.id);
      expect(before.ids.length, 'nothing saved yet').toBe(0);
      await page.locator('#v2sendHoBtn').tap();
      await expect(page.locator('#v2shareStatus')).toHaveText(/Link ready/, { timeout: 30_000 });
      const shared = await page.evaluate(() => window.__shared);
      expect(shared.length, 'the share sheet opened once').toBe(1);
      expect(shared[0].url, 'it carries the accept link').toContain('/deal/' + token);
      const after = await estimatesFor(page, lead.id);
      expect(after.ids.length, 'the estimate was saved').toBe(1);
      expect(after.primary, 'the lead\'s primary estimate is stamped').toBe(after.ids[0]);
      expect(Number(after.jobValue), 'the lead\'s job value is stamped').toBeGreaterThan(0);
      const deal = await page.evaluate(() => (window.CloseBoard.getDeals() || [])[0] || null);
      expect(deal && deal.estimateId, 'the deal is tied to the saved estimate').toBe(after.ids[0]);
      expect(deal.sentVia, 'shared → deal marked sent').toBe('link');
      await expect(page.locator('#estV2Modal.open'), 'the builder stays on screen').toBeVisible();
      await expect(page.locator('#estV2Modal .v3-title')).toHaveText('Finish');
      await expect(page.locator('#v2shareBox'), 'Text / Email / Copy fallbacks').toBeVisible();
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'close-sent-390.png') });

      await page.locator('#v2sendHoBtn').tap();
      await expect.poll(async () => (await page.evaluate(() => window.__shared.length)), { timeout: 30_000 }).toBe(2);
      const again = await estimatesFor(page, lead.id);
      expect(again.ids, 'a second send updates the same estimate, no copy').toEqual(after.ids);
      expect(await page.evaluate(() => window.CloseBoard.getDeals().length), 'and the same deal').toBe(1);
    });
  });

  test('Kentucky insurance, no email: BoldSign hidden; Sign on this phone opens the accept page with the notices', async ({ page, context }) => {
    test.setTimeout(180_000);
    const token = 'tok-e2e-sign-' + Date.now();
    await signIn(page, token);
    const lead = await seedLead(page, {
      address: Date.now() + ' Dixie Hwy, Florence, KY 41042', email: null,
      jobType: 'insurance', insCarrier: 'E2E Mutual', claimNumber: 'E2E-CLM-1',
    });
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    // A Kentucky insurance deal page needs the contractor mailing address
    // (KRS 367.624) — give the test tenant one.
    await page.evaluate(() => {
      const orig = window._brand;
      window._brand = function () {
        const b = Object.assign({}, orig ? orig() : {});
        b.contact = Object.assign({}, b.contact || {}, { mailingAddress: '100 Test Ave, Cincinnati, OH 45202', phone: '(513) 555-0199' });
        return b;
      };
    });
    // The /deal/<token> page: getDealRoom serves the uploaded page — here,
    // the page the app just generated for this deal.
    await context.route('**/deal/' + token, async (r) => {
      const html = await page.evaluate(() => { const d = window.CloseBoard.getDeals()[0]; return window.CloseBoard.generatePageHTML(d); });
      await r.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    await context.route('https://nobigdealwithjoedeal.com/pro/deal-room.js**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: DEAL_ROOM_JS }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

    await openWizard(page, { leadId: lead.id });
    await expect(page.locator('#estV2Modal .v3-title'), 'skips Customer').toHaveText('Measure');
    await page.locator('#v2rawSqft').fill('2400');
    await page.locator('#v2rawSqft').dispatchEvent('input');
    await loadRoof(page);
    await jumpTo(page, 'Finish');
    await page.locator('#estV2Modal .v3-more').tap();

    await expect(page.locator('#v2signBtn'), 'Kentucky insurance: e-mail e-signature is hidden').toBeHidden();
    await expect(page.locator('#v2kyNote')).toBeVisible();
    await expect(page.locator('#v2kyContractBtn')).toBeVisible();
    const signPhone = page.locator('#v2signPhoneBtn');
    await signPhone.scrollIntoViewIfNeeded();
    expect(await reachable(signPhone)).toBe(true);
    expect((await signPhone.boundingBox()).height).toBeGreaterThanOrEqual(44);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'close-ky-more-390.png') });

    const popupP = context.waitForEvent('page');
    await signPhone.tap();
    const popup = await popupP;
    await popup.waitForURL('**/deal/' + token, { timeout: 30_000 });
    await expect(popup.locator('#sigCanvas'), 'the signature pad').toBeVisible();
    await expect(popup.locator('.nbd-ky-notices'), 'the KRS 367.624 notices').toBeVisible();
    await expect(popup.getByText('NOTICE OF CANCELLATION').first(), 'the cancellation form').toBeAttached();
    for (const name of ['📞 Call', '💬 Text']) {
      const b = popup.locator('a.rep-btn', { hasText: name });
      await expect(b).toBeVisible();
      expect((await b.boundingBox()).height, name + ' is 44px').toBeGreaterThanOrEqual(44);
    }
    expect(await popup.locator('a.rep-btn').first().getAttribute('href')).toMatch(/^tel:/);
    await expect(popup.locator('.warranty-badge'), 'no flat lifetime badge').toHaveCount(0);
    if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'close-ky-accept-390.png'), fullPage: false });

    const saved = await estimatesFor(page, lead.id);
    expect(saved.ids.length, 'saved before the deal').toBe(1);
    await expect(page.locator('#estV2Modal.open'), 'the builder is still open behind').toBeAttached();
  });
});
