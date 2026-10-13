// documentation/qa/today-ux-walk-2026-10-13/walk/lib.js
//
// Rig for the Today / "N people need you" phone walk (2026-10-13). NOT a CI
// spec: a repro harness. Run it against a LOCAL emulator suite only:
//
//   cd <repo> && node tests/e2e/fixtures/ensure-emulator-env.js
//   CLOUDSDK_CONFIG=<empty dir> firebase emulators:start --project nobigdeal-pro \
//     --only auth,firestore,storage,hosting,functions:callCenterAction,functions:callPromisesList,\
//   functions:callTaggedMatch,functions:onCallTaskWrite,functions:thursdayCallAction,functions:manageAway
//   node documentation/qa/today-ux-walk-2026-10-13/walk/seed.js
//   node documentation/qa/today-ux-walk-2026-10-13/walk/walk.js <scenario>
//
// Only the callables a Today control calls are loaded (no triggers that alert
// anyone). CLOUDSDK_CONFIG points at an empty dir so the functions emulator
// cannot pick up application-default credentials and reach production.
// Refuses to run unless the emulator env / localhost base URL is set.
'use strict';
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const req = createRequire(path.join(ROOT, 'tests', 'package.json'));

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE)) throw new Error('refusing: base URL is not local: ' + BASE);
process.env.PLAYWRIGHT_BASE_URL = BASE;
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const EMAIL = process.env.PLAYWRIGHT_TEST_USER_EMAIL || 'playwright-e2e@nbd.test';
const PASSWORD = process.env.PLAYWRIGHT_TEST_USER_PASSWORD || 'nbd-e2e-password-1';
const OUT = path.join(ROOT, 'documentation', 'qa', 'today-ux-walk-2026-10-13');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function admin() {
  const { initializeApp, getApps } = req('firebase-admin/app');
  const { getFirestore, FieldValue } = req('firebase-admin/firestore');
  const { getAuth } = req('firebase-admin/auth');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  return { db: getFirestore(), auth: getAuth(), FieldValue };
}

async function who() {
  const { auth } = admin();
  const user = await auth.getUserByEmail(EMAIL);
  return { uid: user.uid, co: ((user.customClaims || {}).companyId) || user.uid };
}

async function launch(opts) {
  const o = opts || {};
  const { chromium } = req('playwright-core');
  const launchOpts = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    baseURL: BASE, bypassCSP: true, serviceWorkers: 'block',
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: IPHONE_UA, colorScheme: o.dark ? 'dark' : 'light',
  });
  // Home-screen app: notch + home indicator insets (CDP, Chromium 126+).
  const page = await ctx.newPage();
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
  } catch (_) { /* older Chromium: no inset override; noted in FINDINGS */ }
  await page.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 36e5));
    } catch (e) { /* blocked */ }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'warning' && m.text().indexOf('[today]') !== -1 || m.text().indexOf('[home-attention]') !== -1) errors.push('warn: ' + m.text().slice(0, 300)); if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 300)); });
  return { browser, ctx, page, errors };
}

async function login(page) {
  const { loginAs } = require(path.join(ROOT, 'tests', 'e2e', 'fixtures', 'auth.js'));
  await loginAs(page, { email: EMAIL, password: PASSWORD });
}

// The installed app is display-mode: standalone; Chromium headless is not.
// Copy the standalone @media rules in as plain rules (the repo's own trick).
async function forceStandalone(page) {
  return page.evaluate(() => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
    }
    const s = document.createElement('style'); s.id = 'ux-walk-standalone'; s.textContent = css; document.head.appendChild(s);
    return css.length;
  });
}

async function waitToday(page, opts) {
  const o = opts || {};
  await page.waitForSelector('#todayPlan[data-tp-state="ready"]', { timeout: 40000 });
  // A fresh e2e tenant shows the owner's "Get set up" card above Today; Jo's account is past it.
  const hide = await page.$('.sc-hide');
  if (hide) { await hide.click().catch(() => {}); await page.waitForTimeout(400); }
  // home-attention boots 1.5 s after the page and Today waits for its rows.
  await page.waitForFunction(() => window.NBDHomeAttention && Array.isArray(window.NBDHomeAttention.lastRows), null, { timeout: 40000 });
  await page.waitForTimeout(o.settle == null ? 1500 : o.settle);
}

async function shot(page, name, o) {
  const opt = o || {};
  const file = path.join(OUT, name + '.png');
  if (opt.mark) {
    // numbered orange outlines so the findings can point at things
    await page.evaluate((marks) => {
      document.querySelectorAll('.uxw-mark').forEach((n) => n.remove());
      marks.forEach((m, i) => {
        const el = typeof m === 'string' ? document.querySelector(m) : null;
        if (!el) return;
        el.style.outline = '3px solid #ff7a00'; el.style.outlineOffset = '-3px';
        const b = document.createElement('div'); b.className = 'uxw-mark'; b.textContent = String(i + 1);
        const r = el.getBoundingClientRect();
        b.style.cssText = 'position:fixed;z-index:2147483647;background:#ff7a00;color:#000;font:700 13px system-ui;padding:1px 6px;border-radius:9px;left:' + Math.max(2, r.right - 22) + 'px;top:' + Math.max(2, r.top - 2) + 'px;pointer-events:none';
        document.body.appendChild(b);
      });
    }, opt.mark);
  }
  await page.screenshot({ path: file, fullPage: !!opt.full, animations: 'disabled' });
  if (opt.mark) await page.evaluate(() => { document.querySelectorAll('.uxw-mark').forEach((n) => n.remove()); document.querySelectorAll('[style*="ff7a00"]').forEach((n) => { n.style.outline = ''; n.style.outlineOffset = ''; }); });
  return file;
}

// What Today shows, as plain data (sections, row names, buttons, counts).
async function readToday(page) {
  return page.evaluate(() => {
    const el = document.getElementById('todayPlan');
    if (!el) return null;
    const txt = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
    const secs = Array.from(el.querySelectorAll('[data-tp-sec]')).map((s) => ({
      id: s.getAttribute('data-tp-sec'),
      title: txt(s.querySelector('.tp-sec-title') || s).slice(0, 60),
      rows: Array.from(s.querySelectorAll('.tp-row')).map((r) => ({
        key: r.getAttribute('data-tp-row'),
        name: txt(r.querySelector('.tp-name') || r).slice(0, 80),
        text: txt(r).slice(0, 260),
        btns: Array.from(r.querySelectorAll('.tp-btn')).map((b) => txt(b)),
      })),
    }));
    return {
      title: txt(el.querySelector('.tp-title') || el).slice(0, 80),
      total: el.querySelector('.tp-title') ? el.querySelector('.tp-title').getAttribute('data-tp-total') : null,
      banner: Array.from(el.querySelectorAll('.tp-readfail,.tp-hidden,.tp-waitquiet')).map(txt),
      strip: (document.getElementById('homeAttention') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
      sections: secs,
    };
  });
}

// Tap-target audit for Today + the strip: everything tappable under 44 px.
async function tapTargets(page, sel) {
  return page.evaluate((s) => {
    const out = [];
    document.querySelectorAll(s).forEach((e) => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      out.push({ text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + scrollY) });
    });
    return out;
  }, sel || '#todayPlan button, #todayPlan a, #todayPlan select, #homeAttention button');
}

module.exports = { ROOT, OUT, BASE, EMAIL, PASSWORD, admin, who, launch, login, forceStandalone, waitToday, shot, readToday, tapTargets };
