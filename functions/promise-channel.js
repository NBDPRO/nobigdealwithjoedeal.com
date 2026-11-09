'use strict';
/**
 * promise-channel.js - the reads behind the server promise channel
 * (functions/promise-channel-logic.js has the rules).
 *
 * ONE query: collectionGroup('tasks').where('userId', '==', owner) - the same
 * equality-only shape the morning brief, the calendar feed and the game card
 * already run, served by the single-field COLLECTION_GROUP index on
 * tasks.userId (firestore.indexes.json). Everything else (kind, done, date) is
 * judged in memory, so NO new index is needed. The owner's own leads are then
 * fetched by id (getAll) for the name, tenant, deleted flag and number label.
 *
 * A failed read is NEVER an empty list: it returns { failed: true } and every
 * caller shows "could not check" (callWatch ledger / brief), never an all-clear.
 */
const { logger } = require('firebase-functions/v2');
const PL = require('./promise-channel-logic');
const TCT = require('./task-call-text');

const GETALL_CHUNK = 100;

async function readDuePromisePeople({ db, owner, nowMs, labels }) {
  try {
    const snap = await db.collectionGroup('tasks').where('userId', '==', owner).get();
    const tasks = [];
    (snap.docs || []).forEach((d) => {
      const t = d.data() || {};
      if (t.kind !== 'promise' || t.done === true) return;
      const parent = d.ref && d.ref.parent && d.ref.parent.parent;
      const leadId = (parent && parent.id) || t.leadId;
      if (!leadId) return;
      tasks.push(Object.assign({}, t, { id: d.id, leadId: String(leadId) }));
    });
    // The owner's push / bell names the promise: lay each task's call text
    // (Q11, 2026-11-09: the task itself holds a generic title) back over it.
    const full = await TCT.overlayTasks(db, tasks);
    tasks.splice(0, tasks.length, ...full);
    // Only the leads behind tasks that are actually due.
    const due = PL.dueItems(tasks, nowMs);
    const ids = Array.from(new Set(due.map((x) => x.leadId)));
    const leadsById = new Map();
    for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
      const part = ids.slice(i, i + GETALL_CHUNK);
      const snaps = await db.getAll(...part.map((id) => db.doc('leads/' + id)));
      snaps.forEach((s, j) => { if (s && s.exists) leadsById.set(part[j], s.data() || {}); });
    }
    const people = PL.duePeople(tasks, leadsById, { now: nowMs, owner, labels });
    return { ok: true, failed: false, people, tasks: due.length };
  } catch (e) {
    logger.warn('[promiseChannel] read failed', { err: e && e.message });
    return { ok: false, failed: true, people: [], tasks: 0, error: String((e && e.message) || e).slice(0, 160) };
  }
}

module.exports = { readDuePromisePeople };
