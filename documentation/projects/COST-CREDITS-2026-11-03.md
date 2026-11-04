# Cost credits, refunds, returns and adjustments (flag `costCredits`), 2026-11-03

Why: Jo tried to import a supplier credit memo (-$1,017.84, ABC Supply) and the
CRM refused it ("Bad amount (a positive number like 125.50)"). Costs are stored
as positive amounts only, so a credit, a refund or a return had nowhere to go
except editing or deleting the original cost, which rewrites history. Ships
dark behind the flag; with it off nothing changes.

## Rule of the design

**Append-only.** A credit is its own dated `/expenses` row. The original cost
is never deleted or edited to make a credit fit. `amountCents` stays POSITIVE
on every row; `entryType` says which way the row moves the totals.

## Fields on `expenses/{id}`

| field | values | notes |
|---|---|---|
| `entryType` | `cost` (default, absent = cost) / `credit` / `adjustment` | write-once (rules) |
| `relatedExpenseId` | string, <= 128 chars | optional; must be an existing row in the SAME tenant; write-once |
| `creditRef` | string, <= 80 | credit memo / RMA number |
| `reason` | string, <= 500 | why |

- `cost`: adds to spend.
- `credit`: refund, return, credit memo or vendor rebate. SUBTRACTS from spend,
  tax included (a credit memo returns the tax).
- `adjustment`: a correction that ADDS (a charge the original entry missed). A
  downward correction is a credit.

Sign rule in one place: `ExpenseConfig.signedCents(e, withTax)` in
`docs/pro/js/expense-config.js`. Files that cannot load it inline the same
one-liner (`e.entryType === 'credit' ? -1 : 1`). Server copy:
`expenseSignedCents` in `functions/agent-mcp-logic.js`.

## The sign is data-driven, not flag-driven

The flag gates CREATING credits (form picker, CSV import `entryType` column, CSV
export columns). It does NOT gate reading them: a credit row that exists always
nets out of every total. Otherwise turning the flag off would silently overstate
spend. With no credit rows in the ledger every number is identical to before.

## Where credits are netted

Client: Expenses summary cards, spend by supplier, spend by category, cost and
margin by job, lead spend (marketing), 1099 subcontractor totals (worklist and
CSV), `ProfitTracker.computeJobPLWithExpenses`, customer page job cost line
(`customer-jobs.js`), Analytics KPI expense metrics, Lead Source ROI marketing
fallback, Money dashboard (`computePnL` spent / COGS / overhead / suppliers /
1099, month close), Month close (`month-close-logic.js`), Job cost auditor,
Sub payments sorter, Sub paperwork (1099 prep), Costs needed list, Receipt
health "costs missing" (a credit never makes a job "costed").

Server (read-only agent / MCP and cron): `job_profit`, `margin_review`,
`lead_sources` (`agent-mcp-logic.js`), the monthly overhead email
(`monthly-overhead-logic.js`, `monthly-overhead-alert.js`).

## Credits larger than costs

Never clamped to $0 and never hidden. The figure goes negative and is flagged:
`creditsExceed` on the Expenses aggregate (ledger, supplier, category, job), a
warning line in the UI, `creditsExceedCosts` + `creditsExceedBuckets` on the
margin engine, "credits exceed costs" on the customer job cost line,
`credits_exceed_costs` on the agent `job_profit` rows, a warning line in the
monthly overhead email (which also no longer skips a negative month).

## Form, import, export

- Log Expense: "Entry type" picker (cost / credit / adjustment) when the flag
  is on. Credit and adjustment show credit memo #, related cost and reason.
  Amount is typed positive. `paidFrom` is not required for a credit. A credit
  never repeats on a schedule and mileage cannot be a credit. The duplicate
  guard compares entry type, so a refund is not a "duplicate" of the charge.
- Bulk CSV import (needs flag `costsPaidFrom` as before): optional columns
  `entryType` (cost | credit | adjustment, blank = cost), `creditRef`,
  `reason`, `relatedExpenseId`. The `amount` column stays positive: zero and
  negative amounts are still rejected (the message points at `entryType`). A
  credit row with the flag off is REJECTED, never read as a cost. The preview
  has a Type column; approve / reject stays per row, no approve-all.
- CSV export (flag on): Entry Type, Related, Credit Ref, Reason columns, and
  Amount / Sales Tax are SIGNED (a credit exports negative) so a plain SUM is
  right. Flag off: the file is byte-for-byte the old shape.

## Rules (`firestore.rules`, `validExpenseEntryType`)

`entryType` in the 3-word enum; a credit or adjustment must have `amountCents >
0`; `relatedExpenseId` <= 128 chars, exists, same `companyId`; `creditRef` <= 80,
`reason` <= 500; `entryType` and `relatedExpenseId` cannot change on update.
Tests: `tests/firestore-rules.test.js` (`cr-*`), `tests/firestore-rules.cross-tenant.test.js`
(`expenses credit:`), logic in `tests/cost-credits-2026-11-03.test.js`.

## Turning it on

`feature_flags/_default` (or per user): `costCredits: true`. Absent = off.
Credit import also needs `costsPaidFrom` on, because that is the flag that shows
the import button.

## How to record Jo's example

Amount 1017.84, entryType credit, vendor ABC Supply, job Jen Stith, creditRef =
the credit memo number, relatedExpenseId = the original invoice row if known.
