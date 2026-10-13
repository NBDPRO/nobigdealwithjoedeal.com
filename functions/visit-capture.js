'use strict';
/**
 * visit-capture.js - the server half of the in-person visit recorder (PR 2).
 *
 *   documentation/projects/VISIT-CAPTURE-PR2-2026-10-13.md
 *
 * PR 1 (docs/pro/js/visit-recorder*.js) records on the phone, uploads the audio
 * to Storage at audio/{uid}/_inbox/{visitId}.{ext} and writes
 * users/{uid}/visit_captures/{visitId} with the CLIENT's status. This file:
 *
 *   onVisitCaptureWrite   Firestore trigger on that doc. Verifies the object
 *                         EXISTS (the client's status is a claim, not proof),
 *                         transcribes (Groq, with a vocabulary prompt) and
 *                         SAVES THE TRANSCRIPT FIRST, then writes ranked
 *                         suggestions, then the notes (Claude). A provider
 *                         outage degrades to "transcript saved, notes pending"
 *                         with no strike.
 *   visitCaptureSweep     every 30 min: retries the states an outage left
 *                         behind (notes only; the transcript is never paid
 *                         for twice) and picks up docs whose trigger was lost.
 *   attachVisitCapture    callable: attach / detach / "not these" / retry
 *                         notes / a ten-minute audio link.
 *   retentionSweep        called by recordingRetentionCron: raw audio older
 *                         than the company's recordingRetentionDays goes.
 *
 * Server-owned fields on the doc (the client's rules allowlist never lists
 * them): pipelineStatus (+ pipelineNextAtMs, pipelineLeaseUntilMs,
 * pipelineNote), transcript, transcriptRaw, transcriptCorrections, notes,
 * suggestions, audioLive, firstSeenAtMs, finalizedKey. The client's own
 * `status` is the upload lifecycle and is only ever READ here. Every client
 * field the server acts on (leadId, audioPath, consentMode, uploadedAtMs,
 * durationSec) is re-validated here: the rules are not the only gate, and a
 * client-written time never decides how long audio is kept.
 *
 * Everything is idempotent: re-running any step writes the same docs, and the
 * trigger's own writes re-fire it into a no-op (nextStep decides from the doc).
 * Nothing in the pipeline throws out to Firebase (a throw would retry the
 * trigger and re-charge Groq), and nothing is retried forever: every retry
 * path has a cap or an age limit.
 */

const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const LG = require('./visit-capture-logic');
const L = require('./call-center-logic');
const { PIPELINE } = LG;

const VISITS = 'visit_captures';
const LEAD_CAP = 3000;

// ── dependencies (a seam: tests swap them; production resolves lazily) ───
let _deps = null;
function deps() {
  if (_deps) return _deps;
  const V = require('./integrations/voice-intelligence');
  return {
    transcribe: ({ buffer, ext, prompt }) => V.transcribeGroqBuffer({
      buffer, mimeType: ext === 'm4a' ? 'audio/mp4' : (ext === 'webm' ? 'audio/webm' : 'audio/' + ext),
      filename: 'visit.' + ext, timeoutMs: 480_000, feature: 'visit-transcribe', prompt,
    }),
    notes: (a) => require('./call-center').claudeNotes(a),
    checkConsent: (a) => V._checkVerbalConsent(a),
    checkBudget: (db, companyId, plan) => V._checkBudget(db, companyId, plan),
    recordUsage: (db, a) => V._incrementVoiceUsage(db, a),
    aiDisabled: async () => {
      const K = require('./integrations/killswitch');
      return (await K.isAiDisabled()) || (await K.isVoiceIntelDisabled());
    },
    signUrl: async (bucket, path) => {
      const [url] = await bucket.file(path).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 10 * 60 * 1000 });
      return url;
    },
    rateLimit: (uid) => require('./integrations/upstash-ratelimit').enforceRateLimit('callable:attachVisitCapture:uid', uid, 120, 60 * 60_000),
  };
}
function setDeps(d) { _deps = d; }
const getDeps = () => (_deps || deps());

// ── small helpers ───────────────────────────────────────────────────────
const msg = (e) => String((e && e.message) || e || '').slice(0, 300);
const extOf = (p) => String(p || '').split('.').pop().toLowerCase();
function uidFromPath(path) {
  const m = /^users\/([^/]+)\/visit_captures\/([^/]+)$/.exec(String(path || ''));
  return m ? { uid: m[1], visitId: m[2] } : null;
}
const visitRef = (db, uid, id) => db.doc('users/' + uid + '/' + VISITS + '/' + id);
const isGone = (e) => !!e && (e.code === 5 || /NOT_FOUND|No document to update/i.test(String(e.message || '')));
class GoneError extends Error { constructor() { super('visit doc is gone'); this.gone = true; } }

/**
 * Write server fields to a doc that must still EXIST. A merge-set would
 * resurrect a doc the person deleted mid-pass (transcript and all, with no
 * status, never swept); update() refuses.
 */
async function upd(ref, patch) {
  try { await ref.update(patch); } catch (e) { if (isGone(e)) throw new GoneError(); throw e; }
}

/** May `uid` (company `companyId`) file a recording on this lead? Same rule as Voice Intel. */
function mayRecordOn(lead, uid, companyId) {
  if (!lead) return false;
  if (lead.userId === uid) return true;
  return !!companyId && lead.companyId != null && lead.companyId === companyId;
}
/** Roles that may reach the company's customers (rules: company staff); every other non-viewer role: their OWN customers only. */
const STAFF_ROLES = ['', 'owner', 'company_admin', 'manager', 'admin'];

/**
 * The caller's tenant, read DIRECTLY (not through Voice Intel's
 * getCompanyContext, which swallows read errors and falls back to "your own
 * uid": a blip there would clear a legitimate attach). Throws on a failed
 * read, so the caller retries instead of deciding on a guess.
 */
async function contextFor(db, uid) {
  const u = await db.doc('users/' + uid).get();
  const companyId = (u.exists && u.data() && u.data().companyId) || uid;
  const sub = await db.doc('subscriptions/' + uid).get();
  const plan = (sub.exists && sub.data() && sub.data().plan) || 'lite';
  const co = await db.doc('companies/' + companyId).get();
  const cd = co.exists ? (co.data() || {}) : {};
  return {
    companyId, plan,
    // Unset = one_party for this feature (Ohio / Kentucky), exactly as the phone reads it.
    companyConsentMode: LG.CONSENT_MODES.indexOf(cd.recordingConsentMode) >= 0 ? cd.recordingConsentMode : 'one_party',
    retentionDays: LG.retentionDays(cd),
  };
}

