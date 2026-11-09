'use strict';

/**
 * functions/coach-line-logic.js — the NBD OS Coach's AI focus line, pure half
 * (2026-11-09, NBD OS P2; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.2).
 *
 * The browser sends the SAME counted evidence the rules Coach already shows
 * (docs/pro/js/os/coach-logic.js evaluate(): rule ids plus whole-number counts).
 * Nothing else crosses: no customer names, no notes, no free text. This file
 *   cleanFacts(data)      keeps only known rule ids and their known numeric keys
 *   buildRequest(facts)   the Haiku request; the prompt is written HERE, from
 *                         server-side labels, never from client text
 *   parseLine(resp)       the model's one sentence, or null
 *   checkLine(line, facts) the post-check: every digit run and every number word
 *                         ("three", "dozen", "half", "twice"…) must be a number the
 *                         evidence holds; anything else fails and the widget shows
 *                         no line (the rules list still stands)
 * No I/O, no clock: functions/coach-line.js does the reads, caps and the call.
 */

const MODEL = 'claude-haiku-4-5-20251001';   // in handlers/_shared.js ALLOWED_CLAUDE_MODELS
const MAX_TOKENS = 150;
const TEMPERATURE = 0.2;
const MAX_RULES = 5;
const MAX_COUNT = 100000;
const MAX_LINE = 180;

/**
 * Server-side labels per rule id (coach-logic.js ids). `keys` are the evidence
 * keys accepted (all whole numbers except ds-warned's boolean); `lines(ev)` turns
 * them into fact lines. A key the rule doesn't list is dropped.
 */
const RULES = {
  'missed-calls': {
    keys: ['fresh', 'late', 'minutes'],
    lines: (e) => e.minutes == null ? [] : [
      e.fresh ? ['Missed calls from the last ' + e.minutes + ' minutes, not called back yet', e.fresh] : null,
      e.late ? ['Older missed calls not called back within ' + e.minutes + ' minutes', e.late] : null,
    ],
  },
  overdue: {
    keys: ['promises', 'missed', 'followUps'],
    lines: (e) => [
      e.promises ? ['Promises to customers that are overdue', e.promises] : null,
      e.missed ? ['Times those promises have already been missed', e.missed] : null,
      e.followUps ? ['Follow-ups past their due date', e.followUps] : null,
    ],
  },
  estimates: {
    keys: ['over10', 'days10', 'over5', 'days5'],
    lines: (e) => [
      e.over10 && e.days10 != null ? ['Estimates out ' + e.days10 + '+ days with no answer', e.over10] : null,
      e.over5 && e.days5 != null ? ['Estimates out ' + e.days5 + '+ days with no answer', e.over5] : null,
    ],
  },
  'ds-warned': {
    keys: ['warned'],
    lines: (e) => [e.warned === true ? ['The rep missed their daily floors on the last workday', null] : null],
  },
  'stuck-new': {
    keys: ['leads', 'days'],
    lines: (e) => [e.leads && e.days != null ? ['Leads still in the first pipeline stage after ' + e.days + '+ days', e.leads] : null],
  },
};

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function count(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null; }

/**
 * { rules: [{ id, evidence }] } from the browser → { rules: [{ id, ev, lines }], numbers:Set } or null.
 * Unknown ids, unknown keys, strings (a tenant stage name), fractions and
 * negatives are dropped; a rule left with no fact line is dropped; no rules → null.
 */
function cleanFacts(data) {
  const raw = isObj(data) && Array.isArray(data.rules) ? data.rules.slice(0, MAX_RULES) : [];
  const seen = new Set();
  const rules = [];
  const numbers = new Set();
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || !Object.prototype.hasOwnProperty.call(RULES, r.id) || seen.has(r.id)) continue;
    const def = RULES[r.id];
    const src = isObj(r.evidence) ? r.evidence : {};
    const ev = {};
    for (const k of def.keys) {
      if (k === 'warned') { if (src.warned === true) ev.warned = true; continue; }
      const n = count(src[k]);
      if (n != null) ev[k] = n;
    }
    const lines = def.lines(ev).filter(Boolean);
    if (!lines.length) continue;
    seen.add(r.id);
    Object.keys(ev).forEach((k) => { if (typeof ev[k] === 'number') numbers.add(ev[k]); });
    rules.push({ id: r.id, ev, lines });
  }
  return rules.length ? { rules, numbers } : null;
}

