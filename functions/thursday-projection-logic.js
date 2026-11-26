'use strict';

/**
 * functions/thursday-projection-logic.js — one call record (roadmap step 17
 * part C, audit 2026-11-22 §3.3), pure. No firebase imports.
 *
 * Two call pipelines never met: Thursday (Bland webhook → thursday_calls,
 * Opus extraction) and Cube ACR (Drive → phone_calls, Groq then Haiku notes).
 * Call Brief, the "you said you'd" sweep and the Calls screen read only
 * phone_calls, so a Thursday call never reached them. Now every FINISHED
 * Thursday call (status 'processed' or 'failed') is projected into ONE
 * phone_calls doc:
 *
 *   phone_calls/thursday_<blandCallId>   source 'thursday', written by the
 *     thursdayCallProcess trigger (integrations/thursday.js) on every write of
 *     its thursday_calls doc, with set(..., { merge: true }) of the fields
 *     buildProjection returns, so a reprocess or an inbox action rewrites the
 *     same doc and never touches what other writers put there (cubeCallId,
 *     mergedInto, handledAtMs, taskDone, a suggestion).
 *
 * What it carries: the fields phone_calls readers use (owner + company, start,
 * duration, number, the caller's name, the lead, status 'noted', the urgent
 * flag, a call type, the summary, the transcript Bland made, callNotes, who
 * filed it from the Thursday inbox). What it NEVER carries: the recording.
 * Thursday's audio stays at thursday_calls.recordingPath (owner-only Storage,
 * read through getThursdayRecording); the projection's storagePath is null.
 * The summary, notes and transcript are the stored text, not instructions:
 * every AI reader of phone_calls (Call Brief) already fences it.
 *
 * Not projected: a call still pending / processing / reprocess, and any call
 * held by a switch (only 'processed' and 'failed' are on the allowlist, so a
 * held status of any name stays out).
 *
 * One card, not two (linkPatches). Jo's cell forwards a busy or unanswered call
 * to Thursday, and Thursday can transfer a caller to Jo, so ONE phone call can
 * leave a Cube ACR row too. A Cube row and a Thursday call are the same call
 * when (cubeMatches):
 *   - both carry the same 10-digit caller number, the same owner (userId) and
 *     the same company;
 *   - the Cube row is not outbound (Jo calling back is a new call);
 *   - the Cube row starts inside [Thursday start - LINK_BEFORE_MS, Thursday
 *     end + LINK_AFTER_MS]. Before: the phone rings Jo first and forwards on
 *     no answer (a carrier no-answer timer is 15-30 s, set as high as 60 s),
 *     so Cube's missed-call row starts up to a minute before Thursday picks
 *     up, plus a few seconds of skew between the phone clock and Bland's.
 *     During: a transfer to Jo starts while Thursday is still on the line.
 *     After: skew only, so a short tail; a caller who redials minutes later
 *     is a second call.
 *   - neither is already linked to a different partner.
 * Several candidates: the one nearest the Thursday window wins, then the
 * earliest. The two docs then point at each other (cubeCallId on the
 * projection, thursdayCallId + thursdayProjectionId on the Cube row) and one
 * hides behind the other as a merge does (the hidden one mergedInto, the kept
 * one mergedFrom, so Call Brief reads both and the Calls screen can undo it).
 * Thursday's card is kept unless the Cube row plainly holds the longer
 * conversation (cubeHasConversation: a transcript, or a known duration longer
 * than Thursday's). A ring, a forward, a stub (listed / short / missed), a
 * personal row or a file whose length is not known yet hides behind
 * Thursday's call, so Thursday's intake is never folded away behind an empty
 * file. Decided once, at link time. Neither doc is deleted.
 *
 * Retention and labels (review 2026-11-25):
 *   - once call retention stripped the projection's transcript
 *     (retention.transcriptStrippedAtMs on it, or on the thursday_calls doc),
 *     a re-projection writes the text fields empty, so a later inbox action
 *     never puts the transcript back past 24 months;
 *   - a number labeled personal with capture off (contact-labels captureOff)
 *     is projected the way the Cube ingest files it: a 'personal' row with no
 *     transcript, summary or notes;
 *   - thursday_calls.reviewed is the call's Handled: a reviewed call carries
 *     handledAtMs (from reviewedBy.at, else processedAt, so a rerun writes the
 *     same value), an unreviewed one leaves handledAtMs to the Calls screen,
 *     whose Handled / Not handled also sets reviewed (call-center.js).
 */

