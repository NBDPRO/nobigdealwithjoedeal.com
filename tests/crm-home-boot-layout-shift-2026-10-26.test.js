/* tests/crm-home-boot-layout-shift-2026-10-26.test.js
 *
 * Overnight pass 2026-10-26, cluster "CRM Home (Today): stop the 3 to 6 reflows
 * while it boots" (perf-1). The Home screen used to build itself in front of
 * you: a "Today / Loading your day" card, a Next stop card inserted above it,
 * the header collapsing to one row, a storm warning inserted above that, and
 * the real list growing from 211px to 1800px and shoving every card under it off
 * the screen. Cumulative layout shift was 1.4 to 1.6 on a phone and 0.4 to 0.6
 * on a desktop.
 *
 * Real Chromium on the real /pro/explore sample account (tests/lib/demo-hosting-
 * server.js serves docs/ with firebase.json's own rewrites; no network, no
 * auth). Runs in the "Pro demo zero-network walk (Chromium)" CI job.
 *
 *   1. Phone (412x823, the loaded state: Today rows, the Next stop card and the
 *      sample storm warning on screen): the layout-shift sum of the whole boot
 *      stays under 0.1, and the boot hold behaves: while Home is held nothing
 *      but the header and one placeholder card is on screen, the placeholder is
 *      swapped for the list in one frame, and the Next stop card and the storm
 *      strip are already there when the list shows.
 *   2. Desktop (1280x800): the same sum stays under 0.1.
 *   3. A Home whose list never becomes ready (the leads never finish loading) is
 *      held for a while and then released: Home can never stay bare.
 *
 * Locally it SKIPS when playwright is not resolvable; under CI=true that is a
 * failure. The static section (0) reads the readable source like every grep-shaped
 * test, so CI runs this file on the readable tree only; the browser sections also
 * pass on the minified build (checked 2026-10-26: 0.058 phone, 0.019 desktop).
 *   Run: cd tests && node crm-home-boot-layout-shift-2026-10-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { start } = require('./lib/demo-hosting-server');

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 1500) : '')); }
}
function report() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const CLS_BUDGET = 0.1;

// Installed before any page script: every layout shift, and one sample per animation frame of what
// is on screen (a box with client rects), so "a card showed while Home was held" is a fact.
const INIT = `
window.__cls = [];
window.__frames = [];
try {
  new PerformanceObserver(function (l) {
    l.getEntries().forEach(function (e) {
      if (e.hadRecentInput) return;
      window.__cls.push({ t: Math.round(e.startTime), v: e.value, n: (e.sources || []).map(function (s) { return s.node ? (s.node.id || s.node.className || s.node.tagName) : '?'; }).join(',') });
    });
  }).observe({ type: 'layout-shift', buffered: true });
} catch (_) {}
(function () {
  var shown = function (sel) { var e = document.querySelector(sel); return !!e && e.getClientRects().length > 0; };
  var tick = function () {
    window.__frames.push({
      t: Math.round(performance.now()),
      held: !!document.querySelector('.view-scroll.tp-booting'),
      skel: shown('#todayPlanSkel'), list: shown('#todayPlan'), next: shown('#homeNextStop'), storm: shown('#homeStorm'),
      closes: shown('#homeClosesWeek'), game: shown('#homeGameCard'), more: shown('#view-home .home-more'), widgets: shown('#widgetGrid')
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function openSample(browser, origin, ctxOpts, init) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'allow', reducedMotion: 'reduce' }, ctxOpts));
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(origin + '/')) return route.continue();
    if (FONT_HOST.test(u)) {
      const css = /fonts\.googleapis\.com/.test(u);
      return route.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: css ? '/* hermetic */' : '' });
    }
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));
  await page.addInitScript(INIT + (init || ''));
  await page.goto(origin + '/pro/explore');
  await page.waitForURL(origin + '/pro/explore/dashboard', { timeout: 40000 });
  return { ctx, page, pageErrors };
}

