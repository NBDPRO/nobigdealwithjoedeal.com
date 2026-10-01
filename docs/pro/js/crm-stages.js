/**
 * crm-stages.js — NBD PRO Unified Stage Configuration
 * Single source of truth for all CRM pipeline stages.
 *
 * Supports:
 *  - Insurance, Cash, Finance lead tracks
 *  - Post-contract Job pipeline
 *  - Backward compatibility with legacy 7-stage names
 *  - Kanban column generation (Simple vs Full Pipeline view)
 *  - Stage colors, labels, icons
 */

// ─────────────────────────────────────────────
// STAGE KEYS (internal identifiers — snake_case)
// ─────────────────────────────────────────────

export const S = {
  // ── Shared lead stages ──
  NEW:                'new',
  CONTACTED:          'contacted',
  INSPECTED:          'inspected',

  // ── Insurance track ──
  CLAIM_FILED:        'claim_filed',
  ADJUSTER_SCHEDULED: 'adjuster_meeting_scheduled',
  ADJUSTER_DONE:      'adjuster_inspection_done',
  SCOPE_RECEIVED:     'scope_received',
  ESTIMATE_SUBMITTED: 'estimate_submitted',
  SUPPLEMENT_REQ:     'supplement_requested',
  SUPPLEMENT_APPROVED:'supplement_approved',

  // ── Cash track ──
  ESTIMATE_SENT_CASH: 'estimate_sent_cash',
  NEGOTIATING:        'negotiating',

  // ── Finance track ──
  PREQUAL_SENT:       'prequal_sent',
  LOAN_APPROVED:      'loan_approved',

  // ── Convergence ──
  CONTRACT_SIGNED:    'contract_signed',

  // ── Job stages (post-contract) ──
  JOB_CREATED:        'job_created',
  PERMIT_PULLED:      'permit_pulled',
  MATERIALS_ORDERED:  'materials_ordered',
  MATERIALS_DELIVERED: 'materials_delivered',
  CREW_SCHEDULED:     'crew_scheduled',
  INSTALL_IN_PROGRESS:'install_in_progress',
  INSTALL_COMPLETE:   'install_complete',
  FINAL_PHOTOS:       'final_photos',
  DEDUCTIBLE_COLLECTED:'deductible_collected',
  FINAL_PAYMENT:      'final_payment',
  // 2026-09-15 (Collections foundation): a job that's done but the final
  // payment didn't land on FINAL_PAYMENT's timeline — was previously
  // nowhere to go except staying parked on final_payment or being dragged
  // straight to closed with money still owed, either way invisible as a
  // distinct "needs collecting" state. Role WON (Jo's call): the job is
  // sold and done, this doesn't change won-revenue accounting — it's an
  // ops queue layered on top, not a new revenue bucket.
  COLLECTIONS:        'collections',
  CLOSED:             'closed',
  // 2026-09-15 (Warranty Claim lane): a claim opened against a job of ANY
  // job type AFTER it's already closed (a leak found months later, a
  // workmanship callback, a manufacturer-defect shingle). Distinct from the
  // pre-existing "warranty" JOB TYPE/track below (WARRANTY_SCHEDULED/
  // WARRANTY_REPAIRED) — that track is the front door for a homeowner whose
  // ORIGINAL need was a warranty service call; this stage is a re-opening of
  // an already-finished job of any type. See warranty-claim.js for the
  // claim-document sub-workflow this stage triggers.
  WARRANTY_CLAIM:     'warranty_claim',

  // ── Warranty track ──
  WARRANTY_SCHEDULED: 'warranty_scheduled',
  WARRANTY_REPAIRED:  'warranty_repaired',

  // ── Service track ──
  SERVICE_QUOTED:     'service_quoted',
  SERVICE_APPROVED:   'service_approved',

  // ── Exit ──
  LOST:               'lost',
};

// ─────────────────────────────────────────────
// STAGE METADATA
// Each stage has: label, color, headerClass, track, type
// ─────────────────────────────────────────────

export const STAGE_META = {
  // ── Lead stages ──────────────────────────
  [S.NEW]:                { label: 'New Lead',           color: '#374151', headerClass: 'kh-new',       track: 'shared',    type: 'lead', icon: '🆕' },
  [S.CONTACTED]:          { label: 'Contacted',          color: '#2563eb', headerClass: 'kh-contacted', track: 'shared',    type: 'lead', icon: '📞' },
  [S.INSPECTED]:          { label: 'Inspected',          color: '#2d5a8e', headerClass: 'kh-insp',      track: 'shared',    type: 'lead', icon: '🔍' },

  [S.CLAIM_FILED]:        { label: 'Claim Filed',        color: '#7c3aed', headerClass: 'kh-claim',     track: 'insurance', type: 'lead', icon: '📋' },
  [S.ADJUSTER_SCHEDULED]: { label: 'Adjuster Mtg',       color: '#a855f7', headerClass: 'kh-adj',       track: 'insurance', type: 'lead', icon: '📅' },
  [S.ADJUSTER_DONE]:      { label: 'Adjuster Done',      color: '#8b5cf6', headerClass: 'kh-adjdone',   track: 'insurance', type: 'lead', icon: '✅' },
  [S.SCOPE_RECEIVED]:     { label: 'Scope Received',     color: '#d97706', headerClass: 'kh-scope',     track: 'insurance', type: 'lead', icon: '📄' },
  [S.ESTIMATE_SUBMITTED]: { label: 'Estimate Sent',      color: '#D4A017', headerClass: 'kh-est',       track: 'insurance', type: 'lead', icon: '💰' },
  [S.SUPPLEMENT_REQ]:     { label: 'Supplement',          color: '#ea580c', headerClass: 'kh-supp',      track: 'insurance', type: 'lead', icon: '📝' },
  [S.SUPPLEMENT_APPROVED]:{ label: 'Supp. Approved',      color: '#16a34a', headerClass: 'kh-suppok',    track: 'insurance', type: 'lead', icon: '✅' },

  [S.ESTIMATE_SENT_CASH]: { label: 'Est. Sent',          color: '#D4A017', headerClass: 'kh-est',       track: 'cash',      type: 'lead', icon: '💰' },
  [S.NEGOTIATING]:        { label: 'Negotiating',        color: '#ea580c', headerClass: 'kh-neg',       track: 'cash',      type: 'lead', icon: '🤝' },

  [S.PREQUAL_SENT]:       { label: 'Pre-Qual Sent',      color: '#0891b2', headerClass: 'kh-prequal',   track: 'finance',   type: 'lead', icon: '🏦' },
  [S.LOAN_APPROVED]:      { label: 'Loan Approved',      color: '#16a34a', headerClass: 'kh-loanok',    track: 'finance',   type: 'lead', icon: '✅' },

  [S.CONTRACT_SIGNED]:    { label: 'Contract Signed',    color: '#16a34a', headerClass: 'kh-contract',  track: 'shared',    type: 'lead', icon: '✍️' },

  // ── Job stages ───────────────────────────
  [S.JOB_CREATED]:        { label: 'Job Created',        color: '#0369a1', headerClass: 'kh-jobcr',     track: 'shared',    type: 'job',  icon: '🏗️' },
  [S.PERMIT_PULLED]:      { label: 'Permit',             color: '#4338ca', headerClass: 'kh-permit',    track: 'shared',    type: 'job',  icon: '📜' },
  [S.MATERIALS_ORDERED]:  { label: 'Materials Ordered',  color: '#b45309', headerClass: 'kh-matord',    track: 'shared',    type: 'job',  icon: '📦' },
  [S.MATERIALS_DELIVERED]:{ label: 'Materials Here',     color: '#a16207', headerClass: 'kh-matdel',    track: 'shared',    type: 'job',  icon: '🚚' },
  [S.CREW_SCHEDULED]:     { label: 'Crew Scheduled',     color: '#0d9488', headerClass: 'kh-crew',      track: 'shared',    type: 'job',  icon: '👷' },
  [S.INSTALL_IN_PROGRESS]:{ label: 'Installing',         color: '#059669', headerClass: 'kh-install',   track: 'shared',    type: 'job',  icon: '🔨' },
  [S.INSTALL_COMPLETE]:   { label: 'Install Done',       color: '#22c55e', headerClass: 'kh-instdone',  track: 'shared',    type: 'job',  icon: '✅' },
  [S.FINAL_PHOTOS]:       { label: 'Final Photos',       color: '#10b981', headerClass: 'kh-photos',    track: 'shared',    type: 'job',  icon: '📸' },
  [S.DEDUCTIBLE_COLLECTED]:{ label: 'Deductible',        color: '#14b8a6', headerClass: 'kh-deduct',    track: 'shared',    type: 'job',  icon: '💵' },
  [S.FINAL_PAYMENT]:      { label: 'Final Payment',      color: '#0d9488', headerClass: 'kh-finpay',    track: 'shared',    type: 'job',  icon: '🏦' },
  [S.COLLECTIONS]:        { label: 'Collections',        color: '#dc2626', headerClass: 'kh-collect',   track: 'shared',    type: 'job',  icon: '⏰' },
  [S.CLOSED]:             { label: 'Closed',             color: '#22C55E', headerClass: 'kh-closed',    track: 'shared',    type: 'job',  icon: '🏆' },
  [S.WARRANTY_CLAIM]:     { label: 'Warranty Claim',     color: '#c2410c', headerClass: 'kh-warrclaim', track: 'shared',    type: 'job',  icon: '🛟' },

  // ── Warranty stages ────────────────────────
  [S.WARRANTY_SCHEDULED]: { label: 'Warranty Visit',     color: '#0891b2', headerClass: 'kh-warrsch',   track: 'warranty',  type: 'lead', icon: '🛠️' },
  [S.WARRANTY_REPAIRED]:  { label: 'Repair Done',        color: '#16a34a', headerClass: 'kh-warrdone',  track: 'warranty',  type: 'lead', icon: '✅' },

  // ── Service stages ─────────────────────────
  [S.SERVICE_QUOTED]:     { label: 'Service Quoted',     color: '#D4A017', headerClass: 'kh-svqt',      track: 'service',   type: 'lead', icon: '💰' },
  [S.SERVICE_APPROVED]:   { label: 'Service Approved',   color: '#16a34a', headerClass: 'kh-svok',      track: 'service',   type: 'lead', icon: '✅' },

  // ── Exit ──
  [S.LOST]:               { label: 'Lost',               color: '#6b7280', headerClass: 'kh-lost',      track: 'shared',    type: 'lead', icon: '❌' },
};

