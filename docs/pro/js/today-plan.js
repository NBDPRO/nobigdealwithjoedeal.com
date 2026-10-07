/**
 * today-plan.js — Jo's ONE Home: the "Today" list, pure (2026-10-03).
 *
 * The 7am audit on the installed iPhone app found two Homes (the boot view
 * and the phone "Home" tab went to different screens), six follow-up
 * surfaces counting by three different rules, calls shown five ways and a
 * task list that could be empty on a cold boot. This file is the one place
 * that decides what is on Jo's plate today. today-home.js reads the data and
 * paints it; nothing here touches the DOM, Firestore or the clock.
 *
 * The list, in order (each row one tap to act, empty sections collapse):
 *   1. appointments  today's bookings / job days / adjuster meetings, in time
 *                    order — collectTodayItems is a port of
 *                    functions/morning-brief-logic.js collectTodayItems
 *                    (tests/today-plan-2026-10-03.test.js runs both on the
 *                    same docs and requires the same rows in the same order);
 *   2. calls         calls / texts owed, one row per PERSON, by
 *                    home-attention.js callNeedsYou/groupNeeds (the Call
 *                    Center's own rule, passed in — never re-implemented);
 *   3. promised      CRM tasks due today or overdue MERGED with the calls
 *                    where Jo promised something, ONE row per lead;
 *   3b. estimates    estimates out 2 / 5 / 10+ days (estimate-followups.js
 *                    computeFollowups, #2136, passed in), one row per lead,
 *                    one-tap Follow up through the phone share sheet;
 *   4. money         invoices still owed by the shared owed rule
 *                    (collected-revenue.js isOwedInvoice, #2112), Stripe
 *                    payments with no customer, and draft deposits when
 *                    invoice-pipeline.js knows what one is (#2131);
 *   5. stalled       follow-ups past due by followUpDue (below), plus a
 *                    pointer to the "No next step" deck when that module
 *                    is loaded (#2126).
 * A person / lead appears in ONE of sections 2–5 (first wins), so "N things
 * today" counts things, not the same customer three times.
 *
 * followUpDue(lead, now) is THE follow-up rule: the KPI tile, the CRM
 * banner (and so the follow-up deck), the bell's follow-up notifications
 * and Today all call it. followUp is 'YYYY-MM-DD' typed into a date input,
 * so it is a LOCAL calendar day; due = that day is today or earlier. Not
 * due: no date, a deleted lead, won / lost / in-production (by stage role),
 * or a door-knock lead with no phone number (nobody can follow up on it
 * from the CRM — 2026-10-03 data audit).
 *
 * tasksQuery(claims, uid) is the ONE task load's shape (tasks.js runs it;
 * tests tie it to firestore.indexes.json — the emulator never enforces
 * indexes).
 *
 * Browser: window.NBDTodayPlan. Node: module.exports.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var DEFAULT_DURATION_MS = 60 * 60 * 1000;   // calendar-feed-logic.js
  var MAX_ITEMS = 40;                         // morning-brief-logic.js
  var TERMINAL_STAGES = ['closed', 'lost', 'Complete', 'Lost', 'final_payment'];

  // ─── primitives ──────────────────────────────────────────────────

  function SWlib(deps) {
    if (deps && deps.SW) return deps.SW;
    if (root && root.NBDScheduleWindow) return root.NBDScheduleWindow;
    if (typeof require === 'function') { try { return require('./schedule-window.js'); } catch (_) { /* not in Node */ } }
    return null;
  }

  /** Firestore Timestamp | Date | number | ISO string → ms, or null. */
  function toMs(t) {
    if (t == null || t === '') return null;
    if (typeof t === 'number') return isFinite(t) ? t : null;
    if (t instanceof Date) return isFinite(t.getTime()) ? t.getTime() : null;
    if (typeof t.toMillis === 'function') { var v = t.toMillis(); return isFinite(v) ? v : null; }
    if (typeof t.toDate === 'function') { var d = t.toDate(); return d && isFinite(d.getTime()) ? d.getTime() : null; }
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (typeof t === 'string') { var p = Date.parse(t); return isFinite(p) ? p : null; }
    return null;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** ms → the device's local 'YYYY-MM-DD'. */
  function ymdLocal(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function startOfLocalDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDaysYmdLocal(ms, n) { var d = new Date(startOfLocalDay(ms)); d.setDate(d.getDate() + n); return ymdLocal(d.getTime()); }

  var NY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  /** ms → the America/New_York calendar date (calendar-feed-logic.nyDateOf). */
  function nyDateOf(ms) { return NY_FMT.format(new Date(ms)); }
  var NY_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  /** ms → 'HH:MM' wall clock in America/New_York (morning-brief-logic.nyHm). */
  function nyHm(ms) {
    var parts = {};
    NY_HM.formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
    return pad2((+parts.hour) % 24) + ':' + parts.minute;
  }
  function hmToMin(hm) {
    var m = /^(\d{2}):(\d{2})$/.exec(String(hm || ''));
    return m ? (+m[1]) * 60 + (+m[2]) : 0;
  }
  function fullName(o) { return (((o && o.firstName) || '') + ' ' + ((o && o.lastName) || '')).trim(); }
  function leadName(l) {
    if (!l) return '';
    return fullName(l) || String(l.name || l.customerName || '').trim() || String(l.address || '').split(',')[0] || 'Customer';
  }
  function digits10(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : ''; }

  // ─── the follow-up rule ──────────────────────────────────────────

  /** A follow-up date as LOCAL midnight ('YYYY-MM-DD' parsed by parts — new Date('YYYY-MM-DD') is UTC). */
  function followUpDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  /** A door-knock lead with no usable phone: not a follow-up anyone can make from the CRM. */
  function isUnreachableKnock(l) {
    if (!l) return false;
    var knock = !!l.d2dKnockId || /door|d2d|knock/i.test(String(l.source || ''));
    if (!knock) return false;
    return String(l.phone || l.phoneDigits || '').replace(/\D/g, '').length < 10;
  }
  function stageRoleOf(lead, env) {
    if (lead._stageRole) return lead._stageRole;
    var sr = (env && env.stageRole) || (root && typeof root.stageRole === 'function' ? root.stageRole : null);
    var sk = lead._stageKey || lead.stage || '';
    if (typeof sr === 'function') { try { return sr(sk) || 'active'; } catch (_) { /* fall through */ } }
    return 'active';
  }
  /**
   * THE follow-up rule. true when the lead has a follow-up date that is today
   * or earlier (local day) and someone can still act on it.
   * @param {object} lead
   * @param {number|Date} [now]  defaults to Date.now()
   * @param {object} [env]       { stageRole(fn) } — defaults to window.stageRole
   */
  function followUpDue(lead, now, env) {
    if (!lead || lead.deleted === true) return false;
    if (lead.followUp == null || String(lead.followUp).trim() === '') return false;
    if (isUnreachableKnock(lead)) return false;
    var role = stageRoleOf(lead, env);
    if (role === 'won' || role === 'lost' || role === 'job') return false;
    var sk = lead._stageKey || lead.stage || '';
    if (TERMINAL_STAGES.indexOf(sk) !== -1 || TERMINAL_STAGES.indexOf(lead.stage || '') !== -1) return false;
    var d = followUpDay(lead.followUp);
    if (isNaN(d.getTime())) return false;
    var t = now == null ? Date.now() : (now instanceof Date ? now.getTime() : now);
    return d.getTime() <= startOfLocalDay(t);
  }
  /** Days past the follow-up date (0 = due today). */
  function followUpDaysLate(lead, now) {
    var d = followUpDay(lead && lead.followUp);
    if (isNaN(d.getTime())) return 0;
    return Math.round((startOfLocalDay(now == null ? Date.now() : now) - d.getTime()) / DAY);
  }

  // ─── the one task load ───────────────────────────────────────────

  var COMPANY_READERS = ['company_admin', 'manager', 'viewer'];
  /**
   * The ONE query tasks.js runs for every task the signed-in user can see:
   * collectionGroup('tasks') scoped by the tenant (company staff) or the
   * owner (everyone else), oldest first like the old per-lead read. Each
   * shape has a COLLECTION_GROUP composite index in firestore.indexes.json
   * (tests/today-plan-2026-10-03.test.js ties them).
   */
  function tasksQuery(claims, uid) {
    var c = claims || {};
    if (COMPANY_READERS.indexOf(c.role || '') !== -1 && c.companyId) {
      return { group: 'tasks', field: 'companyId', value: String(c.companyId), orderBy: 'createdAt', dir: 'asc' };
    }
    return uid ? { group: 'tasks', field: 'userId', value: String(uid), orderBy: 'createdAt', dir: 'asc' } : null;
  }
  /**
   * collectionGroup rows → { leadId: [task…] }. Only leads/{id}/tasks rows
   * count: the retired TOP-LEVEL /tasks store (migration 006 copied it into
   * the subcollections, same ids) also answers collectionGroup('tasks').
   * @param {Array<{id, parentPath, data}>} rows  parentPath = 'leads/{leadId}/tasks'
   */
  function groupTasksByLead(rows) {
    var out = {};
    (rows || []).forEach(function (r) {
      var m = /^leads\/([^/]+)\/tasks$/.exec(String(r && r.parentPath || ''));
      if (!m) return;
      var t = Object.assign({ id: r.id }, r.data || {});
      (out[m[1]] = out[m[1]] || []).push(t);
    });
    return out;
  }
  /** A task's due day as 'YYYY-MM-DD', or '' (dueDate is a date-input value; some writers add a time). */
  function taskDueYmd(t) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String((t && t.dueDate) || ''));
    return m ? m[1] : '';
  }
  /** An open to-do (not an Add-Event entry) due today or earlier. */
  function taskDue(t, now) {
    if (!t || t.done === true || t.completedAt || t.deleted === true || t.type === 'event') return false;
    var due = taskDueYmd(t);
    return !!due && due <= ymdLocal(now == null ? Date.now() : now);
  }

  // ─── 1. appointments (port of morning-brief-logic collectTodayItems) ─

  var TYPE = { INSPECTION: 'Inspection', INSTALL: 'Install', REPAIR: 'Repair', ADJUSTER: 'Adjuster meeting' };
  function typeFromText(text) {
    var t = String(text || '').toLowerCase();
    if (!t) return null;
    if (/adjust/.test(t)) return TYPE.ADJUSTER;
    if (/repair|leak|patch|warranty|fix\b/.test(t)) return TYPE.REPAIR;
    if (/inspect|estimate|assess|consult|quote|free roof/.test(t)) return TYPE.INSPECTION;
    if (/install|replace|re-?roof|tear.?off|new roof/.test(t)) return TYPE.INSTALL;
    return null;
  }
  function typeForJob(view) {
    var fromText = typeFromText([view.subType, view.jobType, view._jobTitle].filter(Boolean).join(' '));
    if (fromText && fromText !== TYPE.ADJUSTER) return fromText;
    var role = view._stageRole || view.stageRole;
    if (role === 'job') return TYPE.INSTALL;
    if (role === 'won') return TYPE.REPAIR;
    return TYPE.INSPECTION;
  }
  /** calendar-feed-logic.normalizeAppointment, the fields Today needs. */
  function normalizeAppointment(doc) {
    if (!doc || typeof doc !== 'object' || doc.status === 'cancelled') return null;
    var startMs = toMs(doc.startTime);
    if (startMs == null) return null;
    var endMs = toMs(doc.endTime);
    if (endMs == null || endMs <= startMs) endMs = startMs + DEFAULT_DURATION_MS;
    return {
      id: String(doc.bookingId || doc.id || ''), startMs: startMs, endMs: endMs,
      title: String(doc.title || doc.attendeeName || 'Appointment'), location: String(doc.location || ''),
      attendeeName: String(doc.attendeeName || ''), attendeePhone: String(doc.attendeePhone || ''),
      leadId: doc.leadId || null,
    };
  }
  /** calendar-feed-logic.normalizeAdjusterMeeting, the fields Today needs. */
  function normalizeAdjusterMeeting(doc, SW) {
    if (!doc || typeof doc !== 'object' || doc.deleted === true) return null;
    var ymd = String(doc.adjusterMeetingDate || '');
    if (!SW.parseYmd(ymd)) return null;
    var start = String(doc.adjusterMeetingStart || '');
    var startMs = start ? SW.localToUtcMs(ymd, start) : null;
    return {
      date: ymd, startMs: startMs,
      adjusterName: String(doc.adjusterName || ''), adjusterPhone: String(doc.adjusterPhone || ''),
      carrier: String(doc.insCarrier || doc.insuranceCarrier || ''), claimNumber: String(doc.claimNumber || ''),
    };
  }
  // functions/jobs-logic.js JOB_FIELDS (pinned equal by the test).
  var JOB_FIELDS = [
    'stage', 'stageRole', 'stageStartedAt', 'stageHistory', 'closedAt', 'lostReason',
    'jobType', 'subType', 'trades', 'jobValue', 'source', 'scopeOfWork', 'damageType',
    'primaryEstimateId', 'openWarrantyClaimId',
    'claimStatus', 'insCarrier', 'claimNumber', 'claimFiledBy', 'policyNumber', 'dateOfLoss',
    'carrierDecisionAt', 'estimateAmount', 'deductibleOrOwedByHO', 'supplementStatus',
    'financeCompany', 'loanAmount', 'loanStatus', 'preQualLink',
    'scheduledDate', 'scheduledWeek', 'scheduledStart', 'scheduledEndDate', 'scheduledDurationMin',
    'adjusterMeetingDate', 'adjusterMeetingStart', 'adjusterName', 'adjusterPhone', 'crew',
    'contractFiledAt', 'permitFiledAt', 'aobFiledAt', 'warrantyCertFiledAt', 'cocFiledAt',
  ];
  function jobView(lead, job) {
    var v = Object.assign({}, lead || {});
    var j = job || {};
    JOB_FIELDS.forEach(function (f) { v[f] = j[f] === undefined ? null : j[f]; });
    if (j.property && typeof j.property.address === 'string' && j.property.address) v.address = j.property.address;
    return v;
  }

  /**
   * Every appointment / job day / adjuster meeting on the New York calendar
   * day of nowMs: all-day first, then by start time. Same rows, keys and
   * order as functions/morning-brief-logic.js collectTodayItems.
   * @param {object} o { appointments, leads, jobs, nowMs }
   * @param {object} [deps] { SW } — schedule-window.js (window.NBDScheduleWindow)
   */
  function collectTodayItems(o, deps) {
    var SW = SWlib(deps);
    var opts = o || {};
    var nowMs = Number(opts.nowMs);
    if (!SW || !isFinite(nowMs)) return [];
    var today = nyDateOf(nowMs);
    var leads = (Array.isArray(opts.leads) ? opts.leads : []).filter(function (l) { return l && l.id && l.deleted !== true; });
    var leadsById = new Map(leads.map(function (l) { return [String(l.id), l]; }));
    var items = [];

    var appts = [];
    (Array.isArray(opts.appointments) ? opts.appointments : []).forEach(function (raw) {
      var a = normalizeAppointment(raw);
      if (!a || nyDateOf(a.startMs) !== today) return;
      appts.push(a);
      var lead = a.leadId ? leadsById.get(String(a.leadId)) : null;
      var durMin = Math.max(0, Math.round((a.endMs - a.startMs) / 60000));
      items.push({
        key: 'appt:' + a.id, source: 'appointment',
        type: typeFromText([raw && raw.title, raw && raw.description].filter(Boolean).join(' ')) || TYPE.INSPECTION,
        leadId: lead ? String(lead.id) : (a.leadId ? String(a.leadId) : null), jobId: null,
        name: (lead && fullName(lead)) || a.attendeeName || a.title || 'Appointment',
        address: (lead && lead.address) || a.location || '',
        phone: (lead && lead.phone) || a.attendeePhone || '',
        title: a.title || '', sortMs: a.startMs, allDay: false,
        timeLabel: SW.timeLabel({ start: nyHm(a.startMs), durationMin: durMin > 0 && durMin < SW.MAX_DURATION_MIN ? durMin : null }),
      });
    });

    var views = leads.map(function (l) { return { view: l, leadId: String(l.id), jobId: l.activeJobId || null, jobTitle: null, other: false }; });
    (Array.isArray(opts.jobs) ? opts.jobs : []).forEach(function (j) {
      if (!j || !j.leadId || !j.id) return;
      var lead = leadsById.get(String(j.leadId));
      if (!lead || lead.activeJobId === j.id || j.deleted === true) return;
      var view = Object.assign(jobView(lead, j), { id: lead.id, _jobTitle: j.title || null });
      views.push({ view: view, leadId: String(lead.id), jobId: String(j.id), jobTitle: j.title || null, other: true });
    });

    var bookedToday = new Set(appts.filter(function (a) { return a.leadId; }).map(function (a) { return String(a.leadId); }));
    views.forEach(function (x) {
      var view = x.view;
      if (SW.coversDay(view, today) && !(bookedToday.has(x.leadId) && !x.other)) {
        var w = SW.normalize(view);
        var dayN = SW.parseYmd(today).day - SW.parseYmd(w.date).day + 1;
        var timed = w.start != null;
        var bits = [];
        if (timed) bits.push(dayN === 1 ? SW.timeLabel(w) : SW.fmtTime12(hmToMin(w.start)));
        else bits.push('All day');
        if (w.days > 1) bits.push('day ' + dayN + ' of ' + w.days);
        items.push({
          key: 'job:' + x.leadId + '/' + (x.jobId || '-'), source: 'job', type: typeForJob(view),
          leadId: x.leadId, jobId: x.jobId || null,
          name: fullName(view) || view.address || 'Scheduled job', address: view.address || '', phone: view.phone || '',
          title: x.jobTitle || '', sortMs: timed ? SW.localToUtcMs(today, w.start) : null, allDay: !timed,
          timeLabel: bits.join(' · '),
        });
      }
      var adj = normalizeAdjusterMeeting(view, SW);
      if (adj && adj.date === today) {
        items.push({
          key: 'adj:' + x.leadId + '/' + (x.jobId || '-'), source: 'adjuster', type: TYPE.ADJUSTER,
          leadId: x.leadId, jobId: x.jobId || null,
          name: fullName(view) || view.address || 'Claim', address: view.address || '', phone: view.phone || '',
          title: x.jobTitle || '', sortMs: adj.startMs, allDay: adj.startMs == null,
          timeLabel: adj.startMs == null ? 'All day' : SW.fmtTime12(hmToMin(view.adjusterMeetingStart)),
          adjusterName: adj.adjusterName, adjusterPhone: adj.adjusterPhone, carrier: adj.carrier, claimNumber: adj.claimNumber,
        });
      }
    });

    var seen = new Set();
    var out = items.filter(function (it) { if (seen.has(it.key)) return false; seen.add(it.key); return true; });
    out.sort(function (a, b) {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      var as = a.sortMs == null ? 0 : a.sortMs, bs = b.sortMs == null ? 0 : b.sortMs;
      if (as !== bs) return as - bs;
      return String(a.name).localeCompare(String(b.name)) || a.key.localeCompare(b.key);
    });
    return out.slice(0, MAX_ITEMS);
  }

  // ─── 2–5. the to-do sections ─────────────────────────────────────

  /** A call / text-day id as callCenterAction wants it (home-attention prefixes texts 'text:'). */
  function actionId(c) { return String((c && c.id) || '').replace(/^text:/, ''); }
  function joPromises(c) { return ((c && c.promises) || []).filter(function (p) { return p && p.who === 'jo'; }); }
  function promiseText(p) { return String((p && (p.text || p.what || p.summary)) || '').trim(); }

  /**
   * The whole Today plan.
   * @param {object} o
   *   now               ms
   *   leads             window._leads
   *   tasksByLead       { leadId: [task] }  (window._taskCache)
   *   appointments,jobs raw docs for section 1
   *   callGroups        home-attention.js groupNeeds(rows, now) output
   *   invoices          collected-revenue.js loadInvoices() rows
   *   isOwedInvoice, owedDollarsOf   the shared owed rule (window.NBDRevenue)
   *   isDepositDraft    invoice-pipeline.js (#2131) — draft deposits only when present
   *   stripeNeedsReview count of Stripe payments with no customer
   *   estimateRows      estimate-followups.js computeFollowups(...).rows (#2136)
   *   noNextStep        { count } from no-next-step.js (#2126), or null
   *   isSnoozed(lead)   LeadSnooze.isSnoozed — a snoozed lead's tasks wait
   *   handled           Set of row keys acted on this session (optimistic)
   *   env               { stageRole }
   *   SW                schedule-window (tests)
   */
  function buildTodayPlan(o) {
    o = o || {};
    var now = o.now == null ? Date.now() : o.now;
    var todayNY = nyDateOf(now);
    var leads = (o.leads || []).filter(function (l) { return l && l.id && l.deleted !== true; });
    var byId = new Map(leads.map(function (l) { return [String(l.id), l]; }));
    var handled = o.handled || new Set();
    var taken = new Set();              // leadIds / person keys already on the list
    var keep = function (k) { return !handled.has(k); };

    // 1. appointments
    var appointments = collectTodayItems({ appointments: o.appointments, leads: leads, jobs: o.jobs, nowMs: now }, { SW: o.SW });

    // Tasks due per lead (snoozed leads wait, like the bell).
    var dueTasks = {};
    Object.keys(o.tasksByLead || {}).forEach(function (leadId) {
      var lead = byId.get(String(leadId));
      if (!lead) return;
      if (typeof o.isSnoozed === 'function') { try { if (o.isSnoozed(lead)) return; } catch (_) { /* keep it */ } }
      var due = (o.tasksByLead[leadId] || []).filter(function (t) { return taskDue(t, now); });
      if (due.length) dueTasks[leadId] = due.sort(function (a, b) { return taskDueYmd(a).localeCompare(taskDueYmd(b)); });
    });

    // 2 + 3. Calls owed per person; a lead's calls join its promised row
    // when Jo promised something on one, or the lead has a task due.
    var calls = [];
    var promisedByLead = new Map();
    function promisedRow(leadId) {
      if (!promisedByLead.has(leadId)) {
        var l = byId.get(leadId);
        promisedByLead.set(leadId, { key: 'lead:' + leadId, leadId: leadId, name: leadName(l), phone: digits10(l && (l.phone || l.phoneDigits)), tasks: [], promises: [], callIds: [] });
      }
      return promisedByLead.get(leadId);
    }
    var todayLocal = ymdLocal(now);
    (o.callGroups || []).forEach(function (g) {
      var first = (g.calls || [])[0];
      var leadId = first && first.leadId && byId.has(String(first.leadId)) ? String(first.leadId) : null;
      var leadTasks = leadId ? ((o.tasksByLead || {})[leadId] || []) : [];
      var open = (g.calls || []).filter(function (c) {
        // Snoozed (callCenterAction 'snooze' with no task) → not today.
        if (c.snoozeUntilYmd && c.snoozeUntilYmd > todayNY) return false;
        // The call's own follow-up task (call-center.js / text-inbox.js:
        // leads/{id}/tasks/cube-<id> | sms-<id>) decides: done = kept,
        // dated after today = later. Due today/overdue = it is on the list.
        var id = actionId(c);
        var tk = leadTasks.filter(function (t) { return t && (t.id === 'cube-' + id || t.id === 'sms-' + id); })[0];
        if (!tk) return true;
        if (tk.done === true || tk.completedAt) return false;
        var due = taskDueYmd(tk);
        return !due || due <= todayLocal;
      });
      if (!open.length) return;
      var latest = open[0];
      var promised = open.some(function (c) { return joPromises(c).length > 0; });
      if (leadId && (promised || dueTasks[leadId])) {
        var r = promisedRow(leadId);
        open.forEach(function (c) {
          r.callIds.push(actionId(c));
          joPromises(c).forEach(function (p) { var s = promiseText(p); if (s) r.promises.push(s); });
        });
        return;
      }
      var lead = leadId ? byId.get(leadId) : null;
      var key = g.key || ('call:' + actionId(latest));
      calls.push({
        key: key, leadId: leadId,
        name: (lead && leadName(lead)) || latest.contactName || latest.callerName || '',
        phone: digits10((lead && (lead.phone || lead.phoneDigits)) || latest.phoneDigits),
        callIds: open.map(actionId),
        count: open.length,
        urgent: open.some(function (c) { return c.urgent === true; }),
        missed: open.some(function (c) { return c.channel !== 'text' && c.status === 'short' && c.direction === 'inbound'; }),
        text: open.some(function (c) { return c.channel === 'text' || /^text:/.test(String(c.id || '')); }),
        summary: String(latest.summary || '').slice(0, 140),
        latestMs: toMs(latest.startedAtMs) || 0,
      });
    });
    Object.keys(dueTasks).forEach(function (leadId) { promisedRow(leadId).tasks = dueTasks[leadId]; });
    var promised = Array.from(promisedByLead.values()).map(function (r) {
      var firstDue = r.tasks.length ? taskDueYmd(r.tasks[0]) : '';
      r.dueYmd = firstDue;
      r.overdue = !!firstDue && firstDue < ymdLocal(now);
      return r;
    }).filter(function (r) { return keep(r.key); });
    promised.sort(function (a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return String(a.dueYmd || '9').localeCompare(String(b.dueYmd || '9')) || a.name.localeCompare(b.name);
    });
    promised.forEach(function (r) { taken.add('lead:' + r.leadId); });
    calls = calls.filter(function (r) { return keep(r.key); });
    calls.forEach(function (r) { taken.add(r.key); if (r.leadId) taken.add('lead:' + r.leadId); });

    // 3b. Estimates to follow up (#2136, estimate-followups.js
    // computeFollowups — passed in, never re-implemented): one row per lead,
    // skipped when the lead is already on Calls owed / Promised; a lead here
    // is not ALSO on Stalled for its follow-up date.
    var estimates = [];
    (o.estimateRows || []).forEach(function (r) {
      if (!r || !r.leadId) return;
      var id = String(r.leadId);
      if (!byId.has(id) || taken.has('lead:' + id) || !keep('est:' + id)) return;
      if (estimates.some(function (e) { return e.leadId === id; })) return;
      estimates.push({
        key: 'est:' + id, leadId: id, name: r.name || leadName(byId.get(id)), daysOut: r.daysOut, bucket: r.bucket,
        opened: !!r.opened, openedLabel: r.openedLabel || '', linkLive: !!r.linkLive,
      });
    });
    estimates.forEach(function (r) { taken.add('lead:' + r.leadId); });

    // 4. Money: owed invoices (the shared owed rule), Stripe to assign, draft deposits.
    var money = [];
    if (typeof o.isOwedInvoice === 'function' && typeof o.owedDollarsOf === 'function') {
      (o.invoices || []).forEach(function (inv) {
        if (!inv || !o.isOwedInvoice(inv)) return;
        var cents = Math.round(o.owedDollarsOf(inv) * 100);
        if (!(cents > 0)) return;
        var lead = inv.leadId ? byId.get(String(inv.leadId)) : null;
        // THE overdue rule (ky-insurance-law.js invoiceOverdue, injected as
        // o.invoiceOverdue): the tenant-zone day after the due date, never
        // while the Kentucky pay hold applies — the same answer as the server
        // task, the Invoices tab and Money.
        var st = typeof o.invoiceOverdue === 'function' ? o.invoiceOverdue(inv, lead, new Date(now), o.tz) : null;
        money.push({
          key: 'inv:' + inv.id, kind: 'invoice', invoiceId: inv.id, leadId: lead ? String(lead.id) : (inv.leadId || null),
          name: (lead && leadName(lead)) || String(inv.customerName || inv.billToName || '').trim() || 'Invoice',
          phone: digits10(lead && (lead.phone || lead.phoneDigits)),
          cents: cents, number: String(inv.invoiceNumber || inv.number || ''),
          overdue: st ? (st.overdue || (String(inv.status || '').toLowerCase() === 'overdue' && !st.held)) : String(inv.status || '').toLowerCase() === 'overdue',
        });
      });
    }
    if (typeof o.isDepositDraft === 'function') {
      (o.invoices || []).forEach(function (inv) {
        var draft = false;
        try { draft = !!o.isDepositDraft(inv); } catch (_) { draft = false; }
        if (!inv || inv.deleted === true || !draft) return;
        var lead = inv.leadId ? byId.get(String(inv.leadId)) : null;
        money.push({
          key: 'dep:' + inv.id, kind: 'deposit', invoiceId: inv.id, leadId: lead ? String(lead.id) : (inv.leadId || null),
          name: (lead && leadName(lead)) || String(inv.customerName || '').trim() || 'Deposit',
          cents: Math.round((parseFloat(inv.total) || 0) * 100), overdue: false,
        });
      });
    }
    money.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'invoice' ? -1 : 1;
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return b.cents - a.cents;
    });
    if (o.stripeNeedsReview > 0) money.push({ key: 'stripe', kind: 'stripe', count: o.stripeNeedsReview, name: 'Stripe', cents: 0 });
    money = money.filter(function (r) { return keep(r.key); });

    // 5. Stalled: follow-ups due by THE rule, not already on the list.
    var stalled = leads.filter(function (l) {
      return followUpDue(l, now, o.env) && !taken.has('lead:' + l.id) && keep('fu:' + l.id);
    }).map(function (l) {
      return { key: 'fu:' + l.id, leadId: String(l.id), name: leadName(l), phone: digits10(l.phone || l.phoneDigits), daysLate: followUpDaysLate(l, now), followUp: l.followUp };
    }).sort(function (a, b) { return b.daysLate - a.daysLate || a.name.localeCompare(b.name); });

    var nns = o.noNextStep && o.noNextStep.count > 0 ? { count: o.noNextStep.count } : null;
    var total = appointments.length + calls.length + promised.length + estimates.length + money.length + stalled.length;
    return { appointments: appointments, calls: calls, promised: promised, estimates: estimates, money: money, stalled: stalled, noNextStep: nns, total: total };
  }

  /** "N things today" — the header line. */
  function headline(n) { return n === 0 ? 'Nothing due today' : n + (n === 1 ? ' thing today' : ' things today'); }

  /**
   * One line of storm status from Storm Center's own cache (nbd_storm_alerts_cache,
   * { ts, data:[{event, headline}] }, fresh for an hour) — no network. '' when none.
   */
  function stormLine(cache, now) {
    if (!cache || !Array.isArray(cache.data) || !cache.data.length) return '';
    var t = now == null ? Date.now() : now;
    if (!(typeof cache.ts === 'number' && t - cache.ts < 60 * 60 * 1000)) return '';
    var first = String((cache.data[0] && cache.data[0].event) || 'Weather alert');
    return '⛈ ' + first + (cache.data.length > 1 ? ' +' + (cache.data.length - 1) + ' more' : '');
  }

  function fmtCents(c) {
    var n = Math.round(Number(c) || 0);
    return (n < 0 ? '-$' : '$') + (Math.abs(n) / 100).toFixed(2).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var API = {
    followUpDue: followUpDue, followUpDay: followUpDay, followUpDaysLate: followUpDaysLate, isUnreachableKnock: isUnreachableKnock,
    tasksQuery: tasksQuery, groupTasksByLead: groupTasksByLead, taskDue: taskDue, taskDueYmd: taskDueYmd,
    collectTodayItems: collectTodayItems, buildTodayPlan: buildTodayPlan, headline: headline, stormLine: stormLine,
    fmtCents: fmtCents, ymdLocal: ymdLocal, addDaysYmdLocal: addDaysYmdLocal, nyDateOf: nyDateOf, actionId: actionId,
    JOB_FIELDS: JOB_FIELDS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root && root.document) root.NBDTodayPlan = API;
})(typeof window !== 'undefined' ? window : null);
