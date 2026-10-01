/**
 * winback-logic.js — pure rules for the "Past Customers" win-back list
 * (2026-10-01). No DOM, no Firestore. Used by winback.js (the view) and
 * pinned by tests/winback-2026-10-01.test.js.
 *
 * Jo's rule: NOTHING is sent automatically. This file only decides who is on
 * the list and drafts a message; the rep reviews/edits it and taps Send.
 *
 * Who is a past customer (pastCustomers):
 *   - not deleted, not a D2D prospect
 *   - at least one WON job (stage role 'won'); a customer with no jobs
 *     subcollection yet is judged on the lead itself
 *   - NO open job now (the jobs-store isOpen rule: a job is done only when
 *     closed out AND paid in full, or lost) — injected as opts.isOpen
 *   - last completion at least opts.minMonths (6) months ago
 *   - has a phone or an email
 *   - not reached for win-back in the last opts.cooldownDays (90)
 *     (lead.lastWinbackAt, written by winback.js on a real send)
 *
 * Kentucky (KRS 367.628): the drafts never mention insurance claims, and the
 * referral draft never names a bonus or any money.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  // 3, not 6 (2026-10-01): every finished customer in the CRM was entered in
  // 2026, the oldest 5 months back — at 6 the list was empty. The view's
  // chips narrow it (6+ months, 1+ year) as history builds up.
  var DEFAULT_MIN_MONTHS = 3;
  var DEFAULT_COOLDOWN_DAYS = 90;
  var ANNIVERSARY_WINDOW_DAYS = 30;
  var STOP_LINE = 'Reply STOP to opt out.';

  /** Firestore Timestamp / Date / ISO string / {seconds} / ms → ms, or 0. */
  function ms(v) {
    if (v == null || v === '') return 0;
    if (v instanceof Date) { var t = v.getTime(); return isNaN(t) ? 0 : t; }
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v.toMillis === 'function') { try { return v.toMillis() || 0; } catch (_) { return 0; } }
    if (typeof v.toDate === 'function') { try { return ms(v.toDate()); } catch (_) { return 0; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((Number(v.nanoseconds) || 0) / 1e6);
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    var p = Date.parse(v);
    return isNaN(p) ? 0 : p;
  }

  /** When a job was finished: closedAt → completedAt → installCompletedAt → stageStartedAt. */
  function completedMs(job) {
    var j = job || {};
    return ms(j.closedAt) || ms(j.completedAt) || ms(j.installCompletedAt) || ms(j.stageStartedAt);
  }

  /** Whole calendar months from a to b (b later). */
  function monthsBetween(aMs, bMs) {
    var a = new Date(aMs), b = new Date(bMs);
    var m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) m -= 1;
    return Math.max(0, m);
  }

  function startOfDay(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

  /** Days from now until the next anniversary of firstMs (0 = today). */
  function daysToAnniversary(firstMs, nowMs) {
    var f = new Date(firstMs);
    var today = startOfDay(nowMs);
    var y = new Date(nowMs).getFullYear();
    var next = new Date(y, f.getMonth(), f.getDate()).getTime();
    if (next < today) next = new Date(y + 1, f.getMonth(), f.getDate()).getTime();
    return Math.round((next - today) / DAY);
  }

  // Win-back's own "still active" test (2026-10-01): a job is active when it
  // is neither won nor lost. Deliberately NOT jobs-store's isOpen (done only
  // when closed AND paidInFull): only the new invoice flow sets paidInFull, so
  // that rule kept every pre-2026-09 finished customer "open" and the list
  // came back empty on production data (25 won customers, 1 flagged paid).
  // Whether a finished job's money is collected is the Collections queue's
  // job, not a reason to skip a "how's the roof?" check-in.
  function defaultIsOpen(job, roleOf) {
    var r = roleFor(job, roleOf);
    return r !== 'won' && r !== 'lost';
  }

  // Lead fields that describe the ACTIVE job (the mirror may lag a beat, so
  // the lead's own copy wins — same stance as jobs-store cardsFor).
  var ACTIVE_FIELDS = ['stage', 'stageRole', 'stageStartedAt', 'closedAt', 'completedAt', 'installCompletedAt', 'paidInFull'];

  function roleFor(job, roleOf) {
    if (job && job.stageRole) return job.stageRole;
    return typeof roleOf === 'function' ? roleOf(job && job.stage) : undefined;
  }

  function personName(l) {
    var full = ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
    return full || String(l.name || '').trim() || String(l.address || '').split(',')[0].trim() || 'Customer';
  }
  function personFirst(l) {
    var f = String(l.firstName || '').trim();
    if (f) return f;
    var n = String(l.name || '').trim();
    return n ? n.split(/\s+/)[0] : '';
  }
  function jobTitle(j) {
    if (!j) return '';
    if (j.title) return String(j.title);
    if (j._jobTitle) return String(j._jobTitle);
    if (j.jobType) return String(j.jobType);
    if (Array.isArray(j.trades) && j.trades.length) return j.trades.join(', ');
    return '';
  }

  /**
   * PURE. The win-back list.
   *   leads   window._leads
   *   jobsOf  (leadId) → that customer's jobs ([] when none / not loaded)
   *   now     Date | ms
   *   opts    { minMonths, cooldownDays, roleOf(stageKey), isOpen(job) }
   */
  function pastCustomers(leads, jobsOf, now, opts) {
    opts = opts || {};
    var nowMs = ms(now) || Date.now();
    var minMonths = opts.minMonths != null ? Number(opts.minMonths) : DEFAULT_MIN_MONTHS;
    var cooldownDays = opts.cooldownDays != null ? Number(opts.cooldownDays) : DEFAULT_COOLDOWN_DAYS;
    var roleOf = opts.roleOf;
    var isOpen = typeof opts.isOpen === 'function' ? opts.isOpen : defaultIsOpen;
    var out = [];

    (leads || []).forEach(function (lead) {
      if (!lead || !lead.id || lead.deleted || lead.isProspect) return;
      var phone = String(lead.phone || '').trim();
      var email = String(lead.email || '').trim();
      if (!phone && !email) return;

      var lastWb = ms(lead.lastWinbackAt);
      if (lastWb && (nowMs - lastWb) < cooldownDays * DAY) return;

      var jobs = (typeof jobsOf === 'function' ? jobsOf(lead.id) : null) || [];
      var effective;
      if (!jobs.length) {
        effective = [lead];                    // pre-jobs customer: the lead is its one job
      } else {
        effective = jobs.map(function (j) {
          if (!j || j.id !== lead.activeJobId) return j || {};
          var o = Object.assign({}, j);
          ACTIVE_FIELDS.forEach(function (f) { if (lead[f] !== undefined && lead[f] !== null) o[f] = lead[f]; });
          if (!o.title && lead._jobTitle) o.title = lead._jobTitle;
          return o;
        });
      }

      // (c) nothing open right now.
      for (var i = 0; i < effective.length; i++) { if (isOpen(effective[i], roleOf)) return; }

      // (b) at least one won job, with a date we can read.
      var won = effective.filter(function (j) { return roleFor(j, roleOf) === 'won'; });
      if (!won.length) return;
      var dated = won.map(function (j) { return { job: j, at: completedMs(j) }; }).filter(function (x) { return x.at > 0; });
      if (!dated.length) return;
      dated.sort(function (a, b) { return a.at - b.at; });
      var first = dated[0], last = dated[dated.length - 1];

      // (d) the last one wrapped up long enough ago.
      if (last.at > nowMs) return;
      var monthsSince = monthsBetween(last.at, nowMs);
      if (monthsSince < minMonths) return;

      var dta = daysToAnniversary(first.at, nowMs);
      out.push({
        leadId: lead.id,
        name: personName(lead),
        firstName: personFirst(lead),
        phone: phone,
        email: email,
        address: String(lead.address || '').trim(),
        lastCompletedMs: last.at,
        monthsSince: monthsSince,
        jobCount: won.length,
        lastJobTitle: jobTitle(last.job),
        anniversarySoon: monthsBetween(first.at, nowMs) >= 6 && dta <= ANNIVERSARY_WINDOW_DAYS,
        daysToAnniversary: dta,
        lastWinbackAt: lastWb || null,
      });
    });

    out.sort(function (a, b) {
      if (a.anniversarySoon !== b.anniversarySoon) return a.anniversarySoon ? -1 : 1;
      if (a.anniversarySoon && a.daysToAnniversary !== b.daysToAnniversary) return a.daysToAnniversary - b.daysToAnniversary;
      return a.lastCompletedMs - b.lastCompletedMs;    // longest since first
    });
    return out;
  }

  /** "about 8 months" / "about a year" / "about 3 years". */
  function sinceText(months) {
    var m = Math.max(0, Math.floor(Number(months) || 0));
    if (m < 12) return 'about ' + m + (m === 1 ? ' month' : ' months');
    if (m < 18) return 'about a year';
    return 'about ' + Math.round(m / 12) + ' years';
  }

  var KINDS = ['checkin', 'referral', 'maintenance'];

  /**
   * PURE. The draft the rep starts from. → { text, subject, kind }
   * opts: { company, repName, kind: 'checkin' | 'referral' | 'maintenance' }
   * The text is the SMS version and always ends with the STOP line.
   */
  function buildWinbackMessage(row, opts) {
    row = row || {}; opts = opts || {};
    var kind = KINDS.indexOf(opts.kind) > -1 ? opts.kind : 'checkin';
    var company = String(opts.company || '').trim() || 'our team';
    var rep = String(opts.repName || '').trim();
    var first = String(row.firstName || '').trim();
    var hi = (first ? 'Hi ' + first : 'Hi') + ', this is ' + (rep ? rep + ' with ' : '') + company + '. ';
    var since = 'It\'s been ' + sinceText(row.monthsSince) + ' since we worked on your home, and we hope everything is holding up well. ';
    var body, subject;
    if (kind === 'referral') {
      body = 'If you know a neighbor, friend or family member who needs a roofer, we would be grateful if you passed our name along. And if anything comes up with your own home, just reply here.';
      subject = 'Thank you from ' + company;
    } else if (kind === 'maintenance') {
      body = 'A quick reminder: this is a good time of year to have your gutters cleaned and checked so water drains away from the house. If you would like us to take a look, reply here and we will set up a time.';
      subject = 'Gutter check reminder from ' + company;
    } else {
      body = 'Now that storm season has passed, we are offering past customers a free roof and gutter check. If you would like us to swing by and take a look, just reply here.';
      subject = 'A free roof check from ' + company;
    }
    var text = hi + since + body + ' ' + STOP_LINE;
    return { text: text, subject: subject, kind: kind };
  }

  /** The email body: the draft without the SMS-only STOP line (the server adds its own unsubscribe footer). */
  function emailText(text) {
    return String(text || '').replace(/\s*Reply STOP to opt out\.?\s*$/i, '').trim();
  }

  var api = {
    DAY: DAY, DEFAULT_MIN_MONTHS: DEFAULT_MIN_MONTHS, DEFAULT_COOLDOWN_DAYS: DEFAULT_COOLDOWN_DAYS,
    ANNIVERSARY_WINDOW_DAYS: ANNIVERSARY_WINDOW_DAYS, STOP_LINE: STOP_LINE, KINDS: KINDS,
    ms: ms, completedMs: completedMs, monthsBetween: monthsBetween, daysToAnniversary: daysToAnniversary,
    defaultIsOpen: defaultIsOpen, sinceText: sinceText,
    pastCustomers: pastCustomers, buildWinbackMessage: buildWinbackMessage, emailText: emailText,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.NBDWinbackLogic = api;
})(typeof window !== 'undefined' ? window : this);