async function tenantLeads(db, uid, companyId) {
  const byId = new Map();
  const take = (snap) => snap.forEach((d) => { if (byId.size < LEAD_CAP && !byId.has(d.id)) byId.set(d.id, Object.assign({ id: d.id }, d.data())); });
  take(await db.collection('leads').where('userId', '==', uid).get());
  if (companyId && companyId !== uid) take(await db.collection('leads').where('companyId', '==', companyId).get());
  return Array.from(byId.values());
}

async function appointmentsAround(db, uid, startedAtMs) {
  if (!startedAtMs) return [];
  const lo = new Date(startedAtMs - LG.APPT_WINDOW_MS - 5 * 60000);
  const hi = new Date(startedAtMs + LG.APPT_WINDOW_MS + 5 * 60000);
  const byId = new Map();
  for (const lane of ['repUid', 'userId']) {
    try {
      const snap = await db.collection('appointments').where(lane, '==', uid)
        .where('startTime', '>=', lo).where('startTime', '<=', hi).orderBy('startTime', 'asc').get();
      snap.forEach((d) => byId.set(d.id, Object.assign({ id: d.id }, d.data())));
    } catch (e) { logger.warn('visit_capture_appointments_failed', { lane, err: msg(e) }); }
  }
  return Array.from(byId.values());
}

const ms = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
};
const leadName = (l) => (String(l.name || l.customerName || '') || (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim()).trim();

/**
 * The Whisper hint's words. Deliberately small: these names leave the
 * building (Groq), so it is the customers in the room plus the 8 most recently
 * touched, not the whole book.
 */
function vocabularyFor({ leads, capture, appointments }) {
  const byId = new Map(leads.map((l) => [String(l.id), l]));
  const priority = [];
  if (capture.leadId && byId.has(String(capture.leadId))) priority.push(leadName(byId.get(String(capture.leadId))));
  (appointments || []).forEach((a) => { const l = a && a.leadId ? byId.get(String(a.leadId)) : null; if (l) priority.push(leadName(l)); });
  const recent = leads.filter((l) => l.deleted !== true && l.doNotRecord !== true)
    .sort((a, b) => (ms(b.updatedAt) || 0) - (ms(a.updatedAt) || 0)).slice(0, 8);
  const streets = []; const towns = [];
  recent.forEach((l) => {
    const segs = String(l.address || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (segs[0]) streets.push(segs[0].replace(/^\d+\s+/, ''));
    if (segs[1]) towns.push(segs[1]);
  });
  const names = recent.map(leadName);
  return { priorityNames: priority, names, streets: streets.slice(0, 4), towns: towns.slice(0, 3), nameList: priority.concat(names), streetList: streets };
}

async function deleteAudio(bucket, uid, id, path) {
  if (!path) return { ok: true, none: true };
  // Not the object the rules allow for THIS capture: not ours to delete, and nothing to retry.
  if (!LG.AUDIO_PATH_RE(uid, id).test(path)) return { ok: true, skipped: 'path_mismatch' };
  try { await bucket.file(path).delete({ ignoreNotFound: true }); return { ok: true }; }
  catch (e) { return { ok: false, why: msg(e) }; }
}

// ── the pipeline ────────────────────────────────────────────────────────
/**
 * One pass over one visit doc. Never throws. Returns a small summary the
 * trigger and the tests read: { step, state, ... }.
 */
async function runVisit({ db, bucket, uid, visitId, nowMs }) {
  const ref = visitRef(db, uid, visitId);
  try {
    const snap = await ref.get();
    if (!snap.exists) return { step: 'none', why: 'gone' };
    const d = snap.data() || {};
    const ns = LG.nextStep(d, nowMs);
    if (ns.step === 'none') return ns;
    if (ns.step === 'discard' || ns.step === 'purge') {
      const discarded = ns.step === 'discard' || d.status === 'discarded';
      return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: discarded ? 'discarded' : (d.skipReason || 'skipped'), final: discarded ? PIPELINE.DISCARDED : (d.purgeFinal || PIPELINE.SKIPPED) });
    }
    if (ns.step === 'finalize') return await doFinalize({ db, bucket, ref, uid, visitId, d, nowMs });
    if (ns.step === 'unfile') return await doUnfile({ db, ref, uid, visitId, d });
    // process: take the lease in a transaction so two invocations never both pay Groq
    const got = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const cur = s.data() || {};
      const again = LG.nextStep(cur, nowMs);
      if (again.step !== 'process') return null;
      tx.update(ref, { pipelineLeaseUntilMs: nowMs + LG.LEASE_MS });
      return { cur, stage: again.stage };
    });
    if (!got) return { step: 'none', why: 'lost the lease' };
    try {
      return await doProcess({ db, bucket, ref, uid, visitId, d: got.cur, stage: got.stage, nowMs });
    } finally {
      await ref.update({ pipelineLeaseUntilMs: 0 }).catch(() => {});
    }
  } catch (e) {
    if (e && e.gone) { logger.info('visit_capture_doc_gone', { uid, visitId }); return { step: 'gone' }; }
    logger.error('visit_capture_unhandled', { uid, visitId, err: msg(e) });
    // Count it: an internal error that repeats is given up on, not retried for ever.
    try {
      const cur = await ref.get();
      if (!cur.exists) return { step: 'gone' };
      const v = cur.data() || {};
      const n = (Number(v.internalErrors) || 0) + 1;
      const patch = { internalErrors: n, pipelineNote: 'internal_error', pipelineError: LG.errCode(e), pipelineNextAtMs: nowMs + 15 * 60000, pipelineLeaseUntilMs: 0 };
      if (n >= LG.INTERNAL_MAX) {
        patch.pipelineStatus = v.transcript ? PIPELINE.NOTES_FAILED : PIPELINE.FAILED;
        patch.pipelineNote = 'internal_error_gave_up';
        patch.pipelineNextAtMs = 0;
      }
      await ref.update(patch);
    } catch (_) { /* the doc is unreachable right now; the sweep tries again */ }
    return { step: 'error', error: msg(e) };
  }
}

