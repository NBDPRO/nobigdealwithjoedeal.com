# Runbook — Emergency spend kill-switch

**When:** the Cloud Billing budget alert fired, or you see runaway AI / SMS /
infra spend and need to **stop the bleeding now**.

> ⚠️ The Cloud **Billing budget alerts — it does NOT stop spend.** And
> `docs/pro/README-killswitch.md` is the *service-worker* kill-switch (disables
> the PWA), **not** a spend control. This page is the actual spend kill-switch.

## 🔴 ONE-BUTTON: halt all billable AI instantly (no deploy)

Set a single Firestore flag. Ten AI endpoints check it (60s cached), so it
takes effect within a minute and reverses just as fast: `claudeProxy`,
`analyzePhotoVision`, `visualizerImageGen`, `extractReceiptData` (all
pre-existing), plus **six wired 2026-09-14** — this flag's own doc claimed
"all billable AI" for over a month while these six spent Anthropic and/or
Groq tokens with zero read of this flag, found by re-auditing every literal
`anthropic.com`/`api.groq.com` caller in `functions/` rather than trusting
this list (or a file-level "does the file mention isAiDisabled anywhere"
check — that check alone would still have missed three of these six, which
live in the same file as the already-gated `claudeProxy`):
- **Rep-initiated:** `dictate`, `previewAiPersona`, `analyzeRoofPhoto`
- **Admin-only:** `adminAI`
- **Public, UNAUTHENTICATED** (the highest-risk gap — no App Check, no
  login, gated only by a per-IP rate limit until this fix):
  `publicVisualizerAI` (the marketing-site room visualizer),
  `publicFunnelAI` (the `/estimate` instant-estimator + storm-check note)

```
feature_flags/global   →   { aiDisabled: true }
```

In the Firebase console: Firestore → `feature_flags` → `global` → set
`aiDisabled` = `true` (create the doc/field if absent). To restore, set it
back to `false`. While set, the endpoints above return 503 / `unavailable`;
SMS and email are unaffected (use their levers below). This is the fastest,
least destructive AI stop — prefer it over pulling the Anthropic key.

**Not covered by `aiDisabled`** — these are the *unattended/automated*
surfaces below, deliberately on their OWN flags (`voiceIntelDisabled`,
`aiDraftDisabled`) so an operator can stop automated spend without also
darkening every rep-initiated AI feature, or vice versa. A real "stop
everything" event needs `aiDisabled: true` **and** those two flags — see
below.

First: **identify the driver** (1 minute) — GCP Billing → Reports (group by
service/SKU), Anthropic console, Twilio console. Then pull the matching lever.

---

## AI (Anthropic / claudeProxy, photo-vision, visualizer) — fastest first

Per-uid (200k tok/day) and per-company (plan-tiered) token caps already
hard-stop *individual* abusers. Use these only for a *platform-wide* event
(e.g. many compromised accounts at once):

1. **Instant, blunt — pull the key.** Remove the Anthropic secret so every AI
   call fails closed:
   ```bash
   firebase functions:secrets:destroy ANTHROPIC_API_KEY --project nobigdeal-pro
   # (re-set it later: firebase functions:secrets:set ANTHROPIC_API_KEY)
   ```
   Takes effect on the next cold start / new secret version binding. Also
   rotate the key in the Anthropic console to kill in-flight use immediately.
2. **Disable the visualizer image-gen** (the ~$0.08/call surface) without
   touching the rest: set `VISUALIZER_IMAGEGEN_ENABLED=false` on the
   `visualizerImageGen` revision (it ships disabled by default anyway).
3. **Tighten a single abuser:** lower that company's cap in
   `CLAUDE_COMPANY_BUDGET` (`functions/handlers/_shared.js`) and redeploy.

## Roof measurement (public /estimate funnel — vendor-metered, ~$3/lead)

**Added 2026-09-14 — this lever existed in code but was undocumented here.**

`measureNewWebLead` (`functions/integrations/public-measure.js`) fires once
per bridged public-estimate lead and spends a metered aerial-measurement
vendor call. Unlike the AI switches above, it has its **own** flag:

```
feature_flags/global   →   { webLeadMeasureDisabled: true }
```

Same doc, same 60-second cache, same instant no-deploy effect
(`functions/integrations/killswitch.js`). It is deliberately separate from
`aiDisabled` — an operator may want to stop metered-vendor spend without
darkening every AI surface, or vice versa.

### CRM auto-order (added 2026-10-04)

`autoMeasureOnStage` / `autoMeasureOnAppointment`
(`functions/integrations/measure-auto-order.js`) order the same $3 measure
for a CRM lead when it gets an appointment or reaches Inspected — once per
lead, under a daily and a monthly cap. Own flag, plus the caps, all in the
same doc:

