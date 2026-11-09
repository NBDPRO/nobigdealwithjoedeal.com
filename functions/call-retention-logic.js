'use strict';

const crypto = require('crypto');

/**
 * functions/call-retention-logic.js — pure decisions for the call retention
 * sweep (Call to Close P2, Q7, 2026-11-09). No firebase imports.
 *
 * Jo's answer to Q7 (CALL-TO-CLOSE-DESIGN-2026-11-09.md §11): briefs and
 * transcripts are kept 24 months, the CRM's copies of call audio 12 months,
 * and the Drive originals are never touched.
 *
 * Age math. "N months" is calendar months in America/New_York: on ET day
 * D, a record is past N months when its ET date is before D minus N months
 * (the day clamped to the end of a shorter month: Aug 31 minus 6 months is
 * Feb 28, or Feb 29 in a leap year). So a call on 2024-11-08 ET is first
 * eligible on 2026-11-09 ET; a call on 2024-11-09 ET one day later.
 *
 * Which date. A call's age counts from the LATER of its start time
 * (startedAtMs) and the time the CRM filed it (createdAtMs): a recording
 * imported late is kept from the day the CRM got its copy, never shorter.
 * A brief's age counts from generatedAtMs. A record with no usable date is
 * never eligible.
 *
 * Legal hold. A record is held (skipped, counted, never deleted) when:
 *   - the call has legalHold === true, or
 *   - its lead has legalHold === true, or
 *   - its lead has an open insurance claim (openClaim below). "Denied"
 *     counts as open, because a denied claim is the one most often disputed.
 *     Jo clears a claim hold by setting claimStatus to "Paid Out", and a
 *     legal hold by setting legalHold to false.
 *
 * Open claim. Any one of these, unless claimStatus is "Paid Out" (Jo's
 * explicit close, which also clears a stale stage or claim number):
 *   - claimStatus is set and is not "No Claim" ("in_progress" and other
 *     off-list values count as open);
 *   - claimStage maps through claim-core.js STAGE_TO_STATUS to anything but
 *     "No Claim" / "Paid Out", or is a stage the map does not know.
 *     insurance-claim.js writes claimStage with no claimStatus when ClaimCore
 *     is not loaded, and the lead modal saves "No Claim" by default, so a
 *     "No Claim" status does not clear an open stage;
 *   - the lead's pipeline stage is on the insurance track
 *     (ky-insurance-law.js INSURANCE_STAGES);
 *   - a claim number is on file.
 * A carrier alone is not a hold: intake records the homeowner's insurer
 * before any claim exists (ky-insurance-law.js counts it as a sign for the
 * claim panel, not as a filed claim).
 */

const TZ = 'America/New_York';
const POLICY = Object.freeze({ transcriptMonths: 24, audioMonths: 12, briefMonths: 24 });
const POLICY_VERSION = 1;

// The fields on a phone_calls doc that carry what was said: the transcript,
// its per-segment confidence index, and the AI notes made from it. The call
// doc itself (date, number, customer, duration, status) stays.
const TRANSCRIPT_FIELDS = Object.freeze(['transcript', 'segIndex', 'summary', 'promises', 'callerFacts', 'actionItems']);
const ARRAY_FIELDS = Object.freeze(['promises', 'actionItems']);

// Claim statuses that are NOT open (claim-core.js STATUS_VALUES).
const CLOSED_CLAIM = Object.freeze(['', 'no claim', 'paid out']);
// docs/pro/js/claim-core.js STAGE_TO_STATUS, copied (the browser file cannot
// be required here); tests/call-to-close-retention-2026-11-09.test.js pins it.
const STAGE_TO_STATUS = Object.freeze({
  initial_inspection: 'No Claim',
  documentation: 'No Claim',
  claim_filed: 'Claim Filed',
  adjuster_scheduled: 'Adjuster Scheduled',
  adjuster_visit: 'Adjuster Scheduled',
  estimate_review: 'Adjuster Scheduled',
  supplement_filed: 'Supplementing',
  approved: 'Approved',
  work_scheduled: 'Approved',
  completed: 'Paid Out',
  denied: 'Denied',
});
// functions/ky-insurance-law.js INSURANCE_STAGES (the insurance track's
// pipeline stages), pinned by the same test.
const INSURANCE_STAGES = Object.freeze(['claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done',
  'scope_received', 'supplement_requested', 'supplement_approved']);

