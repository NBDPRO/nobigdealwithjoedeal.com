/**
 * lien-clock.js — the INTERNAL lien-deadline clock for one job. Pure maths on
 * plain calendar dates ('YYYY-MM-DD'); no DOM, no Firestore, no time zones.
 *
 * STATUS: internal tracking only. It prints no customer-facing text and files
 * nothing. Every date it returns is a planning aid and must be shown with
 * "verify with counsel" until the attorney has walked the checklists
 * (documentation/projects/CONTRACT-STRENGTHENING-PLAN-2026-10-13.md, C4, Q11).
 *
 * Rules encoded (KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13.md, Part C2/C3):
 *   OH residential (1-2 family): affidavit within 60 days of last work
 *     (ORC 1311.06); serve the owner within 30 days of filing; lien lasts 6
 *     years from filing (ORC 1311.13); a demand to sue voids it after 60 days
 *     (ORC 1311.11, owner-triggered, so tracked only when a demand date is given).
 *   KY: sworn statement within 6 months of last work (KRS 376.080); mail the
 *     owner within 7 days of filing or the lien is dissolved; sue within 12
 *     months of filing (KRS 376.090).
 *   KY insurance-paid job: NO lien for any amount above what the insurer pays
 *     (KRS 367.628(2)(g)), so no filing countdown is produced at all.
 *
 * Conservative by design: `deadline` is the statutory arithmetic date and
 * `workBy` is one day earlier. Weekend, holiday and business-day roll rules are
 * counsel's question (Q11) and are NOT guessed: nothing is ever rolled later.
 * Month arithmetic clamps to the month end (Aug 31 + 6 months = Feb 28/29).
 */
(function () {
  'use strict';

  var REMINDER_DAYS = [21, 7];
  var DISCLAIMER = 'Planning date only. Verify with counsel before relying on it.';

  function parse(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = Date.UTC(y, mo - 1, d);
    var back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return t;
  }
  function fmt(t) {
    var d = new Date(t);
    var p = function (n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; };
    return p(d.getUTCFullYear(), 4) + '-' + p(d.getUTCMonth() + 1, 2) + '-' + p(d.getUTCDate(), 2);
  }
  function addDays(s, n) {
    var t = parse(s);
    return t == null ? null : fmt(t + n * 86400000);
  }
  function addMonths(s, n) {
    var t = parse(s);
    if (t == null) return null;
    var d = new Date(t);
    var y = d.getUTCFullYear(), mo = d.getUTCMonth() + n, day = d.getUTCDate();
    var last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return fmt(Date.UTC(y, mo, Math.min(day, last)));
  }
  function addYears(s, n) { return addMonths(s, n * 12); }
  function daysBetween(a, b) {
    var ta = parse(a), tb = parse(b);
    if (ta == null || tb == null) return null;
    return Math.round((tb - ta) / 86400000);
  }

  function step(key, label, basis, deadline, today) {
    if (!deadline) return null;
    var workBy = addDays(deadline, -1);
    var left = today ? daysBetween(today, deadline) : null;
    var status = left == null ? 'upcoming' : left < 0 ? 'passed' : left <= 7 ? 'urgent' : 'upcoming';
    var reminders = [];
    for (var i = 0; i < REMINDER_DAYS.length; i++) {
      reminders.push({ daysBefore: REMINDER_DAYS[i], on: addDays(workBy, -REMINDER_DAYS[i]) });
    }
    return {
      key: key, label: label, basis: basis, deadline: deadline, workBy: workBy,
      daysLeft: left, status: status, reminders: reminders
    };
  }

  /**
   * compute({ state, lastWorkDate, filedDate, isInsurance, today })
   *   state         'OH' | 'KY' (anything else: unsupported, no steps)
   *   lastWorkDate  'YYYY-MM-DD'; required for the filing step
   *   filedDate     'YYYY-MM-DD' once the affidavit/statement is recorded
   *   isInsurance   true for an insurance-paid job
   *   today         'YYYY-MM-DD' (injected so tests are deterministic)
   * Returns { supported, suppressed, reason, steps[], disclaimer }.
   */
  function compute(job) {
    job = job || {};
    var st = String(job.state || '').toUpperCase();
    var out = { state: st, supported: false, suppressed: false, reason: '', steps: [], disclaimer: DISCLAIMER };
    if (st !== 'OH' && st !== 'KY') { out.reason = 'State not supported (OH and KY only).'; return out; }
    out.supported = true;

    if (st === 'KY' && job.isInsurance) {
      out.suppressed = true;
      out.reason = 'No lien for any amount above what the insurer pays (KRS 367.628(2)(g)). No filing countdown.';
      return out;
    }

    var today = parse(job.today) != null ? job.today : null;
    var last = parse(job.lastWorkDate) != null ? job.lastWorkDate : null;
    var filed = parse(job.filedDate) != null ? job.filedDate : null;
    var steps = out.steps;
    var push = function (s) { if (s) steps.push(s); };

    if (!last && !filed) { out.reason = 'Enter the last day of work to start the clock.'; return out; }

    if (st === 'OH') {
      if (last && !filed) push(step('oh-affidavit', 'File the lien affidavit with the county recorder', 'ORC 1311.06: 60 days from last work', addDays(last, 60), today));
      if (filed) {
        push(step('oh-serve', 'Serve the owner a copy of the filed affidavit', 'ORC 1311.06: within 30 days of filing', addDays(filed, 30), today));
        push(step('oh-lien-life', 'Lien expires unless enforced', 'ORC 1311.13: 6 years from filing', addYears(filed, 6), today));
      }
    } else {
      if (last && !filed) push(step('ky-statement', 'File the sworn statement with the county clerk', 'KRS 376.080: within 6 months of last work', addMonths(last, 6), today));
      if (filed) {
        push(step('ky-mail', 'Mail a copy to the owner (lien is dissolved if missed)', 'KRS 376.080: within 7 days of filing', addDays(filed, 7), today));
        push(step('ky-sue', 'Sue to enforce the lien', 'KRS 376.090: within 12 months of filing', addMonths(filed, 12), today));
      }
    }
    return out;
  }

  var API = {
    REMINDER_DAYS: REMINDER_DAYS,
    DISCLAIMER: DISCLAIMER,
    compute: compute,
    addDays: addDays,
    addMonths: addMonths,
    daysBetween: daysBetween
  };

  if (typeof window !== 'undefined') window.NBDLienClock = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
