'use strict';

/**
 * functions/ai-client.js — the one server Anthropic client (2026-11-25,
 * roadmap step 15; audit §3.2). Joe's call: the official Anthropic SDK
 * (@anthropic-ai/sdk, pinned in functions/package.json; server only, never
 * shipped to a browser).
 *
 *   createMessage({ route, system, messages, maxTokens?, companyId, gate,
 *                   apiKey, log? })
 *     → { message, text, model, usage, stopReason }
 *
 *   route    a key of functions/ai-models.js ROUTES. The model, the default
 *            max_tokens, the timeout and the retry bound all come from that
 *            row; a caller never names a model. The route is also the spend
 *            feature name.
 *   gate     REQUIRED, so an ungated call cannot happen by accident:
 *              'caller'  the caller already ran aiGate (ai-gate.js) for this
 *                        work (every route migrated so far: the call-center
 *                        feed, the text inbox, the visit pipeline and the
 *                        promise cleanup gate once per run), so it is not run
 *                        again per call;
 *              { auth } | { forUid } | { companyId } | { publicCaller: true }
 *                        aiGate runs here, feature = route, before any call.
 *   apiKey   the caller's ANTHROPIC_API_KEY secret value (the function that
 *            binds the secret reads it; missing → 'anthropic-not-configured').
 *
 * Errors are AiClientError { code, status, retryable, provider: 'anthropic',
 * route, reason? }. code is one of CODES. A status error keeps the message
 * shape the raw-fetch callers threw ('anthropic 529: Overloaded'), so
 * call-center-logic.js classifyProviderError reads it as before.
 *
 * Spend: one recordAiSpend row per successful call (feature = route, with the
 * companyId), exactly what the raw-fetch callers recorded. A refused or
 * failed call records nothing.
 *
 * API version: pinned to 2023-06-01 (API_VERSION), the version the raw-fetch
 * callers sent, so migrating a route does not also move it to the SDK 1.x
 * default 2026-10-21. That default rejects temperature / top_p / top_k, so a
 * registry row that sends temperature is still refused here
 * (unsupported_route): it could not follow the later version move without
 * Joe's OK to drop it.
 *
 * Retries: per registry row. The migrated rows make one attempt
 * (maxRetries 0), as the raw fetch did: a timed-out attempt can still be
 * billed, and only the answer that comes back is recorded as spend.
 *
 * Raw-fetch callers keep working until they migrate; a route moves by
 * switching its registry row to client: 'ai-client' in the same change.
 */

const Models = require('./ai-models');

// The API version every migrated route sends (the raw fetch's), not the SDK
// 1.x default 2026-10-21. See clientFor.
const API_VERSION = '2023-06-01';

const CODES = Object.freeze([
  'unknown_route', 'not_migrated', 'unsupported_route', 'gate_required', 'gated', 'not_configured',
  'bad_request', 'auth', 'billing', 'permission', 'not_found', 'too_large', 'rate_limited',
  'overloaded', 'server_error', 'timeout', 'connection', 'aborted', 'http_error', 'unknown',
]);

class AiClientError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'AiClientError';
    this.code = code;
    const x = extra || {};
    this.status = Number(x.status) || 0;
    this.retryable = x.retryable === true;
    this.provider = 'anthropic'; // call-center-logic classifyProviderError
    this.route = x.route || null;
    if (x.reason) this.reason = x.reason;
  }
}

// ── test seams (production resolves lazily) ─────────────────────────────
let _test = null;
let _clients = new Map();
function _setTestDeps(d) { _test = d || null; _clients = new Map(); }
function _resetTestDeps() { _test = null; _clients = new Map(); }
const sdkModule = () => (_test && _test.sdk) || require('@anthropic-ai/sdk');
const spendFns = () => (_test && _test.recordAiSpend
  ? { recordAiSpend: _test.recordAiSpend, rowFromAnthropic: require('./ai-spend').rowFromAnthropic }
  : require('./ai-spend'));
const gateFn = () => (_test && _test.aiGate) || require('./ai-gate').aiGate;

function clientFor(apiKey) {
  const Sdk = sdkModule();
  const fetchImpl = _test && _test.fetch;
  let byKey = _clients.get(Sdk);
  if (!byKey) { byKey = new Map(); _clients.set(Sdk, byKey); }
  let c = byKey.get(apiKey);
  if (!c) {
    const Ctor = Sdk.Anthropic || Sdk.default || Sdk;
    // Pinned to the version the raw-fetch callers sent, so a migrated route
    // keeps its wire contract; moving to the SDK default (2026-10-21) is its
    // own change, after the evals. (The SDK sends the key as
    // Authorization: Bearer, which the API accepts like x-api-key.)
    const opts = { apiKey, defaultHeaders: { 'anthropic-version': API_VERSION } };
    if (fetchImpl) opts.fetch = fetchImpl;
    c = new Ctor(opts);
    byKey.set(apiKey, c);
  }
  return c;
}

