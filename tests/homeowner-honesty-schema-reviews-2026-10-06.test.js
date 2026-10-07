/**
 * tests/homeowner-honesty-schema-reviews-2026-10-06.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * Three homeowner-site claims that the 2026-10-06 honesty pass found and Jo
 * ruled on:
 *
 *   1. The site-wide schema-entity partial (on ~290 pages) listed Joe's
 *      knowsAbout as "Hail Damage Claims" and "Storm Damage Claims". Search
 *      and AI engines read that as "Joe is an insurance-claims expert", which
 *      the site must never present. Now "Hail Damage Roof Inspection" and
 *      "Storm Damage Roof Repair".
 *   2. The review count shipped a hard-coded fallback ("29") on / and
 *      /inspect. It was what a visitor saw whenever the live widget fetch
 *      failed, and it went stale the day the next review landed. The count
 *      hook now ships EMPTY inside a `hidden` data-nbd-gr-total-wrap that the
 *      widget reveals only with a live count.
 *   3. /our-work's "Emergency Tarp → Full Replacement" before/after card said
 *      "Insurance covered 100%" (insurance-outcome wording, forbidden) and
 *      paired two photos Jo confirmed are NOT the same house. The same pair
 *      was reused on /services/emergency-roof-tarping as one job ("on the
 *      same home", "once the claim came through"). Both now show two
 *      separate jobs.
 *
 * SCOPE OF (1): every application/ld+json block in the homeowner tree, in the
 * fields that state expertise or identity (knowsAbout, jobTitle, credentials,
 * offer catalog, serviceType, and name/description of business, person and
 * service entities). NOT checked: BreadcrumbList names, which are the title
 * of the page they link to (/services/hail-damage-insurance-claim is labelled
 * "Hail Damage Claims" in the nav; renaming it is a separate SEO decision),
 * and FAQ questions, which are homeowner topics.
 *
 * HOMEOWNER TREE = .html/.js/.json/.txt/.xml under docs/ minus the CRM and
 * private trees (pro/, admin/, dev/, sites/), plus site-src/partials/.
 * Comments are stripped before every check, so a comment that quotes the old
 * text can neither trip nor satisfy a pin.
 *
 * Pure-Node, zero-dep. Run: node tests/homeowner-honesty-schema-reviews-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stripComments(src, rel) {
  if (/\.js$/.test(rel)) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
  }
  return src.replace(/<!--[\s\S]*?-->/g, ' ');
}

const SKIP_TOP = new Set(['pro', 'admin', 'dev', 'sites']);
const FILES = [];
(function walk(dir, top) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (top && SKIP_TOP.has(e.name)) continue;
      if (e.name === 'vendor' || e.name === 'node_modules') continue;
      walk(p, false);
    } else if (/\.(html|js|json|txt|xml)$/.test(e.name) && !/\.min\.js$/.test(e.name)) {
      FILES.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  }
})(DOCS, true);
for (const f of fs.readdirSync(path.join(ROOT, 'site-src', 'partials'))) {
  if (f.endsWith('.html')) FILES.push('site-src/partials/' + f);
}
const HTML = FILES.filter((f) => f.endsWith('.html'));
ok('homeowner tree found (sanity: >250 html files)', HTML.length > 250, String(HTML.length));

// ── 1. No "Damage Claims" in any schema ──────────────────────────────
console.log('\n1. schema never lists "… Damage Claims" as knowledge/expertise');
// Plural on purpose: "… Damage Claims" names a SUBJECT of expertise, while
// "storm damage claim documentation" (photos for the homeowner's own claim)
// is work NBD really does.
const CLAIMS = /damage\s+claims\b/i;
// The fields that say what Joe / NBD KNOWS or IS: knowsAbout, jobTitle,
// credentials, the offer catalog, and the name/description/serviceType of the
// business, person and service entities. FAQ questions ("How long do I have
// to file a storm damage claim?") and article keywords are homeowner topics,
// not expertise claims, and are left to the KY wording scan.
const EXPERT_KEYS = new Set(['knowsAbout', 'jobTitle', 'hasCredential', 'hasOfferCatalog', 'serviceType', 'award', 'hasOccupation']);
const ENTITY_TYPES = /^(?:RoofingContractor|LocalBusiness|HomeAndConstructionBusiness|Organization|Person|Service|Offer|EducationalOccupationalCredential)$/;
function walkJson(node, expert, out, where) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => {
      // knowsAbout is an array of bare strings: check them here, or they are never read.
      if (typeof n === 'string') { if (expert && CLAIMS.test(n)) out.push(where + '[' + i + '] = "' + n + '"'); }
      else walkJson(n, expert, out, where + '[' + i + ']');
    });
    return;
  }
  if (node && typeof node === 'object') {
    const types = [].concat(node['@type'] || []);
    const entity = types.some((t) => ENTITY_TYPES.test(t));
    for (const [k, v] of Object.entries(node)) {
      const inScope = expert || EXPERT_KEYS.has(k)
        || (entity && (k === 'name' || k === 'description' || k === 'alternateName'));
      if (typeof v === 'string') {
        if (inScope && CLAIMS.test(v)) out.push(where + '.' + k + ' = "' + v + '"');
      } else walkJson(v, expert || EXPERT_KEYS.has(k), out, where + '.' + k);
    }
  }
}
const schemaHits = [];
let blocks = 0, unparsed = 0;
for (const rel of HTML) {
  const src = stripComments(read(rel), rel);
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    blocks++;
    let json;
    try { json = JSON.parse(m[1]); } catch (_) { json = null; }
    if (json === null) {
      unparsed++;
      // Can't tell a breadcrumb from an entity here, so any hit counts.
      if (CLAIMS.test(m[1])) schemaHits.push(rel + ': (unparsed block) ' + (m[1].match(/"[^"]*damage\s+claims?[^"]*"/i) || [''])[0]);
      continue;
    }
    const out = [];
    walkJson(json, false, out, '$');
    out.forEach((h) => schemaHits.push(rel + ': ' + h));
  }
}
ok('ld+json blocks scanned (sanity: >300)', blocks > 300, String(blocks));
ok('no "Damage Claims" in any schema value (breadcrumb page titles aside)', schemaHits.length === 0,
  schemaHits.length + ' hit(s), e.g. ' + schemaHits.slice(0, 3).join(' | '));

const entity = read('site-src/partials/schema-entity.html');
ok('schema-entity partial: knowsAbout carries the neutral replacements',
  /"Hail Damage Roof Inspection"/.test(entity) && /"Storm Damage Roof Repair"/.test(entity));
ok('schema-entity partial still credits American Operator (Jo, 2026-10-06: real and active)',
  /Certified by American Operator/.test(entity));

// ── 2. No hard-coded review-count fallback ───────────────────────────
console.log('\n2. no hard-coded review count');
const countHits = [];
for (const rel of FILES) {
  if (rel === 'docs/llms-full.txt') continue; // generated from the pages at deploy; checked via its source pages
  const src = stripComments(read(rel), rel);
  if (/data-nbd-gr-total(?![\w-])[^>]*>\s*\d/.test(src)) countHits.push(rel + ': data-nbd-gr-total ships a number');
  if (/data-nbd-gr-count[^>]*>[^<]*\d+\s+(?:google\s+)?reviews?/i.test(src)) countHits.push(rel + ': data-nbd-gr-count ships a number');
  if (rel.endsWith('.html')) {
    const text = src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const t = text.match(/\b\d+\+?\s+(?:google\s+|five-star\s+|5-star\s+)?reviews\b/i);
    if (t) countHits.push(rel + ': visible text "' + t[0] + '"');
  }
}
ok('no static review count anywhere in the homeowner tree', countHits.length === 0, countHits.join(' | '));

for (const rel of ['docs/index.html', 'docs/inspect.html']) {
  const src = stripComments(read(rel), rel);
  ok(rel + ': count hook sits EMPTY inside a hidden data-nbd-gr-total-wrap',
    /<span data-nbd-gr-total-wrap hidden>[^<]*<span data-nbd-gr-total><\/span>[^<]*<\/span>/.test(src));
}
const widget = stripComments(read('docs/assets/js/google-reviews-widget.js'), 'x.js');
const hydrate = widget.slice(widget.indexOf('function hydrateStaticHooks'), widget.indexOf('let _lastData'));
ok('widget reveals the wrap only after the "no count" early return',
  hydrate.indexOf('if (!total) return;') !== -1
  && hydrate.indexOf('data-nbd-gr-total-wrap') > hydrate.indexOf('if (!total) return;')
  && /\[data-nbd-gr-total-wrap\]'\)\.forEach\(\(el\) => \{\s*el\.hidden = false;/.test(hydrate));

// ── 3. No insurance-outcome "covered" wording; tarp ≠ replacement house ─
console.log('\n3. no "Insurance covered" phrasing; the tarp and replacement photos are two jobs');
const INS = /\binsurance\s+(?:covered|paid(?:\s+for)?)\b|\bcovered\s+100\s*%/i;
const insHits = [];
for (const rel of FILES) {
  const src = stripComments(read(rel), rel);
  const m = src.match(INS);
  if (m) insHits.push(rel + ': "' + m[0] + '"');
}
ok('no "Insurance covered / paid" or "covered 100%" on public pages', insHits.length === 0, insHits.join(' | '));

const TARP = 'before-blue-tarp', ROOF = 'after-new-roof';
const pairHits = [];
for (const rel of HTML) {
  const src = stripComments(read(rel), rel);
  if (!src.includes(TARP)) continue;
  // The two photos may share a page, never one before/after card.
  const cards = src.split(/<div class="ba-pair[^"]*">/).slice(1);
  for (const c of cards) {
    const card = c.slice(0, c.search(/<div class="ba-pair|<\/section>/) >>> 0);
    if (card.includes(TARP) && card.includes(ROOF)) pairHits.push(rel + ': tarp + new-roof in one ba-pair card');
    if (card.includes(TARP) && /ba-label/.test(card)) pairHits.push(rel + ': tarp card carries a Before/After label');
  }
  if (/Emergency Tarp\s*(?:→|&rarr;|-&gt;|->)/i.test(src)) pairHits.push(rel + ': "Emergency Tarp →" heading');
  const alt = (src.match(new RegExp('<img[^>]*' + ROOF + '[^>]*>', 'g')) || []).join(' ');
  if (/same (?:home|house)/i.test(alt)) pairHits.push(rel + ': new-roof alt says "same home"');
  if (/claim came through/i.test(src)) pairHits.push(rel + ': "once the claim came through"');
}
const ourWork = stripComments(read('docs/our-work.html'), 'x.html');
if (/Same house\. Same angle\./.test(ourWork)) pairHits.push('docs/our-work.html: "Same house. Same angle." section intro');
ok('tarp photo never presented as the same job/house as the replacement photo', pairHits.length === 0, pairHits.join(' | '));

console.log('\n' + '─'.repeat(30));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
