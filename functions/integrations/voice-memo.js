/**
 * integrations/voice-memo.js — voice memo transcription (F8)
 *
 * Rep taps 🎙 on a lead → MediaRecorder captures up to 60s of audio →
 * client uploads the blob through this callable → Groq Whisper returns a
 * transcript → we write a `voice_memo` activity entry on the lead and
 * return the text to the client for display.
 *
 * 2026-10-04: moved from Deepgram Nova-3 to Groq Whisper-large-v3-turbo.
 * DEEPGRAM_API_KEY only ever held the deploy's `__unset__` stub, so in prod
 * this callable always answered "Voice transcription not configured" and the
 * card-detail Voice Memo button never worked. It now goes through the SAME
 * provider, key and helpers as `dictate` (functions/dictate.js):
 * voice-intelligence.js transcribeGroqBuffer + transcription-logic.js's
 * groqExtensionForMime / normalizeGroqTranscription — no second Groq client.
 * Same guards as dictate too: the global AI kill switch (isAiDisabled) and a
 * per-uid rate limit. (dictate has no per-company meter to share; Groq's free
 * tier is the cost ceiling for both.)
 *
 * Privacy: audio is NEVER written to Storage. The blob is sent to Groq and
 * discarded after the transcript comes back. Only the transcript survives,
 * on the lead's activity subcollection.
 *
 * Unconfigured secret → callable throws failed-precondition with a clear
 * message; the client toasts it.
 *
 * SETUP:
 *   firebase functions:secrets:set GROQ_API_KEY   (shared with dictate + Voice Intel)
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');

const { SECRETS, hasSecret } = require('./_shared');
const { transcribeGroqBuffer } = require('./voice-intelligence');
const { groqExtensionForMime, normalizeGroqTranscription } = require('./transcription-logic');
const { assertNotViewer } = require('../shared');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app'
];

// Max audio clip accepted. 60s at 128kbps ≈ 960KB, so 1.5MB is a
// generous ceiling that still kills oversize uploads.
const MAX_AUDIO_BYTES = 1_500_000;

exports.transcribeVoiceMemo = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    memory: '512MiB',
    secrets: [SECRETS.GROQ_API_KEY]
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B): a viewer is read-only. WITH a leadId this
    // writes a voice_memo entry onto the lead's activity (owner check
    // below), so a viewer is refused. WITHOUT one it only returns a
    // transcript — nbd-whisper.js's "dictate everywhere" mic, which drops
    // the text into whatever input is focused (a search box too) or a
    // copyable tooltip — so that read-shaped path stays open. Same leadId
    // parse as the handler's own, below.
    if (typeof request.data?.leadId === 'string' && request.data.leadId) {
      assertNotViewer(request.auth.token);
    }

    // Global AI kill-switch (Audit #4) — the same flag dictate reads.
    // Emergency halt of Groq spend without a deploy.
    if (await require('./killswitch').isAiDisabled()) {
      throw new HttpsError('unavailable', 'AI temporarily disabled');
    }

    // D1-style per-uid cap. Voice memos are human-paced; 20/hour
    // is fine for the most diligent rep and kills a loop cheaply.
    const { enforceRateLimit } = require('./upstash-ratelimit');
    try {
      await enforceRateLimit('callable:transcribeVoiceMemo:uid', uid, 20, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) throw new HttpsError('resource-exhausted', 'Rate limit — try again in an hour.');
      throw e;
    }

    // Registry check: the deploy's '__unset__' stub reads as not configured.
    if (!hasSecret('GROQ_API_KEY')) {
      throw new HttpsError('failed-precondition',
        'Voice transcription not configured. Contact support.');
    }

    // Accept base64 audio in the callable payload. MediaRecorder on the
    // client produces audio/webm (Chrome/Android) or audio/mp4 (iOS
    // Safari); groqExtensionForMime maps that to the filename extension
    // Groq detects the container from.
    const audioB64 = typeof request.data?.audioBase64 === 'string' ? request.data.audioBase64 : '';
    const mimeType = typeof request.data?.mimeType === 'string' ? request.data.mimeType : 'audio/webm';
    const leadId   = typeof request.data?.leadId === 'string' ? request.data.leadId : null;

    if (!audioB64 || audioB64.length < 100) {
      throw new HttpsError('invalid-argument', 'Missing audio');
    }
    if (audioB64.length > MAX_AUDIO_BYTES * 2) {  // base64 = ~1.33x raw
      throw new HttpsError('invalid-argument', 'Clip too long (max 60s)');
    }
    const audioBuf = Buffer.from(audioB64, 'base64');
    if (audioBuf.length > MAX_AUDIO_BYTES) {
      throw new HttpsError('invalid-argument', 'Clip too large');
    }

    // Owner-scope: when this memo is attached to a lead, the caller must
    // own that lead (or be platform admin). The activity write below uses
    // the Admin SDK, which BYPASSES firestore.rules — so without this check
    // any authed rep could forge a voice_memo timeline entry onto another
    // tenant's lead by passing its (non-secret) id. Checked before Groq
    // so a cross-tenant id also can't burn transcription quota. Mirrors the
    // guard in remote-signing.js:97-101 / esign.js:94.
    if (leadId) {
      const leadSnap = await getFirestore().doc(`leads/${leadId}`).get();
      if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
      const isAdmin = !!(request.auth.token && request.auth.token.role === 'admin');
      if (leadSnap.data().userId !== uid && !isAdmin) {
        throw new HttpsError('permission-denied', 'Not your lead');
      }
    }

    // Transcribe through the shared Groq helper (the one dictate uses).
    let raw;
    try {
      raw = await transcribeGroqBuffer({
        buffer: audioBuf,
        mimeType,
        filename: 'memo.' + groqExtensionForMime(mimeType),
        // The callable has a 60s ceiling and nothing runs after Groq but
        // one Firestore write; leave headroom for the lead read above.
        timeoutMs: 45_000,
      });
    } catch (e) {
      // Provider detail goes to the log, never to the client.
      logger.warn('[transcribeVoiceMemo] transcription failed', {
        provider: 'groq', status: (e && e.status) || null, code: (e && e.code) || null,
        detail: String((e && e.message) || e).slice(0, 300),
      });
      if (e && e.status === 429) {
        throw new HttpsError('resource-exhausted', 'Transcription is busy — try again in a minute.');
      }
      throw new HttpsError('internal', 'Transcription failed');
    }
    // transcribeGroqBuffer returns { text, segments, durationSec }; the
    // normalizer trims the text and sets confidence null (Groq gives none —
    // never invented).
    const { transcript, confidence } = normalizeGroqTranscription(raw);
    const groqSec = Number(raw && raw.durationSec);

    // Persist to the lead's activity subcollection (if linked).
    if (leadId && transcript) {
      try {
        await getFirestore().collection(`leads/${leadId}/activity`).add({
          userId: uid,
          type: 'voice_memo',
          label: 'Voice memo',
          transcript,
          confidence,
          provider: 'groq',
          durationSec: groqSec > 0
            ? Math.round(groqSec)
            : Math.round(audioBuf.length / (128 * 1024 / 8)),
          createdAt: FieldValue.serverTimestamp()
        });
      } catch (e) { logger.warn('voice-memo activity write failed', { err: e.message }); }
    }

    return {
      success: true,
      transcript,
      confidence,
      words: transcript ? transcript.split(/\s+/).filter(Boolean).length : 0
    };
  }
);

module.exports = exports;
