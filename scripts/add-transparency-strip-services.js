#!/usr/bin/env node
/**
 * Adds a small transparency-signals strip to every service page
 * (docs/services/**\/*.html, but not the service-brand subfolders
 * like /services/lumanail/ or /services/the-nbd-guarantee/ which
 * have their own carefully-tuned hero sections).
 *
 * The strip sits right after the service hero's closing </section>
 * and surfaces four concrete honest-work signals:
 *   You deal with me, start to finish · Free written estimates · Clean job site · Fully insured
 *
 * Idempotent via data-nbd-transparency marker.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs', 'services');

// Skip pages that already have a custom brand hero — they have their
// own trust layout and this strip would be redundant.
const SKIP_FILES = new Set([
  'lumanail/index.html',
  'roofivent/index.html',
  'gaf-pivot-boot/index.html',
  'the-nbd-guarantee/index.html',
  'the-nbd-better-build/index.html',
]);

const MARKER = 'data-nbd-transparency="v1"';
const STRIP_HTML = `<!-- Transparency strip (injected) -->
<section ${MARKER} style="background:#fff;border-bottom:1px solid #e8e5e0;padding:22px 5%">
  <div style="max-width:1100px;margin:0 auto;display:flex;flex-wrap:wrap;justify-content:space-around;align-items:center;gap:14px 28px;font-size:.82rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#142a52">
    <span style="display:inline-flex;align-items:center;gap:8px">
      <svg viewBox="0 0 24 24" fill="none" stroke="#e8720c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>
      You deal with me, start to finish
    </span>
    <span style="display:inline-flex;align-items:center;gap:8px">
      <svg viewBox="0 0 24 24" fill="none" stroke="#e8720c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>
      Free written estimates
    </span>
    <span style="display:inline-flex;align-items:center;gap:8px">
      <svg viewBox="0 0 24 24" fill="none" stroke="#e8720c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>
      Clean job site guarantee
    </span>
    <span style="display:inline-flex;align-items:center;gap:8px">
      <svg viewBox="0 0 24 24" fill="none" stroke="#e8720c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>
      Fully insured
    </span>
  </div>
</section>
`;

function walk(dir, rel, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), rel + entry.name + '/', out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push({ full: path.join(dir, entry.name), rel: rel + entry.name });
    }
  }
  return out;
}

/**
 * Insert after the first </section> that follows a <section class="...hero..."
 * or .service-hero element. Falls back to inserting after the very first
 * </section> if no hero-classed section exists.
 */
function insertAfterHero(html) {
  if (html.includes(MARKER)) return { html, changed: false };

  const heroPatterns = [
    /<section[^>]*class="[^"]*(?:service-hero|city-hero|hero)[^"]*"[^>]*>/i,
  ];
  let heroOpenIdx = -1;
  for (const re of heroPatterns) {
    const m = re.exec(html);
    if (m) { heroOpenIdx = m.index; break; }
  }
  if (heroOpenIdx < 0) return { html, changed: false };

  // Balance <section>...</section> after the hero opening.
  const openRe = /<section\b/gi;
  const closeRe = /<\/section>/gi;
  openRe.lastIndex = heroOpenIdx + 1;
  closeRe.lastIndex = heroOpenIdx + 1;
  let depth = 1;
  let i = heroOpenIdx;
  // Skip past the opening tag.
  const firstGt = html.indexOf('>', heroOpenIdx);
  if (firstGt < 0) return { html, changed: false };
  i = firstGt + 1;

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
      i = c.index + c[0].length;
      if (depth === 0) {
        return { html: html.slice(0, i) + '\n\n' + STRIP_HTML + html.slice(i), changed: true };
      }
    }
  }
  return { html, changed: false };
}

const stats = { scanned: 0, injected: 0, skipped: 0, noHero: 0 };
const noHeroSamples = [];

for (const { full, rel } of walk(ROOT, '')) {
  stats.scanned++;
  if (SKIP_FILES.has(rel.replace(/\\/g, '/'))) { stats.skipped++; continue; }

  const html = fs.readFileSync(full, 'utf8');
  const result = insertAfterHero(html);
  if (result.changed) {
    fs.writeFileSync(full, result.html);
    stats.injected++;
  } else if (!html.includes(MARKER)) {
    stats.noHero++;
    if (noHeroSamples.length < 5) noHeroSamples.push(rel);
  }
}

console.log(JSON.stringify({ stats, noHeroSamples }, null, 2));
