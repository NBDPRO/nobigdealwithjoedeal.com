# NEXT_SESSION — 2026-10-02 part 3 (the 10-02 afternoon, Jo saying "keep building")

Follows [NEXT_SESSION-2026-10-02-part2](NEXT_SESSION-2026-10-02-part2.md),
which covers #2001–#2013.

## §0 Read first

- **The Grok Bot team now has a CRM connection.** Plan:
  [GROKBOT-CRM-INTEGRATION-PLAN-2026-10-02](GROKBOT-CRM-INTEGRATION-PLAN-2026-10-02.md).
  - **How it works:**
    - Bots call `crmMcp` (MCP at `/api/mcp`, `functions/agent-mcp.js`)
      with per-bot keys.
    - Keys are stored only as SHA-256 hashes in `agent_keys`.
    - Bots read **minimized** data: never phone, email or claim numbers.
    - Bots only **file** notes, reminders and reports into `agent_inbox`.
  - **Jo reviews them in the Agent inbox** (`docs/pro/js/agent-inbox.js`),
    opened from a 🤖 bell row or `?agentInbox=1`.
  - **There is no send path anywhere.** Jo: "note it all in the CRM … over
    giving me a massive send-out list."
  - **Nova never gets a key.**
  - Kill switch: `AGENT_MCP_DISABLED=true`.
- **Grok Bot app (updated around 10-02):**
  - The brief or Description editor is **gone**. Briefs now change only by
    a chat message, which costs usage.
  - Rename Bot is in the sidebar's right-click menu.
  - **The bot list re-sorts by activity.** Re-check which chat is open
    before typing. A message nearly went to the wrong bot.
- **A Firestore boot read can answer from the empty cache.** It hit the
  Agent inbox when opened from the bell during page boot. See memory
  `firestore-boot-reads-can-be-fromcache`. Retry an empty `fromCache`
  answer.
- **Parallel PRs fight over the same files**: FLOORS, `ci-manifest`,
  `script-loader ?v` and `dashboard.html`.
  - An **identical** `?v` bump merges clean and is still wrong, so give
    each PR its own number.
  - The re-merge script lives in the session scratchpad (`remerge.sh`). It
    merges main, unions the manifest, re-reads FLOORS from `--check`, bumps
    `?v` past main, re-pins and pushes.

## §1 What shipped or is shipping (#2014–#2030)

- **#2014** Expenses screens: inline styles moved to `ui-primitives`.
  Zero computed-style diff across 273 elements at 1280 and 390.
- **#2015** Plan:
  [STORE-PRICE-BOOK-PLAN-2026-10-02](STORE-PRICE-BOOK-PLAN-2026-10-02.md).
- **#2016** Price book phase 1: HD import keeps the SKU and a per-unit
  price into `priceBook/{companyId}`. Same rules as `catalogCosts`.
- **#2017** Proposal views: open count, reading time, and a push to Jo on
  open. Link-preview bots are ignored.
- **#2018** Price book viewer, from the 💲 button in the Product Library.
- **#2019** Ask Joe actions: `find_customer` and `get_schedule`, plus
  confirm cards for `send_text`, `add_reminder` and `move_stage`.
  Server-side named toolset.
- **#2020** 🧾 Materials list per estimate: purchase units rounded up,
  assumed cost, suggested store.
- **#2021** Storm Watch layer on the D2D map. The storm text links straight
  to `?storm=lat,lon`.
- **#2022** Plan: the Grok Bot → CRM integration.
- **#2023** Agent inbox.
- **#2024** `crmMcp` plus `createAgentKey` / `listAgentKeys` /
  `revokeAgentKey`, and a **🔌 Connect bots** panel.
- **#2025** 🌩 Fill dates of loss.
  - Shows NWS storm reports within 3 mi in the 2 years before the call;
    one tap per customer.
  - Saved as `dateOfLossSource: storm_report_suggested`, to be confirmed
    with the homeowner or adjuster.
- **#2027** Ask Joe `add_note` (confirm card, writes a normal card note)
  and `agent_inbox_summary` (what the bots filed, read-only).
- **#2028** Claim panel labels a storm-report date of loss "suggested —
  confirm with the homeowner or adjuster"; editing it re-labels it
  `entered`.
- **#2029** Reskin: Storm Center → `stc-*` in `css/storm-center.css`
  (79 sites, 716 elements zero diff). The `sc-` prefix belongs to
  `sort-customers.css`.
- **#2030** Reskin: home widgets + picker → `wg-*` in
  `css/widgets-home.css` (124 sites, 1,024 elements zero diff, plus a
  per-conversion pair check that covers unrendered branches).
  - Button overrides need the `body[data-nbd-size] .btn` scope, or the
    size rule (0,2,1) wins.
- **#2011** V3 one-thumb wizard: still merging at time of writing
  (re-merged four times as the others landed).
- **Merge-day gotcha:** the HTML conflict resolver once dropped a whole
  `<link>` line (ask-joe-actions.css) when merging main into #2020.
  After every re-merge, diff the `?v=` lines of dashboard.html and
  customer.html against main and look for REMOVED lines.

## §2 Jo's open items

- **Connect the bots (after #2024 deploys):**
  - In the Agent inbox, go to 🔌 Connect bots and create keys for CoS,
    Marcus and Quinn.
  - Paste each key into that bot's **secure box**. Claude never enters
    keys.
- **Chief of Staff's Stripe read-key paste box** is waiting in the CoS
  chat.
- **Price book phase 2 needs three answers:**
  - the first 30 items, or a whole category?
  - can Gulf Eagle export invoices?
  - preferred store per category?
- **Monthly payment on package cards** needs the financing partner and its
  rates.
- **Test on the phone:**
  - **V3** in daylight;
  - **Ask Joe actions** with the real model, e.g. "remind me Friday to call
    …";
  - **Thursday 0.7.0** with a test call.
- **One real Pro Xtra export** to confirm how HD's "Net Unit Price" reads
  (#2016).

## §3 Next lanes

- **The Grok Bot trial:** one week of CoS, Marcus and Quinn through the
  connection. Then:
  - add Tucker, Dana, Frank, Priya and Theo (their tool lists are already
    defined in `agent-mcp-logic.js`);
  - watch `agent_audit` and the inbox quality.
- **Reskin, the JS-built screens:** `storm-center.js` and `widgets.js`
  are done (#2029, #2030). Next is `vault-page.js` (207 sites).
  - Skip `invoice-pipeline.js`'s panel and list: they are mounted nowhere.
  - `buildInvoiceHtml` is the email body and must stay inline.
  - Its detail modal and record-payment modal are fair game.
  - Proof harness: a scratch `zz-*.spec.js` that dumps the screen's
    computed styles, run before and after, plus the pair check for any
    branch the render doesn't reach.
- **Price book phase 2:** store SKUs, links and photos on products, once
  Jo answers.
- **Bulk texting stays parked.** Jo prefers notes and reminders. If it ever
  comes back, it needs the consent gate first: `tcpaConsent`, the STOP
  register and quiet hours.
