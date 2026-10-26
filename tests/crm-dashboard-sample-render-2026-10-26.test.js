/* tests/crm-dashboard-sample-render-2026-10-26.test.js
 *
 * Overnight pass 2026-10-26, cluster "CRM dashboard: weekly activity tiles
 * populate, Door-to-Door tabs fit on phones, sample estimates use the real
 * field shape" — the PAINTED half (the dependency-free half is
 * tests/crm-dashboard-sample-data-2026-10-26.test.js). Real Chromium on the
 * real /pro/explore sample account, served by tests/lib/demo-hosting-server.js
 * with firebase.json's own rewrites; no network, no auth. Runs in the "Pro demo
 * zero-network walk (Chromium)" CI job.
 *
 *   1. crm-2  First visit to Dashboard (the sample boots on Today): the "This
 *      Week" tiles read the week's leads / estimates / pipeline, not 0 / 0 / $0.
 *      calculateWeeklyStats() lived inside an ES module, so nothing outside it
 *      could call it and the tiles stayed 0 until the next lead load.
 *   2. crm-7  Estimates: every card shows its address and squares (not "No
 *      address · — · — SQ"), the status band counts sent and signed, a close
 *      rate and an average ticket; Reports' avg ticket and funnel agree.
 *   3. crm-4  Door-to-Door tabs at 320 / 360 / 390 / 430 px: each tab's label
 *      stays inside its own tab (it printed "CHALLE📊 GESTATS" over its
 *      neighbours), and the desktop tabs are unchanged.
 *
 * Locally it SKIPS when playwright is not resolvable; under CI=true that is
 * a failure.   Run: cd tests && node crm-dashboard-sample-render-2026-10-26.test.js
 */
'use strict';

const { start } = require('./lib/demo-hosting-server');

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 1200) : '')); }
}
function report() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
}

