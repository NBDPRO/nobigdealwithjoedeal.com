#!/usr/bin/env node
/**
 * Static-site integrity checker for the homeowner site under docs/.
 *
 * Permanently gates the defect classes a manual QC sweep fixed by hand:
 *   1. Dead internal links   — <a href> pointing at paths nothing serves.
 *   2. 404'd assets          — src / poster / srcset / data-src / <link href>
 *                              / og:image / twitter:image / CSS url(/assets/…).
 *   3. Broken in-page anchors — href="#frag" (same page) and /path#frag
 *                              (cross page) whose id doesn't exist.
 *
 * Firebase Hosting semantics (firebase.json is the source of truth and is
 * read AT RUNTIME — redirect/rewrite sources are derived from its arrays,
 * never hardcoded, so config changes can't desync this checker):
 *   - cleanUrls: true  → /foo serves docs/foo.html
 *   - directory index  → /foo serves docs/foo/index.html
 *   - trailingSlash: false → /foo/ 301s to /foo, so both variants resolve
 *   - redirects[]      → their `source` paths resolve (and internal
 *                        `destination` paths are themselves verified)
 *   - rewrites[]       → their `source` paths/globs resolve (file targets
 *                        verified; function targets trusted to exist)
 *
 * Scope: docs/**\/*.html EXCLUDING the internal (non-homeowner) surfaces
 * docs/pro/** (CRM) and docs/admin/** — the same scope the manual sweep used
 * (documentation/qa/homeowner-sweep-2026-06-11/INVENTORY.md marks /admin/*
 * OUT-OF-SCOPE) — plus the Google site-verification stub. Excluded pages are
 * still valid LINK TARGETS; they just aren't scanned themselves.
 *
 * KNOWN DEFECT parked behind the admin exclusion (found 2026-06-11 while
 * building this checker): docs/admin/index.html line 13 loads its module via
 * relative src="js/pages/index-redirect.js". With trailingSlash:false the
 * page serves at the slashless clean URL /admin, so the browser resolves that
 * to /js/pages/index-redirect.js → 404 → /admin renders a blank page instead
 * of redirecting. Fix: make the src site-absolute
 * (/admin/js/pages/index-redirect.js). When admin is brought into scope,
 * delete the 'admin' entry from SCAN_EXCLUDED_TOP_DIRS below.
 *
 * External URLs are ignored EXCEPT absolute self-references to
 * https://nobigdealwithjoedeal.com/… which must resolve exactly like
 * site-absolute paths.
 *
 * Usage:
 *   node scripts/check-site-integrity.js           # full failure list + summary
 *   node scripts/check-site-integrity.js --quiet   # summary only
 *
 * Exit codes: 0 = clean, 1 = at least one failure, 2 = fatal (bad config).
 * Zero npm dependencies — Node 22 builtins only.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SELF_HOSTS = new Set(['nobigdealwithjoedeal.com', 'www.nobigdealwithjoedeal.com']);
const QUIET = process.argv.includes('--quiet');

/* ── firebase.json → redirect/rewrite sources (runtime, no hardcoding) ──── */

function loadHostingConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  } catch (e) {
    console.error(`FATAL: cannot read/parse firebase.json: ${e.message}`);
    process.exit(2);
  }
  const hosting = cfg.hosting || {};
  return {
    redirects: Array.isArray(hosting.redirects) ? hosting.redirects : [],
    rewrites: Array.isArray(hosting.rewrites) ? hosting.rewrites : [],
  };
}

/**
 * Compile a Firebase Hosting `source` glob (e.g. "/share/**", "/privacy")
 * into a RegExp over the URL path. `**` crosses slashes, `*` does not.
 */
function compileSourceGlob(source) {
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
}

const { redirects, rewrites } = loadHostingConfig();
const redirectRules = redirects.map((r) => ({
  rx: compileSourceGlob(r.source),
  destination: r.destination,
}));
const rewriteRules = rewrites.map((r) => ({ rx: compileSourceGlob(r.source) }));

