/**
 * jobs-logic.js — pure rules for "a customer can have more than one job"
 * (Jo's live-CRM handoff 2026-09-30 #1; plan:
 * documentation/projects/CRM-JOBS-AND-MONEY-PAPER-PLAN-2026-09-30.md).
 *
 * The model: /leads/{leadId} stays the CUSTOMER (ids like
 * thumbtack_leads__… survive). Each piece of work is a JOB at
 * leads/{leadId}/jobs/{jobId}. The lead's `activeJobId` names the job its
 * legacy fields (stage, jobValue, scheduledDate, …) currently describe.
 *
 * PHASE 1 (this file + functions/jobs-mirror.js): every screen and writer
 * still uses the lead's own fields, so the lead is the source of truth and a
 * trigger MIRRORS those fields into the active job. The first job is created
 * on the lead's next write (or by scripts/backfill-lead-jobs.js). Nothing a
 * user sees changes.
 *
 * PHASE 2 flips the direction for the pipeline: one card per OPEN job (Jo,
 * J3: "two open job cards" when a second job starts before the first is paid
 * in full and closed), "＋ Add job", and the active job's fields mirrored back
 * onto the lead for every legacy reader.
 */
'use strict';

// The per-JOB fields. Everything else on a lead is about the CUSTOMER
// (name, phone, email, property data, notes, referral code, tags …).
const JOB_FIELDS = Object.freeze([
  // pipeline
  'stage', 'stageRole', 'stageStartedAt', 'stageHistory', 'closedAt', 'lostReason',
  // what the job is
  'jobType', 'subType', 'trades', 'jobValue', 'source', 'scopeOfWork', 'damageType',
  'primaryEstimateId', 'openWarrantyClaimId',
  // insurance claim
  'claimStatus', 'insCarrier', 'claimNumber', 'claimFiledBy', 'policyNumber', 'dateOfLoss',
  'carrierDecisionAt', 'estimateAmount', 'deductibleOrOwedByHO', 'supplementStatus',
  // finance
  'financeCompany', 'loanAmount', 'loanStatus', 'preQualLink',
  // schedule
  'scheduledDate', 'scheduledWeek', 'scheduledStart', 'scheduledEndDate', 'scheduledDurationMin',
  'adjusterMeetingDate', 'adjusterMeetingTime', 'crew',
  // paperwork
  'contractFiledAt', 'permitFiledAt', 'aobFiledAt', 'warrantyCertFiledAt', 'cocFiledAt',
]);

// The first job of every customer has a fixed id, so a retried trigger or a
// re-run backfill can never create it twice.
const FIRST_JOB_ID = 'j1';

// Firestore values compare by JSON: Timestamps carry {_seconds,_nanoseconds}
// (admin) or toMillis(); normalise both to millis so a round trip is a no-op.
function norm(v) {
  if (v === undefined) return null;
  if (v && typeof v.toMillis === 'function') return { __ms: v.toMillis() };
  if (v instanceof Date) return { __ms: v.getTime() };
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).sort().forEach((k) => { o[k] = norm(v[k]); });
    return o;
  }
  return v;
}
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** A short human title for a job, from what the lead says it is. */
function titleFor(lead) {
  const l = lead || {};
  const bits = [];
  if (l.subType) bits.push(String(l.subType).replace(/_/g, ' '));
  else if (l.jobType) bits.push(String(l.jobType).replace(/_/g, ' '));
  if (Array.isArray(l.trades) && l.trades.length) bits.push(l.trades.slice(0, 3).join(' + '));
  const t = bits.join(' · ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Job';
}

/** The job doc for a customer's FIRST job, built from the lead's fields. */
function firstJobFromLead(lead) {
  const l = lead || {};
  const job = {};
  JOB_FIELDS.forEach((f) => { if (l[f] !== undefined) job[f] = l[f]; });
  job.title = titleFor(l);
  job.property = {
    address: l.address || '',
    lat: Number.isFinite(l.lat) ? l.lat : null,
    lng: Number.isFinite(l.lng) ? l.lng : null,
  };
  job.companyId = l.companyId || null;
  job.userId = l.userId || null;
  job.createdAt = l.createdAt || null;
  job.origin = 'lead';
  return job;
}

/**
 * Mirror patch: the job fields whose value on the lead differs from the job.
 * A field the lead no longer has is cleared (null) on the job. → {} when in
 * sync, which is what makes the trigger's own writes a no-op.
 */
function mirrorPatch(lead, job) {
  const l = lead || {}, j = job || {};
  const patch = {};
  JOB_FIELDS.forEach((f) => {
    const lv = l[f] === undefined ? null : l[f];
    const jv = j[f] === undefined ? null : j[f];
    if (!same(lv, jv)) patch[f] = lv;
  });
  // Keep ownership in step (a lead reassigned to another rep).
  if (l.userId && l.userId !== j.userId) patch.userId = l.userId;
  if (l.companyId && l.companyId !== j.companyId) patch.companyId = l.companyId;
  return patch;
}

/**
 * Is this job still OPEN? Jo (J3, 2026-09-30): a job is done only when it is
 * closed out AND paid in full; a lost job is done too. `paidInFull` is set by
 * the invoice side (phase 2); until then a won-and-closed job without the flag
 * still counts as open, which errs toward showing its card.
 */
function isOpen(job) {
  const j = job || {};
  if (j.stageRole === 'lost') return false;
  const closed = String(j.stage || '').toLowerCase() === 'closed' || j.stageRole === 'won' && !!j.closedAt;
  return !(closed && j.paidInFull === true);
}

const msOf = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis()
  : (t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : (Date.parse(t) || 0)));

/**
 * Stage 2b: should the customer's card move to another job? Jo (J3): the
 * card shows the next job once the current one is closed out AND paid in
 * full (or lost). The ACTIVE job is judged on the LEAD's live fields (the
 * mirror may lag) plus the job's own paidInFull. → the job to promote (the
 * OLDEST open other job) or null.
 */
function pickPromotion(lead, jobs) {
  const l = lead || {};
  const list = (jobs || []).filter((j) => j && j.id);
  const active = list.find((j) => j.id === l.activeJobId);
  if (!active) return null;
  const effective = Object.assign({}, active);
  JOB_FIELDS.forEach((f) => { if (l[f] !== undefined) effective[f] = l[f]; });
  if (isOpen(effective)) return null;
  const open = list.filter((j) => j.id !== active.id && isOpen(j))
    .sort((a, b) => msOf(a.createdAt) - msOf(b.createdAt));
  return open[0] || null;
}

/**
 * The lead patch that makes `job` the active one: every per-job field set
 * from the job (null where the job has none, so the previous job's claim,
 * schedule etc. do not linger on the card) + activeJobId. The mirror then
 * finds lead and job equal and writes nothing.
 */
function promotionPatch(job) {
  const j = job || {};
  const patch = {};
  JOB_FIELDS.forEach((f) => { patch[f] = j[f] === undefined ? null : j[f]; });
  patch.activeJobId = j.id;
  return patch;
}

module.exports = { JOB_FIELDS, FIRST_JOB_ID, titleFor, firstJobFromLead, mirrorPatch, isOpen, same, pickPromotion, promotionPatch };
