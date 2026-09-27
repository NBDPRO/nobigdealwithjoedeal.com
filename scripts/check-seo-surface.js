#!/usr/bin/env node
/**
 * scripts/check-seo-surface.js — the whole public surface, on the same
 * criteria a paid one-page audit uses.
 * ═══════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04)
 *
 * An agency ran an automated SEO audit on nobigdealwithjoedeal.com and sold
 * it as "a full, third-party audit". It graded exactly ONE url — the
 * homepage — out of 242 public pages, then priced the remediation. Several
 * of its findings were already false on the page it did scan: it recommended
 * "Add FAQ / Q&A Content" to a page carrying FAQPage JSON-LD with six
 * questions, and "Add Business Address and Phone Number" to a page that
 * states the phone nineteen times and twice in schema.
 *
 * The lesson is not that the tool was bad. It is that nobody here could
 * answer "is that true of the other 241 pages?" without checking by hand.
 * This script answers it, deterministically, for free, on every page.
 *
 * WHAT IT CHECKS
 *
 * Only things that are mechanically decidable from the shipped HTML. It does
 * NOT score, rank, or guess at keyword strategy — a number like "93/100" is
 * a vendor's opinion dressed as a measurement, and reproducing that here
 * would be inventing authority we do not have.
 *
 *   ERROR — objectively broken, blocks CI
 *     missing/empty <title>; missing meta description; zero or multiple <h1>;
 *     missing canonical; malformed JSON-LD (unparseable); missing lang;
 *     missing viewport; an <img> with no alt attribute at all; a FAQPage
 *     question that appears nowhere in the page's visible text.
 *
 *   WARN — a real weakness, reported but does not block
 *     title outside 50-60 chars; description outside 120-160; no JSON-LD;
 *     no Open Graph title/description/image; empty alt on a non-decorative
 *     image; a raster hero with no WebP sibling; no freshness signal on a
 *     page type that should carry one.
 *
 * Excludes docs/pro/ (the CRM — private, noindex, not a search surface) and
 * generator-owned fragments — EXCEPT the handful of pages inside a skipped
 * directory that a sitemap lists as public. Those are audited; see
 * sitemapSurfaces().
 *
 * USAGE
 *   node scripts/check-seo-surface.js            # human report, exit 1 on ERROR
 *   node scripts/check-seo-surface.js --quiet    # summary + errors only
 *   node scripts/check-seo-surface.js --json     # machine-readable
 *   node scripts/check-seo-surface.js --warn-as-error   # strict
 *
 * The exit code is computed ONCE at the end, from the collected findings,
 * and every output mode falls through to it — the --json branch does not get
 * its own early return. That exact shape (a --json path returning before the
 * verdict) is why crm-audit.js silently exited 0 for its whole life.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const JSON_OUT = args.includes('--json');
const WARN_AS_ERROR = args.includes('--warn-as-error');

// --root lets the suite point this at a fixture tree. Without it there is no
// way to prove the gate can go red except by damaging the real site, which
// means in practice nobody proves it — and an unproven gate is how this repo
// shipped a check that exited 0 for its entire life.
const rootFlag = args.indexOf('--root');
const ROOT = rootFlag >= 0 && args[rootFlag + 1]
  ? path.resolve(args[rootFlag + 1])
  : path.join(__dirname, '..');
const DOCS = rootFlag >= 0 ? ROOT : path.join(ROOT, 'docs');

// ── Page discovery ──────────────────────────────────────────────────────
// docs/ IS the hosting root, so what is on disk is what ships. docs/pro is
// the CRM: private, behind auth, deliberately not a search surface.
//
// This exclusion earns its keep — pointing the gate at docs/pro reports 33
// errors (13 canonical, 8 h1, 12 meta-description) across vault, dashboard,
// sandbox, stripe-success, understand and friends. Those are NOT defects:
// the pages are noindexed by X-Robots-Tag *headers* in firebase.json, which
// a static reader of the HTML cannot see. Auditing them would be 33 false
// findings, so the directory stays skipped. See sitemapSurfaces() for the
// four pages inside it that are a genuine search surface.
const SKIP_DIRS = new Set(['pro', 'sites', 'admin', 'tools', 'dev']);

// A page that declares `noindex` is not a search surface, so search criteria
// do not apply to it. This is a rule rather than a filename list on purpose:
// a list is where a real finding goes to hide, and it needs hand-maintenance
// every time a page is added. The page must SAY it is not indexed — which
// means the exemption is visible in the page itself, and a page that wants
// out of this audit has to actually tell Google the same thing.
function isNoIndex(html) {
  const tag = (html.match(/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*>/i) || [])[0];
  return !!tag && /noindex/i.test(tag);
}

// Google Search Console verification stubs are a fixed payload Google
// specifies byte-for-byte. Adding a title or viewport would break
// verification, so they are exempt by shape rather than by name.
const RX_VERIFICATION_STUB = /^docs\/google[0-9a-f]{16}\.html$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (dir === DOCS && SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// ── Sitemapped pages inside a skipped directory ─────────────────────────
// A whole-directory skip is the right call for the CRM app shells and the
// wrong call for the four pages in docs/sitemap-pro.xml: /pro, /pro/pricing,
// /pro/how-to and /pro/terms are canonical to themselves, carry no noindex
// signal of any kind, and /pro sits at priority 0.9. firebase.json's noindex
// rule enumerates the app pages one by one rather than globbing /pro/**
// precisely so these four stay indexable, and says so in its own comment.
// They were nonetheless invisible to this gate — so when #1479 added a
// second JSON-LD block (a FAQPage) to /pro, it shipped with no validation at
// all, on the one check whose whole point is that a typo there is silent.
//
// The covered set is DERIVED, not listed. A <loc> in a sitemap IS the claim
// "this is a search surface" — the same claim isNoIndex() reads in reverse —
// so a page added to sitemap-pro.xml is audited from that moment, and this
// file needs no edit. A filename allowlist here would be exactly the "list
// where a real finding goes to hide" that the noindex rule above refuses to
// be. Sitemaps are read from DOCS, so a --root fixture tree without one
// simply gets nothing, which is what a fixture tree should get.
function sitemapSurfaces() {
  const out = [];
  let maps = [];
  try {
    maps = fs.readdirSync(DOCS).filter((f) => /^sitemap.*\.xml$/i.test(f));
  } catch (e) {
    return out;
  }
  const hosting = hostingSources();
  for (const m of maps.sort()) {
    const xml = fs.readFileSync(path.join(DOCS, m), 'utf8');
    for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      let pathname;
      try {
        pathname = new URL(match[1]).pathname;
      } catch (e) {
        // A <loc> that is not an absolute URL. sitemap.xml is generated by
        // build-sitemap.js, but sitemap-pro.xml is hand-maintained and no
        // script writes or validates it — so nothing else owns this case.
        // Reported rather than skipped, because a silently-dropped <loc> is
        // the failure this whole function exists to end.
        out.push({ loc: match[1], sitemap: m, file: null, malformed: true, candidates: [] });
        continue;
      }
      const trimmed = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!trimmed) continue; // the homepage, already in the walk
      // Only pages the walk could not have reached. Everything else is
      // already audited, and adding it twice would double every finding.
      if (!SKIP_DIRS.has(trimmed.split('/')[0])) continue;
      // cleanUrls: /pro/pricing is served by pricing.html OR pricing/index.html.
      const candidates = [`${trimmed}.html`, `${trimmed}/index.html`];
      const hit = candidates.find((c) => fs.existsSync(path.join(DOCS, c)));
      // No file on disk does NOT mean no page. firebase.json serves 21
      // redirects and 16 rewrites, six of them under /pro — /pro/landing is a
      // 301 and /pro/account-erasure is a Cloud Function. Calling one of those
      // an orphan would fail the build on a URL that resolves perfectly well
      // in production, so hosting config decides before we cry 404.
      const served = !hit && hosting.some((rx) => rx.test(pathname));
      if (served) continue;
      out.push({ loc: match[1], sitemap: m, file: hit || null, candidates });
    }
  }
  return out;
}

// firebase.json is the source of truth for what a URL resolves to, and it is
// read at runtime so hosting changes cannot desync this gate — the same
// posture scripts/check-site-integrity.js takes. The glob compiler is a
// deliberate second copy rather than a shared import: these gates are
// standalone and dependency-free on purpose ("adding a parser dependency to a
// gate is how gates stop running"), and check-site-integrity.js exports
// nothing and runs its full audit on require.
function hostingSources() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  } catch (e) {
    return []; // no hosting config (a --root fixture tree); disk is the only truth
  }
  const hosting = Array.isArray(cfg.hosting) ? cfg.hosting[0] || {} : cfg.hosting || {};
  const sources = []
    .concat(Array.isArray(hosting.redirects) ? hosting.redirects : [])
    .concat(Array.isArray(hosting.rewrites) ? hosting.rewrites : [])
    .map((r) => r && r.source)
    .filter((s) => typeof s === 'string');
  // Firebase glob semantics: `**` crosses slashes, `*` does not.
  return sources.map((source) => {
    let re = '';
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '*') {
        if (source[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
      } else if ('\\^$.|?+()[]{}'.includes(c)) {
        re += '\\' + c;
      } else {
        re += c;
      }
    }
    return new RegExp('^' + re + '$');
  });
}

// ── Tiny, dependency-free HTML probes ───────────────────────────────────
// Deliberately regex, not a DOM parser: this repo ships hand-authored HTML
// with a strict CSP and no build step, and adding a parser dependency to a
// pre-push gate is a cost the gate does not earn.
const rxTitle = /<title[^>]*>([\s\S]*?)<\/title>/i;
// `<h1>` or `<h1 ...>` — and NOT <h1x. Written as an optional whitespace-led
// attribute group because the obvious `[\b]` spelling is a character class
// containing BACKSPACE, not a word boundary: it silently matched nothing and
// reported "no <h1>" on pages that plainly have one. Caught by fixture F2.
const rxH1 = /<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>/gi;
const rxLdJson = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const rxImg = /<img\b[^>]*>/gi;
const rxLinkStylesheet = /<link\b[^>]*>/gi;

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'))
    || tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i'));
  return m ? m[1] : null;
}

function metaContent(html, nameOrProp, value) {
  const re = new RegExp(
    '<meta\\b[^>]*' + nameOrProp + '\\s*=\\s*["\']' + value + '["\'][^>]*>',
    'i',
  );
  const tag = (html.match(re) || [])[0];
  return tag ? attr(tag, 'content') : null;
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

// Length checks must count what a SEARCHER sees, not what the file stores.
// A description written with an apostrophe carries `&#39;` — five bytes for
// one rendered character — so measuring the raw attribute over-counts by four
// per entity and invents truncation warnings for descriptions that are
// comfortably in range. Six of this gate's first nine "too long" findings
// were this bug, not real. (Fixture F19.)
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', trade: '™', reg: '®', copy: '©', rarr: '→',
  larr: '←', middot: '·', times: '×', bull: '•', deg: '°',
};
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED_ENTITIES[n.toLowerCase()] !== undefined
      ? NAMED_ENTITIES[n.toLowerCase()] : m));
}

// ── FAQPage questions must be on the page ───────────────────────────────
// Google's FAQ structured-data policy requires every question and answer in
// the markup to be visible on the page, and AI answer engines cross-check the
// same way. The 2026-09-27 audit found 84 of 753 questions across 25 public
// pages that existed ONLY in JSON-LD — some carrying figures the article body
// contradicted. Nothing caught it because the parse check above only asks
// whether the block is valid JSON, not whether it is true of the page.
//
// "Visible" means: present in the text left after dropping comments, script,
// style, template and noscript, with tags removed, entities decoded, curly
// quotes straightened, case folded and ALL whitespace removed. Whitespace is
// dropped entirely rather than collapsed because a tag between words and
// punctuation (`<a>UHDZ</a>.`) becomes a space on one side and not the other.
// A question inside a collapsed accordion still counts — it is in the DOM,
// which is what the policy asks for. Questions only: answers legitimately
// carry links and emphasis the plain-text schema copy cannot, and are
// reviewed by hand when a page is fixed. (Fixtures F20/F21.)
function squashText(s) {
  return decodeEntities(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function visibleText(html) {
  return squashText(html
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function countFaqPages(node) {
  if (Array.isArray(node)) return node.reduce((n, x) => n + countFaqPages(x), 0);
  if (!node || typeof node !== 'object') return 0;
  const types = [].concat(node['@type'] || []);
  return (types.includes('FAQPage') ? 1 : 0) + (node['@graph'] ? countFaqPages(node['@graph']) : 0);
}

function faqQuestions(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => faqQuestions(n, out));
    return out;
  }
  const types = [].concat(node['@type'] || []);
  if (types.includes('FAQPage')) {
    for (const q of [].concat(node.mainEntity || [])) {
      if (q && typeof q.name === 'string' && q.name.trim()) out.push(q.name);
    }
  }
  if (node['@graph']) faqQuestions(node['@graph'], out);
  return out;
}

// TEMPORARY. These two posts are being rewritten in a separate lane
// (2026-09-27); their FAQ schema still names questions the body does not
// show. Being rewritten — remove when the rewrite lands. Exact paths, never
// a glob: a pattern here is the "list where a real finding goes to hide"
// that isNoIndex() above refuses to be. An entry that no longer fails is
// reported as a WARN so the list cannot quietly outlive its reason.
const FAQ_VISIBLE_ALLOWLIST = new Set([
  'docs/blog/can-i-keep-insurance-check-not-fix-roof.html',
  'docs/blog/what-to-expect-roof-insurance-adjuster-visit.html',
]);
const faqAllowlistHit = new Set();

// ── The audit ───────────────────────────────────────────────────────────
const findings = [];
function add(level, file, check, detail) {
  findings.push({ level, file, check, detail });
}

// Pages the walk reached, plus the sitemapped ones it was told to skip.
const surfaces = sitemapSurfaces();
const sitemapped = new Set();
for (const s of surfaces) {
  if (!s.file) {
    const where = path.relative(ROOT, path.join(DOCS, s.sitemap)).replace(/\\/g, '/');
    if (s.malformed) {
      // Not a URL at all, so it can never resolve for a crawler either.
      add('ERROR', where, 'sitemap-malformed-loc',
        `${s.loc} is not an absolute URL, so no crawler can resolve it`);
      continue;
    }
    // A <loc> with no page behind it is a 404 handed to Google in a document
    // whose entire purpose is to promise the URL resolves. Objectively
    // broken, mechanically decidable — an ERROR by this file's own rules.
    // Redirect- and rewrite-served URLs never reach here; hostingSources()
    // resolves them first.
    add('ERROR', where, 'sitemap-orphan',
      `${s.loc} is listed but no page ships for it (looked for ${s.candidates.join(', ')}), and firebase.json has no redirect or rewrite serving it`);
    continue;
  }
  sitemapped.add(path.join(DOCS, s.file));
}

let skippedNoIndex = 0;
const pages = [...new Set([...walk(DOCS), ...sitemapped])].sort().filter((abs) => {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  if (RX_VERIFICATION_STUB.test(rel)) return false;
  if (isNoIndex(fs.readFileSync(abs, 'utf8'))) {
    // A sitemapped page that also declares noindex is telling Google two
    // opposite things. Skipping it quietly would let the contradiction hide
    // behind the exemption, so it is reported and still audited.
    if (sitemapped.has(abs)) {
      add('ERROR', rel, 'sitemap-noindex',
        'listed in a sitemap but declares <meta robots noindex> — contradictory signals');
      return true;
    }
    skippedNoIndex++;
    return false;
  }
  return true;
});

// Hero-format findings are collected per IMAGE, not per page: the site logo
// is eager on all 227 pages, and reporting it 227 times buries everything
// else. Only images big enough to matter at LCP are worth a warning at all —
// a 3.6 KB badge converted to WebP saves nothing anyone can measure.
const HERO_MIN_BYTES = 30 * 1024;
const heroRasters = new Map(); // src -> { bytes, pages:Set }
const misnamedImages = new Map(); // src -> { real, pages:Set }

// Read the actual encoded format from the file's magic bytes rather than
// trusting the extension. docs/assets/gaf-pivot-boot/pivot-boot-hero.jpg is
// a real WebP carrying a .jpg name — an extension-only check calls that an
// unoptimised hero and demands a conversion that would make it BIGGER. It is
// also the exact mistake the vendor audit made in the other direction, so
// this gate should not repeat it.
function sniffImageFormat(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.slice(0, 6).toString('ascii').startsWith('GIF8')) return 'gif';
    return 'unknown';
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

for (const abs of pages) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const raw = fs.readFileSync(abs, 'utf8');
  const html = stripComments(raw);

  // -- title ------------------------------------------------------------
  const titleRaw = (html.match(rxTitle) || [])[1];
  const title = titleRaw ? decodeEntities(titleRaw).replace(/\s+/g, ' ').trim() : '';
  // The 50-60 band audit tools score against is Google's SERP pixel-width
  // guidance, not a rule — and 148 pages here sit outside it while reading
  // perfectly well in a result. Warn only where it actually costs something:
  // a title long enough to be truncated mid-phrase, or short enough to be
  // carrying no information. Anything between is the author's call.
  if (!title) add('ERROR', rel, 'title', 'no <title> tag, or it is empty');
  else if (title.length > 65) {
    add('WARN', rel, 'title-length', `${title.length} chars — will truncate in results: "${title}"`);
  } else if (title.length < 25) {
    add('WARN', rel, 'title-length', `${title.length} chars — too thin to rank: "${title}"`);
  }

  // -- meta description --------------------------------------------------
  const descRaw = metaContent(html, 'name', 'description');
  const desc = descRaw === null ? null : decodeEntities(descRaw);
  if (!desc || !desc.trim()) add('ERROR', rel, 'meta-description', 'missing meta description');
  else if (desc.length < 120 || desc.length > 160) {
    add('WARN', rel, 'meta-description-length', `${desc.length} chars (want 120-160)`);
  }

  // -- h1 ----------------------------------------------------------------
  const h1s = html.match(rxH1) || [];
  if (h1s.length === 0) add('ERROR', rel, 'h1', 'no <h1> on the page');
  else if (h1s.length > 1) add('ERROR', rel, 'h1', `${h1s.length} <h1> tags (want exactly 1)`);

  // -- canonical ---------------------------------------------------------
  const links = html.match(rxLinkStylesheet) || [];
  const canonical = links.find((l) => /rel\s*=\s*["']canonical["']/i.test(l));
  if (!canonical) add('ERROR', rel, 'canonical', 'no rel=canonical');
  else if (!attr(canonical, 'href')) add('ERROR', rel, 'canonical', 'rel=canonical has no href');

  // -- lang + viewport ---------------------------------------------------
  if (!/<html\b[^>]*\blang\s*=/i.test(html)) add('ERROR', rel, 'lang', '<html> has no lang attribute');
  if (!metaContent(html, 'name', 'viewport')) add('ERROR', rel, 'viewport', 'no viewport meta');

  // -- structured data ---------------------------------------------------
  // Parse every block. An unparseable block is an ERROR: search engines and
  // LLMs silently discard it, so a typo here is invisible damage — exactly
  // the failure mode this whole file exists to catch.
  const blocks = [...html.matchAll(rxLdJson)].map((m) => m[1]);
  if (blocks.length === 0) {
    add('WARN', rel, 'structured-data', 'no JSON-LD on the page');
  } else {
    const questions = [];
    let faqPages = 0;
    blocks.forEach((b, i) => {
      try {
        const parsed = JSON.parse(b);
        faqQuestions(parsed, questions);
        faqPages += countFaqPages(parsed);
      } catch (e) {
        add('ERROR', rel, 'structured-data', `JSON-LD block ${i + 1} does not parse: ${e.message}`);
      }
    });
    // One FAQPage per page: Google's Rich Results report flags a second one
    // as "Duplicate field 'FAQPage'" and can drop both. Found 2026-09-27 on
    // the Covington + Cincinnati area pages (generated TOWNFAQ block + an
    // older hand-written one).
    if (faqPages > 1) {
      add('ERROR', rel, 'faq-single',
        `${faqPages} FAQPage nodes on one page — merge them into a single FAQPage`);
    }
    if (questions.length) {
      const shown = visibleText(html);
      for (const q of questions) {
        if (shown.includes(squashText(q))) continue;
        if (FAQ_VISIBLE_ALLOWLIST.has(rel)) { faqAllowlistHit.add(rel); continue; }
        add('ERROR', rel, 'faq-visible',
          `FAQPage question is not in the page's visible text (render it, or remove it from the schema): "${q}"`);
      }
    }
  }

  // -- Open Graph --------------------------------------------------------
  for (const p of ['og:title', 'og:description', 'og:image']) {
    if (!metaContent(html, 'property', p)) add('WARN', rel, 'open-graph', `missing ${p}`);
  }

  // -- images ------------------------------------------------------------
  const imgs = html.match(rxImg) || [];
  imgs.forEach((tag) => {
    const src = attr(tag, 'src') || attr(tag, 'data-src') || '(no src)';
    if (!/\balt\s*=/i.test(tag)) {
      add('ERROR', rel, 'img-alt', `<img> with no alt attribute: ${src}`);
    }
  });

  // -- hero raster with no WebP sibling ----------------------------------
  // Only eager (non-lazy) images matter here: those are the render-path
  // candidates. A lazy below-the-fold JPG costs nothing at LCP.
  imgs.forEach((tag) => {
    if (/loading\s*=\s*["']lazy["']/i.test(tag)) return;
    const src = attr(tag, 'src');
    if (!src || !/^\/.*\.(jpe?g|png)$/i.test(src)) return;
    const abs = path.join(DOCS, src.replace(/^\//, ''));
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch (e) { return; }

    // Already a modern format wearing the wrong extension: nothing to
    // convert, but the name is a trap for the next person (and for Hosting's
    // Content-Type, which is set from the extension).
    const real = sniffImageFormat(abs);
    if (real === 'webp') {
      if (!misnamedImages.has(src)) misnamedImages.set(src, { real, pages: new Set() });
      misnamedImages.get(src).pages.add(rel);
      return;
    }

    const webp = src.replace(/\.(jpe?g|png)$/i, '.webp');
    if (fs.existsSync(path.join(DOCS, webp.replace(/^\//, '')))) return;
    if (bytes < HERO_MIN_BYTES) return;
    if (!heroRasters.has(src)) heroRasters.set(src, { bytes, pages: new Set() });
    heroRasters.get(src).pages.add(rel);
  });
}

// A temporary exemption that no longer exempts anything is stale — say so,
// so it is removed with the rewrite instead of lingering as a blind spot.
// Only for a live-site run: a --root fixture tree never contains these paths.
if (rootFlag < 0) {
  for (const rel of FAQ_VISIBLE_ALLOWLIST) {
    if (!faqAllowlistHit.has(rel)) {
      add('WARN', rel, 'faq-visible-allowlist',
        'listed in FAQ_VISIBLE_ALLOWLIST but every FAQ question is now visible (or the page is gone) — remove the entry');
    }
  }
}

// Extension lies about the real encoding. Firebase Hosting sets Content-Type
// from the extension, so this ships WebP bytes labelled image/jpeg.
for (const [src, info] of misnamedImages) {
  const n = info.pages.size;
  add('WARN', [...info.pages][0], 'image-extension',
    `${src} is really ${info.real.toUpperCase()} — served with the wrong Content-Type`
    + (n > 1 ? ` (on ${n} pages)` : ''));
}

// One finding per oversized image, naming how many pages carry it.
for (const [src, info] of [...heroRasters.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  const n = info.pages.size;
  add('WARN', [...info.pages][0], 'hero-format',
    `eager ${Math.round(info.bytes / 1024)} KB raster with no .webp sibling: ${src}`
    + (n > 1 ? ` (on ${n} pages)` : ''));
}

// ── Report ──────────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.level === 'ERROR');
const warns = findings.filter((f) => f.level === 'WARN');

// Verdict computed once, before any output branch, so no output mode can
// return past it.
const failed = errors.length > 0 || (WARN_AS_ERROR && warns.length > 0);

if (JSON_OUT) {
  console.log(JSON.stringify({
    pages: pages.length,
    errors: errors.length,
    warnings: warns.length,
    failed,
    findings,
  }, null, 2));
} else {
  const byCheck = {};
  for (const f of findings) {
    const k = `${f.level}:${f.check}`;
    byCheck[k] = (byCheck[k] || 0) + 1;
  }

  console.log(`seo-surface: ${pages.length} public pages audited`
    + (skippedNoIndex ? ` (${skippedNoIndex} skipped — declared noindex)` : ''));
  console.log('─'.repeat(64));

  if (!QUIET) {
    for (const f of errors) console.log(`  ERROR  ${f.file} — ${f.check}: ${f.detail}`);
    if (errors.length && warns.length) console.log('');
    for (const f of warns) console.log(`  warn   ${f.file} — ${f.check}: ${f.detail}`);
    if (findings.length) console.log('');
  } else {
    for (const f of errors) console.log(`  ERROR  ${f.file} — ${f.check}: ${f.detail}`);
    if (errors.length) console.log('');
  }

  console.log('Summary by check:');
  for (const k of Object.keys(byCheck).sort()) console.log(`  ${String(byCheck[k]).padStart(5)}  ${k}`);
  console.log('');
  console.log(`${errors.length} error(s), ${warns.length} warning(s) across ${pages.length} pages`);
}

// A page count of zero means the walk found nothing — a broken invocation,
// not a clean site. Reporting success over an audit of nothing is the second
// way crm-audit.js used to pass.
if (pages.length === 0) {
  console.error('seo-surface: matched ZERO pages — refusing to report success over an empty audit.');
  process.exit(2);
}

process.exit(failed ? 1 : 0);
