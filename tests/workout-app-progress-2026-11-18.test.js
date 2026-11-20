/**
 * tests/workout-app-progress-2026-11-18.test.js
 *
 * The Progress card (estimated 1RM per lift + 12-week volume) on the standalone Workout app (Joe, 2026-11-18, Q8 / Q1 / Q2).
 * The card, its rules and its styles already exist for Daily Success; the Workout page only had no place to draw it. In a real browser at
 * phone width with the clock fixed to Wed 18 Nov 2026:
 *   - the card sits under the coach card and the sign-in link, above the Theme settings (DOM order);
 *   - with finished workouts it shows the lift chips, the estimated 1RM, the line chart and the volume bars; tapping a chip switches lift;
 *   - with none it shows the card's own "Finish a few workouts..." message (Q2: show it);
 *   - finishing a real workout in the coach redraws the card without a reload;
 *   - it fits at 390 and 320 px with no sideways scroll;
 *   - the 12-month heatmap script is NOT loaded here (Q8: charts only).
 *
 * Run: cd tests && node workout-app-progress-2026-11-18.test.js
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const WED = new Date(2026, 10, 18, 9, 0, 0);
const set = (w, r) => ({ weight: w, reps: r, rpe: 8, done: true });
const sess = (date, exId, name, w, r) => ({ id: 's-' + date + exId, date, split: 'push', startedAt: 1, finishedAt: 2000, exercises: [{ exId, name, slot: 0, sets: [set(w, r), set(w, r), set(w, r)] }] });
const SEED = [
  sess('2026-10-27', 'bb_bench', 'Barbell Bench Press', 135, 8), sess('2026-11-03', 'bb_bench', 'Barbell Bench Press', 145, 8),
  sess('2026-11-10', 'bb_bench', 'Barbell Bench Press', 155, 6), sess('2026-11-17', 'bb_bench', 'Barbell Bench Press', 165, 5),
  sess('2026-11-03', 'bb_squat', 'Barbell Back Squat', 185, 5), sess('2026-11-10', 'bb_squat', 'Barbell Back Squat', 205, 5),
];

async function open(browser, srv, o) {
  const ctx = await browser.newContext({ viewport: { width: o.width || 390, height: 780 } });
  await ctx.clock.setFixedTime(WED);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const requested = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  await ctx.addInitScript((seed) => { if (seed && !localStorage.getItem('nbd_ds_workouts')) localStorage.setItem('nbd_ds_workouts', JSON.stringify(seed)); }, o.seed || null);
  await page.goto(srv.origin + '/pro/workout/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.NBDCoachUI && window.NBDWorkoutApp);
  return { ctx, page, requested };
}

(async () => {
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    console.log('\n1. with finished workouts');
    const a = await open(browser, srv, { seed: SEED });
    await a.page.waitForSelector('#waProgress #pgCard');
    const info = await a.page.evaluate(() => {
      const box = document.getElementById('waProgress'), card = document.getElementById('pgCard');
      const after = (x, y) => !!(x && y && (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING));
      return {
        order: after(document.getElementById('wcCard'), box) && after(document.getElementById('waSignIn'), box) && after(box, document.getElementById('waTheme')),
        chips: [...card.querySelectorAll('.pg-chip')].map((c) => c.textContent.trim()),
        on: (card.querySelector('.pg-chip.on') || {}).textContent,
        big: (card.querySelector('.wt-big') || {}).innerText || '', charts: card.querySelectorAll('.pg-chart svg').length, cards: document.querySelectorAll('#pgCard').length,
      };
    });
    ok('the card is under the coach card and sign-in link, above Theme', info.order);
    ok('chips for both lifts, bench (done most) first', info.chips[0] === 'Barbell Bench Press' && info.chips.includes('Barbell Back Squat'), JSON.stringify(info.chips));
    ok('shows an estimated 1RM number for the open lift', /\d+\s*lb est\. 1RM/.test(info.big), info.big);
    ok('draws the line chart and the volume bars', info.charts === 2, String(info.charts));
    ok('exactly one card', info.cards === 1);
    await a.page.click('.pg-chip:has-text("Squat")');
    const sq = await a.page.evaluate(() => ({ on: (document.querySelector('#pgCard .pg-chip.on') || {}).textContent, cards: document.querySelectorAll('#pgCard').length, inBox: !!document.querySelector('#waProgress #pgCard') }));
    ok('tapping a chip switches lift and keeps one card in place', sq.on === 'Barbell Back Squat' && sq.cards === 1 && sq.inBox, JSON.stringify(sq));
    ok('the heatmap script is not loaded (charts only)', !a.requested.some((p) => /heatmap/i.test(p)), JSON.stringify(a.requested.filter((p) => /heatmap/i.test(p))));
    await a.ctx.close();

    console.log('\n2. no workouts yet');
    const e = await open(browser, srv, { seed: null });
    await e.page.waitForSelector('#waProgress #pgCard');
    const msg = await e.page.evaluate(() => document.getElementById('pgCard').innerText);
    ok('the card shows its own message', /Finish a few workouts in the coach and your lifts chart here/.test(msg), msg.slice(0, 120));

    console.log('\n3. finishing a workout redraws it');
    await e.page.evaluate(() => window.NBDCoachUI.start());
    await e.page.waitForSelector('#wcOverlay.open input[aria-label="Weight, set 1"]');
    const got = e.page.locator('#wcOverlay button:has-text("Got it")');
    if (await got.count()) await got.first().click();
    await e.page.locator('#wcOverlay input[aria-label="Weight, set 1"]').first().fill('225');
    await e.page.locator('#wcOverlay button[aria-label="Set 1 done"]').first().click();
    await e.page.locator('#wcOverlay button:has-text("Finish workout")').first().click();
    await e.page.waitForSelector('#wcOverlay .wc-sum, #wcOverlay :text("DONE")');
    await e.page.evaluate(() => window.NBDCoachUI.close());
    await e.page.waitForFunction(() => /1 session/.test((document.getElementById('pgCard') || {}).innerText || ''));
    const done = await e.page.evaluate(() => ({ chips: [...document.querySelectorAll('#pgCard .pg-chip')].map((c) => c.textContent.trim()), cards: document.querySelectorAll('#pgCard').length }));
    ok('the finished lift now has a chip, still one card, no reload', done.chips.length === 1 && /Bench/.test(done.chips[0]) && done.cards === 1, JSON.stringify(done));
    await e.ctx.close();

    console.log('\n3b. a lift name with markup in it stays text');
    const evil = '<img id="xss" src=x onerror="window.__pwned=1">Press';
    const x = await open(browser, srv, { seed: [sess('2026-11-10', 'custom_evil', evil, 100, 5), sess('2026-11-17', 'custom_evil', evil, 105, 5)] });
    await x.page.waitForSelector('#waProgress #pgCard');
    await x.page.waitForTimeout(300);
    const inj = await x.page.evaluate(() => ({ el: !!document.getElementById('xss'), pwned: !!window.__pwned, text: document.getElementById('pgCard').innerText }));
    ok('the markup is shown as text, no element is made and nothing runs', !inj.el && !inj.pwned && /Press/.test(inj.text), JSON.stringify(inj).slice(0, 160));
    await x.ctx.close();

    console.log('\n4. fit on a phone');
    for (const w of [390, 320]) {
      const s = await open(browser, srv, { seed: SEED, width: w });
      await s.page.waitForSelector('#waProgress #pgCard');
      const f = await s.page.evaluate(() => { const r = document.getElementById('pgCard').getBoundingClientRect(); return { right: Math.round(r.right), vw: innerWidth, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, chipH: [...document.querySelectorAll('#pgCard .pg-chip')].map((c) => Math.round(c.getBoundingClientRect().height)) }; });
      ok(w + ' px: the card fits with no sideways scroll', f.right <= f.vw && !f.hscroll, JSON.stringify(f));
      ok(w + ' px: the lift chips are at least 44 px tall', f.chipH.length >= 2 && f.chipH.every((h) => h >= 44), JSON.stringify(f.chipH));
      await s.ctx.close();
    }
  } finally { await browser.close(); if (srv.close) srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
