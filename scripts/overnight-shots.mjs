#!/usr/bin/env node
/**
 * scripts/overnight-shots.mjs — Playwright screenshot + console/404 + axe sweep.
 *
 *   node scripts/overnight-shots.mjs --base http://127.0.0.1:18431 \
 *        --pages /,/inspect --label before [--out overnight/baseline/shots] [--axe]
 *
 * For every page at 390x844 (mobile) and 1440x900 (desktop): scrolls the page
 * once to trigger lazy images, takes a full-page screenshot, re-encodes it as
 * WebP (quality lowered until <= 200 KB, height capped at 9000px), and records
 * console errors, failed requests and (with --axe) axe-core violation counts by
 * rule. Writes <out>/<label>/<slug>-<390|1440>.webp and <out>/<label>/report.json.
 *
 * Playwright + axe come from tests/node_modules (cd tests && npm install);
 * sharp comes from functions/node_modules. Read-only against the server.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(root, 'tests', 'package.json'));
const { chromium } = req('@playwright/test');
const sharp = createRequire(join(root, 'functions', 'package.json'))('sharp');
let AxeBuilder = null;
try { AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright'); } catch (_) { /* optional */ }

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const base = arg('--base', 'http://127.0.0.1:18431');
const pages = arg('--pages', '/').split(',').filter(Boolean);
const label = arg('--label', 'run');
const outDir = join(root, arg('--out', 'overnight/baseline/shots'), label);
const doAxe = process.argv.includes('--axe');
mkdirSync(outDir, { recursive: true });
const slug = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-'));
const VIEWS = [{ w: 390, h: 844 }, { w: 1440, h: 900 }];

const browser = await chromium.launch();
const report = [];
for (const path of pages) {
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1, reducedMotion: 'reduce', bypassCSP: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const consoleErrors = []; const failed = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 160)));
    page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) failed.push(r.status() + ' ' + r.url().replace(base, '')); });
    const row = { path, width: v.w, consoleErrors, failed };
    try {
      await page.goto(base + path, { waitUntil: 'load', timeout: 45000 });
      await page.evaluate(async () => {
        const step = Math.max(300, innerHeight * 0.8);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
        scrollTo(0, 0); await new Promise((r) => setTimeout(r, 400));
      });
      row.hOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      let png = await page.screenshot({ fullPage: true, type: 'png' });
      let img = sharp(png); const md = await img.metadata();
      if (md.height > 9000) img = sharp(png).extract({ left: 0, top: 0, width: md.width, height: 9000 });
      let q = 80, buf;
      do { buf = await img.clone().webp({ quality: q }).toBuffer(); q -= 10; } while (buf.length > 200 * 1024 && q >= 20);
      const file = join(outDir, `${slug(path)}-${v.w}.webp`);
      writeFileSync(file, buf);
      row.shot = file.replace(root + '\\', '').replace(root + '/', ''); row.shotKB = Math.round(buf.length / 1024); row.pageHeight = md.height;
      if (doAxe && AxeBuilder) {
        const res = await new AxeBuilder({ page }).analyze();
        row.axe = {}; for (const vio of res.violations) row.axe[vio.id] = vio.nodes.length;
      }
    } catch (e) { row.error = String(e.message || e).split('\n')[0]; }
    report.push(row);
    console.log(`${path} @${v.w}: ${row.error ? 'ERROR ' + row.error : row.shotKB + 'KB h=' + row.pageHeight}  overflowX=${row.hOverflow}  consoleErr=${consoleErrors.length} 4xx=${failed.length}${row.axe ? ' axe=' + JSON.stringify(row.axe) : ''}`);
    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
