/**
 * tests/ky-pay-link-gate-2026-10-03.test.js — the Kentucky (KRS 367.626)
 * payment-link gate createStripePaymentLink runs (functions/ky-pay-link-gate-logic.js).
 *
 * The bug: functions/stripe.js read the invoice's lead, and on a read error
 * (or a lead doc that no longer exists) carried on with kyLead = null.
 * payLinkHold(null, invoice) only holds an invoice that carries
 * kyInsuranceHold, so a Kentucky insurance job inside its window got a pay
 * link whenever its lead could not be read. ky-insurance-law.js promises
 * FAIL CLOSED; now an invoice that names a lead we cannot read is refused.
 *
 * Run: node tests/ky-pay-link-gate-2026-10-03.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const G = require(path.join(__dirname, '..', 'functions', 'ky-pay-link-gate-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const KY_LEAD = { address: '9 Dixie Hwy, Florence, KY 41042', jobType: 'insurance', claimNumber: 'C-1' };
const OH_LEAD = { address: '12 Main St, Milford, OH 45150', jobType: 'insurance', claimNumber: 'C-2' };
const NOW = Date.parse('2026-10-03T15:00:00Z');
const readOk = (lead) => async () => lead;
const readThrows = async () => { throw new Error('UNAVAILABLE'); };

(async () => {
  console.log('KY PAY-LINK GATE — fail closed on an unreadable lead');

  const a = await G.kyPayLinkGate({ invoice: { leadId: 'L1' }, readLead: readThrows, now: NOW });
  ok('lead read throws → HELD (reason lead_unreadable)', a.held === true && a.reason === 'lead_unreadable', JSON.stringify(a));

  const b = await G.kyPayLinkGate({ invoice: { leadId: 'L1' }, readLead: readOk(null), now: NOW });
  ok('lead doc does not exist → HELD (reason lead_missing)', b.held === true && b.reason === 'lead_missing', JSON.stringify(b));

  const c = await G.kyPayLinkGate({ invoice: { leadId: 'L1' }, readLead: readOk(KY_LEAD), now: NOW });
  ok('KY insurance lead, no carrier decision → HELD (ky_window)', c.held === true && c.reason === 'ky_window', JSON.stringify(c));

  const d = await G.kyPayLinkGate({ invoice: { leadId: 'L1' }, readLead: readOk(Object.assign({ carrierDecisionAt: '2026-08-01' }, KY_LEAD)), now: NOW });
  ok('KY insurance lead after its window → released', d.held === false && d.reason === '', JSON.stringify(d));

  const e = await G.kyPayLinkGate({ invoice: { leadId: 'L2' }, readLead: readOk(OH_LEAD), now: NOW });
  ok('positive control: an Ohio insurance lead that reads fine → not held', e.held === false, JSON.stringify(e));

  let reads = 0;
  const f = await G.kyPayLinkGate({ invoice: { leadId: 'L1', emergencyServices: true }, readLead: async () => { reads++; throw new Error('x'); }, now: NOW });
  ok('emergency tarp/repair invoice (KRS 367.626(3)) → never held, no lead read', f.held === false && reads === 0, JSON.stringify(f));

  const g = await G.kyPayLinkGate({ invoice: {}, readLead: readThrows, now: NOW });
  ok('invoice with no leadId → classified from the invoice alone (not held), lead never read', g.held === false, JSON.stringify(g));
  const h = await G.kyPayLinkGate({ invoice: { kyInsuranceHold: true }, readLead: readThrows, now: NOW });
  ok('…but its kyInsuranceHold flag still holds it', h.held === true && h.reason === 'ky_window', JSON.stringify(h));

  const tzSeen = await G.kyPayLinkGate({ invoice: { leadId: 'L2' }, readLead: readOk(OH_LEAD), readProfile: async () => ({ timezone: 'America/Chicago' }), now: NOW });
  ok('the tenant time zone comes from the company profile', tzSeen.tz === 'America/Chicago', tzSeen.tz);
  const tzBad = await G.kyPayLinkGate({ invoice: { leadId: 'L2' }, readLead: readOk(OH_LEAD), readProfile: readThrows, now: NOW });
  ok('…a profile read error falls back to America/New_York (not a refusal)', tzBad.tz === 'America/New_York' && tzBad.held === false, JSON.stringify(tzBad));

  // Wiring: stripe.js refuses on gate.held with 409 before any Stripe call
  // (tests/ky-insurance-contracts.test.js also pins the order).
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'stripe.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('KyPayLinkGate.kyPayLinkGate({');
  ok('createStripePaymentLink calls the gate and returns 409 when held, before getStripe()',
    at > 0 && at < src.indexOf('const stripe = getStripe();', at) && /if \(gate\.held\) \{[\s\S]{0,600}res\.status\(409\)/.test(src.slice(at, at + 1400)));
  ok('the old fail-open read (kyLead = null on a read error) is gone', !/payment_link_ky_lead_read_failed/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((err) => { console.error('ky-pay-link-gate test crashed:', err && (err.stack || err.message)); process.exit(1); });
