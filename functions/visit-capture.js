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
 * suggestions, audioLive, finalizedKey. The client's own `status` is the upload
 * lifecycle and is only ever READ here.
 *
 * Everything is idempotent: re-running any step writes the same docs, and the
 * trigger's own writes re-fire it into a no-op (nextStep decides from the doc).
 * Nothing in the pipeline throws out to Firebase (a throw would retry the
 * trigger and re-charge Groq).
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
    companyContext: (db, uid) => V._getCompanyContext(db, uid),
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

/** May `uid` (company `companyId`) file a recording on this lead? Same rule as Voice Intel. */
function mayRecordOn(lead, uid, companyId) {
  if (!lead) return false;
  if (lead.userId === uid) return true;
  return !!companyId && lead.companyId != null && lead.companyId === companyId;
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

function vocabularyFor({ leads, capture, appointments }) {
  const byId = new Map(leads.map((l) => [String(l.id), l]));
  const name = (l) => (String(l.name || l.customerName || '') || (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim()).trim();
  const priority = [];
  if (capture.leadId && byId.has(String(capture.leadId))) priority.push(name(byId.get(String(capture.leadId))));
  (appointments || []).forEach((a) => { const l = a && a.leadId ? byId.get(String(a.leadId)) : null; if (l) priority.push(name(l)); });
  const recent = leads.filter((l) => l.deleted !== true)
    .sort((a, b) => (LG_ms(b.updatedAt) || 0) - (LG_ms(a.updatedAt) || 0)).slice(0, 25);
  const streets = []; const towns = [];
  recent.forEach((l) => {
    const segs = String(l.address || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (segs[0]) streets.push(segs[0].replace(/^\d+\s+/, ''));
    if (segs[1]) towns.push(segs[1]);
  });
  const names = recent.map(name);
  return { priorityNames: priority, names, streets, towns, nameList: priority.concat(names), streetList: streets };
}
function LG_ms(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
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
    if (ns.step === 'discard' || ns.step === 'purge') return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: ns.step === 'discard' ? 'discarded' : (d.skipReason || 'skipped') });
    if (ns.step === 'finalize') return await doFinalize({ db, bucket, ref, uid, visitId, d, nowMs });
    // process: take the lease in a transaction so two invocations never both pay Groq
    const got = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const cur = s.data() || {};
      const again = LG.nextStep(cur, nowMs);
      if (again.step !== 'process') return null;
      tx.set(ref, { pipelineLeaseUntilMs: nowMs + LG.LEASE_MS }, { merge: true });
      return { cur, stage: again.stage };
    });
    if (!got) return { step: 'none', why: 'lost the lease' };
    try {
      return await doProcess({ db, bucket, ref, uid, visitId, d: got.cur, stage: got.stage, nowMs });
    } finally {
      await ref.set({ pipelineLeaseUntilMs: 0 }, { merge: true }).catch(() => {});
    }
  } catch (e) {
    logger.error('visit_capture_unhandled', { uid, visitId, err: msg(e) });
    try { await ref.set({ pipelineNote: 'internal_error', pipelineError: msg(e), pipelineNextAtMs: nowMs + 15 * 60000, pipelineLeaseUntilMs: 0 }, { merge: true }); } catch (_) {}
    return { step: 'error', error: msg(e) };
  }
}