// ─────────────────────────────────────────────
// LEGACY STAGE MAPPING
// Maps old 7-stage display names → new stage keys
// ─────────────────────────────────────────────

export const LEGACY_MAP = {
  'New':            S.NEW,
  'New Lead':       S.NEW,
  'Inspected':      S.INSPECTED,
  'Estimate Sent':  S.ESTIMATE_SUBMITTED,    // insurance default
  'Approved':       S.CONTRACT_SIGNED,
  'In Progress':    S.INSTALL_IN_PROGRESS,
  'Complete':       S.CLOSED,
  'Lost':           S.LOST,
  // Also handle old crm.js tag names
  'Contacted':      S.CONTACTED,
  'Negotiating':    S.NEGOTIATING,
  'Closed Won':     S.CLOSED,
  'Closed Lost':    S.LOST,
};

// Reverse: new stage key → closest legacy name (for backward compat)
export const REVERSE_LEGACY = {};
Object.entries(LEGACY_MAP).forEach(([legacy, key]) => {
  if (!REVERSE_LEGACY[key]) REVERSE_LEGACY[key] = legacy;
});

/**
 * Normalize any stage value (legacy display name or new key) → internal key
 */
export function normalizeStage(raw) {
  if (!raw) return S.NEW;
  const trimmed = raw.trim();
  // Already a valid key?
  if (STAGE_META[trimmed]) return trimmed;
  // Live tenant CUSTOM stage? resolvePipelineConfig writes custom_* keys onto
  // window.STAGE_META (a DIFFERENT object from the module-local default above),
  // so without this a custom key falls through to S.NEW — its leads then
  // mis-bucket into the New column while the custom column renders empty
  // (the #921 board bug). Guarded for the Node/test env where window is absent.
  if (typeof window !== 'undefined' && window.STAGE_META && window.STAGE_META[trimmed]) return trimmed;
  // Legacy display name?
  if (LEGACY_MAP[trimmed]) return LEGACY_MAP[trimmed];
  // Case-insensitive search
  const lower = trimmed.toLowerCase();
  for (const [legacy, key] of Object.entries(LEGACY_MAP)) {
    if (legacy.toLowerCase() === lower) return key;
  }
  // Snake_case match attempt
  const snake = trimmed.replace(/\s+/g, '_').toLowerCase();
  if (STAGE_META[snake]) return snake;
  // Fallback
  return S.NEW;
}

/**
 * Get display label for any stage
 */
export function stageLabel(stageKey) {
  const normalized = normalizeStage(stageKey);
  return STAGE_META[normalized]?.label || stageKey || 'New Lead';
}

/**
 * Get color for any stage
 */
export function stageColor(stageKey) {
  const normalized = normalizeStage(stageKey);
  return STAGE_META[normalized]?.color || '#374151';
}

// ─────────────────────────────────────────────
// SEMANTIC ROLE — the tenant-agnostic bucket each stage falls into.
// Foundation for freeform/custom pipelines: KPIs, revenue, referrals, the
// customer portal and server automations classify a lead by its ROLE
// (won / lost / active / job / new), NOT by matching a hardcoded stage-key
// list — so a tenant-invented stage "just works" once it declares a role.
// The mapping below is defined to EXACTLY reproduce the legacy WON_STAGES /
// LOST_STAGES behaviour that was copy-pasted across analytics-kpi / money-
// dashboard / dashboard-api / leaderboard / referral-rewards.
// ─────────────────────────────────────────────

export const ROLE = { NEW: 'new', ACTIVE: 'active', JOB: 'job', WON: 'won', LOST: 'lost' };

// WON = closed + the job-completion/paid stages (the legacy WON_STAGES set).
// JOB = post-contract, in-production stages that are NOT yet won.
const _ROLE_WON  = [S.CLOSED, S.INSTALL_COMPLETE, S.FINAL_PHOTOS, S.FINAL_PAYMENT, S.DEDUCTIBLE_COLLECTED, S.COLLECTIONS, S.WARRANTY_CLAIM];
const _ROLE_JOB  = [S.JOB_CREATED, S.PERMIT_PULLED, S.MATERIALS_ORDERED, S.MATERIALS_DELIVERED, S.CREW_SCHEDULED, S.INSTALL_IN_PROGRESS];
const _ROLE_LOST = [S.LOST];
const _ROLE_NEW  = [S.NEW];

/**
 * Semantic role for any stage value (legacy display name or new key).
 * Normalizes first, so 'Complete' / 'Closed Won' / etc. resolve correctly.
 */
export function stageRole(stageKey) {
  const k = normalizeStage(stageKey);
  if (_ROLE_WON.includes(k))  return ROLE.WON;
  if (_ROLE_LOST.includes(k)) return ROLE.LOST;
  if (_ROLE_JOB.includes(k))  return ROLE.JOB;
  if (_ROLE_NEW.includes(k))  return ROLE.NEW;
  return ROLE.ACTIVE;
}

export function isWonStage(stageKey)  { return stageRole(stageKey) === ROLE.WON; }
export function isLostStage(stageKey) { return stageRole(stageKey) === ROLE.LOST; }

