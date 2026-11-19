/**
 * tests/ds-rpe-history-ui-2026-11-18.test.js
 *
 * RPE history on the two screens (Joe, 2026-11-18), in a real browser at phone width with the clock fixed to Wed 18 Nov 2026.
 * The rule is in ds-rpe-history-2026-11-18.test.js; this checks what Joe sees:
 *   - Progress card (Daily Success Dash): under the lift's 1RM line, "Top-set RPE 7 → 7.5 → 8 → 8.5 (getting harder)", above the weekly
 *     volume. A lift with no RPE logged shows no such line, and switching lift follows.
 *   - Workout history (the coach): an opened workout shows "· RPE 8.5" after a lift that logged one, and nothing for a lift that did not.
 *   - The line wraps inside the card at 390 and 320 px.
 *
 * Run: cd tests && node ds-rpe-history-ui-2026-11-18.test.js
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const WED = new Date(2026, 10, 18, 9, 0, 0);
const set = (w, r, rpe) => ({ weight: w, reps: r, rpe, done: true });
const sess = (date, exId, name, w, r, rpe) => ({ id: 's-' + date + exId, date, split: 'push', startedAt: 1, finishedAt: 2000, exercises: [{ exId, name, slot: 0, sets: [set(w, r, rpe), set(w, r, rpe), set(w, r, rpe)] }] });
// bench logs RPE 7 -> 8.5 over four sessions; squat never logs one. Newest first in the history: 11-17 squat, 11-10 bench, ...
const SEED = [
  sess('2026-10-20', 'bb_bench', 'Barbell Bench Press', 135, 8, 7), sess('2026-10-27', 'bb_bench', 'Barbell Bench Press', 145, 8, 7.5),
  sess('2026-11-03', 'bb_bench', 'Barbell Bench Press', 155, 6, 8), sess('2026-11-10', 'bb_bench', 'Barbell Bench Press', 165, 5, 8.5),
  sess('2026-10-27', 'bb_squat', 'Barbell Back Squat', 185, 5, ''), sess('2026-11-03', 'bb_squat', 'Barbell Back Squat', 195, 5, ''),
  sess('2026-11-17', 'bb_squat', 'Barbell Back Squat', 205, 5, ''),
];
const LINE = 'Top-set RPE 7 → 7.5 → 8 → 8.5 (getting harder)';

async function open(browser, srv, url, o) {
  const ctx = await browser.newContext({ viewport: { width: o.width || 390, height: 780 } });
  await ctx.clock.setFixedTime(WED);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await ctx.addInitScript((seed) => {
    localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic');
    if (!localStorage.getItem('nbd_ds_workouts')) localStorage.setItem('nbd_ds_workouts', JSON.stringify(seed));
  }, SEED);
  await page.goto(srv.origin + url, { waitUntil: 'load' });
  return { ctx, page };
}

(async () => {
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    console.log('\n1. the Progress card');
    const a = await open(browser, srv, '/pro/daily-success/', {});
    await a.page.waitForFunction(() => typeof switchTo === 'function' && window.NBDProgressUI && pages.length > 0);
    await a.page.evaluate(() => switchTo(-1));
    await a.page.waitForSelector('#pgCard .pg-chip');
    const one = await a.page.evaluate(() => {
      const card = document.getElementById('pgCard'), r = card.querySelector('.pg-rpe');
      const lbl = [...card.querySelectorAll('.wc-lbl')].find((x) => /Weekly volume/.test(x.textContent));
      const chart = card.querySelector('.pg-chart');
      const after = (x, y) => !!(x && y && (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING));
      return { open: (card.querySelector('.pg-chip.on') || {}).textContent, text: r ? r.textContent : null, order: after(chart, r) && after(r, lbl) };
    });
    ok('the open lift is bench (done most)', /Bench/.test(one.open), JSON.stringify(one.open));
    ok('the RPE line is there with the trend', one.text === LINE, JSON.stringify(one.text));
    ok('it sits under the 1RM chart and above the weekly volume', one.order);
    await a.page.click('.pg-chip:has-text("Squat")');
    ok('a lift with no RPE logged shows no RPE line', await a.page.evaluate(() => document.querySelectorAll('#pgCard .pg-rpe').length === 0));
    await a.page.click('.pg-chip:has-text("Bench")');
    ok('back on bench the line returns', (await a.page.evaluate(() => (document.querySelector('#pgCard .pg-rpe') || {}).textContent)) === LINE);
    await a.ctx.close();

    console.log('\n2. the workout history');
    const w = await open(browser, srv, '/pro/workout/', {});
    await w.page.waitForFunction(() => window.NBDCoachUI && window.NBDWorkoutApp);
    await w.page.locator('button:has-text("Workout history")').first().click();
    await w.page.waitForSelector('#wcOverlay .wc-hist-row');
    const rows = await w.page.locator('#wcOverlay .wc-hist-row').count();
    ok('seven finished workouts are listed', rows === 7, String(rows));
    // newest first: 11-17 squat (no RPE), 11-10 bench (8.5)
    await w.page.locator('#wcOverlay .wc-hist-row').nth(0).click();
    const squat = await w.page.evaluate(() => [...document.querySelectorAll('#wcOverlay .wc-hist-ex')].map((e) => e.innerText.replace(/\s+/g, ' ')));
    ok('a lift that never logged RPE shows none', squat.length === 1 && /Squat/.test(squat[0]) && !/RPE/.test(squat[0]), JSON.stringify(squat));
    await w.page.locator('#wcOverlay .wc-hist-row').nth(1).click();
    const bench = await w.page.evaluate(() => [...document.querySelectorAll('#wcOverlay .wc-hist-ex')].map((e) => e.innerText.replace(/\s+/g, ' ')));
    ok('a lift that logged one shows "· RPE 8.5" after its sets', bench.length === 1 && /Bench/.test(bench[0]) && /165×5.*· RPE 8\.5/.test(bench[0]), JSON.stringify(bench));
    await w.ctx.close();

    console.log('\n3. fit on a phone');
    for (const width of [390, 320]) {
      const s = await open(browser, srv, '/pro/daily-success/', { width });
      await s.page.waitForFunction(() => typeof switchTo === 'function' && window.NBDProgressUI && pages.length > 0);
      await s.page.evaluate(() => switchTo(-1));
      await s.page.waitForSelector('#pgCard .pg-rpe');
      const f = await s.page.evaluate(() => { const r = document.querySelector('#pgCard .pg-rpe').getBoundingClientRect(), c = document.getElementById('pgCard').getBoundingClientRect(); return { right: Math.round(r.right), cardRight: Math.round(c.right), vw: innerWidth, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
      ok(width + ' px: the RPE line stays inside the card, no sideways scroll', f.right <= f.cardRight && f.cardRight <= f.vw && !f.hscroll, JSON.stringify(f));
      await s.ctx.close();
    }
  } finally { await browser.close(); if (srv.close) srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
