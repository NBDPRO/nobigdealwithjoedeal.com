#!/usr/bin/env node
/**
 * scripts/add-ga4-tag.js — put the GA4 tag on every public landing page.
 *
 * WHY (2026-09-04)
 * ────────────────
 * The homepage, /estimate, /about, /our-work and the storm funnels carry the
 * GA4 loader; the 164 service and area landing pages under docs/services/ and
 * docs/areas/ — the pages that earn organic leads — carried NO analytics tag
 * at all (STABILITY-AUDIT-2026-09-04). Not "missing at conversion time": the
 * tag was never loaded, so every lead those pages produced was invisible to
 * analytics. Same for /careers, /partners and /storm-alerts.
 *
 * WHAT
 * ────
 * Inserts, immediately before </head>, the exact two lines index.html uses:
 *   <script async src="https://www.googletagmanager.com/gtag/js?id=G-8PG7N9Q3DL"></script>
 *   <script defer src="/assets/js/inline/2a90205f1b.js"></script>
 * The second is the @generated external init (dataLayer + gtag('config')) —
 * strict CSP forbids inline scripts, and both hosts are already in
 * script-src-elem / connect-src on the `**` rule. Placed LAST in <head> so
 * the async fetch queues behind the LCP hero and fonts (the reason index.html
 * moved it below the preloads on 2026-08-07).
 *
 * Idempotent: a page already carrying a gtag loader is left alone. Preserves
 * each file's line endings. `--check` exits 1 listing pages in scope that lack
 * the tag (tests/ga4-landing-coverage.test.js runs it); `--list` prints scope.
 *
 * Usage:  node scripts/add-ga4-tag.js            # apply
 *         node scripts/add-ga4-tag.js --check    # CI gate, no writes
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const MEASUREMENT_ID = 'G-8PG7N9Q3DL';
const INIT_SCRIPT = '/assets/js/inline/2a90205f1b.js';
// 2026-11-04 (speed audit): the page no longer fetches gtag.js itself; ga-loader.js fetches it on first interaction
// or 3.5 s after load. The gtag URL rides in data-gtag so HAS_LOADER still finds the property on the page.
const LOADER_LINE = `<script defer src="/assets/js/ga-loader.js" data-gtag="https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}"></script>`;
const INIT_LINE = `<script defer src="${INIT_SCRIPT}"></script>`;

// Directories whose every .html page is a public landing page, plus the
// hand-picked top-level public pages that had no tag. Deliberately NOT in
// scope: 404.html / offline.html (no visitors to attribute), the Google
// site-verification file, /pro/** (the CRM), /admin/**, /dev/**, /sites/**
// (tenant microsites — a tenant's traffic is not NBD's to measure).
const SCOPE_DIRS = ['services', 'areas'];
const SCOPE_FILES = ['careers.html', 'partners.html', 'storm-alerts.html'];

const HAS_LOADER = /googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+/;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function scopePages() {
  const pages = [];
  for (const d of SCOPE_DIRS) {
    const abs = path.join(DOCS, d);
    if (fs.existsSync(abs)) walk(abs, pages);
  }
  for (const f of SCOPE_FILES) {
    const abs = path.join(DOCS, f);
    if (fs.existsSync(abs)) pages.push(abs);
  }
  return pages.sort();
}

/**
 * Return the page with the two lines inserted before </head>, or null when
 * the page already has a loader or has no single </head>. Pure — exported for
 * the test.
 */
function addTag(html) {
  if (HAS_LOADER.test(html)) return null;
  const idx = html.indexOf('</head>');
  if (idx < 0 || html.indexOf('</head>', idx + 1) >= 0) return null;
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  return html.slice(0, idx) + LOADER_LINE + eol + INIT_LINE + eol + html.slice(idx);
}

function main(argv) {
  const check = argv.includes('--check');
  const list = argv.includes('--list');
  const pages = scopePages();
  if (list) { pages.forEach((p) => console.log(path.relative(ROOT, p))); return 0; }

  const initAbs = path.join(DOCS, INIT_SCRIPT.replace(/^\//, ''));
  if (!fs.existsSync(initAbs) || !fs.readFileSync(initAbs, 'utf8').includes(MEASUREMENT_ID)) {
    console.error(`add-ga4-tag: init script ${INIT_SCRIPT} missing or does not configure ${MEASUREMENT_ID}`);
    return 1;
  }

  const missing = [];
  const malformed = [];
  let written = 0;
  for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    if (HAS_LOADER.test(html)) continue;
    const next = addTag(html);
    if (next == null) { malformed.push(path.relative(ROOT, p)); continue; }
    missing.push(path.relative(ROOT, p));
    if (!check) { fs.writeFileSync(p, next); written++; }
  }

  if (malformed.length) {
    console.error(`add-ga4-tag: ${malformed.length} page(s) have no single </head> — fix by hand:\n  ${malformed.join('\n  ')}`);
  }
  if (check) {
    if (missing.length || malformed.length) {
      console.error(`add-ga4-tag --check: ${missing.length} of ${pages.length} in-scope page(s) lack the GA4 tag:\n  ${missing.join('\n  ')}`);
      return 1;
    }
    console.log(`add-ga4-tag --check: all ${pages.length} in-scope pages carry the GA4 tag.`);
    return 0;
  }
  console.log(`add-ga4-tag: ${written} page(s) tagged, ${pages.length - written - malformed.length} already had it, ${malformed.length} malformed.`);
  return malformed.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { addTag, scopePages, MEASUREMENT_ID, INIT_SCRIPT, LOADER_LINE, INIT_LINE, SCOPE_DIRS, SCOPE_FILES, HAS_LOADER };
