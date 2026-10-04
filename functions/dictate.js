/**
 * functions/dictate.js — NBD Whisper unified dictation endpoint (W129)
 *
 * Combines transcribe + AI-process in a single round-trip so the
 * client doesn't pay two callable hops for one user action.
 *
 * Modes:
 *   - 'clean'         → return cleaned dictation text (default).
 *                       Strips filler, normalizes punctuation,
 *                       preserves voice. Intended for the W128
 *                       dictate-into-input flow.
 *   - 'summarize'     → return overview + action items + extracted
 *                       entities (people, dates, $$$, addresses).
 *                       Intended for the W130 Quick Capture modal.
 *   - 'extract-tasks' → return ONLY a structured task array, ready
 *                       to write straight into a leads/{id}/tasks
 *                       subcollection. Caller decides what to do
 *                       with them (commit-or-cancel UI).
 *
 * Auth: Firebase callable, App Check enforced. Per-uid rate-limit
 * (30/hr) — generous for active dictation, kills runaway loops cheap.
 *
 * Budget: transcription goes to Groq Whisper-large-v3-turbo first (free
 * tier: 20 req/min, 2,000 req/day, 8 h audio/day — verified 2026-09-02),
 * the same provider + key the Voice Intelligence pipeline uses, selected by
 * NBD_VOICE_TRANSCRIPTION_PROVIDER (default 'groq'). Deepgram Nova-3 is the
 * fallback when Groq is unset OR throws (its free tier can 429), so a
 * Deepgram-only deployment behaves exactly as before 2026-09-04. The Claude
 * call uses Haiku 4.5 — ~30 tokens of overhead for clean mode, more for
 * summarize. Token usage returned in the `usage` field for client-side
 * budget UI hooks. The response's `provider` field names who transcribed.
 *
 * SETUP:
 *   firebase functions:secrets:set GROQ_API_KEY     (shared with Voice Intel)
 *   firebase functions:secrets:set DEEPGRAM_API_KEY (optional fallback; F8)
 *   firebase functions:secrets:set ANTHROPIC_API_KEY (already required by AI arc)
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');

// Both transcription keys come from the shared registry so hasSecret() sees
// the deploy's `__unset__` stub as "not configured" (a bare defineSecret
// .value() check would treat the stub as a real key).
const { SECRETS, PROVIDERS, hasSecret, getSecret, secretValue } = require('./integrations/_shared');
const { transcribeGroqBuffer } = require('./integrations/voice-intelligence');
const {
  pickDictationProvider,
  groqExtensionForMime,
  normalizeGroqTranscription,
  normalizeDeepgramTranscription,
} = require('./integrations/transcription-logic');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// Same audio cap as F8's transcribeVoiceMemo so dictation can't
// route around the 60s ceiling by hitting this endpoint instead.
const MAX_AUDIO_BYTES = 1_500_000;

const ALLOWED_MODES = new Set(['clean', 'summarize', 'extract-tasks']);

// ─── Cleanup prompt ────────────────────────────────────────────
// Tight on purpose — Haiku does this well in <100 output tokens
// for a typical 1-2 sentence dictation. Keep instructions strict so
// the model never adds preamble like "Here's the cleaned text:".
const CLEAN_PROMPT = [
  'You are a copy editor. Take the user\'s spoken transcript and return ONLY the cleaned text, with these rules:',
  '1. Strip filler words like "um", "uh", "like", "you know", "I mean", "sort of", "kind of".',
  '2. Add proper punctuation and capitalization.',
  '3. Keep the speaker\'s voice and word choice — do not paraphrase or summarize.',
  '4. If the speaker said a voice command like "new paragraph", insert a paragraph break.',
  '5. If the speaker said "scratch that" or "delete that", drop the immediately preceding clause.',
  '6. Return ONLY the cleaned text. No quotes, no commentary, no preamble.',
].join('\n');

// ─── Summarize prompt ──────────────────────────────────────────
// For the W130 Quick Capture modal. Returns structured JSON.
const SUMMARIZE_PROMPT = `You are an assistant helping a roofing/insurance restoration sales rep
process voice notes captured between appointments. Take the
transcript and return ONLY valid JSON matching this schema (no
markdown fences, no preamble):

{
  "overview": "1-2 sentence plain-English recap",
  "actionItems": ["string — concrete next steps the rep should take, each starting with a verb"],
  "people":     ["string — names mentioned"],
  "addresses":  ["string — street addresses or location markers mentioned"],
  "amounts":    ["string — dollar amounts, deductibles, totals mentioned (preserve units)"],
  "dates":      ["string — specific dates or scheduling references like 'Saturday at 2pm'"],
  "category":   "lead-update|new-lead|follow-up|inspection-note|customer-call|admin|other"
}

Rules:
- If a field has no values, return an empty array (not null).
- Keep the rep's voice in actionItems — do NOT paraphrase, do NOT add suggestions the rep didn't make.
- If multiple homeowners or addresses are mentioned, list each separately.
- Output ONLY the JSON. No markdown, no preamble, no trailing text.`;

// ─── Extract-tasks prompt ──────────────────────────────────────
const EXTRACT_TASKS_PROMPT = `You are an assistant helping a roofing/insurance restoration sales rep
turn a voice note into a list of CRM tasks. Take the transcript and
return ONLY valid JSON matching this schema (no markdown fences):

{
  "tasks": [
    { "text": "string — the task in 1-12 words", "dueDate": "YYYY-MM-DD or null" }
  ]
}

Rules:
- Each task must be self-contained (a teammate could read it without the original transcript and know what to do).
- Use the CURRENT user's local date as today when resolving relative phrases like "tomorrow" / "next week".
- If no due date is implied, use null.
- Maximum 8 tasks per transcript — pick the most important ones.
- Output ONLY the JSON.`;

// ─── Transcription helpers ─────────────────────────────────────
// Deepgram Nova-3 — the original (metered) path, now the fallback.
async function transcribeDeepgram(audioBuf, mimeType) {
  const url = 'https://api.deepgram.com/v1/listen?'
    + 'model=nova-3&smart_format=true&punctuate=true&language=en-US';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Token ' + getSecret('DEEPGRAM_API_KEY'),
      'Content-Type': mimeType,
    },
    body: audioBuf,
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error('Deepgram ' + res.status + ': ' + body.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return normalizeDeepgramTranscription(await res.json());
}

// Groq Whisper-large-v3-turbo — free tier, same key as Voice Intel.
async function transcribeGroq(audioBuf, mimeType) {
  const out = await transcribeGroqBuffer({
    buffer: audioBuf,
    mimeType,
    filename: 'dictate.' + groqExtensionForMime(mimeType),
    // Clips are ≤60 s and the callable has a 60 s ceiling; leave room for
    // the Deepgram fallback + the Claude call after a slow Groq response.
    timeoutMs: 25_000,
    feature: 'dictate',
  });
  return normalizeGroqTranscription(out);
}

const TRANSCRIBERS = { groq: transcribeGroq, deepgram: transcribeDeepgram };

// Try the preferred provider, fall back once, and say who did the work.
// Every failure path logs the provider + status (a 429 from Groq is the
// free tier saying "slow down", which is exactly when the fallback earns
// its keep); only when both fail does the caller see an error.
async function transcribeAudio(audioBuf, mimeType, plan) {
  let lastErr = null;
  for (const name of [plan.primary, plan.fallback].filter(Boolean)) {
    try {
      const out = await TRANSCRIBERS[name](audioBuf, mimeType);
      return { ...out, provider: name, fellBack: name !== plan.primary };
    } catch (e) {
      lastErr = e;
      logger.warn('[dictate] transcription failed', {
        provider: name, status: e && e.status || null, message: String(e && e.message || e).slice(0, 300),
      });
    }
  }
  // No provider error text in the client-visible error — it is logged above.
  throw new HttpsError('internal', 'Transcription failed');
}

// ─── Claude call helper ────────────────────────────────────────
// Uses raw fetch against Anthropic's API rather than going through
// the claudeProxy onRequest endpoint — same secret, same provider,
// but skipping the proxy avoids a second network hop + double-auth.
async function callClaudeForDictate({ system, userText, maxTokens, apiKey }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'Anthropic-Version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn('[dictate] Claude error', { status: res.status, body: body.slice(0, 300) });
    throw new HttpsError('internal', 'AI processing failed');
  }
  const data = await res.json();
  await require('./ai-spend').recordAiSpend(require('./ai-spend').rowFromAnthropic('dictate', 'claude-haiku-4-5-20251001', data), { log: logger });
  const text = (data?.content?.[0]?.text || '').trim();
  return {
    text,
    usage: data?.usage || null,
  };
}

// Robust JSON parse that tolerates the model occasionally wrapping
// output in ```json ... ``` despite the prompt. Returns null on
// unparseable input rather than throwing — caller can decide what
// to do with the failure (e.g. fall back to overview-only).
function safeJsonParse(s) {
  if (typeof s !== 'string') return null;
  let trimmed = s.trim();
  // Strip a markdown fence if present.
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // Last-resort: extract the first balanced { ... } object.
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// dictate — unified transcribe + AI-process callable
// ═══════════════════════════════════════════════════════════════
exports.dictate = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    memory: '512MiB',
    secrets: [SECRETS.GROQ_API_KEY, SECRETS.DEEPGRAM_API_KEY, ANTHROPIC_API_KEY],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
    // dictate spends both Groq (transcription) and Anthropic (cleanup) per
    // call, same as the other rep-initiated AI callables this flag covers.
    if (await require('./integrations/killswitch').isAiDisabled()) {
      throw new HttpsError('unavailable', 'AI temporarily disabled');
    }

    // Per-uid rate limit. 30/hr is generous for an active dictator
    // — the W128 click-to-toggle UI naturally tops out around
    // ~5/min during a session, far below this ceiling — but kills
    // a runaway loop cheaply.
    const { enforceRateLimit } = require('./integrations/upstash-ratelimit');
    try {
      await enforceRateLimit('callable:dictate:uid', uid, 30, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) throw new HttpsError('resource-exhausted', 'Rate limit — try again in an hour.');
      throw e;
    }

    let anthKey;
    anthKey = secretValue(ANTHROPIC_API_KEY); // '__unset__' stub → null
    const plan = pickDictationProvider({
      preferred: PROVIDERS.voiceTranscription,
      hasGroq: hasSecret('GROQ_API_KEY'),
      hasDeepgram: hasSecret('DEEPGRAM_API_KEY'),
    });
    if (!plan) throw new HttpsError('failed-precondition', 'Voice transcription not configured.');
    if (!anthKey) throw new HttpsError('failed-precondition', 'AI processing not configured.');

    // ── Input validation ────────────────────────────────────
    const audioB64 = typeof request.data?.audioBase64 === 'string'
      ? request.data.audioBase64 : '';
    const mimeType = typeof request.data?.mimeType === 'string'
      ? request.data.mimeType : 'audio/webm';
    const mode = ALLOWED_MODES.has(request.data?.mode) ? request.data.mode : 'clean';
    // W134 fix: validate todayLocal as YYYY-MM-DD before letting it
    // anywhere near the Claude system prompt. Previously the value
    // was concatenated directly into the prompt text — a malicious
    // (or buggy) caller could smuggle prompt-injection text via the
    // todayLocal field. Strict regex match: 10 chars exactly, all
    // digits + dashes in the right positions. Anything else gets
    // dropped to null and the prompt falls back to the no-hint path.
    const todayLocal = (typeof request.data?.todayLocal === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(request.data.todayLocal))
      ? request.data.todayLocal : null;

    if (!audioB64 || audioB64.length < 100) {
      throw new HttpsError('invalid-argument', 'Missing audio');
    }
    if (audioB64.length > MAX_AUDIO_BYTES * 2) {
      throw new HttpsError('invalid-argument', 'Clip too long (max 60s)');
    }
    const audioBuf = Buffer.from(audioB64, 'base64');
    if (audioBuf.length > MAX_AUDIO_BYTES) {
      throw new HttpsError('invalid-argument', 'Clip too large');
    }

    // ── 1. Transcribe ───────────────────────────────────────
    const t0 = Date.now();
    const { transcript, confidence, provider, fellBack } = await transcribeAudio(audioBuf, mimeType, plan);
    const transcribeMs = Date.now() - t0;
    if (fellBack) logger.info('[dictate] used fallback transcriber', { provider, primary: plan.primary });

    if (!transcript) {
      return {
        success: true,
        mode,
        provider,
        transcript: '',
        cleaned: '',
        confidence: null,
        empty: true,
      };
    }

    // ── 2. Branch on mode ───────────────────────────────────
    if (mode === 'clean') {
      const t1 = Date.now();
      const { text, usage } = await callClaudeForDictate({
        system: CLEAN_PROMPT,
        userText: transcript,
        // Output rarely exceeds input length for cleanup. 200 token
        // floor for short utterances, +200 over the input length for
        // longer dictations.
        maxTokens: Math.min(1500, Math.max(200, Math.ceil(transcript.length / 2) + 200)),
        apiKey: anthKey,
      });
      return {
        success: true,
        mode: 'clean',
        provider,
        transcript,
        cleaned: text || transcript,
        confidence,
        timing: { transcribeMs, cleanMs: Date.now() - t1 },
        usage,
      };
    }

    if (mode === 'summarize') {
      const t1 = Date.now();
      const todayHint = todayLocal ? `\n\nToday is ${todayLocal} (rep's local date).` : '';
      const { text, usage } = await callClaudeForDictate({
        system: SUMMARIZE_PROMPT + todayHint,
        userText: transcript,
        maxTokens: 1200,
        apiKey: anthKey,
      });
      const parsed = safeJsonParse(text);
      // If JSON parse fails, downgrade to overview-only so the user
      // still sees something useful instead of a hard error.
      if (!parsed) {
        return {
          success: true,
          mode: 'summarize',
          provider,
          transcript,
          confidence,
          summary: { overview: text || transcript, actionItems: [], people: [], addresses: [], amounts: [], dates: [], category: 'other' },
          timing: { transcribeMs, summarizeMs: Date.now() - t1 },
          usage,
          parseFailure: true,
        };
      }
      return {
        success: true,
        mode: 'summarize',
        provider,
        transcript,
        confidence,
        summary: {
          overview:    parsed.overview || '',
          actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
          people:      Array.isArray(parsed.people) ? parsed.people : [],
          addresses:   Array.isArray(parsed.addresses) ? parsed.addresses : [],
          amounts:     Array.isArray(parsed.amounts) ? parsed.amounts : [],
          dates:       Array.isArray(parsed.dates) ? parsed.dates : [],
          category:    parsed.category || 'other',
        },
        timing: { transcribeMs, summarizeMs: Date.now() - t1 },
        usage,
      };
    }

    if (mode === 'extract-tasks') {
      const t1 = Date.now();
      const todayHint = todayLocal ? `\n\nToday is ${todayLocal} (rep's local date).` : '';
      const { text, usage } = await callClaudeForDictate({
        system: EXTRACT_TASKS_PROMPT + todayHint,
        userText: transcript,
        maxTokens: 800,
        apiKey: anthKey,
      });
      const parsed = safeJsonParse(text);
      const tasks = (parsed && Array.isArray(parsed.tasks)) ? parsed.tasks
        .filter(t => t && typeof t.text === 'string' && t.text.trim())
        .slice(0, 8)  // hard cap server-side too
        .map(t => ({
          text: String(t.text).trim().slice(0, 200),
          dueDate: (typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate))
            ? t.dueDate : null,
        })) : [];
      return {
        success: true,
        mode: 'extract-tasks',
        provider,
        transcript,
        confidence,
        tasks,
        timing: { transcribeMs, extractMs: Date.now() - t1 },
        usage,
        parseFailure: !parsed,
      };
    }

    // Unreachable due to ALLOWED_MODES gate.
    throw new HttpsError('invalid-argument', 'Unknown mode');
  }
);

module.exports = exports;
