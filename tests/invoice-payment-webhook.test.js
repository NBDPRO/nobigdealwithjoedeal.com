/**
 * tests/invoice-payment-webhook.test.js — money-path invariants for the
 * customer-invoice payment reconciliation in functions/stripe.js: the
 * `payment_intent.succeeded` branch's `db.runTransaction(async (tx)` block
 * inside invoiceWebhook (~L1506-1577 as of phase 3 — LINES DRIFT, locate it by
 * the runTransaction anchor, not by number; the stale pointer this header used
 * to carry pointed 200 lines short of the real block).
 *
 * The Cloud Function can't be require()d standalone (onRequest / defineSecret
 * run at module load), so — per the house pattern used by
 * stripe-payment-link-tax.test.js — `creditPayment()` below is a FAITHFUL
 * MIRROR of the db.runTransaction() callback that credits a Stripe payment
 * onto an invoice. If you change that transaction block in stripe.js, mirror
 * it here.
 *
 * What it guards (all money-critical, none previously covered — this is the
 * "invoice-PAYMENT e2e" gap from the Stripe go-live checklist):
 *   • cumulative credit: newPaid = priorPaid + received (a rep's cash deposit
 *     plus a Stripe balance payoff must SUM, never overwrite);
 *   • status/paidAt flip to 'paid' ONLY when the balance reaches zero — a
 *     deposit-sized online payment leaves the invoice open;
 *   • IDEMPOTENCY: a replayed paymentIntent (Stripe retries after a lost ack,
 *     outer catch having deleted the stripe_events marker) must be a true
 *     no-op — no double-credit, no partial wrongly flipped 'paid';
 *   • owner-mismatch: PI metadata that doesn't match the invoice is refused
 *     (Stripe Dashboard metadata is editable by anyone with write access).
 *     REKEYED 2026-07-3x (Connect phase 3): the check is now two-tier —
 *     TENANCY (metadata.companyId vs inv.companyId) when both sides carry it,
 *     falling back to the original createdBy/userId comparison otherwise. Both
 *     tiers are load-bearing: tier 1 stops a cross-tenant claim on a
 *     destination-routed payment, tier 2 keeps every plink_ minted BEFORE this
 *     deploy payable (those links carry only userId, and they are open in
 *     homeowners' inboxes right now);
 *   • append-only payments[] ledger, penny rounding, and balanceDue clamp.
 *
 * Zero deps. Run: node tests/invoice-payment-webhook.test.js
 */
'use strict';

// ── Firestore sentinel models (the mirror resolves these itself) ───────────
const SERVER_TS = Symbol('serverTimestamp');
// arrayUnion(x) applied to a prior array = append-if-absent (dedup).
const arrayUnion = (prior, x) => {
  const a = Array.isArray(prior) ? prior.slice() : [];
  if (!a.includes(x)) a.push(x);
  return a;
};

/**
 * Faithful mirror of the runTransaction callback in stripe.js.
 * @param inv  the invoice doc data, or null to model a missing doc.
 * @param paymentIntent  Stripe PI: { id, amount_received, metadata }.
 *   The claims are read OFF THE METADATA here, exactly as the server does —
 *   passing them as extra args let the mirror disagree with the PI it was
 *   handed, which is the one thing a mirror must not be able to do.
 * @returns { result, update } — result mirrors the txn return value; update is
 *   the field map written via tx.update (null when the credit is skipped).
 */
