/**
 * invoice-pipeline.test.js
 *
 * Locks in the supplement-inclusive invoice math added for the
 * 2026-06-27 adversarial-review finding (HIGH): createInvoiceFromEstimate
 * billed only the estimate's saved total and IGNORED approved/partial
 * insurance supplements, so invoices undercharged by the supplement amount.
 *
 * Covers the pure helpers exported from docs/pro/js/invoice-pipeline.js:
 *   - supplementBillableAmount  (approved → supplementTotal; partial → approvedAmount)
 *   - selectBillableSupplements (filter to billable + build line description)
 *   - applySupplementsToTotals  (fold into subtotal/total, leave tax untouched)
 *
 * Pure-Node test, no emulator/DOM required. Run via:
 *   node tests/invoice-pipeline.test.js
 */

const path = require('path');
const IP = require(path.join('..', 'docs', 'pro', 'js', 'invoice-pipeline.js'));
const ES = require(path.join('..', 'docs', 'pro', 'js', 'estimate-supplement.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error((label || 'value') + ' = ' + JSON.stringify(actual) + ' (expected ' + JSON.stringify(expected) + ')');
}
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > (tol || 0.005)) throw new Error((label || 'value') + ' = ' + actual + ' (expected ~' + expected + ')');
}

// Supplement doc shapes mirror docs/pro/js/estimate-supplement.js.
const approved2000 = { id: 's1', version: 1, status: 'approved', reason: 'Decking', supplementTotal: 2000, submission: { approvedAmount: null } };
const partial1500  = { id: 's2', version: 2, status: 'partial',  reason: 'Drip edge', supplementTotal: 3000, submission: { approvedAmount: 1500 } };
const denied       = { id: 's3', version: 3, status: 'denied',   supplementTotal: 999,  submission: { approvedAmount: 0 } };
const draft        = { id: 's4', version: 4, status: 'draft',    supplementTotal: 500,  submission: { approvedAmount: null } };
const submitted    = { id: 's5', version: 5, status: 'submitted',supplementTotal: 700,  submission: { approvedAmount: null } };
const partialNull  = { id: 's6', version: 6, status: 'partial',  supplementTotal: 800,  submission: { approvedAmount: null } };

console.log('\ninvoice-pipeline supplement math');
console.log('──────────────────────────────────────────────────');

// ── supplementBillableAmount ──
test('approved → full supplementTotal', () => {
  eq(IP.supplementBillableAmount(approved2000), 2000);
});
test('partial → submission.approvedAmount (NOT supplementTotal)', () => {
  eq(IP.supplementBillableAmount(partial1500), 1500);
});
test('denied / draft / submitted → 0 (not billable)', () => {
  eq(IP.supplementBillableAmount(denied), 0, 'denied');
  eq(IP.supplementBillableAmount(draft), 0, 'draft');
  eq(IP.supplementBillableAmount(submitted), 0, 'submitted');
});
test('partial with null approvedAmount → 0 (no amount to bill)', () => {
  eq(IP.supplementBillableAmount(partialNull), 0);
});
test('null / undefined / garbage supplement → 0, never NaN', () => {
  eq(IP.supplementBillableAmount(null), 0, 'null');
  eq(IP.supplementBillableAmount(undefined), 0, 'undefined');
  eq(IP.supplementBillableAmount({ status: 'approved', supplementTotal: 'abc' }), 0, 'garbage total');
});

// ── selectBillableSupplements ──
test('keeps only approved/partial-with-amount, drops the rest', () => {
  const out = IP.selectBillableSupplements([approved2000, partial1500, denied, draft, submitted, partialNull]);
  eq(out.length, 2, 'billable count');
  eq(out[0].billable, 2000);
  eq(out[1].billable, 1500);
});
test('line description carries version + status tag + reason', () => {
  const out = IP.selectBillableSupplements([approved2000, partial1500]);
  eq(out[0].description, 'Insurance Supplement #1 (approved) — Decking');
  eq(out[1].description, 'Insurance Supplement #2 (partial approval) — Drip edge');
});
test('empty / null input → []', () => {
  eq(IP.selectBillableSupplements([]).length, 0);
  eq(IP.selectBillableSupplements(null).length, 0);
});

