# Bring your own bot: tenant self-serve bots (2026-10-04)

Branch `feat/tenant-bots-self-serve`. Any NBD Pro company on a paid plan can now connect its own AI bots (Claude, ChatGPT, Grok, anything that speaks MCP) to its CRM through the existing connection (`functions/agent-mcp.js`, `/api/mcp`). This follows the gaps listed in the 2026-10-04 landing audit (`documentation/audit/PRO-LANDING-CLAIMS-AND-MCP-TENANCY-2026-10-04.md` on PR #2146's branch) and closes all seven. It builds on the [Grok Bot integration plan](GROKBOT-CRM-INTEGRATION-PLAN-2026-10-02.md).

## What changed

| Gap | Now |
|---|---|
| 1. Fixed roster | Company bots live in `agent_bots/{id}` (server-only): name, role, allowed tools (any CRM tool, never `my_*`), and who gets notified. A key for one is `agent_keys/{hash}` with `botId: 'c_<id>'` and `customBotId`. Max 20 per company. |
| 2. Jo/NBD wording | Every tool description and both `initialize` texts are neutral. The filing reply says "In your Agent inbox". `rules_reference` returns NBD's rules for NBD only. Other companies get their own `companyProfile.businessRules` / `pricing.tierRates` (#2152's fields, read when present), the house rules typed on the Bots page, neutral guidance, and the KY lines (state law). |
| 3. Fixed timezone | `companyProfile.timezone` (or the brand's). America/New_York is the default for NBD only; everyone else gets UTC until it's set. The first bot sets it from the owner's browser. A company with no profile doc keeps it on `agent_settings` instead, so no stub profile is created. |
| 4. Team accounts | The 🤖 bell goes to `companies/{id}.ownerId`, or to the bot's maker for a "Me" bot, never to the company id. `schedule` reads that person's appointments (`repUid` OR `userId`, both indexed). |
| 5. Hidden UI | The 📥 Agent inbox is in the sidebar (AI TOOLS) and the phone More drawer, owner/admin only. **Settings → 🔌 Bots & API** (`agent-bots-settings.js`) and how-to section `#connect-bots` were added. Key minting moved out of the inbox. |
| 6. No per-tenant control | `agent_settings/{companyId}.enabled === false` refuses every key of that company (403), house roster included. **Plan gate:** any active or trialing plan other than `free`, the same test as `requirePaidSubscription` and the AI gate. NBD and personal tracker keys are exempt. |
| 7. Key listing | `listAgentKeys` works for anyone and returns only the caller's own keys. An owner or admin sees every company key except other people's personal keys. Anyone can revoke their own key. |

## Jo's keys

House-roster keys (`botId` in `L.BOTS`) authenticate exactly as before. NBD is identified by `companyId === NBD_OWNER_UID` **or** `createdBy === NBD_OWNER_UID`. That belt-and-braces check matters because a house key is plan-exempt only for NBD. Minting a house-roster bot now requires NBD or a platform admin.

## Tests

- `tests/agent-tenant-bots-2026-10-04.test.js` (node bucket) runs the real handlers over an in-memory Firestore, with `firebase-admin/firestore` and the rate limiter stubbed through `Module._load`. That lets it also run against main's file for the break-test: 57 red on main, including the team routing bug (`["coA"]`) and the "Jo's Agent inbox" wording.
- Rules: section 45 in `firestore-rules.test.js` now covers `agent_bots` and `agent_settings` as client-denied.
- E2E: `tests/e2e/phone-bots-api.spec.js` runs at 390×844 in the functions shard (`@stranger`). It makes a bot, sees the key once, calls the real `crmMcp`, revokes the key (401), and removes the bot.

## Follow-up

- Once this ships, flip the `/pro` landing's "Coming soon for your account" bot line (PR #2146, not merged when this was written).