// 2026-09-15 (Kanban filter unification) — the ONE canonical membership test
// for "is this a job stage," replacing ~9 independent hand-copied stage-key
// lists across the app (crm-pipeline.js x2, ask-joe-proactive.js,
// bottleneck-widget.js, money-dashboard.js, analytics-kpi.js, weekly-digest.js,
// two cosmetic label duplicates) that had already drifted out of sync with
// each other and with VIEW_JOBS within HOURS of the Collections stage being
// added — proof this class of duplication is a real, not hypothetical, risk.
//
// Jo's call (2026-09-15, after a live audit of the "click Jobs, almost
// nothing appears" report): CONTRACT_SIGNED counts as a job even though the
// rep hasn't clicked "Create Job" yet — a signed, materials-on-order deal
// IS a job to him, and the CRM's OWN revenue math already agreed (the
// pipeline-value/closed-revenue split in crm-pipeline.js has always treated
// contract_signed as converted/closed money, not in-play pipeline). Every
// stage from job_created through closed (VIEW_JOBS — role job or won) plus
// contract_signed itself is a job stage. A closed/paid job stays visible —
// no roll-off.
//
// Scope note: like stageRole() above, this classifies by BUILT-IN key only.
// A tenant's CUSTOM stage with a job/won role is not recognized here — the
// Jobs-tab filter has never been freeform-pipeline-aware, and making it so
// is a separate, larger change nobody has asked for yet. Callers that need
// custom-stage safety should check the lead's own persisted stageRole FIRST
// (the established hardcoded-fast-path + role-fallback pattern used
// elsewhere in this codebase) and fall back to isJobStage() only for the
// built-in case — see crm-pipeline.js's migrated closedKeys check for the
// worked example.
export function isJobStage(stageKey) {
  const k = normalizeStage(stageKey);
  return k === S.CONTRACT_SIGNED || VIEW_JOBS.includes(k);
}

// The terminal-stage counterpart (won OR lost — "decided, nothing left to
// do"), mirroring functions/stage-roles.js's server-side isDecided(). Same
// consolidation goal: ask-joe-proactive.js's _TERMINAL_STAGE_KEYS and
// bottleneck-widget.js's SKIP_STAGES were each their own hand-copied list.
export function isTerminalStage(stageKey) {
  const r = stageRole(stageKey);
  return r === ROLE.WON || r === ROLE.LOST;
}

// Stamp the role onto STAGE_META so the Phase-1 config resolver + builder UI
// can read/edit it as a first-class field (single derivation point).
Object.keys(STAGE_META).forEach(k => { STAGE_META[k].role = stageRole(k); });

// ─────────────────────────────────────────────
// KANBAN VIEW CONFIGURATIONS
// ─────────────────────────────────────────────

/**
 * SIMPLE view — backward compatible 7-column layout
 * Maps to the original STAGES array
 */
export const VIEW_SIMPLE = [
  S.NEW,
  S.INSPECTED,
  S.ESTIMATE_SUBMITTED,
  S.CONTRACT_SIGNED,
  S.INSTALL_IN_PROGRESS,
  S.CLOSED,
  S.LOST,
];

/**
 * INSURANCE PIPELINE — full insurance restoration workflow
 * This is the primary view for Jo's business
 */
export const VIEW_INSURANCE = [
  S.NEW,
  S.CONTACTED,
  S.INSPECTED,
  S.CLAIM_FILED,
  S.ADJUSTER_SCHEDULED,
  S.ADJUSTER_DONE,
  S.SCOPE_RECEIVED,
  S.ESTIMATE_SUBMITTED,
  S.SUPPLEMENT_REQ,
  S.SUPPLEMENT_APPROVED,
  S.CONTRACT_SIGNED,
  S.LOST,
];

/**
 * CASH PIPELINE
 */
export const VIEW_CASH = [
  S.NEW,
  S.CONTACTED,
  S.INSPECTED,
  S.ESTIMATE_SENT_CASH,
  S.NEGOTIATING,
  S.CONTRACT_SIGNED,
  S.LOST,
];

/**
 * FINANCE PIPELINE
 */
export const VIEW_FINANCE = [
  S.NEW,
  S.CONTACTED,
  S.INSPECTED,
  S.PREQUAL_SENT,
  S.LOAN_APPROVED,
  S.CONTRACT_SIGNED,
  S.LOST,
];

/**
 * WARRANTY PIPELINE — callbacks and post-install repairs
 * Skips claim/estimate/contract; goes straight from inspect → repair → closed.
 */
export const VIEW_WARRANTY = [
  S.NEW,
  S.CONTACTED,
  S.INSPECTED,
  S.WARRANTY_SCHEDULED,
  S.WARRANTY_REPAIRED,
  S.CLOSED,
  S.LOST,
];

/**
 * SERVICE PIPELINE — small one-off repair/maintenance jobs
 * Lightweight path: quote → approve → install → done (no claim, no supplements).
 */
export const VIEW_SERVICE = [
  S.NEW,
  S.CONTACTED,
  S.INSPECTED,
  S.SERVICE_QUOTED,
  S.SERVICE_APPROVED,
  S.INSTALL_IN_PROGRESS,
  S.INSTALL_COMPLETE,
  S.CLOSED,
  S.LOST,
];

/**
 * JOB BOARD — post-contract stages only
 */
export const VIEW_JOBS = [
  S.JOB_CREATED,
  S.PERMIT_PULLED,
  S.MATERIALS_ORDERED,
  S.MATERIALS_DELIVERED,
  S.CREW_SCHEDULED,
  S.INSTALL_IN_PROGRESS,
  S.INSTALL_COMPLETE,
  S.FINAL_PHOTOS,
  S.DEDUCTIBLE_COLLECTED,
  S.FINAL_PAYMENT,
  S.COLLECTIONS,
  S.CLOSED,
  // 2026-09-15 (Warranty Claim lane): appended, not inserted before CLOSED —
  // order here is the Jobs-tab column order (via VIEW_JOBS_BOARD below) and
  // a claim is chronologically AFTER the job closed. isJobStage()/isTerminalStage()
  // and resolveColumn()'s job-stage collapse all key off membership, not
  // position, so appending is safe for those two consumers; stageOptionsForType's
  // splice (below) just gains one more trailing dropdown option.
  S.WARRANTY_CLAIM,
];

// 2026-09-15 (Kanban filter unification) — the JOBS TAB's actual column
// list, distinct from VIEW_JOBS itself. VIEW_JOBS stays exactly as it was
// (post-Create-Job stages only) because two other consumers depend on that
// exact scope and must NOT see contract_signed added to it:
//   - stageOptionsForType() splices VIEW_JOBS in AFTER whatever
//     contract_signed entry the per-track view (VIEW_INSURANCE/CASH/
//     FINANCE) already contributed — adding contract_signed to VIEW_JOBS
//     too would duplicate that dropdown option.
//   - resolveColumn()'s job-stage collapse branch checks
//     `VIEW_JOBS.includes(normalized)` to decide whether a STRICTLY
//     post-contract stage needs collapsing into Closed/Installing under a
//     narrower view — contract_signed never needs that collapse, because
//     it already has its own real column in every per-track view.
// VIEW_JOBS_BOARD is a separate, wider list built ONLY for what a rep sees
// under the "Jobs" tab (Jo's call: a signed deal is a job to him, even
// before "Create Job" is clicked) — contract_signed gets its own leading
// column here instead of falling into resolveColumn's viewStages[0]
// fallback (an accident of "nothing else matched," not a real column).
export const VIEW_JOBS_BOARD = [S.CONTRACT_SIGNED, ...VIEW_JOBS];

/**
 * ALL VIEWS — for the view switcher dropdown
 */
export const KANBAN_VIEWS = {
  simple:    { label: 'Simple',              stages: VIEW_SIMPLE },
  insurance: { label: 'Insurance Pipeline',  stages: VIEW_INSURANCE },
  cash:      { label: 'Cash Pipeline',       stages: VIEW_CASH },
  finance:   { label: 'Finance Pipeline',    stages: VIEW_FINANCE },
  warranty:  { label: 'Warranty Pipeline',   stages: VIEW_WARRANTY },
  service:   { label: 'Service Pipeline',    stages: VIEW_SERVICE },
  jobs:      { label: 'Job Board',           stages: VIEW_JOBS_BOARD },
};

