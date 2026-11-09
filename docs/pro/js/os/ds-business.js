/**
 * os/ds-business.js — the NBD OS Daily Success widget's business half, goals
 * and doors (2026-11-09, P1; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.1).
 *
 * The runtime ScriptLoader bundle `osdsbiz`: os/home.js registers it and
 * loads it the first time a Daily Success widget paints its business half, so
 * nothing here is in the dashboard's boot, nor in the OS layout's `needs`.
 *
 * What it adds to the widget, each only when it was counted:
 *   goals   companies/{companyId}/settings/goals { callsPerDay, followUpsPerDay,
 *           doorsPerDay }: whole numbers 1-500 (0 or missing = no goal).
 *           One getDoc (firestore.rules "DAILY GOALS": the tenant reads it,
 *           the owner or a company_admin writes it; nothing here writes).
 *   doors   the member's own knocks created today: the D2D tracker's
 *           getCountFromServer (d2d-tracker-core-2026b.js runMapDiagnostics),
 *           loaded by the same dynamic import (the demo's service worker
 *           answers it from the sample SDK), scoped userId == uid, createdAt
 *           >= local midnight (the [userId, createdAt] index exists). Only for
 *           a member whose role shows Door-to-Door.
 * Read cost: at most 1 getDoc + 1 count query per refresh. A refresh happens
 * only when the widget paints (show, an event it already listens to) and the
 * last answer is over 5 minutes old or from another day or account; never on
 * a timer, never twice at once. A failed read keeps the day's last good value
 * and waits the same 5 minutes. When an answer lands it fires
 * `nbd:os-dsbiz`, which the home repaints on.
 *
 * Pure parts (tested in Node, tests/nbd-os-ds-business-2026-11-09.test.js):
 *   cleanGoals(data)              -> { callsPerDay?, followUpsPerDay?, doorsPerDay? } | null
 *   isCount(n)                    a whole number 0-99999
 *   bizRows(summary, doors, goals) the widget's business lines (see below)
 *   fresh(cache, uid, now)        the cache answers for this account, today, under 5 min
 *   startOfDay(ms)                local midnight
 * Browser: current({ uid, companyId, doors, now }) -> { goals, doors } | null,
 * refreshing as above. No style, no DOM.
 */