function creditPayment(inv, paymentIntent) {
  const metadata = paymentIntent.metadata || {};
  const claimedUserId = metadata.userId;
  if (!inv) return { result: { skipped: 'not_found' }, update: null };
  // D5: tenancy tamper check. Phase-3 mints stamp companyId into PI
  // metadata — compare tenancy when both sides have it. Links minted
  // BEFORE the rekey carry only userId: fall back to the original
  // createdBy comparison for those (legacy invoices may also lack
  // companyId). Absent metadata still passes, as before.
  const claimedCompanyId = metadata.companyId;
  if (claimedCompanyId && inv.companyId) {
    if (inv.companyId !== claimedCompanyId) {
      return {
        result: { skipped: 'owner_mismatch', actualCompanyId: inv.companyId, actualCreatedBy: inv.createdBy },
        update: null,
      };
    }
  } else if (claimedUserId && inv.createdBy !== claimedUserId) {
    return { result: { skipped: 'owner_mismatch', actualCreatedBy: inv.createdBy }, update: null };
  }
  const applied = Array.isArray(inv.paidIntentIds) ? inv.paidIntentIds : [];
  if (applied.includes(paymentIntent.id)) return { result: { skipped: 'already_applied' }, update: null };

  const total = Number(inv.total) || 0;
  const receivedCents = Number(paymentIntent.amount_received);
  const received = Number.isFinite(receivedCents) && receivedCents > 0
    ? Math.round(receivedCents) / 100 : 0;
  const priorPaid = Number(inv.amountPaid) || 0;
  const newPaid = Math.round((priorPaid + received) * 100) / 100;
  const newBalanceDue = Math.max(0, Math.round((total - newPaid) * 100) / 100);
  const fullyPaid = newBalanceDue === 0;

  const priorPayments = Array.isArray(inv.payments) ? inv.payments.slice() : [];
  if (received > 0) {
    priorPayments.push({ amount: received, at: new Date(), method: 'stripe', paymentIntentId: paymentIntent.id });
  }
  const update = {
    status: fullyPaid ? 'paid' : (newPaid > 0 ? 'partial' : (inv.status || 'sent')),
    paidAt: fullyPaid ? SERVER_TS : (inv.paidAt || null),
    lastPaymentAt: SERVER_TS,
    payments: priorPayments,
    stripePaymentIntentId: paymentIntent.id,
    paidIntentIds: arrayUnion(inv.paidIntentIds, paymentIntent.id),
    balanceDue: newBalanceDue,
    depositPaid: newPaid >= (Number(inv.depositAmount) || 0),
    amountPaid: newPaid,
    updatedAt: SERVER_TS,
  };
  return { result: { credited: true, fullyPaid, received, newPaid, newBalanceDue, leadId: inv.leadId }, update };
}

// Apply a returned update onto the invoice to get the persisted next state,
// so a follow-up creditPayment() call models a real Stripe retry.
const apply = (inv, update) => (update ? Object.assign({}, inv, update) : inv);
// companyId is optional on purpose: omitting it models a pre-phase-3 plink_,
// which is the shape most open links in the wild still have.
const PI = (id, cents, userId, companyId) => ({
  id, amount_received: cents, metadata: { userId, companyId, invoiceId: 'INV1' },
});

// ── tiny harness (matches the other zero-dep suites) ───────────────────────
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const stripeEntries = (p) => (p || []).filter((e) => e.method === 'stripe');

console.log('INVOICE PAYMENT WEBHOOK — reconciliation invariants');

// A1 — full payment in one shot.
{
  const inv = { createdBy: 'u1', total: 10750, amountPaid: 0, status: 'sent' };
  const { result, update } = creditPayment(inv, PI('pi_1', 1075000, 'u1'));
  ok('A1 credited', result.credited === true);
  ok('A1 amountPaid = 10750', update.amountPaid === 10750);
  ok('A1 balanceDue = 0', update.balanceDue === 0);
  ok('A1 fullyPaid → status paid', result.fullyPaid === true && update.status === 'paid');
  ok('A1 paidAt stamped on full payment', update.paidAt === SERVER_TS);
  ok('A1 one stripe payment entry of 10750', stripeEntries(update.payments).length === 1 && update.payments[0].amount === 10750);
  ok('A1 paidIntentIds records the intent', update.paidIntentIds.join() === 'pi_1');
}

// A2 — deposit-sized online payment must NOT flip the invoice to paid.
{
  const inv = { createdBy: 'u1', total: 10000, amountPaid: 0, status: 'sent' };
  const { result, update } = creditPayment(inv, PI('pi_dep', 300000, 'u1'));
  ok('A2 amountPaid = 3000', update.amountPaid === 3000);
  ok('A2 balanceDue = 7000', update.balanceDue === 7000);
  ok('A2 NOT fullyPaid', result.fullyPaid === false);
  // 2026-10-03: a part payment is 'partial' (as Mark Paid + the ledger write),
  // so the CRM's "Send balance" can bill the rest; still open, still owed.
  ok('A2 status becomes partial (open, not paid)', update.status === 'partial');
  ok('A2 paidAt NOT stamped on partial', update.paidAt === null);
}

// A3 — cash deposit already recorded, Stripe pays the balance: cumulative.
{
  const inv = {
    createdBy: 'u1', total: 10000, amountPaid: 3000, status: 'sent',
    payments: [{ amount: 3000, method: 'cash', at: new Date() }],
  };
  const { result, update } = creditPayment(inv, PI('pi_bal', 700000, 'u1'));
  ok('A3 cumulative amountPaid = 10000 (3000 + 7000)', update.amountPaid === 10000);
  ok('A3 balanceDue = 0 → fullyPaid', update.balanceDue === 0 && result.fullyPaid === true);
  ok('A3 status flips to paid on payoff', update.status === 'paid');
  ok('A3 ledger keeps BOTH payments (cash + stripe)', update.payments.length === 2 && stripeEntries(update.payments).length === 1);
}

