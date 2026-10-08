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
 *
 * 2026-10-07 (review R6-3-1, Jo approved): a STOP inside a longer reply.
 * "Not interested. Stop.", "No thanks stop", "Please stop. Not interested",
 * "stop sending these" and "I no longer want texts from you" were all intent
 * null — no opt-out, and an AI reply draft a rep could send in one tap. Now:
 *
 *   4. A STOP-family keyword that is its own clause ("Not interested. Stop.",
 *      "Stop - wrong person") — STOP / STOPALL / UNSUBSCRIBE / REVOKE /
 *      OPTOUT anywhere, CANCEL / END / QUIT as the first or last clause.
 *   5. A STOP-family keyword within three words of a refusal ("no thanks
 *      stop", "stop I'm not interested", "not interested, cancel").
 *   6. STOP / STOPALL / UNSUBSCRIBE / REVOKE / OPTOUT as the first word
 *      ("Stop wasting my time"), unless the next word makes it an errand —
 *      "stop BY", "stop AT", "stop THE water damage" stay customer messages.
 *      STOP as the LAST word counts when only courtesy or refusal words come
 *      before it ("please just stop", "ok stop"). UNSUBSCRIBE / STOPALL
 *      count anywhere ("how do I unsubscribe").
 *
 * And a new answer, 'possible_stop', for a STOP word this module cannot read
 * safely ("thanks but stop", "when will the crew stop", "I want to cancel").
 * It is NOT an opt-out (nothing is recorded), but every caller treats it as
 * "a person must read this first": incomingSMS writes no AI reply draft and
 * puts a high-priority "may be asking to stop" bell on the rep's dashboard;
 * the NBD text line flags the note and the bell the same way. Guessing
 * either way is worse — a false opt-out silences a customer who asked a
 * question, a missed one texts someone who said stop.
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
const COURTESY = '(?:PLEASE|PLS|PLZ|NOW|THANKS|THANK YOU|THX|OK|OKAY|JUST|HEY|HI|SERIOUSLY)';
const COURTESY_RE = new RegExp('^' + COURTESY + '$');

/** Opt-out keywords that are never an everyday word for a homeowner. */
const STRONG_WORDS = Object.freeze(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'REVOKE', 'OPTOUT']);
/** CANCEL / END / QUIT: opt-outs on their own, but "cancel my appointment". */
const WEAK_WORDS = Object.freeze(['CANCEL', 'END', 'QUIT']);
/** Opt-out words that count anywhere in a message. */
const ANYWHERE_WORDS = Object.freeze(['UNSUBSCRIBE', 'STOPALL']);

/** Refusals that turn a nearby STOP-family word into an opt-out. */
const REFUSALS = Object.freeze([
  'NOT INTERESTED', 'NO THANKS', 'NO THANK YOU', 'NO THX', 'NO THANKYOU',
  'LEAVE ME ALONE', 'REMOVE ME', 'DONT TEXT', 'DO NOT TEXT', 'DON T TEXT',
  'DONT CONTACT', 'DO NOT CONTACT', 'WRONG NUMBER', 'NOT THE OWNER',
]);
const REFUSAL_WINDOW = 3; // words between a refusal and the keyword

// After a STOP word, these make it an errand or a repair, not a revocation:
// "stop by Tuesday", "stop at the store", "stop the leak", "stop sign".
const ERRAND_NEXT = new Set([
  'BY', 'IN', 'AT', 'OVER', 'OFF', 'BACK', 'ON', 'AROUND', 'THROUGH', 'FOR',
  'OUT', 'ALONG', 'PAST', 'HERE', 'THERE', 'BEFORE', 'AFTER', 'SOON', 'TODAY',
  'TOMORROW', 'TONIGHT', 'THE', 'A', 'AN', 'MY', 'OUR', 'THAT', 'THIS',
  'LEAKING', 'DRIPPING', 'RAINING', 'SIGN', 'SIGNS', 'WORK', 'WORKING',
]);
// Before a STOP word: a noun ("gravel stop" is a roofing part, "bus stop") or
// a negation ("the leak won't stop") — never a revocation.
const NOT_REVOKE_PREV = new Set([
  'GRAVEL', 'BUS', 'ONE', 'DOOR', 'TRUCK', 'PIT', 'FULL', 'NON', 'WATER',
  'WONT', 'CANT', 'DIDNT', 'DOESNT', 'WOULDNT', 'COULDNT', 'NEVER', 'NOT',
  'ISNT', 'WASNT', 'HASNT', 'HAVENT',
]);

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
  // 2026-10-07 (R6-3-1): "stop sending these", "I no longer want texts from
  // you", "I don't want to get any more texts", "I want you to stop".
  /\b(?:STOP|QUIT|CEASE) SENDING (?:ME )?(?:THESE|THOSE|THIS|THEM|THAT|IT|ANYTHING|STUFF|ANY MORE|ANYMORE)\b/,
  /\b(?:STOP|QUIT|CEASE) SENDING(?: ME)?$/,
  new RegExp('\\bNO LONGER (?:WANT|WISH|NEED|LIKE)(?: TO (?:RECEIVE|GET))? (?:ANY )?(?:MORE )?(?:YOUR |THESE |THE |THOSE )?' + TEXT_NOUN + '\\b'),
  new RegExp('\\bI (?:DO NOT|DONT|DON T) WANT TO (?:RECEIVE|GET) (?:ANY )?(?:MORE )?(?:YOUR |THESE |THE )?' + TEXT_NOUN + '\\b'),
  // ...but "I need you to stop by Friday" is an errand.
  new RegExp('\\b(?:WANT|NEED|ASKING|ASKED|ASK|TELLING|TOLD) YOU TO (?:STOP|QUIT)\\b(?! (?:' + [...ERRAND_NEXT].join('|') + ')\\b)'),
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
    const around = new RegExp('^(?:' + COURTESY + ' )*' + kw + '(?: ' + COURTESY + ')*$');
    if (around.test(norm)) return kw;
  }
  return '';
}