(function (root) {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var GOALS = ['callsPerDay', 'followUpsPerDay', 'doorsPerDay'];
  var MAX_GOAL = 500;
  var TTL_MS = 5 * 60000;
  var FS = '/assets/vendor/firebase/10.12.2/firebase-firestore.js';   // the D2D tracker's own import

  function isCount(n) { return typeof n === 'number' && Math.floor(n) === n && n >= 0 && n <= 99999; }
  function isGoal(n) { return typeof n === 'number' && Math.floor(n) === n && n >= 1 && n <= MAX_GOAL; }
  /** The goals doc made safe: only whole goals 1-500; 0 means "no goal". Nothing valid -> null. */
  function cleanGoals(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    var out = {}, n = 0;
    GOALS.forEach(function (k) { if (isGoal(d[k])) { out[k] = d[k]; n++; } });
    return n ? out : null;
  }
  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ms) { var d = new Date(Number(ms)); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function startOfDay(ms) { var d = new Date(Number(ms)); d.setHours(0, 0, 0, 0); return d.getTime(); }

  /**
   * The business half's lines, every number counted:
   *   summary  Today's counts-only summary { calls, followUps, jobs } (what is
   *            LEFT; os/home-logic.js todaySummary) or null
   *   doors    knocks created today (a count) or null (not counted)
   *   goals    cleanGoals() or null
   * -> { left: ['3 calls', '5 follow-ups', '2 jobs'] | [], doors: 'Doors 4 of 40' | 'Doors today 4' | '' }
   * "Left" counts are never set against a goal: a goal is a target of work
   * DONE, and nothing counts calls or follow-ups done yet. Doors are done, so
   * they show against the doors goal when both numbers exist; with no goal
   * they show only when there were any.
   */
  function bizRows(summary, doors, goals) {
    var s = summary && isCount(summary.calls) && isCount(summary.followUps) && isCount(summary.jobs) ? summary : null;
    var left = s ? [plural(s.calls, 'call', 'calls'), plural(s.followUps, 'follow-up', 'follow-ups'), plural(s.jobs, 'job', 'jobs')] : [];
    var g = goals && isGoal(goals.doorsPerDay) ? goals.doorsPerDay : null;
    var d = isCount(doors) ? doors : null;
    var line = d == null ? '' : (g != null ? 'Doors ' + String(d) + ' of ' + String(g) : (d > 0 ? 'Doors today ' + String(d) : ''));
    return { left: left, doors: line };
  }
  function fresh(c, uid, now) {
    return !!c && c.uid === uid && dayKey(c.at) === dayKey(now) && now - c.at >= 0 && now - c.at < TTL_MS;
  }

  // ── browser: one cached answer, refreshed on show ─────────────
  var cache = null, inflight = false;
  function fire() {
    try { W.dispatchEvent(new W.CustomEvent('nbd:os-dsbiz')); } catch (e) {}
  }
  function readGoals(cid) {
    if (!cid || typeof W.getDoc !== 'function' || typeof W.doc !== 'function' || !W.db) return Promise.resolve(undefined);
    return Promise.resolve(W.getDoc(W.doc(W.db, 'companies', cid, 'settings', 'goals'))).then(function (snap) {
      var ex = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
      return ex && typeof snap.data === 'function' ? cleanGoals(snap.data()) : null;
    }, function () { return undefined; });
  }
  function countDoors(uid, now) {
    if (typeof W.query !== 'function' || typeof W.collection !== 'function' || typeof W.where !== 'function' || !W.db) return Promise.resolve(undefined);
    return Promise.resolve().then(function () { return api.fsImport(); }).then(function (m) {
      var since = m.Timestamp && typeof m.Timestamp.fromDate === 'function' ? m.Timestamp.fromDate(new Date(startOfDay(now))) : new Date(startOfDay(now));
      return m.getCountFromServer(W.query(W.collection(W.db, 'knocks'), W.where('userId', '==', uid), W.where('createdAt', '>=', since)));
    }).then(function (snap) {
      var n = snap && typeof snap.data === 'function' ? snap.data().count : null;
      return isCount(n) ? n : undefined;
    }, function () { return undefined; });
  }
  /**
   * env: { uid, companyId, doors (true when the member's role shows D2D), now }.
   * -> the day's last answer for this account, { goals, doors } (either null), or null.
   * Kicks off one refresh when that answer is missing or over 5 minutes old.
   */
  function current(env) {
    var e = env || {};
    var uid = typeof e.uid === 'string' ? e.uid : '';
    var now = Number(e.now);
    if (!uid || !isFinite(now)) return null;
    var mine = cache && cache.uid === uid && dayKey(cache.at) === dayKey(now) ? cache : null;
    if (!fresh(mine, uid, now) && !inflight) {
      inflight = true;
      var wantDoors = e.doors === true;
      Promise.all([readGoals(typeof e.companyId === 'string' ? e.companyId : ''), wantDoors ? countDoors(uid, now) : Promise.resolve(null)])
        .then(function (r) {
          var prev = cache && cache.uid === uid && dayKey(cache.at) === dayKey(now) ? cache : null;
          // undefined = that read failed: keep the day's last good value
          cache = { uid: uid, at: now,
            goals: r[0] === undefined ? (prev ? prev.goals : null) : r[0],
            doors: r[1] === undefined ? (prev && wantDoors ? prev.doors : null) : r[1] };
        }, function () { cache = { uid: uid, at: now, goals: mine ? mine.goals : null, doors: mine ? mine.doors : null }; })
        .then(function () { inflight = false; fire(); });
    }
    return mine ? { goals: mine.goals, doors: mine.doors } : null;
  }
  function reset() { cache = null; inflight = false; }

  var api = { fsImport: function () { return import(FS); },   // replaced in the Node tests
    GOALS: GOALS, MAX_GOAL: MAX_GOAL, TTL_MS: TTL_MS, isCount: isCount, cleanGoals: cleanGoals, bizRows: bizRows, fresh: fresh,
    startOfDay: startOfDay, dayKey: dayKey, current: current, reset: reset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSDsBiz = api;
})(typeof window !== 'undefined' ? window : null);
