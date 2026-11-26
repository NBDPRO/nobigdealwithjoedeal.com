/**
 * tests/ai-evals/evals.js — one small, fixed-input eval per route migrated to
 * functions/ai-client.js (roadmap step 15, 2026-11-25).
 *
 * Each case builds the route's REAL prompt with the route's own builder
 * (functions/*-logic.js) from an invented fixture (made-up names, 555
 * numbers, no customer data), and scores the answer with the deterministic
 * checks the route already runs in production (its sanitizer, the promise
 * cleanup's verifyVerdicts) plus "no invented numbers": every number in the
 * output's prose must appear in the input.
 *
 * Not a CI suite (it calls the live API and costs money). See README.md.
 */
'use strict';

const path = require('path');
const FN = (p) => path.join(__dirname, '..', '..', 'functions', p);
const L = require(FN('call-center-logic.js'));
const T = require(FN('text-inbox-logic.js'));
const V = require(FN('visit-capture-logic.js'));
const P = require(FN('promise-cleanup-logic.js'));

// Wed 2026-10-07, 2:15 PM Eastern.
const CALL_MS = Date.parse('2026-10-07T18:15:00Z');

const CALL_TRANSCRIPT = [
  'Hi, is this Jo? This is Pat Example, I live on Oak Hill Drive in Florence.',
  'The gutter over the back porch is leaking again, it is dripping right onto the steps.',
  'Sure Pat. I can come out Thursday afternoon and take a look.',
  'And I will email you the repair quote by Friday.',
  'Great. I will leave the side gate unlocked for you.',
].join(' ');

/** Numbers (digit runs) in a string. */
const numbersIn = (s) => (String(s || '').match(/\d+/g) || []);
/** Every number in `out` appears in `input` (the prompt: transcript, dates, length; due-date fields are not prose and are not passed in). */
function noInventedNumbers(out, input) {
  const have = new Set(numbersIn(input));
  const bad = numbersIn(out).filter((n) => !have.has(n));
  return { ok: bad.length === 0, bad };
}
function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || '')); // the same extraction claudeNotes uses
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}
const check = (name, okv, detail) => ({ name, ok: !!okv, detail });