const SYSTEM = [
  'You write ONE short sentence of focus for a roofing sales rep\'s day, from the facts the app counted.',
  'Use ONLY the facts listed. Point the rep at the single most useful thing to do first.',
  'Never write a number: no digits and no number words (one, two, three, dozen, half, twice and so on).',
  'Never invent customers, names, amounts, dates or anything not listed. No greeting, no quotes, no emoji, no lists.',
  'Reply with the sentence only, at most 22 words.',
].join(' ');

function buildPrompt(facts) {
  const out = ['Facts the app counted today, most urgent first:'];
  for (const r of facts.rules) {
    for (const [label, n] of r.lines) out.push('- ' + label + (n == null ? '' : ': ' + n));
  }
  out.push('', 'Write the one focus sentence.');
  return out.join('\n');
}

function buildRequest(facts) {
  return { model: MODEL, max_tokens: MAX_TOKENS, temperature: TEMPERATURE, system: SYSTEM, messages: [{ role: 'user', content: buildPrompt(facts) }] };
}

/** The model's text as one clean sentence, or null (refusal, empty, several lines, too long, a link). */
function parseLine(resp) {
  if (!isObj(resp) || resp.stop_reason === 'refusal' || !Array.isArray(resp.content)) return null;
  const text = resp.content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
  if (!text || /\n\s*\S/.test(text)) return null;
  const line = text.replace(/\s+/g, ' ').replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (line.length < 8 || line.length > MAX_LINE) return null;
  if (/https?:|www\.|[<>@#{}[\]`*_|\\]/i.test(line)) return null;
  // one sentence: no sentence end followed by more words
  if (/[.!?]["')”’]?\s+\S/.test(line)) return null;
  return line;
}

// ── the number post-check ────────────────────────────────────────────────
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const OTHER = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, dozen: 12, couple: 2, pair: 2, once: 1, twice: 2, thrice: 3,
  // ordinals past "first" ("call back first" means before anything else, not a count)
  second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, twelfth: 12, twentieth: 20, thirtieth: 30,
  // never a whole count the evidence can hold: always fail
  half: NaN, halves: NaN, quarter: NaN, quarters: NaN, dozens: NaN, hundreds: NaN, thousands: NaN, millions: NaN, triple: NaN, double: NaN,
  zeros: NaN, ones: NaN, twos: NaN, threes: NaN, fours: NaN, fives: NaN, tens: NaN };
// a word that only LOOKS like a count in other senses is still treated as one: a false
// fallback costs a missing line; a false pass costs an invented number on screen

/**
 * Every number the line states, as values (NaN for a fraction, a decimal or
 * a non-ASCII digit, which no evidence can match). "twenty-one" is 21.
 */
function numbersIn(line) {
  const s = String(line || '');
  const out = [];
  if (/[¼-¾⅐-⅟↉]/.test(s) || /[^\x00-\x7F]/.test(s.replace(/[^\p{Nd}]/gu, ''))) out.push(NaN);
  for (const m of s.matchAll(/\d+(?:[.,:/]\d+)*/g)) {
    const t = m[0];
    if (/^\d{1,3}(,\d{3})+$/.test(t)) { out.push(Number(t.replace(/,/g, ''))); continue; }
    if (/[.,/]/.test(t)) { out.push(NaN); continue; }
    t.split(':').forEach((p) => out.push(Number(p)));
  }
  const words = s.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || [];
  for (const w of words) {
    const parts = w.split('-');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (Object.prototype.hasOwnProperty.call(TENS, p)) {
        const next = parts[i + 1];
        if (next && Object.prototype.hasOwnProperty.call(UNITS, next) && UNITS[next] > 0 && UNITS[next] < 10) { out.push(TENS[p] + UNITS[next]); i++; }
        else out.push(TENS[p]);
      } else if (Object.prototype.hasOwnProperty.call(UNITS, p)) out.push(UNITS[p]);
      else if (Object.prototype.hasOwnProperty.call(OTHER, p)) out.push(OTHER[p]);
    }
  }
  return out;
}

/** { ok, bad } — ok only when every stated number is one the evidence holds. */
function checkLine(line, facts) {
  if (typeof line !== 'string' || !line) return { ok: false, bad: ['empty'] };
  const allowed = facts && facts.numbers instanceof Set ? facts.numbers : new Set();
  const bad = numbersIn(line).filter((n) => !(Number.isFinite(n) && allowed.has(n)));
  return { ok: bad.length === 0, bad };
}

module.exports = {
  MODEL, MAX_TOKENS, TEMPERATURE, MAX_RULES, MAX_LINE, RULES, SYSTEM,
  cleanFacts, buildPrompt, buildRequest, parseLine, numbersIn, checkLine,
};
