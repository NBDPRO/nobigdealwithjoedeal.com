/**
 * tests/ky-insurance-contracts.test.js — Kentucky insurance-job contracts.
 *
 * 2026 Ky. Acts ch. 54 (SB 153), contracts on/after 2026-07-15 for Kentucky
 * real-estate work expected to be paid from property/casualty insurance:
 *   KRS 367.624  contractor mailing address + phone/email; two notices in
 *                >= 10pt boldface; a fully completed, detachable NOTICE OF
 *                CANCELLATION in duplicate — all BEFORE the contract is signed
 *   KRS 304.20-105  an assignment of policy rights/benefits is void, and a
 *                contract carrying one is void and unenforceable
 *   KRS 367.628(2)(g)  no lien for more than the insurer pays
 * plus the FTC Cooling-Off form (16 CFR 429.1(b)) the server contract promised
 * as "attached" and never attached.
 *
 * Every surface is the REAL code, loaded the way the page loads it:
 *   A. docs/pro/js/ky-insurance-law.js — detection (fail closed), business
 *      days, the statutory text verbatim, and the functions/ copy identical
 *   B. document-generator.js renderContract — KY insurance / OH insurance /
 *      OH cash / unknown-state insurance fixtures
 *   C. renderProposal (signable) — KY insurance vs cash
 *   D. functions/render-pdf.js buildContractStatutory + the REAL contract.hbs
 *   E. NBDDocGen.generate gates — no AOB in Kentucky, no KY insurance
 *      contract without the business address
 *   F. doc-preflight.js — the address block, the $0-at-signing plan (Jo,
 *      2026-09-27; KRS 367.626), the jurisdiction stamp
 *   G. no assignment / direction-to-pay / co-payee instrument anywhere (Jo,
 *      2026-09-27): the plain Payment clause on every contract; the address
 *      printed only from brand.contact.mailingAddress, never the letterhead
 *   H. crm-stages.js — "Claim Filed" no longer needs any AOB stamp
 *   I. close-board.js deal room — a Kentucky insurance deal is a contract entry
 *   J. the Kentucky payment hold — deposit-rule.js $0 at signing; the online
 *      pay link withheld until the carrier's written decision + 5 business
 *      days (ky-insurance-law.js payLinkHold, what createStripePaymentLink runs)
 *
 * No contract fixture (KY insurance, OH insurance, OH cash — client and
 * server) may match /direction to pay|assign|co-?payee/i or /negotiat/i,
 * except the statutory notice (3)(b) on a KY insurance contract ("shall not
 * assign ... in violation of KRS 304.20-105"), which the statute requires
 * verbatim. That one sentence is removed before the scan, nothing else.
 *
 * Needs functions/ deps (handlebars), like deposit-rule.test.js.
 * Run: node tests/ky-insurance-contracts.test.js   (KY_VERBOSE=1 for ✓ lines)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.KY_VERBOSE) console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
const unesc = (h) => String(h || '').replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'").replace(/&#x3D;/g, '=').replace(/&#x60;/g, '`').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (h) => unesc(String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = (s, re) => (String(s).match(re) || []).length;

// ── The statutory text, typed out from the enrolled act (Section 2) and from
//    eCFR 16 CFR 429.1 — NOT read from the module, so a drifted module fails.
const ACT_NOTICE_A = 'You may cancel this contract at any time before midnight on the fifth business day after you have ' +
  'received written notification from the insurer that all or any part of the contracted goods, services, or goods ' +
  'and services is not a covered loss under the property, casualty, or property and casualty insurance policy. This ' +
  'right to cancel is in addition to any other rights of cancellation you may have under state or federal law or ' +
  'regulation. See the attached Notice of Cancellation form for an explanation of this right.';
const ACT_NOTICE_B = 'This contract shall not assign or otherwise transfer, in whole or in part, your duties, rights, or ' +
  'benefits under the property, casualty, or property and casualty insurance policy in violation of KRS 304.20-105. ' +
  'Any contract entered in violation of KRS 304.20-105 shall be void and unenforceable.';
const ACT_FORM_HEAD = 'If you are notified by the insurer that all or any part of the contracted goods, services, or goods ' +
  'and services is not a covered loss under the property, casualty, or property and casualty insurance policy, you may ' +
  'cancel this contract without penalty or monetary obligation before midnight of the fifth business day after you have ' +
  'received the notice. To cancel this transaction, you may use any of the following methods: mail or otherwise deliver ' +
  'a signed and dated copy of this cancellation notice, or any other written notice of cancellation which you sign and ' +
  'date, to';
const ACT_FORM_TAIL = 'not later than midnight of the fifth day after you receive notice from the insurer.';
const FTC_FORM_FIRST = 'You may CANCEL this transaction, without any Penalty or Obligation, within THREE BUSINESS DAYS from the above date.';
const FTC_STATEMENT = 'You, the buyer, may cancel this transaction at any time prior to midnight of the third business day ' +
  'after the date of this transaction. See the attached notice of cancellation form for an explanation of this right.';
const LIEN = "Contractor will not file or claim a mechanic's lien for any amount in excess of what your insurer pays or is expected to pay.";

const KY_ADDR = '1944 Kentucky Ave, Fort Thomas, KY 41075';
const OH_ADDR = '1 Elm St, Cincinnati, OH 45202';
const BIZ_ADDR = '100 Test Plaza, Florence, KY 41042';

// ════════════════════════════════════════════════════════════════════
// A. The module
// ════════════════════════════════════════════════════════════════════
section('A. ky-insurance-law.js — detection, business days, statutory text');
const J = require(path.join(ROOT, 'docs/pro/js/ky-insurance-law.js'));
const JF = require(path.join(ROOT, 'functions/ky-insurance-law.js'));
ok('functions/ copy is byte-identical to docs/pro/js (EOL-normalised)',
  read('docs/pro/js/ky-insurance-law.js').replace(/\r\n/g, '\n') === read('functions/ky-insurance-law.js').replace(/\r\n/g, '\n'));
ok('functions/ copy exports the same surface', Object.keys(J).join() === Object.keys(JF).join());

const C = (ctx) => J.classify(ctx);
ok('KY address + insurance → kyInsurance', C({ address: KY_ADDR, jobType: 'insurance' }).kyInsurance === true);
ok('"Kentucky Ave" in an OHIO address does not make it Kentucky',
  C({ address: '1 Kentucky Ave, Cincinnati, OH 45202', jobType: 'insurance' }).kentucky === false);
ok('KY by ZIP alone (no state token) → Kentucky', C({ address: '7 Elm St, Florence 41042', jobType: 'insurance' }).kentucky === true);
ok('lower-case ", ky 41042" → Kentucky', C({ address: '7 Elm St, Florence, ky 41042' }).kentucky === true);
ok('full name ", Kentucky" → Kentucky', C({ address: '5 Pine Rd, Covington, Kentucky' }).kentucky === true);
ok('address says OH but ZIP says KY → Kentucky wins (fail closed)',
  C({ address: '5 Pine Rd, Covington, OH 41011', jobType: 'insurance' }).kyInsurance === true);
ok('OH insurance → not kyInsurance, AOB allowed',
  C({ address: OH_ADDR, jobType: 'insurance' }).kyInsurance === false && C({ address: OH_ADDR, jobType: 'insurance' }).aobBarred === false);
ok('IN address → Indiana', C({ address: '55 Main St, Lawrenceburg, IN 47025' }).state === 'IN');
ok('"12 Oak Ct 45202" is not Connecticut', C({ address: '12 Oak Ct 45202' }).state === 'OH');
ok('insurance job, NO readable state → treated as KY (fail closed)',
  C({ address: '9 Somewhere Rd', jobType: 'insurance' }).kyInsurance === true);
ok('insurance job, EMPTY address → treated as KY (fail closed)', C({ address: '', claimNumber: 'CLM-1' }).kyInsurance === true);
ok('cash job, no state → not kyInsurance', C({ address: '9 Somewhere Rd', jobType: 'cash' }).kyInsurance === false);
ok('cash job in KY → AOB still barred (Kentucky, any job)', C({ address: KY_ADDR, jobType: 'cash' }).aobBarred === true);
ok('insurance signal: mode', J.isInsurance({ mode: 'insurance' }));
ok('insurance signal: claim number', J.isInsurance({ claimNumber: 'CLM-9' }));
ok('insurance signal: carrier', J.isInsurance({ insuranceCarrier: 'State Farm' }) && J.isInsurance({ insCarrier: 'Allstate' }));
ok('placeholder carrier "N/A" / "none" is not an insurance signal',
  !J.isInsurance({ insuranceCarrier: 'N/A' }) && !J.isInsurance({ insCarrier: 'none', jobType: 'cash' }));
ok('classifyLead reads lead fields', J.classifyLead({ address: KY_ADDR, jobType: 'insurance' }).kyInsurance === true);

const day = (s) => J.formatDay(J.addBusinessDays(J.toUtcDay(s), 3));
ok('FTC business days skip Sunday + Labor Day (Fri 2026-09-04 → Wed Sep 9)', day('2026-09-04') === 'September 9, 2026', day('2026-09-04'));
ok('FTC business days count Saturday, skip Christmas (Wed 2026-12-23 → Mon Dec 28)', day('2026-12-23') === 'December 28, 2026', day('2026-12-23'));
ok('"September 26, 2026" parses (Sat → Wed Sep 30)', day('September 26, 2026') === 'September 30, 2026', day('September 26, 2026'));

// The signing DATE is the local calendar date (America/New_York by default,
// the tenant's zone when its profile carries one) — never the UTC date.
// 2026-09-28T02:30:00Z is 10:30 pm on Sunday September 27 in Kentucky/Ohio.
const SIGNED = '2026-09-28T02:30:00Z';
ok('signing instant 2026-09-28T02:30:00Z → "September 27, 2026" (America/New_York), not the UTC date',
  J.formatDay(J.toUtcDay(new Date(SIGNED))) === 'September 27, 2026' && J.formatDay(J.toUtcDay(SIGNED)) === 'September 27, 2026',
  J.formatDay(J.toUtcDay(SIGNED)));
ok('…and the same instant read as UTC WOULD have been September 28 (the bug this pins)', J.formatDay(J.toUtcDay(SIGNED, 'UTC')) === 'September 28, 2026');
ok('tenant timezone wins when the profile carries one (06:30Z Sep 28 = Sep 27 in Los Angeles, Sep 28 in New York)',
  J.formatDay(J.toUtcDay('2026-09-28T06:30:00Z', J.resolveTimeZone({ timezone: 'America/Los_Angeles' }))) === 'September 27, 2026' &&
  J.formatDay(J.toUtcDay('2026-09-28T06:30:00Z', J.resolveTimeZone({}))) === 'September 28, 2026');
ok('an unknown timezone falls back to America/New_York', J.resolveTimeZone({ timezone: 'Mars/Base' }) === 'America/New_York');
ok('a written date is taken as written', J.formatDay(J.toUtcDay('September 27, 2026')) === 'September 27, 2026' &&
  J.formatDay(J.toUtcDay('2026-09-27')) === 'September 27, 2026');
const kyForm = text(J.kyCancellationFormsHtml({ transactionDate: new Date(SIGNED), physicalAddress: 'X', email: 'y@z.test' }));
ok('KY form dates a 10:30 pm Sunday signing September 27', kyForm.includes('September 27, 2026') && !kyForm.includes('September 28, 2026'));
const ftcForm = text(J.ftcCancellationFormsHtml({ transactionDate: new Date(SIGNED), sellerName: 'S', sellerAddress: 'A' }));
ok('FTC deadline counts 3 business days from the LOCAL date (Sun Sep 27 → Mon/Tue/Wed → September 30), not from UTC Mon Sep 28 (→ Oct 1)',
  ftcForm.includes('September 27, 2026') && ftcForm.includes('NOT LATER THAN MIDNIGHT OF September 30, 2026'), (ftcForm.match(/NOT LATER THAN MIDNIGHT OF [^.]*/) || [''])[0]);

