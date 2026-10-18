/**
 * tests/lowes-import-2026-10-18.test.js
 *
 * docs/pro/js/lowes-import.js — Lowe's Pro purchase import. Drives the real
 * module (with the real hd-import.js matcher) against a SYNTHETIC export that
 * has Lowe's real column headers, the "multiple*:" legend line at the bottom,
 * and email / phone / card columns filled with obviously fake values (the repo
 * is public: no real purchase, name, phone or card is in this file).
 *
 * Pins: parsing (date format, $ amounts, tax vs total, "#" order numbers),
 * N/A fields, the legend line is not an order, cancelled/returned orders are
 * skipped, the stable key (a second import selects nothing), the same
 * matching rules as the Home Depot import, and PRIVACY: purchaser email,
 * phone and card digits never reach the expense document.
 *
 * Run: node tests/lowes-import-2026-10-18.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

function boot(flagOn) {
  const win = { addEventListener() {}, NBDFlags: { enabled: (n) => !!flagOn && n === 'lowesImport' } };
  win.window = win;
  const ctx = { window: win, document: { addEventListener() {} }, console };
  vm.createContext(ctx);
  ['hd-import.js', 'lowes-import.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', f), 'utf8'), ctx));
  return win;
}
const win = boot(true);
const LW = win.NBDLowesImport;

const HEAD = 'Date,Purchased From,Fulfillment Type,Fulfillment Store #,Fulfillment Store Location,Fulfillment Status,PO Number,Project Name,Group Name,Purchaser Name,Purchaser Email,Purchaser Phone Number,Order # / Trans.,Invoice Number,Tax,Order Total,CC Type,CC# (last 4),Loyalty Rewards Earned,Order Ref\n';
const row = (o) => [o.date, 'In-Store', 'Carry With', o.store, o.loc, o.status || 'Sold', o.po, o.proj || 'N/A', 'N/A', 'N/A', 'fake.person@example.test', '5550100123', o.order, '11111', o.tax, o.total, 'DEBITVISA', '************4242', '10 Points', 'N/A'].join(',') + '\n';
const CSV = HEAD
  + row({ date: '14-Oct-2026', store: '1111', loc: 'Test Town Lowe\'s', po: 'NBD-0042 Smith', order: '#900000001', tax: '$3.70', total: '$54.69' })
  + row({ date: '12-Oct-2026', store: '1111', loc: 'Test Town Lowe\'s', po: 'Lora', order: '#900000002', tax: '$8.51', total: '$125.87' })
  + row({ date: '9-Oct-2026', store: '2222', loc: 'Other Lowe\'s', po: 'N/A', proj: 'Elm St', order: '#900000003', tax: '$8.37', total: '$132.33' })
  + row({ date: '9-Oct-2026', store: '2222', loc: 'Other Lowe\'s', po: 'SHOP', order: '#900000004', tax: '$1.28', total: '$20.28' })
  + row({ date: '8-Oct-2026', store: '2222', loc: 'Other Lowe\'s', po: 'NBD-0042 Smith', order: '#900000005', tax: '$0.00', total: '$40.00', status: 'Cancelled' })
  + row({ date: '7-Oct-2026', store: '2222', loc: 'Other Lowe\'s', po: 'Bob', order: '#900000001', tax: '$3.70', total: '$54.69' })
  + '\nmultiple*: indicates more than one value present for the field\n';

const LEADS = [
  { id: 'L1', customerId: 'NBD-0042', firstName: 'Pat', lastName: 'Smith', address: '1 Ash St, Town, OH' },
  { id: 'L2', customerId: 'NBD-0043', firstName: 'Lora', lastName: 'Mueller', address: '2 Birch Ln, Town, OH' },
  { id: 'L3', customerId: 'NBD-0044', firstName: 'Dee', lastName: 'Jones', address: '12 Elm St, Town, OH' },
];

console.log('\n1. parsing');
ok('a Lowe\'s export is recognised; an unrelated CSV is not', LW.kindOf(CSV) === 'lowes' && LW.kindOf('a,b\n1,2\n') === null);
const orders = LW.parseOrders(CSV);
ok('four real orders: the legend line, the cancelled order and the repeated order are not extra', orders.length === 4, String(orders.length));
const o1 = orders.find((o) => o.order === '900000001');
ok('"14-Oct-2026" becomes 2026-10-14', o1.date === '2026-10-14' && LW.ymd('9-Oct-2026') === '2026-10-09');
ok('money in whole cents; pre-tax = total − tax', o1.totalCents === 5469 && o1.taxCents === 370 && o1.pretaxCents === 5099);
ok('store number and name are captured', o1.store === '1111' && /Test Town/.test(o1.storeName));
ok('the order number is stripped of its "#" and is the key', o1.key === 'lw-o-900000001');
ok('"N/A" PO falls back to the Project Name', orders.find((o) => o.order === '900000003').jobName === 'Elm St');
ok('a cancelled order is never imported', !orders.some((o) => o.order === '900000005'));
ok('the same order twice is one purchase (first row wins)', orders.filter((o) => o.order === '900000001').length === 1 && o1.jobName === 'NBD-0042 Smith');

console.log('\n2. matching (the Home Depot importer\'s rules)');
const rows = LW.plan(CSV, LEADS, {}, []);
const by = (n) => rows.find((r) => r.order === n);
ok('a customer number matches exactly', by('900000001').match.status === 'code' && by('900000001').leadId === 'L1');
ok('a first name alone is only a suggestion', by('900000002').match.status === 'suggested' && by('900000002').leadId === 'L2');
ok('a street name in Project Name is a suggestion', by('900000003').leadId === 'L3' && by('900000003').match.status === 'suggested');
ok('a shop word is overhead, no job', by('900000004').match.status === 'overhead' && by('900000004').leadId === null);
const again = LW.plan(CSV, LEADS, {}, rows.map((r) => r.key));
ok('a second import of the same file selects nothing', again.every((r) => r.already && !r.include));

console.log('\n3. the saved expense');
const doc = LW.expenseDoc(Object.assign({}, by('900000001')), { uid: 'u1', companyId: 'c1' });
ok('supplier, source, externalRef, store, order, PO name', doc.supplier === 'Lowe\'s' && doc.source === 'import_lowes' && doc.externalRef === 'lw-o-900000001' && doc.storeNumber === '1111' && doc.orderNumber === '900000001' && doc.poJobName === 'NBD-0042 Smith');
ok('amount is pre-tax, tax separate, whole cents', doc.amountCents === 5099 && doc.taxCents === 370 && Number.isInteger(doc.amountCents));
ok('a matched order is assigned; an unmatched one is unsorted; shop is overhead', doc.reviewState === 'assigned'
  && LW.reviewStateOf({ leadId: null, category: 'materials', match: { status: 'none' } }) === 'unsorted'
  && LW.reviewStateOf(by('900000004')) === 'overhead');
const json = JSON.stringify(doc) + JSON.stringify(rows);
ok('PRIVACY: purchaser email, phone and card digits never reach the receipt or the expense', !/fake\.person|5550100123|4242|example\.test/.test(json));
ok('owner stamping matches the rules', doc.userId === 'u1' && doc.companyId === 'c1' && doc.itemCount === 0 && Array.isArray(doc.items) && doc.items.length === 0);

console.log('\n4. flag');
ok('flag off: no button, not enabled', boot(false).NBDLowesImport.buttonHtml() === '' && boot(false).NBDLowesImport.enabled() === false);
ok('flag on: the button renders', /data-lw-action="open"/.test(LW.buttonHtml()));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
