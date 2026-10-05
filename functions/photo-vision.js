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
 * 2026-10-04: a second door, onPhotoCreatedClassify, runs the same
 * classifier on EVERY created /photos doc (imported, drag-dropped,
 * customer-page, camera) — the callable alone reached 1 photo of 111.
 * Both doors share classifyPhoto(): the same caps, the same cache, an
 * in-flight claim so they never pay twice, and photo-caption-safety.js
 * over every caption (no claim talk on homeowner documents).
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
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { withSentry } = require('./integrations/sentry');

const { callableRateLimit, assertNotViewer } = require('./shared');
const { safeCaption } = require('./photo-caption-safety');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ─── Tunables ──────────────────────────────────────────────────────
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 400; // suggestion JSON fits in ~150 tokens; 400 = headroom

// Anthropic pricing for Haiku 4.5: $1/M input, $5/M output (claude.com/pricing,
// checked 2026-09-30; the earlier $0.80/$4 were Haiku 3.5's rates, so the
// recorded vision spend read ~20% low). Per-token costs in USD.
const COST_INPUT_PER_TOKEN  = 1.00 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 5.00 / 1_000_000;

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
  'unrelated subject), return damageType:"other" with low confidence and caption explaining what you see.',
  '',
  // KRS 367.628 (2026-10-04): the caption lands on homeowner documents. The
  // server also filters it (photo-caption-safety.js) — this line just keeps
  // the model from spending tokens on sentences that will be dropped.
  'The caption describes ONLY what is visible. Never mention insurance, claims, adjusters,',
  'coverage, deductibles, or what anyone will pay or approve.'
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
    // Claim talk is dropped sentence by sentence (photo-caption-safety.js).
    if (typeof raw.caption === 'string')   out.caption = safeCaption(raw.caption.slice(0, 200).trim());
    if (typeof raw.confidence === 'number' && !isNaN(raw.confidence)) {
      out.confidence = Math.max(0, Math.min(1, raw.confidence));
    }
  }
  return out;
}

// ─── Core classifier ───────────────────────────────────────────────
// ONE implementation, two doors: the analyzePhotoVision callable (the
// in-app camera path, bulk re-classify) and onPhotoCreatedClassify (every
// photo doc, however it was stored — imported, drag-dropped, customer-page
// upload, annotated copy excluded). Both run the same caps, the same cache
// and the same caption filter.
//
// Until 2026-10-04 only the callable existed, and only photo-engine's camera
// and the customer-page uploader called it — an audit found the classifier
// had run on ONE photo of 111. The trigger is what makes "AI tags every
// photo" true; the in-flight claim below is what stops the two doors from
// paying twice for the same photo when both fire.

// A claim older than this is a crashed attempt, not a live one.
const CLAIM_TTL_MS = 2 * 60 * 1000;

function claimMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'number') return v;
  return 0;
}

/**
 * Should the trigger classify this freshly created /photos doc? Pure.
 * Returns null to go ahead, or the skip reason.
 */
function triggerSkipReason(photo) {
  const p = photo || {};
  if (!p.userId) return 'no-owner';
  if (!p.leadId) return 'no-lead';
  if (p.aiSuggestion) return 'already-classified';
  // An annotated copy (photo-editor "save as") is a drawing over a photo that
  // was already classified — paying again would describe the marker strokes.
  if (p.originalPhotoId) return 'annotated-copy';
  const url = (p.urls && p.urls.med) || p.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return 'no-url';
  return null;
}

/**
 * Classify one photo. Never trusts the caller for ownership — callers check
 * that first (the callable: photo.userId === auth.uid; the trigger: the doc
 * was written under the owner's own rules).
 *
 * @param {object} args
 *   db, photoRef, photo  — the photo doc (already read)
 *   uid                  — whose meters pay
 *   billingKey           — subscriptions/{billingKey} resolves the plan
 *   apiKey               — Anthropic key
 *   source               — 'callable' | 'trigger' (stamped for audits)
 *   skipIfClassified     — the trigger never re-classifies
 *   fetchImpl, now       — test seams
 * @returns {Promise<object>} {suggestion,cached,costUsd} | {skipped,reason,…} | {pending:true}
 */
