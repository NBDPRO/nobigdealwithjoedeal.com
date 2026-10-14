/**
 * tests/customer-claim-honesty-2026-10-13.test.js
 *
 * Guards the customer-facing statements removed or corrected from the
 * 2026-10-13 contract-language inventory's honesty/contradiction list. Each
 * phrase below was false, risky, or contradicted another copy; none may come
 * back:
 *
 *   1. the dead legacy Work Authorization template in dashboard-ui.js that had
 *      NBD "negotiate with my insurance company on my behalf and receive
 *      payment directly from the insurance carrier";
 *   2. the Testimonial Sheet's invented "Satisfied Homeowner" fallback quotes;
 *   3. the claim guide's "We handle the hard parts", its "Acts of God / no rate
 *      increases" answer and its "claims are approved within 2-4 weeks"
 *      answer (and the public hail-claim page's absolute "cannot raise your
 *      rates");
 *   4. the referral card's $250 bonus literal (code pays $100:
 *      functions/referral-rewards.js REFERRAL_BONUS_USD);
 *   5. the default contract payment-methods sentence "No cash payments
 *      accepted" (the CRM records cash and Zelle; the NBD profile was set to
 *      accept cash on Jo's OK, 2026-09-26).
 *
 * Every ABSENCE assertion is paired with a positive control: the same regex is
 * run against a fixture that contains the phrase and must match, so a regex
 * that can no longer fail is itself a red.
 *
 * Run: node tests/customer-claim-honesty-2026-10-13.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Comments stripped first, so an explanatory comment neither satisfies nor
// trips an absence check.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

// Absence check with its own positive control.
function absent(label, re, haystack, positiveFixture) {
  ok(label + ' (control: regex matches a fixture containing it)', re.test(positiveFixture));
  ok(label, !re.test(haystack));
}

// ── sandbox: real document generator + templates + preflight ──────────
function loadEnv(brand) {
  const b = brand || { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
  const win = { _brand: () => b };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  for (const f of ['estimate-config.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(PRO_JS, f), 'utf8'), sandbox, { filename: f });
  }
  return win;
}
const BASE = { homeownerName: 'Jane Smith', address: '123 Main St', leadId: 'L1' };

console.log('CLAIM HONESTY 2026-10-13 — (1) legacy Work Authorization template');
{
  const ui = stripComments(read('docs/pro/js/dashboard-ui.js'));
  absent('dashboard-ui.js has no "negotiate with my insurance company" authorization',
    /negotiate\s+with\s+my\s+insurance/i, ui,
    'I authorize {{COMPANY}} to negotiate with my insurance company on my behalf');
  absent('dashboard-ui.js has no "receive payment directly from the insurance carrier"',
    /payment\s+directly\s+from\s+the\s+insurance\s+carrier/i, ui,
    'and to receive payment directly from the insurance carrier for covered work');
  ok('dashboard-ui.js DOC_TEMPLATES still defines the other blank forms (contract)',
    /const DOC_TEMPLATES = \{\s*contract:/.test(ui) && /\n  inspection: \{/.test(ui));
  ok('dashboard-ui.js no longer defines an "authorization" template key',
    !/\n  authorization: \{/.test(ui));
}

console.log('CLAIM HONESTY 2026-10-13 — (2) Testimonial Sheet never invents quotes');
{
  const dg = loadEnv().NBDDocGen;
  const empty = dg.renderTestimonialSheet(Object.assign({}, BASE));
  const withRep = dg.renderTestimonialSheet(Object.assign({ testimonial1: 'WIREquote Satisfied Homeowner said so', rating1: '4' }, BASE));
  ok('renders with no rep quotes (no error)', typeof empty === 'string' && empty.length > 500);
  absent('empty sheet has no "Satisfied Homeowner"', /Satisfied Homeowner/, empty, withRep);
  absent('empty sheet has none of the old invented quote text',
    /feel like no big deal|Best contractor experience I have ever had|documented every bit of the storm damage|left the property cleaner than they found it/i,
    empty, 'They made the whole process feel like no big deal.');
  ok('empty sheet shows the real-review prompt instead',
    /No customer reviews have been added to this sheet yet/.test(empty));
  ok('empty sheet shows no invented star rating or "Would Recommend" stat',
    !/Would Recommend/.test(empty) && !/★/.test(empty));
  ok('positive control: a rep-entered quote still renders', /WIREquote/.test(withRep) && /Would Recommend/.test(withRep));
  const oaks = loadEnv({ legalName: 'Oaks Roofing & Construction', colors: {}, contact: {} }).NBDDocGen
    .renderTestimonialSheet(Object.assign({}, BASE));
  ok('a tenant with no quotes also gets the prompt, no quotes', !/Satisfied Homeowner/.test(oaks) && /No customer reviews have been added/.test(oaks));
  absent('source has no "Satisfied Homeowner" literal',
    /Satisfied Homeowner/, stripComments(read('docs/pro/js/document-generator-templates.js')), 'name:\'Satisfied Homeowner\'');
}

console.log('CLAIM HONESTY 2026-10-13 — (3) claim guide: no claim-handling or outcome promises');
{
  const dg = loadEnv().NBDDocGen;
  const html = dg.renderClaimGuide(Object.assign({}, BASE));
  ok('claim guide renders', typeof html === 'string' && html.length > 1000);
  absent('no "We handle the hard parts"', /handle\s+the\s+hard\s+parts/i, html, 'We handle the hard parts — so it really is no big deal.');
  absent('no "Acts of God" / "do not result in rate increases" prediction',
    /Acts of God|do(?:es)? not result in rate increases|won.t raise your rates/i, html,
    'classified as "Acts of God" and generally do not result in rate increases');
  absent('no "claims are approved within N weeks" outcome promise',
    /claims? (?:are|is) approved within/i, html, 'Most claims are approved within 2–4 weeks.');
  ok('claim guide states the insurer decides the claim and rates',
    /Your insurance company decides your claim/.test(html) && /cannot predict it/.test(html) && /up to your insurance company/.test(html));
  ok('claim guide still states we estimate and document (no claim representation)',
    /inspect, document and estimate the repair/.test(html));

  const hail = read('docs/services/hail-damage-insurance-claim.html');
  absent('public hail-claim page does not say insurers "cannot raise your rates"',
    /cannot raise your rates/i, hail, 'In Ohio, insurance companies cannot raise your rates for a single weather-related claim');
  ok('public hail-claim page keeps JSON-LD and visible FAQ answer in step',
    (hail.match(/I can't promise a claim won't affect yours/g) || []).length === 2);
}

console.log('CLAIM HONESTY 2026-10-13 — (4) referral bonus is the code constant ($100)');
{
  const m = /const REFERRAL_BONUS_USD = (\d+);/.exec(read('functions/referral-rewards.js'));
  ok('functions/referral-rewards.js REFERRAL_BONUS_USD is readable', !!m);
  const codeBonus = m ? Number(m[1]) : NaN;
  const win = loadEnv();
  const schema = win.DocPreflight.DOC_SCHEMAS.referral_card;
  const fields = [];
  schema.sections.forEach((s) => s.fields.forEach((f) => fields.push(f)));
  const bonus = fields.find((f) => f.key === 'bonusAmount');
  ok('referral preflight bonus field exists', !!bonus);
  ok('referral preflight bonus literal equals REFERRAL_BONUS_USD (' + codeBonus + ')',
    !!bonus && bonus.source === 'literal:' + codeBonus);
  const terms = fields.find((f) => f.key === 'terms');
  ok('referral terms say the bonus is paid when the job closes (matches the credit trigger)',
    !!terms && /when the referred job closes/.test(terms.source));
  absent('doc-preflight.js has no $250 referral literal', /literal:250\b/, stripComments(read('docs/pro/js/doc-preflight.js')), "source: 'literal:250'");
}

console.log('CLAIM HONESTY 2026-10-13 — (5) default payment-methods sentence matches what is accepted');
{
  const cp = stripComments(read('docs/pro/js/company-profile.js'));
  const m = /paymentMethodsNoCash:\s*'([^']*)'/.exec(cp);
  ok('company-profile.js default paymentMethodsNoCash is readable', !!m);
  const text = m ? m[1] : '';
  absent('default does not say "No cash payments accepted"', /no cash payments? accepted/i, text,
    'All payments must be made by check, ACH transfer, or credit card. No cash payments accepted.');
  ok('default lists check, ACH, card, Zelle and cash',
    /check/i.test(text) && /ACH/.test(text) && /credit card/i.test(text) && /Zelle/.test(text) && /cash/i.test(text));
  ok('default keeps the schedule sentence (not removed with the payment-methods rewrite)',
    /Material delays may extend timeline/.test(text));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
