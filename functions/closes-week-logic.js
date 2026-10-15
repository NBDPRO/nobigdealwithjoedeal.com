/**
 * closes-week-logic.js — "What closes this week" (2026-10-15). PURE, no I/O.
 *
 * ONE ranking, two readers, kept byte-identical:
 *   functions/closes-week-logic.js     the CRM MCP tool closes_this_week (agent-mcp.js)
 *   docs/pro/js/closes-week-logic.js   the Home card (closes-week.js), every layout
 * tests/closes-week-2026-10-15.test.js fails if the two copies drift.
 *
 * Open estimates and deals ranked by likelihood × projected value, each with a
 * plain reason and ONE next action. Likelihood is a transparent heuristic, not
 * AI: a base by stage, then points for signals the CRM already records, every
 * one of which is written into `reasons` so Joe sees why.
 *
 *   base by stage      New 5% · Contacted 10% · Inspected 20% · Estimate sent
 *                      30% · Negotiating 45% · Pre-Qual Sent 40% · Loan
 *                      Approved 65% (deposit / contract = already sold: not listed)
 *   opened estimate    +15% opened in the last 7 days (the "estimate opened"
 *                      alerts, counted per lead) · +5% opened earlier
 *   financing          +10% homeowner tapped "Check my rate" (deal room) or a
 *                      soft pull is on file · +15% loan approved / a deposit
 *                      invoice drafted
 *   last touch         +5% touched in the last 3 days · −10% 14–29 days · −20% 30+
 *   follow-up          −5% when the follow-up date has passed
 *   clamp              2% … 95%
 *
 * Value = the lead's job value, else its latest estimate's total: "projected".
 * Snoozed, deleted, sold, building, won and lost leads are never listed; a
 * lead with no value is not ranked (nothing to project).
 *
 * Next action (one per row; every one only OPENS something or makes a draft):
 *   book_inspection  New / Contacted, no inspection yet
 *   call             follow-up overdue, Inspected (estimate to build), Loan Approved
 *   text             opened the estimate, no reply since → a text draft
 *   resend_estimate  estimate out 2+ days and never opened
 *   check_rate       Pre-Qual Sent → a text draft with the rate-check link
 *
 * rank(leads, opts) → rows sorted by score desc:
 *   { leadId, name, stage, stageLabel, projectedValue, likelihood (0–1),
 *     likelihoodPct, score, reasons: [..], reason: 'a, b', nextAction: { kind, label } }
 *   opts: { nowMs, estimates: [{leadId, grandTotal|total, createdAt}],
 *           views: [{leadId, atMs}] (estimate-opened alerts),
 *           deals: [{leadId, prequalStartedAtMs}], depositDraftLeadIds: [..],
 *           limit, tz }
 * No phone and no email are ever put on a row.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var BASE = {
    'new': 0.05, contacted: 0.10, inspected: 0.20,
    estimate_submitted: 0.30, estimate_sent_cash: 0.30, service_quoted: 0.30, estimate_sent: 0.30, quote_sent: 0.30, proposal_sent: 0.30,
    negotiating: 0.45, prequal_sent: 0.40, loan_approved: 0.65,
  };
  var LABELS = {
    'new': 'New', contacted: 'Contacted', inspected: 'Inspected', estimate_submitted: 'Estimate Sent', estimate_sent_cash: 'Est. Sent',
    service_quoted: 'Service Quoted', estimate_sent: 'Estimate Sent', quote_sent: 'Quote Sent', proposal_sent: 'Proposal Sent',
    negotiating: 'Negotiating', prequal_sent: 'Pre-Qual Sent', loan_approved: 'Loan Approved',
  };
  var ESTIMATE_OUT = { estimate_submitted: 1, estimate_sent_cash: 1, service_quoted: 1, estimate_sent: 1, quote_sent: 1, proposal_sent: 1, negotiating: 1 };
  var ACTION_LABELS = {
    book_inspection: 'Book an inspection', call: 'Call', text: 'Text (draft)',
    resend_estimate: 'Send the estimate again', check_rate: 'Check rate (draft)',
  };

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') { try { return t.toMillis(); } catch (e) { return 0; } }
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (typeof t._seconds === 'number') return t._seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }
  function money(v) {
    if (typeof v === 'number') return isFinite(v) && v > 0 ? v : 0;
    var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) && n > 0 ? n : 0;
  }
  function stageKey(l) {
    var s = String((l && (l._stageKey || l.stage || l.status)) || '').trim();
    if (!s) return 'new';
    var k = s.toLowerCase().replace(/[\s-]+/g, '_');
    if (k === 'new_lead') return 'new';
    if (k === 'estimate_sent') return 'estimate_sent';
    return k;
  }
  function ymdIn(ms, tz) {
    try { return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz || 'America/New_York' }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }
  function daysBetweenYmd(a, b) {
    var x = Date.parse(a + 'T12:00:00Z'), y = Date.parse(b + 'T12:00:00Z');
    return isFinite(x) && isFinite(y) ? Math.round((y - x) / DAY) : 0;
  }
  function nameOf(l) {
    var n = (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim();
    return n || String(l.name || l.customerName || '').trim() || 'Customer';
  }
  function lastTouchMs(l) {
    return Math.max(toMs(l.updatedAt), toMs(l.stageStartedAt), toMs(l.lastContactedAt), toMs(l.createdAt));
  }
  // The homeowner's own last word (an inbound text / call / portal message),
  // when the CRM stamps one; else our own last touch.
  function lastReplyMs(l) {
    return Math.max(toMs(l.lastInboundAt), toMs(l.lastReplyAt), toMs(l.lastContactedAt));
  }
  function sentAtMs(l) { return toMs(l.lastSharedAt) || toMs(l.estimateSentAt) || toMs(l.stageStartedAt) || 0; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /** Is this lead an open estimate / deal the radar should consider? */
  function isOpen(l, nowMs) {
    if (!l || !l.id || l.deleted === true || l.isDeleted === true || l.archived === true || l.e2eTestData) return false;
    if (l.stageRole === 'won' || l.stageRole === 'lost' || l.stageRole === 'job') return false;
    if (toMs(l.snoozedUntil) > nowMs) return false;
    return Object.prototype.hasOwnProperty.call(BASE, stageKey(l));
  }

  function rank(leads, opts) {
    var o = opts || {};
    var nowMs = Number(o.nowMs) || Date.now();
    var tz = o.tz || 'America/New_York';
    var today = ymdIn(nowMs, tz);
    var est = {};
    (o.estimates || []).forEach(function (e) {
      if (!e || !e.leadId || e.deleted === true) return;
      var at = toMs(e.createdAt), v = money(e.grandTotal != null ? e.grandTotal : e.total);
      if (!v) return;
      var cur = est[e.leadId];
      if (!cur || at >= cur.at) est[e.leadId] = { at: at, v: v };
    });
    var views = {};
    (o.views || []).forEach(function (x) {
      if (!x || !x.leadId) return;
      var at = toMs(x.atMs != null ? x.atMs : x.createdAt);
      if (!at || at > nowMs + 60000 || nowMs - at > 7 * DAY) return;
      views[x.leadId] = (views[x.leadId] || 0) + 1;
    });
    var prequal = {};
    (o.deals || []).forEach(function (d) { if (d && d.leadId && toMs(d.prequalStartedAtMs)) prequal[d.leadId] = Math.max(prequal[d.leadId] || 0, toMs(d.prequalStartedAtMs)); });
    var deposit = {};
    (o.depositDraftLeadIds || []).forEach(function (id) { deposit[id] = true; });

    var rows = [];
    (leads || []).forEach(function (l) {
      if (!isOpen(l, nowMs)) return;
      var key = stageKey(l);
      var value = money(l.jobValue) || (est[l.id] ? est[l.id].v : 0);
      if (!value) return;
      var p = BASE[key];
      var reasons = [];
      // estimate opened (the alerts, else the lead's own last-opened stamp)
      var opened = Math.max(toMs(l.lastViewedAt), toMs(l.lastPortalOpenAt), toMs(l.viewedAt));
      var openedAfterSend = ESTIMATE_OUT[key] ? (opened && opened >= sentAtMs(l) - 60000 ? opened : 0) : opened;
      var nViews = views[l.id] || 0;
      var noReply = openedAfterSend && lastReplyMs(l) < openedAfterSend;
      if (nViews > 0 || (openedAfterSend && nowMs - openedAfterSend <= 7 * DAY)) {
        p += 0.15;
        var times = nViews > 1 ? ' ' + nViews + '× this week' : (nViews === 1 ? ' this week' : ' ' + Math.max(0, Math.floor((nowMs - openedAfterSend) / DAY)) + 'd ago');
        reasons.push('opened estimate' + times + (noReply ? ', no reply' : ''));
      } else if (openedAfterSend) {
        p += 0.05;
        reasons.push('opened estimate ' + Math.floor((nowMs - openedAfterSend) / DAY) + 'd ago');
      } else if (ESTIMATE_OUT[key] && sentAtMs(l)) {
        var out = Math.floor((nowMs - sentAtMs(l)) / DAY);
        if (out >= 2) reasons.push('estimate out ' + out + 'd, not opened');
      }
      // financing
      var soft = String(l.softPullStatus || '').toLowerCase();
      var loan = String(l.loanStatus || '').toLowerCase();
      if (key === 'loan_approved' || /approved/.test(loan) || deposit[l.id]) {
        p += 0.15;
        reasons.push(deposit[l.id] ? 'deposit invoice drafted' : 'loan approved');
      } else if (prequal[l.id] || /pass|approved|complete|done|ok/.test(soft)) {
        p += 0.10;
        reasons.push(prequal[l.id] ? 'started a rate check' : 'soft pull on file');
      }
      // last touch
      var touch = lastTouchMs(l);
      var since = touch ? Math.floor((nowMs - touch) / DAY) : null;
      if (since != null && since <= 3) { p += 0.05; reasons.push('touched ' + (since === 0 ? 'today' : plural(since, 'day') + ' ago')); }
      else if (since != null && since >= 30) { p -= 0.20; reasons.push('quiet ' + since + ' days'); }
      else if (since != null && since >= 14) { p -= 0.10; reasons.push('quiet ' + since + ' days'); }
      // follow-up
      var fu = typeof l.followUp === 'string' ? l.followUp.slice(0, 10) : '';
      var late = /^\d{4}-\d{2}-\d{2}$/.test(fu) && fu < today ? daysBetweenYmd(fu, today) : 0;
      if (late > 0) { p -= 0.05; reasons.push('follow-up ' + plural(late, 'day') + ' late'); }
      p = Math.max(0.02, Math.min(0.95, p));

      // next action
      var act;
      if (key === 'new' || key === 'contacted') act = 'book_inspection';
      else if (late > 0) act = 'call';
      else if (key === 'prequal_sent') act = 'check_rate';
      else if (key === 'loan_approved' || key === 'inspected') act = 'call';
      else if (openedAfterSend && noReply) act = 'text';
      else if (ESTIMATE_OUT[key] && !openedAfterSend && sentAtMs(l) && nowMs - sentAtMs(l) >= 2 * DAY) act = 'resend_estimate';
      else act = 'text';
      if (!reasons.length) reasons.push(LABELS[key] || key);

      rows.push({
        leadId: l.id,
        name: nameOf(l),
        stage: key,
        stageLabel: LABELS[key] || key,
        projectedValue: Math.round(value * 100) / 100,
        likelihood: Math.round(p * 100) / 100,
        likelihoodPct: Math.round(p * 100),
        score: Math.round(p * value),
        reasons: reasons,
        reason: reasons.join(', '),
        nextAction: { kind: act, label: ACTION_LABELS[act] },
      });
    });
    rows.sort(function (a, b) { return b.score - a.score || b.likelihood - a.likelihood || (a.leadId < b.leadId ? -1 : 1); });
    var lim = Math.floor(Number(o.limit));
    return lim > 0 ? rows.slice(0, lim) : rows;
  }

  var api = { rank: rank, isOpen: isOpen, stageKey: stageKey, BASE: BASE, ACTION_LABELS: ACTION_LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDClosesWeekLogic = api;
})(typeof window !== 'undefined' ? window : null);
