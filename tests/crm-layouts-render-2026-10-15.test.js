/* tests/crm-layouts-render-2026-10-15.test.js
 *
 * The CRM layouts audit (2026-10-15), checked as PAINTED: the real dashboard
 * on the sample account (/pro/explore, demo service worker, nothing leaves
 * 127.0.0.1; the same server and setup as pro-demo-zero-network), in Chromium
 * at an iPhone size (390x844, touch) and a laptop size (1440x900), dark and
 * light. The source-level checks are in crm-layouts-audit-fixes-2026-10-15.
 *
 *   D1  Island, phone: every Today row's name column is wide enough to read
 *       (it was 0 px: the name painted one letter per line)
 *   D2  Mission, phone: the map has real height and the closes-week card does
 *       not sit on it or on Alerts
 *   D4  Crew and Inbox: the card is one line and the week grid / the reply
 *       list starts on the first screen
 *   D5  no visible text is painted in the brand orange on these screens, and
 *       Field's accent text clears 4.5:1 against what is behind it
 *   D6/D8 the closes-week buttons and the Mission scrubber are >= 44 px tall
 *   D21 a phone that prefers light gets the light palette at boot
 *   and nothing scrolls sideways at 390 px.
 *
 * SHOTS_DIR=<dir> also saves <layout>-<width>-<theme>.png there (the audit's
 * naming). Wired individually in CI next to the zero-network walk (needs
 * Playwright's Chromium). Locally it SKIPS when playwright is not resolvable;
 * under CI=true that is a failure.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { start } = require('./lib/demo-hosting-server');

let passed = 0, failed = 0; const fails = [];
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
const SHOTS = process.env.SHOTS_DIR || '';

// in the page: contrast of an element's text against the first opaque background behind it
function pageHelpers() {
  window.__lx = {
    // rgb()/rgba(), or color(srgb r g b / a) (what Chromium computes a color-mix() to)
    rgb(s) {
      const str = String(s);
      const c = str.match(/color\(srgb ([^)]+)\)/);
      if (c) { const p = c[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
      const m = str.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    },
    lum(c) { const n = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * n(c.r) + 0.7152 * n(c.g) + 0.0722 * n(c.b); },
    bgOf(el) {
      // composite translucent backgrounds from the page up to the element
      const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
      let base = { r: 255, g: 255, b: 255 };
      const root = getComputedStyle(document.documentElement).backgroundColor; const rb = this.rgb(root);
      const body = this.rgb(getComputedStyle(document.body).backgroundColor);
      if (rb && rb.a > 0) base = rb; if (body && body.a > 0) base = { r: body.r * body.a + base.r * (1 - body.a), g: body.g * body.a + base.g * (1 - body.a), b: body.b * body.a + base.b * (1 - body.a) };
      for (let i = chain.length - 1; i >= 0; i--) {
        const c = this.rgb(getComputedStyle(chain[i]).backgroundColor);
        if (c && c.a > 0) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
      }
      return base;
    },
    contrast(el) { const f = this.rgb(getComputedStyle(el).color); const b = this.bgOf(el); const x = this.lum(f), y = this.lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); },
    visible(el) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; },
    ownText(el) { let t = ''; el.childNodes.forEach((n) => { if (n.nodeType === 3) t += n.textContent; }); return t.trim(); },
    /** visible elements whose own text is painted in the brand orange #BD5728 */
    orangeText(scope) {
      const out = [];
      (scope || document.body).querySelectorAll('*').forEach((el) => {
        if (!this.ownText(el) || !this.visible(el)) return;
        const c = this.rgb(getComputedStyle(el).color);
        if (c && Math.abs(c.r - 189) < 3 && Math.abs(c.g - 87) < 3 && Math.abs(c.b - 40) < 3) out.push((el.className || el.tagName) + ': ' + this.ownText(el).slice(0, 30));
      });
      return out;
    },
  };
}

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
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  async function open(size, theme) {
    const phone = size === 390;
    const ctx = await browser.newContext(Object.assign({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      serviceWorkers: 'allow', colorScheme: theme,
    }, phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
    await ctx.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN + '/')) return route.continue();
      if (FONT_HOST.test(u)) return route.fulfill({ status: 200, contentType: /googleapis/.test(u) ? 'text/css' : 'font/woff2', body: '' });
      return route.abort('blockedbyclient');
    });
    // "auto" (the default) follows the phone's light/dark setting: no saved theme or mode
    await ctx.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await ctx.addInitScript(pageHelpers);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
    await page.goto(ORIGIN + '/pro/explore');
    await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 30000 });
    await page.waitForFunction(() => Array.isArray(window._leads) && window._leads.length >= 20 && window._leadsLoaded === true && !!window.LayoutEngine, null, { timeout: 40000 });
    // the layout settings are read once at boot; picking before that lands races it
    await page.waitForFunction(() => window.LayoutEngine.prefs().hydrated === true, null, { timeout: 30000 });
    return { ctx, page, errors };
  }
  async function useLayout(page, id) {
    await page.evaluate(async (lid) => {
      await window.LayoutEngine.saveUser({ id: lid, device: window.LayoutEngine.surface() });
      await window.LayoutEngine.apply(lid, { source: 'user' });
      if (typeof window.goTo === 'function') window.goTo('home');
      const s = document.getElementById('nbd-demo-strip'); if (s) s.style.display = 'none';
    }, id);
    await page.waitForFunction((lid) => document.documentElement.getAttribute('data-layout') === lid, id, { timeout: 20000 });
    // the closes-week card paints after a 250 ms debounce; layouts paint on their own data hooks
    await page.waitForFunction(() => !!document.querySelector('.cwk-card'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  // the audit's set: the first screen, plus a full-page capture for the layouts
  // that scroll the page (Classic, Bento, Island)
  async function shot(page, name) {
    if (!SHOTS) return;
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
    if (/^(classic|bento|island)-/.test(name)) await page.screenshot({ path: path.join(SHOTS, name + '-full.png'), fullPage: true });
  }
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

  try {
    for (const theme of ['dark', 'light']) {
      // ── phone ──────────────────────────────────────────────────────────
      console.log('\n390 x 844, ' + theme);
      const P = await open(390, theme);
      const page = P.page;
      const mode = await page.evaluate(() => ({ mode: document.documentElement.getAttribute('data-mode'), engine: !!window.ThemeEngine }));
      if (theme === 'light') {
        await page.waitForFunction(() => !!window.ThemeEngine, null, { timeout: 20000 }).catch(() => {});
        const bg = await page.evaluate(() => { const c = window.__lx.rgb(getComputedStyle(document.body).backgroundColor); return c && window.__lx.lum(c); });
        ok('D21: a phone set to light gets the light palette at boot (theme engine loaded, light background)', mode.mode === 'light' && (await page.evaluate(() => !!window.ThemeEngine)) && bg > 0.5, JSON.stringify(mode) + ' lum ' + bg);
      }

      await useLayout(page, 'island');
      await page.waitForFunction(() => document.querySelectorAll('.isl-tl .lk-card-row').length > 0, null, { timeout: 15000 }).catch(() => {});
      const isl = await page.evaluate(() => [...document.querySelectorAll('.isl-tl .lk-card-row')].map((r) => {
        const m = r.querySelector('.lk-main'), n = r.querySelector('.lk-name');
        return { main: m ? Math.round(m.getBoundingClientRect().width) : -1, nameH: n ? Math.round(n.getBoundingClientRect().height) : -1, lh: n ? parseFloat(getComputedStyle(n).lineHeight) || 20 : 20 };
      }));
      ok('D1 Island: Today rows exist on the sample account', isl.length > 0);
      ok('D1 Island: every row\'s name column is readable (>= 150 px wide, name on <= 2 lines)', isl.length > 0 && isl.every((r) => r.main >= 150 && r.nameH <= r.lh * 2 + 2), JSON.stringify(isl));
      ok('Island: nothing scrolls sideways at 390', await noSideScroll(page));
      await shot(page, 'island-390-' + theme);

      await useLayout(page, 'mission');
      await page.waitForFunction(() => !!document.querySelector('.mc-map'), null, { timeout: 20000 });
      const mc = await page.evaluate(() => {
        const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, h: b.height }; };
        const slot = document.querySelector('[data-cwk-slot="mission"]');
        const scrub = document.querySelector('.mc-scrub');
        return { map: r('.mc-map'), center: r('.mc-center'), slot: r('[data-cwk-slot="mission"]'), alerts: r('.mc-left'), path: r('.mc-right'),
          inMap: !!(slot && slot.closest('.mc-center')), card: !!(slot && slot.querySelector('.cwk-card')), scrub: scrub ? Math.round(scrub.getBoundingClientRect().height) : null };
      });
      ok('D2 Mission: the map has real height on a phone (>= 200 px)', mc.map && mc.map.h >= 200, JSON.stringify(mc.map));
      ok('D2 Mission: map, then Alerts, then In the path, then the closes-week card; nothing overlaps',
        mc.card && !mc.inMap && mc.alerts.t >= mc.center.b - 1 && mc.path.t >= mc.alerts.b - 1 && mc.slot.t >= mc.path.b - 1, JSON.stringify(mc));
      ok('D8 Mission: the storm scrubber (when shown) is >= 44 px tall', mc.scrub === null || mc.scrub >= 44, String(mc.scrub));
      ok('Mission: nothing scrolls sideways at 390', await noSideScroll(page));
      await shot(page, 'mission-390-' + theme);

      await useLayout(page, 'crew');
      const crew = await page.evaluate(() => {
        const slot = document.querySelector('[data-cwk-slot="crew"]');
        const sc = document.querySelector('.cw-scroll, .cw-daygrid, .cw-empty');
        return { compact: !!(slot && slot.querySelector('.cwk-compact .cwk-sum')), sumH: slot && slot.querySelector('.cwk-sum') ? Math.round(slot.querySelector('.cwk-sum').getBoundingClientRect().height) : 0,
          slotH: slot ? Math.round(slot.getBoundingClientRect().height) : 0, gridTop: sc ? Math.round(sc.getBoundingClientRect().top) : 9999 };
      });
      ok('D4 Crew (phone): the card is one 44 px line, the schedule starts on the first screen', crew.compact && crew.sumH >= 44 && crew.slotH <= 90 && crew.gridTop < 844 * 0.6, JSON.stringify(crew));
      await page.locator('[data-cwk-slot="crew"] .cwk-sum').click();
      const opened = await page.evaluate(() => ({ list: !!document.querySelector('[data-cwk-slot="crew"] .cwk-list'), acts: [...document.querySelectorAll('[data-cwk-slot="crew"] .cwk-act')].map((a) => Math.round(a.getBoundingClientRect().height)), more: [...document.querySelectorAll('[data-cwk-slot="crew"] .cwk-more')].map((a) => Math.round(a.getBoundingClientRect().height)) }));
      ok('D4/D6 Crew: "See all" opens the card; its action and Hide/Show buttons are >= 44 px', opened.list && opened.acts.length > 0 && opened.acts.every((h) => h >= 44) && opened.more.every((h) => h >= 44), JSON.stringify(opened));
      await page.locator('[data-cwk-slot="crew"] [data-cwk-open="0"]').click();
      ok('Crew: nothing scrolls sideways at 390', await noSideScroll(page));
      await shot(page, 'crew-390-' + theme);

      await useLayout(page, 'inbox');
      const ib = await page.evaluate(() => {
        const slot = document.querySelector('[data-cwk-slot="inbox"]'); const sc = document.querySelector('.ib-scroll');
        return { compact: !!(slot && slot.querySelector('.cwk-compact')), listTop: sc ? Math.round(sc.getBoundingClientRect().top) : 9999, orange: window.__lx.orangeText(document.querySelector('.ib-root')) };
      });
      ok('D4 Inbox (phone): one line, and the reply list starts in the top half', ib.compact && ib.listTop < 844 / 2, JSON.stringify(ib));
      ok('D5 Inbox: no text painted in the brand orange', ib.orange.length === 0, ib.orange.join(' | '));
      await shot(page, 'inbox-390-' + theme);

      await useLayout(page, 'field');
      await page.waitForFunction(() => !!document.querySelector('.fa-scroll'), null, { timeout: 15000 });
      const fa = await page.evaluate(() => {
        const sel = ['.fa-now-time', '.fa-do', '.lk-nav-active .lk-nav-lbl', '.fa-link', '.fa-storm'];
        const out = {};
        sel.forEach((s) => { const e = document.querySelector(s); if (e && window.__lx.visible(e)) out[s] = Math.round(window.__lx.contrast(e) * 100) / 100; });
        return { contrast: out, orange: window.__lx.orangeText(document.getElementById('nbdFieldRoot') || document.body) };
      });
      ok('D5 Field: accent text clears 4.5:1 where it shows (stop time, DO THIS, active tab)', Object.keys(fa.contrast).length >= 1 && Object.values(fa.contrast).every((c) => c >= 4.5), JSON.stringify(fa.contrast));
      ok('D5 Field: no text painted in the brand orange', fa.orange.length === 0, fa.orange.join(' | '));
      ok('Field: nothing scrolls sideways at 390', await noSideScroll(page));
      await shot(page, 'field-390-' + theme);

      await useLayout(page, 'focus');
      await shot(page, 'focus-390-' + theme);
      await useLayout(page, 'bento');
      await shot(page, 'bento-390-' + theme);
      await useLayout(page, 'classic');
      await shot(page, 'classic-390-' + theme);
      ok('no script error on the phone walk (' + theme + ')', P.errors.length === 0, P.errors.join(' | '));
      await P.ctx.close();

      // ── laptop ─────────────────────────────────────────────────────────
      console.log('\n1440 x 900, ' + theme);
      const L = await open(1440, theme);
      const lp = L.page;
      await useLayout(lp, 'crew');
      const crewL = await lp.evaluate(() => {
        const slot = document.querySelector('[data-cwk-slot="crew"]'); const sc = document.querySelector('.cw-scroll');
        const t = document.querySelector('[data-cwk-slot="crew"] .cwk-sum-t');
        return { compact: !!(slot && slot.querySelector('.cwk-compact')), gridTop: sc ? Math.round(sc.getBoundingClientRect().top) : 9999, order: t ? getComputedStyle(t).order : null };
      });
      ok('D4 Crew (laptop): the week grid starts near the top (< 260 px), not at the bottom of the screen', crewL.compact && crewL.gridTop < 260, JSON.stringify(crewL));
      // "Certificate expired" (2026-10-16, --ui-danger-text): measured on a real lane. The sample
      // account may have no lapsed sub, so a lane without one gets the exact markup crew.js writes.
      const certC = await lp.evaluate(() => {
        let el = [...document.querySelectorAll('.cw-lane-name .cw-cert')].find((e) => window.__lx.visible(e));
        let added = null;
        const lane = document.querySelector('.cw-lane-name');
        if (!el && lane) { added = document.createElement('small'); added.className = 'cw-cert'; added.textContent = 'Certificate expired'; lane.appendChild(added); el = added; }
        const c = el && window.__lx.visible(el) ? Math.round(window.__lx.contrast(el) * 100) / 100 : 0;
        if (added) added.remove();
        return c;
      });
      ok('Crew: red "Certificate expired" text clears 4.5:1 against its lane', certC >= 4.5, String(certC));
      await lp.locator('[data-cwk-slot="crew"] .cwk-sum').click();
      const crewOpen = await lp.evaluate(() => {
        const hdr = document.querySelector('[data-cwk-slot="crew"] .cwk-hdr'), title = document.querySelector('[data-cwk-slot="crew"] .cwk-title'), aside = document.querySelector('[data-cwk-slot="crew"] .cwk-aside');
        return { acts: [...document.querySelectorAll('[data-cwk-slot="crew"] .cwk-act')].map((a) => Math.round(a.getBoundingClientRect().width)),
          titleFirst: !!(title && aside && title.getBoundingClientRect().top <= aside.getBoundingClientRect().top + 2), hdr: !!hdr };
      });
      ok('D3 Crew: the opened card is not restyled by Crew (title before the $ figure, buttons sized to their label)', crewOpen.titleFirst && crewOpen.acts.length > 0 && crewOpen.acts.every((w) => w < 300), JSON.stringify(crewOpen));
      await lp.locator('[data-cwk-slot="crew"] [data-cwk-open="0"]').click();
      await shot(lp, 'crew-1440-' + theme);

      await useLayout(lp, 'inbox');
      const ibL = await lp.evaluate(() => { const sc = document.querySelector('.ib-scroll'); const v = document.querySelector('[data-cwk-slot="inbox"] .cwk-sum-v');
        return { listTop: sc ? Math.round(sc.getBoundingClientRect().top) : 9999, oneLine: v ? v.getBoundingClientRect().height < 30 : false }; });
      ok('D4 Inbox (laptop): the reply list starts near the top and the summary stays one line', ibL.listTop < 300 && ibL.oneLine, JSON.stringify(ibL));
      await shot(lp, 'inbox-1440-' + theme);

      await useLayout(lp, 'mission');
      await lp.waitForFunction(() => !!document.querySelector('.mc-map'), null, { timeout: 20000 });
      const mcL = await lp.evaluate(() => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        const slot = document.querySelector('[data-cwk-slot="mission"]');
        return { map: Math.round(b('.mc-map').height), card: !!(slot && slot.querySelector('.cwk-card')), underLeft: b('[data-cwk-slot="mission"]').top >= b('.mc-left').bottom - 1 && Math.abs(b('[data-cwk-slot="mission"]').left - b('.mc-left').left) < 2, scrub: (document.querySelector('.mc-scrub') || { getBoundingClientRect: () => ({ height: 44 }) }).getBoundingClientRect().height };
      });
      ok('D2 Mission (laptop): full-height map, the card under the left rail; the scrubber is 44 px', mcL.map >= 400 && mcL.card && mcL.underLeft && mcL.scrub >= 44, JSON.stringify(mcL));
      await shot(lp, 'mission-1440-' + theme);

      for (const id of ['island', 'focus', 'bento', 'classic']) { await useLayout(lp, id); await shot(lp, id + '-1440-' + theme); }
      ok('no script error on the laptop walk (' + theme + ')', L.errors.length === 0, L.errors.join(' | '));
      await L.ctx.close();
    }
  } catch (e) {
    ok('the walk ran to the end', false, e && e.stack);
  } finally {
    await browser.close();
    await srv.close();
  }
  report();
})();
