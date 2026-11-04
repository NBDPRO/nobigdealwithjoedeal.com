'use strict';
/**
 * opp-draft-logic.js — the pure half of oppDraftFile (2026-11-04, flag
 * thumbtackOpportunities, ships dark): build the text of ONE first message for
 * a Thumbtack Opportunity from a FIXED template plus three facts, and refuse
 * anything that looks like a way around Thumbtack. No Firestore, no network, no
 * clock, nothing read from or sent to Thumbtack.
 *
 *   sanitizePhrase(raw)          the customer's problem words as a short, safe quote, or null
 *   phoneProblem(text)           why this text looks like a phone number, or null
 *   linkProblem(text)            why it looks like an email address, link or off-platform handle, or null
 *   kentuckyProblem(text)        the Kentucky insurance-job wording gate (claims talk), or null
 *   draftProblem(text)           the first of the above, plus our banned-claims words, or null
 *   buildOppDraft(input)         { ok:true, text, templateKey, usedQuote } or { ok:false, code, error }
 *
 * The same phoneProblem / draftProblem run again, unchanged, on Jo's EDITED
 * text when the approval step arrives (a later PR): they are exported for that.
 *
 * Phone rule (design 3c, Plan 7): a draft never carries a phone number, a
 * spelled-out number, or one disguised to slip past Thumbtack's masking. Jo's
 * wording is his to edit; the refuser only decides what the SYSTEM will offer.
 * It reads digits in any script, number words ("five one three"), "double
 * five", separators of any kind, zero-width characters between digits, and a
 * letter O or I standing in for 0 or 1 between digits.
 *
 * Prompt injection: every word of an Opportunity is DATA. The only customer
 * text that can reach a draft is the problem phrase, and only as a lower-case
 * quote with no digits, links, instruction wording, phone shapes or insurance
 * talk, at most 120 characters. The template decides everything else.
 */
const R = require('./opp-rules');
const L = require('./agent-mcp-logic');
const TPL = require('./opp-draft-templates');

const PHRASE_MAX = R.DEFAULT_RULES.text.phraseMax;   // 120
const DRAFT_MAX = 700;

// ── characters ──────────────────────────────────────────────────────────────
// Control, bidi, zero-width and soft-hyphen characters (built from code points so no editor can corrupt this file).
const INVISIBLE = new RegExp('[' + [
  [0, 31], [127, 159], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
].map(([a, b]) => String.fromCharCode(a) + (b > a ? '-' + String.fromCharCode(b) : '')).join('') + ']', 'g');

const ND = /\p{Nd}/u;
/** Any Unicode decimal digit to ASCII (Arabic-Indic, fullwidth, Devanagari, ...). Blocks of Nd start at a zero and run in tens. */
function asciiDigit(ch) {
  const cp = ch.codePointAt(0);
  let base = cp;
  while (base > 0 && ND.test(String.fromCodePoint(base - 1))) base--;
  return String((cp - base) % 10);
}
/** NFKC, invisible characters removed, every Unicode digit made ASCII, lower case. */
function fold(text) {
  let s = String(text == null ? '' : text).normalize('NFKC').replace(INVISIBLE, '');
  s = s.replace(/\p{Nd}/gu, (ch) => asciiDigit(ch));
  return s.toLowerCase();
}

// ── phone-shaped text ───────────────────────────────────────────────────────
const WORD_DIGIT = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', fife: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9' };
const WORDS = Object.keys(WORD_DIGIT).join('|');
const SEP = '[\\s.\\-()/_+,*:|' + String.fromCharCode(0xb7, 0x2022, 0x2013, 0x2014) + ']';   // what may sit between digits of one number

/** Text with number words, "double/triple X" and look-alike letters (between digits) turned into digits. */
function digitize(text) {
  let s = fold(text);
  s = s.replace(new RegExp('\\b(double|triple|dbl)[\\s-]+(' + WORDS + '|\\d)\\b', 'g'), (m, mult, d) => {
    const dig = /\d/.test(d) ? d : WORD_DIGIT[d];
    return ' ' + dig.repeat(mult === 'triple' ? 3 : 2) + ' ';
  });
  s = s.replace(new RegExp('\\b(' + WORDS + ')\\b', 'g'), (m, w) => ' ' + WORD_DIGIT[w] + ' ');
  // a letter o / i / l standing in for 0 / 1 right beside digits ("513-555-O100")
  // (a short run of them, not part of a longer word, directly after or directly before a digit)
  const swap = (run) => run.replace(/[oil]/g, (c) => (c === 'o' ? '0' : '1'));
  s = s.replace(new RegExp('(?<=\\d' + SEP + '*)([oil]{1,4})(?![a-z])', 'g'), (m, run) => swap(run));
  s = s.replace(new RegExp('(?<![a-z])([oil]{1,4})(?=' + SEP + '*\\d)', 'g'), (m, run) => swap(run));
  return s;
}
/** Longest run of digits (separators allowed inside a run) and the total count of digits. */
function digitStats(s) {
  let run = 0, best = 0, total = 0;
  const sep = new RegExp('^' + SEP + '$');
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') { run++; total++; if (run > best) best = run; }
    else if (!sep.test(ch)) run = 0;
  }
  return { run: best, total };
}

