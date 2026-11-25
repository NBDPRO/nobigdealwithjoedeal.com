'use strict';

/**
 * functions/ai-prompts.js — claudeProxy's prompt registry (2026-11-25,
 * roadmap step 15; audit §3.2).
 *
 * Today the browser sends claudeProxy a raw system prompt. Where the prompt
 * is FIXED (the same text every call), the browser can instead send
 *   { promptId: '<id>', variables: { name: value, ... } }
 * and the server supplies the system prompt from PROMPTS below, so a page
 * (or anyone holding a session) cannot rewrite it.
 *
 *   promptFromBody(body[, registry])
 *     null                          no promptId: the free-form path, unchanged
 *     { ok: true, system, promptId } a registered prompt, variables filled in
 *     { ok: false, status: 400, error }  refused: unknown promptId, promptId
 *                                   AND a raw system, an undeclared or missing
 *                                   variable, or a variable that is not text
 *
 * Variables: a prompt declares each one (vars: { name: { maxLen } }) and
 * marks where it goes with {{name}}. A value is text (a string or a finite
 * number), capped at maxLen, and has < > swapped for ‹ › so it can never
 * open or close a fence tag in the prompt (AI prompts treat outside text as
 * data). Every declared variable is required.
 *
 * The three prompts below are the fixed prompts of three browser callers
 * (`source`), copied word for word; the step-15 suite decodes each page's
 * literal and checks the copy still matches. Those callers still send the prompt themselves: the
 * browser half is a later PR, after this server half is live. A claudeProxy
 * that predates this file ignores promptId and would run the call with no
 * system prompt at all, and the demo / offline answer paths
 * (docs/pro/js/demo-mode.js, docs/pro/demo-sdk/) need the same switch. (The
 * switch itself REMOVES prompt text from the shipped scripts, so the
 * dashboard's shipped-bytes budget is not what holds it back.)
 * FREE_FORM_CALLERS lists every browser caller and why it is still free-form.
 */

const PROMPTS = Object.freeze({
  // docs/pro/js/nbd-whisper.js _cleanWithClaude (feature 'whisper-clean')
  'whisper-clean': Object.freeze({
    source: 'docs/pro/js/nbd-whisper.js',
    system: 'You are a copy editor. Take the user\'s spoken transcript and return ONLY the cleaned text, with these rules:\n'
      + '1. Strip filler words like "um", "uh", "like", "you know", "I mean", "sort of", "kind of".\n'
      + '2. Add proper punctuation and capitalization.\n'
      + '3. Keep the speaker\'s voice and word choice — do not paraphrase or summarize.\n'
      + '4. If the speaker said a voice command like "new paragraph", insert a paragraph break.\n'
      + '5. Return ONLY the cleaned text. No quotes, no commentary, no preamble.',
    vars: Object.freeze({}),
  }),
  // docs/pro/js/d2d-tracker-core-2026b.js D2D coach (feature 'rep-coach')
  'rep-coach': Object.freeze({
    source: 'docs/pro/js/d2d-tracker-core-2026b.js',
    system: 'You are an elite door-to-door roofing sales coach. From the rep\'s stats, give a SHORT, punchy, encouraging daily game plan. Use exactly these four one-line sections with emoji: "⏰ Best window:", "📍 Where to knock:", "🎯 Improve one thing:", "💬 Objection to practice:". Be specific to their numbers. Max ~140 words, plain text.',
    vars: Object.freeze({}),
  }),
  // docs/pro/js/maps-routing.js measurement-report AI fallback
  'measurement-extract': Object.freeze({
    source: 'docs/pro/js/maps-routing.js',
    system: 'Extract roofing measurements from this report text. Return ONLY a JSON object with these fields (numbers only, no units): totalArea, ridgeLF, hipLF, valleyLF, eaveLF, rakeLF, perimLF, pitch, squares, facets. If a field is not found, omit it.',
    vars: Object.freeze({}),
  }),
});

// Every browser caller of window.callClaude / claudeProxy that still sends a
// raw system prompt (2026-11-25), and why.
const FREE_FORM_CALLERS = Object.freeze([
  { file: 'docs/pro/js/nbd-whisper.js', why: 'fixed prompt, registered as whisper-clean; the browser sends promptId once this server half is live' },
  { file: 'docs/pro/js/d2d-tracker-core-2026b.js', why: 'fixed prompt, registered as rep-coach; the browser sends promptId once this server half is live' },
  { file: 'docs/pro/js/maps-routing.js', why: 'fixed prompt, registered as measurement-extract; the browser sends promptId once this server half is live' },
  { file: 'docs/pro/js/ai.js', why: 'Ask Joe: buildJoeSystemPrompt(ctx) assembles the prompt from live CRM context (needs variables first)' },
  { file: 'docs/pro/js/pages/ask-joe-main.js', why: 'Ask Joe page: the prompt is built in the page' },
  { file: 'docs/pro/js/pages/ai-tree.js', why: 'the prompt is built per decision-tree node' },
  { file: 'docs/pro/js/pages/understand.js', why: 'appends the contractor\'s pipeline data to the prompt' },
  { file: 'docs/pro/js/project-codex-page.js', why: 'two calls: one built per project, one fixed document prompt (register next)' },
  { file: 'docs/pro/js/property-intel.js', why: 'posts to claudeProxy directly (not window.callClaude)' },
  { file: 'docs/pro/js/rep-report-generator.js', why: 'fixed sales-coach prompt (register next)' },
  { file: 'docs/pro/js/smart-followup.js', why: 'fixed AI_SYSTEM_PROMPT (register next)' },
  { file: 'docs/pro/js/pages/social-studio.js', why: 'fixed AI_SYSTEM caption prompt (register next)' },
  { file: 'docs/pro/js/tools.js', why: 'Quick Measure import (Sonnet 5.5): check its prompt when migrating' },
]);

const refuse = (error) => ({ ok: false, status: 400, error });
const fenceSafe = (s) => String(s).replace(/</g, '‹').replace(/>/g, '›');

function promptFromBody(body, registry) {
  const b = body || {};
  if (b.promptId === undefined || b.promptId === null) return null;
  const reg = registry || PROMPTS;
  if (typeof b.promptId !== 'string' || !Object.prototype.hasOwnProperty.call(reg, b.promptId)) return refuse('Unknown promptId');
  if (b.system !== undefined && b.system !== null) return refuse('Send a promptId or a system prompt, not both');
  const p = reg[b.promptId];
  const declared = p.vars || {};
  const given = (b.variables && typeof b.variables === 'object' && !Array.isArray(b.variables)) ? b.variables : {};
  if (b.variables !== undefined && given !== b.variables) return refuse('variables must be an object');
  for (const k of Object.keys(given)) if (!Object.prototype.hasOwnProperty.call(declared, k)) return refuse('Unknown variable ' + JSON.stringify(k) + ' for promptId ' + b.promptId);
  const values = {};
  for (const k of Object.keys(declared)) {
    const v = given[k];
    if (v === undefined || v === null) return refuse('Missing variable ' + JSON.stringify(k));
    if (!(typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) return refuse('Variable ' + JSON.stringify(k) + ' must be text');
    const cap = Number(declared[k] && declared[k].maxLen) || 200;
    values[k] = fenceSafe(String(v).slice(0, cap));
  }
  const system = p.system.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m));
  return { ok: true, system, promptId: b.promptId };
}

module.exports = { PROMPTS, FREE_FORM_CALLERS, promptFromBody };
