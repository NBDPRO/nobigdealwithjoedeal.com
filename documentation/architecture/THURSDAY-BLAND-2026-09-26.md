# Thursday (Bland AI receptionist) → NBD Pro — 2026-09-26

**Status (updated 2026-09-26, evening): LIVE.** Every Thursday call now lands in the CRM.
- **A** #1783: the server pipeline.
- **Tuning** #1788: Jo's own calls are tests, the silence threshold is 4 words, and a caller who said "Hello?" goes to the inbox.
- **B** #1787: the CRM UI (Calls section, Home inbox, source-select fix, CSP media-src).
- **C** (the last PR): couples and second numbers in the lookup, chunked recordings, and the greet-by-name agent version.

Section 5 records what is live and what is waiting on Jo.

Thursday answers **(513) 940-5589** as the Bland agent "Thursday - NBD Reception" (`4c2b2b93-9251-4477-b9b3-3dbfae4eccfe`, pathway `771a3ea4-1e79-40da-aafa-6ec086688913`). Jo's cell forwards busy, unanswered and unreachable calls to her. She went live on 2026-09-24 ([NEXT_SESSION-2026-09-24](../projects/NEXT_SESSION-2026-09-24.md)). Until this note, **nothing she heard reached the CRM**: there was no Bland code in the repo at all.

## 1. Jo's decisions (2026-09-26, final)

- **New callers auto-create a lead** (New stage), with a "Call back" task.
  - Spam, test, silent and job-seeker calls never create a lead.
  - A weak match gets a "possible match" flag instead of a duplicate.
- **Alerts:**
  - Texts go to **+1 859-420-7382**, the same cell as `lead-alert.js` `ALERT_SMS`.
  - Emails go to **both** jd@ and gmail, the same list as `ALERT_EMAILS`.
  - A push to the installed NBD Pro app goes with them.
- **Scope:** the brief's "phase 2" is in scope: greeting known callers by name, a Calls section on the customer card, and a Thursday inbox on Home.
- **Pathway edits happen through the Bland API**, in four steps:
  1. Full backup first.
  2. The change goes into a new version.
  3. A test call.
  4. Promote only after Jo OKs it.
  - **Where the edit actually lives:** in the **agent** (section 7), not in the pathway. The pathway is compiled from the agent.
- **Recording notice:** Thursday says calls are recorded, even though OH and KY are one-party-consent states.
- **Texts** stay off until Jo is on Bland's Agent Phone Plan. He gets email and push meanwhile.

## 2. How a call flows

```
Bland post-call webhook ─► thursdayWebhook (onRequest)
    X-Webhook-Signature = hex HMAC-SHA256(raw body, BLAND_WEBHOOK_SECRET)  → 401 if wrong, 503 if unset
    only inbound calls TO +15139405589 (others: 200 "ignored")
    thursday_calls/bland_calls__{call_id}.create({status:'pending', …})   → redelivery = 200 "duplicate"
                                   │
scripts/thursday-backfill.js ──────┤  same doc, source 'backfill', notify 'suppress'
                                   ▼
thursdayCallProcess (onDocumentWritten; claims status pending|reprocess in a transaction)
    1 hydrate      GET /v1/calls/{id} if transcript/summary/recording are missing
    2 recording    Bland recording (needs the API key) → Storage calls/{uid}/{call_id}.{ext}
    3 extraction   Claude (claude-opus-5, structured outputs json_schema, effort low,
                   fallbacks:"default") → sanitizeExtraction() clamps every field
    4 match        NBD leads only (query companyId == NBD, then the matcher re-checks)
    5 route        create_lead | attach | possible_match | inbox | log_only
    6 write        lead (create-only) · leads/{id}/tasks/thursday-{call_id} (create-only)
                   · leads/{id}/activity/thursday-{call_id}
    7 notify       email (Resend) · push (installed app) · Bland SMS (flagged) — each
                   records notifyState.{channel}; skipped if already sent
```

**Where the code lives:**
- `functions/integrations/thursday-logic.js` makes every decision. It is pure and has no Firebase imports.
- `functions/integrations/thursday.js` executes those decisions.

