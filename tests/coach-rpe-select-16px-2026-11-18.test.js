/**
 * tests/coach-rpe-select-16px-2026-11-18.test.js
 *
 * iOS Safari zooms the page when a form field under 16 px takes focus. The coach's weight and reps boxes were 16 px, but
 * the per-set RPE dropdown (.wc-rpe) was 14 px, so picking an RPE on an iPhone zoomed the screen. Found in the 2026-11-18
 * phone-sized pass of documentation/qa/daily-success-iphone-checklist-2026-11-18.md (B2/B3).
 *
 * This measures every field inside the open coach, on both pages that host it (Daily Success and the Workout app), so a
 * new field added at 14 px fails here too.
 *
 * Run: cd tests && node coach-rpe-select-16px-2026-11-18.test.js
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

async function coachFieldSizes(browser, srv, url) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(() => { localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic'); });
  await page.goto(srv.origin + url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.NBDCoachUI && typeof window.NBDCoachUI.start === 'function');
  await page.evaluate(() => window.NBDCoachUI.start());
  await page.waitForSelector('#wcOverlay .wc-rpe');
  const sizes = await page.evaluate(() => [...document.querySelectorAll('#wcOverlay input, #wcOverlay select, #wcOverlay textarea')]
    .map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className).split(' ')[0], px: parseFloat(getComputedStyle(e).fontSize) })));
  await ctx.close();
  return sizes;
}

(async () => {
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    for (const [name, url] of [['Daily Success', '/pro/daily-success/'], ['Workout app', '/pro/workout/']]) {
      console.log('\n' + name);
      const sizes = await coachFieldSizes(browser, srv, url);
      const rpe = sizes.filter((s) => s.cls === 'wc-rpe');
      const small = sizes.filter((s) => s.px < 16);
      ok('the coach has set rows with RPE dropdowns to measure', rpe.length >= 3 && sizes.length > rpe.length, 'rpe=' + rpe.length + ' fields=' + sizes.length);
      ok('every RPE dropdown is at least 16 px (iOS does not zoom)', rpe.every((s) => s.px >= 16), JSON.stringify(rpe.map((s) => s.px).slice(0, 3)));
      ok('no coach field of any kind is under 16 px', small.length === 0, small.length + ' small: ' + JSON.stringify([...new Set(small.map((s) => s.tag + '.' + s.cls + '@' + s.px))]));
    }
  } finally { await browser.close(); if (srv.close) srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
