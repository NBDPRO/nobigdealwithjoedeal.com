/**
 * storm-proof-logic.js — pure decision logic behind the attachStormProof
 * callable (idea #1 Phase 2). Dependency-free (no firebase) so tests can
 * require() it and the handler shares the exact same code path.
 *
 * Phase 1 (#1046) let a rep bulk-attach a client-written stormEvents[] entry
 * onto every lead in a Storm Center zone — informal, client-clock, forgeable.
 * Phase 2 produces an ADJUSTER-GRADE record: the server looks up verified hail
 * reports (NOAA/IEM or HailTrace) near the lead's address, stamps a
 * server-timestamped proof, and writes it to an immutable subcollection. This
 * module turns the raw hail hits into that proof record + the verified verdict.
 */
'use strict';

// NWS severe-hail threshold (inches). storm-watch.js uses the same 0.75" floor
// for its alerting — a proof "verifies" only when a report at/above this landed
// in the window. Below it, the lookup ran but the proof is advisory (hitCount
// reported, verified=false) — never claim damage the data doesn't support.
const HAIL_VERIFY_THRESHOLD_INCHES = 0.75;

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

// The single strongest hail report in the set (largest finite sizeInches), or
// null when there are none. This is the headline evidence on the proof.
function strongestHit(hits) {
  if (!Array.isArray(hits)) return null;
  let best = null;
  hits.forEach((h) => {
    if (!h) return;
    const s = Number(h.sizeInches);
    if (!isFinite(s)) return;
    if (!best || s > Number(best.sizeInches)) best = h;
  });
  return best;
}

function maxSize(hits) {
  return (Array.isArray(hits) ? hits : []).reduce((m, h) => {
    const s = Number(h && h.sizeInches);
    return isFinite(s) && s > m ? s : m;
  }, 0);
}

// Build the immutable proof record (caller adds verifiedAt serverTimestamp).
// Carries userId + companyId so the frozen-subcollection read rule can gate it
// (mirrors the recordings rule: owner OR same-company manager). Never throws;
// degrades to verified:false with an empty strongestHit.
// Optional measured wind (2026-10-06): the nearest ASOS station's strongest
// gust on the strongest hit's local date (integrations/asos-gust.js). Context
// only — it NEVER changes `verified`, which stays the hail rule above.
function windBlock(wind) {
  if (!wind || !wind.line) return null;
  const mph = num(wind.gustMph);
  if (mph === null || mph <= 0) return null;
  return {
    stationId: String(wind.stationId || '').slice(0, 8) || null,
    stationName: String(wind.stationName || '').slice(0, 80) || null,
    distanceMi: num(wind.distanceMi),
    gustMph: mph,
    date: String(wind.date || '').slice(0, 10) || null,
    line: String(wind.line).slice(0, 300),
    source: 'NOAA/NWS ASOS via IEM',
  };
}

function buildStormProof({ leadId, userId, companyId, verifiedBy, provider, lat, lng, radiusMi, daysBack, hits, address, wind }) {
  const strongest = strongestHit(hits);
  const max = maxSize(hits);
  return {
    leadId: leadId || null,
    userId: userId || null,
    companyId: companyId || null,
    verifiedBy: verifiedBy || null,
    provider: provider || 'noaa',
    lat: num(lat),
    lng: num(lng),
    radiusMi: num(radiusMi),
    daysBack: num(daysBack),
    address: address ? String(address).slice(0, 300) : null,
    hitCount: Array.isArray(hits) ? hits.length : 0,
    maxSizeInches: max,
    verified: max >= HAIL_VERIFY_THRESHOLD_INCHES,
    strongestHit: strongest ? {
      at: strongest.at || null,
      sizeInches: num(strongest.sizeInches),
      lat: num(strongest.lat),
      lng: num(strongest.lng),
      source: strongest.source || null,
    } : null,
    wind: windBlock(wind),
  };
}

module.exports = { HAIL_VERIFY_THRESHOLD_INCHES, strongestHit, maxSize, buildStormProof, windBlock };