**Idempotency:** every write has a deterministic id, and the lead and task are `.create()`-only. A reprocess never duplicates a lead and never re-opens a task Jo has already completed. The emulator suite proves both.

### Routing

| caller_type | match | result |
|---|---|---|
| new_lead | none | new lead `leads/bland_calls__{call_id}` + task + text/email/push |
| new_lead / existing_customer | strong | attach: activity + task on that lead. Stage and source are never touched; only blank phone/email are filled, and the real number goes to `altPhone` when the lead holds a Thumbtack proxy |
| any | possible | no new lead; a "Possible match: confirm" task on the single candidate; the inbox shows Confirm / Not them |
| existing_customer | none | new lead, noted "Caller says existing customer — no CRM match" |
| adjuster / supplier_sub | strong (claim #, phone or address) | attach + task |
| adjuster / supplier_sub | none | inbox only |
| job_seeker | — | inbox + email only |
| spam / test / silent | — | logged, marked reviewed, no notifications |
| extraction failed | — | inbox "Needs review" + email + push with Bland's summary, so a call never vanishes |

### Matching (tenant-scoped twice)

- **Candidates:** only `companyId == NBD` leads that are not deleted. Firestore scopes the query, and `matchLeads()` filters again.
- **Strong** means any of:
  - a non-proxy phone equals the caller ID or the callback number;
  - the claim number matches;
  - the street number and name match, plus a first or last name, with no conflicting ZIP or town.
- **Possible** means any of:
  - the same street without a name, or with a conflicting town;
  - first and last name only;
  - first name with a last initial (or no last name) in the same ZIP or town.
- **Two strong hits are downgraded to possible.** The matcher never guesses.
- **Thumbtack proxy** numbers (source Thumbtack with a 669 area code, the same rule as `dup-review.js`) never phone-match.

**The brief's two acceptance cases** (real customers, so named only in Jo's brief and never in this public repo). Both suites pin fictional equivalents:
- **Case A:** an existing customer → **attach** to her lead, even though her caller ID sits on another tenant's lead.
- **Case B:** a Thumbtack lead ("First L.", 669 proxy phone, town only) → **possible match**, never a duplicate.

### Lead fields written on create

The conventions follow `lead-bridge-logic.js` `mapPublicLeadToLead`:

- **Owner and tenant:** `userId = companyId = 1phDvAVXHSg82wDLegAbQFq14Ci1`.
- **Stage:** `stage:'New'`, `status:'new'`.
- **`source`:** one of the canonical twelve, mapped from what the caller said (`mapHeardAboutToSource`; unknown → Other).
- **Intake, recorded separately from `source`:** `intake:'Phone — Thursday'` and `sourcePage:'phone:thursday'`.
- **Provenance:** `publicLeadKind:'thursday_call'`, `publicLeadCollection:'thursday_calls'`, `publicLeadId`, `thursdayCallId`.
- **Phone:** `phoneDigits`, so inbound SMS matches.
- **Insurance:** `insCarrier`, `claimNumber`, `claimStatus` ('Claim Filed' / 'No Claim') and `jobType:'insurance'`, using the same field names the lead modal saves.

## 3. Data, rules, secrets

**Firestore:**
- `thursday_calls/{bland_calls__id}`
  - **Read:** the owner, the platform admin, or company readers (company_admin, manager, viewer) of the same company, mirroring `/leads`. A sales_rep teammate is denied.
  - **Write:** none from clients.
  - **Tests:** 19 cases in `tests/firestore-rules.cross-tenant.test.js`, break-tested.
- `thursday_config/{companyId}`
  - **Fields:** `smsEnabled`, `smsTo`, `emailTo[]`, `pushEnabled`, `pushUid`, `enabled`, `agentNumber`.
  - **Read:** the owner and company readers. **Write:** only `scripts/thursday-config.js`.
  - The Home widget shows only when this doc exists.

**Storage:**
- `calls/{uid}/…`: owner or admin read, no write.
- Registered in `user-owned.js` `STORAGE_PREFIXES`, so it erases with the account.
- Recordings reach the browser **only** through the `getThursdayRecording` callable, as base64 to a blob URL. No download token is ever minted, and no bearer URL goes in an email.

