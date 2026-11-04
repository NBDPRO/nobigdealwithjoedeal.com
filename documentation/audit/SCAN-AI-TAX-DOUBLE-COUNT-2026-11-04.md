# Scan with AI counted sales tax twice (2026-11-04)

Status: fix on a DRAFT PR, not merged. It touches money computation, so it waits for Jo.

## The bug (confirmed, not just suspected)

- `functions/receipt-vision.js` returns `extracted.{subtotalCents, taxCents, totalCents}`. `totalCents` is the grand total actually paid (prompt: "grand total actually paid").
- Old `applyExtraction` in `docs/pro/js/expenses.js` put `totalCents` in the Amount field and `taxCents` in the Sales Tax field.
- `createExpense` stores those as `amountCents` and `taxCents` unchanged.
- Every cost rollup adds them: `ExpenseConfig.signedCents` (`expense-config.js`, used by the Expenses cards, per-supplier and per-category and per-job totals and the CSV export), `profit-tracker.js` (job margin), `money-dashboard.js`, `job-cost-audit-logic.js`, `month-close-logic.js`, and the 1099 rollup (pre-tax by design: it reads Amount only, so an old scanned row put the tax into a supplier 1099 total as well).
- The Home Depot import (`hd-import.js`) stores `amountCents = total - tax`, `taxCents = tax`: pre-tax in Amount.

So a scanned receipt of subtotal 100.00 + tax 7.00 = total 107.00 rolled up as 114.00. Reproduced by `tests/scan-ai-tax-2026-11-04.test.js` against the old code (got 11400, wanted 10700).

## The fix

`receiptPrefill()` in `expenses.js` (exported as `Expenses.receiptPrefill`) decides what the scan puts in the form:

- Amount = grand total minus tax (pre-tax), Tax = tax. Amount + Tax = the receipt total, matching the Home Depot import.
- No tax on the receipt: Amount = total, Tax blank (unchanged).
- Total unreadable but subtotal readable: Amount = subtotal, Tax = tax.
- Tax >= total (impossible): Amount = total, Tax blank, flagged.
- Reconcile: if subtotal is present and `subtotal + tax` differs from `total` by more than 2 cents, the scan is marked `needsReview` (saved on the expense as before) and the status line says "subtotal + tax doesn't equal the total". This is in addition to the existing server check (line items + tax vs total).
- The "scanned" status now says the Amount is before tax.

## Limits

- Existing saved expenses are not changed and are read exactly as before. Any receipt already scanned and saved with the old behaviour still reads high by its sales tax. Finding those is a data question for Jo (source = `ocr`, taxCents > 0, amountCents equal to the receipt total); this PR does not touch data.
- Manual entry is unchanged. If someone types a tax-inclusive total into Amount AND a tax into Sales Tax by hand, tax still counts twice. Only the AI prefill changed. The field labels say Amount ($) and Sales Tax ($); a clearer manual-entry hint is a separate product choice.
- When the reader gets only the total wrong while the subtotal is right, the check catches it. When it misreads both consistently, nothing can catch it; the user still reviews every scan before Save.
- Not run against a real receipt or a real browser. Tests use synthetic numbers and a stub form.
