/**
 * tests/smoke/security-guards.test.js — Audit #2 (Phase 8.3)
 *
 * Structural regression guards for the security controls that protect
 * money + customer data. These are SOURCE assertions (zero deps, no
 * emulator): they fail CI the moment a refactor silently drops a
 * webhook signature check, the AI billing gate, or the SMS opt-out.
 *
 * They don't replace behavioral tests — they're a cheap tripwire that
 * the *guard still exists*, which is the realistic regression (someone
 * restructures incomingSMS / a webhook handler and the verify/reject
 * branch quietly disappears). Pairs with firestore-rules.cross-tenant
 * .test.js (tenant isolation) + the emulator rules suite.
 */
'use strict';

const path = require('path');
const { read, FUNCTIONS } = require('./_shared');

function run(ctx) {
  const { assert, section } = ctx;

  const stripe      = read(path.join(FUNCTIONS, 'stripe.js'));
  // integrations/esign.js (BoldSign + esignWebhook) was retired 2026-10-04.
  const fs          = require('fs');
  const calcom      = read(path.join(FUNCTIONS, 'integrations/calcom.js'));
  const measurement = read(path.join(FUNCTIONS, 'integrations/measurement.js'));
  const irLogic     = read(path.join(FUNCTIONS, 'integrations/instantroofer-logic.js'));
  const sms         = read(path.join(FUNCTIONS, 'sms-functions.js'));
  const ai          = read(path.join(FUNCTIONS, 'handlers/ai.js'));

  // ── Webhook signature verification (forged/unsigned POST must be rejected) ──
  section('SECURITY GUARDS — webhook signature verification');
  assert('stripeWebhook + invoiceWebhook verify via constructEvent',
    (stripe.match(/constructEvent/g) || []).length >= 2);
  assert('stripe webhooks require rawBody (block reparse-forgery)',
    /rawBody/.test(stripe) && /Invalid request body/.test(stripe));
  assert('stripe webhooks reject a bad signature',
    /signature verification failed/i.test(stripe) || /Invalid signature/.test(stripe));
  assert('stripeWebhook fails closed when its secret is missing/stub',
    /secretValue\(STRIPE_WEBHOOK_SECRET\)/.test(stripe) && /rejecting unsigned request/i.test(stripe));
  // The BoldSign webhook is gone (2026-10-04). An unsigned public endpoint
  // that flips estimates to "signed" must not come back by accident.
  assert('the retired esignWebhook (BoldSign) does not exist',
    !fs.existsSync(path.join(FUNCTIONS, 'integrations/esign.js')));
  assert('calcomWebhook HMAC-verifies (+ timingSafeEqual)',
    /CALCOM_WEBHOOK_SECRET/.test(calcom) && /timingSafeEqual/.test(calcom));
  assert('calcomWebhook fails closed when its secret is unset',
    /rejecting unsigned request/i.test(calcom));
  // swathWebhook was removed 2026-10-04 (VENDOR-COST-LOCKIN Lane C); its HMAC
  // guards went with it. measurementWebhook's only provider is Instant Roofer,
  // whose bearer token is compared constant-time in instantroofer-logic.js.
  assert('measurementWebhook verifies the Instant Roofer bearer (verifyBearer + timingSafeEqual)',
    /verifyInstantRooferBearer/.test(measurement) && /IR\.verifyBearer\(/.test(measurement)
      && /timingSafeEqual/.test(irLogic));
  assert('measurementWebhook refuses any other ?provider= (unknown-provider)',
    /:\s*\{\s*ok:\s*false,\s*reason:\s*'unknown-provider'\s*\}/.test(measurement));
  assert('measurementWebhook rejects on signature mismatch',
    /signature rejected/i.test(measurement) && /sigResult\.ok/.test(measurement));
  assert('incomingSMS verifies the Twilio signature (validateRequest)',
    /validateRequest\(/.test(sms));
  assert('incomingSMS rejects an invalid Twilio signature',
    /signature verification failed/i.test(sms) && /403/.test(sms));

  // ── AI billing entitlement (claudeProxy must be paid + budgeted) ──
  section('SECURITY GUARDS — AI billing entitlement');
  assert('claudeProxy requires an active paid subscription (server-side)',
    /hasPaidPlan/.test(ai) && /require an active paid subscription/i.test(ai));
  assert('claudeProxy enforces a per-uid/company token budget',
    /reserveClaudeBudget/.test(ai));
  assert('claudeProxy requires a verified email before billable AI',
    /email_verified/.test(ai));

  // ── SMS opt-out / TCPA ──
  section('SECURITY GUARDS — SMS opt-out (TCPA)');
  assert('incomingSMS honors STOP-family keywords',
    /STOP_WORDS/.test(sms) && /UNSUBSCRIBE/.test(sms));
  // 2026-09-04: these matched the bare string `sms_opt_outs`, which after the
  // key-normalisation fix survives ONLY in two explanatory comments — so both
  // assertions would have stayed green while every send path stopped checking
  // the register. Re-pointed at the calls, which comments cannot satisfy.
  assert('incomingSMS records opt-outs through the shared register',
    /OptOut\.recordOptOut\(/.test(sms));
  assert('outbound senders gate on the opt-out register before sending',
    // sendSMS, sendD2DSMS and the approved-AI-draft trigger must all consult it.
    (sms.match(/OptOut\.isOptedOut\(/g) || []).length >= 3);

  // ── Claim-escalation remediation script: safety invariants ──
  // scripts/audit-claim-escalation.js mutates prod Auth claims under --apply.
  // These guards ensure it can't regress to auto-applying or running on import.
  section('SECURITY GUARDS — claim-escalation audit script');
  const audit = read(path.join(FUNCTIONS, '..', 'scripts', 'audit-claim-escalation.js'));
  assert('audit script defaults to DRY RUN (report only)',
    /DRY RUN \(report only\)/.test(audit));
  assert('audit script mutates only with BOTH --apply and --yes',
    /const APPLY = process\.argv\.includes\('--apply'\)/.test(audit)
    && /const CONFIRMED = process\.argv\.includes\('--yes'\)/.test(audit)
    && /if \(!APPLY \|\| !CONFIRMED\)/.test(audit));
  assert('audit script is import-safe (guards main on require.main)',
    /require\.main === module/.test(audit));
  assert('audit remediation is scoped to access-code CRITICAL only',
    /critical\.filter\(c => c\.isAccessCode\)/.test(audit));
  assert('audit script revokes sessions after a claim reset',
    /revokeRefreshTokens/.test(audit));
  assert('audit script exports classifyClaims (unit-tested)',
    /module\.exports = \{ classifyClaims \}/.test(audit));
}

module.exports = { run };