// ── applySupplementsToTotals ──
const base = { items: [{ description: 'Roof', quantity: 1, unitPrice: 10000, total: 10000 }], subtotal: 10000, tax: 750, total: 10750 };

test('no supplements → totals + items unchanged, supplementTotal 0', () => {
  const r = IP.applySupplementsToTotals(base, []);
  eq(r.subtotal, 10000, 'subtotal');
  eq(r.tax, 750, 'tax');
  eq(r.total, 10750, 'total');
  eq(r.supplementTotal, 0, 'supplementTotal');
  eq(r.items.length, 1, 'items');
});

test('one approved supplement adds to subtotal + total but NOT tax', () => {
  const r = IP.applySupplementsToTotals(base, [approved2000]);
  eq(r.subtotal, 12000, 'subtotal += 2000');
  eq(r.tax, 750, 'tax UNCHANGED (supplements are tax-exempt)');
  eq(r.total, 12750, 'total += 2000');
  eq(r.supplementTotal, 2000, 'supplementTotal');
  eq(r.supplementCount, 1, 'count');
  eq(r.items.length, 2, 'appended one line');
  const line = r.items[1];
  eq(line.quantity, 1, 'line qty');
  eq(line.unitPrice, 2000, 'line unitPrice');
  eq(line.total, 2000, 'line total');
});

test('partial supplement folds approvedAmount (1500), not supplementTotal (3000)', () => {
  const r = IP.applySupplementsToTotals(base, [partial1500]);
  eq(r.supplementTotal, 1500, 'partial uses approvedAmount');
  eq(r.total, 12250, 'total += 1500');
  eq(r.tax, 750, 'tax unchanged');
});

test('mixed list: only approved + partial(amount) billed; others ignored', () => {
  const r = IP.applySupplementsToTotals(base, [approved2000, partial1500, denied, draft, submitted, partialNull]);
  eq(r.supplementTotal, 3500, '2000 + 1500');
  eq(r.subtotal, 13500, 'subtotal += 3500');
  eq(r.total, 14250, 'total += 3500');
  eq(r.tax, 750, 'tax unchanged');
  eq(r.supplementCount, 2, 'two billable lines');
  eq(r.items.length, 3, 'base 1 + 2 supplement lines');
});

test('tax-exempt holds even on a taxable (cash) base with a positive rate', () => {
  // Cash estimate: $10,000 base @ 7.5% = $750 tax, $10,750 total. Attaching a
  // $2,000 insurance supplement must NOT add 7.5% tax on the supplement.
  const cashBase = { items: [], subtotal: 10000, tax: 750, total: 10750 };
  const r = IP.applySupplementsToTotals(cashBase, [approved2000]);
  eq(r.tax, 750, 'no extra tax on the supplement');
  eq(r.total, 12750, 'supplement added at face value, untaxed');
});

test('money math rounds to cents (no float drift)', () => {
  const b = { items: [], subtotal: 100.1, tax: 0, total: 100.1 };
  const supp = { status: 'partial', version: 1, supplementTotal: 0, submission: { approvedAmount: 0.2 } };
  const r = IP.applySupplementsToTotals(b, [supp]);
  near(r.total, 100.3, 0.0001, 'total');
  near(r.subtotal, 100.3, 0.0001, 'subtotal');
});

test('an already-invoiced supplement is skipped in the fold (no double-bill on a 2nd invoice)', () => {
  const fresh   = { id: 'sA', version: 1, status: 'approved', supplementTotal: 2000, submission: { approvedAmount: null } };
  const already = { id: 'sB', version: 2, status: 'approved', supplementTotal: 2000, submission: { approvedAmount: null }, invoicedInvoiceId: 'inv_1' };
  const r = IP.applySupplementsToTotals({ items: [], subtotal: 100, tax: 0, total: 100 }, [fresh, already]);
  eq(r.supplementCount, 1, 'only the un-invoiced supplement folds');
  eq(r.supplementTotal, 2000, 'billed once (2000), not 4000');
  eq(r.supplementIds.length, 1, 'supplementIds lists only the folded one');
  eq(r.supplementIds[0], 'sA', 'folded id is the un-invoiced supplement (to be stamped)');
});

