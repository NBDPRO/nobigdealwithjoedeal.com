/**
 * tests/seo-gsc-titles-2026-10-07.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * The 2026-10-07 Search Console pass (documentation/audit/GSC-PASS-2026-10-07.md)
 * found pages that Google already shows on page 1–2 but nobody clicks, because
 * the title/description didn't match what people typed:
 *   - town pages titled "Roofing, Siding & Gutters in <Town>" while the queries
 *     are "roofing <town>", "roofer <town>", "roof repair <town>"
 *     (Fort Mitchell: position ~5, 94 impressions, 0 clicks);
 *   - one boilerplate description on every town page ("Honest roofing, siding &
 *     gutter services in <Town>. Free inspections, claim documentation…");
 *   - Mason/Cincinnati titles selling "Insurance Claims"/"Storm Claims";
 *   - a blog post winning "roof replacement cincinnati" while its body link
 *     pointed at the region hub, not the Cincinnati town page.
 *
 * These pins go red if a rewritten title/description drifts back to the old
 * wording, falls outside 50–60 / 120–155 characters, or the blog link moves.
 * HTML comments are stripped first. Pure-Node, zero-dep.
 * Run: node tests/seo-gsc-titles-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const read = (rel) => fs.readFileSync(path.join(DOCS, rel), 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
const dec = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const one = (re, s) => { const m = re.exec(s); return m ? dec(m[1]) : ''; };
const head = (rel) => {
  const src = read(rel);
  return {
    src,
    title: one(/<title>([^<]*)<\/title>/, src),
    desc: one(/<meta name="description" content="([^"]*)"/, src),
  };
};

// page -> [regex the title must match, regex the description must match]
const PAGES = {
  'areas/fort-mitchell-ky.html': [/^Fort Mitchell, KY Roofer \| Roof Repair/, /Fort Mitchell, KY/],
  'areas/indian-hill-oh.html': [/^Indian Hill, OH Roofer \| Roof Repair/, /Indian Hill, OH/],
  'areas/amelia-oh.html': [/^Amelia, OH Roofer \| Roof Repair/, /Amelia, OH/],
  'areas/mt-orab-oh.html': [/^Mt\. Orab, OH Roofer \| Roof Repair/, /Mount Orab, OH/],
  'areas/loveland-oh.html': [/^Loveland, OH Roofer \|/, /Loveland, OH/],
  'areas/montgomery-oh.html': [/^Montgomery, OH Roofer \| Siding Contractor/, /Montgomery, OH/],
  'areas/mason-oh.html': [/^Mason, OH Roofer \|/, null],
  'areas/cincinnati-oh.html': [/^Cincinnati, OH Roofer \|/, null],
  'services/siding-replacement-loveland-oh.html': [/^Siding Replacement in Loveland, OH \| James Hardie/, /James Hardie/],
  'services/lumanail/index.html': [/^LumaNail Orange Roofing Nails/, /orange, ring-shank/],
  'services/roof-replacement-lexington-ky.html': [/^Roof Replacement in Lexington, KY \| Free Estimate/, /Lexington, KY/],
  'blog/gaf-timberline-vs-tamko-storm-series.html': [null, /StormFighter Flex/],
  'blog/gaf-vs-owens-corning-vs-atlas-shingles.html': [null, /Class 4/],
  'blog/gaf-timberline-hdz-vs-tamko-stormfighter-flex.html': [/StormFighter Flex: A Roofer's Review/, /warranty/],
};

console.log('1. retitled pages match the queries Search Console shows for them');
for (const [rel, [tRe, dRe]] of Object.entries(PAGES)) {
  const h = head(rel);
  if (tRe) {
    ok(rel + ': title matches ' + tRe, tRe.test(h.title), h.title);
    ok(rel + ': title is 50–60 chars', h.title.length >= 50 && h.title.length <= 60, h.title.length + ' chars');
  }
  if (dRe) {
    ok(rel + ': description matches ' + dRe, dRe.test(h.desc), h.desc);
    ok(rel + ': description is 120–155 chars', h.desc.length >= 120 && h.desc.length <= 155, h.desc.length + ' chars');
  }
}

console.log('\n2. no boilerplate or claim-selling wording came back');
const BOILER = /^Honest roofing, siding & gutter services in /;
for (const rel of Object.keys(PAGES).filter((r) => r.startsWith('areas/'))) {
  const h = head(rel);
  if (PAGES[rel][1]) ok(rel + ': description is not the shared boilerplate', !BOILER.test(h.desc), h.desc);
  ok(rel + ': title does not sell "Insurance Claims"/"Storm Claims"', !/(Insurance|Storm) Claims/i.test(h.title), h.title);
  ok(rel + ': no "Licensed" in title/description (Fully insured, never Licensed)', !/\blicensed\b/i.test(h.title + ' ' + h.desc));
}
{
  const h = head('areas/fort-mitchell-ky.html');
  ok('Kentucky town page description does not mention claims', !/claim/i.test(h.desc), h.desc);
}

console.log('\n3. the post that ranks for "roof replacement cincinnati" links the Cincinnati town page');
{
  const src = read('blog/how-long-does-roof-replacement-take-cincinnati.html');
  ok('how-long post body links /services/roof-replacement-cincinnati-oh with a Cincinnati anchor',
    /<a href="\/services\/roof-replacement-cincinnati-oh">roof replacement in the Cincinnati area<\/a>/.test(src));
  ok('town page it links to exists', fs.existsSync(path.join(DOCS, 'services/roof-replacement-cincinnati-oh.html')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
