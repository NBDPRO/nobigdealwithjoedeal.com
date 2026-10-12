/**
 * promise-logic.js — the pure half of Promise capture + Waiting-on-them
 * (2026-10-12; design: documentation/projects/PROMISE-CAPTURE-2026-10-12.md).
 *
 * A promise is a normal task, leads/{leadId}/tasks/{id}, with a few extra
 * fields (kind:'promise', promiseKind, why, missCount …) — so the bell, the
 * customer timeline, the overdue push, the one task load and the rules all
 * already apply. Nothing here touches the DOM, Firestore or the clock:
 * callers pass `now` / `todayYmd`. today-plan.js (the Today list) and
 * promise-ui.js (the sheet) both use this; functions/promise-logic.js is the
 * server twin (tests/promise-capture-2026-10-12.test.js pins parity).
 *
 * Browser: window.NBDPromiseLogic. Node: module.exports.
 */
(function (root) {
  'use strict';

  // key → label, the due the chip pre-selects, and the task's lead word.
  // 'waiting' is not owed today: its "due" is when it ripens (since + N).
  var KINDS = Object.freeze({
    callback: Object.freeze({ label: 'Call back', task: 'Call back', due: 'today' }),
    estimate: Object.freeze({ label: 'Send estimate', task: 'Send estimate', due: 'tomorrow' }),
    text:     Object.freeze({ label: 'Text by 5pm', task: 'Text by 5pm', due: 'today', dueBy: '17:00' }),
    order:    Object.freeze({ label: 'Order materials', task: 'Order materials', due: 'tomorrow' }),
    permit:   Object.freeze({ label: 'Check on permit', task: 'Check on permit', due: 'd3' }),
    waiting:  Object.freeze({ label: 'Waiting on them', task: 'Waiting on', due: 'waiting' }),
  });
  var KIND_KEYS = Object.freeze(['callback', 'estimate', 'text', 'order', 'permit', 'waiting']);
  var DUE_CHIPS = Object.freeze([
    Object.freeze({ id: 'today', label: 'Today', days: 0 }),
    Object.freeze({ id: 'tomorrow', label: 'Tomorrow', days: 1 }),
    Object.freeze({ id: 'd3', label: 'In 3 days', days: 3 }),
    Object.freeze({ id: 'w1', label: 'Next week', days: 7 }),
  ]);
  var WAITING_ON = Object.freeze({
    customer: 'the customer', adjuster: 'the adjuster', supplier: 'the supplier', other: 'someone',
  });
  var WAITING_ON_KEYS = Object.freeze(['customer', 'adjuster', 'supplier', 'other']);
  var DEFAULT_WAITING_DAYS = 3;
  var MIN_WAITING_DAYS = 1, MAX_WAITING_DAYS = 14;
  var MAX_AHEAD_DAYS = 120;
  var WHY_MAX = 140;

  // ─── dates: all 'YYYY-MM-DD' calendar-day strings, no timezone math ──
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdLocal(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parts(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd == null ? '' : ymd));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;   // 2026-02-30 is not a date
    return { y: y, m: mo, d: d, utc: t.getTime() };
  }
  function isYmd(s) { return parts(s) !== null; }
  function addDaysYmd(ymd, n) {
    var p = parts(ymd);
    if (!p) return '';
    var t = new Date(p.utc + Math.round(n) * 86400000);
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }
  /** Whole days from a to b (b later = positive); NaN when either is not a date. */
  function daysBetween(a, b) {
    var pa = parts(a), pb = parts(b);
    return pa && pb ? Math.round((pb.utc - pa.utc) / 86400000) : NaN;
  }
  /** A task's due day ('dueDate' is a date-input value; some writers add a time). */
  function dueYmdOf(t) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String((t && t.dueDate) || ''));
    return m && isYmd(m[1]) ? m[1] : '';
  }

  // ─── the chips ───────────────────────────────────────────────────
  function isKind(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(KINDS, k); }
  function isWaitingOn(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(WAITING_ON, k); }
  function clampWaitingDays(n) {
    var v = Math.round(Number(n));
    if (!isFinite(v)) return DEFAULT_WAITING_DAYS;
    return Math.min(MAX_WAITING_DAYS, Math.max(MIN_WAITING_DAYS, v));
  }
  /** A due chip id → the 'YYYY-MM-DD' it means from todayYmd ('' for an unknown id). */
  function dueFromChip(chipId, todayYmd) {
    for (var i = 0; i < DUE_CHIPS.length; i++) if (DUE_CHIPS[i].id === chipId) return addDaysYmd(todayYmd, DUE_CHIPS[i].days);
    return '';
  }
  /** The date a kind pre-selects. Waiting: the day it ripens. */
  function defaultDue(kind, todayYmd, waitingDays) {
    if (!isKind(kind)) return '';
    var d = KINDS[kind].due;
    if (d === 'waiting') return addDaysYmd(todayYmd, clampWaitingDays(waitingDays));
    return dueFromChip(d, todayYmd);
  }
  /** Which due chip a date is (for the pre-selected state), or 'pick'. */
  function chipForDue(ymd, todayYmd) {
    for (var i = 0; i < DUE_CHIPS.length; i++) if (addDaysYmd(todayYmd, DUE_CHIPS[i].days) === ymd) return DUE_CHIPS[i].id;
    return 'pick';
  }
  /** A due date a promise may carry: a real date, today .. today + 120 days. */
  function dueProblem(ymd, todayYmd) {
    if (!isYmd(ymd)) return 'Pick a date.';
    var n = daysBetween(todayYmd, ymd);
    if (!(n >= 0)) return 'That date is in the past - pick today or later.';
    if (n > MAX_AHEAD_DAYS) return 'That is more than ' + MAX_AHEAD_DAYS + ' days out - pick a nearer date.';
    return '';
  }
  /** The one-line "why": plain text, no markup or control characters, 140 chars. */
  function cleanWhy(v) {
    return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, WHY_MAX);
  }
  /** The legacy `text` every older surface reads: "Send estimate - why". */
  function taskText(kind, why, waitingOn) {
    if (!isKind(kind)) return '';
    var lead = kind === 'waiting' ? 'Waiting on ' + (WAITING_ON[waitingOn] || WAITING_ON.customer) : KINDS[kind].task;
    var w = cleanWhy(why);
    return w ? lead + ' - ' + w : lead;
  }

  // ─── the task shape ──────────────────────────────────────────────
  /**
   * The fields of a NEW promise task (no timestamps — the writer adds
   * createdAt / madeAt as serverTimestamp, plus the tenant stamps).
   * Returns { error } for a bad kind / date so no caller writes a half task.
   * @param {object} o { kind, dueYmd, why, todayYmd, uid, source, sourceCallId,
   *                     waitingOn, waitingDays }
   */
  function buildTask(o) {
    var x = o || {};
    if (!isKind(x.kind)) return { error: 'Pick what you promised.' };
    var today = x.todayYmd;
    if (!isYmd(today)) return { error: 'No date to work from.' };
    var waiting = x.kind === 'waiting';
    var waitingOn = waiting ? (isWaitingOn(x.waitingOn) ? x.waitingOn : 'customer') : null;
    var due = x.dueYmd || defaultDue(x.kind, today, x.waitingDays);
    var bad = dueProblem(due, today);
    if (bad) return { error: bad };
    var t = {
      kind: 'promise',
      promiseKind: x.kind,
      text: taskText(x.kind, x.why, waitingOn),
      why: cleanWhy(x.why),
      done: false,
      dueDate: due,
      dueBy: KINDS[x.kind].dueBy || null,
      madeYmd: today,
      madeBy: x.uid || null,
      source: ['call', 'text', 'today', 'customer'].indexOf(x.source) !== -1 ? x.source : 'customer',
      sourceCallId: x.sourceCallId ? String(x.sourceCallId) : null,
      missCount: 0,
      rescheduleCount: 0,
    };
    if (waiting) {
      t.waitingOn = waitingOn;
      t.waitingSince = today;
      t.nudgeCount = 0;
    }
    return t;
  }

  function isPromise(t) { return !!t && t.kind === 'promise' && isKind(t.promiseKind); }
  function isWaiting(t) { return isPromise(t) && t.promiseKind === 'waiting'; }
  function isOpen(t) { return !!t && t.done !== true && !t.completedAt && t.deleted !== true; }
  /** An open, owed-now promise (not a waiting item) due today or earlier. */
  function isOwedNow(t, todayYmd) {
    if (!isPromise(t) || isWaiting(t) || !isOpen(t)) return false;
    var due = dueYmdOf(t);
    return !!due && due <= todayYmd;
  }
  /** Whole days late (0 = due today); 0 when not overdue / no date. */
  function daysLate(t, todayYmd) {
    var due = dueYmdOf(t);
    if (!due) return 0;
    var n = daysBetween(due, todayYmd);
    return n > 0 ? n : 0;
  }
  /** Days since the wait began; 0 when the date is missing or in the future. */
  function waitingDays(t, todayYmd) {
    var since = t && (t.waitingSince || t.madeYmd);
    var n = daysBetween(since, todayYmd);
    return n > 0 ? n : 0;
  }
  /** A waiting item that has been waited out: open, and >= n days since. */
  function isRipe(t, todayYmd, n) {
    return isWaiting(t) && isOpen(t) && waitingDays(t, todayYmd) >= clampWaitingDays(n);
  }

  // ─── the only two exits, and moving it ───────────────────────────
  /** Why this date is not a valid new date for this promise ('' = fine). */
  function moveProblem(t, newYmd, todayYmd) {
    var bad = dueProblem(newYmd, todayYmd);
    if (bad) return bad;
    if (dueYmdOf(t) === newYmd) return 'That is the date it already has - pick a new one.';
    return '';
  }
  /**
   * Patch for moving a promise to a new date. A move on or after the due day is
   * "moved"; one made once it is already past due is a "miss" (missCount).
   * overdueNotified is cleared so the overdue push can fire for the new date.
   */
  function movePatch(t, newYmd, todayYmd) {
    var old = dueYmdOf(t);
    var late = !!old && old < todayYmd;
    var p = {
      dueDate: newYmd,
      rescheduleCount: (Number(t && t.rescheduleCount) || 0) + 1,
      missCount: (Number(t && t.missCount) || 0) + (late ? 1 : 0),
      lastMovedYmd: todayYmd,
      movedFromDue: old || null,
      overdueNotified: false,
    };
    if (isWaiting(t)) p.waitingSince = t.waitingSince;   // moving the nudge date is not a new wait
    return p;
  }
  function keptPatch() { return { done: true, outcome: 'kept' }; }
  function deadPatch() { return { done: true, outcome: 'dead' }; }
  /** "Still waiting": the clock restarts today, dated. */
  function stillWaitingPatch(t, todayYmd, n) {
    return {
      waitingSince: todayYmd,
      dueDate: addDaysYmd(todayYmd, clampWaitingDays(n)),
      stillWaitingCount: (Number(t && t.stillWaitingCount) || 0) + 1,
      lastStillWaitingYmd: todayYmd,
      overdueNotified: false,
    };
  }
  /** Recorded only once Jo says the message went out. */
  function nudgePatch(t, todayYmd) {
    return { nudgeCount: (Number(t && t.nudgeCount) || 0) + 1, lastNudgedYmd: todayYmd };
  }

  /** "missed 2 times" / "moved 3 times" / '' — chronic skips must show. */
  function missLabel(t) {
    var miss = Number(t && t.missCount) || 0;
    if (miss > 0) return 'missed ' + miss + (miss === 1 ? ' time' : ' times');
    var mv = Number(t && t.rescheduleCount) || 0;
    if (mv >= 2) return 'moved ' + mv + ' times';
    return '';
  }
  /** Red once it has been missed twice or moved four times. */
  function missIsHot(t) { return (Number(t && t.missCount) || 0) >= 2 || (Number(t && t.rescheduleCount) || 0) >= 4; }

  // ─── what the row says ───────────────────────────────────────────
  /** One short line: "Send estimate - due today - why". Plain text (callers escape). */
  function describe(t, todayYmd) {
    if (!isPromise(t)) return String((t && (t.text || t.title)) || 'Task');
    var late = daysLate(t, todayYmd);
    var when = late > 0 ? (late === 1 ? '1 day late' : late + ' days late') : 'due today';
    var head = isWaiting(t) ? 'Waiting on ' + (WAITING_ON[t.waitingOn] || WAITING_ON.customer) : KINDS[t.promiseKind].task;
    var bits = [head, when];
    if (t.dueBy && late === 0) bits[1] = 'by 5pm';
    if (t.why) bits.push(t.why);
    return bits.join(' - ');
  }

  // ─── the Nudge: fixed words, merge fields only ────────────────────
  function _firstName(v) {
    return String(v || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/[^A-Za-zÀ-ɏ' -]/g, '').replace(/\s+/g, ' ').trim().split(' ')[0].slice(0, 40);
  }
  function _claimNo(v) { return String(v || '').replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 40); }
  /**
   * The draft Jo's phone opens (never sent from here). Words are fixed; only
   * the recipient's first name, Jo's "<name> with <company>" and (adjuster)
   * the claim number the lead already carries are merged in. No price, no
   * coverage / deductible talk, nothing about handling a claim (Kentucky).
   * @param {object} o { waitingOn, recipientName, from, claimNumber }
   * @returns {{channel:'text'|'email', subject:string, text:string}}
   */
  function nudgeDraft(o) {
    var x = o || {};
    var who = isWaitingOn(x.waitingOn) ? x.waitingOn : 'customer';
    var first = _firstName(x.recipientName);
    var hi = 'Hi' + (first ? ' ' + first : '') + ',';
    var from = String(x.from || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    var me = from ? ' it’s ' + from + '.' : '';
    if (who === 'adjuster') {
      var cn = _claimNo(x.claimNumber);
      return {
        channel: 'text', subject: 'Following up',
        text: hi + me + ' Following up' + (cn ? ' on file ' + cn : '') + '. Could you let me know the date for the inspection or where things stand? Thank you.',
      };
    }
    if (who === 'supplier') {
      return {
        channel: 'text', subject: 'Order status',
        text: hi + me + ' Checking in on my order. Could you confirm the status and the delivery date when you get a chance? Thanks.',
      };
    }
    if (who === 'other') {
      return { channel: 'text', subject: 'Checking in', text: hi + me + ' Just checking in. Let me know where this stands when you get a chance. Thanks.' };
    }
    return {
      channel: 'text', subject: 'Checking in on your roof',
      text: hi + me + ' Just checking in on what we talked about for your roof. Anything I can answer or do on my end? Text me back whenever it is easy.',
    };
  }

  var API = {
    KINDS: KINDS, KIND_KEYS: KIND_KEYS, DUE_CHIPS: DUE_CHIPS, WAITING_ON: WAITING_ON, WAITING_ON_KEYS: WAITING_ON_KEYS,
    DEFAULT_WAITING_DAYS: DEFAULT_WAITING_DAYS, MIN_WAITING_DAYS: MIN_WAITING_DAYS, MAX_WAITING_DAYS: MAX_WAITING_DAYS,
    MAX_AHEAD_DAYS: MAX_AHEAD_DAYS, WHY_MAX: WHY_MAX,
    ymdLocal: ymdLocal, isYmd: isYmd, addDaysYmd: addDaysYmd, daysBetween: daysBetween, dueYmdOf: dueYmdOf,
    isKind: isKind, isWaitingOn: isWaitingOn, clampWaitingDays: clampWaitingDays,
    dueFromChip: dueFromChip, defaultDue: defaultDue, chipForDue: chipForDue, dueProblem: dueProblem,
    cleanWhy: cleanWhy, taskText: taskText, buildTask: buildTask,
    isPromise: isPromise, isWaiting: isWaiting, isOpen: isOpen, isOwedNow: isOwedNow,
    daysLate: daysLate, waitingDays: waitingDays, isRipe: isRipe,
    moveProblem: moveProblem, movePatch: movePatch, keptPatch: keptPatch, deadPatch: deadPatch,
    stillWaitingPatch: stillWaitingPatch, nudgePatch: nudgePatch,
    missLabel: missLabel, missIsHot: missIsHot, describe: describe, nudgeDraft: nudgeDraft,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root && root.document) root.NBDPromiseLogic = API;
})(typeof window !== 'undefined' ? window : null);