/* ── filesystem path resolution (cleanUrls + directory index) ──────────── */

const fileCache = new Map();
function isFile(rel) {
  if (!fileCache.has(rel)) {
    let ok = false;
    try { ok = fs.statSync(path.join(DOCS, rel)).isFile(); } catch (_) { /* missing */ }
    fileCache.set(rel, ok);
  }
  return fileCache.get(rel);
}

/**
 * Resolve a site-absolute URL path ("/services/foo", "/assets/x.jpg") to a
 * docs/-relative file per Firebase semantics, or a rule marker.
 * Returns { kind: 'file', rel } | { kind: 'redirect', destination } |
 *         { kind: 'rewrite' } | null (unresolvable).
 */
function resolvePath(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch (_) { p = urlPath; }
  if (!p.startsWith('/')) return null;

  // trailingSlash:false — /foo/ 301s to /foo; check the canonical form too.
  const variants = p.length > 1 && p.endsWith('/') ? [p, p.slice(0, -1)] : [p];

  for (const v of variants) {
    const rel = v.replace(/^\/+/, '');
    if (rel !== '' && isFile(rel)) return { kind: 'file', rel };
    if (rel !== '' && isFile(rel + '.html')) return { kind: 'file', rel: rel + '.html' }; // cleanUrls
    const idx = rel === '' ? 'index.html' : rel + '/index.html';
    if (isFile(idx)) return { kind: 'file', rel: idx };
  }
  for (const v of variants) {
    const r = redirectRules.find((rule) => rule.rx.test(v));
    if (r) return { kind: 'redirect', destination: r.destination };
    if (rewriteRules.some((rule) => rule.rx.test(v))) return { kind: 'rewrite' };
  }
  return null;
}

/**
 * Follow internal redirects (bounded) until we land on a real file, so
 * cross-page anchor targets behind a redirect can still be id-checked.
 * Returns a docs/-relative file path or null.
 */