const { phoneDigits10 } = require('./phone-utils');

const PROJECTION_PREFIX = 'thursday_';
const SOURCE = 'thursday';
const PROJECTABLE_STATUSES = Object.freeze(['processed', 'failed']);
const LINK_BEFORE_MS = 90 * 1000;
const LINK_AFTER_MS = 60 * 1000;
const TRANSCRIPT_MAX = 60000;
const SUMMARY_MAX = 600;
// The Cube rows that hold no conversation Jo had: a ring he missed.
const CUBE_STUB_STATUSES = Object.freeze(['listed', 'short', 'missed']);
// thursday-logic CALLER_TYPES → call-center-logic CALL_TYPES.
const CALL_TYPE = Object.freeze({
  new_lead: 'lead', existing_customer: 'customer', adjuster: 'insurance', supplier_sub: 'supplier',
  spam: 'spam', job_seeker: 'other', test: 'other', silent: 'other',
});
// The labels thursdayCallAction writes when a PERSON files a call from the
// Thursday inbox (create_lead / confirm_match / attach_to).
const INBOX_FILED_LABELS = Object.freeze(['New lead (from inbox)', 'Attached from inbox']);

const ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

function str(v, max) {
  const s = v == null ? '' : String(v);
  return max && s.length > max ? s.slice(0, max) : s;
}

/** ms from a Firestore Timestamp, a Date, an ISO string or a number; null when none. */
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v.toMillis === 'function') { const n = v.toMillis(); return Number.isFinite(n) && n > 0 ? n : null; }
  if (v instanceof Date) { const n = v.getTime(); return Number.isFinite(n) && n > 0 ? n : null; }
  if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((Number(v.nanoseconds) || 0) / 1e6);
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) && n > 0 ? n : null; }
  return null;
}

/** phone_calls/<id> for a Bland call id ('' when the id is unusable). */
function projectionId(blandCallId) {
  const id = str(blandCallId);
  return ID_RE.test(id) ? PROJECTION_PREFIX + id : '';
}

const isProjection = (row) => !!row && row.source === SOURCE;

/** May this thursday_calls doc be projected right now? */
function projectable(d) {
  return !!d && PROJECTABLE_STATUSES.includes(d.status) && !!projectionId(d.callId || (d.call && d.call.callId));
}

function startOf(d) {
  return toMs(d.startedAt) || toMs(d.call && d.call.startedAt) || toMs(d.createdAt) || null;
}

/**
 * The projection fields for a finished thursday_calls doc (docId: its id), or null.
 * Deterministic: the same doc always gives the same fields (no clock read),
 * so a reprocess rewrites the same values.
 */
