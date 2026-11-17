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
section('8. Work Authorization: cancellation by written notice only');
{
  const h = html('work_authorization', { scopeSummary: 'Roof replacement', email: 'office@example.com' });
  const t = text(h);
  ok('the authorization renders with its cancellation notice (positive control)', h.length > 800 && /Notice of Cancellation/.test(t) && /provide written notice/i.test(t), h.slice(0, 80));
  ok('the notice no longer offers cancelling "by calling" the office', !/by calling/i.test(t), (t.match(/.{0,60}by calling.{0,40}/i) || [''])[0]);
  ok('the three-day cancellation notice itself is unchanged (not rewritten)', /right to cancel this authorization within three \(3\) business\s+days of signing/.test(t));
}

// ═════════════════════════════════════════════════════════════════════════
section('9. Permit Application is unregistered from the picker, with a legacy guard');
{
  ok('the picker/registry no longer lists "permit"', !Object.prototype.hasOwnProperty.call(DG.DOCUMENT_TYPES, 'permit'));
  ok('no registered type is named "Permit Application"', !Object.keys(DG.DOCUMENT_TYPES).some((k) => /Permit Application/i.test(DG.DOCUMENT_TYPES[k].name)));
  ok('a neighbouring type is still registered (positive control)', !!DG.DOCUMENT_TYPES.supplement_request);
  const old = html('permit', { permitNumber: 'P-77' });
  ok('an old saved doc of type "permit" does not crash: getHTML still returns a page', old.length > 400 && old.indexOf('RENDER_ERROR') !== 0, old.slice(0, 80));
  ok('...and that page still carries the old fields (positive control)', /P-77/.test(old));
  ok('...and the title still reads "Permit Application"', /Permit Application/.test(old));
  ok('an unknown type is still refused (the guard is not a catch-all)', DG.getHTML('no_such_type', {}) === null);
}

// ═════════════════════════════════════════════════════════════════════════
section('10. Neighborhood Mailer: no neighbor address, no fixed stats, the tenant\'s own service area');
{
  const NBD_AREA = 'Greater Cincinnati & Northern Kentucky';
  const h = html('neighborhood_mailer', { neighborhoodName: 'Maple Ridge', projectAddress: '742 Evergreen Terrace', companyProfile: { serviceArea: NBD_AREA } });
  const t = text(h);
  ok('the mailer renders (positive control)', h.length > 800 && /Maple Ridge/.test(t) && /Schedule Your Free Inspection/.test(t), h.slice(0, 80));
  ok('a past customer\'s street address is not printed', !/742 Evergreen/.test(h) && !/Your neighbor at/i.test(t));
  ok('the fixed stat tiles are gone (5-star rating, 100% satisfaction, 0 cost)', !/Customer Rating|Satisfaction|Cost for Inspection|5★|100%/.test(t), (t.match(/.{0,30}(Customer Rating|Satisfaction|Cost for Inspection).{0,20}/) || [''])[0]);
  ok('the footer carries the profile service area, not "Lexington"', t.indexOf(NBD_AREA) !== -1 && !/Lexington/.test(t));
  const none = text(html('neighborhood_mailer', { neighborhoodName: 'Maple Ridge', companyProfile: {} }));
  ok('with no service area on file the footer prints no region at all', /Fully Insured/.test(none) && !/Lexington|Surrounding Areas/.test(none));
  const oaks = loadEnv({ brand: { legalName: 'Oaks Roofing', seal: 'OAKS', colors: {}, contact: {} } });
  const oh = text(oaks.dg.getHTML('neighborhood_mailer', { neighborhoodName: 'Maple Ridge', companyProfile: { serviceArea: 'Butler County, OH' } }) || '');
  ok('another company\'s mailer prints its own service area', /Butler County, OH/.test(oh) && !/Lexington/.test(oh));
}

// ═════════════════════════════════════════════════════════════════════════
section('11. Door Hanger: no claims fallback, no "nearby" claim, no Warranty-Backed');
{
  const h = html('door_hanger', { companyProfile: { services: [] } });
  const t = text(h);
  ok('the hanger renders (positive control)', h.length > 800 && /Our Services/.test(t) && /Fully Insured/.test(t), h.slice(0, 80));
  ok('the fallback "Insurance Claims — handled start to finish" row is gone', !/Insurance Claims|handled start to finish/i.test(t));
  ok('the fallback roofing/siding/gutters rows still print (positive control)', /Roofing/.test(t) && /Gutters/.test(t));
  ok('"Our crew is working on a project nearby" does not print without a real nearby job', !/working on a project nearby/i.test(t));
  const near = text(html('door_hanger', { companyProfile: { services: [] }, nearbyJobAddress: '12 Elm St' }));
  ok('with a real nearby-job address supplied the sentence still prints', /working on a project nearby/i.test(near));
  ok('"Warranty-Backed" is gone from the footer badge line, "Fully Insured" stays', !/Warranty-Backed/i.test(t) && /Fully Insured/.test(t));
  const f = env.pf.DOC_SCHEMAS.door_hanger.sections[0].fields.filter((x) => x.key === 'services')[0];
  ok('the pre-flight default services string no longer lists "Insurance claims"', !!f && !/insurance/i.test(String(env.pf._resolveFieldValue(f, {}))), f && env.pf._resolveFieldValue(f, {}));
}

