// tests/e2e/phone-stage-flow.spec.js — moving a job through stages on an
// iPhone (390x844), in the INSTALLED app (navigator.standalone, so
// standalone-compat.js patches confirm() into its DOM modal — the case where a
// page exit or a native dialog hurts most).
//
// 2026-10-03, stage-flow lane:
//   1. Plan Jobs: saving a build day offers "Move to Crew Scheduled?" — one
//      tap moves the lead (moveCard → commitStageChange). A job already past
//      Crew Scheduled is not offered a backward move.
//   2. Customer page: a stage move blocked by a required field opens the
//      inline stage-gate sheet (never leaves the page); "No permit required"
//      answers the permit gate and is recorded as such.
//   3. …and "Estimate $" is pre-filled from the primary estimate.
//   5. D2D: "Appointment Set" asks for the date & time, lands the lead on
//      Contacted (not Inspected) and books the appointment as a lead event.
//
// Every seeded doc carries e2eTestData + an e2eRun tag (fixtures/seeded-run.js).
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390, H = 844;
let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

async function hitTest(page, selector) {
  return safeEvaluate(page, (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { why: 'missing' };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { why: '0x0' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { why: 'off-screen at y=' + Math.round(y) };
    const h = document.elementFromPoint(x, y);
    const ok = !!h && (h === el || el.contains(h));
    return { why: ok ? 'hit' : 'covered by ' + (h ? h.tagName + '.' + String(h.className).split(' ')[0] : 'nothing'), height: r.height, right: r.right };
  }, selector);
}
async function expectTappable(page, selector, label) {
  await expect.poll(async () => (await hitTest(page, selector)).why, { message: `${label} (${selector}) is under a thumb`, timeout: 8_000 }).toBe('hit');
  const h = await hitTest(page, selector);
  expect(h.height, `${label} is a 44px target`).toBeGreaterThanOrEqual(44);
  expect(h.right, `${label} fits the ${W}px screen`).toBeLessThanOrEqual(W);
}
async function dismissToasts(page) {
  for (let i = 0; i < 8; i++) {
    const close = page.locator('#toastContainer .toast-close').first();
    if (!(await close.count())) return;
    await close.tap({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}
const readLead = (page, id) => safeEvaluate(page, async (leadId) => {
  const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
  const s = await fs.getDocFromServer(fs.doc(window.db || window._db, 'leads', leadId));
  return s.exists() ? s.data() : null;
}, id);

test.describe.serial('phone stage flow at 390px, installed app @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let run = '';
  let stamp = 0;

  // Saves a lead through the dashboard's _saveLead (tagged), returns its id.
  async function seedLead(fields) {
    return safeEvaluate(page, async ({ f, tag }) => {
      window.__e2eSeeding = (async () => {
        const id = await window._saveLead(Object.assign({ e2eTestData: true, e2eRun: tag }, f));
        if (id) return id;
        const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
        const snap = await fs.getDocs(fs.query(fs.collection(window.db, 'leads'), fs.where('userId', '==', window._user.uid), fs.where('lastName', '==', f.lastName)));
        return snap.docs.length ? snap.docs[0].id : null;
      })();
      return window.__e2eSeeding;
    }, { f: fields, tag: run });
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    stamp = Date.now();
    run = 'phone-stage-flow:' + stamp;
    context = await browser.newContext({
      viewport: { width: W, height: H }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await context.addInitScript(() => {
      // The installed app: standalone-compat.js keys off navigator.standalone.
      try { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); } catch (_) {}
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
        const today = new Date().toISOString().split('T')[0];
        ['overdue_scan', 'pending_estimate_scan', 'morning_briefing'].forEach((k) => localStorage.setItem('nbd_proactive_' + k, today));
      } catch (_) {}
    });
    page = await context.newPage();
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user && Array.isArray(window._leads)
      && typeof window._saveLead === 'function' && typeof window.moveCard === 'function', { timeout: 30_000 });
    expect(await safeEvaluate(page, () => window._isStandalone === true), 'running as the installed app').toBe(true);
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    if (!context) return;
    const res = await deleteSeededRun({ page, context, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-stage-flow] cleanup: ' + res.failed.join('; '));
    await context.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('1. Plan Jobs: a build date offers "Move to Crew Scheduled?" and one tap moves the job', async () => {
    const name = 'SFlow' + String(stamp).slice(-6);
    const id = await seedLead({ firstName: '[E2E] Crew', lastName: name, address: String(stamp).slice(-4) + ' Crew Way, Milford, OH',
      stage: 'materials_delivered', jobType: 'cash', jobValue: 12000, contractFiledAt: '2026-09-01T00:00:00Z', permitFiledAt: '2026-09-02T00:00:00Z' });
    const past = await seedLead({ firstName: '[E2E] Past', lastName: name + 'P', address: String(stamp).slice(-4) + ' Past Way, Milford, OH',
      stage: 'install_in_progress', jobType: 'cash', jobValue: 9000 });
    expect(id && past, 'both leads seeded').toBeTruthy();
    await safeWaitForFunction(page, (n) => (window._leads || []).filter((l) => String(l.lastName || '').startsWith(n)).length === 2, { timeout: 20_000 }, name)
      .catch(async () => { await safeEvaluate(page, () => window._loadLeads && window._loadLeads()); });
    await safeEvaluate(page, () => { window.goTo('schedule'); window.scrollTo(0, 0); });
    await expect(page.locator('#schedPlanBody')).toBeVisible({ timeout: 15_000 });
    // "Show all open leads" + search narrows to our two rows.
    await safeEvaluate(page, (n) => {
      const all = document.getElementById('spAll');
      if (all && !all.checked) all.click();
      const s = document.getElementById('spSearch');
      s.value = n; s.dispatchEvent(new Event('input', { bubbles: true }));
    }, name);
    const row = `.sp-row[data-id="${id}"]`;
    await expect(page.locator(row)).toBeVisible({ timeout: 10_000 });
    const day = await safeEvaluate(page, () => { const d = new Date(); d.setDate(d.getDate() + 5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
    await page.locator(row + ' .sp-date').fill(day);
    await page.locator(row + ' [data-sp-action="save"]').tap();
    const chip = row + ' .sp-stage-chip';
    await expect(page.locator(chip)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(chip)).toContainText('Crew Scheduled');
    expect((await readLead(page, id)).stage, 'saving the date alone moves no stage').toBe('materials_delivered');
    await dismissToasts(page);
    await page.locator(chip).scrollIntoViewIfNeeded();
    await expectTappable(page, chip, '"Move to Crew Scheduled?" chip');
    await page.locator(chip).tap();
    await expect.poll(async () => (await readLead(page, id)).stage, { message: 'the tap moved the lead', timeout: 15_000 }).toBe('crew_scheduled');
    const after = await readLead(page, id);
    expect(after.scheduledDate, 'the date stayed').toBe(day);
    expect((after.stageHistory || []).some((h) => h && h.to === 'crew_scheduled'), 'stage history written (commitStageChange)').toBe(true);
    await expect(page.locator(chip)).toHaveCount(0);

    // A job already installing is not offered a backward move.
    const prow = `.sp-row[data-id="${past}"]`;
    await expect(page.locator(prow)).toBeVisible({ timeout: 10_000 });
    await page.locator(prow + ' .sp-date').fill(day);
    await page.locator(prow + ' [data-sp-action="save"]').tap();
    await expect.poll(async () => (await readLead(page, past)).scheduledDate, { timeout: 10_000 }).toBe(day);
    await expect(page.locator(prow + ' .sp-stage-chip')).toHaveCount(0);
  });

  async function openCustomer(id) {
    await page.goto('/pro/customer.html?id=' + id);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1' && typeof window.progressStage === 'function'
      && !!window._currentLead && !!window.NBDStageGateSheet, { timeout: 30_000 });
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
    // The installed app's own CSS (display-mode: standalone can't be emulated).
    await safeEvaluate(page, () => {
      let css = '';
      for (const sh of document.styleSheets) {
        let rules; try { rules = sh.cssRules; } catch (e) { continue; }
        for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
      }
      const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    });
  }
  async function tapAdvance() {
    const btn = '#stageProgressBtn';
    await expect(page.locator(btn)).toBeVisible({ timeout: 15_000 });
    await dismissToasts(page);
    await page.locator(btn).scrollIntoViewIfNeeded();
    await page.locator(btn).tap();
    // A normal move no longer asks "Move customer to X?" (2026-10-08, phone
    // audit #10: one tap, then Undo in the toast) — standalone-compat's DOM
    // confirm must NOT appear; the gate sheet is the next thing on screen.
    await expect(page.locator('.sa-btn-ok'), 'a normal move does not ask first').toHaveCount(0);
  }

  test('2. customer page: the permit gate opens the sheet; "No permit required" moves the job', async () => {
    await safeEvaluate(page, () => window.goTo('crm'));
    const id = await seedLead({ firstName: '[E2E] Permit', lastName: 'SFlowPermit' + String(stamp).slice(-6), address: String(stamp).slice(-4) + ' Permit Way, Milford, OH',
      stage: 'permit_pulled', jobType: 'cash', jobValue: 15000, contractFiledAt: '2026-09-01T00:00:00Z' });
    expect(id).toBeTruthy();
    await openCustomer(id);
    const url = page.url();
    await tapAdvance();
    const sheet = page.locator('.sgs-sheet');
    await expect(sheet, 'the gate opens the inline sheet').toBeVisible({ timeout: 10_000 });
    expect(page.url(), 'never leaves the customer page').toBe(url);
    await expect(sheet).toContainText('Materials Ordered');
    const box = await sheet.boundingBox();
    expect(box.x >= 0 && box.x + box.width <= W + 0.5, 'the sheet fits the screen').toBe(true);
    expect(box.y + box.height, 'anchored to the bottom').toBeGreaterThan(H - 4);
    // Save with no answer → still blocked, said in the sheet.
    await page.locator('.sgs-save').tap();
    await expect(page.locator('.sgs-err')).toContainText(/permit/i);
    const none = '.sgs-choice[data-value="none"]';
    await expectTappable(page, none, '"No permit required"');
    await expectTappable(page, '.sgs-choice[data-value="filed"]', '"Permit filed"');
    await page.locator(none).tap();
    await expect(page.locator(none)).toHaveAttribute('aria-pressed', 'true');
    await expectTappable(page, '.sgs-save', 'Save & move');
    await page.locator('.sgs-save').tap();
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#customerStage')).toContainText('Materials Ordered', { timeout: 10_000 });
    const l = await readLead(page, id);
    expect(l.stage).toBe('materials_ordered');
    expect(l.permitNotRequired, 'recorded as not required').toBe(true);
    expect(l.permitNotRequiredAt, 'with when').toBeTruthy();
    expect(l.permitFiledAt || '', 'never a fake "permit filed"').toBe('');
    expect(page.url()).toBe(url);
  });

  test('3. customer page: "Estimate $" is pre-filled from the primary estimate', async () => {
    await page.goto('/pro/dashboard.html');
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user, { timeout: 30_000 });
    const id = await seedLead({ firstName: '[E2E] Est', lastName: 'SFlowEst' + String(stamp).slice(-6), address: String(stamp).slice(-4) + ' Estimate Way, Milford, OH',
      stage: 'supplement_approved', jobType: 'insurance', insCarrier: 'State Farm', claimNumber: 'CLM-' + stamp });
    expect(id).toBeTruthy();
    await safeEvaluate(page, async ({ leadId, tag }) => {
      const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const db = window.db;
      const uid = window._user.uid;
      const ref = await fs.addDoc(fs.collection(db, 'estimates'), {
        userId: uid, leadId, title: '[E2E] primary', grandTotal: 18450, createdAt: new Date(), e2eTestData: true, e2eRun: tag,
      });
      await fs.updateDoc(fs.doc(db, 'leads', leadId), { primaryEstimateId: ref.id });
    }, { leadId: id, tag: run });
    await openCustomer(id);
    await safeWaitForFunction(page, () => (window._customerEstimates || []).length > 0, { timeout: 20_000 });
    await tapAdvance();
    const input = page.locator('#sgs-f-estimateAmount');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input, 'pre-filled from the primary estimate').toHaveValue('18450');
    await expectTappable(page, '#sgs-f-estimateAmount', 'Estimate $ field');
    const fontPx = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontPx, '16px input (iOS does not zoom)').toBeGreaterThanOrEqual(16);
    await page.locator('.sgs-save').tap();
    await expect(page.locator('.sgs-sheet')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(async () => (await readLead(page, id)).stage, { timeout: 10_000 }).toBe('contract_signed');
    expect((await readLead(page, id)).estimateAmount).toBe(18450);
  });

  test('5. D2D: "Appointment Set" asks when, lands on Contacted and books the appointment', async () => {
    await page.goto('/pro/dashboard.html');
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && window.ScriptLoader, { timeout: 30_000 });
    await safeEvaluate(page, () => window.goTo('d2d'));
    await safeWaitForFunction(page, () => window.D2D && typeof window.D2D.openQuickKnock === 'function' && window.NBDKnockLeadLogic && window.NBDLeadEvents, { timeout: 30_000 });
    const address = `${String(stamp).slice(-5)} Appointment Ave, Cincinnati, OH`;
    const homeowner = '[E2E] Appt ' + stamp;
    await safeEvaluate(page, (a) => window.D2D.openQuickKnock({ address: a }), address);
    await expect(page.locator('#d2d-quick-knock-overlay')).toBeVisible({ timeout: 10_000 });
    await page.locator('#d2d-qk-address').fill(address);
    // The door-number confirm (its row is hidden until Save's gate; the gate
    // itself is phone-dashnav.spec.js's subject) — tick it through its handler.
    const tickConfirm = async () => {
      await safeWaitForFunction(page, () => { const c = document.getElementById('d2d-addr-confirm-chk'); return !!(c && c.onchange); }, { timeout: 5_000 });
      await safeEvaluate(page, () => { const c = document.getElementById('d2d-addr-confirm-chk'); c.checked = true; c.onchange(); });
    };
    await expect(page.locator('#d2d-appt-section'), 'hidden until Appointment is picked').toBeHidden();
    await page.locator('#d2d-quick-knock-overlay [data-dispo="appointment"]').first().tap();
    await expect(page.locator('#d2d-appt-section')).toBeVisible();
    // D2D's own toasts (location permission, "Address not found") float over
    // the sheet; a rep swipes them away.
    await dismissToasts(page);
    await expectTappable(page, '#d2d-qk-appt', 'appointment date & time (brought on screen by the tap)');
    // A phone: a phone-less knock gets no automatic CRM follow-up (#2118).
    await safeEvaluate(page, ({ h, ph }) => {
      document.querySelector('.d2d-details')?.setAttribute('open', '');
      document.getElementById('d2d-qk-homeowner').value = h;
      document.getElementById('d2d-qk-phone').value = ph;
    }, { h: homeowner, ph: '513' + String(stamp).slice(-7) });
    // No time → refused, sheet stays open.
    await dismissToasts(page);
    await page.locator('#d2d-qk-save').scrollIntoViewIfNeeded();
    await tickConfirm();
    await page.locator('#d2d-qk-save').tap();
    await expect(page.locator('#toastContainer')).toContainText('appointment date and time', { timeout: 5_000 });
    await expect(page.locator('#d2d-quick-knock-overlay')).toBeVisible();
    const when = await safeEvaluate(page, () => { const d = new Date(); d.setDate(d.getDate() + 2); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T14:30'; });
    await page.locator('#d2d-qk-appt').fill(when);
    await tickConfirm();
    await page.locator('#d2d-qk-save').tap();
    await expect(page.locator('#d2d-quick-knock-overlay')).toHaveCount(0, { timeout: 20_000 });

    let out = null;
    await expect.poll(async () => {
      out = await safeEvaluate(page, async ({ h, tag }) => {
        const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
        const db = window.db || window._db;
        const uid = window._user.uid;
        const snap = await fs.getDocs(fs.query(fs.collection(db, 'leads'), fs.where('userId', '==', uid), fs.where('firstName', '==', '[E2E]')));
        const lead = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())).find((l) => (l.firstName + ' ' + l.lastName) === h);
        if (!lead) return null;
        // Tag it for the sweep (convertToLead writes a fixed shape).
        if (!lead.e2eRun) await fs.updateDoc(fs.doc(db, 'leads', lead.id), { e2eTestData: true, e2eRun: tag }).catch(() => {});
        const tasks = await fs.getDocs(fs.collection(db, 'leads', lead.id, 'tasks'));
        return { stage: lead.stage, followUp: lead.followUp, isProspect: lead.isProspect,
          events: tasks.docs.map((d) => d.data()).filter((t) => t.type === 'event').map((t) => ({ eventAt: t.eventAt, source: t.source, title: t.title })) };
      }, { h: homeowner, tag: run });
      return !!(out && out.events.length);
    }, { message: 'the knock converted and booked its appointment', timeout: 25_000 }).toBe(true);
    expect(out.stage, 'Appointment Set → Contacted (not Inspected)').toBe('contacted');
    expect(out.isProspect).toBe(false);
    const expectAt = await safeEvaluate(page, (v) => new Date(v).toISOString(), when);
    expect(out.events[0].eventAt, 'the appointment at the picked local time').toBe(expectAt);
    expect(out.events[0].source).toBe('d2d');
    const tomorrow = await safeEvaluate(page, () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
    expect(out.followUp, 'follow-up is the LOCAL tomorrow').toBe(tomorrow);
  });
});
