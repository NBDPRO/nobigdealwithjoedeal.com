/**
 * os/shutdown-logic.js — the pure half of the NBD OS Shutdown ritual (2026-11-09, P1;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.2).
 *
 * No DOM, no storage, no network, no clock of its own (every function takes
 * `now`): tested in plain Node (tests/nbd-os-shutdown-2026-11-09.test.js).
 *
 * What the evening list holds:
 *   leads     every open lead OF THE REP'S OWN that was TOUCHED TODAY and fails
 *             no-next-step.js hasNextStep (no follow-up date, no open task, not
 *             snoozed). The same isOpenLead / hasNextStep the No next step card
 *             uses, not a copy.
 *   visits    today's visit recordings still on no customer (the recorder's own
 *             isUnfiled; a capped recording's part 2 is the same visit)
 *   promises  the Today plan's promise rows with a promise past due
 *
 * "Own": lead.userId, else lead.assignedTo (the command palette's and the
 * pipeline cards' owner rule), equal to the signed-in uid. A manager's or an
 * owner's _leads carries the team's leads too; those are the rep's to close,
 * not the manager's. A lead with neither field is nobody's here (never listed).
 *
 * "Touched today" is a HUMAN touch by this rep, from stamps only a person's
 * action writes, inside today's local day:
 *   contact  lastContactedAt   the Call / Text / Email buttons on the customer
 *                              page, and the rep's own recorded calls filed by
 *                              the call center (call-center-logic leadContactPatch)
 *   reply    lastOutboundAt    the Follow-up board's "I replied"
 *   stage    stageHistory[]    an entry this uid wrote (by === uid), dated today
 *                              (`at` from crm-pipeline, `timestamp` from stage-write)
 *   task     _taskCache        a task on the lead completed today
 *   knock    createdAt         a door-knock lead (d2dKnockId) made today
 * NOT counted, because a server or another person writes them: updatedAt (every
 * write stamps it, the follow-up writer and automations included), stageStartedAt
 * (a server stamp; the stage entry above says who moved it), lastInboundAt (the
 * customer's action) and createdAt of any other lead (web forms, imports and
 * storm alerts make leads with the owner's uid on them). no-next-step.js
 * lastTouchMs takes the max of all of those, so it is not used here.
 *
 *   build(input)        -> { leads, visits, promises, closed:{leads, visits|null}, open }
 *   inWindow(now)       16:00-20:00 local: the widget speaks only then (or on tap)
 *   followUpYmd(n, now) 'YYYY-MM-DD' n days from today: the followUp field's format
 *   closedLine(closed)  "Loop closed: 3 leads, 1 visit" from the counts, never a default
 *   carry(result, uid, now)  the device-only carry-over for P2's Welcome Recap (ids only)
 *
 * Classic script: window.NBDOSShutdownLogic; require()-able for tests. Loaded
 * with os/shutdown.js as a runtime ScriptLoader bundle (`osshutdown`, registered
 * by os/home.js the first time a Shutdown widget mounts), never at boot.
 */
