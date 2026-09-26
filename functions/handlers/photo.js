/**
 * functions/handlers/photo.js — photo / image-related HTTP handlers.
 *
 * Step 4c extraction. Moved verbatim from functions/index.js:
 *   - setStorageCors (admin-only one-shot bucket CORS update)
 *   - signImageUrl   (auth'd 15-min v4 signed-URL minter)
 *   - imageProxy     (retired stub returning 410 + RFC 8594 headers)
 *   - analyzeRoofPhoto (Sonnet vision analyzer, JSON result, photo doc stamp)
 *
 * No behavioral changes; pure structural move.
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { FieldValue } = require('firebase-admin/firestore');

const { enforceRateLimit, httpRateLimit } = require('../integrations/upstash-ratelimit');
const { requireAuth, viewOnlyRefusal } = require('../shared');
const { CORS_ORIGINS } = require('./_shared');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/**
 * One-time function to set CORS on the Firebase Storage bucket.
 * Call once via: POST /setStorageCors with Authorization header
 */
exports.setStorageCors = onRequest(
  {
    cors: CORS_ORIGINS,
    maxInstances: 1,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    // Admin-only — uses custom claims, not a self-owned Firestore role doc.
    const authResult = await requireAuth(req, { adminOnly: true });
    if (authResult.error) { res.status(authResult.error.status).json(authResult.error.body); return; }
    try {
      const bucket = getStorage().bucket();
      await bucket.setCorsConfiguration([
        {
          origin: [
            'https://nobigdealwithjoedeal.com',
            'https://www.nobigdealwithjoedeal.com',
            'https://nobigdeal-pro.web.app',
          ],
          method: ['GET', 'HEAD', 'OPTIONS'],
          maxAgeSeconds: 3600,
          responseHeader: ['Content-Type', 'Authorization', 'Content-Length', 'User-Agent'],
        },
      ]);
      logger.info('storage_cors_updated');
      res.json({ success: true, message: 'CORS configuration applied to storage bucket' });
    } catch (e) {
      logger.error('setStorageCors error', { err: e.message });
      res.status(500).json({ error: e.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// signImageUrl — serves Storage reads to authorized clients.
//
// Returns a short-lived (15 min) v4-signed Storage URL after
// authorizing the caller. Same auth/ACL matrix as the Firestore
// owner/manager/platform-admin rules: owner uid match OR same-
// company manager OR platform admin. Clients POST {path} and fetch
// the returned url directly from storage.googleapis.com — we never
// proxy bytes through the function (R-03 lesson; imageProxy did,
// and it double-egressed + starved the instance pool under load).
//
// Endpoint: POST /signImageUrl  { path: 'photos/<uid>/<file>' }
// Returns:  { url: 'https://storage.googleapis.com/...<query>' }
// ═══════════════════════════════════════════════════════════════
exports.signImageUrl = onRequest(
  {
    cors: CORS_ORIGINS,
    // R-05 sizing: every photo render on every page fires one sign
    // call (the 14-minute client cache at signed-image-url.js:23
    // prevents re-signs within a session, but fresh loads all hit).
    // At 10k users × ~10 photos visible on first render =
    // ~100k signs/min peak. Per-instance: 80 concurrent × (signing
    // latency ~150ms) = ~500/sec. 200 instances × 500 = 100k/sec
    // headroom.
    maxInstances: 200,
    concurrency: 80,
    // minInstances was 2, to absorb cold-start when a dashboard load
    // spikes right after a quiet window. Measured 2026-09-05: that cost
    // ~$14.94/mo to hold 160 permanently-idle concurrent slots, and warm
    // instances across four functions were 84% of the entire GCP bill.
    // The tradeoff bought back: 1-3s on the first photo load after an
    // idle period. ~$8.10/mo per warm 256MiB instance if reinstated.
    minInstances: 0,
    timeoutSeconds: 15,
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const authResult = await requireAuth(req);
    if (authResult.error) { res.status(authResult.error.status).json(authResult.error.body); return; }
    const { decoded } = authResult;

    if (!(await httpRateLimit(req, res, 'signImageUrl:ip', 300, 60_000))) return;
    try {
      await enforceRateLimit('signImageUrl:uid', decoded.uid, 300, 60_000);
    } catch (e) {
      if (e.rateLimited) { res.status(429).json({ error: 'Rate limit exceeded' }); return; }
      throw e;
    }

    let filePath = (req.body && req.body.path) || '';
    if (typeof filePath !== 'string' || filePath.length > 500) {
      res.status(400).json({ error: 'Invalid path' }); return;
    }
    if (/%2e|\0|\\|;|\.\./.test(filePath) || filePath.includes('//')) {
      res.status(400).json({ error: 'Invalid path' }); return;
    }
    // H-01: `portals/` intentionally excluded. Storage rules allow
    // HTML uploads under portals/{uid}/ for the legacy customer-
    // portal flow, but HTML served through this signed URL would
    // execute in the storage.googleapis.com origin. Customer-facing
    // portal HTML is served by Firebase Hosting (see storage.rules:78
    // comment). Nobody should be signing portal URLs here.
    // homeowner-uploads/ added 2026-09-14: portal.js's own comment claimed
    // "the rep's dashboard re-signs on demand via the existing signImageUrl
    // function" for these photos once their baked-in 7-day URL expires, but
    // this allowlist never actually included the prefix — every such call
    // 400'd "Invalid path shape" and the photo was unreachable from the rep
    // gallery after 7 days. storage.rules now has a matching read rule too.
    const match = filePath.match(/^(photos|galleries|reports|docs|homeowner-uploads)\/([^/]+)\/(.+)$/);
    if (!match) { res.status(400).json({ error: 'Invalid path shape' }); return; }
    const [, , ownerUid] = match;

    const isOwner = ownerUid === decoded.uid;
    const isPlatformAdmin = decoded.role === 'admin';
    let allowed = isOwner || isPlatformAdmin;
    if (!allowed) {
      const callerCompanyId = decoded.companyId || null;
      const callerRole = decoded.role || '';
      if (callerCompanyId && ['manager', 'company_admin'].includes(callerRole)) {
        try {
          const db = getFirestore();
          const [userDoc, repDoc] = await Promise.all([
            db.doc(`users/${ownerUid}`).get(),
            db.doc(`reps/${ownerUid}`).get()
          ]);
          const ownerCompanyId = (userDoc.exists && userDoc.data().companyId)
            || (repDoc.exists  && repDoc.data().companyId)
            || null;
          if (ownerCompanyId && ownerCompanyId === callerCompanyId) allowed = true;
        } catch (e) { /* fall through */ }
      }
    }
    if (!allowed) { res.status(403).json({ error: 'Forbidden' }); return; }

    try {
      const bucket = getStorage().bucket();
      const file = bucket.file(filePath);
      const [exists] = await file.exists();
      if (!exists) { res.status(404).json({ error: 'File not found' }); return; }

      // 15-minute signed URL. Short enough that a stolen URL can't
      // be re-used indefinitely; long enough that a page render +
      // photo grid scroll doesn't force re-signing on every image.
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 15 * 60_000,
        version: 'v4'
      });
      res.set('Cache-Control', 'private, max-age=300');
      res.status(200).json({ url, expiresIn: 900 });
    } catch (e) {
      logger.error('signImageUrl error', { err: e.message });
      res.status(500).json({ error: 'Signing failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// R-03: imageProxy is RETIRED.
//
// The old handler streamed Storage bytes through the function, which
// means every image egressed twice (Storage → Function → Client). At
// 10k users × 20 photos × 500KB that's ~100GB/hr through 256Mi
// function instances — the instance bandwidth ceiling (~1 Gbps per)
// starves the pool before the workload ever reaches maxInstances.
// It was also a stored-XSS vector (H-01) because it echoed whatever
// Content-Type the Storage metadata carried.
//
// Every caller migrated to signImageUrl + the NBDSignedUrl helper
// (docs/pro/js/signed-image-url.js). The stub below exists only to
// fail loudly for any stale client (cached service worker, open tab,
// third-party integration, uncached CDN edge) that still calls the
// old URL. It holds NO auth, NO Firestore touches, NO Storage reads
// — just a cheap 410 response that carries the RFC 8594 Deprecation
// + Sunset headers pointing to the successor.
//
// Safe to delete outright after 7+ days of zero calls in Cloud Logs.
// Retaining it short-term matches the pattern used for the retired
// Cloudflare Worker at workers/nbd-ai-proxy.js.
// ═══════════════════════════════════════════════════════════════
exports.imageProxy = onRequest(
  {
    cors: CORS_ORIGINS,
    maxInstances: 2,
    concurrency: 20,
    timeoutSeconds: 5,
    memory: '256MiB', // was 128MiB — 128MiB intermittently misses the Gen2 startup healthcheck loading the full index.js graph (see cspReport in handlers/monitoring.js)
  },
  (req, res) => {
    res.set('Deprecation', 'true');
    res.set('Sunset', 'Wed, 01 Oct 2026 00:00:00 GMT');
    res.set('Link', '</signImageUrl>; rel="successor-version"');
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(410).json({
      error: 'gone',
      message: 'imageProxy has been retired. Use POST /signImageUrl { path } to obtain a 15-minute v4-signed Storage URL, then fetch it directly from storage.googleapis.com.',
      successor: '/signImageUrl'
    });
  }
);

// ═══════════════════════════════════════════════════════════════════
// analyzeRoofPhoto — Wave 10 (AI photo analysis MVP)
//
// The DEEP-analysis path. Reads a photo doc by ID, fetches the image
// bytes from Storage, and asks Claude Sonnet (vision) to identify
// visible roof damage. Returns a rich structured JSON result
// (severity, materials, observations[], recommendations[],
// confidence, notRoof) and stamps it on the photo doc as
// `aiAnalysis` for later display in the inspection report and
// lightbox.
//
// ── TWO AI PATHS, BY DESIGN ──
// This file's analyzeRoofPhoto pairs with functions/photo-vision.js's
// analyzePhotoVision. The split is intentional, not legacy:
//
//   analyzeRoofPhoto (this, Sonnet)  — on-demand, deep, rich output.
//     Called from the lightbox "Analyze damage with AI" button
//     (docs/pro/js/photo-ai.js) and the gallery bulk-analyze button
//     (photo-engine.js _bulkAnalyze). Returns observations + repair
//     recommendations a rep can paste into a supplement. ~$0.005/call
//     at Sonnet pricing. Capped by COUNT (100/uid/day).
//
//   analyzePhotoVision (Haiku) — per-upload, fast, light output.
//     Fires fire-and-forget on every photo upload via the
//     PhotoAIClassifier client wrapper. Returns a 1-tap-accept
//     suggestion (phase/damageType/severity/caption/confidence) so
//     the Review UI's chips are pre-filled. Capped by USD ($10/lead,
//     $50/uid/month) because it runs constantly and we want
//     hard-stop financial guards.
//
// Don't merge them — they serve different surfaces with different
// latency / cost / output-richness requirements.
//
// Security:
//  - App Check + Firebase auth required.
//  - Caller must own the photo (photo.userId === caller.uid). No
//    cross-tenant lookups allowed.
//  - Per-uid daily cap of 100 analyses (≈$0.50/day worst case).
//  - Image fetch fails closed if Storage URL doesn't return a real
//    image content-type — prevents server fetching arbitrary URLs.
//  - System prompt is server-owned; client cannot inject one.
//  - Response is JSON-validated server-side; if model produces invalid
//    JSON we return 502 rather than persisting garbage.
// ═══════════════════════════════════════════════════════════════════
const ROOF_ANALYSIS_SYSTEM_PROMPT = `You are a senior roofing inspector with 20 years of field experience for No Big Deal Home Solutions in Greater Cincinnati. You are looking at a single photo from a roof inspection. Your job is to give the contractor a quick, accurate read on what you see.

Return ONLY valid JSON in this exact shape — no prose, no markdown, no code fences:
{
  "damageDetected": true | false,
  "severity": "none" | "minor" | "moderate" | "severe",
  "materials": ["asphalt-shingle" | "metal" | "tile" | "slate" | "tpo" | "epdm" | "wood-shake" | "unknown"],
  "observations": ["short factual observation", "another observation"],
  "recommendations": ["short next-step recommendation", "another recommendation"],
  "confidence": "low" | "medium" | "high",
  "notRoof": true | false
}

Rules:
- "notRoof" is true when the photo clearly is not a roof (set damageDetected to false, severity "none", materials [], observations ["Photo does not appear to be a roof."], recommendations ["Re-take photo of the actual roof surface."], confidence "high").
- Each observation must be a single concrete fact you can see — e.g. "Granule loss across south slope", "Cracked shingle near ridge", "Damaged flashing at chimney base". No vague filler.
- Each recommendation must be actionable — e.g. "Replace 2-3 damaged shingles", "Full replacement recommended", "Document for insurance claim".
- Cap at 5 observations and 5 recommendations.
- "severity": none = no damage, minor = isolated repair, moderate = section repair or active issue, severe = full replacement candidate.
- "confidence" reflects how sure you are based on photo angle/lighting — be honest if it's a partial view.
- DO NOT include any explanation outside the JSON. The response is machine-parsed.`;

// Per-uid daily counter for AI photo analysis. Tracked separately from
// claudeProxy budget because vision calls cost more.
const PHOTO_AI_DAILY_CAP = 100;

exports.analyzeRoofPhoto = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [ANTHROPIC_API_KEY],
    maxInstances: 10,
    concurrency: 10,
    timeoutSeconds: 60,
    memory: '512MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Per-IP cap as a first line of defense.
    if (!(await httpRateLimit(req, res, 'analyzeRoofPhoto:ip', 30, 3_600_000))) return;

    // Auth
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch (e) {
      logger.warn('analyzeRoofPhoto auth failed', { err: e.message });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 2026-09-25 (decision B): a viewer is read-only. This spends a Sonnet
    // vision call and stamps aiAnalysis onto the photo doc; the check below
    // is photo OWNERSHIP only.
    const viewOnly = viewOnlyRefusal(decoded);
    if (viewOnly) {
      res.status(viewOnly.status).json(viewOnly.body);
      return;
    }

    // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
    if (await require('../integrations/killswitch').isAiDisabled()) {
      res.status(503).json({ error: 'AI temporarily disabled' });
      return;
    }

    // Per-uid daily cap
    try {
      await enforceRateLimit('analyzeRoofPhoto:uid', decoded.uid, PHOTO_AI_DAILY_CAP, 86_400_000);
    } catch (e) {
      if (e.rateLimited) {
        res.status(429).json({ error: 'Daily photo analysis limit reached' });
        return;
      }
      throw e;
    }

    const { photoId } = req.body || {};
    if (!photoId || typeof photoId !== 'string') {
      res.status(400).json({ error: 'photoId required' });
      return;
    }

    try {
      const db = getFirestore();
      const photoRef = db.collection('photos').doc(photoId);
      const photoSnap = await photoRef.get();
      if (!photoSnap.exists) {
        res.status(404).json({ error: 'Photo not found' });
        return;
      }
      const photo = photoSnap.data();

      // Ownership check — photos are user-scoped, not company-scoped.
      if (photo.userId !== decoded.uid) {
        logger.warn('analyzeRoofPhoto cross-tenant attempt', {
          callerUid: decoded.uid, photoOwner: photo.userId, photoId
        });
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (!photo.url || typeof photo.url !== 'string') {
        res.status(400).json({ error: 'Photo has no URL' });
        return;
      }
      // Only allow Firebase Storage URLs to prevent SSRF.
      if (!/^https:\/\/firebasestorage\.googleapis\.com\//.test(photo.url) &&
          !/^https:\/\/storage\.googleapis\.com\//.test(photo.url)) {
        logger.warn('analyzeRoofPhoto suspicious url', { photoId, host: photo.url.slice(0, 60) });
        res.status(400).json({ error: 'Photo URL not allowed' });
        return;
      }

      // Fetch image bytes
      const imgRes = await fetch(photo.url);
      if (!imgRes.ok) {
        res.status(502).json({ error: 'Could not fetch photo' });
        return;
      }
      const contentType = imgRes.headers.get('content-type') || '';
      const allowed = ['image/jpeg', 'image/png', 'image/webp'];
      const safeMediaType = allowed.find(t => contentType.startsWith(t)) || null;
      if (!safeMediaType) {
        res.status(400).json({ error: 'Unsupported image type' });
        return;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      // Cap at 4 MB raw / ~5.5 MB base64 — Anthropic vision limit guard.
      if (buf.length > 4 * 1024 * 1024) {
        res.status(413).json({ error: 'Image too large (max 4 MB)' });
        return;
      }
      const imageBase64 = buf.toString('base64');

      // Call Claude (Sonnet for better vision accuracy on small details)
      const anthropicBody = {
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: ROOF_ANALYSIS_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: safeMediaType, data: imageBase64 } },
            { type: 'text', text: 'Analyze this roof photo and return the JSON described in the system prompt.' },
          ],
        }],
      };

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': ANTHROPIC_API_KEY.value(),
        },
        body: JSON.stringify(anthropicBody),
      });
      const aiData = await aiRes.json();
      if (!aiRes.ok) {
        logger.warn('analyzeRoofPhoto upstream error', { status: aiRes.status });
        res.status(502).json({ error: 'AI upstream error' });
        return;
      }

      const text = Array.isArray(aiData.content)
        ? aiData.content.map(c => (c && c.type === 'text' ? c.text : '')).join('').trim()
        : '';

      // Strip code fences if model accidentally wraps JSON.
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

      let analysis;
      try {
        analysis = JSON.parse(cleaned);
      } catch (e) {
        logger.warn('analyzeRoofPhoto invalid JSON', { snippet: cleaned.slice(0, 200) });
        res.status(502).json({ error: 'AI returned invalid JSON' });
        return;
      }

      // Validate shape — fail closed if model drifts.
      const validSeverity   = ['none', 'minor', 'moderate', 'severe'];
      const validConfidence = ['low', 'medium', 'high'];
      const result = {
        damageDetected: !!analysis.damageDetected,
        severity: validSeverity.includes(analysis.severity) ? analysis.severity : 'none',
        materials: Array.isArray(analysis.materials) ? analysis.materials.slice(0, 5).map(String) : [],
        observations: Array.isArray(analysis.observations) ? analysis.observations.slice(0, 5).map(String) : [],
        recommendations: Array.isArray(analysis.recommendations) ? analysis.recommendations.slice(0, 5).map(String) : [],
        confidence: validConfidence.includes(analysis.confidence) ? analysis.confidence : 'low',
        notRoof: !!analysis.notRoof,
        analyzedAt: FieldValue.serverTimestamp(),
        modelVersion: anthropicBody.model,
      };

      // Stamp on photo doc for later report use.
      await photoRef.update({ aiAnalysis: result });

      // Return without the serverTimestamp sentinel (clients can't read it).
      const { analyzedAt, ...clientView } = result;
      res.json({ success: true, analysis: { ...clientView, analyzedAt: new Date().toISOString() } });
    } catch (e) {
      logger.error('analyzeRoofPhoto error', { err: e.message });
      res.status(500).json({ error: 'Internal error' });
    }
  }
);
