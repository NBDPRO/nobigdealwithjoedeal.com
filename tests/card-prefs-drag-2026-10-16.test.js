#!/usr/bin/env node
/**
 * tests/card-prefs-drag-2026-10-16.test.js — drag to reorder in "Customize
 * this screen" (SortableJS 1.15.7, repos report item 5) and ApexCharts retired
 * (item 8).
 *
 *   A. reorder(): a dragged order is accepted only as the same set of cards
 *   B. SortableJS is vendored (pinned 1.15.7, MIT) and loaded ONLY when the
 *      sheet opens (no boot tag, not in any bundle); drag by a handle; the
 *      Move up / Move down buttons stay (keyboard + screen reader path)
 *   C. ApexCharts: gone from the bundle and the vendor folder; the Rep Report's
 *      charts are the generator's static HTML/SVG
 *
 * Run: node tests/card-prefs-drag-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 300) : '')); failed++; fails.push(label); }
}

console.log('\nA. reorder()');
{
  const P = require(path.join(ROOT, 'docs/pro/js/card-prefs.js'));
  const p = { order: ['a', 'b', 'c'], off: ['b'] };
  const n = P.reorder(p, ['c', 'a', 'b']);
  ok('a dragged order becomes the order; hidden cards stay hidden', JSON.stringify(n) === JSON.stringify({ order: ['c', 'a', 'b'], off: ['b'] }));
  ok('a missing card is refused (p unchanged)', P.reorder(p, ['c', 'a']) === p);
  ok('an unknown card is refused', P.reorder(p, ['c', 'a', 'x']) === p);
  ok('a duplicate is refused', P.reorder(p, ['a', 'a', 'b']) === p);
  ok('garbage is refused', P.reorder(p, null) === p);
}

console.log('\nB. SortableJS in the sheet');
{
  const js = read('docs/pro/js/card-prefs.js');
  const vend = read('docs/assets/vendor/sortablejs/1.15.7/Sortable.min.js');
  ok('SortableJS 1.15.7 is vendored with its MIT licence', /^\/\*! Sortable 1\.15\.7 - MIT/.test(vend) && /MIT/.test(read('docs/assets/vendor/sortablejs/1.15.7/LICENSE')));
  ok('…and has no eval / new Function and injects no <style>', !/new Function\(|[^\w.]eval\(|createElement\(["']style["']\)/.test(vend));
  ok('card-prefs.js loads it only when the sheet opens', /var SORTABLE_SRC = '\/assets\/vendor\/sortablejs\/1\.15\.7\/Sortable\.min\.js';/.test(js) &&
    /paintSheet\(\);\s*loadSortable\(function \(\) \{ if \(sheet\) attachDrag\(\); \}\);/.test(js));
  ok('no boot tag and no bundle entry for it', !/sortablejs|Sortable.min/i.test(read('docs/pro/dashboard.html')) && !/sortablejs/i.test(read('docs/pro/js/script-loader.js')));
  ok('drag by a handle, with a touch delay so a scroll is not a drag', /handle: '\.hc-grip'/.test(js) && /delayOnTouchOnly: true/.test(js) && /class="hc-grip" aria-hidden="true"/.test(js));
  ok('the drop saves through the same change() + reorder() path and says where it went', /var p = load\(sheetFor\), n = reorder\(p, ids\);/.test(js) && /moved to position ' \+ \(e\.newIndex \+ 1\)/.test(js));
  ok('Move up / Move down stay, with their labels', /data-hc="up"[^']*' aria-label="Move ' \+ esc\(c\.label\) \+ ' up"/.test(js.replace(/'\s*\+\s*\(i === 0 \? ' disabled' : ''\)\s*\+\s*'/, '')) || /aria-label="Move ' \+ esc\(c\.label\) \+ ' up"/.test(js));
  ok('the instance is destroyed on close and on every repaint', /function close\(\) \{\s*if \(sortable\) \{ try \{ sortable\.destroy\(\); \}/.test(js) && /function attachDrag\(\) \{\s*if \(sortable\) \{ try \{ sortable\.destroy\(\); \}/.test(js));
  const css = read('docs/pro/css/card-prefs.css');
  ok('the handle is a 44px-tall target and only it blocks touch scrolling', /\.hc-grip\{[^}]*min-height:44px;[^}]*touch-action:none;/.test(css));
  ok('the bundle bumped card-prefs ?v=', /'css\/card-prefs\.css\?v=2',\s*'js\/card-prefs\.js\?v=6'/.test(read('docs/pro/js/script-loader.js')));
}

console.log('\nC. ApexCharts retired');
{
  ok('the vendored ApexCharts folder is gone', !fs.existsSync(path.join(ROOT, 'docs/assets/vendor/apexcharts')));
  const sl = read('docs/pro/js/script-loader.js');
  const reports = (sl.match(/reports:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  ok('the reports bundle loads only the generator', !/'[^']*apexcharts/i.test(reports) && /'js\/rep-report-generator\.js\?v=\d+'/.test(reports));
  const gen = read('docs/pro/js/rep-report-generator.js');
  ok('the generator draws static HTML/SVG charts and never calls ApexCharts', !/new ApexCharts\(|ApexCharts\./.test(gen) && /function renderStaticHeatmap/.test(gen));
  let refs = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(node_modules|pagefind)$/.test(e.name)) walk(p); } else if (/\.(js|html)$/.test(e.name) && /apexcharts\.min\.js|vendor\/apexcharts/i.test(fs.readFileSync(p, 'utf8'))) refs.push(path.relative(ROOT, p)); } })(path.join(ROOT, 'docs'));
  ok('nothing under docs/ points at an ApexCharts file', refs.length === 0, refs.join(', '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
