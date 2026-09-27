#!/usr/bin/env node
/**
 * build-llms.mjs — keeps docs/llms.txt's page lists complete and generates
 * docs/llms-full.txt.
 *
 * WHY: docs/llms.txt is a hand-curated brief for AI assistants, and its page
 * lists rotted the way hand-kept lists do: on 2026-09-27 it named 31 towns
 * while docs/areas/ held 43 area pages, said "All 25+ cities", and omitted
 * /services/gutter-cleaning, /services/interior-repair and
 * /services/roof-care-plan. The prose stays hand-written; only the LISTS are
 * generated, inside marker pairs this script owns:
 *
 *   <!-- LLMS:SERVICES:START --> … <!-- LLMS:SERVICES:END -->
 *       Every service/product page not already linked (as a markdown link)
 *       elsewhere in llms.txt. SERVICE PAGE RULE: docs/services/<slug>.html
 *       whose slug does NOT end in -oh or -ky (those are the town-specific
 *       variants, e.g. roof-replacement-mason-oh), plus every
 *       docs/services/<slug>/index.html product page. Membership and order
 *       are generated (plain pages A–Z, then product pages A–Z). An entry
 *       line that already exists for a URL is KEPT VERBATIM, so its wording
 *       can be tuned by hand in place; new pages get "<title>: <meta
 *       description>".
 *   <!-- LLMS:AREAS:START --> … <!-- LLMS:AREAS:END -->
 *       Every docs/areas/<town>-<oh|ky>.html page, grouped Ohio / Kentucky,
 *       named from the page's <h1><span>Town</span> (state from the slug).
 *       Existing lines are kept verbatim, as above.
 *   <!-- LLMS:CASE-STUDIES:START --> … <!-- LLMS:CASE-STUDIES:END -->
 *       The newest CASE_STUDY_LIMIT live projects from
 *       docs/assets/data/projects.json (same live filter and sort as
 *       scripts/build-projects.mjs), fully generated — edit projects.json.
 *
 * Every listed URL must also be in docs/sitemap.xml and carry no robots
 * noindex — the sitemap is the curated public URL set, so anything it leaves
 * out stays out of here too.
 *
 * docs/llms-full.txt is written whole: the <main> content of the homepage,
 * /about, /the-pledge, every service page (rule above), the /areas hub and
 * the cost / insurance-claim blog posts (slug matches BLOG_TOPIC_RE), with
 * nav, footer, scripts, forms and markup stripped. Capped per page and in
 * total (see the caps below). Never reads docs/pro/, docs/admin/ or
 * docs/sites/; refuses to write if a CRM Storage URL or ?token= link appears
 * in the output.
 *
 * USAGE — exactly one mode (no flag = --check-regions):
 *   --check-regions  (alias --check)  CI gate. Checks ONLY the three marker
 *                    regions in docs/llms.txt; exit 1 on drift. They move only
 *                    when a page/project is added, removed or retitled.
 *   --check-full     Local/informational: is the committed llms-full.txt
 *                    current? NOT a CI gate — copy edits on any of its ~37
 *                    source pages would turn every lane red.
 *   --write-regions  Regenerate the llms.txt marker regions only.
 *   --write-full     Regenerate docs/llms-full.txt only.
 *   --write          Both. firebase-deploy.yml runs this BEFORE Deploy
 *                    Hosting, so the served llms-full.txt is always built from
 *                    the tree being deployed; the committed copy is a seed that
 *                    may lag (its header says so).
 *
 * EOL DISCIPLINE (same as build-sitemap.js / build-feed.mjs): files are
 * compared LF-normalised and written back with their own line ending, so a
 * CRLF Windows worktree and an LF CI checkout agree.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fileToUrl, parseSitemapLocs, htmlIsNoindex, ORIGIN } from './indexnow-ping.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const LLMS = path.join(DOCS, 'llms.txt');
const FULL = path.join(DOCS, 'llms-full.txt');
const PROJECTS = path.join(DOCS, 'assets', 'data', 'projects.json');

const CASE_STUDY_LIMIT = 12;
const PAGE_CAP = 24 * 1024;   // bytes of text per page in llms-full.txt
const TOTAL_CAP = 300 * 1024; // bytes for the whole llms-full.txt body
const BLOG_TOPIC_RE = /cost|insurance|claim|adjuster/;
const TOWN_SLUG_RE = /-(oh|ky)$/;

// llms-full.txt service order: the money pages first, then any other service
// page A–Z (so a new service page is included without touching this list).
const FULL_SERVICE_ORDER = [
  'the-nbd-guarantee', 'the-nbd-build', 'roof-replacement', 'roof-repair',
  'storm-damage', 'hail-damage-insurance-claim', 'emergency-roof-tarping',
  'roof-inspection', 'commercial-roofing', 'siding-replacement', 'siding-repair',
  'wood-siding-repair', 'gutter-replacement', 'gutter-cleaning', 'interior-repair',
  'fire-water-smoke-damage', 'roof-care-plan', 'roof-cleaning-soft-wash',
  'shed-roof-replacement', 'financing',
];

const MODES = {
  '--check-regions': { write: false, regions: true, full: false },
  '--check': { write: false, regions: true, full: false },
  '--check-full': { write: false, regions: false, full: true },
  '--write-regions': { write: true, regions: true, full: false },
  '--write-full': { write: true, regions: false, full: true },
  '--write': { write: true, regions: true, full: true },
};
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !MODES[args[0]])) {
  console.error('usage: node scripts/build-llms.mjs [--check-regions | --check-full | --write-regions | --write-full | --write]');
  process.exit(2);
}
const MODE = MODES[args[0] || '--check-regions'];

/* ── HTML helpers ──────────────────────────────────────────────────────── */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', trade: '™',
  reg: '®', copy: '©', times: '×', rarr: '→', larr: '←', bull: '•', deg: '°', frac12: '½',
  check: '✓', laquo: '«', raquo: '»', minus: '−', sup2: '²', dollar: '$', le: '≤', ge: '≥',
};
function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => (NAMED[n] !== undefined ? NAMED[n] : m));
}
const oneLine = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const read = (rel) => readFileSync(path.join(DOCS, rel), 'utf8');
const titleOf = (html) => oneLine((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
const descOf = (html) => {
  const m = html.match(/<meta\s+name=["']description["']\s+content=(["'])([\s\S]*?)\1/i)
    || html.match(/<meta\s+content=(["'])([\s\S]*?)\1\s+name=["']description["']/i);
  return m ? oneLine(m[2]) : '';
};

/** Readable text of an HTML page's <main>: markdown-ish headings and bullets. */
function htmlToText(html) {
  let s = String(html);
  const a = s.search(/<main[\s>]/i);
  const b = s.lastIndexOf('</main>');
  if (a !== -1 && b > a) s = s.slice(a, b);
  else {
    const body = s.search(/<body[\s>]/i);
    if (body !== -1) s = s.slice(body);
  }
  // Shared chrome stamped by apply-partials.js (the mobile nav drawer sits
  // inside <main> on many pages) — drop the whole region, then any comment.
  s = s.replace(/<!--\s*nbd:partial\s+([\w-]+)[\s\S]*?-->[\s\S]*?<!--\s*\/nbd:partial\s+\1\s*-->/g, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer', 'form', 'button', 'select', 'textarea', 'iframe', 'video', 'audio', 'dialog']) {
    s = s.replace(new RegExp('<' + tag + '[\\s>][\\s\\S]*?</' + tag + '>', 'gi'), ' ');
  }
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => {
    const t = oneLine(inner);
    if (!t) return '\n';
    const hashes = n <= 2 ? '###' : n === '3' ? '####' : '#####';
    return '\n\n' + hashes + ' ' + t + '\n\n';
  });
  s = s.replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|aside|ul|ol|table|thead|tbody|tr|blockquote|dl|dt|dd|figure|figcaption|details|summary|main|address|hr)[^>]*>/gi, '\n\n')
    .replace(/<\/?(td|th)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  s = decode(s);
  const lines = s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim());
  const out = [];
  for (const l of lines) {
    if (l === '-' || l === '') { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    if (l === out[out.length - 1]) continue; // duplicated responsive copy
    out.push(l);
  }
  // Bullets separated only by blank lines read better as a tight list.
  const tight = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '' && tight.length && /^- /.test(tight[tight.length - 1]) && /^- /.test(out[i + 1] || '')) continue;
    tight.push(out[i]);
  }
  return tight.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Truncate at a paragraph break at or before `cap` bytes. */