/** Delete the audio and everything derived from it; keep a tombstone saying why. */
async function doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason, final }) {
  const del = await deleteAudio(bucket, uid, visitId, d.audioPath);
  const discarded = reason === 'discarded';
  const patch = {
    pipelineNextAtMs: del.ok ? 0 : nowMs + 60 * 60000,
    transcript: null, transcriptRaw: null, transcriptSegments: null, transcriptCorrections: null,
    notes: null, suggestions: [], pipelineLeaseUntilMs: 0,
    pipelineStatus: discarded ? PIPELINE.DISCARDED : (final || PIPELINE.SKIPPED),
    skipReason: discarded ? 'discarded' : reason,
    audioLive: del.ok ? false : true,
    audioDeletedAtMs: del.ok ? nowMs : null,
  };
  if (!del.ok) patch.pipelineNote = 'audio_delete_failed: ' + del.why;
  await ref.set(patch, { merge: true });
  // Anything this capture filed on a customer goes with it.
  if (d.attachedLeadId) await retract({ db, leadId: d.attachedLeadId, visitId }).catch((e) => logger.warn('visit_capture_retract_failed', { visitId, err: msg(e) }));
  return { step: discarded ? 'discard' : 'purge', state: patch.pipelineStatus, audioDeleted: del.ok, reason: patch.skipReason };
}

