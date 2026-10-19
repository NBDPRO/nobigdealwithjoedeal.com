# Receipt sorter, piece 5: Lowe's Pro import (2026-10-18)

Part of the receipt-sorter build ([audit](RECEIPT-CAPTURE-AUDIT-2026-10-18.md)). Independent of the other pieces; it uses the Home Depot importer's matcher (`NBDHdImport.matchJob`) as it is on main, and picks up the company job-name memory automatically once that piece (company aliases) has merged.

**Source:** Lowe's Pro › My Purchase History › Export Purchase History (date range, Request Report, Download). One CSV, **one row per order, no line items**. Jo started Lowe's Pro tracking on 2026-10-08, so history before that does not exist in the export.

**What it does:** Expenses › **Import Lowe's** (flag `lowesImport`, off when absent; off = no button, nothing runs). The same review-table shape as the Home Depot import: date and store, PO/Job name (first-class, bold) with the match badge and reason, order number, total with tax, a job menu, a category menu. Nothing saves until **Import selected**.

**Matching (the Home Depot rules):** customer number in the PO → exact; remembered name → exact; shop or tool words → overhead; name or street → a suggestion; otherwise unsorted (the receipt sorter takes those). The PO Number column is the job name; if it is "N/A", the Project Name column is used.

**Saved fields:** `source: import_lowes`, `externalRef: lw-o-<order #>` (the same file twice selects nothing), `storeNumber` (the **Fulfillment Store #**), `orderNumber`, `poJobName`, amount pre-tax with tax separate in cents, `reviewState`, `matchEvidence`, `itemCount: 0`, note "order total only". Cancelled, returned, refunded and voided orders are skipped.

**Privacy:** the export carries the purchaser's email, phone and card digits. Those columns are never read into a receipt and the raw text is never kept; the test fails if any of them reaches the saved document.

**Tests:** `tests/lowes-import-2026-10-18.test.js` (21 checks, synthetic export with Lowe's real column headers and its legend line). Break-tests: adding the email column to a parsed order reddens the privacy check; dropping the cancelled-order filter reddens two.

**Not verified:** the review table in the real authed dashboard on a phone; a run against Jo's real export (the dry run reads it through this importer first, with Jo).
