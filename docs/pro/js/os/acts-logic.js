/**
 * os/acts-logic.js — the pure half of NBD OS Activities and Focus modes (2026-11-09, P2;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.3, uncommon #3).
 *
 * No DOM, no clock, no storage, no network: tested in plain Node
 * (tests/nbd-os-acts-2026-11-09.test.js). The stored shape (acts, on) and the
 * presets live in os/home-logic.js, which normalises the os-home key; this file
 * is the focus lens the widgets read through while a mode is on:
 *
 *   leadPhase(lead, roleOf)   the job phase of a lead from its tenant stage role
 *                             (the lead's own _stageRole, else window.stageRole of its
 *                             stage): new Leads, active Inspect/Claim, job Build,
 *                             won Collect, lost none
 *   currentAppt(plan, now)    "In a home": the appointment the rep is at: the latest one
 *                             started in the last 3 hours, else the next under an hour
 *                             away. { key, leadId } or null
 *   lensPlan(plan, ctx)       the Today plan as the focus shows it. ctx { focus, leads,
 *                             roleOf, now }. phase: each section keeps the rows whose
 *                             lead is in that phase (a row with no lead goes by its
 *                             section: a call is Leads work, an appointment or estimate
 *                             Inspect/Claim, money Collect); the no-next-step count,
 *                             which has no per-lead list, is left out. privacy: no money
 *                             rows, and every row but the current appointment's lead
 *                             loses its name, phone, street and texts (a neutral label
 *                             in their place; the lead id stays, so a tap still opens
 *                             the record). The total is recounted from what is left.
 *                             No focus: the same plan object back.
 *   lensLeads(leads, ctx)     a phase's leads; privacy alone keeps them all (the counts
 *                             the Coach shows stay honest) and gates names by nameOk
 *   nameOk(leadId, ctx, cur)  may this lead be named on screen
 *   lensUrgency(u, focus)     a new-lead or missed-call wait is Leads work: gone on a
 *                             desk of another phase
 *   stormOffer(x)             a fresh storm alert while Storm day is off: { offer, mark,
 *                             event }; the caller shows a toast whose one tap switches.
 *                             Nothing here (or anywhere) switches a mode by itself.
 *
 * Classic script: window.NBDOSActsLogic; require()-able for tests. Loaded as part
 * of the runtime ScriptLoader bundle 'osacts' (os/home.js registers it), never at boot.
 */
