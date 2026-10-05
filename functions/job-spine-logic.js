/**
 * job-spine-logic.js — the PURE rules of the event-driven job spine
 * (functions/job-spine.js does the Firestore I/O).
 *
 * The idea (2026-10-03): real-world events move a job forward on their own —
 * a contract signed remotely, a deposit or payoff recorded, an inspection
 * booked on Cal.com — instead of Jo dragging the kanban card after the fact.
 * Before this, the only automatic moves were the Stripe payoff (stripe.js →
 * Final Payment) and a first estimate bumping New → Contacted, and the two
 * payoff paths disagreed (client Mark Paid → Contract Signed, Stripe → Final
 * Payment).
 *
 * Rules, all enforced here so they are unit-testable without Firestore:
 *   - FORWARD ONLY. A move happens only when the target ranks strictly after
 *     the lead's current stage (STAGE_RANK). Never backwards.
 *   - A lost, closed, post-close (warranty_claim) or deleted lead is never
 *     touched.
 *   - A custom (tenant-defined) or unrecognised stage is never touched — the
 *     spine cannot know where it sits in the funnel. The caller logs it.
 *   - Paid in full additionally obeys stage-roles.js payoffAdvanceAllowed —
 *     the rule the Stripe webhook already used (main job track only).
 *   - A move writes exactly what the client's commitStageChange writes
 *     (docs/pro/js/stage-write.js): stage, stageRole, stageStartedAt,
 *     stageHistory, updatedAt, closedAt on entering a won stage (PR #2118's
 *     rule), a timeline note, and the stage-entry task (stage-checklist.js).
 *   - Internal only: nothing here sends to a customer. (The client also fires
 *     EmailDrip on a stage change; the spine deliberately does NOT.)
 *
 * The client's stage config (docs/pro/js/crm-stages.js) is an ES module the
 * functions runtime can't require — it isn't even deployed with functions/ —
 * so the pieces the spine needs (labels, legacy names, STAGE_ACTIONS,
 * preferredActionFor, the job-type inference) are ported below.
 * tests/job-spine-2026-10-03.test.js loads the REAL crm-stages.js and fails on
 * any drift, the same arrangement functions/stage-roles.js has with
 * tests/stage-roles.test.js. Roles come from stage-roles.js (not re-ported).
 */
'use strict';

const stageRoles = require('./stage-roles');
const { normJobType } = require('./ky-insurance-law');

// ── Built-in stage keys → label (crm-stages.js STAGE_META[k].label) ───────
const STAGE_LABELS = {
  new: 'New Lead', contacted: 'Contacted', inspected: 'Inspected',
  claim_filed: 'Claim Filed', adjuster_meeting_scheduled: 'Adjuster Mtg', adjuster_inspection_done: 'Adjuster Done',
  scope_received: 'Scope Received', estimate_submitted: 'Estimate Sent', supplement_requested: 'Supplement',
  supplement_approved: 'Supp. Approved',
  estimate_sent_cash: 'Est. Sent', negotiating: 'Negotiating',
  prequal_sent: 'Pre-Qual Sent', loan_approved: 'Loan Approved',
  contract_signed: 'Contract Signed',
  job_created: 'Job Created', permit_pulled: 'Permit', materials_ordered: 'Materials Ordered',
  materials_delivered: 'Materials Here', crew_scheduled: 'Crew Scheduled', install_in_progress: 'Installing',
  install_complete: 'Install Done', final_photos: 'Final Photos', deductible_collected: 'Deductible',
  final_payment: 'Final Payment', collections: 'Collections', closed: 'Closed', warranty_claim: 'Warranty Claim',
  warranty_scheduled: 'Warranty Visit', warranty_repaired: 'Repair Done',
  service_quoted: 'Service Quoted', service_approved: 'Service Approved',
  lost: 'Lost',
};

