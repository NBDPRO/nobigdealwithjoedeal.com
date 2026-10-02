// @ts-check
/* The mobile drawer, exercised rather than grepped.
 *
 * tests/nav-contract.test.js pins the CSS and JS contract statically and runs
 * on every push. This file is the half that a static gate cannot do: it opens
 * the drawer at iPod-touch size and measures what a finger would actually get.
 *
 * Before the 2026-09-08 audit, not one test in the repo ever clicked the
 * hamburger — every gate was green while the drawer was broken on four
 * independent axes at once. These assertions are written against the failures
 * that were measured, so each one has been seen to fail:
 *
 *   - the drawer left a 38px gap under the header, or hid 40-59px of itself
 *     behind it, depending on scroll position (the announcement bar sits in
 *     flow above a position:sticky nav, so the header's bottom edge moves)
 *   - the page scrolled freely behind the open drawer — the reported symptom,
 *     "the slider moves but the page doesn't"
 *   - the fixed Call/Text bar painted over the drawer's bottom rows
 *   - only 6 of 32 links were reachable
 *
 * 320x508 is an iPod touch with the Safari chrome subtracted — the smallest
 * screen this site meaningfully has to serve, and the device the report came
 * from. WebKit because the symptom is iOS-specific; Chromium hides it.
 */
const { test, expect } = require('@playwright/test');

const IPOD = { width: 320, height: 508 };

/* One page per nav template: standard, blog, pro/blog, and the two that live
   outside the nbd:partial markers (the homepage and the pledge page) — those
   are exactly the ones a partial-only fix silently misses. */
const PAGES = [
  ['homepage (outside the partial markers)', '/'],
  ['service page (nav-standard)', '/services/roof-replacement'],
  ['blog post (nav-blog)', '/blog/cincinnati-hail-season-2026'],
  ['pro blog post (was a third toggler)', '/pro/blog/contractor-review-system'],
  ['the pledge (outside the partial markers)', '/the-pledge/'],
];

test.use({ viewport: IPOD, hasTouch: true, isMobile: true });

