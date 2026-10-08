/**
 * tests/stripe-connect.test.js — Stripe Connect Express: the pure decisions.
 *
 * Phase 1 created connected accounts and onboarded them, moving no money.
 * PHASE 3 (2026-07-3x) moves the money: tenant payment links are now DESTINATION
 * charges routed to the tenant's own connected account, carrying a platform
 * fee, with a chargeback recovered by reversing the transfer. Every one of
 * those is a decision this module owns and this suite unit-tests, because each
 * is arithmetic that touches somebody's bank account:
 *
 *   - a bad/absent Stripe capability must never read as "enabled"
 *   - two admins clicking Connect must not mint two accounts holding real money
 *   - an out-of-order or TEST-mode account.updated must not flip LIVE state
 *   - requirement VALUES (SSN-class PII) must never be mirrored into Firestore
 *   - mayCollectOnline() — written strict in phase 1 while nothing depended on
 *     it, precisely so the gate lift was a reviewed predicate swap. It now has
 *     two callers (the mint gate + the status mirror) and the containment
 *     section pins that they EXIST, the inverse of what phase 1 pinned.
 *   - platformFeeCents() must never exceed the charge and must fail closed on
 *     anything that is not integer cents
 *   - decideDisputeReversal() must recover the disputed amount and never MORE
 *     than the transfer holds — AMENDED 2026-07-30 (#1146 findings 2 + 6): and
 *     must not recover at all until Stripe has actually DEBITED us, because an
 *     inquiry takes nothing and has no outcome event that would give a
 *     claw-back back. disputeFundsWithdrawn() owns that gate.
 *   - connectTestModeAllowed() must be a strict '1', never truthiness
 *
 * The money PRIMITIVES stay in functions/stripe.js; this handler and this logic
 * module remain accounts-only (containment section below, and the other half of
 * the same boundary in tests/stripe-platform-only-payments.test.js Part 1).
 *
 * Zero deps (the logic module is deliberately firebase-free).
 * Run: node tests/stripe-connect.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require(path.join('..', 'functions', 'stripe-connect-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HANDLER = read('functions/handlers/stripe-connect.js');
// Comment-stripped view. Every NEGATIVE assertion below MUST use this: the
// handler's own comments legitimately mention STRIPE_WEBHOOK_SECRET, req.body,
// companyProfile+chargesEnabled and mayCollectOnline() while explaining why it
// does NOT use them — asserting on raw source makes the prose fail the test.
const decomment = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const CODE = decomment(HANDLER);
const LOGIC = read('functions/stripe-connect-logic.js');
const INDEX = read('functions/index.js');
const RULES = read('firestore.rules');

console.log('STRIPE CONNECT — pure decisions (accounts, capability, fee, disputes)');

// ── deriveConnectState: booleans must FAIL CLOSED ─────────────────────────
console.log('\nderiveConnectState — capability state fails closed');
{
  const full = L.deriveConnectState({
    id: 'acct_123', type: 'express', livemode: true,
    charges_enabled: true, payouts_enabled: true, details_submitted: true,
    country: 'US', default_currency: 'usd',
    capabilities: { card_payments: 'active', transfers: 'active' },
    requirements: { disabled_reason: null, currently_due: [], past_due: [] },
  });
  ok('a fully onboarded account maps through', full.accountId === 'acct_123'
    && full.chargesEnabled === true && full.payoutsEnabled === true
    && full.detailsSubmitted === true && full.livemode === true);

  const empty = L.deriveConnectState({});
  ok('an empty account object yields all-false, never undefined',
    empty.chargesEnabled === false && empty.payoutsEnabled === false
    && empty.detailsSubmitted === false && empty.livemode === false,
    JSON.stringify(empty));
  ok('null/undefined input does not throw',
    L.deriveConnectState(null).chargesEnabled === false
    && L.deriveConnectState(undefined).chargesEnabled === false);

  // Truthy-but-not-true must NOT enable. 'true', 1, {} are the shapes a sloppy
  // mirror or a hand-edited doc produces.
  for (const bad of ['true', 1, {}, [], 'yes']) {
    const s = L.deriveConnectState({ id: 'acct_1', charges_enabled: bad, livemode: bad });
    ok('charges_enabled=' + JSON.stringify(bad) + ' does NOT enable charges',
      s.chargesEnabled === false && s.livemode === false);
  }
}

// ── PII: requirement NAMES yes, VALUES never ──────────────────────────────
console.log('\nPII containment');
{
  const s = L.deriveConnectState({
    id: 'acct_1',
    requirements: {
      currently_due: ['individual.id_number', 'external_account'],
      errors: [{ code: 'verification_failed_other', reason: 'The SSN 123-45-6789 could not be verified' }],
    },
    individual: { id_number: '123-45-6789', ssn_last_4: '6789', email: 'contractor@example.com' },
    external_accounts: { data: [{ last4: '4242' }] },
    tos_acceptance: { ip: '1.2.3.4', user_agent: 'Mozilla' },
  });
  ok('requirement FIELD NAMES are mirrored',
    eq(s.requirementsCurrentlyDue, ['individual.id_number', 'external_account']));
  ok('requirement error CODES are mirrored, not free-text reasons',
    eq(s.requirementsErrorCodes, ['verification_failed_other']));
  const blob = JSON.stringify(s);
  for (const secret of ['123-45-6789', '6789', 'could not be verified', '1.2.3.4', 'Mozilla', '4242']) {
    ok('no PII leak: ' + JSON.stringify(secret) + ' is absent from the mirror',
      blob.indexOf(secret) === -1, blob.slice(0, 160));
  }
  ok('the individual / external_accounts / tos blocks are not mirrored at all',
    !('individual' in s) && !('external_accounts' in s) && !('tos_acceptance' in s));
}

// ── decideAccountCreate: two admins must not mint two accounts ────────────
console.log('\ndecideAccountCreate — the duplicate-account race');
{
  const now = 1_700_000_000_000;
  ok('no row → create', L.decideAccountCreate(null, now).action === 'create');
  ok('row with an accountId → idempotent no-op (never a second account)',
    L.decideAccountCreate({ accountId: 'acct_9' }, now).action === 'existing');
  ok('a FRESH creating claim blocks a concurrent caller',
    L.decideAccountCreate({ status: 'creating', claimedAtMs: now - 1000 }, now).action === 'in_flight');
  ok('a STALE creating claim is surfaced, NOT auto-retried',
    L.decideAccountCreate({ status: 'creating', claimedAtMs: now - (L.CLAIM_STALE_MS + 1) }, now).action === 'stale_claim',
    'auto-retry is the one behaviour that can mint a duplicate holding real money');
  ok('a claim with a garbage timestamp is treated as stale, not in-flight',
    L.decideAccountCreate({ status: 'creating', claimedAtMs: 'nope' }, now).action === 'stale_claim');
  ok('a failed row can be retried',
    L.decideAccountCreate({ status: 'failed' }, now).action === 'create');
  ok('an accountId WINS over a creating status (never re-create over a real account)',
    L.decideAccountCreate({ status: 'creating', claimedAtMs: now, accountId: 'acct_9' }, now).action === 'existing');
}

// ── idempotency key must be companyId-derived and stable ──────────────────
console.log('\naccountIdempotencyKey');
{
  ok('stable across calls', L.accountIdempotencyKey('c1') === L.accountIdempotencyKey('c1'));
  ok('distinct per tenant', L.accountIdempotencyKey('c1') !== L.accountIdempotencyKey('c2'));
  ok('contains the companyId', L.accountIdempotencyKey('c1').indexOf('c1') !== -1);
  ok('the handler passes it as idempotencyKey to accounts.create',
    /idempotencyKey: L\.accountIdempotencyKey\(companyId\)/.test(HANDLER));
  ok('no random/uuid/Date.now key anywhere near account creation',
    !/idempotencyKey:\s*(?:.*(?:random|uuid|Date\.now))/i.test(HANDLER),
    'a fresh key on retry mints a SECOND connected account');
}

// ── decideWebhookApply: order + livemode ──────────────────────────────────
console.log('\ndecideWebhookApply — out-of-order and cross-mode protection');
{
  const stored = { livemode: true, lastAccountEventAt: 1000 };
  ok('a platform event (no event.account) is not applied',
    L.decideWebhookApply(stored, { created: 2000, livemode: true }).reason === 'platform_event');
  ok('an unknown account is not applied',
    L.decideWebhookApply(null, { account: 'acct_x', created: 2000, livemode: true }).reason === 'unknown_account');
  ok('a newer event applies',
    L.decideWebhookApply(stored, { account: 'acct_x', created: 2000, livemode: true }).apply === true);
  ok('an OLDER event is skipped (the seat-reversal class)',
    L.decideWebhookApply(stored, { account: 'acct_x', created: 999, livemode: true }).reason === 'out_of_order');
  ok('a same-second event DOES apply (two real changes can share a timestamp)',
    L.decideWebhookApply(stored, { account: 'acct_x', created: 1000, livemode: true }).apply === true);
  ok('a TEST-mode event must not touch LIVE state',
    L.decideWebhookApply(stored, { account: 'acct_x', created: 2000, livemode: false }).reason === 'livemode_mismatch',
    'one deployed function serves both modes');
  ok('a LIVE event must not touch TEST state',
    L.decideWebhookApply({ livemode: false, lastAccountEventAt: 1 }, { account: 'acct_x', created: 2, livemode: true }).reason === 'livemode_mismatch');
  ok('a first event with no stored watermark applies and sets one',
    L.decideWebhookApply({ livemode: true }, { account: 'acct_x', created: 500, livemode: true }).watermark === 500);
}

// ── mayCollectOnline: the gate-lift predicate ─────────────────────────────
// ASSERTIONS UNCHANGED, PREMISE UPGRADED 2026-07-3x: written in phase 1 while
// nothing depended on it, exactly so the phase-3 lift was a reviewed predicate
// swap. Everything below is now LOAD-BEARING — it decides whether a real
// homeowner's card can be charged for a real tenant.
console.log('\nmayCollectOnline — now load-bearing (the mint and the card both call it)');
{
  const ready = { accountId: 'acct_1', chargesEnabled: true, detailsSubmitted: true, livemode: true, payoutsEnabled: true };
  ok('a live, charges-enabled, onboarded account may collect', L.mayCollectOnline(ready) === true);
  ok('a TEST-mode account may NOT collect in live', L.mayCollectOnline(Object.assign({}, ready, { livemode: false })) === false);
  ok('charges disabled → no', L.mayCollectOnline(Object.assign({}, ready, { chargesEnabled: false })) === false);
  ok('onboarding incomplete → no', L.mayCollectOnline(Object.assign({}, ready, { detailsSubmitted: false })) === false);
  ok('no account id → no', L.mayCollectOnline(Object.assign({}, ready, { accountId: null })) === false);
  ok('a non-acct_ id → no', L.mayCollectOnline(Object.assign({}, ready, { accountId: 'cus_123' })) === false);
  ok('payouts on hold does NOT block collecting (UI warning, not a charge block)',
    L.mayCollectOnline(Object.assign({}, ready, { payoutsEnabled: false })) === true);
  ok('empty/null state → no', L.mayCollectOnline(null) === false && L.mayCollectOnline({}) === false);
  ok('allowTestMode:true is opt-in only (for test-mode QA)',
    L.mayCollectOnline(Object.assign({}, ready, { livemode: false }), { allowTestMode: true }) === true);
}

// ── platformFeeCents: the phase-3 platform fee ────────────────────────────
// NEW 2026-07-3x (phase 3). 340bps + 30 cents = Stripe's 2.9% + 30 cents
// pass-through plus a 0.5% platform margin, charged ONLY on Connect-routed
// tenant mints. Two failure modes are worth arithmetic: a fee that exceeds the
// charge (Stripe rejects the mint, and morally we would be taking the whole
// payment), and a fee computed off a value that is not integer cents.
console.log('\nplatformFeeCents — the fee we are allowed to take');
{
  const cases = [
    [10000, 370],     // $100.00 → $3.70
    [100000, 3430],   // $1,000.00 → $34.30
    [250000, 8530],   // $2,500.00 → $85.30
    [100, 33],        // $1.00 → 33c (the mint's MIN_CENTS floor, disclosed honestly)
    [31, 30],         // clamped to charge-1: never take the whole payment
    [1, 0],           // 1c charge cannot carry a 30c flat fee at all
  ];
  for (const [charge, fee] of cases) {
    ok('platformFeeCents(' + charge + ') === ' + fee, L.platformFeeCents(charge) === fee,
      'got ' + L.platformFeeCents(charge));
  }

  // Fails CLOSED on anything that is not strict integer cents. A string or a
  // fractional value means the caller is confused about units, and guessing
  // charges someone the wrong amount.
  for (const bad of [0, -100, NaN, undefined, null, '10000', 100.5, Infinity, {}]) {
    ok('platformFeeCents(' + JSON.stringify(bad) + ') === 0 (fails closed)',
      L.platformFeeCents(bad) === 0, 'got ' + L.platformFeeCents(bad));
  }

  // The clamp is a backstop, not the normal path — but it must hold across the
  // whole range the mint can reach (MIN_CENTS 100 … MAX_CENTS).
  let spreadOk = true;
  for (let charge = 100; charge <= 5000000; charge = Math.ceil(charge * 1.37)) {
    const f = L.platformFeeCents(charge);
    if (!Number.isInteger(f) || f < 0 || f >= charge) { spreadOk = false; break; }
  }
  ok('across the mintable range the fee is a non-negative integer strictly below the charge',
    spreadOk, 'a fee >= the charge leaves the contractor with nothing (and Stripe rejects it)');

  // The constants are the disclosed price. If they move, the copy on
  // pricing/terms/index/landing and the Settings card is a false claim —
  // tests/stripe-connect-ui.test.js Part 8 couples them.
  ok('the rate constants are the disclosed 3.4% + 30 cents',
    /PLATFORM_FEE_BPS = 340/.test(LOGIC) && /PLATFORM_FEE_FLAT_CENTS = 30/.test(LOGIC));
}

// ── decideDisputeReversal: who eats a chargeback ──────────────────────────
// NEW 2026-07-3x (phase 3). Under destination charges a chargeback debits the
// PLATFORM balance while the money already sits with the contractor. The
// transfer attached to the disputed charge is the only recovery lever. Two
// symmetrical mistakes: not reversing (we eat a job we never did), and
// over-reversing (we take more from the contractor than the homeowner
// disputed). dispute.amount is the FULL charge while the transfer is
// charge-minus-fee, so the clamp is mandatory — an unclamped reversal is an
// API error, not a rounding difference.
//
// This function stays PURE: the double-reversal guard is event-level
// (stripe_events/{event.id} + the dispute-keyed idempotencyKey on the reversal
// call), not a flag in here.
//
// PREMISE AMENDED 2026-07-30 (#1146 findings 2 + 6) — the "two symmetrical
// mistakes" framing above is INCOMPLETE, not wrong. There is a third and it is
// the expensive one: reversing when nobody was debited. The cases in this block
// all describe a dispute whose funds ARE withdrawn; the debit gate itself is
// the next block. Kept separate deliberately — this block is the arithmetic
// (clamp, remainder, fail-closed) and that one is the precondition.
console.log('\ndecideDisputeReversal — recovery, not punishment');
{
  const tr = (over) => Object.assign({ id: 'tr_1', amount: 50000, amount_reversed: 0 }, over || {});
  const d = (amount) => ({ id: 'dp_1', amount });

  const full = L.decideDisputeReversal(d(50000), { transfer: tr() });
  ok('a full dispute reverses the full transfer',
    full.reverse === true && full.transferId === 'tr_1' && full.amountCents === 50000
    && full.reason === 'destination_charge', JSON.stringify(full));

  const partial = L.decideDisputeReversal(d(20000), { transfer: tr() });
  ok('a PARTIAL dispute reverses only the disputed amount',
    partial.reverse === true && partial.amountCents === 20000,
    'over-recovering from the contractor turns a $200 dispute into a $500 clawback');

  const clamped = L.decideDisputeReversal(d(60000), { transfer: tr() });
  ok('a dispute larger than the transfer clamps to the transfer',
    clamped.reverse === true && clamped.amountCents === 50000,
    'dispute.amount is the gross charge; the transfer is charge-minus-fee, so this is the NORMAL case');

  const spent = L.decideDisputeReversal(d(50000), { transfer: tr({ amount_reversed: 50000 }) });
  ok('an already fully-reversed transfer is nothing_to_reverse',
    spent.reverse === false && spent.amountCents === 0 && spent.reason === 'nothing_to_reverse',
    'the Stripe retry path must not error on a second attempt');

  const partlySpent = L.decideDisputeReversal(d(50000), { transfer: tr({ amount_reversed: 30000 }) });
  ok('a partly-reversed transfer clamps to what remains',
    partlySpent.reverse === true && partlySpent.amountCents === 20000);

  const platform = L.decideDisputeReversal(d(50000), { id: 'ch_1' });
  ok('a charge with no transfer is a PLATFORM charge — nothing to reverse',
    platform.reverse === false && platform.transferId === null && platform.reason === 'no_transfer',
    'the platform tenant mints without routing; a reversal attempt there is a bug');

  ok('null/garbage charge → no_transfer',
    L.decideDisputeReversal(d(50000), null).reason === 'no_transfer'
    && L.decideDisputeReversal(d(50000), { transfer: { id: 'ch_nope' } }).reason === 'no_transfer'
    && L.decideDisputeReversal(d(50000), { transfer: 42 }).reason === 'no_transfer');

  for (const bad of [null, undefined, 0, -1, 'lots', 100.5]) {
    const m = L.decideDisputeReversal({ amount: bad }, { transfer: tr() });
    ok('a dispute amount of ' + JSON.stringify(bad) + ' is malformed, never a guess',
      m.reverse === false && m.reason === 'malformed' && m.transferId === 'tr_1',
      JSON.stringify(m));
  }
  ok('a null dispute is malformed (transfer still identified)',
    L.decideDisputeReversal(null, { transfer: tr() }).reason === 'malformed');

  // The charge was retrieved WITHOUT expand:['transfer'] — Stripe returns the
  // id as a bare string. We know which transfer, not how much is left on it, so
  // the caller must OMIT the amount and let Stripe reverse the remainder. That
  // can never over-reverse; guessing the full disputed amount could.
  const unexpanded = L.decideDisputeReversal(d(10000), { transfer: 'tr_9' });
  ok('an UNEXPANDED transfer reverses the remainder (amountCents null, not 0)',
    unexpanded.reverse === true && unexpanded.transferId === 'tr_9' && unexpanded.amountCents === null,
    'amountCents 0 would send amount:0; null means "omit the param"');

  // EVERY case above passes a dispute with NO status and NO balance_transactions,
  // and they all still reverse. That is not an accident of the fixtures — it is
  // the fallback pinned at F3 below. Stated here so the block above is not
  // silently load-bearing on a rule it never mentions.
  ok('the cases above rely on the absent-payload fallback, which reverses',
    L.decideDisputeReversal(d(50000), { transfer: tr() }).reverse === true);
}

// ── disputeFundsWithdrawn + the DEBIT gate ────────────────────────────────
// NEW 2026-07-30 (#1146 audit findings 2 + 6). PREMISE CORRECTION to the block
// above, which was written believing there were only "two symmetrical
// mistakes": not reversing, and over-reversing. There is a THIRD, and it is the
// expensive one — reversing when NOBODY was debited.
//
// An INQUIRY (Amex/Discover retrieval; Stripe status warning_*) is a request
// for information. Stripe withdraws nothing from the platform balance for it,
// and an inquiry can never close 'won' — the card networks send no win message
// — so there is no outcome event that would ever give a claw-back back. On a
// $10k invoice the old unconditional reversal parked ~$9.6k of the contractor's
// money in the platform balance indefinitely, and the contractor ate 100% of it.
//
// The fix is NOT "skip warning_*" alone: that would leave an inquiry that
// ESCALATES with no reversal at all and move the whole loss onto the platform.
// Recovery moved onto the DEBIT — which is why the caller now handles
// charge.dispute.funds_withdrawn as well. Both halves are tested here; the
// two-event lifecycle is tested behaviourally in
// tests/stripe-dispute-branches.test.js (S4).
console.log('\ndisputeFundsWithdrawn — has Stripe actually taken the money?');
{
  const tr = (over) => Object.assign({ id: 'tr_1', amount: 50000, amount_reversed: 0 }, over || {});
  const CH = { transfer: tr() };
  const DEBIT = [{ id: 'txn_1', amount: -60000 }];
  const REINSTATE = [{ id: 'txn_2', amount: 60000 }];
  const dp = (over) => Object.assign({ id: 'dp_1', amount: 50000 }, over || {});

  const INQUIRY_STATUSES = ['warning_needs_response', 'warning_under_review', 'warning_closed'];
  const REAL_STATUSES = ['needs_response', 'under_review', 'lost', 'won'];

  // ── F1. An inquiry must never trigger a claw-back ──────────────────────
  for (const status of INQUIRY_STATUSES) {
    const f = L.disputeFundsWithdrawn(dp({ status, balance_transactions: [] }));
    ok('F1 ' + status + ' → withdrawn:false, inquiry:true',
      f.withdrawn === false && f.inquiry === true, JSON.stringify(f));

    const r = L.decideDisputeReversal(dp({ status, balance_transactions: [] }), CH);
    ok('F1 ' + status + ' does NOT reverse',
      r.reverse === false && r.amountCents === 0, JSON.stringify(r));
    // The reason STRING is an API: functions/stripe.js selects the contractor's
    // recovery copy off it (inquiry_no_debit vs awaiting_withdrawal vs
    // needs_review). Renaming it here silently downgrades a truthful inquiry
    // notice into a "we could not recover, a human is settling it" alarm.
    ok('F1 ' + status + ' → reason inquiry_no_funds_withdrawn',
      r.reason === 'inquiry_no_funds_withdrawn', r.reason);
    ok('F1 ' + status + ' → inquiry:true and the transfer is still identified',
      r.inquiry === true && r.transferId === 'tr_1', JSON.stringify(r));
  }

  ok('F1 the status match is case-insensitive',
    L.decideDisputeReversal(dp({ status: 'WARNING_NEEDS_RESPONSE', balance_transactions: [] }), CH)
      .reason === 'inquiry_no_funds_withdrawn',
    'Stripe sends lowercase, but a normaliser upstream must not be able to re-arm the bug');

  // The deliberate asymmetry, and it is worth stating: a warning_* status wins
  // even if a debit entry is somehow present. An inquiry never debits us, so
  // the array cannot be right; guessing the other way costs the contractor the
  // whole transfer with no path back.
  ok('F1 warning_* refuses even when a debit entry IS present',
    L.decideDisputeReversal(dp({ status: 'warning_needs_response', balance_transactions: DEBIT }), CH)
      .reverse === false,
    'the status short-circuit is load-bearing, not belt-and-braces');

  // ── F2. A real chargeback with the debit on file DOES reverse ──────────
  for (const status of REAL_STATUSES) {
    const f = L.disputeFundsWithdrawn(dp({ status, balance_transactions: DEBIT }));
    ok('F2 ' + status + ' + a negative balance transaction → withdrawn',
      f.withdrawn === true && f.inquiry === false && f.basis === 'balance_transactions',
      JSON.stringify(f));
    const r = L.decideDisputeReversal(dp({ status, balance_transactions: DEBIT }), CH);
    ok('F2 ' + status + ' reverses the clamped amount',
      r.reverse === true && r.amountCents === 50000 && r.reason === 'destination_charge'
      && r.inquiry === false, JSON.stringify(r));
  }

  // ── F3. What the array says, and what its ABSENCE says ─────────────────
  // Empty array on a real status = "not withdrawn YET". Distinct from an
  // inquiry: this one WILL debit us, so the caller's copy must say "not yet"
  // rather than "an inquiry takes nothing", and funds_withdrawn does the work.
  const pending = L.decideDisputeReversal(dp({ status: 'needs_response', balance_transactions: [] }), CH);
  ok('F3 a real dispute with no debit yet → funds_not_yet_withdrawn, not reversed',
    pending.reverse === false && pending.reason === 'funds_not_yet_withdrawn'
    && pending.amountCents === 0, JSON.stringify(pending));
  ok('F3 …and it is NOT flagged as an inquiry (two different waits)',
    pending.inquiry === false,
    'collapsing them tells a contractor an incoming chargeback is only a request for information');

  ok('F3 a reinstatement-only array does not count as a withdrawal',
    L.disputeFundsWithdrawn(dp({ status: 'won', balance_transactions: REINSTATE })).withdrawn === false);
  // Withdrawn THEN reinstated: the debit did happen, so the recovery premise
  // held. Whether it is owed back is the closed branch's business, and it
  // attributes by reversal metadata — not by re-reading this.
  ok('F3 withdrawn-then-reinstated still reads as withdrawn (the debit was real)',
    L.disputeFundsWithdrawn(dp({ status: 'won', balance_transactions: DEBIT.concat(REINSTATE) }))
      .withdrawn === true);

  // ABSENT array → fall back to the status and assume withdrawn. Deliberate
  // direction: a real chargeback must never be left unrecovered because a
  // field was missing from an older payload shape or a hand-built object. The
  // false-positive cost is bounded because warning_* is still caught first.
  const noArray = L.disputeFundsWithdrawn(dp({ status: 'needs_response' }));
  ok('F3 an ABSENT balance_transactions falls back to the status and assumes withdrawn',
    noArray.withdrawn === true && noArray.basis === 'status', JSON.stringify(noArray));
  ok('F3 the fallback never overrides the inquiry rule',
    L.disputeFundsWithdrawn(dp({ status: 'warning_under_review' })).withdrawn === false,
    'a missing array must not turn an inquiry into a claw-back');
  for (const junk of [null, 'yes', 42, {}, true]) {
    ok('F3 a non-array balance_transactions ' + JSON.stringify(junk) + ' falls back to the status',
      L.disputeFundsWithdrawn(dp({ status: 'needs_response', balance_transactions: junk })).basis === 'status');
  }
  ok('F3 a null/absent dispute does not throw',
    L.disputeFundsWithdrawn(null).withdrawn === true && L.disputeFundsWithdrawn(undefined).inquiry === false);

  // ── F4. Precedence between the refusal reasons ─────────────────────────
  // Order matters because each reason renders DIFFERENT copy to the contractor.
  ok('F4 no_transfer outranks the debit gate (a platform charge has no counterparty at all)',
    L.decideDisputeReversal(dp({ status: 'warning_needs_response', balance_transactions: [] }), { id: 'ch_1' })
      .reason === 'no_transfer');
  ok('F4 the debit gate outranks malformed (we never even read an amount we will not use)',
    L.decideDisputeReversal(dp({ status: 'warning_needs_response', amount: 0, balance_transactions: [] }), CH)
      .reason === 'inquiry_no_funds_withdrawn');
  ok('F4 a malformed amount on a WITHDRAWN dispute still fails closed',
    L.decideDisputeReversal(dp({ status: 'needs_response', amount: 0, balance_transactions: DEBIT }), CH)
      .reason === 'malformed');
  ok('F4 an already-exhausted transfer still reads nothing_to_reverse once withdrawn',
    L.decideDisputeReversal(dp({ status: 'needs_response', balance_transactions: DEBIT }),
      { transfer: tr({ amount_reversed: 50000 }) }).reason === 'nothing_to_reverse');

  // ── F5. Shape invariants the caller depends on ─────────────────────────
  // amountCents === null is a COMMAND ("omit the param, reverse the whole
  // remainder"). On a refusal path it must never appear, or a caller that reads
  // the amount before the boolean empties the transfer.
  const everyShape = [
    L.decideDisputeReversal(dp({ status: 'warning_needs_response', balance_transactions: [] }), CH),
    L.decideDisputeReversal(dp({ status: 'needs_response', balance_transactions: [] }), CH),
    L.decideDisputeReversal(dp({ status: 'needs_response', balance_transactions: DEBIT }), CH),
    L.decideDisputeReversal(dp({ status: 'needs_response', amount: 0, balance_transactions: DEBIT }), CH),
    L.decideDisputeReversal(dp({ status: 'needs_response', balance_transactions: DEBIT }), { id: 'ch_1' }),
    L.decideDisputeReversal(dp({ status: 'needs_response', balance_transactions: DEBIT }),
      { transfer: tr({ amount_reversed: 50000 }) }),
    L.decideDisputeReversal(dp({ status: 'needs_response', balance_transactions: DEBIT }), { transfer: 'tr_9' }),
    L.decideDisputeReversal(null, null),
  ];
  const KEYS = ['reverse', 'transferId', 'amountCents', 'reason', 'inquiry'];
  ok('F5 every return carries exactly the same five keys',
    everyShape.every((r) => eq(Object.keys(r).sort(), KEYS.slice().sort())),
    JSON.stringify(everyShape.map((r) => Object.keys(r))));
  ok('F5 every REFUSAL reports amountCents 0 — never null',
    everyShape.filter((r) => r.reverse === false).every((r) => r.amountCents === 0),
    'null means "reverse the full remainder"; on a refusal that is the whole transfer');
  ok('F5 every refusal names a reason and every approval says destination_charge',
    everyShape.every((r) => typeof r.reason === 'string' && r.reason.length > 0
      && (r.reverse === false || r.reason === 'destination_charge')),
    JSON.stringify(everyShape.map((r) => r.reason)));
  ok('F5 inquiry is always a strict boolean (the caller does === true on it)',
    everyShape.every((r) => r.inquiry === true || r.inquiry === false));
}

// ── connectTestModeAllowed: the ONE sanctioned test-mode switch ────────────
// NEW 2026-07-3x (phase 3). This is the single source of mayCollectOnline's
// allowTestMode for BOTH the mint gate (functions/stripe.js) and the status
// mirror (handlers/stripe-connect.js). Strict '1' on purpose: a truthiness read
// turns any stray value — 'false', '0', 'no' — into permission to charge real
// cards against a test-mode account.
console.log('\nconnectTestModeAllowed — strict string, never truthiness');
{
  ok("env NBD_CONNECT_ALLOW_TEST_MODE='1' → true",
    L.connectTestModeAllowed({ NBD_CONNECT_ALLOW_TEST_MODE: '1' }) === true);
  for (const bad of ['true', 'yes', '0', 'false', '', ' 1', '1 ', 1, true, null, undefined]) {
    ok('env value ' + JSON.stringify(bad) + ' → false',
      L.connectTestModeAllowed({ NBD_CONNECT_ALLOW_TEST_MODE: bad }) === false);
  }
  ok('an env with the flag absent → false', L.connectTestModeAllowed({ PATH: '/usr/bin' }) === false);
  ok('undefined/null env → false',
    L.connectTestModeAllowed(undefined) === false && L.connectTestModeAllowed(null) === false);
  ok('the strict === \'1\' comparison lives here, in the shared helper',
    /NBD_CONNECT_ALLOW_TEST_MODE === '1'/.test(LOGIC),
    'both callers route through this module so there is exactly one place to get it wrong');
}

// ── describeConnectStatus ─────────────────────────────────────────────────
console.log('\ndescribeConnectStatus');
{
  ok('no account → not_started', L.describeConnectStatus({}).code === 'not_started');
  ok('account, no details → onboarding_incomplete',
    L.describeConnectStatus({ accountId: 'acct_1' }).code === 'onboarding_incomplete');
  ok('details in, charges pending → verifying (NOT an error)',
    L.describeConnectStatus({ accountId: 'acct_1', detailsSubmitted: true }).code === 'verifying');
  ok('charges on, payouts off → payouts_paused',
    L.describeConnectStatus({ accountId: 'acct_1', detailsSubmitted: true, chargesEnabled: true }).code === 'payouts_paused');
  ok('all on → ready',
    L.describeConnectStatus({ accountId: 'acct_1', detailsSubmitted: true, chargesEnabled: true, payoutsEnabled: true }).code === 'ready');
}

// ── CONTAINMENT: this handler still moves no money ────────────────────────
// REWRITTEN 2026-07-3x (phase 3). The section used to assert that NOBODY moved
// money. Phase 3 moves money — deliberately — so the premise narrows to where
// it moves: the mint and the dispute reversal live in functions/stripe.js and
// this handler stays accounts + webhook only. Reading it should never leave you
// wondering whether it can charge a card. (The same boundary from the other
// side: tests/stripe-platform-only-payments.test.js Part 1 allows the money
// primitives in stripe.js and NOWHERE else under functions/.)
console.log('\nContainment (money lives in stripe.js, not here)');
{
  const STRIPE_JS = decomment(read('functions/stripe.js'));
  const decommented = HANDLER.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const forbidden of ['application_fee', 'on_behalf_of', 'transfer_data', 'paymentLinks.create', 'paymentIntents.create', 'charges.create']) {
    ok('this handler contains no ' + forbidden, decommented.indexOf(forbidden) === -1,
      'phase 3 routes money in functions/stripe.js; this handler remains accounts + webhook only');
  }

  // REWRITTEN (silently-stale): the old assertion pinned
  // `if (!isPlatformTenant(decoded)) {` — the shape of a gate that refused
  // every tenant. That literal SURVIVES phase 3 as the platform fast path, so
  // the assertion would have kept passing while meaning something completely
  // different. What must be true now is that the tenant branch is gated by the
  // shared predicate.
  ok('the tenant mint in stripe.js is gated by mayCollectOnline',
    /mayCollectOnline\(/.test(STRIPE_JS),
    'without the predicate the mint either refuses everyone or routes for anyone');
  ok('the ONLINE_PAYMENTS_UNAVAILABLE refusal survives the lift',
    /ONLINE_PAYMENTS_UNAVAILABLE/.test(STRIPE_JS),
    "the code is kept on purpose — it now means 'capability absent', not 'platform-only', and the"
      + ' client branches on it to null out stale links');

  // REWRITTEN (fired): phase 1 hard-coded onlinePaymentsEnabled:false, so a
  // literal was the honest answer. Phase 3 computes it, and the pin must target
  // the COMPUTED expression in publicState — not the field name. VACUOUS-PASS
  // HAZARD: getConnectStatus's not-started early return still carries a
  // truthful `onlinePaymentsEnabled: false` literal, so /onlinePaymentsEnabled/
  // or even /: false/ would pass against a hard-coded card. (Mutation M14.)
  ok('publicState COMPUTES onlinePaymentsEnabled from mayCollectOnline',
    /onlinePaymentsEnabled:\s*L\.mayCollectOnline\(/.test(HANDLER),
    'a hard-coded value here tells a tenant they can (or cannot) collect regardless of Stripe');

  // INVERTED (fired): phase 1 pinned that mayCollectOnline had NO caller — it
  // was a contract written ahead of its use. Phase 3 pins the opposite: the
  // callers EXIST. Deleting the gate now un-gates tenant money, and deleting
  // the mirror makes the Settings card lie about it.
  ok('mayCollectOnline is CALLED by the mint gate and by the status mirror',
    /mayCollectOnline\(/.test(STRIPE_JS) && /mayCollectOnline\(/.test(CODE),
    'phase 1 pinned that it had no caller; phase 3 pins that it has one in each place');
}

// ── Phase-3 webhook branches (platform-account events) ────────────────────
// NEW 2026-07-3x. Under destination charges the dispute/refund/decline events
// all land on the PLATFORM endpoint — invoiceWebhook — not on the Connect
// endpoint, which stays account.* only. These are source pins, not behaviour:
// the reversal DECISION is unit-tested above; what is pinned here is that the
// decision is actually wired to an event and to a Stripe call.
console.log('\nPhase-3 webhook branches');
{
  const S = decomment(read('functions/stripe.js'));
  const wAt = S.indexOf('exports.invoiceWebhook');
  const W = wAt > -1 ? S.slice(wAt) : '';
  ok('the invoiceWebhook region was located', W.length > 1000);

  const disputeAt = W.indexOf('charge.dispute.created');
  ok('invoiceWebhook handles charge.dispute.created', disputeAt > -1,
    'unregistered/unhandled, a chargeback silently debits the platform and nobody is told');
  ok('the dispute branch consults decideDisputeReversal and then reverses',
    disputeAt > -1
    && W.indexOf('decideDisputeReversal(', disputeAt) > disputeAt
    && W.indexOf('createReversal(', disputeAt) > disputeAt,
    'deciding without reversing is a log line; reversing without deciding over-recovers');

  ok('invoiceWebhook handles charge.refunded', W.indexOf('charge.refunded') > -1);

  const failedAt = W.indexOf('payment_intent.payment_failed');
  ok('invoiceWebhook handles payment_intent.payment_failed', failedAt > -1);
  ok('the decline branch is guarded on OUR mint metadata',
    failedAt > -1 && /meta\.invoiceId/.test(W.slice(failedAt, failedAt + 900)),
    'once registered, Stripe also delivers subscription-billing PI failures here — those belong to'
      + " stripeWebhook's dunning wing, not to an invoice alert");
}

// ── Wiring: deploy discoverability, secrets, rules ────────────────────────
console.log('\nWiring');
{
  // The deploy enumerates functions by grepping `^exports.NAME = onCall|onRequest`
  // in functions/*.js, integrations/*.js, handlers/*.js. A function declared any
  // other way silently never deploys.
  const DEPLOY_RE = /^exports\.([a-zA-Z_][a-zA-Z0-9_]*) *= *(onRequest|onCall)/gm;
  const found = [];
  let m;
  while ((m = DEPLOY_RE.exec(HANDLER)) !== null) found.push(m[1]);
  const expected = ['createConnectAccount', 'createConnectOnboardingLink', 'getConnectStatus', 'createConnectDashboardLink', 'stripeConnectWebhook'];
  for (const fn of expected) {
    ok('deploy scanner can see ' + fn, found.indexOf(fn) !== -1,
      'must be a top-level `exports.NAME = onCall(`/`onRequest(` or it never deploys');
    ok('index.js re-exports ' + fn, new RegExp('exports\\.' + fn + '\\s*=\\s*stripeConnectHandlers\\.' + fn).test(INDEX));
  }

  ok('the Connect webhook uses its OWN signing secret',
    /defineSecret\('STRIPE_CONNECT_WEBHOOK_SECRET'\)/.test(HANDLER));
  ok('it does NOT fall back to the platform webhook secret',
    !/STRIPE_WEBHOOK_SECRET/.test(CODE),
    'accepting a platform-signed payload here would let a replayed event write account state');
  ok('an unset webhook secret fails CLOSED (never "skip verification")',
    /startsWith\('whsec_'\)/.test(HANDLER) && /webhook not configured/.test(HANDLER));
  ok('signature verification pins an explicit 300s tolerance',
    /constructEvent\(req\.rawBody, sig, secret, 300\)/.test(HANDLER));
  ok('rawBody is required with no req.body fallback',
    /Buffer\.isBuffer\(req\.rawBody\)/.test(CODE) && !/req\.body\b/.test(CODE));
  ok('the idempotency marker is DELETED before a 500 (or the retry no-ops)',
    /eventRef\.delete\(\)[\s\S]{0,200}status\(500\)/.test(HANDLER));
  ok('an unknown connected account returns 200, not 500 (no 3-day retry storm)',
    /connect_webhook_unknown_account[\s\S]{0,200}res\.json/.test(HANDLER));

  ok('account state is admin-SDK-only in the rules',
    /match \/connectAccounts\/\{companyId\}[\s\S]{0,400}allow write: if false;/.test(RULES));
  ok('account state is same-tenant readable (a rep needs the capability check)',
    /match \/connectAccounts\/\{companyId\}[\s\S]{0,400}companyId == myCompanyId\(\)/.test(RULES));
  ok('the reverse index is fully client-denied',
    /match \/connectAccountIds\/\{accountId\}[\s\S]{0,200}allow read, write: if false;/.test(RULES));
  ok('Connect state is NOT stored on the browser-writable companyProfile',
    !/companyProfile/.test(CODE) && !/pricing\.connect/.test(CODE));

  // R3-10 (2026-10-06, approved by Jo): Connect payout setup is OWNER only,
  // the same as seats.js. It was owner/company_admin before (#2260).
  ok('account creation is owner-only (requireTeamAdmin ownerOnly)',
    /createConnectAccount = onCall\([\s\S]{0,600}requireTeamAdmin\(request, null, \{ ownerOnly: true \}\)/.test(HANDLER));
  ok('onboarding + dashboard links are owner-only (they authenticate the holder)',
    /createConnectOnboardingLink = onCall\([\s\S]{0,700}requireTeamAdmin\(request, null, \{ ownerOnly: true \}\)/.test(HANDLER)
    && /createConnectDashboardLink = onCall\([\s\S]{0,700}requireTeamAdmin\(request, null, \{ ownerOnly: true \}\)/.test(HANDLER));
  ok('the onboarding link is never persisted (it authenticates the account holder)',
    !/set\([\s\S]{0,120}link\.url/.test(HANDLER) && !/onboardingUrl/.test(HANDLER));
  ok('return/refresh URLs are absolute apex /pro/dashboard (the /pro/settings 404 lesson)',
    /const APEX = 'https:\/\/nobigdealwithjoedeal\.com'/.test(CODE)
    && /APEX \+ '\/pro\/dashboard\?settings=billing&connect=return'/.test(CODE)
    && /APEX \+ '\/pro\/dashboard\?settings=billing&connect=refresh'/.test(CODE));
  ok('the logic module stays firebase-free so it is unit-testable',
    !/require\('firebase/.test(LOGIC) && !/require\('stripe'\)/.test(LOGIC));
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