// ── CROSS-MODULE CONTRACT: the RUNTIME supplement path reaches billable ──
// The fixtures above are hand-built {status:'approved'|'partial'} docs. That
// alone can pass while production is inert — which is exactly what happened:
// supplements were created 'draft' and no code path ever flipped them, so the
// invoice fold added $0. These tests drive the REAL estimate-supplement.js
// functions so the two modules can never silently drift apart again:
//   createSupplement() (draft) → recordResponse() → IP.supplementBillableAmount()
console.log('\nsupplement → invoice billable contract (real estimate-supplement.js)');
console.log('──────────────────────────────────────────────────');

// The REAL saved-estimate shape: line items live under `rows` (V2 carries the
// split material/labor + a numeric `quantity`; classic carries display qty/rate
// strings) and the customer total under `grandTotal`. The old fixture used
// {lines,total}, which MASKED the createSupplement drift that made every real
// supplement inert (originalTotal undefined → NaN → the Firestore save threw).
const parentEstimate = {
  rows: [{ code: 'RFG', desc: 'Shingles', unit: 'sq', quantity: 20,
           qty: '20.00sq', rate: '$150.00',
           materialCostPerUnit: 100, laborCostPerUnit: 50, lineTotal: 3000, total: 3000 }],
  grandTotal: 3000, materialCost: 2000, laborCost: 1000,
};

// Engine-shape regression guards (2026-07-08 sweep). These drive the REAL
// createSupplement + calculateDelta against the saved {grandTotal, rows} shape —
// the old fixture + hand-set supplementTotal never exercised this path.
test('createSupplement reads grandTotal + rows (real saved shape) — no undefined/NaN', () => {
  const s = ES.createSupplement(parentEstimate, { version: 1 });
  eq(s.originalTotal, 3000, 'originalTotal from grandTotal (was undefined → save threw)');
  eq(s.originalLineItems.length, 1, 'originalLineItems mapped from rows (was empty)');
  eq(s.originalLineItems[0].code, 'RFG', 'original line code');
  eq(s.originalLineItems[0].quantity, 20, 'original line qty is numeric');
});

test('calculateDelta yields a finite newGrandTotal = original + supplement (was NaN)', () => {
  const s = ES.createSupplement(parentEstimate, { version: 1 });
  ES.addItem(s, { code: 'IWS', name: 'Ice & Water Shield', unit: 'sq', quantity: 4, materialCost: 60, laborCost: 40 });
  eq(Number.isFinite(s.supplementTotal), true, 'supplementTotal finite');
  eq(s.supplementTotal > 0, true, 'supplementTotal positive');
  eq(Number.isFinite(s.newGrandTotal), true, 'newGrandTotal not NaN');
  eq(s.newGrandTotal, s.originalTotal + s.supplementTotal, 'newGrandTotal = original + supplement');
});

test('modifyItemQuantity matches a rows-sourced original line (quantity-adjust path was dead)', () => {
  const s = ES.createSupplement(parentEstimate, { version: 1 });
  const m = ES.modifyItemQuantity(s, 'RFG', 25, 'more storm-exposed field');
  eq(!!m, true, 'modification created (line found in rows, not lines)');
  eq(m && m.deltaQuantity, 5, 'delta qty = 5');
  eq(s.supplementTotal > 0, true, 'quantity adjustment contributes to supplementTotal');
});

test('a tiny positive supplement never rounds to $0', () => {
  const s = ES.createSupplement(parentEstimate, { version: 1 });
  ES.addItem(s, { code: 'CK', name: 'Caulk', unit: 'ea', quantity: 1, materialCost: 3, laborCost: 2 });
  eq(s.supplementTotal >= 25, true, 'positive supplement bills at least one $25 increment');
});

