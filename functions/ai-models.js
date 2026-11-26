'use strict';

/**
 * functions/ai-models.js — the AI model registry (2026-11-25, roadmap step 15;
 * audit §3.2).
 *
 * ONE row per server AI route. The route key is the spend feature name the
 * route records in ai_spend_daily (functions/ai-spend.js), so a row in the
 * spend counters and a row here are the same thing.
 *
 *   route → { model, maxTokens, timeoutMs, maxRetries, temperature?, tier,
 *             client, source, modelExport?, evalSuite?, notes, ab? }
 *
 *   model       the model the route runs TODAY. Changing a route's model is a
 *               one-line edit here (and, for a route still on raw fetch, in
 *               its own constant: see `client`). Switching a route to Haiku
 *               5.5 waits for its eval (tests/ai-evals/README.md).
 *   maxTokens   the route's default max_tokens (a caller may pass less).
 *   timeoutMs / maxRetries   used by functions/ai-client.js (the SDK's own
 *               timeout and bounded retries of 408/409/429/5xx/connection).
 *               The SDK also retries a timeout, which can be billed while
 *               unrecorded: keep 0 unless spend for abandoned attempts is
 *               recorded too.
 *   temperature present only where the route sends one today. functions/ai-
 *               client.js refuses such a route: ai-client pins API version
 *               2023-06-01 today, but the SDK default it will move to
 *               (2026-10-21) rejects temperature/top_p/top_k (400) on every
 *               model, so moving one of these routes is a behaviour change
 *               that needs Joe's OK first.
 *   tier        'internal' (back office: nobody outside the company reads the
 *               output), 'rep' (a signed-in rep reads it), 'customer' (it
 *               drafts or answers words a customer will read), 'public'
 *               (anonymous website visitors).
 *   client      'ai-client' = migrated to functions/ai-client.js (the official
 *               Anthropic SDK); 'fetch' = still a raw fetch call in `source`,
 *               to migrate in a later PR (lowest risk first: Joe, 2026-11-25).
 *   source      the file that makes the call.
 *   modelExport where `source` exports its own model constant ('a.b' path),
 *               so tests can check the two agree until the route migrates.
 *               Every raw-fetch row has one, except claude-proxy (its
 *               handler is driven in the test) and the three that write the
 *               model inline in the request (ai-texting, dictate,
 *               public-visualizer; the test reads that literal).
 *   evalSuite   the case in tests/ai-evals/evals.js (current model vs Haiku
 *               5.5; run by hand: tests/ai-evals/README.md).
 *   ab          config only (Thursday): an A/B that NO code reads yet.
 *
 * Prices stay in functions/ai-spend.js (PRICES).
 */

const MODELS = Object.freeze({
  HAIKU_4_5: 'claude-haiku-4-5-20251001',
  HAIKU_5_5: 'claude-haiku-5-5',
  SONNET_5_5: 'claude-sonnet-5-5',
  OPUS_5_5: 'claude-opus-5-5',
  FABLE_5_2: 'claude-fable-5-2',
});

// The cheaper model every eval compares against (tests/ai-evals/).
const EVAL_CANDIDATE = MODELS.HAIKU_5_5;

// The shared notes pass (call-center.js claudeNotes): 60 s, ONE attempt, as
// the raw fetch it replaced. No retry: a timed-out attempt can still be
// billed and only the answer is recorded, so a retry would hide spend from
// the daily breaker (and double a sweep's worst-case time per call).
const NOTES = { timeoutMs: 60000, maxRetries: 0, client: 'ai-client', source: 'functions/call-center.js' };

