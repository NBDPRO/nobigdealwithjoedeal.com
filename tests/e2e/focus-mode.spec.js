/**
 * tests/e2e/focus-mode.spec.js — L03 Focus Mode end to end on the emulators
 * (2026-10-11, D4). A rep who chose Focus Mode sees today's queue as one big
 * number, then ONE lead at a time with a plain "Why now" line, a DRAFTED text
 * that opens in the messages app (nothing is sent), and Call / Text / Snooze /
 * Done. Keys move and act. "Next" on a row that has no task only sets it aside
 * on this device; the wrap-up says so. The pipeline stays one tap away.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

test.describe.serial('Focus Mode @shard2', () => {
  test('queue -> one lead -> draft -> keys -> wrap-up', async ({ page }) => {
    test.setTimeout(180_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });

    const s = Date.now();
    const d = new Date(Date.now() - 3 * 86400000);
    const fu = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    await safeEvaluate(page, (a) => window._saveLead({ firstName: 'ZZFO', lastName: 'Late' + a.s, address: '3 Focus Way, Mason, OH 45040', phone: '5135550177', stage: 'new', followUp: a.fu }), { s, fu });
    const saved = await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'focus', device: 'desktop' }));
    expect(saved.saved).toBe(true);
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'focus' && !!document.getElementById('nbdFocusRoot'), null, { timeout: 40_000 });

    // Today: one big number
    await page.locator('.fo-big').waitFor({ state: 'visible', timeout: 40_000 });
    const n = Number(await page.locator('.fo-big').innerText());
    expect(n).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.fo-start')).toBeVisible();

    // Start: one lead, the reason, the draft
    await page.locator('[data-fo="start"]').click();
    await expect(page.locator('.fo-card')).toBeVisible();
    // the stalled lead is among the queue; walk to it
    for (let i = 0; i < n && !(await page.locator('.fo-name').innerText()).includes('ZZFO'); i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.fo-name')).toContainText('ZZFO');
    await expect(page.locator('.fo-why')).toContainText('Follow-up was due 3 days ago');
    await expect(page.locator('.fo-draft p')).toContainText('Hi ZZFO, following up');
    await expect(page.locator('[data-fo-call]')).toHaveAttribute('href', 'tel:+15135550177');
    const sms = await page.locator('[data-fo-text]').getAttribute('href');
    expect(sms).toMatch(/^sms:\+15135550177\?&body=Hi%20ZZFO/);
    await expect(page.locator('.fo-draft-k')).toContainText('you press Send');
    // 56px tap targets
    const small = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdFocusRoot .fo-act, #nbdFocusRoot .fo-pill'))
      .filter((e) => e.getBoundingClientRect().height < 55).map((e) => e.className));
    expect(small).toEqual([]);
    // a stalled-follow-up row has no task: the button says "Next", not "Done"
    await expect(page.locator('[data-fo="done"] span')).toHaveText('Next');

    // D (key) sets it aside on this device; the CRM record is untouched
    await page.keyboard.press('d');
    await page.locator('[data-fo="wrap"]').first().click();
    await expect(page.locator('.fo-lines')).toContainText('1 set aside on this device');
    await expect(page.locator('.fo-note')).toContainText('not changed in the CRM');
    const lead = await safeEvaluate(page, (st) => {
      const l = (window._leads || []).find((x) => x.lastName === 'Late' + st);
      return l ? { followUp: l.followUp } : null;
    }, s);
    expect(lead.followUp).toBe(fu);

    // the pipeline is one tap away and the overlay steps aside
    await page.locator('[data-fo="menu"]').click();
    await page.locator('[data-fo="goto"][data-to="crm"]').click();
    await safeWaitForFunction(page, () => document.getElementById('nbdFocusRoot').hidden === true, null, { timeout: 10_000 });
  });
});