**Indexes:** `thursday_calls` (userId, startedAt desc) and (companyId, startedAt desc).

**Secrets** (all in the `integrations/_shared.js` registry and the `integrationStatus` readout):

| Secret | What it is | Who sets it |
|---|---|---|
| `BLAND_API_KEY` | Bland API key (hydrate, recording, SMS, backfill, setup script) | Jo, `firebase functions:secrets:set BLAND_API_KEY --project nobigdeal-pro` |
| `BLAND_WEBHOOK_SECRET` | Bland Dev Portal → Account Settings → Keys → webhook signing | Jo, same command |
| `THURSDAY_LOOKUP_TOKEN` | a bearer WE mint for the pathway's lookup node; also stored in Bland Secrets | generated and piped straight into `secrets:set`, never printed |
| `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` | existing | — |

Secret values are pinned at deploy time. **After setting or rotating one, redeploy the Thursday functions.**

## 4. Runbook

1. **Set the two Bland secrets** (Jo, in his own terminal; never paste a key into chat). Then redeploy, or merge a functions change.
2. **Configure the tenant** (only needed to change a default; the functions have built-in defaults):
   ```
   node scripts/thursday-config.js                     # dry-run: shows current vs defaults
   node scripts/thursday-config.js --apply --yes       # writes thursday_config/<NBD>
   node scripts/thursday-config.js --sms-enabled=true --apply --yes   # once on the Agent Phone Plan
   ```
3. **Point Bland at the webhook:**
   ```
   node scripts/thursday-bland-setup.js status         # backup + summary of the number (read-only)
   node scripts/thursday-bland-setup.js set-webhook --url=https://us-central1-nobigdeal-pro.cloudfunctions.net/thursdayWebhook
   node scripts/thursday-bland-setup.js set-webhook --url=… --apply --yes
   ```
   The apply POSTs only `{webhook}`, GETs the number again and diffs every field. It **exits 1** if anything besides `webhook` changed, and prints the backup path for a rollback.
4. **Test call.** Call 513-940-5589. The call should show as a `processed` doc in `thursday_calls`, an email and a push should arrive, and the recording should play on the card.
5. **Backfill:**
   ```
   node scripts/thursday-backfill.js --since=2026-09-20 --expect=<name>:attach --expect=<name>:no_new_lead   # dry-run: route per call + PASS/FAIL
   node scripts/thursday-backfill.js --since=2026-09-20 --apply --yes   # queue; notifications suppressed
   ```
6. **Reprocess one call:** the inbox has a "Reprocess" action. Or set `status:'reprocess'` on the doc; reprocess suppresses notifications.

**Bland SMS** needs Bland's Agent Phone Plan. With the flag off, `notifyState.sms.status` records `skipped:flag-off`. With it on and Bland still refusing, it records `plan_required:…` and logs a warning. It never throws.

## 5. State at end of session

The verification section below is updated as each step lands.

- **PR A (server):**
  - The unit suite has **103** checks. 8 mutations were break-tested, each reddening the intended assertion.
  - The emulator pipeline suite has **37** checks. 2 mutations were break-tested.
  - The rules suite has **165** checks, including 19 new ones. The rule was break-tested: loosening it reddened 6 checks.
  - Smoke passed 4421/0.
- **PR B (CRM UI):**
  - **Customer card:** a Calls section with a nav badge, recordings streamed through the callable and played from a blob URL, and Confirm / Not them for a possible match. Thursday calls also appear in the timeline under "Calls & Texts".
  - **Home:** a `thursday-calls` inbox widget. It is pinned first for tenants with `thursday_config`; hiding it persists on `userSettings/{uid}.hideThursdayWidget`. The widget offers open, play, confirm, not-them, create lead, attach to any lead (search), reprocess and done.
  - **Source selects:** `#lSource` / `#qaSource` / `#bulkSourceSelect` now list all twelve canonical sources. `#lSource` was missing Google, Direct and Storm Alert, so saving a Thursday lead would have wiped its source.
  - **CSP:** `media-src 'self' blob:` added to the default and portal policies. Without it, no page could play audio.
  - **Tests:** `tests/thursday-ui-wiring.test.js` has 16 checks; 3 mutations were break-tested. A Playwright fixture harness passed 32/32 at 375 and 1280 px: no overflow, no page errors, XSS payloads inert, and the actions send the right callable payloads.
