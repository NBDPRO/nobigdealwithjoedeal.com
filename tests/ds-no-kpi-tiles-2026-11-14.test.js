/**
 * tests/ds-no-kpi-tiles-2026-11-14.test.js
 *
 * Audit 2026-11-14 #7, Joe's decision (2026-11-14): remove the door / close / revenue tiles from Daily Success; the CRM
 * already tracks those. Nothing in the tracker could enter them (no writer for page.kpi or s-revenue), so the tiles
 * only ever read 0. Removed: the Dash's "Door stats" switch, Activity Totals, Best Door / Revenue Day, Door Streak,
 * Monthly Goals, Revenue Pace (and the North Star's revenue pace, fed by the same never-set goal), the three charts and
 * the per-page "Doors · Closes · Rev" line, plus code nothing called (buildDailyComparison, KPI_DEF, autoCheckFloors).
 * Stored pages keep their kpi / s-revenue fields untouched, and the CSV export still carries them.
 *
 * Run: cd tests && node ds-no-kpi-tiles-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const APP = fs.readFileSync(path.join(DS, 'js', 'app.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const dkOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = dkOf(new Date()), YDAY = dkOf(new Date(Date.now() - 86400000));
// an old page that DOES carry sales numbers (from before), so the tiles would have shown
const mk = (id, dk, kpi, rev) => ({ id, dk, suf: 1, name: '', data: Object.assign({ 'l-win': 'win ' + id }, rev ? { 's-revenue': String(rev) } : {}), kpi, exercises: [], objections: [], commissions: [] });

(async () => {
  console.log('\n1. the code is gone');
  ok('nothing left that only fed the tiles', !/function buildDailyComparison\b|const KPI_DEF\b|function autoCheckFloors\b|KPI_FLOOR_KEYWORDS|function getDoorTarget\b|function toggleSales\b|toggle-sales|_dsShowSales|salesVisible/.test(APP));
  ok('control: the stored-page shape is still written (old pages and the CSV keep their fields)', /kpi:\{doors:0,contacts:0,appts:0,closes:0,noshow:0\}/.test(APP) && /'Doors','Contacts','Appts','Closes','No-Shows','Revenue'/.test(APP));

  console.log('\n2. the Dash, with old sales data stored and the old switch left on');
  const srv = await start({ root: path.join(__dirname, '..', 'docs') });
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 900 } })).newPage();
    page.setDefaultTimeout(30000);
    const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    const pages = [mk(1.5, YDAY, { doors: 55, contacts: 20, appts: 3, closes: 1, noshow: 0 }, 4200), mk(2.5, TODAY, { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 })];
    await page.addInitScript((p) => {
      if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); localStorage.setItem('nbd_dsp_v1', JSON.stringify(p)); localStorage.setItem('nbd_ds_show_sales', '1'); localStorage.setItem('nbd_gt', JSON.stringify({ d: 1000, r: 50000, c: 10 })); }
      localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic');
    }, pages);
    await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof switchTo === 'function' && pages.length > 0);
    await page.evaluate(() => switchTo(-1));
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => document.getElementById('main').innerText);
    const gone = ['Door stats', 'Activity Totals', 'Best Door Day', 'Best Revenue Day', 'Door Streak', 'Monthly Goals', 'Revenue Pace', 'Doors Knocked', 'Doors: 55'];
    ok('none of the sales tiles show: ' + gone.join(', '), gone.every((t) => !text.includes(t)), gone.filter((t) => text.includes(t)).join(' | '));
    ok('no sales charts', await page.evaluate(() => !document.querySelector('#c-doors, #c-rev, #c-close')));
    ok('control: the Dash still draws (Workout Streak, Win Streak, Daily Floors, All Pages)', /Workout Streak/.test(text) && /Win Streak/.test(text) && /Daily Floors/i.test(text) && /All Pages/i.test(text), text.slice(0, 300));
    ok('no page errors', errs.length === 0, errs.join(' | '));

    await page.evaluate(() => switchTo(pages.findIndex((p) => p.dk === todayKey())));
    await page.waitForTimeout(300);
    const dayText = await page.evaluate(() => document.getElementById('main').innerText);
    ok('the day page has no "Today vs Yesterday" doors / closes / revenue panel', !/TODAY VS YESTERDAY/i.test(dayText) && !(await page.evaluate(() => !!document.getElementById('comparison-wrap'))), dayText.slice(0, 200));
    ok('control: the day page still draws its floor score', /Floor Score/i.test(dayText), dayText.slice(0, 200));
    ok('no page errors on the day page', errs.length === 0, errs.join(' | '));

    console.log('\n3. stored pages are not broken');
    await page.evaluate(() => { switchTo(pages.findIndex((p) => p.dk !== todayKey())); const el = document.querySelector('#main [data-k="l-win"]'); el.value = 'edited'; el.dispatchEvent(new Event('input', { bubbles: true })); flushDirty(); });
    const kept = await page.evaluate((dk) => { const p = JSON.parse(localStorage.getItem('nbd_dsp_v1')).find((x) => x.dk === dk); return { kpi: p.kpi, rev: p.data['s-revenue'], win: p.data['l-win'] }; }, YDAY);
    ok('an old page edited and saved keeps its kpi and revenue fields', kept.win === 'edited' && kept.kpi && kept.kpi.doors === 55 && kept.rev === '4200', JSON.stringify(kept));
    // exportCSV builds a data: link and clicks it; catch the href instead of downloading
    const csv = await page.evaluate(() => { let out = ''; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__csv = decodeURIComponent(String(this.href).replace(/^data:text\/csv;charset=utf-8,/, '')); }; try { exportCSV(); } catch (e) { out = String(e); } HTMLAnchorElement.prototype.click = click; return out; });
    const csvText = await page.evaluate(() => window.__csv || '');
    ok('the CSV export still carries the stored numbers', !csv && /"55"/.test(csvText) && /"4200"/.test(csvText), csv || csvText.slice(0, 160));
  } finally { await browser.close(); if (srv.close) srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
