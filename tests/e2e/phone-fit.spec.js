// tests/e2e/phone-fit.spec.js — every dashboard view must fit a phone.
//
// Jo's standing requirement (2026-09-24): "keep checking and testing
// visually at phone scale. It needs to fit and run everything flawlessly."
// A one-off walk that day found nothing overflowing the page but a D2D tab
// row 25px past the edge, three "+" controls and a hidden Add Lead label —
// none of which any existing gate could see, because the authed suite ran
// Desktop Chrome except for one spec.
//
// What this pins, per view, at 412px (Jo's Android) and 360px (small
// Androids):
//   1. the document never scrolls sideways;
//   2. no visible element's right edge passes the viewport UNLESS it sits
//      inside a container that scrolls horizontally on purpose (a tab bar,
//      a wide table) or one that clips it. Walking stops at <body>:
//      body{overflow-x:clip} would otherwise hide every offender
//      (overflow-detector-stop-before-body lesson);
//   3. the view's root actually rendered (a view that fails to mount would
//      otherwise pass 1 and 2 vacuously).
// Every failure names the element and attaches a screenshot.
//
// Tagged @audit so it rides the existing audit shard of the authed
// emulator job. Run locally:
//   cd tests && npm run test:e2e:authed:emu   (PLAYWRIGHT_GREP=@phonefit)
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs } = require('./fixtures/auth');

// Every view with a sidebar/mobile-nav entry. 'map' is a redirect to
// 'd2d' (dashboard-actions.js) and 'admin' is owner-only, so both are
// left out rather than asserted vacuously.
const VIEWS = ['home', 'dash', 'crm', 'prospects', 'est', 'schedule', 'd2d', 'draw',
  'photos', 'docs', 'money', 'expenses', 'reports', 'storm', 'joe', 'settings',
  'products', 'training', 'closeboard', 'repos', 'board', 'talk-tank', 'signs'];
const WIDTHS = [412, 360];

test.use({
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
});

async function measure(page, view) {
  return page.evaluate(async (v) => {
    try { if (typeof window.goTo === 'function') window.goTo(v); } catch (e) { return { err: String(e) }; }
    await new Promise((r) => setTimeout(r, 1500));
    const vw = document.documentElement.clientWidth;
    const root = document.getElementById('view-' + v);
    const mounted = !!(root && root.offsetParent !== null && root.getBoundingClientRect().height > 0);
    const offenders = [];
    for (const el of (root || document.body).querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      let contained = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') { contained = true; break; }
        if ((ox === 'hidden' || ox === 'clip') && p.getBoundingClientRect().right <= vw + 1) { contained = true; break; }
      }
      if (contained) continue;
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      offenders.push(el.tagName.toLowerCase() + id + cls + ' (right ' + Math.round(r.right) + 'px)');
    }
    return {
      mounted,
      docOverflow: Math.max(0, document.documentElement.scrollWidth - vw),
      offenders: offenders.slice(0, 5),
    };
  }, view);
}

test.describe('phone fit @audit @phonefit', () => {
  for (const width of WIDTHS) {
    test(`every dashboard view fits at ${width}px`, async ({ page }, testInfo) => {
      test.setTimeout(240000);
      await page.setViewportSize({ width, height: 860 });
      await loginAs(page, requireTestUser());
      // Sample data, so lists and boards render real rows, not empty states.
      await page.evaluate(async () => {
        try {
          if (window.seedDemoLeads && window._user) await window.seedDemoLeads(window._user.uid);
          if (window._loadLeads) await window._loadLeads();
        } catch (_) { /* best effort; empty states still get measured */ }
      });
      const skip = page.getByText('Skip tour', { exact: true });
      if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

      const problems = [];
      for (const view of VIEWS) {
        const m = await measure(page, view);
        const bad = m.err || !m.mounted || m.docOverflow > 1 || m.offenders.length;
        if (bad) {
          problems.push(`${view}: ` + (m.err || [
            m.mounted ? '' : 'view did not render',
            m.docOverflow > 1 ? `page scrolls sideways by ${m.docOverflow}px` : '',
            m.offenders.length ? 'off-screen: ' + m.offenders.join(', ') : '',
          ].filter(Boolean).join('; ')));
          await testInfo.attach(`${view}-${width}px`, { body: await page.screenshot(), contentType: 'image/png' });
        }
      }
      expect(problems, `views that don't fit at ${width}px`).toEqual([]);
    });
  }
});
