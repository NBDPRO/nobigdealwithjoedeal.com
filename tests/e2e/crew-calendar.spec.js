/**
 * tests/e2e/crew-calendar.spec.js — L06 Crew Calendar end to end on the
 * emulators (2026-10-12). A rep who chose the layout sees crews as lanes on a
 * week timeline. A job block is DRAGGED to another day and crew (pointer
 * events) and the move is written to the lead through the schedule fields the
 * Plan Jobs row writes; arrow keys move it too; an Unscheduled job is dragged
 * out of the tray; the drawer shows the job and saves a schedule; a weekend
 * drop saves AND warns (never blocks). Phone width opens on the Day view with
 * 56px targets and no sideways page scroll; blocks stay legible on a light and
 * a dark theme.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
// This week's Monday + n days, in the browser's local calendar (what the app uses).
function weekDay(n) {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n);
  return ymd(d);
}

test.describe.serial('Crew Calendar @shard2', () => {
  test('lanes -> drag -> keys -> tray -> drawer -> warn-not-block -> phone', async ({ page }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine && !!window.NBDProduction, null, { timeout: 30_000 });

    const s = Date.now();
    // two crews on the roster: the doc production.js saveSub writes
    // (companies/{tenant}/subs). Written directly so a retry cannot hang on a reload.
    const subIds = await safeEvaluate(page, async (a) => {
      const t = (window._userClaims || {}).companyId || window._user.uid;
      const col = window.collection(window.db, 'companies', t, 'subs');
      const mk = async (name) => (await window.addDoc(col, { name, phone: '', email: '', trade: 'Roofing', insuranceExpiry: null, notes: '', active: true,
        createdAt: window.serverTimestamp(), updatedAt: window.serverTimestamp() })).id;
      return { alpha: await mk('ZZCW Alpha ' + a.s), bravo: await mk('ZZCW Bravo ' + a.s) };
    }, { s });
    const wed = weekDay(2);
    const thu = weekDay(3);
    // unique phone + address per run: a retry must not trip the duplicate-lead prompt
    await safeEvaluate(page, async (a) => {
      const tail = String(a.s).slice(-6);
      await window._saveLead({ firstName: 'ZZCW' + tail, lastName: 'Placed' + a.s, address: tail + ' Crew Ln, Mason, OH 45040', phone: '513' + tail + '1', stage: 'contract_signed',
        scheduledDate: a.wed, scheduledEndDate: a.thu, scheduledStart: '07:00', subId: a.alpha, crew: 'ZZCW Alpha ' + a.s, permitNotRequired: true });
      await window._saveLead({ firstName: 'ZZCX' + tail, lastName: 'Tray' + a.s, address: tail + ' Tray Ln, Mason, OH 45040', phone: '513' + tail + '2', stage: 'contract_signed', permitNotRequired: true });
    }, { s, wed, thu, alpha: subIds.alpha });
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'crew', device: 'desktop' }));
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'crew' && !!document.getElementById('nbdCrewRoot'), null, { timeout: 40_000 });

    // lanes: both crews + "No crew yet"; the placed job is a 2-column block in Alpha's lane
    await expect(page.locator('.cw-lane-name', { hasText: 'ZZCW Alpha' })).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('.cw-lane-name', { hasText: 'ZZCW Bravo' })).toBeVisible();
    await expect(page.locator('.cw-lane-name', { hasText: 'No crew yet' })).toBeVisible();
    const placed = page.locator('.cw-block', { hasText: 'Placed' + s });
    await expect(placed).toBeVisible();
    await expect(placed).toHaveClass(/cw-n2/);
    await expect(page.locator('.cw-chip', { hasText: 'Tray' + s })).toBeVisible();

    const ids = await safeEvaluate(page, (a) => {
      const l = (window._leads || []);
      return {
        placed: l.find((x) => x.lastName === 'Placed' + a.s).id,
        tray: l.find((x) => x.lastName === 'Tray' + a.s).id,
        alpha: a.alpha,
        bravo: a.bravo,
      };
    }, { s, alpha: subIds.alpha, bravo: subIds.bravo });
    const fresh = (id) => safeEvaluate(page, async (i) => {
      const snap = await window.getDoc(window.doc(window.db, 'leads', i));
      const d = snap.data();
      return { scheduledDate: d.scheduledDate, scheduledEndDate: d.scheduledEndDate || null, scheduledStart: d.scheduledStart || null, subId: d.subId || null, crew: d.crew || '' };
    }, id);

    async function drag(from, to) {
      await expect(from.first()).toBeVisible({ timeout: 15_000 });
      await expect(to).toBeVisible({ timeout: 15_000 });
      const a = await from.first().boundingBox();
      const b = await to.boundingBox();
      // grab near the left edge, so a multi-day block is held by its FIRST day
      const gx = a.x + Math.min(30, a.width / 2);
      await page.mouse.move(gx, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(gx + 20, a.y + a.height / 2 + 6, { steps: 3 });
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
      await page.mouse.up();
    }
    const cell = (lane, date) => page.locator('.cw-cell[data-lane="' + lane + '"][data-date="' + date + '"]');

    // drag Placed (Wed-Thu, Alpha) to Friday in Bravo's lane: day + crew move, length and start stay
    const fri = weekDay(4);
    await drag(placed.first(), cell('sub:' + ids.bravo, fri));
    try {
      await expect.poll(async () => (await fresh(ids.placed)).scheduledDate, { timeout: 15_000 }).toBe(fri);
    } catch (e) {
      // CI-only failure once: say what the page thought, so the log is enough.
      const dbg = await safeEvaluate(page, () => ({
        readOnly: !!document.querySelector('.cw-ro'),
        rootHidden: !!(document.getElementById('nbdCrewRoot') || {}).hidden,
        role: (window._userClaims || {}).role || null,
        notice: (document.querySelector('.cw-notice') || {}).innerText || null,
        toasts: Array.from(document.querySelectorAll('#toastContainer .toast')).map((t) => t.innerText),
        activeView: (document.querySelector('.view.active') || {}).id || null,
        blocks: Array.from(document.querySelectorAll('.cw-block')).map((b) => b.className + ' | ' + b.innerText.replace(/s+/g, ' ')),
      }));
      throw new Error('drag did not move the job: ' + JSON.stringify(dbg) + ' :: ' + e.message);
    }
    const moved = await fresh(ids.placed);
    expect(moved.subId).toBe(ids.bravo);
    expect(moved.scheduledEndDate).toBe(weekDay(5));       // still two days
    expect(moved.scheduledStart).toBe('07:00');
    await expect(page.locator('.cw-notice')).toContainText('Moved');

    // keyboard: ArrowLeft moves it one day earlier
    await page.locator('.cw-block', { hasText: 'Placed' + s }).first().focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await fresh(ids.placed)).scheduledDate, { timeout: 15_000 }).toBe(thu);

    // tray -> Alpha, Tuesday
    const tue = weekDay(1);
    await drag(page.locator('.cw-chip', { hasText: 'Tray' + s }), cell('sub:' + ids.alpha, tue));
    await expect.poll(async () => (await fresh(ids.tray)).scheduledDate, { timeout: 15_000 }).toBe(tue);
    expect((await fresh(ids.tray)).subId).toBe(ids.alpha);
    await expect(page.locator('.cw-chip', { hasText: 'Tray' + s })).toHaveCount(0);

    // a weekend drop is saved and WARNS (never blocks)
    const sat = weekDay(5);
    await drag(page.locator('.cw-block', { hasText: 'Tray' + s }).first(), cell('sub:' + ids.alpha, sat));
    await expect.poll(async () => (await fresh(ids.tray)).scheduledDate, { timeout: 15_000 }).toBe(sat);
    await expect(page.locator('.cw-notice')).toContainText('weekend');

    // the drawer: opens, shows the crew, saves a new length
    await page.locator('.cw-block', { hasText: 'Placed' + s }).first().click();
    await expect(page.locator('.cw-drawer')).toBeVisible();
    await expect(page.locator('#cwCrew')).toHaveValue('sub:' + ids.bravo);
    await expect(page.locator('.cw-drawer')).toContainText('Permit');
    await expect(page.locator('.cw-drawer')).toContainText('Materials');
    await page.locator('#cwDays').fill('3');
    await page.locator('[data-cw="save"]').click();
    await expect.poll(async () => (await fresh(ids.placed)).scheduledEndDate, { timeout: 15_000 }).toBe(weekDay(5));
    await page.keyboard.press('Escape');

    // copy: crews are subs
    const text = await page.locator('#nbdCrewRoot').innerText();
    expect(text).not.toMatch(/employee|in-house|our team/i);

    // light + dark: block text stays legible against the block fill
    await safeEvaluate(page, () => window.ScriptLoader && window.ScriptLoader.loadBundle ? window.ScriptLoader.loadBundle('theme') : null);
    await safeWaitForFunction(page, () => !!(window.ThemeEngine && window.ThemeEngine.apply), null, { timeout: 30_000 });
    for (const theme of ['daylight', 'midnight']) {
      await safeEvaluate(page, (t) => { window.ThemeEngine.apply(t, false); }, theme);
      await page.waitForTimeout(600);
      if (process.env.CREW_SHOTS) await page.screenshot({ path: process.env.CREW_SHOTS + '/crew-week-' + theme + '.png' });
      const ratio = await safeEvaluate(page, () => {
        // computed color-mix() is rgb(...) or color(srgb r g b) with 0-1 channels
        const lum = (c) => { let m = c.match(/[\d.]+/g).map(Number); if (/^color\(srgb/.test(c)) m = m.map((v) => v * 255); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
        const b = document.querySelector('.cw-block');
        const bg = getComputedStyle(b).backgroundColor;
        const fg = getComputedStyle(b.querySelector('.cw-b-name')).color;
        const a = lum(bg), c = lum(fg);
        return { bg, fg, ratio: (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05) };
      });
      expect(ratio.bg, theme + ' block fill resolved').toMatch(/^(rgb|color\(srgb)/);
      expect(ratio.ratio, theme + ' ' + ratio.bg + ' / ' + ratio.fg).toBeGreaterThan(4.5);
    }

    // phone: opens on the Day view, 56px targets, no sideways page scroll
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'crew', device: 'phone' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await safeWaitForFunction(page, () => !!document.getElementById('nbdCrewRoot'), null, { timeout: 40_000 });
    await expect(page.locator('.cw-pill[data-v="day"]')).toHaveAttribute('aria-pressed', 'true');
    const small = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdCrewRoot .cw-pill'))
      .filter((e) => e.getBoundingClientRect().height < 55).map((e) => e.className));
    expect(small).toEqual([]);
    if (process.env.CREW_SHOTS) await page.screenshot({ path: process.env.CREW_SHOTS + '/crew-day-phone.png' });
    const over = await safeEvaluate(page, () => document.scrollingElement.scrollWidth - window.innerWidth);
    expect(over).toBeLessThanOrEqual(1);
    // week on a phone scrolls inside its own region, not the page
    await page.locator('.cw-pill[data-v="week"]').click();
    await expect(page.locator('.cw-scroll')).toBeVisible();
    const over2 = await safeEvaluate(page, () => document.scrollingElement.scrollWidth - window.innerWidth);
    expect(over2).toBeLessThanOrEqual(1);
  });
});
