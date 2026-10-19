/* Bento Board, 320 px phone, Large text: the Home header's two buttons (Arrange home, New estimate)
 * both had flex-basis 0, so they could not wrap and "New estimate" ran past the screen edge. */
'use strict';
module.exports = {
  name: 'Bento Board: the Home header buttons stay on screen at 320 px with Large text',
  async run({ open, useLayout, ok, sideScroll }) {
    const P = await open({ w: 320, h: 568, touch: true, scheme: 'dark' });
    await useLayout(P.page, 'bento');
    await P.page.evaluate(() => { document.documentElement.setAttribute('data-text-size', 'large'); });
    await P.page.waitForTimeout(400);
    const r = await P.page.evaluate(() => {
      const bs = [...document.querySelectorAll('.home-hdr-acts > .btn')].filter((b) => window.__lx.visible(b));
      return { n: bs.length, right: Math.max(0, ...bs.map((b) => Math.round(b.getBoundingClientRect().right))), left: Math.min(999, ...bs.map((b) => Math.round(b.getBoundingClientRect().left))), vw: innerWidth };
    });
    ok('Home header buttons are showing (the check is not vacuous)', r.n >= 2, JSON.stringify(r));
    ok('every Home header button ends inside the screen', r.right <= r.vw, JSON.stringify(r));
    ok('Bento: nothing scrolls sideways', (await sideScroll(P.page)) === 0);
    await P.ctx.close();
  },
};
