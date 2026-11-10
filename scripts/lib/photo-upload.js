/**
 * scripts/lib/photo-upload.js
 *
 * Pure core of scripts/upload-job-photos.js. No I/O, no network. Pinned by
 * tests/upload-job-photos-2026-11-10.test.js.
 *
 * Builds the /photos doc in the shape docs/pro/js/photo-engine.js
 * (uploadPhotoToFirebase) writes, plus source 'photo-match'. The caller adds
 * createdAt / uploadedAt with the server clock.
 */
'use strict';

const crypto = require('crypto');

const PHASES = ['before', 'during', 'after'];
const ON_SITE_RADIUS_M = 150;

// Stable per (lead, source file): a rerun lands on the same id, never a second entry.
function photoIdFor(leadId, sourceKey) {
  return 'pm_' + crypto.createHash('sha1').update(String(leadId) + '|' + String(sourceKey)).digest('hex').slice(0, 20);
}

function buildPaths(uid, leadId, id) {
  return {
    photoPath: `photos/${uid}/${leadId}/${id}_standard.jpg`,
    thumbPath: `photos/${uid}/${leadId}/thumbs/${id}_thumb.jpg`
  };
}

function haversineM(a, b) {
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fin = (v) => typeof v === 'number' && isFinite(v);

function buildPhotoDoc(o) {
  const { id, leadId, uid, companyId, url, thumbUrl, takenAt, lat, lng, fileSize, lead } = o;
  const { photoPath, thumbPath } = buildPaths(uid, leadId, id);
  const phase = PHASES.includes(o.phase) ? o.phase : null;
  const taken = Date.parse(takenAt);
  const geo = fin(lat) && fin(lng) ? { lat, lng, accuracy: null, at: isFinite(taken) ? taken : null, source: 'exif' } : null;
  const hasLead = lead && fin(lead.lat) && fin(lead.lng);
  const doc = {
    id, leadId, userId: uid,
    ...(companyId ? { companyId } : {}),
    url, storagePath: photoPath, thumbStoragePath: thumbPath, thumbUrl,
    tags: [],
    phase,
    // 'stage' makes Photo Review ask the rep to confirm the phase, which is right:
    // this phase came from a date window, not from a person.
    phaseSource: phase ? 'stage' : null,
    description: '',
    location: '',
    quality: 'standard',
    width: 'auto',
    height: 'auto',
    fileSize: fin(fileSize) ? fileSize : 0,
    capturedAt: isFinite(taken) ? taken : Date.now(),
    capturedAtSource: isFinite(taken) ? 'exif' : 'device',
    reportSections: [],
    geoLocation: geo,
    onSite: geo && hasLead ? haversineM(geo, lead) <= ON_SITE_RADIUS_M : null,
    source: 'photo-match'
  };
  return doc;
}

// rows: [{ lead_id, source, jpeg, thumb, phase, taken_at, bytes }]
// opts: { leads: {leadId:{uid,companyId}}, company, fileExists(path), existingIds:Set }
function planUpload(rows, opts) {
  if (!opts || !opts.company) throw new Error('company is required');
  const skipped = { noLead: 0, otherCompany: 0, missingFile: 0, alreadyThere: 0 };
  const toUpload = [];
  const seen = new Set();
  for (const r of rows) {
    const lead = opts.leads[r.lead_id];
    if (!lead) { skipped.noLead++; continue; }
    if (lead.companyId !== opts.company) { skipped.otherCompany++; continue; }
    if (!opts.fileExists(r.jpeg) || !opts.fileExists(r.thumb)) { skipped.missingFile++; continue; }
    // The manifest may carry a display id (NBD-0367); paths and docs use the lead's real doc id.
    const leadId = lead.docId || r.lead_id;
    const id = photoIdFor(leadId, r.source);
    if (opts.existingIds.has(id) || seen.has(id)) { skipped.alreadyThere++; continue; }
    seen.add(id);
    toUpload.push({ id, leadId, uid: lead.uid, companyId: lead.companyId, row: r });
  }
  return { toUpload, skipped };
}

// Counts only, safe to print.
function summarizePlan(p) {
  return {
    toUpload: p.toUpload.length,
    jobs: new Set(p.toUpload.map((x) => x.leadId)).size,
    bytes: p.toUpload.reduce((a, x) => a + (Number(x.row.bytes) || 0), 0),
    skipped: p.skipped
  };
}

module.exports = { photoIdFor, buildPaths, buildPhotoDoc, planUpload, summarizePlan, PHASES };
