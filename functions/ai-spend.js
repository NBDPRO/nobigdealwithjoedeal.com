'use strict';

/**
 * functions/ai-spend.js — AI spend in one place (2026-10-04).
 *
 * Every server-side AI call (Claude through claudeProxy, the call-center notes
 * pass, Groq Whisper transcription, Thursday's extraction, photo / receipt
 * vision, dictate, Brief me, the promise cleanup) adds ONE usage row here —
 * not a document per call: two aggregate counter docs, incremented in place.
 *
 *   ai_spend_daily/{YYYY-MM-DD}   (America/New_York day)
 *   ai_spend_monthly/{YYYY-MM}
 *
 * Each holds usdMicros / calls / inputTokens / outputTokens / audioSec, plus the
 * same counters per feature under features.<feature>. Money is an integer of
 * micro-dollars (1e-6 USD) so increments never drift the way float dollars do.
 * Writes are server-only (Admin SDK; firestore.rules has no client grant).
 *
 * The health digest reads "AI spend yesterday / this month" from these docs
 * (readAiSpend). recordAiSpend never throws: spend accounting must not break
 * the AI feature it is measuring.
 *
 * Prices are the published list prices per million tokens (Anthropic) and per
 * audio hour (Groq). Keep this table the ONE server price table; the Thursday
 * extraction and the client analytics page carry their own copies for their
 * own displays.
 */

const PRICES = {
  // Anthropic, USD per million tokens { input, output }.
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-5-5': { input: 4, output: 20 },
};
// Groq Whisper, USD per audio hour (whisper-large-v3-turbo list price).
const AUDIO_PRICES_PER_HOUR = {
  'whisper-large-v3-turbo': 0.04,
  'whisper-large-v3': 0.111,
};

const ET = 'America/New_York';
function etYmd(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: ET }); }
function etYm(ms) { return etYmd(ms).slice(0, 7); }

function featureKey(f) {
  const s = String(f || 'other').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'other';
}

/**
 * Cost of one call in integer micro-dollars. Unknown model → 0 with
 * priced:false (counted, never guessed at).
 */
function costMicros({ model, inputTokens, outputTokens, audioSec }) {
  const m = String(model || '');
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const sec = Math.max(0, Number(audioSec) || 0);
  if (AUDIO_PRICES_PER_HOUR[m] != null) {
    return { micros: Math.round(sec * AUDIO_PRICES_PER_HOUR[m] / 3600 * 1e6), priced: true };
  }
  const p = PRICES[m];
  if (!p) return { micros: 0, priced: false };
  // tokens × $/MTok = micro-dollars exactly (1e-6 MTok per token × 1e6 µ$/$).
  return { micros: Math.round(inTok * p.input + outTok * p.output), priced: true };
}

/** The increment patch for one call (pure; `inc` is FieldValue.increment). */
function spendPatch(row, inc) {
  const { micros, priced } = costMicros(row);
  const counters = {
    usdMicros: inc(micros),
    calls: inc(1),
    inputTokens: inc(Math.max(0, Number(row.inputTokens) || 0)),
    outputTokens: inc(Math.max(0, Number(row.outputTokens) || 0)),
    audioSec: inc(Math.round(Math.max(0, Number(row.audioSec) || 0))),
  };
  if (!priced) counters.unpricedCalls = inc(1);
  const patch = Object.assign({}, counters);
  patch.features = { [featureKey(row.feature)]: Object.assign({}, counters) };
  return { patch, micros, priced };
}

/**
 * Adds one AI call to today's and this month's counters. Never throws.
 * @param {object} row { feature, model, inputTokens?, outputTokens?, audioSec? }
 * @param {object} [opts] { db, nowMs, FieldValue, log }
 */
async function recordAiSpend(row, opts) {
  const o = opts || {};
  try {
    const fs = require('firebase-admin/firestore');
    const db = o.db || fs.getFirestore();
    const FV = o.FieldValue || fs.FieldValue;
    const nowMs = Number(o.nowMs) || Date.now();
    const { patch, micros } = spendPatch(row || {}, (n) => FV.increment(n));
    const stamp = { updatedAt: FV.serverTimestamp() };
    await Promise.all([
      db.collection('ai_spend_daily').doc(etYmd(nowMs)).set(Object.assign({ day: etYmd(nowMs) }, stamp, patch), { merge: true }),
      db.collection('ai_spend_monthly').doc(etYm(nowMs)).set(Object.assign({ month: etYm(nowMs) }, stamp, patch), { merge: true }),
    ]);
    return { ok: true, micros };
  } catch (e) {
    try { (o.log || console).warn('ai_spend_record_failed', { feature: row && row.feature, err: e && e.message }); } catch (_) { /* ignore */ }
    return { ok: false };
  }
}

/** Anthropic /v1/messages response → recordAiSpend row. */
function rowFromAnthropic(feature, model, resp) {
  const u = (resp && resp.usage) || {};
  return {
    feature,
    model: (resp && resp.model) || model,
    inputTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0),
    outputTokens: Number(u.output_tokens) || 0,
  };
}

function fmtUsdMicros(m) {
  return '$' + ((Number(m) || 0) / 1e6).toFixed(2);
}

/** Yesterday (ET) and month-to-date (ET) for the health digest. */
async function readAiSpend(db, nowMs) {
  const yKey = etYmd(nowMs - 24 * 3600 * 1000);
  const mKey = etYm(nowMs);
  const [y, m] = await Promise.all([
    db.collection('ai_spend_daily').doc(yKey).get(),
    db.collection('ai_spend_monthly').doc(mKey).get(),
  ]);
  const view = (snap) => {
    const d = (snap && snap.exists && snap.data()) || {};
    const features = Object.entries(d.features || {})
      .map(([k, v]) => ({ feature: k, usdMicros: Number((v || {}).usdMicros) || 0, calls: Number((v || {}).calls) || 0 }))
      .sort((a, b) => b.usdMicros - a.usdMicros);
    return { usdMicros: Number(d.usdMicros) || 0, calls: Number(d.calls) || 0, unpricedCalls: Number(d.unpricedCalls) || 0, features };
  };
  return { dayKey: yKey, monthKey: mKey, yesterday: view(y), month: view(m) };
}

/** One line: "AI spend yesterday $0.42 (118 calls) · this month $6.10 (1,402 calls)". */
function aiSpendLine(s) {
  const y = (s && s.yesterday) || { usdMicros: 0, calls: 0 };
  const m = (s && s.month) || { usdMicros: 0, calls: 0 };
  return 'AI spend yesterday ' + fmtUsdMicros(y.usdMicros) + ' (' + y.calls.toLocaleString('en-US') + ' calls) · this month '
    + fmtUsdMicros(m.usdMicros) + ' (' + m.calls.toLocaleString('en-US') + ' calls)';
}

module.exports = {
  PRICES, AUDIO_PRICES_PER_HOUR,
  costMicros, spendPatch, recordAiSpend, rowFromAnthropic, readAiSpend, aiSpendLine, fmtUsdMicros, featureKey, etYmd, etYm,
};
