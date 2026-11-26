/**
 * integrations/turnstile.js — Cloudflare Turnstile verification
 *
 * Humans fill public lead forms; bots fill them with SQLi-looking
 * junk. Turnstile is a free, privacy-friendly CAPTCHA — easier UX
 * than reCAPTCHA and no Google cookies. Drop the widget in the
 * form, pass the token to submitPublicLead, we verify server-side.
 *
 * SETUP:
 *   1. cloudflare.com → Turnstile → new site → grab site + secret key.
 *   2. Set site key in docs/free-guide/... as data-sitekey attr.
 *   3. firebase functions:secrets:set TURNSTILE_SECRET
 *
 * If TURNSTILE_SECRET is unset, verifyTurnstile returns
 * { configured: false } and submitPublicLead falls back to App
 * Check + honeypot + rate limit (still strong — Turnstile is
 * defense in depth).
 *
 * PRODUCTION ENFORCEMENT: set the env var TURNSTILE_REQUIRED=true to make a
 * missing/unset secret fail CLOSED instead of silently waving traffic through.
 * This prevents a Turnstile config drift in prod (secret accidentally cleared)
 * from quietly disabling the CAPTCHA gate. Leave it unset in dev/preview so
 * those environments keep working without a Turnstile secret.
 */

'use strict';

const { logger } = require('firebase-functions/v2');
const { getSecret, hasSecret, notConfigured } = require('./_shared');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token server-side.
 *
 * @param {string} token      cf-turnstile-response from the widget
 * @param {string} remoteip   caller IP (for Turnstile's risk model)
 * @returns {Promise<{ok:boolean, configured:boolean, score?:number, reason?:string}>}
 */
async function verifyTurnstile(token, remoteip) {
  if (!hasSecret('TURNSTILE_SECRET')) {
    // Opt-in hard requirement: in prod, set TURNSTILE_REQUIRED=true so an
    // unset secret fails closed rather than silently passing on App Check +
    // honeypot + rate limit alone. Default (unset) preserves the original
    // defense-in-depth passthrough for dev/preview.
    if (String(process.env.TURNSTILE_REQUIRED).toLowerCase() === 'true') {
      logger.error('Turnstile required (TURNSTILE_REQUIRED=true) but TURNSTILE_SECRET is unset — failing closed');
      return { ok: false, configured: false, reason: 'turnstile-required' };
    }
    return { ok: true, configured: false };  // allow when not configured
  }
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) {
    return { ok: false, configured: true, reason: 'missing-token' };
  }
  try {
    const body = new URLSearchParams();
    body.set('secret', getSecret('TURNSTILE_SECRET'));
    body.set('response', token);
    if (remoteip) body.set('remoteip', remoteip);
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      // Q4: bound the outbound call so a Turnstile incident cannot
      // hold our function instances open for the full 15s handler
      // budget. At 10K-user spikes an unterminated fetch drains the
      // concurrency pool in seconds; a 5s abort lets the caller fail
      // fast with the existing fail-closed path below.
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json();
    // Turnstile returns { success: true|false, "error-codes": [...] }
    if (data && data.success === true) {
      return { ok: true, configured: true };
    }
    logger.warn('Turnstile verify rejected', { codes: data['error-codes'] });
    return { ok: false, configured: true, reason: (data['error-codes'] || []).join(',') || 'rejected' };
  } catch (e) {
    // Fail CLOSED on verifier error — an attacker who can 500 the
    // Turnstile API shouldn't get past the gate.
    logger.error('Turnstile verify error:', e.message);
    return { ok: false, configured: true, reason: 'verify-error' };
  }
}

/**
 * Turnstile POSTURE for the daily lead-gateway probe (2026-11-26). A server
 * cannot solve a Turnstile challenge, so the probe checks what broke on
 * 2026-10-13 instead: the flag on with no real secret fails exactly as a
 * visitor's submit would; with a secret set, Cloudflare is asked about a
 * dummy token. A valid secret answers only `invalid-input-response` (the
 * token is bad); a wrong or deleted secret answers `invalid-input-secret`;
 * Cloudflare unreachable fails like verifyTurnstile's verify-error.
 * @returns {Promise<{ok:boolean, configured:boolean, reason?:string}>}
 */
const PROBE_DUMMY_TOKEN = 'nbd-lead-probe-dummy-token';
async function turnstilePosture() {
  if (!hasSecret('TURNSTILE_SECRET')) {
    if (String(process.env.TURNSTILE_REQUIRED).toLowerCase() === 'true') {
      return { ok: false, configured: false, reason: 'turnstile-required' };
    }
    return { ok: true, configured: false };
  }
  try {
    const body = new URLSearchParams();
    body.set('secret', getSecret('TURNSTILE_SECRET'));
    body.set('response', PROBE_DUMMY_TOKEN);
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json();
    const codes = (data && Array.isArray(data['error-codes'])) ? data['error-codes'] : [];
    if (data && data.success === false && codes.length === 1 && codes[0] === 'invalid-input-response') {
      return { ok: true, configured: true };
    }
    return { ok: false, configured: true, reason: 'posture:' + (codes.join(',') || 'unexpected-answer') };
  } catch (e) {
    return { ok: false, configured: true, reason: 'verify-error' };
  }
}

module.exports = { verifyTurnstile, turnstilePosture };
