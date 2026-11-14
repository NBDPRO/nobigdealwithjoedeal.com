/**
 * tests/plan-checkout-guard-2026-11-14.test.js
 *
 * stripeWebhook's checkout.session.completed case must grant an NBD Pro plan
 * ONLY for the subscription Checkout that createCheckoutSession mints. Stripe
 * Payment Links accept ?client_reference_id=<anything> from the URL, and every
 * tenant invoice link lives on the platform account, so before 2026-11-14
 * paying a $1 invoice link with a victim's company id wrote an "active"
 * Starter plan onto the victim (and wiped its real Stripe subscription id).
 *
 * Part 1 tests the pure guard; part 2 pins that the webhook calls it before
 * the subscriptions/{id} write and the claims write. Synthetic data only.
 *
 * Run: node tests/plan-checkout-guard-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

console.log('\n1. planCheckoutRefusal (functions/plan-checkout-guard.js)');
let G = null;
try { G = require(path.join(ROOT, 'functions', 'plan-checkout-guard.js')); } catch (e) { G = null; }
ok('the guard module exists and exports planCheckoutRefusal', !!(G && typeof G.planCheckoutRefusal === 'function'));
if (G && typeof G.planCheckoutRefusal === 'function') {
  const R = G.planCheckoutRefusal;
  const real = { mode: 'subscription', subscription: 'sub_1', client_reference_id: 'coA', metadata: { companyId: 'coA', plan: 'growth' } };
  ok('the real subscription checkout → allowed', R(real) === '');
  ok('payment-link session (mode payment, no subscription, attacker-set ref) → refused',
    R({ mode: 'payment', subscription: null, client_reference_id: 'coVictim', metadata: { invoiceId: 'inv1', companyId: 'coAttacker' } }) !== '');
  ok('mode payment even with a matching companyId → refused',
    R({ mode: 'payment', subscription: null, client_reference_id: 'coA', metadata: { companyId: 'coA' } }) !== '');
  ok('subscription mode but no subscription id → refused',
    R({ mode: 'subscription', subscription: null, client_reference_id: 'coA', metadata: { companyId: 'coA' } }) !== '');
  ok('subscription mode, metadata.companyId for another company → refused',
    R({ mode: 'subscription', subscription: 'sub_2', client_reference_id: 'coB', metadata: { companyId: 'coA' } }) !== '');
  ok('subscription mode, no metadata → refused',
    R({ mode: 'subscription', subscription: 'sub_2', client_reference_id: 'coB' }) !== '');
  ok('no client_reference_id → refused', R({ mode: 'subscription', subscription: 'sub_1', metadata: { companyId: 'coA' } }) !== '');
  ok('setup mode → refused', R({ mode: 'setup', subscription: 'sub_1', client_reference_id: 'coA', metadata: { companyId: 'coA' } }) !== '');
  ok('null / garbage input → refused, never throws', R(null) !== '' && R(undefined) !== '' && R('x') !== '');
  ok('a non-string ref (object) → refused',
    R({ mode: 'subscription', subscription: 'sub_1', client_reference_id: { a: 1 }, metadata: { companyId: { a: 1 } } }) !== '');
}

console.log('\n2. stripeWebhook calls the guard before any write');
{
  const raw = fs.readFileSync(path.join(ROOT, 'functions', 'stripe.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const i = src.indexOf("case 'checkout.session.completed'");
  const j = src.indexOf("case 'customer.subscription.updated'", i);
  const cs = i === -1 ? '' : src.slice(i, j === -1 ? undefined : j);
  ok('checkout case found', cs.length > 500);
  const g = cs.search(/planCheckoutRefusal\(session\)/);
  ok('the case calls planCheckoutRefusal(session)', g !== -1);
  const subWrite = cs.indexOf('.set(subData');
  const claims = cs.indexOf('mergeCustomClaims(');
  const reactivate = cs.indexOf('reactivateLapsedSeats(');
  const subLookup = cs.indexOf('stripe.subscriptions.retrieve(');
  ok('…before the subscriptions/{id} write', g !== -1 && subWrite !== -1 && g < subWrite);
  ok('…before the claims write', g !== -1 && claims !== -1 && g < claims);
  ok('…before reactivating lapsed seats', g !== -1 && reactivate !== -1 && g < reactivate);
  ok('…before the Stripe subscription lookup', g !== -1 && subLookup !== -1 && g < subLookup);
  // The refusal must leave the case (break), not just log and fall through.
  const after = g === -1 ? '' : cs.slice(g, g + 400);
  // Exact shape: the result is held, tested on its own (no `&& false`
  // wrapper can disable it), and the refusal branch breaks out of the case.
  ok('the refusal is assigned straight from the guard', /const planRefusal = planCheckoutRefusal\(session\);/.test(cs));
  ok('a refusal breaks out of the case', /if \(planRefusal\) \{\s*logger\.warn\([^;]*\);\s*break;\s*\}/.test(cs));
  ok('stripe.js requires the guard module', /require\(['"]\.\/plan-checkout-guard['"]\)/.test(src));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
