/**
 * follow-up-board-logic.js — the Follow-up board's pure ranking (2026-11-03).
 *
 * Extends the Open Estimates Follow-Up Board (estimate-follow-board.js, loaded
 * first) with a four-section priority list. Jo's order (decided 2026-11-03):
 *
 *   1. waiting   a customer wrote and you have not answered (and it has been
 *                at least 2 hours, so a reply in progress is not nagged)
 *   2. promised  you tapped "I promised an estimate" and no estimate has gone
 *                out since; flagged once the promise is 4 hours old
 *   3. quiet     an estimate went out and nobody answered (the existing board's
 *                buildBoard rules, unchanged)
 *   4. stale     a lead still at New, 3+ days old, with no touch from you
 *
 * A lead appears ONCE, in the highest section it qualifies for. Inside a
 * section: biggest dollar value first (jobValue, projected), then oldest.
 * Do-not-contact and snoozed leads are COUNTED, never shown, so nobody is
 * silently dropped. Lost / won / deleted leads are out.
 *
 * NOTHING SENDS. The board only offers drafts (the existing fileLeadTextDraft
 * callable, template keys fu_* / est_follow_*) for Jo to edit and send himself.
 * Money: jobValue only (customer-facing, projected). No cost or margin field.
 *
 * Pure: UMD, no DOM, injected clock. Ships dark behind the `followUpBoard` flag.
 */