const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) {
    if (process.env.CI) { ok('playwright is installed (required in CI)', false); return report(); }
    console.log('  ! playwright unavailable — SKIPPED'); return report();
  }

  const srv = await start();
  const ORIGIN = srv.origin;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
    await ctx.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN + '/')) return route.continue();
      if (FONT_HOST.test(u)) {
        const css = /fonts\.googleapis\.com/.test(u);
        return route.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: css ? '/* hermetic */' : '' });
      }
      return route.abort('blockedbyclient');
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));

    await page.goto(ORIGIN + '/pro/explore');
    await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 40000 });
    await page.waitForFunction(() => Array.isArray(window._leads) && window._leads.length >= 20 && Array.isArray(window._estimates) && window._estimates.length >= 4 && typeof window.goTo === 'function', null, { timeout: 40000, polling: 200 });
    await page.waitForTimeout(800);

    // ── 1. the This Week tiles on a first visit ─────────────────────────
    console.log('1. Dashboard, first visit: the "This Week" tiles (crm-2)');
    ok('calculateWeeklyStats is reachable from outside its module (dashboard-widgets.js tests typeof)', await page.evaluate(() => typeof window.calculateWeeklyStats === 'function'));
    await page.evaluate(() => window.goTo('dash'));
    await page.waitForFunction(() => { const el = document.getElementById('weekNewLeads'); return !!el && el.textContent.trim() !== '0'; }, null, { timeout: 5000, polling: 100 }).catch(() => {});
    const week = await page.evaluate(() => {
      const num = (t) => Number(String(t || '').replace(/[^0-9.]/g, ''));
      const ms = (t) => (t && t.toMillis ? t.toMillis() : t && t.toDate ? t.toDate().getTime() : t ? new Date(t).getTime() : 0);
      const within = (list, days) => (list || []).filter((x) => ms(x.createdAt) >= Date.now() - days * 86400000).length;
      const txt = (id) => (document.getElementById(id) || {}).textContent;
      return {
        leads: num(txt('weekNewLeads')), ests: num(txt('weekEstimates')), rev: txt('weekRevenue'), revN: num(txt('weekRevenue')), tasks: txt('weekTasks'),
        leads6: within(window._leads, 6), leads8: within(window._leads, 8), ests6: within(window._estimates, 6), ests8: within(window._estimates, 8)
      };
    });
    ok('New Leads this week is the number of leads created in the last 7 days, not 0 (between the 6-day and 8-day counts)', week.leads > 0 && week.leads >= week.leads6 && week.leads <= week.leads8, JSON.stringify(week));
    ok('Estimates Created this week is the number created in the last 7 days, not 0', week.ests > 0 && week.ests >= week.ests6 && week.ests <= week.ests8, JSON.stringify(week));
    ok('Pipeline Added is dollars, not $0', /^\$/.test(week.rev || '') && week.revN > 0, week.rev);
    ok('Tasks Completed is a number', /^\d+$/.test(String(week.tasks || '').trim()), week.tasks);

    // ── 2. the Estimates view and Reports ───────────────────────────────
    console.log('2. Estimates + Reports on the sample estimates (crm-7)');
    await page.evaluate(() => window.goTo('est'));
    await page.waitForSelector('.nbd-est-card .est-card-meta', { timeout: 15000 });
    await page.waitForFunction(() => /draft/.test((document.getElementById('estStats') || {}).innerText || ''), null, { timeout: 10000 }).catch(() => {});
    const est = await page.evaluate(() => ({
      metas: [...document.querySelectorAll('.nbd-est-card .est-card-meta')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
      band: (document.getElementById('estStats') || {}).innerText || ''
    }));
    ok('there are four estimate cards', est.metas.length === 4, JSON.stringify(est.metas));
    ok('no card reads "No address"', est.metas.every((m) => !/No address/.test(m)), est.metas.join(' | '));
    ok('every card shows its squares (not "— SQ")', est.metas.every((m) => /\d+(\.\d+)? SQ/.test(m)), est.metas.join(' | '));
    ok('every card shows a roof type and a package (no "—" placeholders)', est.metas.every((m) => !/ — /.test(m) && !/—$/.test(m)), est.metas.join(' | '));
    const counts = /(\d+) draft · (\d+) sent · (\d+) signed/.exec(est.band);
    ok('the status band counts 3 sent and 1 signed', !!counts && counts[2] === '3' && counts[3] === '1', est.band.replace(/\s+/g, ' '));
    ok('the band has a close rate, not "—"', /CLOSE RATE\s+\d+%/i.test(est.band), est.band.replace(/\s+/g, ' '));
    ok('the band has an average ticket, not $0', /AVG TICKET\s+\$(?!0\b)[\d.,]+k?/i.test(est.band), est.band.replace(/\s+/g, ' '));

    await page.evaluate(() => window.goTo('reports'));
    await page.waitForFunction(() => /CONVERSION FUNNEL/i.test((document.getElementById('view-reports') || {}).innerText || ''), null, { timeout: 20000 });
    const rep = await page.evaluate(() => (document.getElementById('view-reports') || {}).innerText || '');
    const sent = /Estimate sent\s+(\d+)/i.exec(rep);
    ok('the Reports funnel counts estimates sent (not "Estimate sent 0") beside the close rate', !!sent && Number(sent[1]) > 0 && /CLOSE RATE\s+\d+%/i.test(rep), rep.replace(/\s+/g, ' ').slice(0, 500));
    ok('Reports shows an average ticket, not $0', /AVG TICKET\s+\$(?!0\b)[\d.,]+k?/i.test(rep), rep.replace(/\s+/g, ' ').slice(0, 500));

    // ── 3. the Door-to-Door tabs on a phone ─────────────────────────────
    console.log('3. Door-to-Door tabs: each label stays inside its own tab (crm-4)');
    await page.evaluate(() => window.goTo('d2d'));
    await page.waitForSelector('.dk-tabs .dk-tab', { timeout: 25000 });
    const measure = () => page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.dk-tabs .dk-tab')];
      const rows = tabs.map((b) => {
        const rg = document.createRange(); rg.selectNodeContents(b);
        const t = rg.getBoundingClientRect(); const r = b.getBoundingClientRect();
        return { label: b.textContent.trim(), left: r.left, right: r.right, tl: t.left, tr: t.right, fs: getComputedStyle(b).fontSize, h: r.height };
      });
      return rows;
    });
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(250);
      const rows = await measure();
      const out = rows.filter((x) => x.tl < x.left - 0.5 || x.tr > x.right + 0.5).map((x) => x.label + ' text ' + Math.round(x.tl) + '..' + Math.round(x.tr) + ' in tab ' + Math.round(x.left) + '..' + Math.round(x.right));
      ok(w + ' px: four tabs, every label inside its own tab', rows.length === 4 && out.length === 0, out.join('; ') || rows.length);
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(250);
    const wide = await measure();
    ok('1200 px: the desktop tabs keep their 13px type on one line', wide.length === 4 && wide.every((x) => x.fs === '13px' && x.h < 50), JSON.stringify(wide.map((x) => [x.fs, x.h])));

    ok('no page error mentions the weekly stats or the tabs', pageErrors.every((m) => !/calculateWeeklyStats|dk-tab/.test(m)), pageErrors.join(' | '));
  } finally {
    await browser.close();
    await srv.close();
  }
  report();
})().catch((e) => { console.error(e); process.exit(1); });
