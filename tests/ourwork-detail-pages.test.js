/**
 * tests/ourwork-detail-pages.test.js — /our-work/<slug> detail pages
 * (2026-09-17).
 *
 * WHY THIS EXISTS. scripts/build-projects.mjs now generates one standalone
 * page per live project into docs/our-work/<slug>.html, on top of the
 * existing gallery. Two failure modes are specific to a GENERATED page that
 * also carries nbd:partial regions it doesn't own:
 *
 *  1. The generator and apply-partials.js fighting over the nav/footer
 *     region — one clobbers what the other just filled in, so --check for
 *     one of them is never simultaneously clean with the other. Caught by
 *     re-running build-projects.mjs against the real, already-partialed
 *     files and asserting nothing changes.
 *  2. A removed/re-slugged project leaving an orphaned, unlinked, still-200
 *     page behind. Caught by asserting the file list matches live slugs
 *     exactly, both directions.
 *
 * Zero deps. Run: node tests/ourwork-detail-pages.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'docs', 'assets', 'data', 'projects.json');
const DETAIL_DIR = path.join(ROOT, 'docs', 'our-work');
const GEN = path.join(ROOT, 'scripts', 'build-projects.mjs');
const OUR_WORK = path.join(ROOT, 'docs', 'our-work.html');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('\nOUR-WORK DETAIL PAGES — generated one per live project\n');

const manifest = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const today = new Date(); today.setHours(0, 0, 0, 0);
const live = manifest.projects.filter((p) => {
  const d = new Date(p.published); d.setHours(0, 0, 0, 0);
  return d <= today;
});
const liveSlugs = new Set(live.map((p) => p.slug));

const onDisk = fs.existsSync(DETAIL_DIR)
  ? fs.readdirSync(DETAIL_DIR).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''))
  : [];
const onDiskSet = new Set(onDisk);

ok('every live project has a detail page on disk',
  live.every((p) => onDiskSet.has(p.slug)),
  live.filter((p) => !onDiskSet.has(p.slug)).map((p) => p.slug).join(', '));
ok('no orphaned detail page for a non-live/removed slug',
  onDisk.every((s) => liveSlugs.has(s)),
  onDisk.filter((s) => !liveSlugs.has(s)).join(', '));

console.log('\nSTRUCTURE — spot-check every generated page');
const titles = new Map();
for (const p of live) {
  const file = path.join(DETAIL_DIR, `${p.slug}.html`);
  if (!fs.existsSync(file)) continue; // already flagged above
  const html = fs.readFileSync(file, 'utf8');
  ok(`${p.slug}: canonical link points at /our-work/${p.slug}`,
    html.includes(`<link rel="canonical" href="https://nobigdealwithjoedeal.com/our-work/${p.slug}">`));
  ok(`${p.slug}: title present`, html.includes(`<h1 class="pd-title">`) && html.includes(esc(p.title)));
  // "| NBD", not "| No Big Deal Home Solutions": the site-wide suffix chosen
  // for the ~60-char search-title budget (scripts/normalize-location-templates.js).
  // The long form made 52 of 53 detail titles overflow (2026-09-24).
  // Since 2026-10-03 the <title> LEADS with service + town — "Roof
  // Replacement in Milford, OH — Forty-Five Squares | NBD" — then the job's
  // own words (whole, or cut back to whole clauses) (titleCandidates() in
  // build-projects.mjs). Until then it led with the job phrase alone, which
  // matched nothing a homeowner searches. og:title / twitter:title carry the
  // same lead with the untrimmed phrase; the H1 keeps the job title as written.
  // Since 2026-10-05 every title is <= 65 chars (check-seo-surface warns
  // above that; 11 sat at 66-75 on the old slack tier): a whole phrase that
  // won't fit sheds " | NBD" first, then the town's state ("Cincinnati").
  {
    const tm = html.match(/<title>([^<]*)<\/title>/);
    const shown = tm ? unesc(tm[1]) : '';
    const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = new RegExp(`^[A-Z][A-Za-z&' -]+ in ${reEsc(p.city)} — `);
    const town = p.city.replace(/, [A-Z]{2}$/, '');
    const titleLead = new RegExp(`^[A-Z][A-Za-z&' -]+ in ${reEsc(town)}(, [A-Z]{2})? — `);
    ok(`${p.slug}: <title> leads with "<Service> in ${p.city} — " (state optional), <= 65 chars`,
      titleLead.test(shown) && shown.length <= 65 && (shown.endsWith(' | NBD') || !shown.includes('|')),
      `got "${shown}" (${shown.length} chars)`);
    ok(`${p.slug}: <title> drops the state only once "| NBD" is gone`,
      lead.test(shown) || !shown.endsWith(' | NBD'), `got "${shown}"`);
    titles.set(shown, (titles.get(shown) || []).concat(p.slug));
    const phrase = p.title.replace(/ — /g, ', ');
    for (const prop of ['property="og:title"', 'name="twitter:title"']) {
      const m = html.match(new RegExp(`<meta ${prop} content="([^"]*)">`));
      const v = m ? unesc(m[1]) : '';
      ok(`${p.slug}: ${prop.split('"')[1]} = same service + town lead + the whole job phrase`,
        lead.test(v) && v.endsWith(` — ${phrase}`), `got "${v}"`);
    }
  }
  // The site-wide sticky Call/Text bar every other template carries
  // (mobile-cta.css, mobile only). Case pages lacked it until 2026-10-03.
  ok(`${p.slug}: sticky mobile Call/Text bar present and styled`,
    html.includes('<link rel="stylesheet" href="/assets/css/mobile-cta.css">')
      && /<div class="mobile-cta-strip"[^>]*>\s*<a href="tel:\+18594207382" class="mobile-cta-call">[\s\S]*?<a href="sms:\+18594207382" class="mobile-cta-text">/.test(html)
      && html.indexOf('class="mobile-cta-strip"') > html.indexOf('<!-- /nbd:partial footer-standard -->'));
  ok(`${p.slug}: Service + BreadcrumbList JSON-LD present`,
    /"@type":"Service"/.test(html) && /"@type":"BreadcrumbList"/.test(html));
  ok(`${p.slug}: nav-standard region is FILLED, not an empty marker pair (apply-partials ran)`,
    /<!-- nbd:partial nav-standard[^>]*-->\r?\n<nav/.test(html));
  ok(`${p.slug}: footer-standard region is FILLED, not an empty marker pair`,
    /<!-- nbd:partial footer-standard[^>]*-->\r?\n<footer/.test(html));
  ok(`${p.slug}: every photo appears in the gallery`,
    p.photos.every((ph) => html.includes(esc(ph.src))));
  ok(`${p.slug}: links back to the listing`, html.includes('href="/our-work"'));
  // "Book an inspection like this" (2026-10-05): right under the write-up and
  // again at the end; a plain /inspect link (no slug/UTM on an internal link).
  ok(`${p.slug}: "Book an inspection like this" under the write-up and at the end`,
    (html.match(/<div class="pd-book(?: pd-book-end)?"><a class="project-book" href="\/inspect">Book an inspection like this &rarr;<\/a><\/div>/g) || []).length === 2
      && html.indexOf('class="pd-book"') > html.indexOf('class="pd-desc"'));
  ok(`${p.slug}: photo figures carry no inline style attributes`,
    !/<figure[^>]*style=|<figcaption[^>]*style=/.test(html));
}

{
  const dupes = [...titles].filter(([, s]) => s.length > 1);
  ok('every case page has its own <title>', dupes.length === 0,
    dupes.map(([t, s]) => `"${t}": ${s.join(', ')}`).join('; '));
}

console.log('\nCARD LINK — the listing gallery links out to each detail page');
{
  const ourWorkHtml = fs.readFileSync(OUR_WORK, 'utf8');
  const missing = live.filter((p) => !ourWorkHtml.includes(`href="/our-work/${p.slug}"`));
  ok('every live project card links to its own /our-work/<slug> page',
    missing.length === 0, missing.map((p) => p.slug).join(', '));
  // Every card carries the booking link; the "View full project" link is not a
  // .project-view (our-work.js opens the lightbox on .project-view clicks, so
  // the link used to open the lightbox AND navigate).
  const books = (ourWorkHtml.match(/<a class="project-book" href="\/inspect">Book an inspection like this &rarr;<\/a>/g) || []).length;
  ok('every gallery card has "Book an inspection like this"', books === live.length, `${books}/${live.length}`);
  ok('no <a> on the gallery carries .project-view', !/<a class="project-view/.test(ourWorkHtml));
  ok('Show-more button ships hidden (no-JS shows every card)',
    /<button type="button" class="ow-more" id="owMore" data-step="12" hidden>/.test(ourWorkHtml));
}

console.log('\nSITEMAP — every detail page is discoverable');
{
  const sitemap = fs.readFileSync(path.join(ROOT, 'docs', 'sitemap.xml'), 'utf8');
  const missing = live.filter((p) => !sitemap.includes(`<loc>https://nobigdealwithjoedeal.com/our-work/${p.slug}</loc>`));
  ok('every live project detail page is listed in sitemap.xml',
    missing.length === 0, missing.map((p) => p.slug).join(', '));
}

console.log('\nGENERATOR SOURCE CONTRACT — the fixes that make this not fight apply-partials.js');
{
  const src = fs.readFileSync(GEN, 'utf8');
  ok('carryOverPartials exists (preserves already-filled nav/footer content)',
    /function carryOverPartials/.test(src));
  ok('carried-over content is normalized to LF before splicing (no double-CRLF bug)',
    /existingMatch\[2\]\.replace\(\/\\r\\n\/g, '\\n'\)/.test(src));
  ok('stale-file cleanup exists for removed/re-slugged projects',
    /orphaned.*no longer a live project slug/.test(src));
}

console.log('\nIDEMPOTENCY — re-running the real generator against the real, already-partialed files changes nothing');
{
  const before = new Map(onDisk.map((s) => [s, fs.readFileSync(path.join(DETAIL_DIR, `${s}.html`), 'utf8')]));
  execFileSync(process.execPath, [GEN], { cwd: ROOT, stdio: 'pipe' });
  const after = onDisk.filter((s) =>
    fs.readFileSync(path.join(DETAIL_DIR, `${s}.html`), 'utf8') !== before.get(s));
  ok('re-running build-projects.mjs against already-partialed pages is a no-op',
    after.length === 0, after.join(', '));
}

function unesc(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

console.log('\n' + '─'.repeat(50));
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