(function (root) {
  'use strict';

  var HOUR = 3600000, DAY = 86400000;
  var FLAG = 'followUpBoard';
  var WAIT_MS = 2 * HOUR;               // a customer message younger than this is not "waiting" yet
  var PROMISE_GRACE_MS = 4 * HOUR;      // a promised estimate is flagged after this long
  var STALE_NEW_DAYS = 3;
  var SECTIONS = [
    { key: 'waiting', label: 'Customers waiting on your reply', template: 'fu_reply_ack' },
    { key: 'promised', label: 'Estimates you promised', template: 'fu_promise_est' },
    { key: 'quiet', label: 'Estimates sent, no answer', template: null },
    { key: 'stale', label: 'New leads nobody has touched', template: 'fu_new_checkin' }
  ];

  var EF = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./estimate-followups.js') : null;
  var EB = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./estimate-follow-board.js') : null;
  // Resolved lazily: in the browser the two files above may finish loading after this one runs.
  function ef() { if (!EF && root) EF = root.NBDEstimateFollowups || null; return EF; }
  function eb() { if (!EB && root && root.NBDEstimateFollowBoard) EB = root.NBDEstimateFollowBoard._pure || null; return EB; }

  function toMs(t) { return ef() ? ef().toMs(t) : 0; }
  function stageKeyOf(l) { return String((l && (l.stage || l.status)) || '').trim().toLowerCase(); }
  function nameOf(l) {
    var n = (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim();
    return n || String(l.name || l.customerName || '').trim() || String(l.address || '').split(',')[0] || 'Customer';
  }
  function firstNameOf(l) {
    var f = String((l && l.firstName) || '').trim();
    return f ? f.split(/\s+/)[0] : '';
  }
  function isThumbtack(l) { return /thumbtack/i.test(String((l && l.source) || '')); }
  function sourceLabel(l) {
    var s = String((l && l.source) || '').trim();
    if (/thumbtack/i.test(s)) return 'Thumbtack';
    if (/^website/i.test(s)) return 'Website';
    return s ? s.slice(0, 24) : '';
  }

  /** The customer's newest message, as a moment: a text (lastInboundAt) or a portal message. */
  function inboundMs(l) { return Math.max(toMs(l && l.lastInboundAt), toMs(l && l.lastHomeownerMessageAt)); }
  /** Jo's newest answer or touch. lastOutboundAt is the board's own "I replied" stamp. */
  function answeredMs(l) {
    return Math.max(toMs(l && l.lastRepMessageAt), toMs(l && l.lastContactedAt), toMs(l && l.lastEstimateNudgeAt), toMs(l && l.lastOutboundAt));
  }
  /** When an estimate was last actually shared: explicit facts only (a stage move is not a send). */
  function estimateSharedMs(l) { return Math.max(toMs(l && l.lastSharedAt), toMs(l && l.estimateSentAt)); }

  /** A customer message exists, is newer than Jo's last answer, and is at least 2 hours old. */
  function isWaiting(l, nowMs) {
    var inb = inboundMs(l);
    return inb > 0 && inb <= nowMs && inb > answeredMs(l) && nowMs - inb >= WAIT_MS;
  }
  /** Promised and no estimate shared since. */
  function isPromiseOpen(l) {
    var p = toMs(l && l.estimatePromisedAt);
    return p > 0 && estimateSharedMs(l) < p;
  }
  /** Promise is open AND old enough to flag (4 hours). */
  function isPromiseDue(l, nowMs) {
    var p = toMs(l && l.estimatePromisedAt);
    return isPromiseOpen(l) && p <= nowMs && nowMs - p >= PROMISE_GRACE_MS;
  }
  /** Stage New, 3+ days old, nothing from Jo, and no customer message sitting there. */
  function isStaleNew(l, nowMs) {
    var role = String((l && l.stageRole) || '').toLowerCase();
    if (role !== 'new' && stageKeyOf(l) !== 'new') return false;
    var created = toMs(l.createdAt);
    if (!created || created > nowMs || Math.floor((nowMs - created) / DAY) < STALE_NEW_DAYS) return false;
    if (answeredMs(l) > 0) return false;
    return inboundMs(l) === 0;
  }

  function isOut(l) {
    if (!l || !l.id) return true;
    if (ef().isClosedLead(l)) return true;
    return !!(eb() && eb().isSigned(l));
  }

  function channelFor(l) {
    var b = eb();
    if (isThumbtack(l)) return b.canText(l) ? 'text' : 'call';   // Thumbtack gives no email: text the phone or call
    return b.channelOf(l);
  }

  function ageLabel(ms) {
    if (ms < DAY) return Math.max(1, Math.floor(ms / HOUR)) + 'h';
    return Math.floor(ms / DAY) + 'd';
  }

  function baseRow(l, section, ageMs, lastAction, nowMs, waitingIds) {
    var ch = channelFor(l);
    var tpl = SECTIONS.filter(function (s) { return s.key === section; })[0].template;
    return {
      leadId: l.id, name: nameOf(l), firstName: firstNameOf(l), section: section,
      source: sourceLabel(l), valueCents: eb().valueCents(l), ageMs: ageMs, age: ageLabel(ageMs),
      lastAction: lastAction, channel: ch, templateKey: tpl, canDraft: ch === 'text' && !!tpl,
      draftWaiting: !!(waitingIds && waitingIds[l.id])
    };
  }

  /**
   * buildFollowUps(leads, nowMs, opts) →
   *   { sections:[{key,label,rows,valueCents}] (always 4, in rank order),
   *     total, valueCents, held:{dnc,snoozed} }
   * opts.waitingDraftIds: { leadId: true } for rows that already have a draft waiting.
   */
  function buildFollowUps(leads, nowMs, opts) {
    var o = opts || {};
    var now = nowMs == null ? Date.now() : nowMs;
    var waitingIds = o.waitingDraftIds || {};
    var out = { sections: [], total: 0, valueCents: 0, held: { dnc: 0, snoozed: 0 } };
    var by = { waiting: [], promised: [], quiet: [], stale: [] };
    var used = {};
    var live = [];

    (leads || []).forEach(function (l) {
      if (isOut(l)) return;
      // The highest section this lead would land in, if it were not held back.
      var sec = isWaiting(l, now) ? 'waiting' : isPromiseDue(l, now) ? 'promised' : isStaleNew(l, now) ? 'stale' : null;
      if (sec) {
        if (eb().isHardStop(l)) { out.held.dnc++; used[l.id] = true; return; }
        if (ef().isSnoozed(l, now)) { out.held.snoozed++; used[l.id] = true; return; }
      }
      if (sec === 'stale') { live.push(l); return; }   // stale-New ranks last: an estimate-out lead can still win "quiet" first (it is not at New, so it cannot clash)
      if (sec === 'waiting') {
        by.waiting.push(baseRow(l, 'waiting', now - inboundMs(l),
          (l.lastInboundVia === 'portal' ? 'Portal message ' : 'Customer wrote ') + ageLabel(now - inboundMs(l)) + ' ago', now, waitingIds));
        used[l.id] = true; return;
      }
      if (sec === 'promised') {
        var p = toMs(l.estimatePromisedAt);
        var r = baseRow(l, 'promised', now - p, 'You promised an estimate ' + ageLabel(now - p) + ' ago', now, waitingIds);
        by.promised.push(r); used[l.id] = true; return;
      }
      live.push(l);
    });

    // quiet: the existing board, unchanged, over the leads not already placed above.
    var restForQuiet = live.filter(function (l) { return !used[l.id]; });
    var board = eb().buildBoard(restForQuiet, now, { waitingDraftIds: waitingIds, minDays: o.minDays });
    out.held.dnc += board.held;
    board.groups.forEach(function (g) {
      g.rows.forEach(function (br) {
        var l = restForQuiet.filter(function (x) { return x.id === br.leadId; })[0];
        var row = baseRow(l, 'quiet', br.daysOut * DAY, br.openedLabel + '. ' + br.lastTouch, now, waitingIds);
        row.templateKey = br.step.key; row.canDraft = row.channel === 'text';
        row.step = br.step.label; row.opened = br.opened;
        by.quiet.push(row); used[l.id] = true;
      });
    });

    // stale New: whatever is left at New that qualified and was not placed above.
    live.forEach(function (l) {
      if (used[l.id] || !isStaleNew(l, now)) return;
      by.stale.push(baseRow(l, 'stale', now - toMs(l.createdAt), 'New lead, no contact from you', now, waitingIds));
      used[l.id] = true;
    });

    SECTIONS.forEach(function (s) {
      var rows = by[s.key];
      rows.sort(function (a, b) { return (b.valueCents - a.valueCents) || (b.ageMs - a.ageMs); });
      var v = rows.reduce(function (sum, r) { return sum + r.valueCents; }, 0);
      out.sections.push({ key: s.key, label: s.label, rows: rows, valueCents: v });
      out.total += rows.length; out.valueCents += v;
    });
    return out;
  }

  /** The lead patch for the one-tap "I promised an estimate". */
  function promisePatch(nowMs) { return { estimatePromisedAt: nowMs == null ? Date.now() : nowMs }; }

  var pure = {
    FLAG: FLAG, WAIT_MS: WAIT_MS, PROMISE_GRACE_MS: PROMISE_GRACE_MS, STALE_NEW_DAYS: STALE_NEW_DAYS, SECTIONS: SECTIONS,
    inboundMs: inboundMs, answeredMs: answeredMs, isWaiting: isWaiting, isPromiseOpen: isPromiseOpen,
    isPromiseDue: isPromiseDue, isStaleNew: isStaleNew, buildFollowUps: buildFollowUps, promisePatch: promisePatch
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (root && root.document) { root.NBDFollowUpLogic = pure; }
})(typeof window !== 'undefined' ? window : this);
