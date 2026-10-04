/**
 * tests/dictate-transcription-provider.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Until 2026-09-04 the CRM's mic buttons (`dictate` callable) sent every clip
 * to Deepgram — metered — while the Voice Intelligence pipeline one file over
 * transcribed on Groq's free tier with a key that was already set. The fix
 * routes dictate through the same provider switch, with Deepgram demoted to
 * fallback.
 *
 * 2026-10-04: the Deepgram fallback was removed (VENDOR-COST-LOCKIN Lane C).
 * Its key was the deploy's __unset__ stub, so prod never reached it. This
 * now pins that dictate is Groq-only and can never be steered back to
 * Deepgram by a stale env value or a stray key.
 *
 * Pure-Node. Run: node tests/dictate-transcription-provider.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  pickDictationProvider,
  groqExtensionForMime,
  normalizeGroqTranscription,
} = require(path.join(ROOT, 'functions', 'integrations', 'transcription-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Strip comments so a source-contract assertion cannot pass (or fail) on
// prose — twice on 2026-09-04 a raw-text grep matched a comment.
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
}

console.log('\nPROVIDER CHOICE — Groq only (Deepgram fallback removed 2026-10-04)');
{
  ok('nothing configured → null (caller says failed-precondition)',
     pickDictationProvider({ hasGroq: false }) === null && pickDictationProvider() === null);
  ok('Groq configured → groq, no fallback',
     same(pickDictationProvider({ hasGroq: true }), { primary: 'groq', fallback: null }));
  ok('a Deepgram key alone no longer yields a provider (the dead fallback is gone)',
     pickDictationProvider({ preferred: 'deepgram', hasGroq: false, hasDeepgram: true }) === null);
  ok('a stale NBD_VOICE_TRANSCRIPTION_PROVIDER=deepgram cannot steer dictate off Groq',
     same(pickDictationProvider({ preferred: 'deepgram', hasGroq: true, hasDeepgram: true }), { primary: 'groq', fallback: null }));
}
console.log('\nGROQ FILENAME — Groq sniffs the container from the extension, not Content-Type');
{
  ok('audio/webm → webm', groqExtensionForMime('audio/webm') === 'webm');
  ok('audio/webm;codecs=opus → webm (the codec suffix Chrome adds)', groqExtensionForMime('audio/webm;codecs=opus') === 'webm');
  ok('audio/mp4 (iOS Safari MediaRecorder) → m4a', groqExtensionForMime('audio/mp4') === 'm4a');
  ok('audio/x-m4a → m4a', groqExtensionForMime('audio/x-m4a') === 'm4a');
  ok('audio/mpeg → mp3', groqExtensionForMime('audio/mpeg') === 'mp3');
  ok('audio/ogg → ogg', groqExtensionForMime('audio/ogg') === 'ogg');
  ok('audio/wav → wav', groqExtensionForMime('audio/wav') === 'wav');
  ok('unknown/empty → webm (the callable default mimeType)', groqExtensionForMime('') === 'webm' && groqExtensionForMime(undefined) === 'webm');
}

console.log('\nRESPONSE SHAPES — the client keeps reading transcript/cleaned; confidence is honest');
{
  const g = normalizeGroqTranscription({ text: '  Replace the north slope.  ', duration: 4.2, segments: [] });
  ok('Groq: transcript trimmed', g.transcript === 'Replace the north slope.');
  ok('Groq: confidence is null (Groq reports none) — not a made-up 1.0', g.confidence === null);
  ok('Groq: duration carried', g.durationSec === 4.2);
  ok('Groq: missing text → empty transcript, no throw', normalizeGroqTranscription({}).transcript === '' && normalizeGroqTranscription(null).transcript === '');

}

console.log('\nSOURCE CONTRACT — dictate.js is wired the way the table above assumes');
{
  const dictate = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'dictate.js'), 'utf8'));
  const voice = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'integrations', 'voice-intelligence.js'), 'utf8'));

  ok('dictate binds GROQ_API_KEY from the shared registry', /secrets:\s*\[[^\]]*SECRETS\.GROQ_API_KEY/.test(dictate));
  ok('dictate no longer binds, defines or calls Deepgram',
     !/DEEPGRAM_API_KEY|api\.deepgram\.com|transcribeDeepgram/.test(dictate));
  ok('voice-intelligence has no Deepgram dispatch arm left',
     !/case 'deepgram'|transcribeDeepgram/.test(voice));
  ok('dictate decides via pickDictationProvider', /pickDictationProvider\(/.test(dictate));
  ok('dictate checks configuration with hasSecret (the __unset__ stub is truthy)',
     /hasSecret\(\s*['"]GROQ_API_KEY['"]\s*\)/.test(dictate));
  ok('dictate calls the shared Buffer-based Groq helper', /transcribeGroqBuffer\(/.test(dictate));
  ok('voice-intelligence exports transcribeGroqBuffer', /transcribeGroqBuffer\s*[,}]/.test(voice.slice(voice.indexOf('module.exports = Object.assign')))
     || /^\s*transcribeGroqBuffer,\s*$/m.test(voice));
  ok('the Storage-based transcribeGroq delegates to the Buffer helper (one Groq request builder)',
     /return transcribeGroqBuffer\(\{/.test(voice) && (voice.match(/api\.groq\.com\/openai\/v1\/audio\/transcriptions/g) || []).length === 1);
  ok('the client-visible error carries no provider error text',
     !/HttpsError\(\s*'internal',\s*'Transcription failed',\s*\{/.test(dictate));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