// crm-stages.js LEGACY_MAP — old display names still sitting on some leads
// (the Cal.com bridge itself writes 'New').
const LEGACY_MAP = {
  'New': 'new', 'New Lead': 'new', 'Inspected': 'inspected', 'Estimate Sent': 'estimate_submitted',
  'Approved': 'contract_signed', 'In Progress': 'install_in_progress', 'Complete': 'closed', 'Lost': 'lost',
  'Contacted': 'contacted', 'Negotiating': 'negotiating', 'Closed Won': 'closed', 'Closed Lost': 'lost',
};

/**
 * Raw stage value → built-in key, or null for a custom / unrecognised stage.
 * Same lookup order as crm-stages.js normalizeStage, except that it answers
 * null where the client falls back to 'new' — a stage the spine can't place
 * must be left alone, not treated as the start of the funnel.
 */
function normalizeStageKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'new';
  if (Object.prototype.hasOwnProperty.call(STAGE_LABELS, s)) return s;
  if (Object.prototype.hasOwnProperty.call(LEGACY_MAP, s)) return LEGACY_MAP[s];
  const lower = s.toLowerCase();
  for (const k of Object.keys(LEGACY_MAP)) if (k.toLowerCase() === lower) return LEGACY_MAP[k];
  const snake = s.replace(/\s+/g, '_').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(STAGE_LABELS, snake)) return snake;
  return null;
}

// ── Forward order ────────────────────────────────────────────────────────
// One global rank that every track's pipeline order (crm-stages.js
// stageOptionsForType) is non-decreasing in, so "forward" means the same
// thing whatever jobType a lead carries — or doesn't. Stages of different
// tracks that sit at the same point share a rank. One deliberate departure
// from VIEW_JOBS order: Collections (money still owed) ranks BEFORE Final
// Payment, so a payoff landing on a job in Collections moves it to Final
// Payment — the Stripe webhook has always done that (payoffAdvanceAllowed).
const STAGE_RANK = {
  new: 0, contacted: 10, inspected: 20,
  claim_filed: 30, adjuster_meeting_scheduled: 31, adjuster_inspection_done: 32, scope_received: 33,
  estimate_submitted: 34, supplement_requested: 35, supplement_approved: 36,
  estimate_sent_cash: 34, negotiating: 35,
  prequal_sent: 34, loan_approved: 35,
  service_quoted: 34, service_approved: 38,
  warranty_scheduled: 34, warranty_repaired: 38,
  contract_signed: 40,
  job_created: 50, permit_pulled: 51, materials_ordered: 52, materials_delivered: 53,
  crew_scheduled: 54, install_in_progress: 55,
  install_complete: 60, final_photos: 61, deductible_collected: 62, collections: 63, final_payment: 64,
  closed: 70, warranty_claim: 80,
  // lost is deliberately absent — a lost lead is never moved (and never a target).
};

