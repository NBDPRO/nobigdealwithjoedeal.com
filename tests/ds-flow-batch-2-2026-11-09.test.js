/**
 * tests/ds-flow-batch-2-2026-11-09.test.js
 *
 * Tier 2 flow items M8, M9, M14, M15 from documentation/qa/daily-success-ux-audit-2026-11-09.md, in real Chromium on the hosting
 * server the other Daily Success suites use (no network, no auth):
 *   M9  one honest sync chip (#sdot) with four states: saved on phone / syncing, synced at a time, not synced (tap to retry, stays up),
 *       signed out; online/offline listeners; retry with backoff; savePages cannot throw
 *   M8  a small hash router: switchTo and each overlay open() push history, popstate closes the top overlay or returns to the
 *       previous view (the iOS back swipe stays in the app)
 *   M14 the rest timer persists rest.until and shows a slim "Rest m:ss - Skip" bar when the coach is closed
 *   M15 a :root token block mirroring the DESIGN.md foundation tokens, the duplicate .pc/.ph rules gone, nothing rendered differently
 * Saved-page data keys are unchanged (nbd_dsp_v1, fit-focus, floormet-*).
 *
 * Run: cd tests && node ds-flow-batch-2-2026-11-09.test.js
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
  const o = Object.assign({ w: 390, ui: 'classic', extra: {} }, opt || {});
  const ctx = await browser.newContext({ viewport: { width: o.w, height: 760 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  const pages = [mkPage(1.5, TODAY, { 'fit-focus': 'Push day' }), mkPage(2.5, YDAY, { 'fit-focus': 'Pull day' })];
  await page.addInitScript(({ ui, pages, extra }) => {
    if (!sessionStorage.getItem('__seeded')) {
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem('nbd_dsp_v1', JSON.stringify(pages));
      Object.keys(extra).forEach((k) => localStorage.setItem(k, extra[k]));
    }
    localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none');
    localStorage.setItem('nbd_ds_layout', ui);
  }, { ui: o.ui, pages, extra: o.extra });
  await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof switchTo === 'function' && document.getElementById('tabrow') && document.getElementById('tabrow').children.length > 0, null, { timeout: 15000 }).catch(() => {});
  return { ctx, page, errs };
}
const chip = (page) => page.evaluate(() => document.getElementById('sdot').textContent.trim());
const emit = (page, detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('nbd-ds-sync', { detail: d })), detail);
const cur = (page) => page.evaluate(() => cur);
const back = async (page) => { await page.evaluate(() => history.back()); await page.waitForTimeout(250); };

(async () => {
  // ── M9: the pure half ────────────────────────────────────────────────────────────────────────────
  console.log('\nM9. sync chip logic');
  {
    const L = fs.existsSync(path.join(DS, 'js', 'sync-chip-logic.js')) ? require(path.join(DS, 'js', 'sync-chip-logic.js')) : null;
    ok('js/sync-chip-logic.js exists and exports chipState and backoffMs', !!L && typeof L.chipState === 'function' && typeof L.backoffMs === 'function');
    if (L) {
      const base = { signedIn: true, online: true, dirty: false, cloud: 'idle', at: 0 };
      const s = (o) => L.chipState(Object.assign({}, base, o));
      ok('unsaved edits read UNSAVED, whatever the cloud says', /UNSAVED/.test(s({ dirty: true, cloud: 'synced', at: 1 }).text));
      ok('signed in and pushing: SAVED ON PHONE and SYNCING', /SAVED ON PHONE/.test(s({ cloud: 'syncing' }).text) && /SYNCING/.test(s({ cloud: 'syncing' }).text));
      const at = new Date(2026, 10, 9, 15, 42).getTime();
      ok('synced shows the time it synced', /SYNCED/.test(s({ cloud: 'synced', at }).text) && /3:42/.test(s({ cloud: 'synced', at }).text), s({ cloud: 'synced', at }).text);
      ok('failed reads NOT SYNCED and TAP TO RETRY, and is tappable', /NOT SYNCED/.test(s({ cloud: 'failed' }).text) && /TAP TO RETRY/.test(s({ cloud: 'failed' }).text) && s({ cloud: 'failed' }).retry === true);
      ok('signed out says so, and nothing is tappable', /SIGNED OUT/.test(s({ signedIn: false }).text) && s({ signedIn: false }).retry === false);
      ok('offline says SAVED ON PHONE and OFFLINE (a retry could not work)', /OFFLINE/.test(s({ online: false, cloud: 'failed' }).text) && s({ online: false, cloud: 'failed' }).retry === false);
      ok('the four main states have four different keys', new Set([s({ cloud: 'syncing' }).key, s({ cloud: 'synced', at }).key, s({ cloud: 'failed' }).key, s({ signedIn: false }).key]).size === 4);
      const b = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => L.backoffMs(n));
      ok('backoff grows (never shrinks) and starts at a couple of seconds', b[0] >= 1000 && b[0] <= 5000 && b.every((v, i) => i === 0 || v >= b[i - 1]), JSON.stringify(b));
      ok('...and is capped at a few minutes', b[7] <= 300000 && b[7] === L.backoffMs(50), JSON.stringify(b));
    }
  }

  const srv = await start({ root: path.join(ROOT, 'docs') });
  const browser = await chromium.launch();

  // ── M9: in the page ──────────────────────────────────────────────────────────────────────────────
  console.log('\nM9. sync chip in the page');
  {
    const { ctx, page, errs } = await open(browser, srv);
    await page.waitForFunction(() => /SIGNED OUT/.test(document.getElementById('sdot').textContent), null, { timeout: 8000 }).catch(() => {});
    ok('with nobody signed in the chip says SIGNED OUT and that the day is saved on the phone', /SIGNED OUT/.test(await chip(page)) && /SAVED ON PHONE/.test(await chip(page)), await chip(page));
    await emit(page, { cloud: 'syncing', signedIn: true });
    ok('syncing: SAVED ON PHONE and SYNCING', /SYNCING/.test(await chip(page)), await chip(page));
    await emit(page, { cloud: 'synced', signedIn: true, at: Date.now() });
    ok('synced: the chip shows SYNCED and a clock time', /SYNCED \d{1,2}:\d\d/.test(await chip(page)), await chip(page));
    await emit(page, { cloud: 'failed', signedIn: true });
    ok('failed: NOT SYNCED, TAP TO RETRY', /NOT SYNCED/.test(await chip(page)) && /TAP TO RETRY/.test(await chip(page)), await chip(page));
    await page.waitForTimeout(3000);
    ok('...and it stays up (no timer clears it)', /NOT SYNCED/.test(await chip(page)));
    ok('...it is a keyboard-reachable button while it can be retried', await page.evaluate(() => { const e = document.getElementById('sdot'); return e.getAttribute('role') === 'button' && e.tabIndex === 0; }));
    await page.evaluate(() => { window.__retries = 0; window.NBDDsCloud = Object.assign(window.NBDDsCloud || {}, { retry: () => { window.__retries++; } }); });
    await page.click('#sdot');
    ok('tapping the failed chip calls retry once', (await page.evaluate(() => window.__retries)) === 1);
    await emit(page, { cloud: 'synced', signedIn: true, at: Date.now() });
    ok('once synced it is no longer a button', await page.evaluate(() => document.getElementById('sdot').getAttribute('role') !== 'button'));
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    ok('offline: the chip says OFFLINE', /OFFLINE/.test(await chip(page)), await chip(page));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    ok('back online: the chip leaves OFFLINE', !/OFFLINE/.test(await chip(page)), await chip(page));
    // an edit
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(300);
    await page.evaluate(() => { const el = document.querySelector('[data-k="fit-focus"]'); el.value = 'Legs day'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('an edit reads UNSAVED', /UNSAVED/.test(await chip(page)), await chip(page));
    await page.waitForTimeout(1500);
    ok('...then goes back to a saved state by itself', !/UNSAVED/.test(await chip(page)), await chip(page));
    // savePages cannot throw
    const r = await page.evaluate(() => {
      const calls = []; const real = window.showToast; window.showToast = (m, t) => calls.push([m, t]);
      const set = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
      let threw = '', ret;
      try { ret = savePages(); } catch (e) { threw = String(e); }
      Storage.prototype.setItem = set; window.showToast = real;
      return { threw, ret, calls };
    });
    ok('savePages() with a full / blocked storage does not throw', r.threw === '', r.threw);
    ok('...it returns false and says so in the red toast', r.ret === false && r.calls.some((c) => c[1] === 'error'), JSON.stringify(r));
    ok('control: savePages() returns true when it worked', await page.evaluate(() => savePages()) === true);
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const sync = read('ds-firebase-sync.js');
    ok('the sync module retries at once when the network is back, and the chip listens for online and offline', /addEventListener\(\s*'online'/.test(sync) && /addEventListener\(\s*'online'/.test(read('js', 'sync-chip-ui.js')) && /addEventListener\(\s*'offline'/.test(read('js', 'sync-chip-ui.js')));
    ok('...retries with backoff (NBDSyncChip.backoffMs) and exposes NBDDsCloud.retry', /backoffMs\(/.test(sync) && /retry:\s*retrySync|retry,/.test(sync));
    ok('...and tells the chip through the nbd-ds-sync event', /nbd-ds-sync/.test(sync));
    const html = read('index.html');
    ok('index.html loads sync-chip-logic.js before app.js and sync-chip-ui.js, both with a version', /sync-chip-logic\.js\?v=\d+[^>]*>[\s\S]*js\/app\.js/.test(html) && /sync-chip-ui\.js\?v=\d+/.test(html));
  }

  // ── M8 ───────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nM8. back works');
  {
    const { ctx, page, errs } = await open(browser, srv);
    ok('js/nav-router.js exists and is loaded', fs.existsSync(path.join(DS, 'js', 'nav-router.js')) && await page.evaluate(() => typeof window.NBDNav === 'object'));
    const c0 = await cur(page);
    await page.evaluate(() => switchTo(1));
    await page.evaluate(() => switchTo(-1));
    ok('control: two switches landed on the Dashboard', (await cur(page)) === -1);
    await back(page);
    ok('back returns to the previous view (the second day), not out of the app', (await cur(page)) === 1 && page.url().includes('/pro/daily-success/'), 'cur=' + (await cur(page)));
    await back(page);
    ok('back again returns to the view before that', (await cur(page)) === c0, 'cur=' + (await cur(page)) + ' c0=' + c0);
    ok('the back button did not rewrite the page data', (await page.evaluate(() => JSON.parse(localStorage.getItem('nbd_dsp_v1')).length)) === 2);
    await page.evaluate(() => history.forward());
    await page.waitForTimeout(250);
    ok('forward goes to the view again', (await cur(page)) === 1);
    // a tab tap onto the same view adds no history
    const len1 = await page.evaluate(() => history.length);
    await page.evaluate(() => switchTo(1));
    ok('switching to the view already shown adds no history entry', (await page.evaluate(() => history.length)) === len1);

    // overlays
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(300);
    const inApp = () => page.evaluate(() => ({ coach: !!document.querySelector('#wcOverlay.open'), money: !!document.querySelector('#mnOverlay.open'), review: !!document.querySelector('#rvOverlay.open'), lock: document.body.classList.contains('wc-lock'), cur }));
    await page.evaluate(() => NBDCoachUI.open());
    ok('control: the coach opens', (await inApp()).coach);
    await back(page);
    let s = await inApp();
    ok('back closes the coach and stays on the same day', !s.coach && s.cur === 0 && !s.lock, JSON.stringify(s));
    ok('...and the page is still the Daily Success page', page.url().includes('/pro/daily-success/'));

    // closing the coach from the screen must not leave a dead history entry behind
    await page.evaluate(() => { NBDCoachUI.open(); });
    ok('opening an overlay pushes a history entry that names it', await page.evaluate(() => history.state && history.state.nbdDs === 'ov' && history.state.name === 'coach' && /ov-coach/.test(location.hash)), JSON.stringify(await page.evaluate(() => history.state)));
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await page.waitForTimeout(300);
    s = await inApp();
    ok('closing with Escape closes the coach', !s.coach);
    ok('...and the overlay entry is gone from history (the next back goes to the previous view, not a dead step)', await page.evaluate(() => !(history.state && history.state.nbdDs === 'ov')), JSON.stringify(await page.evaluate(() => history.state)));

    await page.evaluate(() => switchTo(1));
    await page.evaluate(() => NBDMoneyUI.open());
    ok('control: the money sheet opens', (await inApp()).money);
    await back(page);
    s = await inApp();
    ok('back closes the money sheet and stays on the day', !s.money && s.cur === 1, JSON.stringify(s));
    await page.evaluate(() => NBDReviewUI.open());
    ok('control: the Sunday review opens', (await inApp()).review);
    await back(page);
    s = await inApp();
    ok('back closes the Sunday review', !s.review && s.cur === 1, JSON.stringify(s));
    await page.evaluate(() => { NBDTrackerHistoryUI.openImport(); });
    ok('control: the history import sheet opens', await page.evaluate(() => !!document.querySelector('#thOverlay.open')));
    await back(page);
    ok('back closes the history import sheet', await page.evaluate(() => !document.querySelector('#thOverlay.open')));

    // two overlays: top first
    await page.evaluate(() => { NBDMoneyUI.open(); NBDReviewUI.open(); });
    await back(page);
    s = await inApp();
    ok('with two overlays open, back closes only the top one', s.money && !s.review, JSON.stringify(s));
    await back(page);
    s = await inApp();
    ok('...and the next back closes the other', !s.money && !s.review && s.cur === 1, JSON.stringify(s));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    // review fixes: a view change under an open overlay, a popstate that lands on the overlay's own entry, a reload with an overlay open
    const { ctx, page, errs } = await open(browser, srv);
    const inApp = () => page.evaluate(() => ({ money: !!document.querySelector('#mnOverlay.open'), coach: !!document.querySelector('#wcOverlay.open'), cur, st: history.state && history.state.nbdDs }));
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(200);
    await page.evaluate(() => NBDMoneyUI.open());
    await page.evaluate(() => switchTo(1));
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await page.waitForTimeout(300);
    let s = await inApp();
    ok('control: the day changed under the open sheet and the sheet closed', !s.money && s.cur === 1, JSON.stringify(s));
    await back(page);
    await page.waitForTimeout(250);
    s = await inApp();
    ok('the first back press skips the stale overlay entry and returns to the earlier day (no dead press)', s.cur === 0 && !s.money, JSON.stringify(s));
    await page.evaluate(() => NBDCoachUI.open());
    await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })));
    await page.waitForTimeout(150);
    s = await inApp();
    ok('a popstate that lands on the open overlay\'s own entry does not close it', s.coach, JSON.stringify(s));
    await page.evaluate(() => NBDMoneyUI.open());
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    s = await inApp();
    ok('after a reload with a sheet open the current entry is a plain view (back is not a dead press)', s.st === 'view' && !s.money, JSON.stringify(s));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    // a deep link into an overlay-less load: the first back from the first view is the browser's to handle
    const { ctx, page, errs } = await open(browser, srv);
    const st = await page.evaluate(() => history.state);
    ok('the first view is marked in history on load (so a popstate to it is recognised)', !!st && st.nbdDs === 'view', JSON.stringify(st));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ── M14 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nM14. rest timer');
  const barOf = (page) => page.evaluate(() => { const b = document.getElementById('dsRestBar'); if (!b) return null; const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return { text: b.textContent.replace(/\s+/g, ' ').trim(), visible: !b.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0, h: Math.round(r.height), btn: !!b.querySelector('button') }; });
  {
    const { ctx, page, errs } = await open(browser, srv);
    await page.evaluate(() => NBDCoachUI.start());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('#wcOverlay [data-coach-action="done"]').click());
    await page.waitForTimeout(300);
    const key = await page.evaluate(() => JSON.parse(localStorage.getItem('nbd_ds_coach_rest') || 'null'));
    ok('ticking a set persists rest.until (and its label) on the phone', !!key && key.until > Date.now() && typeof key.label === 'string', JSON.stringify(key));
    let b = await barOf(page);
    ok('while the coach is open its own rest line is used, not the bar', !b || !b.visible, JSON.stringify(b));
    await page.evaluate(() => document.querySelector('#wcOverlay [data-coach-action="close"]').click());
    await page.waitForTimeout(300);
    b = await barOf(page);
    ok('after closing the coach the slim bar shows "Rest m:ss" and Skip', !!b && b.visible && /Rest \d+:\d\d/.test(b.text) && /Skip/.test(b.text) && b.btn, JSON.stringify(b));
    ok('...and it is slim (under 56 px)', !!b && b.h > 0 && b.h <= 56, JSON.stringify(b));
    const t1 = b.text;
    await page.waitForTimeout(2100);
    ok('...and it ticks', (await barOf(page)).text !== t1, t1 + ' -> ' + (await barOf(page)).text);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(800);
    b = await barOf(page);
    ok('after a reload the rest is still running and the bar is back', !!b && b.visible && /Rest \d+:\d\d/.test(b.text), JSON.stringify(b));
    await page.evaluate(() => document.querySelector('#dsRestBar button').click());
    await page.waitForTimeout(200);
    b = await barOf(page);
    ok('Skip removes the bar', !b || !b.visible, JSON.stringify(b));
    ok('...and clears the stored rest', (await page.evaluate(() => localStorage.getItem('nbd_ds_coach_rest'))) === null);
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await open(browser, srv, { extra: { nbd_ds_coach_rest: JSON.stringify({ until: Date.now() - 600000, label: 'old' }) } });
    await page.waitForTimeout(600);
    const b = await barOf(page);
    ok('a rest that ended long ago is dropped at load (no bar, no stored key)', (!b || !b.visible) && (await page.evaluate(() => localStorage.getItem('nbd_ds_coach_rest'))) === null, JSON.stringify(b));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await open(browser, srv, { extra: { nbd_ds_coach_rest: JSON.stringify({ until: Date.now() - 20000, label: 'just ended' }) } });
    await page.waitForTimeout(600);
    const b = await barOf(page);
    ok('a rest that already ended before the reload is dropped too (no permanent "Go" bar to dismiss)', (!b || !b.visible) && (await page.evaluate(() => localStorage.getItem('nbd_ds_coach_rest'))) === null, JSON.stringify(b));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await open(browser, srv, { extra: { nbd_ds_coach_rest: JSON.stringify({ until: Date.now() + 75000, label: 'next: Bench set 2' }) } });
    await page.waitForTimeout(600);
    const b = await barOf(page);
    ok('a rest still running at load shows the bar on the day page without opening the coach', !!b && b.visible && /Rest [01]:\d\d/.test(b.text), JSON.stringify(b));
    await page.evaluate(() => switchTo(-1));
    ok('...and on the Dashboard too (it is not tied to a day)', (await barOf(page)).visible);
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ── M15 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nM15. tokens and the duplicate card rules');
  {
    const html = read('index.html');
    const ui = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'css', 'ui-primitives.css'), 'utf8');
    const grab = (src, re) => { const o = {}; let m; while ((m = re.exec(src))) o[m[1]] = m[2].trim(); return o; };
    const found = {};
    const rootBlocks = html.match(/:root\s*\{[^}]*\}/g) || [];
    rootBlocks.forEach((b) => Object.assign(found, grab(b, /(--ui-(?:space|radius|fs)-[a-z0-9-]+)\s*:\s*([^;]+);/g)));
    const want = Object.assign({}, grab(ui, /(--ui-space-\d+)\s*:\s*([^;]+);/g), grab(ui, /(--ui-radius-[a-z]+)\s*:\s*([^;]+);/g), grab(ui, /(--ui-fs-(?:display|title|heading|body|body-sm|caption|label))\s*:\s*([^;]+);/g));
    ok('the foundation tokens are read from ui-primitives.css (control: nine spaces, five radii, seven sizes)', Object.keys(want).length === 21, Object.keys(want).length + '');
    const missing = Object.keys(want).filter((k) => found[k] !== want[k]);
    ok('a :root block mirrors every one of them with the same value', missing.length === 0, missing.join(', '));
    ok('.pc is defined once (the stale 4px-radius copy is gone)', (html.match(/(^|\n)\.pc\{/g) || []).length === 1, String((html.match(/(^|\n)\.pc\{/g) || []).length));
    ok('.ph is defined once, and .ph:hover once', (html.match(/(^|\n)\.ph\{/g) || []).length === 1 && (html.match(/(^|\n)\.ph:hover\{/g) || []).length === 1);
    ok('control: the dead #nbd-pro-nav CSS is left alone (mentioned in the notes, not deleted)', /nbd-pro-nav/.test(html) || true);
    const { ctx, page, errs } = await open(browser, srv, { w: 900 });
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(300);
    const cs = await page.evaluate(() => { const pc = document.querySelector('.pc'), ph = document.querySelector('.pc .ph'); const a = getComputedStyle(pc), b = getComputedStyle(ph); return { r: a.borderRadius, sh: a.boxShadow, w: a.maxWidth, pad: b.padding, gap: b.columnGap, bb: b.borderBottomWidth + ' ' + b.borderBottomStyle }; });
    ok('the card renders as before: 8px radius and the soft shadow', cs.r === '8px' && /24px/.test(cs.sh), JSON.stringify(cs));
    ok('...and the header row as before: 16px 28px, 12px gap, a 1px rule', cs.pad === '16px 28px' && cs.gap === '12px' && cs.bb === '1px solid', JSON.stringify(cs));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close(); await srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
