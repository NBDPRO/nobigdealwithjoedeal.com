/**
 * tests/site-round2-2026-10-03.test.js — public-site round 2 (2026-10-03).
 *
 *  1. /estimate legibility: every white-alpha text colour in the page's main
 *     stylesheet clears WCAG AA (4.5:1) against the navy page background
 *     #12223d, and the TCPA consent label + financing disclaimer — legal copy
 *     — are at least 7:1 and at least .8rem. Before: consent .35 alpha at
 *     .68rem (3.13:1), disclaimer .35 at .66rem (3.13:1), 18 more rules at
 *     30–45% white (2.66–4.28:1).
 *  2. Eight blog posts linked to no service page from their article body.
 *  3. /services/roof-care-plan was linked only from roof-inspection, and
 *     /blog/hail-season-prep-checklist only from the blog index.
 *  4. The two hero backgrounds (roofing-1/2.webp, preloaded fetchpriority=high
 *     under a 92%→82% navy overlay) were 162 KB and 229 KB.
 *
 * Contrast is computed (WCAG relative luminance of the alpha-composited
 * colour), not pattern-matched, so a rule at .45 fails however it is spelled.
 *
 * Run: node tests/site-round2-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const read = (rel) => fs.readFileSync(path.join(DOCS, rel), 'utf8');

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error('  ✗ ' + msg); } };

// ── WCAG helpers ──
const BG = [0x12, 0x22, 0x3d];
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
function whiteAlphaRatio(a, bg = BG) {
  const fg = bg.map((c) => Math.round(c + (255 - c) * a));
  const l1 = lum(fg); const l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
// sanity: the helper agrees with known values
ok(Math.abs(whiteAlphaRatio(1) - 15.89) < 0.05, 'helper: pure white on #12223d ≈ 15.89:1');
ok(whiteAlphaRatio(0.35) < 4.5, 'helper: 35% white on #12223d fails AA (the old consent colour)');

// ── 1. estimate.html ──
{
  const html = read('estimate.html');
  const css = ((html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(css.length > 5000, 'estimate.html: found the main stylesheet');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim();
    const body = m[2];
    const c = body.match(/(?:^|;)\s*color:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(0?\.\d+|1)\s*\)/);
    if (c) rules.push({ sel, body, a: parseFloat(c[1]) });
  }
  ok(rules.length >= 30, `estimate.html: parsed white-alpha text rules (got ${rules.length})`);
  for (const r of rules) {
    const ratio = whiteAlphaRatio(r.a);
    ok(ratio >= 4.5, `estimate.html: "${r.sel}" text is ${r.a} white = ${ratio.toFixed(2)}:1 on #12223d (needs ≥ 4.5)`);
  }
  const legal = ['.tcpa-check label', '.result-monthly .rm-disc'];
  for (const sel of legal) {
    const r = rules.find((x) => x.sel === sel);
    ok(!!r, `estimate.html: rule ${sel} exists`);
    if (!r) continue;
    ok(whiteAlphaRatio(r.a) >= 7, `estimate.html: ${sel} is ≥ 7:1 (got ${whiteAlphaRatio(r.a).toFixed(2)}:1)`);
    const fs_ = r.body.match(/font-size:\s*([\d.]+)rem/);
    ok(fs_ && parseFloat(fs_[1]) >= 0.8, `estimate.html: ${sel} font-size ≥ .8rem (got ${fs_ ? fs_[1] : 'none'})`);
  }
}

// ── 2. blog posts link a service page from the article body ──
const articleOf = (html) => {
  const a = html.match(/<article\b[\s\S]*?<\/article>/);
  return a ? a[0].replace(/<!--[\s\S]*?-->/g, '') : '';
};
const POSTS = [
  'how-to-file-storm-damage-insurance-claim-ohio',
  'state-farm-allstate-roof-claims-ohio',
  'my-roof-is-too-old-will-insurance-still-pay',
  'how-to-choose-a-roofer-after-a-storm',
  'how-long-does-roof-replacement-take-cincinnati',
  'hail-season-prep-checklist',
  'tamko-hailguard-first-shingle-with-hail-warranty',
  'why-wont-roofing-suppliers-sell-to-homeowners',
];
for (const slug of POSTS) {
  const body = articleOf(read(`blog/${slug}.html`));
  ok(body.length > 2000, `blog/${slug}: article body found`);
  const links = (body.match(/href="\/services\/[a-z0-9-]+"/g) || []);
  ok(links.length >= 1, `blog/${slug}: article body links at least one /services/ page (got ${links.length})`);
  for (const l of links) {
    const target = l.slice(6, -1).replace(/^\//, '');
    const exists = fs.existsSync(path.join(DOCS, target + '.html')) || fs.existsSync(path.join(DOCS, target, 'index.html'));
    ok(exists, `blog/${slug}: ${target} resolves to a real page`);
  }
}

// ── 3. orphan-ish pages get inbound links from the pages that should send them ──
// Search the page body only: partial/generator regions are stripped so a link
// can't be "found" in shared nav that a restamp would overwrite.
const ownBody = (html) => html
  .replace(/<!-- nbd:partial[\s\S]*?<!-- \/nbd:partial[^>]*-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');
for (const rel of ['services/roof-repair.html', 'the-pledge/index.html', 'services/storm-damage.html']) {
  ok(/href="\/services\/roof-care-plan"/.test(ownBody(read(rel))), `${rel}: links /services/roof-care-plan`);
}
{
  const senders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(DOCS, abs).split(path.sep).join('/');
      if (/^(pro|admin|sites|dev)(\/|$)/.test(rel)) continue;
      if (ent.isDirectory()) walk(abs);
      else if (ent.name.endsWith('.html') && rel !== 'blog/index.html' && rel !== 'blog/hail-season-prep-checklist.html') {
        if (/href="\/blog\/hail-season-prep-checklist"/.test(ownBody(fs.readFileSync(abs, 'utf8')))) senders.push(rel);
      }
    }
  };
  walk(DOCS);
  ok(senders.length >= 2, `hail-season-prep-checklist is linked from ≥ 2 pages besides the blog index (got ${senders.length}: ${senders.join(', ')})`);
}

// ── 4. hero background weight + shape (pure RIFF parse, no deps) ──
function webpInfo(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  let off = 12; let w = 0; let h = 0; const chunks = [];
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    chunks.push(id);
    const d = off + 8;
    if (id === 'VP8X') { w = 1 + buf.readUIntLE(d + 4, 3); h = 1 + buf.readUIntLE(d + 7, 3); }
    else if (id === 'VP8 ' && !w) { w = buf.readUInt16LE(d + 6) & 0x3fff; h = buf.readUInt16LE(d + 8) & 0x3fff; }
    else if (id === 'VP8L' && !w) { const b = buf.readUInt32LE(d + 1); w = (b & 0x3fff) + 1; h = ((b >> 14) & 0x3fff) + 1; }
    off = d + size + (size & 1);
  }
  return { w, h, chunks };
}
for (const [name, max] of [['roofing-1.webp', 65 * 1024], ['roofing-2.webp', 65 * 1024]]) {
  const buf = fs.readFileSync(path.join(DOCS, 'assets/images', name));
  const info = webpInfo(buf);
  ok(!!info, `${name}: is a WebP`);
  if (!info) continue;
  ok(buf.length <= max, `${name}: ≤ ${Math.round(max / 1024)} KB (got ${Math.round(buf.length / 1024)} KB)`);
  ok(info.w === 1600 && info.h === 1200, `${name}: still 1600×1200 (got ${info.w}×${info.h})`);
  ok(!info.chunks.includes('EXIF') && !info.chunks.includes('XMP '), `${name}: carries no EXIF/XMP chunk`);
}

console.log(`site-round2-2026-10-03: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