/**
 * Delete the audio and everything derived from it; keep a tombstone saying
 * why. If the delete itself fails the doc goes to purge_pending (retried by
 * the sweep), never to a final state that still holds the audio.
 */
async function doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason, final }) {
  const del = await deleteAudio(bucket, uid, visitId, d.audioPath);
  const finalState = final || PIPELINE.SKIPPED;
  const patch = {
    transcript: null, transcriptRaw: null, transcriptSegments: null, transcriptCorrections: null,
    notes: null, suggestions: [], pipelineLeaseUntilMs: 0,
    skipReason: reason, purgeFinal: finalState,
    pipelineStatus: del.ok ? finalState : PIPELINE.PURGE_PENDING,
    pipelineNextAtMs: del.ok ? 0 : nowMs + 60 * 60000,
    audioLive: del.ok ? false : true,
    audioDeletedAtMs: del.ok ? nowMs : null,
  };
  if (!del.ok) patch.pipelineNote = 'audio_delete_failed';
  else patch.pipelineNote = null;
  await upd(ref, patch);
  // Anything this capture filed on a customer goes with it.
  if (d.attachedLeadId) await retract({ db, leadId: d.attachedLeadId, visitId, uid }).catch((e) => logger.warn('visit_capture_retract_failed', { visitId, err: msg(e) }));
  return { step: reason === 'discarded' ? 'discard' : 'purge', state: patch.pipelineStatus, audioDeleted: del.ok, reason };
}

