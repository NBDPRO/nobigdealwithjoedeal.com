#!/usr/bin/env node
/**
 * migrate-schema-entity.mjs — collapse the site's ~150 copies of the business
 * (and 30+ copies of Joe) into ONE entity graph referenced by @id.
 *
 * WHY (2026-09-27 SEO/AEO/GEO deep dive)
 * Search and AI engines saw a separate, disconnected copy of "No Big Deal Home
 * Solutions" on almost every page: the homepage carried the full
 * RoofingContractor with no @id; every area page declared its own mini-business
 * pinned to THAT TOWN's coordinates (24 of them also claiming a Goshen
 * address); 147 Service nodes inlined their own provider; 28 blog posts
 * published under an anonymous Organization and a bare {"Person","Joe Deal"};
 * and "/#org" — referenced 106 times — was only defined, thinly, on /our-work.
 * Nothing tied any of it together, so there was no single entity to rank.
 *
 * WHAT IT DOES (idempotent; dry-run unless --write)
 *   1. Every public indexable page gets an empty
 *        <!-- nbd:partial schema-entity --> … <!-- /nbd:partial schema-entity -->
 *      region just before </head>; `node scripts/apply-partials.js` then
 *      stamps site-src/partials/schema-entity.html into it — the ONE
 *      definition of #org (the RoofingContractor), #joe (the Person) and
 *      #website, and the only place any of their facts live.
 *   2. Every other JSON-LD node that describes the business, Joe or the
 *      WebSite becomes a bare {"@id": …} reference (Service.provider,
 *      BlogPosting.publisher/author, WebPage.isPartOf/about/publisher,
 *      Offer.seller, …).
 *   3. Standalone business / Joe blocks are deleted — the partial carries
 *      them. Two exceptions keep their page-specific facts:
 *        - docs/areas/<town>-<st>.html: the mini-business (town geo, Goshen
 *          address, neighbour list) becomes a Service node whose areaServed is
 *          that City and whose provider is {"@id": "#org"}.
 *        - a block carrying review[] (docs/review.html) keeps its reviews and
 *          attaches them to the one entity: {"@id": "#org", "review": […]}.
 *   4. A Service whose areaServed is a single "Town, OH|KY" string (the
 *      docs/services/<service>-<town>-<st>.html pages) gets a typed City node,
 *      matching the area pages.
 *
 * Edits are SPAN-LEVEL: each replaced value is cut out of the original text by
 * a position-tracking JSON scanner, so every untouched byte of a block —
 * hand-formatting, inline arrays, FAQ answers — survives exactly. Each edited
 * block is then re-parsed and deep-compared against an independent semantic
 * transform of the original; any mismatch aborts before anything is written.
 * Inserted text is built with \n and converted ONCE to the file's own EOL,
 * and the run asserts no lone CR byte in any file it writes.
 *
 * NOT TOUCHED — generator-owned regions (BLOG-*, OURWORK-*, TOWN*:START, nbd:partial) are
 * skipped; blog/index.html's head schema is fixed in build-blog-index.mjs.
 * PENDING below lists pages another lane owns; they are exempted in the gate
 * (scripts/check-seo-surface.js ENTITY_PENDING) until migrated. To finish one:
 * drop it from PENDING here and there, run this with --write, then
 * apply-partials.
 *
 * Usage:
 *   node scripts/migrate-schema-entity.mjs            # dry run: report only
 *   node scripts/migrate-schema-entity.mjs --write    # apply
 *   node scripts/apply-partials.js                    # then stamp the partial
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const WRITE = process.argv.includes('--write');

const O = 'https://nobigdealwithjoedeal.com';
const ORG = `${O}/#org`;
const JOE = `${O}/#joe`;
const SITE = `${O}/#website`;

// Mirrors check-seo-surface.js: the walk it audits, minus declared noindex.
const SKIP_DIRS = new Set(['pro', 'sites', 'admin', 'tools', 'dev']);
// Must match ENTITY_PENDING in scripts/check-seo-surface.js.
const PENDING = [
  // (/our-work and docs/our-work/** left this list 2026-09-27: build-projects.mjs
  //  now emits only @id references and carries the schema-entity region.
  //  The two insurance blog posts left it with their rewrite, #1796.)
];

const STATE = { OH: 'Ohio', KY: 'Kentucky' };
const BIZ_TYPES = /^(RoofingContractor|LocalBusiness|Organization|HomeAndConstructionBusiness|GeneralContractor|ProfessionalService)$/;

const types = (n) => [].concat(n && n['@type'] || []);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isBiz = (n) => isObj(n) && types(n).some((t) => BIZ_TYPES.test(t))
  && typeof n.name === 'string' && /^no big deal/i.test(n.name);
const isJoe = (n) => isObj(n) && types(n).includes('Person')
  && typeof n.name === 'string' && /^joe deal$/i.test(n.name.trim());
const isSite = (n) => isObj(n) && types(n).includes('WebSite')
  && typeof n.name === 'string' && /^no big deal/i.test(n.name);
const refFor = (n) => (isBiz(n) ? ORG : isJoe(n) ? JOE : isSite(n) ? SITE : null);

// The 43 towns, keyed "Town, ST", from the area pages themselves.
// One spelling per town: the breadcrumbs say "Mt Orab", every areaServed and
// the homepage say "Mt. Orab".
const canonTown = (s) => s.trim().replace(/^Mt\.? /, 'Mt. ');
const TOWNS = new Map();
for (const f of fs.readdirSync(path.join(DOCS, 'areas'))) {
  const m = f.match(/^(.+)-(oh|ky)\.html$/);
  if (!m) continue;
  const html = fs.readFileSync(path.join(DOCS, 'areas', f), 'utf8');
  // The town name as the page itself spells it: its breadcrumb leaf, else
  // its (pre-migration) areaServed lead.
  const t = html.match(/"position":\s*3,\s*"name":\s*"([^"]+), (OH|KY)"/)
    || html.match(/"areaServed":\s*\[\s*"([^"]+), (OH|KY)"/);
  if (!t) throw new Error(`cannot read the town name from docs/areas/${f}`);
  const name = canonTown(t[1]);
  TOWNS.set(`${name}, ${t[2]}`, { name, st: t[2], file: f });
}
const cityNode = (town) => ({ '@type': 'City', name: town.name,
  containedInPlace: { '@type': 'State', name: STATE[town.st] } });
const townFromString = (s) => (typeof s === 'string' ? TOWNS.get(canonTown(s)) : null);

// ── Position-tracking JSON scanner ──────────────────────────────────────
function scan(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const fail = (msg) => { throw new Error(`${msg} at ${i}`); };
  const str = () => {
    if (text[i] !== '"') fail('expected string');
    const s = i++;
    while (text[i] !== '"') { if (text[i] === '\\') i++; i++; if (i > text.length) fail('unterminated string'); }
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const val = () => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++; const members = []; ws();
      if (text[i] === '}') { i++; return { kind: 'obj', start, end: i, members }; }
      for (;;) {
        ws(); const keyStart = i; const key = str(); ws();
        if (text[i++] !== ':') fail('expected :');
        const value = val(); members.push({ key, keyStart, value }); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] !== '}') fail('expected }');
        return { kind: 'obj', start, end: i, members };
      }
    }
    if (c === '[') {
      i++; const items = []; ws();
      if (text[i] === ']') { i++; return { kind: 'arr', start, end: i, items }; }
      for (;;) {
        items.push(val()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] !== ']') fail('expected ]');
        return { kind: 'arr', start, end: i, items };
      }
    }
    if (c === '"') { str(); return { kind: 'str', start, end: i }; }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!m) fail('unexpected token');
    i += m[0].length;
    return { kind: 'lit', start, end: i };
  };
  const root = val(); ws();
  if (i !== text.length) fail('trailing content');
  return root;
}

// Pretty-print in a block's own indentation, inlining anything that fits.
function pretty(v, ind, unit, spaced) {
  const flat = inline(v, spaced);
  if (v === null || typeof v !== 'object' || ind.length + flat.length <= 110) return flat;
  const pad = ind + unit;
  const colon = spaced ? ': ' : ':';
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + pretty(x, pad, unit, spaced)).join(',\n')}\n${ind}]`;
  return `{\n${Object.entries(v).map(([k, x]) => pad + JSON.stringify(k) + colon + pretty(x, pad, unit, spaced)).join(',\n')}\n${ind}}`;
}
function inline(v, spaced) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const sep = spaced ? ', ' : ',';
  if (Array.isArray(v)) return `[${v.map((x) => inline(x, spaced)).join(sep)}]`;
  return `{${Object.entries(v).map(([k, x]) => JSON.stringify(k) + (spaced ? ': ' : ':') + inline(x, spaced)).join(sep)}}`;
}

// ── Semantic transform (the specification the text edits must match) ───
function semanticNested(v) {
  if (Array.isArray(v)) return v.map((x) => (refFor(x) ? { '@id': refFor(x) } : semanticNested(x)));
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = refFor(x) ? { '@id': refFor(x) } : semanticNested(x);
  if (types(v).includes('Service') && townFromString(v.areaServed)) out.areaServed = cityNode(townFromString(v.areaServed));
  return out;
}

function areaService(node, pageUrl, town) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: `Roofing, Siding & Gutters in ${town.name}, ${town.st}`,
    serviceType: 'Roofing, siding and gutter services',
    description: node.description,
    url: pageUrl,
    provider: { '@id': ORG },
    areaServed: cityNode(town),
  };
}

// Decide what happens to one block. Returns {action:'keep'|'edit'|'remove', expected}.
function planBlock(obj, ctx) {
  if (Array.isArray(obj)) return { action: 'edit', expected: semanticNested(obj) };
  if (isJoe(obj)) return { action: 'remove', why: 'standalone Joe Person (partial carries #joe)' };
  if (isSite(obj)) return { action: 'remove', why: 'standalone WebSite (partial carries #website)' };
  if (isBiz(obj)) {
    if (ctx.areaTown) return { action: 'area', expected: areaService(obj, ctx.url, ctx.areaTown), why: 'area mini-business → Service' };
    if (Array.isArray(obj.review)) {
      const expected = {};
      if ('@context' in obj) expected['@context'] = obj['@context'];
      expected['@id'] = ORG;
      expected.review = obj.review;
      return { action: 'review', expected, why: 'reviews attached to #org' };
    }
    return { action: 'remove', why: 'standalone business (partial carries #org)' };
  }
  if (obj['@graph']) {
    for (const g of obj['@graph']) {
      if (refFor(g)) throw new Error(`${ctx.rel}: an @graph member defines the business/Joe — handle by hand`);
    }
  }
  return { action: 'edit', expected: semanticNested(obj) };
}

// Text edits for a nested rewrite — mirrors semanticNested exactly.
function nestedEdits(text, node, spaced, edits) {
  const ref = (id) => (spaced ? `{"@id": "${id}"}` : `{"@id":"${id}"}`);
  const sem = (n) => JSON.parse(text.slice(n.start, n.end));
  if (node.kind === 'arr') {
    for (const it of node.items) {
      const r = it.kind === 'obj' ? refFor(sem(it)) : null;
      if (r) edits.push([it.start, it.end, ref(r)]); else nestedEdits(text, it, spaced, edits);
    }
  } else if (node.kind === 'obj') {
    const self = sem(node);
    for (const m of node.members) {
      const r = m.value.kind === 'obj' ? refFor(sem(m.value)) : null;
      if (r) { edits.push([m.value.start, m.value.end, ref(r)]); continue; }
      if (m.key === 'areaServed' && types(self).includes('Service') && townFromString(self.areaServed)) {
        edits.push([m.value.start, m.value.end, inline(cityNode(townFromString(self.areaServed)), spaced)]);
        continue;
      }
      nestedEdits(text, m.value, spaced, edits);
    }
  }
}

const applyEdits = (text, edits) => edits.sort((a, b) => b[0] - a[0])
  .reduce((t, [s, e, r]) => t.slice(0, s) + r + t.slice(e), text);

// ── Pages ───────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (dir === DOCS && SKIP_DIRS.has(e.name)) continue; walk(full, out); }
    else if (e.isFile() && e.name.endsWith('.html')) out.push(full);
  }
  return out;
}
const isNoIndex = (html) => {
  const tag = (html.match(/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*>/i) || [])[0];
  return !!tag && /noindex/i.test(tag);
};

function protectedRanges(html) {
  const out = [];
  // Every generator's marker family: NAME-START … NAME-END (BLOG-*, OURWORK-*)
  // and NAME:START … NAME:END (build-town-pages.mjs's TOWNFAQ, TOWNFACTS, …).
  for (const m of html.matchAll(/<!--\s*([A-Z][A-Z0-9-]*?)-START\b[\s\S]*?<!--\s*\1-END\s*-->/g)) out.push([m.index, m.index + m[0].length]);
  for (const m of html.matchAll(/<!--\s*([A-Z][A-Z0-9-]*):START\b[\s\S]*?<!--\s*\1:END\s*-->/g)) out.push([m.index, m.index + m[0].length]);
  for (const m of html.matchAll(/<!--\s*nbd:partial\s+([a-z0-9-]+)[\s\S]*?<!--\s*\/nbd:partial\s+\1\s*-->/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

const RX_BLOCK = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const stats = { pages: 0, changed: 0, stamped: 0, removed: 0, area: 0, review: 0, refs: 0, city: 0 };
const skippedWithEntities = [];
let problems = 0;

for (const abs of walk(DOCS).sort()) {
  const rel = path.relative(DOCS, abs).replace(/\\/g, '/');
  if (/^google[0-9a-f]{16}\.html$/.test(rel)) continue;
  const before = fs.readFileSync(abs, 'utf8');
  const pending = PENDING.some((rx) => rx.test(rel));
  if (isNoIndex(before) || pending) {
    if (/"(?:name)"\s*:\s*"(?:No Big Deal[^"]*|Joe Deal)"/.test(before)) skippedWithEntities.push(`${rel}${pending ? ' (pending)' : ' (noindex)'}`);
    continue;
  }
  stats.pages++;
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (s) => s.replace(/\n/g, eol);
  const canon = (before.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1];
  const areaM = rel.match(/^areas\/(.+-(?:oh|ky))\.html$/);
  const areaTown = areaM ? [...TOWNS.values()].find((t) => t.file === `${areaM[1]}.html`) : null;
  const ctx = { rel, url: canon || `${O}/${rel.replace(/(index)?\.html$/, '')}`, areaTown };
  const prot = protectedRanges(before);
  const log = [];
  const htmlEdits = [];

  for (const m of before.matchAll(RX_BLOCK)) {
    if (prot.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const body = m[1];
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    let obj;
    try { obj = JSON.parse(body); } catch (e) { console.error(`✗ ${rel}: unparseable JSON-LD — ${e.message}`); problems++; continue; }
    const plan = planBlock(obj, ctx);
    const tree = scan(body.trim());
    const lead = body.length - body.trimStart().length;
    const spaced = /"\s*:\s/.test(body);
    let newBody = null;

    if (plan.action === 'remove') {
      // Whole lines when the tag owns them; otherwise just the tag.
      let s = m.index, e = m.index + m[0].length;
      const ls = before.lastIndexOf('\n', s - 1) + 1;
      const le = before.indexOf('\n', e);
      if (/^[ \t]*$/.test(before.slice(ls, s)) && /^[ \t\r]*$/.test(before.slice(e, le === -1 ? before.length : le))) {
        s = ls; e = le === -1 ? before.length : le + 1;
      }
      htmlEdits.push([s, e, '']);
      log.push(`remove block — ${plan.why}`); stats.removed++;
      continue;
    }
    if (plan.action === 'area') {
      if (!areaTown) throw new Error(`${rel}: area plan without a town`);
      const firstLine = body.trimStart().split('\n')[1] || '';
      const unit = (firstLine.match(/^[ \t]*/) || ['  '])[0] || '  ';
      const lineStart = before.lastIndexOf('\n', bodyStart + lead - 1) + 1;
      const baseInd = /^[ \t]*$/.test(before.slice(lineStart, bodyStart + lead)) ? before.slice(lineStart, bodyStart + lead) : '';
      const text = toEol(pretty(plan.expected, baseInd, unit.slice(baseInd.length) || '  ', spaced));
      newBody = body.slice(0, lead) + text + body.slice(lead + tree.end);
      log.push(`area Service (${areaTown.name}, ${areaTown.st})`); stats.area++;
    } else if (plan.action === 'review') {
      const t = body.trim();
      const keep = tree.members.filter((mm) => mm.key === '@context' || mm.key === 'review');
      const sep = t.slice(tree.start + 1, tree.members[0].keyStart);
      const closing = t.slice(tree.members[tree.members.length - 1].value.end, tree.end - 1);
      const idMember = `"@id": "${ORG}"`;
      const parts = keep.map((mm) => t.slice(mm.keyStart, mm.value.end));
      const ctxIdx = keep.findIndex((mm) => mm.key === '@context');
      parts.splice(ctxIdx + 1, 0, idMember);
      const text = `{${sep}${parts.join(`,${sep}`)}${closing}}`;
      newBody = body.slice(0, lead) + text + body.slice(lead + tree.end);
      log.push('review block → {"@id": #org, review}'); stats.review++;
    } else {
      const edits = [];
      nestedEdits(body.trim(), tree, spaced, edits);
      if (!edits.length) continue;
      const t = body.trim();
      newBody = body.slice(0, lead) + applyEdits(t, edits) + body.slice(lead + t.length);
      for (const [, , r] of edits) {
        if (r.includes('"City"')) stats.city++; else stats.refs++;
        log.push(r.includes('"City"') ? 'areaServed → City' : `ref ${r.match(/#\w+/)[0]}`);
      }
    }

    // Verify: the rewritten block parses to exactly the semantic transform.
    const got = JSON.parse(newBody);
    if (JSON.stringify(got) !== JSON.stringify(plan.expected)) {
      console.error(`✗ ${rel}: text edit diverged from the semantic transform\n  want ${JSON.stringify(plan.expected).slice(0, 300)}\n  got  ${JSON.stringify(got).slice(0, 300)}`);
      problems++;
      continue;
    }
    htmlEdits.push([bodyStart, bodyStart + body.length, newBody]);
  }

  // Stamp point for the entity partial: its own lines, just before </head>.
  if (!/nbd:partial schema-entity\b/.test(before)) {
    const h = before.search(/<\/head>/i);
    if (h < 0) { console.error(`✗ ${rel}: no </head>`); problems++; }
    else {
      const ls = before.lastIndexOf('\n', h - 1) + 1;
      const onOwnLine = /^[ \t]*$/.test(before.slice(ls, h));
      const at = onOwnLine ? ls : h;
      const marker = `${onOwnLine ? '' : '\n'}<!-- nbd:partial schema-entity -->\n<!-- /nbd:partial schema-entity -->\n`;
      htmlEdits.push([at, at, toEol(marker)]);
      log.push('stamp point for schema-entity'); stats.stamped++;
    }
  }

  if (!htmlEdits.length) continue;
  const after = applyEdits(before, htmlEdits);
  // EOL hygiene: no lone CR, and no new lone LF in a CRLF file.
  for (let k = 0; k < after.length; k++) {
    if (after.charCodeAt(k) === 13 && after.charCodeAt(k + 1) !== 10) throw new Error(`${rel}: lone CR at ${k}`);
  }
  const loneLf = (s) => (s.match(/(^|[^\r])\n/g) || []).length;
  if (eol === '\r\n' && loneLf(after) > loneLf(before)) throw new Error(`${rel}: edit introduced LF-only lines into a CRLF file`);
  stats.changed++;
  console.log(`${WRITE ? '✎' : '·'} ${rel}: ${log.join('; ')}`);
  if (WRITE) fs.writeFileSync(abs, after);
}

console.log('');
console.log(JSON.stringify(stats));
if (skippedWithEntities.length) {
  console.log(`\nNot migrated (noindex or PENDING) but still carrying business/Joe nodes:\n  ${skippedWithEntities.join('\n  ')}`);
}
if (problems) { console.error(`\n${problems} problem(s) — nothing should be committed until they are resolved.`); process.exit(1); }
if (!WRITE) console.log('\nDry run. Re-run with --write to apply, then: node scripts/apply-partials.js');
