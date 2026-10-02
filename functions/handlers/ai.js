/**
 * functions/handlers/ai.js — Claude proxy + public visualizer.
 *
 * Step 4c extraction. Moved verbatim from functions/index.js:
 *   - claudeProxy (authed onRequest, AI proxy with budget reservation)
 *   - publicVisualizerAI (public onRequest, marketing-site assessment)
 *
 * No behavioral changes; pure structural move. The Firebase deploy
 * contract is preserved via index.js re-exports.
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');

const { httpRateLimit, enforceRateLimit } = require('../integrations/upstash-ratelimit');

// Whole-endpoint daily caps for the two UNAUTHENTICATED AI endpoints
// (security checklist 2026-10-01). Their per-IP caps don't bound spend: a
// caller rotating IPs could run the Anthropic bill up indefinitely, and the
// kill switch needs a human. One fixed key = one counter for everyone.
// Override with PUBLIC_AI_DAILY_CAP (env). A limiter-store failure refuses
// (503): for a public paid endpoint, unknown spend is "no".
async function publicAiDailyCap(res, name) {
  const parsed = Number(process.env.PUBLIC_AI_DAILY_CAP);
  const cap = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 300;
  try {
    await enforceRateLimit(name + ':global', 'GLOBAL_DAILY', cap, 86_400_000);
    return true;
  } catch (e) {
    if (e && e.rateLimited) { res.status(429).json({ error: 'Busy right now — please try again tomorrow.' }); return false; }
    logger.error('[publicAi] daily cap check failed', { name, msg: e && e.message });
    res.status(503).json({ error: 'AI temporarily unavailable' });
    return false;
  }
}
// Declarative per-route policy (rate-limit-policy.js ROUTES table) — the
// wrapper enforces per-IP AND per-uid ceilings before the handler runs.
// claudeProxy is the wiring pilot (2026-08-10): its uid namespace/limit are
// byte-identical to the old hand-rolled enforceRateLimit call, plus a new
// per-IP backstop that the hand-rolled gate never had.
const { guardHttp } = require('../rate-limit-policy');
const { requireAuth } = require('../shared');
const {
  CORS_ORIGINS,
  ALLOWED_CLAUDE_MODELS,
  CLAUDE_MAX_TOKENS_CAP,
  CLAUDE_DAILY_TOKEN_BUDGET,
  CLAUDE_COMPANY_BUDGET,
  CLAUDE_COMPANY_BUDGET_DEFAULT,
  CLAUDE_RESERVATION_MAX,
  CLAUDE_MAX_MESSAGES,
  CLAUDE_MAX_PAYLOAD_BYTES,
  estimateInputTokens,
  reserveClaudeBudget,
  adjustClaudeBudget,
} = require('./_shared');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

exports.claudeProxy = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [ANTHROPIC_API_KEY],
    // R-05 sizing: 10k-concurrent-user spike × each user firing
    // ≤1 AI call/min + 30-60s tail latency → ~10k concurrent
    // in-flight. Capped at 200 (not 300) because the us-central1
    // project quota is 200,000 mCPU and each instance uses 1 vCPU
    // (1000 mCPU) — 300×1000 = 300k > 200k quota → deploy fails.
    // 200×80 = 16k ceiling, 2× headroom over the old 100×80 = 8k.
    // To exceed 200 instances, request a quota increase in Cloud
    // Console before bumping this number.
    maxInstances: 200,
    concurrency: 80,
    // minInstances was 3. Measured 2026-09-05: warm instances were 84%
    // of the whole GCP bill (~$70/mo) against ~$8/mo of actual request
    // serving. This one cost ~$22.40/mo — the most of the four — to hold
    // 240 permanently-idle concurrent slots (3 × concurrency 80). A cold
    // start adds 1-2s to a call that already runs 30-60s, so it is the
    // cheapest of the four to give up. Raise it only if measured latency
    // says so, and price it first: ~$8.10/mo per warm 256MiB instance.
    minInstances: 0,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  guardHttp('claudeProxy', async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    // Global AI kill-switch (Audit #4). One write to feature_flags/global
    // .aiDisabled halts all billable AI without a deploy or secret rotation.
    if (await require('../integrations/killswitch').isAiDisabled()) {
      res.status(503).json({ error: 'AI temporarily disabled' });
      return;
    }

    const authResult = await requireAuth(req);
    if (authResult.error) { res.status(authResult.error.status).json(authResult.error.body); return; }
    const { decoded } = authResult;

    try {
      // M-1: email-verification gate. An unverified email can be
      // anything — squatters can burn legitimate emails by signing
      // up first. Block unverified accounts from touching billable
      // surfaces (AI proxy). Platform admin exempt for support.
      const isAdmin = decoded.role === 'admin';
      if (!isAdmin && decoded.email_verified !== true) {
        res.status(403).json({ error: 'Verify your email before using AI features.' });
        return;
      }

      // Subscription gate — server-trusted Firestore doc written only by Stripe webhook.
      // Billing key = the COMPANY (companyId claim), not the caller: an invited
      // rep's uid has no subscriptions doc, so keying on uid gated every rep of
      // a paying tenant as free (gauntlet gap, same class as the #945 stripe.js
      // fix). 'trialing' counts as paid — a Growth trial is exactly the window
      // where AI features must work.
      const billingKey = decoded.companyId || decoded.uid;
      const subSnap = await getFirestore().doc(`subscriptions/${billingKey}`).get();
      const sub = subSnap.exists ? subSnap.data() : null;
      const hasPaidPlan = sub && sub.plan && sub.plan !== 'free'
        && (sub.status === 'active' || sub.status === 'trialing');
      if (!isAdmin && !hasPaidPlan) {
        res.status(403).json({ error: 'AI features require an active paid subscription.' });
        return;
      }

      // Rate limiting (per-uid AND per-IP) is enforced by the
      // guardHttp('claudeProxy') wrapper before this handler runs — limits
      // live in rate-limit-policy.js ROUTES, namespace 'claudeProxy:uid'
      // unchanged from the old inline call (admin-SDK-only Firestore doc,
      // clients cannot reset it).

      // M2: per-day token budget via materialized counters rather
      // than a range scan of api_usage.
      //
      // The previous implementation issued two parallel .where()
      // queries scanning every api_usage doc for the last 24h on
      // every single request. At 10K concurrent users × 1k
      // calls/day each, that was 20k reads/sec against a cold
      // collection — fragile under load and billing-expensive.
      //
      // Replacement: two counter docs, each a single read, keyed
      // by the UTC calendar day:
      //   api_usage_daily/{YYYY-MM-DD}__uid__{uid}
      //   api_usage_daily/{YYYY-MM-DD}__co__{companyId}
      // updated via FieldValue.increment() atomically on every
      // successful call. Rules lock the collection to admin-SDK
      // only (clients can neither read nor write — clients see
      // budget headroom only via the 429 response).
      //
      // The original api_usage collection is still dual-written
      // below, preserving per-lead cost attribution (C6) and
      // analytics drill-downs; only the HOT-PATH budget check
      // moved to the counter.
      // ── Input validation + H-07 size caps ──
      // Run BEFORE any Firestore write so a 400/413 path is free
      // of side effects.
      const { model, max_tokens, messages, system, temperature, toolset } = req.body || {};
      // Ask Joe actions (2026-10-02): a NAMED server-side tool list — never
      // tool definitions from the browser. Unknown names are ignored.
      const tools = require('../ask-joe-tools').toolsFor(toolset);
      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'messages array required' });
        return;
      }
      if (messages.length > CLAUDE_MAX_MESSAGES) {
        res.status(400).json({ error: 'Too many messages (max ' + CLAUDE_MAX_MESSAGES + ')' });
        return;
      }
      let serializedMessages;
      try { serializedMessages = JSON.stringify(messages); }
      catch (_) {
        res.status(400).json({ error: 'Invalid messages structure' });
        return;
      }
      if (serializedMessages.length > CLAUDE_MAX_PAYLOAD_BYTES) {
        res.status(413).json({ error: 'Messages payload too large (max 200KB)' });
        return;
      }
      const CLAUDE_MAX_SYSTEM_CHARS = 12000;
      const safeModel = ALLOWED_CLAUDE_MODELS.has(model) ? model : 'claude-haiku-4-5-20251001';
      const safeMaxTokens = Math.min(Number(max_tokens) || 500, CLAUDE_MAX_TOKENS_CAP);
      // System prompts are capped (tokens still count against the daily budget
      // below). 4000 chars silently cut the end off Ask Joe's prompt once it
      // carried the Kentucky + deposit ground rules (4186 chars, 2026-10-02).
      const safeSystem = (typeof system === 'string') ? system.slice(0, CLAUDE_MAX_SYSTEM_CHARS) : undefined;
      const safeTemperature = (typeof temperature === 'number')
        ? Math.max(0, Math.min(1, temperature))
        : undefined;

      // ── C-03: transactional budget reservation ──
      // Pre-reserve up to CLAUDE_RESERVATION_MAX tokens inside a
      // Firestore transaction. Concurrent callers are serialized
      // through the counter doc, so 20 parallel reqs can no longer
      // each see the same pre-call value and collectively burst
      // past the cap.
      const callerCompanyId = decoded.companyId || decoded.uid; // solo op = own company
      const dayKey = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
      const uidCounterRef = getFirestore()
        .doc(`api_usage_daily/${dayKey}__uid__${decoded.uid}`);
      const coCounterRef  = getFirestore()
        .doc(`api_usage_daily/${dayKey}__co__${callerCompanyId}`);
      const plan = (sub && sub.plan) || 'lite';
      const companyCap = CLAUDE_COMPANY_BUDGET[plan] ?? CLAUDE_COMPANY_BUDGET_DEFAULT;

      const reservation = Math.min(
        safeMaxTokens + estimateInputTokens(messages, safeSystem)
          + (tools ? Math.ceil(JSON.stringify(tools).length / 4) : 0),
        CLAUDE_RESERVATION_MAX
      );
      const reserveResult = await reserveClaudeBudget(
        getFirestore(), uidCounterRef, coCounterRef, reservation,
        {
          isAdmin,
          uidCap: CLAUDE_DAILY_TOKEN_BUDGET,
          coCap: companyCap,
          uid: decoded.uid,
          companyId: callerCompanyId,
          dayKey,
        }
      );
      if (!reserveResult.ok) {
        if (reserveResult.scope === 'uid') {
          res.status(429).json({
            error: 'Daily AI budget exceeded for your account. Resets in 24 hours.'
          });
        } else {
          res.status(429).json({
            error: 'Company AI budget exceeded for today. Upgrade plan or try again in 24 hours.',
            plan, capacity: companyCap
          });
        }
        return;
      }

      // Budget reserved. Any error path below MUST refund or the
      // caller loses tokens to a failed upstream.
      const anthropicBody = { model: safeModel, max_tokens: safeMaxTokens, messages };
      if (safeSystem !== undefined) anthropicBody.system = safeSystem;
      if (safeTemperature !== undefined) anthropicBody.temperature = safeTemperature;
      if (tools) anthropicBody.tools = tools;

      let response, data;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': ANTHROPIC_API_KEY.value(),
          },
          body: JSON.stringify(anthropicBody),
          // Bounded under the function's timeoutSeconds (60) so a slow
          // upstream refunds + errors instead of burning the whole
          // container budget and dying at the platform deadline.
          signal: AbortSignal.timeout(50_000),
        });
        data = await response.json();
      } catch (e) {
        // Network/parse/timeout error reaching Anthropic — refund full reservation.
        await adjustClaudeBudget(uidCounterRef, coCounterRef, -reservation).catch(() => {});
        const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        logger.error('claudeProxy upstream fetch error', { err: e.message, timeout: !!isTimeout });
        res.status(isTimeout ? 504 : 502).json({ error: 'Upstream AI error' });
        return;
      }
      if (!response.ok) {
        // Anthropic returned an error — refund and forward the STATUS only.
        // The raw upstream body can carry internal detail, so log it server-
        // side and return a generic error to the client, matching the
        // hardened sibling endpoints (publicVisualizerAI / publicFunnelAI /
        // adminAI). (SEC info-disclosure, backend security audit 2026-06-24.)
        await adjustClaudeBudget(uidCounterRef, coCounterRef, -reservation).catch(() => {});
        logger.error('claudeProxy upstream error', { status: response.status, body: JSON.stringify(data).slice(0, 500) });
        res.status(response.status).json({ error: 'Upstream AI error' });
        return;
      }

      try {
        // C6: stamp leadId + feature on every api_usage row so we
        // can attribute cost per-deal. Client passes them in the
        // body; trust but bound (120 char max on feature, plain
        // string on leadId).
        const leadId  = typeof req.body?.leadId  === 'string' ? req.body.leadId.slice(0, 80)  : null;
        const feature = typeof req.body?.feature === 'string' ? req.body.feature.slice(0, 60) : null;
        const inTok  = Number(data.usage?.input_tokens)  || 0;
        const outTok = Number(data.usage?.output_tokens) || 0;
        const total  = inTok + outTok;
        // C-03: reconcile actual vs reservation. Positive delta =
        // we undershot and owe the counter more tokens; negative =
        // we overshot and refund. Net effect: the counter converges
        // on true usage while the transactional reservation kept
        // concurrent callers honest.
        const delta  = total - reservation;
        const srv = FieldValue.serverTimestamp();
        await Promise.all([
          getFirestore().collection('api_usage').add({
            uid: decoded.uid,
            companyId: callerCompanyId,   // H-5: per-company budget query
            leadId,                        // C6: per-lead cost attribution
            feature,                       // e.g. 'ask-joe', 'decision-engine', 'rep-report'
            plan,
            model: anthropicBody.model,
            inputTokens: inTok,
            outputTokens: outTok,
            reservation,                   // C-03: audit for over/undershoot trending
            timestamp: srv,
          }),
          adjustClaudeBudget(uidCounterRef, coCounterRef, delta),
        ]);
      } catch (e) {
        logger.warn('api_usage logging failed', { err: e.message });
      }

      res.json(data);
    } catch (e) {
      logger.error('claudeProxy error', { uid: decoded?.uid, err: e.message });
      // claudeProxy swallows its own errors (responds 500, no rethrow), so
      // withSentry can't see them — tee the genuine crash to Sentry here.
      try { require('../integrations/sentry').captureException(e, { op: 'claudeProxy', uid: decoded?.uid }); } catch (_) {}
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// publicVisualizerAI — Public homeowner visualizer endpoint.
//
// The marketing-site visualizer.html calls this to get an AI-generated
// assessment of a home photo. Homeowners are NOT authenticated, so we
// cannot use the claudeProxy subscription gate.
//
// ⚠️ THIS ENDPOINT IS UNAUTHENTICATED. Until 2026-08-02 the list below
// claimed `enforceAppCheck: true` blocked curl replay. It never did:
// firebase-functions honours enforceAppCheck on onCall ONLY — HttpsOptions
// is declared Omit<GlobalOptions,'region'|'enforceAppCheck'>, the onRequest
// wrapper never reads it, and it is not serialized into the deployed
// endpoint either, so there is no platform-side fallback. The option has
// been removed rather than left as reassuring dead config; see the same
// finding written up at handlers/integrations.js (submitPublicLead).
// `cors` does not gate anything either — the middleware calls next() on
// non-OPTIONS requests regardless of Origin, so a request with no Origin
// header reaches this handler.
//
// What actually protects it:
//   - per-IP rolling-window rate limit: 5 requests / hour, keyed on the
//     IPv6 /64 prefix (rate-limit.js rateLimitIpKey) so one allocation
//     cannot rotate addresses to buy unlimited calls
//   - model locked to Haiku (cheapest tier)
//   - max_tokens hard-capped at 800
//   - system prompt is server-owned, client cannot inject one
//   - image payload must be a base64-encoded JPEG/PNG under 1.5 MB
// ═══════════════════════════════════════════════════════════════════════════
const VISUALIZER_MAX_B64_BYTES = Math.round(1.5 * 1024 * 1024 * 4 / 3); // ~2 MB base64
const VISUALIZER_SYSTEM_PROMPT = "You are Joe Deal, owner of No Big Deal Home Solutions in Greater Cincinnati, OH — a roofing and exterior contractor. A homeowner has uploaded a photo of their house AND has already picked the exterior materials/colors they want to see (their selections are in the user message). Your job is to write a warm, 150-200 word assessment that MAKES THEIR SELECTION SOUND GOOD.\n\nPRODUCT DICTIONARY (use these terms correctly — never confuse them):\n- \"architectural asphalt shingles\" = dimensional laminated asphalt shingles (NOT flat, NOT 3-tab)\n- \"3-tab asphalt shingles\" = flat traditional asphalt shingles\n- \"luxury designer asphalt shingles\" = premium heavyweight asphalt shingles (NOT metal, NOT slate)\n- \"standing-seam metal roofing panels\" = flat metal panels with raised seams. This is NOT \"metal shingles\" (a different product). If the user selected metal, it is standing seam — refer to it as a \"standing-seam metal roof\" or \"metal panels\" — NEVER \"metal shingles.\"\n- \"natural slate tile\" = real stone slate tiles\n- \"dutch-lap vinyl siding\", \"board-and-batten vertical siding\", \"cedar-shake siding\", \"horizontal lap siding\", \"James Hardie fiber-cement\" — use these exact product names when referring to siding\n\nSTRUCTURE:\n(1) Briefly acknowledge what the home currently has (roof age, siding condition, anything you can see from the photo).\n(2) Explain specifically why the selections they made will look good on THIS house — cite real reasons (material durability, how the color complements brick/trim/landscaping, curb appeal).\n(3) Mention one practical install consideration so you sound like a real contractor, not a salesman.\n\nBe encouraging and on-their-side — they've ALREADY chosen; don't second-guess them or pitch alternatives. Do NOT say things like 'I'd recommend instead' or 'consider a different color.'\n\nAfter the 150-200 word assessment, append a short visual description prefixed with 'CANVAS:' that describes colors and materials as hex values (this line is machine-parsed and not shown to the user).";

exports.publicVisualizerAI = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [ANTHROPIC_API_KEY],
    maxInstances: 10,
    concurrency: 20,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
    // Unauthenticated + public, so this is the ONLY operator lever short of
    // pulling the shared Anthropic key.
    if (await require('../integrations/killswitch').isAiDisabled()) {
      res.status(503).json({ error: 'AI temporarily disabled' });
      return;
    }

    // Per-IP cap — 5 visualizer calls / hour from a single IP. Each call is
    // a ~$0.01 Haiku request; 5/hour caps cost per IP at ~$0.05/hour worst case.
    if (!(await httpRateLimit(req, res, 'publicVisualizerAI:ip', 5, 3_600_000))) return;
    if (!(await publicAiDailyCap(res, 'publicVisualizerAI'))) return;

    try {
      const { imageBase64, mediaType, selectionsText, notes } = req.body || {};

      if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
        res.status(400).json({ error: 'imageBase64 required' });
        return;
      }
      if (imageBase64.length > VISUALIZER_MAX_B64_BYTES) {
        res.status(413).json({ error: 'Image too large (max 1.5 MB)' });
        return;
      }
      const allowedMedia = new Set(['image/jpeg', 'image/png', 'image/webp']);
      const safeMediaType = allowedMedia.has(mediaType) ? mediaType : 'image/jpeg';
      const safeSelections = String(selectionsText || '').slice(0, 400);
      const safeNotes = String(notes || '').slice(0, 400);

      const anthropicBody = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: VISUALIZER_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: safeMediaType, data: imageBase64 } },
            { type: 'text', text: `Selections: ${safeSelections}.${safeNotes ? ' Notes: ' + safeNotes : ''}` },
          ],
        }],
      };

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': ANTHROPIC_API_KEY.value(),
        },
        body: JSON.stringify(anthropicBody),
        // Bounded under timeoutSeconds (60) — see claudeProxy.
        signal: AbortSignal.timeout(50_000),
      });

      const data = await response.json();
      if (!response.ok) {
        logger.warn('publicVisualizerAI: upstream error', { status: response.status });
        res.status(response.status).json({ error: 'Upstream AI error' });
        return;
      }

      // Return only the text content, never the full upstream payload.
      const text = Array.isArray(data.content)
        ? data.content.map(c => (c && c.type === 'text' ? c.text : '')).join('')
        : '';
      res.json({ text });
    } catch (e) {
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      logger.error('publicVisualizerAI error', { err: e.message, timeout: !!isTimeout });
      res.status(isTimeout ? 504 : 500).json({ error: isTimeout ? 'Upstream AI timeout' : 'Internal error' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// publicFunnelAI — Public marketing-funnel text AI (estimate + storm-check).
//
// The estimate.html instant-estimator and the storm-alerts self-check call this
// for short, text-only Claude completions (a roof-size JSON estimate and a
// personalized "Joe's take" note). Homeowners are NOT authenticated, so — like
// publicVisualizerAI — we gate with a per-IP rate limit rather than the
// claudeProxy subscription gate (App Check does NOT apply here; see below).
//
// This REPLACES the `nbd-ai-proxy` Cloudflare Worker, which was an open
// Anthropic passthrough guarded only by an Origin header (bypassable when the
// header was absent) — no auth, no rate limit, no model/token cap. This
// endpoint removes most of those abuse vectors — but note it is still
// UNAUTHENTICATED, and the `enforceAppCheck: true` this list used to claim
// was dead config (honoured on onCall only; see the publicVisualizerAI
// header above for the full explanation). Removed 2026-08-02.
//   - per-IP rolling-window rate limit (the funnel makes <=2 calls per run),
//     keyed on the IPv6 /64 prefix so address rotation cannot defeat it
//   - the model is forced server-side to the cheapest Haiku tier (the client
//     cannot select an expensive model)
//   - max_tokens is capped server-side
//   - text-only: the request is a single bounded prompt string, never an
//     arbitrary upstream passthrough
// ═══════════════════════════════════════════════════════════════════════════
const FUNNEL_AI_MODEL = 'claude-haiku-4-5-20251001';
const FUNNEL_AI_MAX_PROMPT_CHARS = 6000;
const FUNNEL_AI_MAX_TOKENS_CAP = 700;

exports.publicFunnelAI = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [ANTHROPIC_API_KEY],
    maxInstances: 10,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
    // Unauthenticated + public (the /estimate funnel), so this is the ONLY
    // operator lever short of pulling the shared Anthropic key.
    if (await require('../integrations/killswitch').isAiDisabled()) {
      res.status(503).json({ error: 'AI temporarily disabled' });
      return;
    }

    // Per-IP cap — 10 calls / hour. A full funnel completion is <=2 calls
    // (estimate JSON + note); the headroom covers a couple of retries.
    if (!(await httpRateLimit(req, res, 'publicFunnelAI:ip', 10, 3_600_000))) return;
    if (!(await publicAiDailyCap(res, 'publicFunnelAI'))) return;

    try {
      const { prompt, maxTokens } = req.body || {};
      if (typeof prompt !== 'string' || prompt.length === 0) {
        res.status(400).json({ error: 'prompt required' });
        return;
      }
      if (prompt.length > FUNNEL_AI_MAX_PROMPT_CHARS) {
        res.status(413).json({ error: 'Prompt too large' });
        return;
      }
      const cappedMax = Math.min(
        Math.max(parseInt(maxTokens, 10) || 600, 1),
        FUNNEL_AI_MAX_TOKENS_CAP
      );

      const anthropicBody = {
        model: FUNNEL_AI_MODEL,           // forced — client cannot choose
        max_tokens: cappedMax,
        messages: [{ role: 'user', content: prompt }],
      };

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': ANTHROPIC_API_KEY.value(),
        },
        body: JSON.stringify(anthropicBody),
        // Bounded under timeoutSeconds (30) — see claudeProxy.
        signal: AbortSignal.timeout(25_000),
      });

      const data = await response.json();
      if (!response.ok) {
        logger.warn('publicFunnelAI: upstream error', { status: response.status });
        res.status(response.status).json({ error: 'Upstream AI error' });
        return;
      }

      // Return only the joined text — never the raw upstream payload.
      const text = Array.isArray(data.content)
        ? data.content.map(c => (c && c.type === 'text' ? c.text : '')).join('')
        : '';
      res.json({ text });
    } catch (e) {
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      logger.error('publicFunnelAI error', { err: e.message, timeout: !!isTimeout });
      res.status(isTimeout ? 504 : 500).json({ error: isTimeout ? 'Upstream AI timeout' : 'Internal error' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// adminAI — Authenticated, admin-only text AI for internal operator tools.
//
// Replaces the `nbd-ai-proxy` Cloudflare Worker for the admin tools that still
// used it (the project-codex assistant and the vault session-parsers). Unlike
// the public funnel endpoint, these are signed-in operators working with large
// internal prompts (full session text, codex DNA), so this endpoint:
//   - requires a valid Firebase ID token AND an admin-tier role claim
//   - allows much larger prompts + output than the public funnel
//   - still forces a fixed cheap Claude model server-side, caps max_tokens,
//     and per-uid rate-limits (the key cannot be abused as an open proxy)
// ═══════════════════════════════════════════════════════════════════════════
const ADMIN_AI_MODEL = 'claude-haiku-4-5-20251001';
const ADMIN_AI_MAX_PROMPT_CHARS = 60000;
const ADMIN_AI_MAX_TOKENS_CAP = 2048;
const ADMIN_AI_ROLES = new Set(['admin', 'company_admin', 'manager']);

exports.adminAI = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [ANTHROPIC_API_KEY],
    maxInstances: 5,
    concurrency: 10,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  guardHttp('adminAI', async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
    if (await require('../integrations/killswitch').isAiDisabled()) {
      res.status(503).json({ error: 'AI temporarily disabled' });
      return;
    }

    // Identity + role gate (not just App Check + IP, like the public funnel).
    const auth = await requireAuth(req);
    if (auth.error) {
      res.status(auth.error.status).json(auth.error.body);
      return;
    }
    const decoded = auth.decoded;
    const role = decoded.role || (decoded.admin === true ? 'admin' : '');
    if (!ADMIN_AI_ROLES.has(role)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    // Rate limiting (per-uid + per-IP) is enforced by the guardHttp('adminAI')
    // wrapper — limits in rate-limit-policy.js ROUTES. (The old inline call
    // keyed the SCOPE on the uid — 'adminAI:<uid>' — so its counters don't
    // carry over; limits are unchanged at 60/hr/uid, plus a new IP backstop.)

    try {
      const { prompt, maxTokens } = req.body || {};
      if (typeof prompt !== 'string' || prompt.length === 0) {
        res.status(400).json({ error: 'prompt required' });
        return;
      }
      if (prompt.length > ADMIN_AI_MAX_PROMPT_CHARS) {
        res.status(413).json({ error: 'Prompt too large' });
        return;
      }
      const cappedMax = Math.min(
        Math.max(parseInt(maxTokens, 10) || 1024, 1),
        ADMIN_AI_MAX_TOKENS_CAP
      );

      const anthropicBody = {
        model: ADMIN_AI_MODEL,
        max_tokens: cappedMax,
        messages: [{ role: 'user', content: prompt }],
      };

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(50_000), // bounded under timeoutSeconds (60)
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': ANTHROPIC_API_KEY.value(),
        },
        body: JSON.stringify(anthropicBody),
      });

      const data = await response.json();
      if (!response.ok) {
        logger.warn('adminAI: upstream error', { status: response.status });
        res.status(response.status).json({ error: 'Upstream AI error' });
        return;
      }

      const text = Array.isArray(data.content)
        ? data.content.map(c => (c && c.type === 'text' ? c.text : '')).join('')
        : '';
      res.json({ text });
    } catch (e) {
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      logger.error('adminAI error', { err: e.message, timeout: !!isTimeout });
      res.status(isTimeout ? 504 : 500).json({ error: isTimeout ? 'Upstream AI timeout' : 'Internal error' });
    }
  })
);