/**
 * Map a lead to its appropriate kanban column given the current view.
 * If the lead's stage doesn't match any visible column, finds the closest match.
 */
export function resolveColumn(stageKey, viewStages) {
  const normalized = normalizeStage(stageKey);
  // Direct match — the stage has its own visible column (incl. the full
  // Insurance view, where every sub-stage below is present).
  if (viewStages.includes(normalized)) return normalized;

  // ── Insurance sub-stages → nearest visible "parent" column ──────────────
  // A coarse view (Simple) hides the fine-grained adjuster/supplement columns.
  // Each insurance sub-stage collapses LEFT toward an earlier column; the chain
  // is WALKED (not a single hop) so that when a sub-stage's immediate parent is
  // ALSO hidden — the Simple view has neither an Adjuster nor a Supplement
  // column — the lead still lands on a sensible mid-pipeline column instead of
  // falling through to New. (#981 follow-up: adjuster_inspection_done /
  // supplement_requested / supplement_approved all bucketed into New because
  // the old single-hop group map gave up when the parent column was missing.)
  const INSURANCE_COLLAPSE = {
    [S.CLAIM_FILED]:         S.INSPECTED,
    [S.ADJUSTER_SCHEDULED]:  S.INSPECTED,
    [S.ADJUSTER_DONE]:       S.ADJUSTER_SCHEDULED,   // group with the Adjuster column
    [S.SCOPE_RECEIVED]:      S.ESTIMATE_SUBMITTED,
    [S.SUPPLEMENT_REQ]:      S.ESTIMATE_SUBMITTED,
    [S.SUPPLEMENT_APPROVED]: S.SUPPLEMENT_REQ,        // group with the Supplement column
  };
  if (INSURANCE_COLLAPSE[normalized]) {
    let hop = normalized;
    const seen = new Set();
    while (INSURANCE_COLLAPSE[hop] && !seen.has(hop)) {
      seen.add(hop);
      hop = INSURANCE_COLLAPSE[hop];
      if (viewStages.includes(hop)) return hop;
    }
    // whole chain hidden → fall through to the generic logic below
  }

  // ── Job stages → Closed (won/completed) or Installing (in-production) ────
  // Check Closed FIRST: the Simple view shows BOTH the Installing and Closed
  // columns, and if the Installing branch ran first it would greedily grab
  // EVERY job stage — mislabeling won deals (install_complete … final_payment)
  // as "Installing". _ROLE_WON is exactly the completion set. (Before this
  // reorder the Closed branch sat after the Installing branch and was dead in
  // every view that has an Installing column.)
  if (VIEW_JOBS.includes(normalized)) {
    if (_ROLE_WON.includes(normalized) && viewStages.includes(S.CLOSED)) return S.CLOSED;
    if (viewStages.includes(S.INSTALL_IN_PROGRESS)) return S.INSTALL_IN_PROGRESS;
    return viewStages[viewStages.length - 2] || viewStages[0]; // second to last (before Lost)
  }

  // ── Cross-track collapse for the cash / finance tracks ──────────────────
  if (normalized === S.CONTACTED && !viewStages.includes(S.CONTACTED)) return S.NEW;
  if (normalized === S.ESTIMATE_SENT_CASH && viewStages.includes(S.ESTIMATE_SUBMITTED)) return S.ESTIMATE_SUBMITTED;
  if (normalized === S.NEGOTIATING && viewStages.includes(S.ESTIMATE_SUBMITTED)) return S.ESTIMATE_SUBMITTED;
  if (normalized === S.PREQUAL_SENT && viewStages.includes(S.ESTIMATE_SUBMITTED)) return S.ESTIMATE_SUBMITTED;
  if (normalized === S.LOAN_APPROVED && viewStages.includes(S.CONTRACT_SIGNED)) return S.CONTRACT_SIGNED;

  // Fallback: first column
  return viewStages[0];
}

/**
 * partitionLeadsByColumn — split a lead list into the kanban's visible columns
 * plus the leftover leads that have NO column to live in.
 *
 * A lead has no column when its OWN stage is flagged `hidden` (the Pipelines
 * builder eye-toggle): buildKanbanColumns drops hidden stages from the view, so
 * resolveColumn would otherwise fall through to viewStages[0] and silently
 * rebucket the lead into the first column — mislabeling it, inflating that
 * column's count/$ badges, and letting a drag re-stage it. We keep those leads
 * OUT of the columns (stage field untouched) and return them in `hidden` so the
 * board can surface them via a "N leads on hidden stages" chip instead of
 * silently dropping them from the board's counts + $ totals. (#921 QA follow-up.)
 *
 * Pure + DOM-free. `stageMeta` / `normalize` / `resolve` are injected so the
 * browser drives it with the live tenant config (window.STAGE_META etc.) while
 * tests drive it with a resolved config — one code path, no drift between the
 * board's bucketing and the chip's count.
 *
 * @param {Array} leads       the (already view-narrowed) leads to bucket
 * @param {Array} viewStages  the visible column stage keys (hidden already removed)
 * @param {Object} [opts]     { stageMeta, normalize, resolve } overrides
 * @returns {{columns: Object, hidden: Array}}
 */
export function partitionLeadsByColumn(leads, viewStages, opts) {
  opts = opts || {};
  const meta    = opts.stageMeta || (typeof window !== 'undefined' && window.STAGE_META) || STAGE_META;
  const norm    = opts.normalize || normalizeStage;
  // Accept either `resolve` or `resolveColumn` for the injected resolver.
  const resolve = opts.resolve || opts.resolveColumn || resolveColumn;
  const stages  = Array.isArray(viewStages) ? viewStages : [];
  const columns = {};
  stages.forEach(k => { columns[k] = []; });
  const hidden = [];
  (leads || []).forEach(l => {
    if (!l) return;
    // Prefer the pre-stamped _stageKey (dashboard-bootstrap re-derives it when a
    // custom config applies), else normalize the raw stage.
    const sk = l._stageKey || norm(l.stage);
    const hk = norm(sk);
    if (meta[hk] && meta[hk].hidden) { hidden.push(l); return; }
    const col = resolve(sk, stages);
    if (columns[col]) columns[col].push(l);
    else if (stages.length && columns[stages[0]]) columns[stages[0]].push(l);
  });
  return { columns, hidden };
}

/**
 * Get ordered stage options for a dropdown/select, given a job type.
 * Returns array of { value, label } objects.
 */
export function stageOptionsForType(jobType) {
  let stages;
  let appendJobs = true;
  switch (jobType) {
    case 'insurance': stages = [...VIEW_INSURANCE]; break;
    case 'cash':      stages = [...VIEW_CASH]; break;
    case 'finance':   stages = [...VIEW_FINANCE]; break;
    case 'warranty':  stages = [...VIEW_WARRANTY]; appendJobs = false; break;
    case 'service':   stages = [...VIEW_SERVICE];  appendJobs = false; break;
    default:          stages = [...VIEW_INSURANCE]; break; // default to insurance
  }
  // Add job stages after contract_signed for tracks that converge there
  if (appendJobs) {
    const jobIdx = stages.indexOf(S.CONTRACT_SIGNED);
    if (jobIdx !== -1) {
      stages.splice(jobIdx + 1, 0, ...VIEW_JOBS);
    }
  }
  return stages.map(key => ({
    value: key,
    label: STAGE_META[key]?.label || key,
  }));
}

// ─────────────────────────────────────────────
// JOB TYPE DETECTION
// ─────────────────────────────────────────────

export const JOB_TYPES = {
  INSURANCE: 'insurance',
  CASH: 'cash',
  FINANCE: 'finance',
  WARRANTY: 'warranty',
  SERVICE: 'service',
};

