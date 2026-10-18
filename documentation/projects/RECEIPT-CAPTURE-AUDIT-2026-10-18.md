# Home Depot + Lowe's receipt capture: audit and matching method (2026-10-18)

*Read-only audit. Nothing was downloaded, uploaded or written to the CRM. No customer names, receipts or amounts are in this note (public repo).*

Jo's goal: every Home Depot and Lowe's purchase lands in the CRM as an expense, attached to the right job when we can tell, otherwise parked as unsorted, so overhead and per-job profit are real.

## 1. What is built on main

| Piece | State |
|---|---|
| Home Depot Pro Xtra import ([runbook](../runbooks/HOME-DEPOT-EXPENSES.md)) | **Built and mounted.** Client-side `docs/pro/js/hd-import.js`, loaded by `script-loader.js`, button in Expenses. Not a Cloud Function. Reads the Pro Xtra Summary and Details CSVs, matches job by PO/Job name, review table, writes expenses keyed by `externalRef`, so re-imports skip duplicates. Manual, about monthly, human-in-the-loop. |
| Receipt file on an expense | **Manual only.** "Add receipt" per expense (photo or PDF). The HD import saves `receiptStoragePath: null`. No bulk attach. |
| Receipt OCR (`functions/receipt-vision.js`) | **Built, callable.** Photo/PDF to structured fields, reviewed by a person. Not wired to any inbox or batch. |
| Price book (#2016/#2018) | **Built.** HD imports record last-paid per SKU. Lowe's and Menards are manual entries only. |
| Materials list | **Built** (customer page and dashboard load it). |
| Job profit (`job_profit` MCP tool) | **Built.** Direct costs only count expenses with `leadId` and a direct cost type. |
| Lowe's | **Nothing automatic.** Only a store label in `price-book.js` and `production-logic.js`. No importer, no parser. |

## 2. The real gaps

1. **Costs are almost entirely missing from job profit.** A live read of `job_profit` (last 180 days, 20 finished jobs): 19 of 20 show `costs_logged: false`, and total logged direct cost across all 20 is under $30. Every margin reads about 100%. This is the number to fix.
2. **Matching depends on Jo typing the CRM number in the PO/Job name at checkout.** Receipts with a blank or loose name fall to the "pick a job" list.
3. **Nothing ingests email receipts.** Lowe's Pro receipts and Home Depot order emails exist only as mail.
4. **No receipt image or PDF is stored from the HD import.**
5. **No Lowe's import path** and no verified Lowe's export format.
6. **Returns** are not in the HD export, so spend can read high.

## 3. Where the source data is (counts only)

jdeal.tia@gmail.com (read via Jo's signed-in Chrome, search only):
- **Home Depot Pro Xtra monthly statements:** 4 (June, July, August, September 2026). These are notification emails with no attachment; the statement itself sits behind the Pro Xtra login.
- **Home Depot order emails:** about 14 transactional mails across roughly 5 orders (late June to late August: confirmed, ready/pickup, delivered, "thank you for your pickup order"). Item-level mail only; no totals in the subject line. The rest of the "from Home Depot" mail is surveys, verification codes, perks.
- **Lowe's purchase receipts:** 3 ("Your Lowe's Purchase Receipt", Oct 9, 12, 14). The Lowe's account and Pro Rewards were only created Oct 8, so earlier Lowe's buys were not emailed.
- jonathandeal459@gmail.com: 1 Lowe's account notice, no receipts. iCloud sorter: no purchase receipts.

**Update (Jo, same day): use the store sites directly.** Jo's Chrome is signed in to Home Depot Pro Xtra. Read-only check of Purchase History (25-month filter, table view): the page showed 20 purchases (Aug 6, Sep 10, Oct 4 2026), a 2026 spend tile, and Export / QuickBooks Export / Print / Add Receipt controls, with a PO/Job column on every row. Only 20 rows rendered with no visible pager, so the full count still needs the Export. Lowe's purchase history is not checked yet. Downloading receipts/PDFs needs Jo's per-file yes; Claude never types credentials.

**Implication (email is the weaker source):** email alone is thin. Home Depot's Purchase History export (CSV) is the complete record (Jo's earlier export had 41 receipts; the importer exists for it). Email adds item detail and the Lowe's three.

## 4. Proposed matching method (confidence rule)

Auto-attach only at **HIGH**; everything else goes to an **UNSORTED** list for Jo.

| Confidence | Evidence | Action |
|---|---|---|
| HIGH | PO/Job name contains a CRM number (`NBD-####`) or a name Jo assigned before | Attach to that job |
| HIGH | Shop word (SHOP/STOCK/TOOLS/OFFICE/TRUCK) or tool name | File as overhead, no job |
| MEDIUM (suggest, Jo confirms) | PO name equals a customer name or street; or purchase date inside exactly one job's active window AND the store is near that job | Prefilled in review, not saved |
| MEDIUM | Amount within a plausible range of that job's materials estimate, used only to break ties | Tie-break, never sole evidence |
| LOW | Drone/photo GPS vs lead lat/lng is a tool for old orphaned **photo** sets; it does not apply to receipts (no location on a receipt other than the store) | Not used |
| NONE | No evidence, or two or more candidates | UNSORTED |

Rules: money in cents; one receipt = one job (no splitting); dedupe on `externalRef` (store + date + transaction, or order number, or a Lowe's receipt number); stable key for Lowe's and email-sourced rows too.

## 5. Plan, one PR per piece (nothing started)

1. **Lowe's Pro export importer** in the same review-table shape. Blocked on: does Lowe's give Jo a CSV? Otherwise parse the receipt email text.
2. **Receipt files:** store receipt PDFs/screenshots Jo downloads, and attach by `externalRef` (needs a Storage plan; photos stay private).
3. **UNSORTED view:** list expenses with no `leadId`, with a one-click assign and a "costs missing" flag on finished jobs.
4. Optional: a monthly reminder to export.

Download folder (outside the repo, dated): `Documents\NBD-Receipts\<yyyy>\<yyyy-mm>\<store>\` plus a private manifest CSV. Then a **dry-run report** (per job and unsorted) before any live write, and a read-back after, only on Jo's explicit go.

## 6. Needs from Jo

- Pull the full **Purchase History export** (Summary + Details) from Home Depot Pro Xtra for 2026-01-01 on, and tell me if Lowe's Pro offers an export.
- Confirm: do you want the importer path (CSV, you press Import) or a hands-off email ingest? Recommendation: CSV for completeness, email only for Lowe's.
- Okay to treat past undated/unnamed purchases as UNSORTED rather than guess.
