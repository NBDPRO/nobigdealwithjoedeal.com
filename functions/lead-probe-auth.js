/**
 * functions/lead-probe-auth.js — who may use submitPublicLead's probe mode
 * (2026-11-26, web-leads outage follow-up 5; Joe chose Google ID tokens).
 *
 * The daily leadGatewayProbe cron proves the live lead gateway would accept a
 * homeowner's submit, without storing one. Probe mode must never be a public
 * switch, so the gateway enters it only when the request carries a Google ID
 * token that:
 *   - Google signed (google-auth-library OAuth2Client.verifyIdToken: signature,
 *     expiry, issuer),
 *   - names the gateway's own URL as its audience, and
 *   - was minted for THIS function's own runtime service account (read from
 *     the metadata server), with email_verified true.
 * The cron runs as the same default runtime account, so "the caller is me" is
 * the whole rule: no new secret, nothing to configure. A token from any other
 * account, project or audience is refused, and an unknown own-account (the
 * metadata server unreachable) refuses everything rather than trusting anyone.
 *
 * The token travels in x-nbd-probe-token, not Authorization, so the platform
 * in front of a public Cloud Run service never interprets it.
 */
'use strict';

const PROBE_HEADER = 'x-nbd-lead-probe';
const TOKEN_HEADER = 'x-nbd-probe-token';
/** Honeypot value on every probe body: an older gateway pretends success and stores nothing. */
const PROBE_SENTINEL = 'nbd-lead-probe';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';

/** Test seams: verifyIdToken(token, audience) -> payload, selfEmail() -> string. */
const _overrides = {};

function probeAudience(env) {
  const e = env || process.env;
  const project = e.GCLOUD_PROJECT || e.GCP_PROJECT || 'nobigdeal-pro';
  return 'https://us-central1-' + project + '.cloudfunctions.net/submitPublicLead';
}

function header(req, name) {
  const h = (req && req.headers) || {};
  const v = h[name];
  return typeof v === 'string' ? v : '';
}

function isProbeRequest(req) {
  return header(req, PROBE_HEADER) !== '';
}

let _client = null;
async function defaultVerify(token, audience) {
  if (!_client) _client = new (require('google-auth-library').OAuth2Client)();
  const ticket = await _client.verifyIdToken({ idToken: token, audience });
  return ticket.getPayload();
}

let _self = null;
async function defaultSelfEmail() {
  if (_self) return _self;
  const res = await fetch(METADATA + 'email', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error('metadata email ' + res.status);
  _self = String(await res.text()).trim();
  return _self;
}

/** @returns {Promise<{ok:boolean, reason?:string}>} */
async function verifyProbeCaller(req) {
  const token = header(req, TOKEN_HEADER);
  if (!token || token.length > 4096) return { ok: false, reason: 'no-token' };
  let self = '';
  try { self = await (_overrides.selfEmail || defaultSelfEmail)(); } catch (_) { self = ''; }
  if (!self) return { ok: false, reason: 'self-unknown' };
  let payload = null;
  try { payload = await (_overrides.verifyIdToken || defaultVerify)(token, probeAudience()); } catch (_) { payload = null; }
  if (!payload) return { ok: false, reason: 'bad-token' };
  if (payload.email_verified !== true || String(payload.email || '') !== self) return { ok: false, reason: 'wrong-account' };
  return { ok: true };
}

/** For the cron: an ID token for the gateway, minted by the metadata server. */
async function mintProbeToken(audience) {
  const url = METADATA + 'identity?format=full&audience=' + encodeURIComponent(audience);
  const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('metadata identity ' + res.status);
  return String(await res.text()).trim();
}

module.exports = { PROBE_HEADER, PROBE_SENTINEL, TOKEN_HEADER, probeAudience, isProbeRequest, verifyProbeCaller, mintProbeToken, _overrides };