ok('notice (3)(a) is the act text verbatim', J.KY_NOTICE_CANCEL === ACT_NOTICE_A);
ok('notice (3)(b) is the act text verbatim', J.KY_NOTICE_NO_ASSIGNMENT === ACT_NOTICE_B);
ok('lien clause verbatim', J.KY_LIEN_CLAUSE === LIEN);
ok('FTC 429.1(a) statement verbatim', J.FTC_STATEMENT === FTC_STATEMENT);
ok('stripAssignmentSentences drops "Insurance assignment(s) accepted."',
  J.stripAssignmentSentences('No cash payments accepted. Insurance assignment accepted. Material delays may extend timeline.') ===
  'No cash payments accepted. Material delays may extend timeline.' &&
  !/assign/i.test(J.stripAssignmentSentences('Balance on completion. Insurance assignments accepted.')));
ok('notices HTML is bold, 13px on screen, 10pt in print',
  /font-weight:700/.test(J.kyNoticesHtml()) && /font-size:13px/.test(J.kyNoticesHtml()) &&
  /@media print\{\.nbd-statutory,\.nbd-statutory p\{font-size:10pt !important;\}/.test(J.STATUTORY_CSS));

// ════════════════════════════════════════════════════════════════════
// Sandbox — the page-shaped fake DOM deposit-rule.test.js uses.
// ════════════════════════════════════════════════════════════════════
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
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test', pathname: '/pro/customer' },
    URL, URLSearchParams,
    showToast: (m, kind) => toasts.push({ m: String(m), kind }),
  };
  win.showToast = sandbox.showToast;
  vm.createContext(sandbox);
  return { win, sandbox, byId, toasts };
}
function load(env, rel) { vm.runInContext(read(rel), env.sandbox, { filename: path.basename(rel) }); }

