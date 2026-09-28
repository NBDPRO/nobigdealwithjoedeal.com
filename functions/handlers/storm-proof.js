/**
 * functions/handlers/storm-proof.js — idea #1 Phase 2
 * ═══════════════════════════════════════════════════════════════════
 *
 * `attachStormProof` — the server-verified, adjuster-grade counterpart to the
 * Phase-1 client bulk-attach (#1046). Given a lead, it resolves the property's
 * coordinates, looks up VERIFIED hail reports (NOAA/IEM or HailTrace) near the
 * address, and writes an IMMUTABLE proof record to
 * leads/{leadId}/storm_proofs/{proofId} — server-timestamped, server-derived,
 * client-read-only (firestore.rules: write:false). An adjuster claiming "there
 * wasn't a storm that day" is answered with a record the rep could not have
 * forged from the browser.
 *
 * This does NOT touch the Phase-1 client stormEvents[] path — that stays as the
 * informal, quick, zone-level attach. The two coexist: stormEvents[] is the
 * rep's working note; storm_proofs/{id} is the evidence.
 *
 * Access: the caller must own the lead (userId) or be same-company staff (or a
 * platform admin). App Check enforced, rate-limited.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { callableRateLimit, assertNotViewer } = require('../shared');
const { CORS_ORIGINS } = require('./_shared');
const { secretValue } = require('../integrations/_shared'); // the secret registry, not handlers/_shared
const { SECRETS } = require('../integrations/_shared');
const { lookupHail } = require('../integrations/hail');
const { buildStormProof } = require('../storm-proof-logic');
const { _googleForward } = require('./geocode');

// Forward-geocode fallback secret (same one resolveAddress uses). Declared here
// so a lead with an address but no lat/lng can still be verified.
const GOOGLE_GEOCODING_API_KEY = defineSecret('GOOGLE_GEOCODING_API_KEY');

exports.attachStormProof = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
    secrets: [SECRETS.HAILTRACE_API_KEY, SECRETS.SWATH_API_KEY, GOOGLE_GEOCODING_API_KEY],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B): a viewer is read-only. The access check below
    // admits ANY same-company member on ANY lead, and this writes an
    // immutable storm_proofs record plus a paid hail lookup — refused first.
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'attachStormProof', 60, 60 * 60_000);

    const claims = request.auth.token || {};
    const leadId = request.data && String(request.data.leadId || '').trim();
    if (!leadId) throw new HttpsError('invalid-argument', 'leadId required');
    const radiusMi = Math.min(50, Math.max(0.5, parseFloat(request.data && request.data.radiusMi) || 3));
    const daysBack = Math.min(730, Math.max(7, parseInt(request.data && request.data.daysBack, 10) || 365));

    const db = getFirestore();
    const leadRef = db.collection('leads').doc(leadId);
    const leadSnap = await leadRef.get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
    const lead = leadSnap.data() || {};

    // Access: owner of the lead, same-company staff, or platform admin.
    const myCompany = claims.companyId || uid;
    const canWrite = claims.role === 'admin'
      || lead.userId === uid
      || (lead.companyId && lead.companyId === myCompany);
    if (!canWrite) throw new HttpsError('permission-denied', 'Not your lead');

    // Resolve coordinates: the lead's own lat/lng first, else forward-geocode
    // the address (secret-gated; skipped when the geocoding key is unset).
    let lat = Number(lead.lat);
    let lng = Number(lead.lng);
    if (!isFinite(lat) || !isFinite(lng)) {
      const address = lead.address || '';
      let gKey;
      gKey = secretValue(GOOGLE_GEOCODING_API_KEY); // '__unset__' stub → null (it IS the stub in prod today)
      if (address && gKey && gKey.length > 8) {
        try {
          const g = await _googleForward(address, gKey);
          if (g && isFinite(g.lat) && isFinite(g.lng)) { lat = g.lat; lng = g.lng; }
        } catch (e) { logger.warn('[attachStormProof] geocode failed', { leadId, err: e && e.message }); }
      }
    }
    if (!isFinite(lat) || !isFinite(lng)) {
      throw new HttpsError('failed-precondition', 'This lead has no location — place it on the map or add an address first.');
    }

    // Server-verified hail lookup.
    let result;
    try {
      result = await lookupHail(lat, lng, radiusMi, daysBack);
    } catch (e) {
      logger.warn('[attachStormProof] hail lookup failed', { leadId, err: e && e.message });
      throw new HttpsError('unavailable', 'Storm data lookup failed — try again shortly.');
    }

    const proof = buildStormProof({
      leadId,
      userId: lead.userId || null,
      companyId: lead.companyId || myCompany,
      verifiedBy: uid,
      provider: result.provider,
      lat, lng, radiusMi, daysBack,
      hits: result.hits,
      address: lead.address || null,
    });

    const proofRef = await leadRef.collection('storm_proofs').add(
      Object.assign({}, proof, { verifiedAt: FieldValue.serverTimestamp() })
    );
    // Convenience stamp for the card UI (client-mutable; the immutable evidence
    // is the storm_proofs doc, not this field).
    await leadRef.set({
      lastStormProofAt: FieldValue.serverTimestamp(),
      lastStormProofVerified: proof.verified,
    }, { merge: true }).catch((e) => logger.warn('[attachStormProof] lead stamp failed', { leadId, err: e && e.message }));

    logger.info('[attachStormProof] proof written', { leadId, proofId: proofRef.id, verified: proof.verified, maxSizeInches: proof.maxSizeInches });
    return {
      proofId: proofRef.id,
      verified: proof.verified,
      maxSizeInches: proof.maxSizeInches,
      hitCount: proof.hitCount,
      provider: result.provider,
    };
  }
);
