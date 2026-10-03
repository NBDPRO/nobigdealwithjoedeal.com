/**
 * functions/homeowner-progress.js — the homeowner portal's progress tracker.
 *
 * ONE owner for "where is this homeowner's job, in their words?" (2026-10-03
 * rebuild, 5 steps → 9). getHomeownerPortalView renders from it, and
 * submitCustomerRating gates on it, so the rating card a homeowner sees and
 * the gate that accepts their rating agree by construction — the 2026-09-08
 * lesson in functions/portal.js ("two gates for one invariant drift; now
 * there is one") carried forward.
 *
 * Why it was rebuilt: the old 5th step said "Complete — final walkthrough
 * done" and the rating + referral cards opened on final_photos, i.e. before
 * the homeowner had paid. The tracker now has a Final payment step, and the
 * review ask waits for paid in full.
 *
 * Pure: no Firestore, no clock. The caller hands in the lead and the
 * lead's invoices ALREADY filtered to the portal's tenant (portal-authz.js
 * recordInPortalTenant). tests/portal-progress-steps-2026-10-03.test.js
 * requires this module and runs it.
 */
'use strict';

const { roleFor } = require('./stage-roles');

// ═══════════════════════════════════════════════════════════════════════
// ALL CUSTOMER-FACING WORDING FOR THE TRACKER. Edit here, nowhere else.
// ═══════════════════════════════════════════════════════════════════════
// Rules every line must keep (tests/portal-progress-steps-2026-10-03.test.js
// scans this object):
//   * Kentucky insurance-job law: never say we handle / negotiate / manage a
//     claim, and say nothing about deductibles.
//   * Crews are independent subcontractors: "the crew" — never "our
//     employees", "our team", "in-house".
// Placeholders, filled per homeowner:
//   {rep}   → the rep's first name ("Joe"), filled on the server.
//   {date}  → the build day, filled in the homeowner's browser so the date is
//             in THEIR timezone (the function runs in UTC).
//   {done} / {total} → step counts.
// blurb     = what the step says once the job has reached it.
// upcoming  = what it says while it is the current step but not reached yet.
// paid      = the Final payment step once the job is paid in full.
const HOMEOWNER_PROGRESS_COPY = Object.freeze({
  steps: Object.freeze([
    Object.freeze({ key: 'inspection',  label: 'Inspection',        blurb: '{rep} has looked at your roof.', upcoming: '{rep} will come out and look at your roof.' }),
    Object.freeze({ key: 'estimate',    label: 'Estimate',          blurb: 'You have a written quote.' }),
    Object.freeze({ key: 'signed',      label: 'Signed',            blurb: 'You\'re signed. Next: getting you on the schedule.' }),
    Object.freeze({ key: 'scheduled',   label: 'Build day set',     blurb: 'Your build day: {date}.', upcoming: 'We\'ll confirm your build day soon.' }),
    Object.freeze({ key: 'build',       label: 'Build',             blurb: 'The crew is working on your home.' }),
    Object.freeze({ key: 'walkthrough', label: 'Final walkthrough', blurb: 'Done. {rep} walks the job with you and sends your final photos.' }),
    Object.freeze({ key: 'payment',     label: 'Final payment',     blurb: 'Your final invoice is ready.', paid: 'Paid in full — thank you.' }),
    Object.freeze({ key: 'warranty',    label: 'Warranty',          blurb: 'Your warranty paperwork is on file.' }),
    Object.freeze({ key: 'review',      label: 'Review',            blurb: 'How did we do?' }),
  ]),
  ui: Object.freeze({
    heading:      'Where we are',
    doneCount:    '{done} of {total} done',
    nextUp:       'Next up',
    showAll:      'See all {total} steps',
    payLink:      'Pay your invoice',
    warrantyLink: 'See your warranty',
    reviewLink:   'Leave a rating',
    allDone:      'All done — thank you for choosing us.',
    repFallback:  'Your rep',
  }),
});

const STEP_KEYS = HOMEOWNER_PROGRESS_COPY.steps.map((s) => s.key);
const IDX = Object.fromEntries(STEP_KEYS.map((k, i) => [k, i]));

