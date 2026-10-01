/**
 * tests/e2e/crm-handoff-ui.spec.js — the 2026-09-30 CRM handoff (Jo's live
 * browser session), items 3–5, tested in a real browser on the emulators.
 *
 *  - Global hotkeys stay off while a modal is open, and while focus is in a
 *    <select>; Ctrl+C is never "New Lead". Positive control: with no modal
 *    and focus on the page, "n" still opens Add Lead.
 *  - Edit Lead: #jobFieldsBlock is always shown, so changing Stage to
 *    Contract Signed does not move the fields below it.
 *  - Pipeline search survives the Board/List toggle AND a bare re-render
 *    (the live snapshot path), and the list shows the same narrowed set.
 *  - Header "Save" + bottom "Save Lead" pressed back to back write ONE lead.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

async function openCrm(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForLoadState('load');
      await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 15_000 });
      await page.evaluate(() => window.goTo('crm'));
      return;
    } catch (e) { if (!/Execution context was destroyed|navigation/i.test(String(e))) throw e; }
  }
}

test.describe.serial('CRM handoff 2026-09-30 — hotkeys, job block, search, double save @shard2', () => {
  let creds;
  test.beforeEach(async ({ page }) => {
    creds = requireTestUser();
    // The first-run tour overlay would sit over the modal.
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    // Address lookups never leave the machine.
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, creds);
    await openCrm(page);
  });

  test('hotkeys: off inside a modal and a <select>, Ctrl+C is not New Lead; "n" still works on the page', async ({ page }) => {
    const view = () => safeEvaluate(page, () => (document.querySelector('.view.active, [id^="view-"].active') || {}).id || window._currentView || '');
    const leadOpen = () => safeEvaluate(page, () => document.getElementById('leadModal').classList.contains('open'));

    // Positive control first: no modal, focus on the page → "n" opens Add Lead.
    await safeEvaluate(page, () => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await page.keyboard.press('n');
    await expect(page.locator('#leadModal'), 'control: "n" on the page opens Add Lead').toHaveClass(/open/, { timeout: 5_000 });

    // Inside the open modal, focus OFF any input: "e" and "c" must do nothing.
    const estBefore = await view();
    await safeEvaluate(page, () => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await page.keyboard.press('e');
    await page.keyboard.press('c');
    await page.waitForTimeout(400);
    expect(await leadOpen(), 'Edit/Add Lead modal still open after "e"').toBe(true);
    expect(await view(), '"e" did not navigate to Estimates under the modal').toBe(estBefore);
    expect(await safeEvaluate(page, () => !!document.querySelector('.modal-bg.open:not(#leadModal)')), 'no second modal (New Estimate chooser) opened over it').toBe(false);

    // Focus in the Stage <select>: letters pick options, never hotkeys.
    await page.locator('#lStage').focus();
    await page.keyboard.press('e');
    await page.waitForTimeout(300);
    expect(await leadOpen(), 'still open after "e" in the Stage select').toBe(true);
    expect(await view()).toBe(estBefore);

    // Close it; Ctrl+C on the board must not open New Lead.
    await safeEvaluate(page, () => window.closeLeadModal());
    await expect(page.locator('#leadModal')).not.toHaveClass(/open/, { timeout: 5_000 });
    await safeEvaluate(page, () => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(400);
    expect(await leadOpen(), 'Ctrl+C (copy) did not open New Lead').toBe(false);
  });

  test('Edit Lead: Job Details always shown; Stage → Contract Signed moves nothing below it', async ({ page }) => {
    await safeEvaluate(page, () => window.openLeadModal());
    await expect(page.locator('#leadModal')).toHaveClass(/open/, { timeout: 5_000 });
    await expect(page.locator('#jobFieldsBlock'), 'Job Details (Scheduled Date) visible on a new lead').toBeVisible();
    await expect(page.locator('#lScheduledDate')).toBeVisible();
    // Web fonts (Barlow, via Google Fonts) finishing mid-test grew every block
    // by 1–2 px between the two measurements — a false "Notes jumped 3–7 px"
    // on first attempts in 4 of 8 main runs (never on a retry, fonts cached).
    await safeEvaluate(page, () => document.fonts && document.fonts.ready.then(() => true));
    // Position of Notes relative to the top of the modal card: immune to scroll.
    const y = () => safeEvaluate(page, () => {
      const card = document.querySelector('#leadModal .modal');
      return document.getElementById('lNotes').getBoundingClientRect().top - card.getBoundingClientRect().top + card.scrollTop;
    });
    const heights = () => safeEvaluate(page, () => {
      const out = {};
      document.querySelectorAll('#leadModal .modal [id]').forEach((el) => { if (/Block|Row|Panel|Wrap|Section/.test(el.id)) out[el.id] = Math.round(el.getBoundingClientRect().height); });
      return out;
    });
    const hBefore = await heights();
    const before = await y();
    const hasSigned = await safeEvaluate(page, () => !![...document.getElementById('lStage').options].find((o) => o.value === 'contract_signed'));
    expect(hasSigned, 'precondition: contract_signed is an option').toBe(true);
    await page.selectOption('#lStage', 'contract_signed');
    await page.waitForTimeout(300);
    const after = await y();
    const hAfter = await heights();
    const grew = Object.keys(hAfter).filter((k) => hAfter[k] !== hBefore[k]).map((k) => k + ':' + hBefore[k] + '→' + hAfter[k]);
    expect(Math.abs(after - before), 'Notes did not jump when Stage changed (px); changed: ' + grew.join(', ')).toBeLessThan(2);
    await expect(page.locator('#jobFieldsBlock')).toBeVisible();
    await safeEvaluate(page, () => window.closeLeadModal());
  });

  test('pipeline search survives Board/List toggles and a bare re-render', async ({ page }) => {
    const stamp = Date.now();
    const saved = await safeEvaluate(page, async (s) => {
      const ids = [];
      for (const n of ['Alpha', 'Beta', 'Gamma']) {
        try {
          ids.push(await window._saveLead({ firstName: 'ZZHS' + n, lastName: 'T' + n + s, address: n.length + '0' + n.charCodeAt(0) + ' ' + n + ' Rd, Lebanon, OH 45036', phone: '513555' + String(n.charCodeAt(1)).padStart(4, '0'), stage: 'new', e2eTestData: true }));
        } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; ids.push('exists'); }
      }
      return ids;
    }, stamp);
    expect(saved.filter(Boolean).length, 'three leads written (no dedup prompt): ' + JSON.stringify(saved)).toBe(3);
    await safeWaitForFunction(page, () => (window._leads || []).filter((l) => l && /^ZZHS/.test(l.firstName || '')).length >= 3, null, { timeout: 20_000 });

    await page.fill('#crmSearch', 'ZZHSAlpha');
    await safeEvaluate(page, () => window.kanbanFilter());
    const narrowed = () => safeEvaluate(page, () => (window._filteredLeads || []).map((l) => l.firstName));
    await expect.poll(async () => (await narrowed()).filter((n) => /^ZZHS/.test(n)), { timeout: 5_000 }).toEqual(['ZZHSAlpha']);

    // A bare re-render — what the live leads snapshot does — keeps the search.
    await safeEvaluate(page, () => window.renderLeads(window._leads));
    expect((await narrowed()).filter((n) => /^ZZHS/.test(n)), 'bare renderLeads keeps the search').toEqual(['ZZHSAlpha']);
    // The explicit "unfiltered" call too (filter-chip reset) while the box has a query.
    await safeEvaluate(page, () => window.renderLeads(window._leads, null));
    expect((await narrowed()).filter((n) => /^ZZHS/.test(n)), 'renderLeads(…, null) keeps the search').toEqual(['ZZHSAlpha']);

    // List view shows the same narrowed set.
    await safeEvaluate(page, () => window.crmViewList());
    await expect.poll(() => safeEvaluate(page, () => [...document.querySelectorAll('#crmListWrap tr.crm-list-row .cl-name a')].map((a) => a.textContent.trim()).filter((t) => /ZZHS/.test(t))), { timeout: 5_000 })
      .toEqual([`ZZHSAlpha TAlpha${stamp}`]);
    // Back to Board: still filtered.
    await safeEvaluate(page, () => window.crmViewBoard());
    expect((await narrowed()).filter((n) => /^ZZHS/.test(n)), 'Board after the toggle still narrowed').toEqual(['ZZHSAlpha']);
    const zzCards = () => safeEvaluate(page, () => [...document.querySelectorAll('#view-crm .k-card[data-id]')].filter((c) => c.offsetParent && c.textContent.includes('ZZHS')).length);
    const zzOnBoard = await zzCards();
    expect(zzOnBoard, 'exactly one ZZHS card on the board').toBe(1);

    // Clearing the search brings all three back (the filter is not stuck on).
    await safeEvaluate(page, () => window.clearCrmSearch());
    await expect.poll(zzCards, { timeout: 5_000 }).toBe(3);
    expect(await safeEvaluate(page, () => window._filteredLeads), 'no narrowing after clear').toBeNull();
  });

  test('header Save + bottom Save Lead back to back write ONE lead', async ({ page }) => {
    const stamp = Date.now();
    await safeEvaluate(page, () => window.openLeadModal());
    await expect(page.locator('#leadModal')).toHaveClass(/open/, { timeout: 5_000 });
    await page.fill('#lFname', 'ZZDS');
    await page.fill('#lLname', String(stamp));
    await page.fill('#lAddr', '9 Double St, Mason, OH 45040');
    // Both buttons in the same task, before the first save can finish.
    await safeEvaluate(page, () => { document.getElementById('leadModalSave').click(); document.getElementById('leadSaveBtn').click(); document.getElementById('leadModalSave').click(); });
    await page.waitForTimeout(4_000);
    const n = await safeEvaluate(page, (s) => (window._leads || []).filter((l) => l && l.firstName === 'ZZDS' && String(l.lastName) === String(s)).length, stamp);
    expect(n, 'one lead, not two or three').toBe(1);
  });
});
