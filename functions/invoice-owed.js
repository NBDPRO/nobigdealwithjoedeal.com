/**
 * invoice-owed.js — is this invoice money the customer owes? (server side)
 *
 * A DRAFT was never sent, so nobody owes it — and since 2026-10-03 the server
 * itself makes drafts (deposit-draft.js, on a signed contract), so every
 * server reader that sums or shows a balance must skip them: the homeowner
 * portal's "balance due" (a draft there would tell the homeowner they owe
 * money Jo has not billed yet), the morning brief, the agent tools.
 *
 * Same status list as the client's owed rule (PR #2112, the
 * nbd:owed-rule block in collected-revenue.js / money-dashboard.js /
 * analytics-kpi.js / invoice-pipeline.js): paid, draft, cancelled/canceled,
 * void/voided, uncollectible, or deleted → not owed.
 */
'use strict';

const NOT_OWED_STATUS = { paid: 1, draft: 1, cancelled: 1, canceled: 1, void: 1, voided: 1, uncollectible: 1 };

function isOwedInvoice(inv) {
  if (!inv || inv.deleted === true) return false;
  return !NOT_OWED_STATUS[String(inv.status || '').toLowerCase()];
}

module.exports = { isOwedInvoice, NOT_OWED_STATUS };