- **Open items:** see the handoff for this session.

## 7. How Thursday is actually wired in Bland (recon 2026-09-26, read-only, all backed up)

Backups of the number, persona, pathway and agent versions are in `%TEMP%/thursday-bland-backups` on Jo's PC.

- **The number's own voice fields are Bland placeholders.** `GET /v1/inbound/+15139405589` shows the default prompt ("You are an inbound agent for Bland AI..."), `pathway_id: null` and `max_duration: 30`. The pathway appears only under `sms_config`.
- **The persona owns the calls.** Persona `3cc9959f-dfee-47f3-a26f-05613b92eff9` ("Thursday - NBD Reception") lists the number in `inbound_numbers`. Every call record shows `persona_id` = that persona, `pathway_id` = `771a3ea4...` (version 8 on 09-26), and `max_duration: 5`.
- **The pathway is compiled from the v2 agent** `4c2b2b93-...` (description `v2-agent:4c2b2b93...`). It has two nodes, `__start` and `agent` (`compiledRole: hub`), and the agent's whole prompt is in the hub node. **Never hand-edit this pathway**: the next save of the agent in Bland recompiles it.
- **The agent is versioned** (semver), with dev, staging and production environments. On 09-26, production and staging were both **0.3.0**. Jo published 0.1.0 → 0.3.0 by hand between 22:21 and 22:32.
  - The snapshot has an **Initialization** code step (a fetch handler run at call start). It was disabled.
  - It also has `settings.voiceCall.maxDurationMinutes: 10` and tool mentions (end call, emergency connect to Joe).
- **Post-call webhook:** set on the **number** (`POST /v1/inbound/{number}` with `{webhook}`), the only webhook field Bland exposes for a persona-managed number.
  - Applied 2026-09-26 with `scripts/thursday-bland-setup.js set-webhook`.
  - The diff guard flagged two other fields: `custom_tools: null` → absent and `tools` → `[]`. Both are empty before and after, so this is a representation change.
  - The persona still listed the number afterwards, and the next real call reached the pipeline.
- **Greet by name:** `scripts/thursday-agent-lookup.js` builds a new agent version from production. It makes two changes:
  - it **enables the Initialization step**, which POSTs the caller's number to `thursdayCallerLookup` with a 2.5 s timeout; any failure means "unknown caller";
  - it appends a **RETURNING CALLERS** block and a **RECORDING NOTICE** to the agent prompt.
  - The script diffs the snapshot and refuses any other change.
  - It publishes to **staging** only. Production waits for Jo's test and OK (`--promote --yes`); `--rollback=0.3.0 --yes` restores the previous version.
  - The bearer token is the agent **secret** variable `THURSDAY_LOOKUP_TOKEN` (staging + production), with the same value as the Firebase secret. It was generated in memory and never printed.
- **Recordings are WAV at ~1 MB per minute.** A 10-minute call is ~10 MB, so `getThursdayRecording` streams 5 MB parts. Base64 inflates by 4/3, and callable responses cap at 10 MB.
- **The case-A lesson:** she called from a different phone than the one on her lead. The matcher attached her through the callback number she read out, but the caller-ID lookup could not know her.
  - A strong attach now stores the other number as `altPhone`/`altPhoneDigits` (never overwriting). The lookup and the matcher both read it.
  - A couple's lead ("Tom & Maria") is greeted "Is this Tom or Maria?".

## 8. Live verification, 2026-09-26

