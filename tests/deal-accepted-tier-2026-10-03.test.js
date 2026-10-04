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
  const db = {
    store, writes,
    doc: (p) => ({ path: p }),
    runTransaction: async (fn) => {
      const pending = [];
      const tx = {
        get: async (ref) => snap(ref.path),
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
