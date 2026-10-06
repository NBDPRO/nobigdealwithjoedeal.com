/**
 * tests/warranty-pledge-labor-years-2026-10-06.test.js — Jo's final warranty
 * model, and each company's own certificate on customer.html.
 *
 * Jo, 2026-10-06 (final):
 *   - The NBD Pledge is a lifetime PROMISE on every NBD job, every tier:
 *     "NBD Pledge: for as long as you own the home, we'll come back and make
 *     it right." It is never called a "lifetime workmanship warranty" or a
 *     "lifetime warranty" (that would contradict the written terms below).
 *     One shared constant: estimate-config.js PLEDGE_PROMISE.
 *   - A separate WRITTEN labor (workmanship) warranty by package: Economy 1,
 *     Standard 5, Preferred 10, Elite 20 years. Beyond (the fifth package)
 *     takes its nearest tier's 20 years until Jo confirms. One shared map:
 *     estimate-config.js TIER_LABOR_YEARS; every fallback copy is pinned to it.
 *   - The manufacturer warranty stays its own line (per package / extended).
 *   - Other companies never inherit the Pledge or NBD's years.
 *
 * customer.html certificate (customer-bootstrap.module.js
 * generateCertFromEstimate): it printed NBD's logo, name and an "NBD-"
 * certificate number for EVERY company. Each company's certificate now uses
 * its own company profile (name, logo, cert prefix); every field is escaped.
 *
 * Every renderer is the REAL file run in a vm. Fails on origin/main and on the
 * #2270 branch (they print "NBD Pledge — lifetime workmanship warranty" and
 * the customer.html certificate is NBD-branded for everyone).
 *
 * Needs functions/ deps (handlebars). Run:
 *   node tests/warranty-pledge-labor-years-2026-10-06.test.js
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
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 500) : '')); }
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
// "lifetime" used as a warranty term (any order, either way round).
const LIFETIME_WARRANTY = /lifetime[^.;]{0,40}(warranty|workmanship|guarantee|pledge|coverage)|(warranty|workmanship|guarantee|pledge)[^.;]{0,25}lifetime/i;
const lifetimeHit = (s) => (String(s).match(/.{0,60}lifetime.{0,40}/i) || [''])[0];

const PLEDGE = "NBD Pledge: for as long as you own the home, we'll come back and make it right.";
const YEARS = { economy: 1, good: 5, better: 10, best: 20, beyond: 20 };
const CERT_TIER = { economy: 'economy', good: 'standard', better: 'preferred', best: 'elite', beyond: 'beyond' };
const TIERS = Object.keys(YEARS);
const OWNER_UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OAKS_OWN = '10-year workmanship warranty from Oaks Roofing on labor.';
const GAF_HDZ = [{ code: 'RFG 240-GAF-HDZ', name: 'GAF Timberline HDZ' }];

function makeWin(who, extra) {
  const win = { console: { log() {}, warn() {}, error() {} } };
  win.window = win;
  if (who === 'nbd') {
    win._userClaims = { companyId: OWNER_UID };
    win._companyProfile = { brand: { legalName: 'No Big Deal Home Solutions' } };
    win._brand = () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} });
  } else {
    win._userClaims = { companyId: 'oaksCompany1' };
    win._companyProfile = { brand: { legalName: 'Oaks Roofing', seal: 'OAKS' },
      businessRules: who === 'oaks-own' ? { tiers: { warranty: { good: OAKS_OWN, better: OAKS_OWN, best: OAKS_OWN } } } : {} };
    win._brand = () => ({ legalName: 'Oaks Roofing', seal: 'OAKS', colors: {}, contact: { phone: '555-0100' } });
  }
  Object.assign(win, extra || {});
  const ctx = vm.createContext(win);
  vm.runInContext(read('docs/pro/js/estimate-config.js'), ctx, { filename: 'estimate-config.js' });
  vm.runInContext(read('docs/pro/js/tenant-rules.js'), ctx, { filename: 'tenant-rules.js' });
  return { win, ctx };
}
const CFG = makeWin('nbd').win.NBD_ESTIMATE_CONFIG;
const LL = (t) => (typeof CFG.laborWarrantyLine === 'function' ? CFG.laborWarrantyLine(t) : '(no laborWarrantyLine)');

// ═══════════════════════════════════════════════════════════════════
section('A. the one constant + the one tier→years map (estimate-config.js)');
ok('PLEDGE_PROMISE is Jo\'s exact wording', CFG.PLEDGE_PROMISE === PLEDGE, CFG.PLEDGE_PROMISE);
ok('TIER_LABOR_YEARS: Economy 1, Standard 5, Preferred 10, Elite 20, Beyond 20', JSON.stringify(CFG.TIER_LABOR_YEARS) === JSON.stringify(YEARS), JSON.stringify(CFG.TIER_LABOR_YEARS));
ok('TIER_DISPLAY workmanshipYears restates the same map on every tier', TIERS.every((t) => CFG.TIER_DISPLAY[t].warranty.workmanshipYears === YEARS[t]));
for (const t of TIERS) {
  const s = CFG.tierWarrantyText(t);
  ok(CFG.tierLabel(t) + ': "' + YEARS[t] + '-year written workmanship (labor) warranty", never lifetime', s.indexOf(YEARS[t] + '-year written workmanship (labor) warranty') === 0 && !/lifetime/i.test(s), s);
  ok(CFG.tierLabel(t) + ': blurb leads with ' + YEARS[t] + '-year labor', CFG.tierWarrantyBlurb(t).indexOf(YEARS[t] + '-year labor warranty') === 0, CFG.tierWarrantyBlurb(t));
  ok(CFG.tierLabel(t) + ': laborWarrantyLine', LL(t) === 'Written workmanship (labor) warranty: ' + YEARS[t] + (YEARS[t] === 1 ? ' year' : ' years') + ' from the installation date', LL(t));
}
ok('Economy still names the manufacturer\'s standard limited warranty and no system warranty', /standard limited warranty applies; no system warranty/.test(CFG.tierWarrantyText('economy')));
ok('an unknown tier: no years, no lifetime', !/lifetime|\d+-year/i.test(CFG.tierWarrantyText('platinum')), CFG.tierWarrantyText('platinum'));

// ═══════════════════════════════════════════════════════════════════
section('B. every copy matches the one constant / map (pages that never load the config)');
{
  const strip = (s) => s.replace(/\r\n/g, '\n');
  const tr = strip(read('docs/pro/js/tenant-rules.js'));
  const pf = (/var PLEDGE_FALLBACK = '((?:[^'\\]|\\.)*)'/.exec(tr) || [])[1];
  ok('tenant-rules.js PLEDGE_FALLBACK === PLEDGE_PROMISE', pf && pf.replace(/\\'/g, "'") === PLEDGE, pf);
  const wc = strip(read('docs/pro/js/warranty-cert.js'));
  ok('warranty-cert.js labor-years fallback === TIER_LABOR_YEARS', wc.indexOf('|| { economy: 1, good: 5, better: 10, best: 20, beyond: 20 }') !== -1);
  ok('warranty-cert.js Pledge fallback === PLEDGE_PROMISE', wc.indexOf("'NBD Pledge: for as long as you own the home, we\\'ll come back and make it right.'") !== -1);
  const dg = strip(read('docs/pro/js/document-generator.js'));
  ok('document-generator.js years fallback === TIER_LABOR_YEARS', dg.indexOf("({ economy: 1, good: 5, better: 10, best: 20, beyond: 20 })[tier]") !== -1);
  const dgt = strip(read('docs/pro/js/document-generator-templates.js'));
  const fb = (/const _fallbackWarranty = \{([\s\S]*?)\n    \};/.exec(dgt) || [])[1] || '';
  ok('document-generator-templates.js _fallbackWarranty years === TIER_LABOR_YEARS',
    TIERS.every((t) => new RegExp('\\b' + t + ': \\{ workmanshipYears: ' + YEARS[t] + '\\b').test(fb)), fb);
  const fin = strip(read('docs/pro/js/estimate-finalization.js'));
  ok('estimate-finalization.js card fallback years === TIER_LABOR_YEARS', TIERS.every((t) => new RegExp(t + ':\\s+\\{ workmanshipYears: ' + YEARS[t] + '\\b').test(fin)));
  const cb = strip(read('docs/pro/js/customer-bootstrap.module.js'));
  ok('customer-bootstrap.module.js certificate fallback years === TIER_LABOR_YEARS',
    /economy: \{ workmanshipYears: 1, systemWarranty: false \}, good: \{ workmanshipYears: 5 \}, better: \{ workmanshipYears: 10 \},\s+best: \{ workmanshipYears: 20 \}, beyond: \{ workmanshipYears: 20, hailWarranty: true \}/.test(cb));
  const v2 = strip(read('docs/pro/js/estimate-v2-ui.js'));
  ok('estimate-v2-ui.js tier-list fallback === TIER_LABOR_YEARS', v2.indexOf('|| { economy: 1, good: 5, better: 10, best: 20, beyond: 20 };') !== -1);
  // The five-sentence fallbacks (pages without the config) equal tierWarrantyText byte for byte.
  const src = (s) => s.split("'").join("\\'");
  for (const rel of ['docs/pro/js/close-board.js', 'docs/pro/js/doc-preflight.js', 'docs/pro/js/document-generator-library.js']) {
    const f = strip(read(rel));
    ok(rel + ': fallback tier sentences === tierWarrantyText', TIERS.every((t) => f.indexOf("'" + src(CFG.tierWarrantyText(t, true)) + "'") !== -1));
  }
  const hbs = read('functions/print/templates/warranty.hbs');
  ok('warranty.hbs Pledge fallback === PLEDGE_PROMISE', hbs.indexOf(PLEDGE) !== -1);
  const AG = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
  ok('agent rules reference (server): PLEDGE_PROMISE identical', AG.PLEDGE_PROMISE === PLEDGE, AG.PLEDGE_PROMISE);
  ok('agent rules reference (server): every tier states its years, never lifetime',
    AG.TIERS.every((t) => new RegExp('^' + YEARS[t.key] + '-year written workmanship').test(t.warranty) && !/lifetime/i.test(t.warranty)), JSON.stringify(AG.TIERS.map((t) => t.warranty)));
  ok('agent rules reference: carries the Pledge + a "never lifetime" note', AG.rulesReference().pledge === PLEDGE && /Never write "lifetime warranty"/.test(AG.rulesReference().pledge_note));
}

// ═══════════════════════════════════════════════════════════════════
section('C. tenant-rules.js warrantyLines — NBD: Pledge + years on every tier; others: neither');
{
  const nbd = makeWin('nbd').win.NBDTenantRules;
  for (const t of TIERS) {
    const l = nbd.warrantyLines({ tier: t, lineItems: GAF_HDZ });
    ok('NBD ' + t + ': the Pledge + ' + YEARS[t] + ' written years + a manufacturer line', l.pledge === PLEDGE && l.isPledge === true
      && l.workmanship === LL(t) && /^Manufacturer warranty: /.test(l.manufacturer) && !LIFETIME_WARRANTY.test(JSON.stringify(l)), JSON.stringify(l));
  }
  const oaks = makeWin('oaks-own').win.NBDTenantRules.warrantyLines({ tier: 'good', lineItems: GAF_HDZ });
  ok('another company: no Pledge, its own sentence', oaks.pledge === null && !oaks.isPledge && oaks.workmanship === OAKS_OWN, JSON.stringify(oaks));
  const bare = makeWin('oaks-none').win.NBDTenantRules.warrantyLines({ tier: 'economy', lineItems: GAF_HDZ });
  ok('another company with none configured: no Pledge, no NBD years', bare.pledge === null && bare.workmanship === null, JSON.stringify(bare));
  // A stale "lifetime" sentence NBD saved before the change never prints.
  const stale = makeWin('nbd', {});
  stale.win._companyProfile.businessRules = { tiers: { warranty: { good: 'Lifetime workmanship warranty; does not transfer on sale of property.' } } };
  const sl = stale.win.NBDTenantRules.warrantyLines({ tier: 'good' });
  ok('NBD: a saved old "Lifetime workmanship" sentence is ignored — the written 5 years print', sl.workmanship === LL('good'), sl.workmanship);
  ok('…and tierWarrantyText ignores it too', !/lifetime/i.test(stale.win.NBD_ESTIMATE_CONFIG.tierWarrantyText('good')), stale.win.NBD_ESTIMATE_CONFIG.tierWarrantyText('good'));
}

// ═══════════════════════════════════════════════════════════════════
// D. rendered NBD documents, every tier: the Pledge + the years, never "lifetime"
// ═══════════════════════════════════════════════════════════════════
async function wcRun(who, tier, serverOk) {
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
  vm.runInContext('openWarrantyCertWizard', ctx)({ id: 'L1', firstName: 'Jane', lastName: 'Smith', address: '1 Elm St', estimateLineItems: GAF_HDZ });
  els.wcTier.value = tier;
  vm.runInContext('updateCertPreview()', ctx);
  await vm.runInContext('generateWarrantyCertPDF()', ctx);
  return { payload: payload || {}, html: text(viewerHtml), desc: els.wcTierDesc.textContent, std: opts[1].textContent };
}
let Handlebars = null, RENDER = null;
try {
  try { Handlebars = require(path.join(ROOT, 'functions/node_modules/handlebars')); } catch (_) { Handlebars = require('handlebars'); }
  RENDER = require(path.join(ROOT, 'functions/render-pdf.js'));
} catch (e) { ok('functions/ deps load (handlebars, render-pdf.js)', false, e && e.message); }
function docgen(who) {
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const { win, ctx } = makeWin(who, {
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    setTimeout, clearTimeout, Date, Math, JSON,
  });
  vm.runInContext(read('docs/pro/js/document-generator.js'), ctx, { filename: 'document-generator.js' });
  vm.runInContext(read('docs/pro/js/document-generator-templates.js'), ctx, { filename: 'document-generator-templates.js' });
  vm.runInContext(read('docs/pro/js/document-generator-library.js'), ctx, { filename: 'document-generator-library.js' });
  return win.NBDDocGen;
}
async function docsSection() {
  section('D. NBD documents, every tier — the Pledge + the written years, never "lifetime"');
  const DG = docgen('nbd');
  const WARRANTY = Handlebars && Handlebars.compile(read('functions/print/templates/warranty.hbs'));
  if (RENDER) { RENDER._registerPartialsOnce(); RENDER._registerHelpersOnce(); }
  const base = { owner: 'Jane Smith', address: '1 Elm St', dateFormatted: 'October 6, 2026', work: 'Roof replacement',
    certNumber: 'NBD-1', preparedFor: { name: 'Jane Smith', address: '1 Elm St' }, preparedBy: { name: 'Rep' }, projectMeta: [] };
  for (const t of TIERS) {
    const y = YEARS[t], label = CFG.tierLabel(t);
    const srv = await wcRun('nbd', CERT_TIER[t], true);
    ok('[wizard→server payload] ' + label + ': pledgeLine + ' + y + ' years, no lifetime', srv.payload.pledgeLine === PLEDGE && srv.payload.laborYears === y
      && srv.payload.workmanshipLine === LL(t) && !LIFETIME_WARRANTY.test(JSON.stringify(srv.payload)), lifetimeHit(JSON.stringify(srv.payload)) || JSON.stringify(srv.payload).slice(0, 300));
    ok('[wizard] ' + label + ': tier label names the Pledge + ' + y + '-Year Labor', srv.payload.tierLabel.indexOf('NBD Pledge · ' + y + '-Year Labor Warranty') !== -1, srv.payload.tierLabel);
    const legacy = await wcRun('nbd', CERT_TIER[t], false);
    ok('[legacy certificate] ' + label + ': the Pledge + ' + y + ' written years, never lifetime', legacy.html.includes(PLEDGE)
      && legacy.html.includes(LL(t)) && !/lifetime/i.test(legacy.html), lifetimeHit(legacy.html) || legacy.html.slice(0, 300));
    if (WARRANTY) {
      const h = text(String(WARRANTY(Object.assign({}, base, srv.payload, { company: { footerName: 'No Big Deal Home Solutions', isNbd: true, seal: 'NBD' },
        manufacturer: srv.payload.manufacturerName }))).split('affiliate')[0]);
      ok('[warranty.hbs] ' + label + ': Pledge cover + ' + y + '-Year badge + both lines, never lifetime', /Warranty Certificate · NBD Pledge/.test(h)
        && h.includes(y + '-Year Labor Warranty') && h.includes(PLEDGE) && h.includes(LL(t)) && !/lifetime/i.test(h), lifetimeHit(h) || h.slice(0, 400));
    }
    const cert = text(DG.renderWarrantyCertificate({ homeownerName: 'Jane Smith', address: '1 Elm St', warrantyTier: t, leadId: 'L1', estimateLineItems: GAF_HDZ }));
    ok('[docgen certificate] ' + label + ': Pledge + ' + y + '-YEAR written headline + expiry, never lifetime', cert.includes(PLEDGE)
      && cert.includes('NBD PLEDGE · ' + y + '-YEAR WRITTEN WORKMANSHIP (LABOR) WARRANTY') && cert.includes(y + (y === 1 ? ' year' : ' years') + ' from issue date') && !/lifetime/i.test(cert), lifetimeHit(cert) || cert.slice(0, 400));
    const blk = text(DG.renderWarrantyFor({ warrantyTier: t, estimateLineItems: GAF_HDZ }));
    ok('[contract/proposal block] ' + label + ': Pledge + ' + y + '-Year, never lifetime', blk.includes(PLEDGE) && blk.includes(y + '-Year Workmanship') && !/lifetime/i.test(blk), lifetimeHit(blk) || blk);
  }
  if (RENDER) {
    const nbdDoc = await RENDER.buildDocHtml('warranty', Object.assign({}, base, { tier: 'standard', tierLabel: 'S', tierLabelLong: 'S', tierTerms: 'x', laborYears: 5, pledgeLine: PLEDGE }), OWNER_UID);
    ok('[render-pdf] NBD chrome: NBD Pledge seal, nothing "lifetime"', /NBD Pledge/.test(text(nbdDoc.html)) && !/lifetime/i.test(text(nbdDoc.html)), lifetimeHit(text(nbdDoc.html)));
    const other = await RENDER.buildDocHtml('warranty', Object.assign({}, base, { tier: 'standard', tierLabel: 'S', tierLabelLong: 'S', tierTerms: '', laborYears: 20, pledgeLine: PLEDGE, isPledge: true }), null);
    ok('[render-pdf] another company, even with a forged Pledge payload: no Pledge, no NBD years, no lifetime', !/pledge|lifetime|20-Year/i.test(text(other.html)), (text(other.html).match(/.{0,60}(pledge|lifetime|20-Year).{0,40}/i) || [''])[0]);
  }
  const options = text(DG.renderProposalOptions ? DG.renderProposalOptions({ homeownerName: 'Jane', address: '1 Elm', tierPrices: { economy: 10000, good: 12000, better: 14000, best: 16000, beyond: 18000 }, estimateLineItems: GAF_HDZ }) : '');
  if (options) ok('[proposal options] every card: the Pledge + its written years, never lifetime', TIERS.every((t) => options.includes(CFG.tierWarrantyText(t))) && options.includes(PLEDGE) && !/lifetime/i.test(options), lifetimeHit(options));
  const oaksDG = docgen('oaks-none');
  const oc = text(oaksDG.renderWarrantyCertificate({ homeownerName: 'Jane', address: '1 Elm', warrantyTier: 'better', estimateLineItems: GAF_HDZ }));
  ok('[docgen certificate] another company: no Pledge, no NBD years, no lifetime', !/pledge|lifetime|10-YEAR|10 years/i.test(oc), (oc.match(/.{0,60}(pledge|lifetime|10-YEAR|10 years).{0,40}/i) || [''])[0]);
}

// ═══════════════════════════════════════════════════════════════════
section('E. customer-facing CRM source: no "lifetime" warranty wording left (comments stripped)');
{
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1').replace(/\{\{!--[\s\S]*?--\}\}/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const FILES = ['docs/pro/js/estimate-config.js', 'docs/pro/js/tenant-rules.js', 'docs/pro/js/warranty-cert.js', 'docs/pro/js/customer-bootstrap.module.js',
    'docs/pro/js/document-generator.js', 'docs/pro/js/document-generator-templates.js', 'docs/pro/js/document-generator-library.js', 'docs/pro/js/doc-preflight.js',
    'docs/pro/js/close-board.js', 'docs/pro/js/estimate-finalization.js', 'docs/pro/js/estimate-v2-ui.js', 'docs/pro/js/company-profile.js', 'docs/pro/js/portal.js',
    'docs/pro/js/dashboard-ui.js', 'docs/pro/js/email_system.js', 'docs/pro/dashboard.html', 'functions/agent-mcp-logic.js', 'functions/render-pdf.js',
    'functions/print/templates/warranty.hbs', 'functions/print/templates/contract.hbs', 'functions/print/templates/estimate.hbs'];
  const ALLOWED = /never (be )?call(ed)? (it|anything)? ?(a )?"lifetime|not a "lifetime warranty"|Never write "lifetime warranty"|never a "lifetime"|never "lifetime"|\/lifetime\/i|never call a product warranty lifetime/i;
  const hits = [];
  for (const rel of FILES) {
    const lines = stripComments(read(rel).replace(/\r\n/g, '\n')).split('\n');
    lines.forEach((l, i) => { if (LIFETIME_WARRANTY.test(l) && !ALLOWED.test(l)) hits.push(rel + ':' + (i + 1) + ': ' + lifetimeHit(l)); });
  }
  ok('no customer-facing CRM string calls anything a lifetime warranty / workmanship / pledge', hits.length === 0, hits.slice(0, 6).join(' | '));
}

// ═══════════════════════════════════════════════════════════════════
// F. customer.html certificate — each company's own brand
// ═══════════════════════════════════════════════════════════════════
const CB = read('docs/pro/js/customer-bootstrap.module.js').replace(/\r\n/g, '\n');
const CERT_FN = (() => {
  const a = CB.indexOf('window.generateCertFromEstimate = async function(estimateId) {');
  const b = CB.indexOf('\n};\n', a);
  return a > 0 && b > a ? CB.slice(a, b + 3) : '';
})();
async function portalCert(brandWin, tier) {
  let html = null;
  const { win, ctx } = makeWin(brandWin.who, Object.assign({
    _customerEstimates: [{ id: 'est12345abc', tier, title: 'Roof replacement', lineItems: GAF_HDZ }],
    _currentLead: { firstName: 'Jane', lastName: '<b>Smith</b>', address: '1 Elm St', scheduledDate: '2026-10-01' },
    _companyProfileLoaded: true,
    open: () => ({ document: { write: (h) => { html = h; }, close() {} } }),
    getComputedStyle: () => ({ getPropertyValue: () => '#BD5728' }),
    document: { documentElement: {} },
    showToast() {}, Date, Math, JSON, String, Number, Promise,
  }, brandWin.extra || {}));
  vm.runInContext(CERT_FN, ctx, { filename: 'generateCertFromEstimate' });
  await win.generateCertFromEstimate('est12345abc');
  return html || '';
}
async function customerCertSection() {
  section('F. customer.html warranty certificate — each company\'s own name, logo and number');
  ok('generateCertFromEstimate found', !!CERT_FN);
  if (!CERT_FN) return;
  const nbd = await portalCert({ who: 'nbd', extra: { _tenantIdPrefix: async () => 'NBD' } }, 'good');
  ok('NBD: NBD logo, name and NBD- number (unchanged)', /src="\/assets\/images\/nbd-logo-light-bg\.png"/.test(nbd) && /class="logo-sub">No Big Deal Home Solutions</.test(nbd) && /NBD-EST12345/.test(nbd), nbd.slice(0, 300));
  ok('NBD: the Pledge + 5-year written warranty, never lifetime', text(nbd).includes(PLEDGE) && /5-Year Written Workmanship \(Labor\)/.test(nbd) && !/lifetime/i.test(text(nbd)), lifetimeHit(text(nbd)));
  ok('lead fields are escaped (stored-XSS rule)', !/<b>Smith<\/b>/.test(nbd) && /&lt;b&gt;Smith&lt;\/b&gt;/.test(nbd));

  const oaksBrand = { legalName: 'Oaks Roofing', seal: 'OAKS', logoUrl: 'https://cdn.example.com/oaks.png', colors: {}, contact: {} };
  const oaks = await portalCert({ who: 'oaks-own', extra: { _brand: () => oaksBrand, _tenantIdPrefix: async () => 'OAK' } }, 'good');
  ok('another company: its own name, seal and logo', /class="logo-sub">Oaks Roofing</.test(oaks) && /class="logo">OAKS</.test(oaks) && /src="https:\/\/cdn\.example\.com\/oaks\.png"/.test(oaks), oaks.slice(0, 600));
  ok('another company: its own certificate prefix (OAK-), never NBD-', /OAK-EST12345/.test(oaks) && !/NBD-/.test(oaks));
  ok('another company: no NBD name, logo, Pledge or NBD years', !/No Big Deal|nbd-logo|Pledge|lifetime/i.test(oaks) && !/5-Year Written/.test(oaks), (oaks.match(/.{0,60}(No Big Deal|nbd-logo|Pledge|lifetime|5-Year Written).{0,30}/i) || [''])[0]);
  ok('another company: its own configured workmanship sentence', oaks.includes(OAKS_OWN));
  ok('another company: work is "performed by" the company itself', /performed by Oaks Roofing at the above property/.test(oaks));

  const evil = { legalName: '<img src=x onerror=alert(1)>', seal: '"><script>alert(2)</script>', logoUrl: 'javascript:alert(3)', colors: {}, contact: {} };
  const ev = await portalCert({ who: 'oaks-none', extra: { _brand: () => evil, _tenantIdPrefix: async () => '<i>X' } }, 'better');
  ok('a hostile profile name / seal / prefix is escaped, never markup', !/<img src=x|<script>alert\(2\)|<i>X/.test(ev) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(ev) && /&lt;i&gt;X-/.test(ev), ev.slice(0, 700));
  ok('a javascript: logo URL is dropped', !/javascript:/i.test(ev));

  // A company whose profile still resolves to NBD's defaults (not set up yet).
  const unset = await portalCert({ who: 'oaks-none', extra: { _brand: () => ({ legalName: 'No Big Deal Home Solutions', logoUrl: 'https://nobigdealwithjoedeal.com/assets/images/nbd-logo.png', colors: {}, contact: {} }), _tenantIdPrefix: async () => 'NBD' } }, 'good');
  ok('an unconfigured company never wears NBD\'s name, logo or NBD- number', !/No Big Deal|nbd-logo|NBD-/.test(unset) && /CUS-EST12345/.test(unset), (unset.match(/.{0,60}(No Big Deal|nbd-logo|NBD-).{0,30}/i) || [''])[0]);
}

(async () => {
  await docsSection();
  await customerCertSection();
})().catch((e) => ok('async section threw', false, e && e.stack)).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
});