(function (root) {
  'use strict';

  var ROLE_PHASE = { new: 'leads', active: 'inspect', job: 'build', won: 'collect' };
  var SECTIONS = ['appointments', 'promises', 'calls', 'promised', 'estimates', 'money', 'stalled'];
  var SECTION_PHASE = { calls: 'leads', appointments: 'inspect', estimates: 'inspect', money: 'collect' };
  var NEUTRAL = {
    appointments: 'Appointment', promises: 'A promise to keep', calls: 'A call to return',
    promised: 'A follow-up', estimates: 'An estimate to follow up', stalled: 'A follow-up',
  };
  var STARTED_MS = 3 * 3600000;    // an appointment started under 3 hours ago is the one you are at
  var NEXT_MS = 60 * 60000;        // else the next one, under an hour away
  var STORM_MS = 60 * 60000;       // Storm Center's cache is fresh for an hour (home-logic stormNow)

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v, max) { return v == null ? '' : String(v).slice(0, max || 80); }

  function leadPhase(lead, roleOf) {
    if (!isObj(lead)) return '';
    var role = typeof lead._stageRole === 'string' && lead._stageRole ? lead._stageRole : '';
    var key = String(lead._stageKey || lead.stage || '');
    if (!role && typeof roleOf === 'function') { try { role = String(roleOf(key) || ''); } catch (e) { role = ''; } }
    if (!role && key.toLowerCase() === 'new') role = 'new';
    return ROLE_PHASE[role] || '';
  }

  function currentAppt(plan, now) {
    var list = isObj(plan) && Array.isArray(plan.appointments) ? plan.appointments : [];
    var t = Number(now), started = null, next = null;
    list.forEach(function (a) {
      var ms = isObj(a) && !a.allDay ? Number(a.sortMs) : NaN;
      if (!isFinite(ms)) return;
      if (ms <= t && t - ms < STARTED_MS) { if (!started || ms > Number(started.sortMs)) started = a; }
      else if (ms > t && ms - t < NEXT_MS) { if (!next || ms < Number(next.sortMs)) next = a; }
    });
    var a = started || next;
    return a ? { key: str(a.key, 120), leadId: a.leadId ? String(a.leadId) : '' } : null;
  }

  /** The leads as an id map, built once per lens call (never kept: _leads changes in place). */
  function byId(leads) {
    var m = {};
    if (Array.isArray(leads)) leads.forEach(function (l) { if (isObj(l) && l.id != null) m[String(l.id)] = l; });
    return m;
  }
  function rowPhase(sec, r, c, map) {
    var lead = r && r.leadId != null ? map[String(r.leadId)] : null;
    return lead ? leadPhase(lead, c.roleOf) : (SECTION_PHASE[sec] || '');
  }
  function isCurrent(r, cur) {
    if (!cur || !isObj(r)) return false;
    return (!!cur.leadId && r.leadId != null && String(r.leadId) === cur.leadId) || (!!cur.key && r.key === cur.key);
  }
  /** A row with nothing that names or locates its customer: flags and the lead id only. */
  function blank(sec, r) {
    var o = { key: str(r.key || sec, 120), name: NEUTRAL[sec] || 'A follow-up' };
    if (r.leadId != null) o.leadId = String(r.leadId);
    ['timeLabel', 'sortMs', 'allDay', 'missed', 'urgent', 'overdue', 'daysLate', 'latestMs', 'bucket', 'daysOut'].forEach(function (k) {
      if (r[k] !== undefined && (typeof r[k] !== 'string' || k === 'timeLabel' || k === 'bucket')) o[k] = r[k];
    });
    if (r.text) o.text = true;
    if (Array.isArray(r.promiseTasks)) o.promiseTasks = r.promiseTasks.map(function (t) { return { overdue: !!(t && t.overdue) }; });
    return o;
  }
  function focusOf(c) { return isObj(c) && isObj(c.focus) ? c.focus : {}; }

  function lensPlan(plan, ctx) {
    var c = isObj(ctx) ? ctx : {};
    var f = focusOf(c);
    if (!isObj(plan) || (!f.phase && f.privacy !== true)) return plan;
    var cur = f.privacy === true ? currentAppt(plan, c.now) : null;
    var out = {}, total = 0, map = f.phase ? byId(c.leads) : null;
    SECTIONS.forEach(function (sec) {
      var list = Array.isArray(plan[sec]) ? plan[sec] : [];
      if (f.privacy === true && sec === 'money') list = [];
      if (f.phase) list = list.filter(function (r) { return isObj(r) && rowPhase(sec, r, c, map) === f.phase; });
      if (f.privacy === true) list = list.map(function (r) { return isCurrent(r, cur) ? r : blank(sec, r); });
      out[sec] = list;
      total += list.length;
    });
    out.total = total;
    out.noNextStep = f.phase ? null : (isObj(plan.noNextStep) && typeof plan.noNextStep.count === 'number' ? { count: plan.noNextStep.count } : null);
    return out;
  }
  function lensLeads(leads, ctx) {
    var c = isObj(ctx) ? ctx : {};
    var f = focusOf(c);
    if (!Array.isArray(leads) || !f.phase) return leads;
    return leads.filter(function (l) { return leadPhase(l, c.roleOf) === f.phase; });
  }
  function nameOk(leadId, ctx, cur) {
    if (focusOf(ctx).privacy !== true) return true;
    return !!(cur && cur.leadId && leadId != null && String(leadId) === cur.leadId);
  }
  function lensUrgency(u, focus) {
    var f = isObj(focus) ? focus : {};
    return u && f.phase && f.phase !== 'leads' ? null : u;
  }

  /** x: { cache (nbd_storm_alerts_cache), now, on (the phone mode on), offered (the alert last offered) }. */
  function stormOffer(x) {
    var o = isObj(x) ? x : {};
    var c = o.cache, t = Number(o.now);
    var no = { offer: false, mark: '', event: '' };
    if (!isObj(c) || typeof c.ts !== 'number' || !isFinite(c.ts) || !Array.isArray(c.data) || !c.data.length) return no;
    if (c.ts > t + 5 * 60000 || t - c.ts >= STORM_MS || o.on === 'storm') return no;
    var mark = String(c.ts);
    if (o.offered === mark) return no;
    var first = isObj(c.data[0]) ? c.data[0] : {};
    return { offer: true, mark: mark, event: str(first.event || 'Weather alert', 60) };
  }

  var api = {
    ROLE_PHASE: ROLE_PHASE, NEUTRAL: NEUTRAL, leadPhase: leadPhase, currentAppt: currentAppt,
    lensPlan: lensPlan, lensLeads: lensLeads, nameOk: nameOk, lensUrgency: lensUrgency, stormOffer: stormOffer,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSActsLogic = api;
})(typeof window !== 'undefined' ? window : null);
