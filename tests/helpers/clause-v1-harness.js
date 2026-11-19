/**
 * clause-v1-harness.js — renders the contract-class documents the same way every time, for the
 * clause-set v1 tests (2026-11-18): the client contract / proposal / work authorization HTML in a
 * page-shaped sandbox with the clock frozen, and the server e-sign estimate PDF with the clock frozen.
 *
 * Used by tests/clause-set-v1-2026-11-18.test.js. The flag-off golden hashes in
 * tests/fixtures/clause-set-v1-golden.json were recorded from origin/main BEFORE phase 2 touched a
 * renderer; the test compares today's render to them, which is the byte-identity proof.
 *
 *   node tests/helpers/clause-v1-harness.js --print    prints the golden JSON for the current tree
 *
 * Needs functions/node_modules (pdf-lib), like the other docgen suites.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const FIXED_ISO = '2026-11-18T15:00:00Z';
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FIXED_ISO); }
  static now() { return new RealDate(FIXED_ISO).getTime(); }
}

const KY_ADDR = '100 Kentucky Ave, Fort Thomas, KY 41075';
const OH_ADDR = '1 Elm St, Cincinnati, OH 45202';
const BIZ_ADDR = '100 Test Plaza, Florence, KY 41042';
const NO_STATE_ADDR = '9 Somewhere Rd';

// name -> { address, jobType }
const VARIANTS = {
  oh_cash: { address: OH_ADDR, jobType: 'cash' },
  oh_insurance: { address: OH_ADDR, jobType: 'insurance', claimNumber: 'CLM-8' },
  ky_cash: { address: KY_ADDR, jobType: 'cash' },
  ky_insurance: { address: KY_ADDR, jobType: 'insurance', claimNumber: 'CLM-7', insuranceCompany: 'State Farm' },
  oh_financed: { address: OH_ADDR, jobType: 'finance' },
  unknown_insurance: { address: NO_STATE_ADDR, jobType: 'insurance' },
};

function makeSandbox(extraWin) {
  const byId = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null,
      classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); } },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = {
    head: el('head'), body: el('body'), createElement: el,
    getElementById(id) { if (byId[id]) return byId[id]; const e = el('div'); e.id = id; byId[id] = e; return e; },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {},
  };
  const store = {};
  const localStorage = { getItem(k) { return k in store ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } };
  const win = Object.assign({ localStorage, document }, extraWin || {});
  win.window = win;
  const toasts = [];
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date: FixedDate, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test', pathname: '/pro/customer' },
    URL, URLSearchParams,
    showToast: (m, kind) => toasts.push({ m: String(m), kind }),
  };
  win.showToast = sandbox.showToast;
  vm.createContext(sandbox);
  return { win, sandbox, byId, toasts };
}
function load(env, rel) { vm.runInContext(read(rel), env.sandbox, { filename: path.basename(rel) }); }

/**
 * The docgen stack in a sandbox. opts.flags = { docClauseSetV1: true } turns a flag on in
 * window.NBDFlags; opts.brand overrides window._brand(); opts.extraFiles loads more scripts first.
 */
function docs(opts) {
  const o = opts || {};
  const flags = o.flags || {};
  const brand = o.brand || { legalName: 'No Big Deal Home Solutions', colors: {}, contact: { email: 'info@nobigdealwithjoedeal.com', phone: '(859) 420-7382' } };
  const env = makeSandbox({
    _brand: () => brand,
    NBDFlags: { enabled: (n) => flags[n] === true, get: (n) => flags[n], isLoaded: () => true },
  });
  const files = ['docs/pro/js/estimate-config.js', 'docs/pro/js/deposit-rule.js', 'docs/pro/js/ky-insurance-law.js'];
  // o.noClauseText: the wording file did not load (review 2026-11-18, item 5).
  ['docs/pro/js/clause-set-text.js', 'docs/pro/js/clause-set.js'].forEach((f) => { if (o.noClauseText && /clause-set-text/.test(f)) return; if (fs.existsSync(path.join(ROOT, f))) files.push(f); });
  if (fs.existsSync(path.join(ROOT, 'docs/pro/js/card-fee.js'))) files.push('docs/pro/js/card-fee.js');
  files.push('docs/pro/js/customer-estimate-rows.js', 'docs/pro/js/document-generator.js',
    'docs/pro/js/document-generator-templates.js', 'docs/pro/js/doc-preflight.js');
  if (fs.existsSync(path.join(ROOT, 'docs/pro/js/doc-send-checks.js'))) files.push('docs/pro/js/doc-send-checks.js');
  files.forEach((f) => load(env, f));
  // company-profile.js after the deposit rule, so window.NBD_COMPANY_PROFILE_DEFAULTS exists for _legal()
  load(env, 'docs/pro/js/company-profile.js');
  // company-profile.js defines its own _brand; a test that passes a brand gets that brand (the goldens use the default path)
  if (o.brand) env.win._brand = () => brand;
  return env;
}

