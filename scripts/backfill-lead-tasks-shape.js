/**
 * scripts/backfill-lead-tasks-shape.js
 *
 * ONE-TIME BACKFILL — gives every leads/{leadId}/tasks doc the fields the
 * task readers actually render.
 *
 * Background (2026-09-26)
 * ───────────────────────
 * Every task surface reads the same shape — {text, title, done, dueDate}:
 *   • tasks.js renderTaskList / renderTodayTasks → t.text, t.done, t.dueDate
 *   • notif-bell.js, activity-feed.js, ai.js       → t.text, t.done, t.dueDate
 *   • customer-bootstrap loadTimeline              → title || text, done
 * Two client writers produced a different one — {title, body, status:'open',
 * priority, …} with NO `text` and NO `done`:
 *   • voicemail.js writeActionItemTasks (also no dueDate, sourceType:'voicemail')
 *   • tools.js Quick Add "Reach out within 24h" (has a dueDate)
 * The dashboard printed those rows with an empty label: the Quick Add one
 * sat in Today's Tasks as a blank line (then "OVERDUE"), and its overdue
 * notification read `"undefined" for <name>`. Both writers are fixed in the
 * same PR; this heals the rows they already wrote.
 *
 * Patch (fills MISSING fields only — never overwrites, never deletes):
 *   text    ← title                       when text is absent/empty
 *   done    ← status is done/completed/closed/complete, else false
 *                                         when done is not a boolean
 *   dueDate ← null                        when the field is absent
 *   notes   ← body                        when notes is absent and body is set
 * An absent dueDate is deliberately backfilled as null, NOT as a date:
 * inventing one on an old row would put it straight into Today's Tasks as
 * OVERDUE and fire an overdue notification for a months-old voicemail.
 * `status`, `body`, `sourceType` are left in place (reversibility; nothing
 * reads them, nothing breaks by keeping them).
 * Skipped: Add-Event docs (type:'event' — their own shape) and the legacy
 * top-level /tasks collection (only leads/{id}/tasks is canonical — see
 * functions/migrations/scripts/006-unify-tasks.js).
 *
 * SAFETY
 *   • Dry-run by default — read-only; prints counts and sample rows.
 *   • --apply requires --yes as well.
 *   • Idempotent — a patched doc has nothing missing, so a re-run skips it.
 *   • Run-once guard (scripts/_migration-guard.js); --force to re-apply.
 *
 * RUN
 *   node scripts/backfill-lead-tasks-shape.js               # dry-run
 *   node scripts/backfill-lead-tasks-shape.js --apply --yes # actually write
 */
'use strict';

const DONE_STATUSES = new Set(['done', 'completed', 'complete', 'closed']);

function nonEmpty(v) { return typeof v === 'string' && v.trim() !== ''; }

/**
 * The whole decision, as a pure function (unit-tested in
 * tests/lead-task-writer-shape.test.js). Returns the fields to merge into
 * the doc, or null when nothing is missing / the doc is out of scope.
 */
function canonicalPatch(data) {
  const t = data || {};
  if (t.type === 'event') return null;
  const patch = {};
  if (!nonEmpty(t.text) && nonEmpty(t.title)) patch.text = t.title.trim().slice(0, 200);
  if (typeof t.done !== 'boolean') {
    patch.done = DONE_STATUSES.has(String(t.status || '').toLowerCase());
  }
  if (!Object.prototype.hasOwnProperty.call(t, 'dueDate')) patch.dueDate = null;
  if (!Object.prototype.hasOwnProperty.call(t, 'notes') && nonEmpty(t.body)) patch.notes = t.body;
  return Object.keys(patch).length ? patch : null;
}

module.exports = { canonicalPatch };

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const YES = args.includes('--yes');
  const FORCE = args.includes('--force');
  const MIGRATION = 'backfill-lead-tasks-shape';
  const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
  const PAGE = 500;
  const BATCH = 400;

  if (APPLY && !YES) {
    console.error('Refusing to --apply without --yes. Re-run with: --apply --yes');
    process.exit(2);
  }

  // Lazy: keeps canonicalPatch requirable by a dependency-free test.
  const { initAdmin, getFirestore } = require('./_admin');
  const { assertNotCompleted, recordCompletion } = require('./_migration-guard');
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();
  await assertNotCompleted(MIGRATION, { apply: APPLY, force: FORCE });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('Backfill leads/{id}/tasks shape (text / done / dueDate)');
  console.log('  project : ' + PROJECT);
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)'));
  console.log('═══════════════════════════════════════════════════════════\n');

  const c = { scanned: 0, topLevelSkipped: 0, events: 0, ok: 0, toFix: 0, noText: 0,
    noTextWithSourceType: 0, unlabeled: 0, written: 0, failures: 0 };
  const bySource = {};
  let shown = 0;

  let batch = db.batch();
  let pending = 0;
  async function flush() {
    if (!pending) return;
    try { await batch.commit(); c.written += pending; }
    catch (e) { c.failures += pending; console.warn('! batch commit failed — ' + e.message); }
    batch = db.batch();
    pending = 0;
  }

  let last = null;
  for (;;) {
    let q = db.collectionGroup('tasks').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      c.scanned++;
      const parentDoc = d.ref.parent.parent;
      if (!parentDoc || parentDoc.parent.id !== 'leads') { c.topLevelSkipped++; continue; }
      const t = d.data() || {};
      if (t.type === 'event') { c.events++; continue; }
      if (!nonEmpty(t.text)) {
        c.noText++;
        if (t.sourceType) c.noTextWithSourceType++;
        if (!nonEmpty(t.title)) c.unlabeled++;
      }
      const patch = canonicalPatch(t);
      if (!patch) { c.ok++; continue; }
      c.toFix++;
      const src = t.sourceType || t.source || (t.status ? '(status, no source)' : '(none)');
      bySource[src] = (bySource[src] || 0) + 1;
      if (shown < 20) {
        shown++;
        console.log('  ' + (APPLY ? 'patch ' : 'would patch ') + d.ref.path
          + '  [' + src + ']  ' + JSON.stringify(patch).slice(0, 160));
      }
      if (APPLY) {
        batch.set(d.ref, patch, { merge: true });
        pending++;
        if (pending >= BATCH) await flush();
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }
  await flush();

  console.log('\n───────────────────────────────────────────────────────────');
  console.log('  scanned (all "tasks" groups)   : ' + c.scanned);
  console.log('  top-level /tasks (skipped)     : ' + c.topLevelSkipped);
  console.log('  Add-Event docs (skipped)       : ' + c.events);
  console.log('  already canonical              : ' + c.ok);
  console.log('  no text                        : ' + c.noText);
  console.log('    …of which carry sourceType   : ' + c.noTextWithSourceType);
  console.log('    …with no title either        : ' + c.unlabeled);
  console.log('  needed backfill                : ' + c.toFix);
  Object.keys(bySource).sort().forEach(k => console.log('    ' + k + ': ' + bySource[k]));
  if (APPLY) {
    console.log('  written                        : ' + c.written);
    console.log('  failures                       : ' + c.failures);
  } else {
    console.log('  (dry-run — re-run with --apply --yes to write)');
  }
  console.log('───────────────────────────────────────────────────────────');

  if (APPLY && c.failures === 0) await recordCompletion(MIGRATION, c);
  process.exit(c.failures > 0 ? 1 : 0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