async function doProcess({ db, bucket, ref, uid, visitId, d, stage, nowMs }) {
  const D = getDeps();
  const state = (patch) => ref.set(Object.assign({ pipelineLeaseUntilMs: 0 }, patch), { merge: true });
  const hasTranscript = typeof d.transcript === 'string' && d.transcript.trim().length > 0;

  // 0. the audio path is the one the rules allow, or nothing is read
  if (!d.audioPath || !LG.AUDIO_PATH_RE(uid, visitId).test(d.audioPath)) {
    await state({ pipelineStatus: PIPELINE.FAILED, pipelineNote: 'bad_audio_path', pipelineNextAtMs: 0 });
    return { step: 'process', state: PIPELINE.FAILED, note: 'bad_audio_path' };
  }

  // 1. the AI kill switch parks the work; nothing is spent
  try {
    if (await D.aiDisabled()) {
      await state({ pipelineStatus: d.pipelineStatus || PIPELINE.QUEUED, pipelineNote: 'ai_disabled', pipelineNextAtMs: nowMs + 30 * 60000 });
      return { step: 'process', state: d.pipelineStatus || PIPELINE.QUEUED, note: 'ai_disabled' };
    }
  } catch (_) { /* fail open, like every other caller */ }

  // 2. who is this for, and may we keep it at all?
  const ctx = await D.companyContext(db, uid);
  let lead = null;
  if (d.leadId) {
    const ls = await db.doc('leads/' + d.leadId).get();
    lead = ls.exists ? Object.assign({ id: ls.id }, ls.data()) : null;
    if (lead && !mayRecordOn(lead, uid, ctx.companyId)) {
      // The rules refuse this; refuse it here too. Unattached, not trusted.
      await ref.set({ leadId: null, attachedAtMs: null, pipelineNote: 'lead_not_reachable' }, { merge: true });
      d = Object.assign({}, d, { leadId: null });
      lead = null;
    }
  }
  if (lead && lead.doNotRecord === true) {
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record' });
  }
  // Consent: a two-party company that never recorded the disclosure tap is not processed.
  if (d.consentMode === 'two_party_attested' && !(Number(d.disclosureAckedAtMs) > 0)) {
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
      const since = Number(d.uploadedAtMs) || Number(d.createdAtMs) || nowMs;
      if (nowMs - since > LG.OBJECT_WAIT_MS) {
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
    let t;
    try {
      const [buffer] = await file.download();
      t = await D.transcribe({ buffer, ext: extOf(d.audioPath), prompt });
    } catch (e) {
      const outage = LG.classifyProviderError(e);
      if (outage) {
        // The account / provider is out, not this recording: no strike.
        await state({
          pipelineStatus: PIPELINE.TRANSCRIBE_PENDING, pipelineNote: 'provider_outage', pipelineNextAtMs: nowMs + LG.outageRetryMs(outage.kind),
          pipelineError: msg(e), providerOutage: { provider: outage.provider, kind: outage.kind, atMs: nowMs }, audioLive: true,
        });
        logger.warn('visit_capture_transcribe_outage', { visitId, kind: outage.kind, provider: outage.provider });
        return { step: 'process', state: PIPELINE.TRANSCRIBE_PENDING, outage: outage.kind };
      }
      const strikes = (Number(d.transcribeStrikes) || 0) + 1;
      const dead = strikes >= LG.MAX_TRANSCRIBE_STRIKES;
      await state({
        pipelineStatus: dead ? PIPELINE.FAILED : PIPELINE.TRANSCRIBE_PENDING, transcribeStrikes: strikes, pipelineError: msg(e),
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
    // words are already safe on the doc.
    await state({
      transcript: fixed.text.slice(0, 120000), transcriptRaw: raw.slice(0, 120000), transcriptCorrections: fixed.corrections,
      transcriptSegments: segments, transcriptDurationSec: durationSec, transcribedAtMs: nowMs,
      pipelineStatus: PIPELINE.TRANSCRIBED, pipelineNote: null, pipelineError: null, pipelineNextAtMs: 0, pipelineLeaseUntilMs: nowMs + LG.LEASE_MS,
      transcribeStrikes: 0, objectChecks: 0, providerOutage: null, audioLive: true,
      audioBytes: size, audioMime: d.mime || null,
    });
    try {
      await D.recordUsage(db, { uid, companyId: ctx.companyId, audioSec: Math.round(durationSec), analysisTokens: 0, costCents: 0 });
    } catch (e) { logger.warn('visit_capture_usage_failed', { visitId, err: msg(e) }); }
  }

  // 5. verbal consent (two_party_verbal): the opening must contain a yes
  if (d.consentMode === 'two_party_verbal' && !d.consentCheckedAtMs) {
    try {
      const c = await D.checkConsent({ transcript: transcriptText, segments: segments.map((s) => ({ start: s.s, end: s.e, text: s.t })) });
      if (!c || c.consented !== true) {
        return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'no_verbal_consent', final: PIPELINE.QUARANTINED });
      }
      await ref.set({ consentCheckedAtMs: nowMs, consentEvidence: String(c.evidence || '').slice(0, 300) }, { merge: true });
    } catch (e) {
      const outage = LG.classifyProviderError(e);
      // Unverified consent fails CLOSED: nothing past the transcript runs until it is.
      await state({ pipelineStatus: PIPELINE.CONSENT_PENDING, pipelineNote: outage ? 'provider_outage' : 'consent_check_failed', pipelineError: msg(e), pipelineNextAtMs: nowMs + (outage ? LG.outageRetryMs(outage.kind) : 15 * 60000) });
      return { step: 'process', state: PIPELINE.CONSENT_PENDING };
    }
  }

  // 6. RANKED SUGGESTIONS, from the transcript alone (so an AI outage still has chips)
  if (!leads) leads = await tenantLeads(db, uid, ctx.companyId);
  if (!appointments) appointments = await appointmentsAround(db, uid, Number(d.startedAtMs) || 0);
  const rank = (callerFacts) => LG.rankSuggestions({ capture: d, transcript: transcriptText, callerFacts, leads, appointments, nowMs });
  let r1 = rank(null);
  if (r1.dnrMatch) {
    // The person named is a do-not-record customer: do not keep their words.
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record_match' });
  }
  await ref.set({ suggestions: r1.suggestions, suggestionsAtMs: nowMs, suggestionsRulesV: LG.SUGGEST_RULES_VERSION, pipelineLeaseUntilMs: nowMs + LG.LEASE_MS }, { merge: true });

  // 7. NOTES (Claude). A retry re-runs only this step.
  const leadName = lead ? (String(lead.name || lead.customerName || '') || (String(lead.firstName || '') + ' ' + String(lead.lastName || '')).trim()) : '';
  let notes;
  try {
    const raw = await D.notes({
      system: LG.VISIT_NOTES_SYSTEM,
      prompt: LG.buildVisitNotesPrompt({ capture: Object.assign({}, d, { durationSec }), transcript: transcriptText, leadName, nowMs }),
      feature: 'visit-notes', maxTokens: 1500,
    });
    notes = LG.sanitizeVisitNotes(raw);
  } catch (e) {
    const outage = LG.classifyProviderError(e);
    if (outage) {
      await state({
        pipelineStatus: PIPELINE.NOTES_PENDING, pipelineNote: 'provider_outage', pipelineError: msg(e),
        pipelineNextAtMs: nowMs + LG.outageRetryMs(outage.kind), providerOutage: { provider: outage.provider, kind: outage.kind, atMs: nowMs },
      });
      logger.warn('visit_capture_notes_outage', { visitId, kind: outage.kind, provider: outage.provider });
      const out = { step: 'process', state: PIPELINE.NOTES_PENDING, outage: outage.kind };
      if (d.leadId) { const f = await doFinalize({ db, bucket, ref, uid, visitId, d: Object.assign({}, d, { pipelineStatus: PIPELINE.NOTES_PENDING, notes: null }), nowMs }); out.finalized = f.state; }
      return out;
    }
    const strikes = (Number(d.notesStrikes) || 0) + 1;
    const dead = strikes >= LG.MAX_NOTES_STRIKES;
    await state({
      pipelineStatus: dead ? PIPELINE.NOTES_FAILED : PIPELINE.NOTES_PENDING, notesStrikes: strikes, pipelineError: msg(e),
      pipelineNote: dead ? 'notes_failed' : 'notes_retry', pipelineNextAtMs: dead ? 0 : nowMs + strikes * 15 * 60000,
    });
    logger.warn('visit_capture_notes_failed', { visitId, strikes, err: msg(e) });
    return { step: 'process', state: dead ? PIPELINE.NOTES_FAILED : PIPELINE.NOTES_PENDING, strikes };
  }
  if (notes.visitType === 'personal') {
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'personal' });
  }
  // the facts the model heard make the suggestions better (name + town, name + street)
  const r2 = rank(notes.callerFacts);
  if (r2.dnrMatch) return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record_match' });
  const dismissed = Array.isArray(d.rejectedLeadIds) ? d.rejectedLeadIds.map(String) : [];
  await state({
    notes, notesAtMs: nowMs, pipelineStatus: PIPELINE.READY, pipelineNote: null, pipelineError: null, pipelineNextAtMs: 0,
    notesStrikes: 0, providerOutage: null,
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
 */
async function doFinalize({ db, bucket, ref, uid, visitId, d, nowMs }) {
  const ctx = await getDeps().companyContext(db, uid);
  const leadSnap = await db.doc('leads/' + d.leadId).get();
  const lead = leadSnap.exists ? Object.assign({ id: leadSnap.id }, leadSnap.data()) : null;
  if (!lead || lead.deleted === true || !mayRecordOn(lead, uid, ctx.companyId)) {
    await ref.set({ leadId: null, attachedAtMs: null, pipelineNote: 'attach_refused' }, { merge: true });
    return { step: 'finalize', state: 'refused' };
  }
  if (lead.doNotRecord === true) {
    return await doPurge({ db, bucket, ref, uid, visitId, d, nowMs, reason: 'do_not_record' });
  }
  const co = await db.doc('companies/' + (ctx.companyId || uid)).get().catch(() => null);
  const days = LG.retentionDays(co && co.exists ? co.data() : null);
  const built = LG.buildAttachment({
    capture: d, notes: d.notes || null, visitId, leadId: String(d.leadId), lead, uid,
    todayYmd: LG.etToday(nowMs), nowMs, audioKeptDays: d.audioLive === false ? 0 : days,
  });
  const actRef = db.doc('leads/' + lead.id + '/activity/' + built.activityId);
  const had = await actRef.get();
  await actRef.set(Object.assign({}, built.activity, { updatedAt: FieldValue.serverTimestamp() }, had.exists ? {} : { createdAt: FieldValue.serverTimestamp() }), { merge: true });
  let made = 0;
  for (const t of built.tasks) {
    const r = db.doc('leads/' + lead.id + '/tasks/' + t.id);
    const doc = Object.assign({}, t.doc, { createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    if (t.type === 'promise') doc.madeAt = FieldValue.serverTimestamp();
    if (await createIfAbsent(r, doc)) made++;
  }
  await ref.set({
    finalizedKey: LG.finalizeKey(d), finalizedAtMs: nowMs, attachedLeadId: lead.id,
    attachedAtMs: Number(d.attachedAtMs) || nowMs, tasksMade: made, tasksSkipped: built.skipped.length || 0,
  }, { merge: true });
  return { step: 'finalize', state: 'filed', tasksMade: made, tasks: built.tasks.length, skipped: built.skipped };
}

/** Undo a filing (the person changed or removed the customer). Untouched tasks go; ticked ones stay. */
async function retract({ db, leadId, visitId }) {
  await db.doc('leads/' + leadId + '/activity/visit-' + visitId).delete().catch(() => {});
  const snap = await db.collection('leads/' + leadId + '/tasks').where('visitId', '==', visitId).get();
  const jobs = [];
  snap.forEach((t) => {
    const v = t.data() || {};
    if (v.done !== true) jobs.push(t.ref.delete());
  });
  await Promise.all(jobs);
  return { removedTasks: jobs.length };
}

// ── the callable ────────────────────────────────────────────────────────
const ATTACH_ROLES = ['', 'owner', 'company_admin', 'manager', 'admin'];

async function attachAction({ db, bucket, auth, data, nowMs }) {
  const { HttpsError } = require('firebase-functions/v2/https');
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const token = auth.token || {};
  require('./shared').assertNotViewer(token);
  const role = String(token.role || '');
  if (ATTACH_ROLES.indexOf(role) === -1) throw new HttpsError('permission-denied', 'Your role cannot file visit recordings.');
  const visitId = String((data && data.visitId) || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(visitId)) throw new HttpsError('invalid-argument', 'Bad visit id.');
  const action = String((data && data.action) || 'attach');
  if (['attach', 'detach', 'notThese', 'retryNotes', 'audioUrl'].indexOf(action) === -1) throw new HttpsError('invalid-argument', 'Unknown action.');
  const uid = auth.uid; // never from the client: a person acts on their OWN captures only
  const ref = visitRef(db, uid, visitId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That recording is not on the server yet.');
  const d = snap.data() || {};
  if (d.status === 'discarded' || d.pipelineStatus === PIPELINE.DISCARDED) throw new HttpsError('failed-precondition', 'That recording was discarded.');

  if (action === 'audioUrl') {
    if (d.audioLive !== true || !d.audioPath || !LG.AUDIO_PATH_RE(uid, visitId).test(d.audioPath)) {
      throw new HttpsError('failed-precondition', 'The audio is no longer kept.');
    }
    const url = await getDeps().signUrl(bucket, d.audioPath);
    return { ok: true, url, expiresInSec: 600 };
  }
  if (action === 'notThese') {
    const ids = Array.from(new Set((Array.isArray(d.suggestions) ? d.suggestions : []).map((s) => s.leadId)
      .concat(Array.isArray(d.rejectedLeadIds) ? d.rejectedLeadIds : []))).slice(0, 30);
    await ref.set({ rejectedLeadIds: ids, suggestions: [], suggestionsDismissedAtMs: nowMs }, { merge: true });
    return { ok: true };
  }
  if (action === 'retryNotes') {
    if (!d.transcript) throw new HttpsError('failed-precondition', 'There is no transcript to read yet.');
    await ref.set({ pipelineStatus: PIPELINE.NOTES_PENDING, pipelineNextAtMs: 0, notesStrikes: 0, pipelineNote: 'manual_retry' }, { merge: true });
    const r = await runVisit({ db, bucket, uid, visitId, nowMs });
    return { ok: true, state: r.state || null };
  }
  const ctx = await getDeps().companyContext(db, uid);
  if (action === 'detach') {
    if (d.attachedLeadId) await retract({ db, leadId: d.attachedLeadId, visitId });
    await ref.set({ leadId: null, attachedLeadId: null, attachedAtMs: null, finalizedKey: null, finalizedAtMs: null }, { merge: true });
    return { ok: true, leadId: null };
  }
  // attach
  const leadId = String((data && data.leadId) || '');
  if (!leadId || leadId.length > 128 || /\//.test(leadId)) throw new HttpsError('invalid-argument', 'Pick a customer.');
  const ls = await db.doc('leads/' + leadId).get();
  const lead = ls.exists ? Object.assign({ id: ls.id }, ls.data()) : null;
  if (!lead || lead.deleted === true) throw new HttpsError('not-found', 'Customer not found.');
  if (!mayRecordOn(lead, uid, ctx.companyId)) throw new HttpsError('permission-denied', 'That customer is not in your company.');
  if (lead.doNotRecord === true) throw new HttpsError('failed-precondition', 'That customer is marked do not record.');
  const name = (String(lead.name || lead.customerName || '') || (String(lead.firstName || '') + ' ' + String(lead.lastName || '')).trim()).trim();
  if (d.attachedLeadId && d.attachedLeadId === leadId && d.finalizedKey === LG.finalizeKey(Object.assign({}, d, { leadId }))) {
    return { ok: true, already: true, leadId, leadName: name, state: d.pipelineStatus || null };
  }
  if (d.attachedLeadId && d.attachedLeadId !== leadId) await retract({ db, leadId: d.attachedLeadId, visitId });
  await ref.set({ leadId, attachedAtMs: nowMs, attachedBy: 'user', finalizedKey: null }, { merge: true });
  const cur = Object.assign({}, d, { leadId, attachedAtMs: nowMs, finalizedKey: null });
  let res = { state: 'waiting' };
  // Filed as soon as there is a transcript to file; before that the trigger files it when the pipeline gets there.
  const p = d.pipelineStatus || '';
  if (p === PIPELINE.READY || p === PIPELINE.NOTES_PENDING || p === PIPELINE.NOTES_FAILED || p === PIPELINE.TRANSCRIBED) {
    res = await doFinalize({ db, bucket, ref, uid, visitId, d: cur, nowMs });
  }
  return { ok: true, leadId, leadName: name, state: p || null, filed: res.state === 'filed', tasksMade: res.tasksMade || 0 };
}

// ── retention (called by recordingRetentionCron) ────────────────────────
/**
 * Raw audio older than the company's recordingRetentionDays (default 90, the
 * same rule the recordings cron applies to lead-bound audio) goes from
 * Storage. Transcript + notes stay (they are the useful part and live on
 * owner-only docs). Covers audio/{uid}/_inbox/* AND attached visit audio:
 * attach never moves the object.
 */
async function retentionSweep({ db, bucket, nowMs, maxPages }) {
  const out = { scanned: 0, deleted: 0, failed: 0, kept: 0 };
  const minCutoff = nowMs - 7 * 86400000;
  const daysByUid = new Map();
  const daysFor = async (uid) => {
    if (daysByUid.has(uid)) return daysByUid.get(uid);
    let days = LG.RETENTION_DEFAULT_DAYS;
    try {
      const ctx = await getDeps().companyContext(db, uid);
      const co = await db.doc('companies/' + (ctx.companyId || uid)).get();
      days = LG.retentionDays(co.exists ? co.data() : null);
    } catch (_) { /* default */ }
    daysByUid.set(uid, days);
    return days;
  };
  let last = null;
  for (let page = 0; page < (maxPages || 30); page++) {
    let q = db.collectionGroup(VISITS).where('audioLive', '==', true).where('uploadedAtMs', '<', minCutoff).orderBy('uploadedAtMs').limit(100);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      out.scanned++;
      const who = uidFromPath(doc.ref.path);
      const v = doc.data() || {};
      if (!who) { out.kept++; continue; }
      const days = await daysFor(who.uid);
      // A capture that was skipped / quarantined / discarded and whose audio could not be
      // deleted then is overdue at once (the 7-day floor of the query is the only wait).
      const overdue = !!(v.skipReason || v.status === 'discarded');
      if (!overdue && !(Number(v.uploadedAtMs) < nowMs - days * 86400000)) { out.kept++; continue; }
      const del = await deleteAudio(bucket, who.uid, who.visitId, v.audioPath);
      if (del.ok) {
        await doc.ref.set({ audioLive: false, audioDeletedAtMs: nowMs, audioDeletedBy: 'retention' }, { merge: true });
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
    const snap = await db.collectionGroup(VISITS).where('pipelineStatus', 'in', LG.RETRY_STATES).limit(60).get();
    snap.forEach((d) => rows.set(d.ref.path, d));
  } catch (e) { logger.warn('visit_capture_sweep_retry_query_failed', { err: msg(e) }); out.errors++; }
  try {
    // A doc whose trigger never ran: uploaded in the last 48 h and untouched by the pipeline.
    const snap = await db.collectionGroup(VISITS).where('status', '==', 'uploaded').where('uploadedAtMs', '>', nowMs - 48 * 3600000).limit(100).get();
    snap.forEach((d) => { const v = d.data() || {}; if (!v.pipelineStatus && !rows.has(d.ref.path)) { rows.set(d.ref.path, d); out.lostTrigger++; } });
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
    // A provider outage is the same for every visit: stop spending the run on it.
    if (r.outage && (r.outage === 'credit' || r.outage === 'auth')) break;
  }
  return out;
}

// ── exports (registered in functions/index.js) ───────────────────────────
function register() {
  const { onDocumentWritten } = require('firebase-functions/v2/firestore');
  const { onCall } = require('firebase-functions/v2/https');
  const { onSchedule } = require('./integrations/heartbeat');
  const { defineSecret } = require('firebase-functions/params');
  const { SECRETS } = require('./integrations/_shared');
  const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
  const secrets = [SECRETS.GROQ_API_KEY, ANTHROPIC_API_KEY];
  const out = {};

  out.onVisitCaptureWrite = onDocumentWritten(
    { document: 'users/{uid}/' + VISITS + '/{visitId}', region: 'us-central1', memory: '1GiB', timeoutSeconds: 540, concurrency: 1, secrets },
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
            logger.info('visit_capture_doc_deleted', { visitId, audioDeleted: del.ok });
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

  out.visitCaptureSweep = onSchedule(
    { schedule: 'every 30 minutes', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '1GiB', secrets },
    async () => {
      try {
        if (await getDeps().aiDisabled()) { logger.info('[visitCaptureSweep] AI kill switch on'); return; }
        const r = await sweep({ db: getFirestore(), bucket: getStorage().bucket(), nowMs: Date.now() });
        logger.info('[visitCaptureSweep]', r);
      } catch (e) { logger.warn('[visitCaptureSweep] failed', { err: msg(e) }); }
    }
  );

  out.attachVisitCapture = onCall(
    { region: 'us-central1', enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 120, maxInstances: 10, secrets },
    (request) => attachAction({ db: getFirestore(), bucket: getStorage().bucket(), auth: request.auth, data: request.data, nowMs: Date.now() })
  );
  return out;
}

module.exports = Object.assign(register(), {
  runVisit, attachAction, sweep, retentionSweep, retract,
  _setDeps: setDeps,
  _internal: { doProcess, doFinalize, doPurge, tenantLeads, appointmentsAround, vocabularyFor, mayRecordOn, uidFromPath },
});
