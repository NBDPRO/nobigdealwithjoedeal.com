#!/usr/bin/env node
/**
 * build-projects.mjs — regenerates every Featured Projects surface from
 * docs/assets/data/projects.json:
 *
 *   1. docs/our-work.html         — gallery + filters (OURWORK-STATIC) and
 *                                   head JSON-LD (OURWORK-HEAD-SCHEMA; it
 *                                   references #org, never defines it —
 *                                   see site-src/partials/schema-entity.html)
 *   2. docs/services/<hub>.html   — "Recent jobs" strips (OURWORK-STRIP
 *                                   markers, one per hub page; the marker's
 *                                   service="…" attribute picks which
 *                                   projects it shows)
 *   3. docs/assets/data/homeowner-wall.json — homepage photo-wall manifest,
 *                                   derived from the same live projects so
 *                                   the two manifests can never drift
 *   4. docs/our-work/<slug>.html   — one case-study page per live project
 *   5. docs/areas/<town>.html      — "Jobs we've done in <Town>" (OURWORK-AREA,
 *                                   only on towns with ≥1 live job; the
 *                                   generator inserts/removes the region)
 *   6. docs/services/<svc>-<town>.html — "Real <svc> jobs in <Town>"
 *                                   (OURWORK-LOCAL, same insert/remove rule)
 *   7. docs/index.html             — homepage jobs strip (OURWORK-HOME:
 *                                   the HOME_PICKS slugs + live job count)
 *
 * INTERNAL LINKING (2026-09-27): every card on a hub strip, area block and
 * town-service strip links the job's own /our-work/<slug> page, and every
 * case page links back out to its service hub, its town-service page, its
 * area page, and a ring of sibling jobs by service and by town — so the case
 * pages are neither orphans nor dead ends.
 *
 * WHY: /our-work is the Thumbtack-style featured-projects page — real jobs
 * with retail price RANGES, photos, and service filters. The cards must be
 * crawlable static HTML (this is cost-transparency SEO content), but hand-
 * duplicating card markup is the drift class this repo keeps paying for.
 * Same shape as build-blog-index.mjs: a data file is the single editing
 * surface, this script owns the marked regions, CI gates the drift.
 *
 * USAGE:
 *   node scripts/build-projects.mjs            # restamp all surfaces
 *   node scripts/build-projects.mjs --check    # write nothing; exit 1 on drift
 *
 * TAXONOMY: every project carries services[] — 1+ keys of the SERVICES map
 * below. The keys are exactly the /services/ hub filenames, so one list
 * drives the filter buttons, the deep links (#service=<key>), the schema.org
 * serviceType, the card→hub crosslink pills, and which hub strips a job
 * appears in. A job may carry several (a hail-claim tear-off is
 * ["roof-replacement","storm-damage"]). The legacy category field is
 * optional and display-inert (kept on old entries, validated when present).
 *
 * SORTING: surfaces render newest published first (stable tiebreak =
 * manifest order), so new entries are APPENDED at the end of projects.json —
 * the lowest-risk edit — and still show first everywhere.
 *
 * VALIDATION IS THE POINT. This page publishes prices and photos of real
 * jobs, so the generator refuses bad entries loudly instead of shipping
 * them: retail-only keys (a cost/margin key anywhere in the manifest is
 * fatal — tests/catalog-cost-privacy.test.js is the independent backstop),
 * consentOnFile must be literally true, photos must be repo-local
 * re-encoded copies that exist on disk (never CRM storage URLs), and the
 * price range must be a sane both-or-neither pair. A live, priced job must
 * carry `year` — only the named legacy jobs in LEGACY_UNDATED_PRICED
 * (project-price-context.mjs) may omit it, and the failure names the slug.
 *
 * Publish procedure: documentation/runbooks/PUBLISH-PROJECT.md
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { priceContext, parseAsOf, yearRuleErrors } from './project-price-context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'assets', 'data', 'projects.json');
const HTML = path.join(ROOT, 'docs', 'our-work.html');
const SERVICES_DIR = path.join(ROOT, 'docs', 'services');
const WALL = path.join(ROOT, 'docs', 'assets', 'data', 'homeowner-wall.json');
const DETAIL_DIR = path.join(ROOT, 'docs', 'our-work');
const CHECK = process.argv.includes('--check');

// Key = /services/<key>.html hub page = filter value = strip target.
// Order = filter-button order on /our-work.
const SERVICES = {
  'roof-replacement': 'Roof Replacement',
  'roof-repair': 'Roof Repair',
  'commercial-roofing': 'Commercial Roofing',
  'siding-replacement': 'Siding Replacement',
  'siding-repair': 'Siding Repair',
  'wood-siding-repair': 'Wood Siding Repair',
  'shed-roof-replacement': 'Sheds & Outbuildings',
  'gutter-replacement': 'Gutters',
  'gutter-cleaning': 'Gutter Cleaning',
  'storm-damage': 'Storm & Hail',
  'roof-inspection': 'Inspection',
  'interior-repair': 'Interior Repair',
};

// Legacy display facet — optional since the services[] taxonomy (2026-08-10);
// still validated when present so old entries stay well-formed.
const CATEGORIES = {
  replacement: 'Roof Replacement',
  storm: 'Storm Damage',
  active: 'Active Jobsite',
  specialty: 'Metal & Specialty',
  commercial: 'Commercial',
};

const KNOWN_FIELDS = new Set([
  'slug', 'title', 'category', 'services', 'tag', 'city', 'description',
  'hero', 'photos', 'consentOnFile', 'published', 'priceLow', 'priceHigh',
  'year', 'duration',
  // Optional case-study narrative (2026-09-27). Each renders its own H2 on the
  // /our-work/<slug> page ONLY when present — the template never fills a gap
  // with invented copy. Strings, except scope/materials which may also be a
  // list of strings (rendered as a bullet list).
  'problem', 'scope', 'materials', 'timeline', 'outcome',
]);

// Case-study sections, in reading order. key → H2 on the detail page.
const NARRATIVE = [
  ['problem', 'The problem'],
  ['scope', 'What we did'],
  ['materials', 'Materials'],
  ['timeline', 'Timeline'],
  ['outcome', 'Result'],
];
const LIST_OK = new Set(['scope', 'materials']);

// ── Load + validate ─────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(DATA, 'utf8'));
const all = manifest.projects;
const fail = (msg) => { console.error(`FATAL: ${msg}`); process.exitCode = 1; };

if (!Array.isArray(all) || !all.length) { fail('projects.json has no projects[] array'); process.exit(1); }

// Forbidden-key scan over the WHOLE manifest (keys only — values are prose).
// A cost-family key here means someone pasted internal numbers; token/street/
// address means a CRM URL or a real address is about to ship. Fails before
// the catalog-cost-privacy CI sweep would.
const FORBIDDEN_KEY = /cost|contractor|margin|token|address|street/i;
(function scanKeys(node, at) {
  if (Array.isArray(node)) return node.forEach((v, i) => scanKeys(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEY.test(k)) fail(`${at}.${k}: forbidden key (cost/margin/token/address family) — retail figures and city-level location only`);
      scanKeys(v, `${at}.${k}`);
    }
  }
})(manifest, 'manifest');

const IMG_RE = /^\/assets\/[\w./-]+\.(webp|jpg|jpeg|png)$/;   // homeowner-wall.js contract
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const seen = new Set();

for (const p of all) {
  const at = `project "${p.slug || p.title || '?'}"`;
  if (!SLUG_RE.test(p.slug || '')) fail(`${at}: slug must be kebab-case`);
  if (seen.has(p.slug)) fail(`${at}: duplicate slug`);
  seen.add(p.slug);
  if (!Array.isArray(p.services) || !p.services.length) {
    fail(`${at}: services[] is required — 1+ of ${Object.keys(SERVICES).join('|')}`);
  } else {
    for (const s of p.services) if (!(s in SERVICES)) fail(`${at}: unknown service "${s}" — must be one of ${Object.keys(SERVICES).join('|')}`);
    if (new Set(p.services).size !== p.services.length) fail(`${at}: duplicate entries in services[]`);
  }
  if (p.category != null && !(p.category in CATEGORIES)) fail(`${at}: category (legacy, optional) must be one of ${Object.keys(CATEGORIES).join('|')}`);
  for (const req of ['title', 'tag', 'city', 'description', 'hero', 'published']) {
    if (!p[req] || typeof p[req] !== 'string') fail(`${at}: missing required field "${req}"`);
  }
  if (p.consentOnFile !== true) fail(`${at}: consentOnFile must be literally true — no consent, no publish`);
  if (isNaN(new Date(p.published).getTime())) fail(`${at}: published is not a valid ISO date`);
  if (!Array.isArray(p.photos) || !p.photos.length) fail(`${at}: photos[] must have at least one entry`);

  const hasLow = p.priceLow != null, hasHigh = p.priceHigh != null;
  if (hasLow !== hasHigh) fail(`${at}: priceLow/priceHigh are both-or-neither`);
  if (hasLow) {
    if (!Number.isInteger(p.priceLow) || !Number.isInteger(p.priceHigh) || p.priceLow <= 0)
      fail(`${at}: prices must be positive whole retail dollars`);
    if (p.priceLow > p.priceHigh) fail(`${at}: priceLow > priceHigh`);
  }

  for (const img of [{ src: p.hero, alt: 'hero' }, ...p.photos]) {
    if (!IMG_RE.test(img.src || '')) fail(`${at}: image "${img.src}" must match ${IMG_RE} — repo-local re-encoded copies only, never CRM URLs`);
    else if (!existsSync(path.join(ROOT, 'docs', img.src))) fail(`${at}: image ${img.src} does not exist on disk`);
  }
  for (const ph of p.photos) {
    if (!ph.alt || !String(ph.alt).trim()) fail(`${at}: every photo needs real alt text`);
    if (ph.caption != null && (typeof ph.caption !== 'string' || !ph.caption.trim())) fail(`${at}: photo caption (optional) must be a non-empty string — omit it to fall back to the alt text`);
  }
  for (const [k] of NARRATIVE) {
    if (p[k] == null) continue;
    const v = p[k];
    const good = (typeof v === 'string' && v.trim())
      || (LIST_OK.has(k) && Array.isArray(v) && v.length && v.every((s) => typeof s === 'string' && s.trim()));
    if (!good) fail(`${at}: "${k}" (optional) must be a non-empty string${LIST_OK.has(k) ? ' or a list of non-empty strings' : ''} — omit it when there is nothing true to say`);
  }
  // Town-level location is what links a job to /areas/<town> and the
  // town-specific service pages, so the shape is enforced: "Town, ST".
  if (typeof p.city === 'string' && !/^[A-Za-z][A-Za-z .'-]*, [A-Z]{2}$/.test(p.city.trim())) {
    fail(`${at}: city must be "Town, ST" (e.g. "Mason, OH") — town level only`);
  }
  // Warn-only typo net: an unknown optional field silently no-ops otherwise.
  for (const k of Object.keys(p)) {
    if (!KNOWN_FIELDS.has(k)) console.warn(`WARN: ${at}: unknown field "${k}" is ignored by the renderer (typo?)`);
  }
}
// A live, priced job must say what year it was priced (2026-09-27). Without
// it the dated-price line cannot be honest, and before this gate an undated
// job silently inherited the legacy "Priced before 2025." label. The legacy
// allowlist and the rule live in project-price-context.mjs (unit-tested with
// injected data in tests/project-price-context.test.js).
{
  const validateToday = new Date(); validateToday.setHours(23, 59, 59, 999);
  for (const msg of yearRuleErrors(all, validateToday)) fail(msg);
}
if (process.exitCode) process.exit(1);

// ── Render ──────────────────────────────────────────────────────
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const today = new Date(); today.setHours(0, 0, 0, 0);
const live = all.filter((p) => {
  const d = new Date(p.published); d.setHours(0, 0, 0, 0);
  return d <= today;                       // future date = staged, blog model
});
// Newest first everywhere; Array.prototype.sort is stable, so same-date
// entries keep their curated manifest order. New entries are appended at the
// END of projects.json and still render first.
live.sort((a, b) => new Date(b.published) - new Date(a.published));

// ── Dated-price context (2026-09-27) ────────────────────────────
// Older job prices keep their year and get one honest line of context
// (scripts/project-price-context.mjs has the rule). The as-of date is
// injectable — --as-of=YYYY-MM-DD or NBD_PROJECTS_AS_OF — and otherwise is the
// newest published date, never the wall clock: every surface below is gated
// by --check, and a clock-based rule would redden it each New Year's Day.
const AS_OF_ARG = (process.argv.find((a) => a.startsWith('--as-of=')) || '').slice('--as-of='.length)
  || process.env.NBD_PROJECTS_AS_OF || '';
const AS_OF = AS_OF_ARG
  ? parseAsOf(AS_OF_ARG)
  : parseAsOf(String(live.map((p) => p.published).sort().at(-1) || '').slice(0, 10));
if (!AS_OF) { console.error(`FATAL: as-of date ${AS_OF_ARG ? `"${AS_OF_ARG}" ` : ''}is not YYYY-MM-DD`); process.exit(1); }
const dated = (p) => priceContext(p, AS_OF);

const money =(n) => '$' + n.toLocaleString('en-US');
const priceLine = (p) => (p.priceLow != null ? `${money(p.priceLow)}–${money(p.priceHigh)}` : null);

const webpFor = (src) => {
  const w = src.replace(/\.(jpg|jpeg|png)$/, '.webp');
  return w !== src && existsSync(path.join(ROOT, 'docs', w)) ? w : null;
};
// Same existence rule for AVIF (generated for photos over ~100 KB; roughly
// half the JPEG's bytes). A sibling that doesn't exist is simply not offered,
// and a WebP that came out LARGER than its JPEG was never committed.
const avifFor = (src) => {
  const a = src.replace(/\.(jpg|jpeg|png)$/, '.avif');
  return a !== src && existsSync(path.join(ROOT, 'docs', a)) ? a : null;
};
// <picture> with whichever modern siblings exist, AVIF first; the original
// stays the <img> fallback.
const pictureFor = (src, img) => {
  const sources = [[avifFor(src), 'image/avif'], [webpFor(src), 'image/webp']]
    .filter(([u]) => u).map(([u, t]) => `<source srcset="${esc(u)}" type="${t}">`).join('');
  return sources ? `<picture>${sources}${img}</picture>` : img;
};

const heroAlt = (p) => (p.photos.find((ph) => ph.src === p.hero) || p.photos[0]).alt;

// `lcp`: the case-study page's own hero is its largest paint, so it loads
// eagerly at high priority; every listing/strip card stays lazy.
const heroImg = (p, cls, lcp = false) => {
  const load = lcp ? 'fetchpriority="high"' : 'loading="lazy"';
  const img = `<img src="${esc(p.hero)}" alt="${esc(heroAlt(p))}" class="${cls}" ${load} decoding="async" width="800" height="600">`;
  return pictureFor(p.hero, img);
};

const PIN_SVG = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';

// ── Towns → /areas/<town> and /services/<service>-<town> ─────────
// A job's town is its city field ("Mason, OH"). The slug rule is the one the
// area pages were named by: lowercase, dots dropped, non-alphanumerics → "-",
// then the state. TOWN_ALIASES folds spelling variants onto the page's own
// spelling BEFORE slugging — add a row here rather than renaming a page. A
// town with no docs/areas/<slug>.html (out-of-area jobs: Evansville IN,
// Gatlinburg TN, West Liberty KY) simply gets no area link; nothing is guessed.
const TOWN_ALIASES = {
  'mount orab': 'mt orab',
  'mt. orab': 'mt orab',
  'anderson': 'anderson township',
  'sycamore twp': 'sycamore township',
};
const townOf = (p) => {
  const m = /^(.+?),\s*([A-Z]{2})$/.exec(String(p.city || '').trim());
  if (!m) return null;
  const lower = m[1].toLowerCase().trim();
  const canon = TOWN_ALIASES[lower] || lower;
  const slug = `${canon.replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${m[2].toLowerCase()}`;
  return { name: m[1].trim(), state: m[2], slug };
};
// areaServed as a typed place, the shape every other Service on the site uses
// (see site-src/partials/schema-entity.html). A city string that does not
// parse as "Town, ST" is passed through untouched rather than guessed at.
const STATE_NAMES = { OH: 'Ohio', KY: 'Kentucky', IN: 'Indiana', TN: 'Tennessee' };
const placeNode = (city) => {
  const t = townOf({ city });
  if (!t || !STATE_NAMES[t.state]) return city;
  return { '@type': 'City', name: t.name, containedInPlace: { '@type': 'State', name: STATE_NAMES[t.state] } };
};
const AREAS_DIR = path.join(ROOT, 'docs', 'areas');
const areaHref = (t) => (t && existsSync(path.join(AREAS_DIR, `${t.slug}.html`)) ? `/areas/${t.slug}` : null);

// Town-specific service pages are named <prefix>-<town-slug>.html; the hail
// family is fed by the storm-damage service, same as its hub strip.
const TOWN_PAGE_PREFIX = {
  'roof-replacement': 'roof-replacement', 'roof-repair': 'roof-repair',
  'roof-inspection': 'roof-inspection', 'storm-damage': 'storm-damage',
  'hail-damage': 'storm-damage', 'gutter-replacement': 'gutter-replacement',
  'siding-replacement': 'siding-replacement', 'siding-repair': 'siding-repair',
  'wood-siding-repair': 'wood-siding-repair',
};
// The page a case study links as "<service> in <Town>": the prefix that
// shares the service's own name (storm-damage-<town>, not hail-damage-<town>).
const townServiceHref = (service, t) => {
  if (!t || !(service in TOWN_PAGE_PREFIX)) return null;
  return existsSync(path.join(SERVICES_DIR, `${service}-${t.slug}.html`)) ? `/services/${service}-${t.slug}` : null;
};

// "Real <noun> Jobs" / "More <noun> Jobs" — SERVICES labels are filter-button
// text ("Gutters", "Inspection") and read wrong in a sentence.
const JOB_NOUN = {
  'roof-replacement': 'Roof Replacement', 'roof-repair': 'Roof Repair',
  'commercial-roofing': 'Commercial Roofing', 'siding-replacement': 'Siding Replacement',
  'siding-repair': 'Siding Repair', 'wood-siding-repair': 'Wood Siding Repair',
  'shed-roof-replacement': 'Shed & Outbuilding', 'gutter-replacement': 'Gutter',
  'gutter-cleaning': 'Gutter Cleaning', 'storm-damage': 'Storm Damage',
  'roof-inspection': 'Roof Inspection', 'interior-repair': 'Interior Repair',
};

// Card that links to the job's own case-study page (hub strips, area blocks,
// town-service strips). withDesc adds the write-up — used where the card is
// the page's local-proof content, not a teaser.
const caseCard = (p, { withDesc = false } = {}) => {
  const price = priceLine(p);
  // The whole card is a link, so its dated-price line is text only (a nested
  // <a> is invalid); the case page it opens carries the link.
  const ctx = dated(p);
  const meta = [`<span class="project-loc">${PIN_SVG} ${esc(p.city)}</span>`];
  if (p.year) meta.push(`<span>${esc(String(p.year))}</span>`);
  return `    <a class="project project-link" href="/our-work/${esc(p.slug)}">
      ${heroImg(p, 'project-img')}
      <div class="project-body">
        <span class="project-tag">${esc(p.tag)}</span>
        <h3>${esc(p.title)}</h3>${price ? `
        <div class="project-price">${esc(price)}</div>` : ''}${price && ctx ? `
        <p data-price-context="${ctx.year}">${esc(ctx.short)}</p>` : ''}${withDesc ? `
        <p>${esc(p.description)}</p>` : ''}
        <div class="project-meta">${meta.join(' <span class="project-dot">·</span> ')}</div>
      </div>
    </a>`;
};

// Compact crawlable list for the jobs past a card cap — every job still gets
// its link without a wall of images.
const moreList = (ps, heading) => (ps.length ? `
    <p class="nbd-recent-jobs-more-h">${heading}</p>
    <ul class="nbd-recent-jobs-more">
${ps.map((p) => `      <li><a href="/our-work/${esc(p.slug)}">${esc(p.title)}</a> <span>${esc(p.city)}${p.year ? ` · ${esc(String(p.year))}` : ''}</span></li>`).join('\n')}
    </ul>` : '');

// The dated-price line with its "what it runs today" link — gallery cards and
// case pages (both non-link containers). linkClass reuses an existing
// link style: .nbd-recent-jobs-all (project-cards.css) / .pd-links a.
const datedLine = (ctx, tag, cls, linkClass) => `<${tag}${cls ? ` class="${cls}"` : ''} data-price-context="${ctx.year}">${esc(ctx.lead)} <a${linkClass ? ` class="${linkClass}"` : ''} href="${esc(ctx.href)}">${esc(ctx.linkText)}</a></${tag}>`;

const card = (p) => {
  const price = priceLine(p);
  const ctx = dated(p);
  // Lightbox payload — display fields only, all re-escaped by esc() as one
  // JSON attribute. The client JSON.parses it; it renders via textContent.
  const payload = {
    title: p.title, tag: p.tag, city: p.city, price, year: p.year || null,
    description: p.description, photos: p.photos,
  };
  // Dated price: the lightbox's headline IS the price, so it carries the same
  // context line (our-work.js prepends it to the description).
  if (price && ctx) payload.priceNote = ctx.short;
  const meta = [
    `<span class="project-loc">${PIN_SVG} ${esc(p.city)}</span>`,
    p.year ? `<span>${esc(String(p.year))}</span>` : null,
    p.duration ? `<span>${esc(p.duration)}</span>` : null,
    `<span>${p.photos.length} photo${p.photos.length === 1 ? '' : 's'}</span>`,
  ].filter(Boolean).join(' <span class="project-dot">·</span> ');
  const pills = p.services.map((s) =>
    `<a href="/services/${s}">${esc(SERVICES[s])}</a>`).join('\n            ');
  return `      <div class="project" data-services="${esc(p.services.join(' '))}" data-slug="${esc(p.slug)}" data-project="${esc(JSON.stringify(payload))}">
        ${heroImg(p, 'project-img')}
        <div class="project-body">
          <span class="project-tag">${esc(p.tag)}</span>
          <h3>${esc(p.title)}</h3>${price ? `
          <div class="project-price">${esc(price)}</div>` : ''}${price && ctx ? `
          ${datedLine(ctx, 'p', '', 'nbd-recent-jobs-all')}` : ''}
          <p>${esc(p.description)}</p>
          <div class="project-meta">${meta}</div>
          <div class="project-services">
            ${pills}
          </div>
          <button type="button" class="project-view">View photos &rarr;</button>
          <a class="project-view" href="/our-work/${esc(p.slug)}" style="display:inline-block;text-decoration:none;margin-left:8px;">View full project &rarr;</a>
        </div>
      </div>`;
};

const activeServices = Object.keys(SERVICES).filter((s) => live.some((p) => p.services.includes(s)));
const filters = [
  `      <button class="filter-btn active" data-service="all">All Projects</button>`,
  // id="svc-…" makes /our-work#svc-<key> a REAL anchor (site-integrity checks
  // cross-page anchors), so hub strips deep-link straight to the filter bar.
  ...activeServices.map((s) => `      <button class="filter-btn" id="svc-${s}" data-service="${s}">${esc(SERVICES[s])}</button>`),
].join('\n');

// Newest published date, not today's date: the generated comment must be a
// pure function of projects.json, or the --check gate goes red at the next
// UTC midnight on untouched code (bit CI daily until 2026-08-07).
const newestPublished = live.map((p) => p.published).sort().at(-1);

const staticBlock = `<!-- OURWORK-STATIC-START -->
<!-- generated by build-projects.mjs from assets/data/projects.json — do not hand-edit; ${live.length} live projects, newest published ${newestPublished} -->
    <div class="filters">
${filters}
    </div>

    <div class="gallery" id="gallery">
${live.map(card).join('\n\n')}
    </div>
<!-- OURWORK-STATIC-END -->`;

// ── Schema ──────────────────────────────────────────────────────
const ORIGIN = 'https://nobigdealwithjoedeal.com';
// Service + AggregateOffer, deliberately NOT Product: Product rich-result
// markup on a portfolio page is a documented spammy-structured-markup risk,
// and no rich result exists for local-service portfolios either way.
// Service keeps the price range machine-readable and ties every item to the
// sitewide RoofingContractor node via provider @id. That node is NOT defined
// here: the business, Joe and the WebSite live once, in
// site-src/partials/schema-entity.html, which apply-partials.js stamps into
// our-work.html and every detail page. A copy here is a second business, and
// check-seo-surface.js fails the build on it (entity-business).
const schema = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'ImageGallery',
      '@id': `${ORIGIN}/our-work#gallery`,
      name: 'Our Work — No Big Deal Home Solutions',
      description: 'Real roof replacement, storm damage repair, siding, and gutter projects across Greater Cincinnati — with honest price ranges.',
      url: `${ORIGIN}/our-work`,
      about: { '@id': `${ORIGIN}/#org` },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${ORIGIN}/our-work#breadcrumbs`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Our Work', item: `${ORIGIN}/our-work` },
      ],
    },
    {
      '@type': 'ItemList',
      '@id': `${ORIGIN}/our-work#projects`,
      numberOfItems: live.length,
      itemListElement: live.map((p, i) => {
        const item = {
          '@type': 'Service',
          '@id': `${ORIGIN}/our-work#p-${p.slug}`,
          name: p.title,
          serviceType: SERVICES[p.services[0]],
          provider: { '@id': `${ORIGIN}/#org` },
          areaServed: placeNode(p.city),
          description: p.description,
          image: `${ORIGIN}${p.hero}`,
        };
        if (p.priceLow != null) {
          item.offers = {
            '@type': 'AggregateOffer',
            lowPrice: p.priceLow, highPrice: p.priceHigh, priceCurrency: 'USD',
          };
        }
        return { '@type': 'ListItem', position: i + 1, item };
      }),
    },
  ],
};

const schemaBlock = `<!-- OURWORK-HEAD-SCHEMA-START -->
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<!-- OURWORK-HEAD-SCHEMA-END -->`;

// ── Hub-page strips ─────────────────────────────────────────────
// Each /services/ hub page carries one OURWORK-STRIP marker pair whose
// service="…" attribute picks the projects (so e.g. the hail hub reuses
// service="storm-damage"). Markers are hand-placed ONCE, outside every
// nbd:partial region; this script owns everything between them.
const STRIP_MAX = 3;

// Cards link to each job's own /our-work/<slug> case study (2026-09-27) —
// they used to point at /our-work#svc-<service>, which left the 53 case pages
// with one inbound link each (the gallery). The filtered-gallery deep link
// survives as the strip's "See all" link. Jobs past STRIP_MAX are still
// linked, as a compact text list under the cards.
const stripBlock = (service) => {
  const label = SERVICES[service];
  // Count BEFORE the cap: the provenance comment is what a future session reads to
  // decide whether a strip is showing everything, so it has to name what was left out.
  const all = live.filter((p) => p.services.includes(service));
  const matches = all.slice(0, STRIP_MAX);
  const newest = matches.length ? matches.map((p) => p.published).sort().at(-1) : null;
  const capped = all.length > matches.length ? ` (${all.length} carry this service; ${all.length - matches.length} more listed as links, STRIP_MAX=${STRIP_MAX})` : '';
  const header = `<!-- generated by build-projects.mjs from assets/data/projects.json — do not hand-edit; ${matches.length} live ${service} project(s)${capped}${newest ? `, newest published ${newest}` : ''} -->`;
  if (!matches.length) {
    // No matching live jobs yet: CTA band only — never an empty grid.
    return `${header}
<section class="nbd-recent-jobs" id="recent-jobs">
  <div class="nbd-recent-jobs-inner">
    <div class="nbd-recent-jobs-cta">
      <p>Fresh ${esc(label.toLowerCase())} job photos are coming soon — see completed roofing, siding, and gutter projects with honest price ranges.</p>
      <a href="/our-work">See Our Work &rarr;</a>
    </div>
  </div>
</section>`;
  }
  return `${header}
<section class="nbd-recent-jobs" id="recent-jobs" aria-labelledby="recent-jobs-h">
  <div class="nbd-recent-jobs-inner">
    <div class="nbd-recent-jobs-head">
      <h2 id="recent-jobs-h">Recent <span>${esc(label)}</span> Jobs</h2>
      <a class="nbd-recent-jobs-all" href="/our-work#svc-${service}">See all our work &rarr;</a>
    </div>
    <div class="gallery">
${matches.map((p) => caseCard(p)).join('\n\n')}
    </div>${moreList(all.slice(STRIP_MAX), `More ${esc(JOB_NOUN[service])} jobs`)}
  </div>
</section>`;
};

// ── Generated regions that the generator places itself ──────────
// OURWORK-AREA (on /areas/<town>) and OURWORK-LOCAL (on the town-specific
// /services/<service>-<town> pages) exist only where there is at least one
// matching live job: the generator INSERTS the region before a fixed anchor
// the first time a town gets a job, restamps it after, and REMOVES it
// (markers included) if the last job goes — never an empty block. --check
// treats a missing-but-owed or present-but-unowed region as drift.
const syncRegion = (src, eol, start, end, block, anchor) => {
  const q = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${q(start)}[\\s\\S]*?${q(end)}\\r?\\n(?:\\r?\\n)?`);
  const has = re.test(src);
  if (!block) return has ? src.replace(re, '') : src;
  const full = toEol(`${start}\n${block}\n${end}\n\n`, eol);
  if (has) return src.replace(re, () => full);
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  return src.slice(0, at) + full + src.slice(at);
};

const byTown = new Map();                    // area slug → live jobs, newest first
for (const p of live) {
  const t = townOf(p);
  if (!t) continue;
  if (!byTown.has(t.slug)) byTown.set(t.slug, []);
  byTown.get(t.slug).push(p);
}

// Reuses project-cards.css; area and town-service pages don't load it in
// <head>, so the region carries its own <link> (body-ok per the HTML spec,
// and it arrives and leaves with the region).
const CARDS_CSS = '<link rel="stylesheet" href="/assets/css/project-cards.css?v=1">';
const AREA_CARDS = 6;
const LOCAL_CARDS = 3;

const areaBlock = (t, jobs) => {
  const town = t.name;
  const priced = jobs.some((p) => p.priceLow != null);
  return `<!-- generated by build-projects.mjs from assets/data/projects.json — do not hand-edit; ${jobs.length} live job(s) in ${esc(town)}, ${t.state}, newest published ${jobs.map((p) => p.published).sort().at(-1)} -->
${CARDS_CSS}
<section class="nbd-recent-jobs nbd-local-jobs" id="local-jobs" aria-labelledby="local-jobs-h">
  <div class="nbd-recent-jobs-inner">
    <div class="nbd-recent-jobs-head">
      <h2 id="local-jobs-h">Jobs We've Done in <span>${esc(town)}</span></h2>
      <a class="nbd-recent-jobs-all" href="/our-work">See all our work &rarr;</a>
    </div>
    <p class="nbd-recent-jobs-lede">${jobs.length === 1 ? 'A finished job' : `${jobs.length} finished jobs`} in ${esc(town)}, ${t.state} — photos and the write-up for ${jobs.length === 1 ? 'it' : 'each one'}${priced ? ', with the price range where we publish one' : ''}.</p>
    <div class="gallery">
${jobs.slice(0, AREA_CARDS).map((p) => caseCard(p, { withDesc: true })).join('\n\n')}
    </div>${moreList(jobs.slice(AREA_CARDS), `More ${esc(town)} jobs`)}
  </div>
</section>`;
};

const localBlock = (service, t, jobs) => {
  const noun = JOB_NOUN[service];
  const area = areaHref(t);
  return `<!-- generated by build-projects.mjs from assets/data/projects.json — do not hand-edit; ${jobs.length} live ${service} job(s) in ${esc(t.name)}, ${t.state}, newest published ${jobs.map((p) => p.published).sort().at(-1)} -->
${CARDS_CSS}
<section class="nbd-recent-jobs nbd-local-jobs" id="local-jobs" aria-labelledby="local-jobs-h">
  <div class="nbd-recent-jobs-inner">
    <div class="nbd-recent-jobs-head">
      <h2 id="local-jobs-h">Real ${esc(noun)} Jobs in <span>${esc(t.name)}</span></h2>
      ${area ? `<a class="nbd-recent-jobs-all" href="${area}">Everything we've done in ${esc(t.name)} &rarr;</a>` : `<a class="nbd-recent-jobs-all" href="/our-work#svc-${service}">See all our work &rarr;</a>`}
    </div>
    <div class="gallery">
${jobs.slice(0, LOCAL_CARDS).map((p) => caseCard(p, { withDesc: true })).join('\n\n')}
    </div>${moreList(jobs.slice(LOCAL_CARDS), `More ${esc(noun.toLowerCase())} jobs in ${esc(t.name)}`)}
  </div>
</section>`;
};

// ── Homepage strip (docs/index.html, OURWORK-HOME) ──────────────
// Four curated jobs right under the home hero, swipeable on a phone, plus the
// "See all N jobs" door whose N is the live count — never a typed number
// (the old "See all 7 free tools" idiom drifted). Picks are slugs, not a rule:
// "newest priced roof" would currently surface the $73k commercial rebuild.
// Each pick must be live, priced and a real repo photo, or the build fails
// naming the slug — the homepage never shows a stale or unpriced card.
const HOME_PICKS = [
  'milford-oh-full-tearoff-replacement-2026',
  'norwood-oh-victorian-three-system-2026',
  'newtown-oh-steep-pitch-replacement-2026',
  'cincinnati-oh-full-tearoff-reroof-2026',
];
const homePicks = HOME_PICKS.map((slug) => {
  const p = live.find((x) => x.slug === slug);
  if (!p) { console.error(`FATAL: HOME_PICKS: "${slug}" is not a live project in projects.json`); process.exit(1); }
  if (p.priceLow == null) { console.error(`FATAL: HOME_PICKS: "${slug}" has no published price range — the home strip shows real prices only`); process.exit(1); }
  return p;
});
const homeCard = (p) => {
  const ctx = dated(p);
  const meta = [esc(p.city), p.year ? esc(String(p.year)) : null].filter(Boolean).join(' · ');
  return `      <a class="hj-card" href="/our-work/${esc(p.slug)}">
        ${heroImg(p, 'hj-img')}
        <span class="hj-body"><b>${esc(p.title)}</b><span class="hj-meta">${meta}</span><span class="hj-price">${esc(priceLine(p))}</span>${ctx ? `<span class="hj-note" data-price-context="${ctx.year}">${esc(ctx.short)}</span>` : ''}</span>
      </a>`;
};
const homeBlock = () => `<!-- generated by build-projects.mjs from assets/data/projects.json — do not hand-edit; HOME_PICKS (${homePicks.length}) of ${live.length} live project(s) -->
<section class="home-jobs" id="recent-jobs" aria-labelledby="home-jobs-h">
  <div class="hx-wrap">
    <p class="eyebrow">Recent roofs · real prices</p>
    <h2 class="sec-title" id="home-jobs-h">Jobs near you, <span>with the real price.</span></h2>
    <div class="hj-strip" role="region" aria-label="Recent jobs, swipe for more" tabindex="0">
${homePicks.map(homeCard).join('\n')}
    </div>
    <a class="hj-more" href="/our-work">See all ${live.length} jobs &rarr;</a>
  </div>
</section>`;

const STRIP_RE = /<!-- OURWORK-STRIP-START service="([a-z-]+)" -->[\s\S]*?<!-- OURWORK-STRIP-END -->/g;

// ── Per-project detail pages (docs/our-work/<slug>.html) ────────
// Fully generated from the same projects.json entry as the listing card —
// deliberately not hand-authored, so there is one editing surface and no
// new drift class. Reuses project-cards.css (already shared by the
// listing gallery + hub strips) for the photo grid instead of inventing a
// second page-specific stylesheet, given how much duplicated inline CSS
// this site already carries (see documentation/projects/WEEKLY_CADENCE.md
// backlog item 10).
const detailPhotoCard = (ph) => {
  const img = `<img src="${esc(ph.src)}" alt="${esc(ph.alt)}" loading="lazy" decoding="async" width="400" height="300" style="width:100%;height:200px;object-fit:cover;border-radius:10px;display:block;">`;
  return `      <figure style="margin:0;">
        ${pictureFor(ph.src, img)}
        <figcaption style="font-size:.75rem;color:var(--gray,#5d6673);margin-top:6px;">${esc(ph.caption || ph.alt)}</figcaption>
      </figure>`;
};

// ── Case-study body: narrative sections + links back out ─────────
// Only fields the manifest actually carries are rendered. Nothing here writes
// a sentence about a job that projects.json does not state.
const narrativeHtml = (p) => NARRATIVE.filter(([k]) => p[k] != null).map(([k, h2]) => {
  const v = p[k];
  const body = Array.isArray(v)
    ? `<ul class="pd-list">\n${v.map((s) => `      <li>${esc(s)}</li>`).join('\n')}\n    </ul>`
    : `<p class="pd-text">${esc(v)}</p>`;
  return `    <h2 class="pd-h2">${h2}</h2>
    ${body}`;
}).join('\n');

// Deterministic "next K in the ring" pick: each job links the jobs AFTER it in
// the newest-first list, wrapping. Spreads inbound links evenly across the set
// instead of every page pointing at the same three newest jobs.
const ringPick = (list, p, k, skip) => {
  const i = list.indexOf(p);
  const out = [];
  for (let j = 1; j < list.length && out.length < k; j++) {
    const q = list[(i + j) % list.length];
    if (q !== p && !skip.has(q.slug)) { out.push(q); skip.add(q.slug); }
  }
  return out;
};
const RELATED_BY_SERVICE = 4;
const RELATED_BY_TOWN = 6;

const relatedList = (ps) => `<ul class="pd-related">
${ps.map((q) => `      <li><a href="/our-work/${esc(q.slug)}">${esc(q.title)}</a> <span>${esc(q.city)}${q.year ? ` · ${esc(String(q.year))}` : ''}</span></li>`).join('\n')}
    </ul>`;

const linksOutHtml = (p) => {
  const t = townOf(p);
  const area = areaHref(t);
  const primary = p.services[0];
  const noun = JOB_NOUN[primary];
  const skip = new Set([p.slug]);
  const svcPeers = ringPick(live.filter((q) => q.services.includes(primary)), p, RELATED_BY_SERVICE, skip);
  const townPeers = t ? ringPick(byTown.get(t.slug) || [], p, RELATED_BY_TOWN, skip) : [];
  const svcLinks = [`<a href="/services/${primary}">${esc(SERVICES[primary])} — how we do it</a>`];
  const local = townServiceHref(primary, t);
  if (local) svcLinks.push(`<a href="${local}">${esc(noun)} in ${esc(t.name)}</a>`);
  const out = [`    <h2 class="pd-h2">More ${esc(noun)} Work</h2>
    <p class="pd-links">${svcLinks.join(' <span class="project-dot">·</span> ')}</p>${svcPeers.length ? `
    ${relatedList(svcPeers)}` : ''}`];
  if (t && (area || townPeers.length)) {
    out.push(`    <h2 class="pd-h2">Other Jobs in ${esc(t.name)}</h2>${area ? `
    <p class="pd-links"><a href="${area}">Roofing and exterior work in ${esc(t.name)}, ${t.state}</a></p>` : ''}${townPeers.length ? `
    ${relatedList(townPeers)}` : ''}`);
  }
  return out.join('\n');
};

const factsHtml = (p) => {
  const t = townOf(p);
  const area = areaHref(t);
  const rows = [
    ['Location', area ? `<a href="${area}">${esc(p.city)}</a>` : esc(p.city)],
    ['Services', p.services.map((s) => `<a href="/services/${s}">${esc(SERVICES[s])}</a>`).join(', ')],
  ];
  if (p.year) rows.push(['Year', esc(String(p.year))]);
  if (p.duration) rows.push(['Duration', esc(p.duration)]);
  const price = priceLine(p);
  const ctx = dated(p);
  if (price) rows.push(['Price range', `${esc(price)} (retail${ctx ? `, priced ${esc(ctx.when)}` : ''})`]);
  rows.push(['Photos', String(p.photos.length)]);
  return `    <h2 class="pd-h2">Project Details</h2>
    <dl class="pd-facts">
${rows.map(([k, v]) => `      <div><dt>${k}</dt><dd>${v}</dd></div>`).join('\n')}
    </dl>`;
};

const DETAIL_ORIGIN = 'https://nobigdealwithjoedeal.com';

const detailSchema = (p) => {
  const graph = [
    {
      '@type': 'BreadcrumbList',
      '@id': `${DETAIL_ORIGIN}/our-work/${p.slug}#breadcrumbs`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${DETAIL_ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Our Work', item: `${DETAIL_ORIGIN}/our-work` },
        { '@type': 'ListItem', position: 3, name: p.title, item: `${DETAIL_ORIGIN}/our-work/${p.slug}` },
      ],
    },
    {
      '@type': 'Service',
      '@id': `${DETAIL_ORIGIN}/our-work/${p.slug}#service`,
      name: p.title,
      serviceType: SERVICES[p.services[0]],
      provider: { '@id': `${DETAIL_ORIGIN}/#org` },
      areaServed: placeNode(p.city),
      description: p.description,
      image: `${DETAIL_ORIGIN}${p.hero}`,
    },
  ];
  if (p.priceLow != null) {
    graph[1].offers = { '@type': 'AggregateOffer', lowPrice: p.priceLow, highPrice: p.priceHigh, priceCurrency: 'USD' };
  }
  return { '@context': 'https://schema.org', '@graph': graph };
};

// <title> for a case page (2026-10-03, SEO quick wins): leads with the
// SERVICE + TOWN a homeowner searches for, then the job's own phrase —
// "Roof Replacement in Milford, OH — Forty-Five Squares, Two Days | NBD".
// Until then it led with the job phrase alone ("Forty-Five Squares, Two Days
// — Milford, OH | NBD"), which says nothing a search matches on.
//
// The service is DERIVED, never typed per job: a tag that names the work
// more exactly than the hub does wins (TITLE_TAG_SERVICE — "Gutter Repair"
// beats the gutter-replacement hub's name for a downspout fix), otherwise
// the job's first service in TITLE_SERVICE. storm-damage is skipped when
// the job has another service, because storm is the cause and the other
// service is the work done ("Wind-Lifted Shingles, Reset by Hand" is a roof
// repair). Inner " — " in the job phrase becomes ", " so a title never
// carries two dashes.
//
// Aimed at 65 characters (check-seo-surface.js warns above that), with a
// little slack for a whole phrase over a chopped one — see titleCandidates().
// Service + town always lead and the job's words are never reworded.
// og:title / twitter:title carry the same lead with the untrimmed phrase;
// the H1 keeps the job title as written. Titles must be unique across case
// pages (PAGE_TITLES below; a job left with no unique form is refused).
const TITLE_MAX = 65;
const TITLE_MIN_PHRASE = 8;
const TITLE_SERVICE = {
  'roof-replacement': 'Roof Replacement',
  'roof-repair': 'Roof Repair',
  'commercial-roofing': 'Commercial Roofing',
  'siding-replacement': 'Siding Replacement',
  'siding-repair': 'Siding Repair',
  'wood-siding-repair': 'Wood Siding Repair',
  'shed-roof-replacement': 'Shed Re-Roof',
  'gutter-replacement': 'Gutter Replacement',
  'gutter-cleaning': 'Gutter Cleaning',
  'storm-damage': 'Storm Damage Repair',
  'roof-inspection': 'Roof Inspection',
  'interior-repair': 'Interior Repair',
};
const TITLE_TAG_SERVICE = {
  'Gutter Screens': 'Gutter Screens',
  'Gutter Repair': 'Gutter Repair',
  'Gutter & Shingle Repair': 'Gutter Repair',
  'Soffit Repair': 'Soffit Repair',
  'Metal Roof': 'Metal Roofing',
  'Drywall Crack Repair': 'Drywall Repair',
};
for (const k of Object.keys(SERVICES)) if (!TITLE_SERVICE[k]) fail(`TITLE_SERVICE has no title wording for service "${k}"`);
const titleService = (p) => {
  if (TITLE_TAG_SERVICE[p.tag]) return TITLE_TAG_SERVICE[p.tag];
  const work = p.services.find((s) => s !== 'storm-damage') || p.services[0];
  return TITLE_SERVICE[work];
};
const titleLead = (p) => `${titleService(p)} in ${p.city}`;
const titlePhrase = (p) => p.title.replace(/ — /g, ', ');
const shareTitle = (p) => `${titleLead(p)} — ${titlePhrase(p)}`;
const trimTail = (s) => s.replace(/[\s—–\-,:;+&→]+$/u, '').replace(/\s+(a|an|the|of|to|and|for|near|by|with)$/i, '');
// Every candidate <title> for a job, best first. A cut mid-phrase reads as
// nonsense ("— Charcoal Over | NBD"), so whole phrases and whole leading
// clauses come first and are allowed a little past TITLE_MAX (to
// TITLE_HARD_MAX) before any word-boundary cut is considered:
//   1. the whole phrase, then whole leading clauses (split at ", ", ": ",
//      " + ", " → "; >= TITLE_MIN_PHRASE chars), within TITLE_MAX
//   2. the same, within TITLE_HARD_MAX
//   3. a single later clause on its own, within TITLE_MAX (only reached
//      when two jobs share a leading clause — "Three Layers Off")
//   4. the phrase cut at a word boundary, within TITLE_MAX
//   5. service + town alone
const TITLE_HARD_MAX = 75;
const titleCandidates = (p) => {
  const head = `${titleLead(p)} — `;
  const tail = ' | NBD';
  const phrase = titlePhrase(p);
  // Not " & " — it joins two nouns ("Gutter Section & Shingle Repair"), and
  // cutting there leaves half a phrase.
  const clauses = phrase.split(/(?=, |: | \+ | → )/);
  const whole = [phrase];
  for (let n = clauses.length - 1; n >= 1; n--) {
    const cut = trimTail(clauses.slice(0, n).join(''));
    if (cut.length >= TITLE_MIN_PHRASE) whole.push(cut);
  }
  const wrap = (s) => head + s + tail;
  const later = clauses.slice(1).map((c) => trimTail(c.replace(/^(, |: | \+ | → )/, '')))
    .filter((c) => c.length >= TITLE_MIN_PHRASE);
  const out = [
    ...whole.map(wrap).filter((t) => t.length <= TITLE_MAX),
    ...whole.map(wrap).filter((t) => t.length <= TITLE_HARD_MAX),
    ...later.map(wrap).filter((t) => t.length <= TITLE_MAX),
  ];
  const budget = TITLE_MAX - head.length - tail.length;
  const cut = phrase.slice(0, budget + 1);
  const word = trimTail(cut.slice(0, cut.lastIndexOf(' ')));
  if (word) out.push(wrap(word));
  out.push(`${titleLead(p)}${tail}`);
  return [...new Set(out)];
};
// Assign unique titles: jobs with the fewest fitting candidates choose first
// (stable on manifest order), each taking its best candidate not already
// taken — so a one-clause job keeps its only short form and a many-clause
// job moves to its next one. A job left with nothing unique is refused.
const PAGE_TITLES = new Map();
{
  const taken = new Map();
  const order = live.map((p, i) => ({ p, i, c: titleCandidates(p) }))
    .sort((a, b) => a.c.length - b.c.length || a.i - b.i);
  for (const { p, c } of order) {
    const t = c.find((x) => !taken.has(x));
    if (!t) { fail(`project "${p.slug}" has no unique <title> — every short form ("${c[0]}") is taken by "${taken.get(c[0])}"; shorten or reword one job title`); continue; }
    taken.set(t, p.slug);
    PAGE_TITLES.set(p.slug, t);
  }
  if (process.exitCode) process.exit(1);
}
const pageTitle = (p) => PAGE_TITLES.get(p.slug);

// The site-wide sticky Call/Text bar (conversion audit 2026-07-03), the same
// markup ~240 hand-authored pages carry before </body>, styled by
// /assets/css/mobile-cta.css (mobile only, <=768px; nbd-nav.css hides it
// while the drawer is open). Case pages were the one big template without
// it until 2026-10-03. Kept byte-identical to the other pages' block.
const MOBILE_CTA_STRIP = `<!-- STICKY MOBILE CTA STRIP (site-wide, conversion audit 2026-07-03) -->
<div class="mobile-cta-strip" aria-label="Quick contact options">
  <a href="tel:+18594207382" class="mobile-cta-call"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>Call Joe</a>
  <a href="sms:+18594207382" class="mobile-cta-text"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>Text Joe</a>
</div>`;

const detailPage = (p) => {
  const price = priceLine(p);
  const metaBits = [esc(p.city)];
  if (p.year) metaBits.push(esc(String(p.year)));
  if (p.duration) metaBits.push(esc(p.duration));
  // Footer crumb names the job's own town when it has an area page (it read
  // "Cincinnati, OH" on every case page until 2026-09-27); out-of-area jobs
  // keep the metro default.
  const crumbArea = areaHref(townOf(p)) || '/areas/cincinnati-oh';
  const crumbCity = crumbArea === '/areas/cincinnati-oh' ? 'Cincinnati, OH' : esc(p.city);
  const descMeta = String(p.description).slice(0, 155);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(pageTitle(p))}</title>
<meta name="description" content="${esc(descMeta)}">
<link rel="canonical" href="${DETAIL_ORIGIN}/our-work/${esc(p.slug)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(shareTitle(p))}">
<meta property="og:description" content="${esc(descMeta)}">
<meta property="og:url" content="${DETAIL_ORIGIN}/our-work/${esc(p.slug)}">
<meta property="og:image" content="${DETAIL_ORIGIN}${esc(p.hero)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(shareTitle(p))}">
<meta name="twitter:description" content="${esc(descMeta)}">
<meta name="twitter:image" content="${DETAIL_ORIGIN}${esc(p.hero)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/images/apple-touch-icon.png" sizes="180x180">
<link rel="icon" type="image/png" sizes="192x192" href="/assets/images/home-icon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/assets/images/home-icon-512.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="No Big Deal">
<link rel="stylesheet" href="/assets/css/nbd-fonts.css">
<link rel="stylesheet" href="/assets/css/project-cards.css?v=1">
<link rel="stylesheet" href="/assets/css/nbd-icons.css">
<link rel="stylesheet" href="/assets/css/mobile-cta.css">
<script type="application/ld+json">${JSON.stringify(detailSchema(p))}</script>
<style>
:root{--navy-dark:#12223d;--orange:#bd5728;--gray:#5d6673;--light-gray:#e8e5e0;--off-white:#f5f3ef}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Montserrat',sans-serif;color:#1a1a1a;background:#fff}
a{color:inherit}
.nbd-skip{position:absolute;left:-9999px;top:0;z-index:100000;background:#BD5728;color:#fff;padding:10px 16px;font-weight:700;text-decoration:none;border-radius:0 0 6px 0}
.nbd-skip:focus{left:0}
nav.nav{background:var(--navy-dark);padding:0 40px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:1000;height:70px;box-shadow:0 2px 20px rgba(0,0,0,.4);border-bottom:3px solid var(--orange)}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none}.nav-logo img{height:42px;border-radius:6px}
.nav-links{display:flex;list-style:none;gap:24px;align-items:center}.nav-links > li > a,.nav-links a{color:rgba(255,255,255,.85);text-decoration:none;font-size:.76rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.nav-cta{background:#BD5728;color:white!important;padding:8px 20px;border-radius:6px;font-weight:700!important}
footer{background:var(--navy-dark);border-top:3px solid var(--orange);padding:40px;text-align:center}
footer p{color:rgba(255,255,255,.7);font-size:.75rem;line-height:1.7}footer a{color:var(--orange-light,#dd875f);text-decoration:none}
.nbd-social{display:inline-flex;gap:10px;align-items:center;margin-left:14px;vertical-align:middle}
.nbd-social a{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);text-decoration:none!important;transition:transform .2s,background .2s,color .2s}
.nbd-social a:hover{transform:translateY(-2px);color:#fff}
.nbd-social a.s-fb:hover{background:#1877f2}
.nbd-social a.s-ig:hover{background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)}
.nbd-social a.s-gg:hover{background:#4285f4}
.nbd-social a.s-yelp:hover{background:#d32323}
.nbd-social svg{width:15px;height:15px;display:block}
@media(max-width:640px){.nbd-social{margin-left:0;margin-top:8px;display:flex;gap:8px}}
.pd-wrap{max-width:1000px;margin:0 auto;padding:32px 5% 64px;}
.pd-crumb{font-size:.78rem;margin-bottom:18px;}
.pd-crumb a{color:var(--orange);text-decoration:none;font-weight:700;}
.pd-hero{width:100%;max-height:480px;object-fit:cover;border-radius:14px;display:block;margin-bottom:24px;}
.pd-title{font-family:'Bebas Neue',sans-serif;font-size:2.4rem;color:var(--navy-dark);letter-spacing:.5px;margin-bottom:8px;}
.pd-price{font-family:'Bebas Neue',sans-serif;font-size:1.6rem;color:#A14A22;margin-bottom:14px;}
.pd-meta{font-size:.85rem;color:var(--gray);margin-bottom:20px;}
.pd-desc{font-size:1rem;line-height:1.7;color:#333;margin-bottom:32px;max-width:720px;}
.pd-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-bottom:32px;}
.pd-back{display:inline-block;margin-top:8px;font-weight:700;color:#A14A22;text-decoration:none;}
.pd-h2{font-family:'Bebas Neue',sans-serif;font-size:1.7rem;color:var(--navy-dark);letter-spacing:.5px;margin:8px 0 12px;}
.pd-text{font-size:1rem;line-height:1.7;color:#333;margin-bottom:28px;max-width:720px;}
.pd-list{margin:0 0 28px 1.2em;max-width:720px;line-height:1.7;color:#333;}
.pd-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 24px;margin-bottom:32px;max-width:720px;}
.pd-facts dt{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gray);}
.pd-facts dd{font-size:.95rem;color:#1a1a1a;margin-top:2px;}
.pd-facts a,.pd-links a,.pd-related a{color:#A14A22;font-weight:700;text-decoration:none;}
.pd-facts a:hover,.pd-links a:hover,.pd-related a:hover{text-decoration:underline;}
.pd-links{font-size:.92rem;margin-bottom:12px;line-height:1.8;}
.pd-related{list-style:none;margin:0 0 32px;display:grid;gap:8px;}
.pd-related li{font-size:.92rem;line-height:1.5;}
.pd-related span{color:var(--gray);font-size:.8rem;margin-left:4px;}
@media(max-width:768px){.pd-title{font-size:1.9rem}}
</style>
<link rel="stylesheet" href="/assets/css/nbd-nav-base.css">
<!-- nbd:partial schema-entity -->
<!-- /nbd:partial schema-entity -->
<link rel="stylesheet" href="/assets/css/nbd-nav.css">
</head>
<body><a class="nbd-skip" href="#main">Skip to content</a>
<!-- nbd:partial nav-standard cta_href="/#contact" -->
<!-- /nbd:partial nav-standard -->
<!-- nbd:partial mobile-nav-standard cta_href="/#contact" -->
<!-- /nbd:partial mobile-nav-standard -->
<main id="main">
  <div class="pd-wrap">
    <nav class="pd-crumb" aria-label="Breadcrumb"><a href="/our-work">&larr; Back to Our Work</a></nav>
    ${heroImg(p, 'pd-hero', true)}
    <span class="project-tag">${esc(p.tag)}</span>
    <h1 class="pd-title">${esc(p.title)}</h1>${price ? `
    <div class="pd-price">${esc(price)}</div>` : ''}${price && dated(p) ? `
    ${datedLine(dated(p), 'p', 'pd-links', '')}` : ''}
    <div class="pd-meta">${PIN_SVG} ${metaBits.join(' · ')}</div>
    <p class="pd-desc">${esc(p.description)}</p>
${narrativeHtml(p) ? `${narrativeHtml(p)}\n` : ''}${factsHtml(p)}
    <h2 class="pd-h2">Photos</h2>
    <div class="pd-photos">
${p.photos.map(detailPhotoCard).join('\n')}
    </div>
${linksOutHtml(p)}
    <a class="pd-back" href="/our-work">&larr; See more of our work</a>
  </div>
</main>
<!-- nbd:partial footer-standard crumb_service_href="/our-work" crumb_service_name="Our Work" crumb_city_href="${crumbArea}" crumb_city_name="${crumbCity}" -->
<!-- /nbd:partial footer-standard -->
${MOBILE_CTA_STRIP}
</body>
</html>
`;
};

// ── Homeowner-wall manifest (derived, drift-proof) ──────────────
// Same live projects feed the homepage "Real Roofs. Real Neighbors." wall
// (docs/assets/js/homeowner-wall.js: entries need image+alt, name optional,
// wall reveals at >=3 and caps at 12).
//
// slug/tag added 2026-09-20. Until then this map kept only image+city+alt, so
// all twelve cards were dead thumbnails — while .hw-card:hover already lifted
// them and deepened their shadow, i.e. the wall advertised a click it could not
// deliver, on top of 45 fully written, individually-URL'd project pages. The
// slug is what lets homeowner-wall.js link each photo to its write-up; the tag
// is what makes the caption worth reading ("Cincinnati, OH · Full Tear-Off")
// rather than a bare town name.
//
// DELIBERATELY NO PRICE (Jo's call, same day). The first cut emitted the
// formatted range and the caption showed it. The live twelve span $100–$200 to
// $73,000–$74,000, and a homepage tile reading $73,000 sets a very different
// expectation from the one a homeowner pricing a re-roof should leave with.
// Prices stay on every /our-work detail page and in their AggregateOffer
// schema. Not emitted at all rather than emitted-and-ignored: a public manifest
// carrying a field nothing renders is how it gets picked up again by accident.
// Restoring it is this one line plus the caption array in homeowner-wall.js.
const wallJson = JSON.stringify(
  live.slice(0, 12).map((p) => ({
    image: p.hero,
    city: p.city,
    alt: heroAlt(p),
    slug: p.slug,
    tag: p.tag || null,
  })),
  null, 2,
) + '\n';

// ── Stamp all targets ───────────────────────────────────────────
const stale = [];

// EOL DISCIPLINE — the stamped pages are CRLF in a Windows worktree (autocrlf)
// and LF on CI, while every block rendered above is LF. Stamping LF into a CRLF
// page makes `out === src` false forever: --check exited 1 on every clean
// Windows checkout for line endings alone (an always-red gate everyone learns
// to ignore), and --write rewrote 10 files as pure ending churn. Render in LF,
// then emit with the destination's own ending — scripts/apply-partials.js:201
// is the same three steps, and is why that generator alone passes here.
const toEol = (s, eol) => (eol === '\n' ? s : s.replace(/\n/g, eol));

const stampFile = (file, transform, required) => {
  const rel = path.relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const out = transform(src, eol);
  if (out === null) {
    if (required) { console.error(`FATAL: expected markers not found in ${rel}`); process.exit(1); }
    return 0;
  }
  if (out === src) return 0;
  if (CHECK) { stale.push(rel); return 0; }
  writeFileSync(file, out);
  return 1;
};

// 1b. Per-project detail pages (docs/our-work/<slug>.html) — new files, so
// there's no marker region to diff against; compare rendered output to
// whatever (if anything) is on disk today.
//
// detailPage() always emits EMPTY nbd:partial regions (nav-standard,
// mobile-nav-standard, footer-standard) — this generator doesn't own that
// content, apply-partials.js does. Carrying over whatever's already filled
// in there (if anything) before diffing/writing keeps the two generators
// from fighting: without this, every run here would revert the nav/footer
// to empty and every run of apply-partials.js would refill it, forever.
// schema-entity is the one definition of the business/Joe the page's JSON-LD
// references by @id; like the chrome, apply-partials.js owns its content.
const PARTIAL_NAMES = ['nav-standard', 'mobile-nav-standard', 'footer-standard', 'schema-entity'];
function carryOverPartials(freshHtml, existingHtml) {
  if (!existingHtml) return freshHtml;
  let out = freshHtml;
  for (const name of PARTIAL_NAMES) {
    const re = new RegExp(`(<!--\\s*nbd:partial\\s+${name}[^>]*-->\\r?\\n)([\\s\\S]*?)(<!--\\s*/nbd:partial\\s+${name}\\s*-->)`);
    const existingMatch = existingHtml.match(re);
    if (!existingMatch) continue; // never applied yet — leave the fresh (empty) region as-is
    // Normalize to LF before splicing into freshHtml (also LF) — toEol()
    // does one \n -> destination-EOL pass over the whole file afterward;
    // splicing in content that might already be CRLF would double-convert
    // it into the lone-CR corruption CLAUDE.md warns about.
    const carried = existingMatch[2].replace(/\r\n/g, '\n');
    out = out.replace(re, (_m, open, _emptyBody, close) => `${open}${carried}${close}`);
  }
  return out;
}

let detailWritten = 0, detailDeleted = 0;
{
  const liveSlugsSet = new Set(live.map((p) => p.slug));
  const existingFiles = existsSync(DETAIL_DIR)
    ? readdirSync(DETAIL_DIR).filter((f) => f.endsWith('.html'))
    : [];

  for (const p of live) {
    const file = path.join(DETAIL_DIR, `${p.slug}.html`);
    const rel = path.relative(ROOT, file);
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const eol = cur && cur.includes('\r\n') ? '\r\n' : '\n';
    const out = carryOverPartials(detailPage(p), cur);
    const wanted = toEol(out, eol);
    if (cur === wanted) continue;
    if (CHECK) { stale.push(rel); continue; }
    if (!existsSync(DETAIL_DIR)) mkdirSync(DETAIL_DIR, { recursive: true });
    writeFileSync(file, wanted);
    detailWritten++;
  }

  // Stale-file cleanup: a removed or re-slugged project must not leave a
  // dead, unlinked, still-200 page behind.
  for (const f of existingFiles) {
    const slug = f.replace(/\.html$/, '');
    if (liveSlugsSet.has(slug)) continue;
    const rel = path.relative(ROOT, path.join(DETAIL_DIR, f));
    if (CHECK) { stale.push(`${rel} (orphaned — no longer a live project slug)`); continue; }
    unlinkSync(path.join(DETAIL_DIR, f));
    detailDeleted++;
  }
}

// 1. our-work.html (both regions; missing markers are fatal — page contract)
stampFile(HTML, (src, eol) => {
  const reStatic = /<!-- OURWORK-STATIC-START -->[\s\S]*?<!-- OURWORK-STATIC-END -->/;
  const reSchema = /<!-- OURWORK-HEAD-SCHEMA-START -->[\s\S]*?<!-- OURWORK-HEAD-SCHEMA-END -->/;
  if (!reStatic.test(src) || !reSchema.test(src)) return null;
  // Callback form on purpose — $-sequences in titles would corrupt output.
  return src
    .replace(reStatic, () => toEol(staticBlock, eol))
    .replace(reSchema, () => toEol(schemaBlock, eol));
}, true);

// 2. Every /services/ page that carries a strip marker
let stripCount = 0;
for (const f of readdirSync(SERVICES_DIR)) {
  if (!f.endsWith('.html')) continue;
  const file = path.join(SERVICES_DIR, f);
  stampFile(file, (src, eol) => {
    if (!STRIP_RE.test(src)) return null;           // page has no strip — fine
    STRIP_RE.lastIndex = 0;
    let ok = true;
    const out = src.replace(STRIP_RE, (m, service) => {
      if (!(service in SERVICES)) {
        console.error(`FATAL: docs/services/${f}: OURWORK-STRIP service="${service}" is not one of ${Object.keys(SERVICES).join('|')}`);
        ok = false;
        return m;
      }
      stripCount++;
      return toEol(`<!-- OURWORK-STRIP-START service="${service}" -->\n${stripBlock(service)}\n<!-- OURWORK-STRIP-END -->`, eol);
    });
    if (!ok) process.exit(1);
    return out;
  }, false);
}

// 2b. /areas/<town> — "Jobs we've done in <Town>" (OURWORK-AREA), placed
// just before the page's <!-- SERVICES --> section.
const AREA_START = '<!-- OURWORK-AREA-START -->';
const AREA_END = '<!-- OURWORK-AREA-END -->';
const AREA_ANCHOR = '<!-- SERVICES -->';
let areaCount = 0;
for (const f of readdirSync(AREAS_DIR)) {
  if (!f.endsWith('.html') || f === 'index.html') continue;
  const slug = f.replace(/\.html$/, '');
  const jobs = byTown.get(slug) || [];
  const block = jobs.length ? areaBlock(townOf(jobs[0]), jobs) : null;
  if (block) areaCount++;
  stampFile(path.join(AREAS_DIR, f), (src, eol) => {
    const out = syncRegion(src, eol, AREA_START, AREA_END, block, AREA_ANCHOR);
    if (out === null) { console.error(`FATAL: docs/areas/${f}: has ${jobs.length} job(s) but no "${AREA_ANCHOR}" anchor to place OURWORK-AREA before`); process.exit(1); }
    return out;
  }, false);
}

// 2c. Town-specific service pages (/services/<prefix>-<town>.html) —
// "Real <service> jobs in <Town>" (OURWORK-LOCAL), placed just before the
// quick-quote form. Pages that already carry a service-wide OURWORK-STRIP
// (the wood-siding town pages) are skipped: one jobs strip per page.
const LOCAL_START = '<!-- OURWORK-LOCAL-START -->';
const LOCAL_END = '<!-- OURWORK-LOCAL-END -->';
const LOCAL_ANCHOR = '<section class="qlf-section" id="quote">';
let localCount = 0;
{
  const prefixes = Object.keys(TOWN_PAGE_PREFIX).sort((a, b) => b.length - a.length);
  for (const f of readdirSync(SERVICES_DIR)) {
    if (!f.endsWith('.html')) continue;
    const base = f.replace(/\.html$/, '');
    const prefix = prefixes.find((x) => base.startsWith(`${x}-`) && existsSync(path.join(AREAS_DIR, `${base.slice(x.length + 1)}.html`)));
    if (!prefix) continue;
    const townSlug = base.slice(prefix.length + 1);
    const service = TOWN_PAGE_PREFIX[prefix];
    const jobs = (byTown.get(townSlug) || []).filter((p) => p.services.includes(service));
    const file = path.join(SERVICES_DIR, f);
    const hasStrip = /<!-- OURWORK-STRIP-START /.test(readFileSync(file, 'utf8'));
    const t = jobs.length ? townOf(jobs[0]) : null;
    const block = jobs.length && !hasStrip ? localBlock(service, t, jobs) : null;
    if (block) localCount++;
    stampFile(file, (src, eol) => {
      const out = syncRegion(src, eol, LOCAL_START, LOCAL_END, block, LOCAL_ANCHOR);
      if (out === null) { console.error(`FATAL: docs/services/${f}: has ${jobs.length} matching job(s) but no quick-quote anchor to place OURWORK-LOCAL before`); process.exit(1); }
      return out;
    }, false);
  }
}

// 2d. Homepage jobs strip (docs/index.html, OURWORK-HOME) — markers are
// required: the homepage always carries the strip.
const HOME_HTML = path.join(ROOT, 'docs', 'index.html');
stampFile(HOME_HTML, (src, eol) => {
  const re = /<!-- OURWORK-HOME-START -->[\s\S]*?<!-- OURWORK-HOME-END -->/;
  if (!re.test(src)) return null;
  return src.replace(re, () => toEol(`<!-- OURWORK-HOME-START -->\n${homeBlock()}\n<!-- OURWORK-HOME-END -->`, eol));
}, true);

// 3. Derived homeowner-wall manifest
{
  const rel = path.relative(ROOT, WALL);
  const cur = existsSync(WALL) ? readFileSync(WALL, 'utf8') : '';
  // Same EOL discipline as stampFile above. A file that does not exist yet gets
  // LF, which is what the index stores and what CI checks out.
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  if (cur.replace(/\r\n/g, '\n') !== wallJson) {
    if (CHECK) stale.push(rel);
    else writeFileSync(WALL, toEol(wallJson, eol));
  }
}

if (CHECK) {
  if (!stale.length) {
    console.log(`build-projects --check: ${live.length} live project(s), ${stripCount} hub strip(s), ${areaCount} area block(s), ${localCount} town-service strip(s), ${live.length} detail page(s) — all stamped surfaces clean.`);
    process.exit(0);
  }
  console.error(`build-projects --check: stale generated surfaces vs assets/data/projects.json:
${stale.map((s) => `  - ${s}`).join('\n')}
The OURWORK-* regions and homeowner-wall.json are GENERATED. Edit docs/assets/data/projects.json, then run:
  node scripts/build-projects.mjs
and commit ALL stamped files.`);
  process.exit(1);
}

console.log(`OK: ${live.length} live project(s) stamped — gallery + schema in docs/our-work.html, ${stripCount} hub strip(s), ${areaCount} area block(s), ${localCount} town-service strip(s), ${detailWritten} detail page(s) written (${detailDeleted} orphaned deleted), homeowner-wall.json (${Math.min(live.length, 12)} entries)${all.length - live.length ? ` (${all.length - live.length} staged for a future date)` : ''}`);
