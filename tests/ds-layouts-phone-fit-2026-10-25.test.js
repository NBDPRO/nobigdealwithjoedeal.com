/**
 * tests/ds-layouts-phone-fit-2026-10-25.test.js
 *
 * The interfaces brief's gate: every Daily Success layout x every theme renders the day page at 320 px (and the default theme at
 * 390 px) with no sideways scroll, no page error, a Today bar that painted, and every control in that bar at least 44 px tall
 * (gym thumbs). Real Chromium on the hosting server the other Chromium suites use; no network, no auth. Runs in the
 * "Pro demo zero-network walk (Chromium)" CI job.
 *
 * Run: cd tests && node ds-layouts-phone-fit-2026-10-25.test.js
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'layout-logic.js'));
const THEMES = ['default', 'light', 'paper', 'contrast', 'midnight', 'forest', 'ocean', 'ember', 'graphite', 'terminal'];

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

(async () => {
  const srv = await start({ root: path.join(ROOT, 'docs') });
  const browser = await chromium.launch();
  const layouts = L.LAYOUTS.filter((l) => l.ready).map((l) => l.id);
  ok('control: the whole lineup is ready (' + layouts.length + ' layouts)', layouts.length === L.LAYOUTS.length && layouts.length >= 8, layouts.join());
  const dk = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const combos = [];
  for (const ui of layouts) { for (const theme of THEMES) combos.push({ ui, theme, w: 320 }); combos.push({ ui, theme: 'default', w: 390 }); }
  const bad = [];
  for (const c of combos) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: 760 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
    await page.addInitScript(({ ui, theme, dk }) => {
      localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none');
      localStorage.setItem('nbd_ds_layout', ui); localStorage.setItem('nbd_pro_theme', theme);
      localStorage.setItem('nbd_ds_workouts', JSON.stringify([{ id: 's1', date: dk, split: 'push', startedAt: 1, finishedAt: 2, exercises: [{ exId: 'bb_bench', name: 'Bench press', slot: 0, sets: [{ weight: 135, reps: 8, rpe: 8, done: true }] }] }]));
      localStorage.setItem('nbd_dsp_v1', JSON.stringify([{ id: 1.5, dk, suf: 1, name: '', data: { 'journal-intention': 'Ship it', 'ms-cal': '1,240' }, kpi: { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 }, exercises: [], objections: [], commissions: [] }]));
    }, { ui: c.ui, theme: c.theme, dk });
    await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof switchTo === 'function' && document.getElementById('tabrow') && document.getElementById('tabrow').children.length > 0, null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { try { switchTo(0); } catch (_) {} });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const bar = document.getElementById('today-bar');
      const controls = bar ? [...bar.querySelectorAll('button, input, textarea, [role="button"]')].filter((el) => el.offsetParent !== null) : [];
      const short = controls.filter((el) => el.getBoundingClientRect().height < 44).map((el) => (el.className || el.tagName) + ':' + Math.round(el.getBoundingClientRect().height));
      return { ui: document.documentElement.getAttribute('data-ui'), theme: document.documentElement.getAttribute('data-theme'), sw: document.documentElement.scrollWidth, painted: !!bar && bar.innerHTML.trim().length > 0 && bar.getBoundingClientRect().height > 0, short };
    });
    const problems = [];
    if (r.ui !== c.ui) problems.push('layout not applied (' + r.ui + ')');
    if (r.theme !== c.theme) problems.push('theme not applied (' + r.theme + ')');
    if (r.sw > c.w) problems.push('scrolls sideways: ' + r.sw + ' > ' + c.w);
    if (!r.painted) problems.push('Today bar empty');
    if (r.short.length) problems.push('short controls: ' + r.short.join(', '));
    if (errs.length) problems.push('page errors: ' + errs.join(' | '));
    if (problems.length) bad.push(c.ui + ' x ' + c.theme + ' @ ' + c.w + ': ' + problems.join('; '));
    // the dashboard (cur = -1) in the same layout and theme: it must not scroll sideways either
    if (c.theme === 'default') {
      await page.evaluate(() => { try { switchTo(-1); } catch (_) {} });
      await page.waitForTimeout(150);
      const d = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, dash: !!document.querySelector('.dhero') }));
      if (d.sw > c.w || !d.dash || errs.length) bad.push(c.ui + ' dashboard @ ' + c.w + ': ' + (d.sw > c.w ? 'scrolls sideways ' + d.sw : !d.dash ? 'no dashboard' : 'page errors ' + errs.join(' | ')));
    }
    await ctx.close();
  }
  ok(combos.length + ' layout x theme x width renders (plus each layout\'s dashboard at both widths): no sideways scroll, the Today bar painted, every bar control 44 px, no page errors', bad.length === 0, bad.join('\n      '));
  await browser.close(); await srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
