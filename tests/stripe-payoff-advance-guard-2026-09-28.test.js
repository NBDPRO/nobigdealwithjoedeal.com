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

console.log('WEBHOOK');
ok('invoiceWebhook gates the advance on payoffAdvanceAllowed', /if \(stageRoles\.payoffAdvanceAllowed\(lead\)\)/.test(STRIPE));
ok('…the old three-stage PROTECTED list is gone', !/PROTECTED = new Set\(\['final_payment', 'closed', 'lost'\]\)/.test(STRIPE));
ok('…and the write appends a stageHistory entry', /stage: 'final_payment',[\s\S]{0,2000}stageHistory: FieldValue\.arrayUnion\(\{/.test(STRIPE));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
