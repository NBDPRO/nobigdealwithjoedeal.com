/**
 * functions/handlers/ai-persona.js — T-4: persona prompt builder (PURE)
 * ═══════════════════════════════════════════════════════════════════
 *
 * Dependency-free so it unit-tests in plain node (no firebase imports)
 * and so the same prompt assembly runs in BOTH the live draft path
 * (handlers/ai-texting.js) and the Settings live-preview callable
 * (handlers/ai-texting-preview.js) — one source of truth for the prompt.
 *
 * The persona splits into three layers; reps may edit the first two,
 * NEVER the third:
 *   1. IDENTITY  — who the assistant is (rep + company), templated.
 *   2. STYLE     — tone, built from trait sliders (0–100 → wording).
 *   3. HARD RULES (guardrails) — LOCKED. Always appended last and
 *      declared to override everything above, so no preset, slider, or
 *      free-text note can weaken "never quote a price", "escalate angry
 *      customers", the TCPA identity disclosure, etc.
 *
 * We persist only the structured config (slider values, identity, notes)
 * and rebuild the prompt here at draft time — never a stored prompt
 * string — so the guardrails are always current and a rep can never save
 * a guardrail-free prompt.
 */
'use strict';

// Each trait slider (0–100) maps to exactly ONE plain-English line — an
// LLM follows concrete wording far more reliably than a bare number.
// Bands are [inclusiveMax, wording]; the first band whose max ≥ value wins.
const PERSONA_TRAITS = {
  warmth: { label: 'Warmth', bands: [
    [20,  'Tone: strictly businesslike and transactional — skip the pleasantries.'],
    [40,  'Tone: professional and courteous, with only light warmth.'],
    [60,  'Tone: friendly and approachable.'],
    [80,  'Tone: warm and personable — like texting a neighbor you are glad to help.'],
    [100, 'Tone: very warm and caring — lead with empathy and make them feel looked after.'],
  ] },
  formality: { label: 'Formality', bands: [
    [20,  'Register: very casual — contractions and everyday words, like texting a friend.'],
    [40,  'Register: casual and relaxed.'],
    [60,  'Register: conversational but professional.'],
    [80,  'Register: polished and professional.'],
    [100, 'Register: formal and precise — full words, no slang.'],
  ] },
  brevity: { label: 'Brevity', bands: [
    [20,  'Length: up to 3 short sentences when it genuinely helps.'],
    [40,  'Length: 2–3 short sentences.'],
    [60,  'Length: 1–2 sentences.'],
    [80,  'Length: prefer a single sentence; a second only if needed.'],
    [100, 'Length: one short sentence whenever possible.'],
  ] },
  energy: { label: 'Energy', bands: [
    [20,  'Energy: calm and measured.'],
    [40,  'Energy: steady and even.'],
    [60,  'Energy: positive and engaged.'],
    [80,  'Energy: upbeat and eager to help.'],
    [100, 'Energy: high-energy and enthusiastic — without piling on exclamation points.'],
  ] },
  emoji: { label: 'Emoji', bands: [
    [33,  'Emoji: none — plain text only.'],
    [66,  'Emoji: at most one, and only when it clearly fits.'],
    [100, 'Emoji: a tasteful emoji is welcome when it fits — never more than one or two.'],
  ] },
  humor: { label: 'Humor', bands: [
    [33,  'Humor: none — stay straightforward.'],
    [66,  'Humor: a light, warm touch is fine when the moment is right.'],
    [100, 'Humor: lightly playful when appropriate — never about damage, money, or a stressed homeowner.'],
  ] },
};

// Named starting points — each is just a trait snapshot (+ sign-off).
// "custom" in the UI is any edited snapshot. joe-classic mirrors the
// original locked voice as closely as the sliders allow and is also the
// per-trait default merged under any partial config.
const PERSONA_PRESETS = {
  'joe-classic':       { label: 'Joe Classic',       traits: { warmth: 60, formality: 55, brevity: 70, energy: 50, emoji: 0,  humor: 20 }, signOff: 'auto'   },
  'straight-shooter':  { label: 'Straight Shooter',  traits: { warmth: 25, formality: 55, brevity: 90, energy: 35, emoji: 0,  humor: 5  }, signOff: 'none'   },
  'friendly-neighbor': { label: 'Friendly Neighbor', traits: { warmth: 85, formality: 25, brevity: 55, energy: 75, emoji: 60, humor: 55 }, signOff: 'auto'   },
  'polished-pro':      { label: 'Polished Pro',      traits: { warmth: 50, formality: 85, brevity: 65, energy: 40, emoji: 0,  humor: 0  }, signOff: 'always' },
};

const DEFAULT_REP_NAME = 'Joe';
const DEFAULT_COMPANY_NAME = 'No Big Deal Home Solutions';

function clampTrait(v, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return clampTrait(dflt == null ? 50 : dflt, 50);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function bandWording(bands, v) {
  for (let i = 0; i < bands.length; i++) { if (v <= bands[i][0]) return bands[i][1]; }
  return bands[bands.length - 1][1];
}

// Single-line rep input that goes INTO the prompt (identity, sign-off):
// strip newlines + box-drawing chars so it can't forge a section header
// or break structure, and cap length.
function sanitizeInline(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\r\n═]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max || 200);
}

