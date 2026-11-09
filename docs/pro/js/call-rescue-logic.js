/**
 * call-rescue-logic.js — "Needs a next step", the lost-lead rescue list on the
 * Call Center (Call to Close P1, 2026-11-09). PURE: no DOM, no network, no
 * clock (the caller passes nowMs). call-center-view.js fetches it when the
 * Call Center opens (ScriptLoader.load), never at boot; require()-able for
 * the tests.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §6 #7.
 *
 * A row is a customer whose newest contact is a noted business call at least
 * 2 days old (and inside the last 30 days) after which nothing happened:
 *   - no promise: none in the notes (promises[]), none captured on the call
 *     (promise / promiseTaskId)
 *   - no follow-up date: not on the call, and the customer's follow-up is
 *     not on or after the call's day
 *   - no stage move since the call (lead.stageStartedAt)
 *   - not dismissed (rescueDismissedAtMs, callCenterAction rescueDismiss)
 * Never a personal / spam / supplier / sub call, a call with no notes yet, a
 * call on no customer (those are already on Needs attention), a customer this
 * page did not load, a deleted or closed customer (opts.isClosed). One row per
 * customer. The count is the list's length: nothing is estimated.
 *
 *   NBDCallRescue.list(calls, leadsById, { nowMs, isClosed? })
 *     → [{ call, lead, days }] newest call first
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var MIN_AGE_MS = 2 * DAY;
  var WINDOW_MS = 30 * DAY;
  var NOT_LEADS = ['personal', 'spam', 'supplier', 'sub'];

  function ms(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  function etYmd(t) { return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
  function ymdOf(v) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? '' : v)); return m ? m[1] : ''; }

  function hasNextStep(c, lead) {
    if ((Array.isArray(c.promises) ? c.promises : []).length) return true;
    if (c.promise || c.promiseTaskId) return true;
    if (c.followUpDate) return true;
    var fu = ymdOf(lead.followUp);
    if (fu && fu >= etYmd(c.startedAtMs)) return true;
    return ms(lead.stageStartedAt) > c.startedAtMs;
  }

  function list(calls, leadsById, opts) {
    var o = opts || {};
    var now = Number(o.nowMs) || 0;
    var leads = leadsById || {};
    var isClosed = typeof o.isClosed === 'function' ? o.isClosed : function () { return false; };
    // Each customer's newest contact (a call or a day of texts) on this page.
    var newest = {};
    (calls || []).forEach(function (c) {
      if (!c || !c.leadId) return;
      var t = Number(c.startedAtMs) || 0;
      if (!newest[c.leadId] || t > (Number(newest[c.leadId].startedAtMs) || 0)) newest[c.leadId] = c;
    });
    var out = [];
    Object.keys(newest).forEach(function (leadId) {
      var c = newest[leadId];
      var lead = leads[leadId];
      if (!lead || lead.deleted === true || isClosed(lead)) return;
      if (c.channel === 'text' || c.status !== 'noted' || !c.callType || NOT_LEADS.indexOf(c.callType) !== -1) return;
      if (c.rescueDismissedAtMs) return;
      var age = now - (Number(c.startedAtMs) || 0);
      if (!(c.startedAtMs > 0) || age < MIN_AGE_MS || age > WINDOW_MS) return;
      if (hasNextStep(c, lead)) return;
      out.push({ call: c, lead: lead, days: Math.floor(age / DAY) });
    });
    return out.sort(function (a, b) { return (b.call.startedAtMs || 0) - (a.call.startedAtMs || 0); });
  }

  var api = { list: list, MIN_AGE_MS: MIN_AGE_MS, WINDOW_MS: WINDOW_MS, NOT_LEADS: NOT_LEADS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCallRescue = api;
})(typeof window !== 'undefined' ? window : null);
