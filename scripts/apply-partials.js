#!/usr/bin/env node
/**
 * apply-partials.js — render site-src/partials/*.html into the marked regions
 * of the checked-in pages under docs/.
 *
 * WHY THIS EXISTS
 * docs/ IS the hosting root: Firebase serves these files as-authored, and the
 * deploy workflow validates the tree it is about to ship. So the pages must
 * stay valid standalone HTML — there is no build output directory. But the
 * 200+ homeowner pages each hand-duplicate their own nav, footer and chrome,
 * and 23 of the scripts in this directory exist only to regex-patch that
 * duplication back into sync after it drifts. The "— Goshen, OH" footer bug
 * that shipped to 139 pages is exactly that class of failure.
 *
 * This is the generalisation of two mechanisms the repo already runs in
 * production: build-blog-index.mjs stamps generated HTML between
 * BLOG-STATIC-START/END markers in a committed page, and build-sitemap.js
 * dry-runs as a CI drift gate that exits 1 with a diff. Same shape, applied to
 * the duplicated chrome.
 *
 *   <!-- nbd:partial footer-standard crumb_city="Mason" ... -->
 *   ...generated, owned by this script, hand-edits are overwritten...
 *   <!-- /nbd:partial footer-standard -->
 *
 * Per-page values live as attributes on the opening marker rather than in a
 * side manifest: they travel with the file when a page is copied or renamed
 * (which is how the location pages are authored), and `grep -rl
 * 'crumb_city="Mason"' docs/` answers "which pages claim Mason" in one command.
 *
 * FAILURE MODE IS DELIBERATELY SAFE. A broken partial fails the drift gate
 * while the committed HTML still ships exactly as it is. That is the right
 * trade for a repo that deploys to production on merge.
 *
 * Usage:
 *   node scripts/apply-partials.js            # restamp drifted regions in place
 *   node scripts/apply-partials.js --check    # write nothing; exit 1 on drift
 *   node scripts/apply-partials.js --diff     # with --check, show the drift
 *
 * Exit codes: 0 clean / 1 drift (--check) / 2 fatal.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(REPO_ROOT, 'docs');
const PARTIALS_DIR = path.join(REPO_ROOT, 'site-src', 'partials');

const CHECK = process.argv.includes('--check');
const SHOW_DIFF = process.argv.includes('--diff');

// Mirrors check-site-integrity.js: these trees are the CRM/admin app and
// internal docs, not the marketing site this system governs.
const SCAN_EXCLUDED_TOP_DIRS = new Set(['pro', 'admin', 'dev']);

// name repeated in the closing marker so a mismatched pair is a hard error,
// and so `grep -c 'nbd:partial footer-standard'` is meaningful.
const REGION_RE =
  /([ \t]*)<!--\s*nbd:partial\s+([a-z0-9-]+)((?:\s+[a-z0-9_]+="[^"]*")*)\s*-->\r?\n([\s\S]*?)([ \t]*)<!--\s*\/nbd:partial\s+\2\s*-->/g;

const ATTR_RE = /([a-z0-9_]+)="([^"]*)"/g;

/**
 * Structural contracts. A partial that silently loses one of these ships a
 * page whose JS still runs but whose controls are dead — the exact
 * silent-failure class this repo has been bitten by. Assert at render time so
 * a bad partial edit fails loudly instead of 200 pages later.
 */
