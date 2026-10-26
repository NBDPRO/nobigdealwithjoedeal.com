#!/usr/bin/env node
/*
 * Above-the-fold font preloads for every public page (2026-10-26, overnight
 * marketing-1).
 *
 * nbd-fonts.css declares the two faces every page paints its hero with:
 * Bebas Neue 400 (headlines) and Montserrat 400-900 (body, buttons). The
 * browser only discovers the .woff2 files after it has parsed that CSS, so on
 * a cold load the hero is drawn in the fallback face and re-flows when the
 * real fonts land: the headline and CTA buttons jump ~35px, CLS 0.10-0.29 at
 * phone width on ~290 pages. /book, the guides and the home page already
 * carried the two preload hints and measured CLS ~0; this codemod gives them
 * to every other public page.
 *
 * Inserted right after the nbd-fonts.css stylesheet link (the same anchor
 * add-template-hero-preloads.js uses), keeping that line's indentation and the
 * file's own line endings. Idempotent: a page that already carries a hint is
 * left alone, and a page with only one of the two gets the missing one.
 *
 * Dancing Script is deliberately NOT preloaded (it is below the fold on most
 * pages) and nbd-fonts.css is untouched.
 *
 *   node scripts/add-font-preloads.js           stamp the missing hints
 *   node scripts/add-font-preloads.js --check   list pages that lack them, exit 1
 *
 * New pages built by a generator must emit the same two lines
 * (scripts/build-projects.mjs does); tests/perf-watch-2026-10-02.test.js
 * fails when any public page that links nbd-fonts.css lacks them.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs');
const ANCHOR = '<link rel="stylesheet" href="/assets/css/nbd-fonts.css">';
const FONT_FILES = ['bebas-neue-400-latin.woff2', 'montserrat-400-latin.woff2'];
const fontPreload = (file) => `<link rel="preload" href="/assets/fonts/${file}" as="font" type="font/woff2" crossorigin>`;
const FONT_PRELOADS = FONT_FILES.map(fontPreload);

// Not a marketing page: the service-worker offline fallback has no network to preload from.
const NOT_MARKETING = ['offline.html'];
const SKIP_PATHS = NOT_MARKETING;
// Top-level docs/ folders that are not public marketing pages.
const SKIP_DIRS = ['pro', 'admin', 'dev', 'sites', 'assets', 'tools'];

function publicPages(dir = DOCS, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel === '' && SKIP_DIRS.includes(e.name)) continue;
      out.push(...publicPages(path.join(dir, e.name), r));
    } else if (e.name.endsWith('.html') && !SKIP_PATHS.includes(r)) {
      out.push(r);
    }
  }
  return out.sort();
}

// Returns the page with the missing hints added after the anchor, or null when
// the page has no anchor or nothing is missing.
function stamp(src) {
  const at = src.indexOf(ANCHOR);
  if (at < 0) return null;
  const missing = FONT_FILES.filter((f) => !src.includes(`href="/assets/fonts/${f}"`));
  if (!missing.length) return null;
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const indent = src.slice(lineStart, at).match(/^[ \t]*/)[0];
  const block = missing.map((f) => `\n${indent}${fontPreload(f)}`).join('').replace(/\n/g, eol);
  const end = at + ANCHOR.length;
  return src.slice(0, end) + block + src.slice(end);
}

function main() {
  const check = process.argv.includes('--check');
  let added = 0, had = 0, noAnchor = 0;
  const pending = [];
  for (const r of publicPages()) {
    const p = path.join(DOCS, r);
    const src = fs.readFileSync(p, 'utf8');
    if (!src.includes(ANCHOR)) { noAnchor++; continue; }
    const next = stamp(src);
    if (next === null) { had++; continue; }
    // A lone CR would make git treat the file as binary (CLAUDE.md, "Editing files on Windows").
    if ((next.match(/\r(?!\n)/g) || []).length !== (src.match(/\r(?!\n)/g) || []).length) throw new Error(`lone CR introduced in ${r}`);
    pending.push(r);
    if (!check) fs.writeFileSync(p, next, 'utf8');
    added++;
  }
  if (check) {
    if (pending.length) console.log(`add-font-preloads --check: ${pending.length} page(s) lack the font preloads:\n  ${pending.join('\n  ')}`);
    else console.log(`add-font-preloads --check: all ${had} public pages that link nbd-fonts.css carry both font preloads.`);
    process.exit(pending.length ? 1 : 0);
  }
  console.log(`${added} pages got font preloads; ${had} already had both; ${noAnchor} public pages do not link nbd-fonts.css.`);
}

if (require.main === module) main();
module.exports = { ANCHOR, FONT_PRELOADS, NOT_MARKETING, SKIP_DIRS, publicPages, stamp };
