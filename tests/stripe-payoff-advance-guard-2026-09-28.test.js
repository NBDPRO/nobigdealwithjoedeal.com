/**
 * tests/stripe-payoff-advance-guard-2026-09-28.test.js
 *
 * CRM sweep R14 (2026-09-28) — the Stripe invoiceWebhook's auto-advance to
 * 'final_payment' on a full online payoff (functions/stripe.js).
 *
 * THE BUG: it protected only final_payment / closed / lost. A payoff on a
 * WARRANTY or SERVICE lead dragged it onto the main track's Final Payment —
 * orphaning an open warranty claim (the kanban's moveCard refuses exactly that
 * by hand) — and a custom won stage was pulled back to Final Payment too. The
 * write also had no stageHistory entry, unlike every client stage move.
 *
 * THE FIX: stage-roles.js payoffAdvanceAllowed(lead) — forward-only, main
 * track only — gates the write; the write appends a stageHistory entry.
 *
 * Runs the REAL payoffAdvanceAllowed; checks the webhook uses it.
 * Break-test: against main the helper is absent.
 *
 * Zero deps. Run: node tests/stripe-payoff-advance-guard-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const sr = require(path.join(__dirname, '..', 'functions', 'stage-roles.js'));
const STRIPE = fs.readFileSync(path.join(__dirname, '..', 'functions', 'stripe.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const allow = typeof sr.payoffAdvanceAllowed === 'function' ? sr.payoffAdvanceAllowed : () => undefined;
ok('stage-roles exports payoffAdvanceAllowed', typeof sr.payoffAdvanceAllowed === 'function');

console.log('ADVANCES (forward, main track)');
for (const stage of ['new', 'contacted', 'estimate_submitted', 'contract_signed', 'install_in_progress', 'install_complete', 'final_photos', 'deductible_collected', 'collections', 'New', 'Contacted']) {
  ok('advances from ' + stage, allow({ stage, jobType: 'insurance' }) === true);
}
ok('advances a cash job', allow({ stage: 'contract_signed', jobType: 'cash' }) === true);

console.log('STAYS PUT');
for (const stage of ['final_payment', 'closed', 'lost']) {
  ok('never overrides ' + stage, allow({ stage, jobType: 'insurance' }) === false);
}
for (const stage of ['warranty_claim', 'warranty_scheduled', 'warranty_repaired', 'service_quoted', 'service_approved']) {
  ok('a ' + stage + ' lead is not dragged onto Final Payment', allow({ stage }) === false);
}
ok('a warranty-track lead (jobType) stays', allow({ stage: 'contacted', jobType: 'warranty' }) === false);
ok('a service-track lead (jobType) stays', allow({ stage: 'contacted', jobType: 'Service' }) === false);
ok('a lead with an open warranty claim stays', allow({ stage: 'closed', openWarrantyClaimId: 'wc1' }) === false);
ok('a custom WON stage is not pulled back', allow({ stage: 'custom_paid', stageRole: 'won' }) === false);
ok('no lead → no advance', allow(null) === false);

// 2026-10-03 (job spine): the webhook no longer writes the stage. It flips
// the invoice to 'paid'; the invoice trigger (money-paper.js → job-spine.js
// 'paid_in_full') does the advance for EVERY payment method, still gated on
// payoffAdvanceAllowed, still with a stageHistory entry.
console.log('WEBHOOK → INVOICE TRIGGER');
const SPINE_L = require(path.join(__dirname, '..', 'functions', 'job-spine-logic.js'));
ok('invoiceWebhook no longer writes the stage itself', !/stage: 'final_payment'/.test(STRIPE));
ok('…the old three-stage PROTECTED list is gone', !/PROTECTED = new Set\(\['final_payment', 'closed', 'lost'\]\)/.test(STRIPE));
ok('the spine gates paid_in_full on payoffAdvanceAllowed (warranty lead stays)',
  SPINE_L.planJobEvent({ stage: 'contacted', jobType: 'warranty' }, 'paid_in_full').action === 'skip'
  && SPINE_L.planJobEvent({ stage: 'final_photos', openWarrantyClaimId: 'w' }, 'paid_in_full').reason === 'payoff_not_allowed'
  && SPINE_L.planJobEvent({ stage: 'contract_signed', jobType: 'insurance' }, 'paid_in_full').to === 'final_payment');
ok('…and the move appends a stageHistory entry',
  !!SPINE_L.movePayload({ stage: 'contract_signed' }, SPINE_L.planJobEvent({ stage: 'contract_signed', jobType: 'cash' }, 'paid_in_full'),
    { actor: 'a', atIso: 'T', event: 'paid_in_full' }, { serverTimestamp: () => 'TS', arrayUnion: (x) => ({ u: x }) }).payload.stageHistory.u);

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
