/* Pipeline board: the header title ("PIPELINE", 14 px in the brand orange, 3.2:1 on navy; the layouts
 * audit already moved accent TEXT to --ui-accent-text everywhere else) and the empty-column line
 * ("Drop leads here", muted text at opacity .6, 2.3:1). */
'use strict';
module.exports = {
  name: 'Pipeline: the header title and the empty-column line are readable',
  async run({ open, ok }) {
    for (const scheme of ['dark', 'light']) {
      const P = await open({ w: 390, h: 844, touch: true, scheme });
      await P.page.evaluate(() => { localStorage.setItem('nbd-crm-view-mode', 'board'); window.goTo('crm'); });
      await P.page.waitForSelector('.crm-hdr-title', { timeout: 20000 }).catch(() => {});
      await P.page.waitForTimeout(1500);
      const r = await P.page.evaluate(() => {
        const c = (sel) => { const e = [...document.querySelectorAll(sel)].find((x) => window.__lx.visible(x)); return e ? Math.round(window.__lx.contrast(e) * 100) / 100 : null; };
        // the sample board may have no empty column: add the exact markup the board writes for one
        let added = null; let empty = c('.k-empty-line');
        if (empty === null) {
          const col = [...document.querySelectorAll('.kcol-body')].find((x) => window.__lx.visible(x));
          if (col) { added = document.createElement('div'); added.className = 'k-empty'; added.innerHTML = '<div class="k-empty-line">Drop leads here</div>'; col.insertBefore(added, col.firstChild); empty = c('.k-empty-line'); }
        }
        if (added) added.remove();
        return { title: c('.crm-hdr-title'), empty };
      });
      ok('Pipeline (' + scheme + '): the title clears 4.5:1', r.title !== null && r.title >= 4.5, JSON.stringify(r));
      ok('Pipeline (' + scheme + '): the empty-column line clears 4.5:1', r.empty !== null && r.empty >= 4.5, JSON.stringify(r));
      await P.ctx.close();
    }
  },
};
