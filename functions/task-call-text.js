'use strict';
/**
 * task-call-text.js — the call text of a task (Call to Close Q11, Jo
 * 2026-11-09, review item 2: "a viewer's task list must not show call
 * content").
 *
 * A task the server files from a call (Thursday thursday-<callId>, Call
 * Center cube-<callId> / sms-<dayId>, a call's promise-<callId>[-n]) is read
 * by every reader of the customer, viewers included, and by collection-group
 * loads. Rules cannot hide one field, so the task keeps a GENERIC title
 * ("Follow up with Pat", "Call back Pat", "Call back") and what came from the
 * call (the issue, the promise the AI pulled, "You said you would") goes in
 * leads/{leadId}/task_call_text/{taskId}, which firestore.rules keeps from a
 * viewer. The task carries callText: true so a reader knows to look.
 *
 *   split(full, generic)  the task to store (generic values + callText) with
 *                         the call text on a NON-enumerable `callTextFull`
 *                         ({ full, generic }). Non-enumerable on purpose: a
 *                         writer that forgets the sidecar, or a copy made
 *                         with Object.assign({}, task), stores the generic
 *                         task and drops the call text. It fails closed.
 *   apply(task, side)     the task as an owner reads it: each field that
 *                         still holds the generic value the server wrote gets
 *                         the call text back. A field someone edited since
 *                         keeps the edit.
 *   createTaskIfAbsent    create the task; when created, write its call text.
 *   overlayTasks          apply() over a list of tasks (admin reads, owners).
 *
 * The browser twin of apply() is docs/pro/js/task-call-text.js;
 * tests/q11-task-call-text-2026-11-09.test.js runs both on the same inputs.
 */

const COLLECTION = 'task_call_text';
const FIELDS = ['title', 'text', 'notes', 'why'];
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function split(full, generic) {
  const task = Object.assign({}, full);
  const g = {}, f = {};
  for (const k of FIELDS) {
    if (!has(generic, k) || generic[k] === full[k]) continue;
    g[k] = generic[k];
    f[k] = has(full, k) ? full[k] : '';
  }
  if (!Object.keys(g).length) return task;
  Object.assign(task, g, { callText: true });
  Object.defineProperty(task, 'callTextFull', { value: { full: f, generic: g }, enumerable: false });
  return task;
}

function apply(task, side) {
  if (!task || !side || typeof side !== 'object' || !side.full || !side.generic) return task;
  const out = Object.assign({}, task);
  for (const k of FIELDS) {
    if (has(side.full, k) && has(side.generic, k) && out[k] === side.generic[k]) out[k] = side.full[k];
  }
  return out;
}

/** 'leads/L/tasks/T' -> 'leads/L/task_call_text/T' (null for any other path). */
function sidePath(taskPath) {
  const m = /^leads\/([^/]+)\/tasks\/([^/]+)$/.exec(String(taskPath || ''));
  return m ? 'leads/' + m[1] + '/' + COLLECTION + '/' + m[2] : null;
}

function sideDoc(taskPath, task) {
  const m = /^leads\/([^/]+)\/tasks\/([^/]+)$/.exec(String(taskPath || ''));
  return {
    leadId: m ? m[1] : null,
    taskId: m ? m[2] : null,
    source: (task && task.source) || null,
    full: task.callTextFull.full,
    generic: task.callTextFull.generic,
  };
}

/** Write (set) the task's call text next to it. No-op for a task without one. */
async function writeSide(db, taskPath, task) {
  const p = sidePath(taskPath);
  if (!p || !task || !task.callTextFull) return false;
  await db.doc(p).set(sideDoc(taskPath, task));
  return true;
}

/**
 * createIfAbsent(ref, data) is the caller's own (each writer has one). The
 * call text is written only when the task was created, so a re-run never
 * rewrites what a finished task points at.
 */
async function createTaskIfAbsent(db, createIfAbsent, taskPath, task) {
  const made = await createIfAbsent(db.doc(taskPath), task);
  if (made) await writeSide(db, taskPath, task);
  return made;
}

const alreadyExists = (e) => !!e && (e.code === 6 || e.code === 'already-exists' || /already exists/i.test(String(e.message || '')));

/**
 * Copy a task's call text along with a moved task, then remove the old one.
 * create(), not set(): a target that already has call text keeps it (review
 * 2026-11-09), while a retry whose task copy landed before the call text did
 * still carries it.
 */
async function moveSide(db, fromTaskPath, toTaskPath) {
  const from = sidePath(fromTaskPath), to = sidePath(toTaskPath);
  if (!from || !to) return false;
  const s = await db.doc(from).get();
  if (!s || !s.exists) return false;
  const m = /^leads\/([^/]+)\/tasks\/([^/]+)$/.exec(toTaskPath);
  let moved = true;
  try { await db.doc(to).create(Object.assign({}, s.data(), { leadId: m[1], taskId: m[2] })); }
  catch (e) { if (!alreadyExists(e)) throw e; moved = false; }
  await db.doc(from).delete();
  return moved;
}

/**
 * tasks: [{ id, leadId, ...task }] read with the admin SDK FOR AN OWNER (never
 * for a viewer). Returns a new list with the call text laid over every task
 * that has one. A failed read leaves the generic task.
 */
async function overlayTasks(db, tasks, chunk = 100) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const idx = [];
  list.forEach((t, i) => { if (t && t.callText === true && t.leadId && t.id) idx.push(i); });
  for (let i = 0; i < idx.length; i += chunk) {
    const part = idx.slice(i, i + chunk);
    let snaps = [];
    try { snaps = await db.getAll(...part.map((j) => db.doc('leads/' + list[j].leadId + '/' + COLLECTION + '/' + list[j].id))); } catch (_) { snaps = []; }
    part.forEach((j, n) => { const s = snaps[n]; if (s && s.exists) list[j] = apply(list[j], s.data()); });
  }
  return list;
}

module.exports = { COLLECTION, FIELDS, split, apply, sidePath, writeSide, createTaskIfAbsent, moveSide, overlayTasks };