for (const [label, url] of PAGES) {
  test(`drawer is usable on ${label}`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // nbd-nav.js records lock / unlock / jump / reapply / scroll events into
    // this array (and only when it exists), so a missed restore on CI's
    // mobile WebKit says WHY in the failure message (2026-10-02: 1200, 1200,
    // 9 and 40 px off on the homepage only, never reproducible locally).
    await page.addInitScript(() => { window.__NBD_NAV_TRACE = []; });
    await page.goto(url);
    // Scroll away from the top: the announcement bar leaves, the sticky nav
    // snaps up, and the header's bottom edge moves. Every hardcoded drawer
    // offset was wrong at one end of that range or the other.
    // INSTANT, not scrollTo(0, 1200): the site sets html{scroll-behavior:
    // smooth}, so the plain form glides (the trace showed y 1, 2, 5, 10 …),
    // and on a slow CI WebKit the drawer could be opened mid-glide with the
    // reference point taken from a moving page.
    await page.evaluate(() => window.scrollTo({ top: 1200, left: 0, behavior: 'instant' }));
    await page.waitForFunction(() => {
      const y = Math.round(window.scrollY);
      const w = window.__navScrollSettle || (window.__navScrollSettle = { y, n: 0 });
      if (w.y === y) w.n++; else { w.y = y; w.n = 0; }
      return y > 0 && w.n >= 3;
    }, null, { polling: 100, timeout: 5000 }).catch(() => {});
    // Let late content (lazy images, the reviews widget) finish changing the
    // page height before taking the reference point. WebKit has no scroll
    // anchoring, so content growing ABOVE the viewport moves the reader
    // whether or not the drawer was ever opened; that is not the drawer's
    // restore failing.
    await page.waitForFunction(() => {
      const h = document.documentElement.scrollHeight;
      const w = window.__navSettle || (window.__navSettle = { h, n: 0 });
      if (w.h === h) w.n++; else { w.h = h; w.n = 0; }
      return w.n >= 3;
    }, null, { polling: 150, timeout: 5000 }).catch(() => {});
    const startY = await page.evaluate(() => Math.round(window.scrollY));

    const open = async () => {
      const box = await page.locator('#hamburger').boundingBox();
      if (!box) throw new Error('hamburger has no box — it is not rendered');
      // Apple's 44x44 minimum. A control a thumb misses is a broken control.
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(350);
    };

    await open();

    const opened = await page.evaluate(() => {
      const m = document.getElementById('mobileNav');
      const r = m.getBoundingClientRect();
      const cs = getComputedStyle(m);
      const cta = document.querySelector('.mobile-cta-strip');
      return {
        open: m.classList.contains('open'),
        top: Math.round(r.y),
        bottom: Math.round(r.y + r.height),
        vh: window.innerHeight,
        bg: cs.backgroundColor,
        expanded: document.getElementById('hamburger').getAttribute('aria-expanded'),
        ctaVisible: cta ? getComputedStyle(cta).display !== 'none' : false,
        locked: document.body.classList.contains('nbd-nav-open'),
        lockedY: Math.round(window.scrollY),
      };
    });

    expect(opened.open).toBe(true);
    expect(opened.expanded).toBe('true');
    // Full-viewport sheet: no gap above, nothing showing below. This is the
    // assertion that replaces every hardcoded top offset.
    expect(opened.top).toBeLessThanOrEqual(0);
    expect(opened.bottom).toBeGreaterThanOrEqual(opened.vh);
    // A transparent drawer over live page content is unreadable and untappable.
    expect(opened.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(opened.ctaVisible).toBe(false);
    expect(opened.locked).toBe(true);

    // THE REPORTED SYMPTOM: the page must not move behind the open drawer.
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(opened.lockedY);

    // Every link has to be reachable by scrolling the drawer itself.
    const reach = await page.evaluate(() => {
      const m = document.getElementById('mobileNav');
      m.scrollTop = m.scrollHeight;
      const links = m.querySelectorAll('a');
      const last = links[links.length - 1].getBoundingClientRect();
      return { count: links.length, lastY: Math.round(last.y), vh: window.innerHeight };
    });
    expect(reach.count).toBeGreaterThan(0);
    expect(reach.lastY).toBeLessThan(reach.vh);
    expect(reach.lastY).toBeGreaterThan(-50);

    // Closing puts the reader back exactly where they were.
    await open();
    const closed = await page.evaluate(() => ({
      open: document.getElementById('mobileNav').classList.contains('open'),
      locked: document.body.classList.contains('nbd-nav-open'),
      bodyPos: getComputedStyle(document.body).position,
      y: Math.round(window.scrollY),
    }));
    expect(closed.open).toBe(false);
    expect(closed.locked).toBe(false);
    expect(closed.bodyPos).not.toBe('fixed');
    const navTrace = await page.evaluate(() => (window.__NBD_NAV_TRACE || []).slice(-60));
    expect(Math.abs(closed.y - startY), `restore missed (start ${startY}, closed ${closed.y}); nav trace: ${JSON.stringify(navTrace)}`).toBeLessThanOrEqual(2);

    /* Three pages still ship a legacy closeMobileNav() bound to the <a>
       itself. A target-phase listener on the link runs before the
       controller's bubble-phase listener on the drawer, so `.open` is gone
       before setOpen(false) is reached. If the controller treats that as
       "already closed" and skips the unlock, the body stays position:fixed
       and the page is frozen with no way back except a reload. */
    await open();
    await page.evaluate(() => document.getElementById('mobileNav').classList.remove('open'));
    await page.waitForTimeout(250);
    const thawed = await page.evaluate(() => ({
      locked: document.body.classList.contains('nbd-nav-open'),
      bodyPos: getComputedStyle(document.body).position,
    }));
    expect(thawed.locked).toBe(false);
    expect(thawed.bodyPos).not.toBe('fixed');

    expect(pageErrors).toEqual([]);
  });
}

test('Services dropdown fits the viewport and opens by tap', async ({ browser }) => {
  /* 24 items render ~993px tall. With no max-height and no overflow on a
     position:absolute menu, the bottom eight links (Roof Cleaning through
     Free 24-Hr Inspection) were simply unreachable on a 1366x768 laptop —
     nothing to scroll, and the menu ran off the bottom of the screen. */
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('.nav-links .dropdown > a').first().click();
  await page.waitForTimeout(300);

  const menu = await page.evaluate(() => {
    const m = document.querySelector('.nav-links .dropdown-menu');
    const r = m.getBoundingClientRect();
    const cs = getComputedStyle(m);
    return {
      display: cs.display,
      overflowY: cs.overflowY,
      bottom: Math.round(r.y + r.height),
      right: Math.round(r.x + r.width),
      vh: window.innerHeight,
      vw: window.innerWidth,
      items: m.querySelectorAll('a').length,
      scrollable: m.scrollHeight > m.clientHeight,
    };
  });

  expect(menu.display).toBe('block');
  expect(menu.bottom).toBeLessThanOrEqual(menu.vh);
  expect(menu.right).toBeLessThanOrEqual(menu.vw);
  // If it had to be capped to fit, it must be scrollable, or the capping just
  // moved the unreachable links from off-screen to clipped.
  if (menu.scrollable) expect(menu.overflowY).toBe('auto');

  // Escape closes it. Nothing used to.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() =>
    !!document.querySelector('.nav-links .dropdown.open'))).toBe(false);

  await ctx.close();
});
