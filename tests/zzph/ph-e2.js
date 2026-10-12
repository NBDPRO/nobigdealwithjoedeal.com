// UNCOMMITTED: More on Home expanded (phone) + desktop Home at 1440. PHASE=after node zzph/ph-e2.js
const L = require('./lib');
const path = require('path');
const fs = require('fs');
const OUT = path.join('C:/Users/jonat/nbd-content/phone-E-shots', process.env.PHASE || 'x');
(async () => {
  const browser = await L.launch();
  const out = {};
  for (const phone of [true, false]) {
    const ctx = await L.context(browser, phone);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await L.login(page);
    await page.waitForFunction(() => /things today|Nothing/i.test((document.querySelector('#todayPlan') || {}).innerText || ''), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500); await L.skipTour(page); if (phone) await L.standalone(page);
    const nb = page.locator('#nbd-push-optin button', { hasText: 'Not now' });
    if (await nb.isVisible().catch(() => false)) await nb.click();
    const w = page.viewportSize().width;
    const facts = () => page.evaluate(() => {
      const r = (q) => { const e = document.querySelector(q); if (!e) return 'none'; const b = e.getBoundingClientRect(); return b.height ? Math.round(b.top + scrollY) + '..' + Math.round(b.bottom + scrollY) : 'hidden'; };
      return { toggle: r('#homeMoreToggle'), widgets: r('#widgetGrid'), widgetCount: document.querySelectorAll('#widgetGrid > *').length, nns: r('#homeNoNextStep'), hdrExtra: r('#homeWeekReviewBtn'), moreActs: r('.home-more-acts'), attention: r('#homeAttention'), today: r('#todayPlan'), screens: +(document.scrollingElement.scrollHeight / innerHeight).toFixed(1), scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    out[w] = { collapsed: await facts() };
    await page.screenshot({ path: path.join(OUT, '04-home-top-' + w + '.png') });
    if (phone) {
      await page.locator('#homeMoreToggle').click();
      await page.waitForTimeout(800);
      out[w].expanded = await facts();
      await page.locator('#homeMoreToggle').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, '05-home-more-open-' + w + '.png') });
      await page.screenshot({ path: path.join(OUT, '05-home-more-open-full-' + w + '.png'), fullPage: true });
    } else {
      await page.screenshot({ path: path.join(OUT, '04-home-full-' + w + '.png'), fullPage: true });
    }
    out[w].errs = errs;
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, 'result-e2.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
