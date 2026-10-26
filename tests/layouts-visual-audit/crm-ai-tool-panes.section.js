/* The four AI tool pages (AI Usage, Decision Engine, Understand, Project Codex), found by the 2026-10-26 overnight
 * audit and checked as PAINTED:
 *  - crm-1  inside the dashboard each is an iframe, and the tool's own "Back to Dashboard" / Decision Engine nav
 *           links navigate the FRAME to /pro/dashboard or /pro/login, which are served frame-ancestors 'none'
 *           (a blank pane, chrome-error://). Framed, the pages now drop that chrome (html.nbd-embedded).
 *  - crm-3  the greys picked for a near-black page (#4A5568, #6B7280) were painted on the navy theme background:
 *           1.7:1 to 2.8:1, and small brand-orange text on navy is 2.83:1. Tertiary text is the theme's muted
 *           colour and small orange text is the brand light orange (#DD875F, 4.77:1 on the navy).
 *  - crm-9  Project Codex scrolled sideways on a phone (90 to 200 px: the page is a flex item of the site-wide flex-column
 *           <body>, so it shrink-wrapped its widest row, the scrolling tab strip) and Daily Success by up to 68 px (the
 *           "Open notebook" button text spilled out of a squeezed button, and a 1fr grid track could not shrink). */
'use strict';

const VIEWS = [
  { view: 'aitree', frame: 'iframe-aitree', route: 'ai-tree' },
  { view: 'understand', frame: 'iframe-understand', route: 'understand' },
  { view: 'projectcodex', frame: 'iframe-projectcodex', route: 'project-codex' },
  { view: 'aiusage', frame: 'iframe-aiusage', route: 'analytics' },
];
const ratioOf = (r) => Math.round(r * 100) / 100;

