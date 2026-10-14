'use strict';
/**
 * promise-logic.js — the server twin of docs/pro/js/promise-logic.js
 * (2026-10-12; design: documentation/projects/PROMISE-CAPTURE-2026-10-12.md).
 *
 * callCenterAction's `promise` / `promiseMove` actions build the promise task
 * here. Only what the server writes is mirrored — the chips, the date window,
 * the one-line why, the task shape and the move patch — and
 * tests/promise-capture-2026-10-12.test.js runs both files on the same inputs
 * and requires byte-identical answers (the today-plan.js / morning-brief-logic
 * convention). No Firestore, no clock: callers pass todayYmd.
 */

const KINDS = Object.freeze({
  callback: Object.freeze({ task: 'Call back', due: 'today' }),
  estimate: Object.freeze({ task: 'Send estimate', due: 'tomorrow' }),
  text: Object.freeze({ task: 'Text by 5pm', due: 'today', dueBy: '17:00' }),
  order: Object.freeze({ task: 'Order materials', due: 'tomorrow' }),
  permit: Object.freeze({ task: 'Check on permit', due: 'd3' }),
  waiting: Object.freeze({ task: 'Waiting on', due: 'waiting' }),
});
const DUE_DAYS = Object.freeze({ today: 0, tomorrow: 1, d3: 3, w1: 7 });
const WAITING_ON = Object.freeze({ customer: 'the customer', adjuster: 'the adjuster', supplier: 'the supplier', other: 'someone' });
const DEFAULT_WAITING_DAYS = 3;
const MAX_AHEAD_DAYS = 120;
const WHY_MAX = 140;
const SOURCES = ['call', 'text', 'today', 'customer', 'visit'];

const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const pad2 = (n) => (n < 10 ? '0' : '') + n;

function parts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd == null ? '' : ymd));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { utc: t.getTime() };
}
const isYmd = (s) => parts(s) !== null;
function addDaysYmd(ymd, n) {
  const p = parts(ymd);
  if (!p) return '';
  const t = new Date(p.utc + Math.round(n) * 86400000);
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}
function daysBetween(a, b) {
  const pa = parts(a), pb = parts(b);
  return pa && pb ? Math.round((pb.utc - pa.utc) / 86400000) : NaN;
}
const dueYmdOf = (t) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String((t && t.dueDate) || ''));
  return m && isYmd(m[1]) ? m[1] : '';
};
function clampWaitingDays(n) {
  const v = Math.round(Number(n));
  if (!isFinite(v)) return DEFAULT_WAITING_DAYS;
  return Math.min(14, Math.max(1, v));
}
function defaultDue(kind, todayYmd, waitingDays) {
  if (!has(KINDS, kind)) return '';
  const d = KINDS[kind].due;
  if (d === 'waiting') return addDaysYmd(todayYmd, clampWaitingDays(waitingDays));
  return addDaysYmd(todayYmd, DUE_DAYS[d]);
}
function dueProblem(ymd, todayYmd) {
  if (!isYmd(ymd)) return 'Pick a date.';
  const n = daysBetween(todayYmd, ymd);
  if (!(n >= 0)) return 'That date is in the past - pick today or later.';
  if (n > MAX_AHEAD_DAYS) return 'That is more than ' + MAX_AHEAD_DAYS + ' days out - pick a nearer date.';
  return '';
}
function cleanWhy(v) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, WHY_MAX);
}
function taskText(kind, why, waitingOn) {
  if (!has(KINDS, kind)) return '';
  const lead = kind === 'waiting' ? 'Waiting on ' + (WAITING_ON[waitingOn] || WAITING_ON.customer) : KINDS[kind].task;
  const w = cleanWhy(why);
  return w ? lead + ' - ' + w : lead;
}

/** Same fields, same order, as the client buildTask (no timestamps, no stamps). */
function buildTask(o) {
  const x = o || {};
  if (!has(KINDS, x.kind)) return { error: 'Pick what you promised.' };
  const today = x.todayYmd;
  if (!isYmd(today)) return { error: 'No date to work from.' };
  const waiting = x.kind === 'waiting';
  const waitingOn = waiting ? (has(WAITING_ON, x.waitingOn) ? x.waitingOn : 'customer') : null;
  const due = x.dueYmd || defaultDue(x.kind, today, x.waitingDays);
  const bad = dueProblem(due, today);
  if (bad) return { error: bad };
  const t = {
    kind: 'promise',
    promiseKind: x.kind,
    text: taskText(x.kind, x.why, waitingOn),
    why: cleanWhy(x.why),
    done: false,
    dueDate: due,
    dueBy: KINDS[x.kind].dueBy || null,
    madeYmd: today,
    madeBy: x.uid || null,
    source: SOURCES.indexOf(x.source) !== -1 ? x.source : 'customer',
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

// ── readers (2026-10-13): the server channel judges promise TASKS ──────────
// Server twins of docs/pro/js/promise-logic.js isPromise / isWaiting / isOpen /
// isOwedNow / isRipe (tests/promise-channel-2026-10-13.test.js runs both).
const isPromise = (t) => !!t && t.kind === 'promise' && has(KINDS, t.promiseKind);
const isWaiting = (t) => isPromise(t) && t.promiseKind === 'waiting';
const isOpen = (t) => !!t && t.done !== true && !t.completedAt && t.deleted !== true;
function isOwedNow(t, todayYmd) {
  if (!isPromise(t) || isWaiting(t) || !isOpen(t)) return false;
  const due = dueYmdOf(t);
  return !!due && due <= todayYmd;
}
function isRipe(t, todayYmd, n) {
  if (!isWaiting(t) || !isOpen(t)) return false;
  const due = dueYmdOf(t);
  if (due) return due <= todayYmd;
  const since = t && (t.waitingSince || t.madeYmd);
  const d = daysBetween(since, todayYmd);
  return (d > 0 ? d : 0) >= clampWaitingDays(n);
}

function moveProblem(t, newYmd, todayYmd) {
  const bad = dueProblem(newYmd, todayYmd);
  if (bad) return bad;
  if (dueYmdOf(t) === newYmd) return 'That is the date it already has - pick a new one.';
  return '';
}
function movePatch(t, newYmd, todayYmd) {
  const old = dueYmdOf(t);
  const late = !!old && old < todayYmd;
  const p = {
    dueDate: newYmd,
    rescheduleCount: (Number(t && t.rescheduleCount) || 0) + 1,
    missCount: (Number(t && t.missCount) || 0) + (late ? 1 : 0),
    lastMovedYmd: todayYmd,
    movedFromDue: old || null,
    overdueNotified: false,
  };
  if (t && t.kind === 'promise' && t.promiseKind === 'waiting') p.waitingSince = t.waitingSince;
  return p;
}

module.exports = {
  KINDS, WAITING_ON, DEFAULT_WAITING_DAYS, MAX_AHEAD_DAYS, WHY_MAX,
  isYmd, addDaysYmd, daysBetween, dueYmdOf, clampWaitingDays, defaultDue, dueProblem,
  cleanWhy, taskText, buildTask, moveProblem, movePatch,
  isPromise, isWaiting, isOpen, isOwedNow, isRipe,
};
