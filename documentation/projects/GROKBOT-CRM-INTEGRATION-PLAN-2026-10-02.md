# Grok Bot team → CRM integration plan (2026-10-02)

Jo, 2026-10-02: "the grokbot team also got usage reset so they are available
to work… let's look into that and also solidify our plan to use and
integrate them into the CRM and daily use."

Status on 2026-10-02: Claude was **not** given screen access to the Grok Bot
app this session. This plan is built from the vault and from public docs.
The live team state (chats, queue, what ran last week) is still to be read,
by Jo or with access later.

## What exists (from the vault)

- **The team** ([NEXT_SESSION-2026-09-24](NEXT_SESSION-2026-09-24.md) §3,
  memory `grokbot-team-roster`): ten bots in the Grok Bot desktop app.
  - **Chief of Staff:** router, approval queue, weekday digest at 7:11 AM ET.
  - **Marcus:** NBD Ops.
  - **Priya:** NBD Pro.
  - **Nova:** Eromify. **Walled off from NBD.**
  - **Dana:** Marketing.
  - **Frank:** Finance. **Never moves money.**
  - **Quinn:** Fact-Checker.
  - **Theo:** Venture Scout.
  - **Tucker:** Collections.
  - **Thursday:** Reception. Lives on Bland, and is already wired into the
    CRM.
- **Autonomy tiers.** Every brief carries the same three:
  - **GREEN:** research, drafts, filing.
  - **YELLOW:** ask Jo first — public-facing work, spend, deletes, account
    changes.
  - **RED:** never — money, passwords, contracts, impersonation.
- **Usage.** Last week the team hit about 90% of the weekly Grok limit, so
  everything except CoS, Marcus and Quinn was paused, and the digest moved
  to Mon/Wed/Fri. The limit has now reset.
- **Trust posture.**
  [GROKBOT-BRIEF-VERIFICATION-2026-09-13](../audit/GROKBOT-BRIEF-VERIFICATION-2026-09-13.md):
  7 of ~30 Grok claims were false. **Bot output is a lead, never a fact.**
  The Grok Build CLI is a refuter only, never a builder in this repo.
- **Open approvals carried from 09-24:**
  - Stripe restricted read key (Frank, Priya, Quinn).
  - Gmail + Calendar read-only connect.
  - Bank exports.
  - GBP / Search Console / GA.
  - Dana's town-page drafts: Dana drafts, Claude reviews and ships. There
    are 12 towns.

## What Grok Bot can do (public docs, Aug–Sep 2026)

- **Runtime:** each bot runs on a persistent cloud computer. It has a
  browser, a terminal and files.
- **Built-in connectors:** Google Workspace, Microsoft 365, GitHub and
  Notion.
- **Custom MCP servers:** added by asking the bot in chat; there is no
  config file.
- **Apps:** the desktop and mobile apps are thin clients for chat and
  approvals.

Sources:
[Composio — MCP servers in Grok Bot](https://composio.dev/blog/how-to-add-mcp-servers-to-grok-bot),
[Vellum — Grok Bot breakdown](https://www.vellum.ai/blog/official-grok-bot-breakdown).

## The integration: an NBD CRM MCP server

A Cloud Function speaking MCP over HTTPS (`crmMcp`). **Each bot gets its own
revocable key with a fixed tool list.** Every call is logged to an
admin-only audit trail. All bots share one hard rule:

> **Bots never act on a customer or on money. They read what their role
> needs and FILE items into a CRM approval queue (`agent_inbox`). Jo approves
> in the CRM, where the existing send / task / stage paths run — the same
> confirm-card pattern as Ask Joe actions (#2019).**

| Bot | Read tools | Can file into the queue |
|---|---|---|
| Chief of Staff | pipeline summary, today's schedule, overdue follow-ups, queue status | digest note; routing |
| Marcus · Ops | schedule (any day), jobs by stage, materials lists | task / reminder drafts; schedule-conflict flags |
| Priya · Pro | product/feature notes, error/bug signals (no customer data) | bug reports (→ GitHub issue via Claude review) |
| Dana · Marketing | finished projects (public fields only), town list, Search Console summary | town-page / post drafts (Claude reviews, ships) |
| Frank · Finance | collected revenue, open invoices, expenses (Stripe read key) | finance notes; anomalies |
| Tucker · Collections | open / overdue invoices | reminder-text DRAFTS (Jo confirms each) |
| Quinn · Fact-Checker | read-only everything the claim touches | verdicts on other bots' items |
| Theo · Venture | storm reports, public market data | research notes |
| Nova · Eromify | **none** — no NBD key, ever | — |
| Thursday | already integrated (Bland webhook) | — |

### Guardrails, built in rather than promised

- **Kentucky claim-wording rules** run on every customer-facing draft:
  the claim-wording gate plus the Ask Joe rules.
- **Data minimisation.** Customer phone and email are never returned to
  bots; drafts reference a `lead_id`. Addresses are returned only to Ops
  and Marketing. No PII goes to Theo, Priya or Nova.
- **No sends.** The MCP has no tool that texts, emails, charges or deletes.
  Those only happen from Jo's confirm in the CRM.
- **Quinn first.** A bot's factual item is marked *unverified* until Quinn
  (or Claude) checks it.
- **Kill switch:** one env flag plus per-key revoke. The audit log is
  admin-only.

## Daily rhythm

- **6:45 AM:** the CRM morning brief (already built).
- **7:11 AM:** the CoS digest pulls the same numbers through the MCP. It
  becomes one queue.
- **Through the day:** bots file items, and Jo clears the **Agent inbox**
  in the CRM on his phone, approving or tossing each one.
- **Weekly:**
  - Dana: a town page.
  - Tucker: an overdue sweep.
  - Frank: a revenue-collected summary.
  - Theo: a storm-response report.
- **Usage budget:** CoS, Marcus, Quinn and Tucker active daily; the rest
  weekly; Nova on Jo's say-so.

## Build order (each a PR)

1. **The `agent_inbox` collection and the CRM "Agent inbox" screen.**
   - Approve runs the existing Ask Joe action paths; Toss archives.
   - Rules: owner / company_admin only; writes go through the server.
2. **The `crmMcp` function.**
   - MCP over HTTPS, per-bot keys (hashed), tool lists per bot, the audit
     log, rate limits and a kill switch.
   - First tools: pipeline summary, schedule, overdue follow-ups, open
     invoices, and file-to-inbox.
3. **Wire CoS + Marcus + Quinn first.** Watch one week of real output
   before adding more bots.
4. **Then the rest:** Dana's town pages (her GitHub connector opens a
   draft PR, which Claude reviews), Tucker, Frank (Stripe key), Theo.

## Decisions for Jo

1. **Send customer data to xAI's cloud at all?** Even minimised (lead ids,
   no phones or emails), names and addresses reach Grok's servers for Ops
   and Marketing.
2. **First bots:** CoS + Marcus + Quinn (recommended) or more.
3. **Screen access:** to read the team's current state, either open the app
   with Claude, or Jo pastes CoS's latest digest.