const DOCS = makeSandbox({ _brand: () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: { email: 'info@nobigdealwithjoedeal.com', phone: '(859) 420-7382' } }) });
['docs/pro/js/estimate-config.js', 'docs/pro/js/deposit-rule.js', 'docs/pro/js/ky-insurance-law.js',
  'docs/pro/js/customer-estimate-rows.js', 'docs/pro/js/document-generator.js',
  'docs/pro/js/document-generator-templates.js', 'docs/pro/js/doc-preflight.js'].forEach((f) => load(DOCS, f));
const W = DOCS.win;
const DG = W.NBDDocGen;
ok('stack loaded (NBDJurisdiction + NBDDocGen + DocPreflight)', !!(W.NBDJurisdiction && DG && W.DocPreflight));

// The contractor address lives ONLY in brand.contact.mailingAddress (Jo,
// 2026-09-27); businessAddress (the letterhead field) stays empty here and is
// never read for the statutory paperwork.
const _D = W.NBD_COMPANY_PROFILE_DEFAULTS || {};
const PROFILE = (addr, letterhead) => Object.assign({}, _D, {
  businessAddress: letterhead || '',
  brand: Object.assign({}, _D.brand || {}, { contact: Object.assign({}, (_D.brand || {}).contact || {}, { mailingAddress: addr }) }),
  paymentMethodsNoCash: 'All payments must be made by check, ACH transfer, or credit card. No cash payments accepted. Insurance assignment accepted. Material delays may extend timeline.',
  paymentTermsProposal: 'Cash jobs under $2,000: no deposit. Insurance assignments accepted.',
  paymentTermsContract: 'Balance on completion.',
  insuranceAssignmentClause: 'If this project is insurance-related, NBD is authorized to accept assignment of insurance proceeds as partial or full payment for work performed. Homeowner agrees to provide proof of insurance coverage and claim number.',
  cancellationContractClause: 'The Homeowner has the right to cancel this agreement within three (3) business days of signature without penalty.',
});
const withLead = (lead, fn) => {
  const prev = W._leadDoc; W._leadDoc = lead;
  try { return fn(); } finally { W._leadDoc = prev; }
};
const contractData = (address, jobType, extra) => Object.assign({
  homeownerName: 'Jane Smith', address, phone: '5135550100', email: 'jane@example.test',
  contractPrice: '$18,500.00', projectDescription: 'Roof replacement.', jobType,
  contractDate: '2026-09-28', companyProfile: PROFILE(BIZ_ADDR), leadId: 'L1',
}, extra || {});

// The KY fixture's own words, with the ONE statutory sentence that must say
// "assign" removed — everything else is scanned.
const scanText = (html) => text(html).split(ACT_NOTICE_B).join(' ');
const FORBIDDEN = /direction to pay|assign|co-?payee/i;

// ════════════════════════════════════════════════════════════════════
// B. renderContract
// ════════════════════════════════════════════════════════════════════
section('B. renderContract — the client contract');
const kyHtml = withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance', claimNumber: 'CLM-7' },
  () => DG.renderContract(contractData(KY_ADDR, 'insurance', { claimNumber: 'CLM-7', insuranceCompany: 'State Farm' })));
const kyText = text(kyHtml);
ok('KY: notice (3)(a) verbatim', kyText.includes(ACT_NOTICE_A));
ok('KY: notice (3)(b) verbatim', kyText.includes(ACT_NOTICE_B));
ok('KY: exactly two KY NOTICE OF CANCELLATION forms', count(kyHtml, /data-nbd-noc="ky"/g) === 2 &&
  count(kyText, /NOTICE OF CANCELLATION/g) >= 2, count(kyHtml, /data-nbd-noc="ky"/g));
ok('KY: the form body is the act text', kyText.includes(ACT_FORM_HEAD) && kyText.includes(ACT_FORM_TAIL));
ok('KY: forms prefilled — transaction date, physical address, email',
  kyText.includes('September 28, 2026') && kyText.includes(BIZ_ADDR) && kyText.includes('info@nobigdealwithjoedeal.com'));
// 2026-10-04: every contract now also carries the two FTC forms (the Notice of
// Right to Cancel packet), so the cancel line appears 2 (KY) + 2 (FTC) times.
ok('KY: "I HEREBY CANCEL THIS TRANSACTION." on each of the 2 KY + 2 FTC forms',
  count(kyText, /I HEREBY CANCEL THIS TRANSACTION\./g) === 4 && count(kyHtml, /data-nbd-noc="ftc"/g) === 2);
const sigAt = kyHtml.indexOf('Contract Execution');
ok('KY: both notices sit BEFORE the signature block',
  kyHtml.indexOf('data-nbd-statutory="ky-367-624-3"') > 0 && kyHtml.indexOf('data-nbd-statutory="ky-367-624-3"') < sigAt);
