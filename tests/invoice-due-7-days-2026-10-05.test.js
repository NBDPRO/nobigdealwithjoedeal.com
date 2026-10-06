/**
 * tests/invoice-due-7-days-2026-10-05.test.js — every invoice due date is
 * 7 days (Jo, 2026-10-05: "7 days everywhere").
 *
 * One constant per side: INVOICE_DUE_DAYS in deposit-rule.js (the client copy
 * docs/pro/js/deposit-rule.js and the server copy functions/deposit-rule.js are
 * byte-identical). Each path that computes or defaults an invoice due date or
 * net terms is listed below and must read that rule. The client paths run in
 * a sandbox twice: once with the real rule (7 days) and once with a stand-in
 * rule of 9 days, so a path that only happens to say 7 still fails. No
 * tenant setting for invoice terms exists today; a rep-entered due date still
 * wins over the default, and that is checked too.
 *
 *   server  S1 functions/deposit-rule.js         INVOICE_DUE_DAYS / invoiceDueDateMs / netTermsText
 *           S2 functions/deposit-draft-logic.js  deposit draft + final draft dueDate
 *           S3 functions/money-paper-logic.js    NBD-500 PDF "Due"
 *           S4 functions/stripe-crm-invoice.js   Stripe days_until_due
 *   client  C1 docs/pro/js/deposit-rule.js       same file as S1
 *           C2 docs/pro/js/invoice-pipeline.js   estimate invoice + manual invoice: dueDate + terms
 *           C3 docs/pro/js/doc-preflight.js      invoice form Due Date default (was +30 days)
 *           C4 docs/pro/js/doc-preflight.js      invoice form Payment Terms default (was "Net 30.")
 *           C5 docs/pro/js/document-generator.js invoice PDF payload "Due" when blank (was "Upon receipt")
 *           C6 docs/pro/js/document-generator-templates.js renderInvoice blank due date + terms line
 *                                                (was "Due upon receipt" / "due upon receipt")
 *
 * Run: node tests/invoice-due-7-days-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');
// Strip comments so a guard can't pass on prose (rule: grep guards strip comments).
const code = (p) => lf(read(p)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const DAY = 86400000;
const T = Date.UTC(2026, 9, 5, 15, 0, 0);

// ── server ───────────────────────────────────────────────────────────
console.log('\nserver');
const SDR = require(path.join(ROOT, 'functions/deposit-rule.js'));
ok('S1 INVOICE_DUE_DAYS is 7', SDR.INVOICE_DUE_DAYS === 7, String(SDR.INVOICE_DUE_DAYS));
ok('S1 invoiceDueDateMs(t) = t + 7 days', SDR.invoiceDueDateMs(T) === T + 7 * DAY);
ok('S1 netTermsText() = "Net 7."', SDR.netTermsText() === 'Net 7.');
{
  const src = code('functions/deposit-draft-logic.js');
  const dep = src.slice(src.indexOf('function decideDepositDraft'), src.indexOf('function reviewTask('));
  const fin = src.slice(src.indexOf('function decideFinalDraft'), src.indexOf('function finalTask('));
  ok('S2 deposit draft dueDate = DR.invoiceDueDateMs', /dueDate:\s*new Date\(DR\.invoiceDueDateMs\(nowMs\)\)/.test(dep));
  ok('S2 final draft dueDate = DR.invoiceDueDateMs', /dueDate:\s*new Date\(DR\.invoiceDueDateMs\(nowMs\)\)/.test(fin));
  const mp = code('functions/money-paper-logic.js');
  ok('S3 NBD-500 PDF due = DR.invoiceDueDateMs', /fmtDate\(DR\.invoiceDueDateMs\(nowMs\)\)/.test(mp));
  ok('S4 Stripe days_until_due = INVOICE_DUE_DAYS',
    /days_until_due:\s*require\('\.\/deposit-rule'\)\.INVOICE_DUE_DAYS/.test(code('functions/stripe-crm-invoice.js')));
  // No server file computes its own invoice due offset.
  const own = [];
  for (const f of ['functions/deposit-draft-logic.js', 'functions/money-paper-logic.js', 'functions/stripe-crm-invoice.js',
    'functions/invoice-from-estimate.js', 'functions/render-pdf.js', 'functions/money-paper.js', 'functions/deposit-draft.js']) {
    if (/days_until_due:\s*\d|dueDate[^\n]{0,80}\d+\s*\*\s*(86400000|864e5|24\s*\*\s*60)/.test(code(f))) own.push(f);
  }
  ok('S* no server writer carries its own due-day count', own.length === 0, own.join(', '));
}

// ── client ───────────────────────────────────────────────────────────
console.log('\nclient');
ok('C1 docs/pro/js/deposit-rule.js is byte-identical to the server copy',
  lf(read('docs/pro/js/deposit-rule.js')) === lf(read('functions/deposit-rule.js')));
{
  const ip = code('docs/pro/js/invoice-pipeline.js');
  ok('C2 both invoice-pipeline dueDate writers read invoiceDueDateMs',
    (ip.match(/dueDate:\s*new Date\((_depRule|dr) \? \1\.invoiceDueDateMs\(/g) || []).length === 2);
  ok('C2 both invoice-pipeline terms read netTermsText',
    (ip.match(/terms:\s*\(?(_depRule|dr) \? \1\.netTermsText\(\)/g) || []).length === 2);
}

const DG = 'docs/pro/js/';
function loadEnv(rule) {
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
  if (rule === 'real') vm.runInNewContext(read(DG + 'deposit-rule.js'), sandbox, { filename: 'deposit-rule.js' });
  else win.NBDDepositRule = rule;
  for (const f of ['estimate-config.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
    vm.runInNewContext(read(DG + f), sandbox, { filename: f });
  }
  return win;
}
const NINE = { INVOICE_DUE_DAYS: 9, invoiceDueDateMs: (n) => Number(n) + 9 * DAY, netTermsText: () => 'Net 9.' };
const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const longDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

for (const [label, rule, days] of [['real rule', 'real', 7], ['stand-in 9-day rule', NINE, 9]]) {
  console.log('  — ' + label);
  const win = loadEnv(rule);
  const pf = win.DocPreflight;
  const fields = {};
  pf.DOC_SCHEMAS.invoice.sections.forEach((s) => s.fields.forEach((f) => { fields[f.key] = f; }));
  const ctx = { lead: {}, estimate: {}, photos: [], overrides: {} };
  const now = Date.now();

  const due = pf._resolveFieldValue(fields.dueDate, ctx);
  ok(`C3 [${label}] invoice form Due Date defaults to today + ${days}`, due === ymd(now + days * DAY), 'got ' + due);
  const terms = pf._resolveFieldValue(fields.paymentTerms, ctx);
  ok(`C4 [${label}] invoice form Payment Terms start "Net ${days}."`, typeof terms === 'string' && terms.indexOf('Net ' + days + '.') === 0, 'got ' + JSON.stringify(terms));
  ok(`C3 [${label}] a saved/rep-entered due date still wins`,
    pf._resolveFieldValue(fields.dueDate, Object.assign({}, ctx, { overrides: { dueDate: '2027-01-15' } })) === '2027-01-15');

  const payload = win.NBDDocGen._buildServerPayload('invoice', { homeownerName: 'Jane Smith', address: '1 Main St', leadId: 'L1', lineItems: [{ description: 'Roof', qty: 1, rate: 100 }] });
  const dueRow = (payload.projectMeta || []).find((r) => r.label === 'Due');
  ok(`C5 [${label}] invoice PDF payload with no due date prints today + ${days}`,
    !!dueRow && dueRow.value === longDate(now + days * DAY) && payload.invoice.dueDate === longDate(now + days * DAY),
    'got ' + JSON.stringify(dueRow && dueRow.value) + ' / ' + JSON.stringify(payload.invoice && payload.invoice.dueDate));
  const p2 = win.NBDDocGen._buildServerPayload('invoice', { homeownerName: 'Jane Smith', address: '1 Main St', leadId: 'L1', dueDate: '2027-01-15', lineItems: [] });
  ok(`C5 [${label}] an entered due date still wins`, (p2.projectMeta || []).find((r) => r.label === 'Due').value === '2027-01-15');

  const html = win.NBDDocGen.renderInvoice({ homeownerName: 'Jane Smith', address: '1 Main St' });
  ok(`C6 [${label}] renderInvoice with no due date shows today + ${days}`, html.indexOf(longDate(now + days * DAY)) !== -1);
  ok(`C6 [${label}] renderInvoice says Net ${days}, never "due upon receipt"`,
    !/upon receipt/i.test(html) && new RegExp('Net ' + days + '\\b').test(html));
  ok(`C6 [${label}] renderInvoice keeps an entered due date`,
    win.NBDDocGen.renderInvoice({ homeownerName: 'J', address: 'A', dueDate: 'March 3, 2027' }).indexOf('March 3, 2027') !== -1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