// The loaded state: the Today list has its rows, the hold is over, and the late "Needs you" strip had its say.
async function untilLoaded(page) {
  await page.waitForFunction(() => {
    const tp = document.getElementById('todayPlan');
    return Array.isArray(window._leads) && window._leads.length >= 20 && !!tp && tp.getAttribute('data-tp-state') === 'ready'
      && !document.querySelector('.view-scroll.tp-booting') && !!document.querySelector('#homeNextStop .ns-card');
  }, null, { timeout: 40000, polling: 100 });
  await page.waitForFunction(() => { const a = document.getElementById('homeAttention'); return !!a && !a.hidden && a.getClientRects().length > 0; }, null, { timeout: 8000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(1500);
}

const sumOf = (list) => list.reduce((a, x) => a + x.v, 0);
const describe = (list) => list.map((x) => x.t + 'ms ' + x.v.toFixed(3) + ' ' + x.n).join(' | ');

(async () => {
  // ── static shape of the hold (what the browser run below depends on) ─────
  console.log('0. the boot hold is shipped as one piece');
  const dash = read('docs/pro/dashboard.html');
  const home = (/<template id="tpl-view-home">([\s\S]*?)<\/template>/.exec(dash) || [])[1] || '';
  ok('the Home template starts held (tp-booting) with the welcome block already on its phone shape (tp-has-rows)', /<div class="view-scroll tp-has-rows tp-booting">/.test(home));
  ok('the template carries the placeholder card the hold shows', /<section class="tp tp-skel" id="todayPlanSkel"[^>]*>[\s\S]*?Loading your day/.test(home));
  const css = read('docs/pro/css/today-home.css');
  ok('today-home.css holds the strips, the list and everything after it while tp-booting', /\.view-scroll\.tp-booting > :is\(#awayStatus,#homeStorm,#homeNextStop,#homeDocExpiry,#homeAttention,#todayPlan,#homeClosesWeek,#homeGameCard,#homePixelParty,\.home-more\)/.test(css) && /\.view-scroll\.tp-booting > #todayPlan ~ \*\{display:none !important;\}/.test(css));
  const js = read('docs/pro/js/today-home.js');
  ok('today-home.js releases the hold when the list is ready, bounded twice (strip wait after ready, cap after boot)', /HOLD_MAX_MS = \d+, STRIP_WAIT_MS = \d+/.test(js) && /function holdCheck\(\)/.test(js));
  ok('the storm strip says whether its read has answered (settled), for the hold to wait on', /settled: function \(\) \{ return warnings !== undefined; \}/.test(read('docs/pro/js/storm-strip.js')));

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) {
    if (process.env.CI) { ok('playwright is installed (required in CI)', false); return report(); }
    console.log('  ! playwright unavailable - browser half SKIPPED'); return report();
  }

  const srv = await start();
  const ORIGIN = srv.origin;
  const browser = await chromium.launch();
  try {
    // ── 1. phone ───────────────────────────────────────────────────────────
    console.log('1. phone (412x823): the boot does not reflow');
    {
      const { ctx, page, pageErrors } = await openSample(browser, ORIGIN, { viewport: { width: 412, height: 823 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await untilLoaded(page);
      const r = await page.evaluate(() => ({
        cls: window.__cls, frames: window.__frames,
        rows: document.querySelectorAll('#todayPlan [data-tp-row]').length,
        total: Number((document.querySelector('#todayPlan [data-tp-total]') || { getAttribute: () => 0 }).getAttribute('data-tp-total')),
        storm: !!document.querySelector('#homeStorm .ss-card') && document.getElementById('homeStorm').getClientRects().length > 0,
        next: !!document.querySelector('#homeNextStop .ns-card') && document.getElementById('homeNextStop').getClientRects().length > 0,
        skelShown: !!document.getElementById('todayPlanSkel') && document.getElementById('todayPlanSkel').getClientRects().length > 0,
        scrollCls: document.querySelector('#view-home .view-scroll').className
      }));
      const sum = sumOf(r.cls);
      console.log('     layout-shift sum ' + sum.toFixed(3) + ' over ' + r.cls.length + ' shifts: ' + describe(r.cls));
      ok('the loaded state is real: the Today list has rows, the Next stop card and the storm warning are on screen', r.rows > 0 && r.total > 0 && r.next && r.storm, JSON.stringify({ rows: r.rows, total: r.total, next: r.next, storm: r.storm }));
      ok('the loaded Home is not held, shows no placeholder, and keeps its phone header shape', !/tp-booting/.test(r.scrollCls) && /tp-has-rows/.test(r.scrollCls) && !r.skelShown, r.scrollCls);
      ok('the whole boot shifts less than ' + CLS_BUDGET + ' (it was 1.4 to 1.6)', sum < CLS_BUDGET, sum.toFixed(3) + ': ' + describe(r.cls));

      const held = r.frames.filter((f) => f.held);
      const heldWithCards = held.filter((f) => f.list || f.next || f.storm || f.closes || f.game || f.more || f.widgets);
      ok('while Home is held none of the strips, the list or the cards below it is on screen', held.length > 0 && heldWithCards.length === 0, 'held frames ' + held.length + ', with cards ' + JSON.stringify(heldWithCards.slice(0, 2)));
      ok('the placeholder card shows while held and never beside the real list', held.every((f) => f.skel) && r.frames.every((f) => !(f.skel && f.list)), 'frames ' + r.frames.length);
      const firstList = r.frames.find((f) => f.list);
      ok('in the first frame the list shows, the Next stop card and the storm strip are already there (they do not arrive after it and push it down)', !!firstList && firstList.next && firstList.storm && !firstList.held, JSON.stringify(firstList));
      ok('no page error', pageErrors.length === 0, pageErrors.join(' | '));
      await ctx.close();
    }

    // ── 2. desktop ─────────────────────────────────────────────────────────
    console.log('2. desktop (1280x800): the boot does not reflow');
    {
      const { ctx, page, pageErrors } = await openSample(browser, ORIGIN, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
      await untilLoaded(page);
      const r = await page.evaluate(() => ({ cls: window.__cls, frames: window.__frames }));
      const sum = sumOf(r.cls);
      console.log('     layout-shift sum ' + sum.toFixed(3) + ' over ' + r.cls.length + ' shifts: ' + describe(r.cls));
      ok('the whole boot shifts less than ' + CLS_BUDGET + ' (it was 0.4 to 0.6)', sum < CLS_BUDGET, sum.toFixed(3) + ': ' + describe(r.cls));
      const heldWithCards = r.frames.filter((f) => f.held && (f.list || f.next || f.storm || f.closes || f.game || f.more || f.widgets));
      ok('while Home is held none of the widgets or cards under the list is on screen', heldWithCards.length === 0, JSON.stringify(heldWithCards.slice(0, 2)));
      ok('no page error', pageErrors.length === 0, pageErrors.join(' | '));
      await ctx.close();
    }

    // ── 3. a list that never becomes ready ────────────────────────────────
    console.log('3. the leads never finish loading: Home is held, then released (never bare)');
    {
      const never = 'Object.defineProperty(window, "_leadsLoaded", { configurable: true, get: function () { return false; }, set: function () {} });';
      const { ctx, page } = await openSample(browser, ORIGIN, { viewport: { width: 412, height: 823 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, never);
      await page.waitForSelector('#todayPlan', { state: 'attached', timeout: 20000 });
      await page.waitForTimeout(3000);
      const early = await page.evaluate(() => ({ held: !!document.querySelector('.view-scroll.tp-booting'), skel: !!document.getElementById('todayPlanSkel') && document.getElementById('todayPlanSkel').getClientRects().length > 0 }));
      ok('3 s in, with no list, Home is still held and shows its placeholder', early.held && early.skel, JSON.stringify(early));
      await page.waitForFunction(() => !document.querySelector('.view-scroll.tp-booting'), null, { timeout: 20000, polling: 250 }).catch(() => {});
      const late = await page.evaluate(() => {
        const shown = (el) => !!el && el.getClientRects().length > 0;
        const tp = document.getElementById('todayPlan');
        return {
          held: !!document.querySelector('.view-scroll.tp-booting'),
          skel: shown(document.getElementById('todayPlanSkel')),
          list: shown(tp), state: tp && tp.getAttribute('data-tp-state'),
          more: shown(document.querySelector('#view-home .home-more'))
        };
      });
      ok('after the cap the hold is released: the Today card (still loading) and the More on Home toggle are on screen, the placeholder is gone', !late.held && !late.skel && late.list && late.state === 'loading' && late.more, JSON.stringify(late));
      await ctx.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  report();
})();
