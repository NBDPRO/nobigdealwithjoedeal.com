/**
 * integrations/transcription-logic.js — pure decisions for the dictation
 * transcription path (no firebase, no network; unit-tested in
 * tests/dictate-transcription-provider.test.js).
 *
 * WHY THIS EXISTS (2026-09-04)
 * ───────────────────────────
 * `dictate` (the CRM's mic buttons) transcribed every clip through Deepgram
 * Nova-3 — a metered provider — while the Voice Intelligence pipeline next
 * to it already ran Groq Whisper-large-v3-turbo, whose free tier (20 req/min,
 * 2,000 req/day, 8 h audio/day, 25 MB per file; commercial use permitted
 * under the GroqCloud services agreement, verified 2026-09-02) covers this
 * shop's dictation volume many times over. Same key, same provider switch
 * (`NBD_VOICE_TRANSCRIPTION_PROVIDER`, default 'groq'). This module holds
 * the choice so the callable stays thin and the choice stays testable.
 *
 * 2026-10-04: the Deepgram fallback was removed (VENDOR-COST-LOCKIN Lane C).
 * Its key was the deploy's `__unset__` stub, so the fallback never ran in
 * prod — Groq was the only transcriber dictate could reach.
 */

'use strict';

/**
 * Decide which transcriber the dictate callable should use. The
 * {primary, fallback} shape is kept so a second provider can slot back in
 * without touching the callable's retry loop.
 *
 * @param {object} o
 * @param {boolean} o.hasGroq    hasSecret('GROQ_API_KEY')
 * @returns {{primary: string, fallback: (string|null)} | null}
 *   null when nothing is configured — the caller turns that into
 *   failed-precondition.
 */
function pickDictationProvider({ hasGroq } = {}) {
  if (!hasGroq) return null;
  return { primary: 'groq', fallback: null };
}

// Groq detects the container from the multipart filename's extension, not
// the Content-Type, so a wrong extension gets a 400 "could not process
// file". Map what browsers actually record (MediaRecorder: webm on
// Chrome/Android, mp4 on iOS Safari) to the extensions Groq lists as
// supported: flac mp3 mp4 mpeg mpga m4a ogg wav webm.
const MIME_EXT = [
  [/webm/i, 'webm'],
  [/mp4|m4a|x-m4a|aac/i, 'm4a'],
  [/mpeg|mp3|mpga/i, 'mp3'],
  [/ogg|opus/i, 'ogg'],
  [/wav|wave|x-wav/i, 'wav'],
  [/flac/i, 'flac'],
];
function groqExtensionForMime(mimeType) {
  const m = String(mimeType || '');
  for (const [re, ext] of MIME_EXT) if (re.test(m)) return ext;
  return 'webm';
}

/**
 * Normalize a Groq /audio/transcriptions response (json or verbose_json)
 * to the shape dictate has always returned. Groq gives no per-utterance
 * confidence; the client never read it (nbd-whisper.js uses transcript
 * and cleaned only), so it is null rather than invented.
 */
function normalizeGroqTranscription(data) {
  const text = data && typeof data.text === 'string' ? data.text : '';
  return {
    transcript: text.trim(),
    confidence: null,
    durationSec: data && Number.isFinite(Number(data.duration)) ? Number(data.duration) : null,
  };
}

module.exports = {
  pickDictationProvider,
  groqExtensionForMime,
  normalizeGroqTranscription,
};
