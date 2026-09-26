/**
 * integrations/voice-memo.js — Deepgram voice transcription (F8)
 *
 * Rep taps 🎙 on a lead → MediaRecorder captures 15-30s of audio →
 * client uploads the blob through this callable → Deepgram
 * Nova-3 returns a transcript → we write a `voice_memo` activity
 * entry on the lead and return the text to the client for display.
 *
 * Why server-side transcription vs. browser WebSpeech:
 *   1. Consistent quality across browsers (Safari's WebSpeech is weak).
 *   2. Deepgram supports speaker diarization + smart formatting out of
 *      the box, which matters for D2D logs.
 *   3. Keeps the API key server-side.
 *
 * Privacy: audio is NEVER written to Storage. The blob is streamed
 * to Deepgram and discarded after the transcript comes back. Only
 * the transcript survives, on the lead's activity subcollection.
 *
 * Unconfigured secret → callable throws failed-precondition with a
 * clear message, the client toasts + hides the 🎙 button.
 *
 * SETUP:
 *   firebase functions:secrets:set DEEPGRAM_API_KEY
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');

const DEEPGRAM_API_KEY = defineSecret('DEEPGRAM_API_KEY');
const { secretValue } = require('./_shared');
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
    secrets: [DEEPGRAM_API_KEY]
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

    // D1-style per-uid cap. Voice memos are human-paced; 20/hour
    // is fine for the most diligent rep and kills a loop cheaply.
    const { enforceRateLimit } = require('./upstash-ratelimit');
    try {
      await enforceRateLimit('callable:transcribeVoiceMemo:uid', uid, 20, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) throw new HttpsError('resource-exhausted', 'Rate limit — try again in an hour.');
      throw e;
    }

    const apiKey = secretValue(DEEPGRAM_API_KEY); // the '__unset__' deploy stub reads as null
    if (!apiKey) {
      throw new HttpsError('failed-precondition',
        'Voice transcription not configured. Contact support.');
    }

    // Accept base64 audio in the callable payload. MediaRecorder on
    // the client produces audio/webm or audio/mp4 — Deepgram accepts
    // both without a mime hint if `container=webm` is omitted.
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
    // tenant's lead by passing its (non-secret) id. Checked before Deepgram
    // so a cross-tenant id also can't burn transcription cost. Mirrors the
    // guard in remote-signing.js:97-101 / esign.js:94.
    if (leadId) {
      const leadSnap = await getFirestore().doc(`leads/${leadId}`).get();
      if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
      const isAdmin = !!(request.auth.token && request.auth.token.role === 'admin');
      if (leadSnap.data().userId !== uid && !isAdmin) {
        throw new HttpsError('permission-denied', 'Not your lead');
      }
    }

    // POST to Deepgram. Model: nova-3 (Nov 2024). smart_format=true
    // inserts commas/periods; punctuate=true adds punctuation;
    // diarize=true labels speakers (useful for homeowner+rep memos).
    try {
      const url = 'https://api.deepgram.com/v1/listen?'
        + 'model=nova-3&smart_format=true&punctuate=true&diarize=true&language=en-US';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Token ' + apiKey,
          'Content-Type': mimeType
        },
        body: audioBuf
      });
      if (!res.ok) {
        const body = await res.text();
        logger.warn('Deepgram error', { status: res.status, body: body.slice(0, 300) });
        throw new HttpsError('internal', 'Transcription failed');
      }
      const data = await res.json();
      const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
      const transcript = (alt.transcript || '').trim();
      const confidence = alt.confidence || null;

      // Persist to the lead's activity subcollection (if linked).
      if (leadId && transcript) {
        try {
          await getFirestore().collection(`leads/${leadId}/activity`).add({
            userId: uid,
            type: 'voice_memo',
            label: 'Voice memo',
            transcript,
            confidence,
            durationSec: Math.round(audioBuf.length / (128 * 1024 / 8)),
            createdAt: FieldValue.serverTimestamp()
          });
        } catch (e) { logger.warn('voice-memo activity write failed', { err: e.message }); }
      }

      return {
        success: true,
        transcript,
        confidence,
        words: Array.isArray(alt.words) ? alt.words.length : 0
      };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('transcribeVoiceMemo', { err: e.message });
      throw new HttpsError('internal', 'Transcription failed');
    }
  }
);

module.exports = exports;
