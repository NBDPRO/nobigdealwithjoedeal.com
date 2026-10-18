'use strict';

/**
 * functions/morning-brief-delta.js — the 06:45 brief's DELTA MODE, pure.
 *
 * Step 1 of documentation/projects/NOTIFICATION-POLICY-2026-10-18.md. Behind
 * MORNING_BRIEF_DELTA_ENABLED (default off = the brief is byte-for-byte what it
 * was). When on, the three STANDING lists the brief used to repeat every day —
 *   needsWeek   signed jobs with no day and no week   (production-flow-logic)
 *   promises    "you said you'd…" rows, one per person (call-center)
 *   reviewAsks  jobs wrapped and ready for a review ask (review-request-nudge)
 * — collapse to a count plus a link, and are named only when an item is NEW
 * since the previous brief, or crossed a threshold (a promise turned URGENT,
 * or the count passed 10 / 25 / 50). "New leads in the last 24h" is already a
 * delta by construction and is not tracked here.
 *
 * The previous brief is remembered as a SNAPSHOT of ids only (never a name,
 * phone, address or promise text): morningBriefState/{companyId}, server-only
 * (firestore.rules), written after a successful live send. No firebase, no
 * clock of its own — callers pass nowMs.
 *
 * Fail-safe direction: no snapshot / unreadable / stale (> 72 h) / a list the
 * snapshot lacks  =>  that list is treated as all-new, i.e. the full list shows
 * once, exactly like today. Delta mode can only ever show LESS than the current
 * brief when it has positive evidence of what Jo already saw.
 */

const SNAPSHOT_VERSION = 1;
const STALE_MS = 72 * 3600000;
const THRESHOLDS = [10, 25, 50];
const MAX_IDS = 500;
const LISTS = ['needsWeek', 'promises', 'reviewAsks'];

/** Stable id of one row in a list; null = unkeyed (always shown, never remembered). */
function idOf(list, it) {
  if (!it) return null;
  if (list === 'needsWeek') return it.leadId ? String(it.leadId) + '/' + (it.jobId || '-') : null;
  if (list === 'promises') return it.callId ? String(it.callId) : (it.leadId ? 'lead:' + it.leadId : null);
  if (list === 'reviewAsks') return it.id ? String(it.id) : null;
  return null;
}

function isUrgent(list, it) { return list === 'promises' && !!it && it.kind === 'urgent'; }

/** The previous snapshot's entry for one list, or null when absent / malformed / stale. */
function prevList(prev, list, nowMs) {
  const e = prev && prev.v === SNAPSHOT_VERSION && prev.lists && prev.lists[list];
  if (!e || !Array.isArray(e.ids)) return null;
  const at = Number(e.atMs);
  if (!Number.isFinite(at) || nowMs - at > STALE_MS || at > nowMs + 3600000) return null;
  return e;
}

/** Thresholds passed on the way UP (prevCount < t <= count). */
function crossedThresholds(prevCount, count) {
  if (prevCount == null) return [];
  return THRESHOLDS.filter((t) => prevCount < t && count >= t);
}

function deltaForList(list, rows, prevEntry) {
  const items = Array.isArray(rows) ? rows : [];
  const known = prevEntry ? new Set(prevEntry.ids) : null;
  const prevUrgent = prevEntry && Array.isArray(prevEntry.urgent) ? new Set(prevEntry.urgent) : new Set();
  const shown = [];
  let newCount = 0;
  const curIds = new Set();
  for (const it of items) {
    const id = idOf(list, it);
    if (id) curIds.add(id);
    const isNew = !known || !id || !known.has(id);
    // An old promise that turned urgent since yesterday crossed a threshold too.
    const escalated = !isNew && isUrgent(list, it) && !prevUrgent.has(id);
    if (isNew) newCount++;
    if (isNew || escalated) shown.push(it);
  }
  const prevCount = prevEntry ? prevEntry.ids.length : null;
  const cleared = known ? [...known].filter((id) => !curIds.has(id)).length : 0;
  const crossed = crossedThresholds(prevCount, items.length);
  return {
    count: items.length, prevCount, first: !prevEntry,
    shown, newCount, cleared, crossed,
    hasNews: shown.length > 0 || crossed.length > 0,
  };
}

/**
 * @param {object} o
 * @param {object|null} o.prev       the stored snapshot (or null)
 * @param {object[]}   [o.needsWeek] production-flow rows
 * @param {object|null} [o.sections] the absorbed sections (null = absorb off)
 * @param {number}     o.nowMs
 * @returns {{lists: object, hasNews: boolean}}  a list is absent when its
 *   source was not read (absorb off) or could not be trusted (promise read failed)
 */
function computeDelta(o) {
  const opts = o || {};
  const nowMs = Number(opts.nowMs);
  const lists = {};
  lists.needsWeek = deltaForList('needsWeek', opts.needsWeek, prevList(opts.prev, 'needsWeek', nowMs));
  const sec = opts.sections || null;
  if (sec) {
    // A failed promise read may leave rows out; the brief still prints its
    // warning, and buildSnapshot() keeps yesterday's good promises entry.
    lists.promises = deltaForList('promises', sec.promises, prevList(opts.prev, 'promises', nowMs));
    lists.reviewAsks = deltaForList('reviewAsks', sec.reviewAsks, prevList(opts.prev, 'reviewAsks', nowMs));
  }
  const hasNews = LISTS.some((l) => lists[l] && lists[l].hasNews);
  return { lists, hasNews };
}

/**
 * The ids-only snapshot to merge after a successful live send. Lists whose
 * source was not read, or whose promise read failed, are left out so the
 * previous (good) entry survives the merge.
 */
function buildSnapshot(o) {
  const opts = o || {};
  const nowMs = Number(opts.nowMs);
  const cap = (arr) => arr.slice(0, MAX_IDS);
  const ids = (list, rows) => cap((Array.isArray(rows) ? rows : []).map((it) => idOf(list, it)).filter(Boolean));
  const lists = { needsWeek: { atMs: nowMs, ids: ids('needsWeek', opts.needsWeek) } };
  const sec = opts.sections || null;
  if (sec) {
    if (sec.promiseCheckFailed !== true) {
      const rows = Array.isArray(sec.promises) ? sec.promises : [];
      lists.promises = { atMs: nowMs, ids: ids('promises', rows), urgent: cap(rows.filter((it) => isUrgent('promises', it)).map((it) => idOf('promises', it)).filter(Boolean)) };
    }
    lists.reviewAsks = { atMs: nowMs, ids: ids('reviewAsks', sec.reviewAsks) };
  }
  return { v: SNAPSHOT_VERSION, atMs: nowMs, lists };
}

module.exports = {
  SNAPSHOT_VERSION, STALE_MS, THRESHOLDS, MAX_IDS, LISTS,
  idOf, computeDelta, buildSnapshot, crossedThresholds,
};