// ── The event table ──────────────────────────────────────────────────────
// event → jobType → target stage key (null = this event doesn't move a lead
// of that type). jobType keys are the CRM's own (crm-stages.js JOB_TYPES):
// insurance / cash / finance / service (Jo's "repair" jobs) / warranty, and
// '' for a lead with no type yet — which only ever gets the SHARED stages,
// because a typeless lead's estimate stage is ambiguous (insurance
// estimate_submitted vs cash estimate_sent_cash).
const JOB_TYPE_KEYS = ['insurance', 'cash', 'finance', 'service', 'warranty', ''];
function row(insurance, cash, finance, service, warranty, unset) {
  return { insurance, cash, finance, service, warranty, '': unset };
}
const EVENT_TABLE = {
  // Recorded (marker + optional note) but moves nothing: a lead is born at New.
  lead_created:    row(null, null, null, null, null, null),
  // An inspection / appointment got booked → the homeowner has been reached.
  booked:          row('contacted', 'contacted', 'contacted', 'contacted', 'contacted', 'contacted'),
  inspected:       row('inspected', 'inspected', 'inspected', 'inspected', 'inspected', 'inspected'),
  // The estimate went to the homeowner. Finance has no estimate stage (its
  // track runs through the lender pre-qual), warranty has none at all.
  estimate_shared: row('estimate_submitted', 'estimate_sent_cash', null, 'service_quoted', null, null),
  // The homeowner said yes — a signed deal-room acceptance or a signed contract.
  deal_accepted:   row('contract_signed', 'contract_signed', 'contract_signed', 'service_approved', null, 'contract_signed'),
  contract_signed: row('contract_signed', 'contract_signed', 'contract_signed', 'service_approved', null, 'contract_signed'),
  // Deposit money landed (deposit-rule.js: due at signing) — at least signed.
  deposit_paid:    row('contract_signed', 'contract_signed', 'contract_signed', 'service_approved', null, 'contract_signed'),
  // The crew is on the calendar. The service track has no scheduling stage.
  scheduled:       row('crew_scheduled', 'crew_scheduled', 'crew_scheduled', null, null, 'crew_scheduled'),
  installed:       row('install_complete', 'install_complete', 'install_complete', 'install_complete', null, 'install_complete'),
  // Paid in full → Final Payment, main job track only (payoffAdvanceAllowed
  // refuses service/warranty — a paid repair is Jo's call to close; #2118's
  // "paid in full — not closed" task asks him).
  paid_in_full:    row('final_payment', 'final_payment', 'final_payment', null, null, 'final_payment'),
};
const EVENTS = Object.keys(EVENT_TABLE);

// Human wording for the timeline note: "Stage moved to "X" — <reason>".
const EVENT_LABELS = {
  lead_created: 'lead created', booked: 'appointment booked', inspected: 'inspection done',
  estimate_shared: 'estimate shared', deal_accepted: 'homeowner accepted the deal',
  contract_signed: 'contract signed', deposit_paid: 'deposit paid', scheduled: 'crew scheduled',
  installed: 'install complete', paid_in_full: 'paid in full',
};

// ── Job type ─────────────────────────────────────────────────────────────
const INSURANCE_STAGES = ['claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done', 'scope_received', 'supplement_requested', 'supplement_approved'];
const FINANCE_STAGES = ['prequal_sent', 'loan_approved'];
const CASH_STAGES = ['estimate_sent_cash', 'negotiating'];
/**
 * The lead's job type, as crm-stages.js inferJobType reads it: the stored
 * type (normalised), else the insurance / finance / stage signals. '' when
 * nothing says — inferJobType's null. A stored type outside the five is
 * treated as unset here (the client keeps it, but no table row exists).
 */
function jobTypeOf(lead) {
  if (!lead) return '';
  const jt = normJobType(lead.jobType);
  if (jt) return jt;
  if (String(lead.jobType || '').trim()) return '';
  if (lead.insCarrier || lead.insuranceCarrier || lead.claimNumber
      || lead.claimStatus === 'Filed' || lead.claimStatus === 'Approved') return 'insurance';
  if (lead.loanAmount || lead.softPullStatus || lead.preQualLink) return 'finance';
  const st = normalizeStageKey(lead.stage);
  if (INSURANCE_STAGES.includes(st)) return 'insurance';
  if (FINANCE_STAGES.includes(st)) return 'finance';
  if (CASH_STAGES.includes(st)) return 'cash';
  return '';
}

function isDeleted(lead) {
  return !!lead && (lead.deleted === true || !!lead.deletedAt);
}

/**
 * Decide what an event does to a lead. Pure.
 * → { action: 'move', from, fromKey, to, jobType }
 *   | { action: 'skip', reason, fromKey?, to?, jobType? }
 * reason ∈ unknown_event | no_lead | deleted | custom_stage | lost | closed |
 *          post_close | no_target | payoff_not_allowed | not_forward
 */
