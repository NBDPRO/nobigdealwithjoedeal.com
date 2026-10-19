/* Map cluster: Leaflet's attribution strip on the layouts' own map (Mission Control,
 * the job map). mapview.css restyles it with `.nbd-mv .leaflet-control-attribution`
 * (0,2,0), but leaflet.css loads AFTER the layout's sheet with the same weight and
 * kept its white 80% background, so the strip painted the muted theme grey (#9ca3af)
 * on white (~2.5:1) in every theme. */
'use strict';
module.exports = {
  name: 'Map cluster: the attribution strip is readable on the layouts\' map',
  async run({ open, useLayout, ok }) {
    for (const scheme of ['dark', 'light']) {
      const P = await open({ w: 1440, h: 900, scheme });
      await useLayout(P.page, 'mission');
      await P.page.waitForSelector('.mc-map .leaflet-control-attribution', { timeout: 20000 });
      const r = await P.page.evaluate(() => {
        const box = document.querySelector('.mc-map .leaflet-control-attribution');
        const a = box.querySelector('a');
        return { box: Math.round(window.__lx.contrast(box) * 100) / 100, link: a ? Math.round(window.__lx.contrast(a) * 100) / 100 : null, bg: getComputedStyle(box).backgroundColor };
      });
      ok('Mission (' + scheme + '): attribution text clears 4.5:1 against its strip', r.box >= 4.5, JSON.stringify(r));
      ok('Mission (' + scheme + '): the attribution link clears 4.5:1 too', r.link === null || r.link >= 4.5, JSON.stringify(r));
      await P.ctx.close();
    }
  },
};
