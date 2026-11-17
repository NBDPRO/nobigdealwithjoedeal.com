#!/usr/bin/env node
/**
 * Surfaces /free-roof/ from three touchpoints on every page:
 *   1. Announcement bar — adds a 4th rotating slide
 *   2. Footer copyright line — a "Free Roof Program" link next to Privacy
 *
 * (The dedicated About-page section is a one-off targeted edit, not
 * part of this script.)
 *
 * Idempotent via marker attributes.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const SKIP_DIRS = new Set(['admin', 'pro', 'sites', 'assets', 'deploy', 'tools']);

const ANN_MARKER = 'data-nbd-freeroof-ann="v1"';
const ANN_SLIDE_HTML = `  <div class="ann-slide" ${ANN_MARKER}><a href="/free-roof/" style="color:inherit;text-decoration:none"><svg class="ico" viewBox="0 0 24 24" style="margin-right:6px"><path d="M3 11 L12 3 L21 11"/><path d="M5 10 V20 H19 V10"/></svg>One free roof a year — nominate a Cincinnati neighbor &rarr;</a></div>
</div>`;

const FOOTER_MARKER = 'data-nbd-freeroof-footer="v1"';
const FOOTER_LINK = ` <span style="opacity:.4">·</span> <a href="/free-roof/" ${FOOTER_MARKER} style="color:inherit;text-decoration:none">Free Roof Program</a>`;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Append a new slide before the </div> that closes the .ann-bar.
 * Rather than parse, we look for the sequence of ann-slide divs and
 * locate the LAST </div> inside the ann-bar container.
 */
function injectAnnSlide(html) {
  if (html.includes(ANN_MARKER)) return { html, changed: false };
  const openTag = '<div class="ann-bar"';
  const start = html.indexOf(openTag);
  if (start < 0) return { html, changed: false };

  // Find matching </div> by counting depth.
  let depth = 0;
  let i = start;
  let inTagEnd = html.indexOf('>', start);
  if (inTagEnd < 0) return { html, changed: false };
  depth = 1;
  i = inTagEnd + 1;
  const openRe = /<div\b/g;
  const closeRe = /<\/div>/g;
  while (depth > 0 && i < html.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) return { html, changed: false };
    if (o && o.index < c.index) {
      depth++;
      i = o.index + o[0].length;
    } else {
      depth--;
      if (depth === 0) {
        // Insert the new slide just before this closing </div>.
        const before = html.slice(0, c.index);
        const after = html.slice(c.index);
        return { html: before + ANN_SLIDE_HTML.replace(/\n<\/div>$/, '') + '\n' + after, changed: true };
      }
      i = c.index + c[0].length;
    }
  }
  return { html, changed: false };
}

function injectFooterLink(html) {
  if (html.includes(FOOTER_MARKER)) return { html, changed: false };
  // Hang this off the Privacy link marker dropped by phase C.
  const anchor = 'data-nbd-privacy="1" style="color:inherit;text-decoration:none">Privacy</a>';
  const idx = html.indexOf(anchor);
  if (idx < 0) return { html, changed: false };
  const insertAt = idx + anchor.length;
  return { html: html.slice(0, insertAt) + FOOTER_LINK + html.slice(insertAt), changed: true };
}

const stats = { scanned: 0, annAdded: 0, footerAdded: 0, untouched: 0 };

for (const file of walk(ROOT)) {
  stats.scanned++;
  let html = fs.readFileSync(file, 'utf8');
  let changed = false;

  // 2026-11-17 (Jo): the announcement-bar slide was removed site-wide; do not re-add it.
  const ann = { html, changed: false }; // was injectAnnSlide(html)
  if (ann.changed) { html = ann.html; changed = true; stats.annAdded++; }

  const foot = injectFooterLink(html);
  if (foot.changed) { html = foot.html; changed = true; stats.footerAdded++; }

  if (changed) fs.writeFileSync(file, html);
  else stats.untouched++;
}

console.log(JSON.stringify(stats, null, 2));
