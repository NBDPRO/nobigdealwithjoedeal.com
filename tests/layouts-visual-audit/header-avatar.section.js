/* Global chrome: the header avatar initial (.av) is painted ON the accent (background:var(--orange))
 * but took the inherited text colour, so on 276 of 414 theme x mode combinations it was under
 * 4.5:1 and on 137 it was under 3:1 (invisible) (Paper: a black circle with a black "P"). The engine already
 * computes --accent-fg for exactly this (white or ink, whichever reads on the accent). */
'use strict';
module.exports = {
  name: 'Global chrome: the header avatar initial reads on its accent circle',
  async run({ open, useLayout, ok }) {
    const P = await open({ w: 390, h: 844, touch: true, scheme: 'dark' });
    await useLayout(P.page, 'classic');
    await P.page.evaluate(() => (window.ScriptLoader && window.ScriptLoader.loadBundle ? window.ScriptLoader.loadBundle('theme') : null));
    await P.page.waitForFunction(() => !!window.ThemeEngine, null, { timeout: 20000 });
    const themes = ['nbd-original', 'paper', 'daylight', 'minimalist', 'terminal', 'snowfall', 'spongebob', 'typewriter', 'translucent'];
    const res = await P.page.evaluate((themes) => {
      const out = [];
      for (const mode of ['dark', 'light']) for (const th of themes) {
        window.ThemeEngine.setModePref(mode); window.ThemeEngine.apply(th, false);
        const av = document.querySelector('#userAvatar, header .av');
        if (!av) { out.push({ th, mode, r: null }); continue; }
        const cs = getComputedStyle(av);
        const f = window.__lx.rgb(cs.color), b = window.__lx.rgb(cs.backgroundColor);
        const x = window.__lx.lum(f), y = window.__lx.lum(b);
        out.push({ th, mode, r: Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100 });
      }
      return out;
    }, themes);
    ok('the avatar was found in every theme/mode', res.every((o) => o.r !== null), JSON.stringify(res.filter((o) => o.r === null)));
    const bad = res.filter((o) => o.r !== null && o.r < 3);
    ok('the avatar initial clears 3:1 on its circle (the --accent-fg floor) in every sampled theme and mode', bad.length === 0, JSON.stringify(bad));
    await P.ctx.close();
  },
};
