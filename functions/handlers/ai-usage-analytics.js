/**
 * functions/handlers/ai-usage-analytics.js — real usage aggregation for
 * /admin/analytics.html, replacing the page's SAMPLE DATA mock.
 *
 * `api_usage` holds one doc per successful claudeProxy call — uid,
 * companyId, leadId, feature, plan, model, inputTokens, outputTokens,
 * timestamp (functions/handlers/ai.js). Errors/429s are never written
 * there, only to Cloud Logging (handlers/ai.js, rate-limit-policy.js), so
 * this endpoint has no real backing data for an "errors" or "rate limits"
 * count — it reports those as untracked (null) rather than fabricating a
 * number the way the old mock did.
 *
 * Window is a rolling trailing 24h (not calendar-day), so the numbers
 * don't reset to zero at UTC midnight regardless of when an admin loads
 * the page.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { callableRateLimit } = require('../shared');
const { CORS_ORIGINS } = require('./_shared');

// $ per million tokens — current Anthropic pricing for the two models
// claudeProxy is actually allowed to call (handlers/_shared.js's
// ALLOWED_CLAUDE_MODELS). Estimate only, shown to admins; not billing-critical.
const MODEL_RATES_PER_M = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // Historical rows (removed from the allowlist 2026-10-04 — deprecated).
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};
const DEFAULT_RATE = { input: 3, output: 15 }; // sonnet-tier fallback for an unrecognized model string

function costUSD(model, inputTokens, outputTokens) {
  const rate = MODEL_RATES_PER_M[model] || DEFAULT_RATE;
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

const WINDOW_MS = 24 * 3_600_000;
// Defense against a runaway (a retry storm, a bug), not because real
// volume is expected to reach it — same posture as health-digest.js's
// stripe_events cap.
const READ_CAP = 20_000;

exports.getAiUsageAnalytics = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const isPlatformAdmin = request.auth.token.role === 'admin';
    if (!isPlatformAdmin) {
      throw new HttpsError('permission-denied', 'Admin access required');
    }
    // Platform-wide dashboard, single admin — 90/hr covers a 60s
    // auto-refresh plus manual refreshes, same generosity as
    // getAdminAnalytics/getAiTextingStats.
    await callableRateLimit(request, 'getAiUsageAnalytics', 90, 3_600_000);

    const db = getFirestore();
    const now = Date.now();

    let snap;
    try {
      snap = await db.collection('api_usage')
        .where('timestamp', '>=', Timestamp.fromMillis(now - WINDOW_MS))
        .limit(READ_CAP)
        .get();
    } catch (e) {
      logger.error('[getAiUsageAnalytics] query failed', { err: e.message });
      throw new HttpsError('internal', 'Could not load usage analytics');
    }
    if (snap.size >= READ_CAP) {
      logger.warn('getAiUsageAnalytics.read_cap_hit', { cap: READ_CAP });
    }

    const rows = snap.docs.map((d) => {
      const r = d.data();
      const ts = r.timestamp && typeof r.timestamp.toMillis === 'function' ? r.timestamp.toMillis() : 0;
      const inputTokens = Number(r.inputTokens) || 0;
      const outputTokens = Number(r.outputTokens) || 0;
      return {
        ts,
        uid: r.uid || null,
        feature: r.feature || 'unspecified',
        model: r.model || 'unknown',
        inputTokens,
        outputTokens,
        cost: costUSD(r.model, inputTokens, outputTokens),
      };
    });

    const tokensOf = (r) => r.inputTokens + r.outputTokens;
    const lastHourRows = rows.filter((r) => r.ts >= now - 3_600_000);

    // 24 one-hour buckets, oldest first, ending at the current hour.
    const hourly = [];
    for (let i = 23; i >= 0; i--) {
      const bucketStart = now - i * 3_600_000;
      const hourStartMs = bucketStart - (bucketStart % 3_600_000);
      const requests = rows.filter((r) => r.ts >= hourStartMs && r.ts < hourStartMs + 3_600_000).length;
      hourly.push({ hour: new Date(bucketStart).getHours(), requests });
    }

    // Top 10 users by request count in the window.
    const byUid = new Map();
    for (const r of rows) {
      if (!r.uid) continue;
      const bucket = byUid.get(r.uid) || { requests: 0, tokens: 0, cost: 0 };
      bucket.requests++;
      bucket.tokens += tokensOf(r);
      bucket.cost += r.cost;
      byUid.set(r.uid, bucket);
    }
    const topUidEntries = [...byUid.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, 10);
    const topUsers = await Promise.all(topUidEntries.map(async ([theUid, stat]) => {
      let email = theUid;
      try {
        const u = await getAuth().getUser(theUid);
        email = u.email || theUid;
      } catch (_) { /* deleted/unknown user — fall back to the uid */ }
      return { email, requests: stat.requests, tokens: stat.tokens, cost: Math.round(stat.cost * 10000) / 10000 };
    }));

    // Feature breakdown across the window.
    const byFeature = {};
    for (const r of rows) {
      const f = byFeature[r.feature] || (byFeature[r.feature] = { requests: 0, tokens: 0, cost: 0 });
      f.requests++;
      f.tokens += tokensOf(r);
      f.cost += r.cost;
    }
    for (const key of Object.keys(byFeature)) {
      byFeature[key].cost = Math.round(byFeature[key].cost * 10000) / 10000;
    }

    const totalTokens = rows.reduce((s, r) => s + tokensOf(r), 0);
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);

    return {
      today: {
        requests: rows.length,
        tokens: totalTokens,
        cost: Math.round(totalCost * 10000) / 10000,
        errors: null, // claudeProxy never persists a failed call — not tracked, not fabricated
        rateLimits: null,
        lastHour: lastHourRows.length,
      },
      hourly,
      topUsers,
      features: byFeature,
      generatedAt: now,
    };
  }
);