function capText(text, cap, url) {
  if (Buffer.byteLength(text) <= cap) return text;
  let cut = text.slice(0, cap);
  while (Buffer.byteLength(cut) > cap) cut = cut.slice(0, -1);
  const br = cut.lastIndexOf('\n\n');
  if (br > cap / 2) cut = cut.slice(0, br);
  return cut.trimEnd() + '\n\n[… truncated — full page: ' + url + ']';
}

/* ── Discovery ─────────────────────────────────────────────────────────── */

const sitemapLocs = parseSitemapLocs(read('sitemap.xml'));
const publicUrl = (rel) => {
  const url = fileToUrl('docs/' + rel);
  if (!url || !sitemapLocs.has(url)) return null;
  if (htmlIsNoindex(read(rel))) return null;
  return url;
};

function servicePages() {
  const dir = path.join(DOCS, 'services');
  const plain = readdirSync(dir)
    .filter((f) => f.endsWith('.html') && statSync(path.join(dir, f)).isFile())
    .map((f) => f.slice(0, -5))
    .filter((slug) => !TOWN_SLUG_RE.test(slug))
    .sort()
    .map((slug) => ({ slug, rel: 'services/' + slug + '.html' }));
  const product = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'index.html')))
    .map((d) => d.name)
    .sort()
    .map((slug) => ({ slug, rel: 'services/' + slug + '/index.html' }));
  return [...plain, ...product]
    .map((p) => ({ ...p, url: publicUrl(p.rel) }))
    .filter((p) => p.url);
}

