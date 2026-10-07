/**
 * tests/doc-template-library.test.js — the 2026-10-04 template library.
 *
 * Jo: "we need to greatly expand templates contracts proposals etc", and yes
 * to lien waivers. docs/pro/js/document-generator-library.js adds lien
 * waivers (4 kinds x OH/KY), the 3-day right-to-cancel notice, a material &
 * color selection sheet, a one-page Good-Better-Best comparison and a
 * Kentucky-safe insurance next-steps letter; document-generator-templates.js
 * extends the change order, completion certificate and warranty certificate.
 *
 * Every renderer is loaded the way the browser loads it (ky-insurance-law,
 * deposit-rule, estimate-config, document-generator, -templates, -library,
 * doc-preflight) and fed a fixture lead + estimate + company profile.
 *
 *   1. RENDER — each template, the key fields land in the output.
 *   2. MONEY + SIGNING — the change order's totals are cents-exact and foot;
 *      signable templates emit [data-nbd-sig] canvases when the pre-flight
 *      seeded signers (before: bare lines on every -templates.js document,
 *      so "Send for Signature" offered a document with nothing to sign).
 *   3. PRE-FLIGHT — the warranty certificate names the shingle on the
 *      estimate (before: the pre-flight never passed the estimate's items, so
 *      every certificate it produced named GAF's warranty, TAMKO roofs too).
 *   4. KENTUCKY WORDING — every new template, rendered for a Kentucky
 *      insurance job, passes the claim-wording rules (the RULES of
 *      tests/claim-wording.test.js, loaded from that file, and the CRM's
 *      ky-claims-wording-scan phrases), with a positive control.
 *   5. ATTORNEY BADGE — "DRAFT — have your attorney review" is CRM picker
 *      chrome: the three legal templates carry it in customer.html and the
 *      Create Document modal, and NO rendered document ever does.
 *   6. REACHABLE — every new type has a tile, a catalog entry, a
 *      prerequisite entry, a pre-flight schema, and rides the docgen bundle.
 *
 * Run: node tests/doc-template-library.test.js
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

const NEW_TYPES = ['lien_waiver', 'right_to_cancel', 'material_selection', 'proposal_options', 'insurance_next_steps'];
const ATTORNEY = ['lien_waiver', 'change_order', 'right_to_cancel'];

// ── Sandbox ─────────────────────────────────────────────────────────────
const MAILING = '4400 Test Pike, Cincinnati, OH 45202';
function loadEnv(opts) {
  opts = opts || {};
  const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: { mailingAddress: MAILING } };
  const win = { _brand: () => brand, _leadDoc: opts.lead || null };
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
  for (const f of files) {
    const src = opts.override && opts.override[f] != null ? opts.override[f] : fs.readFileSync(path.join(JS, f), 'utf8');
    vm.runInContext(src, sb, { filename: f });
  }
  return { win, dg: win.NBDDocGen, pf: win.DocPreflight };
}
const env = loadEnv();
const DG = env.dg;

function text(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;|’/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '·').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

// Fixture: lead + estimate + profile, as the CRM holds them.
const KY_LEAD = {
  id: 'L-KY', firstName: 'Dana', lastName: 'Whitfield', address: '18 Linden Ave, Fort Thomas, KY 41075',
  phone: '859-555-0142', email: 'dana@example.test', jobType: 'insurance', insCarrier: 'State Farm',
  claimNumber: 'SF-77-1203', dateOfLoss: '2026-08-14', scopeOfWork: 'Hail bruising on the south and west slopes; replace the roof.',
  deductibleOrOwedByHO: 1000,
};
const OH_LEAD = {
  id: 'L-OH', firstName: 'Marcus', lastName: 'Reyes', address: '902 Ridge Rd, Cincinnati, OH 45230',
  phone: '513-555-0190', email: 'marcus@example.test', jobType: 'retail', scopeOfWork: 'Full tear-off and replacement.',
};
const ESTIMATE = {
  id: 'E1', priceMode: 'per-sq', tier: 'better', selectedTier: 'better',
  prices: { economy: 9680, good: 12100, better: 14520, best: 16940, beyond: 19360 },
  rows: [{ code: 'RFG 240-TAMKO-HAIL', name: 'TAMKO HailGuard Shingles', materialTotal: 4000 }, { code: 'RFG FELT', name: 'Synthetic underlayment' }],
};
function baseFor(lead) {
  return {
    leadId: lead.id, firstName: lead.firstName, lastName: lead.lastName,
    homeownerName: lead.firstName + ' ' + lead.lastName, address: lead.address,
    jobType: lead.jobType, insCarrier: lead.insCarrier || '', claimNumber: lead.claimNumber || '',
    scopeOfWork: lead.scopeOfWork, projectDescription: lead.scopeOfWork, dateOfLoss: lead.dateOfLoss || '',
  };
}
const KY = baseFor(KY_LEAD);
const OH = baseFor(OH_LEAD);
const SIGN = (roles) => roles.map((r) => ({ role: r, label: r === 'rep' ? 'Authorized NBD Representative' : 'Homeowner', required: true }));

function render(method, data, e) {
  try { return (e || env).dg[method](JSON.parse(JSON.stringify(data))); }
  catch (err) { return 'RENDER_ERROR: ' + (err && err.stack || err); }
}

// ════════════════════════════════════════════════════════════════════════
section('1. RENDER — key fields reach every template');
// ════════════════════════════════════════════════════════════════════════
ok('library loaded: NBDDocGen._tpl + five render methods',
  !!DG._tpl && ['renderLienWaiver', 'renderRightToCancel', 'renderMaterialSelection', 'renderProposalOptions', 'renderInsuranceNextSteps']
    .every((m) => typeof DG[m] === 'function'));
NEW_TYPES.forEach((t) => ok('DOCUMENT_TYPES.' + t + ' registered with its renderer',
  !!DG.DOCUMENT_TYPES[t] && typeof DG[DG.DOCUMENT_TYPES[t].template] === 'function'));

// Lien waivers: 4 kinds x 2 states.
const WAIVER = { amount: '12500.50', checkNumber: '4471', throughDate: '2026-10-01', payerType: 'mortgage', mortgageCompany: 'Union Savings Bank', loanNumber: 'LN-55' };
for (const kind of ['conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final']) {
  for (const [st, base] of [['KY', KY], ['OH', OH]]) {
    const html = render('renderLienWaiver', Object.assign({}, base, WAIVER, { waiverKind: kind, waiverState: st, signers: SIGN(['rep']) }));
    const tx = text(html);
    const tag = 'lien ' + kind + ' ' + st + ': ';
    ok(tag + 'renders', html.indexOf('RENDER_ERROR') !== 0, html.slice(0, 300));
    ok(tag + 'owner + property + payer + amount + check no.',
      tx.includes(base.homeownerName) && tx.includes(base.address) && tx.includes('Mortgage company — Union Savings Bank')
      && tx.includes('$12,500.50') && tx.includes('4471') && tx.includes('LN-55'));
    ok(tag + (kind.startsWith('conditional') ? 'says conditional' : 'says unconditional'),
      kind.startsWith('conditional') ? /This waiver is conditional/.test(tx) && !/This waiver is unconditional/.test(tx)
        : /This waiver is unconditional/.test(tx) && !/This waiver is conditional/.test(tx));
    if (kind.endsWith('progress')) ok(tag + 'through-date in plain words', tx.includes('through October 1, 2026'));
    else ok(tag + 'final: all work, no through-date limit', tx.includes('All work under the contract') && !tx.includes('It does not cover work done after'));
    ok(tag + 'state law named', st === 'KY' ? tx.includes('Kentucky Revised Statutes Chapter 376') : tx.includes('Ohio Revised Code Chapter 1311'));
    ok(tag + 'contractor signs in-app ([data-nbd-sig="rep"])', /data-nbd-sig="rep"/.test(html));
    ok(tag + 'subcontractors described as independent', tx.includes('independent subcontractors'));
  }
}
{
  const kyIns = text(render('renderLienWaiver', Object.assign({}, KY, WAIVER, { waiverKind: 'conditional_final' })));
  const ohCash = text(render('renderLienWaiver', Object.assign({}, OH, WAIVER, { waiverKind: 'conditional_final' })));
  ok('lien KY insurance job carries the KRS 367.628(2)(g) lien undertaking', kyIns.includes('will not file or claim a mechanic\'s lien for any amount in excess of what your insurer pays'));
  ok('lien OH cash job does not', !ohCash.includes('in excess of what your insurer pays'));
  ok('lien state comes from the address when not chosen (KY address → Kentucky)', kyIns.includes('Kentucky Revised Statutes Chapter 376'));
  const ins = text(render('renderLienWaiver', Object.assign({}, KY, { amount: 800, payerType: 'insurance', waiverKind: 'unconditional_progress' })));
  ok('lien payer = insurance names the carrier on file and the owner\'s claim no.', ins.includes('Insurance company — State Farm') && ins.includes('SF-77-1203'));
  const notary = render('renderLienWaiver', Object.assign({}, OH, WAIVER, { includeNotary: true }));
  ok('lien notary block only when asked', /lib-notary/.test(notary) && !/class="lib-notary"/.test(render('renderLienWaiver', Object.assign({}, OH, WAIVER))));
}

// Right to cancel.
{
  const oh = render('renderRightToCancel', Object.assign({}, OH, { contractDate: '2026-10-02', signers: SIGN(['homeowner']) }));
  const tx = text(oh);
  ok('cancel OH: renders', oh.indexOf('RENDER_ERROR') !== 0, oh.slice(0, 300));
  ok('cancel OH: contract date + 3-business-day deadline (Fri Oct 2 → Tue Oct 6; Sunday skipped)',
    tx.includes('October 2, 2026') && tx.includes('Last day to cancel October 6, 2026'));
  ok('cancel OH: names Ohio\'s Home Solicitation Sales Act', tx.includes('Ohio Revised Code 1345.21 to 1345.28'));
  ok('cancel OH: the FTC 429.1(a) statement, verbatim from ky-insurance-law.js', /data-nbd-statutory="ftc-429-1-a"/.test(oh)
    && tx.includes('You, the buyer, may cancel this transaction at any time prior to midnight of the third business day'));
  ok('cancel OH: two completed FTC Notice of Cancellation forms', (oh.match(/data-nbd-noc="ftc"/g) || []).length === 2);
  ok('cancel OH: seller address = the Company Profile mailing address', tx.includes(MAILING));
  ok('cancel OH: no Kentucky insurance form on an Ohio cash job', !/data-nbd-noc="ky"/.test(oh));
  ok('cancel OH: homeowner acknowledges in-app ([data-nbd-sig="homeowner"])', /data-nbd-sig="homeowner"/.test(oh));
  const ky = render('renderRightToCancel', Object.assign({}, KY, { contractDate: '2026-10-02' }));
  ok('cancel KY insurance: names Kentucky\'s home solicitation law', text(ky).includes('Kentucky Revised Statutes 367.410 to 367.460'));
  ok('cancel KY insurance: adds the two KRS 367.624(4) forms + the 367.624(3) notices',
    (ky.match(/data-nbd-noc="ky"/g) || []).length === 2 && /data-nbd-statutory="ky-367-624-3"/.test(ky));
}

// Material selection.
{
  const html = render('renderMaterialSelection', Object.assign({}, OH, {
    shingleColor: 'Weathered Wood', dripEdge: 'Style D — brown', ventilation: 'Ridge vent', gutters: '6" K-style seamless',
    gutterColor: 'Musket brown', estimateLineItems: [{ code: 'RFG 240-TAMKO-HAIL', name: 'TAMKO HailGuard Shingles' }],
    warrantyTier: 'beyond', signers: SIGN(['homeowner', 'rep']) }));
  const tx = text(html);
  ok('materials: renders', html.indexOf('RENDER_ERROR') !== 0, html.slice(0, 300));
  ok('materials: shingle line from the estimate + every selection', ['TAMKO HailGuard Shingles', 'Weathered Wood', 'Style D — brown', 'Ridge vent', '6" K-style seamless', 'Musket brown'].every((s) => tx.includes(s)));
  ok('materials: package named by its customer label (Beyond)', tx.includes('Beyond package'));
  ok('materials: homeowner AND rep sign in-app', /data-nbd-sig="homeowner"/.test(html) && /data-nbd-sig="rep"/.test(html));
  const none = text(render('renderMaterialSelection', OH));
  ok('materials: no estimate → no invented shingle line (no GAF default)', !/GAF/.test(none));
}

// Good-Better-Best options.
{
  const html = render('renderProposalOptions', Object.assign({}, OH, { tierPrices: ESTIMATE.prices, selectedTier: 'better' }));
  const tx = text(html);
  ok('options: renders', html.indexOf('RENDER_ERROR') !== 0, html.slice(0, 300));
  ok('options: five priced packages, cheapest first, customer labels',
    /Economy \$9,680\.00.*Standard \$12,100\.00.*Preferred (As quoted )?\$14,520\.00.*Elite \$16,940\.00.*Beyond \$19,360\.00/.test(tx));
  ok('options: the quoted package is marked', /data-tier="better"/.test(html) && /lib-tier lib-quoted" data-tier="better"/.test(html) && tx.includes('As quoted'));
  ok('options: Economy = 1-year labor + no system warranty; Beyond = TAMKO HailGuard', tx.includes('1-year written workmanship (labor) warranty') && /no system warranty/i.test(tx) && tx.includes('TAMKO HailGuard shingles') && !/lifetime/i.test(tx));
  // The figure is deposit-rule.js's own (50%, rounded to its step) — asked of
  // the rule here, never re-derived.
  const dep = env.win.NBDDepositRule.fromEstimate({}, { totalCents: 1452000 });
  const prefCard = (html.match(/data-tier="better">([\s\S]*?)<\/dl><\/div>/) || [])[1] || '';
  ok('options: deposit from deposit-rule.js (cash $14,520 → ' + dep.valueText + ' at signing)',
    dep.depositCents > 0 && text(prefCard).includes('Due at signing: ' + dep.valueText), text(prefCard));
  const ky = text(render('renderProposalOptions', Object.assign({}, KY, { tierPrices: ESTIMATE.prices, deductible: 1000 })));
  ok('options KY insurance: nothing due at signing on any package (KRS 367.626)',
    (ky.match(/Due at signing: \$0\b/g) || []).length === 5 && !/Due at signing: \$[1-9]/.test(ky));
  const empty = text(render('renderProposalOptions', OH));
  ok('options: no prices → says so, prints no $0 package', empty.includes('Option prices appear here') && !/\$0\.00/.test(empty));
}

// Insurance next steps.
{
  const html = render('renderInsuranceNextSteps', KY);
  const tx = text(html);
  ok('next-steps: renders', html.indexOf('RENDER_ERROR') !== 0, html.slice(0, 300));
  ok('next-steps: name, carrier, claim no., date of loss, scope', ['Dear Dana', 'State Farm', 'SF-77-1203', 'August 14, 2026', 'Hail bruising on the south and west slopes'].every((s) => tx.includes(s)));
  ok('next-steps: the homeowner owns the claim; we are not a public adjuster',
    tx.includes('Your insurance claim is between you and your insurance company') && tx.includes('not a public adjuster'));
  ok('next-steps KY: nothing due at signing + 5-business-day cancel + $100 cap', tx.includes('Nothing is due when you sign') && tx.includes('5 business days') && tx.includes('more than $100'));
  ok('next-steps OH: no Kentucky section', !text(render('renderInsuranceNextSteps', Object.assign({}, OH, { jobType: 'insurance', insCarrier: 'Erie' }))).includes('Kentucky homeowners'));
}

// Warranty certificate, per tier, from the tier data.
{
  const items = [{ code: 'RFG 240-TAMKO-TITAN', name: 'TAMKO Titan XT' }];
  const want = {
    // 2026-10-06 (Jo, final): the badge names the NBD Pledge (a promise) and
    // the package's WRITTEN labor years — never "lifetime"; the manufacturer
    // warranty is what the job bought (tenant-rules.js warrantyLines).
    economy: ['NBD PLEDGE · 1-YEAR WRITTEN WORKMANSHIP (LABOR) WARRANTY — ECONOMY TIER', "TAMKO's standard limited warranty on the shingles; no system warranty"],
    good: ['NBD PLEDGE · 5-YEAR WRITTEN WORKMANSHIP (LABOR) WARRANTY — STANDARD TIER', "TAMKO's standard limited warranty on the TAMKO Titan XT (manufacturer terms apply)"],
    better: ['NBD PLEDGE · 10-YEAR WRITTEN WORKMANSHIP (LABOR) WARRANTY — PREFERRED TIER', "TAMKO's standard limited warranty on the TAMKO Titan XT (manufacturer terms apply)"],
    best: ['NBD PLEDGE · 20-YEAR WRITTEN WORKMANSHIP (LABOR) WARRANTY — ELITE TIER', "TAMKO's standard limited warranty on the TAMKO Titan XT (manufacturer terms apply)"],
    beyond: ['NBD PLEDGE · 20-YEAR WRITTEN WORKMANSHIP (LABOR) WARRANTY — BEYOND TIER', 'TAMKO HailGuard hail warranty'],
  };
  for (const [tier, [badge, mfg]] of Object.entries(want)) {
    const tx = text(render('renderWarrantyCertificate', Object.assign({}, OH, { warrantyTier: tier, installDate: '2026-09-30', issueDate: '2026-10-01', estimateLineItems: items })));
    ok('warranty ' + tier + ': workmanship badge + manufacturer warranty by name + install date + address',
      tx.includes(badge) && tx.includes('Manufacturer Warranty ' + mfg) && tx.includes('Install Date September 30, 2026') && tx.includes(OH.address), tx.slice(0, 600));
  }
}

// ════════════════════════════════════════════════════════════════════════
section('2. MONEY + SIGNING — change order, completion certificate');
// ════════════════════════════════════════════════════════════════════════
const coFigures = (html) => {
  const g = (k) => ((html.match(new RegExp('data-co-figure="' + k + '"[^>]*>([^<]*)<')) || [])[1] || '').trim();
  return { original: g('original'), change: g('change'), new: g('new') };
};
{
  // The pre-flight's newTotal used to default to a literal 0, which the
  // renderer trusted: "New Total $0.00" on a document the homeowner signs.
  const co = render('renderChangeOrder', Object.assign({}, OH, { originalTotal: '15000', changeAmount: '1250.25', newTotal: '0', changeDescription: 'Replace 3 sheets of rotted decking.', scheduleDays: '2', newCompletionDate: '2026-10-20', signers: SIGN(['homeowner', 'rep']) }));
  const f = coFigures(co);
  const tx = text(co);
  ok('change order: figures foot in cents ($15,000.00 + $1,250.25 = $16,250.25), never $0.00', f.original === '$15,000.00' && f.change === '+$1,250.25' && f.new === '$16,250.25', JSON.stringify(f));
  ok('change order: blank New Total computes too', coFigures(render('renderChangeOrder', { originalTotal: 9000, changeAmount: '-0.29' })).new === '$8,999.71');
  ok('change order: a typed New Total wins', coFigures(render('renderChangeOrder', { originalTotal: 9000, changeAmount: 500, newTotal: 9600 })).new === '$9,600.00');
  ok('change order: itemized rows sum in cents (3 x $0.10 = $0.30, not $0.30000000000000004)',
    coFigures(render('renderChangeOrder', { originalTotal: 0, itemsAdded: [{ description: 'Nails', qty: 3, unit: 'ea', price: 0.1 }] })).change === '+$0.30');
  ok('change order: effect on schedule — days added + new completion date', tx.includes('adds 2 working days') && tx.includes('New estimated completion: October 20, 2026'));
  ok('change order: description reaches the doc without the pre-flight bridge', tx.includes('Replace 3 sheets of rotted decking.'));
  ok('change order: homeowner and rep sign in-app', /data-nbd-sig="homeowner"/.test(co) && /data-nbd-sig="rep"/.test(co));
  ok('change order: no "[Contract #]" placeholder when none is on file', !tx.includes('[Contract #]'));
  const coc = render('renderCertificateOfCompletion', Object.assign({}, OH, { signers: SIGN(['homeowner', 'rep']) }));
  ok('completion certificate: homeowner signs off in-app', /data-nbd-sig="homeowner"/.test(coc));
  // -templates.js used to REPLACE these core entries with {name, template},
  // dropping defaultSigners — so the pre-flight seeded no signers at all.
  ['change_order', 'certificate_of_completion', 'scope_of_work', 'work_authorization', 'payment_agreement'].forEach((t) => {
    const ds = DG.DOCUMENT_TYPES[t] && DG.DOCUMENT_TYPES[t].defaultSigners;
    ok(t + ': keeps its defaultSigners after -templates loads (homeowner seeded in the pre-flight)',
      Array.isArray(ds) && ds.some((s) => s.role === 'homeowner') && DG.DOCUMENT_TYPES[t].template && typeof DG[DG.DOCUMENT_TYPES[t].template] === 'function');
  });
  const noSigners = render('renderChangeOrder', OH);
  ok('no signers → the printed ink lines, as before (no canvas)', !/data-nbd-sig=/.test(noSigners) && /sig-line/.test(noSigners));
}
{
  const T = DG._tpl;
  ok('toCents: "0.29" = 29, "$1,234.50" = 123450, "-12.5" = -1250, "" = 0, 19.99 = 1999',
    T.toCents('0.29') === 29 && T.toCents('$1,234.50') === 123450 && T.toCents('-12.5') === -1250 && T.toCents('') === 0 && T.toCents(19.99) === 1999);
  ok('centsText: 1625025 → $16,250.25, -29 → -$0.29', T.centsText(1625025) === '$16,250.25' && T.centsText(-29) === '-$0.29');
}

// ════════════════════════════════════════════════════════════════════════
section('3. PRE-FLIGHT — the certificate names the shingle on the estimate');
// ════════════════════════════════════════════════════════════════════════
function viaPreflight(e, type, method, data) {
  e.pf._state.type = type;
  e.pf._state.estimate = ESTIMATE;
  const d = Object.assign({}, data);
  e.pf._hydrateDerivedFields(d);
  return { data: d, html: render(method, d, e) };
}
{
  // Preferred, not Beyond: Beyond's tier text names HailGuard by itself, so
  // only a tier that leaves the shingle to the estimate can show the gap.
  const r = viaPreflight(env, 'warranty_certificate', 'renderWarrantyCertificate', Object.assign({}, OH, { warrantyTier: 'better', installDate: '2026-09-30' }));
  ok('warranty via pre-flight: TAMKO HailGuard roof → TAMKO, never GAF', /TAMKO HailGuard/.test(r.html) && !/GAF/.test(r.html), text(r.html).slice(0, 500));
  ok('pre-flight passes identity only (code + name, no prices)', Array.isArray(r.data.estimateLineItems) && r.data.estimateLineItems.length === 2
    && r.data.estimateLineItems.every((i) => Object.keys(i).sort().join() === 'code,name'));
  const o = viaPreflight(env, 'proposal_options', 'renderProposalOptions', Object.assign({}, OH));
  ok('options via pre-flight: tier prices + quoted tier come from the estimate (no retyping)', o.data.tierPrices === ESTIMATE.prices && o.data.selectedTier === 'better' && /Preferred (As quoted )?\$14,520\.00/.test(text(o.html)));
  const c = viaPreflight(env, 'contract', 'renderContract', Object.assign({}, OH));
  ok('other documents\' merge data unchanged (no estimateLineItems / tierPrices added to a contract)', c.data.estimateLineItems === undefined && c.data.tierPrices === undefined);
  const S = env.pf.DOC_SCHEMAS;
  NEW_TYPES.forEach((t) => ok('pre-flight schema: ' + t, !!(S[t] && Array.isArray(S[t].sections) && S[t].sections.length)));
  const newTotal = S.change_order.sections.reduce((a, s) => a.concat(s.fields), []).find((f) => f.key === 'newTotal');
  ok('change order New Total no longer defaults to a required 0', newTotal && !newTotal.required && newTotal.source === 'literal:');
  const ocd = S.change_order.sections.reduce((a, s) => a.concat(s.fields), []).find((f) => f.key === 'originalContractDate');
  const resolve = (lead) => env.pf._resolveFieldValue(ocd, { lead, estimate: null, overrides: {} });
  ok('change order Original Contract Date: the signed date when the CRM has one, blank (never today) when not',
    resolve({ contractFiledAt: '2026-08-03T15:00:00' }) === '2026-08-03' && resolve({}) === '');
}

// ════════════════════════════════════════════════════════════════════════
section('4. KENTUCKY WORDING — every new template, on a Kentucky insurance job');
// ════════════════════════════════════════════════════════════════════════
// The rules ARE tests/claim-wording.test.js's — loaded from it, not copied.
const CW = (() => {
  const src = read('tests/claim-wording.test.js');
  const cut = src.indexOf('function walk(');
  if (cut < 0) throw new Error('claim-wording.test.js layout changed: no walk()');
  const sb = { require, __dirname: path.join(ROOT, 'tests'), module: {}, console };
  vm.createContext(sb);
  vm.runInContext(src.slice(0, cut) + '\n;this.__cw = { RULES, checkSentence, sentences, decode };', sb);
  return sb.__cw;
})();
const CRM_BANNED = [/claims? (specialist|expert)/i, /insurance (restoration )?specialist/i, /handle the entire (insurance )?claim/i];
function wordingHits(html) {
  const ss = CW.sentences(CW.decode(html));
  const hits = [];
  ss.forEach((s, i) => {
    CW.checkSentence(s, [ss[i - 1], s, ss[i + 1]].filter(Boolean).join(' ')).forEach((id) => hits.push(id + ': ' + s.slice(0, 160)));
    CRM_BANNED.forEach((re) => { if (re.test(s)) hits.push('crm-banned: ' + s.slice(0, 160)); });
  });
  return hits;
}
ok('scanner positive control: flags "We handle the insurance claim for you."', wordingHits('<p>We handle the insurance claim for you.</p>').length > 0);
ok('scanner positive control: flags "we work directly with your insurance company"', wordingHits('<p>I document everything and work directly with your insurance company.</p>').length > 0);
const KY_RENDERS = {
  lien_waiver: render('renderLienWaiver', Object.assign({}, KY, WAIVER, { payerType: 'insurance', amount: 4000 })),
  right_to_cancel: render('renderRightToCancel', Object.assign({}, KY, { contractDate: '2026-10-02' })),
  material_selection: render('renderMaterialSelection', Object.assign({}, KY, { shingleColor: 'Charcoal' })),
  proposal_options: render('renderProposalOptions', Object.assign({}, KY, { tierPrices: ESTIMATE.prices })),
  insurance_next_steps: render('renderInsuranceNextSteps', KY),
  change_order: render('renderChangeOrder', Object.assign({}, KY, { originalTotal: 15000, changeAmount: 500 })),
  certificate_of_completion: render('renderCertificateOfCompletion', KY),
  warranty_certificate: render('renderWarrantyCertificate', Object.assign({}, KY, { warrantyTier: 'beyond' })),
};
for (const [t, html] of Object.entries(KY_RENDERS)) {
  const hits = wordingHits(html);
  ok('KY wording clean: ' + t, html.indexOf('RENDER_ERROR') !== 0 && hits.length === 0, hits.slice(0, 3).join(' | ') || html.slice(0, 200));
  ok('no assignment of benefits / direction to pay: ' + t, !/assignment of (insurance )?benefits|direction to pay|insurance assignments? accepted/i.test(text(html)));
}
// The library source too, comments stripped (ky-claims-wording-scan style).
{
  const lib = fs.readFileSync(path.join(JS, 'document-generator-library.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('library source: no CRM-banned claim phrase', !CRM_BANNED.some((re) => re.test(lib)));
}

// ════════════════════════════════════════════════════════════════════════
section('5. ATTORNEY BADGE — CRM picker only, never the customer\'s copy');
// ════════════════════════════════════════════════════════════════════════
const BADGE_RE = /DRAFT|attorney review|review before first use|have your attorney/i;
ok('DG.ATTORNEY_REVIEW_TYPES = lien waiver, change order, right to cancel', JSON.stringify(DG.ATTORNEY_REVIEW_TYPES) === JSON.stringify(ATTORNEY));
ATTORNEY.forEach((t) => ok('DOCUMENT_TYPES.' + t + '.attorneyReview', DG.DOCUMENT_TYPES[t] && DG.DOCUMENT_TYPES[t].attorneyReview === true));
{
  const all = Object.assign({}, KY_RENDERS, {
    lien_waiver_oh: render('renderLienWaiver', Object.assign({}, OH, WAIVER, { signers: SIGN(['rep']) })),
    right_to_cancel_oh: render('renderRightToCancel', Object.assign({}, OH, { signers: SIGN(['homeowner']) })),
    change_order_signed: render('renderChangeOrder', Object.assign({}, OH, { signers: SIGN(['homeowner', 'rep']) })),
  });
  for (const [t, html] of Object.entries(all)) ok('customer output has no attorney/draft badge: ' + t, !BADGE_RE.test(html), (html.match(BADGE_RE) || [])[0]);
  // Positive control: the same regex DOES see the badge in the picker markup.
  const cust = read('docs/pro/customer.html');
  ok('badge regex positive control: matches the picker markup', BADGE_RE.test(cust));
}
{
  const cust = read('docs/pro/customer.html');
  const grid = cust.slice(cust.indexOf('id="docTemplateGrid"'), cust.indexOf('<!-- UPLOAD SIGNED DOCUMENT -->'));
  const tiles = grid.split('<div class="doc-template-card ui-tile"').slice(1);
  const badged = tiles.filter((t) => /dt-draft-badge/.test(t)).map((t) => (t.match(/data-doc-type="([^"]+)"/) || [])[1]).sort();
  ok('customer.html: exactly the three legal tiles carry the badge', JSON.stringify(badged) === JSON.stringify(ATTORNEY.slice().sort()), badged.join(','));
  ok('customer.html: badge text in full', (grid.match(/DRAFT — have your attorney review before first use/g) || []).length === 3);
  ok('customer.html: .dt-draft-badge is styled (a class, no inline style)', /\.dt-draft-badge\s*\{/.test(cust) && !/dt-draft-badge"[^>]*style=/.test(cust));
  const ui = read('docs/pro/js/customer-tasks-ui.js');
  const cat = ui.slice(ui.indexOf('window._DOC_TEMPLATE_CATALOG = ['), ui.indexOf('window._STAGE_TEMPLATE_PRIORITY'));
  const draftTypes = cat.split('\n').filter((l) => /type:'/.test(l) && /draft:true/.test(l)).map((l) => (l.match(/type:'([^']+)'/) || [])[1]).sort();
  ok('Create Document modal catalog: draft:true on exactly the three', JSON.stringify(draftTypes) === JSON.stringify(ATTORNEY.slice().sort()), draftTypes.join(','));
  ok('Create Document modal renders the badge for draft entries', /t\.draft \? '<div class="dt-draft-badge"/.test(ui));
}

// ════════════════════════════════════════════════════════════════════════
section('6. REACHABLE — tile, catalog, prerequisites, bundle');
// ════════════════════════════════════════════════════════════════════════
{
  const cust = read('docs/pro/customer.html');
  const ui = read('docs/pro/js/customer-tasks-ui.js');
  const prereq = ui.slice(ui.indexOf('const DOC_PREREQUISITES = {'), ui.indexOf('function getCustomerDocData'));
  NEW_TYPES.forEach((t) => {
    ok(t + ': Generate Documents tile on customer.html', new RegExp('data-action="generateCustomerDoc" data-doc-type="' + t + '"').test(cust));
    ok(t + ': Create Document modal entry', new RegExp("type:'" + t + "'").test(ui));
    ok(t + ': prerequisite entry', new RegExp('\\b' + t + ':\\s*\\{ needs:').test(prereq));
  });
  ok('receipt: the existing renderer + pre-flight now have a tile and a catalog entry',
    /data-action="generateCustomerDoc" data-doc-type="receipt"/.test(cust) && /type:'receipt'/.test(ui) && !!env.pf.DOC_SCHEMAS.receipt);
  const loader = read('docs/pro/js/script-loader.js');
  const bundle = (loader.match(/docgen:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  const iT = bundle.indexOf('document-generator-templates.js'), iL = bundle.indexOf('document-generator-library.js'), iP = bundle.indexOf('doc-preflight.js');
  ok('docgen bundle loads the library after -templates and before doc-preflight', iT > -1 && iL > iT && iP > iL);
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
