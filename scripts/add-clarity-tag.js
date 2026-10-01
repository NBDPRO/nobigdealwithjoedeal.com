#!/usr/bin/env node
/**
 * scripts/add-clarity-tag.js — put the Microsoft Clarity loader on every
 * public page that already carries the GA4 tag (2026-10-01).
 *
 * Scope = every docs/**.html with the GA4 loader, EXCEPT /pro/**, /admin/**,
 * /dev/** and /sites/** (the CRM, homeowner portal and tenant microsites must
 * never be session-recorded). Same scope rule as GA4 plus that exclusion, so
 * a page gains Clarity exactly when it gains analytics.
 *
 * Inserts one line right after the GA4 init line (or before </head> if a page
 * has the loader but a different init):
 *   <script defer src="/assets/js/clarity-loader.js"></script>
 * The loader is inert until its PROJECT_ID is set; see clarity-loader.js.
 *
 * Idempotent; preserves each file's line endings.
 * Usage:  node scripts/add-clarity-tag.js          # apply
 *         node scripts/add-clarity-tag.js --check  # CI gate, no writes
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const LINE = '<script defer src="/assets/js/clarity-loader.js"></script>';
const HAS_GA = /googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+/;
const HAS_CLARITY = /\/assets\/js\/clarity-loader\.js/;
const GA_INIT = '<script defer src="/assets/js/inline/2a90205f1b.js"></script>';
const EXCLUDED_DIRS = ['pro', 'admin', 'dev', 'sites'];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (dir === DOCS && EXCLUDED_DIRS.includes(ent.name)) continue;
      walk(p, out);
    } else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function scopePages() {
  return walk(DOCS).filter((p) => HAS_GA.test(fs.readFileSync(p, 'utf8'))).sort();
}

/** The page with the loader line added, or null if it has it already / can't place it. */
function addTag(html) {
  if (HAS_CLARITY.test(html)) return null;
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const at = html.indexOf(GA_INIT);
  if (at >= 0 && html.indexOf(GA_INIT, at + 1) < 0) {
    const end = at + GA_INIT.length;
    return html.slice(0, end) + eol + LINE + html.slice(end);
  }
  const head = html.indexOf('</head>');
  if (head < 0 || html.indexOf('</head>', head + 1) >= 0) return null;
  return html.slice(0, head) + LINE + eol + html.slice(head);
}

function main(argv) {
  const check = argv.includes('--check');
  const pages = scopePages();
  const missing = [], malformed = [];
  let written = 0;
  for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    if (HAS_CLARITY.test(html)) continue;
    const next = addTag(html);
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    if (next == null) { malformed.push(rel); continue; }
    missing.push(rel);
    if (!check) { fs.writeFileSync(p, next); written++; }
  }
  // The loader must never sit on an excluded page, whatever put it there.
  const leaked = [];
  for (const d of EXCLUDED_DIRS) {
    const abs = path.join(DOCS, d);
    if (!fs.existsSync(abs)) continue;
    for (const p of walk(abs)) if (HAS_CLARITY.test(fs.readFileSync(p, 'utf8'))) leaked.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
  if (leaked.length) console.error(`add-clarity-tag: Clarity loader on excluded page(s) — remove it:\n  ${leaked.join('\n  ')}`);
  if (malformed.length) console.error(`add-clarity-tag: ${malformed.length} page(s) have no single place for the tag:\n  ${malformed.join('\n  ')}`);
  if (check) {
    if (missing.length || malformed.length || leaked.length) {
      if (missing.length) console.error(`add-clarity-tag --check: ${missing.length} of ${pages.length} page(s) lack the Clarity loader (run node scripts/add-clarity-tag.js):\n  ${missing.join('\n  ')}`);
      return 1;
    }
    console.log(`add-clarity-tag --check: all ${pages.length} public analytics pages carry the Clarity loader; none under /${EXCLUDED_DIRS.join(', /')}.`);
    return 0;
  }
  console.log(`add-clarity-tag: ${written} page(s) tagged, ${pages.length - written - malformed.length} already had it, ${malformed.length} malformed.`);
  return (malformed.length || leaked.length) ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { addTag, scopePages, LINE, EXCLUDED_DIRS, HAS_CLARITY };