function areaPages() {
  const dir = path.join(DOCS, 'areas');
  return readdirSync(dir)
    .filter((f) => /-(oh|ky)\.html$/.test(f))
    .sort()
    .map((f) => {
      const slug = f.slice(0, -5);
      const rel = 'areas/' + f;
      const html = read(rel);
      const state = slug.endsWith('-ky') ? 'KY' : 'OH';
      const h1 = html.match(/<h1[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
      const town = h1 ? oneLine(h1[1])
        : slug.slice(0, -3).split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
      return { slug, rel, state, town, url: publicUrl(rel) };
    })
    .filter((p) => p.url);
}

function liveProjects() {
  const data = JSON.parse(readFileSync(PROJECTS, 'utf8'));
  const all = Array.isArray(data) ? data : data.projects || [];
  // Same live filter + sort as scripts/build-projects.mjs.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const live = all.filter((p) => {
    const d = new Date(p.published); d.setHours(0, 0, 0, 0);
    return d <= today;
  });
  live.sort((a, b) => new Date(b.published) - new Date(a.published));
  return live
    .map((p) => ({ ...p, url: existsSync(path.join(DOCS, 'our-work', p.slug + '.html')) ? publicUrl('our-work/' + p.slug + '.html') : null }))
    .filter((p) => p.url);
}

/* ── llms.txt blocks ───────────────────────────────────────────────────── */

const BLOCKS = ['SERVICES', 'AREAS', 'CASE-STUDIES'];
const startMark = (n) => '<!-- LLMS:' + n + ':START -->';
const endMark = (n) => '<!-- LLMS:' + n + ':END -->';

