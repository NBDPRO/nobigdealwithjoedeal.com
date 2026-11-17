/**
 * tests/template-honesty-removals-2026-11-17.test.js — removal-only honesty
 * fixes to customer-facing document templates (Jo, 2026-11-17; Q13 + Q30 of
 * documentation/projects/TEMPLATE-DEEP-SWEEP-2026-11-17.md, Part 5A/5B/5C).
 *
 * Every change under test is a DELETION or a neutralisation: a blank or
 * neutral default, an unticked box, a section that hides when empty. Nothing
 * here asserts new legal wording. Each renderer is loaded the way the browser
 * loads it (vm sandbox) and fed real input; the only source-text checks are
 * for the two warranty surfaces that need a DOM or a Handlebars engine.
 *
 *    1  "Backed personally by Joe Deal" gone (CRM wizard + server .hbs)
 *    2  Inspection Report (Homeowner): no hard-coded urgency, "Inspector"
 *    3  Pre-flight: no pre-filled assessment / damage notes (still required)
 *    4  Supplement Request: no default justification, boxes unticked
 *    5  Material Delivery: no invented product list
 *    6  Financing Options: no benefit tiles, no invented $10,000
 *    7  Certificate of Completion: checklist unticked and rep-settable
 *    8  Work Authorization: cancel by written notice only
 *    9  Permit Application unregistered from the picker (legacy guard)
 *   10  Neighborhood Mailer: no neighbor address, no fixed stats, own footer
 *   11  Door Hanger: no claims fallback, no "nearby" claim, no Warranty-Backed
 *   12  Company Intro: no fallback service rows, no "quick approval"
 *   13  Dead legacy "negotiate with my insurance company" text stays gone
 *   14  Testimonial Sheet: no computed average / % recommend, no default 5
 *   15  renderGenericDoc: no signature block
 *
 * Run: node tests/template-honesty-removals-2026-11-17.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs/pro/js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Sandbox: the same load order the CRM page uses ──────────────────────
function loadEnv(opts) {
  opts = opts || {};
  const brand = opts.brand || { legalName: 'No Big Deal Home Solutions', colors: {}, contact: { mailingAddress: '4400 Test Pike, Cincinnati, OH 45202' } };
  const win = { _brand: () => brand };
  if (opts.companyProfile) win._companyProfile = opts.companyProfile;
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sb = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON, Intl,
  };
  vm.createContext(sb);
  const files = ['ky-insurance-law.js', 'deposit-rule.js', 'estimate-config.js', 'tenant-rules.js', 'document-generator.js',
    'document-generator-templates.js', 'document-generator-library.js', 'doc-preflight.js'];
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
  return { win, dg: win.NBDDocGen, pf: win.DocPreflight };
}
const env = loadEnv();
const DG = env.dg;
function html(type, data) {
  try { return DG.getHTML(type, Object.assign({ homeownerName: 'Test Homeowner', address: '1 Test St' }, data || {})) || ''; }
  catch (e) { return 'RENDER_ERROR ' + e.message; }
}
const text = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

ok('the generator and templates load (positive control)', !!DG && typeof DG.getHTML === 'function' && typeof DG.renderSupplementRequest === 'function');

// ═════════════════════════════════════════════════════════════════════════
section('1. "Backed personally by Joe Deal" is gone');
{
  let Handlebars = null, RENDER = null;
  try {
    Handlebars = require(path.join(ROOT, 'functions/node_modules/handlebars'));
    RENDER = require(path.join(ROOT, 'functions/render-pdf.js'));
  } catch (e) { ok('functions/ deps load (handlebars, render-pdf.js)', false, e && e.message); }
  if (Handlebars && RENDER) {
    RENDER._registerPartialsOnce(); RENDER._registerHelpersOnce();
    const W = Handlebars.compile(fs.readFileSync(path.join(ROOT, 'functions/print/templates/warranty.hbs'), 'utf8'));
    const base = { owner: 'Jane Smith', address: '1 Elm St', dateFormatted: 'November 17, 2026', work: 'Roof replacement', certNumber: 'X-1',
      preparedFor: { name: 'Jane Smith', address: '1 Elm St' }, preparedBy: { name: 'Rep' }, projectMeta: [],
      tier: 'standard', tierLabel: 'Standard', tierLabelLong: 'Standard', tierTerms: 'x' };
    const nbd = text(W(Object.assign({}, base, { company: { footerName: 'No Big Deal Home Solutions', isNbd: true, seal: 'NBD' } })));
    const oaks = text(W(Object.assign({}, base, { company: { footerName: 'Oaks Roofing', isNbd: false, seal: 'OAKS' } })));
    ok('the server warranty PDF (NBD) no longer says Joe Deal backs it personally', !/personally/i.test(nbd), (nbd.match(/.{0,40}personally.{0,40}/i) || [''])[0]);
    ok('...and still prints a plain "Backed by" line (positive control)', /Backed by No Big Deal Home Solutions/.test(nbd), nbd.slice(-400));
    ok('another company server warranty PDF keeps its own "Backed by" line', /Backed by Oaks Roofing/.test(oaks));
  }
  const crm = ['docs/pro/js/warranty-cert.js', 'docs/pro/js/document-generator.js', 'docs/pro/js/document-generator-templates.js',
    'docs/pro/js/document-generator-library.js', 'docs/pro/js/doc-preflight.js', 'functions/render-pdf.js', 'functions/print/templates/warranty.hbs']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  ok('no CRM wizard, template or server file carries "Backed personally" (one scan of every warranty surface)', !/Backed personally/i.test(crm));
}

// ═════════════════════════════════════════════════════════════════════════
section('2. Inspection Report (Homeowner): no hard-coded urgency, no "Certified" signer');
{
  const h = html('inspectionHomeowner', { overallDescription: 'Granule loss on the south slope.' });
  ok('the report renders (positive control)', h.length > 800 && h.indexOf('RENDER_ERROR') !== 0 && /Granule loss on the south slope/.test(h), h.slice(0, 80));
  ok('no "immediate attention ... prevent further water damage" sentence on a report that never said it', !/immediate attention|prevent further water damage/i.test(text(h)));
  ok('the Next Steps contact line still prints (positive control)', /Next Steps/.test(h));
  ok('the signer is "Inspector", not "Certified NBD Inspector"', /Inspector/.test(text(h)) && !/Certified/i.test(text(h)));
  const hi = html('inspectionInsurance', { claimNumber: 'C-1', damageNotes: 'Creased shingles on the west slope.' });
  ok('the insurance report renders (positive control)', hi.length > 800 && hi.indexOf('RENDER_ERROR') !== 0 && /Creased shingles/.test(hi), hi.slice(0, 80));
  ok('its signer is "Damage Assessor", not "Certified NBD Damage Assessor"', /Damage Assessor/.test(text(hi)) && !/Certified/i.test(text(hi)));
  const oaks = loadEnv({ brand: { legalName: 'Oaks Roofing', seal: 'OAKS', colors: {}, contact: {} } });
  const ho = oaks.dg.getHTML('inspectionHomeowner', { homeownerName: 'T', address: '1 Test St' }) || '';
  ok('another company\'s homeowner report carries no "Certified" signer either', ho.length > 800 && !/Certified/i.test(text(ho)));
}

// ═════════════════════════════════════════════════════════════════════════
section('3. Pre-flight: the assessment and damage notes start empty, and stay required');
{
  const field = (type, key) => {
    const sch = env.pf.DOC_SCHEMAS[type]; let f = null;
    sch.sections.forEach((s) => s.fields.forEach((x) => { if (x.key === key) f = x; }));
    return f;
  };
  const oa = field('inspectionHomeowner', 'overallDescription');
  const dn = field('inspectionInsurance', 'damageNotes');
  ok('both fields exist (positive control)', !!oa && !!dn);
  ok('Overall Assessment still required', oa && oa.required === true);
  ok('Damage Description still required', dn && dn.required === true);
  ok('Overall Assessment starts empty (no "signs of wear consistent with age" pre-fill)', oa && String(env.pf._resolveFieldValue(oa, {}) || '') === '');
  ok('Damage Description starts empty (no "wind/impact damage ... puncture marks" pre-fill)', dn && String(env.pf._resolveFieldValue(dn, {}) || '') === '');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. Supplement Request: no default justification, documentation boxes unticked');
{
  const base = { insuranceCompany: 'Test Mutual', claimNumber: 'CL-1', policyNumber: 'P-1', dateOfLoss: '2026-10-01', originalApproved: '9000.00',
    supplementItems: [{ item: 'Replace decking', qty: 2, unit: 'SH', price: 80 }] };
  const h = html('supplement_request', base);
  ok('the supplement renders its line items (positive control)', h.length > 800 && /Replace decking/.test(h) && /SUPPLEMENT TOTAL/.test(h), h.slice(0, 80));
  ok('no default "additional damage was discovered ... pre-loss condition" justification', !/additional damage was discovered|pre-loss condition|compliance with local building codes/i.test(text(h)));
  ok('with no justification typed the Justification section is not printed', !/Justification/.test(text(h)));
  const typed = html('supplement_request', Object.assign({}, base, { justification: 'Two sheets of decking were soft under the felt.' }));
  ok('a justification the rep types still prints', /Two sheets of decking were soft/.test(text(typed)) && /Justification/.test(text(typed)));
  const boxes = (s) => (String(s).match(/<input type="checkbox"[^>]*>/g) || []);
  ok('five documentation boxes print (positive control)', boxes(h).length === 5, String(boxes(h).length));
  ok('by default none of them is ticked', boxes(h).every((b) => !/\bchecked\b/.test(b)), boxes(h).join(' '));
  const some = html('supplement_request', Object.assign({}, base, { docPhotos: true, docCodeCompliance: 'true' }));
  const sb = boxes(some);
  ok('the rep can tick the photographs box and the code box, and only those', sb.filter((b) => /\bchecked\b/.test(b)).length === 2 && /\bchecked\b/.test(sb[0]) && /\bchecked\b/.test(sb[3]) && !/\bchecked\b/.test(sb[1]), sb.join(' '));
  const sch = env.pf.DOC_SCHEMAS.supplement_request; const keys = [];
  sch.sections.forEach((s) => s.fields.forEach((f) => keys.push(f.key + ':' + f.type)));
  ok('the pre-flight modal offers the five boxes as rep-set checkboxes', ['docPhotos', 'docRevisedScope', 'docManufacturerSpecs', 'docCodeCompliance', 'docThirdParty'].every((k) => keys.indexOf(k + ':checkbox') !== -1), keys.join(','));
}

// ═════════════════════════════════════════════════════════════════════════
section('5. Material Delivery: no invented product list');
{
  const h = html('material_delivery', {});
  const t = text(h);
  ok('the delivery notice renders (positive control)', h.length > 800 && /Materials Being Delivered/.test(t), h.slice(0, 80));
  ok('no invented products (GAF Timberline, FeltBuster, Cobra, Ice & Water, drip edge, nails)', !/GAF|Timberline|FeltBuster|Cobra|Ice & Water|Drip Edge|Pipe Boot|Starter Strip|Roofing Nails|bundles/i.test(t), (t.match(/.{0,30}(GAF|Timberline|Drip Edge).{0,30}/i) || [''])[0]);
  ok('a neutral "Materials list to be confirmed" row prints instead', /Materials list to be confirmed/.test(t));
  const empty = text(html('material_delivery', { materials: [] }));
  ok('an empty materials list gets the same neutral row, not a blank table', /Materials list to be confirmed/.test(empty) && !/GAF/.test(empty));
  const real = text(html('material_delivery', { materials: [{ item: 'TAMKO Heritage shingles', qty: '28 bundles', notes: 'Rustic Black' }] }));
  ok('materials the rep passes print, with no neutral row beside them', /TAMKO Heritage shingles/.test(real) && /28 bundles/.test(real) && !/Materials list to be confirmed/.test(real));
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Financing Options: no benefit tiles, no invented $10,000');
{
  const h = html('financing_options', {});
  const t = text(h);
  ok('the financing sheet renders (positive control)', h.length > 800 && /Choose Your Plan/.test(t) && /set by your lender/.test(t), h.slice(0, 80));
  ok('the four unconditional benefit claims are gone', !/No money down|Fixed monthly payments|No prepayment penalties|Quick and easy application/i.test(t));
  ok('the "Benefits of Financing" heading went with them', !/Benefits of Financing/.test(t));
  ok('no invented $10,000 project total', !/10,000/.test(t));
  ok('with no real total the Project Total box is hidden', !/Project Total/i.test(t));
  const real = text(html('financing_options', { totalPrice: '$12,500.00' }));
  ok('a real total passed in still prints in the Project Total box', /Project Total/i.test(real) && /\$12,500\.00/.test(real));
  const apr = text(html('financing_options', { companyProfile: { financingTiers: [{ months: 12, apr: 8 }] } }));
  ok('a tenant APR with no total prints no computed $/mo figure', !/\/mo/.test(apr) && !/\$0\.00/.test(apr), (apr.match(/.{0,40}(\/mo|\$0\.00).{0,20}/) || [''])[0]);
}

// ═════════════════════════════════════════════════════════════════════════
section('7. Certificate of Completion: the checklist starts unticked and the rep sets it');
{
  const LABELS = ['All materials installed per manufacturer specifications', 'Flashing and waterproofing completed at all penetrations',
    'Ventilation system installed and verified', 'Property cleaned and all debris removed', 'Magnetic nail sweep of entire property completed',
    'Final quality inspection completed by crew lead'];
  const WALK = 'Homeowner walkthrough and approval obtained';
  const ticked = (h) => (String(h).match(/class="check-icon check-yes"/g) || []).length;
  const glyphs = (h) => (String(h).match(/class="check-icon[^"]*">\s*&#10003;/g) || []).length;
  const d = html('certificate_of_completion', { scopeSummary: 'Roof replacement' });
  const t = text(d);
  ok('the certificate renders (positive control)', d.length > 800 && /Completion Verification/.test(t) && /Roof replacement/.test(t), d.slice(0, 80));
  ok('by default no checklist item is ticked', ticked(d) === 0, String(ticked(d)));
  ok('by default no check mark glyph prints either', glyphs(d) === 0, String(glyphs(d)));
  ok('the six item labels still print, unticked', LABELS.every((l) => t.indexOf(l) !== -1));
  ok('the "walkthrough and approval obtained" line does not print unless that item is checked', t.indexOf(WALK) === -1);
  const all = html('certificate_of_completion', { chkMaterials: true, chkFlashing: true, chkVentilation: true, chkCleanup: true, chkNailSweep: true, chkQualityInspection: true, chkWalkthrough: 'true' });
  ok('the rep can tick all seven, and then the walkthrough line prints', ticked(all) === 7 && glyphs(all) === 7 && text(all).indexOf(WALK) !== -1, String(ticked(all)));
  const one = html('certificate_of_completion', { chkNailSweep: true });
  ok('ticking one item ticks only that one', ticked(one) === 1 && /Magnetic nail sweep/.test(text(one)));
  const sch = env.pf.DOC_SCHEMAS.certificate_of_completion; const keys = [];
  sch.sections.forEach((s) => s.fields.forEach((f) => keys.push(f.key + ':' + f.type)));
  ok('the pre-flight modal offers the seven as rep-set checkboxes', ['chkMaterials', 'chkFlashing', 'chkVentilation', 'chkCleanup', 'chkNailSweep', 'chkQualityInspection', 'chkWalkthrough'].every((k) => keys.indexOf(k + ':checkbox') !== -1), keys.join(','));
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
