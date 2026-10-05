/**
 * tests/deal-accepted-tier-2026-10-03.test.js
 *
 * The homeowner's accepted deal-room package never reached the estimate or
 * the lead: submitDealAcceptance only filled the install date. Now
 * functions/deal-accepted-tier.js:
 *   - estimate with NO tier yet → tier + price written onto it, and the
 *     lead's jobValue follows (when it is the primary estimate);
 *   - estimate WITH a tier → never overwritten; acceptedTier/acceptedPrice
 *     recorded beside it, and the customer page offers a one-tap
 *     "Homeowner picked X — use it?" (docs/pro/js/accepted-tier-chip.js).
 * Drives the transaction with a fake Firestore.
 *
 * Run: node tests/deal-accepted-tier-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const ROOT = path.join(__dirname, '..');
let T = null, C = null;
try { T = require(path.join(ROOT, 'functions', 'deal-accepted-tier.js')); } catch (e) { /* red below */ }
try { C = require(path.join(ROOT, 'docs', 'pro', 'js', 'accepted-tier-chip.js')); } catch (e) { /* red below */ }

function fakeDb(docs) {
  const store = JSON.parse(JSON.stringify(docs));
  const writes = [];
  const snap = (p) => ({ exists: p in store, data: () => JSON.parse(JSON.stringify(store[p])) });
  // collection(name).where(field, '==', v) → tx.get returns { docs } (the
  // admin SDK's transaction query read).
  const query = (q) => ({ docs: Object.keys(store)
    .filter((p) => p.indexOf(q.name + '/') === 0 && store[p][q.field] === q.value)
    .map((p) => ({ id: p.slice(q.name.length + 1), data: () => JSON.parse(JSON.stringify(store[p])) })) });
  const db = {
    store, writes,
    doc: (p) => ({ path: p }),
    collection: (name) => ({ where: (field, op, value) => ({ _q: { name, field, value } }) }),
    runTransaction: async (fn) => {
      const pending = [];
      const tx = {
        get: async (ref) => (ref._q ? query(ref._q) : snap(ref.path)),
        update: (ref, data) => pending.push([ref.path, data]),
      };
      const r = await fn(tx);
      pending.forEach(([p, d]) => { store[p] = Object.assign({}, store[p], d); writes.push([p, d]); });
      return r;
    },
  };
  return db;
}
const NOW = new Date('2026-10-03T16:00:00Z');
const info = (extra) => Object.assign({ dealId: 'D1', leadId: 'L1', ownerUid: 'u1' }, extra);