function blockRange(text, name) {
  const a = text.indexOf(startMark(name));
  const b = text.indexOf(endMark(name));
  if (a === -1 || b === -1 || b < a || text.indexOf(startMark(name), a + 1) !== -1) {
    throw new Error('docs/llms.txt: missing, duplicated or misordered ' + name + ' markers');
  }
  return { a, bodyStart: a + startMark(name).length, b };
}

const LINK_RE = /\]\((https:\/\/nobigdealwithjoedeal\.com[^)\s]*)\)/g;
const lineUrl = (line) => { const m = /^- \[[^\]]*\]\((https:\/\/[^)\s]+)\)/.exec(line); return m ? m[1] : null; };

function existingLines(body) {
  const map = new Map();
  for (const line of body.split('\n')) { const u = lineUrl(line); if (u) map.set(u, line); }
  return map;
}

const money = (n) => '$' + Number(n).toLocaleString('en-US');

function renderServices(body, handLinked) {
  const keep = existingLines(body);
  const lines = ['<!-- generated by scripts/build-llms.mjs from docs/services/ (town variants *-oh/*-ky excluded) — membership is generated; existing entry wording is kept -->'];
  for (const p of servicePages()) {
    if (handLinked.has(p.url)) continue;
    if (keep.has(p.url)) { lines.push(keep.get(p.url)); continue; }
    const html = read(p.rel);
    const name = titleOf(html).split(' | ')[0];
    const desc = descOf(html);
    lines.push('- [' + name + '](' + p.url + ')' + (desc ? ': ' + desc : ''));
  }
  return lines;
}

function renderAreas(body) {
  const keep = existingLines(body);
  const areas = areaPages();
  const lines = ['<!-- generated by scripts/build-llms.mjs from docs/areas/*.html — membership is generated; existing entry wording is kept -->'];
  lines.push(areas.length + ' towns have their own service-area page.');
  for (const [state, label] of [['OH', 'Ohio'], ['KY', 'Kentucky']]) {
    const group = areas.filter((a) => a.state === state);
    if (!group.length) continue;
    lines.push('', '### ' + label + ' (' + group.length + ')', '');
    for (const a of group) lines.push(keep.get(a.url) || '- [' + a.town + ', ' + a.state + '](' + a.url + ')');
  }
  return lines;
}

function renderCaseStudies() {
  const live = liveProjects();
  const shown = live.slice(0, CASE_STUDY_LIMIT);
  const lines = ['<!-- generated by scripts/build-llms.mjs from docs/assets/data/projects.json — edit that file, not this list -->'];
  lines.push('The ' + shown.length + ' most recent of ' + live.length + ' published projects:', '');
  for (const p of shown) {
    const bits = [p.city, p.tag].filter(Boolean).join(' · ');
    const price = p.priceLow != null && p.priceHigh != null ? ' Retail price range: ' + money(p.priceLow) + '–' + money(p.priceHigh) + '.' : '';
    lines.push('- [' + oneLine(p.title) + '](' + p.url + ')' + (bits ? ' — ' + oneLine(bits) : '') + ': ' + oneLine(p.description || '') + price);
  }
  return lines;
}

function renderLlms(currentLF) {
  // Hand-linked URLs = markdown links OUTSIDE every generated block.
  let outside = currentLF;
  for (const n of BLOCKS) {
    const r = blockRange(outside, n);
    outside = outside.slice(0, r.bodyStart) + outside.slice(r.b);
  }
  const handLinked = new Set([...outside.matchAll(LINK_RE)].map((m) => m[1]));

  let text = currentLF;
  for (const n of BLOCKS) {
    const r = blockRange(text, n);
    const body = text.slice(r.bodyStart, r.b);
    const lines = n === 'SERVICES' ? renderServices(body, handLinked)
      : n === 'AREAS' ? renderAreas(body)
      : renderCaseStudies();
    text = text.slice(0, r.bodyStart) + '\n' + lines.join('\n') + '\n' + text.slice(r.b);
  }
  return text;
}

