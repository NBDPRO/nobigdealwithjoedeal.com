# Cash paid out log (flag `cashPayoutsLog`), 2026-10-19

Why: a bank-statement review found crew cash withdrawals the CRM could not see,
and finished jobs with no costs logged, so job profit read too high. Cash
payouts to crew / subs are now logged per job. Ships dark.

## Recon (what already carried this)

- `/expenses` already has a DIRECT category `subcontractor` and a `leadId`
  link (`docs/pro/js/expense-config.js`). Job profit
  (`ProfitTracker.computeJobPLWithExpenses`), the Expenses by-job table, the
  receipt-health "COSTS MISSING" check and the agent `job_profit` tool
  (`functions/agent-mcp-logic.js`) all read direct expenses by `leadId`. So
  **no new collection**: a payout is an expense doc.
- Unlinked direct expenses reach no job. They were only a warning toast and the
  money dashboard's "untied" list, so the new panel keeps a visible counter.
- Voiding: money-dashboard, receipt-health and `job_profit` already skip
  `deleted === true`; `computeJobPLWithExpenses`, `Expenses.aggregate`'s loader
  and the customer cost panel did not, so this PR adds that skip.

## Shape of a payout doc

`category: 'subcontractor'`, `costType: 'direct'`, `source: 'cash_payout'`,
`supplier` = payee, `paymentMethod` = cash | zelle | check | other,
`amountCents` (int), `date`, optional `leadId` / `jobId`, `note`,
`editLog` (max 25 entries `{at, by, what, note}`). Void = `deleted: true` plus
an `editLog` entry with a required note; the row is kept.

## What changed

- `docs/pro/js/cash-payouts.js`, `docs/pro/css/cash-payouts.css`: panel on
  Expenses (totals, per month, per job, "Unassigned crew cash" counter, newest
  first), one-thumb sheet (amount, payee with remembered names, method pills,
  job, date, note), edit and void with a required note. Viewer: read only.
  Edit / void shown only on your own rows (rules allow the writer or platform
  admin to update). No hard delete from this UI.
- Wired in `expenses.js` (button, panel, drop voided rows on load),
  `profit-tracker.js` (skip voided), `script-loader.js` (expenses bundle).
- `firestore.rules`: `validExpenseMoney` validates `paymentMethod` and bounds
  `editLog`. Cases in `tests/firestore-rules.test.js`.
- `tests/cash-payouts-2026-10-19.test.js` (in the node bucket), mutation-checked.

## Turning it on and trying it

Flip `cashPayoutsLog: true` in `feature_flags/_default` (or `feature_flags/{uid}`
for just one person) in the Firebase console. Reload Pro, Expenses: a "Cash paid
out" card and a "Log payout" button appear. The assistant cannot write
production flags.

## Not done / follow-ups

- A company_admin cannot void a rep's payout (rules limit update to the writer
  or platform admin, same as every expense).
- Voided rows are hidden everywhere; the audit note lives on the Firestore doc.
- The functions-side readers outside `job_profit` (monthly overhead digest) were
  not audited for `deleted`; they only matter for voided payouts.
- Existing past cash (the May to Sep withdrawals) still has to be entered by
  hand, per job, from Jo's records.