function buildProjection(d, docId, opts) {
  if (!projectable(d)) return null;
  const o = opts || {};
  // No text: retention stripped it, or the number's capture is off.
  const noText = o.stripped === true || o.captureOff === true || !!(d.retention && d.retention.transcriptStrippedAtMs);
  const call = d.call || {};
  const ex = d.extraction && typeof d.extraction === 'object' ? d.extraction : null;
  const blandId = str(d.callId || call.callId);
  const startedAtMs = startOf(d);
  const route = d.route || {};
  const leadId = typeof d.leadId === 'string' && d.leadId && !d.leadId.includes('/') ? d.leadId : null;
  const filedBy = leadId && INBOX_FILED_LABELS.includes(route.label) && d.reviewedBy && typeof d.reviewedBy.uid === 'string' ? d.reviewedBy.uid : null;
  const callerType = ex ? str(ex.caller_type) : '';
  const transcript = noText ? '' : str(call.transcript, TRANSCRIPT_MAX);
  const out = {
    userId: str(d.userId || d.companyId),
    companyId: str(d.companyId || d.userId),
    source: SOURCE,
    thursdayCallId: blandId,
    thursdayDocId: str(docId || ''),
    startedAtMs,
    // Retention ages a call from the later of its start and createdAtMs; the
    // Thursday doc's own creation keeps it stable across reprocesses.
    createdAtMs: toMs(d.createdAt) || startedAtMs,
    durationSec: Number(d.durationSec || call.durationSec) || 0,
    direction: 'inbound',
    phoneDigits: phoneDigits10(d.fromDigits || call.from || d.from),
    contactName: str(d.callerName || (ex && ex.caller_name), 80),
    bucket: leadId ? 'customer' : (callerType === 'adjuster' ? 'insurance' : 'unknown'),
    leadId,
    alternateLeadIds: [],
    attachedBy: filedBy,
    status: o.captureOff === true ? 'personal' : 'noted',
    callType: CALL_TYPE[callerType] || 'other',
    urgent: d.urgent === true,
    summary: noText ? '' : str(d.issue || call.summary, SUMMARY_MAX),
    callNotes: noText || d.callNotes == null ? null : str(d.callNotes, 2000),
    transcript,
    transcriptSaved: !!transcript,
    storagePath: null,
    hasThursdayRecording: !!d.recordingPath,
    // Marked done for the Cube caller-facts re-read (call-center.js
    // reextractFacts), so no AI is spent on a call Thursday already read.
    factsV: require('./call-center-logic').FACTS_VERSION,
  };
  if (o.captureOff === true) out.labelCapture = 'off';
  // Reviewed in the Thursday inbox (or by Thursday itself on a log-only
  // route) = Handled here. Never written as null for a call no one has
  // reviewed: it keeps whatever the Calls screen set.
  if (d.reviewed === true) {
    out.handledAtMs = toMs(d.reviewedBy && d.reviewedBy.at) || toMs(d.processedAt) || startedAtMs || toMs(d.createdAt);
    out.handledBy = d.reviewedBy && typeof d.reviewedBy.uid === 'string' ? d.reviewedBy.uid : null;
  } else if (d.reviewed === false && d.reviewedBy && typeof d.reviewedBy.uid === 'string') {
    // Mark unreviewed (Thursday inbox, or Not handled on the Calls screen) reopens it.
    out.handledAtMs = null;
    out.handledBy = d.reviewedBy.uid;
  }
  return out;
}

