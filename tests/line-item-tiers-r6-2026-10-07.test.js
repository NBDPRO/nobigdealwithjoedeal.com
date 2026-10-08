/**
 * tests/line-item-tiers-r6-2026-10-07.test.js
 *
 * Review round 6, R6-2-3 + R6-2-4 (Jo's rule, 2026-10-07 — memory
 * signed-price-rules-2026-10-07, last paragraph):
 *   - The deal room offers other tiers on a LINE-ITEM estimate only when the
 *     estimate carries the per-tier line data needed to rebuild the rows at
 *     that tier (estimates/{id}.tierRows, written by the V2 builder at save).
 *     Otherwise it offers the single built price, and the server refuses a
 *     tier it cannot rebuild (never trusting the page).
 *   - When the homeowner accepts a different tier on a line-item estimate, NO
 *     deposit draft is made until the rep taps "Use it" on the accepted-tier
 *     chip. A "Homeowner picked <tier> — apply it" task lands on the customer
 *     (and so on Home's Today list).
 *   - "Use it" really rebuilds: rows, subtotal, tax, Rounding / Minimum,
 *     O&P, jobValue and the deposit all become the picked tier's — and then
 *     the job spine runs the deal acceptance again, so the signed price is
 *     stamped and the deposit draft follows the deposit rule on the new price.
 *   - Kentucky insurance jobs: the KY hold still applies — nothing due at
 *     signing.
 *
 * Worked example (the lane brief): Good $10,500 / Better $12,000 (the rep's
 * pick) / Best $15,000 with per-tier rows stored. The homeowner accepts Best
 * → no draft, the prompt shows; Use it → rows/total/jobValue $15,000 with the
 * tax and rounding rows consistent; the deposit draft then bills 50% =
 * $7,500. Without per-tier rows the deal room shows only $12,000.
 *
 * Real modules throughout: functions/ by require, the V2 builder and the
 * chip by vm against a fake window. Money compared in cents.
 *
 * Run: node tests/line-item-tiers-r6-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FN = (rel) => require(path.join(ROOT, 'functions', rel));
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}
function section(s) { console.log('\n' + s); }
function safe(fn) { try { return fn(); } catch (e) { return { __threw: String((e && e.stack) || e).slice(0, 400) }; } }
const j = (v) => JSON.stringify(v);
const c = (n) => Math.round(Number(n) * 100);
const sumCents = (rows) => (rows || []).reduce((s, r) => s + c(r.total != null ? r.total : r.amount), 0);

const DAT = FN('deal-accepted-tier.js');
const DDL = FN('deposit-draft-logic.js');
const DR = FN('deposit-rule.js');
const CER = FN('customer-estimate-rows.js');
const IFE = FN('invoice-from-estimate.js');

// ── Fixtures (Ohio cash job; money in dollars, as the docs store it) ──────
const OH = '1 Main St, Cincinnati, OH 45202';
const KY = '100 Kentucky Ave, Fort Thomas, KY 41075';
const row = (code, desc, total) => ({ code, desc, qty: '30.00SQ', rate: '$0.00', total, retailTotal: total, quantity: 30, unit: 'SQ' });
// The three builds, each footing: rows → subtotal, 7% tax, nearest-$25 total.
//   good:   9,800.00 + 686.00 = 10,486.00 → 10,500 (rounding +14.00)
//   better: 11,215.00 + 785.05 = 12,000.05 → 12,000 (rounding −0.05)
//   best:   14,020.00 + 981.40 = 15,001.40 → 15,000 (rounding −1.40)
const BUILD = {
  good: { rows: [row('RFG SHG', 'Shingles', 5800), row('LAB', 'Labor', 4000)], subtotal: 9800, tax: 686, taxRate: 0.07, grandTotal: 10500, minJobApplied: false, overhead: 0, profit: 0, materialMarkupPct: 0.25 },
  better: { rows: [row('RFG SHG', 'Shingles', 7215), row('LAB', 'Labor', 4000)], subtotal: 11215, tax: 785.05, taxRate: 0.07, grandTotal: 12000, minJobApplied: false, overhead: 0, profit: 0, materialMarkupPct: 0.25 },
  best: { rows: [row('RFG SHG', 'Shingles', 10020), row('LAB', 'Labor', 4000)], subtotal: 14020, tax: 981.40, taxRate: 0.07, grandTotal: 15000, minJobApplied: false, overhead: 0, profit: 0, materialMarkupPct: 0.25 },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
function lineItemEstimate(extra, opts) {
  const o = opts || {};
  const b = BUILD.better;
  const est = Object.assign({
    id: 'E1', userId: 'u1', companyId: 'u1', leadId: 'L1', builder: 'v2', priceMode: 'line-item', prices: null,
    tier: 'better', selectedTier: 'better', mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
    deposit: 6000, depositPlan: { depositCents: 600000, totalCents: 1200000 },
  }, clone(b), extra || {});
  if (o.withBuilds !== false) {
    est.tierRows = {
      v: 1,
      basis: { tier: 'better', totalCents: 1200000, rowsKey: DAT.rowsKey ? DAT.rowsKey(est.rows) : null },
      tiers: { good: clone(BUILD.good), best: clone(BUILD.best) },
    };
  }
  return est;
}
const lead = (extra) => Object.assign({ userId: 'u1', companyId: 'u1', primaryEstimateId: 'E1', jobValue: 12000, address: OH, state: 'OH', activeJobId: 'J1' }, extra || {});

// ════════════════════════════════════════════════════════════════════════
section('A. Which tiers a line-item estimate can offer (functions/deal-accepted-tier.js)');
// ════════════════════════════════════════════════════════════════════════
const hasHelpers = typeof DAT.offerableTierPrices === 'function' && typeof DAT.tierBuild === 'function' && typeof DAT.rowsKey === 'function';
ok('deal-accepted-tier.js exports offerableTierPrices / tierBuild / rowsKey / dealTierPrices / tierOffered',
  hasHelpers && typeof DAT.dealTierPrices === 'function' && typeof DAT.tierOffered === 'function');
if (hasHelpers) {
  const withB = lineItemEstimate();
  ok('with per-tier rows stored: Good $10,500 / Better $12,000 / Best $15,000 are offered',
    j(DAT.offerableTierPrices(withB)) === j({ good: 10500, better: 12000, best: 15000 }), j(DAT.offerableTierPrices(withB)));
  const noB = lineItemEstimate(null, { withBuilds: false });
  ok('without per-tier rows: only the built price, Better $12,000', j(DAT.offerableTierPrices(noB)) === j({ better: 12000 }), j(DAT.offerableTierPrices(noB)));
  // The invoice pre-flight's "Save to estimate" (#2295) rewrote the rows + total
  // after the save that stored the builds: they no longer describe this estimate.
  const edited = Object.assign(lineItemEstimate(), { rows: BUILD.better.rows.concat([row('RV', 'Ridge vent', 1000)]), subtotal: 12215, tax: 855.05, grandTotal: 13075 });
  ok('rows edited after the builds were stored → the builds are stale, only the current price is offered',
    j(DAT.offerableTierPrices(edited)) === j({ better: 13075 }) && DAT.tierBuild(edited, 'best') === null, j(DAT.offerableTierPrices(edited)));
  // Same total, different rows (a line re-priced and another added to match):
  // the builds were made beside other rows, so they are stale too.
  const sameTotal = Object.assign(lineItemEstimate(), { rows: [row('RFG SHG', 'Shingles', 7000), row('LAB', 'Labor', 4000), row('RV', 'Ridge vent', 215)] });
  ok('rows changed but the total kept → still stale (the basis covers the rows, not just the total)', DAT.tierBuild(sameTotal, 'best') === null && j(DAT.offerableTierPrices(sameTotal)) === j({ better: 12000 }), j(DAT.offerableTierPrices(sameTotal)));
  const reTiered = Object.assign(lineItemEstimate(), { tier: 'good', selectedTier: 'good' });
  ok('a tier change the builds were not stored for → stale', DAT.tierBuild(reTiered, 'best') === null);
  ok('a tier-priced (per-SQ / prices{}) estimate is not restricted here (null)',
    DAT.offerableTierPrices({ priceMode: 'per-sq', prices: { good: 10500, better: 12000, best: 15000 }, tier: 'better', grandTotal: 12000 }) === null);
  ok('a build with no rows is not a build', DAT.tierBuild(Object.assign(lineItemEstimate(), { tierRows: Object.assign(lineItemEstimate().tierRows, { tiers: { best: { rows: [], grandTotal: 15000 } } }) }), 'best') === null);

  const minted = DAT.dealTierPrices({ economy: 0, good: 10500, better: 12000, best: 15000, beyond: 0 }, noB);
  ok('the accept link a rep mints for a line-item estimate WITHOUT builds prices only Better (the server refuses Good / Best)',
    j(minted) === j({ economy: 0, good: 0, better: 12000, best: 0, beyond: 0 }), j(minted));
  const minted2 = DAT.dealTierPrices({ economy: 0, good: 10500, better: 12000, best: 15000, beyond: 0 }, withB);
  ok('…WITH builds, Good / Better / Best stay priced', j(minted2) === j({ economy: 0, good: 10500, better: 12000, best: 15000, beyond: 0 }), j(minted2));
  const minted3 = DAT.dealTierPrices({ good: 10500, better: 12000, best: 15000 }, { priceMode: 'per-sq', prices: { good: 10500, better: 12000, best: 15000 }, tier: 'better' });
  ok('…a per-SQ estimate keeps every tier', j(minted3) === j({ good: 10500, better: 12000, best: 15000 }));
  ok('tierOffered: Best on the no-builds estimate → refused; Better → allowed; Best with builds → allowed',
    DAT.tierOffered(noB, 'best') === false && DAT.tierOffered(noB, 'better') === true && DAT.tierOffered(withB, 'best') === true);
  ok('tierOffered: no estimate → allowed (nothing to check against)', DAT.tierOffered(null, 'best') === true);
}

// ════════════════════════════════════════════════════════════════════════
section('B. R6-2-3 — the deposit draft waits for "Use it" (functions/deposit-draft-logic.js)');
// ════════════════════════════════════════════════════════════════════════
{
  const est = lineItemEstimate();
  const L = lead();
  // What submitDealAcceptance does first: record the pick beside the rep's tier.
  const plan = DAT.planAcceptedTier({ lead: L, estimate: est, estimateId: 'E1', leadId: 'L1', ownerUid: 'u1', tier: 'best', price: 15000, dealId: 'D1', now: 1 });
  ok('control: a line-item estimate records the pick (recorded-differs) and keeps its rows', plan.reason === 'recorded-differs' && !('rows' in (plan.estimate || {})), plan.reason);
  const est2 = Object.assign({}, est, plan.estimate || {});
  const deal = { estimateId: 'E1', leadId: 'L1', acceptedTier: 'best', acceptedPrice: 15000 };
  const dd = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: L, est: est2, estimateId: 'E1', deal, existingInvoices: [], nowMs: 1 });
  ok('FIXED R6-2-3: homeowner accepted Best $15,000 on a line-item estimate → NO deposit draft (accepted_tier_pending), not $12,000 / $6,000',
    dd.action === 'skip' && dd.reason === 'accepted_tier_pending', j({ action: dd.action, reason: dd.reason, total: dd.invoice && dd.invoice.total }));
  ok('…the skip names the pick for the prompt (Best $15,000, rebuildable)',
    !!dd.pick && dd.pick.tier === 'best' && c(dd.pick.price) === 1500000 && dd.pick.rebuildable === true && dd.pick.current === 'better', j(dd.pick));
  const viaContract = DDL.decideDepositDraft({ leadId: 'L1', event: 'contract_signed', lead: L, est: est2, estimateId: 'E1', existingInvoices: [], nowMs: 1 });
  ok('…a contract signed while the pick is unresolved waits too', viaContract.action === 'skip' && viaContract.reason === 'accepted_tier_pending', viaContract.reason);
  const noRecord = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: L, est, estimateId: 'E1', deal, existingInvoices: [], nowMs: 1 });
  ok('…and when the pick never reached the estimate (best-effort write failed), the deal\'s own tier still holds it', noRecord.action === 'skip' && noRecord.reason === 'accepted_tier_pending', noRecord.reason);
  const noBuilds = Object.assign(lineItemEstimate(null, { withBuilds: false }), plan.estimate || {});
  const ddNo = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: L, est: noBuilds, estimateId: 'E1', deal, existingInvoices: [], nowMs: 1 });
  ok('…a line-item estimate with no builds waits as well, marked not rebuildable', ddNo.action === 'skip' && ddNo.reason === 'accepted_tier_pending' && ddNo.pick && ddNo.pick.rebuildable === false, j(ddNo.pick));
  const kept = Object.assign({}, est2, { acceptedTierDismissed: true });
  const ddKeep = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: L, est: kept, estimateId: 'E1', deal, existingInvoices: [], nowMs: 1 });
  ok('control: after the rep taps "Keep", the draft bills the rep\'s Better $12,000 (50% = $6,000)',
    ddKeep.action === 'create' && c(ddKeep.invoice.total) === 1200000 && c(ddKeep.invoice.depositAmount) === 600000, j({ a: ddKeep.action, r: ddKeep.reason }));
  const same = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: L, est, estimateId: 'E1', deal: Object.assign({}, deal, { acceptedTier: 'better', acceptedPrice: 12000 }), existingInvoices: [], nowMs: 1 });
  ok('control: the homeowner accepted the rep\'s own tier → the draft is made as before', same.action === 'create' && c(same.invoice.total) === 1200000, same.reason);
  const perSq = { userId: 'u1', leadId: 'L1', priceMode: 'per-sq', prices: { good: 10500, better: 12000, best: 15000 }, tier: 'better', selectedTier: 'better', grandTotal: 12000, subtotal: 11215, tax: 785.05, taxRate: 0.07, mode: 'cash', jobId: 'J1', addr: OH };
  const ddSq = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: L, est: perSq, estimateId: 'E1', deal, existingInvoices: [], nowMs: 1 });
  ok('control: a per-SQ estimate is priced at acceptance and still drafts at the accepted $15,000 / $7,500',
    ddSq.action === 'create' && c(ddSq.invoice.total) === 1500000 && c(ddSq.invoice.depositAmount) === 750000, j({ a: ddSq.action, r: ddSq.reason }));
  // The install-day final draft must not bill the rep's tier either.
  const fd = DDL.decideFinalDraft({ leadId: 'L1', lead: Object.assign(lead(), { stage: 'install_done' }), est: est2, estimateId: 'E1', invoices: [], nowMs: 1 });
  ok('the install-day final draft waits for the pick too (accepted_tier_pending)', fd.action === 'skip' && fd.reason === 'accepted_tier_pending', j({ a: fd.action, r: fd.reason }));
  const ft = DDL.finalTask('J1', fd, '2026-10-07');
  ok('…and its task says to apply the homeowner\'s pick first (not "no estimate")', /package/i.test(ft.doc.notes) && !/no estimate/i.test(ft.doc.notes), ft.doc.notes);

  // The prompt.
  ok('deposit-draft-logic exports applyTierTask', typeof DDL.applyTierTask === 'function');
  if (typeof DDL.applyTierTask === 'function') {
    const t = DDL.applyTierTask('E1', dd.pick || { tier: 'best', price: 15000, current: 'better', rebuildable: true }, '2026-10-07');
    ok('the task reads "Homeowner picked Elite — apply it", due today, with the estimate id',
      /Homeowner picked Elite — apply it/.test(t.doc.title) && t.doc.dueDate === '2026-10-07' && t.doc.estimateId === 'E1' && t.doc.done === false && t.id === 'apply-accepted-tier-E1', j(t));
    ok('…and says nothing has been sent and the deposit draft comes after', /Nothing has been sent/.test(t.doc.notes) && /deposit/i.test(t.doc.notes) && /\$15,000/.test(t.doc.notes), t.doc.notes);
    const tNo = DDL.applyTierTask('E1', { tier: 'best', price: 15000, current: 'better', rebuildable: false }, '2026-10-07');
    ok('…a not-rebuildable pick sends the rep to the builder instead', /builder/i.test(tNo.doc.notes), tNo.doc.notes);
  }
}

// ════════════════════════════════════════════════════════════════════════
section('C. R6-2-4 — "Use it" really rebuilds the rows (planUseAcceptedTier)');
// ════════════════════════════════════════════════════════════════════════
ok('deal-accepted-tier.js exports planUseAcceptedTier + applyHomeownerPick', typeof DAT.planUseAcceptedTier === 'function' && typeof DAT.applyHomeownerPick === 'function');
if (typeof DAT.planUseAcceptedTier === 'function') {
  const est = Object.assign(lineItemEstimate(), { acceptedTier: 'best', acceptedPrice: 15000, acceptedDealId: 'D1' });
  const L = lead();
  const p = DAT.planUseAcceptedTier({ lead: L, estimate: est, estimateId: 'E1', depositRule: DR });
  ok('Use it on Best → applied', p.reason === 'applied', p.reason);
  const e3 = Object.assign({}, est, p.estimate || {});
  ok('FIXED R6-2-4: the rows are Best\'s ($10,020 shingles + $4,000 labor), not Preferred\'s',
    j((e3.rows || []).map((r) => [r.code, r.total])) === j([['RFG SHG', 10020], ['LAB', 4000]]), j((e3.rows || []).map((r) => [r.code, r.total])));
  ok('…total $15,000, subtotal $14,020, tax $981.40, tier best — the build\'s own numbers, not a back-out',
    c(e3.grandTotal) === 1500000 && c(e3.subtotal) === 1402000 && c(e3.tax) === 98140 && e3.tier === 'best' && e3.selectedTier === 'best' && e3.acceptedTierApplied === true);
  ok('…the deposit follows the deposit rule on $15,000 (cash ≥ $2,000 → 50% = $7,500)', c(e3.deposit) === 750000 && e3.depositPlan && e3.depositPlan.totalCents === 1500000, j([e3.deposit, e3.depositPlan && e3.depositPlan.totalCents]));
  ok('…the stored builds are cleared (they described Preferred\'s rows)', e3.tierRows === null);
  ok('…and the lead\'s job value becomes $15,000 (primary estimate)', p.lead && c(p.lead.jobValue) === 1500000, j(p.lead));
  const contract = safe(() => CER.buildDisplayRows(e3));
  ok('the contract / estimate link lines foot to $15,000 (rows + tax + rounding)', Array.isArray(contract) && sumCents(contract) === 1500000, Array.isArray(contract) ? sumCents(contract) : j(contract));
  const t = safe(() => IFE.invoiceTotalsFromEstimate(e3, { estimateValue: CER.estimateValue }));
  ok('the invoice lines + tax foot to its $15,000 total (the pay link is not refused)', t && !t.__threw && sumCents(t.items) + c(t.tax) === c(t.total) && c(t.total) === 1500000, j(t && (t.__threw || [sumCents(t.items), t.tax, t.total])));
  const dd = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: Object.assign(L, p.lead), est: e3, estimateId: 'E1', deal: { estimateId: 'E1', leadId: 'L1', acceptedTier: 'best', acceptedPrice: 15000 }, existingInvoices: [], nowMs: 1 });
  ok('then the deposit draft follows: $15,000 total, $7,500 due at signing', dd.action === 'create' && c(dd.invoice.total) === 1500000 && c(dd.invoice.depositAmount) === 750000, j({ a: dd.action, r: dd.reason }));

  const noB = Object.assign(lineItemEstimate(null, { withBuilds: false }), { acceptedTier: 'best', acceptedPrice: 15000 });
  const pNo = DAT.planUseAcceptedTier({ lead: L, estimate: noB, estimateId: 'E1', depositRule: DR });
  ok('no per-tier rows → needs-builder, and nothing is written', pNo.reason === 'needs-builder' && !pNo.estimate && !pNo.lead, j(pNo));
  const moved = Object.assign(lineItemEstimate(), { acceptedTier: 'best', acceptedPrice: 14000 });
  const pMoved = DAT.planUseAcceptedTier({ lead: L, estimate: moved, estimateId: 'E1', depositRule: DR });
  ok('the build no longer matches the price the homeowner accepted → price-moved, nothing written', pMoved.reason === 'price-moved' && !pMoved.estimate, j(pMoved));
  const none = DAT.planUseAcceptedTier({ lead: L, estimate: lineItemEstimate(), estimateId: 'E1', depositRule: DR });
  ok('no pick pending → nothing-pending', none.reason === 'nothing-pending' && !none.estimate);
  const collected = DAT.planUseAcceptedTier({ lead: L, estimate: est, estimateId: 'E1', depositRule: DR, depositCollected: true });
  ok('money already taken → the deposit is kept and flagged', collected.reason === 'applied' && collected.estimate.acceptedTierDepositKept === true && !('deposit' in collected.estimate));
  const nonPrimary = DAT.planUseAcceptedTier({ lead: lead({ primaryEstimateId: 'E9' }), estimate: est, estimateId: 'E1', depositRule: DR });
  ok('a non-primary estimate leaves the job value alone', nonPrimary.reason === 'applied' && nonPrimary.lead === null);
  const perSq = { userId: 'u1', leadId: 'L1', priceMode: 'per-sq', prices: { good: 10500, better: 12000, best: 15000 }, tier: 'better', selectedTier: 'better', grandTotal: 12000, subtotal: 11214.95, tax: 785.05, taxRate: 0.07, acceptedTier: 'best', acceptedPrice: 15000, mode: 'cash' };
  const pSq = DAT.planUseAcceptedTier({ lead: L, estimate: perSq, estimateId: 'E1', depositRule: DR });
  ok('a per-SQ estimate still re-tiers its totals from prices{}', pSq.reason === 'applied' && c(pSq.estimate.grandTotal) === 1500000 && !('rows' in pSq.estimate));

  // Kentucky insurance job: after Use it nothing is due at signing.
  const kyLead = lead({ address: KY, state: 'KY', claimNumber: 'CLM-1', insCarrier: 'State Farm' });
  const kyEst = Object.assign(lineItemEstimate({ addr: KY }), { acceptedTier: 'best', acceptedPrice: 15000 });
  const pKy = DAT.planUseAcceptedTier({ lead: kyLead, estimate: kyEst, estimateId: 'E1', depositRule: DR });
  const kyE3 = Object.assign({}, kyEst, pKy.estimate || {});
  const ddKy = DDL.decideDepositDraft({ leadId: 'L1', event: 'deal_accepted', lead: kyLead, est: kyE3, estimateId: 'E1', deal: { estimateId: 'E1', acceptedTier: 'best', acceptedPrice: 15000 }, existingInvoices: [], nowMs: 1 });
  ok('Kentucky insurance job: Use it rebuilds at Best with $0 due at signing, and the draft is still held (ky_insurance_hold)',
    pKy.reason === 'applied' && c(kyE3.grandTotal) === 1500000 && c(kyE3.deposit) === 0 && ddKy.action === 'skip' && ddKy.reason === 'ky_insurance_hold',
    j({ r: pKy.reason, dep: kyE3.deposit, a: ddKy.action, why: ddKy.reason }));
}

// ════════════════════════════════════════════════════════════════════════
section('D. "Use it" on the server (applyHomeownerPick): owner only, then the spine re-runs');
// ════════════════════════════════════════════════════════════════════════
function fakeDb(docs) {
  const store = clone(docs);
  const writes = [];
  const snap = (p) => ({ exists: p in store, data: () => clone(store[p]) });
  const ref = (p) => ({ path: p, collection: (n) => col(p + '/' + n), id: p.split('/').pop() });
  function col(name) {
    return {
      doc: (id) => ref(name + '/' + id),
      where: (field, op, value) => {
        const q = { name, field, value, limit() { return q; } };
        return { _q: q, limit() { return this; } };
      },
    };
  }
  const query = (q) => ({ docs: Object.keys(store)
    .filter((p) => p.indexOf(q.name + '/') === 0 && p.split('/').length === q.name.split('/').length + 1 && store[p][q.field] === q.value)
    .map((p) => ({ id: p.slice(q.name.length + 1), data: () => clone(store[p]) })) });
  return {
    store, writes,
    doc: (p) => ref(p),
    collection: (n) => col(n),
    runTransaction: async (fn) => {
      const pending = [];
      const tx = {
        get: async (r) => (r._q ? query(r._q) : snap(r.path)),
        update: (r, d) => pending.push(['update', r.path, d]),
        set: (r, d) => pending.push(['set', r.path, d]),
        create: (r, d) => pending.push(['create', r.path, d]),
      };
      const out = await fn(tx);
      pending.forEach(([k, p, d]) => {
        if (k === 'create' && p in store) throw Object.assign(new Error('already exists'), { code: 6 });
        store[p] = k === 'update' ? Object.assign({}, store[p], d) : Object.assign({}, d);
        writes.push([k, p, d]);
      });
      return out;
    },
  };
}
if (typeof DAT.applyHomeownerPick === 'function') {
  (async () => {
    const docs = {
      'leads/L1': lead(),
      'estimates/E1': Object.assign(lineItemEstimate(), { acceptedTier: 'best', acceptedPrice: 15000, acceptedDealId: 'D1' }),
      'leads/L1/tasks/apply-accepted-tier-E1': { title: '🤝 Homeowner picked Elite — apply it', done: false, estimateId: 'E1' },
    };
    const spine = [];
    const deps = { now: () => 1000, recordJobEvent: async (db, args) => { spine.push(args); return { moved: false, duplicate: true }; } };
    let db = fakeDb(docs);
    let r = await DAT.applyHomeownerPick(db, { uid: 'u1', token: {}, estimateId: 'E1' }, deps);
    const e = db.store['estimates/E1'];
    ok('the owner\'s "Use it" applies Best on the server', r && r.ok === true && r.reason === 'applied' && e.tier === 'best' && c(e.grandTotal) === 1500000 && e.rows[0].total === 10020, j(r));
    ok('…the lead\'s job value is $15,000', c(db.store['leads/L1'].jobValue) === 1500000);
    ok('…the "apply it" task is marked done', db.store['leads/L1/tasks/apply-accepted-tier-E1'].done === true);
    ok('…and the job spine re-runs the deal acceptance (deal_D1) so the signed price is stamped and the deposit draft follows',
      spine.length === 1 && spine[0].event === 'deal_accepted' && spine[0].sourceId === 'deal_D1' && spine[0].leadId === 'L1' && spine[0].meta && spine[0].meta.dealId === 'D1', j(spine));

    spine.length = 0; db = fakeDb(docs);
    r = await DAT.applyHomeownerPick(db, { uid: 'stranger', token: {}, estimateId: 'E1' }, deps);
    ok('another user\'s "Use it" is refused, nothing written, no spine run', r && r.ok === false && r.reason === 'not-allowed' && db.writes.length === 0 && spine.length === 0, j(r));
    r = await DAT.applyHomeownerPick(fakeDb(Object.assign({}, docs, { 'estimates/E1': Object.assign({}, docs['estimates/E1'], { companyId: 'co1', userId: 'rep2' }), 'leads/L1': lead({ companyId: 'co1', userId: 'rep2' }) })),
      { uid: 'u9', token: { companyId: 'co1', role: 'viewer' }, estimateId: 'E1' }, deps);
    ok('a company viewer is refused (read-only)', r && r.ok === false && r.reason === 'not-allowed', j(r));
    db = fakeDb(Object.assign({}, docs, { 'estimates/E1': Object.assign({}, docs['estimates/E1'], { companyId: 'co1', userId: 'rep2' }), 'leads/L1': lead({ companyId: 'co1', userId: 'rep2' }) }));
    r = await DAT.applyHomeownerPick(db, { uid: 'boss', token: { companyId: 'co1', role: 'company_admin' }, estimateId: 'E1' }, deps);
    ok('a company admin of the same company may apply it', r && r.ok === true && db.store['estimates/E1'].tier === 'best', j(r));

    spine.length = 0; db = fakeDb(Object.assign({}, docs, { 'estimates/E1': Object.assign(lineItemEstimate(null, { withBuilds: false }), { acceptedTier: 'best', acceptedPrice: 15000, acceptedDealId: 'D1' }) }));
    r = await DAT.applyHomeownerPick(db, { uid: 'u1', token: {}, estimateId: 'E1' }, deps);
    ok('no per-tier rows → needs-builder: nothing written, no spine run', r && r.ok === false && r.reason === 'needs-builder' && db.writes.length === 0 && spine.length === 0, j(r));
    r = await DAT.applyHomeownerPick(fakeDb(docs), { uid: 'u1', token: {}, estimateId: 'bad/id' }, deps);
    ok('a bad estimate id is refused', r && r.ok === false);
  })().then(finishD, (e) => { ok('applyHomeownerPick threw', false, String(e && e.stack)); finishD(); });
} else Promise.resolve().then(finishD); // after the module body (the consts below) has run

function finishD() {
  // ══════════════════════════════════════════════════════════════════════
  section('E. The V2 builder stores per-tier rows and the deal room offers only those (estimate-v2-ui.js)');
  // ══════════════════════════════════════════════════════════════════════
  runV2();
  // ══════════════════════════════════════════════════════════════════════
  section('F. The customer-page chip (accepted-tier-chip.js)');
  // ══════════════════════════════════════════════════════════════════════
  runChip().then(() => {
    // ════════════════════════════════════════════════════════════════════
    section('G. Server wiring (source contract, comments stripped)');
    // ════════════════════════════════════════════════════════════════════
    runSource();
    section('H. deposit-draft.js files the "apply it" task when the draft waits');
    return runDraftIo();
  }).then(() => {
    section('I. The worked example end to end: mint → accept → no draft → Use it → draft (deal-acceptance.js run for real)');
    return runEndToEnd();
  }).then(done, (e) => { ok('suite threw', false, String(e && e.stack)); done(); });
}

// ── E: V2 builder sandbox ────────────────────────────────────────────────
function makeSandbox() {
  const byId = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null, checked: false,
      classList: { add(x) { classes.add(x); }, remove(x) { classes.delete(x); }, contains(x) { return classes.has(x); },
        toggle(x, on) { if (on === undefined ? !classes.has(x) : on) classes.add(x); else classes.delete(x); } },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = { head: el('head'), body: el('body'), createElement: el, getElementById(id) { return byId[id] || null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} };
  const store = {};
  const localStorage = { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } };
  const win = { localStorage, document };
  win.window = win;
  const sandbox = { window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' } };
  vm.createContext(sandbox);
  return { win, sandbox };
}
const V2_FILES = [
  'docs/pro/js/estimate-config.js', 'docs/pro/js/ky-insurance-law.js', 'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js', 'docs/pro/js/roofivent-catalog.js', 'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js', 'docs/pro/js/estimate-catalog-xactimate.js', 'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js', 'docs/pro/js/job-templates.js', 'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/estimate-finalization.js', 'docs/pro/js/estimate-v2-ui.js',
];
function v2Env() {
  const env = makeSandbox();
  V2_FILES.forEach((f) => vm.runInContext(rd(f), env.sandbox, { filename: path.basename(f) }));
  const W = env.win;
  // A tier-priced line: tier reaches a line-item price only through a
  // materialId (EstimateLogic.resolveMaterial(materialId, tier)). Synthetic
  // costs (tests/catalog-cost-seed): Good $60 / Better $90 / Best $140 per SQ.
  const cat = W.NBD_XACT_CATALOG;
  const base = cat.find('RFG 240-TAMKO-TITAN');
  const realFind = cat.find.bind(cat);
  cat.find = (code) => (code === 'TEST TIER-SHINGLE'
    ? Object.assign({}, base, { code: 'TEST TIER-SHINGLE', name: 'Test tier-priced shingle', materialCost: undefined, materialId: 'test_tier_shingle', tier: 'any' })
    : realFind(code));
  W.NBD_PRODUCTS = (W.NBD_PRODUCTS || []).concat([{ id: 'test_tier_shingle', name: 'Test shingle', unit: 'SQ', pricing: { good: { cost: 60, sell: 0 }, better: { cost: 90, sell: 0 }, best: { cost: 140, sell: 0 } } }]);
  return W;
}
function v2Priced(W, edit) {
  const V2 = W.EstimateV2UI._test;
  const st = V2.getState();
  st._reopenedClean = false; st._reopenedDoc = null;
  st.mode = 'line-item'; st.jobMode = 'cash'; st.tier = 'better'; st.county = 'hamilton-oh';
  st.measurements = Object.assign({}, st.measurements, { rawSqft: 2000, pitch: 6, cutUpRoof: false });
  st.scope = [{ code: 'TEST TIER-SHINGLE' }, { code: 'RFG SYN-TAMKO' }];
  st.passThru = []; st.upgrades = []; st.minJobCharge = null;
  if (edit) edit(st);
  const est = V2.effectiveEstimate();
  return { V2, st, est, payload: safe(() => V2.buildSavePayload(est, st)), deal: safe(() => V2.dealPricesFor(est)), totals: W.EstimateV2UI.tierTotals() };
}
function runV2() {
  let W;
  try { W = v2Env(); } catch (e) { ok('V2 builder stack loads', false, String(e && e.stack)); return; }
  const P = v2Priced(W);
  ok('control: the tier-priced line prices each tier differently (Good $5,350 / Better $6,450 / Best $8,325)',
    P.totals.good === 5350 && P.totals.better === 6450 && P.totals.best === 8325, j(P.totals));
  const tr = P.payload && P.payload.tierRows;
  ok('the saved estimate carries per-tier rows (tierRows v1) with the basis it was built on',
    !!tr && tr.v === 1 && tr.basis && tr.basis.tier === 'better' && tr.basis.totalCents === 645000 && (!hasHelpers || tr.basis.rowsKey === DAT.rowsKey(P.payload.rows)), j(tr && tr.basis));
  const tiers = tr && tr.tiers ? Object.keys(tr.tiers).sort() : [];
  ok('…one build per OTHER offered tier — Beyond left out (TAMKO HailGuard lock: this scope has another shingle)',
    j(tiers) === j(['best', 'economy', 'good']), j(tiers));
  const best = tr && tr.tiers && tr.tiers.best;
  ok('…Best\'s build: $8,325 total, its own rows (the shingle line repriced), subtotal + tax + rounding consistent',
    !!best && c(best.grandTotal) === 832500 && Array.isArray(best.rows) && best.rows.length === P.payload.rows.length
      && best.rows[0].code === 'TEST TIER-SHINGLE' && best.rows[0].total > P.payload.rows[0].total
      && Math.abs(c(best.subtotal) + c(best.tax) - c(best.grandTotal)) < 2500, j(best && [best.grandTotal, best.subtotal, best.tax, best.rows.map((r) => r.total)]));
  ok('…the build carries no live per-tier price map (it never makes the estimate "tier-priced")', P.payload && P.payload.prices == null && P.payload.priceMode === 'line-item');
  if (hasHelpers && P.payload && tr) {
    const saved = Object.assign({ userId: 'u1', leadId: 'L1' }, P.payload);
    ok('the server reads the saved builds: offerable = Economy $5,350 / Good $5,350 / Better $6,450 / Best $8,325',
      j(DAT.offerableTierPrices(saved)) === j({ economy: 5350, good: 5350, better: 6450, best: 8325 }), j(DAT.offerableTierPrices(saved)));
    const pick = DAT.planUseAcceptedTier({ lead: { primaryEstimateId: 'E1' }, estimate: Object.assign({}, saved, { acceptedTier: 'best', acceptedPrice: 8325 }), estimateId: 'E1', depositRule: DR });
    ok('…and "Use it" at Best rebuilds to exactly what the builder prices at Best',
      pick.reason === 'applied' && c(pick.estimate.grandTotal) === 832500 && j(pick.estimate.rows.map((r) => r.total)) === j(best.rows.map((r) => r.total)), j(pick.reason));
  }
  ok('the deal room offers exactly those tiers (no Beyond) — FIXED: it no longer offers tiers it cannot rebuild',
    j(P.deal) === j({ economy: 5350, good: 5350, better: 6450, best: 8325 }), j(P.deal));
  // No per-tier variation (the shipping catalog: no line carries a materialId).
  const flat = v2Priced(W, (st) => { st.scope = [{ code: 'RFG 240-TAMKO-TITAN' }, { code: 'RFG SYN-TAMKO' }]; });
  ok('a scope that prices the same at every tier stores no builds (tierRows null) and offers one price',
    flat.payload && flat.payload.tierRows === null && j(Object.keys(flat.deal || {})) === j(['better']), j([flat.payload && flat.payload.tierRows, flat.deal]));
  const ins = v2Priced(W, (st) => { st.jobMode = 'insurance'; });
  ok('an insurance estimate stores no builds and offers only its own package', ins.payload && ins.payload.tierRows === null && j(Object.keys(ins.deal || {})) === j(['better']), j([ins.payload && ins.payload.tierRows, ins.deal]));
  // The builder's state is put back after building the other tiers.
  ok('building the other tiers leaves the builder on Better', P.st.tier === 'better');
}

// ── F: the chip ──────────────────────────────────────────────────────────
async function runChip() {
  const src = rd('docs/pro/js/accepted-tier-chip.js');
  // Node require: pure exports.
  delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/accepted-tier-chip.js'))];
  const C = require(path.join(ROOT, 'docs/pro/js/accepted-tier-chip.js'));
  const est = Object.assign(lineItemEstimate(), { acceptedTier: 'best', acceptedPrice: 15000 });
  const pick = C.pendingPick(lead(), [est]);
  ok('pendingPick: Best $15,000, rebuildable (per-tier rows stored)', !!pick && pick.tier === 'best' && c(pick.price) === 1500000 && pick.rebuildable === true, j(pick && { tier: pick.tier, price: pick.price, rebuildable: pick.rebuildable }));
  const pickNo = C.pendingPick(lead(), [Object.assign(lineItemEstimate(null, { withBuilds: false }), { acceptedTier: 'best', acceptedPrice: 15000 })]);
  ok('pendingPick: no per-tier rows → not rebuildable', !!pickNo && pickNo.rebuildable === false, j(pickNo && pickNo.rebuildable));
  ok('the chip no longer writes the totals itself (usePatch is gone — the server rebuilds)', typeof C.usePatch !== 'function');
  // The tier-build block is the server's, byte for byte.
  const blk = (s) => { const a = s.indexOf('// ── tier-build block'); const b = s.indexOf('// ── end tier-build block ──'); return a < 0 || b < 0 ? '' : s.slice(a, b).split('\n').map((l) => l.trim()).join('\n'); };
  const sb = blk(rd('functions/deal-accepted-tier.js')), cb = blk(src);
  ok('the tier-build block is identical in functions/deal-accepted-tier.js and docs/pro/js/accepted-tier-chip.js', sb.length > 500 && sb === cb, sb.length + ' vs ' + cb.length);

  // In a page: render + tap "Use it".
  const nodes = {};
  const listeners = {};
  const mk = (id) => {
    const n = { id, innerHTML: '', textContent: '', dataset: {}, className: '', parentNode: null, children: [], setAttribute() {}, remove() { delete nodes[id]; } };
    nodes[id] = n; return n;
  };
  const list = mk('estimateList');
  list.parentNode = { insertBefore(n) { nodes[n.id] = n; } };
  const document = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => ({ dataset: {}, setAttribute() {}, remove() { delete nodes[this.id]; } }),
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
  };
  const calls = [];
  const updates = [];
  const toasts = [];
  const win = {
    document,
    addEventListener() {},
    _currentLead: lead(), _customerId: 'L1', _customerEstimates: [Object.assign({}, est)],
    db: {}, doc: (db, a, b) => ({ path: a + '/' + b }),
    updateDoc: async (r, d) => { updates.push([r.path, d]); },
    _functions: {}, _httpsCallable: (f, name) => async (data) => { calls.push([name, data]); return { data: { ok: true, reason: 'applied', price: 15000 } }; },
    showToast: (m, k) => toasts.push([m, k]),
  };
  win.window = win;
  const sandbox = { window: win, document, console, Promise, setTimeout, clearTimeout, Number, String, Object, Math, JSON };
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox, { filename: 'accepted-tier-chip.js' }); } catch (e) { ok('chip loads in a page', false, String(e)); return; }
  const API = win.NBDAcceptedTier;
  API.render();
  const host = nodes.acceptedTierChip;
  const html = host ? host.innerHTML : '';
  ok('the customer card shows "Homeowner picked Elite ($15,000) … apply it" with a Use button', /Homeowner picked <strong>Elite<\/strong>/.test(html) && /apply it/i.test(html) && /data-atc="use"/.test(html), html.slice(0, 300));
  const click = listeners.click;
  if (click) {
    await click({ target: { closest: () => ({ dataset: { atc: 'use' } }) } });
    await new Promise((r) => setTimeout(r, 0));
  }
  ok('tapping Use calls the server (useAcceptedTier) with the estimate id', calls.length === 1 && calls[0][0] === 'useAcceptedTier' && calls[0][1] && calls[0][1].estimateId === 'E1', j(calls));
  ok('…and does not write the estimate from the browser', !updates.some((u) => /^estimates\//.test(u[0])), j(updates));
  // Not rebuildable: no Use button, the builder is named.
  win._customerEstimates = [Object.assign(lineItemEstimate(null, { withBuilds: false }), { acceptedTier: 'best', acceptedPrice: 15000 })];
  API.render();
  const html2 = nodes.acceptedTierChip ? nodes.acceptedTierChip.innerHTML : '';
  ok('no per-tier rows: no "Use" button; the chip says to rebuild at Elite in the builder', !/data-atc="use"/.test(html2) && /builder/i.test(html2) && /data-atc="keep"/.test(html2), html2.slice(0, 300));
}

// ── G: source contract for the onCall / onRequest wiring ──────────────────
function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1'); }
function body(src, name) {
  const start = src.indexOf('exports.' + name + ' =');
  if (start < 0) return '';
  const next = src.indexOf('\nexports.', start + 10);
  return src.slice(start, next < 0 ? src.length : next);
}
function runSource() {
  const src = strip(rd('functions/deal-acceptance.js'));
  const mint = body(src, 'createDealAcceptToken');
  const iPrices = mint.search(/dealTierPrices\(/);
  const iWrite = mint.indexOf('deal_accept_tokens/${token}');
  ok('createDealAcceptToken passes the snapshotted tier prices through dealTierPrices (the estimate decides what can be offered) before the token is written',
    iPrices > 0 && iWrite > iPrices);
  ok('…reading the estimate the acceptance will land on (the deal\'s, else the lead\'s primary)', /primaryEstimateId/.test(mint));
  const sub = body(src, 'submitDealAcceptance');
  const iTx = sub.indexOf('runTransaction');
  const iOffered = sub.search(/tierOffered\(/);
  const iUpd = sub.indexOf('tx.update(');
  ok('submitDealAcceptance refuses a package the estimate cannot rebuild, inside the transaction, before any write',
    iTx > 0 && iOffered > iTx && iUpd > iOffered);
  const use = body(src, 'useAcceptedTier');
  ok('useAcceptedTier is an App-Check-enforced callable that refuses viewers and runs applyHomeownerPick',
    /onCall\(/.test(use) && /enforceAppCheck:\s*true/.test(use) && /assertNotViewer\(/.test(use) && /applyHomeownerPick\(/.test(use) && /recordJobEvent/.test(use));
  const sp = strip(rd('functions/signed-price.js'));
  ok('signed-price.js knownTierPrices vouches for the stored builds (a stale build price is caught like any other)', /offerableTierPrices\(/.test(sp));
  const v2 = rd('docs/pro/js/estimate-v2-ui.js');
  ok('the V2 save always writes tierRows (null clears a stale set — updateDoc merges top-level keys)', /tierRows:\s*_isLiveState\(state\) \? _tierBuildsFor\(estimate\) : null,/.test(v2));
}

// ── H: deposit-draft.js I/O ───────────────────────────────────────────────
async function runDraftIo() {
  let DD;
  try { DD = FN('deposit-draft.js'); } catch (e) { ok('deposit-draft.js loads', false, String(e)); return; }
  const est = Object.assign(lineItemEstimate(), { acceptedTier: 'best', acceptedPrice: 15000, acceptedDealId: 'D1' });
  const db = fakeDb({
    'leads/L1': lead(),
    'deal_rooms/D1': { userId: 'u1', leadId: 'L1', estimateId: 'E1', acceptedTier: 'best', acceptedPrice: 15000, status: 'accepted' },
    'estimates/E1': est,
  });
  const deps = { now: () => Date.parse('2026-10-07T16:00:00Z'), FieldValue: { serverTimestamp: () => 'TS' }, logger: { info() {}, warn() {} } };
  const r = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'deal_accepted', sourceId: 'deal_D1', meta: { dealId: 'D1' } }, deps);
  const inv = Object.keys(db.store).filter((p) => p.indexOf('invoices/') === 0);
  const task = db.store['leads/L1/tasks/apply-accepted-tier-E1'];
  ok('the deal acceptance makes no invoice while the pick waits', r.created === false && r.reason === 'accepted_tier_pending' && inv.length === 0, j(r));
  ok('…and files "Homeowner picked Elite — apply it" on the customer (Today list reads it)', !!task && /Homeowner picked Elite — apply it/.test(task.title) && task.done === false && task.source === 'accepted_tier', j(task));
  const again = await DD.draftDepositAfterSign(db, { leadId: 'L1', event: 'deal_accepted', sourceId: 'deal_D1', meta: { dealId: 'D1' } }, deps);
  ok('…a retry does not file a second task', again.reason === 'accepted_tier_pending' && Object.keys(db.store).filter((p) => /tasks\/apply-accepted-tier/.test(p)).length === 1);
}

// ── I: end to end with the real handlers + job spine on a fake Firestore ──
// (the harness of tests/signed-price-r6-2026-10-07.test.js section F)
async function runEndToEnd() {
  const Module = require('module');
  const NOW = Date.parse('2026-10-07T15:00:00Z');
  // NBD's own tenant: its cash rule (50% at $2,000+) applies with no companyProfile.
  const U = '1phDvAVXHSg82wDLegAbQFq14Ci1';
  const FV = { serverTimestamp: () => ({ __ts: true }), arrayUnion: (...x) => ({ __union: x }), increment: (n) => ({ __inc: n }), delete: () => ({ __del: true }) };
  function makeDb(seed) {
    const cl = (d) => (d === undefined ? undefined : JSON.parse(JSON.stringify(d)));
    const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, cl(v)]));
    const apply = (cur, patch) => {
      const d = Object.assign({}, cur);
      for (const k of Object.keys(patch)) {
        const v = patch[k];
        const keys = k.split('.');
        let o = d;
        for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = Object.assign({}, o[keys[i]] || {}); o = o[keys[i]]; }
        const last = keys[keys.length - 1];
        if (v && v.__union) o[last] = (Array.isArray(o[last]) ? o[last] : []).concat(v.__union);
        else if (v && v.__inc != null) o[last] = (Number(o[last]) || 0) + v.__inc;
        else if (v && v.__del) delete o[last];
        else if (v && v.__ts) o[last] = NOW;
        else o[last] = (v instanceof Date) ? v.getTime() : cl(v);
      }
      return d;
    };
    let seq = 0;
    const ref = (p) => ({
      path: p, id: p.split('/').pop(),
      collection: (cn) => col(p + '/' + cn),
      async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => cl(d) }; },
      async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, apply(store.get(p), patch)); },
      async set(data, opt) { store.set(p, opt && opt.merge ? apply(store.get(p) || {}, data) : apply({}, data)); },
      async create(data) { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, apply({}, data)); },
    });
    const query = (cn, filters, lim) => ({
      where: (f, op, v) => query(cn, filters.concat([[f, op, v]]), lim),
      limit: (n) => query(cn, filters, n),
      orderBy: () => query(cn, filters, lim),
      async get() {
        const docs = [];
        for (const [k, v] of store) {
          const parts = k.split('/');
          if (parts.length !== cn.split('/').length + 1 || !k.startsWith(cn + '/')) continue;
          if (filters.every(([f, op, val]) => (op === 'in' ? val.indexOf(v[f]) !== -1 : v[f] === val))) docs.push({ id: parts[parts.length - 1], data: () => cl(v) });
        }
        const out = docs.slice(0, lim || docs.length);
        return { docs: out, empty: !out.length, size: out.length, forEach: (f) => out.forEach(f) };
      },
    });
    const col = (cn) => Object.assign({ doc: (id) => ref(cn + '/' + (id || ('auto' + (++seq)))), async add(d) { const r = ref(cn + '/auto' + (++seq)); await r.set(d); return r; } }, query(cn, [], 0));
    return {
      store, collection: col, doc: (p) => ref(p),
      async runTransaction(fn) {
        const pending = [];
        const tx = {
          get: (r) => r.get(),
          create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(r.path, apply({}, d)); }),
          set: (r, d, opt) => pending.push(() => { store.set(r.path, opt && opt.merge ? apply(store.get(r.path) || {}, d) : apply({}, d)); }),
          update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); store.set(r.path, apply(store.get(r.path), p)); }),
        };
        const out = await fn(tx);
        const snap = new Map(store);
        try { pending.forEach((f) => f()); } catch (e) { store.clear(); snap.forEach((v, k) => store.set(k, v)); throw e; }
        return out;
      },
    };
  }
  let db = makeDb({});
  const fakeFirestore = { getFirestore: () => db, FieldValue: FV, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }), now: () => ({ toMillis: () => NOW }) } };
  const fakeStorage = { getStorage: () => ({ bucket: () => ({ file: () => ({ download: async () => { throw new Error('no storage in test'); }, save: async () => {} }) }) }) };
  const fakeRate = { httpRateLimit: async () => true, enforceRateLimit: async () => {}, clientIp: () => '203.0.113.9' };
  const rateFile = path.join(ROOT, 'functions', 'integrations', 'upstash-ratelimit.js');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'firebase-admin/firestore') return fakeFirestore;
    if (request === 'firebase-admin/storage') return fakeStorage;
    if (request === 'firebase-admin/auth') return { getAuth: () => ({}) };
    try { if (Module._resolveFilename(request, parent, isMain) === rateFile) return fakeRate; } catch (_) { /* not a path */ }
    return origLoad.apply(this, arguments);
  };
  try {
    let DA = null;
    try { DA = require(path.join(ROOT, 'functions', 'deal-acceptance.js')); } catch (e) { ok('loads functions/deal-acceptance.js with the fakes', false, e && e.message); return; }
    const submit = async (body) => {
      const res = { code: 200, body: null, headers: {}, statusCode: 200,
        status(n) { this.code = n; this.statusCode = n; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
        set() { return this; }, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, end() { return this; }, vary() { return this; }, on() {}, once() {}, removeListener() {} };
      const rq = { method: 'POST', body, headers: { 'user-agent': 'test' }, get: (h) => (/user-agent/i.test(h) ? 'test' : ''), header: () => '', ip: '203.0.113.9', path: '/api/deal-accept', url: '/api/deal-accept' };
      await DA.submitDealAcceptance(rq, res);
      return res;
    };
    const mint = async () => {
      try { return await DA.createDealAcceptToken.run({ auth: { uid: U, token: {} }, data: { dealId: 'DEAL0001' }, rawRequest: { headers: {} } }); }
      catch (e) { return { __err: e && e.message }; }
    };
    const sig = 'data:image/png;base64,' + 'A'.repeat(400);
    const leadDoc = { userId: U, companyId: U, primaryEstimateId: 'E1', address: OH, state: 'OH', activeJobId: 'J1', firstName: 'Pat', jobType: 'cash', stage: 'estimate_sent', jobValue: 12000 };
    const estDoc = (withBuilds) => Object.assign(lineItemEstimate({ userId: U, companyId: U }, { withBuilds }), {});
    const dealDoc = { userId: U, leadId: 'L1', estimateId: 'E1', status: 'sent', customerName: 'Pat', tiers: { good: { price: 10500 }, better: { price: 12000 }, best: { price: 15000 } } };
    const invoicesOf = () => [...db.store.keys()].filter((k) => k.indexOf('invoices/') === 0).map((k) => db.store.get(k));

    // 1. No per-tier rows: the link offers only Better; Best is refused.
    db = makeDb({ 'leads/L1': leadDoc, 'estimates/E1': estDoc(false), 'deal_rooms/DEAL0001': dealDoc });
    let m = await mint();
    let tok = m && m.token ? db.store.get('deal_accept_tokens/' + m.token) : null;
    ok('no per-tier rows: the minted link prices only Better $12,000 (Good / Best at 0)',
      !!tok && tok.tierPrices.better === 12000 && tok.tierPrices.best === 0 && tok.tierPrices.good === 0, m && m.__err ? m.__err : j(tok && tok.tierPrices));
    db.store.set('deal_accept_tokens/LEGACYTOKEN1234', { dealId: 'DEAL0001', ownerUid: U, companyId: U, leadId: 'L1', status: 'pending', tierPrices: { good: 10500, better: 12000, best: 15000 }, expiresAt: null });
    let r = await submit({ token: 'LEGACYTOKEN1234', tier: 'best', signature: sig, consent: true, financing: -1 });
    ok('a link minted before this rule offering Best is refused by the server (400), nothing written',
      r.code === 400 && db.store.get('deal_accept_tokens/LEGACYTOKEN1234').status === 'pending' && db.store.get('deal_rooms/DEAL0001').status === 'sent' && invoicesOf().length === 0, j({ code: r.code, body: r.body }));

    // 2. With per-tier rows: Best is offered; the homeowner accepts it.
    db = makeDb({ 'leads/L1': leadDoc, 'estimates/E1': estDoc(true), 'deal_rooms/DEAL0001': dealDoc });
    m = await mint();
    tok = m && m.token ? db.store.get('deal_accept_tokens/' + m.token) : null;
    ok('with per-tier rows: the link prices Good $10,500 / Better $12,000 / Best $15,000', !!tok && tok.tierPrices.good === 10500 && tok.tierPrices.better === 12000 && tok.tierPrices.best === 15000, m && m.__err ? m.__err : j(tok && tok.tierPrices));
    if (!tok) return;
    r = await submit({ token: m.token, tier: 'best', signature: sig, consent: true, financing: -1 });
    let est = db.store.get('estimates/E1');
    ok('the homeowner accepts Best $15,000: accepted, recorded beside Preferred', r.code === 200 && db.store.get('deal_rooms/DEAL0001').acceptedPrice === 15000 && est.acceptedTier === 'best' && est.tier === 'better', j({ code: r.code, body: r.body }));
    ok('FIXED R6-2-3: NO deposit draft is made (not $12,000 / $6,000)', invoicesOf().length === 0, j(invoicesOf().map((i) => [i.total, i.depositAmount])));
    ok('…no signed price is stamped yet (the rows are still Preferred\'s)', !est.signedPrice);
    const task = db.store.get('leads/L1/tasks/apply-accepted-tier-E1');
    ok('…and "Homeowner picked Elite — apply it" is on the customer', !!task && /Homeowner picked Elite — apply it/.test(task.title) && task.done === false, j(task));

    // 3. The rep taps Use it.
    let u = null;
    try { u = await DA.useAcceptedTier.run({ auth: { uid: U, token: {} }, data: { estimateId: 'E1' }, rawRequest: { headers: {} } }); } catch (e) { u = { __err: e && e.message }; }
    est = db.store.get('estimates/E1');
    ok('Use it → applied: the estimate is Best, $15,000, Best\'s rows', !!u && u.ok === true && est.tier === 'best' && c(est.grandTotal) === 1500000 && est.rows[0].total === 10020, j(u));
    ok('…jobValue $15,000', c(db.store.get('leads/L1').jobValue) === 1500000);
    ok('…the signed price is stamped at $15,000 (billing reads it via signedView)', !!est.signedPrice && est.signedPrice.totalCents === 1500000, j(est.signedPrice && est.signedPrice.totalCents));
    const inv = invoicesOf();
    ok('…and the deposit draft follows the deposit rule on $15,000: total $15,000, $7,500 due at signing, still a draft',
      inv.length === 1 && c(inv[0].total) === 1500000 && c(inv[0].depositAmount) === 750000 && inv[0].status === 'draft', j(inv.map((i) => [i.total, i.depositAmount, i.status])));
    ok('…its lines + tax foot to the total', inv.length === 1 && sumCents(inv[0].items) + c(inv[0].tax) === c(inv[0].total), j(inv[0] && [sumCents(inv[0].items), inv[0].tax, inv[0].total]));
    ok('…the "apply it" task is done', db.store.get('leads/L1/tasks/apply-accepted-tier-E1').done === true);
    let u2 = null;
    try { u2 = await DA.useAcceptedTier.run({ auth: { uid: U, token: {} }, data: { estimateId: 'E1' }, rawRequest: { headers: {} } }); } catch (e) { u2 = { __err: e && e.message }; }
    ok('a second tap changes nothing (nothing-pending), still one invoice', !!u2 && u2.ok === false && u2.reason === 'nothing-pending' && invoicesOf().length === 1, j(u2));
    let u3 = null;
    try { u3 = await DA.useAcceptedTier.run({ auth: { uid: 'someone-else', token: {} }, data: { estimateId: 'E1' }, rawRequest: { headers: {} } }); } catch (e) { u3 = { code: e && e.code }; }
    ok('another user is refused (permission-denied)', !!u3 && u3.code === 'permission-denied', j(u3));
  } finally {
    Module._load = origLoad;
  }
}

function done() {
  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
}
