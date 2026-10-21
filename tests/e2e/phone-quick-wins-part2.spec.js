// tests/e2e/phone-quick-wins-part2.spec.js - part 2 of the 2026-10-07 CRM phone
// audit's quick wins (the four items Jo approved out of #2316), on the
// installed iPhone app (390 x 844, standalone rules forced), on the emulator:
//
//   - a fresh device opens the CRM on All; a saved view still wins;
//   - Presentation mode is not a mic; every Schedule target is >= 44px.
//
// (Quick Capture's "Save to <customer>" needs a transcription round trip, so
// it is pinned by tests/phone-quick-wins-part2-2026-10-13.test.js instead.)
// Nothing here sends anything: every Cloud Function call is answered locally.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

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

test.describe('phone quick wins part 2: CRM default view, Presentation icon, Schedule targets @shard3', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

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