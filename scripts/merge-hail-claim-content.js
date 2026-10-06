#!/usr/bin/env node
/**
 * merge-hail-claim-content.js — one-shot codemod (2026-08-02), STEP 1 of 2.
 *
 * Folds the genuinely unique content of the five
 * /services/hail-damage-insurance-claim-<city>-oh pages into their
 * /services/hail-damage-<city>-oh twins, so that consolidating the pair
 * (step 2 = consolidate-hail-claim-pages.js) loses nothing.
 *
 * WHY A MERGE AND NOT JUST A DELETE
 * The pages are ~97% identical, but a section-by-section comparison found real
 * content only on the claim side:
 *   • FAQ — ZERO overlap. The generic pages answer "do I have damage?"
 *     (identifying hail damage, hail size, neighbour got a roof); the claim
 *     pages answer "how does the claim work?" (how to start, how long, adjuster
 *     says no damage, must I use their contractor). All 20 claim Q&As are
 *     unique, and they are the half a homeowner with a claim actually searches.
 *   • Local facts — Batavia's county-seat status, Loveland's three adjuster
 *     pools, West Chester's 1–2" hail vs the replacement threshold, and the
 *     Xactimate/claim-volume angle for Cincinnati and Mason.
 *   • Scope bullets — Batavia, Loveland and West Chester carry 4 claim-specific
 *     items (impact density, adjuster-formatted documentation package,
 *     post-repair sign-off, Lifetime Pledge). Cincinnati and Mason lists are
 *     already byte-identical, so they are skipped automatically.
 *   • Internal links — the claim pages link the two claim-funnel blog posts,
 *     and on three cities carry a 9-tile service grid where the generic has 3.
 *
 * DESIGN: everything that can be derived is derived (FAQ items, JSON-LD
 * entries, scope bullets and tiles are all extracted from the claim page and
 * set-differenced against the generic). Only the five section-3 paragraphs are
 * hand-written here, because merging prose is an editorial judgement — each one
 * carries only what the generic paragraph does not already say, rather than
 * appending a near-duplicate.
 *
 * Usage:
 *   node scripts/merge-hail-claim-content.js            # dry run (default)
 *   node scripts/merge-hail-claim-content.js --write    # apply
 *
 * Exit codes: 0 ok / 1 nothing to do / 2 fatal (an expected anchor was missing —
 * never half-applies).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVICES = path.join(REPO_ROOT, 'docs', 'services');
const WRITE = process.argv.includes('--write');

const CITIES = ['batavia', 'cincinnati', 'loveland', 'mason', 'west-chester'];

// Section-3 prose. `mode: 'append'` adds a second <p> inside .local-box;
// `mode: 'replace'` swaps the existing one (Loveland's generic paragraph is a
// single thin sentence that the claim version strictly improves on).
const LOCAL_BOX_MERGE = {
  batavia: {
    mode: 'append',
    html: 'Batavia is the Clermont County seat, and claims out here are more likely to be under-documented or underpaid on the first pass — which is exactly where 7+ years of insurance restoration experience changes the outcome.',
  },
  cincinnati: {
    mode: 'append',
    html: 'Hamilton County processes thousands of hail claims after a major storm, and that volume means some get underpaid on the first pass. My documentation is thorough and line-itemized, so you have clear photos and an itemized estimate to share with your insurer. What the claim pays is up to your insurer.',
  },
  loveland: {
    mode: 'replace',
    html: 'Loveland spans three counties — Clermont, Hamilton, and Warren — which means hail claims may be processed through different adjuster pools depending on where your home sits. I&rsquo;ve worked insurance claims across all three county markets and know how to document damage in a format that works regardless of which insurer or adjuster you&rsquo;re dealing with.',
  },
  mason: {
    mode: 'append',
    html: 'Warren County processes hundreds of hail claims every year after major storms — and some get missed on the first pass. My documentation is thorough and line-itemized, so you have clear photos and an itemized estimate to share with your insurer. What the claim pays is up to your insurer.',
  },
  'west-chester': {
    mode: 'append',
    html: 'Spring events routinely produce 1- to 2-inch hail that exceeds the threshold for full roof replacement under most policies. I have 7+ years of insurance restoration experience and know how to document Butler County hail damage in a format that supports full claim approval.',
  },
};

const genericFile = c => path.join(SERVICES, `hail-damage-${c}-oh.html`);
const claimFile = c => path.join(SERVICES, `hail-damage-insurance-claim-${c}-oh.html`);

function fatal(msg) { console.error(`FATAL: ${msg}`); process.exit(2); }

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-merge`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Normalise a captured block so appending several in a row keeps one element
 * per line. The capture regexes make the trailing newline optional, so without
 * this the appended blocks concatenate onto the previous element's line —
 * valid HTML, but it wrecks the file's formatting and every future diff.
 */