test('removeAddedItemAt removes only the indexed line, not all sharing a code', () => {
  const s = ES.createSupplement(parentEstimate, { version: 1 });
  ES.addItem(s, { code: 'DRIP', name: 'Drip edge A', unit: 'lf', quantity: 10, materialCost: 2, laborCost: 1 });
  ES.addItem(s, { code: 'DRIP', name: 'Drip edge B', unit: 'lf', quantity: 5, materialCost: 2, laborCost: 1 });
  eq(s.addedItems.length, 2, 'two same-code lines added');
  ES.removeAddedItemAt(s, 0);
  eq(s.addedItems.length, 1, 'only the indexed line removed (was: both dropped by code)');
  eq(s.addedItems[0].name, 'Drip edge B', 'the surviving line is the one not removed');
});

test('supplement markup/OH&P uses the parent estimate rates, not globals', () => {
  const peWithRates = Object.assign({}, parentEstimate, { materialMarkupPct: 0.30, overheadPct: 0.15, profitPct: 0.15 });
  const s = ES.createSupplement(peWithRates, { version: 1 });
  ES.addItem(s, { code: 'X', name: 'Item', unit: 'ea', quantity: 1, materialCost: 100, laborCost: 0 });
  eq(s.settingsSnapshot.materialMarkupPct, 0.30, 'snapshot took parent materialMarkupPct');
  eq(s.settingsSnapshot.overheadPct, 0.15, 'snapshot took parent overheadPct');
  // material 100 * 1.30 = 130 retail; OH 15% + P 15% on 130 = 39 → subtotal 169
  // (defaults 0.25/0.10/0.10 would give 125 + 25 = 150).
  near(s.supplementSubtotal, 169, 0.01, 'subtotal priced at parent rates (130 + 39)');
});

test('a freshly created supplement is draft and bills $0 (the #881 bug shape)', () => {
  const s = ES.createSupplement(parentEstimate, { version: 1 });
  s.supplementTotal = 2500; // calculateDelta stamps this before save
  eq(s.status, 'draft', 'created status');
  eq(IP.supplementBillableAmount(s), 0, 'draft is not billable');
});

test('recordResponse("approved") flips it to bill the full supplementTotal', () => {
  const s = ES.createSupplement(parentEstimate, { version: 1 });
  s.supplementTotal = 2500;
  ES.recordResponse(s, { status: 'approved' });
  eq(s.status, 'approved', 'status');
  eq(IP.supplementBillableAmount(s), 2500, 'bills full total');
});

test('recordResponse("partial", $1500) bills the adjuster amount, not the total', () => {
  const s = ES.createSupplement(parentEstimate, { version: 2 });
  s.supplementTotal = 4000;
  ES.recordResponse(s, { status: 'partial', approvedAmount: 1500 });
  eq(s.status, 'partial', 'status');
  eq(s.submission.approvedAmount, 1500, 'approvedAmount persisted on doc');
  eq(IP.supplementBillableAmount(s), 1500, 'bills approvedAmount');
});

test('recordResponse("denied") stays non-billable', () => {
  const s = ES.createSupplement(parentEstimate, { version: 3 });
  s.supplementTotal = 900;
  ES.recordResponse(s, { status: 'denied' });
  eq(IP.supplementBillableAmount(s), 0, 'denied bills $0');
});

test('end-to-end fold: one approved + one partial supplement land on the invoice', () => {
  const a = ES.createSupplement(parentEstimate, { version: 1 }); a.supplementTotal = 2000;
  ES.recordResponse(a, { status: 'approved' });
  const b = ES.createSupplement(parentEstimate, { version: 2 }); b.supplementTotal = 3000;
  ES.recordResponse(b, { status: 'partial', approvedAmount: 1200 });
  const draftC = ES.createSupplement(parentEstimate, { version: 3 }); draftC.supplementTotal = 500; // never responded
  const invBase = { items: [], subtotal: 10000, tax: 750, total: 10750 };
  const r = IP.applySupplementsToTotals(invBase, [a, b, draftC]);
  eq(r.supplementTotal, 3200, '2000 + 1200 (draft ignored)');
  eq(r.total, 13950, 'total += 3200, tax untouched');
  eq(r.supplementCount, 2, 'two billable lines');
});