function planJobEvent(lead, event) {
  if (!Object.prototype.hasOwnProperty.call(EVENT_TABLE, event)) return { action: 'skip', reason: 'unknown_event' };
  if (!lead) return { action: 'skip', reason: 'no_lead' };
  if (isDeleted(lead)) return { action: 'skip', reason: 'deleted' };
  const fromKey = normalizeStageKey(lead.stage);
  const jobType = jobTypeOf(lead);
  if (fromKey === null) return { action: 'skip', reason: 'custom_stage', fromKey: null, jobType };
  if (fromKey === 'lost' || stageRoles.roleFor(Object.assign({}, lead, { _stageKey: fromKey })) === stageRoles.ROLE.LOST) {
    return { action: 'skip', reason: 'lost', fromKey, jobType };
  }
  if (fromKey === 'closed') return { action: 'skip', reason: 'closed', fromKey, jobType };
  if (fromKey === 'warranty_claim') return { action: 'skip', reason: 'post_close', fromKey, jobType };
  const to = EVENT_TABLE[event][jobType] || null;
  if (!to) return { action: 'skip', reason: 'no_target', fromKey, jobType };
  if (event === 'paid_in_full'
      && !stageRoles.payoffAdvanceAllowed(Object.assign({}, lead, { _stageKey: fromKey }))) {
    return { action: 'skip', reason: 'payoff_not_allowed', fromKey, to, jobType };
  }
  if (!(STAGE_RANK[to] > STAGE_RANK[fromKey])) return { action: 'skip', reason: 'not_forward', fromKey, to, jobType };
  return { action: 'move', from: lead.stage == null ? null : lead.stage, fromKey, to, jobType };
}

// closedAt on entering a won stage — PR #2118's rule (stage-roles.js
// needsClosedAt, mirrored by stage-write.js commitStageChange): stamp when the
// move lands on a WON stage unless the lead was already won with a close date.
// Uses #2118's helper once it's on main, so the two can never drift.
function _needsClosedAtLocal(lead, nextStage) {
  const sale = (l) => { const r = stageRoles.roleFor(l); return r === stageRoles.ROLE.WON || r === stageRoles.ROLE.JOB || stageRoles.normKey(l._stageKey || l.stage) === 'contract_signed'; };
  if (!sale({ stage: nextStage })) return false;
  if (!lead) return true;
  return !lead.closedAt || !sale(lead);
}
function needsClosedAt(lead, nextStage) {
  if (typeof stageRoles.needsClosedAt === 'function') return stageRoles.needsClosedAt(lead, nextStage);
  return _needsClosedAtLocal(lead, nextStage);
}

/**
 * The lead update for a planned move, minus the sentinels the caller owns
 * (`fv` supplies serverTimestamp/arrayUnion so this stays pure). Same fields
 * commitStageChange writes; `_stageKey` is rewritten only where an old Stripe
 * payoff persisted one (stage-roles.js reads `_stageKey || stage`, so a stale
 * copy would misclassify the lead after this move).
 */
function movePayload(lead, plan, ctx, fv) {
  const historyEvent = {
    from: plan.from, to: plan.to,
    timestamp: ctx.atIso, user: ctx.actor, event: ctx.event,
  };
  const p = {
    stage: plan.to,
    stageRole: stageRoles.roleFromKey(plan.to),
    updatedAt: fv.serverTimestamp(),
    stageStartedAt: fv.serverTimestamp(),
    stageHistory: fv.arrayUnion(historyEvent),
  };
  // Keep the comparison against the lead's real current stage key, not a
  // stale _stageKey (same normalisation planJobEvent used).
  if (needsClosedAt(Object.assign({}, lead, { _stageKey: plan.fromKey }), plan.to)) p.closedAt = fv.serverTimestamp();
  if (lead && Object.prototype.hasOwnProperty.call(lead, '_stageKey')) p._stageKey = plan.to;
  return { payload: p, historyEvent };
}

function stageLabel(key) { return STAGE_LABELS[key] || key; }