ok('KY: the forms page comes AFTER the signature block, on its own page, with a dashed cut line',
  kyHtml.indexOf('data-nbd-noc-page="ky"') > sigAt && /data-nbd-noc-page="ky" style="page-break-before:always;break-before:page;/.test(kyHtml) &&
  /\.nbd-noc-cut\{border-top:2px dashed/.test(kyHtml));
ok('KY: statutory CSS (bold, 10pt print) is in the document', kyHtml.includes('.nbd-statutory{font-weight:700 !important;font-size:13px !important;'));
ok('KY: contractor mailing address in the Parties block', /Mailing Address:<\/strong> 100 Test Plaza/.test(kyHtml));
ok('KY: lien clause', kyText.includes(LIEN));
ok('KY: NO /assign/i anywhere but the statutory (3)(b) sentence', !/assign/i.test(scanText(kyHtml)),
  (scanText(kyHtml).match(/.{40}assign.{40}/i) || [''])[0]);
ok('KY: NO /negotiat/i', !/negotiat/i.test(kyText), (kyText.match(/.{40}negotiat.{40}/i) || [''])[0]);
ok('KY: no "Insurance Assignment" section', !/Insurance Assignment/.test(kyHtml));
ok('KY: the plain Payment clause, verbatim', kyText.includes(J.PAYMENT_CLAUSE));

const ohInsHtml = withLead({ id: 'L1', address: OH_ADDR, jobType: 'insurance' },
  () => DG.renderContract(contractData(OH_ADDR, 'insurance', { claimNumber: 'CLM-8' })));
ok('OH insurance: the Insurance Assignment clause is gone (retired in both states)',
  !/Insurance Assignment/.test(ohInsHtml) && !text(ohInsHtml).includes('accept assignment of insurance proceeds'));
ok('OH insurance: the plain Payment clause, no /negotiat/i', text(ohInsHtml).includes(J.PAYMENT_CLAUSE) && !/negotiat/i.test(text(ohInsHtml)));
ok('OH insurance: no KY notices or KY forms', !text(ohInsHtml).includes(ACT_NOTICE_A) && !/data-nbd-noc="ky"/.test(ohInsHtml));

const ohCashHtml = withLead({ id: 'L1', address: OH_ADDR, jobType: 'cash' },
  () => DG.renderContract(contractData(OH_ADDR, 'cash')));
ok('OH cash: no "Insurance Assignment" clause', !/Insurance Assignment/.test(ohCashHtml) &&
  !text(ohCashHtml).includes('accept assignment of insurance proceeds'));
ok('OH cash: no "Insurance assignment accepted"', !/Insurance assignments? accepted/i.test(text(ohCashHtml)));
// The FTC statement + forms are statutory too (2026-10-04) — what must stay
// off an Ohio cash contract is the KENTUCKY text.
ok('OH cash: no KY statutory blocks', !/data-nbd-statutory="ky-367-624-3"/.test(ohCashHtml) && !/data-nbd-noc="ky"/.test(ohCashHtml));
ok('OH cash: the same plain Payment clause', text(ohCashHtml).includes(J.PAYMENT_CLAUSE));
for (const [name, html, statutory] of [['KY insurance', kyHtml, true], ['OH insurance', ohInsHtml, false], ['OH cash', ohCashHtml, false]]) {
  const body = statutory ? scanText(html) : text(html);
  ok(name + ' client contract: no /direction to pay|assign|co-?payee/i' + (statutory ? ' outside the statutory 304.20-105 notice' : ''),
    !FORBIDDEN.test(body), (body.match(/.{50}(direction to pay|assign|co-?payee).{50}/i) || [''])[0]);
  ok(name + ' client contract: no /negotiat/i', !/negotiat/i.test(text(html)));
}

const kyCashHtml = withLead({ id: 'L1', address: KY_ADDR, jobType: 'cash' },
  () => DG.renderContract(contractData(KY_ADDR, 'cash')));
ok('KY cash: no assignment clause, no KY insurance notices', !/Insurance Assignment/.test(kyCashHtml) && !kyCashHtml.includes('nbd-ky-notices'));

const unkHtml = withLead({ id: 'L1', address: '9 Somewhere Rd', jobType: 'insurance' },
  () => DG.renderContract(contractData('9 Somewhere Rd', 'insurance')));
ok('insurance job with NO readable state: KY notices + forms (fail closed)',
  text(unkHtml).includes(ACT_NOTICE_A) && count(unkHtml, /data-nbd-noc="ky"/g) === 2);

ok('a stamped jurisdiction can ADD Kentucky but never remove it',
  withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' }, () => DG.renderContract(contractData(KY_ADDR, 'insurance',
    { jurisdiction: { kentucky: false, insurance: false, kyInsurance: false } }))).includes('nbd-ky-notices'));

// ════════════════════════════════════════════════════════════════════
// C. renderProposal (signable)
// ════════════════════════════════════════════════════════════════════
section('C. renderProposal — a signable proposal is a contract entry');
const kyProp = withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' },
  () => DG.renderProposal(contractData(KY_ADDR, 'insurance', { totalPrice: '$18,500.00' })));
ok('KY proposal: both notices + two forms', text(kyProp).includes(ACT_NOTICE_A) && text(kyProp).includes(ACT_NOTICE_B) &&
  count(kyProp, /data-nbd-noc="ky"/g) === 2);
ok('KY proposal: notices before Acceptance', kyProp.indexOf('nbd-ky-notices') < kyProp.indexOf('>Acceptance<'));
ok('KY proposal: no "Insurance assignments accepted", no /negotiat/i',
  !/assignments? accepted/i.test(text(kyProp)) && !/negotiat/i.test(text(kyProp)));
const cashProp = withLead({ id: 'L1', address: OH_ADDR, jobType: 'cash' },
  () => DG.renderProposal(contractData(OH_ADDR, 'cash', { totalPrice: '$9,000.00' })));
ok('cash proposal: no "Insurance assignments accepted"', !/assignments? accepted/i.test(text(cashProp)));

// ════════════════════════════════════════════════════════════════════
// D. Server contract: buildContractStatutory + the real contract.hbs
// ════════════════════════════════════════════════════════════════════
section('D. functions/render-pdf.js + contract.hbs');
const Handlebars = require(path.join(ROOT, 'functions/node_modules/handlebars'));
const RENDER = require(path.join(ROOT, 'functions/render-pdf.js'));
RENDER._registerPartialsOnce();
RENDER._registerHelpersOnce();
const CONTRACT_HBS = Handlebars.compile(read('functions/print/templates/contract.hbs'));
const COMPANY = { footerName: 'No Big Deal Home Solutions', phone: '(859) 420-7382', email: 'jd@nobigdealwithjoedeal.com', isNbd: true };
function serverContract(address, jobType, contractor, extra) {
  const data = contractData(address, jobType, Object.assign({ customer: { name: 'Jane Smith', address } }, extra || {}));
  const payload = withLead({ id: 'L1', address, jobType }, () => DG._buildServerPayload('contract', Object.assign({}, data)));
  const statutory = RENDER._buildContractStatutory(payload, contractor, COMPANY);
  const html = CONTRACT_HBS(Object.assign({}, payload, { company: COMPANY, statutory }));
  return { payload, statutory, html };
}
const CONTRACTOR = { address: BIZ_ADDR, email: 'info@nobigdealwithjoedeal.com', fax: '' };
const sKy = serverContract(KY_ADDR, 'insurance', CONTRACTOR, { claimNumber: 'CLM-7' });
const sKyText = text(sKy.html);
ok('server payload carries job FACTS (jurisdiction) + transactionDate',
  sKy.payload.jurisdiction && sKy.payload.jurisdiction.address === KY_ADDR && sKy.payload.transactionDate === '2026-09-28');
