# Receipt sorter, piece 6: "are the receipts all in?" (2026-10-18)

Part of the receipt-sorter build ([audit](RECEIPT-CAPTURE-AUDIT-2026-10-18.md)). Independent of the other pieces (it carries its own copy of the "unsorted" rule); it lights up the queue button and the Copy PO name text when those pieces are present.

**Why:** the audit found 19 of the last 20 finished jobs with no cost logged at all, so job profit read about 100% margin. Nothing in the CRM said so.

**What (Expenses, read-only, no flag because it writes nothing):**
- **UNSORTED:** a chip on every store receipt that has no job and was not marked overhead (reviewState `unsorted` / `suggested`, or an older Home Depot / Lowe's import with no job), and a panel line "N store receipts have no job yet" with a **Sort them** button when the receipt-sorter queue is on.
- **COSTS MISSING:** finished (won-stage) jobs with no direct cost on the books. Overhead-only, deleted and zero-dollar expenses do not count as a job cost. The panel lists up to six and says how many more.
- **Jobs in progress:** a collapsible list (contract signed, install, materials, scheduled, production, permit, supplement stages, with a customer number) with a **Copy PO name** button per job, so the number goes into the PO field at checkout. The stage match is a name heuristic: custom pipelines may need their stage keys added.

**Code:** `docs/pro/js/receipt-health.js` (pure functions + panel), `docs/pro/css/receipt-health.css`, two one-line hooks in `expenses.js`, loaded with the expenses bundle.

**Tests:** `tests/receipt-health-2026-10-18.test.js` (15 checks; counting overhead expenses as job costs reddens two). `tests/e2e/phone-receipt-health.spec.js` (`@phonefit @audit`, 360 and 412 px, no server: nothing past the right edge, controls at least 40px, Copy PO name copies "NBD-#### Name"). Ran on local Chrome, passing.

**Not yet verified:** the panel inside the real signed-in Expenses view on an installed iPhone.