// ── Stage-entry task (port of stage-checklist.js + crm-stages.js) ────────
// crm-stages.js STAGE_ACTIONS (id / label / icon / kind / jobTypes only).
const A = (id, label, icon, kind, jobTypes) => (jobTypes ? { id, label, icon, kind, jobTypes } : { id, label, icon, kind });
const STAGE_ACTIONS = {
  new: [A('log_contact', 'Log Contact', '📞', 'action'), A('sched_inspect', 'Schedule Inspection', '📅', 'action')],
  contacted: [A('sched_inspect', 'Schedule Inspection', '📅', 'action'), A('photo_intake', 'Capture Photos', '📸', 'action')],
  inspected: [
    A('photo_report', 'Photo Report', '📸', 'doc'), A('inspect_report', 'Inspection Report', '📄', 'doc'),
    A('file_claim', 'File Claim', '📋', 'action', ['insurance']), A('send_estimate', 'Send Estimate', '💰', 'doc', ['cash']),
    A('send_prequal', 'Send Pre-Qual Link', '🏦', 'doc', ['finance']), A('send_quote', 'Send Service Quote', '💰', 'doc', ['service']),
    A('sched_warranty', 'Schedule Warranty Visit', '🛠️', 'action', ['warranty']),
  ],
  claim_filed: [A('log_adjuster', 'Log Adjuster Meeting', '📅', 'action', ['insurance'])],
  adjuster_meeting_scheduled: [A('mark_adj_done', 'Mark Adjuster Met', '✅', 'stage', ['insurance'])],
  adjuster_inspection_done: [A('upload_scope', 'Upload Scope', '📄', 'action', ['insurance'])],
  scope_received: [A('send_estimate', 'Send Estimate', '💰', 'doc', ['insurance'])],
  estimate_submitted: [A('request_supp', 'Request Supplement', '📝', 'action', ['insurance']), A('send_contract', 'Send Contract', '✍️', 'doc')],
  supplement_requested: [A('follow_supp', 'Follow Up Supplement', '📞', 'action', ['insurance'])],
  supplement_approved: [A('send_contract', 'Send Contract', '✍️', 'doc')],
  estimate_sent_cash: [A('follow_up', 'Follow Up', '📞', 'action', ['cash']), A('send_contract', 'Send Contract', '✍️', 'doc', ['cash'])],
  negotiating: [A('revise_estimate', 'Revise Estimate', '💰', 'doc', ['cash']), A('send_contract', 'Send Contract', '✍️', 'doc', ['cash'])],
  prequal_sent: [A('follow_lender', 'Follow Up with Lender', '🏦', 'action', ['finance'])],
  loan_approved: [A('send_contract', 'Send Contract', '✍️', 'doc', ['finance'])],
  contract_signed: [A('create_job', 'Create Job', '🏗️', 'stage'), A('collect_deposit', 'Collect Deposit', '💵', 'action')],
  job_created: [A('pull_permit', 'Pull Permit', '📜', 'doc'), A('order_materials', 'Order Materials', '📦', 'action')],
  permit_pulled: [A('mark_permit_filed', 'Mark Permit Filed', '✅', 'action'), A('order_materials', 'Order Materials', '📦', 'action')],
  materials_ordered: [A('confirm_delivery', 'Confirm Delivery', '🚚', 'action')],
  materials_delivered: [A('sched_crew', 'Schedule Crew', '👷', 'action')],
  crew_scheduled: [A('start_install', 'Start Install', '🔨', 'stage'), A('work_order', 'Work Order', '📋', 'doc')],
  install_in_progress: [A('progress_photos', 'Progress Photos', '📸', 'action'), A('change_order', 'Change Order', '📝', 'doc')],
  install_complete: [A('final_photos', 'Final Photos', '📸', 'action'), A('closeout', 'Close-Out Checklist', '✅', 'doc')],
  final_photos: [A('collect_deduct', 'Collect Deductible', '💵', 'action', ['insurance']), A('final_invoice', 'Final Invoice', '🧾', 'doc')],
  deductible_collected: [A('request_payment', 'Request Final Payment', '🏦', 'action')],
  final_payment: [A('warranty_cert', 'Warranty Certificate', '🏆', 'doc'), A('close_job', 'Close Job', '🎉', 'stage')],
  collections: [A('send_payment_reminder', 'Send Payment Reminder', '📧', 'action'), A('close_job', 'Close Job', '🎉', 'stage')],
  closed: [A('request_review', 'Request Review', '⭐', 'action'), A('file_warranty_claim', 'File Warranty Claim', '🛟', 'stage')],
  warranty_claim: [A('log_claim_visit', 'Log Claim Visit', '📝', 'action'), A('resolve_warranty_claim', 'Resolve Claim', '✅', 'stage')],
  warranty_scheduled: [A('log_diagnosis', 'Log Diagnosis', '🔍', 'action', ['warranty'])],
  warranty_repaired: [A('final_photos', 'Final Photos', '📸', 'action', ['warranty']), A('warranty_report', 'Warranty Service Report', '📄', 'doc', ['warranty'])],
  service_quoted: [A('follow_up', 'Follow Up', '📞', 'action', ['service'])],
  service_approved: [A('sched_crew', 'Schedule Crew', '👷', 'action', ['service'])],
};

