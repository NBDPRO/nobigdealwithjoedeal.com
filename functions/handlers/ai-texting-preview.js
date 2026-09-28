/**
 * functions/handlers/ai-texting-preview.js — T-4: persona live preview
 * ═══════════════════════════════════════════════════════════════════
 *
 * Backs the "Preview draft" button in Settings → AI Texting. Takes the
 * persona config the rep is editing (NOT yet saved) plus an optional
 * sample inbound message, builds the same system prompt the live draft
 * path uses (handlers/ai-persona.buildPersonaPrompt — guardrails locked),
 * and returns a sample reply. No Firestore write, no lead — a synthetic
 * first-touch context so the rep SEES what the sliders do before saving.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { callableRateLimit, assertNotViewer } = require('../shared');
const { CORS_ORIGINS } = require('./_shared');
const { secretValue } = require('../integrations/_shared'); // the secret registry, not handlers/_shared
const { buildPersonaPrompt } = require('./ai-persona');
const { callClaudeForDraft, ANTHROPIC_API_KEY } = require('./ai-texting');

const SAMPLE_DEFAULT = 'Hey, saw your truck in the neighborhood. How much would a new roof run me?';

// Synthetic first-touch context (mirrors buildLeadContext's shape) so the
// preview reads like a real inbound SMS without touching the database.
function buildSampleContext(sampleMessage) {
  return [
    '═══ WHO THIS IS ═══',
    'Name: Sample Homeowner',
    'Address: 123 Maple St',
    'Relationship: Active lead — stage new',
    '',
    '═══ RECENT TEXT THREAD ═══',
    '(no prior text history — this is the first inbound SMS from this lead)',
    '',
    '═══ THE NEW INBOUND MESSAGE TO REPLY TO ═══',
    sampleMessage,
  ].join('\n');
}

exports.previewAiPersona = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 20,
    memory: '256MiB',
    secrets: [ANTHROPIC_API_KEY],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B, #1780 review): a viewer is refused. Each preview
    // bills a live Claude call, and the persona it previews only shapes AI
    // drafts of texts to homeowners — which a viewer can neither approve nor
    // send (sendSMS refuses a viewer; the draft rows are rules-refused). So
    // the spend buys a viewer nothing. The panel's own catch prints the
    // server's message ("Couldn't generate a preview. Your role is view-only").
    assertNotViewer(request.auth.token);

    // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
    if (await require('../integrations/killswitch').isAiDisabled()) {
      throw new HttpsError('unavailable', 'AI temporarily disabled');
    }

    // Each preview is a live Claude call (~$0.0003) — cap to a sane
    // interactive rate so a stuck slider can't hammer the API.
    await callableRateLimit(request, 'previewAiPersona', 60, 3_600_000);

    let apiKey;
    apiKey = secretValue(ANTHROPIC_API_KEY); // '__unset__' stub → null
    if (!apiKey) throw new HttpsError('failed-precondition', 'AI texting is not configured yet.');

    const cfg = (request.data && request.data.config) || {};
    const sample = String((request.data && request.data.sampleMessage) || SAMPLE_DEFAULT).slice(0, 500);

    let system;
    try {
      system = buildPersonaPrompt(cfg);
    } catch (e) {
      logger.warn('[previewAiPersona] prompt build failed', { uid, err: e.message });
      throw new HttpsError('invalid-argument', 'Could not build a prompt from that persona.');
    }

    try {
      const { text } = await callClaudeForDraft({
        system,
        userText: buildSampleContext(sample),
        maxTokens: 280,
        apiKey,
      });
      return { draftText: (text || '').trim(), sampleMessage: sample };
    } catch (e) {
      logger.warn('[previewAiPersona] generation failed', { uid, err: e.message });
      throw new HttpsError('internal', 'Could not generate a preview right now.');
    }
  }
);
