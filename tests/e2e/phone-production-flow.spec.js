// tests/e2e/phone-production-flow.spec.js — the after-contract production
// flow on an iPhone (390x844), in the INSTALLED app (2026-10-04).
//
//   1. Customer page: the production strip (Permit → Ordered → Delivery →
//      Sub → Start). "Not required" answers the permit (#2128's
//      permitNotRequired); a material order whose delivery lands after the
//      start day warns, saves, and fills the strip.
//   2. The sub picker + roster: add a sub whose insurance certificate has
//      expired → the picker warns (never blocks); saving puts subId + the
//      sub's name on the lead. "Send to sub" builds the job sheet (address,
//      start, access notes — no prices, no homeowner phone) and hands it to
//      the phone's share sheet (stubbed navigator.share).
//   3. Plan Jobs: "Rain day" pushes the job and every committed job after it
//      by N working days — preview, then one save through
//      NBDScheduleWindow.check; weekends are skipped.
//   4. The Schedule view's 7-day busy strip: a CRM job, a Google busy block
//      (getBusyTimes stubbed) and a delivery each shade their own cells; the
//      strip fits the screen.
//
// Google (getBusyTimes) and weather.gov (getJobWeather) are stubbed at the
// network: nothing leaves the rig. Every seeded doc carries e2eTestData + an
// e2eRun tag (fixtures/seeded-run.js); orders and subs are removed here.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390, H = 844;
let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