const BRIEF_PATH = 'leads/{leadId}/call_briefs/{callId}';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function wall(ms) {
  const o = {};
  for (const p of PARTS.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second) };
}
// ET offset at an instant, in ms (EDT -4h, EST -5h).
function offsetMs(ms) {
  const w = wall(ms);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** 'YYYY-MM-DD' of an instant in ET. */
function etYmd(ms) {
  const w = wall(ms);
  return w.y + '-' + String(w.m).padStart(2, '0') + '-' + String(w.d).padStart(2, '0');
}

/** UTC ms of 00:00 ET on a 'YYYY-MM-DD' day (DST-correct). */
function etMidnightMs(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off1 = offsetMs(guess);
  let t = guess - off1;
  const off2 = offsetMs(t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/** 'YYYY-MM-DD' minus n calendar months, the day clamped to the month's end. */
function minusMonths(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const idx = y * 12 + (m - 1) - n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const nd = Math.min(d, daysIn(ny, nm));
  return ny + '-' + String(nm).padStart(2, '0') + '-' + String(nd).padStart(2, '0');
}

/** Records dated before this instant are past n months (00:00 ET of today minus n months). */
function cutoffMs(nowMs, months) {
  return etMidnightMs(minusMonths(etYmd(nowMs), months));
}

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** The instant a call's age counts from, or null (never eligible). */
function callAgeMs(call) {
  const c = call || {};
  const a = fin(c.startedAtMs), b = fin(c.createdAtMs);
  if (a == null && b == null) return null;
  return Math.max(a || 0, b || 0);
}
function briefAgeMs(brief) { return fin((brief || {}).generatedAtMs); }

function isPast(ageMs, cutoff) { return ageMs != null && Number.isFinite(cutoff) && ageMs < cutoff; }

const lc = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/** True when the lead shows an insurance claim still in flight (see the header). */
function openClaim(lead) {
  if (!lead) return false;
  const status = lc(lead.claimStatus);
  if (status === 'paid out') return false;
  if (!CLOSED_CLAIM.includes(status)) return true;
  const stage = lc(lead.claimStage);
  if (stage) {
    const mapped = lc(Object.prototype.hasOwnProperty.call(STAGE_TO_STATUS, stage) ? STAGE_TO_STATUS[stage] : 'unknown');
    if (!CLOSED_CLAIM.includes(mapped)) return true;
  }
  if (INSURANCE_STAGES.includes(lc(lead.stage))) return true;
  if (lc(lead.claimNumber)) return true;
  return false;
}

/** Why a record is held, or null. */
function holdReason({ call, lead } = {}) {
  if (call && call.legalHold === true) return 'call_legal_hold';
  if (lead && lead.legalHold === true) return 'lead_legal_hold';
  if (openClaim(lead)) return 'open_claim';
  return null;
}

const present = (v) => v != null && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'string' && !v.trim())
  && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/** The fields of a call that still carry what was said. */
function transcriptFieldsPresent(call) {
  const c = call || {};
  return TRANSCRIPT_FIELDS.filter((f) => present(c[f]));
}

/** The merge patch that strips a call's transcript + notes, or null when nothing is left to strip. */
function transcriptPatch(call, nowMs) {
  const fields = transcriptFieldsPresent(call);
  if (!fields.length) return null;
  const patch = {};
  for (const f of fields) patch[f] = ARRAY_FIELDS.includes(f) ? [] : null;
  patch.transcriptSaved = false;
  patch.retention = { transcriptStrippedAtMs: nowMs, v: POLICY_VERSION };
  return { patch, fields };
}

/**
 * True only for the CRM's own audio copy: calls/{the call's userId}/... with
 * no '..', no empty segment, no scheme. Never a Drive id or any other path.
 */
function isCrmAudioPath(p, call) {
  if (typeof p !== 'string' || !p) return false;
  if (!p.startsWith('calls/') || p.includes('..') || p.includes('//') || p.includes('\\') || /^[a-z]+:/i.test(p)) return false;
  const segs = p.split('/');
  if (segs.length < 3 || segs.some((s) => !s)) return false;
  const owner = call && call.userId;
  return typeof owner === 'string' && !!owner && segs[1] === owner;
}

/**
 * The merge patch after the CRM audio copy is deleted. A call still 'stored'
 * (never transcribed) becomes 'listed', the status call-center-logic gives a
 * call with no stored audio, so it leaves the transcribe queue and
 * pipeline-health's 'waiting' count instead of sitting there with nothing
 * to transcribe.
 */
function audioPatch(nowMs, call) {
  const patch = { storagePath: null, audioRemoved: 'retention', retention: { audioDeletedAtMs: nowMs, v: POLICY_VERSION } };
  if (call && call.status === 'stored') patch.status = 'listed';
  return patch;
}

/**
 * A fixed call_retention_log id for an audio deletion, so a retry rewrites the
 * same row instead of adding a second one. A new path (a re-copy after
 * "not personal") gets its own row.
 */
function auditId(kind, callId, storagePath) {
  return kind + '_' + callId + '_' + crypto.createHash('sha1').update(String(storagePath || '')).digest('hex').slice(0, 12);
}

/** One audit row. Ids and dates only: never a transcript, quote or summary. */
function auditEntry({ kind, callId, leadId, call, docPath, storagePath, fields, ageMs, cutoff, months, runId, nowMs }) {
  const c = call || {};
  return {
    kind, callId: callId || null, leadId: leadId || null,
    userId: c.userId || null, companyId: c.companyId || null,
    docPath: docPath || null, storagePath: storagePath || null,
    fields: Array.isArray(fields) ? fields.slice() : [],
    ageBasisMs: ageMs == null ? null : ageMs, cutoffMs: cutoff, policyMonths: months,
    driveFileId: c.driveFileId || null, // kept for the record: the Drive original is never touched
    runId, atMs: nowMs, v: POLICY_VERSION,
  };
}

// A full pass restarts every 30 days, so a record whose hold was lifted
// (or that failed once) is looked at again.
const RESCAN_MS = 30 * 24 * 3600 * 1000;
function shouldRescan(state, nowMs) {
  const s = state || {};
  const started = fin(s.passStartedAtMs);
  return started == null || nowMs - started >= RESCAN_MS;
}

module.exports = {
  TZ, POLICY, POLICY_VERSION, TRANSCRIPT_FIELDS, BRIEF_PATH, RESCAN_MS, STAGE_TO_STATUS, INSURANCE_STAGES,
  etYmd, etMidnightMs, minusMonths, cutoffMs, callAgeMs, briefAgeMs, isPast,
  holdReason, openClaim, transcriptFieldsPresent, transcriptPatch, isCrmAudioPath, audioPatch,
  auditId, auditEntry, shouldRescan,
};
