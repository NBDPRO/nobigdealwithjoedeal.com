/**
 * card-fee-v1-2026-11-18.test.js — card fee v1 (flag docCardFeeV1, default OFF).
 *   A. flag OFF (and flag on with no fee configured): invoice, receipt and Payment Agreement are
 *      BYTE-IDENTICAL to goldens recorded from origin/main before any renderer changed.
 *   B. computeCardFee: every gate, cap, rounding, strictness.
 *   C. refundFeeCents, paymentRecordFields, disclosureLine (never prints while CHARGING_LIVE is false).
 *   D. documents: the fee line prints only when the payment data carries a fee and the flag is on.
 *   E. twins byte-identical, flag registered, no Stripe call made by the module.
 * Run: node tests/card-fee-v1-2026-11-18.test.js          --print  prints the goldens
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./helpers/clause-v1-harness');

const GOLDEN = path.join(__dirname, 'fixtures', 'card-fee-v1-golden.json');
const INV = { homeownerName: 'Jane Smith', address: '1 Elm St, Cincinnati, OH 45202', invoiceNumber: 'INV-1',
  invoiceDate: 'November 18, 2026', dueDate: 'November 25, 2026', lineItems: [{ description: 'Roof replacement', qty: 1, unit: 'job', unitPrice: 18500 }] };
const RCT = { homeownerName: 'Jane Smith', address: '1 Elm St, Cincinnati, OH 45202', receiptNumber: 'RCT-1', paymentDate: 'November 18, 2026',
  paymentMethod: 'Card', amountPaid: 5000, contractTotal: 18500, priorPayments: 0 };
const PA = { homeownerName: 'Jane Smith', address: '1 Elm St, Cincinnati, OH 45202', totalAmount: '18500.00', depositAmount: '9250.00',
  progressAmount: '0.00', finalAmount: '9250.00', projectDescription: 'Roof replacement.' };

function renders(env) {
  const W = env.win, out = {};
  const prof = () => H.profileFor(W, H.BIZ_ADDR, {});
  out['invoice.nolink'] = W.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof() }));
  out['invoice.link'] = W.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof(), payUrl: 'https://pay.example/x' }));
  out['invoice.paid'] = W.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof(), paymentsReceived: 5000 }));
  out['receipt.card'] = W.NBDDocGen.renderReceipt(Object.assign({}, RCT, { companyProfile: prof() }));
  out['receipt.nototal'] = W.NBDDocGen.renderReceipt({ homeownerName: 'A', address: 'B', receiptNumber: 'R2', paymentDate: 'D', amountPaid: 100, companyProfile: prof() });
  out['pa.default'] = W.NBDDocGen.renderPaymentAgreement(Object.assign({}, PA, { companyProfile: prof() }));
  return out;
}
if (process.argv.includes('--print')) {
  const r = renders(H.docs({})); const g = {};
  Object.keys(r).forEach((k) => { g[k] = H.sha(r[k]); });
  process.stdout.write(JSON.stringify(g, null, 2) + '\n'); process.exit(0);
}

let passed = 0, failed = 0;
function ok(name, cond, detail) { if (cond) passed++; else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); } }
const norm = (p) => H.read(p).replace(/\r\n/g, '\n');
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const vm = require('vm');

// ---- E. files, twins, flag
ok('twin modules exist', fs.existsSync(path.join(H.ROOT, 'functions/card-fee.js')) && fs.existsSync(path.join(H.ROOT, 'docs/pro/js/card-fee.js')));
ok('card-fee.js twins are byte-identical', fs.existsSync(path.join(H.ROOT, 'docs/pro/js/card-fee.js')) && norm('docs/pro/js/card-fee.js') === norm('functions/card-fee.js'));
const CF = require('../functions/card-fee.js');
const REG = require('../functions/flags-registry.js');
ok('flag docCardFeeV1 registered, default false', REG.FIRESTORE_FLAGS.some((f) => f.name === 'docCardFeeV1' && f.default === false && f.dark === true));
ok('module flag name/default agree with the registry', CF.FLAG_NAME === 'docCardFeeV1' && CF.FLAG_DEFAULT === false);
ok('no fee mechanism is live', CF.CHARGING_LIVE === false);
ok('module makes no Stripe / network call', !/require\(|stripe|fetch\(|XMLHttp/i.test(H.read('functions/card-fee.js').replace(/\/\*[\s\S]*?\*\//, '')));
ok('script-loader loads card-fee.js with the document group', /js\/card-fee\.js\?v=\d+/.test(H.read('docs/pro/js/script-loader.js')));

// ---- B. computeCardFee
const B = { amountCents: 100000, funding: 'credit', cardFeePct: 3, state: 'OH', paymentSource: 'cash', contractHasClause: true };
const fee = (o) => CF.computeCardFee(Object.assign({}, B, o));
ok('3% of $1,000 credit OH cash = $30.00', fee({}).feeCents === 3000 && fee({}).reason === 'OK');
ok('financed OH job pays the fee', fee({ paymentSource: 'financed' }).feeCents === 3000);
['debit', 'prepaid', 'unknown', '', null, undefined, 'Debit', 'credit_card', 5].forEach((f) => ok('funding ' + JSON.stringify(f) + ' = no fee', fee({ funding: f }).feeCents === 0));
ok('funding "Credit" / " credit " reads as credit', fee({ funding: 'Credit' }).feeCents === 3000 && fee({ funding: ' credit ' }).feeCents === 3000);
ok('debit reason NOT_CREDIT', fee({ funding: 'debit' }).reason === 'NOT_CREDIT');
[0, -1, null, undefined, NaN, 'abc', '', Infinity].forEach((p) => ok('cardFeePct ' + String(p) + ' = FEE_OFF', fee({ cardFeePct: p }).feeCents === 0 && fee({ cardFeePct: p }).reason === 'FEE_OFF'));
ok('cardFeePct "3" string works', fee({ cardFeePct: '3' }).feeCents === 3000);
ok('pct above 3 is capped at 3.0', fee({ cardFeePct: 10 }).feeCents === 3000 && fee({ cardFeePct: 3.01 }).feeCents === 3000);
ok('2.5% of $1,000 = $25.00', fee({ cardFeePct: 2.5 }).feeCents === 2500);
[false, undefined, null, 'true', 1, 0].forEach((c) => ok('contractHasClause ' + String(c) + ' = NO_CLAUSE', fee({ contractHasClause: c }).feeCents === 0 && fee({ contractHasClause: c }).reason === 'NO_CLAUSE'));
ok('KY + insurance = 0', fee({ state: 'KY', paymentSource: 'insurance' }).feeCents === 0 && fee({ state: 'KY', paymentSource: 'insurance' }).reason === 'KY_INSURANCE');
ok('Kentucky spelled out + insurance = 0', fee({ state: 'Kentucky', paymentSource: 'Insurance' }).feeCents === 0);
ok('unknown state + insurance = 0 (strict)', fee({ state: '', paymentSource: 'insurance' }).feeCents === 0 && fee({ state: undefined, paymentSource: 'insurance' }).feeCents === 0);
ok('KY + unknown source = 0 (strict)', fee({ state: 'KY', paymentSource: '' }).feeCents === 0 && fee({ state: 'KY', paymentSource: undefined }).feeCents === 0);
ok('unknown state + unknown source = 0', fee({ state: '', paymentSource: '' }).feeCents === 0);
ok('KY cash pays the fee', fee({ state: 'KY', paymentSource: 'cash' }).feeCents === 3000);
ok('OH insurance pays the fee (decided: Ohio insurance normal)', fee({ state: 'OH', paymentSource: 'insurance' }).feeCents === 3000);
ok('unreadable state + cash pays (cash is not insurance)', fee({ state: '', paymentSource: 'cash' }).feeCents === 3000);
[0, -5, 1.5, NaN, '1000', null, undefined, Infinity].forEach((a) => ok('amountCents ' + String(a) + ' = BAD_AMOUNT', fee({ amountCents: a }).feeCents === 0 && fee({ amountCents: a }).reason === 'BAD_AMOUNT'));
ok('half-up: 3% of 50 cents = 1.5 -> 2', fee({ amountCents: 50 }).feeCents === 2);
ok('half-up: 3% of 16 cents = 0.48 -> 0', fee({ amountCents: 16 }).feeCents === 0);
ok('half-up: 3% of 17 cents = 0.51 -> 1', fee({ amountCents: 17 }).feeCents === 1);
ok('half-up exact tie 2.5% of 20 cents = 0.5 -> 1', fee({ amountCents: 20, cardFeePct: 2.5 }).feeCents === 1);
ok('3% of 12345 cents = 370.35 -> 370', fee({ amountCents: 12345 }).feeCents === 370);
ok('3% of 12350 cents = 370.5 -> 371', fee({ amountCents: 12350 }).feeCents === 371);
ok('large amount stays exact: 3% of $9,999,999.99', fee({ amountCents: 999999999 }).feeCents === 30000000);
ok('float edge: 1.1% of 1000 = 11', fee({ cardFeePct: 1.1, amountCents: 1000 }).feeCents === 11);
ok('processor cost below the fee caps it', fee({ processorCostCents: 2500 }).feeCents === 2500);
ok('processor cost above the fee leaves it', fee({ processorCostCents: 9000 }).feeCents === 3000);
ok('processor cost 0 means fee 0 (reason COST_ZERO)', fee({ processorCostCents: 0 }).feeCents === 0 && fee({ processorCostCents: 0 }).reason === 'COST_ZERO');
['x', -1, NaN, null, undefined].forEach((c) => ok('processor cost ' + String(c) + ' is ignored', fee({ processorCostCents: c }).feeCents === 3000));
ok('never negative, always an integer across a sweep', (() => { for (let a = -3; a < 400; a++) { const r = fee({ amountCents: a }); if (!(r.feeCents >= 0) || !Number.isInteger(r.feeCents)) return false; } return true; })());
ok('fee never exceeds the 3% cap plus half a cent (sweep)', (() => { for (let a = 1; a < 5000; a++) { if (fee({ amountCents: a, cardFeePct: 9 }).feeCents > a * 0.03 + 0.5 + 1e-9) return false; } return true; })());
ok('empty / missing input is a safe zero', CF.computeCardFee().feeCents === 0 && CF.computeCardFee({}).feeCents === 0 && CF.computeCardFee(null).feeCents === 0);
ok('input object is not mutated', (() => { const o = Object.assign({}, B); const s = JSON.stringify(o); CF.computeCardFee(o); return JSON.stringify(o) === s; })());

// ---- C. refunds, records, disclosure
ok('full refund returns the whole fee', CF.refundFeeCents(3000, 103000, 103000) === 3000 && CF.refundFeeCents(3000, 103000, 200000) === 3000);
ok('Stripe docs example: $60 of a $100 order with a $1.50 fee returns $0.90', CF.refundFeeCents(150, 10000, 6000) === 90);
ok('half refund returns half the fee', CF.refundFeeCents(3000, 10000, 5000) === 1500);
ok('pro-rata half-up: fee 1 on 3 cents, refund 1 -> 0, refund 2 -> 1', CF.refundFeeCents(1, 3, 1) === 0 && CF.refundFeeCents(1, 3, 2) === 1);
ok('no fee, no payment or no refund = 0', CF.refundFeeCents(0, 100, 50) === 0 && CF.refundFeeCents(100, 0, 50) === 0 && CF.refundFeeCents(100, 100, 0) === 0 && CF.refundFeeCents('x', 1, 1) === 0);
ok('fee refund never exceeds the fee (sweep)', (() => { for (let r = 1; r <= 1000; r += 7) if (CF.refundFeeCents(31, 1000, r) > 31) return false; return true; })());
ok('record fields for a credit payment', JSON.stringify(CF.paymentRecordFields({ cardFeeCents: 3000, cardFeePct: 3, funding: 'credit' })) === JSON.stringify({ cardFeeCents: 3000, cardFeePct: 3, fundingType: 'credit' }));
ok('record fields for debit: no fee, funding kept', JSON.stringify(CF.paymentRecordFields({ funding: 'debit' })) === JSON.stringify({ cardFeeCents: 0, cardFeePct: 0, fundingType: 'debit' }));
ok('record fields: missing funding = unknown, junk fee = 0', CF.paymentRecordFields({ cardFeeCents: -4 }).fundingType === 'unknown' && CF.paymentRecordFields({ cardFeeCents: 'x' }).cardFeeCents === 0 && CF.paymentRecordFields().fundingType === 'unknown');
const DL = { flagOn: true, cardFeePct: 3, contractHasClause: true, state: 'OH', paymentSource: 'cash' };
ok('disclosure is empty while CHARGING_LIVE is false, even with everything else true', CF.disclosureLine(DL) === '');
const LIVE = (() => { const src = H.read('functions/card-fee.js').replace('var CHARGING_LIVE = false;', 'var CHARGING_LIVE = true;'); const m = { exports: {} }; vm.runInNewContext(src, { module: m }); return m.exports; })();
const SENT = 'Pay free by Zelle, check, ACH or wire (and cash). Credit cards carry a 3% fee; debit and prepaid cards do not.';
ok('live copy: disclosure text is exactly the decided sentence', LIVE.disclosureLine(DL) === SENT, LIVE.disclosureLine(DL));
ok('live copy: flag off = no line', LIVE.disclosureLine(Object.assign({}, DL, { flagOn: false })) === '' && LIVE.disclosureLine(Object.assign({}, DL, { flagOn: 'true' })) === '');
ok('live copy: cardFeePct 0 = no line', LIVE.disclosureLine(Object.assign({}, DL, { cardFeePct: 0 })) === '');
ok('live copy: no clause on the contract = no line', LIVE.disclosureLine(Object.assign({}, DL, { contractHasClause: false })) === '');
ok('live copy: KY insurance and unknown = no line', LIVE.disclosureLine(Object.assign({}, DL, { state: 'KY', paymentSource: 'insurance' })) === '' && LIVE.disclosureLine(Object.assign({}, DL, { state: '', paymentSource: '' })) === '');
ok('live copy: pct is capped and trimmed (2.5 prints 2.5, 9 prints 3)', /carry a 2\.5% fee/.test(LIVE.disclosureLine(Object.assign({}, DL, { cardFeePct: 2.5 }))) && /carry a 3% fee/.test(LIVE.disclosureLine(Object.assign({}, DL, { cardFeePct: 9 }))));
ok('receipt line: flag off = none; fee 0 = none; flag on + fee = label', CF.receiptFeeLine({ flagOn: false, cardFeeCents: 300 }) === null && CF.receiptFeeLine({ flagOn: true, cardFeeCents: 0 }) === null && CF.receiptFeeLine({ flagOn: true, cardFeeCents: 300, cardFeePct: 3 }).label === 'Credit card fee (3%)');

// ---- A. flag off / no fee: byte-identical documents
const gold = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const off = renders(H.docs({}));
Object.keys(gold).forEach((k) => ok('flag off: ' + k + ' is byte-identical to the golden', H.sha(off[k]) === gold[k]));
const onNoFee = renders(H.docs({ flags: { docCardFeeV1: true } }));
Object.keys(gold).forEach((k) => ok('flag on, no fee configured or charged: ' + k + ' is byte-identical to the golden', H.sha(onNoFee[k]) === gold[k]));
ok('"Credit Card - ask for secure link" tile is untouched', /Credit Card — ask for secure link/.test(off['invoice.nolink']));
ok('no document mentions a card fee today', Object.keys(off).every((k) => !/credit card fee|Credit cards carry/i.test(off[k]) && !/credit card fee|Credit cards carry/i.test(onNoFee[k])));

// ---- D. documents with a fee on the payment data
function withFee(flag, extra) {
  const env = H.docs({ flags: flag ? { docCardFeeV1: true } : {} });
  const W = env.win;
  const prof = H.profileFor(W, H.BIZ_ADDR, {});
  const fd = Object.assign({ cardFeeCents: 300, cardFeePct: 3 }, extra || {});
  return {
    invoice: W.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof, paymentsReceived: 10300 }, fd)),
    receipt: W.NBDDocGen.renderReceipt(Object.assign({}, RCT, { companyProfile: prof, amountPaid: 10300 }, fd)),
  };
}
const fOn = withFee(true), fOff = withFee(false);
ok('flag on + fee on the payment: the invoice prints it as its own line', /Credit card fee \(3%\)/.test(text(fOn.invoice)) && /\$3\.00/.test(text(fOn.invoice)));
ok('flag on + fee on the payment: the receipt prints it as its own line', /Credit card fee \(3%\)/.test(text(fOn.receipt)) && /\$3\.00/.test(text(fOn.receipt)));
ok('flag off + fee data: nothing prints', !/credit card fee/i.test(fOff.invoice + fOff.receipt));
ok('flag off: fee data does not change the bytes', H.sha(fOff.receipt) === H.sha(withFee(false, { cardFeeCents: 0 }).receipt));
ok('fee 0 with the flag on prints no fee line', !/credit card fee/i.test(withFee(true, { cardFeeCents: 0 }).invoice));
ok('junk fee data prints nothing', !/credit card fee/i.test(withFee(true, { cardFeeCents: 'x' }).receipt + withFee(true, { cardFeeCents: -5 }).receipt));
{
  const env = H.docs({ flags: { docCardFeeV1: true } });
  env.win.NBDCardFee = LIVE;
  const prof = H.profileFor(env.win, H.BIZ_ADDR, { paymentTerms: { cardFeePct: 3 } });
  const run = (extra) => text(env.win.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof, payUrl: 'https://pay.example/x' }, extra || {})));
  ok('live copy + flag + cardFeePct + clause + OH: invoice shows the disclosure', run({ contractCardFeeClause: true }).indexOf(SENT) !== -1);
  ok('live copy: no clause on the contract = no disclosure', run({}).indexOf('Credit cards carry') === -1);
  ok('live copy: KY insurance invoice = no disclosure', run({ contractCardFeeClause: true, address: '1 Elm St, Fort Thomas, KY 41075', jobType: 'insurance' }).indexOf('Credit cards carry') === -1);
  ok('live copy: unreadable address and source = no disclosure', run({ contractCardFeeClause: true, address: 'somewhere' }).indexOf('Credit cards carry') === -1);
}
ok('the shipped module never shows the disclosure on an invoice with all inputs set', (() => {
  const env = H.docs({ flags: { docCardFeeV1: true } });
  const prof = H.profileFor(env.win, H.BIZ_ADDR, { paymentTerms: { cardFeePct: 3 } });
  return text(env.win.NBDDocGen.renderInvoice(Object.assign({}, INV, { companyProfile: prof, contractCardFeeClause: true, jobType: 'cash' }))).indexOf('Credit cards carry') === -1;
})());

console.log('\ncard-fee-v1: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
