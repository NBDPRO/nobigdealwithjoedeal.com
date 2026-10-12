// UNCOMMITTED proof harness for feat/phone-home-nav. PHASE=before|after node zzph/ph-e.js [phone|desk]
const L = require('./lib');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const MODE = process.argv[2] || 'phone';
const PHONE = MODE === 'phone';
const OUT = path.join('C:/Users/jonat/nbd-content/phone-E-shots', process.env.PHASE || 'x');
fs.mkdirSync(OUT, { recursive: true });
const R = { mode: MODE, phase: process.env.PHASE };

function reseed() {
  execSync('curl -s -X DELETE "http://127.0.0.1:8480/emulator/v1/projects/nobigdeal-pro/databases/(default)/documents"');
  execSync('node zzph/seed.js', { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9499', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8480', GCLOUD_PROJECT: 'nobigdeal-pro' }) });
}
async function shot(page, name, full) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name + '-' + page.viewportSize().width + '.png'), fullPage: !!full });
}
const pos = (page, sels) => page.evaluate((sels) => {
  const o = {};
  sels.forEach((q) => {
    const e = document.querySelector(q);
    if (!e) { o[q] = 'none'; return; }
    const r = e.getBoundingClientRect();
    o[q] = (r.width === 0 && r.height === 0) ? 'hidden' : { top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY), h: Math.round(r.height) };
  });
  o.__screens = +(document.scrollingElement.scrollHeight / innerHeight).toFixed(1);
  o.__vh = innerHeight;
  return o;
}, sels);

(async () => {
  reseed();
  const browser = await L.launch();
  const ctx = await L.context(browser, PHONE);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  let dialogs = 0; page.on('dialog', (d) => { dialogs++; d.accept().catch(() => {}); });
  await L.login(page);
  const t0 = Date.now();
  await page.waitForFunction(() => /things today|Nothing/i.test((document.querySelector('#todayPlan') || {}).innerText || ''), null, { timeout: 30000 }).catch(() => {});
  R.todayCardMs = Date.now() - t0;
  // wait for the needs-you strip (home-attention boots at +1.5 s)
  await page.waitForFunction(() => { const e = document.getElementById('homeAttention'); return e && !e.hidden; }, null, { timeout: 15000 }).catch(() => {});
  R.needYouMs = Date.now() - t0;
  await page.waitForTimeout(1500); await L.skipTour(page); await L.standalone(page);
  const nb = page.locator('#nbd-push-optin button', { hasText: 'Not now' });
  if (await nb.isVisible().catch(() => false)) await nb.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  R.home = await pos(page, ['#todayPlan', '#homeAttention', '#homeAttention [data-target="calls"]', '[data-tp-sec="appts"]', '[data-tp-sec="calls"]', '#homeNoNextStep', '#widgetGrid', '#homeGameCard', '#homeMoreToggle', '#mobile-nav']);
  R.homeNeedYouText = await page.locator('#homeAttention [data-target="calls"]').innerText().catch(() => null);
  await shot(page, '01-home'); await shot(page, '01-home-full', true);

  if (PHONE) {
    // More drawer → Calls / Schedule / Close Board / D2D
    await page.locator('#mni-more').click(); await page.waitForTimeout(500);
    R.more = await page.evaluate(() => {
      const out = {};
      ['calls', 'schedule', 'closeboard', 'd2d'].forEach((t) => {
        const e = document.querySelector('#mobile-more-menu [data-target="' + t + '"]');
        if (!e) { out[t] = 'none'; return; }
        const r = e.getBoundingClientRect();
        out[t] = { y: Math.round(r.top), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight, index: Array.from(document.querySelectorAll('#mobile-more-menu .mm-item')).indexOf(e) };
      });
      out.items = document.querySelectorAll('#mobile-more-menu .mm-item').length;
      out.sections = Array.from(document.querySelectorAll('#mobile-more-menu .mm-section')).map((s) => s.textContent.trim());
      return out;
    });
    await shot(page, '02-more');
    const t1 = Date.now();
    await page.locator('#mobile-more-menu [data-target="calls"]').first().click();
    await page.waitForFunction(() => { const v = document.getElementById('view-calls'); return v && v.classList.contains('active'); }, null, { timeout: 15000 }).catch(() => {});
    R.moreToCalls = { taps: 2, ms: Date.now() - t1 };
  }

  // Stage move on Dana's page (inspected → next)
  await page.goto(L.BASE + '/pro/customer.html?id=pa-dana');
  await page.waitForFunction(() => document.documentElement.style.opacity === '1', null, { timeout: 30000 });
  await L.standalone(page); await L.skipTour(page);
  const before = await page.evaluate(() => window._currentStage || (window._currentLead || {}).stage);
  const btn = page.locator('#stageProgressBtn');
  await btn.scrollIntoViewIfNeeded();
  const t2 = Date.now();
  let taps = 1; dialogs = 0;
  await btn.click();
  const ok = page.locator('.sa-btn-ok');
  if (await ok.isVisible({ timeout: 1500 }).catch(() => false)) { await shot(page, '03-stage-confirm'); await ok.click(); taps++; }
  await page.waitForFunction((b) => (window._currentStage && window._currentStage !== b), before, { timeout: 15000 }).catch(() => {});
  const after = await page.evaluate(() => window._currentStage);
  await page.waitForTimeout(300);
  const undo = await page.locator('#toastContainer button', { hasText: 'Undo' }).isVisible().catch(() => false);
  await shot(page, '03-stage-after');
  R.stageMove = { before, after, taps: taps + dialogs, nativeDialogs: dialogs, ms: Date.now() - t2, undoShown: undo };
  if (undo) {
    await page.locator('#toastContainer button', { hasText: 'Undo' }).click();
    await page.waitForFunction((b) => window._currentStage === b, before, { timeout: 15000 }).catch(() => {});
    R.stageMove.afterUndo = await page.evaluate(() => window._currentStage);
    R.stageMove.storedAfterUndo = await page.evaluate(async () => { const s = await window.getDoc(window.doc(window.db, 'leads', 'pa-dana')); return s.data().stage; });
  }
  R.errs = errs; R.fnCalls = L.fnCalls.length; R.blocked = L.blocked.length;
  fs.writeFileSync(path.join(OUT, 'result-' + MODE + '.json'), JSON.stringify(R, null, 2));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
