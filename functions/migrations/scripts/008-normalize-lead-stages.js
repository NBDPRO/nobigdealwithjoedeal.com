/**
 * Migration 008 — normalise old stage keys and stamp stageRole (2026-10-04).
 *
 * The 2026-10-04 numbers audit read the owner tenant: 64 leads sat at the
 * legacy display name 'New' (capital N) and 62 had no stageRole at all. The
 * board normalises 'New' at read time, but anything that compares the stored
 * value — a server count by stage, a Firestore `where('stage', ...)`, a report
 * keyed on the raw string — saw two different stages, and every server
 * classifier that trusts the persisted stageRole first (stage-roles.js
 * roleFor) had nothing to trust. The writers were fixed in the same PR (Cal.com
 * bridge, Thursday intake, inbound-SMS convert all write 'new' + stageRole);
 * this heals the leads already written.
 *
 * Per lead doc (leads/*):
 *   - stage is a legacy display name or a case/spacing variant of a built-in
 *     key → rewrite it to the canonical key ('New' → 'new', 'Closed Won' →
 *     'closed', 'Install In Progress' → 'install_in_progress');
 *   - stageRole missing / not a valid role and the stage is a BUILT-IN key →
 *     stamp the role the key implies;
 *   - a stale `_stageKey` copy (old Stripe payoffs persisted one) is rewritten
 *     to the same canonical key, because stage-roles.js reads `_stageKey ||
 *     stage`.
 * A tenant CUSTOM stage (any key the server does not know) is never touched:
 * its role lives in the tenant's pipeline config, which the server cannot see.
 * Deleted leads are normalised too — restoring one must not bring back drift.
 *
 * Idempotent: a second run finds nothing to change (planStageFix returns null
 * for a lead that is already canonical with a valid role).
 *
 * Dry run: `node functions/migrations/scripts/008-normalize-lead-stages.js`
 * (default) prints what WOULD change, with counts, and writes nothing; add
 * `--apply` to write. The scheduled runner (migrationsTick, 04:40 ET) calls
 * up() and applies. MIGRATION_DRY_RUN=1 in the environment makes up() a dry
 * run too (returns the counts in `note`, writes nothing, and the runner still
 * records the version — so only use it for a manual callable test).
 */

'use strict';

const SR = require('../../stage-roles');

const VALID_ROLES = ['new', 'active', 'job', 'won', 'lost'];

/**
 * The fix for one lead, or null when it is already right. Pure.
 * @returns {null | { patch: object, from: string|null, to: string|null, roleStamped: boolean }}
 */
function planStageFix(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const raw = lead.stage;
  const canon = SR.canonicalStageKey(raw);
  const patch = {};
  if (canon && raw != null && raw !== '' && raw !== canon) patch.stage = canon;
  if (canon && raw == null) patch.stage = canon; // a lead with no stage at all is New
  const key = canon || null;
  if (key && Object.prototype.hasOwnProperty.call(lead, '_stageKey') && lead._stageKey !== key
      && SR.canonicalStageKey(lead._stageKey) !== null) patch._stageKey = key;
  const hasRole = typeof lead.stageRole === 'string' && VALID_ROLES.indexOf(lead.stageRole) !== -1;
  let roleStamped = false;
  if (key) {
    const want = SR.roleFromKey(key);
    // Stamp a missing/invalid role; also correct a built-in key whose stored
    // role disagrees ONLY when the stored value is invalid — a valid stored
    // role on a built-in key may be a tenant override (pipeline config can
    // re-role a built-in stage), so it is left alone.
    if (!hasRole) { patch.stageRole = want; roleStamped = true; }
  }
  if (!Object.keys(patch).length) return null;
  return { patch, from: raw == null ? null : String(raw), to: key, roleStamped };
}

async function run(db, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const dryRun = !!o.dryRun;
  const pages = o.pages;
  let docsRead = 0, docsWritten = 0;
  const counts = { stageRewritten: 0, roleStamped: 0, byFrom: {} };
  let batch = dryRun ? null : db.batch();
  let pending = 0;
  async function flush() {
    if (dryRun || pending === 0) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  }
  for await (const snap of pages('leads', 300)) {
    for (const d of snap.docs) {
      docsRead++;
      const fix = planStageFix(d.data() || {});
      if (!fix) continue;
      if (fix.patch.stage) {
        counts.stageRewritten++;
        const k = (fix.from == null ? '(none)' : fix.from) + ' → ' + fix.to;
        counts.byFrom[k] = (counts.byFrom[k] || 0) + 1;
      }
      if (fix.roleStamped) counts.roleStamped++;
      docsWritten++;
      if (!dryRun) {
        batch.update(d.ref, fix.patch);
        pending++;
        if (pending >= 400) await flush();
      }
    }
  }
  await flush();
  const note = (dryRun ? 'DRY RUN — nothing written. ' : '')
    + counts.stageRewritten + ' stage(s) normalised, ' + counts.roleStamped + ' stageRole(s) stamped. '
    + Object.keys(counts.byFrom).map((k) => k + ' ×' + counts.byFrom[k]).join('; ');
  log(note);
  return { docsRead, docsWritten: dryRun ? 0 : docsWritten, wouldWrite: docsWritten, counts, note: note.slice(0, 900) };
}

exports.version = 8;
exports.name    = 'normalize-lead-stages';
exports.planStageFix = planStageFix;
exports.run = run;
exports.up = async (ctx) => run(ctx.db, {
  log: ctx.log,
  pages: ctx.pages,
  dryRun: !!ctx.dryRun || process.env.MIGRATION_DRY_RUN === '1',
});

// CLI: dry run by default; --apply to write. Needs application-default
// credentials for the target project (gcloud auth application-default login).
if (require.main === module) {
  (async () => {
    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getFirestore, FieldPath } = require('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'nobigdeal-pro' });
    const db = getFirestore();
    async function* pages(coll, size) {
      let cursor = null;
      for (;;) {
        let q = db.collection(coll).orderBy(FieldPath.documentId()).limit(size);
        if (cursor) q = q.startAfter(cursor);
        const s = await q.get();
        if (s.empty) return;
        yield s;
        if (s.size < size) return;
        cursor = s.docs[s.docs.length - 1].id;
      }
    }
    const apply = process.argv.indexOf('--apply') !== -1;
    const r = await run(db, { dryRun: !apply, pages, log: (m) => console.log('[008] ' + m) });
    console.log(JSON.stringify({ apply, docsRead: r.docsRead, wouldWrite: r.wouldWrite, counts: r.counts }, null, 2));
  })().catch((e) => { console.error(e); process.exit(1); });
}