const CASES = {
  'call-center-notes': {
    system: L.notesSystemFor(null),
    prompt: L.buildNotesPrompt({ call: { startedAtMs: CALL_MS, direction: 'inbound', contactName: 'Pat Example' }, transcript: CALL_TRANSCRIPT, leadName: 'Pat Example', tenant: null }),
    score(text) {
      const raw = parseJson(text);
      const n = L.sanitizeNotes(raw, { matched: true });
      const prose = [n.summary].concat(n.promises.map((p) => p.text)).join(' ');
      const inv = noInventedNumbers(prose, this.prompt);
      return [
        check('JSON object returned', !!raw),
        check('business call (customer or lead)', ['customer', 'lead'].includes(n.callType), n.callType),
        check('Jo\'s promise is kept (quote / visit)', n.promises.some((p) => p.who === 'jo')),
        check('town is Florence', n.callerFacts.town === 'Florence', n.callerFacts),
        check('no invented numbers', inv.ok, inv.bad),
      ];
    },
  },
  'call-center-facts': {
    system: L.factsSystemFor(null),
    prompt: L.buildFactsPrompt({ transcript: CALL_TRANSCRIPT }),
    score(text) {
      const raw = parseJson(text);
      const f = L.sanitizeCallerFacts(raw);
      return [
        check('JSON object returned', !!raw),
        check('caller name is Pat', !!f.name && /Pat/.test(f.name), f.name),
        check('town is Florence', f.town === 'Florence', f.town),
        check('service is gutters', f.service === 'gutters', f.service),
        check('no house number invented (none was said)', !f.street || !/\d/.test(f.street), f.street),
      ];
    },
  },
  'text-notes': (() => {
    const day = {
      ymd: '2026-10-07', contactName: 'Pat Example',
      messages: [
        { direction: 'inbound', sentAtMs: CALL_MS, body: 'Hi Jo, Pat here. Any update on the gutter quote?' },
        { direction: 'outbound', sentAtMs: CALL_MS + 600000, body: 'Hi Pat, I will send it over tomorrow morning.' },
        { direction: 'inbound', sentAtMs: CALL_MS + 900000, body: 'Thanks! The porch steps are still getting wet.' },
      ],
    };
    return {
      system: T.TEXT_NOTES_SYSTEM,
      prompt: T.buildTextNotesPrompt({ day, leadName: 'Pat Example' }),
      score(text) {
        const raw = parseJson(text);
        const n = L.sanitizeNotes(raw);
        const prose = [n.summary].concat(n.promises.map((p) => p.text)).join(' ');
        const inv = noInventedNumbers(prose, this.prompt);
        return [
          check('JSON object returned', !!raw),
          check('business texts (customer or lead)', ['customer', 'lead'].includes(n.callType), n.callType),
          check('Jo\'s promise to send the quote is kept', n.promises.some((p) => p.who === 'jo' && /quote/i.test(p.text)), n.promises),
          check('no invented numbers', inv.ok, inv.bad),
        ];
      },
    };
  })(),
  'visit-notes': (() => {
    const transcript = 'Okay Pat, I am up on the roof now. You have two layers of shingles up here, so it all comes off. '
      + 'It is about 28 squares, and the pitch is a 6 over 12. There are two soft spots by the chimney. '
      + 'I will send you the estimate on Monday. Your insurance is State Example, the adjuster comes out next week.';
    return {
      system: V.VISIT_NOTES_SYSTEM,
      prompt: V.buildVisitNotesPrompt({ capture: { startedAtMs: CALL_MS, durationSec: 1260 }, transcript, leadName: 'Pat Example', nowMs: CALL_MS }),
      score(text) {
        const raw = parseJson(text);
        const n = V.sanitizeVisitNotes(raw);
        const prose = [n.summary].concat(n.scopeFacts, n.promises.map((p) => p.text), n.followUps.map((p) => p.text)).join(' ');
        const inv = noInventedNumbers(prose, this.prompt); // the prompt: transcript, visit date, length
        return [
          check('JSON object returned', !!raw),
          check('not personal', n.visitType !== 'personal', n.visitType),
          check('the 28 squares scope fact is kept', n.scopeFacts.some((s) => /28/.test(s)), n.scopeFacts),
          check('Jo\'s estimate promise is kept', n.promises.some((p) => p.who === 'jo'), n.promises),
          check('no invented numbers (prices, measurements)', inv.ok, inv.bad),
        ];
      },
    };
  })(),
  'promise-cleanup': (() => {
    const promises = [{ index: 0, text: 'Email Pat the gutter repair quote' }, { index: 1, text: 'Bring the shingle samples' }];
    const evidence = [
      { id: 'E1', activityId: 'a1', ms: CALL_MS + 86400000, kind: 'note', text: 'Emailed Pat the gutter repair quote this morning.' },
      { id: 'E2', activityId: 'a2', ms: CALL_MS + 2 * 86400000, kind: 'note', text: 'Will bring the shingle samples next week when I am in Florence.' },
    ];
    return {
      system: P.SYSTEM,
      prompt: P.buildPrompt(promises, evidence),
      score(text) {
        const raw = parseJson(text);
        const kept = P.verifyVerdicts(raw, promises, evidence);
        return [
          check('JSON object returned', !!raw),
          check('the emailed quote is kept, on E1', kept.some((k) => k.index === 0 && k.evidenceId === 'E1'), kept),
          check('the samples (only a plan) are NOT kept', !kept.some((k) => k.index === 1), kept),
        ];
      },
    };
  })(),
};

module.exports = { CASES, noInventedNumbers, parseJson };