// crm-stages.js actionsForStage / preferredActionFor.
function actionsForStage(stageKey, jobType) {
  const list = STAGE_ACTIONS[stageKey] || [];
  if (!jobType) return list.filter((a) => !a.jobTypes);
  return list.filter((a) => !a.jobTypes || a.jobTypes.includes(jobType));
}
function preferredActionFor(stageKey, jobType) {
  const actions = actionsForStage(stageKey, jobType);
  if (!actions.length) return null;
  return actions.find((a) => a.kind === 'doc' || a.kind === 'stage') || actions[0];
}

// Stages that never get a "what's next" task: a lost deal, and a closed job
// (its preferred action is File Warranty Claim — a reaction to a problem, not
// a next step). Every OTHER won stage does now get one (Final Invoice, Request
// Final Payment, Warranty Certificate, Close Job…) — same rule as
// stage-checklist.js since 2026-10-03.
function stageGetsTask(stageKey) {
  return !!stageKey && stageKey !== 'closed' && stageRoles.roleFromKey(stageKey) !== stageRoles.ROLE.LOST;
}

/**
 * The stage-entry task for a lead entering `stageKey` — same doc and the
 * same deterministic id stage-checklist.js onStageChange writes, so a
 * client move and a spine move to the same stage resolve to ONE task.
 * → { id, doc } (doc without createdAt — the caller stamps it) | null.
 */
function stageEntryTask(stageKey, jobType, todayYmd) {
  if (!stageGetsTask(stageKey)) return null;
  const action = preferredActionFor(stageKey, jobType || null);
  if (!action || !action.id) return null;
  const id = 'stage-' + String(stageKey).slice(0, 60) + '-' + String(action.id).slice(0, 60);
  const actionLabel = action.label || String(action.id).replace(/_/g, ' ');
  return {
    id,
    doc: {
      text: (action.icon ? action.icon + ' ' : '') + actionLabel,
      title: actionLabel,
      notes: 'Suggested when this lead moved to "' + stageLabel(stageKey) + '".',
      source: 'stage_entry',
      stageKey,
      actionId: action.id,
      actionKind: action.kind || '',
      dueDate: String(todayYmd || ''),
      done: false,
    },
  };
}