// Every stage key in docs/pro/js/crm-stages.js `S` → a step. A test fails if
// crm-stages gains a key this map does not carry.
const STAGE_TO_STEP = Object.freeze({
  // Shared lead stages. new/contacted: the inspection hasn't happened yet.
  new: 'inspection', contacted: 'inspection', inspected: 'inspection',
  // Insurance track — collapses to Estimate once a number is on the table,
  // exactly as before. Nothing about the claim itself reaches the homeowner.
  claim_filed: 'inspection', adjuster_meeting_scheduled: 'inspection',
  adjuster_inspection_done: 'estimate', scope_received: 'estimate',
  estimate_submitted: 'estimate', supplement_requested: 'estimate',
  supplement_approved: 'estimate',
  // Cash / finance.
  estimate_sent_cash: 'estimate', negotiating: 'estimate',
  prequal_sent: 'estimate', loan_approved: 'estimate',
  // Signed, then the job phase. A signed job with a build date on the lead
  // moves up to 'scheduled' (see resolve below) — the date is the fact.
  contract_signed: 'signed', job_created: 'signed', permit_pulled: 'signed',
  materials_ordered: 'signed', materials_delivered: 'signed',
  crew_scheduled: 'scheduled', install_in_progress: 'build',
  install_complete: 'walkthrough', final_photos: 'walkthrough',
  // Money stages. Which of these counts as PAID is decided in resolve, from
  // the invoices as well as the stage.
  deductible_collected: 'payment', final_payment: 'payment',
  collections: 'payment', closed: 'payment', warranty_claim: 'payment',
  // Warranty / service tracks (their own front door, not a re-roof).
  warranty_scheduled: 'scheduled', warranty_repaired: 'walkthrough',
  service_quoted: 'estimate', service_approved: 'signed',
  // Lost: unchanged from the old tracker (it showed the first step).
  lost: 'inspection',
});

// Stages that mean "the final money is in" when no invoice still owes.
// final_payment is where an online payoff auto-advances the lead
// (stage-roles.js payoffAdvanceAllowed / invoice-pipeline markPaid).
const PAID_STAGES = new Set(['final_payment', 'closed', 'warranty_claim']);
// Pre-inspection: the Inspection step reads as upcoming.
const NOT_INSPECTED = new Set(['new', 'contacted']);

// Legacy raw display stages (crm-stages.js LEGACY_MAP + the stage-roles.js
// won/lost ALIASes), matched case-insensitively.
const LEGACY_STAGE = Object.freeze({
  'new': 'new', 'new lead': 'new', 'contacted': 'contacted', 'inspected': 'inspected',
  'estimate sent': 'estimate_submitted', 'negotiating': 'negotiating',
  'approved': 'contract_signed', 'in progress': 'install_in_progress',
  'complete': 'closed', 'closed won': 'closed', 'closed_won': 'closed', 'closed-won': 'closed',
  'won': 'closed', 'closed': 'closed',
  'lost': 'lost', 'closed lost': 'lost',
});

/** A built-in stage key for the lead, or null for a tenant custom stage. */
function stageKeyFor(lead) {
  const raw = String((lead && (lead._stageKey || lead.stage)) || 'new').trim();
  if (STAGE_TO_STEP[raw]) return raw;
  const lower = raw.toLowerCase();
  if (LEGACY_STAGE[lower]) return LEGACY_STAGE[lower];
  const snake = lower.replace(/\s+/g, '_');
  if (STAGE_TO_STEP[snake]) return snake;
  return null;
}

/** Does this invoice still have money owed on it? (one predicate: the
 *  portal's balance card and the tracker's payment step both use it) */
function invoiceOwes(inv) {
  return !!inv && Number(inv.balanceDue) > 0;
}

function _validYmd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function _repFirst(repName) {
  const first = String(repName || '').trim().split(/\s+/)[0] || '';
  return first && first.toLowerCase() !== 'your' ? first : HOMEOWNER_PROGRESS_COPY.ui.repFallback;
}

function _fill(text, repName) {
  return String(text || '').replace(/\{rep\}/g, _repFirst(repName));
}

/**
 * Where the job is, for the homeowner.
 *
 * @param {object} lead
 * @param {object} [opts]
 * @param {object[]} [opts.invoices]  the lead's invoices, tenant-filtered
 * @param {string}   [opts.repName]   rep display name, for {rep}
 * @returns {{currentKey, currentIndex, currentLabel, currentBlurb, pending,
 *            paidInFull, steps, doneCount, total, nextKey, nextLabel,
 *            paidLine, warrantyOnFile}}
 */