// ════════════════════════════════════════════════════════════════════
// buildRowItems — invoice line items at the CUSTOMER price (money-math
// sweep 2026-07-18: V2 line-item + insurance invoices printed each line at
// the contractor's internal COST — no material markup, no O&P — so the
// items summed to ~55-65% of the subtotal and exposed the margin).
// Contract: for a V2 estimate, Σ item totals == est.subtotal (retail lines
// + an explicit Overhead & Profit line, mirroring the signed scope ladder).
// ════════════════════════════════════════════════════════════════════
console.log('\nbuildRowItems — retail line items foot to the subtotal');
console.log('──────────────────────────────────────────────────');

// Engine identities for both V2 fixtures (markup 25%, O&P 10%+10%):
//   line A: mat 1000 + lab 500 → cost 1500, retail 1000×1.25+500 = 1750
//   line B: mat 0 + lab 450    → cost 450,  retail 450
//   passthru SVC: face 75 (no markup, no O&P)
//   retailBeforeOHP = 2200 ; O&P = 440 ; subtotal = 2200+440+75 = 2715
const sumItems = (items) => items.reduce((s, i) => s + i.total, 0);

// Post-sweep save: rows carry explicit retailTotal (and retail rate/total).
const v2New = {
  materialMarkupPct: 0.25, overhead: 220, overheadPct: 0.10, profit: 220, profitPct: 0.10,
  subtotal: 2715, grandTotal: 2715, taxRate: 0,
  rows: [
    { code: 'A', desc: 'Shingles', qty: '10.00SQ', rate: '$175.00', total: 1750, retailTotal: 1750,
      quantity: 10, materialTotal: 1000, laborTotal: 500, materialCostPerUnit: 100, laborCostPerUnit: 50 },
    { code: 'B', desc: 'Tear-off', qty: '10.00SQ', rate: '$45.00', total: 450, retailTotal: 450,
      quantity: 10, materialTotal: 0, laborTotal: 450, materialCostPerUnit: 0, laborCostPerUnit: 45 },
    { code: 'SVC RPT', desc: 'Aerial report', qty: '1.00ea', rate: '$75.00', total: 75, retailTotal: 75,
      quantity: 1, materialTotal: null, laborTotal: null, source: 'passthru' },
  ],
};

// Pre-sweep save: rate/total hold the raw COST basis, no retailTotal.
const v2Old = {
  materialMarkupPct: 0.25, overhead: 220, overheadPct: 0.10, profit: 220, profitPct: 0.10,
  subtotal: 2715, grandTotal: 2715, taxRate: 0,
  rows: [
    { code: 'A', desc: 'Shingles', qty: '10.00SQ', rate: '$150.00', total: 1500,
      quantity: 10, materialTotal: 1000, laborTotal: 500, materialCostPerUnit: 100, laborCostPerUnit: 50 },
    { code: 'B', desc: 'Tear-off', qty: '10.00SQ', rate: '$45.00', total: 450,
      quantity: 10, materialTotal: 0, laborTotal: 450, materialCostPerUnit: 0, laborCostPerUnit: 45 },
    { code: 'SVC RPT', desc: 'Aerial report', qty: '1.00ea', rate: '$75.00', total: 75,
      quantity: 1, materialTotal: null, laborTotal: null, source: 'passthru' },
  ],
};

test('post-sweep V2 rows: items at explicit retailTotal + O&P line', () => {
  const items = IP.buildRowItems(v2New);
  eq(items.length, 4, '3 rows + O&P line');
  eq(items[0].total, 1750, 'line A at retail');
  eq(items[0].unitPrice, 175, 'line A unit at retail');
  eq(items[1].total, 450, 'line B (labor-only) unchanged');
  eq(items[2].total, 75, 'pass-through at face');
  eq(items[3].description, 'Overhead & Profit (20%)', 'O&P line labeled with pct');
  eq(items[3].total, 440, 'O&P = overhead + profit');
});

