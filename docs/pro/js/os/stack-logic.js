/**
 * os/stack-logic.js — the NBD OS Smart Stack, which card to show (2026-11-09, P1;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.1).
 *
 * Pure: no DOM, no clock, no storage, no network (tests/nbd-os-stack-2026-11-09.test.js
 * runs a simulated day through it in plain Node). os/widgets-p1.js passes in what
 * the CRM already holds in memory.
 *
 *   pick({ now, plan, nextAppt, storm, counts, dsSnapshot, dismissed, children, shutdown })
 *     -> { childId, reason, rule, focus }
 *     now        ms; the hour is the device's local hour
 *     plan       NBDToday.last() (the next appointment is found in it when nextAppt is absent)
 *     nextAppt   { key, startMs } of the next timed appointment, optional
 *     storm      Storm Center's cache { ts, data:[...] } (nbd_storm_alerts_cache)
 *     counts     { waiting }: home-logic urgency(), a new lead with no reply on file or a missed call
 *     dsSnapshot the validated same-day Daily Success cut (home-logic dsPersonal), or null
 *     dismissed  { ruleId: true } rules the member stepped away from (skipped)
 *     children   the stack's cards the member can see, in order
 *     shutdown   true when a Shutdown widget is in the catalog at runtime
 *
 *   Rules, first match wins, and only for a card the stack holds:
 *     appt      an appointment starts within 60 min (or began under 15 min ago) -> Up Next,
 *               focused on it (the pre-flight peek is P2)
 *     storm     Storm Center cached an alert within the last 60 min -> Storm
 *     callback  a new lead (or, with no reply stamps, a missed call) has waited 5+ min -> Up Next,
 *               focused on it ("Call back"), else Needs you
 *     morning   05:00-10:00 -> Daily Success
 *     work      10:00-16:00 (work hours, after the morning window) -> Up Next
 *     evening   16:00-20:00 -> Shutdown when that widget exists, else Coach
 *     default   otherwise the stack's first card
 *   `reason` is what "Why this?" says; every number in it is one these inputs counted.
 *   Nothing here re-picks on a timer: the widget calls pick() on show, unlock and events.
 *
 * Classic script: window.NBDOSStackLogic; require()-able for tests. Loaded as the
 * runtime ScriptLoader bundle 'oshomep1' (os/home.js registers it), never at boot.
 */
