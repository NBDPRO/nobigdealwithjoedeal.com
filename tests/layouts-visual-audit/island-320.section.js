/* Island Dock at 320 px: the six pill labels ran into each other ("PipelineSchedule") and the
 * dock's last button ended past the bar's edge. */
'use strict';
module.exports = {
  name: 'Island Dock: the pill and the dock fit a 320 px phone',
  async run({ open, useLayout, ok, sideScroll }) {
    const P = await open({ w: 320, h: 568, touch: true, scheme: 'dark' });
    await useLayout(P.page, 'island');
    await P.page.waitForSelector('.isl-pill-in .isl-item', { timeout: 15000 });
    const r = await P.page.evaluate(() => {
      const box = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, h: b.height }; };
      const lbls = [...document.querySelectorAll('.isl-pill-in .isl-lbl')].filter((e) => e.getBoundingClientRect().width > 4).map((e) => ({ ...box(e), clipped: e.scrollWidth > e.clientWidth + 1, t: e.textContent.trim() }));
      let overlap = [];
      for (let i = 1; i < lbls.length; i++) if (lbls[i].l < lbls[i - 1].r - 0.5) overlap.push(lbls[i - 1].t + '/' + lbls[i].t);
      const inb = document.querySelector('.isl-dock-in'); const ib = inb.getBoundingClientRect();
      const dock = [...document.querySelectorAll('.isl-dock .isl-item')].map(box);
      return { shown: lbls.length, overlap, clipped: lbls.filter((l) => l.clipped).map((l) => l.t), dockRight: Math.round(ib.right), dockLeft: Math.round(ib.left), lastRight: Math.round(Math.max(...dock.map((d) => d.r))), small: dock.filter((d) => d.w < 44 || d.h < 44).length, vw: innerWidth };
    });
    ok('some pill label is still showing (the active tab keeps its word)', r.shown >= 1, JSON.stringify(r));
    ok('no two pill labels overlap', r.overlap.length === 0, JSON.stringify(r));
    ok('no pill label is cut off', r.clipped.length === 0, JSON.stringify(r));
    ok('the dock bar sits inside the screen', r.dockLeft >= 0 && r.dockRight <= r.vw, JSON.stringify(r));
    ok('every dock button ends inside its bar', r.lastRight <= r.dockRight - 3, JSON.stringify(r));
    ok('every dock button is still >= 44 px', r.small === 0, JSON.stringify(r));
    ok('Island: nothing scrolls sideways at 320', (await sideScroll(P.page)) === 0);
    await P.ctx.close();
  },
};
