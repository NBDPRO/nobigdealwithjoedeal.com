/**
 * tests/ds-quick-wins-2026-11-09.test.js
 *
 * The decision-free Tier 1 quick wins from documentation/qa/daily-success-ux-audit-2026-11-09.md, proven in real Chromium on the
 * hosting server the other Chromium suites use (no network, no auth):
 *   Q3  save on the way out (a debounced save after an edit, plus visibilitychange / pagehide)
 *   Q4  failures read as failures (toastErr -> the red toast; no failure message goes through the green one)
 *   Q5  the Dashboard's DELETE / rename buttons do not crash or do nothing silently
 *   Q6  safe-area padding on the header and the content, the sync pill positioned by a class
 *   Q9  the Today bar, Rings and Cockpit numbers are buttons that go to the thing they show
 *   Q10 a search hit lands on the match; scroll position is kept per view across tab switches and a background refresh
 *   Q13 the two streaks are named "Training streak" and "Floor streak"
 * (Q2, the 16 px phone inputs, is asserted in ds-layouts-phone-fit-2026-10-25.test.js.)
 * Saved-page data keys are unchanged: the fixtures below use the shipped keys (nbd_dsp_v1, fit-focus, floormet-*).
 *
 * Run: cd tests && node ds-quick-wins-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');
const ROOT = path.join(__dirname, '..');
const DS = path.join(ROOT, 'docs', 'pro', 'daily-success');
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const dkOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = dkOf(new Date());
const YDAY = dkOf(new Date(Date.now() - 86400000));
const mkPage = (id, dk, data) => ({ id, dk, suf: 1, name: '', data: data || {}, kpi: { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 }, exercises: [], objections: [], commissions: [] });

async function open(browser, srv, opt) {
  const o = Object.assign({ w: 390, ui: 'classic', pages: null, extra: {} }, opt || {});
  const ctx = await browser.newContext({ viewport: { width: o.w, height: 760 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  const pages = o.pages || [mkPage(1.5, TODAY, { 'fit-focus': 'Push day' }), mkPage(2.5, YDAY, { 'fit-focus': 'zebra stripes at dawn' })];
  await page.addInitScript(({ ui, pages, extra }) => {
    localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none');
    localStorage.setItem('nbd_ds_layout', ui);
    localStorage.setItem('nbd_dsp_v1', JSON.stringify(pages));
    Object.keys(extra).forEach((k) => localStorage.setItem(k, extra[k]));
  }, { ui: o.ui, pages, extra: o.extra });
  await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof switchTo === 'function' && document.getElementById('tabrow') && document.getElementById('tabrow').children.length > 0, null, { timeout: 15000 }).catch(() => {});
  return { ctx, page, errs };
}
const stored = (page, id) => page.evaluate((id) => { const l = JSON.parse(localStorage.getItem('nbd_dsp_v1') || '[]'); return l.find((p) => String(p.id) === String(id)) || null; }, id);

(async () => {
  const srv = await start({ root: path.join(ROOT, 'docs') });
  const browser = await chromium.launch();

  // ── Q3 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nQ3. save on the way out');
  {
    const { ctx, page, errs } = await open(browser, srv);
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(300);
    await page.evaluate(() => { const el = document.querySelector('[data-k="fit-focus"]'); el.value = 'Pull day'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('control: right after typing, the field is not in storage yet (nothing saves synchronously)', (await stored(page, 1.5)).data['fit-focus'] === 'Push day');
    await page.waitForTimeout(1600);
    ok('a pause after typing saves the page without any button (debounced, about a second)', (await stored(page, 1.5)).data['fit-focus'] === 'Pull day');
    ok('...and the status dot reads SAVED once it has', (await page.evaluate(() => document.getElementById('sdot').textContent)).includes('SAVED'));
    await page.evaluate(() => document.querySelector('#day-score-card .dsc-item').click());
    await page.waitForTimeout(1600);
    const flo = await stored(page, 1.5);
    ok('a ticked floor survives without a save: floormet-* is in storage after the pause', Object.keys(flo.data).some((k) => k.startsWith('floormet-') && flo.data[k] === '1'), JSON.stringify(flo.data));
    // the way out: visibilitychange (hidden) and pagehide save at once
    await page.evaluate(() => { const el = document.querySelector('[data-k="fit-focus"]'); el.value = 'Legs day'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    ok('going to the background (visibilitychange hidden) saves at once', (await stored(page, 1.5)).data['fit-focus'] === 'Legs day');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); const el = document.querySelector('[data-k="fit-focus"]'); el.value = 'Arms day'; el.dispatchEvent(new Event('input', { bubbles: true })); window.dispatchEvent(new Event('pagehide')); });
    ok('pagehide saves at once', (await stored(page, 1.5)).data['fit-focus'] === 'Arms day');
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ── Q4 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nQ4. failures are red');
  {
    const { ctx, page, errs } = await open(browser, srv);
    const r = await page.evaluate(() => {
      const calls = []; const real = window.showToast;
      window.showToast = (m, t) => calls.push([m, t]);
      window.toast('fine'); if (typeof window.toastErr === 'function') window.toastErr('broke');
      window.showToast = real;
      return { calls, has: typeof window.toastErr === 'function' };
    });
    ok('window.toastErr exists and shows the error toast', r.has && JSON.stringify(r.calls[1]) === JSON.stringify(['broke', 'error']), JSON.stringify(r));
    ok('control: toast() is still the green one', JSON.stringify(r.calls[0]) === JSON.stringify(['fine', 'success']));
    const bad = [];
    for (const f of fs.readdirSync(path.join(DS, 'js')).filter((n) => n.endsWith('.js'))) {
      read('js', f).split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const m = line.match(/(?<![A-Za-z.])toast\(\s*(SAVE_FAILED|["'`][^"'`]*(could not|couldn't|did not start|failed)[^"'`]*["'`])/i);
        if (m) bad.push(f + ':' + (i + 1) + ' ' + m[0].slice(0, 60));
      });
    }
    ok('no failure message ("Could not...", "Couldn\'t...", "...failed", SAVE_FAILED) goes through the green toast', bad.length === 0, bad.join(' ; '));
    const wired = ['adaptive-calories-ui', 'checkin-ui', 'eod-ui', 'export-ui', 'food-log', 'measurements-ui', 'money-ui', 'review-ui', 'tracker-history-ui', 'workout-coach']
      .filter((n) => !/const toastErr = /.test(read('js', n + '.js')));
    ok('every module that reports a failure has a toastErr that calls the shared one', wired.length === 0, wired.join(', '));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ── Q5 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nQ5. Dashboard DELETE / rename');
  {
    const { ctx, page, errs } = await open(browser, srv);
    await page.evaluate(() => switchTo(-1));
    await page.waitForTimeout(200);
    await page.evaluate(() => { try { triggerDel(); } catch (e) { window.__delErr = String(e); } try { openRename(); } catch (e) { window.__renErr = String(e); } });
    const r = await page.evaluate(() => ({ delErr: window.__delErr || '', renErr: window.__renErr || '', del: document.getElementById('mDel').classList.contains('open'), ren: document.getElementById('mRen').classList.contains('open'), msg: document.getElementById('mDelMsg').textContent }));
    ok('triggerDel() on the Dashboard does not throw', r.delErr === '', r.delErr);
    ok('...and does not open a delete box for a page that is not there', !r.del && !/undefined/.test(r.msg), r.msg);
    ok('openRename() on the Dashboard does not throw or open the rename box', r.renErr === '' && !r.ren);
    await page.evaluate(() => switchTo(0));
    await page.evaluate(() => triggerDel());
    ok('control: on a real page triggerDel() still opens the delete box', await page.evaluate(() => document.getElementById('mDel').classList.contains('open')));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ── Q6 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nQ6. safe area');
  {
    const html = read('index.html');
    const sync = read('ds-firebase-sync.js');
    ok('the sync pill is not positioned in JS (no top:10px in ds-firebase-sync.js); it carries a class', !/top:\s*10px/.test(sync) && /ds-sync-badge/.test(sync) && /\.ds-sync-badge\s*\{/.test(html));
    ok('the content has side/bottom inset padding too (env(safe-area-inset-bottom) on .main)', /\.main\{[^}]*safe-area-inset-bottom/.test(html));
    const measure = async (w, sat) => {
      const { ctx, page, errs } = await open(browser, srv, { w });
      await page.evaluate((sat) => { document.documentElement.style.setProperty('--sat', sat); }, sat);
      await page.evaluate(() => switchTo(0));
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const top = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top * 10) / 10 : null; };
        const tb = document.querySelector('.topbar');
        const pill = document.querySelector('.ds-sync-badge') || document.getElementById('ds-sync-badge');
        return { topbarH: Math.round(tb.getBoundingClientRect().height), tabrow: top('.tabrow'), main: top('.main > div'), logo: top('.nbd-logo'), pill: pill ? Math.round(pill.getBoundingClientRect().top * 10) / 10 : null, pillClass: !!pill && pill.classList.contains('ds-sync-badge'), pillInlineTop: !!pill && /(^|;)\s*top\s*:/.test(pill.getAttribute('style') || ''), todayTop: getComputedStyle(document.getElementById('today-bar')).top };
      });
      await ctx.close();
      return Object.assign(m, { errs });
    };
    for (const w of [390, 1024]) {
      const a = await measure(w, '0px'), b = await measure(w, '40px');
      ok(w + ' px: a 40 px inset pushes the title down with the header growing by 40', b.logo - a.logo === 40 && b.topbarH - a.topbarH === 40, JSON.stringify({ a, b }));
      ok(w + ' px: the tab row and the content move down by the same 40 (nothing slides under the header)', b.tabrow - a.tabrow === 40 && b.main - a.main === 40, JSON.stringify({ a: [a.tabrow, a.main], b: [b.tabrow, b.main] }));
      ok(w + ' px: the sync pill follows the inset and has no inline top', b.pill != null && b.pill - a.pill === 40 && b.pillClass && !b.pillInlineTop, JSON.stringify({ a: a.pill, b: b.pill, c: b.pillClass, i: b.pillInlineTop }));
      ok(w + ' px: the sticky Today bar offset follows the inset', parseFloat(b.todayTop) - parseFloat(a.todayTop) === 40, a.todayTop + ' -> ' + b.todayTop);
      ok(w + ' px: control: no page errors', a.errs.length + b.errs.length === 0);
    }
    const ph = await measure(390, '0px');
    ok('on a phone the sync pill sits under the 100 px header, not on top of the title', ph.pill != null && ph.pill >= 100, String(ph.pill));
  }

  // ── Q9 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nQ9. Today bar numbers are buttons');
  for (const ui of ['classic', 'rings', 'cockpit']) {
    const { ctx, page, errs } = await open(browser, srv, { ui });
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(300);
    const btns = await page.evaluate(() => [...document.querySelectorAll('#today-bar button[data-action="tb-go"]')].map((b) => b.dataset.go));
    ok(ui + ': floors, calories, protein and workout are real buttons (' + btns.join(',') + ')', ['floors', 'cal', 'protein', 'workout'].every((g) => btns.includes(g)), JSON.stringify(btns));
    // floors -> the floors card scrolls into view
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => (document.querySelector('#today-bar button[data-go="floors"]') || { click() {} }).click());
    await page.waitForTimeout(700);
    const fl = await page.evaluate(() => { const r = document.getElementById('day-score-wrap').getBoundingClientRect(); return { top: Math.round(r.top), vh: innerHeight }; });
    ok(ui + ': tapping floors brings the floors card on screen', fl.top < fl.vh - 100 && fl.top > -400, JSON.stringify(fl));
    // calories / protein -> the food search is focused (diet section opened)
    for (const g of ['cal', 'protein']) {
      await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); window.scrollTo(0, 0); });
      await page.evaluate((g) => (document.querySelector('#today-bar button[data-go="' + g + '"]') || { click() {} }).click(), g);
      await page.waitForTimeout(700);
      const fs2 = await page.evaluate(() => { const a = document.activeElement; const card = a && a.closest && a.closest('.pc'); return { id: a && a.id, collapsed: !!card && card.classList.contains('collapsed') }; });
      ok(ui + ': tapping ' + g + ' focuses the food search with the diet section open', fs2.id === 'fsQuery' && !fs2.collapsed, JSON.stringify(fs2));
    }
    // workout -> the coach opens
    await page.evaluate(() => { window.__coachOpened = 0; if (window.NBDCoachUI) window.NBDCoachUI.open = () => { window.__coachOpened++; }; });
    await page.evaluate(() => (document.querySelector('#today-bar button[data-go="workout"]') || { click() {} }).click());
    ok(ui + ': tapping workout opens the coach', (await page.evaluate(() => window.__coachOpened)) === 1);
    const short = await page.evaluate(() => [...document.querySelectorAll('#today-bar button')].filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height < 44).map((b) => b.className + ':' + Math.round(b.getBoundingClientRect().height)));
    ok(ui + ': every button in the bar is at least 44 px tall', short.length === 0, short.join(','));
    ok(ui + ': control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ── Q10 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nQ10. search lands on the match; scroll is kept');
  {
    const { ctx, page, errs } = await open(browser, srv, { extra: { nbd_collapsed: JSON.stringify({ fitness: true, diet: true }) } });
    await page.evaluate(() => { toggleSearch(); });
    await page.evaluate(() => { const i = document.getElementById('sinp'); i.value = 'zebra'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    const hit = await page.evaluate(() => { const h = document.querySelector('#sdrop .sri'); return h ? { k: h.dataset.hitKey || '', idx: h.dataset.pageIdx } : null; });
    ok('a search hit names the field it matched (data-k)', !!hit && hit.k === 'fit-focus', JSON.stringify(hit));
    await page.evaluate(() => document.querySelector('#sdrop .sri').click());
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-k="fit-focus"]'); const card = el && el.closest('.pc'); const b = el && el.getBoundingClientRect();
      return { open: !!card && !card.classList.contains('collapsed'), inView: !!b && b.top >= 0 && b.bottom <= innerHeight, flash: !!el && (el.classList.contains('srch-flash') || !!(el.closest('.srch-flash'))), page: document.getElementById('main').dataset.dsPage };
    });
    ok('the jump opens the page that matched', r.page === '2.5', r.page);
    ok('...expands the section the match is in', r.open, JSON.stringify(r));
    ok('...scrolls the matching field into view', r.inView, JSON.stringify(r));
    ok('...and flashes it', r.flash, JSON.stringify(r));

    // scroll memory per view
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(450);   // past the 250 ms settle (the saved spot is re-applied once late cards have loaded)
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(100);
    const y0 = await page.evaluate(() => scrollY);
    await page.evaluate(() => switchTo(-1));
    await page.waitForTimeout(250);
    const dashTop = await page.evaluate(() => scrollY);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(100);
    const yd = await page.evaluate(() => scrollY);
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => scrollY);
    ok('control: the page was really scrolled (' + y0 + ')', y0 > 400);
    ok('switching to the Dashboard and back returns to where the day was (' + back + ' vs ' + y0 + ')', Math.abs(back - y0) <= 4, 'dash=' + dashTop);
    await page.evaluate(() => switchTo(-1));
    await page.waitForTimeout(300);
    const dback = await page.evaluate(() => scrollY);
    ok('...and the Dashboard keeps its own place (' + dback + ' vs ' + yd + ')', yd > 100 && Math.abs(dback - yd) <= 4);
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(450);
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(100);
    await page.evaluate(() => dsRefreshView());
    await page.waitForTimeout(300);
    const kept = await page.evaluate(() => scrollY);
    ok('a background refresh (dsRefreshView) leaves the scroll where it was (' + kept + ')', Math.abs(kept - 700) <= 4);
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ── Q13 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nQ13. the two streaks have names');
  {
    const { ctx, page, errs } = await open(browser, srv);
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(300);
    const t = await page.evaluate(() => document.body.textContent);
    ok('the day page names "Floor streak" and "Training streak" side by side', /floor streak/i.test(t) && /training streak/i.test(t));
    ok('...and no longer says "Workout streak"', !/workout streak/i.test(t));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    // review fix: the long label must not be cut off by the 4-column grid on a phone
    for (const w of [360, 390]) {
      const { ctx, page, errs } = await open(browser, srv, { w, ui: 'cockpit' });
      await page.evaluate(() => switchTo(0));
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => Array.from(document.querySelectorAll('[data-ui="cockpit"] .ck-l')).map((e) => ({ t: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })));
      const tr = r.find((x) => /training streak/i.test(x.t));
      ok('Cockpit at ' + w + ' px shows the "Training streak" tile', !!tr, JSON.stringify(r));
      ok('...and its label is not clipped (' + w + ' px)', !!tr && !r.some((x) => x.clipped), JSON.stringify(r));
      ok('control: no page errors', errs.length === 0, errs.join(' | '));
      await ctx.close();
    }
  }
  ok('Quest says "training streak"', /-day training streak/.test(read('js', 'quest-ui.js')));
  ok('Cockpit labels its tile "Training streak" (no shortened "Streak")', !/'Streak'/.test(read('js', 'cockpit-ui.js')));
  ok('the Sunday review card says "floor streak" (the Sunday line stays word-for-word the same as the NBD OS widget)', /Floor streak/.test(read('js', 'review-ui.js')) && !/ended the streak|start a streak|keeps the streak/.test(read('js', 'review-ui.js')) && !/<b>' \+ x\.streak\.count \+ '<\/b> streak/.test(read('js', 'review-ui.js')));

  await browser.close(); await srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
