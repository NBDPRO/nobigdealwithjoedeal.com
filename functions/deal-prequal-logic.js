'use strict';
/**
 * deal-prequal-logic.js — "Check my rate" in the deal room (2026-10-15). PURE.
 *
 * The homeowner taps "Check my rate" on /deal/<token>: the page opens the
 * Acorn Finance pre-qualification link (the dealer link the public site uses,
 * /assets/js/financing-band.js preQualUrl) in a new tab and pings
 * /api/deal-prequal (functions/deal-prequal.js). The server then:
 *
 *   - logs ONE "Financing prequal started" activity row on the lead per deal
 *     per 24 h (a homeowner tapping three times is one row), and
 *   - moves the lead to Pre-Qual Sent ONLY when that is FORWARD in the
 *     pipeline: on the Finance board (crm-stages.js VIEW_FINANCE: New →
 *     Contacted → Inspected → Pre-Qual Sent) and strictly up job-spine-logic.js
 *     STAGE_RANK. From New / Contacted / Inspected it moves; from Est. Sent /
 *     Negotiating (the same rank band), an insurance-track stage (a claim is
 *     not a finance deal), Contract Signed or later, Lost, a deleted lead or a
 *     tenant's custom stage it stays put.
 *
 * Nothing about the homeowner's credit is ever seen here: Acorn's page is
 * theirs. The amount is NOT passed to Acorn — Acorn's public pages document
 * no amount parameter for the dealer link.
 */

const JSL = require('./job-spine-logic');
const roles = require('./stage-roles');

const TARGET = 'prequal_sent';
// The Finance board's columns before Pre-Qual Sent (crm-stages.js VIEW_FINANCE).
const BEFORE_TARGET = new Set(['new', 'contacted', 'inspected']);
const DEDUPE_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_TYPE = 'financing_prequal_started';
const ACTIVITY_LABEL = 'Financing prequal started';

/** → { move: true, from, fromKey, to } | { move: false, reason } */
function planPrequalMove(lead) {
  if (!lead) return { move: false, reason: 'no_lead' };
  if (lead.deleted === true || lead.deletedAt) return { move: false, reason: 'deleted' };
  if (roles.isLost(lead)) return { move: false, reason: 'lost' };
  const fromKey = JSL.normalizeStageKey(lead._stageKey || lead.stage);
  if (!fromKey) return { move: false, reason: 'custom_stage' };
  if (fromKey === TARGET) return { move: false, reason: 'already_there' };
  const from = JSL.STAGE_RANK[fromKey];
  if (!BEFORE_TARGET.has(fromKey) || typeof from !== 'number' || !(JSL.STAGE_RANK[TARGET] > from)) return { move: false, reason: 'not_forward', fromKey };
  return { move: true, from: lead.stage == null ? null : lead.stage, fromKey, to: TARGET };
}

/** Log a new activity row? Once per deal per 24 h. */
function shouldLog(lastMs, nowMs) {
  const last = Number(lastMs) || 0;
  return !last || (Number(nowMs) || Date.now()) - last >= DEDUPE_MS;
}

module.exports = { TARGET, DEDUPE_MS, ACTIVITY_TYPE, ACTIVITY_LABEL, planPrequalMove, shouldLog };
