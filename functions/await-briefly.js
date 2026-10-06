/**
 * functions/await-briefly.js — finish small best-effort writes BEFORE the
 * response, without letting them slow it much (review R4-10, 2026-10-06).
 *
 * The homeowner-facing endpoints (portal, shared report, remote signing, deal
 * room) fired their view/use counters and the "homeowner viewed" alert
 * without await and then responded. On Cloud Run the CPU is throttled once
 * the response is sent, so those writes could be lost — and the alert's 6h
 * throttle could already be claimed. awaitBriefly waits for them (each
 * already swallows its own error) for at most `ms`, then lets the response
 * go. Never throws.
 */
'use strict';

const DEFAULT_MS = 1500;

async function awaitBriefly(promises, ms) {
  const list = (Array.isArray(promises) ? promises : [promises])
    .filter(Boolean)
    .map((p) => Promise.resolve(p).catch(() => {}));
  if (!list.length) return { settled: true };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms == null ? DEFAULT_MS : ms); });
  const settled = await Promise.race([Promise.all(list).then(() => true), timeout]);
  clearTimeout(timer);
  return { settled };
}

module.exports = { awaitBriefly, DEFAULT_MS };