function resolveToFile(urlPath) {
  let current = urlPath;
  for (let hop = 0; hop < 5; hop++) {
    const res = resolvePath(current);
    if (!res) return null;
    if (res.kind === 'file') return res.rel;
    if (res.kind === 'redirect' && typeof res.destination === 'string' && res.destination.startsWith('/')) {
      current = res.destination.split(/[?#]/)[0];
      continue;
    }
    return null; // external redirect or function/file rewrite — nothing to anchor-check
  }
  return null;
}

/* ── page discovery ─────────────────────────────────────────────────────── */

// Internal (non-homeowner) surfaces — not scanned, still valid link targets.
// 'pro' = CRM; 'admin' = internal admin (see KNOWN DEFECT note in the header).
const SCAN_EXCLUDED_TOP_DIRS = new Set(['pro', 'admin']);

function walkHtml(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDED_TOP_DIRS.has(path.relative(DOCS, abs).split(path.sep)[0])) continue;
      walkHtml(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      if (/^google[0-9a-f]+\.html$/i.test(entry.name)) continue; // Google verification stub
      out.push(path.relative(DOCS, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/** The clean URL a docs/-relative HTML file is served at. */
function cleanUrlOf(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  if (rel.endsWith('.html')) return '/' + rel.slice(0, -'.html'.length);
  return '/' + rel;
}

/**
 * The URL a page is actually REACHED at — the base every relative reference in
 * it resolves against.
 *
 * cleanUrlOf() gives the URL Hosting would serve the file at, but redirects
 * outrank static files in Hosting priority: if some redirect's `source` matches
 * that URL, the URL 301s and never returns this page's HTML at all. The browser
 * lands on the destination, and THAT is the base the page's relative refs
 * resolve against.
 *
 * This is load-bearing for directory indexes. With trailingSlash:false,
 * docs/x/y/index.html serves at /x/y — whose base directory is /x/, one segment
 * shallower than the file actually lives. A relative "about.html" in it then
 * points at /x/about.html and 404s. Redirecting /x/y → /x/y/index restores the
 * correct base, and without this function the checker would keep resolving
 * against a URL that no longer serves the page. Added 2026-08-19 for the Oaks
 * microsite, which is deliberately relative-pathed so the folder stays portable
 * to the client's own host; it is the same defect class as the /admin
 * relative-src bug recorded in this file's header.
 */
function servedUrlOf(rel) {
  const clean = cleanUrlOf(rel);
  for (const { rx, destination } of redirectRules) {
    if (rx.test(clean) && typeof destination === 'string' && destination.startsWith('/')) {
      return destination;
    }
  }
  return clean;
}

/* ── HTML extraction (regex; no DOM lib) ────────────────────────────────── */

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'");
}

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i'));
  if (!m) return null;
  return decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
}

/** Extract every url(...) argument that targets /assets/ from CSS text. */
function cssAssetUrls(cssText) {
  const out = [];
  const rx = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^()"']*))\s*\)/gi;
  let m;
  while ((m = rx.exec(cssText)) !== null) {
    const u = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (u.startsWith('/assets/')) out.push(u);
  }
  return out;
}

/**
 * Collect every checkable reference from one page.
 * Returns [{ ref, why }] where `why` names the construct for error messages.
 */
function extractRefs(html) {
  const refs = [];
  const push = (ref, why) => { if (ref && ref.trim() !== '') refs.push({ ref: ref.trim(), why }); };

  const tagRx = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRx.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];

    if (tag === 'a') push(getAttr(attrs, 'href'), '<a href>');

    if (tag === 'link') {
      const rel = (getAttr(attrs, 'rel') || '').toLowerCase();
      if (!/\b(preconnect|dns-prefetch)\b/.test(rel)) push(getAttr(attrs, 'href'), `<link rel="${rel}">`);
    }

    if (tag === 'meta') {
      const key = ((getAttr(attrs, 'property') || getAttr(attrs, 'name')) || '').toLowerCase();
      if (key === 'og:image' || key === 'twitter:image') push(getAttr(attrs, 'content'), `<meta ${key}>`);
    }

    for (const attr of ['src', 'poster', 'data-src']) {
      push(getAttr(attrs, attr), `<${tag} ${attr}>`);
    }
    const srcset = getAttr(attrs, 'srcset');
    if (srcset) {
      for (const candidate of srcset.split(',')) {
        push(candidate.trim().split(/\s+/)[0], `<${tag} srcset>`);
      }
    }
    const styleAttr = getAttr(attrs, 'style');
    if (styleAttr) for (const u of cssAssetUrls(styleAttr)) push(u, 'style attribute url()');
  }

  const styleRx = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleRx.exec(html)) !== null) {
    for (const u of cssAssetUrls(m[1])) push(u, '<style> url()');
  }

  return refs;
}

/** Collect anchorable ids: id= on any tag, plus legacy <a name=>. */
function extractIds(html) {
  const ids = new Set();
  let m;
  const idRx = /<[a-zA-Z][^>]*?\sid\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/g;
  while ((m = idRx.exec(html)) !== null) ids.add(m[2] ?? m[3] ?? m[4]);
  const nameRx = /<a\b[^>]*?\sname\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  while ((m = nameRx.exec(html)) !== null) ids.add(m[2] ?? m[3] ?? m[4]);
  return ids;
}

/* ── main check ─────────────────────────────────────────────────────────── */

const SKIP_SCHEME = /^(javascript|mailto|tel|sms|data|blob):/i;
const GENERATED_AT_DEPLOY = /^\/pagefind\//;