- **Secrets:** `BLAND_API_KEY`, `BLAND_WEBHOOK_SECRET` and `THURSDAY_LOOKUP_TOKEN` are each at version 2 (version 1 is the deploy stub). The Cloud Run services bind version 2.
- **Lookup (live):**
  - No token or a wrong token → **401**.
  - Case A's lead number → `known:true`, the husband's first name only, and `job_hint:"your upcoming project"` (before the couples fix).
  - An unknown number or a Thumbtack 669 proxy → unknown.
  - ~0.3 s warm, ~1.1 s cold.
- **Backfill dry-run over Thursday's 10 real calls:**
  - **Case A: PASS**, attached to her existing lead, URGENT.
  - **Case B: PASS**, a possible match to her Thumbtack lead.
  - Run with `--expect=<name>:attach --expect=<name>:no_new_lead`; the names stay in the shell, not the repo.
  - 6 silent calls with 0–2 caller words, 1 test ("Tommy Tester"), 1 from Jo's own cell.
- **Jo's end-to-end test call** (as a fictional homeowner) produced `bland_calls__b1bd2311-...`:
  - processed; a new lead with source Google, intake Phone — Thursday, stage New, scoped to NBD;
  - an URGENT high-priority task due today;
  - a 1.5 MB WAV saved;
  - email **sent**, push **sent**, SMS `skipped:flag-off`;
  - extraction cost $0.018.

## 9. Greeting, memory and dead air (2026-09-26, late)

- **Greet-by-name through the CRM did not fire on real calls.**
  - Agent 0.4.0 enabled the Initialization step, and the compiled pathway (version 10) carried the new prompt blocks.
  - But it had **no initialization node**, and during a real test call our lookup logs showed **no request**. The only lookups were manual tests.
  - Bland does not run the v2 Initialization step on phone calls. The next approach is a v2 custom tool (see the handoff).
- **Bland caller memory (`enableMemory`) greeted before the prompt.**
  - Two calls from the same number opened with the word-for-word identical line: "Hey, Greg, it's Thursday at No Big Deal. How's that leak over the garage doing?"
  - A confirm-first prompt rule (0.5.0) changed nothing. The line is produced before the agent node runs.
  - It also repeats a previous call's details to whoever holds that phone.
  - **Jo turned memory off (0.6.0).** The persona's production `memory_enabled` followed and read back as `false`.
- **Dead air (pre-existing since go-live, P1).** Across the calls since 09-24:
  - Most callers spoke first ("Hello?").
  - Thursday's first line came 13.9 s, 14.4 s, 7.9 s, 22.5 s and 15.9 s after connect.
  - The only quick openings (~4–5 s) were memory greetings, plus one 7.1 s generated greeting.
  - Three calls lasting 12–34 s had no words at all, and the "Hello?" hang-ups fit people giving up on silence.
  - Agent settings already say to speak first (`voiceCall.waitForGreeting: false`; the start node has `skipUserResponse: true`). The first line is LLM-generated from a ~12k-character prompt.
  - **Fix needed:** a fixed opening line (Bland UI setting or support), not a prompt tweak.
  - Meanwhile the CRM treats a silent call of 10 s or more from a non-owner number as a missed caller: an inbox row, no alerts.

## 6. Coordination notes

- **#1780** (viewer-refusing callables) adds `tests/viewer-callables.test.js`. It requires every exported callable and HTTP function to carry a verdict.
  - Whichever of #1780 and this work merges **last** must add these verdicts:
    - `thursdayCallAction`: **refused**. It already refuses viewers inline.
    - `getThursdayRecording`: a read, allowed.
    - `thursdayWebhook` and `thursdayCallerLookup`: public, signature- or bearer-gated, no user.
  - Once #1780's `assertNotViewer` is on main, switch `thursdayCallAction` to it.
- **Voice Intel's Claude step never runs** (found during recon, not fixed here). `voice-intelligence.js` `callClaudeJson` gates on `hasSecret('ANTHROPIC_API_KEY')`, which is not in the `SECRETS` registry, so every recording fails `[anthropic-not-configured]`. This module uses its own `defineSecret` plus `secretValue()` instead.
- **Thumbtack leads trigger no new-lead alert**, despite [THUMBTACK-WEBHOOK-2026-08](THUMBTACK-WEBHOOK-2026-08.md) §76 saying so.
