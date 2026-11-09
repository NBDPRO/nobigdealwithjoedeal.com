'use strict';

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
 *   - its lead has an open insurance claim: claimStatus is set and is not
 *     "No Claim" or "Paid Out". "Denied" counts as open, because a denied
 *     claim is the one most often disputed. Jo clears a hold by setting the
 *     claim to Paid Out / No Claim, or legalHold to false.
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

/** Why a record is held, or null. */
function holdReason({ call, lead } = {}) {
  if (call && call.legalHold === true) return 'call_legal_hold';
  if (lead && lead.legalHold === true) return 'lead_legal_hold';
  if (lead && lead.claimStatus != null) {
    const s = String(lead.claimStatus).trim().toLowerCase();
    if (!CLOSED_CLAIM.includes(s)) return 'open_claim';
  }
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

function audioPatch(nowMs) {
  return { storagePath: null, audioRemoved: 'retention', retention: { audioDeletedAtMs: nowMs, v: POLICY_VERSION } };
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
  TZ, POLICY, POLICY_VERSION, TRANSCRIPT_FIELDS, BRIEF_PATH, RESCAN_MS,
  etYmd, etMidnightMs, minusMonths, cutoffMs, callAgeMs, briefAgeMs, isPast,
  holdReason, transcriptFieldsPresent, transcriptPatch, isCrmAudioPath, audioPatch,
  auditEntry, shouldRescan,
};
