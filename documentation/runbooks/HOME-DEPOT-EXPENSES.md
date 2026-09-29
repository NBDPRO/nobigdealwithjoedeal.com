# Home Depot purchases → job expenses

*Written 2026-09-29. Code: `docs/pro/js/hd-import.js`. Test: `tests/hd-import-2026-09-29.test.js`.*

Home Depot Pro Xtra exports your purchase history as a CSV. The CRM imports it into Expenses. Each receipt is matched to the job it was for, so job profit counts real material costs instead of guesses. Nothing is saved until you review the list and press **Import selected**.

## The rules at checkout

These are what make the matching automatic.

1. **Put the customer's CRM number in the PO/Job Name**, for example `NBD-0042 Smith`.
   - The number is on every customer page (the `NBD-####` chip).
   - A receipt carrying it is matched exactly, every time. The last name after it is only for you.
   - Best practice: create the job name ahead of time in Home Depot under **Account › PO/Job Names › Add PO/Job Name**, then pick it from the list at the register or online.
2. **Buying for the shop or a tool? Use a shop word**, not a customer's name:
   - `SHOP` or `STOCK`: materials you're stocking for later. Filed with no job.
   - `TOOLS`: a tool purchase. It is filed as **Tools & Small Equipment** (overhead, not a job cost).
   - A tool's own name ("M18 Combo", "Milwaukee Nail Gun", "Ryobi Vac") is also recognised as a tool buy.
3. **One job per receipt.** If a trip covers two jobs, ring them up as two transactions with two job names. The import can't split one receipt.
4. **Never leave the job name blank.** A blank receipt lands in the review list as "Pick a job".

**Optional:** Home Depot can force rule 1. Under **PO/Job Names › Checkout Settings**, turn on:
- **PO/Job Names are required**
- **Only Admin-created PO/Job Names are allowed**

Then every purchase must use a job you created in advance. You can still edit or add names at any time.

## Importing (about once a month)

1. In Home Depot, go to **Purchase History**. Set the **Date Placed** filter to cover everything since your last import. Overlap is fine, because re-imports are skipped.
2. Click **Export**, choose **Summary Data**, then **Export** again. Optionally do the same with **Details Data**, which adds item lists and helps spot tool buys.
3. In the CRM, go to **Expenses › 🧡 Import Home Depot**, choose the file(s), then **Review purchases**.
4. Check the colours:
   - **Green:** matched by customer number, or by a name you assigned before. Nothing to do.
   - **Amber:** a suggestion from the name or street address. Glance at it.
   - **Red:** pick the job from the dropdown, or choose "No job (overhead / shop)".
5. Press **Import selected**.

The CRM remembers every job name you assign by hand. If "Lora" → Laura Smith's job once, every later "Lora" / "LORA" receipt matches it automatically.

## How it decides

Checked in this order:

| Order | Rule | Result |
|---|---|---|
| 1 | The job name contains a CRM customer number (`NBD-0042`) | That job, exact |
| 2 | You assigned this job name before | That job, remembered |
| 3 | It's a shop word (SHOP, STOCK, TOOLS, OFFICE, TRUCK, ETC…) or names a tool | No job (overhead) |
| 4 | It matches a customer's full name, or their street (with or without the house number; spelling-tolerant) | Suggested job, which you confirm |
| 5 | Nothing matches, or several customers do | You pick |

Every lead has its customer number from the moment it's created, including
website forms, Thumbtack, Cal.com bookings, Thursday calls, referrals and
converted texts (server-side mint, 2026-09-29). Put it in the PO/Job name when
you buy. The one exception is a tenant that has never set its company legal
name. Those leads get their number the first time someone opens the customer page.

**Category:**
- **Tools & Small Equipment** when the job name or the items are tools. Home Depot files power tools under *Hardware*, so tool words decide, not the department.
- **Equipment** (a job cost) only when Home Depot's own department is **TOOL RENTAL**, meaning a real rental.
- **Materials** for everything else.
- You can change any row's category in the review.

**Money:**
- Amount is the pre-tax subtotal.
- Tax is the difference to the total paid, stored separately.
- Supplier is "Home Depot".
- Returns and cancellations are not in Home Depot's export.

**Duplicates:** each receipt is keyed by store + date + transaction number (online orders by order number). A receipt already in Expenses is greyed out and skipped.
