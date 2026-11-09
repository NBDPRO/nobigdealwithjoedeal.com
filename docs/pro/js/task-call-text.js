/**
 * task-call-text.js — window.NBDTaskCallText (Call to Close Q11, Jo
 * 2026-11-09: a viewer's task list shows no call content).
 *
 * A task the server files from a call (Thursday, Call Center, Text Inbox, a
 * call's promise) stores a generic title ("Follow up with Pat"); what came
 * from the call is in leads/{leadId}/task_call_text/{taskId}, which
 * firestore.rules keeps from a viewer. The task carries callText: true.
 * overlay() reads that doc for each such task and lays it back over the task
 * for everyone else, so owners, admins, managers and reps see exactly what
 * they saw before. A viewer is never read for (the rule would refuse it);
 * a refused or failed read leaves the generic task.
 *
 * Lazy: tasks.js and customer-bootstrap.module.js load it with
 * ScriptLoader only when a loaded task has callText and the user is not a
 * viewer. apply() is the twin of functions/task-call-text.js apply();
 * tests/q11-task-call-text-2026-11-09.test.js runs both.
 */
(function (root) {
  'use strict';
  var FIELDS = ['title', 'text', 'notes', 'why'];
  var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };

  function apply(task, side) {
    if (!task || !side || typeof side !== 'object' || !side.full || !side.generic) return task;
    var out = Object.assign({}, task);
    FIELDS.forEach(function (k) {
      if (has(side.full, k) && has(side.generic, k) && out[k] === side.generic[k]) out[k] = side.full[k];
    });
    return out;
  }

  function isViewer(w) { return (((w && w._userClaims) || {}).role || '') === 'viewer'; }

  function wanted(t, opts) {
    return !!t && t.callText === true && !!t.id && !!t.leadId && !(opts && opts.openOnly && t.done === true);
  }

  /** True when overlay() would read anything (callers skip the lazy load otherwise). */
  function needed(w, tasks, opts) {
    return !isViewer(w) && (tasks || []).some(function (t) { return wanted(t, opts); });
  }

  /**
   * w: { db, doc, getDoc, _userClaims } (window). tasks: [{ id, leadId, ... }].
   * opts.openOnly: skip done tasks (the dashboard's whole-book load).
   * Resolves to a new list; never rejects.
   */
  function overlay(w, tasks, opts) {
    var list = Array.isArray(tasks) ? tasks.slice() : [];
    if (!w || isViewer(w) || typeof w.getDoc !== 'function' || typeof w.doc !== 'function') return Promise.resolve(list);
    var jobs = [];
    list.forEach(function (t, i) {
      if (!wanted(t, opts)) return;
      jobs.push(Promise.resolve().then(function () {
        return w.getDoc(w.doc(w.db, 'leads', String(t.leadId), 'task_call_text', String(t.id)));
      }).then(function (s) {
        var exists = s && (typeof s.exists === 'function' ? s.exists() : s.exists);
        if (exists) list[i] = apply(t, s.data());
      }).catch(function () { /* refused / offline: the generic task stays */ }));
    });
    return Promise.all(jobs).then(function () { return list; });
  }

  var api = { apply: apply, overlay: overlay, needed: needed, FIELDS: FIELDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDTaskCallText = api;
})(typeof window !== 'undefined' ? window : null);