const CONTACT_PHRASES = [
  /\b(text|call|ring|phone|dial|message|msg|whatsapp|facetime|dm)\s+(me|us|him|her|jo|joe)\b/,
  /\bgive\s+(me|us|him|her)\s+a\s+(call|ring|text|buzz)\b/,
  /\b(reach|contact|find|get)\s+(me|us|him|her)\s+(at|on|via|by|through)\b/,
  /\b(my|our|his|her|the)\s+(cell|mobile|phone|number|direct line|direct number|digits|whatsapp)\b/,
  /\b(phone|cell|mobile|telephone|contact|direct)\s+(number|no|#)\b/,
  /\barea\s+code\b/,
  /\b(email|e-mail)\s+(me|us|him|her)\b/,
];

/** @returns {string|null} why this looks like a phone number (or a way to ask for one), else null */
function phoneProblem(text) {
  const raw = String(text == null ? '' : text);
  const folded = fold(raw);
  const s = digitize(raw);
  const st = digitStats(s);
  if (st.run >= 7) return 'This looks like a phone number (a long run of digits or number words). Phone numbers are not allowed in a Thumbtack message.';
  if (st.total >= 10) return 'This has ten or more digits or number words spread through it, which can hide a phone number. Take them out.';
  for (const re of CONTACT_PHRASES) if (re.test(folded)) return 'This asks the customer to call, text or email you directly. Keep the conversation in Thumbtack.';
  return null;
}

/** @returns {string|null} why this looks like an email address, link or off-platform handle, else null */
function linkProblem(text) {
  const t = fold(text);
  if (/https?:\/\/|\bwww\.|\bftp:/.test(t)) return 'This has a web link. Links are not allowed in a Thumbtack message.';
  if (/[a-z0-9_.+-]+\s*(@|\(\s*at\s*\)|\[\s*at\s*\]|\{\s*at\s*\})\s*[a-z0-9-]+/.test(t)) return 'This looks like an email address or a social handle.';
  if (/\b[a-z0-9-]+\s*(\.|\(\s*dot\s*\)|\[\s*dot\s*\]|\s+dot\s+)\s*(com|net|org|us|co|io|app|biz|info|me|ly)\b/.test(t)) return 'This looks like a web address.';
  return null;
}

// ── Kentucky insurance-job wording ──────────────────────────────────────────
/**
 * The same gate every other draft runs (agent-mcp-logic claimWordingProblem: never handle / negotiate
 * the claim, never a claims "specialist" or "expert", never approved by an insurer), applied to every
 * draft, not only to Kentucky ones: a draft that is safe everywhere needs no per-lead branching.
 */
function kentuckyProblem(text) {
  return L.claimWordingProblem(String(text == null ? '' : text));
}
/** Insurance-claim talk in OUR words or the customer's: a draft never discusses the claim. */
const CLAIMISH = /\b(claims?|insur\w*|adjusters?|deductibles?|coverage|covered|policy|policies|carrier|state farm|allstate|assignment of benefits|aob|waiv\w*|rebate\w*|storm chasers?)\b/i;
/** Words a finished draft may never contain (our claims rules). "fully insured" is the one insurance word allowed. */
const BANNED_IN_DRAFT = /\$|\b(prices?|pricing|quotes?|estimates?|discounts?|guarantee\w*|warrant\w*|licensed|in[- ]house|lifetime|specialists?|experts?|asap|act now|last chance|today only|hurry|dear\b|homeowner)\b/i;

/** @returns {string|null} the first problem with a finished draft (or Jo's edit of one), else null */
function draftProblem(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return 'The message is empty.';
  if (t.length > DRAFT_MAX) return 'The message is too long (over ' + DRAFT_MAX + ' characters).';
  const ph = phoneProblem(t); if (ph) return ph;
  const lk = linkProblem(t); if (lk) return lk;
  const ky = kentuckyProblem(t); if (ky) return ky;
  const withoutFully = t.replace(/\bfully insured\b/gi, '');
  if (CLAIMISH.test(withoutFully)) return 'A first message does not talk about insurance claims, adjusters, coverage or deductibles. Say "fully insured" and nothing more.';
  if (BANNED_IN_DRAFT.test(t)) return 'This has a price, estimate, guarantee, pressure or title wording that a first message may not carry.';
  if (/\p{Extended_Pictographic}/u.test(t)) return 'No emojis.';
  return null;
}

// ── the customer's words, as one safe quote ─────────────────────────────────
/**
 * @param {*} raw whatever the page or Jo's paste held for the problem
 * @returns {string|null} lower-case letters, spaces, apostrophes, commas and hyphens, 3 to 120 characters,
 *          or null when nothing safe is left (the draft then uses our own fallback phrase)
 */
function sanitizePhrase(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.slice(0, 2000).normalize('NFKC').replace(INVISIBLE, ' ').replace(/<[^>]*>/g, ' ');
  // Anything instruction-shaped, phone-shaped or link-shaped drops the whole phrase (checked BEFORE digits are stripped).
  if (R.INSTRUCTION_CUES.test(s) || phoneProblem(s) || linkProblem(s)) return null;
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  s = s.replace(/\p{Nd}/gu, ' ').replace(/[^A-Za-z' ,-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  s = s.replace(/^[\s,'-]+|[\s,'-]+$/g, '');
  if (s.length < 3 || !/[a-z]{3}/.test(s)) return null;
  if (CLAIMISH.test(s) || BANNED_IN_DRAFT.test(s)) return null;
  if (s.length > PHRASE_MAX) {
    const cut = s.slice(0, PHRASE_MAX);
    const sp = cut.lastIndexOf(' ');
    s = (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,'-]+$/g, '');
  }
  // Digit words that survive (letters only) must not read as a number once quoted.
  if (phoneProblem(s)) return null;
  return s;
}

/** Our own fallback noun phrases, by the fixed tags the shortlist stored. Never the customer's words. */
const TAG_PHRASE = Object.freeze({
  'leak': 'the leak', 'missing shingles': 'the missing shingles', 'storm damage': 'the storm damage', 'flashing': 'the flashing',
  'sagging': 'the sagging', 'inspection': 'the inspection', 'replacement': 'the replacement', 'gutter': 'the gutters', 'siding': 'the siding',
});
const TRADE_PHRASE = Object.freeze({
  roof_repair: 'the roof repair', roof_inspection: 'the roof inspection', siding_repair: 'the siding repair', gutter_repair: 'the gutter repair',
  roof_install: 'the roof replacement', siding_install: 'the siding replacement',
});
function fallbackProblem(tradeKey, summary) {
  const tags = String(summary || '').split(',').map((t) => t.trim()).filter((t) => Object.prototype.hasOwnProperty.call(TAG_PHRASE, t));
  // prefer a specific problem over the trade-wide tags
  const order = ['leak', 'missing shingles', 'storm damage', 'flashing', 'sagging', 'inspection', 'replacement', 'gutter', 'siding'];
  const pick = order.filter((t) => tags.indexOf(t) !== -1)[0];
  return pick ? TAG_PHRASE[pick] : (TRADE_PHRASE[tradeKey] || 'your request');
}

// ── building the draft ──────────────────────────────────────────────────────
const cleanCity = (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z .'-]{0,59}$/.test(v.trim()) ? v.trim() : null);
const cleanCompany = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 &.,'-]{1,79}$/.test(v.trim()) ? v.trim() : null);

/** Stable pick of one of a trade's three wordings from the opportunity id. */
function pickKey(tradeKey, oppId) {
  const keys = TPL.keysForTrade(tradeKey);
  if (!keys.length) return null;
  let h = 0;
  for (const ch of String(oppId || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return keys[h % keys.length];
}

/**
 * @param {{templateKey?:string, tradeKey?:string, oppId?:string, phrase?:*, summary?:string, city?:*, hasPhotos?:boolean, company?:string}} input
 * @returns {{ok:true, text:string, templateKey:string, usedQuote:boolean}|{ok:false, code:string, error:string}}
 */
function buildOppDraft(input) {
  const i = input || {};
  const key = TPL.isTemplateKey(i.templateKey) ? i.templateKey : (i.templateKey == null ? pickKey(i.tradeKey, i.oppId) : null);
  if (!key) return { ok: false, code: 'unknown_template', error: 'Unknown message.' };
  const t = TPL.TEMPLATES[key];
  if (i.tradeKey && t.trade !== i.tradeKey) return { ok: false, code: 'wrong_trade', error: 'That wording is for a different kind of job.' };
  const company = cleanCompany(i.company);
  if (!company) return { ok: false, code: 'no_company_name', error: 'The company has no usable name on its profile, so a message cannot say who it is from.' };
  const phrase = sanitizePhrase(i.phrase);
  const problem = phrase ? '"' + phrase + '"' : fallbackProblem(t.trade, i.summary);
  const city = cleanCity(i.city);
  const near = city ? 'near ' + city : 'in your area';
  const photo = i.hasPhotos === true ? TPL.PHOTO.yes : TPL.PHOTO.no;
  const text = t.lines.map((line) => line
    .replace('{company}', () => company).replace('{near}', () => near).replace('{problem}', () => problem).replace('{photo}', () => photo))
    .join(' ').replace(/\s+/g, ' ').trim();
  const bad = draftProblem(text);
  if (bad) return { ok: false, code: 'text_refused', error: bad };
  return { ok: true, text, templateKey: key, usedQuote: !!phrase };
}

module.exports = {
  PHRASE_MAX, DRAFT_MAX, fold, digitize, digitStats, phoneProblem, linkProblem, kentuckyProblem, draftProblem, sanitizePhrase,
  fallbackProblem, pickKey, buildOppDraft, CLAIMISH, BANNED_IN_DRAFT, TAG_PHRASE,
};
