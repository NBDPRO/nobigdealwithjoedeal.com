/* My Skin wallpaper, light mode (found on REAL uploads through the per-theme uploader, Storage emulator):
 * the frosted header and tab bar turn light (--s) but the light-mode chrome rules assume a dark bar, so
 * the wordmark was 1.05:1 and idle tab labels 2.3:1. And text with no card behind it (page subtitle,
 * Bento's "Your board", the sync status) took muted colours straight onto the picture. This test puts the
 * wallpaper classes on the sample page (the upload path itself is exercised by the audit harness). */
'use strict';
module.exports = {
  name: 'My Skin wallpaper: light-mode chrome and bare text read over a picture',
  async run({ open, useLayout, ok }) {
    const P = await open({ w: 390, h: 844, touch: true, scheme: 'light' });
    await useLayout(P.page, 'classic');
    await P.page.evaluate(() => (window.ScriptLoader && window.ScriptLoader.loadBundle ? window.ScriptLoader.loadBundle('theme') : null));
    await P.page.waitForFunction(() => !!window.ThemeEngine, null, { timeout: 20000 });
    await P.page.evaluate(() => { window.ThemeEngine.setModePref('light'); window.ThemeEngine.apply('nbd-original', false); document.documentElement.classList.add('my-skin', 'my-skin-wallpaper'); });
    await P.page.waitForTimeout(700);
    const r = await P.page.evaluate(() => {
      const c = (sel) => { const e = [...document.querySelectorAll(sel)].find((x) => window.__lx.visible(x)); return e ? Math.round(window.__lx.contrast(e) * 100) / 100 : null; };
      const sub = document.querySelector('.page-sub');
      return { mode: document.documentElement.getAttribute('data-mode'), logo: c('header .logo'), tool: c('header .hdr-tool'), tab: c('#mobile-nav .mn-item:not(.active):not(.mn-fab) .mn-lbl'),
        subShadow: sub ? getComputedStyle(sub).textShadow : null, subColor: sub ? getComputedStyle(sub).color : null, tColor: getComputedStyle(document.documentElement).getPropertyValue('--t').trim() };
    });
    ok('light mode is on', r.mode === 'light', JSON.stringify(r));
    ok('the wordmark clears 4.5:1 on the frosted header', r.logo !== null && r.logo >= 4.5, JSON.stringify(r));
    ok('the header tools clear 4.5:1', r.tool !== null && r.tool >= 4.5, JSON.stringify(r));
    ok('idle tab-bar labels clear 4.5:1', r.tab !== null && r.tab >= 4.5, JSON.stringify(r));
    ok('the page subtitle carries a halo (text-shadow) over the picture', r.subShadow !== null && r.subShadow !== 'none', JSON.stringify(r));
    await P.ctx.close();
  },
};
