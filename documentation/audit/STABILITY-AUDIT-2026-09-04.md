# Stability + integration audit — 2026-09-04

> Two adversarial workflows (632 and 407 agents) swept the marketing site, the
> CRM client and `functions/` for live defects, then had every finding attacked
> by three independent refuters. This note is the durable record.
>
> Session PRs: [#1377](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1377) (TCPA consent) ·
> [#1378](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1378) (216-page SEO gate).
> Related: [FREE-API-INTEGRATIONS-RESEARCH-2026-09-02](FREE-API-INTEGRATIONS-RESEARCH-2026-09-02.md).
>
> **Update 2026-09-13 — "zero live alert policies" is no longer true, and "all
> ten now create successfully" was not the same as "all ten work".** Nine
> policies went live on 2026-09-13 after every condition was replayed against 7
> days of production data. That replay found three defects this note's
> create-then-delete validation could not see: `functions-error-rate` used
> `ALIGN_RATE` (a per-second threshold that could never fire);
> `email-queue-worker-stale` had no cross-series reducer (192 per-revision
> series, so every deploy would have paged); and `claude-budget-exceeded` keys
> on text that is never logged, so it is held. See
> [ALERT-POLICIES-LIVE-2026-09-13](ALERT-POLICIES-LIVE-2026-09-13.md).
>
> **Update 2026-09-26: two Voice Intel findings below are fixed.** Both sat
> unfixed for three weeks. They are "Anthropic calls can never be configured"
> (CRITICAL) and "onAudioUploaded … no tenancy check" (HIGH), and they had to
> ship together: making analysis work would have made the tenancy hole reach
> another tenant's CRM through `voiceConsumer`. Production had 0 recordings,
> so nobody was affected. See
> [VOICE-INTEL-ANTHROPIC-KEY-2026-09-26](VOICE-INTEL-ANTHROPIC-KEY-2026-09-26.md).

## Read this before using the lists below

**77 findings were never verified, and the workflow reported them as refuted.**

Both runs hit the session token limit partway through the verify phase — 441 of
632 agents in the stability run, 285 of 407 in the integration run, all dying
with `You've hit your session limit`. The scripts computed survival as
`refutedCount < ceil(votes/2)` over *surviving* votes, so a finding whose three
verifiers all died scored zero votes and fell into the killed bucket carrying an
empty reason string. It looked identical to a finding that had been argued down.

The honest split:

| | stability | integration |
|---|---|---|
| verified and survived 3 refuters | **47** | **6** |
| genuinely refuted (a real verifier said so) | 14 | 34 |
| **never verified — status unknown** | **47** | **30** |

Both unverified lists are reproduced in full below. Treat them as leads, not
findings. Several look serious on their face and cost nothing to re-check.

**Workflow lesson, worth carrying forward.** `survives` must distinguish *refuted*
from *unverified*. A finding with zero surviving votes is not refuted — it is
un-adjudicated, and silently binning it is the same species of false-green this
repo keeps catching in its own gates. Compute `survives` only when
`votes.length > 0` and carry an explicit `unverified` bucket:

```js
const good = votes.filter(Boolean);
const verdict = good.length === 0
  ? 'unverified'
  : (good.filter(v => v.refuted).length < Math.ceil(good.length / 2) ? 'survives' : 'refuted');
```

## Already fixed this session

- **The /estimate funnel's consent record never persisted.** `submitPublicLead`'s
  M-04 allowlist drops non-strings and never listed `tcpaConsent`, so the boolean
  was discarded on every submission; `ackHomeownerSms` then inferred consent from
  the collection name rather than reading the record. Both halves fixed in #1377
  — plus the funnel's *second* submit button (`skipOtpAndRequestCall`), which
  gates on the checkbox and never sent the field. That one was found by this
  audit *after* the gate was written, which is exactly the window in which the
  bug class ships.
- **216-page SEO gate** (#1378) — a 404 page that was indexable, a 117 KB eager
  JPEG hero, and a WebP file served as `image/jpeg`. Also two bugs in the gate
  itself, both caught by using it: `[\b]` is a backspace character rather than a
  word boundary, and length checks that counted raw HTML bytes scored `&#39;` as
  five characters.

## Confirmed stability findings (47)

Each survived three independent refuters. Grouped by the severity the finder
assigned; `needs deploy` means the fix touches `functions/` and must wait for a
Cloud Functions window.

### CRITICAL (10)

- **The sms_opt_outs record is written under an 11-digit key and read under a 10-digit key, so STOP is never honoured on any rep- or AI-initiated text**
  `functions/sms-functions.js:621` · S · needs deploy · silent-failure
  Homeowner (859) 555-0134 replies STOP. incomingSMS receives Twilio's `From: +18595550134`; line 619 computes `phoneDigits = '18595550134'` (11 digits, country code kept) and line 621 writes `sms_opt_outs/18595550134`. The homeowner gets the TwiML "You've been unsubscribed from NBD Pro SMS". Next day
- **checkStormAlerts blasts marketing SMS to storm subscribers every 30 minutes with no opt-out check of any kind**
  `functions/sms-functions.js:1048` · M · needs deploy · compliance
  A homeowner signs up at /storm-alerts, gets a storm text, replies STOP and is told "You've been unsubscribed from NBD Pro SMS". incomingSMS writes sms_opt_outs and returns — it never touches their `storm_alert_subscribers` doc, whose `active` flag is set server-side to true at signup (handlers/integ
- **submitDealAcceptance burns the single-use token in a transaction, then warn-swallows the write that stores the tier, price and signature — and still returns ok:true**
  `functions/deal-acceptance.js:296` · M · needs deploy · data-loss
  Homeowner opens the deal room and taps Accept. The transaction at :260-275 atomically flips deal_accept_tokens/{token}.status from 'pending' to 'accepted'. The very next write — deal_rooms/{dealId}.set({acceptedTier, acceptedPrice, acceptedFinancing, acceptedSignature, scheduledInstallDate}) at :286
- **enforceLapseForCompany stamps lapseEnforced:true even when zero seats were actually paused, and the scan query permanently excludes it afterwards**
  `functions/lapse-enforcement.js:75` · S · needs deploy · silent-failure
  A tenant's subscription is cancelled; 14 days later enforceLapsedSeats picks it up. For each active member the loop calls getAuth().updateUser(uid, {disabled:true}) at :59. If that Auth call throws for every member — an Auth outage, a quota blip, a service-account permission regression — the catch a
- **Voice Intelligence's Anthropic calls can never be configured — ANTHROPIC_API_KEY is not in the _shared SECRETS registry, so hasSecret() is hard-coded false**
  `functions/integrations/voice-intelligence.js:276` · S · needs deploy · dead-wiring
  A rep records a call and the audio lands under the voice prefix. onAudioUploaded fires, transcribeGroq succeeds (GROQ_API_KEY *is* in the registry) and the doc moves to status:'analyzing'. analyzeTranscript -> callClaudeJson -> hasSecret('ANTHROPIC_API_KEY') evaluates SECRETS['ANTHROPIC_API_KEY'] wh
  **Fixed 2026-09-26.** `callClaudeJson` now reads the bound param through `secretValue()`. See [VOICE-INTEL-ANTHROPIC-KEY-2026-09-26](VOICE-INTEL-ANTHROPIC-KEY-2026-09-26.md).
- **The V2 catalog/Job-Template estimate path never passes the tenant's Overhead %, Profit %, Material Markup %, Round-To or Minimum Job settings to the pricing engine — every such estimate silently prices at the engine's hardcoded 25/10/10**
  `docs/pro/js/estimate-v2-ui.js:1712` · M · silent-mispricing
  Owner sets Settings → Estimates to Material Markup 40%, Overhead 15%, Profit 15% (dashboard.html:3403-3405; saved by dashboard-bootstrap.module.js:4488-4490 into nbd_est_settings_v3 and userSettings). Rep builds a catalog (line-item) estimate — the DEFAULT mode (state.mode:'line-item', estimate-v2-u
- **createSignRequest trusts the client-written htmlPath, so getSignDocument serves another tenant's contract HTML to an unauthenticated token holder**
  `functions/remote-signing.js:195` · S · needs deploy · cross-tenant-read
  A `viewer`-role user in tenant A opens a teammate's customer page. firestore.rules:377-379 lets any isCompanyReader (company_admin/manager/**viewer**) READ leads/{teammateLead}/documents/{docId}, so they copy its htmlPath, e.g. `documents/<teammateUid>/<teammateLeadId>/<docId>.html`. They then creat
- **Every Resend send failure is recorded as a success — the SDK returns {data:null,error} instead of throwing, and all 19 call sites only catch throws**
  `functions/email-functions.js:391` · M · needs deploy · silent-failure
  Resend rejects a send with any non-2xx (unverified from-domain, 429 rate limit, suspended account, 422 validation, 5xx). sendEmail's try block completes normally: email_log gets status:'sent', and the HTTP response is {success:true, id:undefined} -> nbd-comms.js:259 toasts 'Email sent' to the rep. T
- **STOP opt-outs are stored under an 11-digit key but every send-path checks a 10-digit key, so TCPA opt-outs are silently ignored**
  `functions/sms-functions.js:619` · S · needs deploy · key-shape-mismatch
  A homeowner whose lead phone is stored as "(513) 555-0123" replies STOP. incomingSMS receives Twilio's `From` = "+15135550123" and writes the opt-out doc at `sms_opt_outs/15135550123` (leading country-code 1 kept). Later the rep taps Text; NBDComms.sendSMS posts `to` = the lead's raw stored phone, s
- **The documented SMS spend kill-switch is a no-op: setting STORM_MAX_SMS_PER_DAY/RUN to 0 silently restores the default cap**
  `functions/sms-functions.js:1009` · S · needs deploy · dead-kill-switch
  Twilio spend is running away during a multi-county severe-weather event. The operator opens SPEND_KILLSWITCH.md, reads "Set either to `0` on the checkStormAlerts revision to halt storm fan-out without a deploy", and sets STORM_MAX_SMS_PER_DAY=0 (and/or STORM_MAX_SMS_PER_RUN=0) on the revision. Numbe

### HIGH (20)

- **checkStormAlerts' per-run pacing exceeds its own function timeout, so any real storm fan-out is force-killed at roughly a third of its stated cap**
  `functions/sms-functions.js:1073` · S · needs deploy · correctness
  A Severe hail warning covers three counties and 300 active subscribers match. The fan-out sleeps 1100 ms after every send (line 1073) on top of the Twilio round-trip and the `storm_alerts_sent` write, so ~1.4-1.8 s per subscriber. The declared ceiling MAX_SMS_PER_RUN is 250, which needs at least 275
- **C5 auto-invoice writes its only idempotency guard last and passes no Stripe idempotency key, inside a 15-second webhook the provider retries — a signed contract can mint duplicate draft invoices**
  `functions/integrations/esign.js:443` · M · needs deploy · money
  BoldSign posts a 'completed' event. esignWebhook (timeoutSeconds: 15, :198) updates the estimate to signed at :276, then calls createStripeInvoiceForEstimate at :284. That function's ONLY duplicate guard is `if (est.stripeInvoiceId) return` at :336, and stripeInvoiceId is not written until :443 — af
- **hailMatchCron matches zero leads — `.where('deleted','==',false)` is the only such query in the repo and no live lead-create path writes the field**
  `functions/integrations/hail-cron.js:119` · S · needs deploy · dead-wiring
  The nightly 09:00 America/Chicago sweep runs, queries leads where deleted == false, and Firestore returns 0 docs because equality filters skip documents that lack the field entirely. Every lead-create path omits it: docs/pro/js/repos.js:77-86 stampCreate() writes only userId/companyId/createdAt/upda
- **Every non-admin rep sees all integrations as "not set up" — the client short-circuits integrationStatus to an empty map and requireConfigured() then fails closed for measurement, e-signature and parcel**
  `docs/pro/js/integrations-client.js:62` · M · needs deploy · dead-wiring
  A rep whose role is 'member' (the default from nbd-auth.js:521) opens an estimate and taps Send for Signature. status() sees _isAdminCaller() false, populates state.status = { configured: {}, providers: {} } without ever calling the server, and requireConfigured('boldsign','E-signature') reads state
- **Emailed and printed invoices show "Balance Due" equal to the FULL total right below "Deposit due", so the homeowner reads deposit + balance as more than the invoice total**
  `docs/pro/js/invoice-pipeline.js:1321` · S · customer-facing-money
  Per-SQ V2 estimate, grandTotal $14,200 → est.deposit = round((14200×0.5)/25)×25 = $7,100 (estimate-v2-ui.js:1791-1793). createInvoiceFromEstimate writes depositAmount 7100, total 14200 and balanceDue: total (14200). The deposit block's gate (depositAmount > 0 && depositAmount < total) passes, so the
- **A pass-through-only estimate throws a TypeError in renderScope — the shell object returned when the catalog scope is empty has no `internal` block**
  `docs/pro/js/estimate-v2-ui.js:2307` · S · crash
  Default builder state is mode:'line-item' (estimate-v2-ui.js:63) with an empty scope. Rep opens the V2 builder and clicks Auto-measure; applyMeasurementResult auto-adds the $75 'SVC MEASURE-RPT' pass-through (:1403-1414) and calls render(). getCurrentEstimate takes the `items.length ? ... : shell` b
- **companies/{id} update freezes only plan+ownerId, so an owner can client-write siteSlug and bypass the siteSlugs uniqueness lock — hijacking another tenant's microsite URL and its inbound leads**
  `firestore.rules:1236` · S · cross-tenant-hijack
  setSiteSlug (functions/handlers/public-site.js:254-288) is the ONLY path that enforces slug uniqueness, via the admin-SDK-only claim doc siteSlugs/{slug}. But firestore.rules:1236 lets the company doc's owner write any field except plan/ownerId directly. From devtools an attacker who owns companies/
- **onAudioUploaded treats a client-chosen Storage path segment as a lead id with no tenancy check, planting a recording inside another tenant's lead and reading that lead's homeowner name back to the uploader**
  `functions/integrations/voice-intelligence.js:450` · S · needs deploy · cross-tenant-write
  storage.rules:168-174 lets any authenticated user write `audio/{theirOwnUid}/{anything}/{anything}.webm` — the second and third path segments are entirely attacker-chosen. parseAudioPath (line 68-77) maps them to {uid, leadId, recordingId} and processRecording uses leadId verbatim with no check that
  **Fixed 2026-09-26.** `uploaderMayRecordOn()` refuses a lead outside the uploader's tenant, before any write or vendor call. See [VOICE-INTEL-ANTHROPIC-KEY-2026-09-26](VOICE-INTEL-ANTHROPIC-KEY-2026-09-26.md).
- **/photos never constrains leadId, and the docLeadInMyCompany read clause keys on it — so a photo can be injected into another tenant's customer-page gallery**
  `firestore.rules:666` · M · cross-tenant-write
  The 2026-08-02 audit froze userId+companyId on /photos update specifically to stop 'planting an image in that company's shared gallery', but leadId was left free on BOTH create and update — and the read rule's second clause resolves tenancy through leadId, not companyId. So the same injection still 
- **reply_to: is silently dropped by the Resend SDK (it only reads replyTo) — 7 call sites send no Reply-To header at all**
  `functions/lead-alert.js:302` · S · needs deploy · dead-wiring
  A homeowner submits the public contact form. leadAlertContact emails Joe with reply_to set to the homeowner's address so he can hit Reply and be in their inbox. parseEmailToApiOptions builds the API body from a fixed allowlist that reads only `email.replyTo`; the `reply_to` key is not in the allowli
- **The TCPA STOP gate never matches: opt-outs are keyed on 11 digits (E.164 From) but every outbound check looks up 10 digits (rep-typed phone)**
  `functions/sms-functions.js:619` · S · needs deploy · compliance
  A homeowner texts STOP. incomingSMS computes phoneDigits from Twilio's From ('+18594207382') with a plain non-digit strip -> '18594207382' and writes sms_opt_outs/18594207382, then replies 'You've been unsubscribed'. Later a rep texts that lead from the CRM; nbd-comms.js passes lead.phone through ve
- **checkStormAlerts fans out SMS without ever consulting sms_opt_outs, and a STOP never deactivates the storm subscriber — the message's own 'Reply STOP' promise is unenforced**
  `functions/sms-functions.js:1042` · S · needs deploy · compliance
  A homeowner subscribes to storm alerts on the public site, gets one alert whose body ends 'Reply STOP to unsubscribe.', and replies STOP. incomingSMS writes sms_opt_outs/<digits> and confirms the unsubscribe. The next distinct NWS alertId (a new storm, hours later) produces a new dedupeKey `${alertI
- **Three of the four push-notification triggers are gated on lead.assignedTo, a field no write path in the repo ever sets — they have never fired**
  `functions/push-functions.js:219` · S · needs deploy · dead-wiring
  A rep enables 'New Lead' push and adds a lead in the CRM. onNewLead reads leadData.assignedTo, finds undefined, logs '[Push] No assigned rep for lead' and returns — no push, ever. Same for onClaimStageChange:472 (a claim moving to 'Adjuster Scheduled' notifies nobody) and onFollowUpDue:410 (the 08:0
- **Two live /photos write paths omit `createdAt`, and both gallery queries orderBy('createdAt') — Firestore silently excludes those photos**
  `docs/pro/js/customer-bootstrap.module.js:2462` · S · needs deploy · silent-exclusion
  A rep uploads a photo from the customer page's quick-upload. The photo doc gets `date` and `uploadedAt` but no `createdAt`. It renders in the customer photo strip (that query has no orderBy), so the rep believes it saved — but the Photos tab gallery (photo-engine getPhotosForLead) and the dashboard 
- **submitSignature stamps signedAt + signedSha256 even when the signed HTML failed to upload, leaving a burned token and a contract record that claims a signature nobody stored**
  `functions/remote-signing.js:456` · M · needs deploy · partial-write
  A homeowner signs remotely. The token is burned inside the transaction (pending -> signed). The next step, saving the signed HTML over `info.htmlPath`, hits a transient Storage 5xx/timeout — caught and logged as a warning. Execution continues and the documents doc is stamped signedAt / signedRemotel
- **onLeadDeleted reaps only the `documents` subcollection — ai_drafts, tasks and portal_messages survive a hard delete and keep feeding the collectionGroup analytics**
  `functions/lead-artifact-cleanup.js:188` · M · needs deploy · orphaned-children
  **Fixed 2026-09-25 (branch `fix/lead-subtree-sweep`):** onLeadDeleted now deletes the lead's whole subtree, and it turned out to be a security hole as well as a leak: whoever re-creates the lead id owns the leftovers. See [LEAD-SUBTREE-HIJACK-2026-09-25](LEAD-SUBTREE-HIJACK-2026-09-25.md).
  A rep permanently deletes a prospect (dashboard-actions.js:1858, three confirmations plus a typed DELETE). onLeadDeleted reaps Storage prefixes, /photos and the `documents` subcollection — but Firestore cascades nothing, and leads/{id}/ai_drafts, /tasks and /portal_messages are never touched. Those 
- **The customer-page photo delete removes only the Firestore doc, orphaning the Storage original, thumb and three variants beyond any future sweep**
  `docs/pro/js/customer-tasks-ui.js:1567` · M · orphaned-storage
  A rep deletes a photo from the customer page (single delete, or the multi-select bulk delete at :913). Only the /photos doc goes; `storagePath`, the thumb, and the three image-pipeline variants at `photos/{uid}/{leadId}/_variants/{base}_{thumb,med,full}.webp` all stay in the bucket. Because image-pi
- **The daily health digest's Anthropic token section reads a field nothing writes, so AI token spend always renders as 0**
  `functions/health-digest.js:118` · S · needs deploy · silent-failure
  A compromised account or a runaway client loop burns through the 200k/uid/day Claude budget across many users. The next morning's health digest — the one daily artifact that lands in Jo's inbox — renders 'Anthropic Token Usage (today): 0 tokens reserved across all users' and a table of uids each sho
- **verify-backup.sh — the first command in the P0 backup runbook — defaults to the bucket that was deliberately abandoned and never created**
  `scripts/verify-backup.sh:28` · S · broken-runbook
  Backups have stopped. The operator opens ALERT_RESPONSE.md §5 ('Backup cron stale > 26h ... this is a restore-capability outage — treat as P0') and runs its stated first action, `./scripts/verify-backup.sh`, with no BACKUP_BUCKET exported. It defaults to gs://nobigdeal-pro-backups — the bucket FUNCT
- **The health digest's Stripe webhook counter reads an arbitrary 200-doc slice by document ID, so it undercounts toward zero as the collection grows**
  `functions/health-digest.js:95` · S · needs deploy · silent-failure
  stripe_events is keyed by the Stripe event id (`stripe_events/${event.id}` — evt_<random>), so a query with `.limit(200)` and no orderBy returns the 200 lexicographically-lowest document IDs, a fixed arbitrary slice frozen early in the project's life. Once the collection exceeds 200 docs, a newly-wr

### MEDIUM (17)

- **A STOP/HELP/START reply returns before the lead match and before the sms_log write, so an opt-out leaves no trace anywhere in the CRM**
  `functions/sms-functions.js:634` · M · needs deploy · silent-failure
  Homeowner replies STOP. The handler writes the opt-out doc and returns at line 634 — above the MessageSid idempotency claim (657), above the phoneDigits lead lookup (700-715), above the `leads/{id}/notes` inbound-note write (762), and above the terminal `logSMSToFirestore(... 'received' ...)` at 895
- **The STOP and HELP auto-replies are hardcoded with NBD's brand and support number on a long code that serves every tenant**
  `functions/sms-functions.js:631` · M · needs deploy · multi-tenant-leak
  One shared Twilio number serves all tenants — the file's own header at 40-43 says so ("one shared Twilio number serves every tenant"), and sendD2DSMS goes to the trouble of resolving `companyProfile/{tenantKey}.brand.legalName` at 458-471 and rewriting 'NBD Home Solutions' out of the template body p
- **The approved-AI-draft outbound text logs to sms_log without companyId, so it is invisible in the team Communication Log while its inbound half is visible**
  `functions/sms-functions.js:1275` · S · needs deploy · silent-failure
  A company_admin or manager opens a customer record. customer-tasks-ui.js takes the team-thread branch and queries sms_log with `where('leadId','==',leadId)` AND `where('companyId','==',companyId)`. logSMSToFirestore only writes the field when it is truthy (`if (companyId) row.companyId = companyId;`
- **The estimate funnel's "skip verification" path checks the TCPA box but never sends tcpaConsent, so those leads will fail the new consent gate that the rest of the funnel passes**
  `docs/assets/js/inline/4053149b2f.js:816` · S · dead-wiring
  Two buttons write into estimate_leads. `submitAndGetEstimate` includes `tcpaConsent: document.getElementById('tcpaConsent').checked` in its payload (line 955). `skipOtpAndRequestCall` — the "Skip verification — just have Joe call me" escape hatch — reads the same checkbox at line 773 and refuses to 
- **transcribeVoiceMemo returns success:true with the transcript after the write that persists it to the lead timeline has failed — and writes nothing at all, with no log, when the transcript comes back empty**
  `functions/integrations/voice-memo.js:149` · S · needs deploy · silent-failure
  A rep records a voice memo on a lead. Deepgram is billed and returns a transcript. The only durable output of this feature is the leads/{leadId}/activity row written at :137-145 — but it is wrapped in a try whose catch at :146 logs logger.warn('voice-memo activity write failed') and swallows. Execut
- **Voice pipeline accepts a 200 MB upload into a 512 MiB instance and then hands it to Groq, whose documented cap is 25 MB — burns the download and dies**
  `functions/integrations/voice-intelligence.js:60` · S · needs deploy · silent-failure
  A rep uploads a 40 MB WAV/MP3 recording of a long adjuster meeting. MAX_AUDIO_BYTES is 200 MB so the size gate at :195 passes. transcribeGroq calls file.download() into a Buffer, then copies it into `new Blob([buffer])`, then again into FormData — roughly 3x the file in resident memory on an instanc
- **`Number(null) === 0` defeats the documented 50% deposit fallback — every V2 line-item estimate invoices with a $0 deposit while its terms still read "50% deposit due upon scheduling"**
  `docs/pro/js/invoice-pipeline.js:499` · S · silent-failure
  V2 catalog/line-item estimates never set estimate.deposit — it is assigned only inside the per-SQ overlay (estimate-v2-ui.js:1791). _buildSavePayload therefore persists `deposit: null` (estimate-v2-ui.js:2868: `(estimate.deposit != null ? Number(estimate.deposit) : null)`). In createInvoiceFromEstim
- **The homeowner's rendered estimate PDF states a 25% deposit — hardcoded, and contradicted by the 50% the CRM actually persists, invoices and prints everywhere else**
  `docs/pro/js/estimate-v2-ui.js:2727` · S · customer-facing-money
  Rep finalises a $14,200 per-SQ cash estimate. estimate-v2-ui stamps estimate.deposit = $7,100 (50%, :1791-1793), _buildSavePayload persists deposit: 7100, estimate-finalization.js:757-768 prints "Deposit (50% — Upon signing) $7,100.00", and the invoice terms say "50% deposit due upon scheduling" (in
- **Reopening a minimum-job estimate drops the "Minimum Job Charge Adjustment" row — the regenerated scope prints Subtotal + Tax that don't reach the stated RCV**
  `docs/pro/js/estimate-v2-ui.js:2942` · S · customer-facing-money
  Rep builds a small insurance/line-item scope: retailBeforeOHP $400, O&P $80, subtotal $480, tax $0 → resolveEstimate floors total to the $2,500 job minimum and returns minJobApplied: true (estimate-logic-engine.js:956-960). Printed live, estimate-finalization.js:539-541 adds a "Minimum Job Charge Ad
- **Zero-value scope rows that every preset persists make createStripePaymentLink reject the whole invoice with 400 before it ever reaches the totals reconciliation**
  `functions/stripe.js:1184` · S · needs deploy · dead-wiring
  The 'standard-reroof' preset deliberately loads all three dumpster sizes; the engine's sq-gated formulas (estimate-logic-engine.js:724-727) resolve two of them to qty 0. _buildSavePayload maps ALL estimate.lines (estimate-v2-ui.js:2825), unfiltered, so those two rows persist with quantity 0 / total 
- **deal_rooms update does not freeze userId, so a rep can hand a fabricated deal card to another tenant's Close Board**
  `firestore.rules:1502` · S · cross-tenant-write
  Every other owner-keyed collection in this file freezes provenance on update after the 2026-07-08 /pins fix (/pins:709, /zones:734, /knocks:1152, /territories:1188, /training_sessions:1286, /photos:667 all carry `didNotChange(['userId', ...])`). /deal_rooms was missed. An authenticated user creates 
- **The lead-alert triggers have no idempotency claim, so an at-least-once redelivery re-sends Joe's alert email + SMS and a duplicate Joe-branded ack to the homeowner**
  `functions/lead-alert.js:379` · M · needs deploy · trigger-idempotency
  Firestore onDocumentCreated is at-least-once. A duplicate delivery of the same estimate_leads create (Eventarc redelivery, or a container that is killed after alertJoe's sends but before the platform records the ack) re-enters onLeadAlert with the same document. isFollowUpEvent does not suppress it,
- **The email-queue reaper re-queues stale 'sending' rows with no MAX_ATTEMPTS ceiling, so the duplicate-send loop its own comment calls 'bounded by MAX_ATTEMPTS' is actually unbounded**
  `functions/integrations/email-queue-worker.js:79` · S · needs deploy · unbounded-retry
  A row is claimed (status:'sending'), Resend accepts and delivers the message, but the tick is killed before the `status:'sent'` write lands (240s timeout while draining 25 rows sequentially, or an OOM at 256MiB). Ten minutes later the reaper flips it back to 'pending' and bumps attempts. The next ti
- **incomingSMS writes its dedupe claim before doing any work, so a tick that fails mid-processing loses the homeowner's text permanently — the retry is swallowed as a duplicate**
  `functions/sms-functions.js:663` · M · needs deploy · data-loss
  A customer texts back. incomingSMS creates sms_inbound_seen/<MessageSid> first, then does the lead match, note write, generateAIDraft (an Anthropic call with a 10s internal budget, inside a 30s function), and the FCM push. If anything after the claim throws or the function times out, control reaches
- **Deleting a D2D knock orphans its photos and audio in Storage with no reaper anywhere**
  `docs/pro/js/d2d-tracker-core-2026b.js:2146` · M · needs deploy · orphaned-storage
  A rep deletes a knock from the D2D tracker. The knocks doc is removed and nothing else. Knock photos live at `photos/{uid}/d2d/{knockId}/{ts}_{name}` with image-pipeline variants beside them, and knock voice memos at `audio/{uid}/d2d/{knockId}_{ts}.webm`. There is no onDocumentDeleted for knocks (im
- **A homeowner accepting a deal whose deal room was deleted resurrects a userId-less zombie doc, and the acceptance plus signature become unreachable**
  `functions/deal-acceptance.js:286` · M · needs deploy · partial-write
  A rep deletes a deal room from the Close Board (close-board.js:251 deleteDoc). Nothing revokes the outstanding `deal_accept_tokens` — that collection is admin-SDK-only and no delete path touches it. The homeowner opens the still-valid /deal/<token> link and accepts. The transaction burns the token, 
- **removeMember writes a team member's raw email address into Cloud Logging, in the same file that hashes it for createTeamMember**
  `functions/handlers/admin.js:838` · S · needs deploy · pii-in-logs
  A company admin removes any team member. The callable writes that person's plaintext email address into Cloud Logging, where it sits for the log bucket's full retention and is readable by anyone with roles/logging.viewer on the project. The identical concern was already recognised and fixed 275 line

## Integration + leverage survivors (6)

- **Kentucky 3-inch aerials on the D2D tracker: nothing exists yet, and it shares a CSP line with the Wayback fix** — status: `not-built`, effort S, needs CSP
  - Seam: docs/pro/js/d2d-tracker-core-2026b.js:186-191 (add a fifth BASEMAPS entry) + firebase.json:84-85 img-src — the same two CSP lines the Wayback fix edits, so sequence them in one PR
- **One alert file is deployable right now and is the fastest possible move from zero alarms to one** — status: `built-but-dead`, effort S
  - Seam: monitoring/alert-function-latency.json:32 (swap the placeholder for the two real channel IDs), then gcloud monitoring policies create
  - **Jo must:** Confirm +1 513-315-2406 is still the phone he wants woken up, and reply to the first test SMS so he knows the channel actually delivers — I can create the policy but cannot prove Google's SMS reaches 
- **When a customer texts you back, the alert goes to one arbitrarily-picked device — and if that token is dead, you never find out** — status: `partly-built`, effort S, needs deploy
  - Seam: functions/sms-functions.js:830-860 — replace the hand-rolled block with `require('./push-functions').sendCustomNotification(notifyUid, title, body, {leadId, type:'incoming_sms', from})` (push-functions.js:590).
  - **Jo must:** After it ships, confirm on the phone that notifications are actually granted for the installed PWA — nothing in the repo can prove that from here.
- **The HEIC photo parser was written, shipped, and is blocked by your own CSP — it has never run once** — status: `built-but-dead`, effort S
  - Seam: docs/pro/js/photo-smart-ingest.js:73 — replace the skypack URL with a vendored copy under docs/assets/vendor/exifr/<version>/, which needs NO firebase.json change at all. Adding cdn.skypack.dev to the CSP would also work
- **Dependabot security alerts are switched OFF, and the config file states in writing that they are on** — status: `built-but-dead`, effort S
  - Seam: GitHub repo Settings > Advanced Security > Dependabot alerts (+ Dependabot security updates). Then correct the now-true-again comment at .github/dependabot.yml:4-6.
  - **Jo must:** Yes — repo-owner settings toggle, cannot be done from the codebase or by CI.
- **The restore path has never been run against real GCP — and a full drill costs well under a dollar** — status: `partly-built`, effort M
  - Seam: documentation/runbooks/RESTORE_FROM_BACKUP.md §2 already contains the exact working recipe (gcloud firestore databases create, the gcp-sa-firestore IAM binding, gcloud firestore import). Run it once against gs://nobigdea
  - **Jo must:** Yes, and only Jo — creating a GCP project and granting the Firestore service-agent IAM role are owner-level actions on real infrastructure.

## NEVER VERIFIED — stability (47)

Leads, not findings. Each was reported by a finder and then lost all three
verifiers to the session limit.

- [dead-wiring-crm] Photo-upload preview ✕ button always deletes the FIRST queued photo — `+ i +` is inside the string literal, so data-arg ships as literal text
- [dead-wiring-crm] Customer photo-upload metadata UI does not exist — three getElementById reads and two window-exported selectors are orphaned, so every photo saves with empty damageType/location and phase hardcoded to 'During'
- [dead-wiring-crm] Settings → 'Secondary Toolbar' toggle is a no-op that toasts success — applyCrmSecHeaderState bails on #crmSecRestoreBtn, which exists in no HTML
- [dead-wiring-crm] The Pro Tips & D2D Tricks modal is unreachable — openTips() has zero callers anywhere in the repo
- [dead-wiring-crm] Settings → Appearance 'Reset to Default' accent button changes nothing on screen — it clears saved state but never removes the inline --orange override or resets the swatch (wrong element id)
- [dead-wiring-crm] After '✓ Apply Theme', the theme grid keeps the ✓ / accent border on the OLD theme — the refresh hook targets #te-theme-sections, which does not exist
- [dead-wiring-crm] Rep OS weather card and the D2D storm-alert banner are permanently dead — both gate on localStorage 'nbd_weather_key', which nothing in the repo ever writes
- [dead-wiring-crm] 'Solar Analysis' always falls back to a latitude-only guess and tells the user to configure a key that has no UI — 'nbd_google_solar_key' is read once and written nowhere
- [scheduled-crons] Both storm SMS crons ignore the sms_opt_outs STOP register, so a homeowner who replies STOP keeps getting storm blasts
- [scheduled-crons] hailMatchCron's `where('deleted','==',false)` matches almost no real leads -- neither lead-create path writes the field
- [scheduled-crons] onFollowUpDue reads two lead fields that no code in the repo ever writes -- the daily 08:00 follow-up push has never fired
- [scheduled-crons] weeklyDigest reports any merely-EDITED won lead as "won this week", inflating the Monday revenue number
- [scheduled-crons] migrationsTick and runMigrations both inherit the 60s default timeout, and the heartbeat that the staleness alert watches is only logged after the work finishes
- [scheduled-crons] hailMatchCron reads the same first 500 leads every day -- the "larger tenants roll over to the next day run" comment describes a cursor that does not exist
- [scheduled-crons] runAbandonRecovery's 200-doc cap over a 30-day window is filled oldest-first by already-recovered rows, starving new abandoners
- [scheduled-crons] stormWatch reads the subscriber list without the `active == true` filter that checkStormAlerts uses, re-texting numbers the system already deactivated
- [money-and-estimates] The invoice a tenant previews and prints is branded "NBD ROOFING" for every company — the one surface the white-label sweep of this file missed
- [client-runtime-errors] prefs-sync can never push a pref DELETION to Firestore, so turning "Show Prospects"/"Show Snoozed" off silently reverts on the next load
- [client-runtime-errors] Broken string concatenation puts the literal text " + i + " in data-arg, so the photo-queue remove button always deletes the FIRST staged photo
- [client-runtime-errors] The CRM "Secondary toolbar" setting is still a no-op: every apply path bails on #crmSecRestoreBtn, an element that exists nowhere in the repo
- [client-runtime-errors] HEIC/HEIF/TIFF/AVIF photos silently lose all EXIF (GPS + capture time): the exifr lazy-load hits cdn.skypack.dev, which is absent from every CSP script directive
- [client-runtime-errors] The public Storm Check tool's storm-report fetch is CSP-blocked: mesonet.agron.iastate.edu is in img-src but not connect-src, so the evidence-backed verdict never fires
- [client-runtime-errors] Property Intel's US Census enrichment is dead — geocoding.geo.census.gov is not in connect-src, so the AI prompt never gets a census tract
- [client-runtime-errors] The map's Weather overlay toasts "Live weather overlay active" and renders nothing — tilecache.rainviewer.com is absent from img-src
- [client-runtime-errors] The service worker's 500-tile eviction cap is unreachable: ESRI satellite tiles route to handleCDNRequest and accumulate uncapped in the same cache as the app's JS/CSS
- [test-honesty] The classic↔V2 estimate "parity" gate re-implements the code under test and never reads estimates.js — the D-2 half cannot fail
- [test-honesty] The "inline-script gate" in CI checks zero inline scripts and only validates syntax — it does not enforce the no-inline-script CSP invariant it is believed to enforce
- [test-honesty] The EXIF/GPS privacy gate never inspects PNG (or any non-JPEG/WebP) images, but reports a scan count that reads as complete coverage
- [test-honesty] The tripwire that guards the two aggregated buckets only inspects the STEP block and stops at the first workflow file, so all 116 gating suites can be de-gated while it prints "workflow coverage clean"
- [test-honesty] job-templates.test.js keeps a soft-skip that exits 0 with no assertions, and the aggregated runner's failure scanner cannot see it
- [test-honesty] A test in the required public-e2e job is permanently skipped — the page it targets does not exist in the repo
- [public-site] /storm-check's storm-data lookup is blocked by the site CSP — the tool silently reports "no storm history" for every visitor
- [public-site] Admin Project Codex: four session-log fields are silently saved as empty because their ids are duplicated by search-filter buttons earlier in the document
- [public-site] GA4 is not loaded on any of the 163 service/area pages that host the quick lead form — every conversion on the SEO landing surface is invisible
- [public-site] Three public tools hard-gate submission on a TCPA texting-consent checkbox, then discard it — the consent is never sent and the collection is not consent-bearing
- [public-site] 15 indexed pages ship FAQPage structured data whose Q&A text appears nowhere on the page
- [public-site] /inspect accepts photo uploads that are never transmitted — only the filenames are sent, and the success card doesn't say so
- [public-site] /review hero shows a hardcoded "5.0 ★★★★★ Verified on Google" that is never invalidated when the live reviews feed fails
- [public-site] A blog post's og:url points at a different article, so every social/messaging share of it resolves to the wrong post
- [pwa-offline-sw] isOnAuthGatedPath() lists only .html paths, but cleanUrls makes every real /pro pathname extensionless — the forced post-deploy reload never fires on customer.html or login.html
- [pwa-offline-sw] standalone link interceptor preventDefaults every in-DOM <a download> blob anchor — CSV/photo exports navigate the installed app to a just-revoked blob instead of downloading
- [pwa-offline-sw] standalone window.open() resolves relative URLs against location.origin instead of the document URL — the dashboard Help buttons send the installed app to a 404 at /how-to.html
- [pwa-offline-sw] FCM notificationclick calls client.navigate() on a window controlled by a different service worker registration — it always rejects, so a tapped push focuses the app but never opens the record
- [pwa-offline-sw] Every push deep link carries query params nothing in the app reads; the claimUpdate link uses ?leadId= where customer.html reads ?id=, so the notification opens an empty customer page
- [pwa-offline-sw] standalone-compat injects body{padding-top: env(safe-area-inset-top)} on top of the header rule that already reserves the notch, double-counting the inset on a border-box 100dvh flex body
- [pwa-offline-sw] D2D offline-knock background sync is dead wiring: the page registers tag 'nbd-d2d-sync' but sw.js only handles 'nbd-sync-queue', and the FLUSH_OFFLINE_QUEUE message it listens for is posted by no service worker
- [pwa-offline-sw] FCM notificationclick never inspects event.action, so the 'Dismiss' action button on appointment/follow-up notifications opens and focuses the CRM instead of dismissing

## NEVER VERIFIED — integration (30)

- [dead-integrations] Your Google reviews are blank on all 15 marketing pages right now — the key is a placeholder
- [dead-integrations] The mic buttons in the CRM cannot work — dictation is wired to a key that was never set, while the key that IS set sits 300 lines away
- [dead-integrations] Four money-touching automations run every day and throw the email away — the on-switch was never set on any deployed function
- [dead-integrations] Server-side crash reporting is dark — the SDK is installed, the browser half is live, only the DSN is a placeholder
- [dead-integrations] Ten ready-to-run alert policies sit in the repo and zero are live, on a project where alerting is free
- [dead-integrations] The bot-blocker on the public lead forms is off at both ends — and its CDN host is already allowed by CSP
- [dead-integrations] '__unset__' is a truthy string, so three functions believe they are configured when they are not
- [dead-integrations] resolveAddress is deployed, rate-limited, App Check-gated, and structurally incapable of returning an address
- [dead-integrations] NBD_ESIGN_PROVIDER is a switch wired to nothing, and BoldSign behind it has no key either
- [dead-integrations] Three Slack triggers are deployed and mute — but a solo operator may not want a Slack workspace at all
- [dead-integrations] stripeConnectWebhook 500s every delivery — its signing secret is a placeholder
- [dead-integrations] Every provider switch in the codebase is running on its compiled-in default — no NBD_*_PROVIDER is set anywhere
- [ops-monitoring-zero-cost] Six of the ten alert files in monitoring/ physically cannot be deployed — Google rejects their filters
- [ops-monitoring-zero-cost] Nothing tells Jo when a function starts throwing — one free policy fixes that for every function at once
- [ops-monitoring-zero-cost] Error Reporting is already on, already grouping five months of failures, and nobody has ever opened it
- [ops-monitoring-zero-cost] The billing budget is live and firing — but only into a Gmail inbox, never to his phone
- [ops-monitoring-zero-cost] Both notification channels already exist and work — the last mile is not the problem
- [ops-monitoring-zero-cost] Jo is not actually at zero alarms — two homegrown ones are live and delivering email today
- [ops-monitoring-zero-cost] migrationsTick has silently not run since Aug 31 — and the policy meant to catch it is one of the six dead ones
- [ops-monitoring-zero-cost] Uptime checks are free at Jo's scale — but the one endpoint that matters would have passed green all four months
- [ops-monitoring-zero-cost] Healthchecks.io and Better Stack both lose to what Jo already has free — do not sign up
- [ops-monitoring-zero-cost] Do not create user-defined log-based metrics — they are the one chargeable option and the free system metric already covers it
- [missed-opportunities] Your storm-check page has never once shown the "official records show hail near you" line — CSP blocks it in production
- [missed-opportunities] Every review on the homepage and all 12 service pages is blank right now, and the robot that asks customers for reviews is in dry-run
- [missed-opportunities] Five finished money-recovery robots have been running every day since they shipped and silently doing nothing
- [missed-opportunities] Anyone can send email as jd@nobigdealwithjoedeal.com today — the domain publishes no anti-spoofing policy at all
- [missed-opportunities] Find out how many people actually tapped "Call" on your Google listing — free, on OAuth credentials the repo is already built to hold
- [missed-opportunities] Ten alarms are written, committed and switched off — including the one that would have caught the migration cron dying five days ago
- [missed-opportunities] The door-knocking tracker's weather panel needs a paid key you don't have and is CSP-blocked anyway — the free government one is already allowed
- [missed-opportunities] The CRM already knows every address you drove to this year but still makes you type the miles by hand

## Method

Each lane read the real files, returned its 8 strongest findings against a JSON
schema, and every finding was then attacked by three refuters with distinct
lenses — *reproduce* (trace the path, construct the failing input),
*already-handled* (find the guard, caller check, test or CI gate that prevents
it), and *citation* (does the cited line actually say what the finding claims).
Refuters were instructed to default to refuted when uncertain.

Both runs were seeded with the fourteen claims the 2026-09-03 session had
already disproved, plus the known-open list from that session's handoff, so
neither set reappears here as a new discovery.

## UPDATE 2026-09-04 (evening) — "8 stale functions" was wrong; they were orphans

The 2026-09-03 handoff said eight functions were *"three weeks stale"* and
that *"their live code is behind main."* Both halves are false, and the truth
is a worse problem with an easier fix.

`sendEstimateEmail`, `sendTeamInviteEmail`, `sendDripEmail`,
`auditCustomerDataIntegrity`, `backfillCustomerData`, `migratePinsToKnocks`,
`triggerProcessRecording` and `reprocessRecording` were **deliberately retired
from source** on 2026-08-06 and 2026-08-11 (the dead-surface and
tenant-lifecycle lanes, `d419bf76` / `c4eb886e`, Jo-approved). Their live code is
not behind main — it does not exist in main at all. `updateTime 2026-08-11` is
the retirement date, not evidence of drift.

They were never undeployed. They had been serving frozen code for four months
across many green deploys.

**Why no deploy ever removed them.** Firebase only detects an orphan on an
UNFILTERED `deploy --only functions`. This workflow names every target
explicitly (`--only functions:NAME` — its own comment above `_deploy_only()` says
so), and anything absent from that list is simply not considered. The comment
at `firebase-deploy.yml:626` claimed *"--force auto-confirms deletion of orphan
functions"* — describing something that structurally cannot happen here.
Corrected in place.

**A source comment was also lying.** `sendEstimateEmail`'s retirement note read
*"Prod instance deleted via console — see WEEKLY_CADENCE."* It had not been.

**Not a security incident, stated plainly.** Six of the eight were invokable by
`allUsers` at the Cloud Run layer, including a data migration and a
customer-data backfill. Every one was checked before that was characterised:
all are `onCall` with a real `request.auth` guard, and `triggerProcessRecording` /
`reprocessRecording` additionally require `role === 'admin'`. The `allUsers` binding
is the standard Firebase callable arrangement, not a hole. What they actually
cost was frozen dependencies, live secret bindings, and fleet count.

**Resolved.** All eight deleted 2026-09-04 on Jo's explicit instruction, after
confirming zero callers under `docs/` and that all eight were HTTP/callable with
no event triggers (so nothing could be orphaned downstream). Pre-delete state
captured first. Read back: all eight absent from `gcloud functions list`, their
underlying Cloud Run services gone too. **Fleet 179 → 171.**

That fleet number matters beyond tidiness: the 2026-09-03 CPU-quota analysis
was argued over service counts, and eight of the services in that count were
dead.

### The durable lesson

**Retiring an export does not undeploy it.** Deleting the code is half the job;
`gcloud functions delete <name> --region=us-central1` is the other half, and
nothing in CI does it or notices it was skipped. A retirement that does not
name the deletion as a separate, verified step leaves a live endpoint behind.

Still unbuilt, and the obvious next step: a post-deploy orphan detector that
diffs deployed function names against the exports in `functions/` and fails —
this was found by hand, and nothing would have found it otherwise.

## UPDATE 2026-09-04 (late) — all 77 adjudicated; the accounting bug is fixed

The 77 leads above were never refuted. They were **un-adjudicated**, and the
workflow's scoring collapsed that into "refuted". They have now all been read
against the real code, one agent per finding, with an adversarial second pass
on anything ruled TRUE at high or critical severity.

**80 agents, 0 errors, 77/77 adjudicated, 0 left unverified.**

| verdict | count |
|---|---|
| true | 40 |
| partly (real mechanism, claim overstated) | 36 |
| false | 1 |
| **never adjudicated** | **0** |

Of the TRUE rulings, 3 qualified for the adversarial
pass (true + high/critical) and 1 was knocked down.

### The severity labels were badly inflated

The 77 arrived labelled **3 critical + 18 high**. Re-read against production,
**exactly 2 survive at high and none at critical.** Most real findings are
medium or low, and the large majority have harmed nobody — dormant paths, dead
toggles, CSP-blocked features no one has missed. That gap between how a
mechanism *sounds* and what it *costs* is the most reusable thing in this run.

### The script fix that made this honest

```js
const good = votes.filter(Boolean);
const verdict = good.length === 0
  ? 'unverified'                       // agent died — NOT a refutation
  : (good.filter(v => v.refuted).length < Math.ceil(good.length / 2) ? 'survives' : 'refuted');
```

Three outcomes, never two. Collapsing any pair is how 77 unchecked leads got
filed as settled.

## Fixed in this pass

- **hailMatchCron had never scored one of Jo's leads.** `.where('deleted','==',false)`
  skips documents missing the field, and no live create path writes it. Measured
  in prod: 68 of 216 docs matched, every one from the seed-demo tenant, while all
  81 of Jo's geocoded leads were invisible. This was the ONLY `.where('deleted'`
  in the repo; the three sibling lead-sweeping crons all use an in-memory
  `if (lead.deleted) continue`. Now matched, with a smoke guard across all four.
- **/storm-check storm data was CSP-blocked in production.**
  `mesonet.agron.iastate.edu` was in `img-src` (for NEXRAD tiles) but not
  `connect-src`, and `storm-check.js:192` does a `fetch()`. Added to
  `connect-src` on the global `**` rule only — the only rule serving that page.
- **The monitoring policies now actually deploy.** See below.

## What was wrong with the ten alert policies

Not casing. **Six carried log-entry fields (`jsonPayload`, `textPayload`,
`severity`) inside a METRIC filter, with no `metric.type` at all** — so Google
rejected the policy outright and none could ever be created. The one that
worked, `alert-function-latency.json`, is the one that carries a real
`metric.type`.

Fixes, by shape:

| policy | fix |
|---|---|
| tenant-microsite-errors, voice-processing-failures | → `conditionMatchedLog` — which is what "this error line appeared" actually is. Log filter kept verbatim, service name lowercased. |
| email-queue-worker-stale | → `conditionAbsent` on the free `logging.googleapis.com/log_entry_count` system metric (every-1-min cron, 900s window). |
| functions-error-rate | `=~` is not Monitoring filter syntax → `monitoring.regex.full_match`; names lowercased; added `metric.type`; and `severity="ERROR"` → `metric.labels.severity="ERROR"`. |
| backup-cron-stale | → `conditionMatchedLog` on the `backup_freshness.stale` ERROR that `backup-freshness.js:120` already emits. |
| migrations-tick-stale | **Cannot be expressed.** Disabled and marked NOT DEPLOYABLE. |

### Two constraints worth never rediscovering

1. **Cloud Run service names are lowercase.** `onAudioUploaded` matches nothing;
   `onaudiouploaded` does.
2. **A `conditionAbsent` duration cannot exceed 23h30m.** That is SHORTER than a
   daily cron's cadence, so *"a once-a-day job stopped running" is not
   expressible as a Cloud Monitoring absence condition* — any such policy
   false-fires every day. The working pattern is what backups already do: have
   something check heartbeat AGE and log an ERROR, then alert on that line.
   `alert-migrations-tick-stale.json` is disabled for exactly this reason, and
   the real fix for migrationsTick is code, not config.

### Validated by creating them, then deleting them

There is no dry-run for an alert policy, so each of the ten was **created in
`nobigdeal-pro` and then deleted**. All ten now create successfully; the project
is back to **zero live policies**, exactly as found. Deploying them for real is
a separate decision — it changes what Jo's phone does at 3am — and the command is:

```bash
for f in monitoring/alert-*.json; do gcloud alpha monitoring policies create --policy-from-file="$f" --project=nobigdeal-pro; done
```

(Skip `alert-migrations-tick-stale.json`; it is disabled on purpose.)

An earlier pass of that validation created 7 policies whose cleanup silently
failed — the delete loop captured gcloud's `Created alert policy [...]` banner
instead of the resource name, producing malformed paths. They were removed by
id immediately after. Worth recording: `--format="value(name)"` does not
suppress that banner on `create`.

## Still open — the highest-value items

**Jo's Google reviews are blank on every marketing page and have been for weeks.**
`GOOGLE_PLACES_API_KEY` and `NBD_PLACE_ID` are both the literal `__unset__` deploy
stub, so `/api/google-reviews` returns `{"rating":0,"total":0,"empty":true}` with
HTTP **200** — which is exactly why nothing ever alerted. Verified live. This
needs real credentials and is Jo's to supply.

Three more `__unset__` stubs pass as configured secrets (Sentry DSN, Turnstile,
Stripe Connect webhook) because `'__unset__'` is a truthy 9-character string and
four functions test truthiness instead of the registry's `hasSecret()`.

### Confirmed TRUE (39)

- **[HIGH]** No alert exists for "a Cloud Function started throwing" — the one repo policy that nominally covers it names 14 functions by hand, is undeployed, and its threshold is ~4 orders of magnitude too high to ever fire  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* Real and still open, with two numbers corrected. (a) The fleet is 171 functions, not 144 — scripts/check-function-orphans.js records 171 __endpoint exports matching 171 deployments exactly as of today. (b) "Would have caught it on day one" is directionally right but needs a caveat the finding omits: an unnamed, threshold->0 policy across all functions would have fired on day one for getGoogleReviews AND simultaneousl
- **[HIGH]** No uptime checks exist, and the endpoint the finding names is silently broken in production RIGHT NOW — 29 days of blank Google reviews on 15 public pages  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* Correct as filed on the mechanism, and understated on urgency. Accurate version: the project has ZERO Cloud Monitoring uptime checks (verified in prod, not just absent from the repo). /api/google-reviews returns HTTP 200 with a "empty":true body when it is completely broken (google-reviews.js:215-226), so a status-code-only monitor never fires — which is why a ~12-week outage (2026-04-21 to 2026-07-12) went unnoticed
- **[MEDIUM]** In standalone PWA mode the global link interceptor preventDefaults blob: download anchors that live in the DOM, so four CSV/photo exports silently fail while still showing a success toast  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* In installed-PWA mode only (docs/pro/manifest.json display:standalone; browser tabs return at standalone-compat.js:31 and are unaffected), the section-6 document capture click listener at docs/pro/js/standalone-compat.js:329-353 treats a blob: URL as same-origin — verified: new URL('blob:https://<origin>/id').origin === location.origin — and calls preventDefault() at :345, cancelling the download, then assigns locati
- **[MEDIUM]** standalone window.open() patch resolves relative URLs against location.origin, so the installed PWA's "How To" nav item navigates the app in-place to a 404 at /how-to.html  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* In an installed PWA (display-mode: standalone, incl. iOS Add-to-Home-Screen), docs/pro/js/standalone-compat.js:242 resolves relative window.open() URLs against window.location.origin instead of the document URL, dropping the /pro/ path segment. The three "How To" controls in docs/pro/dashboard.html (:764 the top-level sidebar nav item, :4369, :4391), dispatched through dashboard-ui.js:594, therefore navigate the app 
- **[MEDIUM]** HEIC/HEIF/TIFF/AVIF uploads on /pro/customer get no EXIF: the exifr lazy-load imports cdn.skypack.dev, which no CSP script directive allows  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Confirmed as filed on mechanism and reachability; only the impact wording overstates. Accurate version: on /pro/customer, a native HEIC/HEIF/TIFF/AVIF file (AirDrop, Files-app drag-drop, desktop browser, drone HEIC — the input explicitly accepts these extensions) gets NO EXIF written to its Firestore photo doc, because photo-smart-ingest.js:73 dynamic-imports https://cdn.skypack.dev/exifr@7 and neither script-src nor
- **[MEDIUM]** /storm-check's IEM storm-report fetch is CSP-blocked (mesonet is in img-src, not connect-src), so the evidence line and the strongest verdict have never fired in production  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* The CSP block is real and is live in production right now: docs/assets/js/storm-check.js:192 fetches mesonet.agron.iastate.edu, and the global "**" CSP allows that host only in img-src (for the NEXRAD Leaflet tiles), not in connect-src, so the fetch is blocked in every CSP-enforcing browser. But the original "high" overstates the blast radius. The failure is soft, not fatal: the fetch lands in .catch(() => null) at s
- **[MEDIUM]** hailMatchCron's `where('deleted','==',false)` filter excludes every lead that never had the field written — in prod it processes 14 seed-demo rows and none of Jo's 199 leads  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* hailMatchCron's `where('deleted','==',false)` does return docs — 68 of 216 in production — but every lead it actually scores belongs to the seed-demo tenant. Zero of Jo's 199 leads have ever been hail-checked: his 81 geocoded live leads all lack the `deleted` field (neither lead-bridge nor repos.stampCreate writes it) and so are excluded by the equality filter, while the 54 of his rows that do carry `deleted:false` h
- **[MEDIUM]** onFollowUpDue (daily 08:00 ET cron) reads leads.d2dKnocks[] and leads.assignedTo — neither field is written by any code in the repo, so the daily follow-up push has never sent a single notification  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Accurate as filed, and both fields named in the title check out. Precisely: onFollowUpDue (functions/push-functions.js:355, deployed, `every day 08:00` America/New_York) queries `leads.where('d2dKnocks','!=',null)` at :398 and then gates each hit on `leadData.assignedTo` (:410) and `Array.isArray(leadData.d2dKnocks)` (:411). Neither `leads.d2dKnocks` nor `leads.assignedTo` is written by any code in the repo — knocks 
- **[MEDIUM]** weeklyDigest counts any merely-edited won lead as "won this week" (and the same bug hits lostCount)  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The mechanism is exactly as filed, with two corrections. (1) Understated scope: lostThisWeek at line 219 has the identical defect, so lostCount is inflated the same way — the claim names only the won path. (2) Overstated present consequence: no Monday email is being sent. weeklyDigest is deployed and fires on schedule, but WEEKLY_DIGEST_ENABLED is unset on the deployed function, so it runs dry-run — it computes and L
- **[MEDIUM]** check-inline-html-scripts.js only syntax-checks inline scripts; nothing in CI fails on an inline &lt;script&gt; that the enforced CSP will silently kill  
  No impact yet. Effort S.  
  *Corrected:* Claim stands as filed, with two refinements. (1) The script is not mislabelled internally — its own header (lines 2-39) honestly says it runs `node --check` on inline blocks; the overclaim lives in CLAUDE.md, ci.yml:171, docs/dev/rock-4-handoff.md:136 and several vault session notes that read its "N script(s) across 220 file(s)" line as a violation count. (2) The gate is currently in a state where it can never fail o
- **[MEDIUM]** check-image-privacy.js inspects only .jpg/.jpeg/.webp by extension; PNG (and any mislabeled file) is skipped silently while the summary line reads as full coverage  
  No impact yet. Effort M.  
  *Corrected:* Accurate as filed, and slightly broader in mechanism than stated: scripts/check-image-privacy.js:141/162 dispatches on file extension with no fallback, so every non-.jpg/.jpeg/.webp file under docs/ — PNG, HEIC, TIFF, AVIF, GIF, and any file whose extension misdescribes its bytes — is walked but never inspected, while line 191 prints "553 image(s) scanned — 0 privacy failures" without disclosing that 54 of the 607 im
- **[MEDIUM]** Upload-preview ✕ always removes the first queued photo — the index concatenation is trapped inside the string literal  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Exact as filed on mechanism — I confirmed every step including the NaN→0 splice. The only correction is the severity label. Impact is confined to the client-side `window._uploadQueue` before anything is sent to Storage: the wrong photo is dropped from the batch, nothing is deleted server-side, and the rep can re-add the file from the picker. Repeated clicks eat the queue from the front, so a rep trying twice to drop 
- **[MEDIUM]** /storm-check's IEM storm-data fetch is CSP-blocked in production — mesonet is in img-src but not connect-src, so the evidence-backed verdict is unreachable for every visitor  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The CSP mechanism, the file:line and the reachability in the original claim are all exactly right and I reproduced the block on live production. Two corrections, one down and one up. DOWN — the user-visible symptom is misstated. The tool does not "report no storm history". renderResult hides the data element outright (dl.style.display='none'); the visitor simply never sees an evidence line, and gets the generic fallb
- **[MEDIUM]** Project Codex Manual Form: four fields silently save empty because search-filter buttons duplicate their ids  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Exact on mechanism and scope; only the severity label is overstated. In docs/admin/project-codex.html the four search-filter buttons at lines 590-593 duplicate the ids of the Manual Form fields at lines 647/651/655/659, and because the ADD SESSION modal is emitted after the page container, document.getElementById in saveSession (docs/admin/js/project-codex-app.js:475-478) resolves each to the button, whose .value is 
- **[MEDIUM]** GA4 is absent from all 163 service/area landing pages, so the generate_lead conversion event (and every pageview) on the SEO surface silently no-ops  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* The claim is accurate on its facts (163 pages, 0 with GA4) and is if anything understated in one direction and overstated in another. Worse than filed: window.gtag is not merely missing at conversion time — the GA4 tag is not loaded on these pages at all. So GA4 records no page_view, no session and no landing-page row for 163 of the 216 sitemapped URLs (75% of the public surface). The claim frames it as a lost conver
- **[MEDIUM]** /storm-check, /roof-score and /storm-report gate submission on a TCPA express-written-consent box, then throw the answer away — twice over  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* The claim is accurate on both asserted points and understates the mechanism by one layer. Corrected: /storm-check, /roof-score and /storm-report each hard-gate submission on an express-written-consent disclosure and then discard the answer TWICE — the client payload omits it (storm-check.js:268, roof-score.js:315, storm-report-page.js:94), and the `inspect` kind at integrations.js:238 declares no `boolOptional`, so t
- **[MEDIUM]** Six of ten monitoring/alert-*.json policies are rejected by Google's filter parser and cannot be created  
  No impact yet. Effort M.  
  *Corrected:* Exact on the count and the file list, confirmed by Google's parser. Sharpening: the six fail for two different reasons — five (backup-cron-stale, email-queue-worker-stale, migrations-tick-stale, tenant-microsite-errors, voice-processing-failures) point a metric condition at log-entry fields with no metric.type, which the Monitoring filter language forbids outright; the sixth (functions-error-rate) parses fine as a me
- **[MEDIUM]** getGoogleReviews sends the literal '__unset__' stub as the Places API key, so every review widget on the site renders the grey fallback card  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* Confirmed with two refinements, one of which makes the fix bigger than filed. (1) BOTH secrets are the '__unset__' stub, not just the API key — NBD_PLACE_ID is a sentinel too, so the request URL is literally places/__unset__. Setting only GOOGLE_PLACES_API_KEY would not fix this. (2) "Blank on all 15 pages" is exact for the review CARDS, but the homepage is not wholly bare: docs/index.html still renders a static "★★★
- **[MEDIUM]** Server-side Sentry is dark: DSN secret is the literal `__unset__` placeholder AND the secret is bound to zero functions, so the filed "just set the secret" fix would not work  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* Server-side crash reporting is built and installed but dark in production: functions/integrations/sentry.js:33 gates on hasSecret('SENTRY_DSN_FUNCTIONS'), and the production secret's latest version is literally the `__unset__` placeholder that _shared.js:104 defines as "not configured". The browser half is genuinely live with a real DSN. BUT the filed remediation is wrong in a way that matters: this is NOT "no code c
- **[MEDIUM]** Bare defineSecret() locals guarded by truthiness let the '__unset__' deploy stub pass as a configured secret — 4 functions, not 3  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* '__unset__' is a truthy 9-character string, and FOUR deployed functions — not three — mistake it for a configured secret because they read bare defineSecret() locals and guard with plain truthiness (or `||`) instead of the registry's hasSecret(): getGoogleReviews (google-reviews.js:169-172), transcribeVoiceMemo (voice-memo.js:70-74), dictate (dictate.js:219-221), and notifyNewLead (verify-functions.js:321 and :409). 
- **[LOW]** offline-manager.js AUTH_GATED_PATHS is keyed on .html paths that cleanUrls never serves, so the post-deploy forced reload is dead on /pro/customer and /pro/login  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The mechanism is exactly as filed and is broader than filed in one dimension, narrower in another. Broader: all 14 AUTH_GATED_PATHS entries are dead under cleanUrls, including '/pro/' (trailingSlash:false serves /pro), so isOnAuthGatedPath() can only ever return true via the /admin/ prefix branch; and the non-reload fallback is itself inert — showUpdateNotification looks for `#toast`, which does not exist on either p
- **[LOW]** prefs-sync omits null keys from the setDoc merge payload, so a pref DELETION never reaches Firestore and the toggle reverts to ON on the next page load  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The claim is accurate on mechanism and outcome. Three refinements, one of which makes it worse than filed and two of which narrow it: WORSE THAN FILED: the claim describes a failure to push. It is actually a silent, self-sealing ratchet. prefs-sync.js:135 sets `remoteSnapshot = {...snapshot}` after the no-op write, so the client records the deletion as successfully synced. The poll loop goes quiet and never retries. 
- **[LOW]** Photo-queue × button emits a literal data-arg=" + i + ", so removeFromQueue always splices index 0 (removes the first staged photo)  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Exactly as filed on the mechanism: docs/pro/js/customer-bootstrap.module.js:2239 emits `data-arg=" + i + "` for every queue tile, the delegate passes that string to removeFromQueue, splice coerces it to 0, and the FIRST staged photo is removed regardless of which × was clicked. The only correction is to the severity label: the original "high" overstates the impact. This touches the pre-upload staging queue in the bro
- **[LOW]** Settings → "Secondary Toolbar" toggle toasts success, writes localStorage, and changes nothing — dead cosmetic control  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The claim is literally accurate on both halves: the setting is a no-op, and all three apply paths (dashboard-ui.js:2388, :2402, :2417) bail on #crmSecRestoreBtn, which appears in no HTML anywhere in the repo. Two corrections to what it implies, one in each direction. Worse than filed: the missing button is only the FIRST of two independent reasons. Deleting the `!restoreBtn` guard would not restore the feature. The e
- **[LOW]** Property Intel's US Census tract enrichment never returns data — the fetch is blocked before it can help the Claude prompt  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The finding's observation is correct — geocoding.geo.census.gov is absent from connect-src (firebase.json:87) and the census tract never reaches the Claude prompt — but its implied remedy is wrong, and the mechanism is worse than filed. The fetch at docs/pro/js/property-intel.js:29 is blocked three independent ways: (a) CSP connect-src, (b) the Census geocoder sends no Access-Control-Allow-Origin, so the browser bloc
- **[LOW]** Maps "Weather" toggle toasts success while CSP img-src silently blocks every RainViewer tile (plus a second, unfiled call site in the D2D tracker)  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The claim is accurate as written for maps-overlays.js:118, but understates scope: there are TWO blocked RainViewer call sites, not one. docs/pro/js/maps-overlays.js:118 (Maps view "Weather" toggle) toasts "Live weather overlay active" and renders nothing, and docs/pro/js/d2d-tracker-core-2026b.js:4296 (D2D tracker) toasts "Storm radar + precipitation loaded" while only its NOAA/mesonet layer draws. Both are blocked b
- **[LOW]** SW routes ESRI satellite tiles to the uncapped CDN cache; the 500-tile cap and the whole tiles cache are dead code  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The routing defect is exactly as described: the cross-origin branch at sw.js:184 preempts the isMapTile() dispatch at :202, so ESRI satellite tiles are answered cache-first by handleCDNRequest into nbd-cdn-v31 with no size limit and no eviction, sharing that cache with the app's own JS/CSS, while the documented 500-tile cap in handleMapTileRequest is unreachable dead code. Two scope corrections the original finding d
- **[LOW]** stormWatch reads storm_alert_subscribers with no active==true filter, so numbers checkStormAlerts deactivated stay on its send list  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Real and present in main, but it is a deliverability bug, not a consent bug — and it is currently dormant. `active` is flipped false only by checkStormAlerts on Twilio error 21211 (invalid To number) or 21614 (not a mobile — i.e. a landline); a STOP reply does not touch it. So the consequence of stormWatch's missing filter is repeated rejected Twilio API calls to undeliverable numbers, NOT storm texts to people who a
- **[LOW]** checkRunnableWiring() inspects only the step block and only the first matching workflow file, so all 120 aggregated-bucket suites can be de-gated with --check still green  
  No impact yet. Effort S.  
  *Corrected:* Accurate as filed, and the count is now 120 rather than 116 (node:55 + smoke:65). Both constructible de-gates verified against the real script: (a) a job-level `if:` or `continue-on-error: true` on `smoke-tests:` / `unit-suite-manifest:` is outside the inspected block; (b) the `return` after the first workflow file containing the needle lets a decoy step in an earlier-sorting, non-PR workflow shadow a neutered real s
- **[LOW]** CRM Settings "Secondary Toolbar" toggle is a dead control that toasts success  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The Settings → "Secondary Toolbar" toggle is a dead control that reports success. Flipping it toasts "Secondary header OFF/ON" and writes localStorage, applyCrmSecHeaderState() (docs/pro/js/dashboard-ui.js:2384) returns at line 2388 because #crmSecRestoreBtn exists in no HTML, and the toggle re-reads its own localStorage on every Settings visit so it looks like it stuck. The original claim is accurate but stops one l
- **[LOW]** Pro Tips & D2D Tricks modal is orphaned — openTips() has no caller; only its close path is wired  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Accurate as filed, with two clarifications. (1) The orphaning is old and its cause is identified: the modal lost its only entry point — a `#nav-tips` sidebar item with `onclick="openTips()"` — in commit a08dadb6 "Session 25: Navigation overhaul"; the 2026-05 script extraction and the 2026-09 dispatch-map tranches merely carried the corpse forward. (2) `openTips` is a bare `function` declaration in a classic script, s
- **[LOW]** Settings → Appearance theme grid keeps the ✓ / accent border on the previous theme after "✓ Apply Theme" — the refresh hook looks up an id that exists nowhere  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Accurate as filed, with three refinements. (a) The stale badge actually appears one click EARLIER than the claim says: `_tePreviewTheme` (ui.js:1033) calls `TE.apply(key, false)`, which already moves `currentTheme`, and it does not re-render the grid either — so the ✓ is on the wrong card from the moment of preview; "✓ Apply Theme" merely fails to correct it. (b) The hook is doubly broken, not just misnamed: even if 
- **[LOW]** Rep OS weather card and D2D storm-alert banner are both permanently dead — gated on a localStorage key nothing writes, and the API host is not even in the CSP allowlist  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Accurate as filed, with two corrections. (1) It is deader than described: no code writes the key, there is no settings UI to set one, AND api.openweathermap.org is absent from every connect-src in firebase.json, so even a hand-set devtools key gets a CSP-blocked fetch (the d2d call additionally targets the retired One Call 2.5 endpoint). (2) The generateTodayPlan consequence is a benign fail-open, not a wrong answer:
- **[LOW]** "Solar Analysis" button always draws a latitude-only guess and tells the rep to add a key to a Settings field that does not exist  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Clicking "☀️ Solar Analysis" (docs/pro/dashboard.html:1341) always takes the fallback branch: `nbd_google_solar_key` is read at docs/pro/js/maps-routing.js:1704 and written by nothing in the repo, and no Settings UI exists to set it — so the rep gets a latitude-only sun-path circle plus a toast telling him to add the key "in Settings", where no such field exists. One refinement to the original wording: the Google Sol
- **[LOW]** /inspect offers a multi-photo file input whose bytes are never uploaded; only a count and a filename string are sent, and neither the form nor the success card discloses it  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Real and currently present, with one nuance the claim does not carry: the drop is deliberate and documented server-side (integrations.js:236-238), not an accident. The defect is the disclosure gap, not the architecture — the page presents a labelled "Photos (optional, multiple)" multi-file input and returns an unqualified "Got it — thanks!", so a homeowner who attaches six hail photos reasonably believes they were de
- **[LOW]** Turnstile is wired end-to-end but inert at both ends: empty client sitekey, __unset__ server secret  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Turnstile is genuinely dead at both ends and CSP already permits it — all three of those sub-claims verify. Two corrections. (1) The fallback stack is one layer thinner than filed: App Check is NOT part of it. submitPublicLead is a plain v2 onRequest with no App Check verification anywhere in the handler, and the code comment at functions/handlers/integrations.js:281-292 says enforceAppCheck would be dead config on o
- **[LOW]** NBD_ESIGN_PROVIDER is a switch with zero readers, and the BoldSign path behind it is unkeyed in production  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The finding's title is exact and verified: PROVIDERS.esign (functions/integrations/_shared.js:83) has zero readers anywhere in the repo, and BOLDSIGN_API_KEY is the `__unset__` stub in production, so the whole BoldSign path is dark. The claim body's rationale is where it overstates: BoldSign is NOT simply "a paid vendor duplicating a working free path." The two signing paths are not interchangeable, and this matters 
- **[LOW]** stripeConnectWebhook's signing secret is still the deploy workflow's `__unset__` stub, so the handler fails closed with 500 — but nothing has ever been delivered to it  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* stripeConnectWebhook's dedicated signing secret STRIPE_CONNECT_WEBHOOK_SECRET holds the deploy workflow's `__unset__` sentinel (single Secret Manager version, created by CI on 2026-07-30, never replaced), so the fail-closed guard at functions/handlers/stripe-connect.js:406 would return HTTP 500 to every signed delivery. The misconfiguration is real and present today. What the title overstates is the tense: it has nev
- **[LOW]** D2D tracker's storm banner and Rep OS weather card are permanently dead — OpenWeatherMap needs a hand-pasted key AND is absent from connect-src, while api.weather.gov is already allowed  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* Accurate as filed; two scope refinements. (1) Jo is not blind to severe weather overall — Storm Center's NWS alerts work and already feed the Rep OS briefing's storm counts (rep-os.js:144-152). What is dead is the tracker's in-context "⛈️ Storm Alert — knock now!" banner on the knocking screen itself, and the Rep OS temp / wind / canvassing-window card. He has to leave the tracker and open Storm Center to learn a cel

### PARTLY true — real mechanism, overstated claim (36)

- **[HIGH]** Live Google reviews render empty on 14 public pages — but the cause is unset secrets, not a restricted key, and the nudge is not silent  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* Live Google reviews render as an empty "Read our reviews on Google" fallback card on all 14 public pages carrying the widget (homepage, /review, all 12 service pages), and have done so continuously for at least a month — verified by hitting production, not inferred. The cause is NOT an HTTP-referrer-restricted key: GOOGLE_PLACES_API_KEY and NBD_PLACE_ID both still hold the literal `__unset__` deploy stub, never once 
- **[MEDIUM]** The parity gate's D-2 half asserts against a copy of the delegation, not against estimates.js — reverting the real delegation leaves it 75/0 green  
  No impact yet. Effort S.  
  *Corrected:* In tests/estimate-engine-parity.test.js the D-2 (waste-from-pitch) section proves nothing about Classic: lines 44-49 re-implement the delegation inside the test and lines 66-71 assert that replica against V2, so neutering or deleting the real delegation at docs/pro/js/estimates.js:203-208 still yields "75 passed, 0 failed" (verified by running a scratch copy). The claim's "never reads estimates.js" is wrong for the f
- **[MEDIUM]** Cloud Error Reporting is live, has been grouping errors since 2026-04-15, and has never been triaged — all three named failures are in it right now  
  **Has affected something already.** Effort S.  
  *Corrected:* Google Cloud Error Reporting is already ingesting and grouping this project's function errors with zero setup, has been doing so since at least 2026-04-15, and has never been triaged — all 9 groups are still resolutionStatus=OPEN after 2,562 occurrences in the last 30 days alone, and no runbook or README in the repo points at it. It does show, on one screen and right now, all three named failures: the getGoogleReview
- **[MEDIUM]** Both notification channels do exist (SMS is VERIFIED), but wiring the alerts is not "a single JSON field" — half the policy files cannot be created as written  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* Both notification channels exist and are enabled — email to Jd@nobigdealwithjoedeal.com (id 11974029248665804510) and SMS to +1 513 315 2406 (id 7729093229259591605, verificationStatus VERIFIED). So the "Jo would have to sign up for something" excuse is genuinely removed, and an SMS-to-Jo alert is available today. But it is NOT "a single JSON field away." Replacing NOTIFICATION_CHANNEL_ID unblocks only five of the te
- **[MEDIUM]** "Don't buy a cron monitor, you already have it free" — the buy advice is right, but the free thing covers 3 of 25 crons and is not running at all  
  No impact yet. Effort S.  
  *Corrected:* Do not sign up — that half is correct, and for a better reason than the one given: GCP log-absence alerting is free and has no per-check cap, whereas both SaaS free tiers sit below 25 (Healthchecks.io 20 checks, Better Stack 10 monitors — from public pricing, not verified from code). But the premise that this is a capability "already in the project" is wrong twice over. It covers 3 of the 25 crons by design, not 25, 
- **[MEDIUM]** Zero alert policies are live and the channels are wired to nothing — but the ten JSONs are NOT ready to run; six are rejected by the Monitoring API, and the script meant to apply them swallows the failures  
  No impact yet. Effort L, needs deploy.  
  *Corrected:* The project has zero live Cloud Monitoring alert policies while two verified notification channels (Jo's email and SMS, created 2026-07-05) sit wired to nothing — so nothing pages him, and two real conditions are live right now unnoticed: migrationsTick has not emitted its heartbeat since 2026-08-31T13:46Z, and getGoogleReviews throws errors most hours of most days. But this is NOT ten CLI invocations against a ready
- **[MEDIUM]** resolveAddress ships a two-provider fan-in whose two providers are both the CI stub secret, so it has never returned an address in production  
  **Has affected something already.** Effort M, needs deploy.  
  *Corrected:* resolveAddress is deployed, auth + App Check + rate-limit gated, and structurally incapable of returning an address, because both GOOGLE_GEOCODING_API_KEY and REGRID_API_TOKEN in nobigdeal-pro hold the deploy pipeline's `__unset__` sentinel — the code's provider gates (geocode.js:195-196) are correct, the secrets were never provisioned. Production confirms it has never once returned provider data: geocode_cache is em
- **[MEDIUM]** Five rep-facing cron "robots" are still DRY-RUN in production — none of their enable flags was ever added to functions/.env.nobigdeal-pro  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* All five gated crons (runAbandonRecovery, weeklyDigest, dormantLeadNudge, anniversaryAutoTouch, reviewRequestNudge) have run in DRY-RUN in production every scheduled cycle since they shipped 4-5 months ago, because none of FUNNEL_RECOVERY_ENABLED / WEEKLY_DIGEST_ENABLED / DORMANT_NUDGE_ENABLED / ANNIVERSARY_TOUCH_ENABLED / REVIEW_NUDGE_ENABLED was ever added to functions/.env.nobigdeal-pro (verified on the live Cloud
- **[MEDIUM]** No DMARC record on nobigdealwithjoedeal.com — From-header spoofing is unenforced (but SPF and DKIM are present and correct, and the filed p=none fix blocks nothing)  
  No impact yet. Effort S.  
  *Corrected:* The domain publishes SPF and DKIM (both correct, both aligned at the apex for the two senders that matter — Resend and iCloud) but publishes no DMARC record at all, verified NXDOMAIN on two resolvers today. Because SPF only authenticates the envelope sender and never the visible From header, the missing DMARC record means a forged message with From: jd@nobigdealwithjoedeal.com carries no signal a receiver can act on.
- **[MEDIUM]** Ten committed Cloud Monitoring alert policies are all unapplied — but half of them would not work even after the channel ID is substituted  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* All ten Cloud Monitoring alert policies in monitoring/ are committed and none is live, so 25 scheduled functions run behind exactly one working alarm (backupFreshnessCron, functions/backup-freshness.js:65) — including migrationsTick, which has been dark since 2026-08-31 with its purpose-built alarm sitting unapplied in the repo. But this is NOT a sed-and-paste fix. Five of the ten filters name Cloud Run services in m
- **[LOW]** Hardcoded "NBD ROOFING" header in the on-screen invoice detail — real, but screen-only and rep-facing, not on any homeowner-delivered document  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* docs/pro/js/invoice-pipeline.js:1053 hardcodes "NBD ROOFING" as the header of the in-app invoice detail view, the one surface in this file the white-label sweep missed. A non-NBD tenant who creates an invoice gets the platform owner's brand on the invoice document rendered in their own dashboard (reachable via createInvoiceUI → showInvoiceDetailModal). Corrections to the original claim: (1) it does NOT reach paper — 
- **[LOW]** FCM notificationclick calls client.navigate() on an off-scope window — it does always reject, but it is not what stops the record opening  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* firebase-messaging-sw.js:112 does call client.navigate() on a window the messaging SW does not control (it is registered at the disjoint scope /pro/firebase-cloud-messaging-push-scope while /pro/sw.js owns '/pro/'), and that promise always rejects with TypeError, unhandled. focus() succeeds. But the claim is wrong that this is why a tapped push never opens the record, and wrong that it happens on every tap: (1) becau
- **[LOW]** Push deep-link query params are read by nothing; the claimUpdate link uses ?leadId= where customer.html reads ?id= — but that notification can never fire  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The SW's getClickUrl builds five deep links out of query params the app reads nowhere (docs/pro/firebase-messaging-sw.js:130-146), and line 56 overwrites the server-supplied clickUrl with them. The claimUpdate case is the worst-shaped — `customer.html?leadId=` against a page that reads `id` and bails on line 141 — but it is DEAD: onClaimStageChange guards on `claim_stage` while the CRM writes `claimStage`, so the tri
- **[LOW]** standalone-compat injects a second safe-area-top reservation on top of the header's own, on dashboard.html only  
  **Has affected something already.** Effort S, needs deploy.  
  *Corrected:* standalone-compat.js:320 injects `body{padding-top: env(safe-area-inset-top)}` in standalone mode, and on dashboard.html the <header> already reserves the same inset (dashboard-app.css:3931, :3994, :4441 !important) — so the notch is reserved twice. On a notched iPhone in the installed PWA (portrait, ≤768px, inset 47-59px) the top chrome renders 48+2×inset (~154-166px) instead of the intended 48+inset (~95-107px): on
- **[LOW]** D2D background-sync wiring is genuinely dead, but no knock is ever lost — the queue flushes on the next app open  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The Background Sync wiring in d2d-tracker-core-2026b.js:600-615 is dead code — the tag 'nbd-d2d-sync' is handled by no service worker, and the FLUSH_OFFLINE_QUEUE message is posted by none. It is broken in three independent ways, not one: the tag mismatch, registration that only fires while already online (so it never arms during a dead zone), and a SW handler that drains an IndexedDB store the D2D module never write
- **[LOW]** FCM service worker ignores event.action, so the 'Dismiss' button also focuses/opens the CRM  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* docs/pro/firebase-messaging-sw.js:93 does ignore `event.action`, so a tap on the 'Dismiss' action button runs the same open/focus path as 'View'. Two corrections to the filed claim: (1) it does NOT open "instead of dismissing" — line 94 closes the notification first, so Dismiss dismisses AND additionally focuses the open CRM tab, or launches a whole new CRM window via clients.openWindow() when none is open. The unwan
- **[LOW]** Neither storm SMS cron consults sms_opt_outs before texting subscribers  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Both storm SMS crons — stormWatch (functions/storm-watch.js:225-238) and checkStormAlerts (functions/sms-functions.js:1059-1075) — send without ever calling OptOut.isOptedOut, and the incomingSMS STOP handler (sms-functions.js:641-655) does not flip the subscriber's `active` flag. The app's own STOP register is therefore not consulted on either storm path, unlike the three lead-facing senders. But the claimed outcome
- **[LOW]** Migration runner entry points inherit the 60s default timeout; heartbeat logs only on success  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Correct on mechanism, wrong on consequence. It is true that neither runMigrations (runner.js:286-287) nor migrationsTick (runner.js:297-298) declares timeoutSeconds, that no setGlobalOptions exists in functions/, and that both are therefore deployed at the Cloud Functions v2 default of 60s — verified in the live config, not just inferred. It is also true the heartbeat at runner.js:304 runs after `await runPending()` 
- **[LOW]** hailMatchCron has no pagination cursor; the "rolls over to the next run's cursor" comment describes machinery that was never written  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The mechanism is confirmed exactly as filed: hail-cron.js:118-121 has no orderBy and no startAfter, no cursor is persisted anywhere, and the 20-hour lastHailCheck guard at line 145 cannot rotate the window because the schedule interval is 24h. The header comment (lines 14-15) and the inline comment (line 115) describe pagination that does not exist. What the claim overstates is consequence: "reads the same first 500 
- **[LOW]** runAbandonRecovery pages the OLDEST 200 rows in a 30-day window and dedupes only in memory — real mechanism, but the collection is empty and the sender is dark  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The Firestore mechanism the finder describes is exactly right: two range filters on `createdAt` with no explicit orderBy give an implicit `orderBy(createdAt, 'asc')`, so `.limit(200)` at functions/funnel-recovery.js:276 pages the OLDEST 200 rows in the 1h–30d window, and the `completedAt`/`recoveryEmailSentAt` dedupe runs in memory afterwards (functions/funnel-recovery.js:300-303) rather than in the query — contradic
- **[LOW]** job-templates.test.js keeps a stale soft-skip that exits 0 with no assertions, and the aggregated runner's failure scanner cannot distinguish it from a pass  
  No impact yet. Effort S.  
  *Corrected:* tests/job-templates.test.js:84-87 keeps a buildout-era soft-skip that exits 0 with zero assertions when either job-templates file is absent, and scripts/run-test-manifest.js:250-256 has no SKIP awareness — so that suite's row in the aggregated smoke bucket would read "✓ / ✅ pass" while 149 assertions ran nowhere. The soft-skip is now stale: the parallel buildout it was written for landed on 2026-08-26 and the suite r
- **[LOW]** pro-public.spec.js "Instant Estimate" test is permanently skipped — /pro/instant-estimate.html has never existed  
  No impact yet. Effort S.  
  *Corrected:* tests/e2e/pro-public.spec.js:60-72 contains a test that can never execute: it navigates to /pro/instant-estimate.html, a page that has never existed in any commit of this repo, and self-skips on the resulting 404. Confirmed by running the spec against the hosting emulator: 4 passed, 1 skipped. It is dead test scaffolding (1 of 5 tests in the file) plus a stale README line at tests/e2e/README.md:32 claiming coverage t
- **[LOW]** Upload modal has no metadata fields, so the photo doc's damageType/severity reads are orphaned and phase is always hardcoded 'During' — but all four fields are editable post-upload in three working UIs  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The customer photo-upload modal (docs/pro/customer.html:1915-1945) has no metadata controls, so three element ids read by the upload path — uploadMetaSection, uploadDamageType, uploadLocation — resolve to null, and two window-exported selectors (selectUploadPhase, selectUploadSeverity, customer-tasks-ui.js:588/598) are never called from anywhere. The markup was never written, in any commit. Consequently every photo u
- **[LOW]** Settings > Appearance "Reset to Default" leaves the custom accent applied for the rest of the session (stale inline --orange/--og) and its swatch reset targets a nonexistent element id  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* Settings > Appearance "Reset to Default" does not visually revert the custom accent in the current session. ThemeGX.setAccent writes --orange and --og as inline custom properties on <html> (theme-gx.js:506-507); clearAccentOverride (theme-gx.js:509-517) nulls and persists state and re-derives only the --gx-* glow vars, never removing those inline properties, so every --orange-driven surface stays the custom color. Se
- **[LOW]** FAQPage JSON-LD on 15 indexed pages has no visible Q&A block — but the answer substance is on the page  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* 15 indexed pages (20 total; 5 are noindex docs/pro/blog/*) carry FAQPage JSON-LD with no visible question-and-answer block — no question strings, no accordion, no FAQ heading. On the cited page the *answers* are not missing: their substance appears in the body copy nearly verbatim (measured answer-token coverage 0.87, three of four answers 0.96-1.00), just as prose rather than as Q&A pairs. So this is a markup-presen
- **[LOW]** /review hero's static "5.0 ★★★★★ Verified on Google" never self-corrects while the reviews feed is dead — but 5.0 is Jo's real, verified rating  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* The /review hero's hardcoded "5.0 ★★★★★ Verified on Google" is indeed never invalidated while the live feed is down, and the feed IS down right now (verified: /api/google-reviews returns rating 0, total 0, empty:true). But the finding names the wrong mechanism and overstates the harm. Wrong mechanism: the endpoint returns HTTP 200 with a valid body, so the widget's catch block never fires and hydrateStaticHooks IS re
- **[LOW]** Field Notes blog post carries the wrong og:url (points at the insurance-check article)  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* docs/blog/field-notes-joes-notebook-goes-public.html:174 carries an og:url for a different article (/blog/can-i-keep-insurance-check-not-fix-roof). It is the file's only og:url, it is in <head>, and it is the sole canonical/og:url mismatch among 228 public pages. The consequence is narrower than "every social/messaging share resolves to the wrong post": platforms that canonicalize on og:url — Facebook and LinkedIn, a
- **[LOW]** GCP billing budget has an empty notificationsRule, so alerts go only to the default IAM email (a personal Gmail) while a verified SMS channel sits unused  
  No impact yet. Effort S.  
  *Corrected:* The budget resource and the defect are exactly as cited: notificationsRule is `{}`, so its six threshold rules notify only the default IAM recipients — which resolve to exactly one address, the personal Gmail jonathandeal459@gmail.com — while a VERIFIED SMS channel (+15133152406) and a jd@ email channel already exist unattached. Attaching them is a one-command, purely additive fix and the budget is single-project sco
- **[LOW]** The "zero alarms" premise is wrong — the daily health digest really does land in Jo's inbox every day — but only ONE homegrown channel actually sends mail, not two  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* Jo is genuinely not at zero alarms — that correction stands and matters. But the count is off by one: ONE homegrown channel is actually delivering email (healthDigestCron, verified end-to-end today: queued 14:00:32Z, Resend-sent 14:01:02Z, and identically on each of the 11 prior days). The second, backupFreshnessCron, is live and ungated but exception-only — it ran at 10:00Z today, found a 2.73h-old export marker, lo
- **[LOW]** migrationsTick's `every 24 hours` interval schedule is re-anchored by every functions deploy, so it starves — but the migration backlog is empty and nothing is half-applied  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* migrationsTick has not fired since 2026-08-31T13:46Z, and the alert that would have caught it does not exist in the project — both halves of the citation are true. But the stated harm is not: NOTHING is pending and nothing is half-applied. Production system/migrations reads appliedVersion 6 with lastError null, and 6 is the highest script version on disk, so the runner correctly has nothing to do; the lease is releas
- **[LOW]** "Don't build user-defined log-based metrics" — the pricing half is verbatim correct, but both load-bearing claims ("the only billable path" and "the free system metric already covers it") are refuted, and the recommended substitute would silently break the staleness alarms  
  No impact yet. Effort S.  
  *Corrected:* Correct: user-defined logs-based metrics are chargeable custom metrics while system-defined ones are free, and none exist in nobigdeal-pro. Also correct: the umbrella "any function is throwing" policy needs no log-based metric — alert-functions-error-rate.json:13 already uses the free logging.googleapis.com/log_entry_count + severity=ERROR. But two claims fail. (1) User-defined log-based metrics are NOT the only bill
- **[LOW]** Slack is fully dark in prod and gates 9 deployed functions (not 5) — but the claim praises the deadest one and omits the two live money alerts, which already have an email fallback  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* SLACK_WEBHOOK_URL in prod Secret Manager holds only the 9-byte `__unset__` deploy stub, so every Slack post no-ops. That single secret gates NINE deployed Cloud Functions, not five: the three slack.js triggers, stormBriefing_onAlertSent, registerDeviceFingerprint, hailMatchCron, swathWebhook, stripeWebhook and invoiceWebhook. The claim's priority is inverted twice. First, the storm briefing it calls "the only genuine
- **[LOW]** /storm-check's IEM hail lookup is CSP-blocked (connect-src omits mesonet) — real, dead since launch, but the funnel has had one completion ever and it was Jo's own test  
  No impact yet. Effort S, needs deploy.  
  *Corrected:* docs/assets/js/storm-check.js:192 fetches IEM directly from the browser, but firebase.json's "**" CSP allowlists mesonet.agron.iastate.edu in img-src only, never in connect-src — verified absent across the last 60 commits of firebase.json, so the call has been blocked since the page shipped 2026-05-30. The "Official records show N hail reports..." line has therefore never rendered, and (not in the original claim) the
- **[LOW]** GBP Performance API call-click reader — unbuilt, but blocked on an unapproved Google access request, and CALL_CLICKS cannot do the per-page attribution the claim promises  
  No impact yet. Effort M.  
  *Corrected:* The GBP Performance API reader is genuinely not built, and the fetchAccessToken() refresh-token flow at functions/gbp-reviews-sync.js:83-101 is genuinely reusable. Three corrections. (1) It cannot be built and switched on: all five GBP_* secrets in nobigdeal-pro hold the literal __unset__ sentinel, because Google's Business Profile API access request has never been approved — the same gate that has kept syncGbpReview
- **[LOW]** Smart Calendar computes a daily mileage total and throws it away; the expense mileage field is still hand-typed — but that total is not an IRS-usable number  
  No impact yet. Effort M, needs deploy.  
  *Corrected:* Smart Calendar already sums a daily travel figure (smart-calendar.js:215) and renders it as a read-only stat tile, while the expense mileage field (expenses.js:381) is still hand-typed — the two never connect, and the summary is not even exported. That much is true. But the figure it has is NOT the mileage Jo could deduct: it covers today only, Cal.com-booked appointments only (manually scheduled jobs and D2D routes 
- **[NONE]** Provider-switch map: every NBD_*_PROVIDER is unset (true), but the "four dark seams" tally is off — hail runs live on free NOAA, and esign's switch is read by nothing  
  No impact yet. Effort S.  
  *Corrected:* All six provider switches in functions/integrations/_shared.js:81-95 run on their compiled-in defaults — no NBD_*_PROVIDER is set in the repo, in functions/.env.nobigdeal-pro, in the deploy workflow, or on any deployed function (verified on four prod functions). That is accurate and is a fair map. But only THREE seams are dark, not four: measurement (hover/eagleview/nearmap), esign (boldsign) and parcel (regrid/swath

### Ruled FALSE (1)

- Claim that CRM mic buttons are dead because DEEPGRAM_API_KEY was never set — The mic buttons are not broken by a missing key. DEEPGRAM_API_KEY is set (version 1, enabled, created 2026-04-14) and is bound to both ACTIVE deployed callables, dictate and transcribeVoiceMemo; the client call sites are wired correctly and App Check is initialised. What is true, and much narrower: 
