/**
 * invoice-adds-up-2026-10-07.test.js — "Bills add up" (ho-money audit
 * 2026-10-07, H1 + H5 + M6 + M8).
 *
 * The bugs, seen on the emulator with the real functions:
 *   - H1: the invoice EMAIL (InvoicePipeline.buildInvoiceHtml) printed the
 *     items and then "Total" — no Sales tax row. A $13,675 job's lines summed
 *     to $12,780.09 (the $894.91 tax was never printed); a $500 repair's to
 *     $497.42; a per-SQ Elite job read "Roofing system — Elite tier
 *     $22,102.80" over a $23,650.00 total.
 *   - H5: the estimate link measured Rounding from the printed lines, the
 *     invoice from the saved subtotal, so a KY job read "Rounding −$4.96" on
 *     the estimate link and "−$4.95" on the invoice.
 *   - M8: $0 catalog lines printed as "0.00 LF $0".
 *   - M6: the email named no invoice number and never said "Due now"; the
 *     orange row was "Total owed" while Pay Online charged the deposit.
 *
 * THE ROUNDING RULE (one rule, in whole cents): tax = the saved tax rounded
 * to the cent; base = the printed lines' cents when within 100¢ of the saved
 * subtotal, else the subtotal's; Rounding = price − base − tax. It lives in
 * NBDCustomerEstimateRows.footingRows (customer-estimate-rows.js); the
 * estimate link, the e-sign contract, invoiceTotalsFromEstimate (browser +
 * server copy) and invoiceDisplayRows (email, in-app invoice, NBD-500 PDF)
 * all call it.
 *
 * Behaviour tests over the REAL renderers: the browser invoice-pipeline.js
 * (buildInvoiceHtml, invoiceTotalsFromEstimate, invoiceDisplayRows), the
 * server copy functions/invoice-from-estimate.js, the estimate link's row
 * builder (functions/customer-estimate-rows.js buildDisplayRows, which
 * functions/portal.js getEstimateForView prints) and the NBD-500 payload
 * (functions/money-paper-logic.js invoicePayload). Synthetic data only; no
 * email is sent (buildInvoiceHtml only returns a string).
 *
 * Run: node tests/invoice-adds-up-2026-10-07.test.js
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function req(p) {
  try { return require(path.join(ROOT, p)); }
  catch (e) { ok('loads ' + p, false, e && e.message); return null; }
}

const CER = req('functions/customer-estimate-rows.js');
const IFE = req('functions/invoice-from-estimate.js');
const MPL = req('functions/money-paper-logic.js');
global.window = {};
const IP = req('docs/pro/js/invoice-pipeline.js');

const cents = (n) => Math.round(Number(n) * 100);
const money = (s) => {
  const m = String(s).replace(/&minus;|−/g, '-').match(/(-)?\$?(-)?([\d,]+\.\d{2})/);
  return m ? (m[1] || m[2] ? -1 : 1) * Math.round(parseFloat(m[3].replace(/,/g, '')) * 100) : null;
};
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/**
 * Read the email's money table the way a homeowner does: every row above
 * "Total" that is not a running total (Subtotal / Job total) is a summand.
 * Works on the old builder too (items, then "Total:"), so the same parse
 * proves the bug on origin/main.
 */
function readEmail(html) {
  const body = String(html).split('<tbody>')[1].split('</tbody>')[0];
  const trs = body.match(/<tr[\s\S]*?<\/tr>/g) || [];
  const out = { summands: [], labels: [], total: null, after: [] };
  let seenTotal = false;
  trs.forEach((tr) => {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(text);
    if (!cells.length) return;
    const label = cells[0].replace(/:$/, '');
    const amt = money(cells[cells.length - 1]);
    if (seenTotal) { out.after.push({ label, amt, strong: /font-weight:\s*700|class="duenow"/.test(tr), tr }); return; }
    if (/^Total$/i.test(label)) { out.total = amt; seenTotal = true; return; }
    out.labels.push({ label, amt, cells: cells.length });
    if (/^(Subtotal|Job total)$/i.test(label)) return;
    out.summands.push({ label, amt });
  });
  out.sumC = out.summands.reduce((s, r) => s + (r.amt || 0), 0);
  return out;
}

// ── The audit's shapes (synthetic, same money) ─────────────────────────
const zeroRows = Array.from({ length: 11 }, (_, i) => ({ desc: 'Unused catalog line ' + (i + 1), qty: '0.00 LF', retailTotal: 0, total: 0 }));

