/**
 * tests/tamko-page-rename.test.js — the TAMKO page's old "Storm Series" URL
 * must 301 to its new home, and the invented name must not come back
 * (2026-09-27).
 *
 * WHY THIS EXISTS. /services/tamko-storm-series was named for a "TAMKO Storm
 * Series" that does not exist: TAMKO sells Heritage, Titan XT, StormFighter
 * FLEX and HailGuard as separate lines and has no product or page by that
 * name. Jo renamed the page to /services/tamko-impact-resistant-shingles.
 * Same shape of protection as tests/ourwork-retired-slugs.test.js:
 *
 *  1. firebase.json 301s every form the old DIRECTORY-INDEX page answered at
 *     (extensionless, .html, trailing slash, /index, /index.html). With the
 *     directory deleted, cleanUrls no longer normalises any of them.
 *  2. Each redirect lands on a page that ships (docs/services/<new>/index.html),
 *     extensionless, and not on another redirect.
 *  3. No file under docs/ still LINKS the old URL — check-site-integrity.js
 *     follows redirects and would pass such a link; this does not. The
 *     sitemap and llms.txt are called out by name, and the sitemap generator's
 *     curated row must name the new slug.
 *  4. The invented product name is gone from public copy: no "Storm Series"
 *     in shipped HTML/JS/TXT/XML (docs/pro/ included — CRM templates are
 *     public in this repo too).
 *
 * The blog post /blog/gaf-timberline-vs-tamko-storm-series keeps its URL
 * (retitled only), so the scan targets /services/tamko-storm-series, not the
 * bare slug fragment.
 *
 * Zero deps. Run: node tests/tamko-page-rename.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const OLD = '/services/tamko-storm-series';
const NEW = '/services/tamko-impact-resistant-shingles';
const NEW_SLUG = 'tamko-impact-resistant-shingles';

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('\nTAMKO PAGE RENAME — old Storm Series URL 301s, new page ships, invented name gone\n');

// ── 1+2. Redirects ───────────────────────────────────────────────────
const redirects = (JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting.redirects) || [];
const bySource = new Map(redirects.map((r) => [r.source, r]));
const FORMS = [OLD, OLD + '.html', OLD + '/', OLD + '/index', OLD + '/index.html'];
for (const src of FORMS) {
  const r = bySource.get(src);
  ok(`${src} has a redirect`, !!r);
  if (!r) continue;
  ok(`${src} is a permanent 301`, r.type === 301, 'type ' + r.type);
  ok(`${src} → ${NEW}`, r.destination === NEW, 'goes to ' + r.destination);
}
ok('the destination is extensionless and slashless (the canonical form)', !/\.html$|\/$/.test(NEW));
ok(`the destination page ships (docs${NEW}/index.html)`, fs.existsSync(path.join(DOCS, NEW, 'index.html')));
ok('the destination is not itself redirected (no chains)', !redirects.some((r) => r.source === NEW || (r.source || '').startsWith(NEW + '/') || r.source === NEW + '.html'));
ok('the old page directory is deleted (a live page behind a redirect is unreachable)', !fs.existsSync(path.join(DOCS, 'services', 'tamko-storm-series')));

const page = fs.readFileSync(path.join(DOCS, NEW, 'index.html'), 'utf8');
ok('new page canonical names the new URL', page.includes(`<link rel="canonical" href="https://nobigdealwithjoedeal.com${NEW}">`));
ok('new page nav partial focuses the new URL', page.includes(`focus_href="${NEW}"`));

// ── 3. No surface still links the old URL ────────────────────────────
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

const oldRe = /\/services\/tamko-storm-series(?![a-z0-9-])/g;
const linkHits = [];
const nameHits = [];
const nameRe = /storm[\s-]?series/gi;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let m;
  oldRe.lastIndex = 0;
  while ((m = oldRe.exec(src))) linkHits.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
  // The kept blog slug and the page's own section ids (id="storm-series",
  // never linked) are URL/DOM plumbing, not copy — strip before scanning.
  const copy = src
    .replace(/gaf-timberline-vs-tamko-storm-series/g, '')
    .replace(/id="storm-series"/g, '');
  nameRe.lastIndex = 0;
  while ((m = nameRe.exec(copy))) nameHits.push(`${rel}:${copy.slice(0, m.index).split('\n').length}`);
}
ok(`no file under docs/ links ${OLD} (${files.length} files scanned)`, linkHits.length === 0, linkHits.slice(0, 10).join('; '));
ok('no file under docs/ calls anything "Storm Series"', nameHits.length === 0, nameHits.slice(0, 10).join('; '));

const sitemap = fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8');
const llms = fs.readFileSync(path.join(DOCS, 'llms.txt'), 'utf8');
ok('sitemap.xml does not list the old URL', !/\/services\/tamko-storm-series(?![a-z0-9-])/.test(sitemap));
ok('sitemap.xml lists the new URL', sitemap.includes(`<loc>https://nobigdealwithjoedeal.com${NEW}</loc>`));
ok('llms.txt does not list the old URL', !/\/services\/tamko-storm-series(?![a-z0-9-])/.test(llms));
ok('llms.txt lists the new URL', llms.includes(`https://nobigdealwithjoedeal.com${NEW}`));

const sitemapGen = fs.readFileSync(path.join(ROOT, 'scripts', 'build-sitemap.js'), 'utf8');
ok('build-sitemap.js curated row names the new slug (the sitemap is curated, not globbed)',
  sitemapGen.includes(`'${NEW_SLUG}'`) && !/\['tamko-storm-series'/.test(sitemapGen));

// ── Self-checks: the scanners must be able to see what they guard ────
oldRe.lastIndex = 0;
ok('scanner self-check: a planted old link is detected', oldRe.test(`<a href="${OLD}">x</a>`));
oldRe.lastIndex = 0;
ok('scanner self-check: a longer slug that merely starts with the old one is not', !oldRe.test(`<a href="${OLD}-extra">x</a>`));
nameRe.lastIndex = 0;
ok('scanner self-check: planted "TAMKO Storm Series" copy is detected', nameRe.test('I install the TAMKO Storm Series'));

console.log('\n' + '─'.repeat(50));
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