test('post-sweep V2 rows: Σ item totals == subtotal', () => {
  near(sumItems(IP.buildRowItems(v2New)), v2New.subtotal, 0.01, 'items foot to subtotal');
});

test('PRE-sweep V2 rows (cost basis persisted): retail derived from the split', () => {
  const items = IP.buildRowItems(v2Old);
  eq(items.length, 4, '3 rows + O&P line');
  eq(items[0].total, 1750, 'line A derived retail (NOT the stored 1500 cost)');
  eq(items[0].unitPrice, 175, 'line A unit derived from retail (NOT the $150 cost rate)');
  eq(items[1].total, 450, 'labor-only line: margin comes through O&P, shown as-is');
  eq(items[2].total, 75, 'pass-through (no split) at face');
  near(sumItems(items), v2Old.subtotal, 0.01, 'items foot to subtotal');
});

test('PRE-sweep V2 rows: no item leaks the internal cost basis', () => {
  const items = IP.buildRowItems(v2Old);
  eq(items.some(i => i.total === 1500), false, 'cost-basis 1500 never rendered');
  eq(items.some(i => i.unitPrice === 150), false, 'cost rate $150 never rendered');
});

test('classic rows (no markup persisted): mapping unchanged, no O&P line', () => {
  const classic = {
    grandTotal: 3500, subtotal: 3500, taxRate: 0,
    rows: [
      { desc: 'Tear-off + disposal', qty: 20, rate: 100, total: 2000 },
      { desc: 'Shingles (architectural)', qty: '1 EA', rate: '$1,500.00', total: 1500 },
    ],
  };
  const items = IP.buildRowItems(classic);
  eq(items.length, 2, 'no O&P line appended for classic rows');
  eq(items[0].total, 2000, 'classic row total passes through');
  eq(items[0].unitPrice, 100, 'classic rate honored');
  eq(items[1].unitPrice, 1500, 'display-string rate parsed ($1,500.00)');
  eq(sumItems(items), classic.subtotal, 'classic items still foot to subtotal');
});

test('V2 rows with zero O&P (free/comp job): no phantom O&P line', () => {
  const noOhp = Object.assign({}, v2New, { overhead: 0, profit: 0, subtotal: 2275 });
  const items = IP.buildRowItems(noOhp);
  eq(items.length, 3, 'no O&P line when overhead+profit is 0');
  near(sumItems(items), 2275, 0.01, 'still foots (retailBeforeOHP + passthru)');
});

test('empty / missing rows → []', () => {
  eq(IP.buildRowItems({}).length, 0, 'no rows');
  eq(IP.buildRowItems(null).length, 0, 'null estimate');
});

// ── buildInvoiceHtml — the deposit/balance display bug (2026-09-14) ──
//
// invoice.balanceDue is booked as the FULL total until a real payment
// lands (createInvoiceFromEstimate does this on purpose, for correct AR).
// Before this fix, the emailed invoice's "Balance Due" row printed
// `invoice.balanceDue != null ? invoice.balanceDue : (total - depositAmount)`
// — and balanceDue is never null pre-payment, so that ternary always took
// the first branch and printed the full total directly under a separate
// "Deposit due" line, reading as deposit + total owed rather than one bill.
// Anchors on the rendered `>label` markup, not a bare label substring — the
// file's own explanatory HTML comment above this block also contains the
// words "Deposit due" and "Balance Due" in prose, which a bare indexOf
// would match first.
function extractRow(html, label) {
  const idx = html.indexOf('>' + label);
  if (idx < 0) return null;
  const m = html.slice(idx, idx + 300).match(/\$[\d,]+\.\d{2}/);
  return m ? m[0] : null;
}
const depositInvoiceUnpaid = {
  total: 14200, depositAmount: 7100, depositPaid: false, balanceDue: 14200,
  items: [], invoiceNumber: 'INV-DEP-1', customerName: 'Jane Homeowner', customerAddress: '1 Main St',
};
test('unpaid deposit invoice: Balance Due shows total minus deposit, not the full total', () => {
  const html = IP.buildInvoiceHtml(depositInvoiceUnpaid);
  eq(extractRow(html, 'Deposit'), '$7,100.00', 'deposit row unchanged');
  eq(extractRow(html, 'Balance Due'), '$7,100.00', 'balance due = total - deposit while unpaid, not $14,200.00 (the bug)');
});
test('deposit-paid invoice: Balance Due shows the real stored balanceDue (post-payment truth)', () => {
  // Once the deposit is recorded as paid, markPaid has already updated the
  // stored balanceDue to total - amountPaid — safe to show as-is.
  const html = IP.buildInvoiceHtml(Object.assign({}, depositInvoiceUnpaid, {
    depositPaid: true, amountPaid: 7100, balanceDue: 7100,
  }));
  eq(extractRow(html, 'Balance Due'), '$7,100.00', 'shows the real post-deposit balance');
});
test('no-deposit invoice: deposit/balance block does not render at all', () => {
  const html = IP.buildInvoiceHtml({ total: 5000, depositAmount: 0, depositPaid: false, balanceDue: 5000, items: [], invoiceNumber: 'INV-2', customerName: 'X', customerAddress: 'Y' });
  eq(extractRow(html, 'Deposit'), null, 'no deposit row when there is no deposit');
  eq(extractRow(html, 'Balance Due'), null, 'no balance-due row either — nothing to reconcile');
});

