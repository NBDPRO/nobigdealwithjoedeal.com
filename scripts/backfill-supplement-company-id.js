/**
 * scripts/backfill-supplement-company-id.js
 *
 * ONE-TIME BACKFILL (Finding 5, 2026-11-14): stamps `companyId` on every
 * /supplements doc saved before supplements carried it, copied from the
 * supplement's PARENT ESTIMATE's companyId.
 *
 * Why: the office (company_admin / manager) now finds a job's supplements by
 * companyId when it invoices (docs/pro/js/invoice-pipeline.js
 * loadEstimateSupplements; firestore.rules /supplements read). A supplement
 * with no companyId stays readable only by the rep who saved it. When the
 * lead's timeline names it, the office's invoice is refused (not under-billed);
 * when the timeline entry is also missing, nothing can see it and the office's
 * invoice silently leaves it off. This closes that gap.
 *
 * SAFETY
 *   • Dry-run by default: prints what WOULD change, writes nothing.
 *   • --apply requires --yes as well. Agents never run --apply (CLAUDE.md rule f);
 *     Jo runs it, after the rules + client change is deployed.
 *   • Fill-only and idempotent: a supplement that already has a companyId is
 *     never touched, so it is safe to re-run.
 *   • Stamps ONLY when the supplement's author belongs to the estimate's tenant
 *     (they wrote the estimate, or their companyId claim equals the
 *     estimate's companyId) AND its leadId is the estimate's leadId (second
 *     security pass M-C, 2026-11-14). A supplement saved before this PR could
 *     name ANOTHER tenant's estimate; stamping it would pull its amount into
 *     that tenant's billing. Everything else is REPORTED for a person.
 *   • A supplement whose parent estimate is missing, or has no companyId
 *     itself, is REPORTED and left alone (no guessing a tenant).
 *   • A PERSON MUST READ THE DRY-RUN OUTPUT (every "would stamp" and every
 *     "cannot place" line) before anyone runs --apply.
 *   • Joe's decision (2026-11-14): this stays a DRY RUN. Joe reviews its
 *     output first; nobody runs it against production (dry run or --apply)
 *     without Joe asking for that specific run.
 *   • Writes only `companyId`, with update() (fails if the doc is gone; never
 *     re-creates one), so the invoiced stamp, the money and the provenance
 *     fields are untouched. The Admin SDK skips rules.
 *
 * SETUP (admin-script-runner pattern; firebase-admin via scripts/_admin.js)
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *   export NBD_PROJECT=nobigdeal-pro               # optional override
 *
 * RUN
 *   node scripts/backfill-supplement-company-id.js               # dry-run
 *   node scripts/backfill-supplement-company-id.js --apply --yes # actually write
 *
 * planBackfill() is pure and exported for
 * tests/invoice-supplements-company-2026-11-14.test.js.
 */
'use strict';

/**
 * @param {Array<{id: string, data: object}>} supplements
 * @param {Object<string, object>} estimatesById  parent estimate data by id (missing = not found)
 * @param {Object<string, string>} [authorCompanyById]  uid → that user's companyId claim
 * @returns {{ updates: Array<{id, companyId}>, skipped: {already: number}, problems: Array<{id, reason}> }}
 */
/**
 * Every supplement that already carries an approval record (approvedBy,
 * approvedAt or approvalEvidence). Pure. Before the approval rules deploy
 * (security review M2, 2026-11-15) no app wrote these fields, so the list is
 * expected to be EMPTY; anything on it was written by hand and a person
 * decides what to do with it (the invoice refuses any approval older than the
 * cutoff, but a planted future date with an owner's uid would pass).
 * @param {Array<{id: string, data: object}>} supplements
 * @returns {Array<{id, approvedBy, companyId, parentEstimateId}>}
 */
function approvalRecordsPresent(supplements) {
  return (supplements || []).filter((s) => {
    const d = (s && s.data) || {};
    return d.approvedBy != null || d.approvedAt != null || d.approvalEvidence != null;
  }).map((s) => ({ id: s.id, approvedBy: s.data.approvedBy || null, companyId: s.data.companyId || null, parentEstimateId: s.data.parentEstimateId || null }));
}

