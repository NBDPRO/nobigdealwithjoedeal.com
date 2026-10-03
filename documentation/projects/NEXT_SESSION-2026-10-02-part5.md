# NEXT_SESSION — 2026-10-02 part 5 (the 10-02 night: bot keys fixed, back to the CRM)

Follows [part 4](NEXT_SESSION-2026-10-02-part4.md). Jo was at the PC for the
key rewire, then said "keep working on the crm" and answered decisions live.

## §0 Read first

- **Bots crossed keys on reconnect. It is fixed.**
  - The cause: every bot named its MCP server "NBD CRM", so the shared local
    `mcp-remote` entry and its auth cache held whichever key was written last.
    Chief of Staff's and Tucker's secrets held Priya's key.
  - The fix: each bot now has a unique server name ("NBD CRM — <Bot>") and a
    unique secret name ("NBD CRM key v2 (<Bot>)", "Jo Tracker key (Coach)").
  - Tucker also needed Quinn's pattern (a private header file plus a unique
    port), because the host kept serving the cached key.
  - Exactly **10 keys**, one per bot; the old ones are revoked.
  - Every bot's tools/list was checked against `BOTS`. Coach has
    `my_today`/`my_week`/`my_reviews`; Finance Board has
    `my_week`/`my_reviews`/`my_money`. Neither has CRM tools.
  - The Connect bots **Revoke link acts with no confirm dialog**. Re-find the
    rows after each click.
- **The Firestore emulator never enforces composite indexes.** callWatch
  passed every emulator test, then its first prod run failed with
  FAILED_PRECONDITION (#2042).
  - Tie each new range query to `firestore.indexes.json` in a test.
  - Read the logs after a scheduled function's first prod run.
- **Restyle proof, stronger form: the in-place swap check.**
  1. For every rendered element with the new prefix, snapshot its computed
     style.
  2. Swap its classes back to the old inline style and snapshot again.
  3. Compare the two snapshots.
  - Elements that don't render get a synthetic element, measured **alone**:
    siblings trip `:last-child` rules.
  - Positive control: +1px on one rule must turn the check red.
  - Email and print builders keep their inline styles. reskin.js has
    `skipLines` for exactly this (`buildInvoiceHtml`).
- **Phone E2E gotchas.**
  - Modals pop in with a scale animation. Measure only after
    `document.getAnimations()` settles: 44px fields read 40 mid-pop.
  - The dashboard's `window.PhotoEngine` is a load-then-run **stub** until
    the photos bundle loads. Its `uploadFromFile` returns nothing.
  - "A + B = owed" identities can hold by construction. Pin exact values,
    and break-test the assertion that matters.

## §1 What shipped (#2039–#2049)

- **#2039** Money tab (tracker) plus Finance Board `my_money`.
- **#2037** Part 4 handoff.
- **#2041 / #2043 / #2044 / #2045** Reskin, JS screens 8–11: supplement
  (`sx-*`), product library (`plx-*`), customer-page panels (`cbx-*`), and
  invoices (`ipx-*`). Invoices skips the homeowner email body. The ratchet
  went from 3585 to 3305.
- **#2042** callWatch range queries order desc to use the deployed indexes.
- **#2046** V3 wizard on a phone:
  - Insurance / line-item Package cards said "—" on 4 of 5 tiers. They now
    say "Tap to price", with a line pointing at Per-SQ for cash jobs.
  - The Photos step gets **📷 Add photos** (PhotoEngine upload to the
    customer, ticked onto the estimate).
  - New `phone-v3-wizard.spec.js` (iPhone, standalone): full roof including
    a real photo and Save, cash Per-SQ with 5 ascending prices, and a repair.
- **#2047** Bold **Total owed** on invoices while the deposit is part-paid
  (Jo). Part-paid invoices read **partial**, not "draft"; that status was
  missing from the customer page's allow-list, so even Stripe partials
  showed as draft. The customer-page row shows "$X owed". New
  `phone-invoice-pay.spec.js`.
- **#2048** phone-fit covers 9 more views (Call Center, Job Templates,
  referrals, win-back, academy, AI views). All of them already fit.
- **#2049** **"Needs you" counts people** (Jo: "group them by customer"):
  Home banner, Call Center (one card per person, "✓ Handled (all N)"), and
  the callWatch alert. Prod: 78 calls became 58 people. Memory:
  calls-need-you-counts-people.

## §2 Jo's open items

- Open the Daily tracker once, so Coach sees today's floors.
- Enter the money numbers in the money tab. Finance Board sees no plan yet.
- The V3 iPhone test, now with Add photos and Tap to price.
- Carried over: gym auto-renew, price book phase 2, financing partner,
  Thursday 0.7.0 test, a Pro Xtra export.

## §3 Next lanes

- callWatch's first in-hours run after #2042 / #2049: read its logs at
  8 AM ET.
- Reskin pool: `document-generator.js` is mostly print output; only its
  fill-form modal is UI. Others: `expenses.js` remainder, `close-board.js`,
  `rep-os.js`, `money-dashboard.js`.
- The invoice panel and list (`renderInvoicePanel` / `renderInvoiceList`)
  are still mounted nowhere.