/* ── llms-full.txt ─────────────────────────────────────────────────────── */

function fullPages() {
  const pages = [
    { rel: 'index.html' }, { rel: 'about.html' }, { rel: 'the-pledge/index.html' },
  ];
  // Priority order, because the total cap drops pages from the END: core
  // services (FULL_SERVICE_ORDER), the areas hub, the cost/insurance posts,
  // then every other service/product page A–Z.
  const services = servicePages();
  const core = FULL_SERVICE_ORDER.map((slug) => services.find((s) => s.slug === slug)).filter(Boolean);
  const rest = services.filter((s) => !FULL_SERVICE_ORDER.includes(s.slug));
  pages.push(...core.map((s) => ({ rel: s.rel })));
  pages.push({ rel: 'areas/index.html' });
  const blogDir = path.join(DOCS, 'blog');
  pages.push(...readdirSync(blogDir)
    .filter((f) => f.endsWith('.html') && f !== 'index.html' && BLOG_TOPIC_RE.test(f))
    .sort()
    .map((f) => ({ rel: 'blog/' + f })));
  pages.push(...rest.map((s) => ({ rel: s.rel })));
  return pages
    .filter((p) => !/^(pro|admin|sites)\//.test(p.rel))
    .map((p) => ({ ...p, url: publicUrl(p.rel) }))
    .filter((p) => p.url);
}

function renderFull() {
  const pages = fullPages();
  const sections = [];
  const omitted = [];
  let used = 0;
  for (const p of pages) {
    const html = read(p.rel);
    const title = titleOf(html);
    const text = capText(htmlToText(html), PAGE_CAP, p.url);
    const section = '## ' + title + '\n\nURL: ' + p.url + '\n\n' + text + '\n';
    const size = Buffer.byteLength(section);
    if (used + size > TOTAL_CAP) { omitted.push(p); continue; }
    used += size;
    sections.push({ p, title, section });
  }
  const head = [
    '# No Big Deal Home Solutions — full-text context (llms-full.txt)',
    '',
    '> The readable content of No Big Deal Home Solutions\' core public pages in one plain-text document, for AI assistants and LLM tools that want more than the link index in https://nobigdealwithjoedeal.com/llms.txt. Owner-operated roofing, siding, gutter, interior repair and insurance-restoration contractor (Joe Deal) serving Greater Cincinnati, Northern Kentucky and the Lexington, KY area.',
    '',
    'Freshness: this file is regenerated at every deploy from the pages being deployed, so the served copy matches the live site; the copy in the git repository is a seed and may lag behind it.',
    '',
    'How this file is made: generated by scripts/build-llms.mjs from the site\'s own HTML — each section is the <main> content of one page, with navigation, footers, scripts, forms and markup stripped. The live page at each section\'s URL is always the source of truth; long pages are truncated (marked) at ' + (PAGE_CAP / 1024) + ' KB. Prices that appear are retail prices homeowners pay. The curated summary, citation guidelines and contact rules are in llms.txt.',
    '',
    'Pages included (' + sections.length + '):',
    ...sections.map((s) => '- ' + s.title + ' — ' + s.p.url),
  ];
  if (omitted.length) {
    head.push('', 'Left out to keep this file under ' + (TOTAL_CAP / 1024) + ' KB (read them at their URLs):', ...omitted.map((p) => '- ' + p.url));
  }
  const out = head.join('\n') + '\n\n---\n\n' + sections.map((s) => s.section).join('\n---\n\n');
  if (/firebasestorage\.googleapis\.com|[?&]token=/i.test(out)) {
    throw new Error('llms-full.txt would contain a CRM Storage URL / ?token= link — refusing to write');
  }
  return { out, count: sections.length, omitted: omitted.length };
}

/* ── Main ──────────────────────────────────────────────────────────────── */

function readEol(file) {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
  return { cur, eol: cur && cur.includes('\r\n') ? '\r\n' : null, lf: cur === null ? null : cur.replace(/\r\n/g, '\n') };
}

function diffSummary(label, a, b) {
  const x = (a || '').split('\n'); const y = b.split('\n');
  const xs = new Set(x); const ys = new Set(y);
  const removed = x.filter((l) => !ys.has(l)); const added = y.filter((l) => !xs.has(l));
  console.error(label + ' drifts from its sources (' + added.length + ' line(s) added, ' + removed.length + ' removed):');
  for (const l of removed.slice(0, 20)) console.error('- ' + l.slice(0, 160));
  for (const l of added.slice(0, 20)) console.error('+ ' + l.slice(0, 160));
  if (removed.length > 20 || added.length > 20) console.error('  … (showing the first 20 of each)');
}

function main() {
  const llms = readEol(LLMS);
  if (llms.cur === null) { console.error('docs/llms.txt is missing'); process.exit(2); }
  const full = readEol(FULL);
  // New llms-full.txt takes llms.txt's ending, so a CRLF worktree stays uniform.
  const llmsEol = llms.eol || '\n';
  const fullEol = full.eol || (full.cur === null ? llmsEol : '\n');

  // Only render what the mode touches — --check-regions never reads the ~37
  // full-text source pages' bodies.
  let llmsNext = null; let fullNext = null;
  try {
    if (MODE.regions) llmsNext = renderLlms(llms.lf);
    if (MODE.full) fullNext = renderFull();
  } catch (e) { console.error('FATAL: ' + e.message); process.exit(2); }

  const llmsOk = !MODE.regions || llmsNext === llms.lf;
  const fullOk = !MODE.full || fullNext.out === full.lf;
  const fullDesc = fullNext ? ' (' + fullNext.count + ' pages, ' + (Buffer.byteLength(fullNext.out) / 1024).toFixed(1) + ' KB'
    + (fullNext.omitted ? ', ' + fullNext.omitted + ' over the size cap' : '') + ')' : '';

  if (MODE.write) {
    const jobs = [];
    if (MODE.regions) jobs.push([LLMS, llmsNext, llmsOk, llmsEol]);
    if (MODE.full) jobs.push([FULL, fullNext.out, fullOk, fullEol]);
    for (const [file, next, ok, eol] of jobs) {
      if (ok) continue;
      const tmp = file + '.tmp-' + process.pid;
      writeFileSync(tmp, eol === '\n' ? next : next.replace(/\n/g, eol));
      renameSync(tmp, file);
    }
    const said = [];
    if (MODE.regions) said.push('docs/llms.txt regions ' + (llmsOk ? 'unchanged' : 'regenerated'));
    if (MODE.full) said.push('docs/llms-full.txt ' + (fullOk ? 'unchanged' : 'written') + fullDesc);
    console.log('OK: ' + said.join('; ') + '.');
    return;
  }

  if (llmsOk && fullOk) {
    console.log('OK: ' + (MODE.regions ? 'docs/llms.txt generated regions are current.' : 'docs/llms-full.txt is current' + fullDesc + '.'));
    return;
  }
  if (!llmsOk) {
    diffSummary('docs/llms.txt (SERVICES / AREAS / CASE-STUDIES regions)', llms.lf, llmsNext);
    console.error('Run: node scripts/build-llms.mjs --write-regions');
  }
  if (!fullOk) {
    if (full.cur === null) console.error('docs/llms-full.txt does not exist.');
    else diffSummary('docs/llms-full.txt', full.lf, fullNext.out);
    console.error('Run: node scripts/build-llms.mjs --write-full   (optional — the deploy regenerates it)');
  }
  process.exit(1);
}

main();