/** True when two projections would write the same thing (skip the write). */
function sameProjection(a, b) {
  if (!a || !b) return a === b;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

// ── one card, not two ──────────────────────────────────────────────────────

function windowOf(projection) {
  const s = Number(projection && projection.startedAtMs) || 0;
  if (!s) return null;
  const end = s + Math.max(0, Number(projection.durationSec) || 0) * 1000;
  return { start: s, end, from: s - LINK_BEFORE_MS, to: end + LINK_AFTER_MS };
}

/** Distance (ms) from a Cube start to the Thursday call itself; 0 inside it. */
function distance(cube, projection) {
  const w = windowOf(projection);
  const c = Number(cube && cube.startedAtMs) || 0;
  if (!w || !c) return Infinity;
  return c < w.start ? w.start - c : (c > w.end ? c - w.end : 0);
}

/** Is this Cube ACR row the same phone call as this Thursday projection? */
function cubeMatches(cube, projection, projId) {
  if (!cube || !projection || isProjection(cube) || !isProjection(projection)) return false;
  if (cube.channel === 'text' || cube.direction === 'outbound') return false;
  const digits = phoneDigits10(cube.phoneDigits);
  if (digits.length !== 10 || digits !== phoneDigits10(projection.phoneDigits)) return false;
  if (!cube.userId || cube.userId !== projection.userId) return false;
  if ((cube.companyId || cube.userId) !== (projection.companyId || projection.userId)) return false;
  if (cube.thursdayProjectionId && cube.thursdayProjectionId !== projId) return false;
  // A Cube-to-Cube redial merge is never overwritten by a Thursday link.
  const partner = cube.mergedInto || cube.mergedFrom;
  if (partner && partner !== projId) return false;
  const w = windowOf(projection);
  const c = Number(cube.startedAtMs) || 0;
  return !!w && !!c && c >= w.from && c <= w.to;
}

/** The one Cube row (with .id) to link to this projection, or null. */
function pickCube(cubes, projection, projId) {
  if (projection && projection.cubeCallId) return null;
  const hits = (cubes || []).filter((c) => c && c.id && cubeMatches(c, projection, projId));
  hits.sort((a, b) => distance(a, projection) - distance(b, projection) || (a.startedAtMs - b.startedAtMs) || String(a.id).localeCompare(String(b.id)));
  return hits[0] || null;
}

/** The one projection (with .id) to link to this Cube row, or null. */
function pickProjection(projections, cube) {
  if (!cube || cube.thursdayProjectionId) return null;
  const hits = (projections || []).filter((p) => p && p.id && !p.cubeCallId && cubeMatches(cube, p, p.id));
  hits.sort((a, b) => distance(cube, a) - distance(cube, b) || (a.startedAtMs - b.startedAtMs) || String(a.id).localeCompare(String(b.id)));
  return hits[0] || null;
}

const isCubeStub = (cube) => CUBE_STUB_STATUSES.includes(cube && cube.status);

/**
 * Does this Cube row plainly hold more of the call than Thursday's? Only a
 * transcript, or a KNOWN duration longer than Thursday's, says so. A stub, a
 * personal row, or a file with no duration yet (no sidecar) does not.
 */
function cubeHasConversation(cube, projection) {
  if (!cube || isCubeStub(cube) || cube.status === 'personal') return false;
  if (str(cube.transcript).trim()) return true;
  if (cube.durationSec == null || cube.durationSec === '') return false;
  const sec = Number(cube.durationSec);
  return Number.isFinite(sec) && sec > (Number(projection && projection.durationSec) || 0);
}

/**
 * The two merge patches that link a Cube row and a projection (both with .id).
 * One hides behind the other like a merge (mergedInto on the hidden one,
 * mergedFrom on the kept one): Thursday's card stays unless the Cube row holds
 * the longer conversation.
 */
function linkPatches(cube, projection) {
  const cubePatch = { thursdayCallId: projection.thursdayCallId || null, thursdayProjectionId: projection.id };
  const projectionPatch = { cubeCallId: cube.id };
  const [kept, hidden] = cubeHasConversation(cube, projection) ? [cubePatch, projectionPatch] : [projectionPatch, cubePatch];
  Object.assign(kept, { mergedFrom: kept === cubePatch ? projection.id : cube.id, mergedInto: null });
  Object.assign(hidden, { mergedInto: hidden === cubePatch ? projection.id : cube.id, mergedFrom: null });
  return { cubePatch, projectionPatch };
}

const LINK_ID_RE = /^thursday_[A-Za-z0-9_-]{6,128}$/;
/** A thursday_<id> projection id (a merge / link partner a cube_ check misses). */
const isProjectionId = (id) => LINK_ID_RE.test(String(id || ''));

/**
 * The follow-up task a phone_calls row's sweep entry reads:
 * leads/{leadId}/tasks/<this>. Thursday files its task as thursday-<blandId>;
 * a Cube call as cube-<docId>; a day of texts as sms-<dayId>.
 */
function followUpTaskId(row) {
  const r = row || {};
  if (isProjection(r) && r.thursdayCallId) return 'thursday-' + r.thursdayCallId;
  return (r.channel === 'text' ? 'sms-' : 'cube-') + r.id;
}

/** The newest startedAtMs among docs that are NOT projections (Cube freshness); 0 when none. */
function newestCubeStartMs(rows) {
  let best = 0;
  for (const r of rows || []) {
    if (!r || isProjection(r)) continue;
    const ms = toMs(r.startedAtMs) || 0;
    if (ms > best) best = ms;
  }
  return best;
}

module.exports = {
  PROJECTION_PREFIX, SOURCE, PROJECTABLE_STATUSES, LINK_BEFORE_MS, LINK_AFTER_MS, CUBE_STUB_STATUSES, INBOX_FILED_LABELS,
  toMs, projectionId, isProjection, projectable, buildProjection, sameProjection,
  windowOf, cubeMatches, pickCube, pickProjection, isCubeStub, cubeHasConversation, linkPatches, isProjectionId, followUpTaskId, newestCubeStartMs,
};
