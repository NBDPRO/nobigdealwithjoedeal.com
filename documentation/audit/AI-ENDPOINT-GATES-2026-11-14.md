# AI endpoint gates: who may spend NBD's AI keys (2026-11-14)

Every AI call in NBD Pro is billed to NBD's own Anthropic, Groq and Replicate keys. Today's two AI security reviews found free and unconfirmed accounts using several AI features on those keys, and two public endpoints that a stranger could switch off for the day. This note records the rule and where it lives. It leaves out exploit detail because the repo is public.

## The rule (Jo, 2026-11-14)

Free accounts get no AI. Every AI feature needs a paid plan and a confirmed email. NBD's own company is exempt so Jo can't lock himself out. Every other tenant follows the same rule, with no per-tenant exception in code.

It lives in one place: `functions/ai-gate.js`.

- **`aiEntitlement(db, claims, uid)`** checks a decoded ID token. It passes when:
  - the email is confirmed, and
  - `subscriptions/{companyId || uid}` holds a non-free plan with status `active` or `trialing`.
- **Exemptions:** the platform admin (`role: 'admin'`) and the platform tenant (`NBD_OWNER_UID`, as a uid or as a companyId).
- **Expired code trials:** an access-code trial past its `trialEndsAt` counts as free, the same way `billing.js` meters it.
- **Return value:** it returns the company it billed against.
- **`aiEntitlementForUid(db, uid)`** is for triggers, which have no token. It reads the uploader's Auth record. If the claims have no `companyId`, it falls back to `users/{uid}.companyId`, which only the server writes. A disabled account is refused.
- **`assertAiEntitled(db, auth)`** throws for `onCall` handlers: `permission-denied` with a plain message, or `unavailable` when the plan check can't be read.
- **Fails closed:** a plan read or Auth read that fails means no AI.

## Where it is applied

| PR | Endpoints |
|---|---|
| #3063 | `dictate`, `transcribeVoiceMemo` |
| #3076 | walkthrough recorder (`onVisitCaptureWrite`), call-recording uploads (`onAudioUploaded`) |
| #3079 | `analyzeRoofPhoto`, `analyzePhotoVision` and the photo-created trigger, `extractReceiptData` |
| #3085 | `previewAiPersona`, Reel Studio (`requireReelsOn`), `submitInboxReceipt`, AI reply drafts (`generateAIDraft`, which checks the lead owner) |

`adminAI` (#3039) and `claudeProxy`, `leadBrief`, `callBrief` and `coachLine` already apply the same rule with their own copies. Moving them onto `ai-gate.js` is a follow-up. `leadBrief` has no NBD exemption today.

## Budgets that changed

- **Voice (#3076):**
  - **Audio:** the monthly audio cap per company now really applies. It used to be compared against a daily counter. The new counter is `api_usage_monthly/{YYYY-MM}__co__{companyId}`.
  - **Claude calls:** each voice Claude call is counted against a per-company daily cap of 200 (`VOICE_CLAUDE_DAILY_CAP`).
  - **Plan:** the plan is read from the company.
  - **NBD:** NBD gets the top tier.
- **Vision (#3079):**
  - **Monthly dollar cap:** it is per company (`companyCostMeter/{companyId}__{YYYY-MM}`), shared by photos and receipts.
  - **Roof analysis:** `analyzeRoofPhoto` also has a per-company daily cap of 300 (`PHOTO_AI_COMPANY_DAILY_CAP`).
  - **NBD:** NBD gets the top tier.
- **Public endpoints (#3058, #3085):**
  - **Estimate and visualizer AI:** `publicFunnelAI` and `publicVisualizerAI` validate the request before they count their daily cap. `publicFunnelAI` takes structured form answers and builds its own prompt. It no longer accepts a free-text prompt.
  - **Image generator:** `visualizerImageGen`, which is off in prod, has its own daily cap (`VISUALIZER_IMAGEGEN_DAILY_CAP`, default 60). It counts only plausible images.

## Shipped and decided (2026-11-15)

- **Live:** all five fixes shipped together as #3105 (merge `44e84596`) on 2026-11-15. The separate PRs (#3058, #3063, #3076, #3079, #3085) were closed as superseded.
- **Jo's decisions:**
  - The limits stay as listed: voice hours per company per month (Starter 20, Team 35, Growth 50, Professional 166), 200 voice Claude calls per company per day, vision Starter $25 a month per company, roof analysis 300 a day, image generator 60 a day.
  - `past_due` tenants lose AI, as the older gates already did. He was asked whether to keep the limits and keep cutting AI for past-due tenants, and answered "Yes to both".
  - No per-tenant exception for any contractor tenant.
- **Plan location:** every plan reader keys a tenant's plan on `subscriptions/{companyId}`, the doc Stripe's webhook writes. `scripts/provision-tenant.js` used to seed slug tenants under the owner's uid, where nothing reads it. #3102 fixed it, and its `--check` flags a misplaced plan.

## Open follow-ups

- **Erasure and slug tenants:** `functions/integrations/erasure-billing.js` looks for Stripe ids at `subscriptions/{uid}`, so for a tenant whose company id is not the owner's uid, an erasure request can miss the live subscription.
- **Shared gate everywhere:** move `claudeProxy`, `adminAI`, `leadBrief`, `callBrief` and `coachLine` onto `ai-gate.js`.

- **Walkthrough flood:** only confirmed emails should be able to create `visit_captures` (a rules change). A flood of free signups costs no AI money, but it still uses the walkthrough lane.
- **Roof analysis App Check:** `analyzeRoofPhoto` should verify App Check by hand. It is `onRequest`, where `enforceAppCheck` does nothing.
- **Cap overshoot:** vision caps are checked outside a transaction, so parallel calls can overshoot them slightly.
- **Estimate AI and Turnstile:** tie it to a Turnstile-verified lead, so that well-formed requests from many IPs can't fill its daily limit.
- **Lapsed reels:** a reel queued while the tenant was paid still renders after the plan lapses. That is at most one day's queue.

Source audit and the per-session hand-over: `side-session-notes/.../ai-endpoints-audit-2026-11-14.md` and `ai-endpoint-fixes-handover-2026-11-14.md`, outside the repo.
