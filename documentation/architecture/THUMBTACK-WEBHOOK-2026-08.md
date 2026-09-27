# Thumbtack Webhook Integration — 2026-08-16

> **Correction — 2026-09-26: Thumbtack leads never paged anyone until this
> date.** This doc said a bridged lead "inherits the alert triggers" and that
> the webhook would "fire the existing `leadAlert*` SMS/email". Neither was
> true. `functions/lead-alert.js` had no trigger on `thumbtack_leads`. Its one
> `leads/{leadId}` trigger (`leadAlertCalcom`) returned early for everything
> except Cal.com bookings, and `push-functions.js` needs an `assignedTo` that
> the bridge never sets. A read-only prod check found **0 `alert_outbox`
> rows against 74 real Thumbtack leads** (2026-08-16 → 2026-09-26). The 3
> contact-form leads in the same window had exactly 3 rows. This is the
> channel whose losses the audit traced to *reply speed*.
> [WAVE2-IMPLEMENTATION-MAPS-2026-09-05](../audit/WAVE2-IMPLEMENTATION-MAPS-2026-09-05.md)
> had already flagged this sentence as wrong, but the doc was not corrected.
>
> **Fixed 2026-09-26.** `leadAlertCalcom` now also alerts on the bridge's
> create of `leads/{thumbtack_leads__<rawId>}`: an email to `ALERT_EMAILS`
> and an SMS to Joe's cell, labelled "Thumbtack", with the service,
> questionnaire answers and lead cost. It is recorded in `alert_outbox` under
> collection `leads`, and the homeowner gets no ack. Only the doc whose id
> is the bridge's own deterministic id pages, and nothing listens on
> `thumbtack_leads`, so one lead gets one alert. The alert goes live when the
> functions deploy ships. Leads that arrived before then were never alerted
> and will not be. Details, the prod evidence and the break-tests:
> [THUMBTACK-LEAD-ALERT-GAP-2026-09-26](../audit/THUMBTACK-LEAD-ALERT-GAP-2026-09-26.md).
> The diagram and §Architecture below are corrected to match.
>
> **Also stale — the 2026-09-20 "Known live gap" below is resolved.** PR #1681
> (merged 2026-09-20) made `mapPublicLeadToLead` write the structured
> `leadCost` from Thumbtack's `leadPrice` at bridge time
> (`functions/lead-bridge-logic.js`, `isExternal && data.leadPrice`). Leads
> bridged since then carry it. Only leads bridged between the 09-06 backfill
> and that deploy can be missing it.

> **Update — 2026-09-20:** This doc's original "not yet connected" status line
> below was stale — [INDEX.md](../INDEX.md) has carried "LIVE in prod since
> 2026-08-16, real leads flowing" since the day this was written, and
> `thumbtack-logic.js` has carried "VERIFIED 2026-08-16 against a live
> delivery" comments the whole time. The webhook was connected same-day; only
> this status line never got updated. The §Open question below is also
> stale for the same reason — the payload **was** captured and the `pick()`
> paths **were** tightened against real deliveries; see the "VERIFIED
> 2026-08-16" comments in `thumbtack-logic.js` for the confirmed shape
> (`event.eventType: "NegotiationCreatedV4"`, price at `data.leadPrice`).
>
> **Known live gap (found 2026-09-20):** `data.leadPrice` is captured into the
> CRM lead's `notes` text (via `leadNotes()`) but is **not** written to the
> structured `leadCost` field on the `/leads` doc at ingest time — only
> `docs/pro/js/crm-leads.js` (manual dashboard entry) and the one-off
> `scripts/backfill-lead-cost.js` (historical notes-parsing) populate that
> field. Every Thumbtack lead bridged since the 2026-09-06 backfill is
> missing a structured `leadCost` unless someone re-runs the backfill or
> types it in by hand.

**Status: LIVE in prod since 2026-08-16 — real leads flowing.** The receiving endpoint (`thumbtackWebhook`) and the CRM bridge (`leadBridgeThumbtack`) are in the repo, unit-tested, and connected on the Thumbtack side.

