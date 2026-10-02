/**
 * ask-joe-rules.js — THE ground rules every Ask Joe surface puts in its
 * system prompt (2026-10-02). Both surfaces load this file:
 *   • the CRM's Ask Joe (js/ai.js buildJoeSystemPrompt)
 *   • the standalone /pro/ask-joe page (js/pages/ask-joe-main.js)
 * Before this, the CRM prompt carried the claim-ownership rule but not the
 * Kentucky payment rules or the deposit rule, and the standalone page carried
 * none of them and still said Joe knew "adjuster negotiations".
 *
 * Sources (do not paraphrase loosely — these are the rules NBD runs on):
 *   • Kentucky insurance jobs: SB 153, KRS 367.620–.628 (contracts on/after
 *     2026-07-15) — no representing or negotiating the claim, no "claims /
 *     insurance specialist" marketing, NO payment until the insurer's written
 *     coverage decision + the 5-business-day cancellation window (367.626;
 *     emergency tarp/repair billable on its own invoice), no deductible
 *     rebates, no discounts against the fee, nothing worth more than $100 to
 *     the insured, referral fees included (367.628(2)). KRS 304.20-105 voids
 *     assignment of benefits; Jo also rules out direction-to-pay (2026-09-27).
 *   • Ohio: negotiating a claim for pay is public adjusting (ORC 3951).
 *   • Deposits: deposit-rule.js policyText() — the one deposit rule. When it
 *     is not loaded, FALLBACK_DEPOSIT (pinned equal to it by
 *     tests/ask-joe-rules-2026-10-02.test.js) is used.
 *
 * Checked by tests/ask-joe-rules-2026-10-02.test.js, and by the golden
 * questions in scripts/eval-ask-joe.mjs (run with an Anthropic key).
 */
(function (root) {
  'use strict';

  var CLAIM = 'The insurance claim belongs to the homeowner. A contractor documents damage, meets the adjuster, writes scopes, estimates and supplements, and the homeowner is the one who decides and submits. Never coach a contractor to negotiate the claim, act for the homeowner with the carrier, take an assignment of benefits or a direction-to-pay, waive or absorb a deductible, or promise "we handle your claim". In Kentucky (KRS 367.620–.628) that’s illegal for contractors, and in Ohio negotiating a claim is unlicensed public adjusting. If asked, say so plainly and give the legal way to do it.';

  var KY_PAY = 'Kentucky insurance jobs: NOTHING is due at signing — no deposit, no deductible, no down payment — until the insurer’s written coverage decision AND the 5-business-day cancellation window have passed (KRS 367.626). Emergency tarp or repair work can be billed on its own invoice.';

  var KY_VALUE = 'Kentucky insurance jobs: never offer the homeowner a deductible rebate, a discount against the fee, or anything worth more than $100 (gift cards, cash, referral fees included) (KRS 367.628). And never present NBD as a specialist or expert in insurance claims.';

  var FALLBACK_DEPOSIT = 'Cash jobs under $2,000: no deposit — payment in full on completion. Cash jobs of $2,000 or more: 50% deposit at contract signing, balance on completion. Insurance claims: the homeowner’s deductible is due at signing and the insurance ACV payment (the carrier’s first check) is due as soon as the carrier releases it; the balance is due on completion. Kentucky insurance claims: nothing is due at signing; the deductible and the ACV payment are due after the insurer’s written coverage decision and the 5-business-day cancellation window. The deductible is the homeowner’s responsibility and is never waived or reduced.';

  var UNSURE = 'If you’re not sure something is legal in Ohio or Kentucky, say so and tell them to check before acting.';

  function depositPolicy() {
    try {
      var D = root && root.NBDDepositRule;
      if (D && typeof D.policyText === 'function') return D.policyText();
    } catch (_) { /* fall through */ }
    return FALLBACK_DEPOSIT;
  }

  function lines() {
    return [CLAIM, KY_PAY, KY_VALUE, 'Deposits follow NBD’s rule exactly — quote it, never improvise one: ' + depositPolicy(), UNSURE];
  }

  var api = {
    lines: lines,
    text: function () { return lines().map(function (l) { return '- ' + l; }).join('\n'); },
    FALLBACK_DEPOSIT: FALLBACK_DEPOSIT,
  };
  if (root) root.NBDAskJoeRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