ok('server KY: both notices verbatim', sKyText.includes(ACT_NOTICE_A) && sKyText.includes(ACT_NOTICE_B));
ok('server KY: two KY forms + two FTC forms', count(sKy.html, /data-nbd-noc="ky"/g) === 2 && count(sKy.html, /data-nbd-noc="ftc"/g) === 2);
ok('server KY: notices inside the signature block, before the signature lines',
  sKy.html.indexOf('nbd-ky-notices') > sKy.html.indexOf('Acceptance &amp; Signatures') &&
  sKy.html.indexOf('nbd-ky-notices') < sKy.html.indexOf('class="sig-grid"'));
ok('server KY: forms after the signatures', sKy.html.indexOf('data-nbd-noc-page="ky"') > sKy.html.indexOf('class="sig-grid"'));
ok('server KY: contractor mailing address printed', sKyText.includes('Mailing address: ' + BIZ_ADDR));
ok('server KY: lien clause', sKyText.includes(LIEN));
ok('server KY: NO /assign/i but the statutory sentence', !/assign/i.test(scanText(sKy.html)), (scanText(sKy.html).match(/.{40}assign.{40}/i) || [''])[0]);
ok('server KY: NO /negotiat/i', !/negotiat/i.test(sKyText), (sKyText.match(/.{40}negotiat.{40}/i) || [''])[0]);
ok('server KY without an address → missingAddress (the callable refuses it)',
  RENDER._buildContractStatutory(sKy.payload, { address: '', email: 'x@y.z' }, COMPANY).missingAddress === true);
ok('server: a client verdict cannot switch Kentucky OFF',
  RENDER._buildContractStatutory(Object.assign({}, sKy.payload, { jurisdiction: Object.assign({}, sKy.payload.jurisdiction, { kentucky: false, kyInsurance: false }) }), CONTRACTOR, COMPANY).kyInsurance === true);

{
  const late = RENDER._buildContractStatutory(Object.assign({}, sKy.payload, { transactionDate: SIGNED }), CONTRACTOR, COMPANY);
  const lateText = text(late.kyFormsHtml + late.ftcFormsHtml);
  ok('server (UTC clock): a 10:30 pm Kentucky signing is dated September 27 on both forms, FTC deadline September 30',
    count(lateText, /September 27, 2026/g) === 4 && !lateText.includes('September 28, 2026') &&
    lateText.includes('NOT LATER THAN MIDNIGHT OF September 30, 2026'), (lateText.match(/NOT LATER THAN MIDNIGHT OF [^.]*/) || [''])[0]);
  const la = RENDER._buildContractStatutory(Object.assign({}, sKy.payload, { transactionDate: '2026-09-28T06:30:00Z' }),
    Object.assign({}, CONTRACTOR, { timeZone: 'America/Los_Angeles' }), COMPANY);
  ok('server: the tenant timezone from its profile decides the date', text(la.kyFormsHtml).includes('September 27, 2026'));
  const cl = withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' },
    () => DG.renderContract(contractData(KY_ADDR, 'insurance', { contractDate: SIGNED })));
  ok('client renderContract: the same instant is dated September 27, 2026', text(cl).includes('September 27, 2026') && !text(cl).includes('September 28, 2026'));
  const pl = withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' },
    () => DG._buildServerPayload('contract', contractData(KY_ADDR, 'insurance', { contractDate: undefined, customer: { name: 'J', address: KY_ADDR } })));
  ok('client payload stamps the LOCAL signing date as YYYY-MM-DD (America/New_York today)',
    pl.transactionDate === J.isoDay(J.todayIn('America/New_York')), pl.transactionDate);
}

const sOhCash = serverContract(OH_ADDR, 'cash', { address: '123 Main St, Goshen, OH 45122', email: 'info@x.test' });
const sOhText = text(sOhCash.html);
ok('server OH cash: the promised "attached Notice of Cancellation form" is attached — two FTC copies',
  /attached Notice of Cancellation form/i.test(sOhText) && count(sOhCash.html, /data-nbd-noc="ftc"/g) === 2);
ok('server OH cash: FTC form text verbatim + seller + deadline (3 business days after Mon Sep 28 → Thu Oct 1)',
  sOhText.includes(FTC_FORM_FIRST) && sOhText.includes('NOT LATER THAN MIDNIGHT OF October 1, 2026') &&
  sOhText.includes('No Big Deal Home Solutions, at 123 Main St, Goshen, OH 45122'));
ok('server OH cash: 429.1(a) statement bold next to the signatures',
  sOhCash.html.indexOf('data-nbd-statutory="ftc-429-1-a"') > sOhCash.html.indexOf('Acceptance &amp; Signatures') &&
  sOhCash.html.indexOf('data-nbd-statutory="ftc-429-1-a"') < sOhCash.html.indexOf('class="sig-grid"'));
ok('server OH cash: no KY blocks, no assignment language', !/data-nbd-noc="ky"/.test(sOhCash.html) && !/assign/i.test(sOhText));

