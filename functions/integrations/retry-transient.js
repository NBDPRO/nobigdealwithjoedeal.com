'use strict';
/**
 * retry-transient.js — retry a network call on transient failures only.
 *
 * hailMatchCron lost a few leads per run to "fetch failed" / "terminated"
 * (2026-10-02/03 audit). Those leads weren't stamped, so they only came back
 * a day later. One or two short retries catch the blip the same run. Only
 * transient errors retry; a real error (bad response, parse failure) throws
 * straight through so it isn't hidden.
 *
 * Not exported from functions/index.js (it's a helper, not a function).
 */
const TRANSIENT_RE = /fetch failed|terminated|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|aborted|timeout/i;

function isTransient(e) {
  if (!e) return false;
  const name = String(e.name || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return TRANSIENT_RE.test(String(e.message || '')) || TRANSIENT_RE.test(String(e.cause && e.cause.code || ''));
}

async function retryTransient(fn, { delaysMs = [1500, 4000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delaysMs.length || !isTransient(e)) throw e;
      await sleep(delaysMs[attempt]);
    }
  }
}

module.exports = { retryTransient, isTransient };
