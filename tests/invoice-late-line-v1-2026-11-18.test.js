/**
 * invoice-late-line-v1-2026-11-18.test.js — the invoice and the Payment Agreement stop printing the
 * "1.5% monthly finance charge" / "A convenience fee may apply." wording when flag docClauseSetV1 is on,
 * and print the LATE-4 pointer line instead ("Late-payment terms are in your signed contract.").
 * Flag off: both documents render BYTE-IDENTICAL to before (goldens in tests/fixtures/invoice-late-line-golden.json,
 * recorded from the tree BEFORE the renderers were touched).
 * Run: node tests/invoice-late-line-v1-2026-11-18.test.js          --print  prints the goldens
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./helpers/clause-v1-harness');

const GOLDEN = path.join(__dirname, 'fixtures', 'invoice-late-line-golden.json');
const LINE = 'Late-payment terms are in your signed contract.';

const INV = { homeownerName: 'Jane Smith', address: '1 Elm St, Cincinnati, OH 45202', invoiceNumber: 'INV-1',
  invoiceDate: 'November 18, 2026', dueDate: 'November 25, 2026', lineItems: [{ description: 'Roof replacement', qty: 1, unit: 'job', unitPrice: 18500 }] };
const PA = { homeownerName: 'Jane Smith', address: '1 Elm St, Cincinnati, OH 45202', totalAmount: '18500.00', depositAmount: '9250.00',
  progressAmount: '0.00', finalAmount: '9250.00', projectDescription: 'Roof replacement.' };
const CUSTOM = { latePaymentChargeText: '2% monthly service charge' };

function renders(env) {
  const W = env.win, out = {};
  const prof = (extra) => H.profileFor(W, H.BIZ_ADDR, extra);
  out['invoice.default'] = W.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof() }));
  out['invoice.custom'] = W.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof(CUSTOM) }));
  out['pa.default'] = W.NBDDocGen.renderPaymentAgreement(Object.assign({}, PA, { companyProfile: prof() }));
  out['pa.custom'] = W.NBDDocGen.renderPaymentAgreement(Object.assign({}, PA, { companyProfile: prof(CUSTOM) }));
  return out;
}
function goldens() {
  const r = renders(H.docs({}));
  const g = {};
  Object.keys(r).forEach((k) => { g[k] = H.sha(r[k]); });
  return g;
}
if (process.argv.includes('--print')) { process.stdout.write(JSON.stringify(goldens(), null, 2) + '\n'); process.exit(0); }

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) passed++; else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// 1. flag off: byte-identical, and the old wording is still there
const gold = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const off = renders(H.docs({}));
Object.keys(gold).forEach((k) => ok('flag off: ' + k + ' is byte-identical to the golden', H.sha(off[k]) === gold[k]));
ok('flag off: the invoice still says 1.5% monthly finance charge', /1\.5% monthly finance charge/.test(off['invoice.default']));
ok('flag off: the Payment Agreement still says A convenience fee may apply', /A convenience fee may apply/.test(off['pa.default']));
ok('flag off: a tenant late-charge text still prints', /2% monthly service charge/.test(off['invoice.custom']) && /2% monthly service charge/.test(off['pa.custom']));
ok('flag off: the LATE-4 line is not printed', off['invoice.default'].indexOf(LINE) === -1 && off['pa.default'].indexOf(LINE) === -1);

// 2. flag on
const on = renders(H.docs({ flags: { docClauseSetV1: true } }));
const CS = H.docs({ flags: { docClauseSetV1: true } }).win.NBDClauseSet;
ok('registry exposes the invoice line', CS && typeof CS.lateInvoiceLine === 'function' && CS.lateInvoiceLine() === LINE);
Object.keys(on).forEach((k) => {
  const t = text(on[k]);
  ok('flag on: ' + k + ' prints the LATE-4 line', t.indexOf(LINE) !== -1);
  ok('flag on: ' + k + ' has no 1.5%', !/1\.5\s*%/.test(t));
  ok('flag on: ' + k + ' has no finance charge', !/finance charge/i.test(t));
  ok('flag on: ' + k + ' has no convenience fee', !/convenience fee/i.test(t));
  ok('flag on: ' + k + ' drops the tenant free-text late charge too', !/service charge/i.test(t));
  ok('flag on: ' + k + ' prints the LATE-4 line exactly once', t.split(LINE).length === 2);
});
ok('flag on: the invoice keeps its Net 7 due-date sentence', /Payment is due within 7 days of the invoice date \(Net 7\)/.test(text(on['invoice.default'])));
ok('flag on: the Payment Agreement keeps its card-by-secure-link line', /Credit card payments are accepted via secure link/.test(text(on['pa.default'])));
ok('flag on: the Payment Agreement keeps its other terms', /Work will not commence until the deposit/.test(on['pa.default']) && /disputed amounts/.test(on['pa.default']));

// 3. flag on but the wording did not load: fall back to today's text (never a blank, never a thrown render)
const bare = renders(H.docs({ flags: { docClauseSetV1: true }, noClauseText: true }));
ok('flag on, wording missing: invoice falls back to today\'s text', H.sha(bare['invoice.default']) === gold['invoice.default']);
ok('flag on, wording missing: Payment Agreement falls back to today\'s text', H.sha(bare['pa.default']) === gold['pa.default']);

// 4. the twins and the packet
const norm = (p) => fs.readFileSync(path.join(H.ROOT, p), 'utf8').replace(/\r\n/g, '\n');
ok('clause-set.js twins are byte-identical', norm('docs/pro/js/clause-set.js') === norm('functions/clause-set.js'));
ok('clause-set-text.js twins are byte-identical', norm('docs/pro/js/clause-set-text.js') === norm('functions/clause-set-text.js'));
const T = require(path.join(H.ROOT, 'functions/clause-set-text.js')).CLAUSES['LATE-4'];
ok('LATE-4 contract sentences are unchanged', T.parts.length === 1 && /^Invoices, reminders and payment links are for convenience\./.test(T.parts[0].text));

// 5. no server-side invoice text carries the old wording
['functions/render-pdf.js', 'functions/stripe-crm-invoice.js', 'functions/invoice-from-estimate.js', 'functions/print/templates/invoice.hbs'].forEach((f) => {
  ok(f + ' has no 1.5% / finance charge / convenience fee', !/1\.5\s*%|finance charge|convenience fee/i.test(norm(f)));
});

console.log('\ninvoice-late-line-v1: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
