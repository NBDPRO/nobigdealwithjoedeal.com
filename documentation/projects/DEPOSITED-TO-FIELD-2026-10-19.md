# "Deposited to" on payments (2026-10-19)

**Why:** a bank-versus-CRM reconciliation found that a payment records customer, amount, method and date, but not **which account the money landed in**, so some deposits could not be matched automatically. This adds that one optional field. It ships **dark**.

**Flag:** `depositedToField` in `feature_flags/_default` (or per user in `feature_flags/{uid}`). Absent or false = nothing changes anywhere. Turn it on by setting `depositedToField: true` there (same place as `lowesImport` and `receiptSorterAliases`).

**What it does (flag on):**
- Both payment sheets (Record payment on the customer page, Record Payment on an invoice) get a **Deposited to** menu: Chase business, Chase personal, Chime, Cash, Stripe payout, Other (this is a sample list; the keys are `chase_business`, `chase_personal`, `chime`, `cash`, `stripe_payout`, `other`). Default is "Not set".
- The invoice's Payment History shows a **Deposited to** menu on every non-Stripe payment, so an already-recorded payment can be set or changed after the fact. Stripe rows are left alone (the webhook and ledger own them).
- Stored as `depositedTo` on the entry in `invoices/{id}.payments[]`. Old payments have no such key and stay untouched. Amount, date, method, `amountPaid`, `balanceDue` and the collected-revenue logic are not changed by it.

**Flag off:** no menu renders, `markPaid` drops any `depositedTo` it is handed, and the payment write is identical to before (pinned by the test).

**Not included:** there is no payments CSV export in the CRM today, so there is nothing to add the column to yet; the field is plain data on the entry for the reconciliation work to read. No bank account numbers are stored anywhere, only the account label key.

**Files:** `docs/pro/js/invoice-pipeline.js` (helpers, both sheets, history row, edit-in-place, exports), `tests/deposited-to-2026-10-19.test.js` (registered in `tests/ci-manifest.json`).