/**
 * @param {string} body  the inbound message, raw
 * @returns {{intent: 'stop'|'help'|'start'|'possible_stop'|null, keyword: string, match: 'keyword'|'phrase'|'ambiguous'|null}}
 *   keyword: the canonical keyword (or 'PHRASE') recorded with the opt-out.
 *   'possible_stop' is NOT an opt-out: record nothing, draft nothing, flag
 *   the thread for a person (see the 2026-10-07 note at the top).
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

  // ── 2026-10-07 (R6-3-1): a STOP-family word inside a longer reply ──────
  const inMessage = (kw) => ({ intent: 'stop', keyword: kw, match: 'phrase' });
  const possible = (kw) => ({ intent: 'possible_stop', keyword: kw, match: 'ambiguous' });

  // 4. Its own clause. Split the RAW text on sentence punctuation (and a
  //    spaced dash), drop clauses that are only courtesy words.
  const clauses = String(body).split(/[.!?;,:\n\r]+|\s[-\u2013\u2014]+\s/)
    .map(normalise).filter((c) => c && !c.split(' ').every((w) => COURTESY_RE.test(w)));
  let edgeWeak = '';
  for (let i = 0; i < clauses.length; i++) {
    const kw = wholeKeyword(clauses[i], STOP_KEYWORDS);
    if (!kw) continue;
    const canon = kw.replace(/ /g, '');
    if (WEAK_WORDS.indexOf(canon) === -1) return inMessage(canon);
    if (!edgeWeak && (i === 0 || i === clauses.length - 1)) edgeWeak = canon;
  }

  // Tokens, with "OPT OUT" joined so it is one word.
  const words = norm.replace(/\bOPT OUT\b/g, 'OPTOUT').split(' ');
  const isStopWord = (w) => STRONG_WORDS.indexOf(w) !== -1 || WEAK_WORDS.indexOf(w) !== -1;

  // 5. Within REFUSAL_WINDOW words of a refusal.
  const refusalAt = [];
  for (const r of REFUSALS) {
    const rw = r.split(' ');
    for (let i = 0; i + rw.length <= words.length; i++) {
      if (rw.every((x, j) => words[i + j] === x)) refusalAt.push([i, i + rw.length - 1]);
    }
  }
  for (let i = 0; i < words.length; i++) {
    if (!isStopWord(words[i])) continue;
    if (refusalAt.some(([a, b]) => (i < a ? a - i - 1 : i - b - 1) <= REFUSAL_WINDOW && (i < a || i > b))) return inMessage(words[i]);
  }

  // UNSUBSCRIBE / STOPALL anywhere ("how do I unsubscribe").
  for (const w of words) if (ANYWHERE_WORDS.indexOf(w) !== -1) return inMessage(w);

  // 6. First word (after courtesy) / last word.
  let first = 0;
  while (first < words.length && COURTESY_RE.test(words[first])) first++;
  let last = words.length - 1;
  while (last >= 0 && COURTESY_RE.test(words[last])) last--;
  if (first <= last && STRONG_WORDS.indexOf(words[first]) !== -1) {
    const next = words[first + 1];
    if (!ERRAND_NEXT.has(next)) return inMessage(words[first]);
  }
  if (first <= last && STRONG_WORDS.indexOf(words[last]) !== -1 && last > first) {
    const before = words.slice(0, last);
    const prev = words[last - 1];
    if (before.every((w) => COURTESY_RE.test(w) || w === 'NO' || w === 'OK' || w === 'YES')) return inMessage(words[last]);
    if (!NOT_REVOKE_PREV.has(prev)) return possible(words[last]);
  }

  // Anything left: a STOP word we can't read safely → a person reads it.
  // Strong words mid-message unless an errand / a negation / a noun;
  // CANCEL / END / QUIT only as the last word or an edge clause ("I want to
  // cancel") — mid-message they are everyday words ("end of the day").
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (STRONG_WORDS.indexOf(w) === -1) continue;
    if (ERRAND_NEXT.has(words[i + 1]) || NOT_REVOKE_PREV.has(words[i - 1])) continue;
    return possible(w);
  }
  if (edgeWeak) return possible(edgeWeak);
  if (last >= 0 && WEAK_WORDS.indexOf(words[last]) !== -1 && !NOT_REVOKE_PREV.has(words[last - 1])) return possible(words[last]);
  return { intent: null, keyword: '', match: null };
}

module.exports = {
  STOP_KEYWORDS,
  HELP_KEYWORDS,
  START_KEYWORDS,
  STOP_PHRASES,
  REFUSALS,
  normalise,
  classifyInbound,
};
