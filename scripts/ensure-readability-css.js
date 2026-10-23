#!/usr/bin/env node
/*
 * Keep the sitewide readability rules ("nbd-readability-v2": 16px root/body
 * floor, capped non-hero h2/h3, footer contrast, .ann-bar floor, wide-desktop
 * nav breathing room) in ONE shared stylesheet instead of per-page inline
 * copies.
 *
 * 2026-09-18 (inline-CSS dedup phase 2, slice 3b — WEEKLY_CADENCE.md backlog
 * item 10): the block that scripts/fix-typography-and-footer.js injected as
 * an inline <style> (186 in-scope byte-identical copies of 2,462 B; 446 KB
 * of HTML net of the link tags) moved to docs/assets/css/nbd-readability.css. Modelled on ensure-nav-css.js, with
 * ONE deliberate difference in the write path:
 *
 *   --write replaces the <style> with the <link> IN PLACE. It never removes
 *   the block and appends the link before </head> the way ensure-nav-css.js
 *   and ensure-icon-css.js do. On most pages this block sits BEFORE the
 *   nbd-mobile.css link, and several of its !important rules tie on
 *   specificity with nbd-mobile.css rules — source order decides who wins.
 *   Moving it after nbd-mobile.css flips those ties. Concrete case: at
 *   <=380px nbd-mobile.css's .ann-bar{font-size:.66rem} wins today; moved,
 *   the readability block's .72rem would win. That is the #1194 icon-cascade
 *   regression pattern (documentation/audit/ICON-CASCADE-REGRESSION-2026-08-17.md).
 *
 * Scope: docs/**, excluding pro/ (the CRM; pro/terms.html keeps its own
 * copy) and sites/ (tenant microsites — sites/free-guide has its own design
 * system), plus admin/assets/deploy/tools like ensure-nav-css.js.
 * docs/index.html carries a deliberate VARIANT under the same marker (no
 * .sc-body rule, adds .trim-mobile) — it does not match the canonical text
 * and is left inline, untouched and unflagged.
 *
 * Default run is assert-only (CI-wired; exit 1 listing offenders):
 *   - a byte-exact inline copy of the canonical block (a re-injection — run
 *     --write to migrate it), or
 *   - a page carrying BOTH the link and the marker (double-applied rules;
 *     fix by hand).
 * --write migrates every byte-exact inline copy to the link in place. It
 * does NOT add the link to pages that never had the block — unlike the nav
 * base, these rules are not a contract every page must carry.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const CSS_FILE = path.join(ROOT, 'assets', 'css', 'nbd-readability.css');

const MARKER = '/* nbd-readability-v2 */';
const LINK_HREF = '/assets/css/nbd-readability.css';
const LINK_TAG = `<link rel="stylesheet" href="${LINK_HREF}">`;
const EXCLUDED_TOP = new Set(['admin', 'pro', 'sites', 'assets', 'deploy', 'tools']);