// ═════════════════════════════════════════════════════════════════════════
section('12. Company Introduction: no fallback service rows, no "quick approval"');
{
  const h = html('company_intro', { companyProfile: { services: [], financePartner: 'Test Lender' } });
  const t = text(h);
  ok('the introduction renders (positive control)', h.length > 800 && /Schedule Your Free Inspection/.test(t), h.slice(0, 80));
  ok('the hard-coded "Full insurance claim management" Storm Damage row is gone', !/insurance claim management/i.test(t));
  ok('with no profile services there are no service cards at all', !/class="svc-card"/.test(h) && !/Our Services/.test(t));
  ok('the financing blurb still prints (positive control)', /Test Lender/.test(t) && /affordable monthly payments/i.test(t));
  ok('"quick approval" is gone from it', !/quick approval/i.test(t));
  const real = text(html('company_intro', { companyProfile: { services: [{ icon: 'x', name: 'Roofing', desc: 'Replacements and repairs' }] } }));
  ok('services the profile lists still print', /Roofing/.test(real) && /Replacements and repairs/.test(real));
  const typed = text(html('company_intro', { companyProfile: { services: [] }, services: 'Roofing, Gutters' }));
  ok('services the rep types still print', /Roofing/.test(typed) && /Gutters/.test(typed));
}

// ═════════════════════════════════════════════════════════════════════════
section('13. The legacy "negotiate with my insurance company" authorization stays gone');
{
  const ui = fs.readFileSync(path.join(JS, 'dashboard-ui.js'), 'utf8');
  ok('dashboard-ui.js carries neither the negotiate nor the paid-directly sentence', !/negotiate with my insurance company/i.test(ui) && !/receive payment directly from the insurance carrier/i.test(ui));
}

// ═════════════════════════════════════════════════════════════════════════
section('14. Testimonial Sheet: no computed average or % recommend, no default 5 stars');
{
  const stars = (h) => (text(h).match(/★/g) || []).length;
  const none = html('testimonial_sheet', { testimonial1: 'Crew was on time and tidy. - A. Homeowner' });
  const rated = html('testimonial_sheet', { testimonial1: 'Crew was on time and tidy. - A. Homeowner', rating1: '4' });
  ok('the sheet renders the rep\'s quote (positive control)', none.length > 800 && /Crew was on time/.test(text(none)), none.slice(0, 80));
  ok('no "Average Rating" stat', !/Average Rating/i.test(text(none)) && !/Average Rating/i.test(text(rated)));
  ok('no "Would Recommend" percentage', !/Would Recommend/i.test(text(none)) && !/\d+%/.test(text(rated)));
  ok('a quote with no rating prints no stars (it is no longer a 5)', stars(none) === 0, String(stars(none)));
  ok('a rating the rep enters still prints that many stars', stars(rated) === 4, String(stars(rated)));
  const bad = html('testimonial_sheet', { testimonial1: 'Fine.', rating1: '9' });
  ok('an out-of-range rating is ignored, not turned into 5', stars(bad) === 0, String(stars(bad)));
  const five = html('testimonial_sheet', { testimonial1: 'Fine.', rating1: 5 });
  ok('a real 5 still prints 5 stars', stars(five) === 5, String(stars(five)));
}

// ═════════════════════════════════════════════════════════════════════════
section('15. renderGenericDoc: no signature block');
{
  const h = DG.renderGenericDoc({ _documentType: 'permit', address: '12 Elm St', permitNumber: 'P-77', homeownerName: 'Test Homeowner' });
  ok('the fallback still prints the real fields (positive control)', /12 Elm St/.test(h) && /P-77/.test(h) && /Customer Information/.test(h));
  ok('it no longer prints a "Homeowner Signature" line', !/Homeowner Signature/.test(h));
  ok('it no longer prints a "Contractor Signature" line', !/Contractor Signature/.test(h));
  ok('it carries no signature block markup at all', !/class="sig-block"|class="sig-line"/.test(h.replace(/<style[\s\S]*?<\/style>/gi, '')));
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
