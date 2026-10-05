/**
 * integrations/killswitch.js — global feature kill-switches (Audit #4 Phase 4)
 *
 * A single Firestore doc `feature_flags/global` holds emergency switches that
 * take effect WITHOUT a deploy or secret rotation — one write to flip them.
 * The hot path (claudeProxy, publicVisualizerAI, publicFunnelAI, adminAI,
 * analyzePhotoVision, visualizerImageGen, extractReceiptData, dictate,
 * previewAiPersona, analyzeRoofPhoto, transcribeVoiceMemo) reads this via a
 * 60-second in-memory cache, so the cost is ~1 Firestore read per minute per warm instance, not
 * one per request.
 *
 * Flags:
 *   aiDisabled: true         → all eleven AI endpoints above fail closed
 *                              (503 / unavailable) — rep-initiated, admin,
 *                              AND the two unauthenticated public ones
 *                              (publicVisualizerAI, publicFunnelAI). Does
 *                              NOT cover the automated/unattended surfaces
 *                              below — those are deliberately on their own
 *                              flags.
 *   webLeadMeasureDisabled: true → stop measuring public estimate leads
 *                              (integrations/public-measure.js; $3 a lead)
 *   autoMeasureDisabled: true → stop the CRM auto-order of the same measure
 *                              (integrations/measure-auto-order.js, 2026-10-04);
 *                              autoMeasureDailyCap / autoMeasureMonthlyCap
 *                              (numbers) override its default caps. Read via
 *                              getFlags(), not a dedicated isX() helper.
 *   voiceIntelDisabled: true → stop the voice-memo transcribe+analyze
 *                              pipeline (integrations/voice-intelligence.js
 *                              onAudioUploaded; Groq + Anthropic spend)
 *   aiDraftDisabled: true    → stop generateAIDraft() (handlers/ai-texting.js),
 *                              the one Anthropic call behind every
 *                              AI-suggested reply: inbound SMS
 *                              (sms-functions.js incomingSMS), inbound
 *                              homeowner portal messages
 *                              (sms-functions.js onPortalMessageDraft), and
 *                              admin unmatched-SMS convert
 *                              (handlers/inbound-sms-convert.js
 *                              convertUnmatchedSms). Gated inside
 *                              generateAIDraft itself so all three (and any
 *                              future caller) share one switch.
 *
 * To pull the switch in an emergency (see SPEND_KILLSWITCH.md runbook):
 *   firebase firestore:... or in console: set feature_flags/global.aiDisabled = true
 *
 * FAIL-OPEN BY DESIGN: if the flag read throws (Firestore blip), we treat it
 * as "not disabled" and reuse the last-known value. A transient Firestore
 * error must not take down all AI — the switch is for deliberate emergencies,
 * where the operator can confirm it took effect.
 */
'use strict';

const { getFirestore } = require('firebase-admin/firestore');

const TTL_MS = 60_000;
let _cache = { at: 0, flags: {} };

async function getFlags() {
  const now = Date.now();
  if (now - _cache.at < TTL_MS) return _cache.flags;
  try {
    const snap = await getFirestore().doc('feature_flags/global').get();
    _cache = { at: now, flags: (snap.exists && snap.data()) || {} };
  } catch (e) {
    // Fail open: keep serving with the last-known flags, but advance the
    // timestamp so a Firestore outage doesn't hammer reads every request.
    _cache.at = now;
  }
  return _cache.flags;
}

async function isAiDisabled() {
  const f = await getFlags();
  return f.aiDisabled === true;
}

// Automated roof measurement of public estimate leads. Its own flag, because
// this one spends a metered vendor budget rather than AI tokens and an
// operator may well want to stop it without darkening the AI surfaces.
async function isWebLeadMeasureDisabled() {
  const f = await getFlags();
  return f.webLeadMeasureDisabled === true;
}

// Voice-memo pipeline (onAudioUploaded). Own flag for the same reason as
// webLeadMeasureDisabled above — an operator may want to stop voice
// transcription/analysis spend specifically without darkening claudeProxy,
// photo-vision, etc.
async function isVoiceIntelDisabled() {
  const f = await getFlags();
  return f.voiceIntelDisabled === true;
}

// generateAIDraft() (handlers/ai-texting.js) — the AI-suggested-reply draft
// shared by incomingSMS, onPortalMessageDraft, and convertUnmatchedSms. Own
// flag, same reasoning as the others: an operator stopping drafted replies
// shouldn't also stop claudeProxy or voice intel.
async function isAiDraftDisabled() {
  const f = await getFlags();
  return f.aiDraftDisabled === true;
}

// Test hook — clears the cache so unit tests can assert fresh reads.
function _resetCache() { _cache = { at: 0, flags: {} }; }

module.exports = {
  getFlags,
  isAiDisabled,
  isWebLeadMeasureDisabled,
  isVoiceIntelDisabled,
  isAiDraftDisabled,
  _resetCache
};
