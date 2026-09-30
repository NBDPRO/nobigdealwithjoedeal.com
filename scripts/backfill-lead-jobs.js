/**
 * scripts/backfill-lead-jobs.js
 *
 * ONE-TIME BACKFILL for "a customer can have more than one job" (phase 1;
 * functions/jobs-logic.js, functions/jobs-mirror.js; plan in
 * documentation/projects/CRM-JOBS-AND-MONEY-PAPER-PLAN-2026-09-30.md).
 *
 * For every lead of ONE company that has no job yet, creates its first job
 * (leads/{id}/jobs/j1, copied from the lead's own stage / value / schedule /
 * claim fields) and sets lead.activeJobId = 'j1'. The jobsMirrorOnLead trigger
 * does exactly this lazily on a lead's next write; the backfill just gets
 * every lead there at once, including the ones nobody touches.
 *
 * SAFETY
 *   • Dry-run by default — prints what WOULD change, writes nothing.
 *   • --company=<companyId> is REQUIRED (Jo's rule for admin scripts: NBD is
 *     --company=1phDvAVXHSg82wDLegAbQFq14Ci1). Only that tenant's leads.
 *   • --apply requires --yes as well.
 *   • Idempotent: a lead that already has a valid activeJobId pointing at an
 *     existing job is skipped; j1 is written with create-if-absent semantics
 *     (a job that already exists is never overwritten).
 *   • Never deletes anything. Run-once guard per company
 *     (scripts/_migration-guard.js); --force overrides.
 *   • The lead write re-fires the mirror trigger, which then finds the job in
 *     step and writes nothing.
 *
 * SETUP (the admin-script-runner pattern — prod nobigdeal-pro via ADC):
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *
 * RUN
 *   node scripts/backfill-lead-jobs.js --company=<id>               # dry-run
 *   node scripts/backfill-lead-jobs.js --company=<id> --apply --yes # write
 */
'use strict';

const J = require('../functions/jobs-logic');

const VALID_ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Pure per-lead decision. → { action: 'skip'|'create'|'repoint', why }
 *   skip    — already has a valid pointer to an existing job
 *   create  — no job: create j1 from the lead + set activeJobId
 *   repoint — j1 exists but the pointer is missing/invalid/dangling: set it
 */
function planForLead(lead, jobs) {
  const l = lead || {};
  const ids = new Set((jobs || []).map((j) => j.id));
  const ptr = typeof l.activeJobId === 'string' && VALID_ID.test(l.activeJobId) ? l.activeJobId : null;
  if (ptr && ids.has(ptr)) return { action: 'skip', why: 'has active job ' + ptr };
  if (ids.has(J.FIRST_JOB_ID)) return { action: 'repoint', why: ptr ? 'pointer to a missing job' : 'job exists, no pointer' };
  return { action: 'create', why: 'no job yet' };
}

module.exports = { planForLead };

if (require.main === module) {
  const { initAdmin, getFirestore } = require('./_admin');
  const { assertNotCompleted, recordCompletion } = require('./_migration-guard');

  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const YES = args.includes('--yes');
  const FORCE = args.includes('--force');
  const COMPANY = ((args.find((a) => a.startsWith('--company=')) || '').split('=')[1] || '').trim();
  const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
  const PAGE = 300;

  (async () => {
    if (!COMPANY || !VALID_ID.test(COMPANY)) {
      console.error('Required: --company=<companyId>  (NBD: --company=1phDvAVXHSg82wDLegAbQFq14Ci1)');
      process.exit(2);
    }
    if (APPLY && !YES) { console.error('Refusing to --apply without --yes.'); process.exit(2); }
    initAdmin({ projectId: PROJECT });
    const db = getFirestore();
    const MIGRATION = 'backfill-lead-jobs:' + COMPANY;
    await assertNotCompleted(MIGRATION, { apply: APPLY, force: FORCE });

    console.log('Backfill leads/{id}/jobs  project=' + PROJECT + '  company=' + COMPANY + '  mode=' + (APPLY ? 'APPLY' : 'DRY-RUN'));
    const counts = { scanned: 0, skip: 0, create: 0, repoint: 0, written: 0, failures: 0 };
    let last = null;
    for (;;) {
      let q = db.collection('leads').where('companyId', '==', COMPANY).orderBy('__name__').limit(PAGE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        counts.scanned++;
        const lead = doc.data() || {};
        const jobsSnap = await doc.ref.collection('jobs').get();
        const plan = planForLead(lead, jobsSnap.docs.map((d) => ({ id: d.id })));
        counts[plan.action]++;
        if (plan.action === 'skip') continue;
        if (!APPLY) {
          if (counts.create + counts.repoint <= 25) {
            console.log('  would ' + plan.action + '  ' + doc.id + '  (' + plan.why + ')  stage=' + JSON.stringify(lead.stage || '') + ' value=' + (lead.jobValue || 0));
          }
          continue;
        }
        try {
          if (plan.action === 'create') {
            await doc.ref.collection('jobs').doc(J.FIRST_JOB_ID).create(Object.assign(J.firstJobFromLead(lead), { origin: 'backfill', mirroredAt: new Date() }));
          }
          await doc.ref.update({ activeJobId: J.FIRST_JOB_ID });
          counts.written++;
        } catch (e) {
          if (/already exists/i.test(e.message || '')) {
            await doc.ref.update({ activeJobId: J.FIRST_JOB_ID }).then(() => counts.written++, () => counts.failures++);
          } else {
            counts.failures++;
            console.warn('! ' + doc.id + ' — ' + e.message);
          }
        }
      }
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < PAGE) break;
    }
    console.log(JSON.stringify(counts));
    if (!APPLY) console.log('(dry-run — re-run with --apply --yes to write)');
    if (APPLY && counts.failures === 0) await recordCompletion(MIGRATION, counts);
    process.exit(counts.failures > 0 ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