// 1. Cash < $2k: a $500 shingle-patch repair, job minimum, no deposit.
//    Lines $497.42 + tax $2.58 = $500.00.
const SHAPE1 = {
  priceMode: 'line-item', taxRate: 0.07, minJobApplied: true,
  rows: [
    { desc: 'Shingle patch — materials', qty: '1 EA', retailTotal: 36.86 },
    { desc: 'Shingle patch — labor', qty: '1 EA', retailTotal: 460.56 },
  ].concat(zeroRows.slice(0, 3)),
  subtotal: 497.42, tax: 2.58, grandTotal: 500, total: 500,
};
// 2. Cash $2k+: $13,675 with $894.91 tax, Rounding, a $6,850 deposit. The
//    engine's per-row rounding left the lines ($12,784.40) a cent above the
//    saved subtotal ($12,784.39) — the shape that put the estimate link and
//    the invoice a cent apart. 11 of the lines are $0 (LF left at 0).
const SHAPE2 = {
  priceMode: 'line-item', taxRate: 0.07, minJobApplied: false,
  rows: [
    { desc: 'Tear off 1 layer', qty: '27.60 SQ', retailTotal: 3196.10 },
    { desc: 'Shingles — architectural', qty: '27.60 SQ', retailTotal: 3196.10 },
    { desc: 'Underlayment + ice & water', qty: '27.60 SQ', retailTotal: 3196.10 },
    { desc: 'Install labor', qty: '27.60 SQ', retailTotal: 3196.10 },
  ].concat(zeroRows),
  subtotal: 12784.39, tax: 894.91, grandTotal: 13675, total: 13675,
};
// 3. Tiered per-SQ, homeowner picked Elite: $23,650 at 7%.
const SHAPE3 = {
  priceMode: 'per-sq', taxRate: 0.07, selectedTier: 'best',
  prices: { economy: 15800, good: 17900, better: 20400, best: 23650, beyond: 26900 },
  rows: [{ desc: 'internal cost line', qty: '27.6 SQ', total: 9999 }],
  grandTotal: 23650, total: 23650,
};
// KY insurance (untaxed): lines $13,254.96, subtotal $13,254.95, price
// $13,250 → estimate link "Rounding −$4.96", old invoice "−$4.95".
const SHAPE_KY = {
  priceMode: 'line-item', taxRate: 0, minJobApplied: false,
  rows: [
    { desc: 'Roof replacement per scope', qty: '1 EA', retailTotal: 6627.48 },
    { desc: 'Install labor', qty: '1 EA', retailTotal: 6627.48 },
  ],
  subtotal: 13254.95, tax: 0, grandTotal: 13250, total: 13250,
};

const OPTS = CER ? { estimateValue: CER.estimateValue } : {};
// The invoice createInvoiceFromEstimate writes for this estimate (no
// supplements, no earlier invoices): invoiceTotalsFromEstimate + deposit.
function invoiceFor(M, est, extra) {
  const t = M.invoiceTotalsFromEstimate(est, OPTS);
  return Object.assign({
    items: t.items, subtotal: t.subtotal, tax: t.tax, taxRate: t.taxRate, total: t.total,
    depositAmount: 0, depositPaid: false, amountPaid: 0, balanceDue: t.total,
    customerName: 'Pat Homeowner', terms: 'Net 7', status: 'sent',
  }, extra || {});
}
function estimateLinkRounding(est) {
  const r = CER.buildDisplayRows(est).filter((x) => x.code === 'ADJ')[0];
  return r ? cents(r.total) : 0;
}

const SHAPES = [
  { name: 'shape 1 ($500 repair, no deposit)', est: SHAPE1, total: 50000, tax: 258, extra: {} },
  { name: 'shape 2 ($13,675, tax + rounding, $6,850 deposit)', est: SHAPE2, total: 1367500, tax: 89491, extra: { depositAmount: 6850 } },
  { name: 'shape 3 (per-SQ Elite $23,650)', est: SHAPE3, total: 2365000, tax: 154720, extra: { depositAmount: 11825 } },
  { name: 'KY insurance ($13,250, untaxed)', est: SHAPE_KY, total: 1325000, tax: 0, extra: {} },
];

