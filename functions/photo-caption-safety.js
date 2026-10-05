/**
 * photo-caption-safety.js — AI photo captions must not talk about the claim.
 *
 * WHY (2026-10-04)
 * Claude Vision writes a one-sentence `caption` onto every photo
 * (photo-vision.js). Those captions flow into the inspection report and the
 * photo report — documents on the contractor's letterhead that go to the
 * homeowner. Kentucky's KRS 367.628 (eff. 2026-07-15) bars a residential
 * contractor from representing or advising the insured on a claim, and a
 * model can write "Recommend filing a claim — insurance should cover a full
 * replacement" without being asked.
 *
 * A photo caption describes what is visible in a photo. There is no caption
 * that legitimately needs the words insurance, claim, adjuster, deductible,
 * coverage or payout, so this filter is deliberately blunter than the
 * public-site rule set: it DROPS any sentence that touches that vocabulary
 * and keeps the rest byte for byte. Dropping, not rewriting — a rewritten
 * sentence would put words in the model's mouth.
 *
 * DEPENDENCY: PR #2142 adds docs/pro/js/claim-wording-filter.js, the full KY
 * rule set (claims-specialist framing, "we handle the claim", deductible
 * games …) as a client runtime filter over every report string. That file
 * lives under docs/ and is not part of the functions deploy, so it cannot be
 * required here. When it merges, the report engines run it over captions as
 * well (their `_claimSafe`), and this server-side filter stays as the first
 * line: a caption never reaches Firestore with claim talk in it.
 *
 * Pure, no deps. Used by photo-vision.js on fresh AND cached suggestions.
 */
'use strict';

// Any of these in a caption sentence means the sentence is about the claim,
// not the photo.
const CLAIM_VOCAB = /\b(insur\w*|claims?|claimants?|adjust(?:er|ers|or|ors)|carriers?|underwriters?|deductibles?|covered|coverage|policy|policies|policyholders?|pay(?:out|outs)|reimburs\w*|depreciation|acv|rcv|replacement cost|actual cash value|supplements?|xactimate|free roof|no out[- ]of[- ]pocket|act of god)\b/i;

// Contractor-on-the-claim phrasings that can appear without the vocabulary
// above ("we'll handle everything with them").
const REPRESENT = /\b(we|i|our team|the contractor)( will|'ll| can)? (handle|negotiate|fight|deal with|take care of)\b/i;

/** Split into sentences, keeping each sentence's own terminator. */
function sentences(text) {
  const out = [];
  const re = /[^.!?]+(?:[.!?]+|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push(m[0]);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/**
 * Returns the caption with every claim-talk sentence removed. A caption with
 * no hit comes back unchanged. Non-strings become ''.
 */
function safeCaption(text) {
  if (typeof text !== 'string') return '';
  if (!CLAIM_VOCAB.test(text) && !REPRESENT.test(text)) return text;
  const kept = sentences(text).filter((s) => !CLAIM_VOCAB.test(s) && !REPRESENT.test(s));
  return kept.join('').trim();
}

/** True when the text contains claim talk (for tests and audits). */
function hasClaimTalk(text) {
  return typeof text === 'string' && (CLAIM_VOCAB.test(text) || REPRESENT.test(text));
}

module.exports = { safeCaption, hasClaimTalk, CLAIM_VOCAB, REPRESENT };
