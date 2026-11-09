/**
 * os/focus-logic.js — the pure half of the NBD OS knock-block focus session
 * (2026-11-09, P3; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md
 * §6 #10, ChromeOS Focus).
 *
 * No DOM, no storage, no network, no clock of its own (every function takes
 * `now`): tested in plain Node (tests/nbd-os-focus-2026-11-09.test.js).
 *
 * A knock block is a canvassing block the rep starts by hand (30, 60 or 90
 * minutes; never by itself). While it runs Do Not Disturb is on, the widget
 * counts down calmly (minutes, never seconds) and shows the doors knocked in
 * the block, counted by the server from the rep's own knocks, against the
 * company's daily doors floor. When it ends it says what the block did and
 * puts Do Not Disturb back the way it was.
 *
 * The record (this device only: localStorage nbd_os_focus, an nbd_ key, so
 * sign-out wipes it; nothing goes to Firestore):
 *   { v:1, uid, start, mins, end,            end = start + mins minutes
 *     dnd: 'mine'                            this block turned DND on (restore = off)
 *        | 'kept'                            DND was already on (restore = leave it)
 *        | 'none'                            no DND on this device (the system layer is off)
 *        | 'done',                           restored already
 *     endedAt?,                              when the block ended (time up, or End early)
 *     doors?, floor? }                       the last count of the block (whole), the doors floor (1-500)
 *
 *   begin(env)              a new record, or null (only LENGTHS, a signed-in uid, a sane clock)
 *   parse(raw, uid, now)    the stored record if it is this account's and whole, else null;
 *                           a block that ended over 12 h ago is dropped
 *   phase(rec, now)         'none' | 'running' | 'over'
 *   finish(rec, now)        the record with endedAt (time up: the planned end; early: now)
 *   minsLeft(rec, now)      whole minutes left, rounded up (never 0 while running)
 *   span(rec)               the count window { from, to }: start .. the block's end (planned, or End early)
 *   withCount(rec, n)       the record with a whole count, or unchanged (a failed count shows nothing)
 *   restore(rec, dndOn, held)  'off' | 'hand' | 'keep': off when this block turned DND on, it is
 *                           still on, and nothing else holds it; 'hand' when a privacy mode
 *                           ("In a home") holds it now (the mode takes it over, see below)
 *   floorOn(goals, ms)      the doors floor for that day: goals.doorsPerDay, Mon-Sat only
 *   view(rec, now)          what the widget says, every number from the record (see below)
 */