const STATUS_CODES = { 400: 'bad_request', 401: 'auth', 402: 'billing', 403: 'permission', 404: 'not_found', 408: 'timeout', 413: 'too_large', 429: 'rate_limited', 529: 'overloaded' };

/** An SDK error → AiClientError (typed classes first, then the HTTP status). */
function mapError(e, route) {
  if (e instanceof AiClientError) return e;
  let S = {};
  try { S = sdkModule() || {}; } catch (_) { S = {}; }
  const is = (name) => typeof S[name] === 'function' && e instanceof S[name];
  const detail = (m) => String(m || '').slice(0, 200);
  if (is('APIConnectionTimeoutError')) return new AiClientError('timeout', 'anthropic timeout: ' + detail(e.message), { retryable: true, route });
  if (is('APIUserAbortError')) return new AiClientError('aborted', 'anthropic aborted: ' + detail(e.message), { route });
  if (is('APIConnectionError')) return new AiClientError('connection', 'anthropic connection error: ' + detail(e.message), { retryable: true, route });
  const status = Number(e && e.status) || 0;
  if (status) {
    const body = e.error;
    const msg = (body && body.error && body.error.message) || (body && body.message) || '';
    const code = STATUS_CODES[status] || (status >= 500 ? 'server_error' : 'http_error');
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    return new AiClientError(code, 'anthropic ' + status + ': ' + detail(msg), { status, retryable, route });
  }
  return new AiClientError('unknown', 'anthropic error: ' + detail(e && e.message), { route });
}

async function runGate(gate, route, db) {
  if (gate === 'caller') return null;
  if (!gate || typeof gate !== 'object') throw new AiClientError('gate_required', 'ai-client: gate required for route ' + route, { route });
  const getDb = () => db || require('firebase-admin/firestore').getFirestore();
  const r = await gateFn()(getDb(), Object.assign({}, gate, { feature: route }));
  if (!r || r.ok !== true) {
    throw new AiClientError('gated', (r && r.message) || 'AI is not available.', { status: r && r.status, route, reason: (r && r.reason) || 'plan' });
  }
  return r;
}

/**
 * One Messages API call for a registry route. See the header for the args.
 */
async function createMessage(opts) {
  const o = opts || {};
  const route = String(o.route || '');
  let entry;
  try { entry = Models.routeConfig(route); } catch (e) { throw new AiClientError('unknown_route', e.message, { route }); }
  if (entry.client !== 'ai-client') throw new AiClientError('not_migrated', 'ai-client: route ' + route + ' is still on raw fetch (ai-models.js client)', { route });
  if (entry.temperature !== undefined) throw new AiClientError('unsupported_route', 'ai-client: route ' + route + ' sends temperature, which API 2026-10-21 rejects', { route });

  const gate = await runGate(o.gate, route, o.db);

  const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : '';
  if (!apiKey) throw new AiClientError('not_configured', 'anthropic-not-configured', { route });

  const maxTokens = Number(o.maxTokens) > 0 ? Math.min(Number(o.maxTokens), entry.maxTokens) : entry.maxTokens;
  const req = o.system !== undefined
    ? { model: entry.model, max_tokens: maxTokens, system: o.system, messages: o.messages }
    : { model: entry.model, max_tokens: maxTokens, messages: o.messages };
  const reqOpts = {
    timeout: (_test && _test.timeoutMs) || entry.timeoutMs,
    maxRetries: (_test && _test.maxRetries !== undefined) ? _test.maxRetries : entry.maxRetries,
  };

  let message;
  try {
    message = await clientFor(apiKey).messages.create(req, reqOpts);
  } catch (e) {
    throw mapError(e, route);
  }

  const companyId = o.companyId || (gate && gate.companyId) || undefined;
  const S = spendFns();
  await S.recordAiSpend(S.rowFromAnthropic(route, req.model, message), { log: o.log, companyId });

  const text = ((message && message.content) || []).map((c) => (c && c.type === 'text' ? c.text : '')).join('').trim();
  return { message, text, model: (message && message.model) || req.model, usage: (message && message.usage) || {}, stopReason: (message && message.stop_reason) || null };
}

module.exports = { createMessage, mapError, AiClientError, CODES, API_VERSION, _setTestDeps, _resetTestDeps };
