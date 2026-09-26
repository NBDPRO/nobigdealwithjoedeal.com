/**
 * billing.js — server-side usage tracking for plan limits.
 *
 * Closes the Audit A KNOWN GAP: firestore.rules locks
 * subscriptions/{uid} writes (`allow write: if false`) so the
 * client-side billing-gate.js used to silently 403 on every
 * trackUsage call. Local-session counters worked, but cross-
 * session / cross-device usage was lost. Reps could refresh and
 * "get" their lead allowance back.
 *
 * Now: trackUsage is a callable that atomically increments
 * subscriptions/{uid}.usage[feature] via the admin SDK and
 * returns the post-increment state plus the plan limit, so the
 * client can render an accurate "X of Y leads this month" gauge.
 *
 * Rate limit: 200/min/uid — generous enough that a rep logging
 * a busy day's leads never hits it, tight enough to block a
 * pathological loop.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');

const { callableRateLimit, assertNotViewer } = require('./shared');
// Owner check: claims-based (token.owner === true) with the deprecated
// email fallback, both inside isOwnerCaller. The email list itself lives
// ONLY in handlers/_shared.js (single server-side source — it exists to
// mint claims, not to authorize; the fallback goes away after owner
// claims are confirmed in prod).
const { isOwnerCaller } = require('./handlers/_shared');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// Mirrors PLANS in docs/pro/js/billing-gate.js. Server is the source
// of truth for caps. Update both when adding a new tier.
const PLAN_LIMITS = {
  free:         { leads: 10,        reports: 0,        aiCalls: 0,        reps: 1 },
  starter:      { leads: 50,        reports: 2,        aiCalls: 20,       reps: 1 },
  foundation:   { leads: 50,        reports: 2,        aiCalls: 20,       reps: 1 },
  // Team ($149/mo): the first multi-seat tier — owner + 2 reps. reps:2 (>1)
  // makes it seat-invitable AND makes the over-capacity seat-picker reachable
  // (a Growth→Team downgrade leaves more reps than seats).
  team:         { leads: 150,       reports: Infinity, aiCalls: 100,      reps: 2 },
  growth:       { leads: 500,       reports: Infinity, aiCalls: Infinity, reps: 5 },
  professional: { leads: 500,       reports: Infinity, aiCalls: Infinity, reps: 5 },
  enterprise:   { leads: Infinity,  reports: Infinity, aiCalls: Infinity, reps: Infinity },
};

const ALLOWED_FEATURES = new Set(['leads', 'reports', 'aiCalls']);

// Owner cap bypass is claims-based (token.owner === true) via
// isOwnerCaller — no local email list. The single server-side owner
// email list lives in handlers/_shared.js and only mints claims.

exports.trackUsage = onCall({
  region: 'us-central1',
  cors: CORS_ORIGINS,
  enforceAppCheck: true,
  timeoutSeconds: 10,
  memory: '256MiB',
  maxInstances: 50,
  concurrency: 80,
}, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  // 2026-09-25 (decision B): a viewer is read-only. This increments the
  // COMPANY's usage meter (subscriptions/{companyId}.usage), and a viewer
  // has no metered action to record — the client calls it after a lead
  // create, which the rules already refuse a viewer.
  assertNotViewer(request.auth.token);

  // Rate-limit per uid. 200/min handles bulk imports + busy days.
  await callableRateLimit(request, 'trackUsage', 200, 60_000);

  const feature = typeof request.data?.feature === 'string' ? request.data.feature : null;
  if (!feature || !ALLOWED_FEATURES.has(feature)) {
    throw new HttpsError('invalid-argument', 'feature must be one of: leads, reports, aiCalls');
  }

  const db = getFirestore();
  // Pillar 4: usage pools on the COMPANY subscription (doc keyed by owner
  // uid == the companyId claim team members carry) so five reps share one
  // Growth allowance instead of each getting a phantom free-tier meter.
  // Solo owners: companyId == uid — byte-identical to the old behavior.
  const claimCompany = request.auth.token && request.auth.token.companyId;
  const billingKey = (typeof claimCompany === 'string' && claimCompany) ? claimCompany : uid;
  const subRef = db.doc(`subscriptions/${billingKey}`);

  // Atomically increment + read back. Transaction so concurrent
  // increments (e.g. bulk-import 50 leads in parallel) tally correctly.
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(subRef);
    const data = snap.exists ? snap.data() : {};
    let plan = data.plan || 'free';
    // Access-code trial expiry — enforced at READ time (2026-07-05 product
    // decision). validateAccessCode writes trialEndsAt when a code carries
    // trialDays, but nothing ever downgraded the plan afterward — a
    // "14-day trial" code granted its tier forever. A code-granted sub past
    // its trialEndsAt now meters as free. Stripe-billed subs are untouched
    // (Stripe owns their lifecycle); code grants WITHOUT trialDays remain
    // indefinite comps.
    if (
      data.source === 'access_code'
      && data.trialEndsAt
      && typeof data.trialEndsAt.toMillis === 'function'
      && data.trialEndsAt.toMillis() < Date.now()
    ) {
      plan = 'free';
    }
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const cap = limits[feature];

    // Month rollover. Paid tenants get their counters reset by the Stripe
    // invoice.paid webhook, but FREE tenants have no invoices — without
    // this, "10 leads/month" was 10 leads EVER once metering went live
    // (gauntlet batch 2). cycleStart is an ISO string (webhook convention);
    // when its calendar month differs from now, start a fresh cycle.
    const nowMonth = new Date().toISOString().slice(0, 7);
    const cycleMonth = (data.usage && typeof data.usage.cycleStart === 'string')
      ? data.usage.cycleStart.slice(0, 7)
      : null;
    const rolled = cycleMonth !== null && cycleMonth !== nowMonth;
    const baseUsage = rolled ? {} : (data.usage || {});

    const prevUsage = (!rolled && data.usage && typeof data.usage[feature] === 'number')
      ? data.usage[feature]
      : 0;
    const nextUsage = prevUsage + 1;

    // Server-side cap check. Owner accounts bypass entirely — keyed on
    // the { owner: true } custom claim (minted by mintOwnerClaims);
    // isOwnerCaller keeps the deprecated email fallback during the
    // rollout (remove after owner claims are confirmed in prod).
    const isOwner = isOwnerCaller(request.auth.token);
    const isAdmin = request.auth.token && request.auth.token.role === 'admin';
    const overage = !isOwner && !isAdmin && cap !== Infinity && nextUsage > cap;

    // Even on overage, increment. The product decision is "soft gate" —
    // the UI shows an upgrade modal but the action still proceeds. We
    // still want the meter to read accurately so dunning / nudges can
    // fire on real usage.
    // merge:true merges MAP FIELDS individually, so a bare {...baseUsage}
    // would leave last month's other counters in place on rollover —
    // zero every metered feature explicitly when the cycle resets.
    const resetZeros = rolled
      ? Object.fromEntries([...ALLOWED_FEATURES].map((f) => [f, 0]))
      : {};
    tx.set(subRef, {
      usage: {
        ...baseUsage,
        ...resetZeros,
        cycleStart: (rolled || !cycleMonth) ? new Date().toISOString() : data.usage.cycleStart,
        [feature]: nextUsage,
      },
      lastUsageAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      feature,
      plan,
      usage: nextUsage,
      limit: cap === Infinity ? null : cap,
      overage,
    };
  });

  logger.info('trackUsage.ok', { uid, feature: result.feature, usage: result.usage, plan: result.plan, overage: result.overage });
  return result;
});

// Test-only export for unit checks.
exports._test = { PLAN_LIMITS, ALLOWED_FEATURES };