(async () => {
  if (!IP || !IFE || !CER || !MPL) { console.log('\n  modules failed to load'); process.exit(1); }

  console.log('\n1. the emailed invoice\'s rows add up to its total (buildInvoiceHtml)');
  SHAPES.forEach((s) => {
    const inv = invoiceFor(IP, s.est, s.extra);
    const html = IP.buildInvoiceHtml(inv, { payUrl: 'https://pay.example.test/x', zelle: '', invoiceId: 'inv1' });
    const e = readEmail(html);
    ok(s.name + ': prints Total ' + (s.total / 100).toFixed(2), e.total === s.total, 'Total row = ' + e.total);
    ok(s.name + ': Σ printed rows === Total (lines + tax + rounding)', e.sumC === s.total,
      'rows sum to ' + (e.sumC / 100).toFixed(2) + ' — ' + e.summands.map((r) => r.label + ' ' + (r.amt / 100).toFixed(2)).join(' | '));
    if (s.tax) {
      const taxRow = e.summands.filter((r) => /^Sales tax/.test(r.label))[0];
      ok(s.name + ': prints a Sales tax row of ' + (s.tax / 100).toFixed(2), !!taxRow && taxRow.amt === s.tax, taxRow ? taxRow.label + ' ' + taxRow.amt : 'no Sales tax row');
    }
    ok(s.name + ': no $0 line is printed', e.labels.every((r) => r.amt !== 0), e.labels.filter((r) => r.amt === 0).map((r) => r.label).join(', '));
  });
  {
    const e = readEmail(IP.buildInvoiceHtml(invoiceFor(IP, SHAPE3, {}), {}));
    ok('shape 3: the summary line is the tier price before tax, then Sales tax (7%) — both printed',
      e.summands.length === 2 && /Elite tier/.test(e.summands[0].label) && e.summands[0].amt === 2210280 && /^Sales tax \(7%\)$/.test(e.summands[1].label),
      JSON.stringify(e.summands));
  }

  console.log('\n2. one rounding rule: estimate link === invoice, to the cent');
  [['shape 2', SHAPE2, -431], ['KY insurance', SHAPE_KY, -496]].forEach(([name, est, want]) => {
    const link = estimateLinkRounding(est);
    ok(name + ': estimate link Rounding is ' + (want / 100).toFixed(2), link === want, 'link = ' + link);
    [['browser', IP], ['server', IFE]].forEach(([which, M]) => {
      const t = M.invoiceTotalsFromEstimate(est, OPTS);
      const adj = t.items.filter((i) => i.adjustment === true)[0];
      ok(name + ': ' + which + ' invoice Rounding line === estimate link (' + (link / 100).toFixed(2) + ')',
        !!adj && cents(adj.total) === link, 'invoice adjustment = ' + (adj ? adj.total : 'none'));
      const foot = t.items.reduce((s, i) => s + cents(i.total), 0) + cents(t.tax);
      ok(name + ': ' + which + ' invoice items + tax === total (what the pay link checks)', foot === cents(t.total), foot + ' vs ' + cents(t.total));
      ok(name + ': ' + which + ' invoice subtotal + tax + rounding === total', cents(t.subtotal) + cents(t.tax) + (adj ? cents(adj.total) : 0) === cents(t.total));
    });
    const e = readEmail(IP.buildInvoiceHtml(invoiceFor(IP, est, {}), {}));
    const row = e.summands.filter((r) => r.label === 'Rounding')[0];
    ok(name + ': the emailed invoice prints Rounding ' + (link / 100).toFixed(2), !!row && row.amt === link, row ? String(row.amt) : 'no Rounding row');
  });
  {
    // An invoice saved BEFORE the rule (Rounding measured from the subtotal,
    // a cent off): the email prints the corrected cent, so it still adds up.
    const legacy = invoiceFor(IP, SHAPE_KY, {});
    legacy.items = legacy.items.map((i) => (i.adjustment ? Object.assign({}, i, { total: -4.95, unitPrice: -4.95 }) : i));
    legacy.subtotal = 13254.95;
    const rows = IP.invoiceDisplayRows(legacy);
    const sum = rows.filter((r) => ['line', 'tax', 'adjustment', 'credit'].indexOf(r.kind) >= 0).reduce((s, r) => s + cents(r.amount), 0);
    const total = rows.filter((r) => r.kind === 'total')[0];
    ok('a pre-rule invoice (−$4.95 saved) still prints rows that add up, Rounding −$4.96',
      sum === cents(total.amount) && rows.some((r) => r.kind === 'adjustment' && cents(r.amount) === -496), JSON.stringify(rows.slice(-3)));
  }
  ok('browser and server invoice builders agree on every shape',
    SHAPES.every((s) => JSON.stringify(IP.invoiceTotalsFromEstimate(s.est, OPTS)) === JSON.stringify(IFE.invoiceTotalsFromEstimate(s.est, OPTS))));
  ok('invoice data carries no $0 line (it also blocked the pay link\'s $1 floor)',
    SHAPES.every((s) => IP.invoiceTotalsFromEstimate(s.est, OPTS).items.every((i) => cents(i.total) !== 0)));

  console.log('\n3. a FINAL invoice (deposit credited) still adds up');
  {
    const base = IP.invoiceTotalsFromEstimate(SHAPE2, OPTS);
    // applyJobCredits: the server copy (byte-identical nbd:job-billing block).
    const credited = IFE.applyJobCredits(base, [{ invoiceId: 'dep1', label: 'Less deposit paid', cents: 685000, paid: true }]);
    const inv = Object.assign({ taxRate: base.taxRate, subtotal: base.subtotal, tax: base.tax, amountPaid: 0, depositAmount: 0, balanceDue: credited.total }, credited);
    const e = readEmail(IP.buildInvoiceHtml(inv, { payUrl: 'https://pay.example.test/x' }));
    ok('final invoice: Σ lines + tax + rounding − deposit credit === Total $6,825.00', e.total === 682500 && e.sumC === 682500,
      'total ' + e.total + ', sum ' + e.sumC);
    ok('final invoice: shows the Job total before the credit', e.labels.some((r) => r.label === 'Job total' && r.amt === 1367500));
    const pay = MPL.invoicePayload(inv, null, 'NBD-2026-1007-0003', Date.UTC(2026, 9, 7, 16), null);
    const pdfSum = pay.lines.reduce((s, l) => s + cents(l.lineTotal), 0) + cents(pay.tax) + cents(pay.rounding)
      - pay.credits.reduce((s, c) => s + cents(c.amountAbs), 0);
    ok('NBD-500 PDF payload: lines + Tax + Rounding − credits === its total', pdfSum === cents(pay.total) && cents(pay.total) === 682500,
      'pdf sum ' + pdfSum + ' total ' + cents(pay.total));
    ok('NBD-500 PDF payload: Subtotal is the lines (not the rounding + credits mixed in)',
      cents(pay.subtotal) === pay.lines.reduce((s, l) => s + cents(l.lineTotal), 0) && cents(pay.subtotal) === 1278440);
  }
  SHAPES.forEach((s) => {
    const inv = invoiceFor(IP, s.est, s.extra);
    const pay = MPL.invoicePayload(inv, null, 'NBD-2026-1007-0001', Date.UTC(2026, 9, 7, 16), null);
    const sum = pay.lines.reduce((t, l) => t + cents(l.lineTotal), 0) + cents(pay.tax) + cents(pay.rounding);
    ok(s.name + ': NBD-500 PDF rows add up to ' + (s.total / 100).toFixed(2), sum === s.total && cents(pay.total) === s.total, sum + ' vs ' + cents(pay.total));
  });

  console.log('\n4. invoice number, greeting, and a clear "Due now"');
  {
    const inv = invoiceFor(IP, SHAPE2, { depositAmount: 6850, invoiceNumber: 'NBD-2026-1007-0003' });
    const html = IP.buildInvoiceHtml(inv, { payUrl: 'https://pay.example.test/x', invoiceId: 'abc123' });
    const e = readEmail(html);
    ok('names the invoice number', /Invoice NBD-2026-1007-0003/.test(text(html)));
    ok('greets the homeowner by name', /Hello Pat,/.test(text(html)));
    ok('no "converted to an invoice" jargon', !/converted to an invoice/.test(html));
    const due = e.after.filter((r) => r.label === 'Due now')[0];
    ok('"Due now: $6,850.00" — what Pay Online charges (the deposit)', !!due && due.amt === 685000, JSON.stringify(e.after.map((r) => r.label + ' ' + r.amt)));
    ok('"Due now" is the only emphasised row (Total owed is not the orange ask)',
      e.after.filter((r) => r.strong).map((r) => r.label).join() === 'Due now', e.after.filter((r) => r.strong).map((r) => r.label).join());
    const held = IP.buildInvoiceHtml(invoiceFor(IP, SHAPE_KY, {}), { payUrl: '', zelle: '' });
    ok('KY hold (no link, no Zelle): no "Due now" is demanded', !/Due now/.test(held));
    const nodep = readEmail(IP.buildInvoiceHtml(invoiceFor(IP, SHAPE1, {}), { zelle: '(859) 420-7382' }));
    ok('no deposit: "Due now" is the total', nodep.after.some((r) => r.label === 'Due now' && r.amt === 50000));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