const profileFor = (W, addr, extra) => {
  const D = W.NBD_COMPANY_PROFILE_DEFAULTS || {};
  return Object.assign({}, D, {
    businessAddress: '',
    brand: Object.assign({}, D.brand || {}, { contact: Object.assign({}, (D.brand || {}).contact || {}, { mailingAddress: addr }) }),
  }, extra || {});
};

const contractData = (W, v, extra) => Object.assign({
  homeownerName: 'Jane Smith', address: v.address, phone: '5135550100', email: 'jane@example.test',
  contractPrice: '$18,500.00', projectDescription: 'Roof replacement.', jobType: v.jobType,
  claimNumber: v.claimNumber, insuranceCompany: v.insuranceCompany,
  contractDate: '2026-09-28', companyProfile: profileFor(W, BIZ_ADDR), leadId: 'L1',
  startDate: 'December 1, 2026', estimatedCompletion: '5-7 business days',
}, extra || {});

/** Render one document type for one variant, with the page's lead doc set the way the generator reads it. */
function render(env, method, v, extra) {
  const W = env.win;
  const prev = W._leadDoc;
  W._leadDoc = { id: 'L1', address: v.address, jobType: v.jobType, claimNumber: v.claimNumber };
  try { return W.NBDDocGen[method](contractData(W, v, extra)); } finally { W._leadDoc = prev; }
}

/** Server e-sign estimate PDF for a state, with the clock frozen. Returns { bytes, text } (text = the layout's lines). */
async function esignPdf(state, extra) {
  const P = require(path.join(ROOT, 'functions/estimate-esign-pdf.js'));
  const prev = global.Date;
  global.Date = FixedDate;
  try {
    const input = Object.assign({
      companyName: 'No Big Deal Home Solutions', sellerAddress: BIZ_ADDR, state, title: 'Roofing Contract', estimateNumber: 'E1',
      preparedDate: 'November 18, 2026',
      customer: { name: 'Jane Smith', address: state === 'KY' ? KY_ADDR : OH_ADDR, phone: '5135550100', email: 'j@x.test' },
      lines: [{ name: 'Roof replacement', quantity: '30 SQ', lineTotalCents: 1850000 }, { name: 'Gutters', quantity: '120 LF', lineTotalCents: 90000 }],
      tierName: 'Preferred', totalCents: 1940000,
      depositPlan: { label: 'Due at signing', valueText: '$9,700.00', summary: '50% at signing, balance on completion.', rows: [{ label: 'Balance', due: 'on completion', amountText: '$9,700.00' }] },
      signers: [{ id: 's1', name: 'Jane Smith' }, { id: 's2', name: 'Pat Smith' }],
    }, extra || {});
    return await P.buildEstimateContractPdf(input);
  } finally { global.Date = prev; }
}

/** Every flag-off golden: name -> sha256. */
async function goldens() {
  const env = docs({});
  const out = {};
  Object.keys(VARIANTS).forEach((k) => {
    out['contract.' + k] = sha(render(env, 'renderContract', VARIANTS[k]));
  });
  ['oh_cash', 'ky_insurance'].forEach((k) => {
    out['proposal.' + k] = sha(render(env, 'renderProposal', VARIANTS[k]));
    out['workAuthorization.' + k] = sha(render(env, 'renderWorkAuthorization', VARIANTS[k]));
  });
  for (const st of ['OH', 'KY']) {
    const r = await esignPdf(st);
    out['esignPdf.' + st] = sha(Buffer.from(r.bytes));
  }
  const r2 = await esignPdf('OH', { depositPlan: null, lines: [], tierName: null, signers: [{ id: 's1', name: 'Jane Smith' }] });
  out['esignPdf.OH.bare'] = sha(Buffer.from(r2.bytes));
  return out;
}

module.exports = { ROOT, read, sha, load, makeSandbox, docs, profileFor, contractData, render, esignPdf, goldens, FixedDate, VARIANTS, KY_ADDR, OH_ADDR, BIZ_ADDR, NO_STATE_ADDR };

if (require.main === module && process.argv.includes('--print')) {
  goldens().then((g) => { process.stdout.write(JSON.stringify(g, null, 2) + '\n'); }).catch((e) => { console.error(e); process.exit(1); });
}
