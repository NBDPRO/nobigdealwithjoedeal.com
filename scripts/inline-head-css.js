#!/usr/bin/env node
/**
 * scripts/inline-head-css.js — put the homepage's head stylesheets inline at
 * DEPLOY time (PageSpeed mobile 2026-10-27: Performance 84, LCP 4.3 s,
 * "Render-blocking requests, est. savings 850 ms": 11 stylesheets in the head).
 *
 * docs/ stays the readable source of truth. Like scripts/minify-shipped.js,
 * only the deploy runner's checkout is rewritten, right after the minify and
 * before `firebase deploy --only hosting`; the deploy job restores
 * docs/index.html straight after.
 *
 * What it does: every `<link rel="stylesheet" href="/assets/css/X.css[?v=n]">`
 * that sits BEFORE </head> in a listed page is replaced, in place, by
 * `<style>` + that file's text + `</style>`. Same position, same order, so the
 * cascade is byte-for-byte what it was; the page just stops waiting on 11
 * requests before it can paint. The CSS files themselves stay served (every
 * other page still links them).
 *
 * Safe by construction:
 *   - a file that cannot be read, or contains `</style`, is left as a link;
 *   - only same-origin /assets/css/ links are touched; anything after </head>
 *     is not;
 *   - the CSS files use absolute url(/assets/...) paths only (guarded in
 *     tests/inline-head-css-2026-10-27.test.js), so moving them into the page
 *     changes no URL resolution;
 *   - idempotent: a second run finds no links and changes nothing.
 *
 * Usage:
 *   node scripts/inline-head-css.js           # dry run: counts and sizes
 *   node scripts/inline-head-css.js --write   # rewrite the listed pages
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
// Homepage first (the page PageSpeed was run on). Add a page here only after
// re-measuring it; each one grows by the size of its head CSS.
const PAGES = ['index.html'];
const LINK = /<link rel="stylesheet" href="\/assets\/css\/([A-Za-z0-9._-]+\.css)(?:\?[^"]*)?">\n?/g;

// readCss(name) -> string | null. Returns { html, count, skipped }.
function inlineHeadCss(html, readCss) {
  const end = html.indexOf('</head>');
  if (end < 0) return { html, count: 0, skipped: 0 };
  let count = 0, skipped = 0;
  const head = html.slice(0, end).replace(LINK, (whole, file) => {
    let css = readCss(file);
    if (typeof css !== 'string' || /<\/style/i.test(css)) { skipped++; return whole; }
    css = css.replace(/^﻿/, '').trim();
    count++;
    return '<style>' + css + '</style>\n';
  });
  return { html: head + html.slice(end), count, skipped };
}

function readFromDocs(file) {
  try { return fs.readFileSync(path.join(DOCS, 'assets', 'css', file), 'utf8'); } catch (e) { return null; }
}

function main() {
  const write = process.argv.includes('--write');
  let total = 0;
  for (const rel of PAGES) {
    const p = path.join(DOCS, rel);
    const before = fs.readFileSync(p, 'utf8');
    const r = inlineHeadCss(before, readFromDocs);
    total += r.count;
    console.log((write ? 'inlined ' : 'would inline ') + r.count + ' stylesheet(s) in ' + rel +
      (r.skipped ? ' (' + r.skipped + ' left as links)' : '') + ': ' + before.length + ' -> ' + r.html.length + ' bytes');
    if (write && r.count) fs.writeFileSync(p, r.html);
  }
  if (!total) console.log('nothing to inline');
}

if (require.main === module) main();
module.exports = { inlineHeadCss, PAGES };