// ── Partial payment SMALLER than the deposit (emulator, 2026-09-28) ──────
// $14,880 invoice, $7,450 deposit, a $3,000 check recorded via Mark Paid.
// markPaid stored amountPaid 3000 / balanceDue 11880 / depositPaid false —
// and both renderers kept printing "Deposit due $7,450 · Balance Due $7,430",
// exactly as before the check: the payment was invisible.
const partialUnderDeposit = {
  total: 14880, depositAmount: 7450, depositPaid: false, amountPaid: 3000, balanceDue: 11880,
  items: [], invoiceNumber: 'INV-PART', customerName: 'Jane Homeowner', customerAddress: '1 Main St',
};
test('partial < deposit: remaining deposit, paid to date, and a balance that still foots', () => {
  const html = IP.buildInvoiceHtml(partialUnderDeposit);
  eq(extractRow(html, 'Deposit due (remaining)'), '$4,450.00', 'deposit left = 7,450 − 3,000');
  eq(extractRow(html, 'Paid to date'), '$3,000.00', 'the check is shown');
  eq(extractRow(html, 'Balance Due'), '$7,430.00', 'deposit left + balance = 11,880 outstanding');
});
test('paymentSummaryRows: rows always foot to total − paid', () => {
  const cases = [
    depositInvoiceUnpaid,
    Object.assign({}, depositInvoiceUnpaid, { depositPaid: true, amountPaid: 7100, balanceDue: 7100 }),
    partialUnderDeposit,
    Object.assign({}, partialUnderDeposit, { amountPaid: 9000, balanceDue: 5880, depositPaid: true }),
    { total: 5000, depositAmount: 0, amountPaid: 1200, balanceDue: 3800 },
  ];
  for (const c of cases) {
    const rows = IP.paymentSummaryRows(c);
    const due = rows.filter(r => r.label !== 'Paid to date' && r.label !== 'Deposit (paid)' && r.label !== 'Total owed').reduce((s, r) => s + r.amount, 0);
    eq(Math.round(due * 100), Math.round((c.total - (c.amountPaid || 0)) * 100), 'foots for ' + JSON.stringify({ t: c.total, d: c.depositAmount, p: c.amountPaid }));
  }
});
test('Total owed: a bold sum while deposit AND balance are both still owed', () => {
  // Jo 2026-10-02: "Balance Due" alone read as the whole debt mid-deposit.
  const rows = IP.paymentSummaryRows(partialUnderDeposit);
  const by = (l) => rows.find(r => r.label === l);
  eq(by('Deposit due (remaining)').amount, 4450, 'deposit remaining = 7450 − 3000');
  eq(by('Balance Due').amount, 7430, 'balance due = 14880 − 7450');
  eq(by('Total owed') && by('Total owed').amount, 11880, 'total owed = total − paid');
  eq(rows.filter(r => r.strong).map(r => r.label).join('|'), 'Total owed', 'Total owed is the one emphasised row');
  const before = IP.paymentSummaryRows(depositInvoiceUnpaid);
  eq(before.find(r => r.label === 'Total owed').amount, 14200, 'before any payment: the whole invoice');
  // Deposit met, or no deposit: one owed row, no Total owed.
  const met = IP.paymentSummaryRows(Object.assign({}, partialUnderDeposit, { amountPaid: 9000, balanceDue: 5880, depositPaid: true }));
  eq(met.some(r => r.label === 'Total owed'), false, 'deposit met → no Total owed');
  eq(met.filter(r => r.strong).map(r => r.label).join('|'), 'Balance Due', 'Balance Due is emphasised again');
  const noDep = IP.paymentSummaryRows({ total: 5000, depositAmount: 0, amountPaid: 1200, balanceDue: 3800 });
  eq(noDep.some(r => r.label === 'Total owed'), false, 'no deposit → no Total owed');
  const html = IP.buildInvoiceHtml(Object.assign({}, partialUnderDeposit));
  eq(/Total owed:[\s\S]{0,200}11,880\.00/.test(html), true, 'the emailed invoice carries Total owed $11,880.00');
});
test('no-deposit invoice with a partial payment shows paid + balance (was: nothing)', () => {
  const html = IP.buildInvoiceHtml({ total: 5000, depositAmount: 0, amountPaid: 1200, balanceDue: 3800, items: [], invoiceNumber: 'INV-3', customerName: 'X', customerAddress: 'Y' });
  eq(extractRow(html, 'Paid to date'), '$1,200.00', 'paid row');
  eq(extractRow(html, 'Balance Due'), '$3,800.00', 'balance row');
});

