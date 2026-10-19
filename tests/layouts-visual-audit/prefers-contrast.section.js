/* prefers-contrast: more, emulated (Playwright contrast:'more'). Mission, Focus, Inbox, Crew and Field
 * had no rule for it: the next-stop and closes-week cards' edges were 1.2:1 against the page and muted
 * text 4 to 6:1. Under the OS setting the hairline and muted tokens now come from the text colour;
 * without it nothing changes. */
'use strict';
const probe = () => {
  const lx = window.__lx;
  const edge = (sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => lx.visible(e));
    if (!el) return null;
    const cs = getComputedStyle(el); const bc = lx.rgb(cs.borderTopColor); const par = lx.bgOf(el.parentElement);
    const c = { r: bc.r * bc.a + par.r * (1 - bc.a), g: bc.g * bc.a + par.g * (1 - bc.a), b: bc.b * bc.a + par.b * (1 - bc.a) };
    const x = lx.lum(c), y = lx.lum(par); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
  };
  const muted = (sel) => { const el = [...document.querySelectorAll(sel)].find((e) => lx.visible(e)); return el ? Math.round(lx.contrast(el) * 100) / 100 : null; };
  return { mq: matchMedia('(prefers-contrast: more)').matches, card: edge('.ns-card, .cwk-card'), muted: muted('.ns-addr, .ns-aside') };
};
module.exports = {
  name: 'prefers-contrast: more: card edges and muted text in Mission, Focus, Inbox, Crew, Field',
  async run({ open, useLayout, ok }) {
    for (const layout of ['mission', 'focus', 'inbox', 'crew', 'field']) {
      const P = await open({ w: 390, h: 844, touch: true, scheme: 'dark', contrast: 'more' });
      await useLayout(P.page, layout);
      const r = await P.page.evaluate(probe);
      ok(layout + ': the media query is on (the check is not vacuous)', r.mq === true);
      ok(layout + ': the next-stop / closes-week card edge reads (>= 3:1 against the page)', r.card !== null && r.card >= 3, JSON.stringify(r));
      ok(layout + ': the muted address line clears 7:1', r.muted !== null && r.muted >= 7, JSON.stringify(r));
      await P.ctx.close();
    }
    const N = await open({ w: 390, h: 844, touch: true, scheme: 'dark' });
    await useLayout(N.page, 'focus');
    const base = await N.page.evaluate(probe);
    ok('without the setting the card edge is untouched (still the soft hairline)', base.mq === false && base.card !== null && base.card < 3, JSON.stringify(base));
    await N.ctx.close();
  },
};
