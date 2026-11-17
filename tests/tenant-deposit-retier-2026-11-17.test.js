/**
 * tests/tenant-deposit-retier-2026-11-17.test.js
 *
 * Repo sweep 2026-11-17, M1: when a homeowner accepted a tier (applyAcceptedTier)
 * or the rep tapped "Use it" (applyHomeownerPick), the server re-ran the deposit
 * through deposit-rule.js with NO tenant config. On the server there is no
 * window.NBDTenantRules, so every company got NBD's rule (50% cash deposit over
 * $2,000), while the signing-day deposit draft (deposit-draft.js) used the
 * company's own rule. The estimate, portal and contract then showed one deposit
 * and the draft invoice another.
 *
 * Now both paths read companyProfile/{companyId} and pass
 * tenant-ops-logic depositConfigFor() through, exactly as deposit-draft.js does.
 * NBD (and a lead with no company) stays on deposit-rule.js's own rule.
 *
 * Run: node tests/tenant-deposit-retier-2026-11-17.test.js
 */
'use strict';
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '\n      ' + extra : '')); }
}
const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'functions', 'deal-accepted-tier.js'));
const { NBD_OWNER_UID } = require(path.join(ROOT, 'functions', 'tenant-ops-logic.js'));

const clone = (o) => JSON.parse(JSON.stringify(o));
function fakeDb(docs) {
  const store = clone(docs);
  const snap = (p) => ({ exists: p in store, data: () => clone(store[p]) });
  const query = (q) => ({ docs: Object.keys(store)
    .filter((p) => p.split('/').length === 2 && p.indexOf(q.name + '/') === 0 && store[p][q.field] === q.value)
    .map((p) => ({ id: p.slice(q.name.length + 1), data: () => clone(store[p]) })) });
  const reads = [];
  return {
    store, reads,
    doc: (p) => ({ path: p }),
    collection: (name) => ({ where: (field, op, value) => ({ _q: { name, field, value } }) }),
    runTransaction: async (fn) => {
      const pending = [];
      let wrote = false;
      const tx = {
        get: async (ref) => {
          if (wrote) throw new Error('read after write in a transaction');
          reads.push(ref._q ? 'query:' + ref._q.name : ref.path);
          return ref._q ? query(ref._q) : snap(ref.path);
        },
        update: (ref, data) => { wrote = true; pending.push([ref.path, data]); },
      };
      const r = await fn(tx);
      pending.forEach(([p, d]) => { store[p] = Object.assign({}, store[p], d); });
      return r;
    },
  };
}
const NOW = new Date('2026-11-17T16:00:00Z');
const c = (n) => Math.round(Number(n) * 100);
const tenantRule = { businessRules: { deposit: { depositPct: 30, noDepositUnderCents: 0, roundToCents: 100 } } };

