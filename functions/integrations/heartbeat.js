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
const { AsyncLocalStorage } = require('async_hooks');
const { SECRETS, hasSecret, getSecret } = require('./_shared');
const { planFor } = require('./heartbeat-plan');

const HC_BASE = 'https://hc-ping.com/';
const PING_TIMEOUT_MS = 5_000;
const SECRET_NAME = 'HEALTHCHECKS_PING_KEY';

// Per-job run ledger (2026-11-22, audit BOTS-AGENTS-SCHEDULES-REVIEW §3.8): a
// shared Healthchecks check stays green while its FASTEST member pings, so
// every wrapped run also writes system/heartbeats/cron_runs/<export name> and
// cron-deadman.js judges each job on its own doc. Admin SDK only: no rule
// matches the path, so the default deny keeps clients out. Never name it
// `jobs`, `orders` or `tasks`: firestore.rules has recursive
// {path=**}/<name> read grants for those, and collectionGroup queries on
// them would scan the ledger too.
const LEDGER_COLLECTION = 'system/heartbeats/cron_runs';
const LEDGER_TIMEOUT_MS = 3_000;

// Test seams only: { fetchImpl, pingKey, functionTarget, recordRun }.
// Production never sets these; undefined means "use the real thing".
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

// Caught-error counting (review R4-7, 2026-10-06). Most crons catch per-item
// failures (one lead, one invoice, one email) and carry on, which is right,
// but the run then "succeeds" and the check stays green however many items
// failed. Every logger.error made while a wrapped run is in flight is counted
// (AsyncLocalStorage keeps concurrent runs apart), and a run that finished
// with errors logged pings /fail with the count instead of success. The
// run's own result is untouched. This covers every scheduled job without
// adding each one to the error-rate alert, whose >50-per-5-min threshold a
// once-a-day job can never reach.
const _runs = new AsyncLocalStorage();
let _loggerPatched = false;
function countLoggedErrors() {
  if (_loggerPatched) return;
  _loggerPatched = true;
  const targets = new Set();
  try { targets.add(require('firebase-functions/v2').logger); } catch (_) { /* not installed */ }
  try { const m = require('firebase-functions/logger'); targets.add(m); if (m && m.logger) targets.add(m.logger); } catch (_) { /* not installed */ }
  for (const t of targets) {
    if (!t || typeof t.error !== 'function' || t.error.__nbdCounted) continue;
    const orig = t.error;
    const counted = function (...args) {
      const run = _runs.getStore();
      if (run) run.errors++;
      return orig.apply(this, args);
    };
    counted.__nbdCounted = true;
    try { t.error = counted; } catch (_) { /* read-only export: not counted */ }
  }
}

/**
 * softFail (2026-11-22): a cron that CATCHES the failure of its main work
 * (so one bad pass does not change Cloud Scheduler retries) calls this in the
 * catch, and the run is reported failed: /fail ping, ledger ok:false. The
 * handler still returns normally. Per-item best-effort catches do NOT call
 * it. `expected` lists codes (err.code / err.status / err.response.status)
 * that are an idle state rather than a failure. Logs nothing itself (the call
 * site keeps its own warn). Outside a wrapped run it does nothing.
 * Returns true when the run was marked failed.
 */
function softFail(err, opts) {
  const expected = (opts && Array.isArray(opts.expected)) ? opts.expected.map(String) : [];
  const codes = [err && err.code, err && err.status, err && err.response && err.response.status]
    .filter((c) => c !== undefined && c !== null).map(String);
  if (codes.some((c) => expected.includes(c))) return false;
  const run = _runs.getStore();
  if (!run) return false;
  run.softError = redactText(String((err && err.message) || err || 'failed')).slice(0, 500);
  return true;
}

/**
 * mainWorkRan (2026-11-22): call just before throwing a REPORT rather than a
 * failure of this job (leadAlertWatchdog throws to fail its heartbeat when
 * pipeline-deadman found a problem elsewhere). The /fail ping is unchanged;
 * the ledger records ok:true, so cron-deadman does not alert a second time
 * as if this job had died. Outside a wrapped run it does nothing.
 */
function mainWorkRan() {
  const run = _runs.getStore();
  if (run) run.mainWorkRan = true;
}

/**
 * Mask what could identify a customer before an error leaves the function
 * (ledger doc, Healthchecks body, Joe's lock screen): emails, phone numbers
 * (10-15 digits) and token/key/sig query values.
 */
function redactText(s) {
  return String(s == null ? '' : s)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/([?&](?:token|key|sig|signature|access_token)=)[^&\s'"]+/gi, '$1[redacted]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 10 && n <= 15 ? '[phone]' : m;
    });
}

