/**
 * integrations/heartbeat.js — dead-man's-switch pings for every scheduled function
 *
 * WHY (2026-09-04)
 * ────────────────
 * Cloud Monitoring cannot say "this daily cron stopped": `conditionAbsent`
 * caps at 23h30m, shorter than a daily cadence, so an absence alert on a
 * once-a-day job false-fires every day (STABILITY-AUDIT-2026-09-04). The
 * proof is `migrationsTick`, silent since 2026-08-31 with nothing watching,
 * and before it the three backup crons that failed every night for weeks.
 * A heartbeat monitor inverts the problem: each run PINGS an external
 * service, and the service alerts when the ping does not arrive. Grace
 * periods are per check, so "daily" and "every minute" are both expressible.
 *
 * Healthchecks.io: free hobbyist tier, 20 checks, no card; slug-addressed
 * pings `https://hc-ping.com/<ping-key>/<slug>` (append `/fail` to flag a
 * failed run). A slug with no check behind it returns 404 and is ignored, so
 * Jo creates only the checks he wants and the code stays list-free.
 *
 * HOW
 * ───
 * This module exports a drop-in `onSchedule` with the same signature as
 * firebase-functions/v2/scheduler's. It (1) adds SECRETS.HEALTHCHECKS_PING_KEY
 * to the function's `secrets` so the key is bound at deploy, and (2) wraps the
 * handler so a success pings `<slug>` and a throw pings `<slug>/fail` and then
 * rethrows. Every cron file swaps ONE import line; tests/cron-heartbeat.test.js
 * fails CI if a scheduled function imports the raw scheduler instead.
 *
 * The slug is the export name in kebab-case (`hailMatchCron` →
 * `hail-match-cron`), read at run time from FUNCTION_TARGET (the Functions
 * Framework sets it to the exported name). K_SERVICE is the lowercase Cloud
 * Run name and only a fallback — it would give `hailmatchcron`. The slug is
 * logged on the first ping of each instance so the exact string can be read
 * from the logs when creating the check. `{ heartbeat: 'custom-slug' }` in
 * the options overrides it; `{ heartbeat: false }` opts a function out.
 *
 * 2026-10-04: 35 crons vs a 20-check free tier, so the slug now comes from
 * heartbeat-plan.js first (dedicated checks keep their kebab slug; low-stakes
 * crons on one cadence share a check; `exempt` opts out). The kebab default
 * remains the fallback for a cron missing from the plan — which CI rejects.
 *
 * When HEALTHCHECKS_PING_KEY is unset (the deploy's `__unset__` stub) every
 * ping is a no-op — nothing changes for a project that never configures it.
 * A ping never throws into the cron: a monitoring outage must not fail the
 * work it monitors.
 *
 * SETUP: documentation/runbooks/HEALTHCHECKS-SETUP.md
 */

'use strict';

