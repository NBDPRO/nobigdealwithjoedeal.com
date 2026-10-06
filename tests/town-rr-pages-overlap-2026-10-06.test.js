/**
 * tests/town-rr-pages-overlap-2026-10-06.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * The 2026-10-06 SEO/AEO audit (nbd-content/seo-aeo-audit-2026-10-06.md, §1c-5)
 * measured the Mason, West Chester, Batavia and Loveland roof-replacement town
 * pages at 0.51-0.58 pairwise overlap (5-gram Jaccard of the main text, town
 * names masked). Every other town-page family was at or below 0.46 and the
 * /areas pages average 0.22, so these four were the doorway-page pattern the
 * 2026-09-27 de-templating (build-town-pages.mjs) removed everywhere else.
 * Mason, the hometown, sat at position ~32 for its money terms.
 *
 * These four pages are hand-authored (no generator owns their body), so the
 * only thing that keeps them distinct is this test. It fails when any pair's
 * overlap reaches MAX_PAIR, so copying one town's section into another, or
 * re-templating the four, goes red.
 *
 * WHAT "MAIN TEXT" MEANS HERE
 * ───────────────────────────
 * Everything a visitor reads inside <main>…</main>, with:
 *   - the shared nbd:partial regions removed (mobile nav — identical on every
 *     page by design, not page content);
 *   - <script>/<style> blocks, tags and HTML comments removed;
 *   - entities decoded, lower-cased, punctuation dropped;
 *   - every one of the four town names masked to "TOWN", so "in Mason" and
 *     "in Loveland" count as the same words (otherwise the names alone would
 *     make two copies look different).
 * Generator-owned OURWORK-LOCAL regions are KEPT: they ship and a crawler
 * reads them. The score is |A ∩ B| / |A ∪ B| over the sets of word 5-grams.
 *
 * Pure-Node, zero-dep. Run: node tests/town-rr-pages-overlap-2026-10-06.test.js
 *                       or: node tests/town-rr-pages-overlap-2026-10-06.test.js --report
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = {
  'Mason': 'docs/services/roof-replacement-mason-oh.html',
  'West Chester': 'docs/services/roof-replacement-west-chester-oh.html',
  'Batavia': 'docs/services/roof-replacement-batavia-oh.html',
  'Loveland': 'docs/services/roof-replacement-loveland-oh.html',
};
// The audit's target for this family was "under 0.3". The rewrite measured
// well under it; the ceiling leaves room for small copy edits, not a re-template.
const MAX_PAIR = 0.30;
const N = 5;

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', middot: '·', mdash: '—', ndash: '–', trade: '™', reg: '®', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
}

function mainText(src) {
  const m = src.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (!m) return null;
  let s = m[1];
  s = s.replace(/<!--\s*nbd:partial\s+([a-z0-9-]+)[\s\S]*?<!--\s*\/nbd:partial\s+\1\s*-->/gi, ' ');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decode(s).toLowerCase();
  for (const town of Object.keys(PAGES)) s = s.split(town.toLowerCase()).join(' town ');
  return s.replace(/[^a-z0-9$%.]+/g, ' ').replace(/\.(?=\s|$)/g, ' ').split(/\s+/).filter(Boolean);
}

function grams(words) {
  const g = new Set();
  for (let i = 0; i + N <= words.length; i++) g.add(words.slice(i, i + N).join(' '));
  return g;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function measure(read) {
  const G = {}, W = {};
  for (const [town, rel] of Object.entries(PAGES)) {
    const words = mainText(read(rel));
    W[town] = words; G[town] = words ? grams(words) : null;
  }
  const pairs = [];
  const towns = Object.keys(PAGES);
  for (let i = 0; i < towns.length; i++) {
    for (let j = i + 1; j < towns.length; j++) {
      const a = towns[i], b = towns[j];
      pairs.push({ a, b, score: G[a] && G[b] ? jaccard(G[a], G[b]) : NaN });
    }
  }
  return { pairs, W };
}

module.exports = { measure, mainText, MAX_PAIR, PAGES };

if (require.main === module) {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  console.log('town roof-replacement pages: pairwise 5-gram overlap (town names masked)');
  const { pairs, W } = measure(read);

  for (const [town, rel] of Object.entries(PAGES)) {
    ok(`${town}: page exists and has a <main> region`, Array.isArray(W[town]), rel);
    // A page gutted to near-nothing would score low overlap for the wrong reason.
    ok(`${town}: main text is a real page (>= 450 words)`, (W[town] || []).length >= 450, `${(W[town] || []).length} words`);
  }
  // The 2026-10-06 rewrite left "[JO: …]" prompts where only Jo knows the
  // answer (a job he remembers, a permit fee). They must never ship, so this
  // stays red until every one is replaced or removed.
  for (const [town, rel] of Object.entries(PAGES)) {
    const left = (read(rel).match(/\[JO:/g) || []).length;
    ok(`${town}: no unresolved [JO: …] prompts`, left === 0, `${left} left in ${rel}`);
  }
  for (const p of pairs) {
    ok(`${p.a} vs ${p.b}: overlap ${p.score.toFixed(3)} < ${MAX_PAIR}`, p.score < MAX_PAIR);
  }
  if (process.argv.includes('--report')) {
    const mean = pairs.reduce((s, p) => s + p.score, 0) / pairs.length;
    console.log(`  mean ${mean.toFixed(3)}, max ${Math.max(...pairs.map((p) => p.score)).toFixed(3)}`);
  }

  // Self-check: the metric must be able to fail. Two copies of one page with
  // only the town swapped must score ~1, or the masking/extraction is broken
  // and every pass above is vacuous.
  const mason = read(PAGES['Mason']);
  const clone = mason.split('Mason').join('Loveland');
  const self = measure((rel) => (rel === PAGES['Loveland'] ? clone : read(rel))).pairs.find((p) => p.a === 'Mason' && p.b === 'Loveland');
  ok(`self-check: a town-swapped clone scores >= 0.9 (got ${self.score.toFixed(3)})`, self.score >= 0.9);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