// ════════════════════════════════════════════════════════════════════
// E. NBDDocGen.generate gates
// ════════════════════════════════════════════════════════════════════
section('E. generate() — no AOB in Kentucky; no KY insurance contract without the address');
(async () => {
  let viewerOpened = 0;
  W.NBDDocViewer = { open() { viewerOpened++; } };
  W._companyProfileLoaded = true;
  const lastToast = () => (DOCS.toasts[DOCS.toasts.length - 1] || {}).m || '';

  W._legal = () => PROFILE(BIZ_ADDR);
  for (const [st, addr] of [['Kentucky', KY_ADDR], ['Ohio', OH_ADDR]]) {
    DOCS.toasts.length = 0; viewerOpened = 0;
    await withLead({ id: 'L1', address: addr, jobType: 'insurance', claimNumber: 'C', insCarrier: 'SF' },
      () => DG.generate('assignment_of_benefits', { homeownerName: 'Jane', address: addr, leadId: 'L1' }));
    ok('AOB is retired — a ' + st + ' job gets the reason, not a document', viewerOpened === 0 && lastToast() === J.MSG.aobRetired, lastToast());
  }
  DOCS.toasts.length = 0; viewerOpened = 0;
  await withLead({ id: 'L1', address: OH_ADDR, jobType: 'insurance' },
    () => DG.generate('direction_to_pay', { homeownerName: 'Jane', address: OH_ADDR, leadId: 'L1' }));
  ok('the Direction to Pay is retired too — a stale call gets the reason', viewerOpened === 0 && lastToast() === J.MSG.aobRetired, lastToast());
  ok('no AOB, no Direction to Pay document type or renderer is left',
    !DG.DOCUMENT_TYPES.assignment_of_benefits && !DG.DOCUMENT_TYPES.direction_to_pay &&
    typeof DG.renderAssignmentOfBenefits !== 'function' && typeof DG.renderDirectionToPay !== 'function' &&
    !DG.FILED_FIELD_BY_DOC_TYPE.direction_to_pay && !DG.FILED_FIELD_BY_DOC_TYPE.assignment_of_benefits);

  W._legal = () => PROFILE('');
  DOCS.toasts.length = 0; viewerOpened = 0;
  await withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' },
    () => DG.generate('contract', contractData(KY_ADDR, 'insurance', { signers: [{ role: 'homeowner', label: 'Homeowner', required: true }] })));
  ok('KY insurance contract with no business address is refused', viewerOpened === 0 &&
    lastToast() === J.MSG.addressRequired, lastToast());

  // ══════════════════════════════════════════════════════════════════
  // F. doc pre-flight
  // ══════════════════════════════════════════════════════════════════
  section('F. doc pre-flight — block, warning, stamp');
  async function preflight(lead, profileAddr) {
    W._legal = () => PROFILE(profileAddr);
    W._leadDoc = Object.assign({ id: 'L1', firstName: 'Jane', lastName: 'Smith', phone: '5135550100',
      email: 'jane@example.test', scopeOfWork: 'Roof.' }, lead);
    W._currentLead = W._leadDoc;
    W._customerEstimates = [{ id: 'e1', tier: 'better', mode: lead.jobType === 'insurance' ? 'insurance' : 'cash', grandTotal: 18500, total: 18500, leadId: 'L1',
      rows: [{ desc: 'Roof', total: 18500, retailTotal: 18500, quantity: 1, unit: 'EA', unitPrice: 18500 }] }];
    let captured = null;
    const real = DG.generate;
    DG.generate = (t, data) => { captured = data; };
    DOCS.toasts.length = 0;
    let st;
    try {
      W.DocPreflight.open('contract', null);
      st = W.DocPreflight._state;
      const notes = (st.legalNotes || []).slice();
      if (st.open) { st.softAck = true; await W.DocPreflight.submit(); }
      return { captured, notes, toasts: DOCS.toasts.map((t) => t.m) };
    } finally { DG.generate = real; if (st && st.open) W.DocPreflight.close(); }
  }
  const p1 = await preflight({ address: KY_ADDR, jobType: 'insurance', claimNumber: 'CLM-7', insCarrier: 'SF' }, '');
  ok('pre-flight: KY insurance + no business address → BLOCKED (generator never called)', p1.captured === null && p1.toasts.includes(J.MSG.addressRequired), p1.toasts.join('|'));
  ok('pre-flight: the address block and the $0-at-signing note are both on screen',
    p1.notes.some((n) => n.level === 'block' && n.message === J.MSG.addressRequired) &&
    p1.notes.some((n) => n.level === 'warn' && n.message === J.MSG.depositHold));
  ok('pre-flight: the address message says exactly where to enter it',
    /Settings → Company Profile → "Mailing Address \(one line\)"/.test(J.MSG.addressRequired) && /not a PO box/.test(J.MSG.addressRequired));
  ok('pre-flight: the hold note cites KRS 367.626 and the emergency exception', /KRS 367\.626\b/.test(J.MSG.depositHold) && /367\.626\(3\)/.test(J.MSG.depositHold));
  const p2 = await preflight({ address: KY_ADDR, jobType: 'insurance', claimNumber: 'CLM-7', insCarrier: 'SF' }, BIZ_ADDR);
  ok('pre-flight: with the address it generates — the deposit warning never blocks', !!p2.captured &&
    p2.notes.some((n) => n.level === 'warn') && !p2.notes.some((n) => n.level === 'block'));
  ok('pre-flight: the job\'s jurisdiction is stamped on the document data', !!(p2.captured && p2.captured.jurisdiction && p2.captured.jurisdiction.kyInsurance === true));
  const kyPlan = p2.captured && p2.captured.depositPlan;
  ok('pre-flight KY insurance contract: $0 at signing (the real rule, not a warning)', !!kyPlan && kyPlan.depositCents === 0 &&
    /^Nothing is due at signing\./.test(kyPlan.summary) && kyPlan.rows.every((r) => r.due === J.KY_HOLD_DUE || r.label === 'Balance'),
    kyPlan && JSON.stringify(kyPlan.rows));
  if (kyPlan) {
    const sp = withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' }, () => DG._buildServerPayload('contract', Object.assign({}, p2.captured)));
    ok('server contract Payment Schedule: every stage but the balance is due after the decision + window',
      sp.paymentSchedule.length > 0 && sp.paymentSchedule.every((r) => r.dueDescription === J.KY_HOLD_DUE || r.stage === 'Balance'),
      JSON.stringify(sp.paymentSchedule));
  }
  const p3 = await preflight({ address: OH_ADDR, jobType: 'cash' }, '');
  ok('pre-flight: an Ohio cash contract is untouched (no notes, generates)', !!p3.captured && p3.notes.length === 0);
  const p4 = await preflight({ address: OH_ADDR, jobType: 'insurance', claimNumber: 'CLM-8', insCarrier: 'SF', deductibleOrOwedByHO: 1000 }, BIZ_ADDR);
  ok('pre-flight: an Ohio insurance contract keeps the deductible at signing (unchanged)', !!(p4.captured && p4.captured.depositPlan) &&
    p4.captured.depositPlan.depositCents === 100000 && /deductible is due at signing/.test(p4.captured.depositPlan.summary),
    p4.captured && p4.captured.depositPlan && p4.captured.depositPlan.summary);

  // ══════════════════════════════════════════════════════════════════
  // G. Work Authorization + AOB templates
  // ══════════════════════════════════════════════════════════════════
  section('G. no assignment / co-payee instrument; the address only where the law requires it');
  for (const [st, addr] of [['Kentucky', KY_ADDR], ['Ohio', OH_ADDR]]) {
    const wa = withLead({ id: 'L1', address: addr, jobType: 'insurance' }, () => DG.renderWorkAuthorization(
      { homeownerName: 'Jane', address: addr, isInsurance: true, claimNumber: 'C1', insuranceCompany: 'SF', leadId: 'L1' }));
    ok('Work Authorization ' + st + ': no /direction to pay|assign|co-?payee/i, no /negotiat/i',
      !FORBIDDEN.test(text(wa)) && !/negotiat/i.test(text(wa)), (text(wa).match(/.{40}(direction to pay|assign|co-?payee).{40}/i) || [''])[0]);
  }
  // Server contracts, all three fixtures, same rule.
  for (const [name, address, jobType, statutory] of [['KY insurance', KY_ADDR, 'insurance', true], ['OH insurance', OH_ADDR, 'insurance', false], ['OH cash', OH_ADDR, 'cash', false]]) {
    const sc = serverContract(address, jobType, { address: BIZ_ADDR, email: 'info@nobigdealwithjoedeal.com', fax: '' });
    const body = statutory ? scanText(sc.html) : text(sc.html);
    ok(name + ' server contract: the plain Payment clause', text(sc.html).includes(J.PAYMENT_CLAUSE));
    ok(name + ' server contract: no /direction to pay|assign|co-?payee/i' + (statutory ? ' outside the statutory notice' : ''),
      !FORBIDDEN.test(body), (body.match(/.{50}(direction to pay|assign|co-?payee).{50}/i) || [''])[0]);
  }

  // The address: brand.contact.mailingAddress ONLY, never businessAddress.
  ok('contractorMailingAddress reads brand.contact.mailingAddress, never businessAddress',
    J.contractorMailingAddress({ businessAddress: 'LETTERHEAD 1', brand: { contact: { mailingAddress: '' } } }) === '' &&
    J.contractorMailingAddress({ businessAddress: '', brand: { contact: { mailingAddress: BIZ_ADDR } } }) === BIZ_ADDR &&
    JF.contractorMailingAddress({ contact: { mailingAddress: BIZ_ADDR } }) === BIZ_ADDR);
  const kyA = withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' },
    () => DG.renderContract(contractData(KY_ADDR, 'insurance', { companyProfile: PROFILE(BIZ_ADDR, '') })));
  const headerOf = (h) => { const i = h.indexOf('<div class="document-header">'); const j = h.indexOf('<div class="document-title">', i); return i >= 0 && j > i ? h.slice(i, j) : ''; };
  ok('mailingAddress set + businessAddress empty: the KY insurance contract prints it in the Parties block and both NoC forms',
    /Mailing Address:<\/strong> 100 Test Plaza/.test(kyA) && count(text(kyA), new RegExp(BIZ_ADDR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) >= 3);
  ok('…and the letterhead header shows NO contractor address', headerOf(kyA).length > 0 && !headerOf(kyA).includes('100 Test Plaza'), headerOf(kyA).slice(0, 200));
  const ohEst = withLead({ id: 'L1', address: OH_ADDR, jobType: 'cash' },
    () => DG.renderProposal(contractData(OH_ADDR, 'cash', { totalPrice: '$9,000.00', companyProfile: PROFILE(BIZ_ADDR, '') })));
  // …except the FTC Notice of Cancellation, which the law requires to name
  // the seller's address (2026-10-04: attached to every contract).
  ok('an Ohio estimate shows the contractor address nowhere but the FTC cancellation forms',
    !J.stripCancelPacket(ohEst).includes('100 Test Plaza') && /data-nbd-noc="ftc"[\s\S]*100 Test Plaza/.test(ohEst));
  const ohIns = withLead({ id: 'L1', address: OH_ADDR, jobType: 'insurance' },
    () => DG.renderContract(contractData(OH_ADDR, 'insurance', { companyProfile: PROFILE(BIZ_ADDR, '') })));
  ok('an Ohio insurance contract shows it nowhere either (outside those forms)', !J.stripCancelPacket(ohIns).includes('100 Test Plaza'));
  const lhOnly = withLead({ id: 'L1', address: KY_ADDR, jobType: 'insurance' },
    () => DG._contractorPhysicalAddress(PROFILE('', 'LETTERHEAD ONLY 9 Elm')));
  ok('a letterhead address alone does NOT satisfy the KY requirement (never read)', lhOnly === '');
  const rpSrc = read('functions/render-pdf.js').replace(/\r\n/g, '\n');
  ok('the server reads KyLaw.contractorMailingAddress, not businessAddress',
    /out\.address = KyLaw\.contractorMailingAddress\(p\);/.test(rpSrc) && !/out\.address = String\(p\.businessAddress/.test(rpSrc));

  // ══════════════════════════════════════════════════════════════════
  // H. crm-stages.js — the AOB Filed gate
  // ══════════════════════════════════════════════════════════════════
  section('H. crm-stages.js — "Claim Filed" needs no AOB/DTP stamp in either state');
  let src = read('docs/pro/js/crm-stages.js');
  src = src.replace(/export\s+function\s+/g, 'function ').replace(/export\s+const\s+/g, 'const ');
  src += '\nthis.__out = { S, missingRequiredFields };';
  const sb = { console, window: {}, NBDJurisdiction: J };
  vm.runInNewContext(src, sb, { filename: 'crm-stages.js' });
  const { S, missingRequiredFields } = sb.__out;
  const kyMissing = missingRequiredFields({ jobType: 'insurance', stage: S.CLAIM_FILED, address: KY_ADDR, insCarrier: 'SF', claimNumber: 'C' });
  const ohMissing = missingRequiredFields({ jobType: 'insurance', stage: S.CLAIM_FILED, address: OH_ADDR, insCarrier: 'SF', claimNumber: 'C' });
  ok('Kentucky insurance lead can reach Claim Filed without aobFiledAt', !kyMissing.includes('aobFiledAt'), JSON.stringify(kyMissing));
  ok('Ohio insurance lead too (the requirement was dropped with the AOB)', !ohMissing.includes('aobFiledAt'), JSON.stringify(ohMissing));

  // ══════════════════════════════════════════════════════════════════
  // I. Close Board deal room
  // ══════════════════════════════════════════════════════════════════
  section('I. close-board.js — a Kentucky insurance deal is a contract entry');
  function closeBoard(profileAddr) {
    const raw = read('docs/pro/js/close-board.js').replace(/\bimport\(/g, '__testImport(');
    const mk = () => ({ _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = String(v); },
      get textContent() { return this._h; },
      set textContent(v) { this._h = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } });
    const els = {}; const store = {};
    const sb2 = {
      console: { log() {}, info() {}, warn() {}, error() {} }, JSON, Math, Date, Number, String, Array, Object, RegExp,
      Boolean, Error, Promise, Set, Map, isNaN, parseFloat, parseInt, encodeURIComponent,
      setTimeout: () => 0, clearTimeout: () => {},
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
      document: { getElementById: (id) => (els[id] = els[id] || mk()), createElement: mk, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
      navigator: {},
      __testImport: async () => ({}),
    };
    sb2.window = sb2; sb2.addEventListener = () => {}; sb2.showToast = () => {}; sb2.open = () => null;
    sb2.NBDJurisdiction = J;
    sb2.NBDDepositRule = require(path.join(ROOT, 'docs/pro/js/deposit-rule.js'));
    sb2._legal = () => ({ businessAddress: '', brand: { contact: { mailingAddress: profileAddr } } });
    sb2._brand = () => ({ legalName: 'No Big Deal Home Solutions', contact: { email: 'info@nobigdealwithjoedeal.com' } });
    vm.runInNewContext(raw, sb2, { filename: 'close-board.js' });
    return sb2.CloseBoard;
  }
  const deal = (address, insurance) => ({
    id: 'd1', customerName: 'Jane', address, repName: 'Joe', repPhone: '1', repEmail: 'jd@x.test', warranty: 'Lifetime',
    tiers: { good: { price: 10000, description: 'g' }, better: { price: 12000, description: 'b' }, best: { price: 15000, description: 'x' } },
    insuranceClaim: insurance, insuranceCarrier: insurance ? 'State Farm' : '', claimNumber: '', deductible: 1000, expiresAt: Date.now(),
  });
  const CB = closeBoard(BIZ_ADDR);
  const cbKy = CB.generatePageHTML(deal(KY_ADDR, true));
  ok('deal room KY insurance: both notices before the signature pad, two forms after it',
    text(cbKy).includes(ACT_NOTICE_A) && text(cbKy).includes(ACT_NOTICE_B) && count(cbKy, /data-nbd-noc="ky"/g) === 2 &&
    cbKy.indexOf('nbd-ky-notices') < cbKy.indexOf('id="sigCanvas"') && cbKy.indexOf('data-nbd-noc-page="ky"') > cbKy.indexOf('id="sigCanvas"'));
  ok('deal room KY: no "we work directly with your insurance" / negotiation copy',
    !/work directly with your insurance/i.test(text(cbKy)) && !/negotiat/i.test(text(cbKy)));
  const cbOh = CB.generatePageHTML(deal(OH_ADDR, true));
  ok('deal room OH insurance: no KY blocks', !/data-nbd-noc="ky"/.test(cbOh));
  ok('deal room KY insurance: every tier says $0 due at signing', (cbKy.match(/<div class="tier-deposit">[^\n]*?<\/div>/g) || [])
    .every((l) => /Due at signing: <strong>\$0<\/strong>/.test(l)) && (cbKy.match(/tier-deposit/g) || []).length >= 3);
  ok('deal room OH insurance: tiers keep the deductible at signing', /Due at signing: <strong>\$1,000<\/strong>/.test(cbOh));
  let threw = null;
  try { closeBoard('').generatePageHTML(deal(KY_ADDR, true)); } catch (e) { threw = e; }
  ok('deal room KY insurance without a business address is refused', !!threw && threw.code === 'ky-address-required');

  // ══════════════════════════════════════════════════════════════════
  // J. The Kentucky payment hold — what createStripePaymentLink runs
  // ══════════════════════════════════════════════════════════════════
  section('J. the online pay link waits for the carrier decision + 5 business days');
  const KYL = { address: KY_ADDR, jobType: 'insurance', claimNumber: 'C' };
  ok('no decision date recorded → held', J.payLinkHold(KYL, {}, '2026-10-10').held === true);
  // Decision Fri 2026-09-25 → KY business days Mon 28 … Fri Oct 2 → payable from Sat Oct 3.
  ok('the window skips Saturdays and Sundays: ends Fri Oct 2, payable from Oct 3',
    J.formatDay(J.kyWindowEnd('2026-09-25')) === 'October 2, 2026' && J.kyReleaseDateText('2026-09-25') === 'October 3, 2026');
  ok('decision recorded, still inside the window → held', J.payLinkHold(Object.assign({ carrierDecisionAt: '2026-09-25' }, KYL), {}, '2026-10-02T15:00:00Z').held === true);
  ok('…the day after the window → released', J.payLinkHold(Object.assign({ carrierDecisionAt: '2026-09-25' }, KYL), {}, '2026-10-03T15:00:00Z').held === false);
  // Fri Oct 9 → Tue 13, Wed 14, Thu 15, Fri 16, Mon 19 (Mon 12 skipped).
  ok('…a federal holiday in the window pushes it out (Columbus Day Mon 2026-10-12)',
    J.formatDay(J.kyWindowEnd('2026-10-09')) === 'October 19, 2026', J.formatDay(J.kyWindowEnd('2026-10-09')));
  ok('the window counts from the LOCAL date (10:30 pm ET Friday is still Friday)',
    J.formatDay(J.kyWindowEnd(new Date('2026-09-26T02:30:00Z'))) === 'October 2, 2026');
  ok('an invoice marked emergency tarp/repair work is never held (KRS 367.626(3))', J.payLinkHold(KYL, { emergencyServices: true }).held === false);
  ok('an Ohio insurance job is never held', J.payLinkHold({ address: OH_ADDR, jobType: 'insurance' }, {}).held === false);
  ok('the invoice flag can ADD the hold (lead unreadable)', J.payLinkHold(null, { kyInsuranceHold: true }).held === true);
  const stripeSrc = read('functions/stripe.js').replace(/\r\n/g, '\n');
  // 2026-10-03: the gate moved into functions/ky-pay-link-gate-logic.js
  // (behaviour-tested in tests/ky-pay-link-gate-2026-10-03.test.js).
  const gateAt = stripeSrc.indexOf('KyPayLinkGate.kyPayLinkGate({');
  ok('createStripePaymentLink runs the KY pay-link gate before any Stripe call and refuses with 409 KY_CANCELLATION_WINDOW',
    gateAt > 0 && gateAt < stripeSrc.indexOf('const stripe = getStripe();', gateAt) &&
    /res\.status\(409\)\.json\(\{\s*error: 'KY_CANCELLATION_WINDOW'/.test(stripeSrc.slice(gateAt, gateAt + 1400)));

  console.log('\n' + '─'.repeat(50));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.log('FATAL', e && e.stack); process.exit(1); });
