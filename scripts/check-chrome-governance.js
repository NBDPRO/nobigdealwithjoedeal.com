#!/usr/bin/env node
/**
 * check-chrome-governance.js — every marketing page's nav and footer must be
 * generator-owned, or explicitly and briefly excused here.
 *
 * WHY THIS EXISTS
 * apply-partials.js skips any file that carries no `nbd:partial` marker. That
 * is correct behaviour for a restamper, but it means a page with hand-built
 * chrome is invisible to `--check` — and therefore to CI — forever. 22 of 211
 * marketing pages were in that state, including the homepage.
 *
 * The consequence is not hypothetical. Every sitewide chrome sweep since
 * 2026-06 (the cert-bar rollout, the American Operator badge, the WCAG contrast
 * fix, the privacy-link injection) reached the partial-stamped pages and
 * stopped at exactly this boundary, leaving residue on the same ~29 files each
 * time. The 2026-08-19 audit found all of it downstream of this one gap.
 *
 * SELECTION IS A WALK, NOT A LIST. Three guards in this repo have now failed
 * because the offending file was on neither their strict list nor their
 * exception list (ensure-icon-css 2026-08-17, catalog-cost-privacy 2026-08-18,
 * marketing-polish-contract's certBarTargets 2026-08-19). So this walks the
 * tree and treats EXEMPT as a denylist of known-good: a NEW page defaults to
 * failing, which is the inversion those three got backwards.
 *
 * EXEMPT entries carry a reason and are themselves checked — an entry that no
 * longer needs to be there is a failure too, so the list shrinks as the
 * follow-ups land instead of quietly rotting.
 *
 * Usage:
 *   node scripts/check-chrome-governance.js
 *   node scripts/check-chrome-governance.js --json
 *
 * Exit codes: 0 clean / 1 violations / 2 fatal.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(REPO_ROOT, 'docs');
const JSON_OUT = process.argv.includes('--json');

// The CRM/admin app and internal docs are not this system's business — same
// exclusion apply-partials.js and check-site-integrity.js use.
const SKIP_TOP_DIRS = new Set(['pro', 'admin', 'dev', 'assets']);

// Pages that legitimately ship hand-built chrome today. Each entry states WHY.
// Shrink this list; do not grow it. See the audit note:
// documentation/audit/DESIGN-CONSISTENCY-SWEEP-2026-08-19.md
const EXEMPT = {
  // --- tenant + B2B surfaces on a separate design system ---
  'sites/t/index.html': 'tenant microsite template — identity injected at runtime from companyProfile; NBD chrome here would be a cross-tenant leak',
  'sites/index.html': '/sites B2B surface — separate design system (Barlow, #C8541A), noindex',
  'sites/free-guide/index.html': '/sites B2B lead magnet — separate design system with CONTRACTOR chrome (NBD Pro / Pro Blog / Pricing, switched off the homeowner nav 2026-09-13); no homeowner partial family can own it; badge logo on record at scripts/migrate-nav-to-partial.js:53-58',

  // --- Oaks Roofing & Construction microsite (rebuilt 2026-08-19) ---
  // A CLIENT's site, not an NBD surface: its own brand (#fa6404, Montserrat/Open
  // Sans), its own orc-* class namespace, and its own self-contained chrome. NBD
  // partials here would be a cross-brand leak, exactly as for sites/t/index.html.
  // It is also a hand-off deliverable — the folder must stay portable and
  // hand-editable after Scott takes it to his own host, so it deliberately has no
  // build step and no dependency on this repo's generators. Delete these 11 entries
  // if the microsite is ever removed.
  'sites/oaks/index.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/about.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/contact.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/gallery.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/service-areas.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/privacy.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/services/roof-replacement.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/services/roof-repair.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/services/siding-replacement.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/services/siding-repair.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',
  'sites/oaks/services/gutter-replacement.html': 'Oaks client microsite — separate brand + design system, portable hand-off deliverable',

  // --- hub pages that predate the partial migration ---
  'index.html': 'homepage — hand-built nav mirrors nav-blog; predates the partials',
  'areas/index.html': 'areas hub — 4-column grid footer, no partial variant covers it yet',
  'privacy.html': 'legal page — hand-built grid footer',
  'review.html': 'reviews hub — hand-built grid footer',
  'the-pledge/index.html': 'pledge landing — hand-built grid footer + its own sticky CTA',
  'visualizer.html': 'tool page — hand-built grid footer',

  // --- funnel pages whose footer is still hand-built ---
  'estimate.html': 'slim one-line funnel footer; nav IS nav-tool-governed. No footer partial variant covers this shape',
  'inspect.html': 'QR-code capture funnel — the header is deliberately logo-only, on record in the page: "no nav (QR funnel: keep them on the page)". nav-tool would add Back-to-site + a 32-link menu, so it is NOT stamped here',
  'storm-alerts.html': 'slim one-line funnel footer; nav IS nav-tool-governed. No footer partial variant covers this shape',

  // --- brand microsites (nav-microsite stamped 2026-08-19; only the
  //     4-column grid footer is still hand-built) ---
  'services/gaf-pivot-boot/index.html': '4-column grid footer; nav IS nav-microsite-governed. No footer partial variant covers this shape',
  'services/gaf-timberline/index.html': '4-column grid footer; nav IS nav-microsite-governed. No footer partial variant covers this shape',
  'services/lumanail/index.html': '4-column grid footer; nav IS nav-microsite-governed. No footer partial variant covers this shape',
  'services/roofivent/index.html': '4-column grid footer; nav IS nav-microsite-governed. No footer partial variant covers this shape',
  'services/tamko-impact-resistant-shingles/index.html': '4-column grid footer; nav IS nav-microsite-governed. No footer partial variant covers this shape',
  'services/the-nbd-build/index.html': '4-column grid footer; nav IS nav-microsite-governed. No footer partial variant covers this shape',
  'services/the-nbd-guarantee/index.html': '4-column grid footer; nav IS nav-microsite-governed. No footer partial variant covers this shape',
};

function walk(dir, acc) {
  acc = acc || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dir === DOCS && SKIP_TOP_DIRS.has(e.name)) continue;
      walk(p, acc);
    } else if (e.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

const rel = (f) => path.relative(DOCS, f).split(path.sep).join('/');

const HAS_FOOTER = /<footer[\s>]/;
const HAS_NAVLINKS = /class="nav-links"/;
const FOOTER_PARTIAL = /nbd:partial\s+footer-/;
const NAV_PARTIAL = /nbd:partial\s+(?:nav-|mobile-nav-)/;

/** What chrome, if any, this page hand-builds. */
function ungovernedParts(source) {
  const missing = [];
  if (HAS_FOOTER.test(source) && !FOOTER_PARTIAL.test(source)) missing.push('footer');
  if (HAS_NAVLINKS.test(source) && !NAV_PARTIAL.test(source)) missing.push('nav');
  return missing;
}

