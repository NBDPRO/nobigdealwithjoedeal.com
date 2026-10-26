#!/usr/bin/env node
/*
 * LCP hero preloads for the templated city/area pages (2026-07-13).
 *
 * The 146 templated service-city and area pages paint their hero through a
 * CSS background image-set (desktop full-size + -800 mobile variant), which
 * the browser only discovers after CSS parse. The homepage carries an
 * explicit media-split preload pair for exactly this pattern; this codemod
 * gives every templated page the same treatment, auto-detected from each
 * page's own image-set (roofing-1 or roofing-2 today — the script reads the
 * page rather than assuming).
 *
 * Inserted after the nbd-fonts.css stylesheet link (present on every
 * template) so the hints sit in the early head. Idempotent: pages that
 * already contain a hero preload are skipped.
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs');
const ANCHOR = '<link rel="stylesheet" href="/assets/css/nbd-fonts.css">';

let added = 0, skipped = 0, warned = 0;
for (const dir of ['services', 'areas']) {
  for (const name of fs.readdirSync(path.join(DOCS, dir))) {
    if (!name.endsWith('.html')) continue;
    const p = path.join(DOCS, dir, name);
    const src = fs.readFileSync(p, 'utf8');
    const imgs = [...src.matchAll(/image-set\(url\((\/assets\/images\/[^)]+\.webp)\)/g)].map((m) => m[1]);
    if (!imgs.length) continue;
    const desktop = imgs.find((i) => !i.includes('-800'));
    const mobile = imgs.find((i) => i.includes('-800'));
    if (!desktop || !mobile) { console.warn(`WARN no pair: ${dir}/${name} [${imgs.join(', ')}]`); warned++; continue; }
    // An image preload only: the font preloads add-font-preloads.js stamps on the same pages must not read as a hero preload.
    if (/<link rel="preload"[^>]*\bas="image"/.test(src)) { skipped++; continue; }
    if (!src.includes(ANCHOR)) { console.warn(`WARN no anchor: ${dir}/${name}`); warned++; continue; }
    const hints =
      `${ANCHOR}\n` +
      `<link rel="preload" href="${mobile}" as="image" type="image/webp" fetchpriority="high" media="(max-width:600px)">\n` +
      `<link rel="preload" href="${desktop}" as="image" type="image/webp" fetchpriority="high" media="(min-width:601px)">`;
    fs.writeFileSync(p, src.replace(ANCHOR, hints), 'utf8');
    added++;
  }
}
console.log(`${added} pages got hero preloads; ${skipped} already had preloads; ${warned} warnings.`);
if (added + skipped !== 146 && added > 0) {
  console.warn(`Expected to cover 146 templated pages, covered ${added + skipped} — grep image-set usage before trusting this run.`);
}
