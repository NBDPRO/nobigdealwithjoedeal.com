# Receipt sorter, piece 2: company-wide job-name memory (2026-10-18)

Part of the receipt-sorter build ([audit](RECEIPT-CAPTURE-AUDIT-2026-10-18.md)).

**Problem:** the Home Depot importer remembers "what job did this PO text mean" (for example a first name Jo typed at the register) in `userSettings/{uid}.hdJobAliases`. That belongs to one person on one login, so a teammate or a second device starts from nothing, and the receipt queue (piece 4) would have the same blind spot.

**Change:**
- New doc `companyAliases/{companyId}` = `{ aliases: { <normalised PO text>: <leadId> }, updatedAt, updatedBy }`.
- Behind the **`receiptSorterAliases`** feature flag (`feature_flags/_default`, absent = off). **Off = the old behaviour exactly** (reads and writes `userSettings` only).
- **On:** load reads the company doc and falls back to the user's legacy map; the company's entries win; the next save writes the merged map to the company doc. That is the one-time migration. The legacy map is left in place as a fallback and is never deleted.
- Entries are cleaned on the way in and out: only a safe lead id string for a key of at most 120 characters.
- `NBDHdImport.loadAliases / saveAliases / mergeAliases / cleanAliases` are exposed for the queue.

**Rules:** `companyAliases/{companyId}`: members of that tenant who are not viewers read and write; only the keys `aliases`, `updatedAt`, `updatedBy`; `aliases` is a map of at most 2000; `updatedBy` must be the caller; delete is admin only. Rules tests: same-tenant read and write pass; other tenant, a viewer, a forged author, a non-map, a stray key and a client delete are all refused. With the rule absent the first write is refused (red).

**Tests:** `tests/hd-aliases-2026-10-18.test.js` (flag off, flag on, migration, hygiene). Break-test: reversing the merge order reddens "company entries win" and "next save writes the MERGED map".

**To turn on:** set `receiptSorterAliases: true` in `feature_flags/_default` after the rules deploy.
