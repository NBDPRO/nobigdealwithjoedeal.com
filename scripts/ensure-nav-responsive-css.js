/**
 * ensure-nav-responsive-css.js — keeps the `nav-responsive-fix v3` block a
 * LINKED stylesheet instead of an inline <style> repeated on every page.
 * ═══════════════════════════════════════════════════════════════
 *
 * WHY (2026-09-22, inline-CSS dedup slice 4)
 *
 * The block was byte-identical inline CSS on 173 public pages, 892 B each —
 * ~151 KB of HTML to say one thing. A re-census found the friendliest
 * conditions of any block left: ONE distinct body, and on every page it was
 * the sole content of its own plain <style> element.
 *
 * MODES
 *   (default) assert. Exits 1 if a page still carries the inline canonical
 *     copy, carries BOTH the link and the marker, or carries more than one
 *     copy. This is the CI gate.
 *   --write   migrates each byte-exact inline copy to the link IN PLACE.
 *
 * "IN PLACE" IS LOAD-BEARING — do not hoist the link.
 * Every rule in the block is `!important`, and nbd-mobile.css carries its own
 * `!important` nav padding, so the winner is decided by SOURCE ORDER. Slice
 * 3b (#1674) moved a link to the end of <head> as a control and changed
 * computed styles on 39 of 70 page@width combos. The regex below matches the
 * <style>…</style> span ONLY, so surrounding indentation and line breaks stay
 * put and the link lands exactly where the block was.
 *
 * Nothing re-injects this block — unlike the footer/social/typography blocks
 * it has no generator (verified 2026-09-22: no script in scripts/ contains
 * its rules). So there is no stale injector to guard here, only this assert.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const CSS_FILE = path.join(ROOT, 'assets', 'css', 'nbd-nav-responsive.css');

const MARKER = '/* nav-responsive-fix v3 */';
const LINK_HREF = '/assets/css/nbd-nav-responsive.css';
const LINK_TAG = `<link rel="stylesheet" href="${LINK_HREF}">`;
// Same exclusions as ensure-readability-css.js. 'sites' matters here: one
// page carrying the block (sites/free-guide/index.html) lives under it and
// keeps its inline copy deliberately, as index.html did for readability.
const EXCLUDED_TOP = new Set(['admin', 'pro', 'sites', 'assets', 'deploy', 'tools']);

// Must stay byte-identical to docs/assets/css/nbd-nav-responsive.css's body
// (minus that file's own header comment). Deliberately NOT derived from the
// CSS file at runtime, so a drifted stylesheet cannot silently redefine what
// counts as canonical — same reasoning as ensure-readability-css.js.
const CANONICAL_BODY = `@media(max-width:1024px){
  nav .nav-links{display:none!important}
  nav .hamburger,nav button.hamburger{display:flex!important}
  nav{padding-left:20px!important;padding-right:20px!important}
}
/* Compact desktop nav in the 1025-1440 range so it fits on one line
   without crashing into the logo card. Above 1440 the default applies. */
@media(min-width:1025px) and (max-width:1440px){
  nav{padding-left:24px!important;padding-right:24px!important}
  nav .nav-links{gap:14px!important}
  nav .nav-links > li > a{font-size:.7rem!important;letter-spacing:.05em!important;padding:5px 0!important}
  nav .nav-cta{padding:8px 14px!important;font-size:.7rem!important}
  nav .nav-logo img{height:50px!important}
  nav .nav-logo-text .brand{font-size:.9rem!important}
  nav .nav-logo-text .sub{font-size:.62rem!important}
  nav .nav-logo{margin-right:12px!important}
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

// The working tree is CRLF on Windows (core.autocrlf) and LF in git/CI, and
// an LF needle silently no-ops on a CRLF file — so the needle is always built
// with the file's own EOL.
function exactBlockRegex(eol, flags) {
  const body = eol === '\n' ? CANONICAL_BODY : CANONICAL_BODY.split('\n').join(eol);
  const raw = '<style>' + eol + MARKER + eol + body + eol + '</style>';
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

function eolOf(src) {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

/** Pure per-page transform, exported for tests. */
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
  if (!fs.existsSync(CSS_FILE)) {
    console.error('ensure-nav-responsive-css: missing ' + path.relative(process.cwd(), CSS_FILE));
    process.exit(1);
  }
  // The stylesheet must still say exactly what the 173 inline copies said.
  // Without this, the sheet could be edited and every page would silently
  // render something the migration never signed off on — existence alone is
  // the weaker check, and this is the whole safety property of an extraction.
  {
    const raw = fs.readFileSync(CSS_FILE, 'utf8').replace(/\r\n/g, '\n');
    const at = raw.indexOf(MARKER);
    const body = at === -1 ? null : raw.slice(at + MARKER.length + 1).replace(/\n$/, '');
    if (body !== CANONICAL_BODY) {
      console.error('ensure-nav-responsive-css: ' + path.relative(process.cwd(), CSS_FILE)
        + ' has DRIFTED from CANONICAL_BODY.');
      console.error('  The stylesheet and the block it replaced must stay byte-identical.');
      console.error('  Change both deliberately, or not at all.');
      process.exit(1);
    }
  }
  for (const file of walk(ROOT)) {
    const orig = fs.readFileSync(file, 'utf8');
    if (!orig.includes(MARKER) && !orig.includes(LINK_HREF)) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const r = migrate(orig);
    if (r.problem) { offenders.push(rel + ' [' + r.problem + ' — fix by hand]'); continue; }
    if (!r.copies) continue; // already linked
    if (!WRITE) { offenders.push(rel + ' [inline canonical copy — run --write]'); continue; }
    fs.writeFileSync(file, r.next);
    migrated++;
  }

  if (offenders.length) {
    console.error('ensure-nav-responsive-css: ' + offenders.length + ' page(s) off-contract:');
    for (const o of offenders.slice(0, 20)) console.error('  - ' + o);
    if (!WRITE) console.error('Run: node scripts/ensure-nav-responsive-css.js --write');
    process.exit(1);
  }
  console.log(JSON.stringify(WRITE ? { migrated } : { clean: true }, null, 2));
}

if (require.main === module) main();

module.exports = { CANONICAL_BODY, MARKER, LINK_HREF, LINK_TAG, CSS_FILE, exactBlockRegex, migrate };