// B1 — replay of a FULL payment is an idempotent no-op (double-credit guard).
{
  const inv = { createdBy: 'u1', total: 10750, amountPaid: 0, status: 'sent' };
  const first = creditPayment(inv, PI('pi_1', 1075000, 'u1'));
  const paid = apply(inv, first.update);
  const replay = creditPayment(paid, PI('pi_1', 1075000, 'u1'));
  ok('B1 replay skipped already_applied', replay.result.skipped === 'already_applied');
  ok('B1 replay writes nothing', replay.update === null);
  ok('B1 amountPaid NOT doubled (still 10750)', paid.amountPaid === 10750);
  ok('B1 payments ledger not re-pushed (still 1)', stripeEntries(paid.payments).length === 1);
}

// B2 — replay of a PARTIAL must not wrongly flip it to paid or re-credit.
{
  const inv = { createdBy: 'u1', total: 10000, amountPaid: 0, status: 'sent' };
  const first = creditPayment(inv, PI('pi_dep', 300000, 'u1'));
  const partial = apply(inv, first.update);
  const replay = creditPayment(partial, PI('pi_dep', 300000, 'u1'));
  ok('B2 partial replay skipped', replay.result.skipped === 'already_applied');
  ok('B2 amountPaid still 3000', partial.amountPaid === 3000);
  ok('B2 balanceDue still 7000', partial.balanceDue === 7000);
  ok('B2 status still partial (not flipped to paid)', partial.status === 'partial');
}

// C — tamper defense, REKEYED TO TENANCY (Connect phase 3).
//
// The threat is unchanged: Stripe Dashboard metadata is editable by anyone with
// write access to the account, so PI metadata is a CLAIM, never a fact. What
// changed is what the claim is compared against. Phase-3 mints stamp companyId
// alongside userId, and ownership of an invoice is now TENANCY rather than
// authorship — the owner regenerating a rep's link, or markPaid regenerating
// from any seat, is normal operation. So a userId-only check would refuse
// legitimate same-tenant payments (C3), and a companyId-only check would refuse
// every link minted before this deploy (C6). Both tiers, or the money is either
// stolen or stranded.
{
  const inv = { createdBy: 'owner_real', total: 5000, amountPaid: 0, status: 'sent' };
  const tamper = creditPayment(inv, PI('pi_x', 500000, 'attacker'));
  ok('C1 owner mismatch refused', tamper.result.skipped === 'owner_mismatch');
  ok('C1 no credit written', tamper.update === null);
  // No claimed userId at all → the `claimedUserId &&` short-circuit lets it through.
  const noClaim = creditPayment(inv, PI('pi_y', 500000, undefined));
  ok('C2 absent userId does not trip the guard', noClaim.result.credited === true);

  // C3 — the case the authorship check got WRONG. Same tenant, different uid.
  const teamInv = { companyId: 'C1', createdBy: 'rep1', total: 5000, amountPaid: 0, status: 'sent' };
  const teamPay = creditPayment(teamInv, PI('pi_team', 500000, 'rep2', 'C1'));
  ok('C3 same-tenant mint by a different member → CREDITED', teamPay.result.credited === true,
    'the owner regenerating a rep\'s link is not an intruder — refusing it strands a real payment'
      + ' the homeowner already made');

  // C4 — the case the tenancy check exists for. A matching userId must NOT
  // rescue a cross-tenant claim: tenancy is the stronger statement.
  const cross = creditPayment(teamInv, PI('pi_cross', 500000, 'rep1', 'C2'));
  ok('C4 cross-tenant claim refused even with a matching userId',
    cross.result.skipped === 'owner_mismatch');
  ok('C4 no credit written', cross.update === null);
  ok('C4 the refusal names BOTH actual ids (the log line has to be diagnosable)',
    cross.result.actualCompanyId === 'C1' && cross.result.actualCreatedBy === 'rep1',
    JSON.stringify(cross.result));

  // C5 — legacy invoice with no companyId stamp, paid by a phase-3 link.
  // Neither side can compare tenancy, so the uid fallback carries it.
  const legacyInv = { createdBy: 'u9', total: 5000, amountPaid: 0, status: 'sent' };
  const legacyOk = creditPayment(legacyInv, PI('pi_leg', 500000, 'u9', 'C1'));
  ok('C5 legacy invoice + phase-3 link → CREDITED via the uid fallback',
    legacyOk.result.credited === true);
  const legacyBad = creditPayment(legacyInv, PI('pi_leg2', 500000, 'someone_else', 'C1'));
  ok('C5b the fallback still refuses a mismatched uid',
    legacyBad.result.skipped === 'owner_mismatch',
    'a companyId in metadata must not become a way to bypass the check it replaced');

  // C6 — LOAD-BEARING ACROSS THE DEPLOY. plink_ links minted before this PR
  // carry userId only and are sitting in homeowners' inboxes right now. They
  // must keep paying.
  const preInv = { companyId: 'C1', createdBy: 'u1', total: 5000, amountPaid: 0, status: 'sent' };
  const preLink = creditPayment(preInv, PI('pi_pre', 500000, 'u1'));
  ok('C6 a pre-phase-3 link (no companyId in metadata) still credits',
    preLink.result.credited === true,
    'breaking this strands live payments on links we cannot recall');

  // C7 — neither claim present: today's short-circuit, unchanged.
  const bare = creditPayment(preInv, PI('pi_bare', 500000, undefined));
  ok('C7 no claims at all → credited (unchanged short-circuit)', bare.result.credited === true);

  // C8 — DOCUMENTATION TEST (no behaviour change, and that is the point). Under
  // a destination charge the platform fee nets out of the tenant's SETTLEMENT,
  // not out of the charge: amount_received is still the full homeowner payment.
  // So the ledger credits the FULL amount and the payments[] contract read by
  // money-dashboard.js:61 / analytics-kpi.js:107 / leaderboard.js:110 is
  // untouched. If someone ever "corrects" this to charge-minus-fee, every
  // Connect invoice silently stops reaching zero balance.
  const connectInv = { companyId: 'C1', createdBy: 'u1', total: 1000, amountPaid: 0, status: 'sent' };
  const connectPay = creditPayment(connectInv, PI('pi_conn', 100000, 'u1', 'C1'));
  ok('C8 a Connect-routed payment credits the FULL charge, never charge-minus-fee',
    connectPay.update.amountPaid === 1000 && connectPay.update.balanceDue === 0
    && connectPay.result.fullyPaid === true,
    JSON.stringify({ paid: connectPay.update.amountPaid, bal: connectPay.update.balanceDue }));
  ok('C8 the stripe ledger entry records the gross amount',
    stripeEntries(connectPay.update.payments).length === 1
    && connectPay.update.payments[0].amount === 1000);
}

