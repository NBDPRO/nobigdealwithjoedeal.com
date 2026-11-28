/**
 * tests/pay-agreement-gate-2026-11-27.test.js — no signed agreement, no pay
 * link (functions/pay-agreement-gate-logic.js; Jo, 2026-11-27).
 *
 * Two same-day emergency tarp jobs were paid in full by text with nothing
 * signed, then argued back. createStripePaymentLink (platform tenant) now
 * refuses unless the lead has a signed contract (job_events signing marker, or
 * a signed estimate for jobs signed before the spine), or, for an emergency
 * invoice, a signed Emergency Services Request. No override. Fails closed.
 * The platform link also requires the Stripe terms checkbox.
 *
 * Run: node tests/pay-agreement-gate-2026-11-27.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const G = require(path.join(__dirname, '..', 'functions', 'pay-agreement-gate-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const yes = async () => true;
const no = async () => false;
const boom = async () => { throw new Error('UNAVAILABLE'); };
const lead = (o) => async () => Object.assign({ primaryEstimateId: 'E1' }, o || {});
const est = (o) => async () => o;
const deps = (o) => Object.assign({
  readLead: lead(), hasSignEvent: no, readEstimate: est(null), hasSignedEmergencyForm: no,
}, o || {});

(async () => {
  // ── Ordinary invoices ──
  let r = await G.payAgreementGate(Object.assign({ invoice: {} }, deps()));
  ok('no leadId → refused (no_lead)', r.ok === false && r.reason === 'no_lead' && /not linked to a customer/.test(r.message), JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1' } }, deps()));
  ok('nothing signed → refused (no_contract), message says nothing was charged', r.ok === false && r.reason === 'no_contract' && /Nothing was charged/.test(r.message), JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1' } }, deps({ hasSignEvent: yes })));
  ok('a contract_signed / deal_accepted marker → allowed', r.ok === true && r.reason === 'contract', JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1' } }, deps({ readEstimate: est({ leadId: 'L1', signatureStatus: 'signed' }) })));
  ok('legacy job: primary estimate e-signed → allowed', r.ok === true && r.reason === 'estimate', JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1' } }, deps({ readEstimate: est({ leadId: 'L1', signedPrice: { totalCents: 1450000 } }) })));
  ok('legacy job: server signedPrice stamp → allowed', r.ok === true, JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1' } }, deps({ readEstimate: est({ leadId: 'OTHER', signatureStatus: 'signed' }) })));
  ok("another lead's signed estimate does not count", r.ok === false && r.reason === 'no_contract', JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1' } }, deps({ readEstimate: est({ leadId: 'L1', signatureStatus: 'signed', deleted: true }) })));
  ok('a deleted signed estimate does not count', r.ok === false, JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1' } }, deps({ hasSignEvent: boom })));
  ok('a read that throws → refused (fail closed)', r.ok === false && r.reason === 'unreadable', JSON.stringify(r));

  // ── Emergency invoices ──
  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1', emergencyServices: true } }, deps({ hasSignEvent: yes })));
  ok('emergency invoice needs the signed Emergency Services Request even with a contract marker', r.ok === false && r.reason === 'no_emergency_form', JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1', emergencyServices: true } }, deps({ hasSignedEmergencyForm: yes })));
  ok('emergency invoice + signed request → allowed', r.ok === true && r.reason === 'emergency_form', JSON.stringify(r));

  r = await G.payAgreementGate(Object.assign({ invoice: { leadId: 'L1', emergencyServices: true } }, deps({ hasSignedEmergencyForm: boom })));
  ok('emergency form read throws → refused', r.ok === false && r.reason === 'unreadable', JSON.stringify(r));

  // ── Signed-form row shape ──
  ok('signed ESR row counts', G.isSignedEmergencyForm({ type: 'emergency_services_request', status: 'signed', signedAt: 1 }));
  ok('unsigned / undated / deleted / other-type rows do not', !G.isSignedEmergencyForm({ type: 'emergency_services_request', status: 'sent', signedAt: 1 })
    && !G.isSignedEmergencyForm({ type: 'emergency_services_request', status: 'signed' })
    && !G.isSignedEmergencyForm({ type: 'emergency_services_request', status: 'signed', signedAt: 1, deleted: true })
    && !G.isSignedEmergencyForm({ type: 'contract', status: 'signed', signedAt: 1 }));

  // ── Stripe terms checkbox params ──
  const p = G.termsConsentParams();
  ok('pay link requires the terms checkbox', p.consent_collection && p.consent_collection.terms_of_service === 'required');
  const msg = p.custom_text.terms_of_service_acceptance.message;
  ok('checkbox text links the payment terms and fits Stripe\'s 1200-char limit', msg.indexOf(G.TERMS_URL) !== -1 && msg.length <= 1200, String(msg.length));

  // ── Wiring: stripe.js refuses before any Stripe call, and puts the box on the platform link ──
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'stripe.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('PayAgreementGate.payAgreementGate({');
  const stripeAt = src.indexOf('const stripe = getStripe();', at);
  ok('createStripePaymentLink runs the gate and answers 409 before getStripe()',
    at > 0 && stripeAt > at && /if \(!agreement\.ok\) \{[\s\S]{0,400}res\.status\(409\)/.test(src.slice(at, stripeAt)));
  ok('the platform payment link spreads termsConsentParams()', /_achOnLink \? PayAgreementGate\.termsConsentParams\(\) : \{\}/.test(src));

  // The /terms page carries the anchor the checkbox links to.
  const terms = fs.readFileSync(path.join(__dirname, '..', 'docs', 'terms.html'), 'utf8');
  ok('/terms has id="payment-terms" and id="emergency-service"', terms.includes('id="payment-terms"') && terms.includes('id="emergency-service"'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((err) => { console.error('pay-agreement-gate test crashed:', err && (err.stack || err.message)); process.exit(1); });
