/* Global chrome contrast (found by the audit's DOM sweep over 12 themes x 2 modes):
 *  - "Sign Out" in the always-dark header took the theme's muted text colour, which in LIGHT mode is
 *    a dark slate: 1.5:1 on the dark bar (hdr-tool and the logo already had light-mode rules).
 *  - the red count badges (sidebar Pipeline, bottom-nav CRM) painted --t on --red: the theme's text
 *    colour is dark in light mode and ~3.6:1 on red; white on the badge red is 4.8:1. */
'use strict';
const need = async (P) => {
  await P.page.evaluate(() => (window.ScriptLoader && window.ScriptLoader.loadBundle ? window.ScriptLoader.loadBundle('theme') : null));
  await P.page.waitForFunction(() => !!window.ThemeEngine, null, { timeout: 20000 });
};
module.exports = {
  name: 'Global chrome: Sign Out and the red count badges are readable in every mode',
  async run({ open, useLayout, ok }) {
    const D = await open({ w: 1440, h: 900, scheme: 'dark' });
    await useLayout(D.page, 'classic'); await need(D);
    const dr = {};
    for (const mode of ['dark', 'light']) {
      await D.page.evaluate((m) => { window.ThemeEngine.setModePref(m); window.ThemeEngine.apply('nbd-original', false); }, mode);
      await D.page.waitForTimeout(600); // .so and friends transition colour over 200 ms
      dr[mode] = await D.page.evaluate(() => {
        const so = document.querySelector('button.so'), b = document.getElementById('leadBadge');
        return { so: so && window.__lx.visible(so) ? Math.round(window.__lx.contrast(so) * 100) / 100 : null, badge: b && window.__lx.visible(b) ? Math.round(window.__lx.contrast(b) * 100) / 100 : null };
      });
    }
    for (const mode of ['dark', 'light']) {
      ok('Sign Out is showing (' + mode + ')', dr[mode].so !== null, JSON.stringify(dr));
      ok('Sign Out clears 4.5:1 on the header (' + mode + ')', dr[mode].so !== null && dr[mode].so >= 4.5, JSON.stringify(dr));
      ok('the sidebar Pipeline badge clears 4.5:1 (' + mode + ')', dr[mode].badge !== null && dr[mode].badge >= 4.5, JSON.stringify(dr));
    }
    await D.ctx.close();
    const M = await open({ w: 390, h: 844, touch: true, scheme: 'dark' });
    await useLayout(M.page, 'classic'); await need(M);
    const mr = {};
    for (const mode of ['dark', 'light']) {
      await M.page.evaluate((m) => { window.ThemeEngine.setModePref(m); window.ThemeEngine.apply('nbd-original', false); }, mode);
      await M.page.waitForTimeout(600);
      mr[mode] = await M.page.evaluate(() => { const b = document.getElementById('mni-crm-badge'); return b && window.__lx.visible(b) ? Math.round(window.__lx.contrast(b) * 100) / 100 : null; });
    }
    for (const mode of ['dark', 'light']) ok('the bottom-nav CRM badge clears 4.5:1 (' + mode + ')', mr[mode] !== null && mr[mode] >= 4.5, JSON.stringify(mr));
    await M.ctx.close();
  },
};
