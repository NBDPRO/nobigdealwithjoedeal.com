// UNCOMMITTED proof harness for feat/phone-estimate-from-lead. PHASE=before|after node zzph/ph-d.js [phone|desk]
const L = require('./lib');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const MODE = process.argv[2] || 'phone';
const PHONE = MODE === 'phone';
const OUT = path.join('C:/Users/jonat/nbd-content/phone-D-shots', process.env.PHASE || 'x');
fs.mkdirSync(OUT, { recursive: true });

function reseed() {
  execSync('curl -s -X DELETE "http://127.0.0.1:8480/emulator/v1/projects/nobigdeal-pro/databases/(default)/documents"');
  execSync('node zzph/seed.js', { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9499', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8480', GCLOUD_PROJECT: 'nobigdeal-pro' }) });
}
async function shot(page, name) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, name + '-' + page.viewportSize().width + '.png') });
}

(async () => {
  reseed();
  const browser = await L.launch();
  const ctx = await L.context(browser, PHONE);
  await ctx.route('**/createDealAcceptToken**', (r) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const token = 'tok-ph-' + Date.now();
    return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ result: { token, acceptUrl: 'http://127.0.0.1:5500/deal/' + token, expiresAt: Date.now() + 864e5 } }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  let taps = 0; const steps = [];
  page.on('dialog', (d) => { taps++; steps.push('dialog: ' + d.message().slice(0, 60)); d.accept().catch(() => {}); });
  const tap = async (loc, label) => { taps++; steps.push(label); await loc.click({ timeout: 15000 }); };
  await L.login(page);
  await page.goto(L.BASE + '/pro/customer.html?id=pa-dana');
  await page.waitForFunction(() => document.documentElement.style.opacity === '1', null, { timeout: 30000 });
  if (PHONE) await L.standalone(page); await L.skipTour(page);
  const R = { mode: MODE, phase: process.env.PHASE };
  const b = page.locator('button[data-action="_openInDashboardEstimate"]').first();
  await b.scrollIntoViewIfNeeded();
  const t0 = Date.now();
  await tap(b, 'Build Estimate');
  await page.waitForSelector('#estV2Modal.open', { timeout: 30000 });
  await page.waitForFunction(() => { const t = document.querySelector('#estV2Modal .v3-title'); return t && t.textContent.trim() && !/customer/i.test(t.textContent); }, null, { timeout: 15000 }).catch(() => {});
  R.wizardOpenMs = Date.now() - t0;
  R.openUrl = page.url().replace(L.BASE, '');
  if (PHONE) await L.standalone(page);
  const titles = [];
  let presetSeenOnScope = false;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(400);
    const title = (await page.locator('#estV2Modal .v3-title').innerText().catch(() => '?')).trim();
    const count = (await page.locator('#estV2Modal .v3-count').innerText().catch(() => '')).trim();
    titles.push(title + ' ' + count);
    await shot(page, 'wiz-' + String(i).padStart(2, '0') + '-' + title.replace(/\W+/g, '_'));
    if (/^measure/i.test(title)) {
      const sq = page.locator('#v2rawSqft');
      if (await sq.isVisible().catch(() => false)) { await tap(sq, 'sqft'); await sq.fill('2400'); await sq.dispatchEvent('input'); }
    }
    if (/shingle/i.test(title)) {
      presetSeenOnScope = await page.locator('#estV2Modal .v2-preset-btns').isVisible().catch(() => false);
    }
    if (/^package/i.test(title)) {
      const pre = page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]');
      if (await pre.isVisible().catch(() => false)) { await tap(pre, 'Standard re-roof preset'); await page.waitForTimeout(500); }
      const tier = page.locator('#estV2Modal .v3-pkg .v3-tier[data-v3-val="better"]');
      if (await tier.isVisible().catch(() => false)) { await tap(tier, 'Better tier'); await page.waitForTimeout(400); }
      const skip = page.locator('#estV2Modal [data-v3-act="looks-right"]');
      if (await skip.isVisible().catch(() => false)) { await shot(page, 'wiz-package-looks-right'); await tap(skip, 'Looks right → Review'); continue; }
    }
    if (/^finish/i.test(title)) break;
    await tap(page.locator('#estV2Modal .v3-next'), 'Next (' + title + ')');
  }
  R.steps = titles;
  R.presetShownAgainOnScope = presetSeenOnScope;
  R.total = (await page.locator('#v2total').innerText().catch(() => '?')).trim();
  await tap(page.locator('#v2sendHoBtn'), 'Send to homeowner');
  await page.waitForFunction(() => /ready/i.test((document.getElementById('v2shareStatus') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => {});
  await shot(page, 'sent');
  R.shared = await page.evaluate(() => window.__shared && window.__shared.url);
  R.tapsToSend = taps;
  // Close the wizard: where does Jo land?
  const close = page.locator('#estV2Modal .v2-close').first();
  R.closeLabel = (await close.innerText().catch(() => '')).trim();
  const t1 = Date.now();
  await tap(close, 'close wizard');
  await page.waitForTimeout(400);
  await page.waitForURL(/customer/, { timeout: 8000 }).catch(() => {});
  if (/customer/.test(page.url())) {
    await page.waitForFunction(() => document.documentElement.style.opacity === '1', null, { timeout: 30000 }).catch(() => {});
    R.backOnLeadMs = Date.now() - t1;
  }
  R.landedOn = page.url().replace(L.BASE, '');
  await shot(page, 'after-close');
  R.tapsRoundTrip = taps + (/customer/.test(page.url()) ? 0 : 3); // back to the lead by hand: CRM tab, find, card
  R.errs = errs; R.fnCalls = L.fnCalls.slice(); R.blocked = L.blocked.length; R.tapLog = steps;
  fs.writeFileSync(path.join(OUT, 'result-' + MODE + '.json'), JSON.stringify(R, null, 2));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
