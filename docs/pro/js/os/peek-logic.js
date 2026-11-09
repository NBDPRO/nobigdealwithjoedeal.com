/**
 * os/peek-logic.js — the pure half of NBD OS P2's pre-flight peek and Welcome
 * Recap (2026-11-09; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md
 * §6 #6 and #7).
 *
 * No DOM, no storage, no network, no clock of its own (callers pass `now`):
 * tested in plain Node (tests/nbd-os-peek-2026-11-09.test.js,
 * tests/nbd-os-welcome-recap-2026-11-09.test.js).
 *
 *   facts({ plan, leads, key })   what the Peek sheet shows for one appointment of
 *                                 the Today plan (NBDToday.last()): the appointment,
 *                                 its address, the lead's notes and its open promises.
 *                                 Memory only; the lead brief is NOT here: it is a
 *                                 paid, capped callable the sheet asks for on a tap.
 *   brief(data)                   the leadBrief callable's answer made safe, or null
 *   recap({ carry, leads, plan, now, apptsFailed })
 *                                 the Welcome Recap card from Shutdown's carry-over
 *                                 (ids only, resolved against _leads now) and today's
 *                                 first appointment; null when nothing is on the list
 *
 * Every number shown is one of these lists' lengths. A carried lead no longer in
 * _leads (deleted, or not the member's any more) is left out, never guessed at.
 *
 * Classic script: window.NBDOSPeekLogic; require()-able for tests. Loaded with
 * os/peek.js as the runtime ScriptLoader bundle `osp2peek`, which os/home.js
 * registers and loads on the first Peek tap or a due Welcome Recap, never at boot.
 */
(function (root) {
  'use strict';

  var MAPS = 'https://www.google.com/maps/search/?api=1&query=';
  var NOTES_MAX = 600;

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v, max) { return v == null ? '' : String(v).slice(0, max || 80); }
  function street(a) { return str(String(a == null ? '' : a).split(',')[0].trim(), 60); }
  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }
  function leadName(l) {
    var n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || String(l.name || '').trim();
    return str(n || street(l.address) || 'Customer', 80);
  }
  function custHref(id) { return id ? '/pro/customer.html?id=' + encodeURIComponent(String(id)) : ''; }
  function findLead(leads, id) {
    if (!id) return null;
    var out = null;
    arr(leads).forEach(function (l) { if (!out && isObj(l) && l.deleted !== true && String(l.id) === String(id)) out = l; });
    return out;
  }
  /** The Today plan's promise rows for one lead, as lines: "Call back by Friday · overdue". */
  function promisesFor(plan, leadId) {
    var out = [];
    if (!leadId || !isObj(plan)) return out;
    arr(plan.promises).forEach(function (r) {
      if (!isObj(r) || String(r.leadId) !== String(leadId)) return;
      arr(r.promiseTasks).forEach(function (t) {
        if (!isObj(t)) return;
        var line = str(t.text || t.why || 'A promise', 160);
        out.push(t.overdue ? line + ' · overdue' : line);
      });
    });
    return out.slice(0, 6);
  }

  function facts(input) {
    var i = isObj(input) ? input : {};
    var plan = isObj(i.plan) ? i.plan : null;
    var key = str(i.key, 120);
    if (!plan || !key) return null;
    var a = null;
    arr(plan.appointments).forEach(function (x) { if (!a && isObj(x) && String(x.key) === key) a = x; });
    if (!a) return null;
    var leadId = a.leadId ? str(a.leadId, 120) : '';
    var lead = findLead(i.leads, leadId);
    var address = str(a.address, 160);
    return {
      key: key,
      leadId: leadId,
      linked: !!lead,
      name: str(a.name) || (lead ? leadName(lead) : 'Appointment'),
      title: str(a.title, 120),
      time: str(a.timeLabel, 40),
      address: address,
      mapsHref: address ? MAPS + encodeURIComponent(address) : '',
      custHref: lead ? custHref(leadId) : '',
      // the notes field on the lead, as the customer page holds it ('' = none on file)
      notes: lead ? str(String(lead.notes || '').trim(), NOTES_MAX) : '',
      notesCut: !!lead && String(lead.notes || '').trim().length > NOTES_MAX,
      promises: promisesFor(plan, leadId),
    };
  }

  /** functions/lead-brief.js answers { oneLine, bullets, source, generatedAtMs, cached }; anything else is null. */
  function brief(data) {
    if (!isObj(data) || typeof data.oneLine !== 'string' || !data.oneLine.trim()) return null;
    var src = data.source === 'ai' ? 'AI summary' : (data.source === 'sample' ? 'Sample brief' : 'From the record');
    return {
      oneLine: str(data.oneLine.trim(), 400),
      bullets: arr(data.bullets).filter(function (b) { return typeof b === 'string' && b.trim(); }).map(function (b) { return str(b.trim(), 300); }).slice(0, 8),
      source: src,
      cached: data.cached === true,
      at: typeof data.generatedAtMs === 'number' && isFinite(data.generatedAtMs) ? data.generatedAtMs : 0,
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  /** "yesterday" / "on Saturday" for a carry-over's day key, from today's. */
  function whenWords(dk, now) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dk));
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var y = new Date(Number(now)); y.setHours(0, 0, 0, 0); y.setDate(y.getDate() - 1);
    var yk = y.getFullYear() + '-' + pad2(y.getMonth() + 1) + '-' + pad2(y.getDate());
    return dk === yk ? 'yesterday' : 'on ' + DAYS[d.getDay()];
  }
  /** Today's first appointment from the plan: { name, time, place } | 'none' | null (unknown). */
  function firstAppt(plan, failed) {
    if (!isObj(plan) || !Array.isArray(plan.appointments)) return null;
    var list = plan.appointments.filter(isObj);
    if (!list.length) return failed ? null : 'none';
    var timed = list.filter(function (a) { return !a.allDay && isFinite(Number(a.sortMs)) && a.sortMs != null; });
    timed.sort(function (x, y) { return Number(x.sortMs) - Number(y.sortMs); });
    var a = timed[0] || list[0];
    return { name: str(a.name) || 'Appointment', time: str(a.timeLabel, 40) || 'All day', place: street(a.address) };
  }

  /**
   * input: { carry (home-logic parseCarry's shape), leads, plan, now, apptsFailed }
   * -> null | { when, leads:[{ id, name, why, href }], visits, first }
   */
  function recap(input) {
    var i = isObj(input) ? input : {};
    var c = i.carry;
    if (!isObj(c)) return null;
    var rows = [], seen = {};
    function add(id, why) {
      if (seen[id]) return;
      var l = findLead(i.leads, id);
      if (!l) return;
      seen[id] = true;
      rows.push({ id: str(id, 120), name: leadName(l), why: why, href: custHref(id) });
    }
    arr(c.leads).forEach(function (id) { add(id, 'No next step yet'); });
    arr(c.promises).forEach(function (id) { add(id, 'Promise past due'); });
    var visits = arr(c.visits).length;
    if (!rows.length && !visits) return null;
    return { when: whenWords(c.dk, i.now), leads: rows, visits: visits, first: firstAppt(i.plan, i.apptsFailed === true) };
  }
  /** "1 visit still on no customer" / '' with none. */
  function visitsLine(n) { return n > 0 ? plural(n, 'visit', 'visits') + ' still on no customer' : ''; }

  var api = { facts: facts, brief: brief, recap: recap, firstAppt: firstAppt, whenWords: whenWords, visitsLine: visitsLine, promisesFor: promisesFor, NOTES_MAX: NOTES_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSPeekLogic = api;
})(typeof window !== 'undefined' ? window : null);