```
feature_flags/global   →   { autoMeasureDisabled: true }        // stop it
feature_flags/global   →   { autoMeasureDailyCap: 6,            // defaults
                             autoMeasureMonthlyCap: 60 }
```

Counters live in `measurementAutoOrders/day_YYYY-MM-DD` and
`month_YYYY-MM` (admin SDK only); each lead's marker is
`measurementAutoOrders/lead_<leadId>` with `status` ordered / reused /
failed.

The per-photo AI classifier trigger `onPhotoCreatedClassify`
(`functions/photo-vision.js`, also 2026-10-04) sits under `aiDisabled`
like the `analyzePhotoVision` callable it shares its code and caps with.

## Voice memos and AI-drafted replies

**Wired 2026-09-14** — these surfaces were flagged in the Grok Pro/CRM
audit evaluation's freeze-list pass as unattended metered spend with no
operator-flippable switch (only the "Instant, blunt" shared-key lever
below, and only by coincidence — neither read `feature_flags/global` at
all). Each now has its own dedicated flag, same pattern as
`webLeadMeasureDisabled`:

- **`onAudioUploaded`** (`functions/integrations/voice-intelligence.js`) —
  a Storage trigger firing on every voice-memo upload; spends Groq +
  (sometimes) Anthropic tokens transcribing and summarizing.
  ```
  feature_flags/global   →   { voiceIntelDisabled: true }
  ```
  A recording that lands while the flag is set is written as
  `status:'failed'` with a clear `statusError` (not silently dropped) —
  the customer-page UI listens for the doc via `onSnapshot`, so it must
  resolve one way or the other rather than spin forever.
- **`generateAIDraft()`** (`functions/handlers/ai-texting.js`) — the one
  Anthropic call behind every AI-suggested reply, shared by all three of
  its callers: **`incomingSMS`** (fires on every inbound SMS, no human in
  the loop), **`onPortalMessageDraft`** (fires on every inbound homeowner
  portal message), and the admin-only **`convertUnmatchedSms`** callable.
  ```
  feature_flags/global   →   { aiDraftDisabled: true }
  ```
  The flag is checked once, inside `generateAIDraft` itself, so all
  three callers (and any future one) share it automatically — no call
  site can ship ungated. The underlying inbound SMS/message itself is
  unaffected either way; only the AI-drafted reply is skipped, and the
  rep can still answer by hand.
  **Note:** the first cut of this fix (same day) gated only
  `onPortalMessageDraft` at its own call site and missed that
  `incomingSMS` calls the identical `generateAIDraft()` with no flag
  check of its own — caught by re-reading the shared function rather
  than trusting the one call site the original audit named. Moved the
  gate inside the shared function so that class of gap can't recur.

Same doc, same 60-second cache, same instant no-deploy effect
(`functions/integrations/killswitch.js`). Both are deliberately separate
flags from `aiDisabled` and from each other — an operator can stop either
metered surface without darkening `claudeProxy`, photo-vision, or the
other one.

## SMS (Twilio / checkStormAlerts, verification, D2D)

1. **Per-run cap already exists:** `STORM_MAX_SMS_PER_RUN` (default 250).
   Drop it to `0` on the `checkStormAlerts` revision to halt storm fan-out
   without a deploy.
2. **Instant, blunt — pull Twilio creds:** destroy `TWILIO_AUTH_TOKEN` (all
   SMS sends fail closed), and/or pause the number / set a spend limit in the
   Twilio console (Twilio also supports an account-level spend trigger — set
   one up as a backstop).

## Email (Resend / emailQueueWorker, digests)

- Destroy `RESEND_API_KEY`, or flip the digest flags off
  (`WEEKLY_DIGEST_ENABLED`, `DORMANT_NUDGE_ENABLED`, `ANNIVERSARY_TOUCH_ENABLED`,
  `HEALTH_DIGEST_ENABLED`, `FUNNEL_RECOVERY_ENABLED`) on those revisions.

## Firebase infra (function invocations / Firestore reads)

- A runaway *function* (loop, retry storm): `gcloud functions delete <fn>
  --project nobigdeal-pro` (redeploy from the branch when fixed), or pause its
  Cloud Scheduler job: `gcloud scheduler jobs pause <job> --project nobigdeal-pro`.
- Vendor metered calls (HOVER/Regrid/Groq): destroy the corresponding secret —
  each integration is a no-op when its secret is unset.

## Set the backstop budgets (do once, now)

- **GCP Billing → Budgets:** $50/day with 50/90/100% → **phone** alert.
- **Twilio:** account spend trigger / monthly cap.
- **Anthropic:** workspace spend limit.
- **Resend / Groq / vendors:** plan caps where offered.

## SMS daily ceiling

Storm SMS is now bounded by both `STORM_MAX_SMS_PER_RUN` (default 250) and
`STORM_MAX_SMS_PER_DAY` (default 2000). Set either to `0` on the
`checkStormAlerts` revision to halt storm fan-out without a deploy.