const REQUIRED_MARKUP = {
  // Beyond the ids, the desktop nav carries four structural contracts the
  // ids don't cover: nav-faq.js opens the Services dropdown only through
  // ul.nav-links > li.dropdown; the hamburger↔mobileNav controller tag lives
  // INSIDE <nav> (drop it and every mobile menu dies silently); that
  // controller animates the hamburger's three <span> children; and
  // nbd-nav.css carries the drawer's positioning contract, without which the
  // per-page inline copies take over and the drawer misaligns with the header
  // again (see the 2026-09-08 nav reliability audit).
  'nav-standard': ['id="mainNav"', 'id="navLinks"', 'id="hamburger"',
    'class="nav-links"', 'class="dropdown"',
    'href="/assets/css/nbd-nav.css"', 'src="/assets/js/nbd-nav.js"',
    '<span></span><span></span><span></span>'],
  'nav-blog': ['id="mainNav"', 'id="navLinks"',
    'class="nav-links"', 'class="dropdown"',
    'href="/assets/css/nbd-nav.css"', 'src="/assets/js/nbd-nav.js"'],
  'nav-tool': ['id="mainNav"',
    'href="/assets/css/nbd-nav.css"', 'src="/assets/js/nbd-nav.js"'],
  // The 7 brand microsites (LumaNail, Roofivent, GAF Pivot Boot, GAF Timberline,
  // TAMKO Impact-Resistant Shingles + the two promise pages) ran 4 divergent link sets before
  // 2026-08-19 — two of them dropped Pledge/Guarantee/Build entirely and pointed
  // "Services" at a leaf page. Same contracts as nav-standard minus the dropdown,
  // which this family does not have.
  'nav-microsite': ['id="mainNav"', 'id="navLinks"', 'id="hamburger"',
    'class="nav-links"',
    'href="/assets/css/nbd-nav.css"', 'src="/assets/js/nbd-nav.js"',
    '<span></span><span></span><span></span>'],
  'mobile-nav-standard': ['id="mobileNav"'],
  'mobile-nav-blog': ['id="mobileNav"'],
  'footer-standard': ['<footer>', '</footer>'],
  'footer-blog': ['<footer>', '</footer>'],
  'footer-area': ['<footer>', '</footer>'],
  'footer-extended': ['<footer>', '</footer>'],
  'footer-slim': ['<footer', '</footer>', 'tel:+18594207382', '/privacy'],
  // The ONE definition of the business, Joe and the WebSite (2026-09-27).
  // ~500 JSON-LD nodes across the site reference these three @ids; a partial
  // that drops one leaves every reference on every page dangling while each
  // page still parses, so check-seo-surface.js alone would stay green.
  'schema-entity': ['<script type="application/ld+json">',
    '"@id": "https://nobigdealwithjoedeal.com/#org"',
    '"@id": "https://nobigdealwithjoedeal.com/#joe"',
    '"@id": "https://nobigdealwithjoedeal.com/#website"'],
  // ('mobile-nav-hub' removed 2026-08-19 — it was a stale fork of
  //  mobile-nav-standard, 7 destinations short (/visualizer, /roof-score,
  //  /inspect, /free-tools, /services/the-nbd-build, /roofivent,
  //  /gaf-pivot-boot were unreachable from mobile chrome on the 15 pillar
  //  pages that used it) and with a hardcoded CTA that ignored cta_href.
  //  Those pages now carry mobile-nav-standard. See
  //  documentation/audit/DESIGN-CONSISTENCY-SWEEP-2026-08-19.md)
  // ('footer-hub' entry removed 2026-08-07 — no such partial exists in
  //  site-src/partials/ and no page carries the marker.)
};

let fatalCount = 0;
function fatal(msg) { console.error(`FATAL: ${msg}`); fatalCount++; }

function loadPartials() {
  if (!fs.existsSync(PARTIALS_DIR)) {
    console.error(`FATAL: ${path.relative(REPO_ROOT, PARTIALS_DIR)} does not exist`);
    process.exit(2);
  }
  const map = new Map();
  for (const name of fs.readdirSync(PARTIALS_DIR)) {
    if (!name.endsWith('.html')) continue;
    const key = name.replace(/\.html$/, '');
    let body = fs.readFileSync(path.join(PARTIALS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
    body = body.replace(/\n+$/, '');           // trailing blank lines are noise
    for (const needle of REQUIRED_MARKUP[key] || []) {
      if (!body.includes(needle)) {
        console.error(`FATAL: partial "${key}" is missing required markup ${needle} — runtime JS depends on it`);
        process.exit(2);
      }
    }
    map.set(key, body);
  }
  if (!map.size) { console.error('FATAL: no partials found'); process.exit(2); }
  return map;
}

function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === DOCS && SCAN_EXCLUDED_TOP_DIRS.has(entry.name)) continue;
      walkHtml(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** Render a partial, substituting {{key}} from the marker attributes. */
function render(name, body, attrs, where) {
  const used = new Set();
  const out = body.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in attrs)) {
      fatal(`${where}: partial "${name}" needs {{${key}}} but the marker does not set it`);
      return `{{${key}}}`;
    }
    used.add(key);
    return attrs[key];
  });
  // An attribute nothing consumes is almost always a typo in the marker, and a
  // silent typo here means a page quietly keeps stale content.
  for (const key of Object.keys(attrs)) {
    if (!used.has(key)) fatal(`${where}: marker sets ${key}="${attrs[key]}" but partial "${name}" has no {{${key}}}`);
  }
  return out;
}

