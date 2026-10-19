/* Triage Inbox: the reply-by timer chips. The red one already reads (--ui-danger-text, #2490); the
 * green ("30m left") and gold ones were plain --green / --gold: 2.7:1 on a light row. */
'use strict';
module.exports = {
  name: 'Triage Inbox: every reply-by timer chip clears 4.5:1',
  async run({ open, useLayout, ok }) {
    for (const scheme of ['light', 'dark']) {
      const P = await open({ w: 1440, h: 900, scheme });
      await useLayout(P.page, 'inbox');
      await P.page.waitForSelector('.ib-row', { timeout: 20000 }).catch(() => {});
      const r = await P.page.evaluate(() => {
        // The sample account may not hold every timer state (or any row at all). Real chips are measured when they
        // render; a missing state is seeded DETERMINISTICALLY: one throwaway row with the exact markup inbox.js writes
        // (rowHtml + chipHtml), prepended to the list and scrolled into view so it is on screen. No list = no seed.
        const list = document.querySelector('.ib-scroll');
        const seeded = [];
        const seed = (k) => {
          if (!list) return;
          const row = document.createElement('button'); row.type = 'button'; row.className = 'ib-row';
          row.innerHTML = '<span class="ib-row-top"><span class="ib-dot" aria-hidden="true"></span><span class="ib-name">Sample</span>' +
            '<span class="ib-timer ib-timer-' + k + '" data-ib-timer>30m left</span></span>';
          list.insertBefore(row, list.firstChild); seeded.push(row);
          row.scrollIntoView({ block: 'nearest' });
        };
        const out = {};
        let skipped = 0;
        for (const k of ['red', 'gold', 'green']) {
          let el = [...document.querySelectorAll('.ib-row .ib-timer-' + k)].find((e) => window.__lx.visible(e));
          if (!el) { seed(k); el = [...document.querySelectorAll('.ib-row .ib-timer-' + k)].find((e) => window.__lx.visible(e)); }
          if (el) out[k] = Math.round(window.__lx.contrast(el) * 100) / 100;
          else { out[k] = null; skipped++; }
        }
        seeded.forEach((s) => s.remove());
        return { out, skipped, hasList: !!list };
      });
      // A chip that could not be rendered AND could not be seeded (no inbox list on screen) is skipped, not failed:
      // the layout render sections already fail when the inbox does not mount. A chip that renders must still clear 4.5.
      for (const k of ['red', 'gold', 'green']) {
        const v = r.out[k];
        ok('Inbox (' + scheme + '): the ' + k + ' timer clears 4.5:1' + (v === null ? ' (skipped: no ' + k + ' chip rendered and no list to seed one into)' : ''), v === null ? !r.hasList : v >= 4.5, JSON.stringify(r));
      }
      await P.ctx.close();
    }
  },
};
