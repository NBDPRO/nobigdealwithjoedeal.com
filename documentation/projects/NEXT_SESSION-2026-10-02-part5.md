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

### Later the same night (#2051–#2061)

- **Texting was dead and looked alive.** A read-only Twilio check (Jo okayed
  it) found:
  - a **Trial** account, with no A2P brand or campaign;
  - **0 of 23** CRM texts delivered in 45 days (30034 / 21608), while
    `alert_outbox` said "sent".

  What shipped in response:
  - the paste-ready
    [A2P runbook](../runbooks/TWILIO-A2P-REGISTRATION.md) (#2054). Its
    warning (#2060): upgrade and register **in one sitting**, because
    upgrading alone makes customer texts fail silently.
  - the /privacy mobile-information sentence (#2056);
  - a "texts are not delivering" alert from callWatch, at most once a day
    (#2055);
  - `alert_outbox.smsDelivery`, stamped with the real result, which the
    alert-health banner now counts (#2059).

  Memory: twilio-trial-no-a2p-sms-undelivered.
- **One at a time** (Jo: "like swiping through Gmail"). `triage-deck.js` is
  a reusable deck:
  - swipe right = the main action, saved at once;
  - swipe left = later, remembered;
  - ⋯ = other options;
  - Undo where it's safe.

  It's used by:
  - Sort my customers and Call Center Needs attention (#2053);
  - overdue follow-ups (#2057);
  - the Agent inbox (#2058);
  - **review asks** (#2061). Prod had **30 won jobs and 0 ever asked**.

  `tests/e2e/phone-one-at-a-time.spec.js` covers all five with real taps,
  each read back from Firestore.
- Reskins: Money (`mdx-*`, #2051) and Close Board (`cbr-*`, #2052; its
  homeowner deal page is untouched). Rep OS (`rpx-*`) is proven and waits
  on branch `feat/reskin-rep-os`.
- Health sweep: all 35 crons were OK, and the 24 h error log had only
  deploy noise. Texting is the one dead path.
- Pattern for parallel PRs:
  - The one-line spec list, the shared phone spec, `script-loader ?v=`
    and the ratchet ceiling conflict every time.
  - Fix them with the scratchpad resolvers: resolve-versions, resolve-html
    and splice-test. Never just "take ours" on a version line; pick a fresh
    number instead.

## §2 Jo's open items

- **Twilio, in one sitting:** upgrade from Trial, register the brand (LLC +
  EIN), create the campaign and attach the number. Every field is in the
  runbook.
- **Review asks:** Home shows "⭐ N review asks waiting"; work them one at a
  time.

- Open the Daily tracker once, so Coach sees today's floors.
- Enter the money numbers in the money tab. Finance Board sees no plan yet.
- The V3 iPhone test, now with Add photos and Tap to price.
- Carried over: gym auto-renew, price book phase 2, financing partner,
  Thursday 0.7.0 test, a Pro Xtra export.

## §3 Next lanes

- callWatch's first in-hours run after #2042 / #2049: read its logs at
  8 AM ET.
- Push `feat/reskin-rep-os` after #2052. Re-merge it and set the ratchet
  to whatever the count is then.
- Reskin pool: `document-generator.js` is mostly print output; only its
  fill-form modal is UI. Others: the `expenses.js` remainder,
  `invoice-pipeline.js` (done), and `portal.js` (a public page with its own
  CSS, so check first).
- The invoice panel and list (`renderInvoicePanel` / `renderInvoiceList`)
  are still mounted nowhere.
