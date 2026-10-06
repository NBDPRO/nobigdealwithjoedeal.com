/**
 * tests/hd-import-2026-09-29.test.js
 *
 * docs/pro/js/hd-import.js — Home Depot Pro Xtra purchase import. Drives the
 * real module against SYNTHETIC exports shaped exactly like Home Depot's
 * Summary and Details CSVs (account-info preamble, then a header row). The
 * repo is public: no real purchase, name, phone or card is in this file.
 *
 * Pins: parsing (preamble, quotes, $ amounts, tax = total − pre-tax), the
 * details join, stable receipt keys (so a re-import skips), category
 * suggestions (power tools live in HARDWARE — detected by words, not the
 * department; only the TOOL RENTAL department is a rental), and the job
 * matching rules Jo follows at checkout.
 *
 * Run: node tests/hd-import-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const win = { addEventListener() {} }; win.window = win;
win.ExpenseConfig = { costTypeFor: (k) => (['materials', 'equipment_dumpster'].includes(k) ? 'direct' : 'overhead') };
const ctx = { window: win, document: { addEventListener() {} }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'hd-import.js'), 'utf8'), ctx, { filename: 'hd-import.js' });
const H = win.NBDHdImport;

const PRE = 'Company Name,ZZ QA ROOFING\nPhone Number,555-000-0000\nSource,Purchase Tracking\nDate Range,01/01/26 to 09/29/26\nExport Date,September 29 2026 07:52:57\n \n';
const SUMMARY = PRE +
  'Date,Receipt Added Date,Order Origin,Purchaser,Transaction ID,Register Number,Project Name,Job Name,Program Disc Amt,Other Disc,Pre-tax Amount,Total Amount Paid,Order Number,Payment,Text2Confirm,Card/Account Nickname,Invoice Number\n' +
  '2026-09-26,2026-09-26,"#1111, Test Town",ZZ Buyer,2281,36,,NBD-0042 Smith,,$0.00,$61.44,$66.23,,X-0000,N,,\n' +
  '2026-09-25,2026-09-25,"#1111, Test Town",ZZ Buyer,1497,3,,LORA,,$0.00,$51.62,$55.65,,X-0000,N,,\n' +
  '2026-09-19,2026-09-19,"#2222, Other Town",ZZ Buyer,6003,51,,Foxglove,,-$18.00,"$1,161.10","$1,171.97",,X-0000,N,,\n' +
  '2026-06-24,2026-06-24,"#2222, Other Town",ZZ Buyer,7001,5,,M18 8 Tool Combo,,$0.00,$619.00,$660.78,,X-0000,N,,\n' +
  '2026-06-04,2026-06-04,"#2222, Other Town",ZZ Buyer,7002,5,,4622 ASHGROVE AVE.,,$0.00,$240.00,$259.44,,X-0000,N,,\n' +
  '2026-05-10,2026-05-10,Online,ZZ Buyer,,,,SHOP,,$0.00,$27.00,$28.84,WH00000001,X-0000,N,,\n' +
  '2026-05-09,2026-05-09,"#1111, Test Town",ZZ Buyer,8001,9,,,,$0.00,$29.00,$30.74,,X-0000,N,,\n';
const DETAILS = PRE +
  'Date,Store Number,Transaction ID,Register Number,Project Name,Job Name,SKU Number,SKU Description,Quantity,Unit price,Department Name,Class Name,Subclass Name,Program Discount Amount,Program Discount Indicator,Other Discount Amount,Extended Retail (before discount),Net Unit Price,Internet SKU,Purchaser,Order Number,Invoice Number,Card/Account Nickname\n' +
  '2026-09-26,1111,2281,0,,NBD-0042 Smith,1,C3 x 10 ft. Drip Edge Flashing,8,,BLDG. MATERIALS,,,$0.00,,$0.00,$61.44,$61.44,1,ZZ Buyer,,,\n' +
  '2026-06-24,2222,7001,0,,M18 8 Tool Combo,2,"M18 18V Cordless 8-Tool Combo Kit",1,,HARDWARE,,,$0.00,,$0.00,$619.00,$619.00,2,ZZ Buyer,,,\n' +
  '2026-05-09,1111,8001,0,,,3,Carpet cleaner rental 4 hr,1,,TOOL RENTAL,,,$0.00,,$0.00,$29.00,$29.00,3,ZZ Buyer,,,\n' +
  '2026-06-04,2222,7002,0,,4622 ASHGROVE AVE.,4,203 Roll Roofing Adhesive 4.75 gal.,2,,PAINT,,,$0.00,,$0.00,$240.00,$240.00,4,ZZ Buyer,,,\n';

const LEADS = [
  { id: 'L42', customerId: 'NBD-0042', firstName: 'Pat', lastName: 'Smith', address: '1 Oak St, Town' },
  { id: 'L52', customerId: 'NBD-0052', firstName: 'Rick', lastName: '', address: '4622 Ashgrove Ave, Town' },
  { id: 'L82', customerId: 'NBD-0082', firstName: 'Becca', lastName: 'Hill', address: '6365 Foxglove Ln, Town' },
  { id: 'L17', customerId: 'NBD-0017', firstName: 'Larry', lastName: '', address: '5 Hopewell Valley Dr' },
  { id: 'L90', customerId: 'NBD-0090', firstName: 'Scott', lastName: 'Steel', address: '9 Elm St' },
  { id: 'LX', customerId: 'NBD-0099', firstName: 'Old', lastName: 'Gone', address: '', deleted: true },
];

console.log('\n1. parsing Home Depot exports');
ok('Summary export is recognised', H.kindOf(SUMMARY) === 'summary');
ok('Details export is recognised', H.kindOf(DETAILS) === 'details');
ok('an unrelated CSV is not', H.kindOf('a,b,c\n1,2,3\n') === null);
const rec = H.parseSummary(SUMMARY);
ok('7 receipts, account preamble skipped', rec.length === 7, String(rec.length));
const smith = rec.find((r) => r.txn === '2281');
ok('money in cents; tax = total − pre-tax', smith.totalCents === 6623 && smith.pretaxCents === 6144 && smith.taxCents === 479);
ok('"$1,171.97" with a thousands comma parses', rec.find((r) => r.txn === '6003').totalCents === 117197);
ok('store number from "#1111, Test Town"', smith.store === '1111' && smith.storeName === 'Test Town');
ok('online order keyed by order number', rec.find((r) => r.order === 'WH00000001').key === 'hd-o-WH00000001');
ok('receipt keys are unique', new Set(rec.map((r) => r.key)).size === rec.length);

console.log('\n2. details join + categories');
const plan = H.plan(SUMMARY, DETAILS, LEADS, {}, []);
const by = (txn) => plan.find((r) => r.txn === txn);
ok('line items join to their receipt (store + date + transaction)', by('2281').items.length === 1 && /Drip Edge/.test(by('2281').items[0].desc));
ok('a power-tool buy in HARDWARE is Tools, not Materials', by('7001').category === 'tools_small_equipment', by('7001').category);
ok('a TOOL RENTAL department receipt is Equipment (a real rental)', by('8001').category === 'equipment_dumpster', by('8001').category);
ok('roof adhesive stays Materials', by('7002').category === 'materials');
ok('a tool word in the job name alone ("SCOTT TOOLS") is Tools', H.suggestCategory({ jobName: 'SCOTT TOOLS', departments: {}, items: [] }) === 'tools_small_equipment');
ok('a hand-tool accessory in Hardware is not called a rental', H.suggestCategory({ jobName: 'x', departments: { HARDWARE: 100 }, items: [{ desc: 'Impact bit set', cents: 100 }] }) !== 'equipment_dumpster');

console.log('\n3. job matching rules');
const m = (n, aliases) => H.matchJob(n, LEADS, aliases || {});
ok('rule 1: customer # in the job name → that job, exactly', m('NBD-0042 Smith').status === 'code' && m('NBD-0042 Smith').leadId === 'L42');
ok('rule 1: customer # anywhere, any case', m('smith nbd-0042').leadId === 'L42');
ok('rule 2: a remembered name → its job', m('LORA', { lora: 'L17' }).status === 'alias' && m('LORA', { lora: 'L17' }).leadId === 'L17');
ok('rule 3: SHOP → no job', m('SHOP').status === 'overhead' && m('SHOP').leadId === null);
ok('rule 3: a tool name anywhere → no job (not the lead named Scott)', m('SCOTT TOOLS').status === 'overhead');
ok('house number + street → that job', m('4622 ASHGROVE AVE.').leadId === 'L52' && m('4622 ASHGROVE AVE.').status === 'suggested');
ok('street name alone → that job', m('ashgrove ave').leadId === 'L52');
ok('subdivision / street word → that job', m('Foxglove').leadId === 'L82');
ok('a typo in the street ("Ashgrve"→ no; "Ashgro" → yes) matches on 4 letters', m('ashgro ave').leadId === 'L52');
ok('first name alone is only a suggestion', m('Larry').status === 'suggested' && m('Larry').leadId === 'L17');
ok('an unknown name → pick a job, never a guess', m('Lora').status === 'none' && m('Lora').leadId === null);
ok('blank job name → pick a job', m('').status === 'none');
ok('deleted leads never match', m('NBD-0099').status !== 'code');

console.log('\n4. re-import + the saved expense');
const again = H.plan(SUMMARY, DETAILS, LEADS, {}, plan.map((r) => r.key));
ok('a second import of the same file selects nothing', again.every((r) => r.already && !r.include));
const doc = H.expenseDoc(Object.assign({}, by('2281'), { leadId: 'L42' }), { uid: 'u1', companyId: 'c1' });
ok('expense amount is pre-tax, tax separate, whole cents', doc.amountCents === 6144 && doc.taxCents === 479 && Number.isInteger(doc.amountCents));
ok('provenance: source, externalRef, PO/job name, supplier', doc.source === 'import_homedepot' && doc.externalRef === by('2281').key && doc.poJobName === 'NBD-0042 Smith' && doc.supplier === 'Home Depot');
ok('job link and direct cost type', doc.leadId === 'L42' && doc.costType === 'direct' && doc.category === 'materials');
ok('the note lists what was bought', /Drip Edge/.test(doc.note));
ok('owner stamping matches the rules', doc.userId === 'u1' && doc.companyId === 'c1');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