// D — not-found, malformed amounts, rounding, overpay clamp.
{
  ok('D1 missing invoice → not_found', creditPayment(null, PI('pi_z', 100, 'u1')).result.skipped === 'not_found');

  const inv = { createdBy: 'u1', total: 500, amountPaid: 100, status: 'sent', payments: [{ amount: 100, method: 'cash' }] };
  const nan = creditPayment(inv, PI('pi_nan', undefined, 'u1'));
  ok('D2 non-finite amount_received → received 0', nan.result.received === 0);
  ok('D2 no phantom payments entry pushed', stripeEntries(nan.update.payments).length === 0);
  ok('D2 amountPaid unchanged (100)', nan.update.amountPaid === 100);

  const neg = creditPayment(inv, PI('pi_neg', -5000, 'u1'));
  ok('D3 negative amount_received → received 0, no push', neg.result.received === 0 && stripeEntries(neg.update.payments).length === 0);

  // Float drift: $0.10 prior + $0.20 stripe must be exactly $0.30, balance 0.
  const cents = { createdBy: 'u1', total: 0.30, amountPaid: 0.10, status: 'sent' };
  const drift = creditPayment(cents, PI('pi_c', 20, 'u1'));
  ok('D4 penny rounding: 0.10 + 0.20 === 0.30 (no float drift)', drift.update.amountPaid === 0.30);
  ok('D4 exact payoff → balanceDue 0, fullyPaid', drift.update.balanceDue === 0 && drift.result.fullyPaid === true);

  // Overpayment: balanceDue clamps at 0, amountPaid recorded honestly.
  const over = { createdBy: 'u1', total: 100, amountPaid: 0, status: 'sent' };
  const o = creditPayment(over, PI('pi_o', 15000, 'u1'));
  ok('D5 overpay: balanceDue clamped to 0 (never negative)', o.update.balanceDue === 0);
  ok('D5 overpay: amountPaid recorded as collected (150)', o.update.amountPaid === 150 && o.result.fullyPaid === true);
}

// E — depositPaid flag drives the "deposit received" UI independent of payoff.
{
  const inv = { createdBy: 'u1', total: 10000, amountPaid: 0, status: 'sent', depositAmount: 3000 };
  const meets = creditPayment(inv, PI('pi_d1', 300000, 'u1'));
  ok('E1 payment >= depositAmount → depositPaid true', meets.update.depositPaid === true && meets.result.fullyPaid === false);
  const under = creditPayment(inv, PI('pi_d2', 100000, 'u1'));
  ok('E2 payment < depositAmount → depositPaid false', under.update.depositPaid === false);
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