/**
 * Metadata for each job type — drives labels, icons, default behaviors.
 */
export const JOB_TYPE_META = {
  insurance: { label: 'Insurance',  icon: '📋', color: '#7c3aed', description: 'Claim-based restoration paid by the carrier' },
  cash:      { label: 'Cash',       icon: '💵', color: '#16a34a', description: 'Homeowner pays out of pocket' },
  finance:   { label: 'Finance',    icon: '🏦', color: '#0891b2', description: 'Job funded through a lender' },
  warranty:  { label: 'Warranty',   icon: '🛠️', color: '#0369a1', description: 'Callback or service under existing warranty' },
  service:   { label: 'Service',    icon: '🔧', color: '#ea580c', description: 'Small repair or maintenance, not a full replacement' },
};

export function jobTypeLabel(jobType) {
  return JOB_TYPE_META[jobType]?.label || jobType || 'Unset';
}

/**
 * Infer job type from a lead's data
 */
export function inferJobType(lead) {
  // Through the shared normalizer (ky-insurance-law.js normJobType): one job
  // was stored as 'Insurance', which matched none of the lowercase checks.
  const K = (typeof window !== 'undefined') ? window.NBDJurisdiction : null;
  // A type outside the five known ones is still returned (lowercased), as before.
  const raw = String(lead.jobType || '').trim().toLowerCase();
  const jt = ((K && typeof K.normJobType === 'function') ? K.normJobType(raw) : '') || raw;
  if (jt) return jt;
  // Check insurance indicators
  if (lead.insCarrier || lead.insuranceCarrier || lead.claimNumber ||
      lead.claimStatus === 'Filed' || lead.claimStatus === 'Approved') {
    return JOB_TYPES.INSURANCE;
  }
  // Check finance indicators
  if (lead.loanAmount || lead.softPullStatus || lead.preQualLink) {
    return JOB_TYPES.FINANCE;
  }
  // Check stage-based inference
  const stage = normalizeStage(lead.stage);
  const insuranceStages = [S.CLAIM_FILED, S.ADJUSTER_SCHEDULED, S.ADJUSTER_DONE, S.SCOPE_RECEIVED, S.SUPPLEMENT_REQ, S.SUPPLEMENT_APPROVED];
  if (insuranceStages.includes(stage)) return JOB_TYPES.INSURANCE;
  const financeStages = [S.PREQUAL_SENT, S.LOAN_APPROVED];
  if (financeStages.includes(stage)) return JOB_TYPES.FINANCE;
  const cashStages = [S.ESTIMATE_SENT_CASH, S.NEGOTIATING];
  if (cashStages.includes(stage)) return JOB_TYPES.CASH;
  // Default — insurance (most common for NBD)
  return null;
}

// ─────────────────────────────────────────────
// TAG CLASS (backward compat for CSS)
// ─────────────────────────────────────────────

export function tagClass(stageKey) {
  const normalized = normalizeStage(stageKey);
  const meta = STAGE_META[normalized];
  if (!meta) return 'tag-new';
  return `tag-${normalized.replace(/_/g, '-')}`;
}

// ─────────────────────────────────────────────
// SUB-TYPES
// Optional second-level classification per job type.
// Drives template variant selection (e.g., storm AOB vs fire AOB,
// GreenSky terms vs in-house terms) and reporting cuts.
// ─────────────────────────────────────────────

export const SUB_TYPES = {
  insurance: [
    { value: 'storm_hail',  label: 'Storm — Hail' },
    { value: 'storm_wind',  label: 'Storm — Wind' },
    { value: 'storm_combo', label: 'Storm — Hail & Wind' },
    { value: 'fire',        label: 'Fire' },
    { value: 'water',       label: 'Water / Leak' },
    { value: 'other',       label: 'Other' },
  ],
  cash: [
    { value: 'full_replace', label: 'Full Replacement' },
    { value: 'partial',      label: 'Partial Replacement' },
    { value: 'repair',       label: 'Repair' },
  ],
  finance: [
    { value: 'third_party',  label: 'Third-Party Lender' },
    { value: 'in_house',     label: 'In-House Financing' },
  ],
  warranty: [
    { value: 'workmanship',  label: 'Workmanship' },
    { value: 'material',     label: 'Material Defect' },
    { value: 'manufacturer', label: 'Manufacturer Claim' },
    { value: 'goodwill',     label: 'Goodwill / Out of Warranty' },
  ],
  service: [
    { value: 'repair',       label: 'Repair' },
    { value: 'maintenance',  label: 'Maintenance' },
    { value: 'inspection',   label: 'Inspection Only' },
  ],
};

export function subTypeOptionsFor(jobType) {
  return SUB_TYPES[jobType] || [];
}

export function subTypeLabel(jobType, value) {
  return SUB_TYPES[jobType]?.find(s => s.value === value)?.label || value || '';
}

// ─────────────────────────────────────────────
// WARRANTY CLAIM — a claim document's OWN status sub-workflow.
// Separate from the lead's `stage` (S.WARRANTY_CLAIM handles the LEAD side
// above — one board column, one hard gate on re-entering S.CLOSED). This is
// the finer-grained state machine for the claim doc itself
// (leads/{leadId}/warrantyClaims/{claimId}), never written through
// commitStageChange() — see warranty-claim.js's advanceClaimStatus().
// reason reuses SUB_TYPES.warranty (workmanship/material/manufacturer/
// goodwill) rather than inventing a parallel list.
// ─────────────────────────────────────────────

export const CLAIM_STATUSES = ['open', 'scheduled', 'repaired', 'resolved', 'denied'];

export const CLAIM_STATUS_ACTIONS = {
  open:      [{ id: 'schedule_claim_visit', label: 'Schedule Visit',  icon: '📅', kind: 'action' }],
  scheduled: [{ id: 'log_claim_visit',      label: 'Log Diagnosis',  icon: '🔍', kind: 'action' }],
  repaired:  [{ id: 'resolve_claim',        label: 'Mark Resolved',  icon: '✅', kind: 'stage' }],
  resolved:  [],
  denied:    [],
};

export function preferredActionForClaim(status) {
  const actions = CLAIM_STATUS_ACTIONS[status] || [];
  if (!actions.length) return null;
  return actions.find(a => a.kind === 'stage') || actions[0];
}

// Required claim-doc fields per DESTINATION status. Mirrors
// missingRequiredFields()'s shape below but is intentionally a SEPARATE
// function over a separate object — this gates the claim doc, never the
// lead, and must never be merged into REQUIRED_FIELDS_BY_TYPE/
// missingRequiredFields (those two stay lead-only).
export const REQUIRED_FIELDS_BY_CLAIM_STATUS = {
  scheduled: ['scheduledDate'],
  resolved:  ['resolutionNotes'],
};

export function missingClaimFields(claim, newStatus) {
  const required = REQUIRED_FIELDS_BY_CLAIM_STATUS[newStatus] || [];
  return required.filter(f => {
    const v = claim && claim[f];
    return v === undefined || v === null || v === '';
  });
}

// ─────────────────────────────────────────────
// TRADES — multi-select, orthogonal to job type
// Drives estimate template, crew assignment, material list.
// Stored on a lead as `lead.trades` (array of values).
// ─────────────────────────────────────────────

export const TRADES = [
  { value: 'roof',      label: 'Roof',            icon: '🏠' },
  { value: 'gutters',   label: 'Gutters',         icon: '🌧️' },
  { value: 'siding',    label: 'Siding',          icon: '🧱' },
  { value: 'windows',   label: 'Windows',         icon: '🪟' },
  { value: 'fascia',    label: 'Fascia / Soffit', icon: '🔲' },
  { value: 'paint',     label: 'Paint',           icon: '🎨' },
  { value: 'skylights', label: 'Skylights',       icon: '☀️' },
  { value: 'other',     label: 'Other',           icon: '🔧' },
];

export function tradeLabel(value) {
  return TRADES.find(t => t.value === value)?.label || value || '';
}

