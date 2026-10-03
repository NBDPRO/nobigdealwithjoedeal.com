/**
 * invoice-owed.js — is this invoice money the customer owes? (server side)
 *
 * A DRAFT was never sent, so nobody owes it — and since 2026-10-03 the server
 * itself makes drafts (deposit-draft.js, on a signed contract), so every
 * server reader that sums or shows a balance must skip them: the homeowner
 * portal's "balance due" (a draft there would tell the homeowner they owe
 * money Jo has not billed yet), the morning brief, the agent tools.
 *
 * The rule below is PR #2112's nbd:owed-rule block, copied byte-for-byte
 * from docs/pro/js/collected-revenue.js (functions/ cannot reach docs/).
 * tests/deposit-draft-2026-10-03.test.js fails if the copies drift.
 */
'use strict';

  // nbd:owed-rule:start — ONE "is this invoice still owed?" rule, kept
  // byte-identical in collected-revenue.js, money-dashboard.js,
  // analytics-kpi.js and invoice-pipeline.js
  // (tests/invoice-owed-rule-2026-10-03.test.js). A voided Stripe mirror is
  // written { status:'void', balanceDue:0 }; drafts were never sent. Neither
  // is owed. Amount = balanceDue when present (0 means nothing due — the old
  // `balanceDue || total` read 0 as "missing" and re-counted the full face).
  var NOT_OWED_STATUS = { paid: 1, draft: 1, cancelled: 1, canceled: 1, void: 1, voided: 1, uncollectible: 1 };
  function isOwedInvoice(inv) {
    if (!inv || inv.deleted === true) return false;
    return !NOT_OWED_STATUS[String(inv.status || '').toLowerCase()];
  }
  function owedDollarsOf(inv) {
    if (!isOwedInvoice(inv)) return 0;
    var b = inv.balanceDue;
    var v = parseFloat((b != null && b !== '') ? b : inv.total);
    return v > 0 ? v : 0;
  }
  // nbd:owed-rule:end

module.exports = { isOwedInvoice, owedDollarsOf, NOT_OWED_STATUS };
