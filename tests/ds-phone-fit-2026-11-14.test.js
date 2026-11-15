/**
 * tests/ds-phone-fit-2026-11-14.test.js
 *
 * Audit 2026-11-14, phone UX:
 *   - The Workout Coach overlay had no top safe-area inset: on an iPhone the Close and settings buttons sat under the
 *     status bar / Dynamic Island. Its sticky header now clears it.
 *   - The toast sat 24 px from the bottom, under the home indicator. It now clears the bottom inset.
 *   - The 16 px "no zoom on focus" rule only applied under 768 px wide, so a phone turned sideways (844 px) zoomed again
 *     on every field. It now also applies to any touch (coarse pointer) screen.
 *   - Small tap targets: the food row's remove x (32 px) and the help sheet's close (28 px) are now 44 px.
 * Chromium has no notch, so the insets are set through the page's own --sat / --sab variables (which read env()).
 *
 * Run: cd tests && node ds-phone-fit-2026-11-14.test.js
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

async function openPage(browser, srv, ctxOpts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 760 } }, ctxOpts || {}));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(() => { localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic'); });
  await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof switchTo === 'function' && window.NBDCoachUI && pages.length > 0);
  return { ctx, page };
}

(async () => {
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await openPage(browser, srv);
    // an iPhone with a Dynamic Island and a home indicator
    await page.evaluate(() => { document.documentElement.style.setProperty('--sat', '59px'); document.documentElement.style.setProperty('--sab', '34px'); });

    console.log('\n1. the coach header clears the status bar');
    await page.evaluate(() => window.NBDCoachUI.start());
    await page.waitForTimeout(200);
    const top = await page.evaluate(() => { const x = document.querySelector('#wcOverlay .wc-x'); return x ? x.getBoundingClientRect().top : -1; });
    ok('the Close button sits below a 59 px top inset', top >= 59, String(top));
    await page.evaluate(() => { const o = document.getElementById('wcOverlay'); o.scrollTop = 2000; });
    await page.waitForTimeout(100);
    const topScrolled = await page.evaluate(() => document.querySelector('#wcOverlay .wc-x').getBoundingClientRect().top);
    ok('...and still does once the logger is scrolled (sticky header)', topScrolled >= 59, String(topScrolled));
    await page.evaluate(() => window.NBDCoachUI.close());

    console.log('\n2. the toast clears the home indicator');
    await page.evaluate(() => toast('Saved'));
    await page.waitForTimeout(400);
    const gap = await page.evaluate(() => { const t = document.getElementById('nbd-toast'); return parseFloat(getComputedStyle(t).bottom); });   // the resting offset (the slide-in transform is animation)
    ok('at least 24 px above a 34 px bottom inset', gap >= 24 + 34 - 1, String(gap));

    console.log('\n3. tap targets');
    const sizes = await page.evaluate(() => {
      const m = (cls) => { const e = document.createElement('button'); e.className = cls; e.textContent = '×'; document.body.appendChild(e); const r = e.getBoundingClientRect(); e.remove(); return [Math.round(r.width), Math.round(r.height)]; };
      return { flx: m('fl-x'), nhm: m('nhm-close') };
    });
    ok('the food row remove x is at least 44 px', sizes.flx[0] >= 44 && sizes.flx[1] >= 44, JSON.stringify(sizes.flx));
    ok('the help sheet close is at least 44 px', sizes.nhm[0] >= 44 && sizes.nhm[1] >= 44, JSON.stringify(sizes.nhm));
    await page.evaluate(() => switchTo(-1));
    await page.waitForTimeout(300);
    const week = await page.evaluate(() => [...document.querySelectorAll('[data-action="switch-to"][data-page-idx]')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    ok('the week strip days are at least 44 px tall (the whole column is the button)', week.length >= 1 && week.every(([w, h]) => h >= 44), JSON.stringify(week));
    await ctx.close();

    console.log('\n4. a phone turned sideways does not zoom into fields');
    const land = await openPage(browser, srv, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const fs16 = await land.page.evaluate(() => { const i = document.createElement('input'); i.type = 'text'; document.body.appendChild(i); const v = getComputedStyle(i).fontSize; i.remove(); const t = document.createElement('textarea'); document.body.appendChild(t); const w = getComputedStyle(t).fontSize; t.remove(); return [v, w]; });
    ok('text fields are 16 px at 844 px wide on a touch screen', fs16[0] === '16px' && fs16[1] === '16px', JSON.stringify(fs16));
    await land.ctx.close();
  } finally { await browser.close(); if (srv.close) srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
