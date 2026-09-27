/**
 * tests/docgen-render.test.js — full client doc-render integration test.
 *
 * Loads BOTH document-generator.js + document-generator-templates.js into one
 * NBDDocGen (as the browser does), stubs window._brand(), and renders real
 * documents for NBD and for a tenant (Oaks). Asserts the brand actually lands
 * in the output HTML — the closest thing to a render-verify we can do without
 * a browser.
 *
 * This is the test that proves the EXTENDED doc types (the ones in templates.js)
 * are tenant-aware, not just the core ones. It renders a spread of doc types for
 * BOTH tenants and asserts:
 *   - NBD shows 'No Big Deal' + navy #1A3057 + orange #BD5728.
 *   - Oaks shows 'Oaks Roofing & Construction' + charcoal #333333 + accent
 *     #C2410C, and does NOT leak NBD navy #1A3057 or the 'No Big Deal' name.
 * A failure on the Oaks side is a real tenant-brand leak — a render method
 * hardcoding an NBD value instead of resolving it from C/P/S/A/LOGO.
 *
 * Run: node tests/docgen-render.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const DG_DIR = path.join(__dirname, '..', 'docs/pro/js');
const SRC_DOCGEN    = fs.readFileSync(path.join(DG_DIR, 'document-generator.js'), 'utf8');
const SRC_TEMPLATES = fs.readFileSync(path.join(DG_DIR, 'document-generator-templates.js'), 'utf8');

function loadFullDocGen(brand) {
  const win = { _brand: () => brand };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(SRC_DOCGEN, sandbox, { filename: 'document-generator.js' });
  vm.runInNewContext(SRC_TEMPLATES, sandbox, { filename: 'document-generator-templates.js' });
  return win.NBDDocGen;
}

// Render a single doc type for a brand. `method` is the NBDDocGen render*
// method name (from DOCUMENT_TYPES[..].template in -templates.js); `data` is
// the minimal merge data that method needs. Wrapped in try/catch so a render
// throwing in the vm surfaces as a readable assertion failure, not a crash.
function renderType(brand, method, data) {
  const dg = loadFullDocGen(brand);
  try {
    return dg[method](Object.assign({}, data));
  } catch (e) {
    return 'RENDER_ERROR: ' + (e && e.message);
  }
}

// Back-compat shim for the original warranty-certificate render.
function render(brand) {
  return renderType(brand, 'renderWarrantyCertificate',
    { homeownerName: 'Jane Smith', address: '123 Main St', warrantyTier: 'best', leadId: 'L1' });
}

const NBD_BRAND = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
const OAKS_BRAND = {
  legalName: 'Oaks Roofing & Construction',
  displayName: 'Oaks Roofing & Construction',
  seal: 'ORC',
  docPrefix: 'OAK',
  tagline: 'Roofing, Siding, Gutters',
  logoUrl: 'https://nobigdealwithjoedeal.com/sites/oaks/logo-orange.svg',
  colors: { primary: '#333333', secondary: '#1A1A1A', accent: '#C2410C', ink: '#222222' },
  contact: { phone: '(513) 827-5297', email: 'joe@oaksrfc.com', website: 'oaksroofingandconstruction.com', address: 'Goshen, OH' }
};

console.log('DOCGEN RENDER — warranty certificate (full render)');

// ── NBD: full brand, byte-identical ──
const nbd = render(NBD_BRAND);
ok('NBD: renders HTML (no error)', typeof nbd === 'string' && nbd.indexOf('RENDER_ERROR') !== 0 && nbd.length > 500);
ok('NBD: shows NBD name', /No Big Deal Home Solutions/.test(nbd));
ok('NBD: navy #1A3057 in styles', /#1A3057/i.test(nbd));
ok('NBD: orange #BD5728 accent', /#BD5728/i.test(nbd));
ok('NBD: NBD-WC cert number', /NBD-WC-/.test(nbd));

// ── Oaks: tenant brand throughout (body + chrome + number) ──
const oak = render(OAKS_BRAND);
ok('Oaks: renders HTML (no error)', typeof oak === 'string' && oak.indexOf('RENDER_ERROR') !== 0 && oak.length > 500);
ok('Oaks: shows Oaks name', /Oaks Roofing & Construction/.test(oak));
ok('Oaks: OAK-WC cert number (docPrefix)', /OAK-WC-/.test(oak));
ok('Oaks: charcoal #333333 (tenant primary)', /#333333/i.test(oak));
ok('Oaks: burnt-orange #C2410C (tenant accent)', /#c2410c/i.test(oak));
ok('Oaks: does NOT show NBD navy #1A3057', !/#1A3057/i.test(oak));
ok('Oaks: does NOT show "No Big Deal"', !/No Big Deal/.test(oak));
ok('Oaks: does NOT leak "NBD" signature seal', !/Authorized NBD Representative/.test(oak));

// ════════════════════════════════════════════════════════════════════
// EXTENDED COVERAGE — render EVERY extended doc type in
// document-generator-templates.js for BOTH tenants and assert the same
// brand contract on each. Each entry: a friendly label, the render*
// method, and the minimal data that method needs (each render* uses
// Object.assign defaults, so BASE is enough for the brand-leak check;
// the FORM_FIELDS map near the end of -templates.js lists the real
// editable fields per type if richer fixtures are ever needed).
//
// Each render is wrapped in try/catch (see renderType) so a render that
// throws in the vm surfaces as a readable assertion failure, never a
// crash. None of these templates need real DOM/canvas — they are pure
// string builders — so none are skipped here.
// ════════════════════════════════════════════════════════════════════
const BASE = { homeownerName: 'Jane Smith', address: '123 Main St', leadId: 'L1' };
const DOC_TYPES = [
  // ── already covered before this sweep ──
  { label: 'invoice',                   method: 'renderInvoice',                 data: BASE },
  { label: 'change_order',              method: 'renderChangeOrder',             data: BASE },
  { label: 'work_authorization',        method: 'renderWorkAuthorization',       data: BASE },
  { label: 'certificate_of_completion', method: 'renderCertificateOfCompletion', data: BASE },
  { label: 'scope_of_work',             method: 'renderScopeOfWork',             data: BASE },
  { label: 'company_intro',             method: 'renderCompanyIntro',            data: BASE },
  // ── added in tenant-render-coverage-2 (the rest of -templates.js) ──
  { label: 'supplement_request',        method: 'renderSupplementRequest',       data: BASE },
  { label: 'before_after_report',       method: 'renderBeforeAfterReport',       data: BASE },
  { label: 'financing_options',         method: 'renderFinancingOptions',        data: Object.assign({ totalPrice: 18500 }, BASE) },
  { label: 'referral_card',             method: 'renderReferralCard',            data: BASE },
  // (assignment_of_benefits / direction_to_pay retired 2026-09-27 — no renderer.)
  { label: 'material_delivery',         method: 'renderMaterialDelivery',        data: BASE },
  { label: 'storm_checklist',           method: 'renderStormChecklist',          data: BASE },
  { label: 'claim_guide',               method: 'renderClaimGuide',              data: BASE },
  { label: 'door_hanger',               method: 'renderDoorHanger',              data: BASE },
  { label: 'neighborhood_mailer',       method: 'renderNeighborhoodMailer',      data: Object.assign({ neighborhoodName: 'Maple Grove', projectAddress: '456 Oak Ave' }, BASE) },
  { label: 'testimonial_sheet',         method: 'renderTestimonialSheet',        data: BASE },
  { label: 'thank_you',                 method: 'renderThankYou',                data: BASE },
  { label: 'payment_agreement',         method: 'renderPaymentAgreement',        data: Object.assign({ totalAmount: 12500, depositAmount: 4000, progressAmount: 4500, finalAmount: 4000 }, BASE) },
  // BASE alone (no `stormReport`) exercises the "unavailable" branch — the
  // one every real call takes until _attachStormHistory() has run — which
  // still goes through page()/letterhead()/footer(), so the brand contract
  // holds either way. The populated-data branch is covered separately below.
  { label: 'storm_history_report',      method: 'renderStormHistoryReport',      data: BASE },
];

for (const t of DOC_TYPES) {
  console.log('\nDOCGEN RENDER — ' + t.label + ' (full render, both tenants)');

  // NBD: navy + orange + the NBD name all present, no error.
  const n = renderType(NBD_BRAND, t.method, t.data);
  const nOk = typeof n === 'string' && n.indexOf('RENDER_ERROR') !== 0 && n.length > 500;
  ok(t.label + ' / NBD: renders HTML (no error)', nOk);
  ok(t.label + ' / NBD: shows "No Big Deal"', /No Big Deal/.test(n));
  ok(t.label + ' / NBD: navy #1A3057 present', /#1A3057/i.test(n));

  // Oaks: tenant name + charcoal + accent present; NBD navy + NBD name +
  // NBD signature seal ("Authorized NBD Representative") all absent.
  const o = renderType(OAKS_BRAND, t.method, t.data);
  const oOk = typeof o === 'string' && o.indexOf('RENDER_ERROR') !== 0 && o.length > 500;
  ok(t.label + ' / Oaks: renders HTML (no error)', oOk);
  ok(t.label + ' / Oaks: shows "Oaks Roofing & Construction"', /Oaks Roofing & Construction/.test(o));
  ok(t.label + ' / Oaks: charcoal #333333 (tenant primary)', /#333333/i.test(o));
  ok(t.label + ' / Oaks: accent #C2410C (tenant accent)', /#c2410c/i.test(o));
  ok(t.label + ' / Oaks: does NOT leak NBD navy #1A3057', !/#1A3057/i.test(o));
  ok(t.label + ' / Oaks: does NOT leak "No Big Deal"', !/No Big Deal/.test(o));
  ok(t.label + ' / Oaks: does NOT leak "NBD" signature seal', !/Authorized NBD Representative/.test(o));
}

// ════════════════════════════════════════════════════════════════════
// UNRESERVED-PREFIX TENANT — _docPrefix derives from legalName.
// A non-NBD tenant with docPrefix '' used to mint orphan '-WC-#####'
// certificate numbers ('Certificate #-WC-48213'). Now the prefix derives
// from legalName (byte-identical to company-profile.js _deriveCustPrefix),
// so certs read 'ORC-WC-…' — consistent with customer IDs and the
// standalone warranty wizard, and still never 'NBD'.
// ════════════════════════════════════════════════════════════════════
console.log('\nDOCGEN RENDER — warranty cert, unreserved-prefix tenant (derived prefix)');
const UNDER_BRAND = {
  legalName: 'Oaks Roofing & Construction', displayName: 'Oaks Roofing & Construction',
  seal: '', docPrefix: '', tagline: '', smsSignOff: '', logoUrl: '',
  colors: { accent: '#C2410C' },
  contact: { phone: '', email: '', website: '', address: '', alertEmail: '', alertSms: '' },
};
const un = render(UNDER_BRAND);
ok('unreserved: renders HTML (no error)', typeof un === 'string' && un.indexOf('RENDER_ERROR') !== 0 && un.length > 500);
ok('unreserved: Certificate #ORC-WC-… (derived prefix)', /Certificate #ORC-WC-\d/.test(un));
ok('unreserved: no orphan "Certificate #-WC-"', !/Certificate #-WC-/.test(un));
ok('unreserved: no NBD-WC- leak', !/NBD-WC-/.test(un));

// ════════════════════════════════════════════════════════════════════
// BLANK TENANT — footers/letterheads must not emit orphan separators,
// dangling labeled lines, or empty <img src=""> when every contact
// field is blank (first-run audit 2026-07-28: '(555) 555-5555 · · ',
// 'Zelle —', broken-image boxes on a brand-new tenant's paper).
// The blank tenant has ZERO contact fields, so ZERO join separators
// may survive in any rendered doc.
// ════════════════════════════════════════════════════════════════════
const BLANK_TENANT = { legalName: 'Blank Roofing Co', colors: {}, contact: {} };
for (const t of DOC_TYPES) {
  console.log('\nDOCGEN RENDER — ' + t.label + ' (blank-contact tenant, no orphans)');
  const bl = renderType(BLANK_TENANT, t.method, t.data);
  ok(t.label + ' / blank: renders HTML (no error)', typeof bl === 'string' && bl.indexOf('RENDER_ERROR') !== 0 && bl.length > 500);
  ok(t.label + ' / blank: no empty <img src="">', !/src=""/.test(bl));
  ok(t.label + ' / blank: no orphan &nbsp;|&nbsp; separators', !/&nbsp;\|&nbsp;/.test(bl));
  ok(t.label + ' / blank: no orphan " &middot; " separators', !/ &middot; /.test(bl));
  ok(t.label + ' / blank: no dangling "Zelle —"', !/Zelle —\s*</.test(bl));
  ok(t.label + ' / blank: no "For Zelle payments" line', !/For Zelle payments/.test(bl));
  ok(t.label + ' / blank: no dangling "CALL OR TEXT:"', !/CALL OR TEXT:\s*</.test(bl));
}

// Blank tenant through the core header/footer builders (renderHeader /
// renderFooter feed proposal/contract/inspection docs).
console.log('\nDOCGEN RENDER — core header/footer builders (blank vs NBD joins)');
const dgBlankFull = loadFullDocGen(BLANK_TENANT);
const blHdr = dgBlankFull.renderHeader({});
const blFtr = dgBlankFull.renderFooter({});
ok('blank renderHeader: no orphan &nbsp;|&nbsp;', !/&nbsp;\|&nbsp;/.test(blHdr));
ok('blank renderHeader: no empty <img src="">', !/src=""/.test(blHdr));
ok('blank renderFooter: no orphan &nbsp;|&nbsp;', !/&nbsp;\|&nbsp;/.test(blFtr));

// ── NBD byte-identity pins: every join separator must still render for
// NBD exactly as before (all NBD fields are set, so filter(Boolean)
// keeps all parts and join reproduces the original strings). ──
const nbdInv = renderType(NBD_BRAND, 'renderInvoice', BASE);
ok('NBD invoice: still lists "Zelle — info@nobigdealwithjoedeal.com"', /Zelle — info@nobigdealwithjoedeal\.com/.test(nbdInv));
ok('NBD invoice: footer keeps " &middot; " joins', / &middot; /.test(nbdInv));
const dgNbdFull = loadFullDocGen(NBD_BRAND);
ok('NBD renderHeader: keeps &nbsp;|&nbsp; joins', /&nbsp;\|&nbsp;/.test(dgNbdFull.renderHeader({})));
ok('NBD renderFooter: keeps &nbsp;|&nbsp; joins', /&nbsp;\|&nbsp;/.test(dgNbdFull.renderFooter({})));
const nbdHang = renderType(NBD_BRAND, 'renderDoorHanger', BASE);
ok('NBD door hanger: keeps "CALL OR TEXT: (859) 420-7382"', /CALL OR TEXT: \(859\) 420-7382/.test(nbdHang));
const nbdPay = renderType(NBD_BRAND, 'renderPaymentAgreement', Object.assign({ totalAmount: 12500, depositAmount: 4000, progressAmount: 4500, finalAmount: 4000 }, BASE));
ok('NBD payment agreement: keeps "For Zelle payments" term', /For Zelle payments, send to <strong>info@nobigdealwithjoedeal\.com<\/strong>/.test(nbdPay));

// ════════════════════════════════════════════════════════════════════
// STORM HISTORY REPORT — populated-data branch. The two DOC_TYPES passes
// above only exercise the "unavailable" branch (BASE carries no
// `stormReport`); this proves the real success path — the one every
// generated document actually shows once _attachStormHistory() (in
// document-generator.js) has resolved live NOAA data — renders the
// summary stats and event table, and HTML-escapes a hostile city name
// rather than injecting it.
// ════════════════════════════════════════════════════════════════════
console.log('\nDOCGEN RENDER — storm_history_report (populated data)');
const STORM_DATA = Object.assign({}, BASE, {
  stormReport: {
    years: 5, radiusMi: 30, maxHail: 1.75, source: 'NWS Local Storm Reports (NOAA) via Iowa Environmental Mesonet',
    counts: { total: 3, hail: 2, wind: 1, tornado: 0, stormDays: 2 },
    events: [
      { date: '2025-05-12T18:00:00Z', type: 'hail', magnitude: 1.75, unit: 'in', distanceMi: 2.1, severity: 'severe', city: '<script>alert(1)</script>' },
      { date: '2024-06-03T20:00:00Z', type: 'wind', magnitude: 62, unit: 'mph', distanceMi: 5.4, severity: 'significant', city: 'Milford' },
      { date: '2023-04-01T15:00:00Z', type: 'wind', magnitude: 40, unit: 'mph', distanceMi: 8.0, severity: 'minor', city: 'Batavia' },
    ],
  },
});
const stormPop = renderType(NBD_BRAND, 'renderStormHistoryReport', STORM_DATA);
ok('storm (populated): renders HTML (no error)', typeof stormPop === 'string' && stormPop.indexOf('RENDER_ERROR') !== 0);
ok('storm (populated): shows total event count', /Total Events[\s\S]*?<\/div>|>3</.test(stormPop));
ok('storm (populated): shows max hail size', />1\.75&Prime;</.test(stormPop));
ok('storm (populated): lists the hail event', />hail</.test(stormPop));
ok('storm (populated): shows the NOAA/IEM source line', /Iowa Environmental Mesonet/.test(stormPop));
ok('storm (populated): drops the minor wind event (notable-only filter)', !/Batavia/.test(stormPop));
ok('storm (populated): escapes a hostile city name', !/<script>alert\(1\)<\/script>/.test(stormPop) && /&lt;script&gt;/.test(stormPop));
ok('storm (populated): does not render the "unavailable" branch', !/Storm History Unavailable/.test(stormPop));

// Honesty gate: a report with ZERO recorded events must NOT claim "verified
// storm activity" — this document is meant to be handed to an adjuster, so
// it has to stay accurate at zero the same as it does at a high count.
const STORM_DATA_ZERO = Object.assign({}, BASE, {
  stormReport: {
    years: 5, radiusMi: 30, maxHail: 0, source: 'NWS Local Storm Reports (NOAA) via Iowa Environmental Mesonet',
    counts: { total: 0, hail: 0, wind: 0, tornado: 0, stormDays: 0 },
    events: [],
  },
});
const stormZero = renderType(NBD_BRAND, 'renderStormHistoryReport', STORM_DATA_ZERO);
ok('storm (zero events): renders HTML (no error)', typeof stormZero === 'string' && stormZero.indexOf('RENDER_ERROR') !== 0);
ok('storm (zero events): does NOT claim "Verified storm activity"', !/Verified storm activity near this property/.test(stormZero));
ok('storm (zero events): says no storm reports on file instead', /No storm reports on file/.test(stormZero));

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
