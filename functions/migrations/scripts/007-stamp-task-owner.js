/**
 * Migration 007 — stamp every lead task with its lead's owner + tenant.
 *
 * The Today home (2026-10-03) loads all of a user's tasks in ONE
 * collection-group query scoped by `companyId` (company staff) or `userId`
 * (everyone else) instead of one query per lead. Most task writers never
 * wrote those fields, and a collection-group query cannot see a task that
 * lacks the field it filters on. functions/tasks-stamp.js stamps every NEW
 * task from its parent lead; this stamps the backlog the same way
 * (tasks-stamp.js stampPatch — the one rule):
 *
 *   userId    ← lead.userId     (only when the task has none)
 *   companyId ← lead.companyId  (only when the task has none)
 *   leadId    ← the path        (only when the task has none)
 *
 * Never overwrites a value. Tasks under a lead that no longer exists are
 * skipped (nothing reads them). Idempotent: a re-run finds nothing missing.
 * Runs on the daily migrationsTick after deploy, or at once via the admin
 * runMigrations callable — until it has run, a legacy unstamped task is
 * missing from the Today list / bell / card badges (the one-query load).
 */
'use strict';

const { stampPatch } = require('../../tasks-stamp')._internal;

exports.version = 7;
exports.name = 'stamp-task-owner';
exports.up = async (ctx) => {
  const { db, log } = ctx;
  let docsRead = 0, docsWritten = 0;
  const counts = { leads: 0, tasks: 0, stamped: 0 };
  let batch = db.batch();
  let pending = 0;
  async function flush() {
    if (!pending) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  }

  for await (const snap of ctx.pages('leads')) {
    for (const leadDoc of snap.docs) {
      docsRead++;
      counts.leads++;
      const lead = leadDoc.data() || {};
      const tasks = await leadDoc.ref.collection('tasks').get();
      for (const t of tasks.docs) {
        docsRead++;
        counts.tasks++;
        const patch = stampPatch(t.data(), lead, leadDoc.id);
        if (!Object.keys(patch).length) continue;
        batch.set(t.ref, patch, { merge: true });
        pending++;
        docsWritten++;
        counts.stamped++;
        if (pending >= 400) await flush();
      }
    }
  }
  await flush();
  log('leads=' + counts.leads + ' tasks=' + counts.tasks + ' stamped=' + counts.stamped);
  return { docsRead, docsWritten, note: 'stamped ' + counts.stamped + '/' + counts.tasks + ' tasks across ' + counts.leads + ' leads' };
};
