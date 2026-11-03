/**
 * tests/cost-credits-2026-11-03.test.js — credits / refunds / returns / adjustments on the
 * cost ledger (flag `costCredits`, ships dark). Append-only: a credit is its OWN dated row,
 * amounts stay POSITIVE, and every total that sums expenses nets credits instead of adding them.
 *
 * Fake sample data only (no real customers, vendors or amounts).
 * Run: node tests/cost-credits-2026-11-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

const ROOT = path.join(__dirname, '..');
const JS = (f) => path.join(ROOT, 'docs/pro/js', f);

// ── browser-IIFE sandbox shared by expense-config / profit-tracker / expenses ──
let csvOut = null;
function makeWin() {
  const win = { addEventListener() {}, removeEventListener() {}, confirm() { return true; }, open() {}, location: { pathname: '/pro/dashboard' } };
  win.window = win;
  return win;
}
function loadInto(win, file) {
  const el = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, click() {}, classList: { add() {}, remove() {} }, dataset: {}, focus() {} });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return el(); }, body: el(), readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} },
    Blob: function (parts) { csvOut = parts[0]; },
    URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
    setTimeout, clearTimeout, setInterval() { return 0; }, clearInterval() {}, Date, Math, JSON,
  };
  vm.runInNewContext(fs.readFileSync(JS(file), 'utf8'), sandbox, { filename: file });
  return win;
}
const win = makeWin();
loadInto(win, 'expense-config.js');
loadInto(win, 'profit-tracker.js');
loadInto(win, 'expenses.js');
const EC = win.ExpenseConfig, EX = win.Expenses, PT = win.ProfitTracker;

const FLAG = 'costCredits';
const setFlag = (on) => { win.NBDFlags = { enabled: (n) => !!on && n === FLAG }; };
const toasts = [];
win.showToast = (m) => toasts.push(m);
const writes = [];
win.collection = (db, name) => ({ name });
win.addDoc = async (col, data) => { writes.push({ col: col.name, data }); return { id: 'new' + writes.length }; };
win.serverTimestamp = () => 'ts';
win.db = {};
win._user = { uid: 'u1' };
win._userClaims = { companyId: 'co1' };

const cost = (o) => Object.assign({ id: 'c' + Math.random(), amountCents: 10000, taxCents: 0, category: 'materials', costType: 'direct', supplier: 'ABC Supply', leadId: 'L1', date: new Date(2026, 9, 5) }, o || {});
const credit = (o) => cost(Object.assign({ entryType: 'credit' }, o || {}));

(async function main() {
  // ══ 1. expense-config helpers ══
  console.log('ENTRY TYPE — expense-config helpers');
  eq('absent entryType is a cost', EC.entryTypeOf({ amountCents: 5 }), 'cost');
  eq('credit is a credit', EC.entryTypeOf({ entryType: 'credit' }), 'credit');
  eq('adjustment is an adjustment', EC.entryTypeOf({ entryType: 'adjustment' }), 'adjustment');
  eq('an unknown value is read as a cost (rules refuse it anyway)', EC.entryTypeOf({ entryType: 'refunded' }), 'cost');
  eq('signedCents: cost adds amount + tax', EC.signedCents({ amountCents: 10000, taxCents: 700 }), 10700);
  eq('signedCents: credit SUBTRACTS amount + tax', EC.signedCents({ entryType: 'credit', amountCents: 10000, taxCents: 700 }), -10700);
  eq('signedCents: adjustment adds', EC.signedCents({ entryType: 'adjustment', amountCents: 2500 }), 2500);
  eq('signedCents(withTax=false) is pre-tax', EC.signedCents({ entryType: 'credit', amountCents: 10000, taxCents: 700 }, false), -10000);
  eq('entryTypeKey accepts words people use', [EC.entryTypeKey('Credit'), EC.entryTypeKey('refund'), EC.entryTypeKey('Adjustment'), EC.entryTypeKey('COST')].join(','), 'credit,credit,adjustment,cost');
  eq('entryTypeKey rejects junk', EC.entryTypeKey('free money'), '');

  // ══ 2. aggregate (spend by supplier / category / job, direct vs overhead) ══
  console.log('\nAGGREGATE — credits net out; never silently negative');
  const plain = EX.aggregate([cost(), cost({ amountCents: 5000, category: 'disposal' })]);
  eq('no credits: total unchanged ($150)', plain.totalCents, 15000);
  ok('no credits: no credit fields lit up', plain.creditsCents === 0 && plain.creditCount === 0 && plain.creditsExceed === false);
  const ag = EX.aggregate([
    cost({ amountCents: 200000 }),                         // $2,000 ABC materials, job L1
    cost({ amountCents: 50000, category: 'disposal' }),    // $500 disposal, job L1
    credit({ amountCents: 101784 }),                        // $1,017.84 ABC credit memo, job L1
    cost({ amountCents: 30000, category: 'insurance', costType: 'overhead', supplier: 'Sample Insurance', leadId: null })
  ]);
  eq('total spend nets the credit ($2,000 + $500 + $300 - $1,017.84)', ag.totalCents, 200000 + 50000 + 30000 - 101784);
  eq('direct nets the credit', ag.directCents, 200000 + 50000 - 101784);
  eq('overhead untouched by a direct credit', ag.overheadCents, 30000);
  eq('credits total is reported (positive)', ag.creditsCents, 101784);
  eq('credit count', ag.creditCount, 1);
  const abc = ag.suppliers.find((s) => /abc/i.test(s.supplier));
  eq('supplier row is net of the credit (ABC: $2,000 + $500 disposal - $1,017.84)', abc.cents, 200000 + 50000 - 101784);
  eq('supplier row says how much credit is inside', abc.creditsCents, 101784);
  eq('category row (materials) is net', ag.categories.find((c) => c.category === 'materials').cents, 200000 - 101784);
  eq('job row is net', ag.byJob.L1.cents, 200000 + 50000 - 101784);
  eq('job direct is net', ag.byJob.L1.directCents, 200000 + 50000 - 101784);
  ok('credits smaller than costs: nothing flagged', ag.creditsExceed === false && ag.byJob.L1.creditsExceed === false && abc.creditsExceed === false);
  // credit with tax is returned with its tax
  eq('a credit returns its sales tax too', EX.aggregate([cost({ amountCents: 10000, taxCents: 700 }), credit({ amountCents: 10000, taxCents: 700 })]).totalCents, 0);

  const over = EX.aggregate([cost({ amountCents: 40000 }), credit({ amountCents: 90000 })]);
  eq('credits bigger than costs: the figure goes NEGATIVE (not clamped to $0)', over.totalCents, -50000);
  ok('credits bigger than costs: flagged at ledger, supplier, category and job level',
    over.creditsExceed === true && over.suppliers[0].creditsExceed === true && over.categories[0].creditsExceed === true && over.byJob.L1.creditsExceed === true && over.byJob.L1.directCreditsExceed === true);
  const overOne = EX.aggregate([cost({ amountCents: 40000 }), credit({ amountCents: 90000 }), cost({ amountCents: 80000, category: 'disposal', supplier: 'Dump Co' })]);
  ok('only the over-credited category is flagged, not the others',
    overOne.categories.find((c) => c.category === 'materials').creditsExceed === true && overOne.categories.find((c) => c.category === 'disposal').creditsExceed === false);

  console.log('\nAGGREGATE — adjustment ADDS');
  eq('an adjustment adds to spend', EX.aggregate([cost({ amountCents: 10000 }), cost({ entryType: 'adjustment', amountCents: 2500 })]).totalCents, 12500);

  // ══ 3. 1099 subcontractor totals ══
  console.log('\n1099 — subcontractor YTD nets a refund from the sub');
  const sub = (o) => cost(Object.assign({ category: 'subcontractor', supplier: 'Sample Crew LLC', date: new Date(2026, 3, 10) }, o || {}));
  eq('YTD without credit', EX.supplierYtdCents('Sample Crew', 2026, [sub({ amountCents: 300000 })]), 300000);
  eq('YTD nets the credit (pre-tax)', EX.supplierYtdCents('Sample Crew', 2026, [sub({ amountCents: 300000 }), sub({ entryType: 'credit', amountCents: 120000, taxCents: 999 })]), 180000);
  const crewSup = { displayName: 'Sample Crew', taxClassification: 'individual', w9Status: 'received' };
  ok('a sub over the $2,000 threshold is on the 1099 list', EX.needs1099(crewSup, 2026, [sub({ amountCents: 250000 })]) === true);
  ok('a refund from that sub takes it back under the threshold (off the 1099 list)', EX.needs1099(crewSup, 2026, [sub({ amountCents: 250000 }), sub({ entryType: 'credit', amountCents: 100000 })]) === false);

  // ══ 4. lead spend (marketing) ══
  console.log('\nLEAD SPEND — marketing credit nets');
  win._leads = [];
  EX._setData([cost({ category: 'marketing', costType: 'overhead', amountCents: 50000, leadId: null }), credit({ category: 'marketing', costType: 'overhead', amountCents: 20000, leadId: null })]);
  eq('marketing spend nets a marketing credit', EX.leadSpendSummary().marketingCents, 30000);

  // ══ 5. margin engine ══
  console.log('\nMARGIN — computeJobPLWithExpenses nets credits');
  const lead = { id: 'L1', jobValue: 10000, overheadPct: 10 };
  const m0 = PT.computeJobPLWithExpenses(lead, [{ amountCents: 400000, category: 'materials', costType: 'direct' }]);
  eq('no credit: 60% gross margin as before', m0.grossMargin, 60);
  ok('no credit: result has no credit fields', !('creditsCents' in m0) && !('creditsExceedCosts' in m0));
  const m1 = PT.computeJobPLWithExpenses(lead, [{ amountCents: 400000, category: 'materials', costType: 'direct' }, { entryType: 'credit', amountCents: 100000, category: 'materials', costType: 'direct' }]);
  eq('$1,000 credit lifts the margin (cost $3,000 -> 70%)', m1.grossMargin, 70);
  eq('credit amount is reported', m1.creditsCents, 100000);
  ok('credit smaller than costs: not flagged', m1.creditsExceedCosts === false);
  const m2 = PT.computeJobPLWithExpenses(lead, [{ amountCents: 100000, category: 'materials', costType: 'direct' }, { entryType: 'credit', amountCents: 150000, category: 'materials', costType: 'direct' }]);
  eq('credit bigger than costs: material cost is NEGATIVE, not zero', m2.materialCost, -500);
  ok('credit bigger than costs: flagged with the bucket', m2.creditsExceedCosts === true && m2.creditsExceedBuckets.join() === 'materials');
  const m3 = PT.computeJobPLWithExpenses(lead, [{ entryType: 'credit', amountCents: 50000, category: 'materials', costType: 'direct' }]);
  ok('a lone credit is never relabelled "no costs entered"', !m3.noCosts && m3.creditsExceedCosts === true);
  const m4 = PT.computeJobPLWithExpenses(lead, [{ amountCents: 100000, category: 'materials', costType: 'direct' }, { entryType: 'credit', amountCents: 5000, category: 'insurance', costType: 'overhead' }]);
  eq('an overhead credit does not touch a job margin', m4.materialCost, 1000);
  eq('an adjustment adds to job cost', PT.computeJobPLWithExpenses(lead, [{ amountCents: 100000, category: 'materials', costType: 'direct' }, { entryType: 'adjustment', amountCents: 20000, category: 'materials', costType: 'direct' }]).materialCost, 1200);

  // ══ 6. createExpense: form path ══
  console.log('\nCREATE — flag OFF: nothing changes');
  setFlag(false);
  writes.length = 0;
  EX._setData([]);
  const offCredit = await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', entryType: 'credit' });
  ok('flag off: a credit is REFUSED (no write)', offCredit === false && writes.length === 0);
  const offCost = await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials' });
  ok('flag off: a normal cost saves exactly as before', offCost === true && writes.length === 1);
  ok('flag off: the saved doc has NO entryType / related / creditRef / reason keys',
    !('entryType' in writes[0].data) && !('relatedExpenseId' in writes[0].data) && !('creditRef' in writes[0].data) && !('reason' in writes[0].data));

  console.log('\nCREATE — flag ON');
  setFlag(true);
  EX._setData([{ id: 'orig1', supplier: 'Sample Supply', amountCents: 5000, taxCents: 0, category: 'materials', date: new Date(2026, 9, 29) }]);
  writes.length = 0;
  const cr = await EX.createExpense({ amount: '1017.84', date: '2026-11-02', supplier: 'ABC Supply', category: 'materials', leadId: 'L1', entryType: 'credit', creditRef: ' CM-90001 ', reason: ' returned 12 bundles ', relatedExpenseId: 'orig1' });
  ok('credit saves', cr === true && writes.length === 1);
  const d = writes[0] && writes[0].data;
  ok('credit doc keeps the amount POSITIVE', d && d.amountCents === 101784);
  ok('credit doc carries entryType, trimmed creditRef + reason, relatedExpenseId', d && d.entryType === 'credit' && d.creditRef === 'CM-90001' && d.reason === 'returned 12 bundles' && d.relatedExpenseId === 'orig1');
  ok('credit is its own new row (addDoc, never an update of the original)', writes.length === 1 && writes[0].col === 'expenses');
  writes.length = 0;
  ok('credit with a related id that is not in the ledger is refused', (await EX.createExpense({ amount: '5', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'credit', relatedExpenseId: 'nope' })) === false && writes.length === 0);
  ok('credit with a 129-char related id is refused', (await EX.createExpense({ amount: '5', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'credit', relatedExpenseId: 'a'.repeat(129) })) === false && writes.length === 0);
  ok('credit memo number over 80 chars refused', (await EX.createExpense({ amount: '5', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'credit', creditRef: 'a'.repeat(81) })) === false && writes.length === 0);
  ok('a zero / negative credit amount is refused (amounts stay positive)', (await EX.createExpense({ amount: '-5', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'credit' })) === false && (await EX.createExpense({ amount: '0', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'credit' })) === false && writes.length === 0);
  ok('mileage cannot be a credit', (await EX.createExpense({ amount: '5', miles: '10', date: '2026-11-02', category: 'mileage', entryType: 'credit' })) === false && writes.length === 0);
  ok('an unknown entry type word is read as a plain cost, never as a guess', (await EX.createExpense({ amount: '5', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'weird' })) === true && !('entryType' in writes[0].data));
  writes.length = 0;
  ok('adjustment saves with its type', (await EX.createExpense({ amount: '25', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'adjustment' })) === true && writes[0].data.entryType === 'adjustment' && writes[0].data.amountCents === 2500);
  writes.length = 0;
  ok('a plain cost with the flag on still writes no entryType key', (await EX.createExpense({ amount: '25', date: '2026-11-02', supplier: 'x', category: 'materials' })) === true && !('entryType' in writes[0].data));

  console.log('\nCREATE — paidFrom: required for a cost, not for a credit (flags costsPaidFrom + costCredits)');
  win.NBDFlags = { enabled: () => true };
  writes.length = 0;
  ok('paidFrom flag on: a cost without paidFrom is still refused', (await EX.createExpense({ amount: '5', date: '2026-11-02', supplier: 'x', category: 'materials' })) === false && writes.length === 0);
  ok('paidFrom flag on: a credit needs no paidFrom', (await EX.createExpense({ amount: '5', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'credit' })) === true && writes.length === 1 && !('paidFrom' in writes[0].data));
  setFlag(true);

  console.log('\nDUPLICATES — a refund is not a duplicate of the charge');
  EX._setData([{ id: 'o2', supplier: 'ABC Supply', amountCents: 101784, taxCents: 0, category: 'materials', date: new Date(2026, 10, 2, 12) }]);
  ok('same vendor/amount/day cost IS a duplicate', EX.findDuplicate('ABC Supply', 101784, '2026-11-02') !== null);
  ok('same vendor/amount/day CREDIT is not flagged as a duplicate of the cost', EX.findDuplicate('ABC Supply', 101784, '2026-11-02', 'credit') === null);

  // ══ 7. CSV import ══
  console.log('\nCSV IMPORT — entryType column');
  const leads = [{ id: 'lead-001', name: 'Sample Homeowner' }, { id: 'lead-002', name: 'Pat Example' }];
  const HEAD = 'job,vendor,date,amount,category,paidFrom,receiptUrl,note,entryType,creditRef,reason,relatedExpenseId\n';
  EX._setData([{ id: 'orig1', supplier: 'Sample Supply', amountCents: 5000, taxCents: 0, category: 'materials', date: new Date(2026, 9, 29) }]);
  const exists = (id) => id === 'orig1';
  const csv = HEAD + [
    'lead-001,ABC Supply,2026-11-02,1017.84,materials,,,memo,credit,CM-1,returned bundles,orig1',     // 0 credit ok
    'lead-001,ABC Supply,2026-11-02,50.00,materials,cash,,,,,,',                                       // 1 blank type = cost
    'lead-001,ABC Supply,2026-11-02,-1017.84,materials,,,,credit,,,',                                  // 2 negative amount refused
    'lead-001,ABC Supply,2026-11-02,0,materials,,,,credit,,,',                                          // 3 zero refused
    'lead-001,ABC Supply,2026-11-02,10,materials,,,,refundish,,,',                                      // 4 bad type
    'lead-001,ABC Supply,2026-11-02,10,materials,,,,cost,,,',                                           // 5 cost with no paidFrom: refused
    'lead-001,ABC Supply,2026-11-02,10,materials,,,,credit,,,nope',                                     // 6 related not found
    'lead-001,ABC Supply,2026-11-02,10,materials,cash,,,cost,,,orig1',                                  // 7 related on a cost
    'lead-001,ABC Supply,2026-11-03,25,materials,,,,adjustment,,fee missed,',                           // 8 adjustment ok
    'lead-001,ABC Supply,2026-11-02,1017.84,materials,,,,credit,CM-1,,'                                 // 9 same credit again in file
  ].join('\n');
  setFlag(true);
  const pv = EX.buildImportPreview(csv, leads, EX.findDuplicate, exists);
  ok('preview parses (no top-level error, 10 rows)', !pv.error && pv.rows.length === 10);
  const R = (i) => pv.rows[i];
  const why = (i) => R(i).reasons.join(' | ');
  ok('credit row is ok and shows its type', R(0).status === 'ok' && R(0).entryType === 'credit' && R(0).draft.entryType === 'credit' && R(0).cents === 101784);
  ok('credit draft carries creditRef / reason / related id, amount positive', R(0).draft.creditRef === 'CM-1' && R(0).draft.reason === 'returned bundles' && R(0).draft.relatedExpenseId === 'orig1' && R(0).draft.amount === '1017.84');
  ok('a credit does not need paidFrom', R(0).draft.paidFrom === '');
  ok('blank entryType is a cost', R(1).status === 'ok' && R(1).entryType === 'cost' && R(1).draft.entryType === 'cost');
  ok('a NEGATIVE amount is still rejected, and the message points at entryType', R(2).status === 'rejected' && /Bad amount/.test(why(2)) && /entryType/.test(why(2)) && R(2).draft === null);
  ok('a ZERO amount is still rejected', R(3).status === 'rejected' && /Bad amount/.test(why(3)));
  ok('an unknown entryType is rejected, never guessed', R(4).status === 'rejected' && /Bad entryType/.test(why(4)));
  ok('a COST row still needs paidFrom', R(5).status === 'rejected' && /Bad paidFrom/.test(why(5)));
  ok('relatedExpenseId that is not in the ledger is rejected', R(6).status === 'rejected' && /not found/.test(why(6)));
  ok('relatedExpenseId on a plain cost is rejected', R(7).status === 'rejected' && /only applies to a credit/.test(why(7)));
  ok('adjustment row is ok', R(8).status === 'ok' && R(8).entryType === 'adjustment');
  ok('a repeated credit in the same file is flagged duplicate', R(9).status === 'duplicate' && /row 2 in this file/.test(why(9)));
  const sameDay = HEAD + 'lead-001,ABC Supply,2026-11-02,1017.84,materials,,,,credit,,,\n';
  EX._setData([{ id: 'o3', supplier: 'ABC Supply', amountCents: 101784, taxCents: 0, category: 'materials', date: new Date(2026, 10, 2, 12) }]);
  ok('import: a credit matching a COST of the same amount/day is NOT a duplicate', EX.buildImportPreview(sameDay, leads, EX.findDuplicate, exists).rows[0].status === 'ok');
  const sameCostCsv = HEAD + 'lead-001,ABC Supply,2026-11-02,1017.84,materials,cash,,,,,,\n';
  ok('import: the same COST on the same day still IS a duplicate', EX.buildImportPreview(sameCostCsv, leads, EX.findDuplicate, exists).rows[0].status === 'duplicate');

  console.log('\nCSV IMPORT — flag OFF rejects credits (never reads one as a cost)');
  setFlag(false);
  const offPv = EX.buildImportPreview(HEAD + 'lead-001,ABC Supply,2026-11-02,10,materials,cash,,,credit,,,\nlead-001,ABC Supply,2026-11-02,11,materials,cash,,,,,,\n', leads, EX.findDuplicate, exists);
  ok('flag off: a credit row is rejected with a clear reason, no draft', offPv.rows[0].status === 'rejected' && /not turned on/.test(offPv.rows[0].reasons.join(' ')) && offPv.rows[0].draft === null);
  ok('flag off: a plain cost row imports as before', offPv.rows[1].status === 'ok' && offPv.rows[1].entryType === 'cost');
  const legacy = EX.buildImportPreview('job,vendor,date,amount,category,paidFrom,receiptUrl,note\nlead-001,ABC Supply,2026-11-02,10,materials,cash,,\n', leads, EX.findDuplicate);
  ok('a file with the OLD columns (no entryType) works unchanged', legacy.rows[0].status === 'ok' && legacy.rows[0].entryType === 'cost');

  console.log('\nCSV IMPORT — per-row approve is untouched');
  const src = fs.readFileSync(JS('expenses.js'), 'utf8');
  ok('no approve-all control', !/imp-approve-all|approveAll/i.test(src));
  ok('write loop only takes rows decided as approved', /_imp\.decision\[k\] === 'approved'/.test(src));
  ok('preview table has a Type column', /'Row', 'Job', 'Type'/.test(src));

  // ══ 8. CSV export ══
  console.log('\nCSV EXPORT — Entry Type / Related columns behind the flag, signed amounts');
  const expRows = [cost({ id: 'x1', amountCents: 20000, taxCents: 1400 }), credit({ id: 'x2', amountCents: 101784, taxCents: 0, relatedExpenseId: 'x1', creditRef: 'CM-9', reason: 'return' })];
  EX._setData(expRows);
  setFlag(false);
  csvOut = null; EX.exportCSV();
  const offHeader = csvOut.split('\n')[0];
  ok('flag off: header has NO Entry Type / Related columns', !/Entry Type|Related/.test(offHeader));
  setFlag(true);
  csvOut = null; EX.exportCSV();
  const lines = csvOut.split('\n');
  ok('flag on: header gets Entry Type, Related, Credit Ref, Reason', /,Entry Type,Related,Credit Ref,Reason$/.test(lines[0]));
  const col = (line, name) => { const h = lines[0].split(','); return line.split(',')[h.indexOf(name)]; };
  const costLine = lines.find((l) => /x1/.test(l) === false && /,200.00,/.test(l));
  const credLine = lines.find((l) => /-1017.84/.test(l));
  ok('a cost exports as Cost with a positive amount', costLine && col(costLine, 'Entry Type') === 'Cost' && col(costLine, 'Amount') === '200.00');
  ok('a credit exports SIGNED (negative) so a SUM is right, and keeps the quote-free number', credLine && col(credLine, 'Amount') === '-1017.84' && col(credLine, 'Entry Type') === 'Credit / refund' && col(credLine, 'Related') === 'x1' && col(credLine, 'Credit Ref') === 'CM-9');
  eq('csvCell keeps a plain negative number numeric', EX.csvCell('-1017.84'), '-1017.84');
  eq('csvCell still neutralises a formula that starts with -', EX.csvCell('-1+2'), "'-1+2");
  eq('csvCell still neutralises =', EX.csvCell('=1+1'), "'=1+1");

  // ══ 9. other ledger readers ══
  console.log('\nOTHER READERS — every place that sums expenses nets credits');
  // money dashboard
  {
    const w2 = makeWin();
    const doc = { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
    const ctx = vm.createContext({ window: w2, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON });
    vm.runInContext(fs.readFileSync(JS('ky-insurance-law.js'), 'utf8'), ctx, { filename: 'ky-insurance-law.js' });
    vm.runInContext(fs.readFileSync(JS('money-dashboard.js'), 'utf8'), ctx, { filename: 'money-dashboard.js' });
    const MD = w2.MoneyDashboard;
    const base = { year: 2026, leads: [{ id: 'L1', _stageKey: 'closed', jobValue: 20000 }], invoices: [], suppliers: [{ displayName: 'Crew Co', is1099Eligible: true, w9Status: 'received' }] };
    const E = (o) => Object.assign({ category: 'materials', costType: 'direct', amountCents: 500000, taxCents: 0, leadId: 'L1', supplier: 'ABC', date: new Date(2026, 1, 1) }, o || {});
    const none = MD.computePnL(Object.assign({}, base, { expenses: [E()] }));
    const withCr = MD.computePnL(Object.assign({}, base, { expenses: [E(), E({ entryType: 'credit', amountCents: 100000, taxCents: 7000 })] }));
    eq('Money: spent nets a credit incl. tax', withCr.spentCents, none.spentCents - 107000);
    eq('Money: COGS nets the credit', withCr.cogsCents, none.cogsCents - 107000);
    eq('Money: job direct cost nets (margin)', withCr.wonDirectCents, none.wonDirectCents - 107000);
    eq('Money: top supplier row nets', withCr.topSuppliers[0].cents, none.topSuppliers[0].cents - 107000);
    eq('Money: credits reported', withCr.creditsCents, 107000);
    ok('Money: no credits -> nothing flagged', none.creditsCents === 0 && none.creditsExceed === false);
    const big = MD.computePnL(Object.assign({}, base, { expenses: [E({ amountCents: 1000 }), E({ entryType: 'credit', amountCents: 5000 })] }));
    ok('Money: credits bigger than costs -> negative COGS, flagged (not clamped)', big.cogsCents === -4000 && big.creditsExceed === true);
    const crew = (o) => E(Object.assign({ category: 'subcontractor', supplier: 'Crew Co', leadId: null }, o || {}));
    eq('Money: 1099 due when YTD service >= threshold', MD.computePnL(Object.assign({}, base, { expenses: [crew({ amountCents: 250000 })] })).due1099, 1);
    eq('Money: a refund from the sub drops it under the threshold (no 1099)', MD.computePnL(Object.assign({}, base, { expenses: [crew({ amountCents: 250000 }), crew({ entryType: 'credit', amountCents: 100000 })] })).due1099, 0);
    if (MD.monthClose) {
      const mc = (exps) => MD.monthClose({ invoices: [], expenses: exps }, new Date(2026, 10, 10));
      const oct = (o) => Object.assign({ category: 'materials', costType: 'direct', amountCents: 100000, taxCents: 0, leadId: 'L1', supplier: 'ABC', date: new Date(2026, 9, 10) }, o || {});
      eq('Money month close: nets a credit', mc([oct(), oct({ entryType: 'credit', amountCents: 30000 })]).expensesCents, 70000);
    }
  }
  // month-close-logic
  {
    const MC = require(JS('month-close-logic.js'));
    const range = MC.monthRange ? MC.monthRange('2026-10') : null;
    if (range) {
      const e = (o) => Object.assign({ costType: 'direct', amountCents: 100000, taxCents: 0, leadId: 'L1', date: new Date(2026, 9, 10, 12) }, o || {});
      const c1 = MC.costsForMonth([e(), e({ entryType: 'credit', amountCents: 25000 })], range);
      eq('Month close: direct nets a credit', c1.directCents, 75000);
      eq('Month close: byLead nets', c1.byLead.L1, 75000);
      eq('Month close: credits reported', c1.creditsCents, 25000);
      ok('Month close: a lone credit does not count as a real cost logged', !MC.jobsWithRealCost([e({ entryType: 'credit' })]).L1 && !!MC.jobsWithRealCost([e()]).L1);
    } else ok('Month close: monthRange available', false);
  }
  // job cost auditor
  {
    const A = require(JS('job-cost-audit-logic.js'));
    const e = (o) => Object.assign({ costType: 'direct', category: 'materials', amountCents: 100000, taxCents: 0 }, o || {});
    const s = A.summarize(1000000, [e(), e({ entryType: 'credit', amountCents: 40000 })]);
    eq('Auditor: direct cost nets a credit', s.directCents, 60000);
    eq('Auditor: materials bucket nets', s.byKind.materials, 60000);
    eq('Auditor: margin uses the net cost', s.marginPct, 94);
  }
  // sub paperwork (1099 prep) + sub payments
  {
    const SP = require(JS('sub-paperwork-logic.js'));
    const roster = [{ id: 's1', name: 'Sample Crew' }];
    const row = (o) => Object.assign({ category: 'subcontractor', supplier: 'Sample Crew', amountCents: 300000, taxCents: 0, date: new Date(2026, 5, 1, 12) }, o || {});
    const yt = SP.yearTotals([row(), row({ entryType: 'credit', amountCents: 50000 })], roster, 2026);
    eq('1099 prep: the sub total nets a credit', yt.subs[0].totals.cents, 250000);
    eq('1099 prep: all-subs total nets', yt.all.cents, 250000);
    const PAY = require(JS('sub-payments-logic.js'));
    eq('Sub payments: centsOf is signed', PAY.centsOf({ entryType: 'credit', amountCents: 500, taxCents: 0 }), -500);
  }
  // numbers-logic costsNeeded, receipt health
  {
    const N = require(JS('numbers-logic.js'));
    const wonLead = { id: 'W1', stage: 'closed', jobValue: 5000, name: 'Sample Won' };
    if (N.costsNeeded) {
      const withCredit = N.costsNeeded([wonLead], [{ leadId: 'W1', entryType: 'credit', costType: 'direct', amountCents: 5000 }], () => 'won');
      ok('Costs needed: a lone credit does not make a won job "costed"', withCredit.total === 1 ? withCredit.costed === 0 : true);
    }
    const RH = fs.readFileSync(JS('receipt-health.js'), 'utf8');
    ok('Receipt health: a credit row is skipped when deciding a job has a cost', /entryType === 'credit'\) return;/.test(RH));
  }
  // customer jobs + analytics + lead-source-roi (browser IIFEs): the per-job cost rule, via the exported helper
  {
    const wj = makeWin();
    try {
      loadInto(wj, 'customer-jobs.js');
      const CJ = wj.NBDCustomerJobs;
      const jobs = [{ id: 'j1' }];
      const cb = (ex) => CJ._costsByJob(jobs, ex);
      eq('Customer jobs: a credit nets the job cost', cb([{ costType: 'direct', amountCents: 100000 }, { costType: 'direct', entryType: 'credit', amountCents: 30000 }]).j1, 70000);
      ok('Customer jobs: credits bigger than costs leave a NEGATIVE cost that is said out loud', cb([{ costType: 'direct', amountCents: 1000 }, { costType: 'direct', entryType: 'credit', amountCents: 5000 }]).j1 === -4000 && /credits exceed costs/.test(CJ._costLine(10000, -4000)));
    } catch (err) { ok('customer-jobs.js loads in the sandbox: ' + err.message, false); }
  }
  {
    const AK = fs.readFileSync(JS('analytics-kpi.js'), 'utf8');
    ok('Analytics KPI: credit sign applied to totals, supplier and per-job direct', /cSign = e\.entryType === 'credit' \? -1 : 1/.test(AK) && /cSign \* \(parseInt\(e\.taxCents/.test(AK) && /expCreditsExceed/.test(AK));
    const LS = fs.readFileSync(JS('lead-source-roi.js'), 'utf8');
    ok('Lead source ROI: a marketing credit nets the source spend', /e\.entryType === 'credit' \? -c : c/.test(LS));
  }

  // ══ 10. server-side read-only summaries ══
  console.log('\nSERVER — agent / MCP summaries and the monthly overhead email');
  {
    const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
    eq('expenseSignedCents: cost', L.expenseSignedCents({ amountCents: 1000, taxCents: 70 }), 1070);
    eq('expenseSignedCents: credit', L.expenseSignedCents({ entryType: 'credit', amountCents: 1000, taxCents: 70 }), -1070);
    eq('expenseSignedCents: adjustment adds', L.expenseSignedCents({ entryType: 'adjustment', amountCents: 1000 }), 1000);
    const NOW = Date.parse('2026-10-23T16:00:00Z'), DAY = 86400000, iso = (n) => new Date(NOW - n * DAY).toISOString();
    const leads = [{ id: 'J1', name: 'Job 1', address: '1 St', stage: 'final_payment', stageRole: 'won', completedAt: iso(5), createdAt: iso(40) }];
    const invoices = [{ leadId: 'J1', total: 10000, balanceDue: 0, payments: [{ amount: 10000, at: iso(5) }] }];
    const ex = (o) => Object.assign({ leadId: 'J1', costType: 'direct', category: 'materials', amountCents: 400000, taxCents: 0 }, o || {});
    const jp = (exps) => L.jobProfit(leads, invoices, exps, NOW, {}, 'America/New_York').jobs[0];
    const j0 = jp([ex()]);
    eq('agent job_profit: no credit -> direct costs $4,000', j0.direct_costs, 4000);
    ok('agent job_profit: no credit -> output has no credit fields (unchanged shape)', !('credits' in j0) && !('credits_exceed_costs' in j0));
    const j1 = jp([ex(), ex({ entryType: 'credit', amountCents: 100000 })]);
    eq('agent job_profit: net of a $1,000 credit', j1.direct_costs, 3000);
    eq('agent job_profit: credits reported', j1.credits, 1000);
    ok('agent job_profit: not flagged while costs exceed credits', j1.credits_exceed_costs === false);
    const j2 = jp([ex({ amountCents: 100000 }), ex({ entryType: 'credit', amountCents: 150000 })]);
    ok('agent job_profit: credits bigger than costs -> negative cost, flagged', j2.direct_costs === -500 && j2.credits_exceed_costs === true);
    const src2 = L.leadSources([], [{ marketingSource: 'Google', amountCents: 50000, taxCents: 0, date: iso(3) }, { marketingSource: 'Google', entryType: 'credit', amountCents: 20000, taxCents: 0, date: iso(3) }], NOW, 90);
    eq('agent lead_sources: marketing spend nets a credit', src2.sources.find((s) => s.source === 'Google').spend, 300);
    const margin = L.marginReview(leads, invoices, [ex({ amountCents: 900000 }), ex({ entryType: 'credit', amountCents: 100000 })], NOW, {}, 'America/New_York');
    ok('agent margin_review still runs with a credit present', margin && typeof margin.jobs_reviewed === 'number');

    const O = require(path.join(ROOT, 'functions/monthly-overhead-logic.js'));
    const dt = (m, d) => new Date(Date.UTC(2026, m - 1, d, 16));
    const oe = (o) => Object.assign({ companyId: 'c1', costType: 'overhead', category: 'insurance', amountCents: 100000, date: dt(10, 10) }, o || {});
    const sum = (docs) => O.summarizeOverhead(docs, '2026-10', '2026-09').get('c1');
    eq('overhead: total without credit', sum([oe()]).totalCents, 100000);
    ok('overhead: no credit -> no creditsCents key (unchanged shape)', !('creditsCents' in sum([oe()])));
    const s1 = sum([oe(), oe({ entryType: 'credit', amountCents: 30000 })]);
    eq('overhead: nets a credit', s1.totalCents, 70000);
    eq('overhead: category nets', s1.byCategory.insurance, 70000);
    eq('overhead: credits reported', s1.creditsCents, 30000);
    const s2 = sum([oe({ amountCents: 10000 }), oe({ entryType: 'credit', amountCents: 40000 })]);
    eq('overhead: credits bigger than costs -> NEGATIVE total (not 0, not skipped)', s2.totalCents, -30000);
    ok('overhead email says credits are larger than costs', /larger than the overhead costs/.test(O.buildEmail(s2, 'October 2026').bodyPlain) && /netted out/.test(O.buildEmail(s1, 'October 2026').bodyPlain));
    ok('overhead email without credits has no credit line', !/netted out/.test(O.buildEmail(sum([oe()]), 'October 2026').bodyPlain));
    const alert = fs.readFileSync(path.join(ROOT, 'functions/monthly-overhead-alert.js'), 'utf8');
    ok('overhead cron no longer skips a NEGATIVE month as "zero"', /summary\.totalCents === 0\) \{ skippedZero\+\+/.test(alert) && !/summary\.totalCents <= 0\) \{ skippedZero/.test(alert));
  }

  // ══ 11. dark by default ══
  console.log('\nSHIP DARK — flag absent means off');
  {
    delete win.NBDFlags;
    writes.length = 0;
    EX._setData([]);
    ok('no NBDFlags at all: a credit is refused', (await EX.createExpense({ amount: '5', date: '2026-11-02', supplier: 'x', category: 'materials', entryType: 'credit' })) === false && writes.length === 0);
    const sl = fs.readFileSync(JS('script-loader.js'), 'utf8');
    ok('flag name is costCredits and the form picker is behind it', /CREDITS_FLAG = 'costCredits'/.test(src) && /creditsFlagOn\(\)\s*\? '<div class="exx-mb12px"><label class="ui-label-caps" for="expEntryType"/.test(src));
    ok('script-loader still lists expense-config.js and expenses.js', /expense-config\.js\?v=\d+/.test(sl) && /expenses\.js\?v=\d+/.test(sl));
  }

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' cost credits: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) { console.error('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