## Why this exists

The [Aug 2026 lead-channel audit](../audit/) found that **every** Thumbtack loss traced to speed or silence — never to price or lead quality. The pattern, from the verified lead log:

| Reply time | Outcome |
|---|---|
| 2 min | Won $250 on a $23.38 lead |
| 2 min | Won $140 on a $9.40 lead |
| 9 min | Won $2,500 on a $20.78 lead |
| 1h 44m | Lost — competitor replied in 7 min |
| 7h 58m | Lost — competitor replied in 4 min |
| 11h 06m | Lost, despite being the **only** pro of four who responded at all |

Separately, 15 of 38 people were owed something Joe said he would send. The two webhook event types map directly onto those two failure modes: **Lead details** attacks the response-time gap, **Messages** attacks the follow-through gap.

## What it can and cannot do

**Can:** capture a lead into the CRM pipeline within seconds of Thumbtack creating it. Since 2026-09-26 (see the correction at the top) it also texts and emails Joe through `leadAlertCalcom` and `resolveAlertTarget(companyId)`. Before that date it did not.

**Cannot — and this is a hard platform limit, not a to-do:**

- **One-way.** Thumbtack pushes; we cannot push back. There is no auto-reply and there cannot be one — replies still happen inside the Thumbtack app. This buys notification speed and automatic capture, nothing else. Do not build an "auto-respond" feature on top of this expecting it to reach the customer.
- **No email addresses, ever.** Thumbtack states plainly: *"We provide you with the customer's name and phone number on all leads (we do not provide email addresses)."* A Thumbtack CRM lead is legitimately email-less. The pipeline card says so in its notes so nobody records it as missing data.

## Architecture

```
Thumbtack (Apps → Webhooks)
      │  POST + Custom Header token
      ▼
thumbtackWebhook            functions/integrations/thumbtack.js
  ├─ fail closed if secret unset (503)
  ├─ constant-time token compare (401 on mismatch)
  ├─ 256 KB body cap (413)
  ├─ classify: lead | message | review | unknown
  └─ create() with deterministic id  ← idempotent
      │
      ├─ thumbtack_leads     ──┐
      ├─ thumbtack_messages    │  (all four admin-SDK only,
      ├─ thumbtack_reviews     │   explicit deny in firestore.rules)
      └─ thumbtack_events   ──┘   ← unrecognised payloads, stored verbatim
              │
              ▼
      leadBridgeThumbtack       functions/lead-bridge.js
        ├─ skips isTest deliveries (stored, never bridged)
        └─ mapPublicLeadToLead → leads/{thumbtack_leads__<rawId>}  (create())
                │
                ▼
        leadAlertCalcom         functions/lead-alert.js   (since 2026-09-26)
          ├─ only when doc id == bridgeDocId('thumbtack_leads', publicLeadId)
          └─ SMS + email to Joe, alert_outbox row, NO homeowner ack
```

Deliberately reuses the existing public-lead → CRM bridge rather than inventing a parallel path, so a Thumbtack lead inherits `companyId` stamping, `phoneDigits` (inbound-SMS matching) and `stageStartedAt` for free. It did **not** inherit the new-lead alert. The web forms alert from their own public collections, and nothing did that for `thumbtack_leads`. The alert was added separately on 2026-09-26. It keys on the bridged `leads/` doc, not `thumbtack_leads`, so a Thumbtack test delivery (never bridged) pages nobody. A future marketplace added to `EXTERNAL_SOURCE_COLLECTIONS` needs its own alert branch too, because being bridged does not mean being alerted.

**Not** a new `kind` on `submitPublicLead`. That endpoint is browser-shaped — CORS origin allowlist, Turnstile verification, per-IP rate limiting. A server-to-server POST from Thumbtack carries no browser origin and no Turnstile token; it would fail every gate.

## Channel attribution — the subtle bit

