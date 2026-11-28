/**
 * tests/ds-review-audit-ui-2026-11-18.test.js
 *
 * The Sunday review sheet in a real browser at phone width, clock fixed to Wed 18 Nov 2026 (the review covers Wed 11 to Tue 17 Nov).
 * Seeded week: the five floors hit 7, 6, 4, 3 and 0 days. The rule is in ds-review-audit-suggest-2026-11-18.test.js; this checks the sheet:
 *   - under "kept" and "bailed" a one-line "From your floors: ..." suggestion with a Use button, the 4/7 floor in neither;
 *   - opening the sheet writes nothing into the boxes;
 *   - Use fills an empty box, appends on a new line to a box that has text, and a second tap does not add it twice;
 *   - the saved review carries what is in the boxes;
 *   - a week with only middle floors shows no suggestion line at all; the line fits at 390 px with a 44 px Use button.
 *
 * Run: cd tests && node ds-review-audit-ui-2026-11-18.test.js
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const WED = new Date(2026, 10, 18, 9, 0, 0);
const DAYS = []; for (let d = 11; d <= 17; d++) DAYS.push('2026-11-' + d);
const mk = (dk, ids) => ({ id: Math.random(), dk, suf: 1, name: '', data: Object.fromEntries(ids.map((i) => ['floormet-' + i, '1'])), kpi: { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 }, exercises: [], objections: [], commissions: [] });
// hits[i] = how many of the 7 days floor i was met
const week = (ids, hits) => DAYS.map((dk, n) => mk(dk, ids.filter((_, i) => n < hits[i])));

async function open(browser, srv, seed) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.clock.setFixedTime(WED);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await ctx.addInitScript((s) => {
    localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic');
    if (s && !localStorage.getItem('nbd_dsp_v1')) localStorage.setItem('nbd_dsp_v1', JSON.stringify(s));
  }, seed || null);
  await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.NBDReviewUI && window.NBDReview && pages.length > 0);
  return { ctx, page };
}

(async () => {
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    const probe = await open(browser, srv, null);
    const fl = await probe.page.evaluate(() => getFloors().map((f) => ({ id: f.id, label: f.label })));
    await probe.ctx.close();
    ok('the tracker has five floors to seed', fl.length === 5, JSON.stringify(fl.map((f) => f.id)));
    const ids = fl.map((f) => f.id), L = fl.map((f) => f.label);

    console.log('\n1. the sheet suggests from the floors');
    const a = await open(browser, srv, week(ids, [7, 6, 4, 3, 0]));
    await a.page.evaluate(() => NBDReviewUI.open());
    await a.page.waitForSelector('#rvOverlay.open #rvKept');
    const info = await a.page.evaluate(() => {
      const t = (f) => { const n = document.querySelector('.rv-sug[data-for="' + f + '"]'); return n ? n.innerText : null; };
      return { kept: t('rvKept'), bailed: t('rvBailed'), keptBox: document.getElementById('rvKept').value, bailedBox: document.getElementById('rvBailed').value };
    });
    ok('under "kept": the 7/7 and 6/7 floors', info.kept && info.kept.indexOf('From your floors: ' + L[0] + ' 7/7, ' + L[1] + ' 6/7') === 0, JSON.stringify(info.kept));
    ok('under "bailed": the 3/7 and 0/7 floors', info.bailed && info.bailed.indexOf('From your floors: ' + L[3] + ' 3/7, ' + L[4] + ' 0/7') === 0, JSON.stringify(info.bailed));
    ok('the 4/7 floor is in neither line', !(String(info.kept) + String(info.bailed)).includes(L[2] + ' 4/7'));
    ok('opening the sheet wrote nothing into either box', info.keptBox === '' && info.bailedBox === '', JSON.stringify([info.keptBox, info.bailedBox]));

    console.log('\n2. Use');
    await a.page.click('[data-rv-action="use"][data-for="rvKept"]');
    const k1 = await a.page.inputValue('#rvKept');
    ok('Use fills an empty box with the suggestion', k1 === L[0] + ' 7/7, ' + L[1] + ' 6/7', JSON.stringify(k1));
    await a.page.click('[data-rv-action="use"][data-for="rvKept"]').catch(() => {});
    ok('a second tap does not add it twice', (await a.page.inputValue('#rvKept')) === k1);
    await a.page.fill('#rvBailed', 'skipped the gym twice');
    await a.page.click('[data-rv-action="use"][data-for="rvBailed"]');
    const b1 = await a.page.inputValue('#rvBailed');
    ok('Use appends on a new line to a box that has text', b1 === 'skipped the gym twice\n' + L[3] + ' 3/7, ' + L[4] + ' 0/7', JSON.stringify(b1));

    console.log('\n3. it is saved with the review');
    await a.page.click('[data-rv-action="save"]');
    await a.page.waitForTimeout(300);
    const saved = await a.page.evaluate(() => { const w = JSON.parse(localStorage.getItem('nbd_ds_reviews')).weeks; return w['2026-11-18']; });
    ok('the saved week holds both boxes', saved && saved.kept === k1 && saved.bailed === b1, JSON.stringify(saved && [saved.kept, saved.bailed]));
    await a.page.evaluate(() => NBDReviewUI.open());
    await a.page.waitForSelector('#rvOverlay.open #rvKept');
    ok('reopened: the saved text is still in the boxes', (await a.page.inputValue('#rvKept')) === k1);
    await a.ctx.close();

    console.log('\n4. fit on a phone');
    const f = await open(browser, srv, week(ids, [7, 6, 4, 3, 0]));
    await f.page.evaluate(() => NBDReviewUI.open());
    await f.page.waitForSelector('#rvOverlay.open .rv-sug');
    const fit = await f.page.evaluate(() => { const ov = document.getElementById('rvOverlay'); const b = [...document.querySelectorAll('.rv-use')].map((x) => Math.round(x.getBoundingClientRect().height)); const sug = [...document.querySelectorAll('.rv-sug')].map((x) => Math.round(x.getBoundingClientRect().right)); return { b, sug, vw: innerWidth, hscroll: ov.scrollWidth > ov.clientWidth }; });
    ok('the Use buttons are at least 44 px tall', fit.b.length === 2 && fit.b.every((h) => h >= 44), JSON.stringify(fit.b));
    ok('the lines fit the screen with no sideways scroll', fit.sug.every((r) => r <= fit.vw) && !fit.hscroll, JSON.stringify(fit));
    await f.ctx.close();

    console.log('\n5. a week with only middle floors');
    const m = await open(browser, srv, week(ids, [5, 4, 5, 4, 5]));
    await m.page.evaluate(() => NBDReviewUI.open());
    await m.page.waitForSelector('#rvOverlay.open #rvKept');
    ok('no suggestion line is drawn at all', await m.page.evaluate(() => document.querySelectorAll('.rv-sug').length === 0));
    await m.ctx.close();
  } finally { await browser.close(); if (srv.close) srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
