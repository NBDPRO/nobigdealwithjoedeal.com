/**
 * tests/gauntlet-brand-guard.test.js — source-contract tripwire (gauntlet Batch 3).
 *
 * The Batch 3 de-branding taught us that a whole family of customer/adjuster-
 * facing generators hardcoded NBD identity and slipped past manual review. This
 * guard scans those generators and FAILS if an NBD-identity literal
 * ('No Big Deal Home Solutions', 'Joe Deal', '(859) 420-7382', 'Cincinnati',
 * 'Northern Kentucky', 'Lexington, KY') appears on a line that is NOT gated —
 * i.e. not adjacent to an isNbd / _brand() / _legal() / {{company}} / getter
 * reference and not a comment. Every real NBD literal in these files should be
 * an explicit NBD-branch fallback next to its gate; a bare one is a regression.
 *
 * Purely lexical (no execution). Run: node tests/gauntlet-brand-guard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const ROOT = path.join(__dirname, '..');

// Customer/adjuster-facing generators de-branded in Batch 3.
const FILES = [
  'docs/pro/js/document-generator.js',
  'docs/pro/js/document-generator-templates.js',
  'docs/pro/js/estimate-supplement.js',
  'docs/pro/js/estimate-finalization.js',
  'docs/pro/js/warranty-cert.js',
  'docs/pro/js/photo-report.js',
  'docs/pro/js/inspection-report-engine.js',
  'docs/pro/js/email_system.js',
  'docs/pro/js/portal.js',
  'docs/pro/js/customer-portal.js',
  'functions/print/templates/warranty.hbs',
  'functions/print/partials/coverPage.hbs',
  // Added after the first-run audit. Every one of these leaked the platform
  // owner's identity into something a HOMEOWNER receives, and every one
  // survived purely because it wasn't on this list — the checks below would
  // have caught them on day one:
  //   estimate-v2-ui.js       preparedBy:'Joe Deal' on the BoldSign-signed instrument
  //   d2d-tracker-core        "from NBD Home Solutions" in six knock-follow-up templates
  //   dashboard-ui.js         "- No Big Deal Exteriors" signing a tenant's booking email
  //   crm-portal-bridge.js    "Joe from No Big Deal Home Solutions" in a follow-up SMS
  //   review-engine.js        "Joe & the NBD team" + the owner's cell in a review ask
  // A file-list omission is a silent hole; prefer adding a file here over
  // trusting that it has no customer-facing output.
  'docs/pro/js/estimate-v2-ui.js',
  'docs/pro/js/d2d-tracker-core-2026b.js',
  'docs/pro/js/dashboard-ui.js',
  'docs/pro/js/crm-portal-bridge.js',
  'docs/pro/js/review-engine.js',
  // Added with the Stripe platform-only gate: this module hardcoded
  // "NBD Roofing" in the invoice email subject, the emailed invoice header and
  // thank-you line, the payment receipt, and the invoice SMS — five things a
  // TENANT's homeowner receives.
  'docs/pro/js/invoice-pipeline.js',
  // Added with the neutral-county fix (first-run audit punch list): the V2
  // engine generates customer-paper line names (e.g. the Building Permit
  // scope line) — a jurisdiction/brand literal here would print on every
  // tenant's estimate.
  'docs/pro/js/estimate-builder-v2.js',
  // Added with the photo-report filename fix (punch-list spin-off 2026-07-29):
  // this generator builds a PDF a homeowner receives; its filename used to
  // fall back `docPrefix || 'NBD'` for under-configured tenants.
  'docs/pro/js/customer-photo-report-generator.js',
];

// Rendered NBD-identity literals that must never appear ungated on a tenant path.
const NBD_LITERALS = [
  /No Big Deal Home Solutions/,
  /Joe Deal/,
  /\(859\)\s?420-7382/,
  /859-420-7382/,
  /Northern Kentucky/,
  /Lexington, KY/,
];

// A line is "gated" if it — or any line within GATE_WINDOW above/below — carries
// a per-tenant resolver / NBD-gate reference, OR the literal's own line is part
// of a conditional/fallback expression (ternary, ||, ===). A truly BARE literal
// (`x = 'No Big Deal Home Solutions'` with no gate nearby and no branch operator)
// is what this tripwire is meant to catch.
const GATE_WINDOW = 6;
const GATE_TOKENS = [
  'isNbd', '_isNbdBrand', '_brand(', 'window._brand', '_brandRaw', '_brandOverride',
  '_legal(', '_custIdPrefix', 'NBD_COMPANY_PROFILE_DEFAULTS', 'legalName',
  'company.isNbd', 'company.footerName', 'company.seal', 'preparedBy',
  'DEFAULT_COMPANY_NAME', 'DEFAULT_REP_NAME', 'BRAND', 'tenantName', '_bc.', '_b.',
  // structural resolvers: these NBD-default data blocks are only ever read for
  // the NBD tenant by a nearby resolver function / ternary.
  'C.name', 'view.company', '_resolveCompany', '_pbNbd', '_pbCo', 'NBD_DOC_COMPANY',
  'resolveDocCompany', 'resolveBrand', '_repName', 'brandRaw',
  // NBD-default DATA blocks read only for the NBD tenant by their consumer:
  'COMPANY',   // DG.COMPANY default, gated by _resolveCompany()
  'curated',   // NBD-only curated testimonial fallback (rendered only when isNbd)
];
// Same-line branch/fallback operators: the literal is the NBD arm of a ternary
// or the fallback of a `||`, i.e. structurally gated on this very line. (Does
// NOT include a bare `: '` — that would pass every object property, defeating
// the tripwire.)
const BRANCH_ON_LINE = /\?|\|\||===|!==/;

function isCommentLine(t) {
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--') || t.startsWith('{{!');
}

console.log('BRAND GUARD — no ungated NBD identity literal in customer-facing generators');

let totalUngated = 0;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); }
  catch (_) { ok('file present: ' + rel, false); continue; }
  const lines = src.split(/\r?\n/);
  const ungated = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!NBD_LITERALS.some((re) => re.test(line))) continue;
    const trimmed = line.trim();
    if (isCommentLine(trimmed)) continue; // documentation, not output
    // Gated if the literal's own line is a branch/fallback expression, OR any
    // line within ±GATE_WINDOW carries a resolver/gate token (an NBD-default
    // data block is only ever read for NBD by a nearby resolver / isNbd ternary).
    if (BRANCH_ON_LINE.test(line)) continue;
    const lo = Math.max(0, i - GATE_WINDOW), hi = Math.min(lines.length - 1, i + GATE_WINDOW);
    const windowText = lines.slice(lo, hi + 1).join('\n');
    const gated = GATE_TOKENS.some((tok) => windowText.indexOf(tok) !== -1);
    if (!gated) ungated.push((i + 1) + ': ' + trimmed.slice(0, 100));
  }
  ok('no ungated NBD literal in ' + rel, ungated.length === 0);
  if (ungated.length) { totalUngated += ungated.length; ungated.forEach((u) => console.log('        → ' + u)); }
}

// ── Server-PDF social rail: NBD-only chrome ────────────────────────
// socialRail.hbs is pure hardcoded NBD identity (Google reviews / site /
// Facebook / Instagram URLs — no template vars). It must render ONLY for the
// NBD tenant, gated at its single include site in _layout.hbs. A bare
// {{> socialRail}} would stamp NBD's socials on every stranger tenant's
// customer/adjuster PDFs (contract/invoice/receipt/warranty/inspection/…).
console.log('\nBRAND GUARD — server-PDF social rail is NBD-gated');
{
  const layout = fs.readFileSync(path.join(ROOT, 'functions/print/partials/_layout.hbs'), 'utf8');
  // The only {{> socialRail}} include must be wrapped in {{#if company.isNbd}}.
  const includeRe = /\{\{>\s*socialRail\s*\}\}/g;
  const gatedRe = /\{\{#if\s+company\.isNbd\s*\}\}\s*\{\{>\s*socialRail\s*\}\}\s*\{\{\/if\}\}/;
  const includes = (layout.match(includeRe) || []).length;
  ok('_layout.hbs includes socialRail exactly once', includes === 1);
  ok('the socialRail include is gated on {{#if company.isNbd}}', gatedRe.test(layout));
  // socialRail.hbs may keep its NBD URLs (it is the NBD rail); the gate is the
  // contract. Assert it is indeed NBD-only content so the gate stays meaningful.
  const rail = fs.readFileSync(path.join(ROOT, 'functions/print/partials/socialRail.hbs'), 'utf8');
  ok('socialRail.hbs carries the NBD identity it must stay gated behind',
    /nobigdealwithjoedeal\.com/.test(rail) || /g\.page\/r\//.test(rail));
}

// ── Deal-acceptance error page: neutral <title>, no NBD identity ───
// getDealRoom's errPage (invalid / expired / already-accepted) is served for
// EVERY tenant's /deal/<token> link, so its <title> must never assert NBD's
// identity on a stranger tenant's customer-facing tab / link-preview.
console.log('\nBRAND GUARD — deal-acceptance error page title is neutral');
{
  const da = fs.readFileSync(path.join(ROOT, 'functions/deal-acceptance.js'), 'utf8');
  ok('deal-acceptance errPage does NOT hardcode an NBD <title>',
    !/<title>No Big Deal<\/title>/.test(da));
}

// ── Warranty wizard tier picker names the tenant's pledge, not NBD's ───
// dashboard.html's #wcTier first option is static "Standard — NBD Lifetime
// Pledge"; updateCertPreview (run on open + on change) relabels it per tenant.
// Behavioral: the REAL warranty-cert.js in a vm with a stub DOM (2026-09-28).
console.log('\nBRAND GUARD — warranty tier picker is tenant-named');
{
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'docs/pro/js/warranty-cert.js'), 'utf8');
  function relabel(brand) {
    const opt0 = { value: 'standard', textContent: 'Standard — NBD Lifetime Pledge' };
    const els = {
      wcTier: { value: 'standard', options: [opt0, { value: 'preferred', textContent: 'Preferred' }] },
      wcTierDesc: { textContent: '' },
      wcEyebrow: { textContent: 'NBD Guarantee' },
    };
    const ctx = { window: { _brand: () => brand }, document: { getElementById: (id) => els[id] || null }, console };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'warranty-cert.js' });
    vm.runInContext('updateCertPreview()', ctx);
    return { opt: opt0.textContent, desc: els.wcTierDesc.textContent, eyebrow: els.wcEyebrow.textContent };
  }
  const nbd = relabel({ legalName: 'No Big Deal Home Solutions' });
  // Jo, 2026-10-06 (final): the Pledge is a promise, never "lifetime"; Standard's written labor term is 5 years.
  ok('NBD sees "Standard — NBD Pledge · 5-Year Labor"', nbd.opt === 'Standard — NBD Pledge · 5-Year Labor', nbd.opt);
  ok('NBD keeps the "NBD Guarantee" eyebrow', nbd.eyebrow === 'NBD Guarantee');
  const t = relabel({ legalName: 'Demo Roofing Co', seal: 'DRC' });
  // 2026-10-06 (Jo): the Lifetime Pledge is NBD's own; another company's rep sees the plain package name.
  ok('a tenant with a seal sees the plain "Standard" (never a Lifetime Pledge)', t.opt === 'Standard', t.opt);
  ok('…and no "NBD" in the tier description', !/\bNBD\b/.test(t.desc));
  ok('…and the eyebrow reads "DRC Guarantee"', t.eyebrow === 'DRC Guarantee');
  const t2 = relabel({ legalName: 'Demo Roofing Co' });
  ok('a tenant without a seal: plain "Standard" too', t2.opt === 'Standard', t2.opt);
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed` + (totalUngated ? ` (${totalUngated} ungated literal lines)` : ''));
if (failed) { console.log('\nUngated NBD literals found — gate each behind isNbd/_brand()/{{company}} or make it a per-tenant value:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('✓ No ungated NBD identity literal in any customer-facing generator');