async function noSideScroll(page) {
  return safeEvaluate(page, () => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function boxFits(page, selector) {
  const b = await page.locator(selector).first().boundingBox();
  return !!b && b.x >= -0.5 && b.x + b.width <= W + 0.5;
}
async function dismissToasts(page) {
  for (let i = 0; i < 8; i++) {
    const close = page.locator('#toastContainer .toast-close').first();
    if (!(await close.count())) return;
    await close.tap({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
}
const readLead = (page, id) => safeEvaluate(page, async (leadId) => {
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const s = await fs.getDocFromServer(fs.doc(window.db || window._db, 'leads', leadId));
  return s.exists() ? s.data() : null;
}, id);
const readOrders = (page, id) => safeEvaluate(page, async (leadId) => {
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const snap = await fs.getDocsFromServer(fs.collection(window.db || window._db, 'leads', leadId, 'jobs', 'j1', 'orders'));
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}, id);
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
// The browser runs in New York time (timezoneId below); the strip's days and
// the stubbed Google block are New York days too, wherever CI runs.
const SWN = require('../../functions/schedule-window.js');
const nyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nyDay = (n) => SWN.addDays(nyToday(), n);

test.describe.serial('phone production flow at 390px, installed app @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let run = '';
  let stamp = 0;
  let leadA = null;           // the customer-page job
  const seededOrders = [];    // [leadId]
  const seededSubs = [];      // sub names (removed by name in afterAll)
  const textChecks = [];      // phoneTextAction payloads (the ok-to-text stub)

  async function seedLead(fields) {
    return safeEvaluate(page, async ({ f, tag }) => {
      const id = await window._saveLead(Object.assign({ e2eTestData: true, e2eRun: tag }, f));
      if (id) return id;
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const snap = await fs.getDocs(fs.query(fs.collection(window.db, 'leads'), fs.where('userId', '==', window._user.uid), fs.where('lastName', '==', f.lastName)));
      return snap.docs.length ? snap.docs[0].id : null;
    }, { f: fields, tag: run });
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    stamp = Date.now();
    run = 'phone-production-flow:' + stamp;
    context = await browser.newContext({
      viewport: { width: W, height: H }, isMobile: true, hasTouch: true, serviceWorkers: 'block', timezoneId: 'America/New_York',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await context.addInitScript(() => {
      try { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); } catch (_) {}
      // The share sheet: record what would have been shared (nothing leaves).
      window.__shared = [];
      try { Object.defineProperty(Navigator.prototype, 'share', { value: async (d) => { window.__shared.push(d); }, configurable: true }); } catch (_) {}
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
        const today = new Date().toISOString().split('T')[0];
        ['overdue_scan', 'pending_estimate_scan', 'morning_briefing'].forEach((k) => localStorage.setItem('nbd_proactive_' + k, today));
      } catch (_) {}
    });
    page = await context.newPage();
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.route('**/api.weather.gov/**', (r) => r.fulfill({ status: 500, body: 'stubbed' }));
    // Callables: Google busy times + job weather stubbed; anything else answers null.
    await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => {
      const url = r.request().url();
      if (/getBusyTimes/.test(url)) {
        const s = SWN.localToUtcMs(nyDay(1), '09:00');
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: {
          configured: true, primaryShared: true, jobsCalendarId: 'jobs@group', primaryCalendarId: 'jo@example.test',
          blocks: [{ startMs: s, endMs: s + 2 * 3600000, calendars: ['jo@example.test'], titles: [] }] } }) });
      }
      if (/getJobWeather/.test(url)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { byLead: {} } }) });
      // phoneTextAction (review R2-3-2): a send to a sub's number is checked
      // against the STOP / Do Not Text lists first and fails CLOSED, so yes.
      if (/phoneTextAction/.test(url)) {
        try { textChecks.push((JSON.parse(r.request().postData() || '{}').data) || {}); } catch (_) {}
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { ok: true } }) });
      }
      return r.fulfill({ contentType: 'application/json', body: '{"result":null}' });
    });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user && Array.isArray(window._leads)
      && typeof window._saveLead === 'function' && !!window.NBDProduction && !!window.NBDProductionLogic, { timeout: 30_000 });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    if (!context) return;
    await safeEvaluate(page, async ({ leads, names }) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      for (const id of leads) {
        try { const s = await fs.getDocs(fs.collection(db, 'leads', id, 'jobs', 'j1', 'orders')); for (const d of s.docs) await fs.deleteDoc(d.ref); } catch (_) {}
      }
      const t = (window._userClaims && window._userClaims.companyId) || window._user.uid;
      try { const s = await fs.getDocs(fs.collection(db, 'companies', t, 'subs')); for (const d of s.docs) if (names.includes(d.data().name)) await fs.deleteDoc(d.ref); } catch (_) {}
    }, { leads: seededOrders, names: seededSubs }).catch(() => {});
    const res = await deleteSeededRun({ page, context, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-production-flow] cleanup: ' + res.failed.join('; '));
    await context.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  async function openCustomer(id) {
    await page.goto('/pro/customer.html?id=' + id);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1' && !!window._leadDoc && !!window.NBDProduction, { timeout: 30_000 });
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
    await expect(page.locator('#productionPanel .pr-strip')).toBeVisible({ timeout: 15_000 });
  }

  test('1. customer page: the production strip — permit "not required", an order that lands after the start', async () => {
    const start = new Date(); start.setDate(start.getDate() + 6);
    leadA = await seedLead({ firstName: '[E2E] Prod', lastName: 'PFlow' + String(stamp).slice(-6), address: String(stamp).slice(-4) + ' Strip Way, Mason, OH',
      stage: 'job_created', jobType: 'cash', jobValue: 14000, contractFiledAt: '2026-09-01T00:00:00Z', scheduledDate: ymd(start), scopeOfWork: 'Tear off, 24 SQ architectural' });
    expect(leadA, 'lead seeded').toBeTruthy();
    seededOrders.push(leadA);
    await openCustomer(leadA);
    const steps = page.locator('#productionPanel .pr-step');
    await expect(steps).toHaveCount(5);
    await expect(page.locator('#productionPanel .pr-step-label')).toHaveText(['Permit', 'Ordered', 'Delivery', 'Sub', 'Start']);
    expect(await noSideScroll(page), 'no sideways scroll at 390px').toBe(true);
    expect(await boxFits(page, '#productionPanel'), 'the panel fits the screen').toBe(true);

    // Permit → Not required.
    await dismissToasts(page);
    await page.locator('[data-pr-step="permit"]').tap();
    await page.locator('input[name="prPermit"][value="none"]').check();
    await page.locator('#prPermitCity').fill('Mason');
    await page.locator('[data-pr-action="save-permit"]').tap();
    await expect.poll(async () => (await readLead(page, leadA)).permitNotRequired, { timeout: 10_000 }).toBe(true);
    const l1 = await readLead(page, leadA);
    expect(l1.permitFiledAt || '', 'never a fake filed stamp').toBe('');
    await expect(page.locator('[data-pr-step="permit"] .pr-step-val')).toContainText('Not required');

    // Ordered → a material order, delivery the day AFTER the start → warns, still saves.
    await dismissToasts(page);
    await page.locator('[data-pr-step="ordered"]').tap();
    await page.locator('[data-pr-action="new-order"]').tap();
    await page.locator('#prOrdStore').selectOption('Gulf Eagle Supply');
    const late = new Date(start); late.setDate(late.getDate() + 1);
    await page.locator('#prOrdDeliv').fill(ymd(late));
    await page.locator('#prOrdDeliv').dispatchEvent('change');
    await expect(page.locator('#prOrdWarn')).toContainText('after the start day');
    const save = page.locator('[data-pr-action="save-order"]');
    const sb = await save.boundingBox();
    expect(sb.height, 'Add order is a 44px target').toBeGreaterThanOrEqual(44);
    await save.tap();
    await expect.poll(async () => (await readOrders(page, leadA)).length, { timeout: 10_000 }).toBe(1);
    const o = (await readOrders(page, leadA))[0];
    expect(o.store).toBe('Gulf Eagle Supply');
    expect(o.deliveryDate).toBe(ymd(late));
    expect(o.userId, 'owner pinned to the lead').toBe(l1.userId);
    expect(Object.keys(o).some((k) => /cost|price|total|margin/i.test(k)), 'no money keys on an order').toBe(false);
    await expect(page.locator('#productionPanel .pr-step').nth(1), 'Ordered is done').toHaveClass(/pr-done/);
    await expect(page.locator('#productionPanel .pr-step').nth(2).locator('.pr-step-warn'), 'Delivery warns on the strip').toContainText('after the start day');
  });

  test('2. sub roster + picker: an expired certificate warns; "Send to sub" shares the job sheet', async () => {
    expect(leadA).toBeTruthy();
    const subName = '[E2E] Ridge Bros ' + String(stamp).slice(-5);
    seededSubs.push(subName);
    await dismissToasts(page);
    await page.locator('[data-pr-step="sub"]').tap();
    await page.locator('[data-pr-action="roster"]').tap();
    await page.locator('#prSubName').fill(subName);
    await page.locator('#prSubPhone').fill('513-555-0177');
    const past = new Date(); past.setDate(past.getDate() - 3);
    await page.locator('#prSubExp').fill(ymd(past));
    await page.locator('[data-pr-action="save-roster"]').tap();
    await expect(page.locator('#productionPanel .pr-sub', { hasText: subName })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#productionPanel .pr-sub', { hasText: subName }).locator('.pr-cert')).toContainText('expired');

    await page.locator('[data-pr-step="sub"]').tap();
    const subId = await safeEvaluate(page, (n) => (window.NBDProduction.subs().find((s) => s.name === n) || {}).id, subName);
    expect(subId, 'the sub is on the roster').toBeTruthy();
    await page.locator('#prSubSel').selectOption(subId);
    await expect(page.locator('#prSubWarn')).toContainText('expired', { timeout: 10_000 });
    await page.locator('[data-pr-action="save-sub"]').tap();
    await expect.poll(async () => (await readLead(page, leadA)).subId, { timeout: 10_000 }).toBe(subId);
    expect((await readLead(page, leadA)).crew, 'the sub\'s name rides in crew').toBe(subName);
    await expect(page.locator('[data-pr-step="sub"] .pr-step-val')).toContainText(subName);

    // Send to sub.
    await dismissToasts(page);
    await page.locator('#productionPanel .pr-head [data-pr-action="sheet"]').tap();
    await page.locator('#prAccess').fill('Gate code 4411 — dog in the back yard');
    await page.locator('#prAccess').dispatchEvent('change');
    await expect(page.locator('#prSheetPreview')).toContainText('Gate code 4411');
    await page.locator('[data-pr-action="send-sheet"]').tap();
    await expect.poll(() => safeEvaluate(page, () => (window.__shared || []).length), { timeout: 10_000 }).toBe(1);
    const shared = await safeEvaluate(page, () => window.__shared[0]);
    expect(textChecks.some((d) => d.action === 'check' && d.recipient === 'crew'), "the sub's number was checked (crew) before the sheet opened").toBe(true);
    expect(shared.text).toContain('Strip Way, Mason, OH');
    expect(shared.text).toContain('https://www.google.com/maps/search/?api=1&query=');
    expect(shared.text).toContain('Tear off, 24 SQ architectural');
    expect(shared.text).toContain('Gate code 4411');
    expect(shared.text, 'no prices').not.toMatch(/\$|14,?000/);
    expect((await readLead(page, leadA)).accessNotes).toContain('Gate code 4411');
    expect(await noSideScroll(page), 'no sideways scroll with the editors open').toBe(true);
  });

  test('3. Plan Jobs: rain day pushes the job and every committed job after it, skipping weekends', async () => {
    await page.goto('/pro/dashboard.html');
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && Array.isArray(window._leads) && !!window.NBDProduction, { timeout: 30_000 });
    // Next Thursday + the Friday after it.
    const thu = new Date(); thu.setDate(thu.getDate() + ((4 - thu.getDay() + 7) % 7 || 7));
    const fri = new Date(thu); fri.setDate(fri.getDate() + 1);
    const tag = 'PRain' + String(stamp).slice(-6);
    const a = await seedLead({ firstName: '[E2E] RainA', lastName: tag + 'A', address: '1 Rain Way, Milford, OH', stage: 'crew_scheduled', jobType: 'cash', jobValue: 9000, scheduledDate: ymd(thu), scheduledStart: '07:00', scheduledEndDate: ymd(fri) });
    const b = await seedLead({ firstName: '[E2E] RainB', lastName: tag + 'B', address: '2 Rain Way, Milford, OH', stage: 'contract_signed', jobType: 'cash', jobValue: 8000, scheduledDate: ymd(fri) });
    expect(a && b).toBeTruthy();
    await safeWaitForFunction(page, (n) => (window._leads || []).filter((l) => String(l.lastName || '').startsWith(n)).length === 2, { timeout: 20_000 }, tag)
      .catch(async () => { await safeEvaluate(page, () => window._loadLeads && window._loadLeads()); });
    await safeEvaluate(page, () => { window.goTo('schedule'); window.scrollTo(0, 0); });
    await expect(page.locator('#schedPlanBody')).toBeVisible({ timeout: 15_000 });
    await safeEvaluate(page, (n) => { const s = document.getElementById('spSearch'); s.value = n; s.dispatchEvent(new Event('input', { bubbles: true })); }, tag);
    const row = `.sp-row[data-id="${a}"]`;
    await expect(page.locator(row)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(row + ' .sp-sub-sel'), 'Plan Jobs rows carry the sub picker').toHaveCount(1);
    const expected = await safeEvaluate(page, ({ ids }) => {
      const plan = window.NBDProductionLogic.rainPushPlan(window._leads, ids[0], 1);
      return plan.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, start: p.to.start, end: p.fields.scheduledEndDate }));
    }, { ids: [a, b] });
    expect(expected.length, 'both jobs are in the push').toBe(2);
    await dismissToasts(page);
    await page.locator(row + ' [data-sp-action="rain"]').tap();
    const sheet = page.locator('#prRainSheet .pr-sheet-card');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    expect(await boxFits(page, '#prRainSheet .pr-sheet-card'), 'the rain sheet fits the screen').toBe(true);
    await expect(sheet.locator('.pr-rain-row', { hasText: '[E2E] RainA' })).toBeVisible();
    await expect(sheet.locator('.pr-rain-row', { hasText: '[E2E] RainB' })).toBeVisible();
    const move = sheet.locator('[data-pr-action="rain-save"]');
    expect((await move.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await move.tap();
    await expect(page.locator('#prRainSheet')).toHaveCount(0, { timeout: 15_000 });
    for (const e of expected) {
      await expect.poll(async () => (await readLead(page, e.id)).scheduledDate, { timeout: 10_000 }).toBe(e.start);
      expect((await readLead(page, e.id)).scheduledEndDate || null).toBe(e.end || null);
    }
    const la = await readLead(page, a);
    expect(new Date(la.scheduledDate + 'T12:00:00').getDay(), 'Thu–Fri pushed one working day starts Friday').toBe(5);
    expect(new Date(la.scheduledEndDate + 'T12:00:00').getDay(), '...and ends Monday, not Saturday').toBe(1);
    expect(la.scheduledStart, 'start time kept').toBe('07:00');
  });

  test('4. the 7-day busy strip shades CRM jobs, Google busy and deliveries', async () => {
    const tag = 'PBusy' + String(stamp).slice(-6);
    const id = await seedLead({ firstName: '[E2E] Busy', lastName: tag, address: '3 Busy Way, Milford, OH', stage: 'crew_scheduled', jobType: 'cash', jobValue: 7000,
      scheduledDate: nyDay(2), scheduledStart: '13:00', scheduledDurationMin: 60 });
    expect(id).toBeTruthy();
    seededOrders.push(id);
    await safeEvaluate(page, async ({ leadId, day }) => {
      const lead = (window._leads || []).find((l) => l.id === leadId) || { userId: window._user.uid, companyId: (window._userClaims && window._userClaims.companyId) || window._user.uid };
      await window.NBDProduction.saveOrder(leadId, lead, { store: 'Home Depot', orderedDate: day, deliveryDate: day, status: 'ordered' }, null);
    }, { leadId: id, day: nyDay(1) });
    await safeWaitForFunction(page, (n) => (window._leads || []).some((l) => l.lastName === n), { timeout: 20_000 }, tag)
      .catch(async () => { await safeEvaluate(page, () => window._loadLeads && window._loadLeads()); });
    // getBusyTimes answers only Jo (owner / company_admin) — the test user is
    // neither, so the Google answer is stubbed one level up, at busyBetween.
    await safeEvaluate(page, async (s) => {
      window.NBDGoogleCalendarUI.busyBetween = async () => ({ configured: true, primaryShared: true, jobsCalendarId: 'jobs@group', primaryCalendarId: 'jo@example.test',
        blocks: [{ startMs: s, endMs: s + 2 * 3600000, calendars: ['jo@example.test'], titles: [] }] });
      await window.NBDProduction.loadTenantOrders(true);
      await window.NBDProduction.renderSchedExtras(true);
    }, SWN.localToUtcMs(nyDay(1), '09:00'));
    const strip = page.locator('#schedBusyStrip');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip.locator('.bs-day')).toHaveCount(7);
    await expect(strip.locator('.bs-day').nth(0).locator('.bs-cell')).toHaveCount(12);
    // Day +2: the 1 pm job shades the 1 pm cell (index 6: 7am…).
    await expect(strip.locator('.bs-day').nth(2).locator('.bs-cell').nth(6)).toHaveClass(/bs-job/);
    // Day +1: the stubbed Google block 9–11 am shades 9 and 10 (index 2, 3); the delivery shades the rest lightly.
    await expect(strip.locator('.bs-day').nth(1).locator('.bs-cell').nth(2)).toHaveClass(/bs-busy/);
    await expect(strip.locator('.bs-day').nth(1).locator('.bs-cell').nth(3)).toHaveClass(/bs-busy/);
    await expect(strip.locator('.bs-day').nth(1).locator('.bs-cell').nth(0)).toHaveClass(/bs-deliv/);
    await expect(strip.locator('.bs-day').nth(1).locator('.bs-note')).toContainText('🚚');
    expect(await boxFits(page, '#schedBusyStrip'), 'the strip fits 390px').toBe(true);
    expect(await noSideScroll(page), 'no sideways scroll on the Schedule view').toBe(true);
  });
});
