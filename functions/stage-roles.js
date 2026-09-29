/**
 * stage-roles.js — SERVER mirror of the crm-stages.js semantic roles.
 *
 * The client stage config (docs/pro/js/crm-stages.js) is an ES module the
 * functions runtime can't require, so this is a small pure copy of the role
 * mapping. Freeform-pipeline design (Phase 3):
 *
 *   A lead's PERSISTED `stageRole` wins. The client stamps it on every stage
 *   change (crm-pipeline moveCard), so a lead sitting on a tenant's CUSTOM
 *   stage carries its role here even though the server has no idea what that
 *   stage means. The built-in key map is only the FALLBACK for legacy leads /
 *   leads that predate the stageRole denormalization.
 *
 * Keep the WON/JOB/LOST/NEW sets in sync with crm-stages.js (tests/crm-stages-
 * roles.test.js guards the client side; tests/stage-roles.test.js guards this).
 */
'use strict';

const ROLE = { NEW: 'new', ACTIVE: 'active', JOB: 'job', WON: 'won', LOST: 'lost' };

const WON  = new Set(['closed', 'install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'collections', 'warranty_claim']);
const JOB  = new Set(['job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress']);
const LOST = new Set(['lost']);
const NEW  = new Set(['new']);

// Legacy raw display-name aliases that affect ROLE (subset of crm-stages
// LEGACY_MAP — only the won/lost ones matter for classification).
const ALIAS = {
  'Complete': 'closed', 'complete': 'closed',
  'Closed Won': 'closed', 'closed_won': 'closed', 'closed-won': 'closed', 'Won': 'closed',
  'Closed': 'closed', 'Closed Lost': 'lost', 'Lost': 'lost',
};

function normKey(stage) {
  const s = String(stage == null ? '' : stage).trim();
  if (!s) return 'new';
  if (WON.has(s) || JOB.has(s) || LOST.has(s) || NEW.has(s)) return s;
  if (ALIAS[s]) return ALIAS[s];
  return s.toLowerCase();
}

function roleFromKey(stage) {
  const k = normKey(stage);
  if (WON.has(k)) return ROLE.WON;
  if (LOST.has(k)) return ROLE.LOST;
  if (JOB.has(k)) return ROLE.JOB;
  if (NEW.has(k)) return ROLE.NEW;
  return ROLE.ACTIVE;
}

const _VALID = new Set(Object.keys(ROLE).map((k) => ROLE[k]));

// Prefer the persisted stageRole (custom-stage-safe); fall back to the key map.
function roleFor(lead) {
  if (lead && typeof lead.stageRole === 'string' && _VALID.has(lead.stageRole)) return lead.stageRole;
  return roleFromKey(lead && (lead._stageKey || lead.stage));
}

function isWon(lead)  { return roleFor(lead) === ROLE.WON; }
function isLost(lead) { return roleFor(lead) === ROLE.LOST; }
// "Decided" = the project is finished either way (won or lost).
function isDecided(lead) { const r = roleFor(lead); return r === ROLE.WON || r === ROLE.LOST; }

// Exposed so callers that need a literal-stage Firestore `where(field, 'in',
// list)` PREFILTER (e.g. functions/anniversary-touch.js — reading only
// completed leads instead of a rep's whole pipeline) can build that list from
// this single source of truth instead of hand-maintaining their own, which is
// exactly how anniversary-touch.js went stale and missed 'closed' plus every
// WON stage added after 2026-09-07 (2026-09-15 audit). Frozen copies — WON
// above is the mutable module-internal Set; these are read-only exports.
const WON_STAGES  = Object.freeze(Array.from(WON));
const WON_ALIASES = Object.freeze(Object.keys(ALIAS).filter((k) => ALIAS[k] === 'closed'));

// May an online payoff (Stripe invoiceWebhook) auto-advance this lead to
// 'final_payment'? Only FORWARD, only on the main job track (CRM sweep R14,
// 2026-09-28). The webhook's old guard protected just final_payment / closed /
// lost, so a payoff on a WARRANTY or SERVICE lead dragged it onto the main
// track's Final Payment — orphaning an open warranty claim, which the kanban
// refuses to do by hand (moveCard's warranty guard) — and any custom won stage
// was pulled back to it too. Same forward-only rule as the client payoff
// (invoice-pipeline.js markPaid, #1821).
const PRE_FINAL_WON = new Set(['install_complete', 'final_photos', 'deductible_collected', 'collections']);
function payoffAdvanceAllowed(lead) {
  if (!lead) return false;
  const key = normKey(lead._stageKey || lead.stage);
  if (key === 'final_payment') return false;
  const jt = String(lead.jobType || '').toLowerCase();
  if (jt === 'warranty' || jt === 'service') return false;
  if (/^(warranty|service)_/.test(key) || lead.openWarrantyClaimId) return false;
  const role = roleFor(lead);
  if (role === ROLE.NEW || role === ROLE.ACTIVE || role === ROLE.JOB) return true;
  return role === ROLE.WON && PRE_FINAL_WON.has(key);
}

module.exports = { ROLE, WON_STAGES, WON_ALIASES, normKey, roleFromKey, roleFor, isWon, isLost, isDecided, payoffAdvanceAllowed };