(function (root) {
  'use strict';

  var MIN = 60000;
  var APPT_AHEAD = 60, APPT_GRACE = 15, STORM_FRESH = 60, WAIT_MIN = 5;
  var MORNING = [5, 10], WORK = [10, 16], EVENING = [16, 20];
  var RULES = ['appt', 'storm', 'callback', 'morning', 'work', 'evening'];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function whole(v) { var n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : 0; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function inHours(h, w) { return h >= w[0] && h < w[1]; }
  /** A wait as words: minutes under 90, else whole hours. */
  function waited(m) { return m < 90 ? plural(m, 'minute', 'minutes') : plural(Math.floor(m / 60), 'hour', 'hours'); }

  /** The next timed appointment in the plan that is not more than APPT_GRACE minutes under way. */
  function nextFrom(plan, now) {
    var list = isObj(plan) && Array.isArray(plan.appointments) ? plan.appointments : [];
    var best = null;
    list.forEach(function (a) {
      var t = isObj(a) && !a.allDay ? Number(a.sortMs) : NaN;
      if (isFinite(t) && t >= now - APPT_GRACE * MIN && (!best || t < best.startMs)) best = { key: String(a.key || ''), startMs: t };
    });
    return best;
  }
  function apptRule(x, now) {
    var na = isObj(x.nextAppt) && isFinite(Number(x.nextAppt.startMs)) ? { key: String(x.nextAppt.key || ''), startMs: Number(x.nextAppt.startMs) } : nextFrom(x.plan, now);
    if (!na) return null;
    var d = na.startMs - now;
    if (d > APPT_AHEAD * MIN || d < -APPT_GRACE * MIN) return null;
    var m = Math.round(Math.abs(d) / MIN);
    var reason = m === 0 ? 'Your next appointment starts now.'
      : d > 0 ? 'Your next appointment starts in ' + plural(m, 'minute', 'minutes') + '.'
        : 'Your appointment started ' + plural(m, 'minute', 'minutes') + ' ago.';
    return { childId: 'upnext', reason: reason, focus: { kind: 'appt', key: na.key } };
  }
  function stormRule(x, now) {
    var c = x.storm;
    if (!isObj(c) || typeof c.ts !== 'number' || !Array.isArray(c.data) || !c.data.length) return null;
    if (c.ts > now + 5 * MIN || now - c.ts >= STORM_FRESH * MIN) return null;
    var n = c.data.length, age = Math.max(0, Math.floor((now - c.ts) / MIN));
    return { childId: 'storm', reason: 'Storm Center cached ' + plural(n, 'weather alert', 'weather alerts') + ' ' + (age ? plural(age, 'minute', 'minutes') + ' ago' : 'just now') + '.' };
  }
  function callbackRule(x, has) {
    var w = isObj(x.counts) ? x.counts.waiting : null;
    if (!isObj(w) || !whole(w.n) || whole(w.oldestMin) < WAIT_MIN) return null;
    var n = whole(w.n), m = whole(w.oldestMin);
    var reason = w.kind === 'lead'
      ? (n === 1 ? 'A new lead has waited ' + waited(m) + ' with no reply on file.'
        : plural(n, 'new lead', 'new leads') + ' have no reply on file; the oldest has waited ' + waited(m) + '.')
      : (n === 1 ? 'A missed call from ' + waited(m) + ' ago is not returned yet.'
        : plural(n, 'missed call', 'missed calls') + ' are not returned yet; the oldest is ' + waited(m) + ' old.');
    var child = has('upnext') ? 'upnext' : (has('needsyou') ? 'needsyou' : '');
    if (!child) return null;
    return { childId: child, reason: reason, focus: { kind: w.kind === 'lead' ? 'lead' : 'call', id: String(w.leadId || ''), n: n, min: m } };
  }
  function morningRule(x) {
    var d = x.dsSnapshot;
    var whole2 = isObj(d) && typeof d.met === 'number' && typeof d.of === 'number' && d.of > 0;
    return { childId: 'daily', reason: whole2 ? 'Morning: your floors first. ' + d.met + ' of ' + d.of + ' met so far today.' : 'Morning: your floors first.' };
  }

  function pick(input) {
    var x = isObj(input) ? input : {};
    var now = whole(x.now);
    var kids = (Array.isArray(x.children) ? x.children : []).filter(function (id) { return typeof id === 'string' && id; });
    if (!kids.length) return null;
    var off = isObj(x.dismissed) ? x.dismissed : {};
    function has(id) { return kids.indexOf(id) !== -1; }
    var h = new Date(now).getHours();
    var tries = {
      appt: function () { return apptRule(x, now); },
      storm: function () { return stormRule(x, now); },
      callback: function () { return callbackRule(x, has); },
      morning: function () { return inHours(h, MORNING) ? morningRule(x) : null; },
      work: function () { return inHours(h, WORK) ? { childId: 'upnext', reason: 'Work hours: what is next on your Today list.' } : null; },
      evening: function () {
        if (!inHours(h, EVENING)) return null;
        return x.shutdown === true && has('shutdown') ? { childId: 'shutdown', reason: 'Evening: close the loop on today.' }
          : { childId: 'coach', reason: 'Evening: one thing worth doing before you stop.' };
      },
    };
    for (var i = 0; i < RULES.length; i++) {
      if (off[RULES[i]] === true) continue;
      var r = now ? tries[RULES[i]]() : null;
      if (r && has(r.childId)) return { childId: r.childId, reason: r.reason, rule: RULES[i], focus: r.focus || null };
    }
    return { childId: kids[0], reason: 'Nothing time-sensitive right now, so your first card.', rule: 'default', focus: null };
  }

  /** The card one step from `i` (dir -1 / +1), wrapping. */
  function step(n, i, dir) { var c = whole(n); if (!c) return 0; return ((Number(i) || 0) + (dir < 0 ? -1 : 1) + c) % c; }

  var api = { RULES: RULES, pick: pick, step: step, nextFrom: nextFrom, WAIT_MIN: WAIT_MIN, MORNING: MORNING, WORK: WORK, EVENING: EVENING };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSStackLogic = api;
})(typeof window !== 'undefined' ? window : null);