async function doProcess({ db, bucket, ref, uid, visitId, d, stage, nowMs }) {
  const D = getDeps();
  const state = (patch) => upd(ref, Object.assign({ pipelineLeaseUntilMs: 0 }, patch));
  const hasTranscript = typeof d.transcript === 'string' && d.transcript.trim().length > 0;

  // 0. the audio path is the one the rules allow, or nothing is read
  if (!d.audioPath || !LG.AUDIO_PATH_RE(uid, visitId).test(d.audioPath)) {
    await state({ pipelineStatus: PIPELINE.FAILED, pipelineNote: 'bad_audio_path', pipelineNextAtMs: 0 });
    return { step: 'process', state: PIPELINE.FAILED, note: 'bad_audio_path' };
  }
  // Server-stamped first sight: retention and every age limit run from THIS, never from a client-written time.
  const firstSeen = Number(d.firstSeenAtMs) || nowMs;
  if (!(Number(d.firstSeenAtMs) > 0)) {
    await upd(ref, { firstSeenAtMs: nowMs, audioLive: true });
    d = Object.assign({}, d, { firstSeenAtMs: nowMs, audioLive: true });
  } else if (d.audioLive !== true && d.audioLive !== false) {
    await upd(ref, { audioLive: true });
  }

  // 0b. nothing is retried for ever
  if (nowMs - firstSeen > LG.GIVE_UP_MS) {
    const to = hasTranscript ? PIPELINE.NOTES_FAILED : PIPELINE.FAILED;
    await state({ pipelineStatus: to, pipelineNote: 'gave_up_after_14_days', pipelineNextAtMs: 0 });
    return { step: 'process', state: to, note: 'gave_up_after_14_days' };
  }

  // 1. the AI kill switch parks the work; nothing is spent
  try {
    if (await D.aiDisabled()) {
      await state({ pipelineStatus: d.pipelineStatus || PIPELINE.QUEUED, pipelineNote: 'ai_disabled', pipelineNextAtMs: nowMs + 30 * 60000 });
      return { step: 'process', state: d.pipelineStatus || PIPELINE.QUEUED, note: 'ai_disabled' };
    }
  } catch (_) { /* fail open, like every other caller */ }

  // 2. who is this for, and may we keep it at all? (read errors propagate: retry, never guess)
  const ctx = await contextFor(db, uid);
  let lead = null;
  if (d.leadId) {
    if (!LG.LEAD_ID_RE.test(String(d.leadId))) {
      // Not a lead id (a path with a slash would resolve to a different doc): never looked up.
      await upd(ref, { leadId: null, attachedAtMs: null, attachNote: 'lead_id_invalid' });
      d = Object.assign({}, d, { leadId: null });
    } else {
      const ls = await db.doc('leads/' + d.leadId).get();
      lead = ls.exists ? Object.assign({ id: ls.id }, ls.data()) : null;
      if (lead && !mayRecordOn(lead, uid, ctx.companyId)) {
        // The rules refuse this; refuse it here too. Unattached, not trusted.
        await upd(ref, { leadId: null, attachedAtMs: null, attachNote: 'lead_not_reachable' });
        d = Object.assign({}, d, { leadId: null });
        lead = null;
      }
    }
  }
  if (lead && lead.doNotRecord === true) {
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record' });
  }
  // Consent: the company's setting is the floor; the phone's claim can only raise it.
  const consent = LG.stricterConsent(d.consentMode, ctx.companyConsentMode);
  if (consent === 'two_party_attested' && !(Number(d.disclosureAckedAtMs) > 0)) {
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'no_disclosure_ack', final: PIPELINE.QUARANTINED });
  }

  // 3. the day's budget (company), before any vendor spend
  if (!hasTranscript) {
    try {
      const b = await D.checkBudget(db, ctx.companyId, ctx.plan);
      if (b && b.overBudget) {
        await state({ pipelineStatus: PIPELINE.TRANSCRIBE_PENDING, pipelineNote: 'over_budget', pipelineNextAtMs: nowMs + 60 * 60000 });
        return { step: 'process', state: PIPELINE.TRANSCRIBE_PENDING, note: 'over_budget' };
      }
    } catch (_) { /* budget read failed: do not block the customer's memo */ }
  }

  // 4. TRANSCRIBE (skipped when a previous pass already saved the transcript)
  let leads = null;
  let appointments = null;
  let transcriptText = hasTranscript ? d.transcript : '';
  let segments = Array.isArray(d.transcriptSegments) ? d.transcriptSegments : [];
  let durationSec = Number(d.transcriptDurationSec) || Number(d.durationSec) || 0;
  if (!hasTranscript) {
    const file = bucket.file(d.audioPath);
    let exists = false;
    try { [exists] = await file.exists(); } catch (e) {
      // Cannot tell: treat as "not yet", the sweep looks again. Never a strike.
      await state({ pipelineStatus: PIPELINE.WAITING_OBJECT, pipelineNote: 'storage_unreachable', pipelineNextAtMs: nowMs + 10 * 60000 });
      return { step: 'process', state: PIPELINE.WAITING_OBJECT, note: 'storage_unreachable' };
    }
    if (!exists) {
      if (nowMs - firstSeen > LG.OBJECT_WAIT_MS) {
        await state({ pipelineStatus: PIPELINE.FAILED, pipelineNote: 'object_missing', pipelineNextAtMs: 0 });
        return { step: 'process', state: PIPELINE.FAILED, note: 'object_missing' };
      }
      await state({ pipelineStatus: PIPELINE.WAITING_OBJECT, pipelineNote: 'object_missing', pipelineNextAtMs: nowMs + 10 * 60000, objectChecks: (Number(d.objectChecks) || 0) + 1 });
      return { step: 'process', state: PIPELINE.WAITING_OBJECT, note: 'object_missing' };
    }
    let size = 0;
    try { const [meta] = await file.getMetadata(); size = Number(meta && meta.size) || 0; } catch (_) { size = 0; }
    if (size <= 0) {
      await state({ pipelineStatus: PIPELINE.FAILED, pipelineNote: 'audio_empty', pipelineNextAtMs: 0, audioLive: true });
      return { step: 'process', state: PIPELINE.FAILED, note: 'audio_empty' };
    }
    if (size > L.GROQ_MAX_BYTES) {
      await state({ pipelineStatus: PIPELINE.FAILED, pipelineNote: 'too_large', pipelineNextAtMs: 0, audioLive: true });
      return { step: 'process', state: PIPELINE.FAILED, note: 'too_large' };
    }
    if ((Number(d.durationSec) || 0) > LG.MAX_DURATION_SEC) {
      await state({ pipelineStatus: PIPELINE.FAILED, pipelineNote: 'too_long', pipelineNextAtMs: 0, audioLive: true });
      return { step: 'process', state: PIPELINE.FAILED, note: 'too_long' };
    }
    leads = await tenantLeads(db, uid, ctx.companyId);
    appointments = await appointmentsAround(db, uid, Number(d.startedAtMs) || 0);
    const vocab = vocabularyFor({ leads, capture: d, appointments });
    const prompt = LG.buildVocabularyPrompt(vocab);
    // Reading the object is Storage's business, not the recording's: its own try, no strike.
    let buffer;
    try { [buffer] = await file.download(); } catch (e) {
      const fails = (Number(d.storageFails) || 0) + 1;
      const dead = fails >= 6;
      await state({
        pipelineStatus: dead ? PIPELINE.FAILED : PIPELINE.WAITING_OBJECT, pipelineNote: dead ? 'storage_read_failed' : 'storage_read_retry',
        pipelineError: LG.errCode(e), pipelineNextAtMs: dead ? 0 : nowMs + 10 * 60000, storageFails: fails,
      });
      logger.warn('visit_capture_download_failed', { visitId, fails, err: msg(e) });
      return { step: 'process', state: dead ? PIPELINE.FAILED : PIPELINE.WAITING_OBJECT, note: 'storage_read_failed' };
    }
    let t;
    try {
      t = await D.transcribe({ buffer, ext: extOf(d.audioPath), prompt });
    } catch (e) {
      const outage = LG.visitOutage(e);
      // One poisoned file can answer 5xx / time out for ever: after TRANSIENT_MAX in a row it is the file's fault.
      const transient = outage && outage.kind === 'overloaded' ? (Number(d.transientFails) || 0) + 1 : 0;
      if (outage && !(transient >= LG.TRANSIENT_MAX)) {
        // The account / provider is out, not this recording: no strike.
        await state({
          pipelineStatus: PIPELINE.TRANSCRIBE_PENDING, pipelineNote: 'provider_outage', pipelineNextAtMs: nowMs + LG.outageRetryMs(outage.kind),
          pipelineError: LG.errCode(e, outage), providerOutage: { provider: outage.provider, kind: outage.kind, atMs: nowMs },
          transientFails: transient, audioLive: true,
        });
        logger.warn('visit_capture_transcribe_outage', { visitId, kind: outage.kind, provider: outage.provider });
        return { step: 'process', state: PIPELINE.TRANSCRIBE_PENDING, outage: outage.kind };
      }
      const strikes = (Number(d.transcribeStrikes) || 0) + 1;
      const dead = strikes >= LG.MAX_TRANSCRIBE_STRIKES;
      await state({
        pipelineStatus: dead ? PIPELINE.FAILED : PIPELINE.TRANSCRIBE_PENDING, transcribeStrikes: strikes, pipelineError: LG.errCode(e),
        pipelineNote: dead ? 'transcribe_failed' : 'transcribe_retry', pipelineNextAtMs: dead ? 0 : nowMs + strikes * 15 * 60000, audioLive: true,
      });
      logger.warn('visit_capture_transcribe_failed', { visitId, strikes, err: msg(e) });
      return { step: 'process', state: dead ? PIPELINE.FAILED : PIPELINE.TRANSCRIBE_PENDING, strikes };
    }
    const raw = String((t && t.text) || '').trim();
    if (!raw) {
      await state({ pipelineStatus: PIPELINE.FAILED, pipelineNote: 'no_speech', pipelineNextAtMs: 0, audioLive: true });
      return { step: 'process', state: PIPELINE.FAILED, note: 'no_speech' };
    }
    const fixed = LG.correctTranscript(raw, { names: vocab.nameList, streets: vocab.streetList });
    transcriptText = fixed.text;
    durationSec = Number(t.durationSec) || Number(d.durationSec) || 0;
    segments = (Array.isArray(t.segments) ? t.segments : []).slice(0, 600).map((s) => ({ s: Math.round((s.start || 0) * 10) / 10, e: Math.round((s.end || 0) * 10) / 10, t: String(s.text || '').slice(0, 400) }));
    // SAVE THE TRANSCRIPT FIRST. Everything after this can fail and the
    // words are already safe on the doc. Groq was just paid for: one in-place
    // retry before the error handler counts it.
    const save = {
      transcript: fixed.text.slice(0, 120000), transcriptRaw: raw.slice(0, 120000), transcriptCorrections: fixed.corrections,
      transcriptSegments: segments, transcriptDurationSec: durationSec, transcribedAtMs: nowMs,
      pipelineStatus: PIPELINE.TRANSCRIBED, pipelineNote: null, pipelineError: null, pipelineNextAtMs: 0, pipelineLeaseUntilMs: nowMs + LG.LEASE_MS,
      transcribeStrikes: 0, transientFails: 0, objectChecks: 0, storageFails: 0, providerOutage: null, audioLive: true,
      audioBytes: size, audioMime: d.mime || null,
    };
    try { await state(save); } catch (e) { if (e && e.gone) throw e; await state(save); }
    try {
      await D.recordUsage(db, { uid, companyId: ctx.companyId, audioSec: Math.round(durationSec), analysisTokens: 0, costCents: 0 });
    } catch (e) { logger.warn('visit_capture_usage_failed', { visitId, err: msg(e) }); }
  }

  // 5. verbal consent: the opening must contain a yes
  if (consent === 'two_party_verbal' && !d.consentCheckedAtMs) {
    try {
      const c = await D.checkConsent({ transcript: transcriptText, segments: segments.map((s) => ({ start: s.s, end: s.e, text: s.t })) });
      if (!c || c.consented !== true) {
        return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'no_verbal_consent', final: PIPELINE.QUARANTINED });
      }
      await upd(ref, { consentCheckedAtMs: nowMs, consentEvidence: String(c.evidence || '').slice(0, 300) });
    } catch (e) {
      if (e && e.gone) throw e;
      const outage = LG.visitOutage(e);
      // Unverified consent fails CLOSED: nothing past the transcript runs until it is.
      await state({ pipelineStatus: PIPELINE.CONSENT_PENDING, pipelineNote: outage ? 'provider_outage' : 'consent_check_failed', pipelineError: LG.errCode(e, outage), pipelineNextAtMs: nowMs + (outage ? LG.outageRetryMs(outage.kind) : 15 * 60000) });
      return { step: 'process', state: PIPELINE.CONSENT_PENDING };
    }
  }

  // 6. RANKED SUGGESTIONS, from the transcript alone (so an AI outage still has chips)
  if (!leads) leads = await tenantLeads(db, uid, ctx.companyId);
  if (!appointments) appointments = await appointmentsAround(db, uid, Number(d.startedAtMs) || 0);
  const rank = (callerFacts) => LG.rankSuggestions({ capture: d, transcript: transcriptText, callerFacts, leads, appointments, nowMs });
  const r1 = rank(null);
  if (r1.dnrMatch) {
    // The person named is a do-not-record customer: do not keep their words.
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record_match' });
  }
  await upd(ref, { suggestions: r1.suggestions, suggestionsAtMs: nowMs, suggestionsRulesV: LG.SUGGEST_RULES_VERSION, pipelineLeaseUntilMs: nowMs + LG.LEASE_MS });

  // 7. NOTES (Claude). A retry re-runs only this step.
  const name = lead ? leadName(lead) : '';
  let notes;
  const notesPrompt = LG.buildVisitNotesPrompt({ capture: Object.assign({}, d, { durationSec }), transcript: transcriptText, leadName: name, nowMs });
  try {
    const raw = await D.notes({ system: LG.VISIT_NOTES_SYSTEM, prompt: notesPrompt, feature: 'visit-notes', maxTokens: 1500 });
    notes = LG.sanitizeVisitNotes(raw);
  } catch (e) {
    const outage = LG.visitOutage(e);
    const transient = outage && outage.kind === 'overloaded' ? (Number(d.transientFails) || 0) + 1 : 0;
    if (outage && !(transient >= LG.TRANSIENT_MAX)) {
      await state({
        pipelineStatus: PIPELINE.NOTES_PENDING, pipelineNote: 'provider_outage', pipelineError: LG.errCode(e, outage),
        pipelineNextAtMs: nowMs + LG.outageRetryMs(outage.kind), providerOutage: { provider: outage.provider, kind: outage.kind, atMs: nowMs },
        transientFails: transient,
      });
      logger.warn('visit_capture_notes_outage', { visitId, kind: outage.kind, provider: outage.provider });
      const out = { step: 'process', state: PIPELINE.NOTES_PENDING, outage: outage.kind };
      if (d.leadId) { const f = await doFinalize({ db, bucket, ref, uid, visitId, d: Object.assign({}, d, { pipelineStatus: PIPELINE.NOTES_PENDING, notes: null }), nowMs }); out.finalized = f.state; }
      return out;
    }
    const strikes = (Number(d.notesStrikes) || 0) + 1;
    const dead = strikes >= LG.MAX_NOTES_STRIKES;
    await state({
      pipelineStatus: dead ? PIPELINE.NOTES_FAILED : PIPELINE.NOTES_PENDING, notesStrikes: strikes, pipelineError: LG.errCode(e),
      pipelineNote: dead ? 'notes_failed' : 'notes_retry', pipelineNextAtMs: dead ? 0 : nowMs + strikes * 15 * 60000,
    });
    logger.warn('visit_capture_notes_failed', { visitId, strikes, err: msg(e) });
    const out = { step: 'process', state: dead ? PIPELINE.NOTES_FAILED : PIPELINE.NOTES_PENDING, strikes };
    if (dead && d.leadId) { const f = await doFinalize({ db, bucket, ref, uid, visitId, d: Object.assign({}, d, { pipelineStatus: PIPELINE.NOTES_FAILED, notes: null }), nowMs }); out.finalized = f.state; }
    return out;
  }
  // Claude spend counted against the company (tokens are an estimate from the text sent + the 1.5k cap).
  try {
    await D.recordUsage(db, { uid, companyId: ctx.companyId, audioSec: 0, analysisTokens: Math.round((notesPrompt.length + LG.VISIT_NOTES_SYSTEM.length) / 4) + 700, costCents: 0 });
  } catch (_) { /* best effort: the audio seconds are the budgeted quantity */ }
  if (notes.visitType === 'personal') {
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'personal' });
  }
  // the facts the model heard make the suggestions better (name + town, name + street)
  const r2 = rank(notes.callerFacts);
  if (r2.dnrMatch) return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record_match' });
  const dismissed = Array.isArray(d.rejectedLeadIds) ? d.rejectedLeadIds.map(String) : [];
  await state({
    notes, notesAtMs: nowMs, pipelineStatus: PIPELINE.READY, pipelineNote: null, pipelineError: null, pipelineNextAtMs: 0,
    notesStrikes: 0, transientFails: 0, providerOutage: null,
    suggestions: r2.suggestions.filter((s) => dismissed.indexOf(s.leadId) === -1), suggestionsAtMs: nowMs, suggestionsRulesV: LG.SUGGEST_RULES_VERSION,
  });
  const out = { step: 'process', state: PIPELINE.READY, visitType: notes.visitType };
  // Pre-attached by the client (started from the customer's page): file it now.
  if (d.leadId) {
    const f = await doFinalize({ db, bucket, ref, uid, visitId, d: Object.assign({}, d, { notes, pipelineStatus: PIPELINE.READY }), nowMs });
    out.finalized = f.state;
  }
  return out;
}