(function (root) {
  'use strict';

  var KEY = 'nbd_os_focus';
  var LENGTHS = [30, 60, 90];
  var MIN = 60000;
  var SKEW = 5 * MIN;          // a start this far in the future is a broken clock or record
  var KEEP_MS = 12 * 3600000;  // an ended block's summary is dropped after this
  var DND = ['mine', 'kept', 'none', 'done'];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isMs(n) { return typeof n === 'number' && isFinite(n) && n > 0 && Math.floor(n) === n; }
  function isCount(n) { return typeof n === 'number' && Math.floor(n) === n && n >= 0 && n <= 99999; }
  function isFloor(n) { return typeof n === 'number' && Math.floor(n) === n && n >= 1 && n <= 500; }
  function copy(r) { var o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k]; }); return o; }

  /**
   * env: { uid, now, mins, dndOn (DND is on now), dndAvail (this device has the switch) }
   * -> a new record, or null. The caller turns DND on only when rec.dnd === 'mine'.
   */
  function begin(env) {
    var e = env || {};
    var now = Number(e.now);
    if (typeof e.uid !== 'string' || !e.uid || !isMs(now) || LENGTHS.indexOf(e.mins) === -1) return null;
    return { v: 1, uid: e.uid, start: now, mins: e.mins, end: now + e.mins * MIN,
      dnd: e.dndAvail === true ? (e.dndOn === true ? 'kept' : 'mine') : 'none' };
  }

  function stopAt(r) { return r.endedAt != null ? r.endedAt : r.end; }

  /** The stored record (a string), if it is this account's, whole and not stale; else null. */
  function parse(raw, uid, now) {
    if (typeof raw !== 'string' || !raw || typeof uid !== 'string' || !uid) return null;
    var r;
    try { r = JSON.parse(raw); } catch (e) { return null; }
    var t = Number(now);
    if (!isObj(r) || r.v !== 1 || r.uid !== uid || !isFinite(t)) return null;
    if (!isMs(r.start) || LENGTHS.indexOf(r.mins) === -1 || r.end !== r.start + r.mins * MIN) return null;
    if (r.start > t + SKEW) return null;
    if (DND.indexOf(r.dnd) === -1) return null;
    if (r.endedAt != null && (!isMs(r.endedAt) || r.endedAt < r.start || r.endedAt > r.end)) return null;
    if (r.doors != null && !isCount(r.doors)) return null;
    if (r.floor != null && !isFloor(r.floor)) return null;
    if (t - Math.min(stopAt(r), t) >= KEEP_MS) return null;   // ended long ago (or never finished, long ago)
    var o = { v: 1, uid: r.uid, start: r.start, mins: r.mins, end: r.end, dnd: r.dnd };
    if (r.endedAt != null) o.endedAt = r.endedAt;
    if (r.doors != null) o.doors = r.doors;
    if (r.floor != null) o.floor = r.floor;
    return o;
  }

  function phase(r, now) {
    if (!isObj(r)) return 'none';
    return r.endedAt != null || Number(now) >= r.end ? 'over' : 'running';
  }
  /** The record, ended: time up keeps the planned end; an early End stops at now. Already ended: unchanged. */
  function finish(r, now) {
    if (!isObj(r) || r.endedAt != null) return r;
    var o = copy(r);
    var t = Number(now);
    o.endedAt = isFinite(t) && t < r.end ? Math.max(r.start, Math.floor(t)) : r.end;
    return o;
  }
  function minsLeft(r, now) {
    if (phase(r, now) !== 'running') return 0;
    return Math.max(1, Math.ceil((r.end - Number(now)) / MIN));
  }
  /**
   * The count window: knocks created from the start until the block's end (the planned end while it
   * runs, so a knock the server stamps a little ahead of this device's clock still counts).
   */
  function span(r) { return { from: r.start, to: stopAt(r) }; }
  function withCount(r, n) {
    if (!isObj(r) || !isCount(n)) return r;
    var o = copy(r); o.doors = n; return o;
  }
  function withFloor(r, f) {
    if (!isObj(r)) return r;
    var o = copy(r);
    if (isFloor(f)) o.floor = f; else delete o.floor;
    return o;
  }
  /**
   * What to do with Do Not Disturb when a block ends. 'off' when this block turned it
   * on, it is still on, and nothing else holds it. 'hand' when this block turned it on
   * and a privacy mode ("In a home") holds it now: os/acts.js found DND on when the mode
   * started, so it never took it as its own; the caller hands it over (the mode's memo)
   * so leaving the mode turns it off, as it was before the block. Otherwise 'keep'.
   */
  function restore(r, dndOn, held) {
    if (!isObj(r) || r.dnd !== 'mine' || dndOn !== true) return 'keep';
    return held === true ? 'hand' : 'off';
  }
  /** The doors floor for the day of `ms`: the company goal doorsPerDay, Mon-Sat only (Sunday never counts). */
  function floorOn(goals, ms) {
    if (!isObj(goals) || !isFloor(goals.doorsPerDay)) return null;
    var d = new Date(Number(ms));
    if (!isFinite(d.getTime()) || d.getDay() === 0) return null;
    return goals.doorsPerDay;
  }

  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }
  /**
   * The widget's words. Every number comes from the record; nothing is guessed:
   *   { phase, left: '42 min left' | '', pct: 0-100 (time used) | null,
   *     doors: '7 doors this block' | '' (not counted yet, or the count failed),
   *     floor: 'Toward today's floor of 40' | '',
   *     done: 'Block done: 12 doors in 60 min' | 'Block done after 38 min' (no count) | '',
   *     s: the small widget's short forms { left: '42 min', doors: '7 doors' | '' (running; at the end
   *        '12 doors' | 'Block done' with no count), ran: 'in 60 min' } }
   */
  function view(r, now) {
    var p = phase(r, now);
    var out = { phase: p, left: '', pct: null, doors: '', floor: '', done: '', s: { left: '', doors: '', ran: '' } };
    if (p === 'none') return out;
    var counted = isCount(r.doors);
    if (p === 'running') {
      out.left = minsLeft(r, now) + ' min left';
      out.s.left = minsLeft(r, now) + ' min';
      var used = Math.min(r.mins * MIN, Math.max(0, Number(now) - r.start));
      out.pct = Math.floor(used * 100 / (r.mins * MIN));
      if (counted) out.doors = r.doors === 0 ? 'No doors yet this block' : plural(r.doors, 'door', 'doors') + ' this block';
      if (counted) out.s.doors = plural(r.doors, 'door', 'doors');
    } else {
      var ran = Math.max(1, Math.round((stopAt(r) - r.start) / MIN));
      out.done = counted ? 'Block done: ' + plural(r.doors, 'door', 'doors') + ' in ' + ran + ' min' : 'Block done after ' + ran + ' min';
      out.s.doors = counted ? plural(r.doors, 'door', 'doors') : 'Block done';
      out.s.ran = 'in ' + ran + ' min';
    }
    if (isFloor(r.floor)) out.floor = (p === 'running' ? 'Toward today\'s floor of ' : 'Today\'s floor is ') + plural(r.floor, 'door', 'doors');
    return out;
  }

  var api = { KEY: KEY, LENGTHS: LENGTHS, KEEP_MS: KEEP_MS, begin: begin, parse: parse, phase: phase, finish: finish, minsLeft: minsLeft,
    span: span, withCount: withCount, withFloor: withFloor, restore: restore, floorOn: floorOn, view: view, stopAt: stopAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSFocusLogic = api;
})(typeof window !== 'undefined' ? window : null);
