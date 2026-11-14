/**
 * tests/ds-day-rollover-2026-11-14.test.js
 *
 * Audit 2026-11-14 #8 and #10: data landing on the wrong day.
 *   #8  A workout opened at night (the coach builds it with that day's date) and lifted the next morning was filed
 *       under the night before: history, the week strip and the "workout done" floor all pointed at yesterday.
 *       Now it is filed under the day the first set was logged; a workout that runs past midnight stays on the day
 *       lifting began.
 *   #10 Left open past midnight, the page kept showing yesterday as TODAY, so floor ticks and notes landed on
 *       yesterday. Now coming back to the app (visibilitychange / pageshow / focus) after the date changed
 *       moves TODAY to the new day.
 *
 * Run: cd tests && node ds-day-rollover-2026-11-14.test.js
 */
'use strict';
const path = require('path');
const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

(async () => {
  console.log('\n#8 a workout opened at night, lifted next morning');
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-13' });
    h.click('start');
    ok('control: built with the night it was opened', h.live().date === '2026-11-13');
    h.click('close');
    h.sandbox.todayKey = () => '2026-11-14';          // next morning
    h.sandbox.NBDCoachUI.open();
    h.click('done', { i: 0, s: 0 });
    h.click('finish');
    const saved = h.saved();
    ok('it is filed under the morning it was lifted', saved.length === 1 && saved[0].date === '2026-11-14', JSON.stringify(saved.map((s) => s.date)));
  }
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-13' });
    h.click('start');
    h.click('done', { i: 0, s: 0 });                   // 11:40 pm: lifting starts
    h.sandbox.todayKey = () => '2026-11-14';          // past midnight
    h.click('done', { i: 0, s: 1 });
    h.click('finish');
    ok('control: a workout that runs past midnight stays on the day lifting began', h.saved()[0] && h.saved()[0].date === '2026-11-13', JSON.stringify(h.saved().map((s) => s.date)));
  }
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-13' });
    h.click('start');
    h.sandbox.todayKey = () => '2026-11-14';
    h.field('reps', 0, 0, '8');                        // typed reps count as a logged set too
    h.click('finish');
    ok('typing reps (no ✓) next morning also files it under the morning', h.saved()[0] && h.saved()[0].date === '2026-11-14', JSON.stringify(h.saved().map((s) => s.date)));
  }

  {
    // reps pre-filled from the target and never ticked or typed: Finish ticks them, so nothing marked the first set
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-13' });
    h.click('start');
    const live = h.live(); live.exercises[0].sets[0].reps = '8'; h.store.set('nbd_ds_coach_live', JSON.stringify(live));
    const h2 = makeHarness({ storage: { nbd_ds_workouts: [], nbd_ds_coach_live: live }, today: '2026-11-14' });
    h2.click('finish');
    ok('Finish the next morning with only pre-filled reps files it under that morning', h2.saved()[0] && h2.saved()[0].date === '2026-11-14', JSON.stringify(h2.saved().map((s) => s.date)) + ' ' + JSON.stringify(h2.toasts));
  }

  console.log('\n#10 the page left open past midnight');
  let chromium, start;
  try { ({ chromium } = require('playwright')); ({ start } = require('./lib/demo-hosting-server.js')); }
  catch (e) { console.log('  ✗ playwright unavailable: ' + e.message); failed++; return finish(); }
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 760 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const night = new Date(2026, 10, 13, 23, 50, 0);
    await page.clock.install({ time: night });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__seeded')) {
        sessionStorage.setItem('__seeded', '1');
        const mk = (id, dk) => ({ id, dk, suf: 1, name: '', data: {}, kpi: { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 }, exercises: [], objections: [], commissions: [] });
        localStorage.setItem('nbd_dsp_v1', JSON.stringify([mk(1, '2026-11-12'), mk(2, '2026-11-13')]));
      }
      localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic');
    });
    await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof switchTo === 'function' && pages.length > 0);
    await page.evaluate(() => switchTo(pages.findIndex((p) => p.dk === todayKey())));
    ok('control: at 11:50 pm the open page is Nov 13', await page.evaluate(() => pages[cur].dk) === '2026-11-13');
    // phone locked overnight; Jo opens it at 7 am
    await page.clock.setSystemTime(new Date(2026, 10, 14, 7, 0, 0));
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({ dk: cur >= 0 && pages[cur] ? pages[cur].dk : null, today: todayKey(), days: pages.map((p) => p.dk) }));
    ok('coming back the next morning no longer shows yesterday as the open day: the Dash, with today\'s card', st.dk === null && await page.evaluate(() => cur === -1), JSON.stringify(st));
    ok('...and no Nov 14 page is made before the cloud pull (another device may already have one)', !st.days.includes('2026-11-14'), JSON.stringify(st.days));
    await page.click('#main .nu-today [data-nu="open-today"]');
    await page.waitForTimeout(300);
    ok('"Open today" then opens Nov 14', await page.evaluate(() => pages[cur] && pages[cur].dk) === '2026-11-14');
    await page.evaluate(() => { const f = getFloors()[0]; toggleFloor(f.id); flushDirty(); });
    const where = await page.evaluate(() => { const ps = JSON.parse(localStorage.getItem('nbd_dsp_v1')); const id = getFloors()[0].id; return ps.filter((p) => p.data && p.data['floormet-' + id] === '1').map((p) => p.dk); });
    ok('a floor tick then lands on Nov 14, not Nov 13', JSON.stringify(where) === '["2026-11-14"]', JSON.stringify(where));
    await ctx.close();
    // control: a page that is NOT today's (Jo reading an old day) is not yanked away
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 760 } });
    const p2 = await ctx2.newPage(); p2.setDefaultTimeout(30000);
    await p2.clock.install({ time: night });
    await p2.addInitScript(() => {
      const mk = (id, dk) => ({ id, dk, suf: 1, name: '', data: {}, kpi: {}, exercises: [], objections: [], commissions: [] });
      if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); localStorage.setItem('nbd_dsp_v1', JSON.stringify([mk(1, '2026-11-12'), mk(2, '2026-11-13')])); }
      localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic');
    });
    await p2.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
    await p2.waitForFunction(() => typeof switchTo === 'function' && pages.length > 0);
    await p2.evaluate(() => switchTo(pages.findIndex((p) => p.dk === '2026-11-12')));
    await p2.clock.setSystemTime(new Date(2026, 10, 14, 7, 0, 0));
    await p2.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await p2.waitForTimeout(400);
    ok('control: an older day Jo was reading stays open', await p2.evaluate(() => pages[cur] && pages[cur].dk) === '2026-11-12');
    // today's page already on the phone (e.g. pulled from the laptop): coming back on yesterday's page moves straight to it
    await p2.evaluate(() => { pages.push(mkPage('2026-11-14'), mkPage('2026-11-15')); savePages(); switchTo(pages.findIndex((p) => p.dk === '2026-11-14')); });
    const from = await p2.evaluate(() => pages[cur].dk);
    await p2.clock.setSystemTime(new Date(2026, 10, 15, 7, 0, 0));
    await p2.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await p2.waitForTimeout(400);
    ok('a today page that already exists is opened on return (from ' + from + ')', await p2.evaluate(() => pages[cur] && pages[cur].dk) === '2026-11-15' && await p2.evaluate(() => pages.filter((p) => p.dk === '2026-11-15').length) === 1);
    await ctx2.close();
  } finally { await browser.close(); if (srv.close) srv.close(); }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });

function finish() { console.log(String.fromCharCode(10) + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); }
