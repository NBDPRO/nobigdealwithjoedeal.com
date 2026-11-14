/**
 * tests/ds-storage-full-2026-11-14.test.js
 *
 * Audit 2026-11-14 #9 and #13: a full or blocked phone storage must never look saved.
 *   #13 Workout Coach: a set typed while localStorage refuses the write was only in memory, with no
 *       word until Finish. Now the first failed write says so (red toast), once per few seconds.
 *   #9  Day page: collectPage() ignored savePages()'s false and the chip still flipped to SAVED
 *       (800 ms flush, 30 s autosave, the SAVE button). Now it stays UNSAVED and SAVE says it failed.
 *
 * Run: cd tests && node ds-storage-full-2026-11-14.test.js
 */
'use strict';
const path = require('path');
const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

(async () => {
  console.log('\n#13 Workout Coach: a set typed while storage is full');
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
    const errs = [];
    h.sandbox.toastErr = (m) => errs.push(String(m));
    h.click('start');
    h.field('reps', 0, 0, '8');
    ok('control: with room, typing a set raises no error', errs.length === 0 && h.live().exercises[0].sets[0].reps === '8');
    const realSet = h.sandbox.localStorage.setItem;
    h.sandbox.localStorage.setItem = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
    h.field('reps', 0, 1, '7');
    ok('a set that could not be stored says so at once', errs.length === 1 && /save|storage|space/i.test(errs[0]), JSON.stringify(errs));
    h.field('weight', 0, 1, '135');
    ok('...once, not on every keystroke', errs.length === 1, JSON.stringify(errs));
    ok('the typed set is still on screen (kept in memory for Finish to retry)', /value="7"/.test(h.html()) || /7/.test(h.html()));
    h.sandbox.localStorage.setItem = realSet;
    h.field('reps', 0, 2, '6');
    ok('control: once storage has room again the next set saves with every set typed so far', h.live().exercises[0].sets[1].reps === '7' && h.live().exercises[0].sets[2].reps === '6');
  }

  console.log('\n#9 Day page: the chip never says SAVED after a failed save');
  let chromium, start;
  try { ({ chromium } = require('playwright')); ({ start } = require('./lib/demo-hosting-server.js')); }
  catch (e) { console.log('  ✗ playwright unavailable: ' + e.message); failed++; finish(); return; }
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 760 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await page.addInitScript(() => { localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic'); });
    await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof switchTo === 'function' && typeof collectPage === 'function' && pages.length > 0);
    await page.evaluate(() => { const i = pages.findIndex((p) => p.dk === todayKey()); switchTo(i >= 0 ? i : 0); });
    await page.waitForFunction(() => document.querySelector('#main [data-k="l-win"]'));
    const typeWin = (v) => page.evaluate((x) => { const el = document.querySelector('#main [data-k="l-win"]'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    const chip = () => page.evaluate(() => document.getElementById('sdot').textContent.replace(/\s+/g, ' ').trim());
    // control: a normal edit ends SAVED
    await typeWin('control win');
    await page.waitForTimeout(1200);
    ok('control: with room, an edit ends SAVED', /SAVED/i.test(await chip()) && !/UNSAVED/i.test(await chip()), await chip());
    // fill the phone: every write of the pages key now throws
    await page.evaluate(() => { const real = Storage.prototype.setItem; window.__realSet = real; Storage.prototype.setItem = function (k, v) { if (k === 'nbd_dsp_v1') { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return real.call(this, k, v); }; });
    await typeWin('lost win');
    await page.waitForTimeout(1200);
    ok('after the 800 ms save fails the chip does not say SAVED', /UNSAVED/i.test(await chip()), await chip());
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [role="status"], [role="alert"]')].map((e) => e.textContent).join(' | '));
    ok('...and the red "could not save" toast showed', /Could not save on this device/.test(toasts), toasts.slice(0, 200));
    await page.evaluate(() => { window.__toasts = []; const t = window.toast; window.toast = function (m) { window.__toasts.push(String(m)); return t.apply(this, arguments); }; saveNow(); });
    const said = await page.evaluate(() => window.__toasts);
    ok('the SAVE button does not say "Saved ✓" when nothing was saved', !said.some((m) => /Saved ✓/.test(m)), JSON.stringify(said));
    ok('...and the chip still says UNSAVED', /UNSAVED/i.test(await chip()), await chip());
    await page.evaluate(() => { Storage.prototype.setItem = window.__realSet; });
    await page.evaluate(() => saveNow());
    ok('control: once storage has room, SAVE saves it and the chip says SAVED', /SAVED/i.test(await chip()) && !/UNSAVED/i.test(await chip()) && await page.evaluate(() => JSON.parse(localStorage.getItem('nbd_dsp_v1')).some((p) => p.data && p.data['l-win'] === 'lost win')), await chip());
    await ctx.close();
  } finally { await browser.close(); if (srv.close) srv.close(); }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });

function finish() { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); }
