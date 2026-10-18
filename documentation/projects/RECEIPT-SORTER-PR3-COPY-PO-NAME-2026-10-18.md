# Receipt sorter, piece 3: Copy PO name (2026-10-18)

Part of the receipt-sorter build (audit: [RECEIPT-CAPTURE-AUDIT-2026-10-18](RECEIPT-CAPTURE-AUDIT-2026-10-18.md)). Order Jo approved: copy-job-number, keep line items, tenant aliases, review queue, Lowe's importer, UNSORTED badge.

**What:** a "Copy PO name" button beside the customer-number chip on the customer page. It copies `NBD-0042 Smith` (customer number first, last name second; businesses keep their words; no number yet means no copy).

**Why:** the importer matches a receipt to a job exactly when the PO/Job name carries the customer number. In the 2026-10-18 dry run none of 47 Home Depot receipts did. Paste this into Pro Xtra PO/Job Names (Account, PO/Job Names, Add) and the Lowe's PO field.

**Code:** `docs/pro/js/po-name.js` (pure `NBDPoName.poText`, delegated click, clipboard with a textarea fallback); script tag and button in `customer.html`. Later pieces reuse `poText` for the queue card and the Expenses list.

**Test:** `tests/po-name-2026-10-18.test.js`, including a round trip through `hd-import.js` `matchJob` (the pasted text must read back as an exact `code` match). Break-test: removing the number-format check reddens "no customer number → empty" and "a malformed number is rejected".

No data model change, no writes, so no flag.