const asOwnLine = block => (block.endsWith('\n') ? block : block + '\n');

/** All <div class="faq-item">…</div> blocks, in order. */
function extractFaqItems(src, label) {
  const items = [];
  const re = /[ \t]*<div class="faq-item">[\s\S]*?<\/div>\s*<\/div>\n?/g;
  let m;
  while ((m = re.exec(src))) items.push(m[0]);
  if (!items.length) fatal(`no faq-item blocks found in ${label}`);
  return items;
}

/**
 * The FAQPage JSON-LD <script> block and its parsed object.
 * These blocks are written both inline and pretty-printed across many lines,
 * so parse every ld+json block and pick the FAQPage one rather than trying to
 * pattern-match the object's shape.
 */
function findFaqSchema(src, label) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1].trim();
    if (!body.includes('"FAQPage"')) continue;
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      fatal(`FAQPage JSON-LD in ${label} does not parse: ${e.message}`);
    }
    if (parsed && parsed['@type'] === 'FAQPage') return { whole: m[0], json: body, parsed };
  }
  fatal(`no FAQPage JSON-LD found in ${label}`);
}

/**
 * End index (exclusive) of the <div> opening at `openIdx`, matching nesting.
 * The tiles contain their own <div>s, so a non-greedy /<div…>[\s\S]*?<\/div>/
 * stops inside the first tile — this walks the tags instead.
 */
function endOfDiv(src, openIdx) {
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = openIdx;
  let depth = 0, m;
  while ((m = tagRe.exec(src))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** Byte ranges of every <div class="svc-grid"> block. */
function svcGridRanges(src) {
  const ranges = [];
  const re = /<div class="svc-grid">/g;
  let m;
  while ((m = re.exec(src))) {
    const end = endOfDiv(src, m.index);
    if (end > 0) ranges.push({ start: m.index, end });
  }
  return ranges;
}

/** Anchor tiles inside a grid, keyed by href. */
function extractTiles(src) {
  const tiles = new Map();
  const re = /[ \t]*<a href="(\/[^"]+)"[^>]*class="svc-card"[^>]*>[\s\S]*?<\/a>\n?/g;
  let m;
  while ((m = re.exec(src))) if (!tiles.has(m[1])) tiles.set(m[1], m[0]);
  return tiles;
}

