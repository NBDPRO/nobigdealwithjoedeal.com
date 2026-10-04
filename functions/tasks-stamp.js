/**
 * tasks-stamp.js — every lead task carries its lead's owner + tenant
 * (2026-10-03, the Today home).
 *
 * The dashboard loads every task in ONE collection-group query
 * (docs/pro/js/tasks.js, shape in today-plan.js tasksQuery): company staff by
 * `companyId`, everyone else by `userId`. A collection-group query only sees
 * a task that carries the field it filters on — and of the ~20 writers of
 * leads/{id}/tasks (the dashboard, the customer page, quick capture, voice
 * notes, the stage checklist, the call center, Thursday, money paper, the
 * portal, measurement…) most never wrote either one. An unstamped task would
 * silently vanish from the bell, the Today list and the card badges.
 *
 * So instead of trusting every writer, this trigger fills what is MISSING on
 * each new task from its parent lead: userId ← lead.userId, companyId ←
 * lead.companyId, leadId ← the path. It never overwrites a value a writer
 * set. Migration 007 (migrations/scripts/007-stamp-task-owner.js) stamps the
 * tasks that already exist. One lead read + at most one write per new task.
 */
'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');

function blank(v) { return v === undefined || v === null || v === ''; }

/**
 * PURE. The fields a task is missing that its lead can supply; {} when none.
 * @param {object} task   the task doc
 * @param {object} lead   the parent lead doc (or null when it is gone)
 * @param {string} leadId the parent lead's id (from the path)
 */
function stampPatch(task, lead, leadId) {
  const t = task || {};
  const l = lead || {};
  const patch = {};
  if (blank(t.userId) && !blank(l.userId)) patch.userId = l.userId;
  if (blank(t.companyId) && !blank(l.companyId)) patch.companyId = l.companyId;
  if (blank(t.leadId) && leadId) patch.leadId = String(leadId);
  return patch;
}

/** Stamp one task. → the patch written ({} = nothing to do). */
async function stampTask(db, leadId, taskId, task) {
  if (!task) return {};
  // Cheap exit: a writer that stamps (tasks.js, tools.js, voicemail.js…) costs no read.
  if (!blank(task.userId) && !blank(task.companyId) && !blank(task.leadId)) return {};
  const ls = await db.doc('leads/' + leadId).get();
  const patch = stampPatch(task, ls.exists ? ls.data() : null, leadId);
  if (Object.keys(patch).length) await db.doc('leads/' + leadId + '/tasks/' + taskId).set(patch, { merge: true });
  return patch;
}

exports.tasksStampOwner = onDocumentCreated({ document: 'leads/{leadId}/tasks/{taskId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 }, async (event) => {
  const task = event.data && typeof event.data.data === 'function' ? event.data.data() : null;
  try {
    const patch = await stampTask(getFirestore(), event.params.leadId, event.params.taskId, task);
    if (Object.keys(patch).length) logger.info('[tasksStampOwner] stamped', { leadId: event.params.leadId, taskId: event.params.taskId, fields: Object.keys(patch) });
  } catch (e) {
    // Never throw on a task write — the migration re-stamps anything missed.
    logger.warn('[tasksStampOwner] failed', { leadId: event.params.leadId, taskId: event.params.taskId, err: e && e.message });
  }
});

exports._internal = { stampPatch, stampTask };
