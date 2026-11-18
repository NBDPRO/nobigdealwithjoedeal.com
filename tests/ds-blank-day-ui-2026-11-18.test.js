/**
 * tests/ds-blank-day-ui-2026-11-18.test.js
 *
 * The "yesterday is blank" banner on the Daily Success Dash, in a real browser at phone width with the clock fixed (the rules themselves are
 * unit tested in ds-blank-day-2026-11-18.test.js). Seeded tracker: one logged day (Sat 14 Nov), nothing for Tue 17 Nov, today is Wed 18 Nov.
 *   - the Dash Today card says "Yesterday (Tue Nov 17) is blank" with "Fill it in" and "Not now", and "Days logged this week: 1 / 7";
 *   - "Fill it in" makes yesterday's page (there is none) and opens it, once;
 *   - "Not now" hides the banner and it stays hidden after a reload;
 *   - on a Monday (yesterday = Sunday) there is no banner;
 *   - the card fits at 320 and 390 px with no sideways scroll and 44 px buttons.
 *
 * Run: cd tests && node ds-blank-day-ui-2026-11-18.test.js
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const WED = new Date(2026, 10, 18, 9, 0, 0), MON = new Date(2026, 10, 23, 9, 0, 0);

async function open(browser, srv, o) {
  const ctx = await browser.newContext({ viewport: { width: o.width || 390, height: 760 } });
  await ctx.clock.setFixedTime(o.time);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await ctx.addInitScript((seed) => {
    localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic');
    if (seed && !localStorage.getItem('nbd_dsp_v1')) localStorage.setItem('nbd_dsp_v1', JSON.stringify(seed));
  }, o.seed || null);
  await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof switchTo === 'function' && window.NBDNextUp && window.NBDBlankDay && pages.length > 0);
  return { ctx, page };
}
const mk = (dk, ids, extra) => ({ id: Math.random(), dk, suf: 1, name: '', data: Object.fromEntries(ids.map((i) => ['floormet-' + i, '1'])), kpi: { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 }, exercises: [], objections: [], commissions: [] });

(async () => {
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    // discover the default floor ids once
    const probe = await open(browser, srv, { time: WED });
    const ids = await probe.page.evaluate(() => getFloors().map((f) => f.id));
    await probe.ctx.close();
    ok('the tracker has floors to seed', ids.length >= 2, JSON.stringify(ids));
    const seed = [mk('2026-11-14', ids.slice(0, 2))];

    console.log('\n1. the banner on the Dash (Wed 18 Nov, yesterday blank)');
    const a = await open(browser, srv, { time: WED, seed });
    await a.page.evaluate(() => switchTo(-1));
    await a.page.waitForSelector('.nu-today');
    const txt = await a.page.evaluate(() => document.querySelector('.nu-today').innerText);
    ok('says yesterday (Tue Nov 17) is blank', /Yesterday \(Tue Nov 17\) is blank/.test(txt), txt.slice(0, 160));
    ok('offers Fill it in and Not now', /Fill it in/.test(txt) && /Not now/.test(txt));
    ok('shows Days logged this week: 1 / 7', /Days logged this week: 1 \/ 7/.test(txt), txt.slice(0, 220));
    const box = await a.page.evaluate(() => { const t = document.querySelector('.nu-today'), r = t.getBoundingClientRect(); const btns = [...t.querySelectorAll('.nu-blank button')].map((b) => Math.round(b.getBoundingClientRect().height)); return { right: Math.round(r.right), vw: innerWidth, btns, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
    ok('the card fits at 390 px with no sideways scroll', box.right <= box.vw && !box.hscroll, JSON.stringify(box));
    ok('both buttons are at least 44 px tall', box.btns.length === 2 && box.btns.every((h) => h >= 44), JSON.stringify(box.btns));

    console.log('\n2. Fill it in');
    ok('there is no page for yesterday yet', await a.page.evaluate(() => !pages.some((p) => p.dk === '2026-11-17')));
    await a.page.click('[data-blank="open"]');
    await a.page.waitForTimeout(300);
    const after = await a.page.evaluate(() => ({ dk: cur >= 0 ? pages[cur].dk : null, count: pages.filter((p) => p.dk === '2026-11-17').length, stored: JSON.parse(localStorage.getItem('nbd_dsp_v1')).filter((p) => p.dk === '2026-11-17').length }));
    ok('yesterday\'s page was made and is open', after.dk === '2026-11-17', JSON.stringify(after));
    ok('exactly one page was made, and it is saved', after.count === 1 && after.stored === 1, JSON.stringify(after));
    await a.page.evaluate(() => switchTo(-1));
    await a.page.waitForSelector('.nu-today');
    ok('back on the Dash a second tap finds the same page (no duplicate)', await (async () => {
      await a.page.click('[data-blank="open"]'); await a.page.waitForTimeout(200);
      return (await a.page.evaluate(() => pages.filter((p) => p.dk === '2026-11-17').length)) === 1;
    })());

    console.log('\n3. Not now');
    await a.page.evaluate(() => switchTo(-1));
    await a.page.waitForSelector('.nu-today .nu-blank');
    await a.page.click('[data-blank="later"]');
    await a.page.waitForTimeout(200);
    ok('the banner is gone', await a.page.evaluate(() => !document.querySelector('.nu-blank')));
    ok('the Days logged line stays', await a.page.evaluate(() => /Days logged this week/.test(document.querySelector('.nu-today').innerText)));
    await a.page.reload({ waitUntil: 'load' });
    await a.page.waitForFunction(() => window.NBDNextUp && pages.length > 0);
    await a.page.evaluate(() => switchTo(-1));
    await a.page.waitForSelector('.nu-today');
    ok('and it stays gone after a reload', await a.page.evaluate(() => !document.querySelector('.nu-blank')));
    await a.ctx.close();

    console.log('\n4. a Monday: yesterday was Sunday');
    const m = await open(browser, srv, { time: MON, seed });
    await m.page.evaluate(() => switchTo(-1));
    await m.page.waitForSelector('.nu-today');
    ok('no banner', await m.page.evaluate(() => !document.querySelector('.nu-blank')));
    await m.ctx.close();

    console.log('\n5. a small phone (320 px)');
    const s = await open(browser, srv, { time: WED, seed, width: 320 });
    await s.page.evaluate(() => switchTo(-1));
    await s.page.waitForSelector('.nu-today .nu-blank');
    const small = await s.page.evaluate(() => { const r = document.querySelector('.nu-today').getBoundingClientRect(); return { right: Math.round(r.right), vw: innerWidth, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
    ok('the card fits with no sideways scroll', small.right <= small.vw && !small.hscroll, JSON.stringify(small));
    await s.ctx.close();
  } finally { await browser.close(); if (srv.close) srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