(function (root, factory) {
  'use strict';
  var nns = null;
  if (typeof module !== 'undefined' && module.exports) { try { nns = require('../no-next-step.js'); } catch (e) { nns = null; } }
  var api = factory(root, nns);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSShutdownLogic = api;
})(typeof window !== 'undefined' ? window : null, function (root, nodeNns) {
  'use strict';

  var DAY = 86400000;
  var WINDOW_FROM = 16;   // 4 PM local
  var WINDOW_TO = 20;     // up to 8 PM
  var CARRY_KEY = 'nbd_os_carry';
  var CARRY_MAX = 30;

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v, max) { return v == null ? '' : String(v).slice(0, max || 80); }
  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') { try { return t.toMillis(); } catch (e) { return 0; } }
    if (typeof t.toDate === 'function') { try { return t.toDate().getTime(); } catch (e) { return 0; } }
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dayKey(now) { return ymd(new Date(Number(now))); }
  /** Today's local day as [start, end). */
  function dayRange(now) {
    var d = new Date(Number(now)); d.setHours(0, 0, 0, 0);
    var start = d.getTime();
    d.setDate(d.getDate() + 1);
    return { start: start, end: d.getTime() };
  }
  function inRange(ms, r) { return ms > 0 && ms >= r.start && ms < r.end; }
  function inWindow(now) { var h = new Date(Number(now)).getHours(); return h >= WINDOW_FROM && h < WINDOW_TO; }
  function followUpYmd(n, now) {
    var d = new Date(Number(now)); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + (Math.floor(Number(n)) || 0));
    return ymd(d);
  }

  /** no-next-step.js's own pure half: the browser's NBDNoNextStep._pure, Node's require. */
  function nnsApi(env) {
    if (env && env.nns) return env.nns;
    if (nodeNns) return nodeNns;
    var N = root && root.NBDNoNextStep;
    return N && N._pure ? N._pure : null;
  }

  function ownerOf(lead) { return str(lead && (lead.userId || lead.assignedTo), 128); }
  function isMine(lead, uid) { return !!uid && ownerOf(lead) === String(uid); }

  var CONTACT_WORDS = { call: 'Called today', text: 'Texted today', sms: 'Texted today', email: 'Emailed today' };
  /** The latest human touch today by this uid on this lead, or null: { kind, ms, words }. */
  function touchOf(lead, uid, range, taskCache) {
    var best = null;
    function take(kind, ms, words) { if (inRange(ms, range) && (!best || ms > best.ms)) best = { kind: kind, ms: ms, words: words }; }
    take('contact', toMs(lead.lastContactedAt), CONTACT_WORDS[String(lead.lastContactType || '').toLowerCase()] || 'Contacted today');
    take('reply', toMs(lead.lastOutboundAt), 'Replied today');
    arr(lead.stageHistory).forEach(function (h) {
      if (isObj(h) && uid && h.by === uid) take('stage', toMs(h.at || h.timestamp), 'Stage moved today');
    });
    arr(taskCache && taskCache[lead.id]).forEach(function (t) {
      if (isObj(t) && t.deleted !== true) take('task', toMs(t.completedAt), 'Task done today');
    });
    if (lead.d2dKnockId) take('knock', toMs(lead.createdAt), 'Knocked today');
    return best;
  }
  function nameOf(lead) {
    var n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || String(lead.name || '').trim();
    return str(n || String(lead.address || '').split(',')[0].trim() || 'Customer', 80);
  }
  function street(a) { return str(String(a == null ? '' : a).split(',')[0].trim(), 60); }

  /**
   * Own open leads touched today: rows for those with no next step, and the count of those that have one.
   * env: { stageRole, normalizeStage, nns }
   */
  function leadRows(leads, uid, now, taskCache, env) {
    var N = nnsApi(env);
    var out = { rows: [], closed: 0 };
    if (!N || !uid) return out;
    var range = dayRange(now);
    var e = { stageRole: env && env.stageRole, normalizeStage: env && env.normalizeStage };
    var tc = isObj(taskCache) ? taskCache : {};
    arr(leads).forEach(function (l) {
      if (!isObj(l) || !l.id || !isMine(l, uid) || !N.isOpenLead(l, e)) return;
      var t = touchOf(l, uid, range, tc);
      if (!t) return;
      if (N.hasNextStep(l, tc, Number(now))) { out.closed++; return; }
      out.rows.push({ kind: 'lead', id: 'lead:' + str(l.id, 120), leadId: str(l.id, 120), name: nameOf(l), place: street(l.address), touch: t.kind, words: t.words, ms: t.ms });
    });
    out.rows.sort(function (a, b) { return b.ms - a.ms || a.name.localeCompare(b.name); });
    return out;
  }

  var DEAD = { discarded: 1, skipped: 1, quarantined_consent: 1, purge_pending: 1 };
  function fallbackUnfiled(r) {
    if (!r || !r.id || r.leadId) return false;
    if (r.status === 'discarded' || r.status === 'recording') return false;
    return !(r.pipelineStatus && DEAD[r.pipelineStatus]);
  }
  function isGone(r) { return !r || !r.id || r.status === 'discarded' || r.status === 'recording' || !!(r.pipelineStatus && DEAD[r.pipelineStatus]); }
  /**
   * Today's visits (rows from NBDVisitRecorder.listAll, local and remote merged by id): the unfiled ones as rows,
   * and how many were filed. null visits = not read (the counts stay unknown, never 0).
   */
  function visitRows(visits, now, env) {
    if (!Array.isArray(visits)) return { rows: null, filed: null };
    var isUnfiled = env && typeof env.isUnfiled === 'function' ? env.isUnfiled : fallbackUnfiled;
    var range = dayRange(now);
    var byId = {};
    visits.forEach(function (r) {
      if (!isObj(r) || !r.id || !inRange(Number(r.startedAtMs) || 0, range)) return;
      if (r.remoteOnly && r.status !== 'uploaded') return;   // another device's, not uploaded yet (the Unfiled sheet's rule)
      if (!byId[r.id]) byId[r.id] = r;
    });
    var ids = Object.keys(byId);
    // part 2 of a capped recording is the same visit as part 1
    var roots = ids.filter(function (id) { var p = byId[id].partOf; return !p || !byId[p]; }).map(function (id) { return byId[id]; });
    var rows = [], filed = 0;
    roots.forEach(function (r) {
      if (isUnfiled(r)) rows.push({ kind: 'visit', id: 'visit:' + str(r.id, 120), visitId: str(r.id, 120), ms: Number(r.startedAtMs) });
      else if (!isGone(r) && r.leadId) filed++;
    });
    rows.sort(function (a, b) { return a.ms - b.ms; });
    return { rows: rows, filed: filed };
  }

  /** The Today plan's promise rows with a promise past due (NBDToday.last()). */
  function promiseRows(plan) {
    if (!isObj(plan)) return [];
    var seen = {};
    return arr(plan.promises).filter(function (r) {
      return isObj(r) && r.leadId && arr(r.promiseTasks).some(function (t) { return isObj(t) && t.overdue === true; });
    }).map(function (r) {
      var misses = Math.max(0, Math.floor(Number(r.missTotal) || 0));
      return { kind: 'promise', id: 'promise:' + str(r.leadId, 120), leadId: str(r.leadId, 120), name: str(r.name, 80) || 'Customer', misses: misses };
    }).filter(function (r) { if (seen[r.id]) return false; seen[r.id] = true; return true; });
  }

  /**
   * input: { leads, uid, now, taskCache, visits (null = not read), plan, stageRole, normalizeStage, isUnfiled, nns }
   * closed.visits is null until the visits were read.
   */
  function build(input) {
    var i = isObj(input) ? input : {};
    var now = Number(i.now);
    var uid = typeof i.uid === 'string' ? i.uid : '';
    var L = leadRows(i.leads, uid, now, i.taskCache, i);
    var V = visitRows(i.visits, now, i);
    var P = promiseRows(i.plan);
    // a promise row's lead is on the list once
    var onList = {};
    L.rows.forEach(function (r) { onList[r.leadId] = true; });
    P = P.filter(function (r) { return !onList[r.leadId]; });
    var vrows = V.rows || [];
    return {
      leads: L.rows, visits: V.rows, promises: P,
      closed: { leads: L.closed, visits: V.filed },
      open: L.rows.length + vrows.length + P.length,
    };
  }

  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }
  function isCount(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n; }
  /** "Loop closed: 3 leads, 1 visit"; the visits part only once they were counted. '' with no counts. */
  function closedLine(closed) {
    if (!isObj(closed) || !isCount(closed.leads)) return '';
    var parts = [plural(closed.leads, 'lead', 'leads')];
    if (isCount(closed.visits)) parts.push(plural(closed.visits, 'visit', 'visits'));
    return 'Loop closed: ' + parts.join(', ');
  }
  /** The widget's one line from the in-memory rows (no visits there: they need a read). */
  function widgetLine(result) {
    if (!isObj(result)) return '';
    var n = arr(result.leads).length, p = arr(result.promises).length;
    if (!n && !p) return 'Every lead you touched today has a next step';
    var parts = [];
    if (n) parts.push(plural(n, 'lead', 'leads') + ' with no next step');
    if (p) parts.push(plural(p, 'promise', 'promises') + ' past due');
    return parts.join(' · ');
  }

  /**
   * What is still open, for P2's Welcome Recap: ids only (no names, no addresses), this uid's, today's.
   * Kept device-only in localStorage nbd_os_carry (an nbd_ key: sign-out wipes it).
   */
  function carry(result, uid, now) {
    if (!isObj(result) || typeof uid !== 'string' || !uid) return null;
    function ids(list, k) { return arr(list).map(function (r) { return r[k]; }).filter(Boolean).slice(0, CARRY_MAX); }
    return {
      v: 1, uid: uid, dk: dayKey(now), at: Number(now),
      leads: ids(result.leads, 'leadId'), visits: ids(result.visits, 'visitId'), promises: ids(result.promises, 'leadId'),
    };
  }

  return {
    CARRY_KEY: CARRY_KEY, WINDOW_FROM: WINDOW_FROM, WINDOW_TO: WINDOW_TO,
    dayRange: dayRange, dayKey: dayKey, inWindow: inWindow, followUpYmd: followUpYmd,
    ownerOf: ownerOf, isMine: isMine, touchOf: touchOf, leadRows: leadRows, visitRows: visitRows, promiseRows: promiseRows,
    build: build, nameOf: nameOf, closedLine: closedLine, widgetLine: widgetLine, carry: carry, toMs: toMs,
  };
});