// ── The "Request Review" task (Jo, 2026-10-03) ─────────────────────────
// crm-stages.js lists Request Review as a CLOSED action, and Closed never
// gets a stage-entry task (stageGetsTask) — so nothing ever made one, and
// 0 of 36 won/paid jobs in prod were asked. The ask belongs at PAID IN FULL
// (functions/paid-in-full.js): job-spine.js makes this task when a payment
// leaves the job at Final Payment (or later) with nothing owed. One id per
// job, so a customer's next job a year on gets its own task, and a task the
// rep already finished is never reopened (create-only).
const REVIEW_TASK_ACTION = A('request_review', 'Request Review', '⭐', 'action');
function reviewTaskId(jobId) {
  const j = typeof jobId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(jobId) ? jobId : '';
  return 'stage-final_payment-' + REVIEW_TASK_ACTION.id + (j ? '-' + j : '');
}
function reviewRequestTask(jobId, todayYmd) {
  const a = REVIEW_TASK_ACTION;
  return {
    id: reviewTaskId(jobId),
    doc: {
      text: a.icon + ' ' + a.label,
      title: a.label,
      notes: 'Paid in full — ask for a Google review. The ask carries their referral link in the same message.',
      source: 'stage_entry',
      stageKey: 'final_payment',
      actionId: a.id,
      actionKind: a.kind,
      dueDate: String(todayYmd || ''),
      done: false,
    },
  };
}

// Today in Eastern time as YYYY-MM-DD — the business's local day (the client
// writes the rep's local day; a UTC date is a day early every US evening).
function todayYmdEt(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(nowMs));
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}

// ── Idempotency marker ───────────────────────────────────────────────────
// One doc per (leadId, event, sourceId) in job_events/ — created inside the
// same transaction as the move, so a retried trigger or webhook finds it and
// writes nothing. sourceId names the real-world thing (invoice id, booking
// uid, envelope id…); without one the event counts once per lead.
function _seg(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120); }
function markerId(leadId, event, sourceId) {
  return _seg(leadId) + '__' + _seg(event) + '__' + (_seg(sourceId) || 'once');
}

// Timeline note text — the client writes `Stage moved to "<label>"`
// (type 'stage_change'); the spine adds why, so the timeline says it moved
// itself.
function moveNoteText(toKey, event, detail) {
  return 'Stage moved to "' + stageLabel(toKey) + '" — automatic: ' + (EVENT_LABELS[event] || event)
    + (detail ? ' (' + String(detail).slice(0, 200) + ')' : '') + '.';
}

// Small, flat, bounded copy of the caller's meta for the marker doc.
function cleanMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const k of Object.keys(meta).slice(0, 20)) {
    const v = meta[k];
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 300);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// ── Caller helpers ───────────────────────────────────────────────────────
// document-generator.js FILED_FIELD_BY_DOC_TYPE — the lead's "filed" gate
// field stamped when a document of that type is signed (in person there;
// remotely via remote-signing.js now too).
const FILED_FIELD_BY_DOC_TYPE = { contract: 'contractFiledAt', certificate_of_completion: 'cocFiledAt' };

// An e-sign envelope is a rep-uploaded PDF with only a title — no document
// type. Treat it as the contract only when the title says so and nothing in
// it says it's a side document (a warranty registration, a change order, a
// completion certificate, a lien waiver, an addendum).
function envelopeIsContract(env) {
  const t = String((env && env.title) || '');
  if (!/\b(contract|agreement)\b/i.test(t)) return false;
  return !/\b(warranty|change[\s-]?order|completion|lien|waiver|addendum|amendment)\b/i.test(t);
}

function _cents(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; }
/**
 * The spine events one invoice write carries. before null = a new invoice.
 *   paid_in_full — status flipped to 'paid' on this write (any method: card
 *                  via the Stripe webhook, or cash / check / Zelle via Mark Paid).
 *   deposit_paid — depositPaid flipped true on a real deposit and the invoice
 *                  is NOT also paid off in the same write (paid in full wins).
 */