module.exports = {
  name: 'AI tool pages: no dead-end links in the dashboard panes, readable text on navy, nothing scrolls sideways',
  async run({ open, ok, ORIGIN }) {
    const P = await open({ w: 1280, h: 800, scheme: 'dark' });
    const page = P.page;

    // The page is hidden (visibility:hidden on <html>) until the sample account's gate has run.
    const settle = async (target) => {
      await target.waitForFunction(() => location.href.indexOf('about:blank') === -1 && document.readyState === 'complete' && getComputedStyle(document.documentElement).visibility === 'visible', null, { timeout: 25000 });
      await page.waitForTimeout(300);
    };
    const visibleLinks = () => [...document.querySelectorAll('a[href]')]
      .filter((a) => { const b = a.getBoundingClientRect(), s = getComputedStyle(a); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })
      .map((a) => ({ t: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24), h: a.getAttribute('href') }));

    // ── crm-1: panes inside the dashboard ──
    for (const v of VIEWS) {
      await page.evaluate((view) => window.goTo(view), v.view);
      const fr = await (await page.waitForSelector('#' + v.frame, { state: 'attached', timeout: 15000 })).contentFrame();
      await page.waitForFunction((id) => { const f = document.getElementById(id); try { return !!f && !!f.contentWindow && f.contentWindow.location.href.indexOf('about:blank') === -1; } catch (_) { return false; } }, v.frame, { timeout: 25000 });
      await settle(fr);
      const embedded = await fr.evaluate(() => document.documentElement.classList.contains('nbd-embedded'));
      ok(v.route + ' framed in the dashboard: html.nbd-embedded is set', embedded);
      const links = await fr.evaluate(visibleLinks);
      ok(v.route + ' framed: no link is left to navigate the pane (' + links.length + ' visible)', links.length === 0, JSON.stringify(links));
      // Whatever link a pane does show must still land on a page, not on the browser's refused-to-connect page.
      const landed = [];
      for (let i = 0; i < Math.min(links.length, 14); i++) {
        await page.evaluate((id) => { const f = document.getElementById(id); f.src = f.getAttribute('src'); }, v.frame);
        await page.waitForTimeout(400);
        await settle(fr).catch(() => {});
        try { await fr.locator('a[href]:visible').nth(i).click({ timeout: 2500 }); } catch (_) { continue; }
        await page.waitForTimeout(1500);
        const url = (await (await page.$('#' + v.frame)).contentFrame()).url();
        if (/^chrome-error:/.test(url) || url === 'about:blank') landed.push(links[i].t + ' -> ' + url);
      }
      ok(v.route + ' framed: no link lands the pane on a blank / refused page', landed.length === 0, landed.join('\n       '));
    }
    // The Saved button is the page's own tool, not a way out: it stays.
    {
      await page.evaluate(() => { window.goTo('understand'); const f = document.getElementById('iframe-understand'); f.src = f.getAttribute('src'); });
      const fr = await (await page.waitForSelector('#iframe-understand', { state: 'attached' })).contentFrame();
      await page.waitForTimeout(400);
      await settle(fr);
      const saved = await fr.evaluate(() => { const b = document.querySelector('.tb-saved'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      ok('understand framed: the Saved Insights button is still reachable', saved);
      if (saved) {
        await fr.locator('.tb-saved').click();
        await page.waitForTimeout(500);
        ok('understand framed: Saved opens the Saved Insights panel', await fr.evaluate(() => document.getElementById('siPanel').classList.contains('open')));
      }
    }
    // Opened on its own the page keeps its bar and its links (nothing changes outside the dashboard).
    for (const [route, sel] of [['understand', '.tb-back'], ['project-codex', '.tb-back'], ['ai-tree', '#nbd-pro-nav .nnav-link']]) {
      await page.goto(ORIGIN + '/pro/explore/' + route);
      await settle(page);
      const r = await page.evaluate((s) => { const e = document.querySelector(s); const b = e && e.getBoundingClientRect(); return { embedded: document.documentElement.classList.contains('nbd-embedded'), shown: !!b && b.width > 0 && b.height > 0 }; }, sel);
      ok(route + ' standalone: no nbd-embedded class and the top bar link ' + sel + ' still shows', !r.embedded && r.shown, JSON.stringify(r));
    }

    // ── crm-3: text on the navy ──
    const PAGES = {
      analytics: { path: 'analytics', sel: ['.tt:not(.active)', '#lReq', '#mReq', '.sc-label', '.ph-sub', '.ph-eyebrow', '.tbl th', '.chart-label', '.price-row', '#lastRefresh'] },
      'ai-tree': { path: 'ai-tree', sel: ['.page-eyebrow', '.cat-desc', '.history-title', '.history-empty'] },
      understand: { path: 'understand', sel: ['.hero-ey', '.path-desc', '.hero-sub', '.tb-back', '.tb-saved'] },
      'project-codex': { path: 'project-codex', sel: ['.sec-ey', '.sec-sub', '.tab', '.tl-empty'], after: 'codex' },
    };
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [name, def] of Object.entries(PAGES)) {
        await page.goto(ORIGIN + '/pro/explore/' + def.path);
        await settle(page);
        if (def.after === 'codex') {
          await page.selectOption('#projSelect', { index: 1 });
          await page.waitForTimeout(700);
          def.sel = ['.sec-ey', '.sec-sub', '.tab:not(.on)', '.tab.on', '.stat-lbl', '.tl-date', '.proj-refresh', '.tl-type.note'];
        }
        const res = await page.evaluate((sels) => sels.map((s) => {
          const el = [...document.querySelectorAll(s)].find((e) => window.__lx.visible(e) || e.getBoundingClientRect().width > 0);
          return { s, ratio: el ? Math.round(window.__lx.contrast(el) * 100) / 100 : null };
        }), def.sel);
        const missing = res.filter((r) => r.ratio === null).map((r) => r.s);
        const low = res.filter((r) => r.ratio !== null && r.ratio < 4.5).map((r) => r.s + ' ' + r.ratio);
        ok(name + ' (' + scheme + ' scheme): every probe element is on screen', missing.length === 0, missing.join(', '));
        ok(name + ' (' + scheme + ' scheme): tertiary and small orange text clear 4.5:1 on the navy', low.length === 0, low.join('\n       '));
      }
    }
    // The headline accent words stay the brand orange at display size (>= 40 px) and the hover state is not the old orange.
    {
      await page.goto(ORIGIN + '/pro/explore/understand');
      await settle(page);
      const hl = await page.evaluate(() => { const e = document.querySelector('.hero-h .hl'); const s = getComputedStyle(e); return { color: s.color, fs: parseFloat(s.fontSize) }; });
      ok('understand: the headline accent word stays brand orange rgb(189, 87, 40) at display size', hl.color === 'rgb(189, 87, 40)' && hl.fs >= 40, JSON.stringify(hl));
    }

    // ── crm-9: nothing scrolls sideways on a phone ──
    const side = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;
    for (const route of ['project-codex', 'daily-success']) {
      const bad = [];
      for (const w of [320, 360, 390, 430]) {
        await page.setViewportSize({ width: w, height: 844 });
        await page.goto(ORIGIN + '/pro/explore/' + route);
        await settle(page);
        if (route === 'project-codex') { await page.selectOption('#projSelect', { index: 1 }); await page.waitForTimeout(700); }
        const px = await page.evaluate(side);
        if (px !== 0) bad.push(w + ' px: ' + px);
      }
      ok(route + ': no sideways scroll at 320 / 360 / 390 / 430', bad.length === 0, bad.join(', '));
    }
    // Project Codex framed in the dashboard (the route the audit measured) at 320 and 390.
    {
      const bad = [];
      for (const w of [320, 390]) {
        await page.setViewportSize({ width: w, height: 844 });
        await page.goto(ORIGIN + '/pro/explore/dashboard');
        await page.waitForFunction(() => typeof window.goTo === 'function' && Array.isArray(window._leads) && window._leads.length >= 20, null, { timeout: 40000 });
        await page.evaluate(() => window.goTo('projectcodex'));
        const fr = await (await page.waitForSelector('#iframe-projectcodex', { state: 'attached' })).contentFrame();
        await page.waitForFunction(() => { const f = document.getElementById('iframe-projectcodex'); try { return f.contentWindow.location.href.indexOf('about:blank') === -1; } catch (_) { return false; } }, null, { timeout: 25000 });
        await settle(fr);
        await fr.selectOption('#projSelect', { index: 1 });
        await page.waitForTimeout(700);
        const px = await fr.evaluate(side);
        if (px !== 0) bad.push(w + ' px: ' + px);
      }
      ok('project-codex framed in the dashboard: no sideways scroll at 320 / 390', bad.length === 0, bad.join(', '));
    }
    await P.ctx.close();
  },
};
