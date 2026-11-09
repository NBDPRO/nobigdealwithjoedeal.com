'use strict';

/**
 * functions/call-merge-logic.js — Call to Close P2 (2026-11-09): merging
 * split calls. Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md
 * §9 P2 ("merging split calls"); §3.2 step 5 said P0 only links them.
 *
 * A call that dropped and was redialed lands as two phone_calls docs. This
 * file holds the pure rules; callCenterAction 'merge' / 'unmerge'
 * (call-center.js) is the one writer, and callBrief (call-brief.js) reads a
 * merged primary's transcript through joinTranscripts.
 *
 *   pairProblem(a, b)   '' when the two calls look like one call, else why
 *                       not: same customer number, same owner tenant
 *                       (userId + companyId), never two different customers,
 *                       the second starts within 10 minutes of the first's
 *                       end, an unfiled first call never takes a filed
 *                       redial, neither already merged, neither personal / spam
 *                       / a missed call with no recording / a text day.
 *   orderPair(a, b)     { primary, secondary }: the earlier call is primary.
 *   candidates(calls)   [{ primaryId, secondaryId, gapMs }] for a list, each
 *                       call in at most one pair (a suggestion only: nothing
 *                       merges without a person's tap).
 *   joinTranscripts     primary + SEPARATOR + secondary, in call order.
 *   joinSegIndex        the two calls' segment-confidence indexes, the
 *                       second's char offsets moved past the separator.
 *   fitJoin             both texts trimmed so the joined text fits the
 *                       brief's cap (the redial is never cut off silently).
 *
 * Merging never deletes either doc and never moves audio: both keep their
 * own recording, notes, timeline row and task. Undo clears the two marks.
 *
 * Twin: docs/pro/js/call-merge-logic.js (the Call Center card's suggestion).
 * tests/call-to-close-split-merge-2026-11-09.test.js holds the two equal.
 */

const MERGE_GAP_MS = 10 * 60 * 1000;
// Cube ACR stamps the start to the second and the length is rounded: a
// redial that seems to start a few seconds before the first call ended is
// still a redial. Anything more is two calls at once, not a redial.
const OVERLAP_GRACE_MS = 60 * 1000;
const SEPARATOR = '\n\n[The call dropped here. The same caller, on the next call:]\n\n';

const isCallId = (id) => /^cube_[A-Za-z0-9_-]{5,120}$/.test(String(id || ''));
const startOf = (c) => { const n = Number(c && c.startedAtMs); return Number.isFinite(n) && n > 0 ? n : null; };
function endOf(c) {
  const s = startOf(c);
  const d = c && c.durationSec != null ? Number(c.durationSec) : NaN;
  return s !== null && Number.isFinite(d) && d >= 0 ? s + d * 1000 : null;
}

/** Why this one call cannot be half of a merge ('' when it can). */
function callProblem(c) {
  if (!c || typeof c !== 'object') return 'No call.';
  if (c.channel === 'text') return 'Texts are not merged.';
  if (c.mergedInto || c.mergedFrom) return 'Already merged.';
  if (c.status === 'personal' || c.callType === 'personal' || c.callType === 'spam') return 'Personal or spam calls are not merged.';
  if (c.status === 'listed' || c.status === 'missed') return 'A missed call has no recording to merge.';
  if (!/^\d{10}$/.test(String(c.phoneDigits || ''))) return 'No caller number.';
  if (startOf(c) === null) return 'No start time.';
  if (!c.userId) return 'No owner.';
  return '';
}

/** { primary, secondary }: the earlier call is primary (ties: the smaller id). */
function orderPair(a, b) {
  const sa = startOf(a) || 0, sb = startOf(b) || 0;
  const aFirst = sa < sb || (sa === sb && String(a.id) < String(b.id));
  return aFirst ? { primary: a, secondary: b } : { primary: b, secondary: a };
}

/** '' when a and b look like one call that dropped and was redialed. */
function pairProblem(a, b) {
  if (!a || !b) return 'No call.';
  if (a.id && b.id && a.id === b.id) return 'The same call.';
  const pa = callProblem(a) || callProblem(b);
  if (pa) return pa;
  if (String(a.phoneDigits) !== String(b.phoneDigits)) return 'Different numbers.';
  if (a.userId !== b.userId || (a.companyId || null) !== (b.companyId || null)) return 'Different owners.';
  if (a.leadId && b.leadId && a.leadId !== b.leadId) return 'Filed on two different customers.';
  const { primary, secondary } = orderPair(a, b);
  const end = endOf(primary);
  if (end === null) return 'The first call has no length.';
  const gap = startOf(secondary) - end;
  if (startOf(secondary) <= startOf(primary) || gap < -OVERLAP_GRACE_MS) return 'The calls overlap.';
  if (gap > MERGE_GAP_MS) return 'More than 10 minutes apart.';
  // An unfiled first call never takes a redial filed on a customer: the
  // redial would hide on that customer's page while the primary shows there
  // only by number, and neither could be briefed (review 2026-11-09).
  if (!primary.leadId && secondary.leadId) return 'File the first call on the customer first.';
  return '';
}

