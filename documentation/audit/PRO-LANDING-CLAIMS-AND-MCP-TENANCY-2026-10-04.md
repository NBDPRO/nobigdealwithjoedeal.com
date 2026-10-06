# /pro landing rebuild: claim check and crmMcp tenancy verdict (2026-10-04)

Recon behind the `/pro` product-page rebuild (`feat/pro-landing-revamp`).
Each section claim on `docs/pro/index.html` is pinned to its code in
`tests/pro-claims-honesty-2026-09-13.test.js` (LANDING 2026-10-04 block).
This note keeps the parts that are not obvious from the test.

## Update 2026-10-05: copy refresh + visual pass

The verdict below is **superseded for bots**: #2158 made bring-your-own-bot
self-serve (Settings → Bots & API, any active/trialing paid plan,
`planAllowsBots` in `functions/agent-mcp-logic.js`), so the page now says
"Live on paid plans". The page also now credits, each pinned in the test:
the 9-step portal tracker (#2130, step names read from
`HOMEOWNER_PROGRESS_COPY`), the six Today sections (#2137), in-app e-sign with
the right-to-cancel notice and two cancellation forms (#2166/#2149), the
production strip (#2147), the close rate and lost reasons (#2150), the 75 m
on-site photo tag (#2153), and 33 document types (#2141, counted by loading
the three generator files in a VM).

Deliberately **not** claimed, with a negative pin each:
- Solar measurement: the default provider is still `instantroofer`.
- Offline-safe field work: #2145 is not merged.
- #2135's getting-paid features: not merged. Its spot is an HTML comment,
  `PENDING #2135`, in the Paid tour step.
- Facebook/Instagram auto-publishing: one global page token, which is Jo's.
- Job weather and Google Calendar sync: these answer Jo's account only.

The morning email is Jo-only, so it sits under "Running in my shop".

## Bring-your-own-bot: PARTIAL, so the page says "coming soon for your account"

The crmMcp API (`/api/mcp` → `functions/agent-mcp.js`) **is company-scoped**.
No cross-tenant leak was found:

- Keys are random `nbdk_` strings stored as SHA-256 at `agent_keys/{hash}` and bound to `companyId`.
- The tenant comes only from the key doc. No tool takes a companyId argument.
- Every tool filters by the key's company or checks ownership after a fetch-by-id.
- `agent_keys` and `agent_audit` are server-only in `firestore.rules`.
- `agent_inbox` reads and decisions require a companyId match.

It is **not self-serve** for another company yet:

- **Fixed bot roster.** Jo's ten Grok bots are hard-coded (`agent-mcp-logic.js`), with no custom bot or tool-scope picker.
- **Jo/NBD wording.** Tool descriptions and server instructions name Jo, and a successful filing replies "In Jo's Agent inbox". `rules_reference` serves NBD's own tiers and house rules to every tenant.
- **Fixed timezone.** It is hard-coded to `America/New_York`.
- **Team accounts are missed.** The notification goes to `userId: company`, and appointments use `repUid == company`.
- **Hidden UI.** It is reachable only from the command palette or the bell, with no Settings entry, and there is no how-to page.
- **No per-tenant controls.** There is only a global kill switch (`AGENT_MCP_DISABLED`), with no plan gate or per-tenant enable flag.
- **Personal keys.** Any user can mint one, but `listAgentKeys` needs admin, so reps can't see or manage their own.

## Plan lists vs. real gates

| Gate | Enforced? |
|---|---|
| Leads per month | Yes. Hard client block at 100% |
| AI | Free: blocked server-side (claudeProxy needs a paid sub). Paid: a soft meter on `aiCalls` |
| Seats | Yes. Server caps |
| Growth-only pages | `requiredPlan: 'growth'`: ai-tree, understand, vault, ai-tool-finder, ask-joe.html |
| Starter-only pages | analytics, project-codex |
| **Reports** | **Not metered.** `PLAN_LIMITS.reports` exists, but no client calls `trackUsage('reports')`. The pricing lists no longer advertise a reports cap. |

Removed because nothing backs them:

- "Rep leaderboard + coaching" as a Team/Growth perk. The page-plan table that names it has no callers.
- "Territory management / Customer portals" as paid perks. Every plan gets them.
- "Multi-tenant architecture", "White-label", "SLA", "On-site training" on Enterprise.
- The "MOST POPULAR" badge.

## Not on main when this shipped

- **#2130** (9-step portal tracker): the page says **5 steps**, which is `HOMEOWNER_PROGRESS`.
- **#2135** (getting paid): the page claims only what main has: recorded check, cash, Zelle and ACH; a card pay link through Stripe; and the deposit rule. It makes no claim of online ACH or emailed receipts.
- **#2137** (Today home): the hero shows main's **Home** screen and never uses the word "Today".

## Screenshots

There are 10 frames, captured at 390×844 @2x with Playwright on the local emulator (auth, firestore, storage and hosting only; no functions, so no alerts can fire).

- All data is invented: "Sample Roofing Co.", "Sam Carver", 555-01xx phones, and streets such as "Sample Ridge Rd" and "Placeholder Ln".
- Function calls were stubbed by route.
- Other lanes' E2E specs wrote `[E2E] …` leads into the same emulator mid-run. Those were deleted before every capture, and each frame was checked for stray text.
- The estimate frame uses line-item mode, so the per-SQ prices of the CRM-only Economy and Beyond tiers are not published.
