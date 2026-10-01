/**
 * tests/e2e/sort-customers.spec.js — "Sort my customers" end to end
 * (2026-10-01, Jo chose "suggest + sort" for 118 untyped customers).
 *
 *  - The banner over the board counts the untyped customers.
 *  - The screen suggests a type with a reason: a Thumbtack "Gutter Repair"
 *    request → Service, a carrier on file → Insurance, a bare lead → no clues.
 *  - Nothing is written until Save. Save writes exactly the picked rows,
 *    including a hand-picked type for the no-clue lead, leaves "Skip" rows
 *    untyped, and adds a timeline note per sorted lead.
 *  - A NEW lead can't be saved from the form without a job type.
 *  - Phone width (390px): controls are 44px, nothing overflows.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

test.describe.serial('Sort my customers @shard2', () => {
  test('suggest, pick, save; new leads need a type', async ({ page }) => {
    test.setTimeout(150_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"result":{}}' }));
    await page.route(/nominatim\.openstreetmap\.org/, (r) => r.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.addDoc === 'function' && !!window.db && !!window._user
      && typeof window._loadLeads === 'function' && !!window.NBDSortCustomers && typeof window.suggestJobType === 'function', null, { timeout: 40_000 });

    const tok = 'Zs' + Date.now();
    const ids = await safeEvaluate(page, async (tok) => {
      const uid = window._user.uid;
      const base = { userId: uid, companyId: (window._userClaims && window._userClaims.companyId) || uid, stage: 'new', source: 'Thumbtack', createdAt: new Date(), updatedAt: new Date(), e2eTestData: true };
      const add = async (extra) => (await window.addDoc(window.collection(window.db, 'leads'), Object.assign({}, base, extra))).id;
      const out = {
        gutter: await add({ firstName: tok, lastName: 'Gutter', address: '1 Sort St, Mason OH 45040', notes: 'Thumbtack request · Zip code: 45040 · Category: Gutter Repair · Insurance claim coverage: No, the project is not covered by an insurance claim' }),
        carrier: await add({ firstName: tok, lastName: 'Carrier', address: '2 Sort St, Mason OH 45040', insCarrier: 'Example Mutual' }),
        bare: await add({ firstName: tok, lastName: 'Bare', address: '3 Sort St, Mason OH 45040', notes: 'Called, left voicemail.' }),
        skip: await add({ firstName: tok, lastName: 'Skip', address: '4 Sort St, Mason OH 45040' }),
        typed: await add({ firstName: tok, lastName: 'Typed', address: '5 Sort St, Mason OH 45040', jobType: 'cash' }),
      };
      await window._loadLeads();
      return out;
    }, tok);

    await safeEvaluate(page, () => { try { localStorage.setItem('nbd_crm_show_prospects', '0'); } catch (_) {} window.goTo('crm'); });
    const skipTour = page.getByText('Skip tour', { exact: true });
    if (await skipTour.isVisible().catch(() => false)) await skipTour.click().catch(() => {});

    // Banner: counts every untyped customer, ours included.
    const banner = page.locator('#sortCustomersWrap .sc-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    const before = await safeEvaluate(page, () => window.NBDSortCustomers._untyped().length);
    expect(before).toBeGreaterThanOrEqual(4);
    await expect(banner).toContainText(String(before));

    await page.locator('#sortCustomersWrap [data-sc="open"]').click();
    const modal = page.locator('#sortCustomersModal');
    await expect(modal).toHaveClass(/open/, { timeout: 5_000 });

    // Suggestions + reasons (the All tab shows every row).
    await modal.locator('[data-sc="filter"][data-arg="all"]').click();
    const row = (id) => modal.locator('.sc-row[data-lead-id="' + id + '"]');
    await expect(row(ids.gutter).locator('select')).toHaveValue('service');
    await expect(row(ids.gutter)).toContainText('Gutter Repair');
    await expect(row(ids.carrier).locator('select')).toHaveValue('insurance');
    await expect(row(ids.carrier)).toContainText('Carrier on file');
    await expect(row(ids.bare).locator('select')).toHaveValue('');
    await expect(row(ids.bare)).toContainText('No clues');
    await expect(modal.locator('.sc-row[data-lead-id="' + ids.typed + '"]')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/sort-customers-phone.png' });
    // Nothing written yet.
    const typeOf = (id) => safeEvaluate(page, async (id) => (await window.getDoc(window.doc(window.db, 'leads', id))).data().jobType || '', id);
    expect(await typeOf(ids.gutter)).toBe('');

    // Phone fit: 44px controls, no horizontal overflow in the screen.
    const fit = await safeEvaluate(page, (id) => {
      const m = document.querySelector('#sortCustomersModal .sc-modal');
      const sel = document.querySelector('.sc-row[data-lead-id="' + id + '"] select').getBoundingClientRect();
      const save = document.querySelector('#sortCustomersModal .sc-save').getBoundingClientRect();
      return { sel: sel.height, save: save.height, overflow: m.scrollWidth - m.clientWidth, right: m.getBoundingClientRect().right, vw: document.documentElement.clientWidth };
    }, ids.gutter);
    expect(fit.sel).toBeGreaterThanOrEqual(44);
    expect(fit.save).toBeGreaterThanOrEqual(44);
    expect(fit.overflow).toBeLessThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.vw);

    // Jo's call on the bare lead; "skip" stays untyped. Other untyped
    // customers in the emulator are set to Skip so only ours save.
    await safeEvaluate(page, (ids) => {
      const st = window.NBDSortCustomers._state;
      Object.keys(st.picks).forEach((k) => { if (![ids.gutter, ids.carrier, ids.bare].includes(k)) st.picks[k] = ''; });
    }, ids);
    await row(ids.bare).locator('select').selectOption('cash');
    await expect(modal.locator('.sc-save')).toHaveText('Save 3 customers');
    await modal.locator('.sc-save').click();
    await expect(modal.locator('.sc-status')).toContainText('Sorted 3 customers', { timeout: 20_000 });

    expect(await typeOf(ids.gutter)).toBe('service');
    expect(await typeOf(ids.carrier)).toBe('insurance');
    expect(await typeOf(ids.bare)).toBe('cash');
    expect(await typeOf(ids.skip)).toBe('');
    const notes = await safeEvaluate(page, async (id) => {
      const q = window.query(window.collection(window.db, 'notes'), window.where('leadId', '==', id), window.where('userId', '==', window._user.uid));
      return (await window.getDocs(q)).docs.map((d) => d.data()).filter((n) => n.type === 'type_change').map((n) => n.text);
    }, ids.gutter);
    expect(notes.join('|')).toContain('Unset → Service');
    const after = await safeEvaluate(page, () => window.NBDSortCustomers._untyped().length);
    expect(after).toBe(before - 3);
    await safeEvaluate(page, () => window.NBDSortCustomers.close());

    // A NEW lead must pick a type.
    await safeEvaluate(page, () => window.openLeadModal());
    await expect(page.locator('#leadModal')).toHaveClass(/open/, { timeout: 5_000 });
    await page.selectOption('#lJobType', '').catch(() => {});
    await page.fill('#lFname', tok);
    await page.fill('#lLname', 'NoType');
    await page.fill('#lAddr', '6 Sort St, Mason OH 45040');
    await safeEvaluate(page, () => document.getElementById('leadSaveBtn').click());
    await expect(page.locator('#mErr')).toContainText('Pick a job type', { timeout: 5_000 });
    await page.waitForTimeout(1_500);
    const made = await safeEvaluate(page, (tok) => (window._leads || []).filter((l) => l.firstName === tok && l.lastName === 'NoType').length, tok);
    expect(made, 'no untyped lead was created').toBe(0);
    await safeEvaluate(page, () => window.closeLeadModal && window.closeLeadModal());

    // Cleanup.
    await safeEvaluate(page, (ids) => Promise.all(Object.values(ids).map((id) => window.deleteDoc(window.doc(window.db, 'leads', id)).catch(() => {}))), ids).catch(() => {});
  });
});