// ── Bill-To name (phone audit 2026-09-25, estimate#9) ─────────────────────
// Real shapes: no estimate writer stamps customerName (V2 and Classic save the
// homeowner as `owner`), and saveLead writes firstName/lastName, never `name`.
// The old read `est.customerName || lead.name` was therefore always '' and
// every invoice from an estimate billed "Customer".
const v2Est = { builder: 'v2', owner: 'Mark Deluca', leadId: 'L1' };
const realLead = { id: 'L1', firstName: 'Mark', lastName: 'Deluca', email: 'm@example.com' };
test('resolveCustomerName: a V2 estimate + a firstName/lastName lead bills the homeowner', () => {
  eq(IP.resolveCustomerName(v2Est, realLead), 'Mark Deluca', 'lead full name');
});
test('resolveCustomerName: the linked lead\'s current name beats the estimate\'s owner snapshot', () => {
  eq(IP.resolveCustomerName({ owner: 'Mark Delucca' }, realLead), 'Mark Deluca', 'lead wins');
});
test('resolveCustomerName: no lead → the estimate\'s owner', () => {
  eq(IP.resolveCustomerName(v2Est, null), 'Mark Deluca', 'owner fallback');
});
test('resolveCustomerName: an explicit customerName still wins; Classic\'s "—" owner is not a name', () => {
  eq(IP.resolveCustomerName({ customerName: 'Jane Roe', owner: 'X' }, realLead), 'Jane Roe', 'explicit');
  eq(IP.resolveCustomerName({ owner: '—' }, null), '', 'dash placeholder → blank (renders "Customer")');
});
test('invoiceCustomerName: an invoice already saved with a blank name resolves its lead at render', () => {
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  const prev = global.window;
  global.window = { _leads: [realLead] };
  try {
    eq(IP.invoiceCustomerName({ customerName: '', leadId: 'L1' }), 'Mark Deluca', 'blank stored name');
    eq(IP.invoiceCustomerName({ customerName: 'Stored Name', leadId: 'L1' }), 'Stored Name', 'stored name kept');
    eq(IP.invoiceCustomerName({ customerName: '', leadId: 'nope' }), '', 'unknown lead → blank');
  } finally {
    if (had) global.window = prev; else delete global.window;
  }
});

console.log('──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
