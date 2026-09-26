/**
 * functions/integrations/_shared.js
 *
 * Helpers every integration adapter uses: secret registry, config
 * check, and a shared `integrationStatus` endpoint that tells the
 * client which connectors are wired so the UI can grey-out buttons
 * for unconfigured providers.
 *
 * Design rule: every adapter checks for its own secret at call time
 * and returns a structured { configured: false, provider } response
 * when the key is missing. Nothing ever throws just because an
 * integration isn't set up — a non-configured provider behaves like
 * the feature doesn't exist.
 */

'use strict';

let defineSecret;
try {
  ({ defineSecret } = require('firebase-functions/params'));
} catch (_) {
  // Not in Firebase Functions runtime (e.g., test / node --check environment).
  // Provide a stub whose .value() reads from process.env so hasSecret() works.
  defineSecret = (name) => ({ value: () => (process.env[name] || null) });
}

// ── Secret registry ─────────────────────────────────────────
// Every integration secret lives here so we can iterate them for
// the status endpoint without duplicating the list. Adding a new
// integration? Register its secret here AND in the adapter file.
const SECRETS = {
  // Observability
  SENTRY_DSN_FUNCTIONS:  defineSecret('SENTRY_DSN_FUNCTIONS'),
  SLACK_WEBHOOK_URL:     defineSecret('SLACK_WEBHOOK_URL'),
  // Healthchecks.io project ping key — every onSchedule pings
  // hc-ping.com/<key>/<slug> after each run (integrations/heartbeat.js).
  // Bound automatically by the heartbeat onSchedule wrapper; unset = no-op.
  HEALTHCHECKS_PING_KEY: defineSecret('HEALTHCHECKS_PING_KEY'),

  // Human verification
  TURNSTILE_SECRET:      defineSecret('TURNSTILE_SECRET'),

  // Rate limiting
  UPSTASH_REDIS_REST_URL:   defineSecret('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: defineSecret('UPSTASH_REDIS_REST_TOKEN'),

  // Business integrations
  HOVER_API_KEY:         defineSecret('HOVER_API_KEY'),
  HOVER_WEBHOOK_SECRET:  defineSecret('HOVER_WEBHOOK_SECRET'),
  EAGLEVIEW_API_KEY:     defineSecret('EAGLEVIEW_API_KEY'),
  EAGLEVIEW_WEBHOOK_SECRET: defineSecret('EAGLEVIEW_WEBHOOK_SECRET'),
  NEARMAP_API_KEY:       defineSecret('NEARMAP_API_KEY'),
  // Instant Roofer — AI measure from coordinates (synchronous) and the ~1 h
  // Human Certified Report; the webhook secret is a bearer token WE mint and
  // paste into their dashboard (runbooks/INSTANTROOFER-SETUP.md).
  INSTANTROOFER_API_KEY: defineSecret('INSTANTROOFER_API_KEY'),
  INSTANTROOFER_WEBHOOK_SECRET: defineSecret('INSTANTROOFER_WEBHOOK_SECRET'),
  BOLDSIGN_API_KEY:      defineSecret('BOLDSIGN_API_KEY'),
  BOLDSIGN_WEBHOOK_SECRET: defineSecret('BOLDSIGN_WEBHOOK_SECRET'),
  REGRID_API_TOKEN:      defineSecret('REGRID_API_TOKEN'),
  HAILTRACE_API_KEY:     defineSecret('HAILTRACE_API_KEY'),
  CALCOM_WEBHOOK_SECRET: defineSecret('CALCOM_WEBHOOK_SECRET'),
  // Swath (swathapi.com) — storm-verified property intel. One key for
  // both the hail-swath and property-lookup surfaces; the webhook secret
  // comes back from POST /v1/monitors (see runbooks/SWATH-SETUP.md).
  SWATH_API_KEY:         defineSecret('SWATH_API_KEY'),
  SWATH_WEBHOOK_SECRET:  defineSecret('SWATH_WEBHOOK_SECRET'),
  // Shared token Thumbtack presents on every webhook delivery (Custom Header
  // auth — Thumbtack offers no HMAC signing, so this is a bearer-style secret
  // and the receiver fails closed without it). See integrations/thumbtack.js.
  THUMBTACK_WEBHOOK_SECRET: defineSecret('THUMBTACK_WEBHOOK_SECRET'),
  // Bland AI — Thursday, the NBD receptionist (integrations/thursday.js).
  // API key: fetch calls/recordings, send SMS. Webhook secret: Dev Portal →
  // Keys, verifies X-Webhook-Signature. Lookup token: a bearer WE mint and
  // store in Bland Secrets for the pathway's caller-lookup webhook node.
  BLAND_API_KEY:         defineSecret('BLAND_API_KEY'),
  BLAND_WEBHOOK_SECRET:  defineSecret('BLAND_WEBHOOK_SECRET'),
  THURSDAY_LOOKUP_TOKEN: defineSecret('THURSDAY_LOOKUP_TOKEN'),

  // Image generation (visualizer) — kie.ai alternate provider
  // (visualizer-image-gen.js; Replicate's token is declared there, not here,
  // because it predates this registry).
  KIE_API_KEY:           defineSecret('KIE_API_KEY'),

  // Voice transcription (F8)
  DEEPGRAM_API_KEY:      defineSecret('DEEPGRAM_API_KEY'),

  // Voice Intelligence (Voice Intel — C1)
  // Phase 1 transcription = Groq Whisper-large-v3-turbo ($0.04/hr).
  // Phase 2 may add Deepgram for native diarization on Pro+ tiers.
  GROQ_API_KEY:          defineSecret('GROQ_API_KEY')
};

// Provider preference for swappable categories. Set via env (not
// secret) so it's visible in logs and easy to rotate mid-flight.
// Defaults chosen for biggest-bang-for-buck in roofing CRM context.
const PROVIDERS = {
  // measurement default flipped hover → instantroofer on 2026-09-06: it is the
  // first provider that ever had a real key (the other three have been the
  // deploy stub since April). hover/eagleview/nearmap remain selectable.
  measurement:       (process.env.NBD_MEASUREMENT_PROVIDER  || 'instantroofer').toLowerCase(),
  esign:             (process.env.NBD_ESIGN_PROVIDER        || 'boldsign').toLowerCase(),
  // parcel: 'regrid' (default) | 'swath'  ·  hail: 'noaa' (default,
  // free) | 'swdi' (free, keyless radar hail — integrations/swdi-hail.js)
  // | 'hailtrace' | 'swath'. Swath is one key for both slots —
  // integrations/swath.js.
  parcel:            (process.env.NBD_PARCEL_PROVIDER       || 'regrid').toLowerCase(),
  hail:              (process.env.NBD_HAIL_PROVIDER         || 'noaa').toLowerCase(),
  rateLimit:         (process.env.NBD_RATE_LIMIT_PROVIDER   || 'firestore').toLowerCase(),
  // Voice transcription for the Voice Intelligence pipeline.
  //   'groq'     → Groq Whisper-large-v3-turbo ($0.04/hr, no speakers)
  //   'deepgram' → Deepgram Nova-2 ($0.26/hr, native diarization)
  // Flip via env var — no code deploy needed when switching tiers.
  voiceTranscription:(process.env.NBD_VOICE_TRANSCRIPTION_PROVIDER || 'groq').toLowerCase()
};

// A secret is considered "configured" only if it has a non-empty
// value AFTER trimming whitespace AND isn't the placeholder we use
// to stub-create missing secrets during deploy (see the
// "Ensure integration secrets exist" step in firebase-deploy.yml).
// Firebase CLI requires each secret to have a "latest version" with
// at least 1 byte, so the stub value can't be empty — but it still
// needs to be recognizable as "not configured" at runtime.
const SECRET_STUB_VALUE = '__unset__';
function hasSecret(name) {
  try {
    if (!SECRETS[name]) return false;
    // Read process.env directly instead of SecretParam.value().
    //
    // They are the SAME SOURCE — firebase-functions' SecretParam.runtimeValue()
    // is literally `process.env[this.name]` (params/types.js) — but .value()
    // ALSO logs a WARNING every time the secret is not bound to the calling
    // function, then returns ''. This registry is module scope, so any function
    // that requires _shared.js paid that warning for every secret it does not
    // bind, on every cold start.
    //
    // Measured 2026-09-06: 500+ WARNING lines in 24h across 12+ services
    // (claudeProxy, stormWatch, checkStormAlerts, onFollowUpDue, …), all of
    // them for UPSTASH_REDIS_REST_URL alone. Nothing was broken — Firestore is
    // the configured rate-limit provider and `rate_limit_provider_drift` had
    // never once fired — but the noise is the problem: drift is the warning
    // built to catch a REAL Upstash misconfiguration, and it would have been
    // one line among hundreds of identical ones.
    //
    // Semantics are unchanged, including the deploy-time case: .value() throws
    // while FUNCTIONS_CONTROL_API=true, which the catch below turned into
    // false; process.env is simply undefined there, giving the same false.
    const raw = process.env[name];
    if (typeof raw !== 'string') return false;
    const trimmed = raw.trim();
    return trimmed.length > 0 && trimmed !== SECRET_STUB_VALUE;
  } catch (e) { return false; }
}

function getSecret(name) {
  // Trim — a secret pasted with a trailing newline (the Stripe \r\r\n bug
  // class) silently breaks exact-match consumers: HMAC compares (Cal.com
  // webhook) and bearer headers fail with no signal. No secret we store has
  // meaningful leading/trailing whitespace, so trimming is universally safe.
  try {
    const v = SECRETS[name].value();
    return typeof v === 'string' ? v.trim() : v;
  } catch (e) { return null; }
}

// Structured "integration not configured" response. Adapters return
// this instead of throwing so the caller can gracefully fall back
// (e.g., manual entry if HOVER isn't wired).
function notConfigured(provider, reason) {
  return { configured: false, provider, reason: reason || 'Missing API key' };
}

// Read a BARE defineSecret() param (one that predates this registry) with the
// same rules hasSecret()/getSecret() apply to registry entries: trimmed, and
// the deploy's `__unset__` stub counts as unset. Returns null when the param
// is unbound, empty, or the stub.
//
// Why this exists (2026-09-04, STABILITY-AUDIT): `'__unset__'` is a truthy
// nine-character string. Four deployed functions guarded a bare param with
// plain truthiness — `if (!X.value())` or `X.value() || fallback` — and so
// believed they were configured when they were not: the Places widget asked
// Google for `places/__unset__`, the lead alert would have texted the phone
// number "__unset__" instead of Jo's fallback, and so on. Every bare read
// goes through here now; tests/secret-stub-guard.test.js fails CI if a
// `.value() ||` / `.value() ??` fallback comes back outside its allowlist.
function secretValue(param) {
  try {
    const v = param && typeof param.value === 'function' ? param.value() : null;
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed.length > 0 && trimmed !== SECRET_STUB_VALUE ? trimmed : null;
  } catch (e) { return null; }
}

// `secretOr(EMAIL_FROM, 'noreply@…')` — the fallback wins over the stub too,
// which `EMAIL_FROM.value() || 'noreply@…'` never did.
function secretOr(param, fallback) {
  const v = secretValue(param);
  return v == null ? fallback : v;
}

module.exports = {
  SECRETS,
  PROVIDERS,
  hasSecret,
  getSecret,
  secretValue,
  secretOr,
  SECRET_STUB_VALUE,
  notConfigured
};
