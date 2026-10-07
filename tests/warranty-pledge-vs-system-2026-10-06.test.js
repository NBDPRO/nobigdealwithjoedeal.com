/**
 * tests/warranty-pledge-vs-system-2026-10-06.test.js — two warranty lines on
 * every certificate / contract / proposal.
 *
 * Jo, 2026-10-06: "I offer a lifetime warranty but that's the NBD Pledge. My
 * system warranties are based on package selected and if extended
 * manufacturer warranty was sold."
 *
 * Final model (Jo, 2026-10-06, later the same day): the NBD Pledge is a
 * PROMISE — "NBD Pledge: for as long as you own the home, we'll come back and
 * make it right" — on every NBD job, never a "lifetime warranty"; the written
 * labor warranty is by package (Economy 1, Standard 5, Preferred 10, Elite 20
 * years). tests/warranty-pledge-labor-years-2026-10-06.test.js covers that
 * model end to end; this file keeps the manufacturer-line cases.
 *
 * So, per document:
 *   1. workmanship  — NBD: the Pledge line + "Written workmanship (labor)
 *                     warranty: N years". Another
 *                     company: ITS OWN configured warranty sentence
 *                     (companyProfile.businessRules.tiers.warranty), never
 *                     NBD's Pledge, never "lifetime" it didn't write; none
 *                     configured → no workmanship line.
 *   2. manufacturer — "Manufacturer warranty: <what this job bought>": the
 *                     package's warranty (NBD: GAF System Plus on Standard and
 *                     up when the shingle is GAF) plus an extended
 *                     manufacturer warranty ONLY when one was sold on the job
 *                     (a WAR line on the estimate). Nothing known → "per
 *                     manufacturer — see your estimate". Never the old
 *                     invented "GAF Timberline lifetime manufacturer shingle
 *                     warranty" default.
 *
 * Every renderer below is the REAL file run in a vm with the real
 * tenant-rules.js + estimate-config.js loaded:
 *   A. tenant-rules.js warrantyLines / manufacturerWarranty (the shared rule)
 *   B. warranty-cert.js — the dashboard wizard: server payload + legacy html
 *   C. functions/print warranty.hbs + contract.hbs + render-pdf seal
 *   D. document-generator(.js + -templates.js) — warranty certificate and the
 *      contract / proposal Warranty Coverage block
 *   E. customer.html certificate (the real block, lifted)
 *
 * Cases: NBD Standard without an extended warranty, NBD Preferred with one,
 * NBD with no package info, another company with and without a configured
 * warranty. Fails on origin/main (2026-10-06): every certificate printed the
 * GAF lifetime default and other companies printed "<seal> Lifetime Pledge".
 *
 * Needs functions/ deps (handlebars). Run:
 *   node tests/warranty-pledge-vs-system-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
function section(t) { console.log('\n' + t); }
function text(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

const PLEDGE = "NBD Pledge: for as long as you own the home, we'll come back and make it right.";
const LABOR5 = 'Written workmanship (labor) warranty: 5 years from the installation date';
const UNKNOWN = 'Manufacturer warranty: per manufacturer — see your estimate';
const OAKS_OWN = '10-year workmanship warranty from Oaks Roofing on labor.';
const GAF_HDZ = [{ code: 'RFG 240-GAF-HDZ', name: 'GAF Timberline HDZ' }, { code: 'RFG IWS', name: 'Ice & water shield' }];
const EXT_LINE = { code: 'WAR EXT-TEST', name: 'Extended manufacturer warranty (test fixture)' };
const GAF_HDZ_EXT = GAF_HDZ.concat([EXT_LINE]);
const OWNER_UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';

// A browser-ish window with the real estimate-config + tenant-rules loaded.
function makeWin(who, extra) {
  const win = { console: { log() {}, warn() {}, error() {} } };
  win.window = win;
  if (who === 'nbd') {
    win._userClaims = { companyId: OWNER_UID };
    win._companyProfile = { brand: { legalName: 'No Big Deal Home Solutions' } };
    win._brand = () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} });
  } else {
    const own = who === 'oaks-own';
    win._userClaims = { companyId: 'oaksCompany1' };
    win._companyProfile = { brand: { legalName: 'Oaks Roofing', seal: 'OAKS' },
      businessRules: own ? { tiers: { warranty: { good: OAKS_OWN, better: OAKS_OWN, best: OAKS_OWN } } } : {} };
    win._brand = () => ({ legalName: 'Oaks Roofing', seal: 'OAKS', colors: {}, contact: { phone: '555-0100' } });
  }
  Object.assign(win, extra || {});
  const ctx = vm.createContext(win);
  vm.runInContext(read('docs/pro/js/estimate-config.js'), ctx, { filename: 'estimate-config.js' });
  vm.runInContext(read('docs/pro/js/tenant-rules.js'), ctx, { filename: 'tenant-rules.js' });
  return { win, ctx };
}

// ═══════════════════════════════════════════════════════════════════
// A. the shared rule
// ═══════════════════════════════════════════════════════════════════
function ruleSection() {
  section('A. tenant-rules.js — warrantyLines (the shared rule)');
  const nbd = makeWin('nbd').win.NBDTenantRules;
  const has = nbd && typeof nbd.warrantyLines === 'function';
  ok('NBDTenantRules.warrantyLines exists', has);
  if (!has) return;
  const std = nbd.warrantyLines({ tier: 'good', lineItems: GAF_HDZ });
  ok('NBD Standard: the NBD Pledge line + the 5-year written labor line', std.pledge === PLEDGE && std.workmanship === LABOR5 && std.isPledge === true, JSON.stringify(std));
  ok('NBD Standard (GAF): System Plus, included with the package', /^Manufacturer warranty: GAF System Plus Limited Warranty, included with the Standard package/.test(std.manufacturer), std.manufacturer);
  ok('NBD Standard without an extended warranty: names no extended warranty', !/extended/i.test(std.manufacturer), std.manufacturer);
  const pref = nbd.warrantyLines({ tier: 'better', lineItems: GAF_HDZ_EXT });
  ok('NBD Preferred with an extended warranty sold: System Plus + the extended line', /included with the Preferred package/.test(pref.manufacturer)
    && /plus Extended manufacturer warranty \(test fixture\) \(extended manufacturer warranty sold on this job\)/.test(pref.manufacturer), pref.manufacturer);
  const none = nbd.warrantyLines({ tier: 'good', lineItems: [] });
  ok('NBD with no package info: "per manufacturer — see your estimate", no GAF guess', none.manufacturer === UNKNOWN, none.manufacturer);
  const eco = nbd.warrantyLines({ tier: 'economy', lineItems: GAF_HDZ });
  ok('NBD Economy: still the Pledge, 1-year written labor, no system warranty', eco.pledge === PLEDGE && /: 1 year from/.test(eco.workmanship) && eco.isPledge
    && /standard limited warranty on the shingles; no system warranty/.test(eco.manufacturer), JSON.stringify(eco));
  const tam = nbd.warrantyLines({ tier: 'better', lineItems: [{ code: 'RFG 240-TAMKO-TITAN', name: 'TAMKO Titan XT (Impact Class 3)' }] });
  ok('NBD TAMKO (not GAF): no System Plus claim, TAMKO\'s own warranty', !/System Plus/.test(tam.manufacturer) && /TAMKO/.test(tam.manufacturer), tam.manufacturer);
  ok('WAR MFG / WAR LAB paperwork lines are not "extended warranties"',
    !/extended/i.test(nbd.manufacturerWarranty({ tier: 'good', lineItems: GAF_HDZ.concat([{ code: 'WAR MFG', name: 'Manufacturer Warranty Registration' }, { code: 'WAR LAB', name: 'Labor Warranty Documentation' }]) })));

  const oaks = makeWin('oaks-own').win.NBDTenantRules;
  const o = oaks.warrantyLines({ tier: 'good', lineItems: GAF_HDZ });
  ok('other company (configured): its own workmanship sentence, not the Pledge', o.workmanship === OAKS_OWN && !o.isPledge, JSON.stringify(o));
  ok('other company: never inherits NBD\'s System Plus package rule', !/System Plus/.test(o.manufacturer) && /GAF’s standard limited warranty/.test(o.manufacturer), o.manufacturer);
  const bare = makeWin('oaks-none').win.NBDTenantRules.warrantyLines({ tier: 'better', lineItems: GAF_HDZ_EXT });
  ok('other company (none configured): no workmanship line at all', bare.workmanship === null, JSON.stringify(bare));
  ok('other company: an extended warranty it sold still prints', /extended manufacturer warranty sold on this job/.test(bare.manufacturer), bare.manufacturer);
}

// ═══════════════════════════════════════════════════════════════════
// B. warranty-cert.js (dashboard wizard)
// ═══════════════════════════════════════════════════════════════════
async function wcRun(who, tier, lineItems, serverOk) {
  const opts = ['economy', 'standard', 'preferred', 'elite', 'beyond'].map((v) => ({ value: v, textContent: v }));
  const els = {
    wcOwner: { value: 'Jane Smith' }, wcAddr: { value: '1 Elm St' }, wcDate: { value: '2026-10-06' },
    wcTier: { value: tier, options: opts }, wcWork: { value: 'Roof replacement' },
    wcTierDesc: { textContent: '' }, wcEyebrow: { textContent: '' },
    warrantyCertModal: { classList: { add() {}, remove() {} } },
  };
  let payload = null, viewerHtml = null;
  const { ctx } = makeWin(who, {
    NBDDocViewer: { open: (o) => { viewerHtml = o.html; } },
    document: { getElementById: (id) => els[id] || null },
    showToast() {}, Date, Math, JSON, Promise,
  });
  vm.runInContext(read('docs/pro/js/warranty-cert.js'), ctx, { filename: 'warranty-cert.js' });
  ctx._tryServerRender = async (p) => { payload = p; return serverOk; };
  vm.runInContext('openWarrantyCertWizard', ctx)({ id: 'L1', firstName: 'Jane', lastName: 'Smith', address: '1 Elm St', estimateLineItems: lineItems });
  els.wcTier.value = tier;
  vm.runInContext('updateCertPreview()', ctx);
  await vm.runInContext('generateWarrantyCertPDF()', ctx);
  return { payload: payload || {}, html: text(viewerHtml), opts, desc: els.wcTierDesc.textContent };
}
async function certSection() {
  section('B. warranty-cert.js — server payload + legacy certificate');
  const std = await wcRun('nbd', 'standard', GAF_HDZ, true);
  ok('NBD Standard payload: Pledge line + 5-year written labor line', std.payload.pledgeLine === PLEDGE && std.payload.workmanshipLine === LABOR5 && std.payload.laborYears === 5, JSON.stringify(std.payload).slice(0, 400));
  ok('NBD Standard payload: manufacturer line = GAF System Plus with the package, no extended',
    /^Manufacturer warranty: GAF System Plus Limited Warranty, included with the Standard package/.test(std.payload.manufacturerLine || '') && !/extended/i.test(std.payload.manufacturerLine || ''), std.payload.manufacturerLine);
  const pref = await wcRun('nbd', 'preferred', GAF_HDZ_EXT, true);
  ok('NBD Preferred with extended: the extended warranty sold is on the manufacturer line',
    /Preferred package/.test(pref.payload.manufacturerLine || '') && /Extended manufacturer warranty \(test fixture\)/.test(pref.payload.manufacturerLine || ''), pref.payload.manufacturerLine);
  const unk = await wcRun('nbd', 'standard', [], true);
  ok('NBD with no estimate line items: "per manufacturer — see your estimate"', unk.payload.manufacturerLine === UNKNOWN, unk.payload.manufacturerLine);
  ok('…and no manufacturer is guessed for the disclaimer', unk.payload.manufacturerName === '', unk.payload.manufacturerName);

  const legacy = await wcRun('nbd', 'standard', GAF_HDZ, false);
  ok('NBD legacy certificate: two separate lines (Pledge + manufacturer)', legacy.html.includes(PLEDGE) && legacy.html.includes('Manufacturer warranty: GAF System Plus Limited Warranty'), legacy.html.slice(0, 600));
  ok('NBD legacy certificate: never the old GAF Timberline lifetime default', !/GAF Timberline lifetime manufacturer/.test(legacy.html));
  const legacyUnk = await wcRun('nbd', 'standard', [], false);
  ok('NBD legacy, no line items: per manufacturer, no GAF named', legacyUnk.html.includes(UNKNOWN) && !/\bGAF\b/.test(legacyUnk.html), legacyUnk.html.slice(-700));

  const oaks = await wcRun('oaks-own', 'standard', GAF_HDZ, true);
  ok('other company (configured): its own sentence is the workmanship line + terms', oaks.payload.workmanshipLine === OAKS_OWN && oaks.payload.tierTerms === OAKS_OWN, JSON.stringify(oaks.payload).slice(0, 300));
  const _vals = (o) => Object.keys(o).map((k) => (typeof o[k] === 'string' ? o[k] : '')).join(' | ');
  ok('other company: never a Pledge / "lifetime" in any payload value, no NBD years', oaks.payload.isPledge === false && !oaks.payload.pledgeLine && !oaks.payload.laborYears && !/lifetime|pledge/i.test(_vals(oaks.payload)), (_vals(oaks.payload).match(/.{0,80}(lifetime|pledge).{0,40}/i) || [''])[0]);
  ok('other company: the Guarantee Tier option is the plain package name', oaks.opts[1].textContent === 'Standard', oaks.opts[1].textContent);
  const oaksLegacy = await wcRun('oaks-own', 'preferred', GAF_HDZ, false);
  ok('other company legacy certificate: own sentence, no lifetime, no NBD perks', oaksLegacy.html.includes(OAKS_OWN) && !/lifetime|pledge|Transferable to new owner/i.test(oaksLegacy.html), oaksLegacy.html.slice(0, 700));
  const bare = await wcRun('oaks-none', 'standard', GAF_HDZ, true);
  ok('other company (none configured): no workmanship line, no terms', bare.payload.workmanshipLine === '' && !bare.payload.tierTerms, JSON.stringify(bare.payload).slice(0, 300));
  ok('…and still the manufacturer line', /^Manufacturer warranty: /.test(bare.payload.manufacturerLine || ''), bare.payload.manufacturerLine);
  const bareLegacy = await wcRun('oaks-none', 'standard', GAF_HDZ, false);
  ok('other company (none) legacy certificate: no lifetime / pledge / labor guarantee claim', !/lifetime|pledge|covers defects in labor/i.test(bareLegacy.html), bareLegacy.html.slice(0, 700));
}

// ═══════════════════════════════════════════════════════════════════
// C. server templates
// ═══════════════════════════════════════════════════════════════════
let Handlebars = null, RENDER = null;
try {
  try { Handlebars = require(path.join(ROOT, 'functions/node_modules/handlebars')); } catch (_) { Handlebars = require('handlebars'); }
  RENDER = require(path.join(ROOT, 'functions/render-pdf.js'));
} catch (e) { ok('functions/ deps load (handlebars, render-pdf.js)', false, e && e.message); }
async function printSection() {
  section('C. functions/print — warranty.hbs, contract.hbs, render-pdf seal');
  if (!Handlebars || !RENDER) return;
  RENDER._registerPartialsOnce();
  RENDER._registerHelpersOnce();
  const WARRANTY = Handlebars.compile(read('functions/print/templates/warranty.hbs'));
  const NBD = { footerName: 'No Big Deal Home Solutions', isNbd: true, seal: 'NBD' };
  const OAKS = { footerName: 'Oaks Roofing', isNbd: false, seal: 'OAKS' };
  const base = { owner: 'Jane Smith', address: '1 Elm St', dateFormatted: 'October 6, 2026', work: 'Roof replacement',
    certNumber: 'X-1', preparedFor: { name: 'Jane Smith', address: '1 Elm St' }, preparedBy: { name: 'Rep' }, projectMeta: [] };
  const body = (html) => text(String(html).split('affiliate')[0]);
  const std = (await wcRun('nbd', 'standard', GAF_HDZ, true)).payload;
  const nbdStd = body(WARRANTY(Object.assign({}, base, std, { company: NBD, workmanshipLine: std.workmanshipLine, manufacturerLine: std.manufacturerLine, manufacturer: std.manufacturerName })));
  ok('warranty.hbs NBD Standard: the Pledge line and the manufacturer line, separately', nbdStd.includes(PLEDGE) && nbdStd.includes('Manufacturer warranty: GAF System Plus Limited Warranty, included with the Standard package'), nbdStd.slice(-900));
  ok('warranty.hbs NBD: never the GAF Timberline lifetime default', !/GAF Timberline lifetime manufacturer/.test(nbdStd));
  const nbdOld = body(WARRANTY(Object.assign({}, base, { company: NBD, tier: 'standard', tierLabel: 'S', tierLabelLong: 'S', tierTerms: 'x' })));
  ok('warranty.hbs, an older client\'s payload (no lines): per manufacturer, not GAF lifetime', nbdOld.includes(UNKNOWN) && !/GAF Timberline lifetime/.test(nbdOld), nbdOld.slice(-700));

  const oaks = (await wcRun('oaks-own', 'standard', GAF_HDZ, true)).payload;
  const oaksHtml = body(WARRANTY(Object.assign({}, base, oaks, { company: OAKS, manufacturer: oaks.manufacturerName })));
  ok('warranty.hbs other company: its own sentence, never "Lifetime Pledge"', oaksHtml.includes(OAKS_OWN) && !/lifetime|pledge/i.test(oaksHtml), oaksHtml.slice(0, 900));
  // Even a payload that claims the Pledge cannot print it for another company.
  const forged = body(WARRANTY(Object.assign({}, base, { company: OAKS, tier: 'standard', tierLabel: 'Standard', tierLabelLong: 'Standard', tierTerms: '', isPledge: true, isElite: true, isPreferred: true, manufacturerLine: UNKNOWN })));
  ok('warranty.hbs other company, no warranty configured: no Pledge, no NBD perks', !/lifetime|pledge|transferable|courtesy inspection/i.test(forged), forged.slice(0, 900));
  // companyId = the NBD owner → NBD's chrome; null → a neutral (non-NBD) company.
  const sealOf = (html) => (String(html).match(/class="seal">([\s\S]*?)<\/div>/) || ['', ''])[1];
  const nbdDoc = await RENDER.buildDocHtml('warranty', Object.assign({}, base, { tier: 'standard', tierLabel: 'S', tierLabelLong: 'S', tierTerms: 'x' }), OWNER_UID);
  ok('render-pdf: NBD\'s warranty chrome stamps the NBD Pledge seal, never "Lifetime"', /NBD Pledge/.test(sealOf(nbdDoc.html)) && !/lifetime/i.test(sealOf(nbdDoc.html)), sealOf(nbdDoc.html));
  const otherDoc = await RENDER.buildDocHtml('warranty', Object.assign({}, base, { tier: 'standard', tierLabel: 'S', tierLabelLong: 'S', tierTerms: '' }), null);
  ok('render-pdf: another company\'s warranty never stamps "Lifetime Pledge" (seal or body)', !/lifetime|pledge/i.test(text(otherDoc.html)),
    sealOf(otherDoc.html) + ' | ' + (text(otherDoc.html).match(/.{0,60}(lifetime|pledge).{0,40}/i) || [''])[0]);

  const CONTRACT = Handlebars.compile(read('functions/print/templates/contract.hbs'));
  const cbase = { preparedFor: {}, preparedBy: {}, projectMeta: [], contract: {}, homeowner: {}, paymentSchedule: [], additionalTerms: [] };
  const cNbd = text(CONTRACT(Object.assign({}, cbase, { company: NBD, warranty: '5-year written workmanship (labor) warranty; does not transfer on sale of property.', warrantyIsPledge: true, warrantyPledge: PLEDGE, manufacturerWarranty: std.manufacturerLine })));
  ok('contract.hbs NBD: written labor warranty + a separate NBD Pledge block + a separate manufacturer line, never "lifetime"', /NBD Written Workmanship \(Labor\) Warranty 5-year/.test(cNbd) && /NBD Pledge NBD Pledge: for as long as you own the home/.test(cNbd) && cNbd.includes('Manufacturer warranty: GAF System Plus') && !/lifetime/i.test(cNbd), cNbd.slice(0, 900));
  const cOaks = text(CONTRACT(Object.assign({}, cbase, { company: OAKS, warranty: OAKS_OWN, warrantyIsPledge: true, manufacturerWarranty: oaks.manufacturerLine })));
  ok('contract.hbs other company: its own sentence under a plain title, never "NBD … Warranty"', cOaks.includes(OAKS_OWN) && !/NBD|Pledge/.test(cOaks.split('Right to Cancel')[0]), cOaks.slice(0, 900));
  const cBare = text(CONTRACT(Object.assign({}, cbase, { company: OAKS, warranty: null, manufacturerWarranty: UNKNOWN })));
  ok('contract.hbs other company with no warranty set: the manufacturer line only', cBare.includes(UNKNOWN) && !/Workmanship Warranty/.test(cBare), cBare.slice(0, 600));
}

// ═══════════════════════════════════════════════════════════════════
// D. document generator: certificate + contract/proposal block
// ═══════════════════════════════════════════════════════════════════
function docgen(who) {
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const { win, ctx } = makeWin(who, {
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    setTimeout, clearTimeout, Date, Math, JSON,
  });
  vm.runInContext(read('docs/pro/js/document-generator.js'), ctx, { filename: 'document-generator.js' });
  vm.runInContext(read('docs/pro/js/document-generator-templates.js'), ctx, { filename: 'document-generator-templates.js' });
  return win.NBDDocGen;
}
function docgenSection() {
  section('D. document generator — warranty certificate + Warranty Coverage block');
  const DG = docgen('nbd');
  const cert = (dg, tier, items) => text(dg.renderWarrantyCertificate({ homeownerName: 'Jane Smith', address: '1 Elm St', warrantyTier: tier, leadId: 'L1', estimateLineItems: items }));
  const s = cert(DG, 'good', GAF_HDZ);
  ok('NBD certificate: NBD Pledge + 5-year written headline + System Plus manufacturer line', /NBD PLEDGE · 5-YEAR WRITTEN WORKMANSHIP \(LABOR\) WARRANTY — STANDARD TIER/.test(s) && s.includes(PLEDGE) && s.includes('Manufacturer warranty: GAF System Plus Limited Warranty, included with the Standard package'), s.slice(0, 700));
  const p = cert(DG, 'better', GAF_HDZ_EXT);
  ok('NBD certificate, Preferred + extended: the extended warranty sold is named', /Extended manufacturer warranty \(test fixture\)/.test(p), p.slice(0, 900));
  const u = cert(DG, 'good', []);
  ok('NBD certificate, no package info: per manufacturer, no GAF guess', u.includes(UNKNOWN) && !/GAF Timberline/.test(u), u.slice(0, 800));

  const oaks = docgen('oaks-own');
  const o = cert(oaks, 'good', GAF_HDZ);
  ok('other company certificate (configured): its own sentence, no lifetime / pledge', o.includes(OAKS_OWN) && !/lifetime|pledge/i.test(o), o.slice(0, 900));
  const bare = cert(docgen('oaks-none'), 'better', GAF_HDZ);
  ok('other company certificate (none configured): no workmanship promise, manufacturer line only', !/lifetime|pledge|guarantees the quality/i.test(bare) && /Manufacturer warranty: /.test(bare), bare.slice(0, 900));

  const bN = text(DG.renderWarrantyFor({ warrantyTier: 'better', estimateLineItems: GAF_HDZ }));
  ok('NBD contract/proposal block: NBD Pledge + written years + a separate manufacturer line', /Preferred: NBD Pledge \+ 10-Year Workmanship/.test(bN) && /for as long as you own the home/.test(bN) && !/lifetime/i.test(bN) && bN.includes('Manufacturer warranty: GAF System Plus Limited Warranty, included with the Preferred package'), bN);
  ok('NBD contract/proposal block: no tier-guessed "Enhanced Manufacturer" coverage', !/Enhanced Manufacturer|Premium Manufacturer|Enhanced manufacturer coverage/i.test(bN), bN);
  const bO = text(oaks.renderWarrantyFor({ warrantyTier: 'better', estimateLineItems: GAF_HDZ }));
  ok('other company contract block: own sentence, no lifetime (keeps the #2265 fix)', bO.includes(OAKS_OWN) && !/lifetime|pledge/i.test(bO), bO);
  const bB = text(docgen('oaks-none').renderWarrantyFor({ warrantyTier: 'better', estimateLineItems: GAF_HDZ }));
  ok('other company with none configured: no workmanship line, manufacturer line only', !/lifetime|pledge|Workmanship/i.test(bB) && /Manufacturer warranty: /.test(bB), bB);
}

// ═══════════════════════════════════════════════════════════════════
// E. customer.html certificate (real block, lifted)
// ═══════════════════════════════════════════════════════════════════
function customerSection() {
  section('E. customer.html warranty certificate (real block, lifted)');
  const cb = read('docs/pro/js/customer-bootstrap.module.js').replace(/\r\n/g, '\n');
  const a = cb.indexOf('  const _tierKey = _jobW ?');
  const b = cb.indexOf('\n\n  // Accent is a literal here');
  ok('certificate tier block found', a > 0 && b > a);
  const block = cb.slice(a, b);
  const run = (who, tier) => {
    const { win } = makeWin(who);
    const ctx = { window: win, _jobW: null, _jw: null, est: { tier }, String, Number };
    vm.createContext(ctx);
    vm.runInContext(block + '\nthis.__o = { period: _roofPeriod, body: _roofBody };', ctx);
    return ctx.__o;
  };
  const n = run('nbd', 'good');
  ok('NBD: the 5-year written period and body, never "lifetime"', n.period === '5-Year Written Workmanship (Labor)' && /for 5 years from the completion date/.test(n.body) && !/lifetime/i.test(n.period + n.body), JSON.stringify(n));
  const o = run('oaks-own', 'good');
  ok('other company (configured): its own sentence, no lifetime', o.body === OAKS_OWN && !/lifetime|pledge/i.test(o.period + o.body), JSON.stringify(o));
  const z = run('oaks-none', 'good');
  ok('other company (none configured): no period, no body', z.period === '' && z.body === '', JSON.stringify(z));
  ok('certificate prints a Manufacturer Warranty row from the shared rule', /label">Manufacturer Warranty</.test(cb) && /_TRc\.warrantyLines\(/.test(cb));
}

(async () => {
  ruleSection();
  await certSection();
  await printSection();
  docgenSection();
  customerSection();
})().catch((e) => ok('async section threw', false, e && e.stack)).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
});