const ROUTES = {
  // ── internal / back office: MIGRATED to ai-client.js (2026-11-25) ──────
  'call-center-notes': Object.assign({ model: MODELS.HAIKU_4_5, maxTokens: 900, tier: 'internal', evalSuite: 'call-center-notes',
    notes: 'Call recording notes (summary, promises, follow-up date); sanitizeNotes checks the shape.' }, NOTES),
  'call-center-facts': Object.assign({ model: MODELS.HAIKU_4_5, maxTokens: 900, tier: 'internal', evalSuite: 'call-center-facts',
    notes: 'Caller facts from a transcript (sanitizeCallerFacts keeps only grounded facts).' }, NOTES),
  'text-notes': Object.assign({ model: MODELS.HAIKU_4_5, maxTokens: 900, tier: 'internal', evalSuite: 'text-notes',
    notes: 'A day of texts with one customer, summarised (text-inbox.js; sanitizeNotes).' }, NOTES),
  'visit-notes': Object.assign({ model: MODELS.HAIKU_4_5, maxTokens: 1500, tier: 'internal', evalSuite: 'visit-notes',
    notes: 'Site-visit walkthrough notes (visit-capture.js; sanitizeVisitNotes).' }, NOTES),
  'promise-cleanup': Object.assign({ model: MODELS.HAIKU_4_5, maxTokens: 600, tier: 'internal', evalSuite: 'promise-cleanup',
    notes: 'Nightly "was it kept?" pass; verifyVerdicts keeps only quoted, later evidence.' }, NOTES),

  // ── still raw fetch: listed with their CURRENT model, migrate later ────
  'coach-line': { model: MODELS.HAIKU_4_5, maxTokens: 150, temperature: 0.2, timeoutMs: 20000, tier: 'rep', client: 'fetch',
    source: 'functions/coach-line.js', modelExport: 'functions/coach-line-logic.js#MODEL',
    notes: 'The OS Coach focus line (the morning line on the OS home). Sends temperature 0.2: moving it to the SDK drops it (needs Joe\'s OK).' },
  'brief-me': { model: MODELS.HAIKU_4_5, maxTokens: 500, timeoutMs: 40000, tier: 'rep', client: 'fetch',
    source: 'functions/lead-brief.js', modelExport: 'functions/lead-brief-logic.js#BRIEF_MODEL', notes: 'Brief me (lead conversation summary).' },
  'call-brief': { model: MODELS.HAIKU_4_5, maxTokens: 2000, timeoutMs: 50000, tier: 'rep', client: 'fetch',
    source: 'functions/call-brief.js', modelExport: 'functions/call-brief-logic.js#BRIEF_MODEL',
    notes: 'Call to Close brief. A caller may also ask for claude-sonnet-5-5 (call-brief-logic ALLOWED_MODELS).' },
  'photo-vision': { model: MODELS.HAIKU_4_5, maxTokens: 400, timeoutMs: null, tier: 'internal', client: 'fetch',
    source: 'functions/photo-vision.js', modelExport: 'functions/photo-vision.js#_test.MODEL', notes: 'Photo tags (phase, damage). Tests inject fetchImpl; migrate with the SDK fetch option.' },
  'receipt-vision': { model: MODELS.HAIKU_4_5, maxTokens: 1500, timeoutMs: null, tier: 'internal', client: 'fetch',
    source: 'functions/receipt-vision.js', modelExport: 'functions/receipt-vision.js#_test.MODEL', notes: 'Receipt OCR (line items).' },
  'receipt-inbox': { model: MODELS.HAIKU_4_5, maxTokens: 1500, timeoutMs: null, tier: 'internal', client: 'fetch',
    source: 'functions/receipt-inbox.js', modelExport: 'functions/receipt-inbox.js#_MODEL', notes: 'Receipt inbox (emailed receipts).' },
  'price-doc-read': { model: MODELS.HAIKU_4_5, maxTokens: 6000, timeoutMs: null, tier: 'internal', client: 'fetch',
    source: 'functions/price-doc-read.js', modelExport: 'functions/price-doc-read.js#_internal.MODEL', notes: 'Supplier price document reader.' },
  'reel-vision': { model: MODELS.HAIKU_4_5, maxTokens: 1500, timeoutMs: null, tier: 'internal', client: 'fetch',
    source: 'functions/reel-studio.js', modelExport: 'functions/reel-studio.js#_test.VISION_MODEL', notes: 'Reel studio frame check.' },
  'voice-analysis': { model: MODELS.HAIKU_4_5, maxTokens: 1200, timeoutMs: 60000, tier: 'internal', client: 'fetch',
    source: 'functions/integrations/voice-intelligence.js', modelExport: 'functions/integrations/voice-intelligence.js#_VOICE_ANALYSIS_MODEL', notes: 'Voice Intelligence recording analysis.' },
  'voice-consent-check': { model: MODELS.HAIKU_4_5, maxTokens: 120, timeoutMs: 60000, tier: 'internal', client: 'fetch',
    source: 'functions/integrations/voice-intelligence.js', modelExport: 'functions/integrations/voice-intelligence.js#_VOICE_ANALYSIS_MODEL', notes: 'Verbal-consent check on a recording.' },
  'dictate': { model: MODELS.HAIKU_4_5, maxTokens: 1500, timeoutMs: null, tier: 'rep', client: 'fetch',
    source: 'functions/dictate.js', notes: 'Dictation clean-up / structure (callers pass 800-1500).' },
  'roof-photo': { model: MODELS.SONNET_5_5, maxTokens: 800, timeoutMs: null, tier: 'rep', client: 'fetch',
    source: 'functions/handlers/photo.js', modelExport: 'functions/handlers/photo.js#_ROOF_ANALYSIS_MODEL', notes: 'analyzeRoofPhoto; thinking between_tools.' },
  'admin-ai': { model: MODELS.HAIKU_4_5, maxTokens: 800, timeoutMs: 50000, tier: 'internal', client: 'fetch',
    source: 'functions/handlers/ai.js', modelExport: 'functions/handlers/ai.js#_ADMIN_AI_MODEL', notes: 'Platform admin AI (adminAI).' },
  // customer-facing: last (drafts a customer reads, or answers on the website)
  'ai-texting': { model: MODELS.HAIKU_4_5, maxTokens: 280, timeoutMs: null, tier: 'customer', client: 'fetch',
    source: 'functions/handlers/ai-texting.js', notes: 'Smart text reply drafts (owner approves before send).' },
  'claude-proxy': { model: MODELS.HAIKU_4_5, maxTokens: 500, timeoutMs: 50000, tier: 'customer', client: 'fetch',
    source: 'functions/handlers/ai.js',
    notes: 'claudeProxy: the browser picks Haiku 4.5 or Sonnet 5.5 (handlers/_shared.js ALLOWED_CLAUDE_MODELS) and may send '
      + 'temperature; the model here is its default. Spend is recorded under the browser\'s feature name. Prompt registry: functions/ai-prompts.js.' },
  'public-visualizer': { model: MODELS.HAIKU_4_5, maxTokens: 800, timeoutMs: 50000, tier: 'public', client: 'fetch',
    source: 'functions/handlers/ai.js', notes: 'publicVisualizerAI (anonymous).' },
  'public-funnel': { model: MODELS.HAIKU_4_5, maxTokens: 800, timeoutMs: 25000, tier: 'public', client: 'fetch',
    source: 'functions/handlers/ai.js', modelExport: 'functions/handlers/ai.js#_FUNNEL_AI_MODEL', notes: 'publicFunnelAI (anonymous); max_tokens per kind, server-owned.' },
  'thursday': { model: MODELS.OPUS_5_5, maxTokens: 8000, timeoutMs: 120000, tier: 'internal', client: 'fetch',
    source: 'functions/integrations/thursday.js', modelExport: 'functions/integrations/thursday-logic.js#EXTRACTION_MODEL',
    notes: 'Thursday call extraction (structured output, fallbacks default). Its own price copy: thursday-logic MODEL_PRICE_PER_MTOK.',
    // Model A/B: CONFIG ONLY (2026-11-25). Nothing reads this yet; no live
    // change. The documented flag is feature_flags/global.thursdayModelAb =
    // { enabled: false, candidate: 'claude-sonnet-5-5', sharePct: 0 }. Wiring
    // it needs: a per-call bucket (hash of the call id), the candidate's
    // price in thursday-logic MODEL_PRICE_PER_MTOK, and the model recorded on
    // each extraction so the two arms can be compared.
    ab: { flag: 'feature_flags/global.thursdayModelAb', candidate: MODELS.SONNET_5_5, defaultSharePct: 0, wired: false } },
};
for (const k of Object.keys(ROUTES)) Object.freeze(ROUTES[k]);
Object.freeze(ROUTES);

class UnknownRouteError extends Error {
  constructor(route) { super('ai-models: unknown route ' + JSON.stringify(String(route))); this.code = 'unknown_route'; }
}

/** The registry row for a route; throws UnknownRouteError for a route not listed. */
function routeConfig(route) {
  const key = String(route || '');
  if (!Object.prototype.hasOwnProperty.call(ROUTES, key)) throw new UnknownRouteError(key);
  return ROUTES[key];
}

/** The model a route runs. */
function modelFor(route) { return routeConfig(route).model; }

module.exports = { MODELS, ROUTES, EVAL_CANDIDATE, routeConfig, modelFor, UnknownRouteError };
