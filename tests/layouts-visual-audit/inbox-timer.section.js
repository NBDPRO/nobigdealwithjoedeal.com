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
        // the sample account may not hold every state: add the exact markup inbox.js writes for the missing ones
        const top = [...document.querySelectorAll('.ib-row .ib-row-top')].find((e) => window.__lx.visible(e));
        const added = [];
        for (const k of ['red', 'gold', 'green']) {
          if (!document.querySelector('.ib-row .ib-timer-' + k) && top) {
            const s = document.createElement('span'); s.className = 'ib-timer ib-timer-' + k; s.textContent = '30m left'; top.appendChild(s); added.push(s);
          }
        }
        const out = {};
        for (const k of ['red', 'gold', 'green']) {
          const el = [...document.querySelectorAll('.ib-row .ib-timer-' + k)].find((e) => window.__lx.visible(e));
          out[k] = el ? Math.round(window.__lx.contrast(el) * 100) / 100 : null;
        }
        added.forEach((s) => s.remove());
        return out;
      });
      for (const k of ['red', 'gold', 'green']) ok('Inbox (' + scheme + '): the ' + k + ' timer clears 4.5:1', r[k] !== null && r[k] >= 4.5, JSON.stringify(r));
      await P.ctx.close();
    }
  },
};