const { onSchedule: rawOnSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { SECRETS, hasSecret, getSecret } = require('./_shared');
const { planFor } = require('./heartbeat-plan');

const HC_BASE = 'https://hc-ping.com/';
const PING_TIMEOUT_MS = 5_000;
const SECRET_NAME = 'HEALTHCHECKS_PING_KEY';

// Test seams only: { fetchImpl, pingKey, functionTarget }. Production never
// sets these; undefined means "use the real thing".
const _overrides = {};
const _loggedSlugs = new Set();

function heartbeatSlug(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function currentFunctionName() {
  if (_overrides.functionTarget !== undefined) return _overrides.functionTarget || '';
  return process.env.FUNCTION_TARGET || process.env.K_SERVICE || '';
}

function heartbeatUrl(pingKey, slug, outcome) {
  const base = HC_BASE + encodeURIComponent(String(pingKey)) + '/' + slug;
  if (outcome === 'fail') return base + '/fail';
  if (outcome === 'start') return base + '/start';
  return base;
}

function resolvePingKey() {
  if (_overrides.pingKey !== undefined) return _overrides.pingKey || null;
  return hasSecret(SECRET_NAME) ? getSecret(SECRET_NAME) : null;
}

/**
 * POST one ping. Resolves to { sent, status|reason|error }; never rejects.
 * @param {string} slug
 * @param {'success'|'fail'|'start'} outcome
 * @param {object} meta  small JSON shown in the check's ping log (duration, error)
 */
async function pingHeartbeat(slug, outcome = 'success', meta = {}) {
  const pingKey = resolvePingKey();
  if (!pingKey) return { sent: false, reason: 'unset' };
  if (!slug) return { sent: false, reason: 'no-slug' };
  if (!_loggedSlugs.has(slug)) {
    _loggedSlugs.add(slug);
    logger.info('[heartbeat] pinging as slug', { slug });
  }
  const url = heartbeatUrl(pingKey, slug, outcome);
  const fetchImpl = _overrides.fetchImpl || fetch;
  try {
    const body = JSON.stringify({ outcome, ...meta }).slice(0, 10_000);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'NBDProCRM/1.0 heartbeat' },
      body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 = no check with this slug yet — expected until Jo creates it.
      logger.warn('[heartbeat] ping not accepted', { slug, outcome, status: res.status });
      return { sent: false, status: res.status };
    }
    return { sent: true, status: res.status };
  } catch (e) {
    logger.warn('[heartbeat] ping failed', { slug, outcome, message: String(e && e.message || e).slice(0, 200) });
    return { sent: false, error: String(e && e.message || e) };
  }
}

/** Wrap a scheduled handler: success → ping, throw → ping /fail then rethrow. */
/**
 * The slug this run pings: an explicit `heartbeat: 'slug'` option wins, then
 * the plan in heartbeat-plan.js (shared checks — 35 crons, 20 free checks),
 * then the kebab-case export name. `null` = the plan exempts this cron.
 */
function resolveSlug(explicit) {
  if (explicit) return explicit;
  const name = currentFunctionName();
  const planned = planFor(name);
  if (planned === null) return null;
  return planned || heartbeatSlug(name);
}

function withHeartbeat(slugOrNull, handler) {
  if (typeof handler !== 'function') throw new TypeError('withHeartbeat: handler must be a function');
  return async function heartbeatWrapped(event) {
    const slug = resolveSlug(slugOrNull);
    if (slug === null) return handler(event); // exempt in heartbeat-plan.js
    const t0 = Date.now();
    try {
      const result = await handler(event);
      await pingHeartbeat(slug, 'success', { durationMs: Date.now() - t0 });
      return result;
    } catch (e) {
      await pingHeartbeat(slug, 'fail', {
        durationMs: Date.now() - t0,
        error: String(e && e.message || e).slice(0, 500),
      });
      throw e;
    }
  };
}

/**
 * Drop-in for firebase-functions/v2/scheduler's onSchedule.
 *   onSchedule(opts, handler)        — opts.secrets gains the ping key
 *   onSchedule('every 5 minutes', h) — string form supported like the original
 *   opts.heartbeat: 'slug' | false   — override the slug, or opt out entirely
 */
function onSchedule(opts, handler) {
  const o = typeof opts === 'string' ? { schedule: opts } : Object.assign({}, opts || {});
  if (o.heartbeat === false) {
    delete o.heartbeat;
    return rawOnSchedule(o, handler);
  }
  const slug = typeof o.heartbeat === 'string' && o.heartbeat ? heartbeatSlug(o.heartbeat) : null;
  delete o.heartbeat;
  const secrets = Array.isArray(o.secrets) ? o.secrets.slice() : [];
  if (!secrets.includes(SECRETS[SECRET_NAME])) secrets.push(SECRETS[SECRET_NAME]);
  o.secrets = secrets;
  return rawOnSchedule(o, withHeartbeat(slug, handler));
}

module.exports = {
  onSchedule,
  withHeartbeat,
  resolveSlug,
  pingHeartbeat,
  heartbeatSlug,
  heartbeatUrl,
  currentFunctionName,
  HC_BASE,
  SECRET_NAME,
  _overrides,
};
