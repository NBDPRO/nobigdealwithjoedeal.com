/* Global chrome (phones): the header icon buttons are 40x40 and the What's New bell 41x36, under
 * the 44 px floor every phone control holds to. The Settings pill already fixes this with an
 * invisible 44x44 ::after; the icon buttons get the same, so nothing paints differently. */
'use strict';
module.exports = {
  name: 'Global chrome: header icon buttons have a 44 px touch target on a phone',
  async run({ open, useLayout, ok }) {
    const P = await open({ w: 390, h: 844, touch: true, scheme: 'dark' });
    await useLayout(P.page, 'classic');
    await P.page.waitForSelector('#nbd-whats-new-bell', { timeout: 20000 }).catch(() => {});
    const r = await P.page.evaluate(() => {
      const els = [...document.querySelectorAll('header .hdr-tool, #nbd-whats-new-bell')].filter((e) => window.__lx.visible(e));
      const bad = [];
      for (const el of els) {
        const b = el.getBoundingClientRect(); const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        for (const [dx, dy] of [[-21, -21], [21, -21], [-21, 21], [21, 21]]) {
          const hit = document.elementFromPoint(cx + dx, cy + dy);
          if (!hit || !(hit === el || el.contains(hit))) { bad.push((el.id || el.className) + ' @' + dx + ',' + dy + ' -> ' + (hit && (hit.id || hit.className))); break; }
        }
      }
      return { n: els.length, bad };
    });
    ok('the header icon buttons are found', r.n >= 3, JSON.stringify(r));
    ok('every header icon button answers a tap within 21 px of its centre in all four corners', r.bad.length === 0, JSON.stringify(r));
    await P.ctx.close();
  },
};
