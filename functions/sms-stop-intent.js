/**
 * functions/sms-stop-intent.js — what an inbound text is asking for
 * ═══════════════════════════════════════════════════════════════════
 *
 * THE GAP THIS CLOSES (texting review, 2026-10-05, Jo approved the fix)
 *
 * incomingSMS honoured an opt-out only when the WHOLE message, upper-cased and
 * trimmed, was one of STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT. So:
 *
 *   "Stop."            → not an opt-out (the full stop)
 *   "Stop texting me"  → not an opt-out (a phrase)
 *   "REVOKE", "OPTOUT" → not an opt-out (keywords the browser triage and
 *                         Twilio's own STOP list already treat as one)
 *
 * Each of those fell through to the AI draft step, which wrote a reply the rep
 * could send in one tap — to someone who had just said stop. The FCC's 2025
 * revocation rule says consent can be revoked "by any reasonable means", and a
 * plain-English "stop texting me" is the most reasonable means there is.
 *
 * This module is the one place that decides. Pure, no Firestore, so the
 * decision table is unit-tested (tests/sms-stop-intent-2026-10-05.test.js).
 *
 * HOW IT DECIDES
 *
 *   1. Normalise: upper-case, every non-letter/digit becomes a space, runs of
 *      space collapse. "Stop." / "STOP!!" / " stop " all become "STOP", and
 *      "opt-out" becomes "OPT OUT".
 *   2. Whole-message keywords (the CTIA set plus REVOKE / OPTOUT / OPT OUT),
 *      optionally with a courtesy word around them: "STOP PLEASE",
 *      "PLEASE STOP", "STOP NOW", "STOP THANKS".
 *   3. Revocation phrases anywhere in the message: "stop texting me",
 *      "don't text me", "no more texts", "remove me from your list",
 *      "take me off", "unsubscribe me", "leave me alone", "lose my number"…
 *
 * What it must NOT catch is just as important: a homeowner writing "can you
 * stop by Tuesday?" or "cancel my Thursday appointment" is a customer, not an
 * opt-out. A keyword therefore only counts on its own (step 2); inside a
 * longer sentence only a phrase that is unmistakably about the texts counts
 * (step 3). When in doubt the answer is NOT an opt-out: the message still
 * reaches the rep, who can mark the number Do Not Text from the CRM.
 *
 * HELP / INFO and START / UNSTOP are whole-message keywords only, exactly as
 * before (a "yes" is not a resume — see the START comment in incomingSMS).
 */

'use strict';

/** Whole-message opt-out keywords (after normalise). */
const STOP_KEYWORDS = Object.freeze([
  'STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'REVOKE', 'OPTOUT', 'OPT OUT',
]);
const HELP_KEYWORDS = Object.freeze(['HELP', 'INFO']);
const START_KEYWORDS = Object.freeze(['START', 'UNSTOP']);

/** Courtesy words allowed around a whole-message keyword. */
const COURTESY = '(?:PLEASE|PLS|PLZ|NOW|THANKS|THANK YOU|THX|OK|OKAY)';

// The things a revocation is about. "ME" is optional where the phrase is
// already unambiguous ("stop texting", "no more texts").
const TEXT_NOUN = '(?:TEXT|TEXTS|TEXTING|MESSAGE|MESSAGES|MESSAGING|SMS|MSG|MSGS)';
const TEXT_VERB = '(?:TEXT|TEXTING|MESSAGE|MESSAGING|CONTACT|CONTACTING|SMS|SPAM|SPAMMING)';

/**
 * Revocation phrases, matched against the normalised message with word
 * boundaries. Every one names the texts (or the sender's list/number); none
 * is a bare "stop" or "cancel", which a customer uses for other things.
 */
const STOP_PHRASES = Object.freeze([
  // "stop texting me", "please stop messaging", "quit texting me"
  new RegExp('\\b(?:STOP|QUIT|CEASE)(?: SENDING(?: ME)?)? ' + TEXT_VERB + '\\b'),
  new RegExp('\\b(?:STOP|QUIT) SENDING(?: ME)?(?: THESE| THOSE| ANY| YOUR)? ' + TEXT_NOUN + '\\b'),
  new RegExp('\\b(?:STOP|QUIT) (?:ALL |THE |THESE |THOSE |YOUR )?' + TEXT_NOUN + '\\b'),
  // "don't text me", "do not contact me", "dont message me again"
  new RegExp('\\b(?:DO NOT|DONT|DON T|NEVER) (?:EVER )?' + TEXT_VERB + ' (?:ME|THIS NUMBER|US)\\b'),
  // "no more texts", "no more messages"
  new RegExp('\\bNO MORE ' + TEXT_NOUN + '\\b'),
  // "remove me", "take me off your list", "unsubscribe me", "opt me out"
  /\bREMOVE (?:ME|MY NUMBER|THIS NUMBER)\b/,
  /\bTAKE (?:ME|MY NUMBER|THIS NUMBER) OFF\b/,
  /\bUNSUBSCRIBE ME\b/,
  /\bOPT ME OUT\b/,
  /\bI (?:WANT TO |WOULD LIKE TO |WANNA )?(?:OPT OUT|UNSUBSCRIBE)\b/,
  /\bLEAVE ME ALONE\b/,
  /\bLOSE MY NUMBER\b/,
  /\bWRONG NUMBER STOP\b/,
  /\bI (?:DO NOT|DONT|DON T) WANT (?:ANY )?(?:MORE )?(?:YOUR )?(?:TEXT|TEXTS|MESSAGES)\b/,
]);

/** "Stop." → "STOP"; "opt-out" → "OPT OUT". */
function normalise(body) {
  return String(body == null ? '' : body)
    .toUpperCase()
    // Curly/straight apostrophes inside a word ("don't") collapse to nothing
    // so DONT and DON T both match; every other non-alphanumeric is a space.
    .replace(/[’']/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function wholeKeyword(norm, list) {
  for (const kw of list) {
    if (norm === kw) return kw;
    const around = new RegExp('^(?:' + COURTESY + ' )?' + kw.replace(/ /g, ' ') + '(?: ' + COURTESY + ')*$');
    if (around.test(norm)) return kw;
  }
  return '';
}

/**
 * @param {string} body  the inbound message, raw
 * @returns {{intent: 'stop'|'help'|'start'|null, keyword: string, match: 'keyword'|'phrase'|null}}
 *   keyword: the canonical keyword (or 'PHRASE') recorded with the opt-out.
 */
function classifyInbound(body) {
  const norm = normalise(body);
  if (!norm) return { intent: null, keyword: '', match: null };

  const stopKw = wholeKeyword(norm, STOP_KEYWORDS);
  if (stopKw) return { intent: 'stop', keyword: stopKw.replace(/ /g, ''), match: 'keyword' };

  // START before HELP is irrelevant (disjoint sets); both whole-message only.
  if (START_KEYWORDS.indexOf(norm) !== -1) return { intent: 'start', keyword: norm, match: 'keyword' };
  if (HELP_KEYWORDS.indexOf(norm) !== -1) return { intent: 'help', keyword: norm, match: 'keyword' };

  for (const re of STOP_PHRASES) {
    if (re.test(norm)) return { intent: 'stop', keyword: 'PHRASE', match: 'phrase' };
  }
  return { intent: null, keyword: '', match: null };
}

module.exports = {
  STOP_KEYWORDS,
  HELP_KEYWORDS,
  START_KEYWORDS,
  STOP_PHRASES,
  normalise,
  classifyInbound,
};
