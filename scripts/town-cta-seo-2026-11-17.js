#!/usr/bin/env node
/**
 * town-cta-seo-2026-11-17.js — one-off, idempotent page sweep for the town and
 * service pages (Jo approved 2026-11-17). Pages under docs/areas and
 * docs/services are hand-authored: only their marker regions are generated, so
 * these edits cannot live in towns.json or a partial. Re-running is a no-op.
 *
 *   1. CTA: every cal.com button, the "/#contact" estimate buttons and the
 *      "Request Estimate" / "Email Joe" links in a final CTA become one button,
 *      "Book a free inspection" -> /inspect. Phone and sms: links stay.
 *   2. Announcement bar: drop the "One free roof a year" /free-roof slide
 *      (there is no partial for the bar; each page carries its own copy).
 *      docs/index.html and docs/blog/ belong to other lanes and are skipped.
 *   3. Hero proof list (.svc-proof): "Fully insured" plus the live Google
 *      rating hook (same data-nbd-gr-rating hooks /inspect uses), with
 *      "Real Google reviews" kept as the no-JS / failed-fetch fallback.
 *   4. /areas/<town>: one title pattern, a per-town description built from
 *      site-src/data/towns.json (median build year, county), & escaped, og and
 *      twitter cards in step. Cincinnati's H1 stops echoing the homepage.
 *   5. hail-damage-<town> pages: headings follow the "Roof Inspection" title.
 *      Mt. Orab FAQ no longer promises an outcome.
 *
 * Usage: node scripts/town-cta-seo-2026-11-17.js [--check]
 * After a real run: node scripts/stamp-page-dates.mjs --write --date=2026-11-17 <changed pages>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const CHECK = process.argv.includes('--check');
const TOWNS = new Map(require(path.join(ROOT, 'site-src', 'data', 'towns.json')).towns.map((t) => [t.slug, t]));

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(DOCS, p).split(path.sep).join('/');

// ── 1. CTA ────────────────────────────────────────────────────────────
function ctaButtons(h) {
  // cal.com buttons -> /inspect. Keep the calendar icon and the arrow if there was one.
  h = h.replace(/<a href="https:\/\/cal\.com\/[^"]*"[^>]*?class="(btn-cal|btn-white)"[^>]*>([\s\S]*?)<\/a>/g, (m, cls, inner) => {
    const svg = (inner.match(/<svg[\s\S]*?<\/svg>/) || [''])[0];
    const arrow = /→|&rarr;/.test(inner) ? ' →' : '';
    return '<a href="/inspect" class="' + cls + '">' + (svg ? svg + ' ' : '') + 'Book a free inspection' + arrow + '</a>';
  });
  // "Email Joe" mailto and "Request Estimate" -> gone (own line, with its indent)
  h = h.replace(/\n[ \t]*<a href="mailto:[^"]*"[^>]*>[^<]*Email Joe<\/a>/g, '');
  h = h.replace(/\n[ \t]*<a href="\/#contact"[^>]*>Request Estimate<\/a>/g, '');
  // /#contact estimate buttons (not the <li> footer-column link, which is a partial)
  h = h.replace(/<a href="\/#contact" class="(btn-[a-z]+)"((?: style="[^"]*")?)>Get My Free Estimate →<\/a>/g, '<a href="/inspect" class="$1"$2>Book a free inspection →</a>');
  // one /inspect button per button row: drop a second one in the same .hero-btns
  h = h.replace(/(<div class="hero-btns[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/g, (m, open, body, close) => {
    let seen = 0;
    body = body.replace(/\n?[ \t]*<a href="\/inspect"[^>]*>[\s\S]*?<\/a>/g, (a) => (++seen > 1 ? '' : a));
    return open + body + close;
  });
  return h;
}

// ── 2. announcement bar ───────────────────────────────────────────────
function annBar(h) {
  return h.replace(/[ \t]*<div class="ann-slide"[^>]*data-nbd-freeroof-ann="v1"[^>]*>[\s\S]*?<\/div>\n/, '');
}

// ── 3. hero proof ─────────────────────────────────────────────────────
const RATING_LI = '<li>Fully insured</li><li><span data-nbd-gr-rating-wrap hidden><span data-nbd-gr-rating></span> on Google</span><span data-nbd-gr-rating-fallback>Real Google reviews</span></li>';
function heroProof(h) {
  return h.replace(/(<ul class="svc-proof">[^\n]*?)<li>Real Google reviews<\/li>/, '$1' + RATING_LI);
}

// ── 4. area titles / descriptions ─────────────────────────────────────
const escAmp = (s) => s.replace(/&/g, '&amp;');
function areaHead(h, t) {
  const place = t.town + ', ' + t.state;
  const title = 'Roofing, Siding & Gutters in ' + place + ' | NBD';
  const social = 'Roofing, Siding & Gutters in ' + place + ' | No Big Deal Home Solutions';
  const county = t.county.indexOf(' / ') < 0 ? ' (' + t.county + ')' : '';
  const lead = 'Roofing, siding and gutters in ' + place + '. The median home here was built in ' + t.housing.medianYearBuilt + county + '. ';
  let desc = lead + 'Free inspection from Joe Deal: (859) 420-7382.';
  if (desc.length > 155) desc = lead + 'Free inspection: (859) 420-7382.';
  h = h.replace(/<title>[^<]*<\/title>/, '<title>' + escAmp(title) + '</title>');
  h = h.replace(/(<meta name="description" content=")[^"]*(")/, '$1' + escAmp(desc) + '$2');
  h = h.replace(/(<meta property="og:title" content=")[^"]*(")/, '$1' + escAmp(social) + '$2');
  h = h.replace(/(<meta name="twitter:title" content=")[^"]*(")/, '$1' + escAmp(social) + '$2');
  h = h.replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + escAmp(desc) + '$2');
  h = h.replace(/(<meta name="twitter:description" content=")[^"]*(")/, '$1' + escAmp(desc) + '$2');
  if (t.slug === 'cincinnati-oh') {
    h = h.replace('<h1>Your <span>Cincinnati</span> Roofer.<br>It\'s Just Me, Joe.</h1>',
      '<h1>Roofing, Siding &amp; Gutters<br>in <span>Cincinnati</span>. It\'s Just Me, Joe.</h1>');
  }
  return h;
}

// ── 5. hail-damage town pages ─────────────────────────────────────────
function hailHeadings(h) {
  const town = (h.match(/<h1>[\s\S]*?in <span>([^<]*)<\/span>/) || [])[1];
  h = h.replace(/(<h2[^>]*>)([\s\S]*?)(<\/h2>)/g, (m, o, inner, c) => {
    let s = inner;
    s = s.replace(/Hail Damage (?:Insurance Claims|Repair) in /, 'Hail Damage Inspection in ');
    s = s.replace(/^(\S+ )Hail Damage in /, '$1Hail Damage Inspection in ');
    s = s.replace(/Hail Damage (?:Insurance Claims|Repair|Claims|Inspection (?:&amp;|&) Claims) — (<span>)?Full Scope/, 'Hail Damage Inspection — $1Full Scope');
    s = s.replace(/Hail Damage Insurance Claims FAQ/, 'Hail Damage Inspection FAQ');
    s = s.replace(/Hail Claims (on Older|in)/, 'Hail Damage $1');
    if (town) s = s.replace('<span>Hail Damage Insurance Claims Estimate</span>', '<span>Hail Damage Inspection in ' + town + '</span>');
    return o + s + c;
  });
  return h;
}
const MT_ORAB_OLD = 'My free inspection tells you definitively whether a claim is worth pursuing.';
const MT_ORAB_NEW = 'My free inspection documents what is on your roof, with photos, so you can decide whether to file a claim.';

// ── drive ─────────────────────────────────────────────────────────────
const touched = new Map();
function edit(file, fn) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const before = raw.replace(/\r\n/g, '\n');
  const after = fn(before);
  if (after === before) return;
  const out = crlf ? after.replace(/\n/g, '\r\n') : after;
  if (/\r(?!\n)/.test(out)) throw new Error('lone CR in ' + file);
  touched.set(rel(file), true);
  if (!CHECK) fs.writeFileSync(file, out);
}

const all = walk(DOCS, []);
for (const f of all) {
  const r = rel(f);
  if (/^(pro|admin|sites|dev|assets|tools|deploy)\//.test(r)) continue;
  const inAreas = /^areas\/[^/]+\.html$/.test(r) && r !== 'areas/index.html';
  const inServices = /^services\//.test(r);
  const other = !/^(blog\/|index\.html$)/.test(r);
  if (!(inAreas || inServices || other)) continue;
  edit(f, (h) => {
    if (inAreas || inServices) h = ctaButtons(h);
    if (other) h = annBar(h);
    if (inServices) h = heroProof(h);
    if (inAreas) {
      const slug = path.basename(f, '.html');
      if (!TOWNS.has(slug)) throw new Error('no towns.json entry for ' + r);
      h = areaHead(h, TOWNS.get(slug));
    }
    if (/^services\/hail-damage-[a-z-]+-(oh|ky)\.html$/.test(r)) {
      h = hailHeadings(h);
      if (r === 'services/hail-damage-mt-orab-oh.html') h = h.split(MT_ORAB_OLD).join(MT_ORAB_NEW);
    }
    return h;
  });
}
console.log((CHECK ? 'would change ' : 'changed ') + touched.size + ' file(s)');
if (process.argv.includes('--list')) console.log([...touched.keys()].join('\n'));
if (CHECK && touched.size) process.exit(1);