(async () => {
  console.log('\ndeal-room accepted tier → estimate + lead\n');
  ok('functions/deal-accepted-tier.js exports applyAcceptedTier', !!(T && T.applyAcceptedTier && T.planAcceptedTier));
  if (T && T.applyAcceptedTier) {
    // 1. no tier chosen yet → written on the estimate + job value
    {
      const db = fakeDb({
        'leads/L1': { userId: 'u1', jobValue: 0, primaryEstimateId: 'E1' },
        'deal_rooms/D1': { userId: 'u1', leadId: 'L1', estimateId: null },
        'estimates/E1': { userId: 'u1', leadId: 'L1', grandTotal: 0 },
      });
      const r = await T.applyAcceptedTier(db, info(), 'best', 21450, { now: () => NOW });
      const e = db.store['estimates/E1'], l = db.store['leads/L1'];
      ok('no tier on the estimate → reason applied', r === 'applied', r);
      ok('…the estimate takes the accepted tier and price', e.tier === 'best' && e.selectedTier === 'best' && e.grandTotal === 21450 && e.acceptedTier === 'best' && e.acceptedTierApplied === true);
      ok('…and the lead job value follows (primary estimate)', l.jobValue === 21450 && l.acceptedTier === 'best' && l.acceptedPrice === 21450);
    }
    // 2. rep already chose a tier → never overwritten, recorded beside it
    {
      const db = fakeDb({
        'leads/L1': { userId: 'u1', jobValue: 18000, primaryEstimateId: 'E1' },
        'deal_rooms/D1': { userId: 'u1' },
        'estimates/E1': { userId: 'u1', leadId: 'L1', selectedTier: 'better', tier: 'better', grandTotal: 18000, prices: { better: 18000, best: 21450 } },
      });
      const r = await T.applyAcceptedTier(db, info(), 'best', 21450, { now: () => NOW });
      const e = db.store['estimates/E1'], l = db.store['leads/L1'];
      ok('a chosen tier → reason recorded-differs', r === 'recorded-differs', r);
      ok('…the rep\'s tier and total are untouched', e.selectedTier === 'better' && e.tier === 'better' && e.grandTotal === 18000);
      ok('…the pick is recorded beside it', e.acceptedTier === 'best' && e.acceptedPrice === 21450 && !e.acceptedTierApplied);
      ok('…the lead job value is untouched', l.jobValue === 18000 && l.acceptedTier === 'best');
      // The customer-page chip offers the one tap.
      ok('accepted-tier-chip.js loads', !!(C && C.pendingPick));
      if (C && C.pendingPick) {
        const est = Object.assign({ id: 'E1' }, e);
        const pick = C.pendingPick(l, [est]);
        ok('the chip offers "Homeowner picked Elite"', pick && pick.tier === 'best' && pick.price === 21450 && C.tierLabel(pick.tier) === 'Elite');
        const w = C.usePatch(l, pick);
        ok('"Use it" sets the estimate tier + total and the primary job value', w.estimate.tier === 'best' && w.estimate.selectedTier === 'best' && w.estimate.grandTotal === 21450 && w.lead && w.lead.jobValue === 21450);
        ok('…once adopted, the chip goes away', C.pendingPick(l, [Object.assign({}, est, w.estimate)]) === null);
        ok('…"Keep" dismisses it too', C.pendingPick(l, [Object.assign({}, est, { acceptedTierDismissed: true })]) === null);
        ok('a non-primary estimate\'s "Use it" leaves the job value alone', C.usePatch({ primaryEstimateId: 'E9' }, pick).lead === null);
      }
    }
    // 3. same tier → recorded, no prompt
    {
      const db = fakeDb({
        'leads/L1': { userId: 'u1', jobValue: 18000, primaryEstimateId: 'E1' },
        'estimates/E1': { userId: 'u1', leadId: 'L1', selectedTier: 'better', grandTotal: 18000 },
      });
      const r = await T.applyAcceptedTier(db, info({ dealId: 'NOPE' }), 'better', 18000, { now: () => NOW });
      ok('the same tier → same-tier, nothing to ask', r === 'same-tier' && (!C || C.pendingPick(db.store['leads/L1'], [Object.assign({ id: 'E1' }, db.store['estimates/E1'])]) === null));
    }
    // 4. guards
    {
      const db = fakeDb({ 'leads/L1': { userId: 'someone-else' }, 'estimates/E1': { userId: 'u1', leadId: 'L1' } });
      ok('another owner\'s lead → not-owner, no writes', (await T.applyAcceptedTier(db, info(), 'best', 1000, {})) === 'not-owner' && db.writes.length === 0);
      const db2 = fakeDb({ 'leads/L1': { userId: 'u1', primaryEstimateId: 'E1' }, 'estimates/E1': { userId: 'intruder', leadId: 'L1' } });
      const r2 = await T.applyAcceptedTier(db2, info(), 'best', 1000, { now: () => NOW });
      ok('an estimate that is not the owner\'s is never written', r2 === 'no-estimate' && !db2.writes.some(([p]) => p === 'estimates/E1'));
      const db3 = fakeDb({ 'leads/L1': { userId: 'u1', jobValue: 15000 } });
      ok('no estimate + a job value already set → job value kept', (await T.applyAcceptedTier(db3, info(), 'good', 9000, { now: () => NOW })) === 'no-estimate' && db3.store['leads/L1'].jobValue === 15000);
      const db4 = fakeDb({ 'leads/L1': { userId: 'u1' } });
      await T.applyAcceptedTier(db4, info(), 'good', 9000, { now: () => NOW });
      ok('no estimate + no job value → filled from the accepted price', db4.store['leads/L1'].jobValue === 9000);
      ok('a bad tier writes nothing', T.planAcceptedTier({ lead: { userId: 'u1' }, ownerUid: 'u1', tier: 'platinum', price: 5 }).reason === 'bad-tier');
      const boom = { doc: (p) => ({ path: p }), runTransaction: async () => { throw new Error('unavailable'); } };
      ok('a Firestore failure never throws into the acceptance', (await T.applyAcceptedTier(boom, info(), 'best', 1, {})) === 'error');
      const db5 = fakeDb({
        'leads/L1': { userId: 'u1', jobValue: 7000, primaryEstimateId: 'E0' },
        'deal_rooms/D1': { estimateId: 'E1' },
        'estimates/E1': { userId: 'u1', leadId: 'L1' },
      });
      const r5 = await T.applyAcceptedTier(db5, info(), 'best', 12000, { now: () => NOW });
      ok('the deal\'s own untiered estimate (not the primary) takes the tier, job value kept', r5 === 'applied-estimate-only' && db5.store['estimates/E1'].tier === 'best' && db5.store['leads/L1'].jobValue === 7000);
      const db6 = fakeDb({ 'leads/L1': { userId: 'u1', primaryEstimateId: 'E1' }, 'estimates/E1': { userId: 'u1', leadId: 'L1', tierApplies: false } });
      ok('a template estimate with no roofing tier is recorded, not re-tiered', (await T.applyAcceptedTier(db6, info(), 'best', 12000, { now: () => NOW })) !== 'applied' && !db6.store['estimates/E1'].tier);
    }
  }

  // ── 2026-10-05 bug #10 (Jo: recompute all three) ──────────────────────
  // Accepting a tier onto a tier-less estimate moves subtotal, tax AND the
  // deposit with the total. Dollars below are worked by hand from the rule:
  //   tax = total × rate / (1 + rate) (rounded to the cent), subtotal = total − tax;
  //   cash ≥ $2,000 → 50% deposit (to the $25 step); cash < $2,000 → none;
  //   insurance → deductible (+ ACV check when known); Kentucky insurance → $0.
  console.log('\nbug #10 — subtotal, tax and deposit follow the accepted tier\n');
  if (T && T.applyAcceptedTier) {
    const DR = require(path.join(ROOT, 'functions', 'deposit-rule.js'));
    const KY = '1944 Kentucky Ave, Fort Thomas, KY 41075';
    const OH = '1 Main St, Cincinnati, OH 45202';
    const cashEst = () => ({ userId: 'u1', leadId: 'L1', grandTotal: 10000, subtotal: 9300, tax: 700, taxRate: 0.07527, deposit: 5000,
      depositPlan: DR.toStored(DR.compute({ total: 10000, mode: 'cash' })) });
    const run = async (est, tier, price, extra, lead) => {
      const db = fakeDb(Object.assign({
        'leads/L1': Object.assign({ userId: 'u1', primaryEstimateId: 'E1' }, lead || {}),
        'deal_rooms/D1': { estimateId: 'E1' },
        'estimates/E1': est,
      }, extra || {}));
      const r = await T.applyAcceptedTier(db, info(), tier, price, { now: () => NOW });
      return { r, db, e: db.store['estimates/E1'], l: db.store['leads/L1'] };
    };

    // Higher tier, cash: $10,000 → Best $15,000.
    // tax 15,000 × .07527 / 1.07527 = 1,050.0153 → $1,050.02; subtotal $13,949.98; deposit 50% = $7,500.
    {
      const { r, e, l } = await run(cashEst(), 'best', 15000);
      ok('higher tier (cash $10,000 → $15,000): applied, total $15,000', r === 'applied' && e.grandTotal === 15000 && l.jobValue === 15000, r);
      ok('…subtotal $13,949.98 + tax $1,050.02 = the total exactly', e.subtotal === 13949.98 && e.tax === 1050.02 && Math.round((e.subtotal + e.tax) * 100) === 1500000, JSON.stringify([e.subtotal, e.tax]));
      ok('…deposit $5,000 → $7,500 and the stored plan is on $15,000', e.deposit === 7500 && e.depositPlan.depositCents === 750000 && e.depositPlan.totalCents === 1500000 && /\$7,500 due at signing/.test(e.depositPlan.summary) && e.acceptedTierDepositKept === false, JSON.stringify([e.deposit, e.depositPlan]));
    }
    // Lower tier, cash: $10,000 → Standard $8,000.
    // tax 8,000 × .07527 / 1.07527 = 560.0082 → $560.01; subtotal $7,439.99; deposit 50% = $4,000.
    {
      const { r, e } = await run(cashEst(), 'good', 8000);
      ok('lower tier (cash $10,000 → $8,000): subtotal $7,439.99, tax $560.01, deposit $4,000', r === 'applied' && e.grandTotal === 8000 && e.subtotal === 7439.99 && e.tax === 560.01 && e.deposit === 4000 && e.depositPlan.depositCents === 400000, JSON.stringify([e.subtotal, e.tax, e.deposit]));
    }
    // Lower tier under the $2,000 cash line: Economy $1,800 → no deposit.
    // tax 1,800 × .07527 / 1.07527 = 126.0018 → $126.00; subtotal $1,674.00.
    {
      const { e } = await run(cashEst(), 'economy', 1800);
      ok('lower tier under $2,000 (cash $1,800): deposit $5,000 → $0, payment on completion', e.deposit === 0 && e.depositPlan.depositCents === 0 && e.tax === 126 && e.subtotal === 1674, JSON.stringify([e.deposit, e.tax, e.subtotal]));
    }
    // Insurance (Ohio) with a deductible: no tax; the deposit stays the
    // deductible + ACV rule on the new total.
    {
      const est = { userId: 'u1', leadId: 'L1', mode: 'insurance', addr: OH, grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, deposit: 1000,
        claim: { deductible: 1000 } };
      const { e } = await run(est, 'best', 16000);
      ok('insurance + $1,000 deductible ($12,000 → $16,000): no tax, subtotal $16,000, deposit = the $1,000 deductible', e.tax === 0 && e.subtotal === 16000 && e.deposit === 1000 && e.depositPlan.rule === 'insurance' && e.depositPlan.totalCents === 1600000, JSON.stringify([e.tax, e.subtotal, e.deposit, e.depositPlan && e.depositPlan.rule]));
      const withAcv = await run(Object.assign({}, est, { claim: { deductible: 1000, acv: 9000 } }), 'best', 16000);
      // $1,000 deductible + the $8,000 ACV check (9,000 − 1,000) = $9,000 up front.
      ok('…with a $9,000 ACV: $1,000 deductible + $8,000 ACV check = $9,000', withAcv.e.deposit === 9000, String(withAcv.e.deposit));
      const leadDed = await run(Object.assign({}, est, { claim: {} }), 'best', 16000, null, { deductible: 1500, address: OH });
      ok('…the deductible on the LEAD is used when the estimate has none ($1,500)', leadDed.e.deposit === 1500, String(leadDed.e.deposit));
    }
    // Kentucky insurance: nothing at signing, whatever the tier (KRS 367.626).
    {
      const est = { userId: 'u1', leadId: 'L1', mode: 'insurance', addr: KY, grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, deposit: 0,
        claim: { deductible: 1000 } };
      const { e } = await run(est, 'best', 16000);
      ok('Kentucky insurance ($12,000 → $16,000): $0 at signing stays $0', e.deposit === 0 && e.depositPlan.depositCents === 0 && e.depositPlan.rule === 'insurance-ky' && /^Nothing is due at signing/.test(e.depositPlan.summary), JSON.stringify([e.deposit, e.depositPlan && e.depositPlan.rule]));
      // A Kentucky claim lead priced in CASH mode is still held (the lead's claim number).
      const cashKy = await run({ userId: 'u1', leadId: 'L1', addr: KY, grandTotal: 10000, subtotal: 9346, tax: 654, taxRate: 0.07, deposit: 0 },
        'best', 15000, null, { claimNumber: 'CLM-1', address: KY });
      ok('…a Kentucky claim lead priced in cash mode is held at $0 too (never 50% = $7,500)', cashKy.e.deposit === 0 && cashKy.e.depositPlan.rule === 'insurance-ky', JSON.stringify([cashKy.e.deposit, cashKy.e.depositPlan && cashKy.e.depositPlan.rule]));
    }
    // A deposit already PAID is never rewritten; subtotal/tax still follow.
    {
      const before = cashEst();
      const paid = { 'invoices/I1': { leadId: 'L1', estimateId: 'E1', status: 'partial', depositAmount: 5000, depositPaid: true, amountPaid: 5000, total: 10000 } };
      const { r, e } = await run(before, 'best', 15000, paid);
      ok('deposit already paid ($5,000 collected): the deposit and its plan are kept, flagged for the rep', r === 'applied' && e.deposit === 5000
        && JSON.stringify(e.depositPlan) === JSON.stringify(before.depositPlan) && e.acceptedTierDepositKept === true, JSON.stringify([e.deposit, e.acceptedTierDepositKept]));
      ok('…the total, subtotal and tax still follow the tier', e.grandTotal === 15000 && e.subtotal === 13949.98 && e.tax === 1050.02);
      const other = await run(cashEst(), 'best', 15000, { 'invoices/I2': { leadId: 'L1', estimateId: 'E9', status: 'paid', amountPaid: 900 } });
      ok('…money paid on ANOTHER estimate\'s invoice does not freeze this one', other.e.deposit === 7500 && other.e.acceptedTierDepositKept === false);
      const voided = await run(cashEst(), 'best', 15000, { 'invoices/I3': { leadId: 'L1', estimateId: 'E1', status: 'void', amountPaid: 5000 } });
      ok('…a void invoice does not count as collected', voided.e.deposit === 7500);
      const unpaid = await run(cashEst(), 'best', 15000, { 'invoices/I4': { leadId: 'L1', estimateId: 'E1', status: 'draft', depositPaid: false, amountPaid: 0 } });
      ok('…an unpaid draft deposit invoice does not count as collected', unpaid.e.deposit === 7500);
      ok('depositCollected: paid in full / part-paid / depositPaid count; deleted and other estimates do not',
        T.depositCollected([{ status: 'paid' }], 'E1') && T.depositCollected([{ estimateId: 'E1', amountPaid: 1 }], 'E1')
          && T.depositCollected([{ estimateId: 'E1', depositPaid: true }], 'E1')
          && !T.depositCollected([{ estimateId: 'E1', amountPaid: 50, deleted: true }], 'E1')
          && !T.depositCollected([{ estimateId: 'E2', amountPaid: 50 }], 'E1') && !T.depositCollected([], 'E1'));
    }
    // Accepting the same tier twice changes nothing.
    {
      const first = await run(cashEst(), 'best', 15000);
      const money = (x) => JSON.stringify([x.grandTotal, x.subtotal, x.tax, x.deposit, x.depositPlan, x.tier, x.selectedTier]);
      const snap1 = money(first.e);
      const r2 = await T.applyAcceptedTier(first.db, info(), 'best', 15000, { now: () => new Date('2026-10-04T10:00:00Z') });
      ok('accepting the same tier twice: second run is same-tier and every money field is unchanged', r2 === 'same-tier' && money(first.db.store['estimates/E1']) === snap1 && first.db.store['leads/L1'].jobValue === 15000, r2);
    }
    // The customer page's "Use it" does the same recompute (same block).
    if (C && C.usePatch) {
      const est = { id: 'E1', selectedTier: 'better', tier: 'better', grandTotal: 18000, subtotal: 16822.43, tax: 1177.57, taxRate: 0.07, deposit: 9000,
        acceptedTier: 'best', acceptedPrice: 21450, prices: { better: 18000, best: 21450 } };
      const lead = { primaryEstimateId: 'E1' };
      const pick = C.pendingPick(lead, [est]);
      const w = C.usePatch(lead, pick, { depositRule: DR });
      // 21,450 × .07 / 1.07 = 1,403.2710 → $1,403.27; subtotal $20,046.73; 50% = $10,725 (a $25 step).
      ok('"Use it" recomputes too: total $21,450, subtotal $20,046.73, tax $1,403.27, deposit $10,725', w.estimate.grandTotal === 21450 && w.estimate.subtotal === 20046.73 && w.estimate.tax === 1403.27 && w.estimate.deposit === 10725 && w.estimate.depositPlan.totalCents === 2145000, JSON.stringify(w.estimate));
      const kept = C.usePatch(lead, pick, { depositRule: DR, depositCollected: true });
      ok('…and keeps a deposit already collected', !('deposit' in kept.estimate) && !('depositPlan' in kept.estimate) && kept.estimate.acceptedTierDepositKept === true && kept.estimate.grandTotal === 21450);
      const noRule = C.usePatch(lead, pick);
      ok('…with no deposit rule loaded the deposit is kept and flagged, never guessed', !('deposit' in noRule.estimate) && noRule.estimate.acceptedTierDepositKept === true);
    }
    // The two copies of the retier block are the same code (indentation aside).
    {
      const blk = (rel) => {
        const s = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
        const a = s.indexOf('// ── retier block'), b = s.indexOf('// ── end retier block ──');
        return (a < 0 || b < 0) ? null : s.slice(a, b).split('\n').map((x) => x.replace(/^\s+/, '')).join('\n');
      };
      const sb = blk('functions/deal-accepted-tier.js'), cb = blk('docs/pro/js/accepted-tier-chip.js');
      ok('the retier block is identical in functions/deal-accepted-tier.js and docs/pro/js/accepted-tier-chip.js', !!sb && sb.length > 500 && sb === cb);
    }
  }

  const da = fs.readFileSync(path.join(ROOT, 'functions', 'deal-acceptance.js'), 'utf8');
  const sub = da.slice(da.indexOf('exports.submitDealAcceptance'));
  ok('submitDealAcceptance applies the tier AFTER the acceptance commits (best-effort)',
    /require\('\.\/deal-accepted-tier'\)\.applyAcceptedTier\(db, info, tier, info\.price, \{ logger \}\)/.test(sub)
      && sub.indexOf('applyAcceptedTier') > sub.indexOf('db.runTransaction'));
  const html = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'customer.html'), 'utf8');
  ok('customer.html loads the chip', /<script defer src="js\/accepted-tier-chip\.js\?v=\d+"><\/script>/.test(html));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
})();