const files = walk(DOCS);
const ungoverned = [];
const usedExempt = new Set();

for (const f of files) {
  const r = rel(f);
  const missing = ungovernedParts(fs.readFileSync(f, 'utf8'));
  if (!missing.length) continue;
  if (Object.prototype.hasOwnProperty.call(EXEMPT, r)) { usedExempt.add(r); continue; }
  ungoverned.push({ page: r, missing });
}

// An exemption nobody needs any more is itself a defect — otherwise the list
// only ever grows and stops meaning anything.
const stale = Object.keys(EXEMPT).filter((r) => {
  if (usedExempt.has(r)) return false;
  const abs = path.join(DOCS, r);
  if (!fs.existsSync(abs)) return false;          // deleted page: harmless
  return ungovernedParts(fs.readFileSync(abs, 'utf8')).length === 0;
});

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned: files.length, ungoverned, staleExemptions: stale }, null, 2));
} else {
  console.log(`check-chrome-governance: ${files.length} marketing page(s) scanned, ` +
    `${Object.keys(EXEMPT).length} exempt.`);
  if (ungoverned.length) {
    console.log('\nUNGOVERNED CHROME — add an nbd:partial region, or an EXEMPT entry with a reason:');
    for (const u of ungoverned) console.log(`  ${u.page}  (hand-built: ${u.missing.join(' + ')})`);
  }
  if (stale.length) {
    console.log('\nSTALE EXEMPTIONS — these pages are governed now; delete their EXEMPT entries:');
    for (const r of stale) console.log(`  ${r}`);
  }
  if (!ungoverned.length && !stale.length) {
    console.log('  clean — every marketing page is generator-owned or explicitly excused.');
  }
}

process.exit(ungoverned.length || stale.length ? 1 : 0);