export function tradesLabel(values) {
  if (!Array.isArray(values) || values.length === 0) return '';
  return values.map(tradeLabel).join(', ');
}

// ─────────────────────────────────────────────
// STAGE ACTIONS — context-aware "what to do next"
// For each stage, list the actions/docs that make sense right now.
// `kind` = 'doc' (generates a document), 'stage' (advances pipeline),
// 'action' (other workflow step).
// `jobTypes` is an optional whitelist; omitted means all types.
// Consumed by the Next Actions panel in Phase 2.
// ─────────────────────────────────────────────

export const STAGE_ACTIONS = {
  [S.NEW]: [
    { id: 'log_contact',     label: 'Log Contact',             icon: '📞',  kind: 'action' },
    { id: 'sched_inspect',   label: 'Schedule Inspection',     icon: '📅',  kind: 'action' },
  ],
  [S.CONTACTED]: [
    { id: 'sched_inspect',   label: 'Schedule Inspection',     icon: '📅',  kind: 'action' },
    { id: 'photo_intake',    label: 'Capture Photos',          icon: '📸',  kind: 'action' },
  ],
  [S.INSPECTED]: [
    { id: 'photo_report',    label: 'Photo Report',            icon: '📸',  kind: 'doc' },
    { id: 'inspect_report',  label: 'Inspection Report',       icon: '📄',  kind: 'doc' },
    { id: 'file_claim',      label: 'File Claim',              icon: '📋',  kind: 'action', jobTypes: ['insurance'] },
    // (The Send AOB chip — briefly a Direction to Pay — was retired
    // 2026-09-27: no assignment or co-payee paperwork in any state.)
    { id: 'send_estimate',   label: 'Send Estimate',           icon: '💰',  kind: 'doc',    jobTypes: ['cash'] },
    { id: 'send_prequal',    label: 'Send Pre-Qual Link',      icon: '🏦',  kind: 'doc',    jobTypes: ['finance'] },
    { id: 'send_quote',      label: 'Send Service Quote',      icon: '💰',  kind: 'doc',    jobTypes: ['service'] },
    { id: 'sched_warranty',  label: 'Schedule Warranty Visit', icon: '🛠️', kind: 'action', jobTypes: ['warranty'] },
  ],
  [S.CLAIM_FILED]: [
    { id: 'log_adjuster',    label: 'Log Adjuster Meeting',    icon: '📅',  kind: 'action', jobTypes: ['insurance'] },
  ],
  [S.ADJUSTER_SCHEDULED]: [
    { id: 'mark_adj_done',   label: 'Mark Adjuster Met',       icon: '✅',  kind: 'stage',  jobTypes: ['insurance'] },
  ],
  [S.ADJUSTER_DONE]: [
    { id: 'upload_scope',    label: 'Upload Scope',            icon: '📄',  kind: 'action', jobTypes: ['insurance'] },
  ],
  [S.SCOPE_RECEIVED]: [
    { id: 'send_estimate',   label: 'Send Estimate',           icon: '💰',  kind: 'doc',    jobTypes: ['insurance'] },
  ],
  [S.ESTIMATE_SUBMITTED]: [
    { id: 'request_supp',    label: 'Request Supplement',      icon: '📝',  kind: 'action', jobTypes: ['insurance'] },
    { id: 'send_contract',   label: 'Send Contract',           icon: '✍️', kind: 'doc' },
  ],
  [S.SUPPLEMENT_REQ]: [
    { id: 'follow_supp',     label: 'Follow Up Supplement',    icon: '📞',  kind: 'action', jobTypes: ['insurance'] },
  ],
  [S.SUPPLEMENT_APPROVED]: [
    { id: 'send_contract',   label: 'Send Contract',           icon: '✍️', kind: 'doc' },
  ],
  [S.ESTIMATE_SENT_CASH]: [
    { id: 'follow_up',       label: 'Follow Up',               icon: '📞',  kind: 'action', jobTypes: ['cash'] },
    { id: 'send_contract',   label: 'Send Contract',           icon: '✍️', kind: 'doc',    jobTypes: ['cash'] },
  ],
  [S.NEGOTIATING]: [
    { id: 'revise_estimate', label: 'Revise Estimate',         icon: '💰',  kind: 'doc',    jobTypes: ['cash'] },
    { id: 'send_contract',   label: 'Send Contract',           icon: '✍️', kind: 'doc',    jobTypes: ['cash'] },
  ],
  [S.PREQUAL_SENT]: [
    { id: 'follow_lender',   label: 'Follow Up with Lender',   icon: '🏦',  kind: 'action', jobTypes: ['finance'] },
  ],
  [S.LOAN_APPROVED]: [
    { id: 'send_contract',   label: 'Send Contract',           icon: '✍️', kind: 'doc',    jobTypes: ['finance'] },
  ],
  [S.CONTRACT_SIGNED]: [
    { id: 'create_job',      label: 'Create Job',              icon: '🏗️', kind: 'stage' },
    { id: 'collect_deposit', label: 'Collect Deposit',         icon: '💵',  kind: 'action' },
  ],
  [S.JOB_CREATED]: [
    // 2026-09-15 (Paperwork Filing): was kind:'action' — one of the dashboard
    // bootstrap's own named-dead "workflow markers with nothing to open".
    // 'doc' generates a real permit-application document instead.
    { id: 'pull_permit',     label: 'Pull Permit',             icon: '📜',  kind: 'doc' },
    { id: 'order_materials', label: 'Order Materials',         icon: '📦',  kind: 'action' },
  ],
  [S.PERMIT_PULLED]: [
    // 2026-09-15 (Paperwork Filing): first in the array so preferredActionFor()'s
    // actions[0] fallback (both entries are kind:'action') picks this — the
    // job-created→materials-ordered gate needs permitFiledAt set before it lets
    // the lead through.
    { id: 'mark_permit_filed', label: 'Mark Permit Filed',     icon: '✅',  kind: 'action' },
    { id: 'order_materials',   label: 'Order Materials',       icon: '📦',  kind: 'action' },
  ],
  [S.MATERIALS_ORDERED]: [
    { id: 'confirm_delivery', label: 'Confirm Delivery',       icon: '🚚',  kind: 'action' },
  ],
  [S.MATERIALS_DELIVERED]: [
    { id: 'sched_crew',      label: 'Schedule Crew',           icon: '👷',  kind: 'action' },
  ],
  [S.CREW_SCHEDULED]: [
    { id: 'start_install',   label: 'Start Install',           icon: '🔨',  kind: 'stage' },
    { id: 'work_order',      label: 'Work Order',              icon: '📋',  kind: 'doc' },
  ],
  [S.INSTALL_IN_PROGRESS]: [
    { id: 'progress_photos', label: 'Progress Photos',         icon: '📸',  kind: 'action' },
    { id: 'change_order',    label: 'Change Order',            icon: '📝',  kind: 'doc' },
  ],
  [S.INSTALL_COMPLETE]: [
    { id: 'final_photos',    label: 'Final Photos',            icon: '📸',  kind: 'action' },
    { id: 'closeout',        label: 'Close-Out Checklist',     icon: '✅',  kind: 'doc' },
  ],
  [S.FINAL_PHOTOS]: [
    { id: 'collect_deduct',  label: 'Collect Deductible',      icon: '💵',  kind: 'action', jobTypes: ['insurance'] },
    { id: 'final_invoice',   label: 'Final Invoice',           icon: '🧾',  kind: 'doc' },
  ],
  [S.DEDUCTIBLE_COLLECTED]: [
    { id: 'request_payment', label: 'Request Final Payment',   icon: '🏦',  kind: 'action' },
  ],
  [S.FINAL_PAYMENT]: [
    { id: 'warranty_cert',   label: 'Warranty Certificate',    icon: '🏆',  kind: 'doc' },
    { id: 'close_job',       label: 'Close Job',               icon: '🎉',  kind: 'stage' },
  ],
  [S.COLLECTIONS]: [
    // send_payment_reminder is log-only (kind:'action') — there's no
    // dedicated reminder-email template yet, same shape as Follow Up /
    // Log Contact elsewhere. close_job reuses the SAME action id
    // FINAL_PAYMENT's own "Close Job" button already uses (STAGE_TARGETS
    // in dashboard-bootstrap.module.js maps it to 'closed') — one target,
    // not a second stage-target entry, so once payment actually lands the
    // rep closes the job exactly the way they always have.
    { id: 'send_payment_reminder', label: 'Send Payment Reminder', icon: '📧', kind: 'action' },
    { id: 'close_job',             label: 'Close Job',             icon: '🎉', kind: 'stage' },
  ],
  [S.CLOSED]: [
    { id: 'request_review',  label: 'Request Review',          icon: '⭐',  kind: 'action' },
    // 2026-09-15 (Warranty Claim lane): no jobTypes filter — a post-close
    // issue can be reported against a job of ANY type, incl. warranty/service
    // (which skip the formal certificate at CLOSED but can still have a
    // workmanship callback). kind:'stage' routes through STAGE_TARGETS →
    // moveCard(), whose guard (crm-pipeline.js) intercepts the move to run
    // WarrantyClaim.promptIntake() BEFORE the stage actually changes.
    { id: 'file_warranty_claim', label: 'File Warranty Claim', icon: '🛟',  kind: 'stage' },
  ],
  [S.WARRANTY_CLAIM]: [
    { id: 'log_claim_visit',     label: 'Log Claim Visit',       icon: '📝', kind: 'action' },
    // kind:'stage' → STAGE_TARGETS maps this to 'closed'; moveCard()'s guard
    // intercepts (oldStageKey === 'warranty_claim') and runs
    // WarrantyClaim.promptResolution() before allowing the move back to Closed.
    { id: 'resolve_warranty_claim', label: 'Resolve Claim',      icon: '✅', kind: 'stage' },
  ],
  [S.WARRANTY_SCHEDULED]: [
    { id: 'log_diagnosis',   label: 'Log Diagnosis',           icon: '🔍',  kind: 'action', jobTypes: ['warranty'] },
  ],
  [S.WARRANTY_REPAIRED]: [
    { id: 'final_photos',    label: 'Final Photos',            icon: '📸',  kind: 'action', jobTypes: ['warranty'] },
    { id: 'warranty_report', label: 'Warranty Service Report', icon: '📄',  kind: 'doc',    jobTypes: ['warranty'] },
  ],
  [S.SERVICE_QUOTED]: [
    { id: 'follow_up',       label: 'Follow Up',               icon: '📞',  kind: 'action', jobTypes: ['service'] },
  ],
  [S.SERVICE_APPROVED]: [
    { id: 'sched_crew',      label: 'Schedule Crew',           icon: '👷',  kind: 'action', jobTypes: ['service'] },
  ],
};

