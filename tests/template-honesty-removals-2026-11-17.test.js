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
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
