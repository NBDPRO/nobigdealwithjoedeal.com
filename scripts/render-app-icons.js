#!/usr/bin/env node
/**
 * scripts/render-app-icons.js - build the home-screen icons for the two personal web apps (Daily Success, Workout)
 * from their SVG sources in docs/pro/img/. Run it whenever one of those SVGs changes; nothing else does.
 *
 * Per app (prefix `ds` / `workout`):
 *   <p>-icon-192.png, <p>-icon-512.png                    purpose "any": the rounded tile, transparent corners
 *   <p>-icon-maskable-192.png, <p>-icon-maskable-512.png  purpose "maskable": full-bleed, mark inside the 80% safe zone
 *   <p>-apple-touch-icon.png (180)                        iOS: the rounded-tile art over the tile colour (iOS masks it itself,
 *                                                         and paints transparent pixels black, so it must be opaque)
 *
 * Chromium (the Playwright install under tests/node_modules) draws each one; the PNG is the screenshot of a
 * size x size page. tests/ds-workout-installable-2026-11-16.test.js walks every chunk of every output.
 *
 * Usage:  node scripts/render-app-icons.js
 * Needs:  tests/node_modules (cd tests && npm ci), or NODE_PATH pointing at a Playwright install. Not run in CI.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IMG = path.join(ROOT, 'docs', 'pro', 'img');
const APPS = [
  { prefix: 'ds', tile: '#12223D' },
  { prefix: 'workout', tile: '#BD5728' },
];

function targets() {
  const out = [];
  for (const a of APPS) {
    const any = path.join(IMG, a.prefix + '-icon.svg'), mask = path.join(IMG, a.prefix + '-icon-maskable.svg');
    out.push({ svg: any, out: a.prefix + '-icon-192.png', size: 192, bg: null });
    out.push({ svg: any, out: a.prefix + '-icon-512.png', size: 512, bg: null });
    out.push({ svg: mask, out: a.prefix + '-icon-maskable-192.png', size: 192, bg: a.tile });
    out.push({ svg: mask, out: a.prefix + '-icon-maskable-512.png', size: 512, bg: a.tile });
    out.push({ svg: any, out: a.prefix + '-apple-touch-icon.png', size: 180, bg: a.tile });
  }
  return out;
}

(async () => {
  let chromium;
  try {
    ({ chromium } = require(require.resolve('playwright', { paths: [path.join(ROOT, 'tests')].concat((process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) })));
  } catch (_) {
    console.error('Playwright not found. Run: cd tests && npm ci');
    process.exit(1);
  }
  const browser = await chromium.launch();
  try {
    for (const t of targets()) {
      const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
      const svg = fs.readFileSync(t.svg, 'utf8');
      const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
      await page.setContent('<!doctype html><html><body style="margin:0;background:' + (t.bg || 'transparent') + '"><img src="' + uri + '" width="' + t.size + '" height="' + t.size + '" style="display:block"></body></html>');
      await page.waitForFunction(() => { const i = document.images[0]; return i && i.complete && i.naturalWidth > 0; });
      const buf = await page.screenshot({ type: 'png', omitBackground: !t.bg, clip: { x: 0, y: 0, width: t.size, height: t.size } });
      fs.writeFileSync(path.join(IMG, t.out), buf);
      console.log('wrote docs/pro/img/' + t.out + ' (' + buf.length + ' bytes)');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