function planBackfill(supplements, estimatesById, authorCompanyById) {
  const authors = authorCompanyById || {};
  const updates = [];
  const problems = [];
  let already = 0;
  for (const s of supplements || []) {
    const d = (s && s.data) || {};
    if (typeof d.companyId === 'string' && d.companyId) { already++; continue; }
    const pid = d.parentEstimateId;
    const e = (pid && estimatesById) ? estimatesById[pid] : null;
    if (!e) { problems.push({ id: s.id, reason: 'parent estimate ' + (pid || '(none)') + ' not found' }); continue; }
    if (!(typeof e.companyId === 'string' && e.companyId)) {
      problems.push({ id: s.id, reason: 'parent estimate ' + pid + ' has no companyId' });
      continue;
    }
    const author = d.userId;
    const ownsEstimate = !!author && author === e.userId;
    if (!ownsEstimate && !(author && authors[author] && authors[author] === e.companyId)) {
      problems.push({ id: s.id, reason: 'author ' + (author || '(none)') + ' is not in the estimate company '
        + e.companyId + ' (author company: ' + ((author && authors[author]) || 'unknown') + ')' });
      continue;
    }
    if ((d.leadId || null) !== (e.leadId || null)) {
      problems.push({ id: s.id, reason: 'leadId ' + (d.leadId || '(none)') + ' is not the estimate lead ' + (e.leadId || '(none)') });
      continue;
    }
    updates.push({ id: s.id, companyId: e.companyId });
  }
  return { updates, skipped: { already }, problems };
}

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const YES = args.includes('--yes');
  const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
  if (APPLY && !YES) {
    console.error('Refusing to --apply without --yes. Re-run with: --apply --yes');
    process.exit(2);
  }
  const { initAdmin, getFirestore, getAuth } = require('./_admin');
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  console.log('Backfill supplements.companyId');
  console.log('  project : ' + PROJECT);
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)') + '\n');

  const PAGE = 500;
  const missing = [];
  const all = [];
  let scanned = 0, last = null;
  while (true) {
    let q = db.collection('supplements').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() || {};
      all.push({ id: doc.id, data });
      if (!(typeof data.companyId === 'string' && data.companyId)) missing.push({ id: doc.id, data });
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  const estimatesById = {};
  for (const pid of [...new Set(missing.map((s) => s.data.parentEstimateId).filter((x) => typeof x === 'string' && x))]) {
    const e = await db.collection('estimates').doc(pid).get();
    if (e.exists) estimatesById[pid] = e.data() || {};
  }
  // Each author's tenant, from their auth claims (the source of truth the
  // rules use). An author that cannot be read stays unknown → reported.
  const authorCompanyById = {};
  for (const uid of [...new Set(missing.map((s) => s.data.userId).filter((x) => typeof x === 'string' && x))]) {
    try {
      const u = await getAuth().getUser(uid);
      const cid = (u.customClaims && u.customClaims.companyId) || null;
      if (cid) authorCompanyById[uid] = cid;
    } catch (e) { /* unknown author: reported by planBackfill */ }
  }
  const plan = planBackfill(missing, estimatesById, authorCompanyById);

  console.log('  scanned          : ' + scanned);
  console.log('  missing companyId: ' + missing.length);
  console.log('  would stamp      : ' + plan.updates.length);
  console.log('  cannot place     : ' + plan.problems.length);
  plan.updates.slice(0, 50).forEach((u) => console.log('    ' + u.id + ' → companyId ' + u.companyId));
  plan.problems.forEach((p) => console.log('  ! ' + p.id + ': ' + p.reason));
  // Approval records already present (expected NONE before the approval rules deploy).
  const approvals = approvalRecordsPresent(all);
  console.log('\n  approval records already present: ' + approvals.length + ' (expected 0)');
  approvals.forEach((a) => console.log('  ? ' + a.id + ': approvedBy ' + (a.approvedBy || '(none)') + ', company ' + (a.companyId || '(none)') + ', estimate ' + (a.parentEstimateId || '(none)')));

  if (!APPLY) { console.log('\nDRY-RUN: nothing written. Re-run with --apply --yes to write.'); return; }
  let written = 0;
  for (let i = 0; i < plan.updates.length; i += 400) {
    const batch = db.batch();
    for (const u of plan.updates.slice(i, i + 400)) batch.update(db.collection('supplements').doc(u.id), { companyId: u.companyId });
    await batch.commit();
    written += Math.min(400, plan.updates.length - i);
  }
  console.log('\nWrote companyId on ' + written + ' supplement(s).');
}

module.exports = { planBackfill, approvalRecordsPresent };
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
