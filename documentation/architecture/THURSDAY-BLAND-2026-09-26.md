# Thursday (Bland AI receptionist) → NBD Pro — 2026-09-26

**Status:** built on 2026-09-26 in three PRs.
- **A:** the server pipeline.
- **B:** the CRM UI (Calls section, Home inbox widget, source-select fix).
- **C:** live caller lookup and the pathway greeting.

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

**Brief test cases, pinned in both suites:**
- Michelle Sherrill (1912 Russell St, Covington) → **attach** to her lead, even though her caller ID sits on another tenant's lead.
- Danuta (8586 Alexander Ct, 45069) → **possible match** to her Thumbtack lead ("Danuta K.", proxy phone, town only), never a duplicate.

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
   node scripts/thursday-backfill.js --since=2026-09-20      # dry-run: route per call + Sherrill/Danuta PASS/FAIL
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

## 6. Coordination notes

- **#1780** (viewer-refusing callables) adds `tests/viewer-callables.test.js`. It requires every exported callable and HTTP function to carry a verdict.
  - Whichever of #1780 and this work merges **last** must add these verdicts:
    - `thursdayCallAction`: **refused**. It already refuses viewers inline.
    - `getThursdayRecording`: a read, allowed.
    - `thursdayWebhook` and `thursdayCallerLookup`: public, signature- or bearer-gated, no user.
  - Once #1780's `assertNotViewer` is on main, switch `thursdayCallAction` to it.
- **Voice Intel's Claude step never runs** (found during recon, not fixed here). `voice-intelligence.js` `callClaudeJson` gates on `hasSecret('ANTHROPIC_API_KEY')`, which is not in the `SECRETS` registry, so every recording fails `[anthropic-not-configured]`. This module uses its own `defineSecret` plus `secretValue()` instead.
- **Thumbtack leads trigger no new-lead alert**, despite [THUMBTACK-WEBHOOK-2026-08](THUMBTACK-WEBHOOK-2026-08.md) §76 saying so.
