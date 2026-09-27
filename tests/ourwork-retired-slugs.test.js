/**
 * tests/ourwork-retired-slugs.test.js — a merged-away /our-work case study
 * must 301 to the page it was merged into, and must not survive anywhere
 * else on the site (2026-09-27).
 *
 * WHY THIS EXISTS. Four jobs were published twice under two slugs each (the
 * Newport siding job was also posted as Cincinnati, the brick hip-roof
 * tear-off also as a "duplex" card, and the Sycamore Township and West
 * Liberty jobs split into install-day + finished cards). Jo merged each pair
 * into one case study. build-projects.mjs deletes a retired slug's page on
 * its own, but three things it cannot do were done by hand and are pinned
 * here:
 *
 *  1. firebase.json 301s for the retired URLs (extensionless AND .html) — the
 *     old URLs are in Google's index and in GBP posts. Without them the
 *     merge turns every inbound link into a 404.
 *  2. The 301 must land on a page that ships: a live slug in projects.json
 *     whose docs/our-work/<slug>.html exists, and not on another redirect.
 *  3. No retired slug may still be LINKED from the site — sitemap, llms.txt,
 *     a hand-written paragraph (docs/services/commercial-roofing.html linked
 *     /our-work/apartment-complex-complete by hand). check-site-integrity.js
 *     passes such a link because it follows the redirect; this does not.
 *
 * The retired set is read from firebase.json (any /our-work/<slug> redirect),
 * so a future merge is covered by adding its redirects; EXPECTED below is a
 * floor, so the 2026-09-27 redirects can't be deleted without a red.
 *
 * Zero deps. Run: node tests/ourwork-retired-slugs.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Jo's 2026-09-27 merge decisions: retired slug → the case study it became.
const EXPECTED = {
  'cincinnati-oh-siding-repair-2026': 'newport-ky-siding-top-course-2026',
  'brick-duplex-designer-reroof-2026': 'cincinnati-oh-full-tearoff-reroof-2026',
  'brick-underlayment-install': 'multi-section-complex-roof',
  'apartment-complex-complete': 'apartment-complex-tearoff',
};

const hosting = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting;
const redirects = hosting.redirects || [];
const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'assets', 'data', 'projects.json'), 'utf8'));
const allSlugs = new Set(manifest.projects.map((p) => p.slug));
const today = new Date(); today.setHours(0, 0, 0, 0);
const liveSlugs = new Set(manifest.projects.filter((p) => {
  const d = new Date(p.published); d.setHours(0, 0, 0, 0);
  return d <= today;
}).map((p) => p.slug));

// Every /our-work/<slug>[.html] redirect in firebase.json, keyed by slug.
const OW_SRC = /^\/our-work\/([a-z0-9]+(?:-[a-z0-9]+)*)(\.html)?$/;
const retired = new Map();                   // slug → { plain, html }
for (const r of redirects) {
  const m = OW_SRC.exec(r.source || '');
  if (!m) continue;
  const e = retired.get(m[1]) || {};
  e[m[2] ? 'html' : 'plain'] = r;
  retired.set(m[1], e);
}

console.log('\nOUR-WORK RETIRED SLUGS — 301 to the kept case study, gone from every surface\n');

ok('firebase.json carries a /our-work redirect for every 2026-09-27 retired slug',
  Object.keys(EXPECTED).every((s) => retired.has(s)),
  Object.keys(EXPECTED).filter((s) => !retired.has(s)).join(', '));

for (const [slug, e] of retired) {
  const expectDest = EXPECTED[slug];
  for (const form of ['plain', 'html']) {
    const r = e[form];
    const label = `/our-work/${slug}${form === 'html' ? '.html' : ''}`;
    ok(`${label} has a redirect`, !!r, 'both the extensionless and the .html URL must redirect');
    if (!r) continue;
    ok(`${label} is a permanent 301`, r.type === 301, `type ${r.type}`);
    const dm = /^\/our-work\/([a-z0-9-]+)$/.exec(r.destination || '');
    ok(`${label} → an extensionless /our-work/<slug> page`, !!dm, r.destination);
    if (!dm) continue;
    const kept = dm[1];
    if (expectDest) ok(`${label} → /our-work/${expectDest} (Jo's merge decision)`, kept === expectDest, `goes to ${kept}`);
    ok(`${label} destination is a live project`, liveSlugs.has(kept), kept);
    ok(`${label} destination page ships (docs/our-work/${kept}.html)`,
      fs.existsSync(path.join(DOCS, 'our-work', `${kept}.html`)));
    ok(`${label} destination is not itself redirected (no chains)`, !retired.has(kept));
  }
  ok(`${slug} is out of projects.json (a live entry behind a redirect is unreachable)`, !allSlugs.has(slug));
  ok(`docs/our-work/${slug}.html is deleted`, !fs.existsSync(path.join(DOCS, 'our-work', `${slug}.html`)));
}

// ── No surface still names a retired URL ─────────────────────────────
// Walk every text file that ships under docs/ and look for the URL form
// (/our-work/<slug> followed by a non-slug character). Image filenames that
// still carry a retired slug (photos merged into the kept page) live under
// /assets/images/projects/, never under /our-work/, so they don't match.
const TEXT_EXT = new Set(['.html', '.xml', '.txt', '.json', '.js', '.mjs', '.css', '.md', '.webmanifest']);
const files = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (TEXT_EXT.has(path.extname(ent.name))) files.push(p);
  }
})(DOCS);

const slugList = [...retired.keys()];
const urlRe = slugList.length
  ? new RegExp(`/our-work/(${slugList.map((s) => s.replace(/[-]/g, '\\-')).join('|')})(?![a-z0-9-])`, 'g')
  : null;
const hits = [];
if (urlRe) {
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    urlRe.lastIndex = 0;
    while ((m = urlRe.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      hits.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${line} ${m[0]}`);
    }
  }
}
ok(`no file under docs/ links a retired /our-work URL (${files.length} files scanned)`, hits.length === 0, hits.slice(0, 10).join('; '));

// The sitemap and llms.txt are called out by name: they are the two surfaces
// that tell crawlers a URL exists, so a regression there is the costly one.
const sitemap = fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8');
const llms = fs.readFileSync(path.join(DOCS, 'llms.txt'), 'utf8');
for (const s of slugList) {
  ok(`sitemap.xml does not list /our-work/${s}`, !new RegExp(`/our-work/${s}(?![a-z0-9-])`).test(sitemap));
  ok(`llms.txt does not list /our-work/${s}`, !new RegExp(`/our-work/${s}(?![a-z0-9-])`).test(llms));
}

// Self-check: the scanner must be able to see a retired link, or its green
// above means nothing.
if (urlRe) {
  urlRe.lastIndex = 0;
  ok('scanner self-check: a planted retired link is detected',
    urlRe.test(`<a href="/our-work/${slugList[0]}">x</a>`));
  urlRe.lastIndex = 0;
  ok('scanner self-check: a longer slug that merely starts with a retired one is not',
    !urlRe.test(`<a href="/our-work/${slugList[0]}-extra">x</a>`));
}

console.log('\n' + '─'.repeat(50));
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