/** Suggested pairs in a list of calls (texts and merged calls skipped). */
function candidates(calls) {
  const groups = {};
  (Array.isArray(calls) ? calls : []).forEach((c) => {
    if (!c || !c.id || callProblem(c)) return;
    const k = c.userId + '|' + (c.companyId || '') + '|' + c.phoneDigits;
    (groups[k] = groups[k] || []).push(c);
  });
  const out = [];
  Object.keys(groups).forEach((k) => {
    const g = groups[k].slice().sort((x, y) => (startOf(x) - startOf(y)) || (String(x.id) < String(y.id) ? -1 : 1));
    for (let i = 0; i + 1 < g.length; i++) {
      if (pairProblem(g[i], g[i + 1])) continue;
      out.push({ primaryId: g[i].id, secondaryId: g[i + 1].id, gapMs: startOf(g[i + 1]) - endOf(g[i]) });
      i++; // each call in one pair at most
    }
  });
  return out;
}

/** The marks a merge writes on each doc (never anything else). */
function mergePatch(primaryId, secondaryId, uid, nowMs) {
  return {
    primary: { mergedFrom: secondaryId, mergedInto: null, mergedBy: uid, mergedAtMs: nowMs },
    secondary: { mergedInto: primaryId, mergedFrom: null, mergedBy: uid, mergedAtMs: nowMs },
  };
}
function unmergePatch(uid, nowMs) {
  return { mergedInto: null, mergedFrom: null, mergedBy: null, mergedAtMs: null, unmergedBy: uid, unmergedAtMs: nowMs };
}
/** True when p and s are merged with each other (both marks agree). */
function mergedTogether(p, s) {
  return !!(p && s && p.id && s.id && p.mergedFrom === s.id && s.mergedInto === p.id);
}

/**
 * The transcript a merged primary's brief reads: the first call, the
 * separator, the second call. A second call with no transcript yet adds
 * nothing (its text joins, and the hash changes, once it is transcribed).
 */
function joinTranscripts(primaryText, secondaryText) {
  const a = String(primaryText || '');
  const b = String(secondaryText || '');
  if (!b.trim()) return a;
  return a + SEPARATOR + b;
}

const CUT_MARK = '\n[...the rest of this call is cut for length...]';
/**
 * { a, b }: the two texts, trimmed so a + SEPARATOR + b fits max (call-brief-
 * logic TRANSCRIPT_MAX). Under the cap nothing changes. Over it, a short call
 * keeps all of itself and the long one gives up its end; two long calls keep
 * about half each. A trimmed text ends with CUT_MARK, so the model is told.
 */
function fitJoin(primaryText, secondaryText, max) {
  let a = String(primaryText || '');
  let b = String(secondaryText || '');
  if (!b.trim() || !(max > 0) || a.length + SEPARATOR.length + b.length <= max) return { a, b };
  const room = Math.max(0, max - SEPARATOR.length);
  const half = Math.floor(room / 2);
  const cut = (t, n) => (t.length <= n ? t : t.slice(0, Math.max(0, n - CUT_MARK.length)) + CUT_MARK);
  if (b.length <= half) a = cut(a, room - b.length);
  else if (a.length <= half) b = cut(b, room - a.length);
  else { a = cut(a, half); b = cut(b, room - a.length); }
  return { a, b };
}

/**
 * Both calls' segIndex (call-center-logic buildSegIndex: off[] / lp[] /
 * start[] / end[]) as one index over joinTranscripts. A call with no index
 * counts as one clear segment (lp 0), the same as a call transcribed before
 * the index existed, so the other call's low segments never spill onto it.
 */
function joinSegIndex(pSeg, sSeg, primaryText, secondaryText) {
  const a = String(primaryText || '');
  const b = String(secondaryText || '');
  const ok = (s) => s && Array.isArray(s.off) && Array.isArray(s.lp) && s.off.length && s.off.length === s.lp.length;
  if (!b.trim()) return ok(pSeg) ? pSeg : null;
  if (!ok(pSeg) && !ok(sSeg)) return null;
  const one = { off: [0], lp: [0], start: [0], end: [0] };
  // A segment that starts past a trimmed text's end (fitJoin) is dropped.
  const within = (x, len) => {
    const keep = x.off.map((o, i) => (i === 0 || Number(o) < len ? i : -1)).filter((i) => i >= 0);
    if (keep.length === x.off.length) return x;
    const pickArr = (k) => (Array.isArray(x[k]) && x[k].length === x.off.length ? keep.map((i) => x[k][i]) : undefined);
    return { v: x.v, off: pickArr('off'), lp: pickArr('lp'), start: pickArr('start'), end: pickArr('end') };
  };
  const p = within(ok(pSeg) ? pSeg : one, a.length);
  const s = within(ok(sSeg) ? sSeg : one, b.length);
  const shift = a.length + SEPARATOR.length;
  const arr = (x, k, n) => (Array.isArray(x[k]) && x[k].length === n ? x[k] : new Array(n).fill(0));
  return {
    v: (pSeg && pSeg.v) || (sSeg && sSeg.v) || 1,
    off: p.off.map(Number).concat(s.off.map((o) => Number(o) + shift)),
    lp: p.lp.map(Number).concat(s.lp.map(Number)),
    start: arr(p, 'start', p.off.length).concat(arr(s, 'start', s.off.length)),
    end: arr(p, 'end', p.off.length).concat(arr(s, 'end', s.off.length)),
  };
}

module.exports = {
  MERGE_GAP_MS, OVERLAP_GRACE_MS, SEPARATOR, CUT_MARK,
  isCallId, endOf, callProblem, orderPair, pairProblem, candidates,
  mergePatch, unmergePatch, mergedTogether, joinTranscripts, joinSegIndex, fitJoin,
};