const pages = walkHtml(DOCS, []).sort();
const pageHtml = new Map(pages.map((rel) => [rel, fs.readFileSync(path.join(DOCS, rel), 'utf8')]));
const pageIds = new Map();
function idsOf(rel) {
  if (!pageIds.has(rel)) {
    const html = pageHtml.get(rel) ?? fs.readFileSync(path.join(DOCS, rel), 'utf8');
    pageIds.set(rel, extractIds(html));
  }
  return pageIds.get(rel);
}

const failures = new Map(); // page rel → [messages]
function fail(pageRel, msg) {
  if (!failures.has(pageRel)) failures.set(pageRel, []);
  failures.get(pageRel).push(msg);
}

let refsChecked = 0;
let anchorsChecked = 0;

for (const rel of pages) {
  const html = pageHtml.get(rel);
  const base = new URL(servedUrlOf(rel), 'https://nobigdealwithjoedeal.com');

  for (const { ref, why } of extractRefs(html)) {
    if (SKIP_SCHEME.test(ref)) continue;

    let target;
    try { target = new URL(ref, base); } catch (_) {
      fail(rel, `${why} → unparseable URL: ${ref}`);
      continue;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (!SELF_HOSTS.has(target.hostname)) continue; // external — out of scope

    // Same-page pure-fragment link (href="#frag")
    if (ref.startsWith('#')) {
      const frag = ref.slice(1);
      anchorsChecked++;
      if (frag !== '' && frag !== 'top' && !idsOf(rel).has(frag)) {
        fail(rel, `${why} → missing in-page anchor: #${frag}`);
      }
      continue;
    }

    refsChecked++;
    const urlPath = target.pathname;
    // /pagefind/** (the site search index and its UI) is generated at deploy by
    // scripts/build-site-search.mjs and gitignored, so it is not in the tree.
    if (GENERATED_AT_DEPLOY.test(urlPath)) continue;
    const res = resolvePath(urlPath);
    if (!res) {
      fail(rel, `${why} → unresolvable target: ${ref} (path ${urlPath})`);
      continue;
    }

    // Cross-page anchor: the fragment must exist in the target page's ids.
    const frag = target.hash ? decodeURIComponent(target.hash.slice(1)) : '';
    if (frag !== '' && frag !== 'top') {
      const targetRel = resolveToFile(urlPath);
      if (targetRel && targetRel.endsWith('.html') && !SCAN_EXCLUDED_TOP_DIRS.has(targetRel.split('/')[0])) {
        anchorsChecked++;
        if (!idsOf(targetRel).has(frag)) {
          fail(rel, `${why} → anchor #${frag} not found in ${urlPath} (${targetRel})`);
        }
      }
    }
  }
}

// Config self-check: every internal redirect destination must itself resolve,
// so a redirect can never silently point into a 404.
for (const r of redirects) {
  if (typeof r.destination === 'string' && r.destination.startsWith('/')) {
    refsChecked++;
    if (!resolvePath(r.destination.split(/[?#]/)[0])) {
      fail('firebase.json', `redirect ${r.source} → unresolvable destination ${r.destination}`);
    }
  }
}

/* ── report ─────────────────────────────────────────────────────────────── */

const failureCount = [...failures.values()].reduce((n, list) => n + list.length, 0);

if (!QUIET && failureCount > 0) {
  for (const [pageRel, msgs] of [...failures.entries()].sort()) {
    console.log(`\n${pageRel === 'firebase.json' ? pageRel : 'docs/' + pageRel}`);
    for (const msg of msgs) console.log(`  FAIL  ${msg}`);
  }
  console.log('');
}

console.log(
  `site-integrity: ${pages.length} pages, ${refsChecked} internal refs, ` +
  `${anchorsChecked} anchors checked — ${failureCount} failure${failureCount === 1 ? '' : 's'}` +
  (failureCount === 0 ? ' (clean)' : ` across ${failures.size} page${failures.size === 1 ? '' : 's'}`)
);
if (failureCount > 0 && QUIET) {
  console.log('(re-run without --quiet for the per-page failure list)');
}
process.exit(failureCount > 0 ? 1 : 0);
