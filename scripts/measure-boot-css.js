#!/usr/bin/env node
// Which dashboard stylesheets style anything at boot? (boot CSS, 2026-11-06)
//
// Boots the real dashboard on the sample account (/pro/explore: demo service
// worker, nothing leaves 127.0.0.1) once per layout at phone and desktop width,
// with Chrome's CSS rule-usage tracking on from the reload until the page has
// settled, and lists every stylesheet with no rule used. Exits 1 when a sheet
// marked data-late-css in dashboard.html IS used at boot (it would paint
// unstyled until late-css.js applies it).
//
//   node scripts/measure-boot-css.js [--layouts classic,crew] [--json out.json]
//
// Needs Playwright (tests/node_modules). PLAYWRIGHT_CHROMIUM_PATH picks a
// pre-installed Chromium. The empty-tenant role matrix (owner, manager, sales
// rep, viewer) runs in the emulator rig instead: documentation/audit/BOOT-CSS-2026-11-06.md.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rq = require('module').createRequire(path.join(ROOT, 'tests', 'package.json'));
const { chromium } = rq('playwright');
const { start } = require(path.join(ROOT, 'tests', 'lib', 'demo-hosting-server'));

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const LAYOUTS = (arg('--layouts') || 'classic,field,focus,mission,bento,crew,island,inbox').split(',');
const JSON_OUT = arg('--json');
const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;

(async () => {
  const srv = await start();
  const ORIGIN = srv.origin;
  const launch = process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {};
  const browser = await chromium.launch(launch);
  const used = {};
  const seen = new Set();
  let runs = 0;
  for (const layout of LAYOUTS) {
    for (const width of ['phone', 'desktop']) {
      const phone = width === 'phone';
      const ctx = await browser.newContext(Object.assign({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, serviceWorkers: 'allow',
      }, phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
      await ctx.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(ORIGIN + '/')) return route.continue();
        if (FONT_HOST.test(u)) return route.fulfill({ status: 200, contentType: /googleapis/.test(u) ? 'text/css' : 'font/woff2', body: '' });
        return route.abort('blockedbyclient');
      });
      await ctx.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) { /* private mode */ } });
      // Measure every late sheet as if it were eager (a media="print" sheet can never show a used rule): strip the
      // attribute as each <link> is parsed, and keep late-css.js out of it (no idle, no input).
      await ctx.addInitScript(() => {
        window.requestIdleCallback = function () { return 0; };
        new MutationObserver((recs) => recs.forEach((r) => r.addedNodes.forEach((n) => {
          if (n.tagName === 'LINK' && n.hasAttribute('data-late-css')) n.removeAttribute('media');
        }))).observe(document, { childList: true, subtree: true });
      });
      const page = await ctx.newPage();
      await page.goto(ORIGIN + '/pro/explore');
      await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 30000 });
      await page.waitForFunction(() => window.LayoutEngine && window.LayoutEngine.prefs().hydrated === true, null, { timeout: 40000 });
      await page.evaluate((id) => window.LayoutEngine.saveUser({ id, device: window.LayoutEngine.surface() }), layout);
      await page.waitForTimeout(1000);
      const cdp = await ctx.newCDPSession(page);
      const sheets = new Map();
      cdp.on('CSS.styleSheetAdded', ({ header }) => sheets.set(header.styleSheetId, header));
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      await cdp.send('CSS.startRuleUsageTracking');
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window._leadsLoaded === true, null, { timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const got = await page.evaluate(() => document.documentElement.getAttribute('data-layout'));
      const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');
      const key = (u) => new URL(u).pathname.replace(/^\/pro\/explore\//, '/pro/');
      for (const h of sheets.values()) if (h.sourceURL && h.sourceURL.startsWith(ORIGIN) && !h.isInline) seen.add(key(h.sourceURL));
      for (const r of ruleUsage) {
        if (!r.used) continue;
        const h = sheets.get(r.styleSheetId);
        if (!h || !h.sourceURL || !h.sourceURL.startsWith(ORIGIN) || h.isInline) continue;
        (used[key(h.sourceURL)] = used[key(h.sourceURL)] || new Set()).add(got + '/' + width);
      }
      runs++;
      console.log(`  ${layout} -> ${got} ${width}: ${Object.keys(used).length} sheets used so far`);
      await ctx.close();
    }
  }
  await browser.close();
  await srv.close();

  const html = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  const late = [...html.matchAll(/<link\b[^>]*\bdata-late-css\b[^>]*\bhref="css\/([\w-]+)\.css/g)].map((m) => '/pro/css/' + m[1] + '.css');
  const never = [...seen].filter((s) => !used[s]).sort();
  const lateUsed = late.filter((s) => used[s]);
  console.log(`\n${runs} boots; ${seen.size} stylesheets loaded, ${Object.keys(used).length} used at boot, ${never.length} never:`);
  never.forEach((s) => console.log('  ' + s + (late.includes(s) ? '  (late)' : '')));
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ runs, used: Object.fromEntries(Object.entries(used).map(([k, v]) => [k, [...v]])), never, late }, null, 1));
  if (lateUsed.length) {
    console.log('\nFAIL: marked data-late-css but used at boot:');
    lateUsed.forEach((s) => console.log('  ' + s + ' (' + [...used[s]].join(', ') + ')'));
    process.exit(1);
  }
  console.log(`\nok: none of the ${late.length} data-late-css sheets is used at boot`);
})().catch((e) => { console.error(e); process.exit(1); });