function main() {
  const report = [];

  for (const city of CITIES) {
    const gPath = genericFile(city), cPath = claimFile(city);
    if (!fs.existsSync(gPath)) fatal(`missing generic page for ${city}`);
    if (!fs.existsSync(cPath)) fatal(`missing claim page for ${city} — run this BEFORE consolidate-hail-claim-pages.js`);

    const claim = fs.readFileSync(cPath, 'utf8');
    let generic = fs.readFileSync(gPath, 'utf8');
    const changes = [];

    // ── 1. FAQ items — append the claim's, keep the generic's ──────────────
    const claimFaqs = extractFaqItems(claim, path.basename(cPath));
    const genericFaqs = extractFaqItems(generic, path.basename(gPath));
    const genericQuestions = new Set(
      genericFaqs.map(f => (f.match(/<div class="faq-q">([\s\S]*?)<span/) || [, ''])[1].trim())
    );
    const newFaqs = claimFaqs.filter(f => {
      const q = (f.match(/<div class="faq-q">([\s\S]*?)<span/) || [, ''])[1].trim();
      return q && !genericQuestions.has(q);
    });
    if (newFaqs.length) {
      const lastFaq = genericFaqs[genericFaqs.length - 1];
      const at = generic.lastIndexOf(lastFaq);
      if (at < 0) fatal(`could not locate the last FAQ item in ${path.basename(gPath)}`);
      generic = generic.slice(0, at + lastFaq.length) + newFaqs.map(asOwnLine).join('') + generic.slice(at + lastFaq.length);
      changes.push(`+${newFaqs.length} FAQ items`);
    }

    // ── 2. FAQPage JSON-LD — mirror the visible merge ──────────────────────
    const gSchema = findFaqSchema(generic, path.basename(gPath));
    const cSchema = findFaqSchema(claim, path.basename(cPath));
    const gEntities = gSchema.parsed.mainEntity || [];
    const cEntities = cSchema.parsed.mainEntity || [];
    const haveQ = new Set(gEntities.map(e => (e.name || '').trim()));
    const addEntities = cEntities.filter(e => e.name && !haveQ.has(e.name.trim()));
    if (addEntities.length) {
      const merged = { ...gSchema.parsed, mainEntity: [...gEntities, ...addEntities] };
      generic = generic.replace(
        gSchema.whole,
        `<script type="application/ld+json">${JSON.stringify(merged)}</script>`
      );
      changes.push(`+${addEntities.length} FAQPage schema entries`);
      if (addEntities.length !== newFaqs.length) {
        console.warn(`  ! ${city}: ${newFaqs.length} visible FAQs but ${addEntities.length} schema entries — verify by hand`);
      }
    }

    // ── 3. Scope bullets ───────────────────────────────────────────────────
    // A plain set difference is WRONG here: the claim list is a full rewrite,
    // so 4 of its 8 bullets are reworded restatements of bullets the generic
    // already has ("Free hail damage inspection with photo documentation" vs
    // "Free hail damage roof inspection — ground-level and on-roof assessment"
    // + "Photo documentation of every hail strike…"). String equality cannot
    // see that, and appending all 8 would build a redundant 16-item list.
    // These four carry genuinely new scope and are identical across the three
    // cities whose claim list differs at all (Cincinnati and Mason already
    // match byte-for-byte, so they take none).
    const CLAIM_ONLY_BULLETS = [
      'Impact density measurement (dents per 10 sq ft)',
      'Documentation package formatted for insurance adjusters',
      'Post-repair inspection and sign-off',
      'NBD Lifetime Pledge',
    ];
    const bulletRe = /[ \t]*<div class="inc-item">[\s\S]*?<\/div>\n?/g;
    const gBullets = generic.match(bulletRe) || [];
    const cBullets = claim.match(bulletRe) || [];
    // trim BEFORE stripping the check glyph — the captured block keeps its
    // leading indentation, so /^✓/ would never match otherwise.
    const norm = s => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().replace(/^✓\s*/, '').trim();
    const haveBullets = new Set(gBullets.map(norm));
    const newBullets = cBullets.filter(b => {
      const t = norm(b);
      return CLAIM_ONLY_BULLETS.includes(t) && !haveBullets.has(t);
    });
    if (newBullets.length) {
      const lastBullet = gBullets[gBullets.length - 1];
      const at = generic.lastIndexOf(lastBullet);
      if (at < 0) fatal(`could not locate the last scope bullet in ${path.basename(gPath)}`);
      generic = generic.slice(0, at + lastBullet.length) + newBullets.map(asOwnLine).join('') + generic.slice(at + lastBullet.length);
      changes.push(`+${newBullets.length} scope bullets`);
    }

    // ── 4. Section-3 local-box prose ───────────────────────────────────────
    const spec = LOCAL_BOX_MERGE[city];
    const boxRe = /(<div class="local-box">\s*<h2>[^<]*<\/h2>\s*)(<p>[\s\S]*?<\/p>)/;
    const boxMatch = generic.match(boxRe);
    if (!boxMatch) fatal(`could not locate the .local-box paragraph in ${path.basename(gPath)}`);
    if (!generic.includes(spec.html)) {
      if (spec.mode === 'replace') {
        generic = generic.replace(boxRe, `$1<p>${spec.html}</p>`);
        changes.push('local-box paragraph replaced');
      } else {
        generic = generic.replace(boxRe, `$1$2\n      <p>${spec.html}</p>`);
        changes.push('+1 local-box paragraph');
      }
    }

    // ── 5. Tiles the generic grid is missing ───────────────────────────────
    // Skip anything pointing at a page this consolidation deletes, or at the
    // generic page itself (a self-link).
    const doomed = new Set(CITIES.map(c => `/services/hail-damage-insurance-claim-${c}-oh`));
    const selfHref = `/services/hail-damage-${city}-oh`;
    const gTiles = extractTiles(generic);
    const cTiles = extractTiles(claim);
    const addTiles = [...cTiles.entries()].filter(([href]) =>
      !gTiles.has(href) && !doomed.has(href) && href !== selfHref
    );
    if (addTiles.length) {
      // Append into the LAST svc-grid (the nearby-cities / blog grid) for blog
      // links, and the first grid for city service links, matching where the
      // claim page had them.
      for (const [href, html] of addTiles) {
        const isBlog = href.startsWith('/blog/');
        const grids = svcGridRanges(generic);
        if (!grids.length) fatal(`no svc-grid found in ${path.basename(gPath)}`);
        // Blog tiles belong in the trailing nearby-cities grid; city service
        // tiles in the first ("More Services in <City>") grid.
        const target = isBlog ? grids[grids.length - 1] : grids[0];
        const block = generic.slice(target.start, target.end);
        const lastAnchor = block.lastIndexOf('</a>');
        if (lastAnchor < 0) fatal(`svc-grid in ${path.basename(gPath)} has no anchors to append after`);
        const insertAt = target.start + lastAnchor + '</a>'.length;
        generic = generic.slice(0, insertAt) + '\n' + html.replace(/\n$/, '') + generic.slice(insertAt);
      }
      changes.push(`+${addTiles.length} tiles (${addTiles.filter(([h]) => h.startsWith('/blog/')).length} blog)`);
    }

    // ── 6. Loveland's broken breadcrumb (position 2 -> a URL with no file) ──
    const badCrumb = '"item": "https://nobigdealwithjoedeal.com/services/hail-damage"}';
    if (generic.includes(badCrumb)) {
      generic = generic.replace(
        badCrumb,
        '"item": "https://nobigdealwithjoedeal.com/services/hail-damage-insurance-claim"}'
      );
      changes.push('breadcrumb position-2 URL fixed');
    }

    if (changes.length && WRITE) writeAtomic(gPath, generic);
    report.push({ city, changes });
  }

  console.log(`${WRITE ? 'APPLIED' : 'DRY RUN'} — merge claim-page content into the generic twins\n`);
  let total = 0;
  for (const r of report) {
    console.log(`  ${r.city.padEnd(14)} ${r.changes.length ? r.changes.join(', ') : '(nothing to merge)'}`);
    total += r.changes.length;
  }
  if (!total) { console.log('\nNothing to do.'); process.exit(1); }
  console.log(`\n${WRITE ? 'Wrote' : 'Would write'} ${report.filter(r => r.changes.length).length} file(s).`);
  if (!WRITE) console.log('Dry run. Re-run with --write to apply.');
  else console.log('Next: node scripts/consolidate-hail-claim-pages.js --write');
  process.exit(0);
}

main();