/**
 * Return the actions relevant for a given stage + job type.
 * If jobType is null/empty, returns only universal actions.
 */
export function actionsForStage(stage, jobType) {
  const normalized = normalizeStage(stage);
  const list = STAGE_ACTIONS[normalized] || [];
  if (!jobType) return list.filter(a => !a.jobTypes);
  return list.filter(a => !a.jobTypes || a.jobTypes.includes(jobType));
}

// 2026-09-15 (driven-UX foundation): "which ONE action matters most for
// this stage" used to be inlined separately everywhere it was needed —
// the kanban card's next-action chip picked doc/stage-kind actions over
// plain ones with its own `.find(...)`, and a second copy would have been
// needed for the stage-entry auto-task generator (stage-checklist.js).
// Single source now, so both surfaces (and any future one) always agree
// on "the" next action for a stage — no drift between what the chip shows
// and what task gets auto-created.
export function preferredActionFor(stage, jobType) {
  const actions = actionsForStage(stage, jobType);
  if (!actions.length) return null;
  return actions.find(a => a.kind === 'doc' || a.kind === 'stage') || actions[0];
}

// ─────────────────────────────────────────────
// REQUIRED FIELDS — stage transition gates
// Map: jobType → stageKey → required lead-field names.
// Wired into a HARD block (no override) at both stage-mutating call sites —
// crm-pipeline.js's moveCard() and customer-bootstrap.module.js's
// progressStage() (2026-09-15 driven-UX foundation) — via missingRequiredFields()
// below. Data AND enforcement live here; there is no separate "Phase 2" step.
// ─────────────────────────────────────────────

// CREW_SCHEDULED requires scheduledDate on EVERY track.
//
// It is a `track: 'shared'` stage reachable from the Jobs view by a lead of
// any type, but the lookup is keyed by the lead's jobType — so with only
// warranty listing scheduledDate, an insurance/cash/finance/service job moved
// to Crew Scheduled was gated by nothing. smart-calendar.js builds the day's
// job list from `leads.filter(l => l.scheduledDate === todayStr)`, so such a
// job is invisible on the schedule: the crew is "scheduled" and the schedule
// does not know about it. That is the precise failure a scheduling stage
// exists to prevent.
//
// Satisfiable by construction — scheduledDate already has a FIELD_LABELS
// entry, a _GATE_FIELD_META mapping and the #lScheduledDate input, because
// the warranty track has always gated on it. This adds no new machinery.
// Paperwork-filing gate fields (2026-09-15 Paperwork Filing lane) — flat
// ISO-string-or-'' scalars on the LEAD (never boolean: missingRequiredFields
// below treats `undefined/null/''` as missing and nothing else, so a plain
// `false` would silently satisfy the gate). contractFiledAt/permitFiledAt
// gate SHARED job stages reachable by ANY jobType (JOB_CREATED/
// MATERIALS_ORDERED are track:'shared', same as CREW_SCHEDULED above) — every
// track lists them, not just the "obvious" ones, for the exact reason the
// crew_scheduled comment above exists: skipping a track here IS that bug's
// shape. warrantyCertFiledAt is deliberately ABSENT from warranty/service at
// CLOSED — JOB_TYPE_META.warranty/service describe a callback or small
// repair, neither issues a NEW warranty on close (not an oversight).
export const REQUIRED_FIELDS_BY_TYPE = {
  insurance: {
    // aobFiledAt dropped 2026-09-27: the AOB is retired in both states (it
    // used to block every Kentucky lead, where an AOB is void). The legacy
    // field is left in place, unused and hidden; no stage requires it.
    [S.CLAIM_FILED]:        ['insCarrier', 'claimNumber'],
    [S.ADJUSTER_SCHEDULED]: ['insCarrier'],
    [S.ESTIMATE_SUBMITTED]: ['estimateAmount', 'deductibleOrOwedByHO'],
    [S.CONTRACT_SIGNED]:    ['estimateAmount'],
    [S.JOB_CREATED]:        ['contractFiledAt'],
    [S.MATERIALS_ORDERED]:  ['permitFiledAt'],
    [S.CREW_SCHEDULED]:     ['scheduledDate'],
    [S.CLOSED]:             ['warrantyCertFiledAt', 'cocFiledAt'],
  },
  cash: {
    [S.ESTIMATE_SENT_CASH]: ['jobValue'],
    [S.CONTRACT_SIGNED]:    ['jobValue'],
    [S.JOB_CREATED]:        ['contractFiledAt'],
    [S.MATERIALS_ORDERED]:  ['permitFiledAt'],
    [S.CREW_SCHEDULED]:     ['scheduledDate'],
    [S.CLOSED]:             ['warrantyCertFiledAt'],
  },
  finance: {
    [S.PREQUAL_SENT]:       ['financeCompany'],
    [S.LOAN_APPROVED]:      ['loanAmount', 'financeCompany'],
    [S.CONTRACT_SIGNED]:    ['loanAmount', 'financeCompany'],
    [S.JOB_CREATED]:        ['contractFiledAt'],
    [S.MATERIALS_ORDERED]:  ['permitFiledAt'],
    [S.CREW_SCHEDULED]:     ['scheduledDate'],
    [S.CLOSED]:             ['warrantyCertFiledAt'],
  },
  warranty: {
    [S.WARRANTY_SCHEDULED]: ['scheduledDate'],
    [S.JOB_CREATED]:        ['contractFiledAt'],
    [S.MATERIALS_ORDERED]:  ['permitFiledAt'],
    [S.CREW_SCHEDULED]:     ['scheduledDate'],
  },
  service: {
    [S.SERVICE_QUOTED]:     ['jobValue'],
    [S.SERVICE_APPROVED]:   ['jobValue'],
    [S.JOB_CREATED]:        ['contractFiledAt'],
    [S.MATERIALS_ORDERED]:  ['permitFiledAt'],
    [S.CREW_SCHEDULED]:     ['scheduledDate'],
  },
};

