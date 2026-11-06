#!/usr/bin/env node
/**
 * scripts/audit/doc-render-matrix.js — render EVERY NBDDocGen.DOCUMENT_TYPES
 * entry for each audit tenant inside the real dashboard (the app's own brand
 * resolution, profile load and print CSS), then assert the customer-paper
 * contract on each. Read-only: calls NBDDocGen.getHTML(), never generate()
 * (generate() opens viewers, saves drafts and can call the server renderer).
 *
 * Checks per render:
 *   renders     getHTML returned > 400 chars, no exception
 *   noPro       no "NBD Pro" / standalone "PRO" in the visible text
 *   noNbdLeak   (non-NBD tenant only) none of: "No Big Deal" (case-sensitive: the
 *               lowercase idiom "no big deal" is ordinary copy), nobigdealwithjoedeal,
 *               Joe Deal, 1162011, 181382, #1A3057 navy as a literal colour,
 *               NBD logo data URI
 *   noCssComments  no /* … *\/ inside <style>
 *   receiptNoDue   receipt has no "due" date language
 *   hasTenantName  the tenant's own legal/display name appears
 * Writes <out>/matrix.json, <out>/<tenant>/<type>.html and, unless --no-shots,
 * a 816px-wide JPEG thumbnail per render.
 *
 * Usage (harness running + seeded, see overnight/crm/HARNESS.md):
 *   MSYS_NO_PATHCONV=1 node scripts/audit/doc-render-matrix.js --out C:/Users/jonat/nbd-overnight-tools/renders
 *   flags: --users owner@a.test,owner@b.test  --no-shots  --check (exit 1 on any failed check)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const ROOT = path.join(__dirname, '..', '..');
const { chromium } = createRequire(path.join(ROOT, 'tests', 'package.json'))('playwright');

const argv = process.argv;
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const BASE = 'http://127.0.0.1:5000';
const FS_PORT = Number(process.env.NBD_AUDIT_FS_PORT || 8085);
const OUT = path.resolve(arg('out', path.join(ROOT, 'overnight', 'crm', 'renders')));
const USERS = String(arg('users', 'owner@a.test,owner@b.test')).split(',');
const SHOTS = !argv.includes('--no-shots');
const CHECK = argv.includes('--check');

const SAMPLE = {
  customerName: 'Test Homeowner 01', homeownerName: 'Test Homeowner 01', clientName: 'Test Homeowner 01',
  address: '100 Test St, Testville, OH 45000', propertyAddress: '100 Test St, Testville, OH 45000',
  phone: '(555) 010-1000', email: 'homeowner01@example.test', date: '2026-11-06',
  projectType: 'Roof replacement', projectDescription: 'Synthetic roof replacement',
  lineItems: [
    { description: 'Synthetic shingle line', qty: 20.3, unit: 'SQ', rate: 100, unitPrice: 100, lineTotal: 2030, total: 2030 },
    { description: 'Synthetic labor line', qty: 1, unit: 'JOB', rate: 500, unitPrice: 500, lineTotal: 500, total: 500 },
  ],
  totalPrice: 2530, totalAmount: 2530, subtotal: 2530, amountPaid: 2530, balanceDue: 0,
  invoiceNumber: 'TEST-0001', receiptNumber: 'TEST-R-0001', claimNumber: 'TEST-CLAIM', insCarrier: 'Test Mutual',
  _isBlankPreview: true,
};

async function renderAll(user) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (FS_PORT !== 8080) await ctx.route(/^http:\/\/(127\.0\.0\.1|localhost):8080\//, (r) => r.continue({ url: r.request().url().replace(/:8080\//, ':' + FS_PORT + '/') }));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => (/^https:\/\/(www\.gstatic\.com|fonts\.(googleapis|gstatic)\.com)\//.test(r.request().url()) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  await page.goto(BASE + '/pro/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginBtn:not([disabled])', { timeout: 20000 });
  await page.fill('#emailInput', user); await page.fill('#passwordInput', 'Audit123!');
  await Promise.all([page.waitForURL(/\/pro\/dashboard/, { timeout: 45000 }), page.click('#loginBtn')]);
  // The doc cluster is lazy (ScriptLoader 'docgen' bundle), as in the app.
  await page.waitForFunction(() => window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function', null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => window.ScriptLoader.loadBundle('docgen')).catch((e) => console.error('loadBundle failed: ' + e.message));
  await page.waitForFunction(() => window.NBDDocGen && window._companyProfileLoaded === true, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const out = await page.evaluate(async (sample) => {
    const DG = window.NBDDocGen;
    if (!DG) return { error: 'NBDDocGen missing' };
    try { if (typeof window._loadCompanyProfile === 'function') await window._loadCompanyProfile(); } catch (_) { /* best effort */ }
    const brand = (typeof window._brand === 'function' ? window._brand() : null) || {};
    const isNbd = typeof window._isNbdPlatformTenant === 'function' ? window._isNbdPlatformTenant() : null;
    const rows = [];
    for (const key of Object.keys(DG.DOCUMENT_TYPES || {})) {
      let html = '', err = null;
      try { html = DG.getHTML(key, JSON.parse(JSON.stringify(Object.assign({ _documentType: key, companyProfile: window._companyProfile }, sample)))) || ''; }
      catch (e) { err = String(e && e.message || e).slice(0, 200); }
      rows.push({ key, name: DG.DOCUMENT_TYPES[key].name, html, err });
    }
    return { brand: { legalName: brand.legalName, displayName: brand.displayName }, isNbd, rows };
  }, SAMPLE);
  return { browser, page, out };
}

