#!/usr/bin/env node
/**
 * scripts/audit/harness.js — drive the CRM in the local emulator harness and
 * record, per route: console errors, page errors, failed requests, a 390px and
 * a 1440px screenshot, an axe-core WCAG A/AA summary, horizontal overflow at
 * 390px, and undersized tap targets. Read-only: it only navigates and reads.
 *
 * Prereqs: node scripts/audit/emulators.js running; seed applied
 * (scripts/audit/seed-audit-tenants.js). Talks ONLY to 127.0.0.1.
 *
 * Usage:
 *   node scripts/audit/harness.js --user owner@a.test --routes "/pro/dashboard.html#/crm,/pro/customer.html?id=audit-a-01"
 *   node scripts/audit/harness.js --user owner@b.test --routes-file overnight/crm/routes.txt --out overnight/crm/harness-runs/b
 *   flags: --no-shots  --no-axe  --base http://127.0.0.1:5000  --wait 2500  --eval "<js expr run after load>"
 *
 * Writes <out>/results.json and <out>/<slug>-390.png / -1440.png (screenshots
 * are JPEG-quality PNGs clipped to the viewport; keep them out of commits
 * unless < 200 KB).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..', '..');
const treq = createRequire(path.join(ROOT, 'tests', 'package.json'));
const { chromium } = treq('playwright');
const AxeBuilder = treq('@axe-core/playwright').default;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const BASE = String(arg('base', 'http://127.0.0.1:5000')).replace(/\/$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) { console.error('REFUSING: --base must be a loopback URL'); process.exit(1); }
const FS_PORT = Number(process.env.NBD_AUDIT_FS_PORT || 8085);
const USER = String(arg('user', 'owner@a.test'));
const PASS = String(arg('pass', 'Audit123!'));
const OUT = path.resolve(String(arg('out', path.join(ROOT, 'overnight', 'crm', 'harness-runs', USER.replace(/[^a-z0-9]+/gi, '-')))));
const WAIT = Number(arg('wait', 2500));
const SHOTS = !process.argv.includes('--no-shots');
const AXE = !process.argv.includes('--no-axe');
const EVAL = arg('eval', null);
let routes = [];
if (arg('routes')) routes = String(arg('routes')).split(',');
if (arg('routes-file')) routes = routes.concat(fs.readFileSync(String(arg('routes-file')), 'utf8').split(/\r?\n/).map((l) => (/^\s*#/.test(l) ? '' : l.trim())));  // whole-line '#' comments only: routes carry #/hash
routes = routes.map((r) => r.trim()).filter(Boolean);
if (!routes.length) routes = ['/pro/dashboard.html'];

const slug = (r) => r.replace(/^\/pro\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'root';

async function prep(context) {
  // The client hard-codes the Firestore emulator at 127.0.0.1:8080
  // (nbd-emulator-connect.js); the harness runs it on FS_PORT because 8080 is
  // taken on this machine. Re-point at the network layer, test-only (an in-page
  // fetch/XHR patch misses the SDK's channel requests).
  if (FS_PORT !== 8080) {
    await context.route(/^http:\/\/(127\.0\.0\.1|localhost):8080\//, (route) =>
      route.continue({ url: route.request().url().replace(/:8080\//, ':' + FS_PORT + '/') }));
  }
  // Never let the page reach a non-loopback host except the Firebase SDK/font CDNs it needs.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
    const u = route.request().url();
    if (/^https:\/\/(www\.gstatic\.com|fonts\.(googleapis|gstatic)\.com)\//.test(u)) return route.continue();
    return route.abort('blockedbyclient');
  });
}

async function login(page) {
  await page.goto(BASE + '/pro/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginBtn:not([disabled])', { timeout: 20000 });
  await page.fill('#emailInput', USER);
  await page.fill('#passwordInput', PASS);
  await Promise.all([
    page.waitForURL(/\/pro\/(dashboard|home|onboarding)/, { timeout: 45000 }),
    page.click('#loginBtn'),
  ]);
  await page.waitForTimeout(WAIT);
}

async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = Math.max(0, doc.scrollWidth - window.innerWidth);
    const small = [];
    document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [data-action]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') return;
      if (r.bottom < 0 || r.top > window.innerHeight * 3) return;
      if (r.width < 44 || r.height < 44) small.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : '')) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    const tinyInputs = [];
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const fs2 = parseFloat(getComputedStyle(el).fontSize);
      if (fs2 < 16) tinyInputs.push((el.id || el.name || el.tagName) + ' ' + fs2 + 'px');
    });
    return { overflowX, smallTargets: small.length, smallSample: small.slice(0, 12), tinyInputs: tinyInputs.length, tinySample: tinyInputs.slice(0, 8), title: document.title };
  });
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = { user: USER, base: BASE, at: new Date().toISOString(), routes: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: AXE });
  await prep(context);
  const page = await context.newPage();
  let cur = null;
  const bucket = () => cur || (cur = { consoleErrors: [], pageErrors: [], failedRequests: [] });
  page.on('console', (m) => { if (m.type() === 'error') bucket().consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => bucket().pageErrors.push(String(e && e.message || e).slice(0, 300)));
  page.on('requestfailed', (r) => {
    const f = r.failure() && r.failure().errorText;
    if (f === 'net::ERR_BLOCKED_BY_CLIENT' || f === 'net::ERR_ABORTED') return;
    bucket().failedRequests.push(r.url().slice(0, 160) + ' ' + f);
  });
  page.on('response', (r) => { if (r.status() >= 400 && /127\.0\.0\.1/.test(r.url())) bucket().failedRequests.push(r.status() + ' ' + r.url().slice(0, 160)); });
  try { await login(page); } catch (e) { results.loginError = String(e.message || e); }
  results.landedOn = page.url();
  for (const r of routes) {
    cur = null; bucket();
    const row = { route: r };
    try {
      await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (r.includes('#')) await page.evaluate((h) => { if (location.hash !== h) location.hash = h; }, r.slice(r.indexOf('#')));
      await page.waitForTimeout(WAIT);
      if (EVAL) row.eval = await page.evaluate(String(EVAL)).catch((e) => 'EVAL ERROR ' + e.message);
      row.desktop = await measure(page);
      if (SHOTS) await page.screenshot({ path: path.join(OUT, slug(r) + '-1440.png') });
      if (AXE) {
        try {
          const ax = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
          row.axe = ax.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
        } catch (e) { row.axe = 'axe failed: ' + e.message; }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(600);
      row.mobile = await measure(page);
      if (SHOTS) await page.screenshot({ path: path.join(OUT, slug(r) + '-390.png') });
      await page.setViewportSize({ width: 1440, height: 900 });
    } catch (e) { row.error = String(e.message || e).slice(0, 300); }
    Object.assign(row, cur);
    results.routes.push(row);
    console.log((row.error ? 'ERR ' : 'ok  ') + r + '  console=' + row.consoleErrors.length + ' pageErr=' + row.pageErrors.length +
      ' failedReq=' + row.failedRequests.length + (row.mobile ? ' overflow390=' + row.mobile.overflowX + ' small=' + row.mobile.smallTargets : '') +
      (Array.isArray(row.axe) ? ' axe=' + row.axe.map((a) => a.id + ':' + a.impact).join(',') : ''));
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log('landed=' + results.landedOn + (results.loginError ? ' LOGIN ERROR ' + results.loginError : '') + '\nresults: ' + path.join(OUT, 'results.json'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