async function classifyPhoto(args) {
  const { db, photoRef, photo, uid, billingKey, apiKey } = args;
  const fetchImpl = args.fetchImpl || fetch;
  const now = args.now || Date.now;
  const source = args.source || 'callable';

  const leadId = photo.leadId;
  if (!leadId) return { skipped: true, reason: 'no-lead' };

  // ── In-flight claim — the two doors must not both spend ──
  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(photoRef);
    if (!s.exists) return 'gone';
    const d = s.data() || {};
    if (args.skipIfClassified && d.aiSuggestion) return 'done';
    if (now() - claimMs(d.aiClassifyClaimAt) < CLAIM_TTL_MS) return 'busy';
    tx.update(photoRef, { aiClassifyClaimAt: Timestamp.fromMillis(now()), aiClassifySource: source });
    return 'ok';
  });
  if (claim === 'gone') return { skipped: true, reason: 'gone' };
  if (claim === 'done') return { skipped: true, reason: 'already-classified' };
  // Not `skipped`: the client toasts every skip as a cap message.
  if (claim === 'busy') return { pending: true };

  const release = () => photoRef.update({ aiClassifyClaimAt: FieldValue.delete() }).catch(() => {});

  try {
    // ── Cap checks (read meters, decide before spending money) ──
    const monthKey = new Date(now()).toISOString().slice(0, 7);
    const leadMeterRef = db.doc(`leadCostMeter/${leadId}`);
    const userMeterRef = db.doc(`userCostMeter/${uid}__${monthKey}`);

    // Plan resolves from the COMPANY's subscription (companyId claim || uid) —
    // an invited rep has no subscriptions/{uid} doc, so keying on uid capped
    // every rep of a paying tenant at the 'lite' budget (gauntlet gap). The
    // per-user spend METERS stay uid-keyed on purpose.
    const [leadMeterSnap, userMeterSnap, subSnap] = await Promise.all([
      leadMeterRef.get(),
      userMeterRef.get(),
      db.doc(`subscriptions/${billingKey || uid}`).get(),
    ]);
    const leadUsd = (leadMeterSnap.exists && leadMeterSnap.data().visionUsd) || 0;
    const userUsd = (userMeterSnap.exists && userMeterSnap.data().visionUsd) || 0;
    const plan = (subSnap.exists && subSnap.data().plan) || 'lite';
    const userMonthlyCap = PER_USER_MONTHLY_USD_CAP_BY_PLAN[plan] ?? PER_USER_MONTHLY_USD_CAP;

    if (leadUsd >= PER_LEAD_USD_CAP) {
      logger.info('photo-vision.cap.lead', { leadId, leadUsd, source });
      await release();
      return { skipped: true, reason: 'lead-cap', leadUsd };
    }
    if (userUsd >= userMonthlyCap) {
      logger.info('photo-vision.cap.user', { uid, monthKey, userUsd, plan, cap: userMonthlyCap, source });
      await release();
      return { skipped: true, reason: 'user-cap', userUsd, cap: userMonthlyCap };
    }

    // ── Cache check ──
    // Prefer the med variant (~600px) if the image pipeline has produced
    // it. Falls back to the original URL when the trigger hasn't fired
    // yet. Either way we hash the URL so the cache key matches across
    // identical photos.
    const imageUrl = (photo.urls && photo.urls.med) || photo.url;
    if (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) {
      await release();
      throw new HttpsError('invalid-argument', 'Photo has no usable URL');
    }
    const cacheKey = crypto.createHash('sha256').update(imageUrl).digest('hex').slice(0, 32);
    const cacheRef = db.doc(`visionCache/${cacheKey}`);
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      // Re-sanitized on the way out: a suggestion cached before the caption
      // filter existed must not reach a report unfiltered.
      const cachedSuggestion = sanitizeSuggestion(cacheSnap.data().suggestion);
      await photoRef.update({
        aiSuggestion: cachedSuggestion,
        aiSuggestionAt: FieldValue.serverTimestamp(),
        aiSuggestionCached: true,
        aiClassifyClaimAt: FieldValue.delete(),
      });
      return { suggestion: cachedSuggestion, cached: true, costUsd: 0 };
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
      response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      data = await response.json();
    } catch (e) {
      logger.error('photo-vision.fetch_failed', { err: e.message, source });
      throw new HttpsError('internal', 'Vision API request failed');
    }
    if (!response.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + response.status);
      logger.warn('photo-vision.api_error', { status: response.status, msg, source });
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
      logger.warn('photo-vision.unparseable', { snippet: text.slice(0, 200), source });
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
        aiClassifyClaimAt:   FieldValue.delete(),
      });
    });

    return { suggestion, cached: false, costUsd: callCostUsd };
  } catch (e) {
    await release();
    throw e;
  }
}

// ─── Callable door ─────────────────────────────────────────────────
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
  if (!photo.leadId) throw new HttpsError('invalid-argument', 'Photo has no leadId');

  return classifyPhoto({
    db, photoRef, photo, uid,
    billingKey: (request.auth.token && request.auth.token.companyId) || uid,
    apiKey: ANTHROPIC_API_KEY.value(),
    source: 'callable',
  });
}));

// ─── Trigger door — every newly stored photo ───────────────────────
// Fires once per created /photos doc, whatever wrote it. Same caps as the
// callable (the photo OWNER's meters pay — the doc's userId is pinned to the
// writer by firestore.rules), same kill switch. Never throws: a trigger retry
// would be a second paid call, and the photo itself is already saved.
async function handlePhotoCreated(photoId, photo, deps) {
  deps = deps || {};
  const reason = triggerSkipReason(photo);
  if (reason) return { skipped: true, reason };
  const killswitch = deps.killswitch || require('./integrations/killswitch');
  if (await killswitch.isAiDisabled()) return { skipped: true, reason: 'ai-disabled' };
  const db = deps.db || getFirestore();
  return classifyPhoto({
    db,
    photoRef: db.doc(`photos/${photoId}`),
    photo,
    uid: photo.userId,
    billingKey: photo.companyId || photo.userId,
    apiKey: deps.apiKey || ANTHROPIC_API_KEY.value(),
    source: 'trigger',
    skipIfClassified: true,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
}

exports.onPhotoCreatedClassify = onDocumentCreated({
  document: 'photos/{photoId}',
  region: 'us-central1',
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 60,
  memory: '256MiB',
  retry: false,
}, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const photoId = event.params && event.params.photoId;
  try {
    const out = await handlePhotoCreated(photoId, snap.data() || {});
    if (out && out.skipped) logger.info('photo-vision.trigger.skip', { photoId, reason: out.reason });
  } catch (e) {
    logger.warn('photo-vision.trigger.failed', { photoId, err: e && e.message });
  }
});

// Export the sanitizer + core for unit testing.
exports._test = { sanitizeSuggestion, classifyPhoto, handlePhotoCreated, triggerSkipReason, CLAIM_TTL_MS };
