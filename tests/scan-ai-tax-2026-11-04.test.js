/**
 * tests/scan-ai-tax-2026-11-04.test.js — "Scan with AI" must not double-count sales tax.
 *
 * Every cost rollup counts amountCents + taxCents (expense-config signedCents,
 * expenses.js aggregate, profit-tracker, money-dashboard, job-cost-audit-logic,
 * month-close-logic). The Home Depot importer therefore stores PRE-TAX in Amount and
 * the tax in Tax (hd-import.js: amountCents = total - tax). Scan with AI used to put the
 * receipt GRAND TOTAL in Amount AND the tax in Tax, so a $107.00 receipt rolled up as $114.00.
 *
 * Drives the real expenses.js applyExtraction against a stub form, then feeds the field
 * values through the same dollars->cents step createExpense uses and the real aggregate().
 * Synthetic receipts only; nothing here calls the vision model.
 *
 * Run: node tests/scan-ai-tax-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name); } }
function eq(name, a, b) { ok(name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')', a === b); }

function load() {
  const els = {};
  const getEl = (id) => (els[id] = els[id] || { id, value: '', style: {}, textContent: '' });
  const win = { addEventListener() {}, removeEventListener() {}, confirm() { return true; }, open() {}, location: { pathname: '/pro/dashboard' } };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {}, focus() {} });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, removeEventListener() {}, getElementById: getEl, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return noop(); }, body: noop(), readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  for (const f of ['expense-config.js', 'profit-tracker.js', 'expenses.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', f), 'utf8'), sandbox, { filename: f });
  }
  return { win, getEl };
}

const { win, getEl } = load();
const EC = win.ExpenseConfig;
const EX = win.Expenses;

// What the Save button stores for the scanned form values (createExpense: dollarsToCents on each field).
function storedRow() {
  return {
    amountCents: EC.dollarsToCents(getEl('expAmount').value),
    taxCents: Math.max(0, EC.dollarsToCents(getEl('expTax').value) || 0),
    category: 'materials',
    supplier: 'Synthetic Supply',
  };
}
function resetForm() { ['expAmount', 'expTax', 'expSupplier', 'expDate', 'expCategory'].forEach((id) => { getEl(id).value = ''; }); }
function scan(extracted, extra) {
  resetForm();
  const d = Object.assign({ extracted, needsReview: false, reconcile: { matched: true } }, extra || {});
  EX._applyExtraction(d);
  return d;
}
const receipt = (o) => Object.assign({ vendor: 'Synthetic Supply', date: '2026-11-04', subtotalCents: 10000, taxCents: 700, totalCents: 10700, confidence: 0.95, suggestedCategory: 'materials' }, o);

console.log('\nthe synthetic receipt: subtotal 100.00, tax 7.00, total 107.00');
{
  scan(receipt());
  const row = storedRow();
  const rolled = EX.aggregate([row]).totalCents;
  eq('rollup counts exactly the receipt total (old behaviour: 11400)', rolled, 10700);
  eq('Amount field is the pre-tax 100.00', getEl('expAmount').value, '100.00');
  eq('Tax field is 7.00', getEl('expTax').value, '7.00');
  eq('same shape the Home Depot importer stores (amount = total - tax)', row.amountCents, 10700 - 700);
  eq('per-job cost (jobMargin cost input) counts 107.00', EX.aggregate([Object.assign({ leadId: 'L1' }, row)]).byJob.L1.cents, 10700);
  eq('shared signedCents (cards, exports) counts 107.00', EC.signedCents(row), 10700);
}

console.log('\nno tax on the receipt');
{
  scan(receipt({ subtotalCents: 5000, taxCents: 0, totalCents: 5000 }));
  eq('amount is the total, tax blank', getEl('expAmount').value + '|' + getEl('expTax').value, '50.00|');
  eq('rollup 50.00', EX.aggregate([storedRow()]).totalCents, 5000);
}

console.log('\nreceipt with no subtotal line (total + tax only)');
{
  scan(receipt({ subtotalCents: null }));
  eq('rollup still the receipt total', EX.aggregate([storedRow()]).totalCents, 10700);
}

console.log('\nreconcile: reader got the numbers wrong -> flagged, not silently saved');
{
  const d = scan(receipt({ subtotalCents: 10000, taxCents: 700, totalCents: 11000 }));
  ok('needsReview forced on when subtotal + tax != total', d.needsReview === true);
  ok('status tells the user subtotal + tax does not match', /subtotal.*tax.*total/i.test(getEl('expScanStatus').textContent));
  eq('status is the warning kind', getEl('expScanStatus').style.color.indexOf('eab308') !== -1, true);
}
{
  const d = scan(receipt({ subtotalCents: 10000, taxCents: 700, totalCents: 10701 }));
  ok('1 cent of rounding is tolerated, not flagged', d.needsReview === false);
}
{
  const d = scan(receipt({ subtotalCents: null, taxCents: 700, totalCents: 10700 }));
  ok('no subtotal to check -> not flagged by this check', d.needsReview === false);
}

console.log('\nnonsense the reader can return: tax >= total');
{
  const d = scan(receipt({ subtotalCents: null, taxCents: 900, totalCents: 500 }));
  ok('flagged for review', d.needsReview === true);
  eq('never stores a negative or zero Amount; total kept, tax left blank', getEl('expAmount').value + '|' + getEl('expTax').value, '5.00|');
  eq('rollup is the receipt total, not total + tax', EX.aggregate([storedRow()]).totalCents, 500);
}

console.log('\ntotal unreadable');
{
  const d = scan(receipt({ totalCents: null, subtotalCents: 10000, taxCents: 700 }), { needsReview: true });
  eq('falls back to subtotal as Amount, tax in Tax (sum is the real total)', EX.aggregate([storedRow()]).totalCents, 10700);
  ok('stays flagged', d.needsReview === true);
}

console.log('\nmanual entry is unchanged: whatever the user types is stored as typed');
{
  resetForm();
  getEl('expAmount').value = '107.00';
  getEl('expTax').value = '7.00';
  const row = storedRow();
  eq('typed amount and tax are stored verbatim (no auto-subtraction on save)', row.amountCents + '|' + row.taxCents, '10700|700');
}

console.log('\nexisting saved rows are read exactly as before (historical data untouched)');
{
  eq('a legacy scanned row (amount = total, tax = tax) still reads as amount + tax', EC.signedCents({ amountCents: 10700, taxCents: 700 }), 11400);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
