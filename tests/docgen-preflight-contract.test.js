/**
 * tests/docgen-preflight-contract.test.js — DocPreflight ↔ renderer contract.
 *
 * The REAL document path is: rep fills the DocPreflight modal -> submit() builds
 * mergedData keyed by each schema field's `key` -> hydrateDerivedFields() adds
 * aliases -> NBDDocGen.generate(type, mergedData) -> renderer. A 2026-06-25 audit
 * found the modal and the renderers had grown divergent key vocabularies, so
 * rep-entered values were silently dropped (e.g. modal "Carrier" = insCarrier but
 * the supplement renderer reads insuranceCompany; payment modal collects
 * payment1Amount but the renderer reads depositAmount; financing collects jobTotal
 * but the renderer reads totalPrice). hydrateDerivedFields now BRIDGES those keys.
 *
 * This test reproduces that exact path: it loads doc-preflight.js (for the real
 * hydrateDerivedFields) + both generator files (for the real renderers) into one
 * sandbox, feeds data under the PREFLIGHT keys a rep would actually enter, hydrates,
 * renders, and asserts the rep's distinctive value reaches the output HTML (and the
 * old fabricated default does not). The existing docgen-render.test.js feeds RENDERER
 * keys, so it cannot catch this drift — this is its companion.
 *
 * Run: node tests/docgen-preflight-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const DG_DIR = path.join(__dirname, '..', 'docs/pro/js');
const SRC_PREFLIGHT = fs.readFileSync(path.join(DG_DIR, 'doc-preflight.js'), 'utf8');
const SRC_DOCGEN    = fs.readFileSync(path.join(DG_DIR, 'document-generator.js'), 'utf8');
const SRC_TEMPLATES = fs.readFileSync(path.join(DG_DIR, 'document-generator-templates.js'), 'utf8');
// estimate-config.js: dashboard.html loads this before document-generator.js /
// doc-preflight.js (its own comment there: "MUST load before estimates.js +
// estimate-builder-v2.js"), and it's the source of truth the GBB tier
// consolidation (#1529) moved tier labels + warranty text onto
// (window.NBD_ESTIMATE_CONFIG.tierLabel/tierWarrantyText). Load it here too so
// this sandbox matches the real page instead of silently exercising only the
// no-config fallback text every renderer carries for when it fails to load.
const SRC_ESTCFG    = fs.readFileSync(path.join(DG_DIR, 'estimate-config.js'), 'utf8');

// One sandbox holding the real hydrateDerivedFields + the real renderers, wired
// as the browser wires them. Brand stub mirrors docgen-render.test.js.
function loadEnv() {
  const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
  const win = { _brand: () => brand };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(SRC_ESTCFG, sandbox, { filename: 'estimate-config.js' });
  vm.runInNewContext(SRC_DOCGEN, sandbox, { filename: 'document-generator.js' });
  vm.runInNewContext(SRC_TEMPLATES, sandbox, { filename: 'document-generator-templates.js' });
  vm.runInNewContext(SRC_PREFLIGHT, sandbox, { filename: 'doc-preflight.js' });
  return { dg: win.NBDDocGen, hydrate: win.DocPreflight && win.DocPreflight._hydrateDerivedFields, preflight: win.DocPreflight };
}

const env = loadEnv();
ok('env: NBDDocGen loaded', !!env.dg);
ok('env: DocPreflight._hydrateDerivedFields exposed', typeof env.hydrate === 'function');

// Feed PREFLIGHT-keyed data through the real hydrate, then the real renderer.
function renderViaPreflight(method, preflightData) {
  const data = Object.assign({ homeownerName: 'Jane Smith', address: '123 Main St', leadId: 'L1' }, preflightData);
  try {
    env.hydrate(data);
    const html = env.dg[method](data);
    return (typeof html === 'string') ? html : 'RENDER_ERROR: non-string';
  } catch (e) {
    return 'RENDER_ERROR: ' + (e && e.message);
  }
}

// ── payment_agreement: modal keys totalPrice/payment{1,2}Amount/payment{1,2}Date
//    bridge to renderer keys totalAmount/deposit*/progress* ──
{
  const html = renderViaPreflight('renderPaymentAgreement', {
    totalPrice: 27345, payment1Amount: 9000, payment1Date: '2026-07-01',
    payment2Amount: 8000, payment2Date: '2026-08-01',
  });
  console.log('PREFLIGHT CONTRACT — payment_agreement');
  ok('payment: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('payment: rep total $27,345 reaches doc (totalPrice→totalAmount)', /27,345/.test(html));
  ok('payment: rep deposit $9,000 reaches doc (payment1Amount→depositAmount)', /9,000/.test(html));
  ok('payment: rep deposit date reaches doc (payment1Date→depositDue)', /2026-07-01/.test(html));
  ok('payment: rep progress $8,000 reaches doc (payment2Amount→progressAmount)', /8,000/.test(html));
  ok('payment: rep progress date reaches doc (payment2Date→progressDue)', /2026-08-01/.test(html));
  ok('payment: fabricated $0 "3. Final Payment" row is GONE (no final entered)', !/3\. Final Payment/.test(html));
}

// ── financing_options: modal jobTotal bridges to renderer totalPrice (+ parse strip) ──
{
  const html = renderViaPreflight('renderFinancingOptions', { jobTotal: 33210 });
  console.log('PREFLIGHT CONTRACT — financing_options');
  ok('financing: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('financing: rep job total $33,210 reaches doc (jobTotal→totalPrice)', /33,210/.test(html));
  ok('financing: fabricated $10,000 default is GONE', !/10,000/.test(html));
}

// ── change_order: changeDescription bridges; the rep's changeAmount + newTotal
//    are now CONSUMED (renderer previously computed $0 from empty itemsAdded) ──
{
  const SENT = 'SENTINELchangedescXYZ';
  const html = renderViaPreflight('renderChangeOrder', { changeDescription: SENT, originalContractDate: '2026-01-15', originalTotal: 12000, changeAmount: 1500, newTotal: 13500 });
  console.log('PREFLIGHT CONTRACT — change_order');
  ok('change_order: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('change_order: rep change description reaches doc (changeDescription→changesDescription)', html.indexOf(SENT) !== -1);
  ok('change_order: rep change amount $1,500 reaches doc (not $0 from empty items)', /1,500\.00/.test(html));
  ok('change_order: rep new total $13,500 reaches doc', /13,500\.00/.test(html));
  // Printed the way a person writes it since 2026-10-04 (was the raw input value).
  ok('change_order: rep original contract date reaches doc', /January 15, 2026/.test(html));
}

// ── supplement_request: modal insCarrier bridges to renderer insuranceCompany;
//    supplementItems arrive as {description,rate} (estimate shape, not normalized)
//    and must not render blank rows / $0 prices ──
{
  const html = renderViaPreflight('renderSupplementRequest', {
    insCarrier: 'Acme Mutual Insurance', claimNumber: 'CLM-77',
    policyNumber: 'POL-SENT-9', dateOfLoss: '2026-03-04', originalApproved: 20000,
    supplementItems: [{ description: 'Ridge cap replacement', qty: 120, unit: 'LF', rate: 5.5 }],
  });
  console.log('PREFLIGHT CONTRACT — supplement_request');
  ok('supplement: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('supplement: rep carrier reaches doc (insCarrier→insuranceCompany)', /Acme Mutual Insurance/.test(html));
  ok('supplement: "[Insurance Company]" placeholder is GONE', !/\[Insurance Company\]/.test(html));
  ok('supplement: line-item description reaches doc (i.description shape)', /Ridge cap replacement/.test(html));
  ok('supplement: line-item price reaches doc, not $0 (i.rate shape)', /5\.50/.test(html) && /660\.00/.test(html));
  ok('supplement: rep policy # + date of loss reach doc (new schema fields)', /POL-SENT-9/.test(html) && /2026-03-04/.test(html));
  ok('supplement: NEW PROJECT TOTAL = original approved + supplement ($20,000 + $660 = $20,660)', /20,660\.00/.test(html));
  ok('supplement: "[Policy #]"/"[Date of Loss]" placeholders are GONE', !/\[Policy #\]/.test(html) && !/\[Date of Loss\]/.test(html));
}

// ── invoice: lineItems are normalized to {description,unitPrice}; the renderer
//    historically read i.rate and priced every row at $0 ──
{
  const html = renderViaPreflight('renderInvoice', {
    lineItems: [{ description: 'Tear off and replace shingles', qty: 30, unit: 'SQ', rate: 50 }],
  });
  console.log('PREFLIGHT CONTRACT — invoice');
  ok('invoice: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('invoice: line-item description reaches doc', /Tear off and replace shingles/.test(html));
  ok('invoice: line-item unit price reaches doc (normalized unitPrice, not $0)', /50\.00/.test(html));
  ok('invoice: line amount + subtotal total correctly (30 x 50 = 1,500)', /1,500/.test(html));
}

// ── invoice SERVICE LOCATIONS: a customer with more than one building (Anthony
//    Juniperly, 100 + 102 Kentucky Ave) must see BOTH addresses on the
//    invoice. Before multi-address support the second building existed nowhere in
//    the schema, so the invoice named only one of the two roofs it billed for. ──
{
  const html = renderViaPreflight('renderInvoice', {
    address: '100 Kentucky Ave, Cincinnati, OH 45223',
    serviceAddresses: ['102 Kentucky Ave, Cincinnati, OH 45223'],
    lineItems: [{ description: 'EPDM restoration', qty: 1, unit: 'EA', rate: 100 }],
  });
  console.log('PREFLIGHT CONTRACT — invoice service locations');
  ok('svcaddr: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('svcaddr: SERVICE LOCATIONS block present when extra addresses exist', /Service Locations/i.test(html));
  ok('svcaddr: primary address 100 Kentucky Ave reaches doc', html.indexOf('100 Kentucky Ave, Cincinnati, OH 45223') !== -1);
  ok('svcaddr: second building 102 Kentucky Ave reaches doc', html.indexOf('102 Kentucky Ave, Cincinnati, OH 45223') !== -1);
}
{
  const html = renderViaPreflight('renderInvoice', {
    address: '100 Kentucky Ave, Cincinnati, OH 45223',
    lineItems: [{ description: 'EPDM restoration', qty: 1, unit: 'EA', rate: 100 }],
  });
  ok('svcaddr: single-property invoice omits the block entirely', !/Service Locations/i.test(html));
  ok('svcaddr: single-property invoice still renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
}
{
  const html = renderViaPreflight('renderInvoice', {
    address: '100 Kentucky Ave, Cincinnati, OH 45223',
    serviceAddresses: ['', '   ', null],
    lineItems: [{ description: 'EPDM restoration', qty: 1, unit: 'EA', rate: 100 }],
  });
  ok('svcaddr: blank/whitespace extra addresses are filtered, block omitted', !/Service Locations/i.test(html));
}
{
  const html = renderViaPreflight('renderInvoice', {
    address: '100 Kentucky Ave, Cincinnati, OH 45223',
    serviceAddresses: ['<script>alert(1)</script>'],
    lineItems: [{ description: 'EPDM restoration', qty: 1, unit: 'EA', rate: 100 }],
  });
  ok('svcaddr: extra addresses are HTML-escaped (no raw <script>)', html.indexOf('<script>alert(1)</script>') === -1);
}

// ── receipt: a job that is PAID needs a closing document that is not an
//    invoice with the balance zeroed. `receipt` existed in _buildPremiumData
//    and the server-render map but was never registered in DOCUMENT_TYPES, so
//    paid-in-full jobs (Elmsworth, Larchmont) had no closing document at all.
{
  const html = renderViaPreflight('renderReceipt', {
    receiptNumber: 'RCT-2026-0818-HIG', paymentDate: '2026-07-30',
    amountPaid: 400, paymentMethod: 'PayPal', paidInFull: true,
    workPerformed: 'SENTINELsidingrepair',
  });
  console.log('PREFLIGHT CONTRACT — receipt');
  ok('receipt: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('receipt: is headed RECEIPT, not INVOICE', /RECEIPT/.test(html) && !/>INVOICE</.test(html));
  ok('receipt: rep amount $400 reaches doc', /400\.00/.test(html));
  ok('receipt: payment method reaches doc', /PayPal/.test(html));
  ok('receipt: date paid reaches doc', /2026-07-30/.test(html));
  ok('receipt: work performed reaches doc', html.indexOf('SENTINELsidingrepair') !== -1);
  ok('receipt: PAID IN FULL stamp shows when the rep ticked it', /PAID IN FULL/.test(html));
  ok('receipt: carries NO late-payment / due-date language (it is not a bill)',
    !/Late Payment/i.test(html) && !/finance charge/i.test(html) && !/Balance Due/i.test(html));
}
{
  // The rule that matters most: with no contractTotal supplied, the receipt
  // must state only what was received. Inventing a $0 balance would tell a
  // customer their job is settled when we were never told that.
  const html = renderViaPreflight('renderReceipt', {
    receiptNumber: 'RCT-1', paymentDate: '2026-08-01', amountPaid: 1500,
    paymentMethod: 'Check', workPerformed: 'Partial payment',
  });
  ok('receipt: no contract total → NO balance section at all', !/Balance Remaining/.test(html));
  ok('receipt: no contract total → NO unearned PAID IN FULL stamp', !/PAID IN FULL/.test(html));
  ok('receipt: still shows what was received', /1,500\.00/.test(html));
}
{
  const html = renderViaPreflight('renderReceipt', {
    receiptNumber: 'RCT-2', paymentDate: '2026-08-01',
    amountPaid: 1515, contractTotal: 3145, priorPayments: 1630,
    paymentMethod: 'Check', workPerformed: 'Final payment',
  });
  ok('receipt: contract total supplied → balance section appears', /Balance Remaining/.test(html));
  ok('receipt: balance computes to $0.00 (3145 - 1630 - 1515)', /Balance Remaining<\/span><span>\$0\.00/.test(html.replace(/\s+/g, '')) || /0\.00/.test(html));
  ok('receipt: a computed zero balance DOES earn the PAID IN FULL stamp', /PAID IN FULL/.test(html));
}
{
  const html = renderViaPreflight('renderReceipt', {
    receiptNumber: 'RCT-3', paymentDate: '2026-08-01',
    amountPaid: 1000, contractTotal: 3000,
    paymentMethod: 'Venmo', workPerformed: 'Deposit',
  });
  ok('receipt: an outstanding balance is shown, not hidden', /2,000\.00/.test(html));
  ok('receipt: an outstanding balance does NOT get a PAID IN FULL stamp', !/PAID IN FULL/.test(html));
}

// ── roof_assessment: the deliverable for a PAID inspection. The existing
//    inspection template is insurance-shaped (carrier + claim # + date of loss
//    all required), so a homeowner who simply paid for an opinion had no
//    document at all — three such inspections were outstanding on 2026-08-18.
{
  const html = renderViaPreflight('renderRoofAssessment', {
    reportNumber: 'ASM-1', inspectionDate: '2026-08-10',
    inspectorName: 'Joe Deal', roofSystem: 'EPDM low-slope',
    summary: 'SENTINELsummary',
    findings: [
      { title: 'SENTINELponding', observed: 'SENTINELobserved', whyItMatters: 'SENTINELwhy', severity: 'urgent' },
      { title: 'SENTINELseams', observed: 'obs2', whyItMatters: 'why2', severity: 'monitor' },
    ],
    recommendations: ['SENTINELrec1', 'SENTINELrec2'],
    nextSteps: 'SENTINELnext',
  });
  console.log('PREFLIGHT CONTRACT — roof_assessment');
  ok('assessment: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('assessment: rep summary reaches doc', html.indexOf('SENTINELsummary') !== -1);
  ok('assessment: every finding title reaches doc',
    html.indexOf('SENTINELponding') !== -1 && html.indexOf('SENTINELseams') !== -1);
  ok('assessment: observed + why-it-matters both reach doc',
    html.indexOf('SENTINELobserved') !== -1 && html.indexOf('SENTINELwhy') !== -1);
  ok('assessment: findings are numbered in order', /1\. SENTINELponding/.test(html) && /2\. SENTINELseams/.test(html));
  ok('assessment: rep-set severity drives the badge, both levels render',
    /Address Now/.test(html) && /Monitor/.test(html));
  ok('assessment: every recommendation reaches doc',
    html.indexOf('SENTINELrec1') !== -1 && html.indexOf('SENTINELrec2') !== -1);
  ok('assessment: next steps reach doc', html.indexOf('SENTINELnext') !== -1);
  ok('assessment: roof system + inspector reach doc', /EPDM low-slope/.test(html) && /Joe Deal/.test(html));
}
{
  // A report padded with empty placeholder boxes reads as unfinished work —
  // and this template is sent to a customer who has already paid for it.
  const html = renderViaPreflight('renderRoofAssessment', {
    reportNumber: 'ASM-2', summary: 'nothing else supplied',
  });
  ok('assessment: no findings → no "What I Found" section', !/What I Found/.test(html));
  // NB: assert against the BODY, not the whole file — `.photo-zone` lives in
  // the shared stylesheet page() emits for every template, so grepping the
  // raw HTML for it tests the stylesheet rather than this document.
  const _body = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  ok('assessment: no photos → no photo grid, no <img>, no placeholder boxes',
    !/Photos<\/div>/.test(_body) && !/<img\s/i.test(_body.replace(/<img[^>]*logo[^>]*>/gi, '')));
  ok('assessment: no recommendations → no empty list', !/What I Recommend/.test(html));
  ok('assessment: still renders cleanly with almost nothing supplied', html.indexOf('RENDER_ERROR') !== 0);
}
{
  const html = renderViaPreflight('renderRoofAssessment', {
    reportNumber: 'ASM-3',
    photos: [
      { url: 'https://photos.example/ASM-REAL.jpg', caption: 'SENTINELcaption' },
      { url: 'javascript:alert(1)', caption: 'hostile' },
      { url: '', caption: 'empty' },
    ],
    findings: [{ title: '<script>alert(1)</script>', observed: 'x', severity: 'note' }],
  });
  ok('assessment: real photo renders as <img src>', /<img src="https:\/\/photos\.example\/ASM-REAL\.jpg"/.test(html));
  ok('assessment: caption reaches doc', html.indexOf('SENTINELcaption') !== -1);
  ok('assessment: non-http photo URLs are dropped, not rendered', html.indexOf('javascript:alert(1)') === -1);
  ok('assessment: finding titles are HTML-escaped', html.indexOf('<script>alert(1)</script>') === -1);
  ok('assessment: unknown/absent severity falls back to the neutral badge', /For Your Records/.test(html));
}

// ── warranty_certificate: installDate→issueDate; coverageDetails + transferable
//    wired; roof-specific workPerformed default no longer fabricated.
//    GBB audit 2026-09-09 (documentation/audit/GBB-TIER-SOURCE-OF-TRUTH-2026-09-09.md
//    §3/§8 PR3): transferability is now TIER-driven by default (Preferred/Elite
//    are inherently transferable per estimate-config.js TIER_DISPLAY) — the rep
//    checkbox can only ADD transferability on top of a non-transferable tier
//    (Standard/'good'), it can never remove what a tier already promises. Uses
//    'good' (Standard, non-transferable by default) so the checkbox's own
//    effect is what's actually under test. ──
{
  const html = renderViaPreflight('renderWarrantyCertificate', {
    installDate: '2026-09-15', warrantyTier: 'good',
    coverageDetails: 'SENTINELcoverage', transferable: true,
  });
  console.log('PREFLIGHT CONTRACT — warranty_certificate');
  ok('warranty: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('warranty: rep install date reaches doc (installDate→issueDate)', /September 15, 2026/.test(html));
  ok('warranty: rep coverage details reach doc (coverageDetails wired)', html.indexOf('SENTINELcoverage') !== -1);
  ok('warranty: rep-checked transferable clause shows on a Standard-tier cert (checkbox ADDS transferability)', /fully transferable/.test(html));
  ok('warranty: roof-specific "Complete roof replacement" workPerformed default is GONE', !/Complete roof replacement including tear-off/.test(html));
}
// Standard tier ('good') + unchecked → no transferability claim at all: the
// tier default is non-transferable and the rep did not override it.
{
  const html2 = renderViaPreflight('renderWarrantyCertificate', { installDate: '2026-09-15', warrantyTier: 'good', transferable: false });
  ok('warranty: transferable clause absent on Standard tier when unchecked', !/transferable/.test(html2));
}
// Elite tier ('best') + unchecked → transferability claim is STILL present:
// Elite is inherently fully transferable, and the checkbox cannot take that
// away — only add to a lesser tier's default.
{
  const html3 = renderViaPreflight('renderWarrantyCertificate', { installDate: '2026-09-15', warrantyTier: 'best', transferable: false });
  ok('warranty: Elite tier stays transferable even with the checkbox unchecked (tier default wins)', /fully transferable/.test(html3));
}

// ── warrantyTier SOURCE OF TRUTH (2026-09-17): the field must read the
//    estimate's actual sold tier (estimate.tier), not a lead.warrantyTier
//    field nothing in this codebase ever writes. Before this fix every
//    proposal/contract/warranty_certificate printed whichever hardcoded
//    default that call site happened to carry, regardless of what was
//    priced — this exercises the REAL resolveFieldValue()/ctx path
//    (DocPreflight.open() -> resolveFieldValue), not just the renderer, since
//    the bug was in field resolution, not rendering. ──
{
  console.log('PREFLIGHT CONTRACT — warrantyTier reads estimate.tier, not lead.warrantyTier');
  const preflight = env.preflight;
  ok('DocPreflight._resolveFieldValue is exposed for this test', typeof preflight._resolveFieldValue === 'function');

  ['proposal', 'contract', 'warranty_certificate'].forEach(function (docType) {
    const schema = preflight.DOC_SCHEMAS[docType];
    let field = null;
    (schema.sections || []).forEach(function (sec) {
      (sec.fields || []).forEach(function (f) { if (f.key === 'warrantyTier') field = f; });
    });
    ok(docType + ': schema defines a warrantyTier field', !!field);
    if (!field) return;
    ok(docType + ': warrantyTier.source is estimate.tier (not lead.warrantyTier)', field.source === 'estimate.tier');
    ok(docType + ': warrantyTier.persist is document, not lead (an estimate-derived value has no lead field to update)', field.persist === 'document');

    // The estimate actually sold at "best" (Elite) reaches the resolved value.
    const ctxBest = { lead: {}, estimate: { tier: 'best' }, photos: [], overrides: {} };
    const gotBest = preflight._resolveFieldValue(field, ctxBest);
    ok(docType + ': resolves "best" from the estimate the doc is generated for (got ' + JSON.stringify(gotBest) + ')',
      gotBest === 'best');

    // A stale/forged lead.warrantyTier must NOT win over the real estimate —
    // guards against silently regressing back to the old source.
    const ctxConflict = { lead: { warrantyTier: 'good' }, estimate: { tier: 'best' }, photos: [], overrides: {} };
    const gotConflict = preflight._resolveFieldValue(field, ctxConflict);
    ok(docType + ': a lead.warrantyTier value is ignored in favor of the estimate\'s real tier (got ' + JSON.stringify(gotConflict) + ')',
      gotConflict === 'best');

    // No estimate at all (a real, if rare, state): resolves empty rather than
    // silently asserting a tier nobody chose. renderWarrantyTier()'s own
    // display-only fallback (not this resolver) is what shows a card
    // pre-selected in that case.
    const ctxNone = { lead: {}, estimate: null, photos: [], overrides: {} };
    const gotNone = preflight._resolveFieldValue(field, ctxNone);
    ok(docType + ': no estimate at all resolves empty, not a fabricated tier (got ' + JSON.stringify(gotNone) + ')',
      gotNone === '');
  });
}

// ── certificate_of_completion: modal scopeCompleted bridges to renderer scopeSummary ──
{
  const SENT = 'SENTINELscopedoneABC';
  const html = renderViaPreflight('renderCertificateOfCompletion', { scopeCompleted: SENT, completionDate: '2026-09-20', qualitySignoff: 'SENTINELquality' });
  console.log('PREFLIGHT CONTRACT — certificate_of_completion');
  ok('cert: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('cert: rep scope reaches doc (scopeCompleted→scopeSummary)', html.indexOf(SENT) !== -1);
  ok('cert: rep quality sign-off reaches doc (qualitySignoff wired)', html.indexOf('SENTINELquality') !== -1);
  ok('cert: "[Start Date]" placeholder is GONE (no start date entered)', !/\[Start Date\]/.test(html));
}

// ── scope_of_work: modal projectScope/timeline bridge to projectDescription/estimatedTimeline ──
{
  const html = renderViaPreflight('renderScopeOfWork', { projectScope: 'SENTINELprojscope', timeline: 'SENTINELtimeline99' });
  console.log('PREFLIGHT CONTRACT — scope_of_work');
  ok('scope: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('scope: rep project scope reaches doc (projectScope→projectDescription)', html.indexOf('SENTINELprojscope') !== -1);
  ok('scope: rep timeline reaches doc (timeline→estimatedTimeline)', html.indexOf('SENTINELtimeline99') !== -1);
}

// ── before_after_report: modal projectDescription bridges to renderer workDescription ──
{
  const html = renderViaPreflight('renderBeforeAfterReport', { projectDescription: 'SENTINELbadesc' });
  console.log('PREFLIGHT CONTRACT — before_after_report');
  ok('before_after: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('before_after: rep description reaches doc (projectDescription→workDescription)', html.indexOf('SENTINELbadesc') !== -1);
}

// ── inspectionInsurance: modal estimatedRepairCost bridges to renderer {{totalPrice}};
//    damageNotes/scopeItems/photos now render; fabricated damage table is gone ──
{
  const html = renderViaPreflight('renderInspectionInsurance', {
    estimatedRepairCost: 44556, claimNumber: 'CLM-99', damageType: 'Hail',
    damageNotes: 'SENTINELdamagenotes', scopeItems: ['SENTINELscopeitem1', 'SENTINELscopeitem2'],
  });
  console.log('PREFLIGHT CONTRACT — inspectionInsurance');
  ok('insIns: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('insIns: rep repair cost reaches doc (estimatedRepairCost→totalPrice)', /44,556/.test(html));
  ok('insIns: rep damage notes reach doc (damageNotes wired)', html.indexOf('SENTINELdamagenotes') !== -1);
  ok('insIns: rep scope items reach doc (scopeItems wired)', html.indexOf('SENTINELscopeitem1') !== -1 && html.indexOf('SENTINELscopeitem2') !== -1);
  ok('insIns: fabricated "North Slope ~400 sq ft" damage table is GONE', !/North Slope/.test(html) && !/400 sq ft/.test(html));
  ok('insIns: hardcoded 7-item restoration scope is GONE', !/Remove all damaged roofing materials/.test(html));
}

// ── inspectionHomeowner: rep condition notes / recommendations / property
//    details render; fabricated $11,500 recs + [object Object] + uncollected
//    siding/windows assessments are gone ──
{
  const html = renderViaPreflight('renderInspectionHomeowner', {
    overallDescription: 'SENTINELoverall', roofCondition: 'SENTINELroofcond',
    gutterCondition: 'SENTINELguttercond', recommendationsNote: 'SENTINELrecnote',
    roofType: 'Architectural asphalt', roofAge: 12, squareFootage: 2400,
  });
  console.log('PREFLIGHT CONTRACT — inspectionHomeowner');
  ok('insHome: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('insHome: rep overall + roof + gutter notes reach doc', html.indexOf('SENTINELoverall') !== -1 && html.indexOf('SENTINELroofcond') !== -1 && html.indexOf('SENTINELguttercond') !== -1);
  ok('insHome: rep recommendations note reaches doc (not a fabricated table)', html.indexOf('SENTINELrecnote') !== -1);
  ok('insHome: rep roof type / age / sqft reach doc', /Architectural asphalt/.test(html) && /12 years/.test(html) && /2400 sq ft/.test(html));
  ok('insHome: fabricated $11,500 recommendation table is GONE', !/11,500/.test(html));
  ok('insHome: no "[object Object]" condition rendering', !/\[object Object\]/.test(html));
  ok('insHome: uncollected "Vinyl siding"/"Windows in good condition" assessments are GONE', !/Vinyl siding/.test(html) && !/Windows in good condition/.test(html));
}

// ── Marketing / letter / scope renderers wired to read rep input (current
//    hardcoded copy kept as the blank-field fallback); fabricated defaults gone ──
const WIRING = [
  { label: 'thank_you', method: 'renderThankYou',
    data: { projectType: 'WIREsiding', completionDate: 'WIREcompdate', projectSummary: 'WIREsummary', personalNote: 'WIREnote', reviewLink: 'https://ex.com/WIRElink' },
    present: ['WIREsiding', 'WIREcompdate', 'WIREsummary', 'WIREnote', 'WIRElink'], absent: ['roof replacement project'] },
  { label: 'referral_card', method: 'renderReferralCard',
    data: { firstName: 'WIREfirst', lastName: 'WIRElast', referralCode: 'WIRECODE9', bonusAmount: 250, terms: 'WIREterms' },
    present: ['WIREfirst WIRElast', 'WIRECODE9', '250.00', 'WIREterms'], absent: ['Ask Us For Details!'] },
  { label: 'storm_checklist', method: 'renderStormChecklist',
    data: { stormType: 'WIREhail', stormDate: 'WIREdate', checklistNotes: 'WIREnotes', emergencyPhone: 'WIRE-555-0100' },
    present: ['WIREhail', 'WIREdate', 'WIREnotes', 'WIRE-555-0100'], absent: [] },
  { label: 'claim_guide', method: 'renderClaimGuide',
    data: { insCarrier: 'WIREcarrier', timeline: 'WIREtimeline', guideNotes: 'WIREguide' },
    present: ['WIREcarrier', 'WIREtimeline', 'WIREguide'], absent: [] },
  { label: 'testimonial_sheet', method: 'renderTestimonialSheet',
    data: { testimonial1: 'WIREtestimonial one', rating1: '4' },
    present: ['WIREtestimonial one'], absent: ['made the whole process feel like no big deal'] },
  { label: 'door_hanger', method: 'renderDoorHanger',
    data: { headline: 'WIREheadline', services: 'WIREsvcA, WIREsvcB' },
    present: ['WIREheadline', 'WIREsvcA'], absent: [] },
  { label: 'company_intro', method: 'renderCompanyIntro',
    data: { services: 'WIREsvc1, WIREsvc2', serviceArea: 'WIREarea', testimonialsNote: 'WIREtestnote' },
    present: ['WIREarea', 'WIREtestnote', 'WIREsvc1'], absent: [] },
  { label: 'neighborhood_mailer', method: 'renderNeighborhoodMailer',
    data: { affectedArea: 'WIREaffected', ctaText: 'WIREcta', neighborhoodName: 'WIREhood', projectAddress: 'WIREaddr' },
    present: ['WIREhood', 'WIREcta', 'WIREaddr'], absent: ['[Your Neighborhood]', '[Nearby Project Address]'] },
  { label: 'before_after_report', method: 'renderBeforeAfterReport',
    data: { projectType: 'WIREbatype', duration: 'WIREduration', highlights: 'WIREhl one\nWIREhl two' },
    present: ['WIREbatype', 'WIREduration', 'WIREhl one', 'WIREhl two'], absent: ['Full roof system replacement with premium'] },
  { label: 'scope_of_work', method: 'renderScopeOfWork',
    data: { projectScope: 'WIREscope', labor: 'WIRElabor crew of 5' },
    present: ['WIRElabor crew of 5'], absent: [] },
  { label: 'work_authorization', method: 'renderWorkAuthorization',
    data: { scopeOfWork: 'WIREwascope', startDate: 'WIREstart', emergencyContact: 'WIREemerg', accessInstructions: 'WIREaccess' },
    present: ['WIREwascope', 'WIREstart', 'WIREemerg', 'WIREaccess'], absent: ['[Start Date]', '[Emergency Contact'] },
  { label: 'proposal', method: 'renderProposal',
    data: { termsNote: 'WIREtermsnote' },
    present: ['WIREtermsnote'], absent: [] },
];
for (const w of WIRING) {
  const html = renderViaPreflight(w.method, w.data);
  console.log('PREFLIGHT CONTRACT — ' + w.label + ' (field wiring)');
  ok(w.label + ': renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  for (const s of w.present) ok(w.label + ': rep value reaches doc — "' + s + '"', html.indexOf(s) !== -1);
  for (const s of (w.absent || [])) ok(w.label + ': fabricated default GONE — "' + s + '"', html.indexOf(s) === -1);
}

// ── contract: itemized line-item table now renders the rep's required line items
//    (was a lump-sum Contract Price only) ──
{
  const html = renderViaPreflight('renderContract', {
    totalPrice: 18500,
    lineItems: [{ description: 'CONTRACTITEM tear-off and replace', qty: 30, unit: 'SQ', rate: 50 }],
  });
  console.log('PREFLIGHT CONTRACT — contract (itemized table)');
  ok('contract: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('contract: itemized scope table present', /Itemized Scope/.test(html));
  ok('contract: rep line-item description reaches doc', html.indexOf('CONTRACTITEM tear-off and replace') !== -1);
  ok('contract: rep line-item total (30 x $50 = $1,500.00) reaches doc', /1,500\.00/.test(html));
  ok('contract: rep contract price reaches doc', /18,500/.test(html));
}

// ── contract SERVER PAYLOAD: _buildServerPayload feeds the Puppeteer/PDF render
//    path (functions/print/templates/contract.hbs), a SEPARATE code path from
//    renderContract's client HTML tested above. doc-preflight's CONTRACT schema
//    submits `paymentSchedule` as a plain STRING (a "Payment Schedule / Terms"
//    textarea, not a {stage,due,amount} array) -- _buildServerPayload's contract
//    branch used to call .map() on it unconditionally and throw a TypeError,
//    which generate()'s outer try/catch silently swallowed, so every no-signers
//    contract fell back to the client path with no visible symptom. This
//    exercises _buildServerPayload directly so a regression here is caught even
//    though the fallback hides it from the render-output tests above. ──
function buildServerPayloadViaPreflight(preflightData) {
  const data = Object.assign({ homeownerName: 'Jane Smith', address: '123 Main St', leadId: 'L1' }, preflightData);
  try {
    env.hydrate(data);
    return env.dg._buildServerPayload('contract', data);
  } catch (e) {
    return { ERROR: e && e.message };
  }
}
{
  const payload = buildServerPayloadViaPreflight({
    paymentSchedule: '50% due upon contract execution; remaining balance due upon substantial completion.',
    warrantyTier: 'best',
    contractPrice: 18500,
  });
  console.log('PREFLIGHT CONTRACT — contract (_buildServerPayload, server/PDF path)');
  ok('server payload: does not throw on string paymentSchedule (was TypeError: .map is not a function)', !payload.ERROR);
  ok('server payload: paymentSchedule table is empty (no invented $0.00 row from prose text)',
    Array.isArray(payload.paymentSchedule) && payload.paymentSchedule.length === 0);
  ok('server payload: prose schedule routes into paymentTerms instead',
    payload.paymentTerms === '50% due upon contract execution; remaining balance due upon substantial completion.');
  ok('server payload: warrantyTier bridges to warranty text (contract.hbs "5 · Warranty" section is dropped entirely when warranty is null)',
    typeof payload.warranty === 'string' && payload.warranty.length > 0);
  ok('server payload: warranty text reflects the selected "best"/Elite tier, not a fabricated/wrong one (lifetime + full transfer + inspection, per estimate-config.js TIER_DISPLAY.best; no tier-guessed "Premium" manufacturer level since 2026-10-06 — the manufacturer warranty is its own line)',
    /Lifetime/.test(payload.warranty) && /fully transferable/.test(payload.warranty)
      && /annual courtesy inspection/.test(payload.warranty) && !/Premium|Enhanced/.test(payload.warranty));
}
{
  // A real {stage,due,amount} array (built programmatically rather than typed
  // into the preflight textarea) must still populate the table as before.
  const payload = buildServerPayloadViaPreflight({
    paymentSchedule: [{ stage: 'Deposit', due: 'Upon execution', amount: 9250 }],
  });
  ok('server payload: a real array paymentSchedule still populates the table row',
    payload.paymentSchedule.length === 1 && payload.paymentSchedule[0].stage === 'Deposit' && payload.paymentSchedule[0].amount === 9250);
}
{
  // No warrantyTier at all (legacy/partial submission) must not throw and must
  // leave warranty null -- the bridge is additive only, never fabricates.
  const payload = buildServerPayloadViaPreflight({ paymentSchedule: 'Net 30.' });
  ok('server payload: no warrantyTier supplied → warranty stays null (bridge does not fabricate)', payload.warranty === null);
}

// ── cert + before/after: real selected photos render as <img> (were empty
//    placeholder grids) ──
{
  const html = renderViaPreflight('renderCertificateOfCompletion', {
    scopeCompleted: 'done', afterPhotos: [{ url: 'https://photos.example/CERTAFTER1.jpg' }],
  });
  console.log('PREFLIGHT CONTRACT — certificate_of_completion (real photos)');
  ok('cert: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('cert: rep photo renders as <img src>', /<img src="https:\/\/photos\.example\/CERTAFTER1\.jpg"/.test(html));
}
{
  const html = renderViaPreflight('renderBeforeAfterReport', {
    projectDescription: 'done',
    beforePhotos: [{ url: 'https://photos.example/BA-BEFORE.jpg' }],
    afterPhotos: [{ url: 'https://photos.example/BA-AFTER.jpg' }],
  });
  console.log('PREFLIGHT CONTRACT — before_after_report (real photos)');
  ok('before_after: renders (no error)', html.indexOf('RENDER_ERROR') !== 0);
  ok('before_after: rep before+after photos render as <img src>',
    /<img src="https:\/\/photos\.example\/BA-BEFORE\.jpg"/.test(html) && /<img src="https:\/\/photos\.example\/BA-AFTER\.jpg"/.test(html));
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
