# NEXT_SESSION — 2026-10-02 part 4 (the 10-02 evening: the bot team goes live, Jo's personal system)

Follows [part 3](NEXT_SESSION-2026-10-02-part3.md). Jo was steering live,
then away, saying "keep building", then: "perfect all the bots and all their
roles as well as the MCP itself to match — then we jump back into the CRM."

## §0 Read first

- **Every NBD bot is connected (Nova excluded).** Each bot uses its own key.
  Jo pasted every key; Claude never enters keys.
  - Tool lists were verified against `BOTS` in `functions/agent-mcp-logic.js`.
    A wrong list means the bot borrowed another bot's key.
  - The connection steps are in the plan,
    [GROKBOT-CRM-INTEGRATION-PLAN-2026-10-02](GROKBOT-CRM-INTEGRATION-PLAN-2026-10-02.md).
- **Grok Bot's built-in remote connector can't attach a key.** It connects
  without auth, gets 401 or 405, and the bot calls the connector "broken".
  - The working path is the bot's own **`mcp-remote`** wrapper, which adds
    `Authorization: Bearer`.
  - When a bot offers "Replace the broken connector?", say yes. Don't steer
    a bot away from the "local bridge".
- **Never run `git checkout <ref> -- .` in the shared checkout.** On
  2026-10-02 it overwrote 642 files. They were restored, but uncommitted
  edits from another session would have been lost. Read main with
  `git show origin/main:<path>` or from a worktree.
- **The Bash tool strips backslashes, even inside quoted heredocs.** Write
  regex-bearing scripts with the Write tool.
- **A squash merge of a base branch makes stacked PRs "conflict" on
  identical code.** Before taking your side, confirm that main's copy
  equals the base branch tip (`git hash-object`).

## §1 What shipped (#2027–#2036, all merged)

- **#2027** Ask Joe `add_note` + `agent_inbox_summary`.
- **#2028** Claim panel: a storm-report date of loss shows as "suggested —
  confirm".
- **#2029–#2031** Reskin, JS-built screens 4–6: Storm Center (`stc-*`), home
  widgets (`wg-*`), D2D tracker (`dk-*`).
  - Each has zero computed-style diff, plus a per-conversion pair check that
    covers unrendered branches.
  - Gotchas:
    - The `sc-` prefix belongs to `sort-customers.css`.
    - `body[data-nbd-size] .btn` (0,2,1) out-ranks `.btn.x`.
    - `theme-bridge.css`'s single-class `.d2d-*` rules load later; double
      the class to win.
- **#2032** MCP: `estimates_status` (customer-facing total only) and
  `collected_revenue` (same ledger as `collected-revenue.js`, parity-tested).
  The inbox gets a "✓ Add the N Quinn checked" bulk button and visible
  Quinn flags.
- **#2033** Jo's operating system, build 1 (tracker):
  - "Don't miss twice" floor streaks: one miss warns, two in a row end the
    streak, and today never counts as a miss.
  - The Sunday review: floors out of 7, the $5 miss tax, the 0.5 lb
    weigh-in rule (one tap cuts 200 kcal), last week's hard thing, a
    promise audit, this week's hard thing, and a scorecard.
- **#2035** Build 3: **personal-scope keys.**
  - Coach · Personal (`my_today`, `my_week`, `my_reviews`) and Finance
    Board · Personal read only `userSettings/{ownerUid}.dsSnapshot` /
    `dsReviews`.
  - The tracker publishes that snapshot on each dashboard paint, and only
    when it changed.
  - Two locks, both break-tested:
    - at auth, a personal bot must hold a personal-scope key with an owner;
    - every call from a personal key enters a branch that refuses any CRM
      tool.
- **#2011** Estimate Builder V3 merged.
  - Its CI fix: `phone-estbuilder.spec` now taps "Full editor" first,
    because those specs cover V2.
  - It deploys with #2036; V3's own deploy was superseded.
- **#2036** MCP v1.1, tools matched to roles:
  - `rules_reference` (Quinn / Marcus / Tucker / Dana). It is drift-tested
    against `estimate-config.js`.
  - `post_job` (Tucker).
  - `lead_sources` (CoS / Dana / Frank / Theo).
  - `job_profit` (**Frank only**).
  - `storm_near_customers` (Marcus / Quinn).
  - `team_activity` (CoS / Priya).
  - MCP read-only annotations; server 1.1.0.

## §2 Jo's open items

- **Coach and Finance Board keys:** both bots exist in Grok Bot with their
  briefs. Make the keys under 🔌 Connect bots → **Personal**, server name
  "Jo Tracker". About 2 minutes at the PC.
- **Money numbers for build 2 (the money tab):**
  - take-home pay and its frequency;
  - fixed bills;
  - each card's balance and APR;
  - the emergency fund now and its target;
  - subscriptions.
- **Tracker setup:**
  - set the 5 floors (Workout, Protein, 10k steps, Business follow-ups,
    Sleep — lights out 9:15);
  - set a daily calorie target on the Food card;
  - set the gym to auto-renew until he holds 220 for 4 weeks.
- **Carried over:** the price book phase 2 answers, the financing partner,
  the V3 phone test, the Thursday 0.7.0 test, and a real Pro Xtra export.

## §3 Next lanes

- **Bot brief updates for v1.1** go out once #2036 deploys. The text is in
  the session scratchpad (`bot-briefs-v11.md`). After that, the bot work is
  done except the two personal keys.
- **Build 2, the money tab:** zero-based paycheck allocation, emergency fund
  bar, card payoff order by APR, subscriptions; plus a `my_money` tool for
  the Finance Board.
- **Back to the CRM:** Jo's call on what comes first.
- **Reskin pool:** `customer-tasks-ui.js` (90 sites, several customer-page
  panels; needs a seeded customer with photos and comms) and `supplement-ui.js`.
  - Skip `invoice-pipeline.js`'s panel and list (mounted nowhere).
  - Skip the `vault-page.js` admin tracker.
- **Weekly digest refunds:** `_paymentsOf` in `weekly-digest.js` ignores
  refunds. A separate session was started on it; check for its PR.
