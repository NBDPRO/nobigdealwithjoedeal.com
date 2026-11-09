'use strict';

/**
 * functions/call-transcribe-now.js — Call to Close P1 (2026-11-09): "Transcribe now".
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.2, §9 (Q5).
 *
 * callTranscribeNow (onCall { callId }) → { state, message, transcript? }.
 * One stored phone call, transcribed and noted NOW instead of at the next
 * half-hourly callCenterTranscribe run. It runs that same pass for this one
 * call (call-center.js runTranscribe `only`): the same Groq transcriber, the
 * same notes, the same filing, the same day audio allowance and the same
 * capture-off rule. Nothing changes about who is recorded or where audio
 * goes (Q6).
 *
 * Gates, in order: App Check + assertNotGhost; signed in; exactly
 * callCenterAction's role test (not a viewer; admin, the call's owner, or a
 * same-company company_admin / manager: call-brief-logic canActOnCall).
 * A transcript already on the call is returned as it is (no Groq, no quota,
 * no switch needed to read it). Then the AI kill switch, the
 * CALL_CENTER_TRANSCRIBE_ENABLED gate and integrations/callCenter.paused; the
 * call must be one the schedule would pick (the owner's, stored, a
 * recording, fewer than three failed tries, under the size limit, inside
 * today's audio allowance); not already being transcribed (the lease); and
 * the daily caps: USER_DAY_CAP per user and COMPANY_DAY_CAP per company per
 * ET day, in one transaction. A run that transcribed nothing gives the count
 * back.
 *
 * Idempotent: two taps (or a tap and the schedule) never transcribe one call
 * twice. runTranscribe claims the call in a transaction (transcribeLease) and
 * the second one finds it claimed or already noted.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { SECRETS } = require('./integrations/_shared');
const CC = require('./call-center');
const L = require('./call-center-logic');
const B = require('./call-brief-logic');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const CALLS = 'phone_calls';
const QUOTA = 'call_transcribe_quota';
const USER_DAY_CAP = 10;
const COMPANY_DAY_CAP = 30;
const MAX_TRIES = 3;  // = call-center-logic pickToTranscribe

const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const enabled = () => process.env.CALL_CENTER_TRANSCRIBE_ENABLED === 'true';
const refuse = (msg) => { throw new HttpsError('failed-precondition', msg); };

/** Why the schedule would not pick this call, or ''. */
function notTranscribable(call, cfg, nowMs) {
  const c = call || {};
  if (c.status === 'short') return 'Short calls (under 15 seconds) are not transcribed.';
  if (c.status === 'personal') return 'This call is marked personal, so it is not transcribed.';
  if (c.status === 'too_large' || (!(c.transcriptSaved === true && String(c.transcript || '').trim()) && (Number(c.sizeBytes) || 0) > L.GROQ_MAX_BYTES)) return 'This recording is too long to transcribe automatically.';
  if (c.status !== 'stored' || !c.storagePath) return 'This call has no recording to transcribe.';
  if (c.userId !== CC._test.OWNER) return 'This call is not in the transcription queue.';
  if ((Number(c.transcribeAttempts) || 0) >= MAX_TRIES && !L.isProviderOutage(c.transcribeError)) return 'Transcription failed three times on this call. Listen to the recording instead.';
  const today = etYmd(nowMs);
  const used = (cfg.audioSecDay === today && Number(cfg.audioSecUsed)) || 0;
  const est = c.transcriptSaved === true && String(c.transcript || '').trim() ? 0 : L.estimateAudioSec(c.sizeBytes);
  if (est > L.dayAudioCapSec(cfg.dayAudioCapHours) - used) return "Today's transcription allowance is used up. This call is transcribed tomorrow.";
  return '';
}