function invoiceEvents(before, after) {
  const b = before || {};
  if (!after || !after.leadId || after.deleted === true || after.status === 'void' || after.e2eTestData) return [];
  if (after.status === 'paid' && b.status !== 'paid') return ['paid_in_full'];
  if (after.depositPaid === true && b.depositPaid !== true && _cents(after.depositAmount) > 0
      && _cents(after.amountPaid) > 0) return ['deposit_paid'];
  return [];
}

// ── The sold package (2026-10-04, "knowing your numbers") ────────────────
// Which of the five packages a job was sold on was nowhere on the lead: the
// deal room kept acceptedTier, the estimate its selectedTier, and Reports
// could not say what sells. At a signing event the spine records it once as
// lead.soldTier — the homeowner's accepted pick first (this event's meta.tier
// for deal_accepted, then lead.acceptedTier), else the primary estimate's
// tier. Never overwrites a soldTier already set (a rep's manual pick on the
// customer page wins). Pure; the caller stamps soldTierAt.
const SOLD_TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
const SOLD_TIER_EVENTS = ['contract_signed', 'deal_accepted'];
function soldTierPatch(lead, event, meta, estimate) {
  if (SOLD_TIER_EVENTS.indexOf(event) === -1 || !lead || isDeleted(lead)) return null;
  if (SOLD_TIERS.indexOf(String(lead.soldTier || '').toLowerCase()) !== -1) return null;
  const cands = [
    [meta && meta.tier, 'deal_room'],
    [lead.acceptedTier, 'deal_room'],
    [estimate && estimate.deleted !== true ? (estimate.selectedTier || estimate.tier) : null, 'estimate'],
  ];
  for (let i = 0; i < cands.length; i++) {
    const t = String(cands[i][0] || '').toLowerCase();
    if (SOLD_TIERS.indexOf(t) !== -1) return { soldTier: t, soldTierSource: cands[i][1] };
  }
  return null;
}
// Does this event need the primary estimate read to decide? (Transaction
// reads must come before writes, so the caller asks first.)
function soldTierNeedsEstimate(lead, event, meta) {
  if (SOLD_TIER_EVENTS.indexOf(event) === -1 || !lead || isDeleted(lead)) return false;
  if (SOLD_TIERS.indexOf(String(lead.soldTier || '').toLowerCase()) !== -1) return false;
  const pick = String((meta && meta.tier) || lead.acceptedTier || '').toLowerCase();
  return SOLD_TIERS.indexOf(pick) === -1 && typeof lead.primaryEstimateId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(lead.primaryEstimateId);
}

/**
 * Did this lead write ENTER the given stage? before null = a new lead.
 * Legacy display names normalise first (normalizeStageKey), so "Install
 * Complete" → "install_complete" is not a fresh entry. A deleted lead never
 * enters anything. Used by install-final-invoice.js (2026-10-03): any write
 * that lands the lead on Install Done — the client's commitStageChange, a
 * bulk move, the spine's own 'installed' move — fires the final invoice.
 */
function enteredStage(before, after, key) {
  if (!after || isDeleted(after)) return false;
  const a = normalizeStageKey(after.stage);
  if (a !== key) return false;
  const b = before ? normalizeStageKey(before.stage) : null;
  return b !== key;
}

module.exports = {
  enteredStage,
  EVENTS, EVENT_TABLE, EVENT_LABELS, JOB_TYPE_KEYS, STAGE_RANK, STAGE_LABELS, LEGACY_MAP, STAGE_ACTIONS,
  FILED_FIELD_BY_DOC_TYPE, SOLD_TIERS,
  normalizeStageKey, jobTypeOf, isDeleted, planJobEvent, needsClosedAt, movePayload, stageLabel,
  actionsForStage, preferredActionFor, stageGetsTask, stageEntryTask, todayYmdEt, markerId, moveNoteText,
  cleanMeta, envelopeIsContract, invoiceEvents, soldTierPatch, soldTierNeedsEstimate, reviewTaskId, reviewRequestTask,
};
