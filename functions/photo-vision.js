/**
 * photo-vision.js — Phase 3 of the photo system rebuild.
 *
 * The AUTO-TAG path. Single-photo Claude Vision classifier. The
 * client calls analyzePhotoVision({photoId}) and receives a light
 * suggestion object:
 *
 *   { phase, damageType, severity, caption, confidence }
 *
 * which the Review UI (Phase 4) renders as 1-tap-accept chips and
 * the upload flow fires fire-and-forget to pre-populate suggestions
 * before the rep ever opens Review.
 *
 * ── TWO AI PATHS, BY DESIGN ──
 * This file's analyzePhotoVision pairs with handlers/photo.js's
 * analyzeRoofPhoto. The split is intentional, not legacy:
 *
 *   analyzePhotoVision (this, Haiku) — per-upload, fast, light.
 *     Fires fire-and-forget on every photo upload via the
 *     PhotoAIClassifier client wrapper (docs/pro/js/photo-ai-
 *     classifier.js). Capped by USD ($10/lead, $50/uid/month)
 *     because it runs constantly — financial hard-stop matters.
 *
 *   analyzeRoofPhoto (Sonnet) — on-demand, deep, rich output.
 *     Called from the lightbox "Analyze with AI" button and the
 *     gallery bulk-analyze button. Returns observations + repair
 *     recommendations a rep can paste into an insurance supplement.
 *     Capped by COUNT (100/uid/day).
 *
 * Don't merge them — different surfaces, different latency / cost /
 * output-richness requirements.
 *
 * Architecture choices (locked with the user):
 *   - claude-haiku-4-5-20251001 for vision (cheap, fast, in toolchain)
 *   - onCall callable (key stays server-side, App Check enforced)
 *   - Hard $10/lead cap + $50/uid/month cap, enforced via Firestore
 *     transaction on cost meters.
 *   - Cache by sha256(imageUrl) so re-running classify on the same
 *     photo returns the cached suggestion (0 cost, near-zero latency).
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { withSentry } = require('./integrations/sentry');

const { callableRateLimit, assertNotViewer } = require('./shared');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ─── Tunables ──────────────────────────────────────────────────────
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 400; // suggestion JSON fits in ~150 tokens; 400 = headroom

// Anthropic pricing for Haiku 4.5 (verified 2026-05): $0.80/M input,
// $4.00/M output. Per-token costs in USD.
const COST_INPUT_PER_TOKEN  = 0.80 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 4.00 / 1_000_000;

// Hard caps from user product decision.
const PER_LEAD_USD_CAP         = 10.00;
// Per-user monthly vision spend cap. Plan-aware (Audit #4): a flat $50/uid
// could exceed a multi-rep Starter tenant's $99/mo revenue. Resolve the
// plan the same way claudeProxy does (subscriptions/{uid}.plan, default
// 'lite'); fall back to PER_USER_MONTHLY_USD_CAP for any unmapped plan.
const PER_USER_MONTHLY_USD_CAP = 50.00;
const PER_USER_MONTHLY_USD_CAP_BY_PLAN = {
  // 'free' is the canonical free-tier key (gap #6 seeds subscriptions/{id}
  // with plan:'free'). It MUST map to the same $25 the absent-doc default
  // ('lite') gave — without it, a seeded free doc falls through to the $50
  // PER_USER_MONTHLY_USD_CAP and silently DOUBLES the free-tenant vision spend
  // cap. 'lite' kept as the legacy alias the old default used.
  free:          25.00,
  lite:          25.00,
  foundation:    25.00,
  starter:       25.00,
  blueprint:     40.00,
  // Team had no row, so it fell through to PER_USER_MONTHLY_USD_CAP
  // (50.00) -- a coincidence, not a decision. Pinned explicitly, still
  // interpolated between Starter and Growth pending a real number.
  team:          50.00,
  growth:        75.00,
  professional: 150.00,
};

// Defense allowlists (Claude can free-form; we re-clamp to these).
const ALLOWED_PHASES   = new Set(['Before', 'During', 'After']);
const ALLOWED_DAMAGE   = new Set(['hail', 'wind', 'wear', 'granular_loss', 'leak', 'none', 'other']);
const ALLOWED_SEVERITY = new Set(['minor', 'moderate', 'severe']);

// ─── Prompt ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You are a roofing damage assessor analyzing a photo from a residential restoration job.",
  "You will receive ONE photo plus optional context. Output STRICT JSON only — no markdown",
  "code fences, no explanation, no preamble.",
  "",
  "Schema:",
  "{",
  '  "phase":      "Before" | "During" | "After" | null,',
  '  "damageType": "hail" | "wind" | "wear" | "granular_loss" | "leak" | "none" | "other",',
  '  "severity":   "minor" | "moderate" | "severe" | null,',
  '  "caption":    "one short sentence in plain English, ≤140 chars",',
  '  "confidence": 0.0-1.0  (your overall confidence in the assessment)',
  "}",
  "",
  "Conventions:",
  '- "Before" = pre-repair / pre-inspection / damage shots',
  '- "During" = work in progress (tearoff, installation, midway shots)',
  '- "After"  = finished / repaired / cleaned-up work',
  '- "phase"  can be null if you genuinely can\'t tell',
  '- "damageType" should be "none" for after-shots of fully repaired roofs or for non-damage photos',
  '- "severity" can be null when no damage visible',
  '- "caption" must be ONE short sentence, plain English (NOT technical jargon).',
  '   Good: "Hail bruising visible on the third course, north slope."',
  '   Good: "Finished install — ridge cap closed clean, gutters reattached."',
  '   Bad:  "This image depicts a roof with possible damage from hail."',
  '- "confidence" reflects HOW SURE you are. 0.5 = best guess, 0.9 = very confident.',
  '',
  "If the photo is clearly not a roof / property (e.g. a screenshot, document, or",
  'unrelated subject), return damageType:"other" with low confidence and caption explaining what you see.'
].join('\n');

// ─── Suggestion validator ──────────────────────────────────────────
// Anthropic occasionally returns markdown-wrapped JSON or extra fluff.
// Re-clamp every field to the allowed set; never trust raw output.
function sanitizeSuggestion(raw) {
  const out = {
    phase: null,
    damageType: 'other',
    severity: null,
    caption: '',
    confidence: 0.5,
  };
  if (raw && typeof raw === 'object') {
    if (ALLOWED_PHASES.has(raw.phase))     out.phase = raw.phase;
    if (ALLOWED_DAMAGE.has(raw.damageType)) out.damageType = raw.damageType;
    if (ALLOWED_SEVERITY.has(raw.severity)) out.severity = raw.severity;
    if (typeof raw.caption === 'string')   out.caption = raw.caption.slice(0, 200).trim();
    if (typeof raw.confidence === 'number' && !isNaN(raw.confidence)) {
      out.confidence = Math.max(0, Math.min(1, raw.confidence));
    }
  }
  return out;
}

// ─── Main handler ──────────────────────────────────────────────────
exports.analyzePhotoVision = onCall({
  region: 'us-central1',
  cors: CORS_ORIGINS,
  enforceAppCheck: true,
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 30,
  memory: '512MiB',
  maxInstances: 50,
  concurrency: 80
}, withSentry('analyzePhotoVision', async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  // 2026-09-25 (decision B): a viewer is read-only. This spends AI budget
  // and writes the classification onto the photo doc; the check below is
  // photo OWNERSHIP only.
  assertNotViewer(request.auth.token);

  // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
  if (await require('./integrations/killswitch').isAiDisabled()) {
    throw new HttpsError('unavailable', 'AI temporarily disabled');
  }

  // 100/min/uid — handles a 100-photo batch in ~1 minute with parallel
  // client throttling at 5 concurrent. Generous enough that legitimate
  // workflow never hits it.
  await callableRateLimit(request, 'analyzePhotoVision', 100, 60_000);

  const photoId = typeof request.data?.photoId === 'string' ? request.data.photoId : null;
  if (!photoId) throw new HttpsError('invalid-argument', 'photoId required');

  const db = getFirestore();
  const photoRef = db.doc(`photos/${photoId}`);
  const photoSnap = await photoRef.get();
  if (!photoSnap.exists) throw new HttpsError('not-found', 'Photo not found');
  const photo = photoSnap.data();

  // Owner-scope: only the photo owner can spend AI budget on it.
  const isAdmin = request.auth.token && request.auth.token.role === 'admin';
  if (!isAdmin && photo.userId !== uid) {
    throw new HttpsError('permission-denied', 'Not your photo');
  }

  const leadId = photo.leadId;
  if (!leadId) throw new HttpsError('invalid-argument', 'Photo has no leadId');

  // ── Cap checks (read meters, decide before spending money) ──
  const monthKey = new Date().toISOString().slice(0, 7);
  const leadMeterRef = db.doc(`leadCostMeter/${leadId}`);
  const userMeterRef = db.doc(`userCostMeter/${uid}__${monthKey}`);

  // Plan resolves from the COMPANY's subscription (companyId claim || uid) —
  // an invited rep has no subscriptions/{uid} doc, so keying on uid capped
  // every rep of a paying tenant at the 'lite' budget (gauntlet gap). The
  // per-user spend METERS stay uid-keyed on purpose.
  const billingKey = (request.auth.token && request.auth.token.companyId) || uid;
  const [leadMeterSnap, userMeterSnap, subSnap] = await Promise.all([
    leadMeterRef.get(),
    userMeterRef.get(),
    db.doc(`subscriptions/${billingKey}`).get(),
  ]);
  const leadUsd = (leadMeterSnap.exists && leadMeterSnap.data().visionUsd) || 0;
  const userUsd = (userMeterSnap.exists && userMeterSnap.data().visionUsd) || 0;
  const plan = (subSnap.exists && subSnap.data().plan) || 'lite';
  const userMonthlyCap = PER_USER_MONTHLY_USD_CAP_BY_PLAN[plan] ?? PER_USER_MONTHLY_USD_CAP;

  if (leadUsd >= PER_LEAD_USD_CAP) {
    logger.info('photo-vision.cap.lead', { leadId, leadUsd });
    return { skipped: true, reason: 'lead-cap', leadUsd };
  }
  if (userUsd >= userMonthlyCap) {
    logger.info('photo-vision.cap.user', { uid, monthKey, userUsd, plan, cap: userMonthlyCap });
    return { skipped: true, reason: 'user-cap', userUsd, cap: userMonthlyCap };
  }

  // ── Cache check ──
  // Prefer the med variant (~600px) if the image pipeline has produced
  // it. Falls back to the original URL when the trigger hasn't fired
  // yet. Either way we hash the URL so the cache key matches across
  // identical photos.
  const imageUrl = (photo.urls && photo.urls.med) || photo.url;
  if (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) {
    throw new HttpsError('invalid-argument', 'Photo has no usable URL');
  }
  const cacheKey = crypto.createHash('sha256').update(imageUrl).digest('hex').slice(0, 32);
  const cacheRef = db.doc(`visionCache/${cacheKey}`);
  const cacheSnap = await cacheRef.get();
  if (cacheSnap.exists) {
    const cached = cacheSnap.data();
    await photoRef.update({
      aiSuggestion: cached.suggestion,
      aiSuggestionAt: FieldValue.serverTimestamp(),
      aiSuggestionCached: true,
    });
    return { suggestion: cached.suggestion, cached: true, costUsd: 0 };
  }

  // ── Build user prompt with priors (cheap signal boost) ──
  const priors = [];
  if (photo.exif && photo.exif.takenAt) priors.push(`Taken at: ${photo.exif.takenAt}`);
  if (photo.inferredLocation && photo.inferredLocation.label) {
    priors.push(`Inferred location: ${photo.inferredLocation.label}`);
  }
  // Lead-stage prior so phase has a strong hint.
  try {
    const leadSnap = await db.doc(`leads/${leadId}`).get();
    if (leadSnap.exists) {
      const stage = leadSnap.data()._stageKey || leadSnap.data().stage;
      if (stage) priors.push(`Lead currently at stage: ${stage}`);
    }
  } catch (_) { /* non-fatal */ }

  const userText = priors.length
    ? `Context: ${priors.join(' | ')}\n\nAnalyze this photo:`
    : 'Analyze this photo:';

  // ── Call Anthropic ──
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text',  text: userText },
      ],
    }],
  };

  let response, data;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ANTHROPIC_API_KEY.value(),
      },
      body: JSON.stringify(body),
    });
    data = await response.json();
  } catch (e) {
    logger.error('photo-vision.fetch_failed', { err: e.message });
    throw new HttpsError('internal', 'Vision API request failed');
  }
  if (!response.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + response.status);
    logger.warn('photo-vision.api_error', { status: response.status, msg });
    throw new HttpsError('internal', 'Vision API error: ' + msg);
  }

  // ── Parse + sanitize ──
  const textBlock = data.content && Array.isArray(data.content)
    ? data.content.find(b => b && b.type === 'text')
    : null;
  const text = (textBlock && textBlock.text) || '';
  let rawSuggestion;
  try {
    // Strip optional ```json fences (Claude sometimes ignores the
    // "no markdown" instruction on the first call).
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
    rawSuggestion = JSON.parse(cleaned);
  } catch (e) {
    logger.warn('photo-vision.unparseable', { snippet: text.slice(0, 200) });
    throw new HttpsError('internal', 'AI returned unparseable response');
  }
  const suggestion = sanitizeSuggestion(rawSuggestion);

  // ── Compute actual cost from usage block ──
  const usage = data.usage || {};
  const inputTokens  = usage.input_tokens  || 0;
  const outputTokens = usage.output_tokens || 0;
  const callCostUsd = (inputTokens * COST_INPUT_PER_TOKEN) + (outputTokens * COST_OUTPUT_PER_TOKEN);

  // ── Atomically record cost + cache + photo update ──
  await db.runTransaction(async (tx) => {
    tx.set(leadMeterRef, {
      leadId,
      ownerUid: uid,
      visionUsd:   FieldValue.increment(callCostUsd),
      visionCount: FieldValue.increment(1),
      updatedAt:   FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(userMeterRef, {
      uid,
      monthKey,
      visionUsd:   FieldValue.increment(callCostUsd),
      visionCount: FieldValue.increment(1),
      updatedAt:   FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(cacheRef, {
      cacheKey,
      suggestion,
      model:       MODEL,
      tokensIn:    inputTokens,
      tokensOut:   outputTokens,
      costUsd:     callCostUsd,
      createdAt:   FieldValue.serverTimestamp(),
    });

    tx.update(photoRef, {
      aiSuggestion:        suggestion,
      aiSuggestionAt:      FieldValue.serverTimestamp(),
      aiSuggestionCostUsd: callCostUsd,
      aiSuggestionCached:  false,
    });
  });

  return { suggestion, cached: false, costUsd: callCostUsd };
}));

// Export the sanitizer for unit testing.
exports._test = { sanitizeSuggestion };