/** One transaction: 'user' / 'company' when over a cap, else both counters +1 (delta -1 gives one back). */
async function takeQuota(db, uid, companyId, nowMs, delta) {
  const day = etYmd(nowMs);
  const uRef = db.collection(QUOTA).doc(day + '__u__' + uid);
  const cRef = db.collection(QUOTA).doc(day + '__c__' + companyId);
  const d = delta === -1 ? -1 : 1;
  return db.runTransaction(async (tx) => {
    const [u, c] = [await tx.get(uRef), await tx.get(cRef)];
    const un = (u.exists && Number(u.data().n)) || 0;
    const cn = (c.exists && Number(c.data().n)) || 0;
    if (d > 0 && un >= USER_DAY_CAP) return 'user';
    if (d > 0 && cn >= COMPANY_DAY_CAP) return 'company';
    tx.set(uRef, { n: Math.max(0, un + d), uid, day, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(cRef, { n: Math.max(0, cn + d), companyId, day, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return '';
  });
}

const leased = (c, nowMs) => !!(c && c.transcribeLease && Number(c.transcribeLease.untilMs) > nowMs);
const MESSAGES = {
  noted: 'Transcribed. The notes are on the call.',
  already: 'This call is already transcribed.',
  personal: 'Transcribed. It was a personal call, so nothing was kept.',
  captureOff: 'This number is marked personal and not to be transcribed, so the call was not transcribed.',
  busy: 'This call is being transcribed right now. Check back in a minute.',
  outage: 'The transcription service is not answering right now. The call stays in the queue.',
  failed: 'Transcription did not work this time. The call stays in the queue.',
};

async function transcribeNow({ db, bucket, auth, data, nowMs, log = logger }) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const callId = String((data && data.callId) || '');
  if (!/^cube_[A-Za-z0-9_-]{5,120}$/.test(callId)) throw new HttpsError('invalid-argument', 'Bad call id.');
  const ref = db.collection(CALLS).doc(callId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = snap.data() || {};
  if (String((auth.token || {}).role || '') === 'viewer') throw new HttpsError('permission-denied', 'Your role is view-only.');
  if (!B.canActOnCall(auth, call)) throw new HttpsError('permission-denied', 'Not your call.');

  // Idempotent: a transcript already here is the answer.
  if (call.status === 'noted' && String(call.transcript || '').trim()) {
    return { state: 'already', message: MESSAGES.already, transcript: String(call.transcript) };
  }
  let off = false;
  try { off = await require('./integrations/killswitch').isAiDisabled(); } catch (_) { off = false; }
  if (off) refuse('AI is switched off right now, so calls are not transcribed.');
  if (!enabled()) refuse('Call transcription is switched off.');
  const cs = await db.doc(CC._test.CONFIG).get();
  const cfg = cs.exists ? (cs.data() || {}) : {};
  if (cfg.paused === true) refuse('Call transcription is paused.');
  const why = notTranscribable(call, cfg, nowMs);
  if (why) refuse(why);
  if (leased(call, nowMs)) return { state: 'busy', message: MESSAGES.busy };

  const companyId = String(call.companyId || call.userId || '');
  const over = await takeQuota(db, auth.uid, companyId, nowMs);
  if (over === 'user') throw new HttpsError('resource-exhausted', 'You have used Transcribe now ' + USER_DAY_CAP + ' times today, the daily limit. The call is still transcribed on the next scheduled pass.');
  if (over === 'company') throw new HttpsError('resource-exhausted', 'Your company has used Transcribe now ' + COMPANY_DAY_CAP + ' times today, the daily limit. The call is still transcribed on the next scheduled pass.');

  let out = null;
  try {
    out = await CC.runTranscribe({ db, bucket, live: true, nowMs, only: { id: callId, by: 'now:' + auth.uid } });
  } catch (e) {
    log.warn('call_transcribe_now_failed', { callId, err: e && e.message });
  }
  const after = await ref.get();
  const c = after.exists ? (after.data() || {}) : {};
  let state;
  if (c.status === 'noted' && String(c.transcript || '').trim()) state = out && out.noted > 0 ? 'noted' : 'already';
  else if (c.status === 'personal') state = 'personal';
  else if (out && out.providerOutage) state = 'outage';
  else if (!out || out.leased || leased(c, nowMs)) state = 'busy';
  else state = 'failed';
  // Only a run that did the work keeps its count.
  if (!(out && (out.noted > 0 || out.personal > 0))) {
    await takeQuota(db, auth.uid, companyId, nowMs, -1).catch((e) => log.warn('call_transcribe_now_refund_failed', { callId, err: e && e.message }));
  }
  log.info('call_transcribe_now', { callId, state, by: auth.uid });
  // The capture-off rule filed it personal without transcribing anything.
  const msg = state === 'personal' && out && out.captureOff ? MESSAGES.captureOff : MESSAGES[state];
  const res = { state, message: c.status === 'too_large' ? 'This recording is too long to transcribe automatically.' : msg };
  if (state === 'noted' || state === 'already') res.transcript = String(c.transcript);
  return res;
}

exports.callTranscribeNow = onCall(
  // 300 s: a long call's Groq request (call-center.js gives it 300 s); under
  // the 15-minute transcribe lease. 1 GiB: the FLAC re-encode, as the schedule.
  { region: 'us-central1', enforceAppCheck: true, secrets: [SECRETS.GROQ_API_KEY, ANTHROPIC_API_KEY], memory: '1GiB', timeoutSeconds: 300, maxInstances: 5 },
  async (request) => {
    await require('./tenant-guard').assertNotGhost(request);
    return transcribeNow({ db: getFirestore(), bucket: getStorage().bucket(), auth: request.auth, data: request.data, nowMs: Date.now() });
  }
);

exports.USER_DAY_CAP = USER_DAY_CAP;
exports.COMPANY_DAY_CAP = COMPANY_DAY_CAP;
exports._test = { transcribeNow, takeQuota, notTranscribable };