// Must stay byte-identical to docs/assets/css/nbd-readability.css's body
// (minus its own file-header comment) — this is what --write matches to
// migrate a legacy inline block, and tests/marketing-polish-contract.test.js
// pins the stylesheet to it. Not derived from the CSS file at runtime so a
// drifted stylesheet cannot silently redefine what counts as canonical.
const CANONICAL_BODY = `/* Root + body floor: 16px + generous line-height */
html{font-size:16px}
body{font-size:1rem;line-height:1.65;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}

/* Body copy — override per-page shrinks on main content */
main p,section p,article p,.sec-desc,.hiw-body{font-size:1rem!important;line-height:1.7!important}
.sc-body{font-size:.97rem!important;line-height:1.65!important;color:#4b5563!important}

/* Non-hero heading caps — keep hero h1s untouched */
main h2,section h2,article h2{font-size:clamp(1.8rem,3vw,2.6rem)!important;line-height:1.1!important}
main h3,section h3,article h3{font-size:clamp(1.05rem,1.35vw,1.3rem)!important;line-height:1.3!important}

/* Footer readability + contrast */
footer .footer-desc,footer .footer-links a,footer .footer-col ul li a,footer p,footer li{font-size:.92rem!important;line-height:1.65!important}
footer .footer-desc{color:rgba(255,255,255,.82)!important}
footer .footer-col-title,footer h4,footer .label{font-size:.72rem!important;letter-spacing:.14em!important;text-transform:uppercase!important;color:rgba(255,255,255,.95)!important;font-weight:800!important;margin-bottom:14px!important}
footer .footer-bottom,footer .footer-bottom p,footer .footer-bottom a,footer .pro-door{font-size:.82rem!important;line-height:1.6!important}
footer .footer-bottom a{color:rgba(255,255,255,.7)!important}
footer .footer-bottom a:hover{color:#dd875f!important}
footer.foot,.review-footer{font-size:.9rem!important;padding:24px 5%!important;line-height:1.6!important}
footer.foot a,.review-footer a{color:#dd875f!important}

/* Announcement bar legibility floor */
.ann-bar{font-size:.8rem!important;letter-spacing:.04em!important}
@media(max-width:640px){.ann-bar{font-size:.72rem!important;padding:10px 14px!important;min-height:40px!important}}

/* Nav breathing room at TRULY wide desktop (>=1441). v3 nav-responsive-fix
   keeps a compact nav style in the 1025-1440 range; this block only
   loosens things up on big displays where there's room to breathe. */
@media(min-width:1441px){
  nav{padding-left:40px!important;padding-right:40px!important}
  nav .nav-logo{margin-right:28px!important}
  nav .nav-links{gap:22px!important}
  nav .nav-links > li > a{font-size:.78rem!important;letter-spacing:.07em!important}
}
@media(min-width:1600px){
  nav{padding-left:56px!important;padding-right:56px!important}
  nav .nav-links{gap:28px!important}
}`;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === ROOT && EXCLUDED_TOP.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

// The exact legacy <style> element (marker + canonical body), byte-exact
// modulo the file's own EOL style. The working tree is CRLF on Windows
// (core.autocrlf) and LF in git/CI, and an LF needle silently no-ops on a
// CRLF file — so the needle is always built with the file's own EOL. Matches
// the <style>…</style> span ONLY: the surrounding indentation and line break
// stay put, so the link lands at exactly the block's old position.
function exactBlockRegex(eol, flags) {
  const body = eol === '\n' ? CANONICAL_BODY : CANONICAL_BODY.split('\n').join(eol);
  const raw = '<style>' + eol + MARKER + eol + body + eol + '</style>';
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

function eolOf(src) {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

// Pure per-page transform, exported for tests. Returns
// { next, copies, hasLink, hasMarker, problem }.
function migrate(src) {
  const eol = eolOf(src);
  const copies = (src.match(exactBlockRegex(eol, 'g')) || []).length;
  const hasLink = src.includes(LINK_HREF);
  const hasMarker = src.includes(MARKER);
  let problem = null;
  if (hasLink && hasMarker) problem = 'carries BOTH the ' + LINK_HREF + ' link and the inline marker';
  else if (copies > 1) problem = copies + ' inline canonical copies';
  let next = src;
  if (!problem && copies === 1) next = src.replace(exactBlockRegex(eol), LINK_TAG);
  return { next, copies, hasLink, hasMarker, problem };
}

function main() {
  const WRITE = process.argv.includes('--write');
  let migrated = 0;
  const offenders = [];
  for (const file of walk(ROOT)) {
    const orig = fs.readFileSync(file, 'utf8');
    if (!orig.includes(MARKER) && !orig.includes(LINK_HREF)) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const r = migrate(orig);
    if (r.problem) { offenders.push(rel + ' [' + r.problem + ' — fix by hand]'); continue; }
    if (!r.copies) continue; // linked, or a deliberate variant (docs/index.html)
    if (!WRITE) { offenders.push(rel + ' [inline canonical copy — run --write]'); continue; }
    fs.writeFileSync(file, r.next);
    migrated++;
  }

  if (offenders.length) {
    console.error('ensure-readability-css: ' + offenders.length + ' page(s) off-contract:');
    for (const o of offenders.slice(0, 20)) console.error('  - ' + o);
    if (!WRITE) console.error('Run: node scripts/ensure-readability-css.js --write');
    process.exit(1);
  }
  console.log(JSON.stringify(WRITE ? { migrated } : { clean: true }, null, 2));
}

if (require.main === module) main();

module.exports = { CANONICAL_BODY, MARKER, LINK_HREF, LINK_TAG, CSS_FILE, exactBlockRegex, migrate };
