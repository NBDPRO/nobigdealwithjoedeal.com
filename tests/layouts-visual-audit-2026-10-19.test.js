/* tests/layouts-visual-audit-2026-10-19.test.js
 *
 * The overnight visual audit of every CRM layout (2026-10-19), checked as
 * PAINTED. The real dashboard on the sample account (/pro/explore, nothing
 * leaves 127.0.0.1; the same server and setup as crm-layouts-render-2026-10-15),
 * in Chromium at the size and colour scheme each defect showed up in.
 *
 * Each cluster of fixes adds ONE file to tests/layouts-visual-audit/
 * (<cluster>.section.js, loaded in name order) and touches nothing here, so
 * small PRs never collide. A section exports { name, run(env) }:
 *   env.open({ w, h, touch, scheme })  -> { ctx, page, errors }   (the sample account, layouts hydrated)
 *   env.useLayout(page, id)            -> settles that layout on the sample account
 *   env.ok(name, cond, detail)         -> an assertion
 *   env.sideScroll(page)               -> px the document scrolls sideways
 *   window.__lx (in the page)          -> contrast / visible / rgb helpers
 *
 * Wired in .github/workflows/ci.yml next to the layouts render check.
 * Locally it SKIPS when playwright is not resolvable (under CI=true that is a
 * failure). PW_CHROMIUM_PATH=<chrome.exe> runs it on an installed Chrome.
 */
'use strict';

const fs = require('fs');
const path = require('path');
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

// in the page: contrast of an element's text against what is behind it
function pageHelpers() {
  window.__lx = {
    rgb(s) {
      const str = String(s);
      const c = str.match(/color\(srgb ([^)]+)\)/);
      if (c) { const p = c[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
      const m = str.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    },
    lum(c) { const n = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * n(c.r) + 0.7152 * n(c.g) + 0.0722 * n(c.b); },
    bgOf(el) {
      const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
      let base = { r: 255, g: 255, b: 255 };
      const rb = this.rgb(getComputedStyle(document.documentElement).backgroundColor);
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
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});

  async function open(o) {
    const w = o.w || 1440, h = o.h || 900;
    const ctx = await browser.newContext(Object.assign({
      viewport: { width: w, height: h }, serviceWorkers: 'allow', colorScheme: o.scheme || 'dark', contrast: o.contrast || 'no-preference',
    }, o.touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
    await ctx.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN + '/')) return route.continue();
      if (FONT_HOST.test(u)) return route.fulfill({ status: 200, contentType: /googleapis/.test(u) ? 'text/css' : 'font/woff2', body: '' });
      return route.abort('blockedbyclient');
    });
    await ctx.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await ctx.addInitScript(pageHelpers);
    if (o.init) await ctx.addInitScript(o.init);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
    await page.goto(ORIGIN + '/pro/explore');
    await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 30000 });
    await page.waitForFunction(() => Array.isArray(window._leads) && window._leads.length >= 20 && window._leadsLoaded === true && !!window.LayoutEngine, null, { timeout: 40000 });
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
    await page.waitForFunction(() => !!document.querySelector('.cwk-card'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  const sideScroll = (page) => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));

  try {
    const dir = path.join(__dirname, 'layouts-visual-audit');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.section\.js$/.test(f)).sort() : [];
    ok('at least one audit section is present', files.length > 0);
    for (const f of files) {
      const sec = require(path.join(dir, f));
      console.log('\n' + (sec.name || f));
      await sec.run({ open, useLayout, ok, sideScroll, ORIGIN });
    }
  } catch (e) {
    ok('the walk ran to the end', false, e && e.stack);
  } finally {
    await browser.close();
    await srv.close();
  }
  report();
})();
