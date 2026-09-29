/**
 * schedule-planner-logic.js — the pure half of the "Plan jobs" list on the
 * Schedule view (js/schedule-planner.js).
 *
 * Jo (2026-09-29), after Google Calendar went live with one event: "I haven't
 * been tracking schedule … I need to start filling it in from my memory and
 * real schedule for the next month." Opening each customer to set a date is
 * slow, so the planner lists the jobs that need one and saves a row at a time.
 *
 *   rowsFor(leads, opts) → { needs:[], scheduled:[] }
 *     needs     — open jobs with no scheduledDate. By default only the stages
 *                 where work is committed (READY); opts.all widens it to every
 *                 open lead (not lost / closed / deleted). opts.q filters by
 *                 name / address / customer id.
 *     scheduled — leads with a scheduledDate from opts.today to today+30,
 *                 soonest first, so a date can be moved in the same place.
 *   fieldsFor(input) → { ok, fields } | { ok:false, error }
 *     input { date, start, days, week } → the lead's schedule fields,
 *     validated by NBDScheduleWindow.check (the same rules the firestore
 *     scheduleWindowOk and the Google sync read).
 *
 * Week planning (Jo, 2026-09-29): "schedule jobs by assigning them to a week
 * and then refining… once I get it figured out closer by date I'll put a real
 * date on it." scheduledWeek holds that week's Monday while there is no day;
 * the portal says "scheduled for the week of…" and Google shows a free
 * Mon–Fri bar. Setting a day clears the week.
 *
 * window.NBDSchedulePlanner + module.exports (tests).
 */
(function (root) {
  'use strict';

  // Committed work: signed through installing, plus approved service and
  // warranty visits. A lead at "Estimate Sent" is not a job yet — opts.all.
  const READY = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered',
    'materials_delivered', 'crew_scheduled', 'install_in_progress',
    'warranty_claim', 'warranty_scheduled', 'service_approved'];
  const DONE = ['lost', 'closed', 'install_complete', 'final_photos', 'deductible_collected',
    'final_payment', 'collections', 'warranty_repaired'];

  const W = () => (root && root.NBDScheduleWindow) || (typeof require === 'function' ? require('./schedule-window.js') : null);
  const str = (v) => String(v == null ? '' : v).trim();
  const nameOf = (l) => str([l.firstName, l.lastName].filter(Boolean).join(' ')) || str(l.name) || str(l.customerName) || '(no name)';

  function rowsFor(leads, opts) {
    const o = opts || {};
    const norm = typeof o.normalize === 'function' ? o.normalize : (s) => str(s).toLowerCase();
    const today = o.today;
    const horizon = W().addDays(today, 30);
    const q = str(o.q).toLowerCase();
    const needs = [], scheduled = [];
    for (const l of leads || []) {
      if (!l || l.deleted || !l.id) continue;
      const stage = norm(l.stage || '');
      const row = { id: l.id, name: nameOf(l), address: str(l.address), customerId: str(l.customerId), stage, lead: l };
      if (q && ![row.name, row.address, row.customerId].some((s) => s.toLowerCase().includes(q))) continue;
      const date = str(l.scheduledDate);
      if (date) {
        row.sortKey = date + ' ' + str(l.scheduledStart);
        if (date >= today && date <= horizon) scheduled.push(row);
        continue;
      }
      // Planned to a week, no day yet. Still ahead (its Sunday not passed) →
      // the upcoming list, to refine in place. A week that went by without a
      // day falls back into "needs a date", flagged.
      const week = mondayOf(l.scheduledWeek);
      if (week) {
        row.week = week;
        const sunday = W().addDays(week, 6);
        if (sunday >= today && week <= horizon) { row.sortKey = sunday + ' ~'; scheduled.push(row); continue; }
        row.weekPassed = true;
      }
      if (DONE.includes(stage)) continue;
      if (!o.all && !READY.includes(stage)) continue;
      needs.push(row);
    }
    // Needs: furthest-along first (a job with materials here beats a fresh
    // signature), then name. Scheduled: soonest first.
    const rank = (s) => { const i = READY.indexOf(s); return i < 0 ? -1 : i; };
    needs.sort((a, b) => rank(b.stage) - rank(a.stage) || a.name.localeCompare(b.name));
    // Soonest first; within a week, set days before the week-only plans.
    scheduled.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return { needs, scheduled };
  }

  /** The Monday of the week holding ymd (YYYY-MM-DD), or null. */
  function mondayOf(ymd) {
    const p = W().parseYmd(str(ymd));
    if (!p) return null;
    const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();   // 0 = Sunday
    return W().addDays(str(ymd), -((dow + 6) % 7));
  }

  /**
   * One row's inputs → lead fields. An exact date wins: days > 1 = a
   * multi-day project (end date); a start time with days 1 = an arrival time;
   * no time = all day — and any planned week is cleared. No date but a week →
   * scheduledWeek (that week's Monday) and no day. Neither → everything
   * cleared.
   */
  function fieldsFor(input) {
    const i = input || {};
    const date = str(i.date);
    const empty = { scheduledDate: '', scheduledStart: null, scheduledDurationMin: null, scheduledEndDate: null };
    if (!date) {
      const week = str(i.week) ? mondayOf(i.week) : null;
      if (str(i.week) && !week) return { ok: false, error: 'bad-week', message: 'Pick the week again.' };
      return { ok: true, fields: Object.assign({}, empty, { scheduledWeek: week }) };
    }
    const max = (W().MAX_PROJECT_DAYS) || 14;
    const days = Math.max(1, Math.min(max, parseInt(i.days, 10) || 1));
    const start = str(i.start).slice(0, 5) || null;
    const fields = {
      scheduledDate: date,
      scheduledStart: start,
      scheduledDurationMin: null,
      scheduledEndDate: days > 1 ? W().addDays(date, days - 1) : null,
    };
    const c = W().check(fields);
    fields.scheduledWeek = null;   // a real day replaces the week plan
    if (!c.ok) return { ok: false, error: c.error, message: (W().ERRORS && W().ERRORS[c.error]) || 'Check the date and time.' };
    return { ok: true, fields };
  }

  /** The row's current inputs from a lead (to prefill a scheduled row). */
  function inputsOf(lead) {
    const l = lead || {};
    const date = str(l.scheduledDate);
    let days = 1;
    if (date && l.scheduledEndDate && W()) {
      const a = W().parseYmd(date), b = W().parseYmd(l.scheduledEndDate);
      if (a && b && b.day >= a.day) days = b.day - a.day + 1;
    }
    return { date, start: str(l.scheduledStart), days, week: date ? '' : (mondayOf(l.scheduledWeek) || '') };
  }

  const api = { READY, DONE, rowsFor, fieldsFor, inputsOf, nameOf, mondayOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDSchedulePlanner = api;
})(typeof window !== 'undefined' ? window : null);
