/**
 * call-merge-logic.js — "Looks like one call" on the Call Center (Call to
 * Close P2, 2026-11-09). PURE: no DOM, no network, no clock. call-center-view.js
 * fetches it when the Call Center opens (ScriptLoader.load), never at boot;
 * require()-able for the tests.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §9 P2.
 *
 * Twin of functions/call-merge-logic.js (callProblem / orderPair /
 * pairProblem / candidates); the server re-checks every merge.
 * tests/call-to-close-split-merge-2026-11-09.test.js holds the two equal.
 *
 * A pair is two calls from the same customer number, same owner tenant,
 * never filed on two different customers, the second starting within 10
 * minutes of the first's end, neither merged, neither personal / spam / a
 * missed call / a text day. Only a suggestion: a person taps Merge.
 *
 *   NBDCallMerge.candidates(calls) → [{ primaryId, secondaryId, gapMs }]
 */
(function (root) {
  'use strict';

  var MERGE_GAP_MS = 10 * 60 * 1000;
  var OVERLAP_GRACE_MS = 60 * 1000;

  function startOf(c) { var n = Number(c && c.startedAtMs); return isFinite(n) && n > 0 ? n : null; }
  function endOf(c) {
    var s = startOf(c);
    var d = c && c.durationSec != null ? Number(c.durationSec) : NaN;
    return s !== null && isFinite(d) && d >= 0 ? s + d * 1000 : null;
  }

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

  function orderPair(a, b) {
    var sa = startOf(a) || 0, sb = startOf(b) || 0;
    var aFirst = sa < sb || (sa === sb && String(a.id) < String(b.id));
    return aFirst ? { primary: a, secondary: b } : { primary: b, secondary: a };
  }

  function pairProblem(a, b) {
    if (!a || !b) return 'No call.';
    if (a.id && b.id && a.id === b.id) return 'The same call.';
    var pa = callProblem(a) || callProblem(b);
    if (pa) return pa;
    if (String(a.phoneDigits) !== String(b.phoneDigits)) return 'Different numbers.';
    if (a.userId !== b.userId || (a.companyId || null) !== (b.companyId || null)) return 'Different owners.';
    if (a.leadId && b.leadId && a.leadId !== b.leadId) return 'Filed on two different customers.';
    var o = orderPair(a, b);
    var end = endOf(o.primary);
    if (end === null) return 'The first call has no length.';
    var gap = startOf(o.secondary) - end;
    if (startOf(o.secondary) <= startOf(o.primary) || gap < -OVERLAP_GRACE_MS) return 'The calls overlap.';
    if (gap > MERGE_GAP_MS) return 'More than 10 minutes apart.';
    // An unfiled first call never takes a redial filed on a customer (the
    // server twin says why).
    if (!o.primary.leadId && o.secondary.leadId) return 'File the first call on the customer first.';
    return '';
  }

  function candidates(calls) {
    var groups = {}, keys = [];
    (calls || []).forEach(function (c) {
      if (!c || !c.id || callProblem(c)) return;
      var k = c.userId + '|' + (c.companyId || '') + '|' + c.phoneDigits;
      if (!groups[k]) { groups[k] = []; keys.push(k); }
      groups[k].push(c);
    });
    var out = [];
    keys.forEach(function (k) {
      var g = groups[k].slice().sort(function (x, y) { return (startOf(x) - startOf(y)) || (String(x.id) < String(y.id) ? -1 : 1); });
      for (var i = 0; i + 1 < g.length; i++) {
        if (pairProblem(g[i], g[i + 1])) continue;
        out.push({ primaryId: g[i].id, secondaryId: g[i + 1].id, gapMs: startOf(g[i + 1]) - endOf(g[i]) });
        i++;
      }
    });
    return out;
  }

  var api = { MERGE_GAP_MS: MERGE_GAP_MS, OVERLAP_GRACE_MS: OVERLAP_GRACE_MS, endOf: endOf, callProblem: callProblem, orderPair: orderPair, pairProblem: pairProblem, candidates: candidates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCallMerge = api;
})(typeof window !== 'undefined' ? window : null);