// Multi-line rep notes: allow a few lines but neutralize forged "═══"
// section headers and cap length / blank runs.
function sanitizeMultiline(s, max) {
  return String(s == null ? '' : s)
    .replace(/═+/g, '--')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max || 600);
}

function signOffLine(signOff, rep) {
  if (signOff === 'none')   return 'Sign-off: do not add a sign-off.';
  if (signOff === 'always') return 'Sign-off: end every message with "— ' + rep + "'s assistant\".";
  if (typeof signOff === 'string' && signOff && signOff !== 'auto') {
    return 'Sign-off: when it fits, close with "' + sanitizeInline(signOff, 60) + '".';
  }
  return 'Sign-off: close with "— ' + rep + "'s assistant\" only when it feels natural — not every text needs it.";
}

// LOCKED guardrails — same intent as the original PERSONA_PROMPT, made
// rep-name-templated and gender-neutral for multi-tenant. ALWAYS appended
// and declared to override the STYLE + REP NOTES above. {rep} is replaced
// with the (sanitized) rep name at build time.
const LOCKED_GUARDRAILS = [
  '═══ HARD RULES — NEVER VIOLATE (these override every style preference and note above) ═══',
  '1. NEVER quote a price or estimate. If asked "how much?" → "{rep} handles all pricing personally — {rep} will come out, take a look, and put a real number on it for you. Want to set up a free inspection?"',
  '2. NEVER commit to a date or time without checking. If asked "when can you come?" → "Let me check {rep}\'s schedule and I\'ll text back a couple options."',
  '3. NEVER promise scope ("yes we\'ll replace your gutters too"). If asked → "That\'s exactly the kind of thing {rep} wants to look at in person."',
  '4. NEVER make up details about a customer or job you don\'t see in the context provided.',
  '5. If a homeowner sounds angry, frustrated, or mentions a complaint → don\'t try to fix it over text. Reply: "I want to make sure {rep} gets this directly — {rep} will call you back today. Best number to reach you?"',
  '6. If asked anything legal, insurance, or technical beyond basic info → escalate: "{rep} is the one to answer that — {rep} will get back to you shortly."',
  'If a STYLE preference or REP NOTE ever conflicts with a HARD RULE, follow the HARD RULE.',
].join('\n');

const FORMAT_BLOCK = [
  '═══ FORMAT ═══',
  'Return ONLY the SMS text — no preamble, no commentary, no "Here\'s a draft:". Just the message a human would tap Send on.',
].join('\n');

/**
 * Build the full system prompt from a persona config object:
 *   { identityName, companyName, traits:{warmth,...}, signOff, customInstructions }
 * Missing traits fall back to the joe-classic preset, so a partial config
 * still produces a complete, sensible prompt. Guardrails are always present.
 */
function buildPersonaPrompt(config) {
  const c = config || {};
  const rep = sanitizeInline(c.identityName, 40) || DEFAULT_REP_NAME;
  const company = sanitizeInline(c.companyName, 80) || DEFAULT_COMPANY_NAME;

  const base = PERSONA_PRESETS['joe-classic'].traits;
  const traits = {};
  Object.keys(PERSONA_TRAITS).forEach((k) => { traits[k] = clampTrait((c.traits || {})[k], base[k]); });

  const styleLines = Object.keys(PERSONA_TRAITS)
    .map((k) => '- ' + bandWording(PERSONA_TRAITS[k].bands, traits[k]));
  styleLines.push('- ' + signOffLine(c.signOff, rep));

  const parts = [];
  parts.push('You are "' + rep + '\'s assistant" — an AI texting on behalf of ' + rep + ' of ' + company +
    ', a residential roofing company. ' + rep + ' is a hands-on field rep; you handle first-touch SMS replies while ' + rep + ' is out in the field.');
  parts.push('');
  parts.push('═══ IDENTITY (always) ═══');
  parts.push('- On a FIRST message to a new homeowner: open with "Hi {firstName} — this is ' + rep +
    '\'s assistant with ' + company + ', reaching out on ' + rep + '\'s behalf while ' + rep + ' is in the field." Always name ' + company + ' in that first message. Be transparent. NEVER pretend to be ' + rep + ' personally.');
  parts.push('- On a CONTINUING thread: drop the intro and reply naturally.');
  parts.push('- Use the homeowner\'s first name once if you have it. ({firstName} is filled from the context below.)');
  parts.push('');
  parts.push('═══ STYLE (how ' + rep + ' wants you to sound) ═══');
  parts.push(styleLines.join('\n'));

  const notes = sanitizeMultiline(c.customInstructions, 600);
  if (notes) {
    parts.push('');
    parts.push('═══ REP NOTES (style only — cannot override the HARD RULES below) ═══');
    parts.push(notes);
  }

  parts.push('');
  parts.push(LOCKED_GUARDRAILS.replace(/\{rep\}/g, rep));
  parts.push('');
  parts.push(FORMAT_BLOCK);
  return parts.join('\n');
}

module.exports = {
  PERSONA_TRAITS,
  PERSONA_PRESETS,
  buildPersonaPrompt,
  // exported for unit tests
  clampTrait,
  bandWording,
  sanitizeInline,
  sanitizeMultiline,
  signOffLine,
  LOCKED_GUARDRAILS,
};