// Human labels for the gate fields above — a rep reads "Carrier", not
// "insCarrier". crm-pipeline.js's card chip keeps its own short copy.
export const REQUIRED_FIELD_LABELS = {
  jobType: 'Job Type', insCarrier: 'Carrier', claimNumber: 'Claim #',
  policyNumber: 'Policy #', dateOfLoss: 'Date of Loss',
  estimateAmount: 'Estimate $', deductibleOrOwedByHO: 'Deductible',
  jobValue: 'Job Value', financeCompany: 'Lender', loanAmount: 'Loan $',
  scheduledDate: 'Schedule Date', contractFiledAt: 'Contract Filed',
  permitFiledAt: 'Permit Filed', warrantyCertFiledAt: 'Warranty Cert Filed',
  cocFiledAt: 'COC Filed',
};
export function requiredFieldLabel(f) {
  return REQUIRED_FIELD_LABELS[f] || f;
}

/**
 * Required field names for a given job type + stage. Empty array if none.
 */
export function requiredFieldsFor(jobType, stage) {
  const normalized = normalizeStage(stage);
  return REQUIRED_FIELDS_BY_TYPE[jobType]?.[normalized] || [];
}

/**
 * Returns the list of required fields a lead is missing for its current stage.
 * Treats numeric 0 as a valid value (not missing).
 *
 * When jobType is unset AND the target stage requires any per-type fields,
 * `jobType` itself is returned as a missing field — the rep has to pick a
 * type before the per-type required fields are even visible in the modal,
 * so listing the downstream fields first is misleading.
 */
export function missingRequiredFields(lead) {
  if (!lead) return [];
  const jobType = lead.jobType || inferJobType(lead);
  if (!jobType) {
    const normalized = normalizeStage(lead.stage);
    const anyTypeRequires = Object.keys(REQUIRED_FIELDS_BY_TYPE).some(jt =>
      (REQUIRED_FIELDS_BY_TYPE[jt]?.[normalized] || []).length > 0
    );
    return anyTypeRequires ? ['jobType'] : [];
  }
  const required = requiredFieldsFor(jobType, lead.stage);
  return required.filter(f => {
    const v = lead[f];
    return v === undefined || v === null || v === '';
  });
}

// ─────────────────────────────────────────────
// PIPELINE CONFIG RESOLVER (Phase 1 — freeform pipelines)
// Merge a per-tenant config (stored at companyProfile.pipelines) OVER the
// built-in defaults → resolved { stageMeta, views, roleOf }. Fail-safe: any
// malformed piece is ignored and the default kept, so a bad config can never
// break the board. Custom stages (keys not in the defaults) MUST declare a
// valid semantic role so KPIs / portal / server still classify them.
// Pure + side-effect-free — the browser wiring (dashboard-bootstrap) applies
// the result to window.STAGE_META / window.KANBAN_VIEWS / window.stageRole.
// ─────────────────────────────────────────────

const _VALID_ROLES = [ROLE.NEW, ROLE.ACTIVE, ROLE.JOB, ROLE.WON, ROLE.LOST];
const _HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

// The built-in defaults expressed AS a config, so the Phase-2 builder can show
// "your current pipelines" and diff tenant edits against it.
export const DEFAULT_PIPELINE_CONFIG = { version: 1, stages: {}, views: {} };

function _cloneDefaultStageMeta() {
  const out = {};
  for (const k of Object.keys(STAGE_META)) out[k] = Object.assign({}, STAGE_META[k]);
  return out;
}

export function resolvePipelineConfig(raw) {
  const errors = [];
  const stageMeta = _cloneDefaultStageMeta();
  const views = {};
  for (const k of Object.keys(KANBAN_VIEWS)) {
    views[k] = { label: KANBAN_VIEWS[k].label, stages: KANBAN_VIEWS[k].stages.slice() };
  }
  // roleOf checks the EXACT key first (custom stages don't normalize), then
  // falls back to the normalized default role.
  const roleOf = (k) => {
    if (k && stageMeta[k]) return stageMeta[k].role;
    const n = normalizeStage(k);
    return (stageMeta[n] && stageMeta[n].role) || stageRole(k);
  };

  if (!raw || typeof raw !== 'object') return { stageMeta, views, roleOf, errors };

  // ── stage overrides + custom stages ──
  const rawStages = (raw.stages && typeof raw.stages === 'object') ? raw.stages : {};
  for (const key of Object.keys(rawStages)) {
    const ov = rawStages[key];
    if (!ov || typeof ov !== 'object') { errors.push('stage ' + key + ': not an object'); continue; }
    const existing = stageMeta[key];
    if (existing) {
      if (typeof ov.label === 'string' && ov.label.trim()) existing.label = ov.label.trim().slice(0, 40);
      if (typeof ov.color === 'string' && _HEX_RE.test(ov.color)) existing.color = ov.color;
      if (typeof ov.icon === 'string' && ov.icon.trim()) existing.icon = ov.icon.trim().slice(0, 8);
      if (typeof ov.role === 'string' && _VALID_ROLES.includes(ov.role)) existing.role = ov.role;
      if (ov.hidden === true) existing.hidden = true;
    } else {
      // Custom stage — role + label are mandatory, else skip (fail-safe).
      if (!(typeof ov.role === 'string' && _VALID_ROLES.includes(ov.role))) { errors.push('custom stage ' + key + ': missing/invalid role'); continue; }
      if (!(typeof ov.label === 'string' && ov.label.trim())) { errors.push('custom stage ' + key + ': missing label'); continue; }
      stageMeta[key] = {
        label: ov.label.trim().slice(0, 40),
        color: (typeof ov.color === 'string' && _HEX_RE.test(ov.color)) ? ov.color : '#374151',
        icon: (typeof ov.icon === 'string' && ov.icon.trim()) ? ov.icon.trim().slice(0, 8) : '📌',
        role: ov.role,
        track: 'custom',
        type: ov.role === ROLE.JOB ? 'job' : 'lead',
        custom: true,
        // Honour the builder's eye-toggle for custom stages too — the built-in
        // branch copies ov.hidden (above), so without this a hidden custom stage
        // kept rendering on the board (the column filter reads META[k].hidden).
        hidden: ov.hidden === true,
      };
    }
  }

  // ── view overrides (ordered stage lists) ──
  const rawViews = (raw.views && typeof raw.views === 'object') ? raw.views : {};
  for (const vk of Object.keys(rawViews)) {
    const rv = rawViews[vk];
    if (!rv || typeof rv !== 'object') { errors.push('view ' + vk + ': not an object'); continue; }
    const base = views[vk] || { label: vk, stages: [] };
    if (typeof rv.label === 'string' && rv.label.trim()) base.label = rv.label.trim().slice(0, 40);
    if (Array.isArray(rv.stages)) {
      const cleaned = rv.stages.filter(s => typeof s === 'string' && stageMeta[s]);
      if (cleaned.length) base.stages = cleaned;
      else errors.push('view ' + vk + ': no valid stages, kept default');
    }
    views[vk] = base;
  }

  return { stageMeta, views, roleOf, errors };
}