function resolveHomeownerProgress(lead, opts) {
  const o = opts || {};
  const invoices = Array.isArray(o.invoices) ? o.invoices : [];
  const L = lead || {};
  const key = stageKeyFor(L);
  const hasDate = _validYmd(L.scheduledDate);
  const warrantyOnFile = !!L.warranty;
  const rated = typeof L.customerRating === 'number' && L.customerRating > 0;

  let base;
  let paidStage = false;
  let notInspected = false;
  if (key) {
    base = STAGE_TO_STEP[key];
    paidStage = PAID_STAGES.has(key);
    notInspected = NOT_INSPECTED.has(key);
  } else {
    // Tenant CUSTOM stage — fall back by its persisted semantic role. A
    // custom WON stage keeps the 2026-09-08 behaviour (rateable when nothing
    // is owed); a custom JOB stage claims only "signed", never "the crew is
    // working", since the server cannot know which job stage it is.
    const role = roleFor(L);
    if (role === 'won') { base = 'payment'; paidStage = true; }
    else if (role === 'job') base = 'signed';
    else { base = 'inspection'; notInspected = role === 'new'; }
  }

  let current = base;
  let pending = false;
  let paidInFull = false;
  if (base === 'inspection') pending = notInspected;
  if (base === 'signed' && hasDate) current = 'scheduled';
  if (base === 'build') pending = true; // in progress, not done
  if (base === 'payment') {
    const owes = invoices.some(invoiceOwes);
    if (key === 'collections' || owes) {
      current = 'payment'; pending = true;
    } else if (paidStage) {
      paidInFull = true;
      current = 'review';
      pending = !rated;
    } else {
      // e.g. deductible_collected with no final invoice out yet: the money
      // step has not started, so the job is still at the walkthrough.
      current = 'walkthrough';
    }
  }

  const ci = IDX[current];
  const steps = HOMEOWNER_PROGRESS_COPY.steps.map((s, i) => {
    let state = i < ci ? 'done' : (i === ci ? 'current' : 'upcoming');
    // Warranty paperwork is not issued on every job (repairs, gutters). Once
    // the job is past it, a missing cert is skipped, not shown as done.
    if (s.key === 'warranty' && state === 'done' && !warrantyOnFile) state = 'skipped';
    return { key: s.key, label: s.label, state };
  });
  const total = steps.filter((s) => s.state !== 'skipped').length;
  const doneCount = steps.filter((s) => s.state === 'done').length + (pending ? 0 : 1);

  const step = HOMEOWNER_PROGRESS_COPY.steps[ci];
  let blurb = step.blurb;
  if (current === 'inspection' && pending) blurb = step.upcoming;
  if (current === 'scheduled' && !hasDate) blurb = step.upcoming;

  const next = HOMEOWNER_PROGRESS_COPY.steps[ci + 1] || null;
  return {
    currentKey: current,
    currentIndex: ci,
    currentLabel: step.label,
    currentBlurb: _fill(blurb, o.repName),
    pending,
    paidInFull,
    paidLine: paidInFull ? HOMEOWNER_PROGRESS_COPY.steps[IDX.payment].paid : null,
    warrantyOnFile,
    steps,
    doneCount,
    total,
    nextKey: next ? next.key : null,
    nextLabel: next ? next.label : null,
  };
}

/** Paid in full — the ONE gate for the rating card, the rating submit, and
 *  the refer-a-friend card. */
function paidInFullFor(lead, invoices) {
  return resolveHomeownerProgress(lead, { invoices }).paidInFull;
}

/**
 * When did each step first happen? Indexes lead.stageHistory ({from, to,
 * timestamp}, written by docs/pro/js/stage-write.js commitStageChange) by the
 * step each entry's destination stage maps to, keeping the EARLIEST
 * timestamp — a bounce-back must not overwrite the date a later step was
 * first reached. Custom-stage entries carry no role in history, so they are
 * skipped. Timestamps are ISO strings, so string comparison is chronological.
 */
function milestoneDatesFor(lead) {
  const dates = {};
  const history = Array.isArray(lead && lead.stageHistory) ? lead.stageHistory : [];
  for (const h of history) {
    if (!h || !h.to || typeof h.timestamp !== 'string') continue;
    const k = stageKeyFor({ stage: h.to });
    // new/contacted are BEFORE the inspection; dating it by them would show
    // the day the lead came in as the day the roof was looked at.
    const step = k && !NOT_INSPECTED.has(k) && STAGE_TO_STEP[k];
    if (!step) continue;
    if (!(step in dates) || h.timestamp < dates[step]) dates[step] = h.timestamp;
  }
  return dates;
}

module.exports = {
  HOMEOWNER_PROGRESS_COPY,
  STAGE_TO_STEP,
  LEGACY_STAGE,
  STEP_KEYS,
  stageKeyFor,
  invoiceOwes,
  resolveHomeownerProgress,
  paidInFullFor,
  milestoneDatesFor,
};