function withTimeout(p, ms) {
  let timer;
  const t = new Promise((resolve) => { timer = setTimeout(() => resolve({ written: false, reason: 'timeout' }), ms); });
  if (timer && typeof timer.unref === 'function') timer.unref();
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Write one run to system/heartbeats/jobs/<job>. Never rejects. A no-op when
 * no Firebase Admin app is initialised (unit tests; index.js initialises it
 * in production). lastOkAtMs / lastFailAtMs only move on the matching outcome,
 * so a job that keeps failing never looks fresh to cron-deadman.js.
 */
async function recordRunToFirestore(row) {
  try {
    const { getApps } = require('firebase-admin/app');
    if (!getApps().length) return { written: false, reason: 'no-app' };
    const { getFirestore, FieldValue } = require('firebase-admin/firestore');
    const doc = {
      job: row.job, slug: row.slug, schedule: row.schedule || null, timeZone: row.timeZone || null,
      startedAtMs: row.startedAtMs, finishedAtMs: row.finishedAtMs, ok: row.ok,
      error: row.ok ? null : (row.error || 'failed'), caughtErrors: row.caughtErrors || 0,
    };
    if (row.ok) Object.assign(doc, { lastOkAtMs: row.finishedAtMs, consecutiveFails: 0 });
    else Object.assign(doc, { lastFailAtMs: row.finishedAtMs, lastError: doc.error, consecutiveFails: FieldValue.increment(1) });
    const r = await withTimeout(getFirestore().doc(LEDGER_COLLECTION + '/' + row.job).set(doc, { merge: true }).then(() => ({ written: true })), LEDGER_TIMEOUT_MS);
    if (!r.written) logger.warn('[heartbeat] ledger write timed out', { job: row.job });
    return r;
  } catch (e) {
    logger.warn('[heartbeat] ledger write failed', { job: row && row.job, message: String(e && e.message || e).slice(0, 200) });
    return { written: false, error: String(e && e.message || e) };
  }
}

async function recordRun(row) {
  if (!row.job) return { written: false, reason: 'no-job' };
  try {
    return await (_overrides.recordRun || recordRunToFirestore)(row);
  } catch (e) {
    logger.warn('[heartbeat] ledger write failed', { job: row.job, message: String(e && e.message || e).slice(0, 200) });
    return { written: false };
  }
}

/**
 * Wrap a scheduled handler: success → ping, throw → ping /fail then rethrow,
 * finished but logged errors → ping /fail with the count, softFail() → ping
 * /fail with its error. Every outcome is also written to the per-job ledger.
 * meta = { schedule, timeZone } from onSchedule, stored on the ledger doc so
 * the dead-man knows each job's cadence.
 */
function withHeartbeat(slugOrNull, handler, meta) {
  if (typeof handler !== 'function') throw new TypeError('withHeartbeat: handler must be a function');
  countLoggedErrors();
  const m = meta || {};
  return async function heartbeatWrapped(event) {
    const slug = resolveSlug(slugOrNull);
    if (slug === null) return handler(event); // exempt in heartbeat-plan.js
    const t0 = Date.now();
    const run = { errors: 0, softError: null };
    // ok = the job's main work ran. Per-item errors logged on a finished run
    // still ping /fail (as before) but are not a dead job for the ledger.
    const ledger = (ok, error) => recordRun({
      job: currentFunctionName(), slug, schedule: m.schedule, timeZone: m.timeZone,
      startedAtMs: t0, finishedAtMs: Date.now(), ok, error: error ? redactText(error).slice(0, 500) : null, caughtErrors: run.errors,
    });
    try {
      const result = await _runs.run(run, () => handler(event));
      if (run.softError) {
        await Promise.all([
          pingHeartbeat(slug, 'fail', { durationMs: Date.now() - t0, caughtErrors: run.errors, error: run.softError }),
          ledger(false, run.softError),
        ]);
        return result;
      }
      if (run.errors > 0) {
        await Promise.all([
          pingHeartbeat(slug, 'fail', {
            durationMs: Date.now() - t0,
            caughtErrors: run.errors,
            error: run.errors + ' error(s) logged during the run (caught; the run finished)',
          }),
          ledger(true),
        ]);
        return result;
      }
      await Promise.all([pingHeartbeat(slug, 'success', { durationMs: Date.now() - t0 }), ledger(true)]);
      return result;
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 500);
      await Promise.all([
        pingHeartbeat(slug, 'fail', { durationMs: Date.now() - t0, error: msg }),
        run.mainWorkRan ? ledger(true) : ledger(false, msg),
      ]);
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
  return rawOnSchedule(o, withHeartbeat(slug, handler, { schedule: o.schedule, timeZone: o.timeZone }));
}

module.exports = {
  onSchedule,
  withHeartbeat,
  softFail,
  mainWorkRan,
  redactText,
  LEDGER_COLLECTION,
  resolveSlug,
  pingHeartbeat,
  heartbeatSlug,
  heartbeatUrl,
  currentFunctionName,
  HC_BASE,
  SECRET_NAME,
  _overrides,
};
