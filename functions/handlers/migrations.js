/**
 * functions/handlers/migrations.js — owner-callable migration jobs.
 *
 * Step 4c extraction. Moved verbatim from functions/index.js:
 *   - backfillAnalytics    (onCall, derives hour/day + geocoded fields)
 *   - migratePinsToKnocks  (onCall, one-time pins → knocks port)
 *
 * NOTE: this is distinct from functions/migrations/runner.js — the
 * runner there handles versioned admin migrations. These are owner-
 * facing one-shot tools.
 *
 * No behavioral changes; pure structural move.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');

const { enforceRateLimit } = require('../integrations/upstash-ratelimit');
const { assertNotViewer } = require('../shared');
const {
  CORS_ORIGINS,
  reverseGeocode,
  parseAddress,
} = require('./_shared');

const GOOGLE_GEOCODING_API_KEY = defineSecret('GOOGLE_GEOCODING_API_KEY');

// ═════════════════════════════════════════════════════════════
// backfillAnalytics — one-time enrichment of existing knocks + leads
//
// Derives analytics fields from the data that's already stored:
//   - hourOfDay, dayOfWeek (from timestamp) — for time-of-day heatmaps
//   - city, zip, state (via Google Geocoding if API key set + lat/lng)
//
// Scope: owner-only. Runs against the calling user's own docs. Never
// touches another user's data.
//
// Degraded mode: if GOOGLE_GEOCODING_API_KEY isn't set, the function
// still processes timestamp-based fields (hourOfDay, dayOfWeek) so
// the Rep Report Generator's heatmaps work. Reverse-geocoding is
// skipped with a warning in the response.
//
// Idempotent: re-running the function only enriches docs that are
// missing the fields. Existing enriched docs are skipped.
// ═════════════════════════════════════════════════════════════
exports.backfillAnalytics = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    secrets: [GOOGLE_GEOCODING_API_KEY],
    timeoutSeconds: 540, // 9 minutes — enough for ~5k docs
    memory: '256MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Not authenticated');
    // 2026-09-25 (decision B): a viewer is read-only. This rewrites fields
    // on every knock and lead the caller owns (and bills Google geocoding).
    assertNotViewer(request.auth.token);

    // Rate-limit: max 1 call per 10 minutes per user. Backfill is
    // expensive (hits Google Geocoding + writes to Firestore), so
    // we don't want someone spamming the button.
    try {
      await enforceRateLimit({
        key: 'backfill:' + uid,
        windowSec: 600,
        maxCalls: 1
      });
    } catch (e) {
      throw new HttpsError('resource-exhausted', 'Please wait 10 minutes between backfill runs.');
    }

    const geocodingKey = GOOGLE_GEOCODING_API_KEY.value();
    const hasGeocoding = !!(geocodingKey && geocodingKey.startsWith('AIza'));

    const summary = {
      knocksProcessed: 0,
      knocksEnriched: 0,
      knocksGeocoded: 0,
      leadsProcessed: 0,
      leadsEnriched: 0,
      leadsGeocoded: 0,
      geocodingEnabled: hasGeocoding,
      warnings: []
    };

    // ─ Knocks enrichment ─
    // Path: leads/{uid}/knocks/* (if the app stores knocks under user
    // subcollections) OR leads/{uid}/leads/{leadId}/knocks/*. We check
    // both paths. For safety this backfill only reads, writes, and
    // deletes from within the caller's uid namespace.
    const db = getFirestore();

    // Fetch knocks collection — assumes top-level 'knocks' with userId field
    const knocksSnap = await db.collection('knocks').where('userId', '==', uid).limit(5000).get();
    logger.info('backfillAnalytics: knocks fetched', { uid, count: knocksSnap.size });

    // Process in batches of 400 writes (Firestore batch limit is 500)
    const geocodeCache = new Map();
    let batch = db.batch();
    let batchCount = 0;

    for (const doc of knocksSnap.docs) {
      summary.knocksProcessed++;
      const data = doc.data();
      const updates = {};

      // Time-of-day fields
      const ts = data.timestamp || data.createdAt;
      let d = null;
      if (ts && typeof ts.toDate === 'function') d = ts.toDate();
      else if (ts && ts.seconds) d = new Date(ts.seconds * 1000);
      else if (ts) d = new Date(ts);

      if (d && !isNaN(d.getTime())) {
        if (data.hourOfDay == null) updates.hourOfDay = d.getHours();
        if (data.dayOfWeek == null) updates.dayOfWeek = d.getDay();
      }

      // Reverse geocode if we have lat/lng and missing city
      if (hasGeocoding && data.location && data.location.lat && data.location.lng && !data.city) {
        try {
          const key = data.location.lat.toFixed(3) + ',' + data.location.lng.toFixed(3);
          let geo = geocodeCache.get(key);
          if (!geo) {
            geo = await reverseGeocode(data.location.lat, data.location.lng, geocodingKey);
            geocodeCache.set(key, geo);
          }
          if (geo) {
            if (geo.city) updates.city = geo.city;
            if (geo.zip) updates.zip = geo.zip;
            if (geo.state) updates.state = geo.state;
            summary.knocksGeocoded++;
          }
        } catch (e) {
          summary.warnings.push('Geocoding failed for knock ' + doc.id + ': ' + e.message);
        }
      }

      if (Object.keys(updates).length > 0) {
        batch.update(doc.ref, updates);
        batchCount++;
        summary.knocksEnriched++;
        if (batchCount >= 400) {
          await batch.commit();
          batch = db.batch();
          batchCount = 0;
        }
      }
    }

    // ─ Leads enrichment ─
    // Top-level 'leads' collection with userId == uid. Parse address
    // text into city/zip if those fields are missing.
    const leadsSnap = await db.collection('leads').where('userId', '==', uid).limit(5000).get();
    logger.info('backfillAnalytics: leads fetched', { uid, count: leadsSnap.size });

    for (const doc of leadsSnap.docs) {
      summary.leadsProcessed++;
      const data = doc.data();
      const updates = {};

      // Parse city/zip from address string if missing
      if (data.address && !data.city) {
        const parsed = parseAddress(data.address);
        if (parsed.city) updates.city = parsed.city;
        if (parsed.zip) updates.zip = parsed.zip;
        if (parsed.state) updates.state = parsed.state;
      }

      // Stage transition: if a lead is won/lost and has no closedAt,
      // use updatedAt as a proxy so velocity calcs have a signal.
      const stage = (data.stage || '').toString().toLowerCase();
      if (['closed','install_complete','final_payment','complete','lost'].includes(stage) && !data.closedAt) {
        updates.closedAt = data.updatedAt || data.createdAt || FieldValue.serverTimestamp();
      }

      if (Object.keys(updates).length > 0) {
        batch.update(doc.ref, updates);
        batchCount++;
        summary.leadsEnriched++;
        if (updates.city) summary.leadsGeocoded++;
        if (batchCount >= 400) {
          await batch.commit();
          batch = db.batch();
          batchCount = 0;
        }
      }
    }

    // Final batch commit
    if (batchCount > 0) await batch.commit();

    if (!hasGeocoding) {
      summary.warnings.push('GOOGLE_GEOCODING_API_KEY not set — reverse geocoding skipped. Set the secret and re-run for full enrichment.');
    }

    logger.info('backfillAnalytics: done', { uid, ...summary });
    return summary;
  }
);

// ═════════════════════════════════════════════════════════════
// migratePinsToKnocks — one-time migration of the old 'pins'
// collection into 'knocks' so the Maps retirement is complete.
//
// Pin status → knock disposition mapping:
//   Signed       → appointment
//   Interested   → interested
//   Not Home     → not_home
//   Not Interested → not_interested
//   Callback     → interested  (closest match)
//   Do Not Knock → do_not_knock
//   Left Material → interested
//   Follow Up    → interested
//
// Scope: owner-only. Migrates only the calling user's pins.
// Idempotent: pins with migrated:true are skipped on re-runs.
// ═════════════════════════════════════════════════════════════
// migratePinsToKnocks was retired 2026-08-11 (dead-surface lane): the
// one-time pins→knocks migration completed; zero callers. Approved by
// Jo. Prod instance console-deleted — see WEEKLY_CADENCE.