(async () => {
  console.log('\nM1: the accepted-tier re-tier uses the company\'s own deposit rule\n');

  // A. applyAcceptedTier (deal-room acceptance), tier-less cash estimate, $10,000.
  async function accept(companyId, profile) {
    const docs = {
      'leads/L1': { userId: 'u1', companyId, primaryEstimateId: 'E1', state: 'OH', address: '1 Main St, Milford, OH 45150' },
      'deal_rooms/D1': { userId: 'u1', leadId: 'L1', estimateId: 'E1' },
      'estimates/E1': { userId: 'u1', leadId: 'L1', companyId, grandTotal: 0, mode: 'cash', addr: '1 Main St, Milford, OH 45150' },
    };
    if (profile) docs['companyProfile/' + companyId] = profile;
    const db = fakeDb(docs);
    const r = await T.applyAcceptedTier(db, { dealId: 'D1', leadId: 'L1', ownerUid: 'u1' }, 'best', 10000, { now: () => NOW });
    return { r, e: db.store['estimates/E1'], db };
  }
  {
    const { r, e } = await accept('co-oaks', tenantRule);
    ok('another company with a 30% rule → applied', r === 'applied', r);
    ok('…the estimate deposit is the company\'s 30% ($3,000), not NBD\'s 50%', c(e.deposit) === 300000, e.deposit);
    ok('…and the stored deposit plan agrees', e.depositPlan && e.depositPlan.depositCents === 300000, JSON.stringify(e.depositPlan));
  }
  {
    const { e } = await accept('co-plain', { businessRules: {} });
    ok('a company with no saved deposit rule → the neutral default, no cash deposit ($0)', c(e.deposit) === 0, e.deposit);
  }
  {
    const { e } = await accept('co-missing', null);
    ok('a company with no companyProfile doc at all → $0 too (same as the deposit draft)', c(e.deposit) === 0, e.deposit);
  }
  {
    const { e, db } = await accept(NBD_OWNER_UID, tenantRule);
    ok('NBD keeps deposit-rule.js\'s own rule (50% of $10,000 = $5,000)', c(e.deposit) === 500000, e.deposit);
    ok('…and NBD never reads a companyProfile for it', !db.reads.some((p) => p.indexOf('companyProfile/') === 0), db.reads.join(','));
  }

  // B. applyHomeownerPick ("Use it"), tier-priced estimate.
  async function useIt(companyId, profile) {
    const docs = {
      'leads/L1': { userId: 'u1', companyId, primaryEstimateId: 'E1', state: 'OH' },
      'estimates/E1': { userId: 'u1', leadId: 'L1', companyId, mode: 'cash', addr: '1 Main St, Milford, OH 45150',
        priceMode: 'per-sq', tier: 'better', selectedTier: 'better', grandTotal: 18000, prices: { better: 18000, best: 20000 },
        acceptedTier: 'best', acceptedPrice: 20000 },
    };
    if (profile) docs['companyProfile/' + companyId] = profile;
    const db = fakeDb(docs);
    const r = await T.applyHomeownerPick(db, { uid: 'u1', token: {}, estimateId: 'E1' },
      { now: () => NOW, recordJobEvent: async () => ({}) });
    return { r, e: db.store['estimates/E1'] };
  }
  {
    const { r, e } = await useIt('co-oaks', tenantRule);
    ok('"Use it" for another company → applied', r && r.ok === true, JSON.stringify(r));
    ok('…the deposit is the company\'s 30% of $20,000 ($6,000)', c(e.deposit) === 600000, e.deposit);
  }
  {
    const { e } = await useIt(NBD_OWNER_UID, null);
    ok('"Use it" for NBD keeps 50% of $20,000 ($10,000)', c(e.deposit) === 1000000, e.deposit);
  }

  // C. The pure planners take the config straight through.
  {
    const est = { userId: 'u1', leadId: 'L1', grandTotal: 0, mode: 'cash' };
    const p = T.planAcceptedTier({ lead: { userId: 'u1' }, estimate: est, estimateId: 'E1', leadId: 'L1', ownerUid: 'u1',
      tier: 'best', price: 10000, now: NOW,
      depositConfig: { CASH_NO_DEPOSIT_UNDER_CENTS: 0, CASH_DEPOSIT_PCT: 30, CASH_DEPOSIT_ROUND_TO_CENTS: 100 } });
    ok('planAcceptedTier honours opts.depositConfig', p.estimate && c(p.estimate.deposit) === 300000, p.estimate && p.estimate.deposit);
  }
  // "Use it" on a LINE-ITEM estimate rebuilds from its stored tier build and
  // re-runs the deposit there (its own fromEstimate call, not retierFields).
  {
    const rows = [{ code: 'RFG', total: 10000 }];
    const est = { userId: 'u1', leadId: 'L1', mode: 'cash', tier: 'better', selectedTier: 'better', grandTotal: 10000, rows,
      acceptedTier: 'best', acceptedPrice: 20000,
      tierRows: { v: 1, basis: { tier: 'better', totalCents: 1000000, rowsKey: T.rowsKey(rows) },
        tiers: { best: { rows: [{ code: 'RFG', total: 20000 }], grandTotal: 20000, subtotal: 20000, tax: 0, taxRate: 0 } } } };
    const cfg = { CASH_NO_DEPOSIT_UNDER_CENTS: 0, CASH_DEPOSIT_PCT: 30, CASH_DEPOSIT_ROUND_TO_CENTS: 100 };
    const p = T.planUseAcceptedTier({ lead: { userId: 'u1' }, estimate: est, estimateId: 'E1', depositConfig: cfg });
    ok('"Use it" on a line-item build honours opts.depositConfig (30% of $20,000 = $6,000)',
      p.reason === 'applied' && c(p.estimate.deposit) === 600000, p.reason + ' ' + (p.estimate && p.estimate.deposit));
    const n = T.planUseAcceptedTier({ lead: { userId: 'u1' }, estimate: est, estimateId: 'E1' });
    ok('…and without one keeps deposit-rule.js\'s own rule (50% = $10,000)', n.reason === 'applied' && c(n.estimate.deposit) === 1000000, n.estimate && n.estimate.deposit);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