// ── attach: the timeline row + tasks ────────────────────────────────────
async function createIfAbsent(r, data) {
  try { await r.create(data); return true; } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false;
    throw e;
  }
}

/**
 * Write what attaching files on the customer: ONE activity row (rewritten
 * with each pass, so a later notes pass fills it in), and the tasks, each
 * created only when absent. Keyed by visitId, so it is a no-op the second time.
 * A different customer than last time retracts the old filing first.
 */
async function doFinalize({ db, bucket, ref, uid, visitId, d, nowMs }) {
  const refuse = async (note) => {
    await upd(ref, { leadId: null, attachedAtMs: null, attachNote: note });
    if (d.attachedLeadId) await retract({ db, leadId: d.attachedLeadId, visitId, uid }).catch(() => {});
    return { step: 'finalize', state: 'refused', note };
  };
  const leadId = String(d.leadId || '');
  if (!LG.LEAD_ID_RE.test(leadId)) return refuse('lead_id_invalid');
  const ctx = await contextFor(db, uid);
  const leadSnap = await db.doc('leads/' + leadId).get();
  const lead = leadSnap.exists ? Object.assign({ id: leadSnap.id }, leadSnap.data()) : null;
  if (!lead || lead.id !== leadId || lead.deleted === true || !mayRecordOn(lead, uid, ctx.companyId)) return refuse('attach_refused');
  if (lead.doNotRecord === true) {
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record' });
  }
  const actRef = db.doc('leads/' + lead.id + '/activity/visit-' + visitId);
  const had = await actRef.get();
  // A row with this id that is not ours (another person's capture with the same id): never overwritten.
  if (had.exists && (had.data() || {}).visitUid && (had.data() || {}).visitUid !== uid) return refuse('visit_id_conflict');
  if (d.attachedLeadId && d.attachedLeadId !== lead.id) await retract({ db, leadId: d.attachedLeadId, visitId, uid });
  const built = LG.buildAttachment({
    capture: d, notes: d.notes || null, visitId, leadId: lead.id, lead, uid,
    todayYmd: LG.etToday(nowMs), nowMs, audioKeptDays: d.audioLive === false ? 0 : ctx.retentionDays,
    notesFailed: d.pipelineStatus === PIPELINE.NOTES_FAILED,
  });
  await actRef.set(Object.assign({}, built.activity, { updatedAt: FieldValue.serverTimestamp() }, had.exists ? {} : { createdAt: FieldValue.serverTimestamp() }), { merge: true });
  let made = 0;
  for (const t of built.tasks) {
    const r = db.doc('leads/' + lead.id + '/tasks/' + t.id);
    const doc = Object.assign({}, t.doc, { createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    if (t.type === 'promise') doc.madeAt = FieldValue.serverTimestamp();
    if (await createIfAbsent(r, doc)) made++;
  }
  await upd(ref, {
    finalizedKey: LG.finalizeKey(Object.assign({}, d, { leadId: lead.id })), finalizedAtMs: nowMs, attachedLeadId: lead.id,
    attachedAtMs: Number(d.attachedAtMs) || nowMs, tasksMade: made, tasksSkipped: built.skipped.length || 0,
  });
  return { step: 'finalize', state: 'filed', tasksMade: made, tasks: built.tasks.length, skipped: built.skipped };
}

/** The customer was taken off (the phone wrote leadId null): take what was filed off too. */
async function doUnfile({ db, ref, uid, visitId, d }) {
  if (d.attachedLeadId) await retract({ db, leadId: d.attachedLeadId, visitId, uid });
  await upd(ref, { attachedLeadId: null, finalizedKey: null, finalizedAtMs: null });
  return { step: 'unfile', state: 'unfiled' };
}

/**
 * Undo a filing: the row, and the tasks that are still open. Only what THIS
 * person's capture made (visitUid), so another rep's capture that happens to
 * share a visit id is never touched. A task already ticked stays.
 */
async function retract({ db, leadId, visitId, uid }) {
  const actRef = db.doc('leads/' + leadId + '/activity/visit-' + visitId);
  const act = await actRef.get();
  if (act.exists && (act.data() || {}).visitUid === uid) await actRef.delete().catch(() => {});
  const snap = await db.collection('leads/' + leadId + '/tasks').where('visitId', '==', visitId).where('visitUid', '==', uid).get();
  const jobs = [];
  snap.forEach((t) => {
    const v = t.data() || {};
    if (v.done !== true) jobs.push(t.ref.delete());
  });
  await Promise.all(jobs);
  return { removedTasks: jobs.length };
}

// ── the callable ────────────────────────────────────────────────────────
async function attachAction({ db, bucket, auth, data, nowMs }) {
  const { HttpsError } = require('firebase-functions/v2/https');
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const token = auth.token || {};
  require('./shared').assertNotViewer(token);
  const role = String(token.role || '');
  const staff = STAFF_ROLES.indexOf(role) !== -1;
  const visitId = String((data && data.visitId) || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(visitId)) throw new HttpsError('invalid-argument', 'Bad visit id.');
  const action = String((data && data.action) || 'attach');
  if (['attach', 'detach', 'notThese', 'retryNotes', 'audioUrl'].indexOf(action) === -1) throw new HttpsError('invalid-argument', 'Unknown action.');
  const uid = auth.uid; // never from the client: a person acts on their OWN captures only
  try { await getDeps().rateLimit(uid); } catch (e) {
    if (e && /resource-exhausted/.test(String(e.code || ''))) throw e;
    // a limiter outage must not lock the person out of their own recordings
  }
  const ref = visitRef(db, uid, visitId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That recording is not on the server yet.');
  const d = snap.data() || {};
  if (d.status === 'discarded' || d.pipelineStatus === PIPELINE.DISCARDED) throw new HttpsError('failed-precondition', 'That recording was discarded.');

  if (action === 'audioUrl') {
    const gone = [PIPELINE.SKIPPED, PIPELINE.QUARANTINED, PIPELINE.PURGE_PENDING].indexOf(d.pipelineStatus) !== -1;
    if (gone || d.audioLive !== true || !d.audioPath || !LG.AUDIO_PATH_RE(uid, visitId).test(d.audioPath)) {
      throw new HttpsError('failed-precondition', 'The audio is no longer kept.');
    }
    const url = await getDeps().signUrl(bucket, d.audioPath);
    return { ok: true, url, expiresInSec: 600 };
  }
  if (action === 'notThese') {
    const ids = Array.from(new Set((Array.isArray(d.suggestions) ? d.suggestions : []).map((s) => s.leadId)
      .concat(Array.isArray(d.rejectedLeadIds) ? d.rejectedLeadIds : []))).slice(0, 30);
    await upd(ref, { rejectedLeadIds: ids, suggestions: [], suggestionsDismissedAtMs: nowMs });
    return { ok: true };
  }
  if (action === 'retryNotes') {
    if (!d.transcript) throw new HttpsError('failed-precondition', 'There is no transcript to read yet.');
    if (Number(d.pipelineLeaseUntilMs) > nowMs) throw new HttpsError('failed-precondition', 'It is being worked on right now.');
    if (nowMs - (Number(d.lastManualRetryAtMs) || 0) < LG.MANUAL_RETRY_COOLDOWN_MS) throw new HttpsError('resource-exhausted', 'Give it a couple of minutes between tries.');
    if ((Number(d.manualRetries) || 0) >= LG.MANUAL_RETRY_MAX) throw new HttpsError('resource-exhausted', 'That has been retried the most it will be. The transcript is saved.');
    await upd(ref, { pipelineStatus: PIPELINE.NOTES_PENDING, pipelineNextAtMs: 0, notesStrikes: 0, transientFails: 0, pipelineNote: 'manual_retry', lastManualRetryAtMs: nowMs, manualRetries: (Number(d.manualRetries) || 0) + 1 });
    const r = await runVisit({ db, bucket, uid, visitId, nowMs });
    return { ok: true, state: r.state || null };
  }
  const ctx = await contextFor(db, uid);
  if (action === 'detach') {
    if (d.attachedLeadId) await retract({ db, leadId: d.attachedLeadId, visitId, uid });
    await upd(ref, { leadId: null, attachedLeadId: null, attachedAtMs: null, finalizedKey: null, finalizedAtMs: null });
    return { ok: true, leadId: null };
  }
  // attach
  const leadId = String((data && data.leadId) || '');
  if (!LG.LEAD_ID_RE.test(leadId)) throw new HttpsError('invalid-argument', 'Pick a customer.');
  const ls = await db.doc('leads/' + leadId).get();
  const lead = ls.exists ? Object.assign({ id: ls.id }, ls.data()) : null;
  if (!lead || lead.deleted === true) throw new HttpsError('not-found', 'Customer not found.');
  // Company staff reach the company's customers; any other role only their own (the same split the rules make).
  const reachable = staff ? mayRecordOn(lead, uid, ctx.companyId) : lead.userId === uid;
  if (!reachable) throw new HttpsError('permission-denied', 'That customer is not yours to file under.');
  if (lead.doNotRecord === true) throw new HttpsError('failed-precondition', 'That customer is marked do not record.');
  const name = leadName(lead);
  if (d.attachedLeadId && d.attachedLeadId === leadId && d.finalizedKey === LG.finalizeKey(Object.assign({}, d, { leadId }))) {
    return { ok: true, already: true, leadId, leadName: name, state: d.pipelineStatus || null };
  }
  await upd(ref, { leadId, attachedAtMs: nowMs, attachedBy: 'user', finalizedKey: null });
  const cur = Object.assign({}, d, { leadId, attachedAtMs: nowMs, finalizedKey: null });
  let res = { state: 'waiting' };
  // Filed as soon as there is a transcript to file; before that the trigger files it when the pipeline gets there.
  const p = d.pipelineStatus || '';
  if (p === PIPELINE.READY || p === PIPELINE.NOTES_PENDING || p === PIPELINE.NOTES_FAILED || p === PIPELINE.TRANSCRIBED) {
    res = await doFinalize({ db, bucket, ref, uid, visitId, d: cur, nowMs });
    if (res.state === 'refused') throw new HttpsError('failed-precondition', 'That recording could not be filed there.');
  }
  return { ok: true, leadId, leadName: name, state: p || null, filed: res.state === 'filed', tasksMade: res.tasksMade || 0 };
}

// ── retention (called by recordingRetentionCron) ────────────────────────
/**
 * Raw audio older than the company's recordingRetentionDays (default 90, the
 * same rule the recordings cron applies to lead-bound audio) goes from
 * Storage. Transcript + notes stay (they are the useful part and live on
 * owner-only docs). Covers audio/{uid}/_inbox/* AND attached visit audio:
 * attach never moves the object. Age runs from the SERVER's first sight of the
 * object (firstSeenAtMs), never from a time the phone wrote.
 * A company whose settings cannot be read this run is skipped, not defaulted:
 * a guess here is a deletion.
 */
async function retentionSweep({ db, bucket, nowMs, maxPages }) {
  const out = { scanned: 0, deleted: 0, failed: 0, kept: 0, skipped: 0 };
  const minCutoff = nowMs - 7 * 86400000;
  const daysByUid = new Map();
  const daysFor = async (uid) => {
    if (daysByUid.has(uid)) return daysByUid.get(uid);
    let days = null;
    try { days = (await contextFor(db, uid)).retentionDays; } catch (e) { logger.warn('visit_capture_retention_ctx_failed', { uid, err: msg(e) }); }
    daysByUid.set(uid, days);
    return days;
  };
  let last = null;
  for (let page = 0; page < (maxPages || 30); page++) {
    let q = db.collectionGroup(VISITS).where('audioLive', '==', true).where('firstSeenAtMs', '<', minCutoff).orderBy('firstSeenAtMs').limit(100);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      out.scanned++;
      const who = uidFromPath(doc.ref.path);
      const v = doc.data() || {};
      if (!who) { out.kept++; continue; }
      const days = await daysFor(who.uid);
      if (days == null) { out.skipped++; continue; }
      // A capture that was skipped / quarantined / discarded and whose audio could not be
      // deleted then is overdue at once (the 7-day floor of the query is the only wait).
      const overdue = !!(v.skipReason || v.status === 'discarded');
      if (!overdue && !(Number(v.firstSeenAtMs) < nowMs - days * 86400000)) { out.kept++; continue; }
      const del = await deleteAudio(bucket, who.uid, who.visitId, v.audioPath);
      if (del.ok) {
        await doc.ref.update({ audioLive: false, audioDeletedAtMs: nowMs, audioDeletedBy: 'retention' }).catch((e) => logger.warn('visit_capture_retention_stamp_failed', { path: doc.ref.path, err: msg(e) }));
        out.deleted++;
      } else {
        out.failed++;
        logger.warn('visit_capture_retention_delete_failed', { path: doc.ref.path, why: del.why });
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 100) break;
  }
  return out;
}

// ── the sweep ───────────────────────────────────────────────────────────
async function sweep({ db, bucket, nowMs, budgetMs }) {
  const out = { picked: 0, ran: 0, outage: 0, errors: 0, lostTrigger: 0 };
  const t0 = Date.now();
  const rows = new Map();
  try {
    // Only what is DUE, oldest first: a backed-off doc never uses a slot, so a flood
    // of waiting docs cannot starve the ones that can run.
    const snap = await db.collectionGroup(VISITS).where('pipelineStatus', 'in', LG.RETRY_STATES)
      .where('pipelineNextAtMs', '<=', nowMs).orderBy('pipelineNextAtMs').limit(60).get();
    snap.forEach((d) => rows.set(d.ref.path, d));
  } catch (e) { logger.warn('visit_capture_sweep_retry_query_failed', { err: msg(e) }); out.errors++; }
  try {
    // A doc whose trigger never ran: uploaded in the last 48 h and untouched by the
    // pipeline. The window is bounded above so a far-future client time cannot sit in it.
    let last = null;
    for (let page = 0; page < 5; page++) {
      let q = db.collectionGroup(VISITS).where('status', '==', 'uploaded')
        .where('uploadedAtMs', '>', nowMs - 48 * 3600000).where('uploadedAtMs', '<', nowMs + 3600000)
        .orderBy('uploadedAtMs').limit(100);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      snap.forEach((d) => { const v = d.data() || {}; if (!v.pipelineStatus && !rows.has(d.ref.path)) { rows.set(d.ref.path, d); out.lostTrigger++; } });
      if (snap.size < 100) break;
      last = snap.docs[snap.docs.length - 1];
    }
  } catch (e) { logger.warn('visit_capture_sweep_lost_query_failed', { err: msg(e) }); out.errors++; }
  for (const doc of rows.values()) {
    if (Date.now() - t0 > (budgetMs || 480000)) break;
    out.picked++;
    const who = uidFromPath(doc.ref.path);
    if (!who) continue;
    const r = await runVisit({ db, bucket, uid: who.uid, visitId: who.visitId, nowMs });
    if (r.step === 'process') out.ran++;
    if (r.outage) out.outage++;
    if (r.step === 'error') out.errors++;
    // A credit / key outage is the same for every visit: stop spending the run on it.
    if (r.outage && (r.outage === 'credit' || r.outage === 'auth')) break;
  }
  return out;
}

// ── exports (registered in functions/index.js) ───────────────────────────
// Top-level `exports.NAME = onX(` on purpose: tests/cron-heartbeat.test.js and the
// function-map / viewer-callables sweeps find functions by that shape.
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for the scheduler
const { defineSecret } = require('firebase-functions/params');
const { SECRETS } = require('./integrations/_shared');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const FN_SECRETS = [SECRETS.GROQ_API_KEY, ANTHROPIC_API_KEY];

exports.onVisitCaptureWrite = onDocumentWritten(
  { document: 'users/{uid}/' + VISITS + '/{visitId}', region: 'us-central1', memory: '1GiB', timeoutSeconds: 540, concurrency: 1, maxInstances: 5, secrets: FN_SECRETS },
  async (event) => {
    try {
      const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
      const { uid, visitId } = event.params;
      const bucket = getStorage().bucket();
      if (!after) {
        // A deleted doc must not leave its audio behind.
        if (before && before.audioPath && before.audioLive !== false) {
          const del = await deleteAudio(bucket, uid, visitId, before.audioPath);
          if (del.ok) logger.info('visit_capture_doc_deleted', { visitId, audioDeleted: true });
          else logger.error('visit_capture_doc_deleted_audio_kept', { visitId, uid, path: before.audioPath, why: del.why });
        }
        return;
      }
      // Cheap exit for every write that has nothing to do (the pipeline's own writes).
      const ns = LG.nextStep(after, Date.now());
      if (ns.step === 'none') return;
      await runVisit({ db: getFirestore(), bucket, uid, visitId, nowMs: Date.now() });
    } catch (e) {
      // Never let Firebase retry this trigger: a retry re-charges Groq.
      logger.error('onVisitCaptureWrite: swallowed', { err: msg(e) });
    }
  }
);

exports.visitCaptureSweep = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '1GiB', secrets: FN_SECRETS },
  async () => {
    try {
      if (await getDeps().aiDisabled()) { logger.info('[visitCaptureSweep] AI kill switch on'); return; }
      const r = await sweep({ db: getFirestore(), bucket: getStorage().bucket(), nowMs: Date.now() });
      logger.info('[visitCaptureSweep]', r);
    } catch (e) { logger.warn('[visitCaptureSweep] failed', { err: msg(e) }); }
  }
);

exports.attachVisitCapture = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 120, maxInstances: 10, secrets: FN_SECRETS },
  (request) => attachAction({ db: getFirestore(), bucket: getStorage().bucket(), auth: request.auth, data: request.data, nowMs: Date.now() })
);

Object.assign(exports, {
  runVisit, attachAction, sweep, retentionSweep, retract,
  _setDeps: setDeps,
  _internal: { doProcess, doFinalize, doPurge, doUnfile, tenantLeads, appointmentsAround, vocabularyFor, mayRecordOn, uidFromPath, contextFor },
});