`mapPublicLeadToLead` prefixes every bridged source with `Website — `. For a marketplace lead that is actively wrong: it credits paid Thumbtack spend to the website in the lead scorecard, which is exactly the class of attribution error the Aug audit spent a day unwinding (six leads were filed as Direct when they came through Yelp).

`EXTERNAL_SOURCE_COLLECTIONS` in `functions/lead-bridge-logic.js` exists for this. Thumbtack leads get `source: 'Thumbtack'` and `webLead: false`. Add any future marketplace to that array, not to the generic path.

## Security posture

Thumbtack offers **no HMAC signing** — the auth choices are None, Basic, or Custom Header. So this is a bearer-style shared secret, weaker than the `calcomWebhook` HMAC model, and the endpoint compensates:

- Fails closed when `THUMBTACK_WEBHOOK_SECRET` is unset. An unauthenticated writer who learns the URL could otherwise stuff the pipeline.
- Constant-time compare via SHA-256 digests of both sides (equal-length buffers, so `timingSafeEqual` can't throw and can't leak length).
- All four landing collections carry raw customer names and phone numbers → explicit `allow read, write: if false` in `firestore.rules`, on top of the default deny.
- Logs carry ids and classification only, never name or phone.

Rotation: set a new secret, then update the header value in the Thumbtack webhook form. See [SECRET_ROTATION](../runbooks/SECRET_ROTATION.md).

## Open question — the payload schema

**Thumbtack does not publish one.** Their guidance is to point the webhook at Zapier, which is schema-agnostic. So `thumbtack-logic.js` accepts several plausible spellings per field (camelCase, snake_case, nested under `lead`/`customer`/`request`) and **stores the complete raw payload on every doc**.

That last part is the important one: the first real delivery is the spec. Read it back out of `thumbtack_leads`, then tighten the `pick()` path lists. Do not narrow them before there's a real payload to narrow against — `tests/thumbtack-webhook.test.js` pins the current tolerance so a premature cleanup fails loudly instead of silently dropping leads.

## Setup (endpoint first, webhook second)

1. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. `firebase functions:secrets:set THUMBTACK_WEBHOOK_SECRET`
3. Deploy. Endpoint: `https://us-central1-nobigdeal-pro.cloudfunctions.net/thumbtackWebhook`
4. Thumbtack → Apps → Webhooks → Manage webhooks → Create webhook
   - Authorization type **Custom Header**, name `X-NBD-Webhook-Token` (override via `THUMBTACK_WEBHOOK_HEADER`), value = the token
   - Profile: No Big Deal Home Solutions (`586102014464466945`)
   - Receive: Lead details, Messages, Reviews
5. **Test this webhook** → check Recent deliveries for a 200. Test payloads are stored in `thumbtack_leads` but never bridged, so the kanban stays clean.

## Strategic caveat

This makes the *weaker* channel less weak. Yelp returned ~$138 per dollar against Thumbtack's $2.45 over the audited period, and Yelp offers no equivalent webhook. The reallocation is the big lever; this is not. It earns its place because it is free, roughly a day of work, and the Messages and Reviews events pay off regardless of how much lead spend flows through Thumbtack.

## Files

- `functions/integrations/thumbtack.js` — receiver
- `functions/integrations/thumbtack-logic.js` — pure payload logic (firebase-free)
- `functions/lead-bridge.js` / `lead-bridge-logic.js` — bridge + external-source handling
- `functions/lead-alert.js` — `leadAlertCalcom` → `onThumbtackLeadAlert` (new-lead alert, since 2026-09-26)
- `tests/lead-alert-thumbtack.test.js` — the alert fires once for a bridged lead, never for a look-alike, never to the homeowner
- `functions/integrations/_shared.js` — `THUMBTACK_WEBHOOK_SECRET` registration
- `firestore.rules` — explicit deny on the four collections
- `tests/thumbtack-webhook.test.js` — 61 assertions, wired into `npm test` as `test:thumbtack`
