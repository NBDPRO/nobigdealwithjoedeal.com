#!/usr/bin/env node
/**
 * scripts/chibi-sheet.js — render a grid of characters through the shipped renderer (docs/pro/js/chibi.js) so a
 * change can be looked at before it ships (CLAUDE.md rule g, the character style bar).
 *
 *   node scripts/chibi-sheet.js <spec.json> <out.png>
 *
 * spec.json: { "cols": 6, "w": 150, "h": 180, "dpr": 2, "cells": [ { "label": "cap + afro, walk", "look": { "hair": "afro",
 *   "hat": "cap" }, "o": { "pose": "walk", "t": 150 }, "bg": "#e9edf3" } ] }
 * look: any avatar fields chibi.js normalizes (hair, hat, beard, eyes, eyeColor, top, vest, tool, extra, prop, build, elder,
 * clipboard, mood, colours). o: draw options (pose, facing, t, mood, gaze, wind, cold, pop, crop 'bust', fit, seed); blink is
 * off and t is 5 unless o says otherwise. Each cell is a w×h CSS box drawn at dpr. Uses Playwright's Chromium from
 * tests/node_modules (the same install the E2E suites use). Zero other deps; nothing is written but the PNG.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const [specPath, outPath] = process.argv.slice(2);
if (!specPath || !outPath) { console.error('usage: node scripts/chibi-sheet.js <spec.json> <out.png>'); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const chibi = fs.readFileSync(path.join(ROOT, 'docs/pro/js/chibi.js'), 'utf8');
const { chromium } = require(path.join(ROOT, 'tests/node_modules/playwright'));

// The page is built in memory (setContent): the renderer is inlined, so nothing under docs/ changes and no file:// path
// is needed. The grid paints one canvas per cell through NBDChibi.paintCanvas with a cached box, like the loops do.
const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#1a3057;padding:10px;font:11px/1.2 system-ui}
.g{display:grid;gap:8px}.c{background:#e9edf3;border-radius:8px;display:flex;flex-direction:column;align-items:center;padding:4px}
.c span{color:#1a3057;font-size:10px;text-align:center;margin-top:2px;max-width:160px}canvas{display:block}</style></head>
<body><div class="g" id="g"></div><script>${chibi}</script><script>
window.renderSpec = function (spec) {
  var CH = window.NBDChibi, g = document.getElementById('g');
  g.style.gridTemplateColumns = 'repeat(' + (spec.cols || 6) + ', max-content)';
  var W = spec.w || 150, H = spec.h || 180;
  (spec.cells || []).forEach(function (cell) {
    var d = document.createElement('div'); d.className = 'c'; if (cell.bg) d.style.background = cell.bg;
    var c = document.createElement('canvas'); c.style.width = W + 'px'; c.style.height = H + 'px'; d.appendChild(c);
    var s = document.createElement('span'); s.textContent = cell.label || ''; d.appendChild(s); g.appendChild(d);
    CH.paintCanvas(c, cell.look || {}, Object.assign({ blink: false, t: 5 }, cell.o || {}, { box: { width: W, height: H } }));
  });
  document.title = 'ready';
};
</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const pg = await browser.newPage({ viewport: { width: spec.vw || 1200, height: 800 }, deviceScaleFactor: spec.dpr || 2 });
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.setContent(page);
  await pg.waitForFunction(() => !!window.NBDChibi);
  await pg.evaluate((s) => window.renderSpec(s), spec);
  await pg.waitForFunction(() => document.title === 'ready');
  await pg.screenshot({ path: outPath, fullPage: true });
  await browser.close();
  if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exit(1); }
  console.log('chibi-sheet: ' + (spec.cells || []).length + ' cells -> ' + outPath);
})().catch((e) => { console.error(e); process.exit(1); });