function unifiedish(expected, actual, indent) {
  const e = expected.split('\n'), a = actual.split('\n');
  const lines = [];
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] === a[i]) continue;
    if (a[i] !== undefined) lines.push(`      - ${a[i].slice(0, 150)}`);
    if (e[i] !== undefined) lines.push(`      + ${e[i].slice(0, 150)}`);
    if (lines.length > 12) { lines.push('      … (truncated)'); break; }
  }
  return lines.join('\n');
}

function main() {
  const partials = loadPartials();
  const files = walkHtml(DOCS);

  const drifted = [];
  let regionCount = 0, fileCount = 0;

  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    // Prefilter matches the bare token, not '<!-- nbd:partial': a file whose
    // ONLY marker is an orphan CLOSER (<!-- /nbd:partial … -->) lacks the
    // opener substring and would skip the dangling-marker guard below.
    if (!before.includes('nbd:partial')) continue;
    fileCount++;

    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const localDrift = [];

    // EOL DISCIPLINE — the pages are CRLF. Render in LF, then emit with the
    // file's own line ending. Stamping LF into a CRLF file would rewrite every
    // line of the region and show as a whole-block change in every diff; and
    // comparing LF against CRLF would report permanent, unfixable "drift".
    const eol = before.includes('\r\n') ? '\r\n' : '\n';

    const after = before.replace(REGION_RE, (whole, indent, name, attrStr, current, closeIndent) => {
      regionCount++;
      const body = partials.get(name);
      if (body === undefined) {
        fatal(`${rel}: unknown partial "${name}" (no site-src/partials/${name}.html)`);
        return whole;
      }
      const attrs = {};
      let am;
      ATTR_RE.lastIndex = 0;
      while ((am = ATTR_RE.exec(attrStr))) attrs[am[1]] = am[2];

      const rendered = render(name, body, attrs, rel);
      // Canonical stamped form — deterministic bytes, so drift detection is a
      // string compare rather than a parse.
      const want = rendered.replace(/\n/g, eol) + eol;
      if (current !== want) localDrift.push({ name, want, have: current, indent });
      return `${indent}<!-- nbd:partial ${name}${attrStr} -->${eol}${want}${closeIndent}<!-- /nbd:partial ${name} -->`;
    });

    // DANGLING-MARKER GUARD — REGION_RE only matches complete opener+closer
    // pairs, so an unclosed opener (or an orphan closer, or a name-mismatched
    // pair) never enters the loop above: its region silently leaves governance
    // and --check stays green while the block rots as hand-editable text.
    // Any marker still present once the paired regions are removed is broken.
    const residue = before.replace(REGION_RE, '');
    const stray = residue.match(/<!--\s*\/?nbd:partial\b[^>]*-->/);
    if (stray) {
      fatal(`${rel}: dangling partial marker ${stray[0].trim()} — opener without closer, orphan closer, or name-mismatched pair; the region it should own is NOT governed`);
    }

    if (localDrift.length) drifted.push({ file, rel, regions: localDrift });
    if (!CHECK && after !== before) {
      const tmp = `${file}.tmp-partial`;
      fs.writeFileSync(tmp, after);
      fs.renameSync(tmp, file);
    }
  }

  if (fatalCount) process.exit(2);

  if (CHECK) {
    if (!drifted.length) {
      console.log(`apply-partials --check: ${regionCount} region(s) in ${fileCount} file(s) match site-src/partials — clean.`);
      process.exit(0);
    }
    for (const d of drifted) {
      for (const r of d.regions) {
        console.error(`✗ ${d.rel} — region "${r.name}" differs from the rendered partial`);
        if (SHOW_DIFF) console.error(unifiedish(r.want, r.have, r.indent));
      }
    }
    console.error(`
Regions between <!-- nbd:partial --> markers are GENERATED. To change one:
  site-wide change → edit site-src/partials/<name>.html
  per-page data    → edit the attributes in that page's opening marker
then run:  node scripts/apply-partials.js
and commit BOTH the partial and every restamped page.
(Add --diff to see the drift. Hand-edits inside a region are always
 overwritten; page-specific content belongs outside the markers.)`);
    process.exit(1);
  }

  if (!drifted.length) {
    console.log(`apply-partials: ${regionCount} region(s) in ${fileCount} file(s) already match — nothing to do.`);
  } else {
    console.log(`apply-partials: restamped ${drifted.reduce((n, d) => n + d.regions.length, 0)} region(s) in ${drifted.length} file(s); ${regionCount} region(s) checked across ${fileCount} file(s).`);
  }
  process.exit(0);
}

main();