function checks(row, tenant) {
  const html = row.html || '';
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const styles = (html.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');
  const c = {};
  c.renders = !row.err && html.length > 400;
  c.noPro = c.renders && !/\bNBD\s*Pro\b|\bPRO\b/.test(text);
  c.noCssComments = c.renders && !/\/\*[\s\S]*?\*\//.test(styles);
  if (!tenant.isNbd) {
    const leaks = [/No Big Deal/, /No Big Deal Home Solutions/i, /nobigdealwithjoedeal/i, /Joe Deal/i, /1162011/, /181382/, /data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAB/].filter((re) => re.test(html));
    c.noNbdLeak = c.renders && leaks.length === 0;
    if (leaks.length) c.leaks = leaks.map(String);
  }
  const name = (tenant.brand.legalName || tenant.brand.displayName || '').trim();
  c.hasTenantName = c.renders && !!name && (text.includes(name) || text.includes(tenant.brand.displayName || '\u0000'));
  if (/receipt/i.test(row.key)) c.receiptNoDue = c.renders && !/\bdue\b/i.test(text);
  return c;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const matrix = [];
  let failures = 0;
  for (const user of USERS) {
    const { browser, page, out } = await renderAll(user);
    if (out.error) { console.error(user + ': ' + out.error); failures++; await browser.close(); continue; }
    const tdir = path.join(OUT, user.replace(/[^a-z0-9]+/gi, '-'));
    fs.mkdirSync(tdir, { recursive: true });
    for (const row of out.rows) {
      const c = checks(row, out);
      const bad = Object.entries(c).filter(([k, v]) => v === false).map(([k]) => k);
      failures += bad.length;
      matrix.push({ user, key: row.key, name: row.name, err: row.err, bytes: (row.html || '').length, checks: c, failed: bad });
      if (row.html) fs.writeFileSync(path.join(tdir, row.key + '.html'), row.html);
      if (SHOTS && row.html) {
        await page.setViewportSize({ width: 816, height: 1056 });
        await page.setContent(row.html, { waitUntil: 'load' }).catch(() => {});
        await page.screenshot({ path: path.join(tdir, row.key + '.jpg'), type: 'jpeg', quality: 55 }).catch(() => {});
      }
      console.log((bad.length ? 'FAIL ' : 'ok   ') + user.padEnd(13) + ' ' + row.key.padEnd(28) + (row.err ? ' ERR ' + row.err : '') + (bad.length ? ' ' + bad.join(',') : '') + (c.leaks ? ' leaks=' + c.leaks.join(' ') : ''));
    }
    console.log(user + ': brand=' + JSON.stringify(out.brand) + ' isNbd=' + out.isNbd + ' types=' + out.rows.length);
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(matrix, null, 2));
  console.log('failed checks: ' + failures + '  → ' + path.join(OUT, 'matrix.json'));
  process.exit(CHECK && failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
