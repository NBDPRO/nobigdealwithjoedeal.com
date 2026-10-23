/**
 * call-center-loop-logic.js - the call-to-job loop's two pure rules (Horizon 3, step 3; no DOM, no Firestore).
 *
 *   1. Which customers a call's NUMBER points at. Calls match leads by phoneDigits / the lead's phone fields (a call's
 *      own leadId is null until it is filed). One match is a sure thing; two or more is a shared number (a couple, a
 *      duplicate lead) where the screen must ask, never pick the first; three or more is a relay/proxy line and says
 *      nothing about who called.
 *   2. The reminder that filing a call makes. Attaching a noted call to a customer already writes a follow-up task on the
 *      server (functions/call-center-logic.js buildFollowUpTask: createIfAbsent, id cube-<callId>). This is that rule,
 *      mirrored, so the card can say what filing will set BEFORE the tap. Parity is pinned by a test that runs both files
 *      on the same inputs. Nothing here writes or sends anything.
 *
 * Loaded before call-center-view.js (lazy bundle 'callcenter').
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  // Server TASK_WINDOW_MS: only a call from the last 14 days makes a task (an older one still gets notes + a timeline entry).
  const TASK_WINDOW_MS = 14 * DAY;
  const PROXY_AT = 3;                                                       // a number on this many customers is a relay line

  /** Last 10 digits (a leading 1 dropped), '' when it is not a 10-digit number. Same key the server files by. */
  function digits10(v) {
    let d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function leadName(l) { return l ? (((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.address || 'Customer') : ''; }

  /**
   * The customers a number is on: { candidates: [{ leadId, name }], proxy }. Deleted leads never count; the same lead is
   * listed once. 3+ matches is a proxy line: no candidates at all, so nothing can be suggested from it.
   */
  function candidatesForNumber(leads, num) {
    const d = digits10(num);
    const out = { candidates: [], proxy: false };
    if (!d) return out;
    const seen = {};
    (leads || []).forEach((l) => {
      if (!l || !l.id || l.deleted || seen[l.id]) return;
      if ([l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone].some((p) => digits10(p) === d)) {
        seen[l.id] = true;
        out.candidates.push({ leadId: l.id, name: leadName(l) });
      }
    });
    if (out.candidates.length >= PROXY_AT) return { candidates: [], proxy: true };
    return out;
  }

  const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

  /**
   * The reminder filing this call will set: { title, dueDate, high } or null (no promise of yours and no follow-up date, a call
   * older than 14 days, or a call whose notes are not written yet - the server files the task when the notes land).
   */
  function followUpPreview(call, nowMs, todayYmd) {
    if (!call || call.channel === 'text' || call.status !== 'noted') return null;
    if (Number.isFinite(nowMs) && (Number(call.startedAtMs) || 0) < nowMs - TASK_WINDOW_MS) return null;
    const mine = (Array.isArray(call.promises) ? call.promises : []).filter((p) => p && p.who === 'jo');
    const follow = call.followUpDate || null;
    if (!mine.length && !follow) return null;
    const who = call.contactName || 'customer';
    const first = mine[0];
    const title = clip(first ? first.text + ' (' + who + ')' : 'Follow up with ' + who, 200);
    const dues = mine.map((p) => p.due).filter(Boolean).concat(follow ? [follow] : []).sort();
    return { title: title, dueDate: dues[0] || todayYmd, high: !!call.urgent };
  }

  const api = { TASK_WINDOW_MS, PROXY_AT, digits10, candidatesForNumber, followUpPreview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCallCenterLoop = api;
})(typeof window !== 'undefined' ? window : null);
