/**
 * tests/numbers-you-can-trust-2026-10-04.test.js — "knowing your numbers".
 *
 * The 2026-10-04 read-only audit of the owner tenant: 38 won leads, $92.5k
 * booked, $3,650 collected and recorded; 104 Thumbtack leads, 36 costed; 64
 * leads at stage 'New', 62 with no stageRole; close rate counted three
 * different ways. This suite runs the REAL code (vm / require) for each item:
 *
 *   1  spend per paid source, CSV import, cost per lead, uncosted paid leads
 *   2  the lead-source table (Cal.com → Website, booked labelled projected)
 *   3  ONE close rate — won ÷ (won + lost), contract_signed counts as won,
 *      "—" with no data — on the KPI card, Reports and the table
 *   4  soldTier recorded at signing (spine) + package mix
 *   5  costs needed — won jobs with no cost, costed share
 *   6  closedAt = the sale; close dates equal to createdAt flagged
 *   7  lost reason required (commitStageChange refuses without one)
 *   8  stormId tagging (new lead after a storm; accepted DOL) + per-storm results
 *   9  reviews & referrals per month; referral-link opens counted
 *   10 the Sunday review
 *   11 stage-key drift — canonical writers, migration 008 (dry run, idempotent)
 *
 * Zero deps. Run: node tests/numbers-you-can-trust-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
async function sec(name, fn) {
  try { await fn(); } catch (e) { ok(String(name).trim() + ' — threw: ' + (e && e.message), false); }
}
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// numbers-logic.js is UMD: require it directly.
const N = require(path.join(ROOT, 'docs/pro/js/numbers-logic.js'));
const SR = require(path.join(ROOT, 'functions/stage-roles.js'));
const srSale = (l) => typeof SR.isSale === 'function' && SR.isSale(l);

const DAY = 86400000;
const NOW = new Date(2026, 9, 4, 12, 0, 0).getTime(); // Sun 2026-10-04 local noon
const ago = (d) => NOW - d * DAY;

(async () => {
  // ── 3. ONE close rate ─────────────────────────────────────────────────
  console.log('3. ONE close rate');
  await sec('3. ONE close rate', async () => {
    const leads = [
      { id: 'a', stage: 'contract_signed' },              // signed = won (Jo 2026-09-15)
      { id: 'b', stage: 'contract_signed', stageRole: 'active' }, // persisted role 'active' still a sale
      { id: 'c', stage: 'install_in_progress' },          // job = won
      { id: 'd', stage: 'closed' },                       // won
      { id: 'e', stage: 'lost' },
      { id: 'f', stage: 'Lost' },                         // legacy spelling
      { id: 'g', stage: 'inspected' },                    // open — not decided
      { id: 'h', stage: 'New' },                          // open
      { id: 'i', stage: 'closed', deleted: true },        // excluded
      { id: 'j', stage: 'lost', isProspect: true },       // excluded
    ];
    const cr = N.closeRate(leads);
    ok('won ÷ (won + lost): 4 won / 6 decided', cr.won === 4 && cr.lost === 2 && cr.decided === 6 && Math.abs(cr.rate - 4 / 6) < 1e-9, JSON.stringify(cr));
    ok('contract_signed with persisted stageRole "active" counts as won', N.isSale({ stage: 'contract_signed', stageRole: 'active' }) === true);
    ok('no decided leads → rate null → "—" (never 0%)', N.closeRate([{ stage: 'new' }]).rate === null && N.fmtRate(N.closeRate([])) === '—');
    ok('fmtRate rounds', N.fmtRate({ rate: 2 / 3 }) === '67%');
    ok('server isSale agrees (contract_signed / job / won; not lost, not open)',
      srSale({ stage: 'contract_signed' }) && srSale({ stage: 'crew_scheduled' }) && srSale({ stage: 'Closed Won' })
      && !srSale({ stage: 'lost' }) && !srSale({ stage: 'negotiating' }));

    // The KPI card (analytics-kpi.js computeKPIs) reads THE close rate.
    const src = ['numbers-logic.js', 'analytics-kpi.js'];
    const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
    const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' } };
    win.window = win;
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop(), readyState: 'complete' }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Object };
    vm.createContext(sb);
    src.forEach((f) => vm.runInContext(read('docs/pro/js/' + f), sb, { filename: f }));
    win._leads = [{ id: 'k1', stage: 'contract_signed', jobValue: 10000 }, { id: 'k2', stage: 'lost' }];
    win._estimates = [];
    const k = win.computeKPIs();
    ok('KPI card: a signed contract is a win → 50%, not 0% (break-test: main read 0)', k.closeRate === 50, 'got ' + k.closeRate);
    win._leads = [{ id: 'k3', stage: 'inspected' }];
    ok('KPI card: nothing decided → null (renders "—")', win.computeKPIs().closeRate === null);
    const kpiSrc = read('docs/pro/js/analytics-kpi.js');
    ok('KPI card renders "—" for a null rate', /k\.closeRate == null \? '—'/.test(kpiSrc));

    // Reports: rateBetween over leads decided in the window.
    const rl = [
      { id: 'r1', stage: 'contract_signed', closedAt: ago(3) },
      { id: 'r2', stage: 'lost', closedAt: ago(2) },
      { id: 'r3', stage: 'closed', closedAt: ago(40) },
    ];
    const wk = N.rateBetween(rl, ago(7), NOW + 1);
    ok('Reports window rate: decided in the window only (1/2)', wk.won === 1 && wk.decided === 2);
    ok('Reports window with nothing decided → null', N.rateBetween(rl, ago(20), ago(10)).rate === null);
    const rd = read('docs/pro/js/reports-dashboard.js');
    ok('Reports tile shows "—" when the rate is null', /cur\.closeRate == null \? '—'/.test(rd) && /N\.rateBetween\(leads, start, end \+ 1\)/.test(rd));
    ok('Win Rate widget reads NBDNumbers.closeRate', /window\.NBDNumbers\.closeRate\(leads\)/.test(read('docs/pro/js/widgets.js')));
  });

  // ── 2. lead-source table ──────────────────────────────────────────────
  console.log('\n2. lead-source table');
  await sec('\n2. lead-source table', async () => {
    ok('"Website — Cal.com booking" folds into Website', N.normalizeSource('Website — Cal.com booking') === 'Website');
    ok('contact form + inspection tool fold into Website', N.normalizeSource('Website — Contact form') === 'Website' && N.normalizeSource('website - inspection / storm tool') === 'Website');
    ok('door spellings stay Door Knock; Thumbtack its own', N.normalizeSource('d2d') === 'Door Knock' && N.normalizeSource('thumbtack') === 'Thumbtack');
    const sep = new Date(2026, 8, 10).getTime();
    const leads = [
      { id: 't1', source: 'Thumbtack', stage: 'contract_signed', jobValue: 12000, createdAt: sep },
      { id: 't2', source: 'Thumbtack', stage: 'lost', createdAt: sep },
      { id: 't3', source: 'Thumbtack', stage: 'new', createdAt: sep },
      { id: 't4', source: 'Thumbtack', stage: 'new', createdAt: sep },
      { id: 'w1', source: 'Website — Cal.com booking', stage: 'closed', jobValue: 20000, createdAt: sep },
      { id: 'w2', source: 'Website — Contact form', stage: 'new', createdAt: sep },
    ];
    const spend = { months: { '2026-09': { thumbtack: 20000 } } }; // $200 for 4 leads
    const t = N.sourceTable(leads, { collectedByLead: { w1: 5000, t1: 1000 }, spend });
    const tt = t.rows.find((r) => r.source === 'Thumbtack');
    const web = t.rows.find((r) => r.source === 'Website');
    ok('one Website row for Cal.com + contact form (2 leads)', web && web.leads === 2 && !t.rows.find((r) => /cal\.com/i.test(r.source)));
    ok('sorted by collected (Website $5,000 first)', t.rows[0].source === 'Website');
    ok('Thumbtack: 4 leads, won % 50 (1 signed / 2 decided)', tt.leads === 4 && tt.winRate === 0.5);
    ok('booked is jobValue in cents (projected) and collected is cash', tt.bookedCents === 1200000 && tt.collectedCents === 100000);
    ok('spend = the month\'s bill ($200), cost per job won $200, booked per $1 = 60', tt.spendCents === 20000 && tt.costPerWonCents === 20000 && Math.abs(tt.bookedPerDollar - 60) < 1e-9);
    ok('no spend → cost per job and booked per $1 are null ("—")', web.spendCents === 0 && web.costPerWonCents === null && web.bookedPerDollar === null);

    // lead-source-roi.js renders off the same function and keeps legacy names.
    const win = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    win.window = win;
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; } }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
    vm.createContext(sb);
    ['numbers-logic.js', 'lead-source-roi.js'].forEach((f) => vm.runInContext(read('docs/pro/js/' + f), sb, { filename: f }));
    win._leads = leads;
    win.NBDRevenue = { cached: () => [{}], collectedByLead: () => ({ w1: 5000 }) };
    const m = win.LeadSourceROI.compute(spend);
    const r = m.rows.find((x) => x.source === 'Thumbtack');
    ok('LeadSourceROI.compute: Won % from THE close rate (conversionRate 50)', r.conversionRate === 50 && r.closed === 1);
    ok('LeadSourceROI.compute: spend $200, cost per job won $200', r.spendCents === 20000 && r.costPerWonCents === 20000);
    const roiSrc = read('docs/pro/js/lead-source-roi.js');
    ok('table header labels Booked as projected and shows the new columns', /Booked <span class="nb-dim">\(projected\)<\/span>/.test(roiSrc) && /Cost \/ job won/.test(roiSrc) && /Booked per \$1/.test(roiSrc));
    ok('spend columns only for the owner', /owner \? '<th>Spend<\/th>/.test(roiSrc));
  });

  // ── 1. spend entry ────────────────────────────────────────────────────
  console.log('\n1. spend per paid source');
  await sec('\n1. spend per paid source', async () => {
    const sep = new Date(2026, 8, 3).getTime();
    const leads = [
      { id: 'p1', source: 'Thumbtack', leadCost: 51.96, createdAt: sep },
      { id: 'p2', source: 'Thumbtack', createdAt: sep },
      { id: 'p3', source: 'Thumbtack', createdAt: sep },
      { id: 'p4', source: 'Yelp', createdAt: sep },
      { id: 'p5', source: 'Referral', createdAt: sep },
    ];
    const mlc = N.monthLeadCounts(leads);
    const spend = { months: { '2026-09': { thumbtack: 30000 } } };
    ok('a lead with its own price uses it', N.leadCostOf(leads[0], spend, mlc).cents === 5196 && N.leadCostOf(leads[0], spend, mlc).basis === 'lead');
    ok('no price → month spend ÷ month leads ($300 / 3 = $100)', N.leadCostOf(leads[1], spend, mlc).cents === 10000 && N.leadCostOf(leads[1], spend, mlc).basis === 'monthly');
    ok('no price, no spend → none', N.leadCostOf(leads[3], spend, mlc).basis === 'none');
    const miss = N.missingLeadCost(leads, spend);
    ok('paid-source leads with no leadCost flagged (Thumbtack ×2 + Yelp), not Referral', miss.length === 3 && miss.every((x) => x.lead.source !== 'Referral'));
    ok('…Thumbtack ones covered by the month\'s spend, Yelp not', miss.filter((x) => x.covered).length === 2 && !miss.find((x) => x.lead.id === 'p4').covered);

    const csv = '﻿Date,Description,Amount\n09/03/2026,"Lead: Roof repair, Mason",$51.96\n9/15/2026,Lead,"$1,048.00"\n2026-10-01,Lead,$20.00\n2026-10-02,Refund,($20.00)\n,blank,\n';
    const pc = N.parseSpendCsv(csv);
    ok('CSV: finds date + amount columns, quoted commas handled', !pc.error && pc.rows.length === 4, JSON.stringify(pc));
    ok('CSV: by month in cents (Sep $1,099.96; Oct nets $0 after the refund)', pc.byMonth['2026-09'] === 109996 && pc.byMonth['2026-10'] === 0, JSON.stringify(pc.byMonth));
    ok('CSV: a row with no date/amount is skipped', pc.skipped === 1);
    ok('CSV with no amount column → a plain error', !!N.parseSpendCsv('Date,Note\n2026-09-01,x\n').error);

    // numbers-data.js writes spend to the owner-only doc.
    const writes = [];
    const win = {
      _user: { uid: 'OWNER' }, _userClaims: { companyId: 'OWNER' }, db: {},
      doc: (...p) => p.slice(1).join('/'),
      getDoc: async () => ({ exists: () => false, data: () => ({}) }),
      setDoc: async (ref, data, opt) => { writes.push({ ref, data, opt }); },
      serverTimestamp: () => 'TS',
    };
    const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Object, Promise };
    vm.createContext(sb);
    vm.runInContext(read('docs/pro/js/numbers-data.js'), sb);
    const okSave = await win.NBDNumbersData.saveSpendMonth('2026-09', 'thumbtack', 30000);
    ok('saveSpendMonth → companies/{owner}/owner_numbers/lead_spend, merge', okSave && writes[0].ref === 'companies/OWNER/owner_numbers/lead_spend' && writes[0].opt.merge === true && writes[0].data.months['2026-09'].thumbtack === 30000);
    win._user = { uid: 'MGR' }; win._userClaims = { companyId: 'OWNER', role: 'manager' };
    ok('a manager is not the owner → no spend read/write', win.NBDNumbersData.isOwner() === false && (await win.NBDNumbersData.loadSpend()) === null);
    const rules = read('firestore.rules');
    const blk = rules.slice(rules.indexOf('match /owner_numbers/{docId}'), rules.indexOf('match /owner_numbers/{docId}') + 900);
    ok('rules: owner_numbers readable by the owner only (uid == companyId or ownerId)', /allow read: if isAdmin\(\)\s*\|\| \(isAuth\(\) && request\.auth\.uid == companyId\)/.test(blk) && /ownerId == request\.auth\.uid/.test(blk));
    ok('rules: clients can never write referral_clicks_*', /!docId\.matches\('referral_clicks_\.\*'\)/.test(blk));
  });

  // ── 4. sold package ───────────────────────────────────────────────────
  console.log('\n4. sold package');
  await sec('\n4. sold package', async () => {
    const L = require(path.join(ROOT, 'functions/job-spine-logic.js'));
    ok('contract_signed + acceptedTier → soldTier', JSON.stringify(L.soldTierPatch({ acceptedTier: 'better' }, 'contract_signed', {}, null)) === JSON.stringify({ soldTier: 'better', soldTierSource: 'deal_room' }));
    ok('deal_accepted meta.tier wins', L.soldTierPatch({ acceptedTier: 'good' }, 'deal_accepted', { tier: 'best' }, null).soldTier === 'best');
    ok('falls back to the primary estimate tier', L.soldTierPatch({}, 'contract_signed', {}, { selectedTier: 'economy' }).soldTier === 'economy');
    ok('never overwrites a soldTier already set (a manual pick)', L.soldTierPatch({ soldTier: 'good', acceptedTier: 'best' }, 'contract_signed', {}, null) === null);
    ok('other events never record one', L.soldTierPatch({ acceptedTier: 'best' }, 'paid_in_full', {}, null) === null);

    // recordJobEvent writes it (fake transactional db).
    const SPINE = require(path.join(ROOT, 'functions/job-spine.js'));
    const store = new Map(Object.entries({
      'leads/S1': { stage: 'estimate_submitted', userId: 'u1', companyId: 'c1', primaryEstimateId: 'E1' },
      'estimates/E1': { userId: 'u1', selectedTier: 'better' },
      'leads/S2': { stage: 'install_complete', userId: 'u1', companyId: 'c1', acceptedTier: 'best' },
    }));
    const apply = (cur, p) => { const d = Object.assign({}, cur); for (const k of Object.keys(p)) { const v = p[k]; d[k] = v && v.__union ? (d[k] || []).concat(v.__union) : v; } return d; };
    const ref = (p) => ({ path: p, collection: (c) => ({ doc: (id) => ref(p + '/' + c + '/' + id) }), async get() { const d = store.get(p); return { exists: d !== undefined, data: () => d }; } });
    const db = {
      collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
      doc: (p) => ref(p),
      async runTransaction(fn) {
        const pend = [];
        const tx = { get: (r) => r.get(), create: (r, d) => pend.push(() => store.set(r.path, d)), set: (r, d) => pend.push(() => store.set(r.path, d)), update: (r, p) => pend.push(() => store.set(r.path, apply(store.get(r.path), p))) };
        const out = await fn(tx); pend.forEach((f) => f()); return out;
      },
    };
    const deps = { FieldValue: { serverTimestamp: () => 'TS', arrayUnion: (...x) => ({ __union: x }) }, logger: { info() {}, warn() {} }, now: () => NOW, depositDraft: false };
    await SPINE.recordJobEvent(db, { leadId: 'S1', companyId: 'c1', event: 'contract_signed', sourceId: 'doc_1' }, deps);
    const s1 = store.get('leads/S1');
    ok('spine: signing stamps soldTier from the primary estimate + soldTierAt', s1.soldTier === 'better' && s1.soldTierSource === 'estimate' && s1.soldTierAt === 'TS' && s1.stage === 'contract_signed');
    await SPINE.recordJobEvent(db, { leadId: 'S2', companyId: 'c1', event: 'contract_signed', sourceId: 'doc_2' }, deps);
    const s2 = store.get('leads/S2');
    ok('spine: no stage move (already past signing) still records soldTier', s2.stage === 'install_complete' && s2.soldTier === 'best');

    const mix = N.packageMix([
      { stage: 'closed', soldTier: 'better', jobValue: 15000 },
      { stage: 'closed', soldTier: 'better', jobValue: 17000 },
      { stage: 'contract_signed', soldTier: 'good', jobValue: 11000 },
      { stage: 'closed' },
      { stage: 'lost', soldTier: 'best', jobValue: 99999 },
    ]);
    const better = mix.rows.find((r) => r.tier === 'better');
    ok('package mix: sales only, avg ticket per package', mix.sales === 4 && mix.unknown === 1 && better.count === 2 && better.avgTicketCents === 1600000 && !mix.rows.find((r) => r.tier === 'best'));
    const cn = read('docs/pro/js/customer-numbers.js');
    ok('customer page has a manual sold-package picker that writes soldTierSource manual', /data-cn="tier"/.test(cn) && /soldTierSource: 'manual'/.test(cn));
  });

  // ── 5. costs needed ───────────────────────────────────────────────────
  console.log('\n5. costs needed');
  await sec('\n5. costs needed', async () => {
    const leads = [
      { id: 'c1', stage: 'closed', jobValue: 20000 },
      { id: 'c2', stage: 'contract_signed', jobValue: 9000 },
      { id: 'c3', stage: 'final_payment', jobValue: 15000, materialCost: 4200 },
      { id: 'c4', stage: 'closed', jobValue: 8000 },
      { id: 'c5', stage: 'new' },
    ];
    const exps = [
      { leadId: 'c1', amountCents: 50000, costType: 'direct', category: 'materials' },
      { leadId: 'c4', amountCents: 9000, costType: 'overhead', category: 'marketing' }, // not a job cost
    ];
    const r = N.costsNeeded(leads, exps);
    ok('won jobs with no cost (c2 signed, c4 only overhead), largest first', r.list.map((l) => l.id).join(',') === 'c2,c4', r.list.map((l) => l.id).join(','));
    ok('costed share counts expenses + Job Costs panel fields (2 of 4)', r.costed === 2 && r.total === 4);
    const wr = read('docs/pro/js/week-review.js');
    ok('one tap: "+ Add cost" opens the expense form on that job; Home Depot import linked', /Expenses\.openForm\(\{ leadId: id, category: 'materials' \}\)/.test(wr) && /NBDHdImport\.open\(\)/.test(wr));
    ok('expenses.js exposes openForm(opts) with lead preselect', /function openForm\(opts\)/.test(read('docs/pro/js/expenses.js')) && /openForm: openForm/.test(read('docs/pro/js/expenses.js')));
  });

  // ── 6/7. close dates + lost reason (stage-write.js commitStageChange) ──
  console.log('\n6/7. closedAt = the sale; lost reason required');
  await sec('\n6/7. closedAt = the sale; lost reason required', async () => {
    ok('needsClosedAt: entering contract_signed stamps', SR.needsClosedAt({ stage: 'negotiating' }, 'contract_signed') === true);
    ok('needsClosedAt: signed (dated) → install_complete keeps the date', SR.needsClosedAt({ stage: 'contract_signed', closedAt: 1 }, 'install_complete') === false);
    ok('needsClosedAt: a lost lead (closedAt from the loss) re-won restamps', SR.needsClosedAt({ stage: 'lost', closedAt: 1 }, 'contract_signed') === true);
    ok('needsCloseDate flags closedAt == createdAt and a missing closedAt', N.needsCloseDate({ stage: 'closed', createdAt: 1e12, closedAt: 1e12 + 5000 }) && N.needsCloseDate({ stage: 'contract_signed', createdAt: 1e12 })
      && !N.needsCloseDate({ stage: 'closed', createdAt: 1e12, closedAt: 1e12 + 9 * DAY }) && !N.needsCloseDate({ stage: 'new', createdAt: 1e12 }));

    function loadStageWrite(cur) {
      const src = read('docs/pro/js/stage-write.js').replace(/export async function /g, 'async function ').replace(/export function /g, 'function ')
        + '\nglobalThis.__sw = { commitStageChange };';
      const updates = [];
      const win = {
        db: {}, doc: (...p) => p.slice(1).join('/'),
        serverTimestamp: () => 'TS', arrayUnion: (x) => ({ __u: x }),
        addDoc: async () => ({}), collection: () => 'notes',
        stageRole: (k) => SR.roleFromKey(k),
        async runTransaction(db, fn) {
          const tx = { get: async () => ({ exists: () => true, data: () => cur }), update: (r, p) => updates.push(p) };
          return fn(tx);
        },
      };
      const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Date, JSON, Object };
      vm.createContext(sb);
      vm.runInContext(read('docs/pro/js/numbers-logic.js'), sb);
      vm.runInContext(src, sb);
      return { sw: sb.__sw, updates };
    }
    {
      const { sw, updates } = loadStageWrite({ stage: 'negotiating' });
      await sw.commitStageChange('L1', 'contract_signed', 'negotiating', {});
      ok('commitStageChange: a signed contract stamps closedAt (break-test: main left it unset)', updates[0] && updates[0].closedAt === 'TS');
    }
    {
      const { sw, updates } = loadStageWrite({ stage: 'contract_signed', closedAt: 5, acceptedTier: 'best' });
      await sw.commitStageChange('L1', 'install_complete', 'contract_signed', {});
      ok('…signed → install complete keeps the signing date', updates[0] && !('closedAt' in updates[0]));
      ok('…and carries the accepted pick onto soldTier', updates[0].soldTier === 'best' && updates[0].soldTierSource === 'deal_room');
    }
    {
      const { sw, updates } = loadStageWrite({ stage: 'inspected' });
      let err = null;
      try { await sw.commitStageChange('L1', 'lost', 'inspected', { isLostMove: true }); } catch (e) { err = e.message; }
      ok('a lost move with no reason is refused (LOST_REASON_REQUIRED) and writes nothing', err === 'LOST_REASON_REQUIRED' && updates.length === 0, err);
    }
    {
      const { sw, updates } = loadStageWrite({ stage: 'inspected' });
      const fields = N.lostReasonFields({ key: 'competitor', note: 'Cheaper bid from ABC' });
      await sw.commitStageChange('L1', 'lost', 'inspected', { isLostMove: true, lostFields: fields });
      ok('…with the picker\'s fields: key + label/note + closedAt', updates[0].lostReasonKey === 'competitor' && updates[0].lostReason === 'Went with someone else — Cheaper bid from ABC' && updates[0].closedAt === 'TS');
    }
    {
      const { sw, updates } = loadStageWrite({ stage: 'inspected', lostReason: 'Price' });
      await sw.commitStageChange('L1', 'lost', 'inspected', { isLostMove: true });
      ok('…a lead that already carries a reason may move without asking again', updates[0].lostReason === 'Price');
    }
    ok('validateLostReason: a key is required; Other needs a note', N.validateLostReason({}) && N.validateLostReason({ key: 'other' }) && !N.validateLostReason({ key: 'other', note: 'x' }) && !N.validateLostReason({ key: 'price' }));
    ok('the six quick picks', N.LOST_REASONS.map((r) => r.key).join(',') === 'price,competitor,no_damage,no_response,insurance_denied,other');
    ok('old free-text reasons read into keys', N.lostReasonKeyOf({ lostReason: 'Price — too expensive' }) === 'price' && N.lostReasonKeyOf({ lostReason: 'Ghosted / no response' }) === 'no_response'
      && N.lostReasonKeyOf({ lostReason: 'Chose a competitor' }) === 'competitor' && N.lostReasonKeyOf({ lostReason: 'Insurance denied the claim' }) === 'insurance_denied' && N.lostReasonKeyOf({}) === null);
    const lb = N.lossesByReason([
      { stage: 'lost', source: 'Thumbtack', lostReasonKey: 'price' },
      { stage: 'lost', source: 'Thumbtack', lostReason: 'Ghosted / no response' },
      { stage: 'lost', source: 'Door Knock' },
      { stage: 'closed', source: 'Thumbtack', lostReasonKey: 'price' },
    ]);
    ok('losses by reason and by source; missing counted', lb.total === 3 && lb.byReason.price === 1 && lb.byReason.no_response === 1 && lb.missing === 1 && lb.bySource.Thumbtack.price === 1 && lb.bySource['Door Knock'].unknown === 1);
    const cp = read('docs/pro/js/crm-pipeline.js');
    ok('moveCard has no "Skip — no reason" path any more; the picker is required', !/Skip — no reason/.test(cp) && /window\.NBDLostReason\.prompt\(lead\)/.test(cp));
    ok('crm-leads edit modal asks for the reason on a lost move', /window\.NBDLostReason \? await window\.NBDLostReason\.prompt\(_existing\)/.test(read('docs/pro/js/crm-leads.js')));
  });

  // ── 8. storms ─────────────────────────────────────────────────────────
  console.log('\n8. results per storm');
  await sec('\n8. results per storm', async () => {
    const T = require(path.join(ROOT, 'functions/storm-tag-logic.js'));
    const created = Date.parse('2026-06-20T15:00:00Z');
    const events = [
      { kind: 'wind', mag: 60, lat: 39.27, lon: -84.26, valid: '2026-06-14T21:30:00', city: 'Loveland', st: 'OH' },
      { kind: 'hail', mag: 1.25, lat: 39.30, lon: -84.30, valid: '2026-06-14T22:10:00', city: 'Mason', st: 'OH' },
      { kind: 'hail', mag: 2, lat: 39.27, lon: -84.26, valid: '2026-05-01T20:00:00', city: 'Old', st: 'OH' },  // > 14 d before
      { kind: 'hail', mag: 2, lat: 40.5, lon: -84.26, valid: '2026-06-18T20:00:00', city: 'Far', st: 'OH' },  // > 10 mi
    ];
    const m = T.matchStorm({ lat: 39.28, lng: -84.27, createdAt: created }, events);
    ok('a lead within 14 d / 10 mi of a report gets storm-YYYY-MM-DD (Eastern date)', m && m.stormId === 'storm-2026-06-14' && m.stormDate === '2026-06-14', JSON.stringify(m));
    ok('hail beats wind for the same storm', m.stormKind === 'hail' && m.stormPlace === 'Mason, OH');
    ok('outside the window or radius → no storm', T.matchStorm({ lat: 39.28, lng: -84.27, createdAt: Date.parse('2026-07-20T12:00:00Z') }, events) === null);
    ok('an accepted storm-report date of loss names the storm', T.matchStorm({ dateOfLoss: '2026-05-01', dateOfLossSource: 'storm_report_suggested' }, []).stormId === 'storm-2026-05-01');
    ok('already tagged / deleted / no pin → no patch', T.stormTagPatch({ stormId: 'storm-x', lat: 39.28, lng: -84.27, createdAt: created }, events) === null
      && T.stormTagPatch({ deleted: true, lat: 39.28, lng: -84.27, createdAt: created }, events) === null && T.stormTagPatch({ createdAt: created }, events) === null);

    const ST = require(path.join(ROOT, 'functions/storm-tag.js'))._test;
    const upd = [];
    const fdb = {
      collection: (c) => ({
        where: () => ({ limit: () => ({ get: async () => ({ docs: events.map((e) => ({ data: () => e })) }) }) }),
        doc: (id) => ({ update: async (p) => upd.push([c + '/' + id, p]) }),
      }),
    };
    const r = await ST.tagLead(fdb, 'LZ', { lat: 39.28, lng: -84.27, createdAt: created }, created + 60000);
    ok('storm-tag trigger writes the tag onto the new lead', r.tagged === 'storm-2026-06-14' && upd[0][0] === 'leads/LZ' && upd[0][1].stormId === 'storm-2026-06-14');
    ok('index.js exports stormTagOnLeadCreate; storm-tag.js assigns onDocumentCreated directly (CI deploy regex)',
      /exports\.stormTagOnLeadCreate = require\('\.\/storm-tag'\)\.stormTagOnLeadCreate/.test(read('functions/index.js'))
      && /^exports\.stormTagOnLeadCreate = onDocumentCreated\(/m.test(read('functions/storm-tag.js')));

    // dol-fill: accepting a storm-report date tags the storm.
    const dwin = { addEventListener() {} };
    const dsb = { window: dwin, document: { addEventListener() {}, getElementById() { return null; } }, console: { log() {}, warn() {} }, Date, Math, JSON, setTimeout };
    vm.createContext(dsb);
    vm.runInContext(read('docs/pro/js/dol-fill.js'), dsb);
    const sp = dwin.NBDDolFill.savePatch({}, '2026-06-14', 'storm_report_suggested');
    ok('dol-fill: a storm-report date stamps stormId storm-YYYY-MM-DD', sp.stormId === 'storm-2026-06-14' && sp.stormTaggedBy === 'date_of_loss');
    ok('dol-fill: a typed date does not tag; an existing tag is kept', !dwin.NBDDolFill.savePatch({}, '2026-06-14', 'manual').stormId && !dwin.NBDDolFill.savePatch({ stormId: 'storm-a' }, '2026-06-14', 'storm_report_suggested').stormId);

    const res = N.stormResults([
      { stormId: 'storm-2026-06-14', stormDate: '2026-06-14', stage: 'contract_signed', jobValue: 14000 },
      { stormId: 'storm-2026-06-14', stage: 'lost' },
      { stormId: 'storm-2026-06-14', stage: 'new' },
      { stormId: 'storm-2026-07-02', stage: 'closed', jobValue: 9000 },
      { stage: 'closed', jobValue: 5000 },
    ]);
    ok('per storm: leads, wins, booked (projected), newest first', res.length === 2 && res[0].stormId === 'storm-2026-07-02' && res[1].leads === 3 && res[1].won === 1 && res[1].bookedCents === 1400000);
  });

  // ── 9. reviews & referrals ────────────────────────────────────────────
  console.log('\n9. reviews & referrals');
  await sec('\n9. reviews & referrals', async () => {
    const sep = new Date(2026, 8, 15).getTime(), oct = new Date(2026, 9, 2).getTime();
    const rows = N.reviewsReferralsByMonth({
      leads: [
        { source: 'Referral', stage: 'contract_signed', createdAt: sep, closedAt: oct },
        { source: 'Website', redeemReferralCode: 'NBD-0042', stage: 'new', createdAt: oct },
        { source: 'Thumbtack', stage: 'closed', createdAt: sep },
      ],
      reviewAsks: [{ at: sep }, { at: oct }, { at: oct }],
      reviews: [{ time: Math.floor(oct / 1000) }],
      clicks: { '2026-10': 7 },
    });
    const o = rows.find((r) => r.month === '2026-10'), s = rows.find((r) => r.month === '2026-09');
    ok('per month: asks, reviews, link opens, referred leads, referred wins', o.asks === 2 && o.reviews === 1 && o.clicks === 7 && o.referredLeads === 1 && o.referredWins === 1
      && s.asks === 1 && s.referredLeads === 1 && s.referredWins === 0, JSON.stringify(rows));

    const RC = require(path.join(ROOT, 'functions/referral-clicks.js'))._test;
    ok('parseRef accepts NBD-0042, rejects junk', RC.parseRef('nbd-0042').code === 'NBD-0042' && RC.parseRef('<script>') === null && RC.parseRef('NBD') === null);
    const sets = [];
    const mkDb = (prefixCo, leadsByCode) => ({
      doc: (p) => ({
        get: async () => ({ exists: p.startsWith('docPrefixes/') && !!prefixCo, get: () => prefixCo }),
        set: async (d, o) => sets.push([p, d, o]),
      }),
      collection: () => ({ where: (f, op, v) => ({ limit: () => ({ get: async () => { const l = (leadsByCode[v] || []); return { size: l.length, docs: l.map((x) => ({ get: (k) => x[k] })) }; } }) }) }),
    });
    await RC.recordClick(mkDb('CO1', {}), 'NBD-0042', NOW);
    ok('a known code increments companies/{co}/owner_numbers/referral_clicks_YYYY-MM (merge)', sets[0][0] === 'companies/CO1/owner_numbers/referral_clicks_2026-10' && sets[0][2].merge === true);
    await RC.recordClick(mkDb(null, { 'NBD-0007': [{ companyId: 'CO2' }] }), 'NBD-0007', NOW);
    ok('legacy code with no prefix doc resolves by its one lead', sets[1] && sets[1][0] === 'companies/CO2/owner_numbers/referral_clicks_2026-10');
    const r3 = await RC.recordClick(mkDb(null, { 'NBD-0009': [{ companyId: 'A' }, { companyId: 'B' }] }), 'NBD-0009', NOW);
    ok('an ambiguous / unknown code is not counted', r3.skipped === 'unknown_prefix' && sets.length === 2);
    ok('refer.js reports the page open once per session', /referralLinkOpened/.test(read('docs/pro/js/refer.js')) && /sessionStorage/.test(read('docs/pro/js/refer.js')));
  });

  // ── 10. the Sunday review ─────────────────────────────────────────────
  console.log('\n10. the Sunday review');
  await sec('\n10. the Sunday review', async () => {
    const leads = [
      { id: 'w1', source: 'Thumbtack', stage: 'contract_signed', jobValue: 12000, createdAt: ago(20), closedAt: ago(2), leadCost: 40 },
      { id: 'w2', source: 'Referral', stage: 'closed', jobValue: 18000, createdAt: ago(60), closedAt: ago(30), soldTier: 'better' },
      { id: 'w3', source: 'Thumbtack', stage: 'lost', createdAt: ago(10), closedAt: ago(1) },
      { id: 'w4', source: 'Website — Cal.com booking', stage: 'new', createdAt: ago(3) },
      { id: 'w5', source: 'Thumbtack', stage: 'contacted', createdAt: ago(40), stageStartedAt: ago(35) },
      { id: 'w6', source: 'Door Knock', stage: 'contacted', createdAt: ago(20), stageStartedAt: ago(12) },
      { id: 'w7', source: 'Thumbtack', stage: 'inspected', createdAt: ago(5), stageStartedAt: ago(4) },
      { id: 'w8', source: 'Thumbtack', stage: 'lost', createdAt: ago(25), closedAt: ago(15), lostReasonKey: 'price' },
      { id: 'w9', source: 'Referral', stage: 'closed', createdAt: ago(90), closedAt: ago(90) + 1000, jobValue: 7000 },
    ];
    const rv = N.weeklyReview({
      nowMs: NOW, leads,
      collectedBetween: (a, b) => ({ total: 1500, count: 1 }),
      owedCents: 420000,
      collectedByLead: { w2: 18000 },
      expenses: [{ leadId: 'w2', amountCents: 900000, costType: 'direct' }],
      reviewAsks: [{ at: ago(1) }], reviews: [{ time: Math.floor(ago(2) / 1000) }], clicks: { '2026-10': 3 },
    });
    ok('cash collected this week (payments by date) and still owed', rv.cash.collectedCents === 150000 && rv.cash.payments === 1 && rv.owedCents === 420000);
    ok('wins booked this week = signed in the last 7 days (projected)', rv.bookedWins.count === 1 && rv.bookedWins.bookedCents === 1200000);
    ok('new leads by source this week (Cal.com → Website)', rv.newLeads.count === 2 && rv.newLeads.bySource.some((s) => s.source === 'Website' && s.leads === 1));
    ok('win rate this week (1 won / 2 decided) vs the 4 weeks before (1 won / 2)', rv.winRate.week.won === 1 && rv.winRate.week.decided === 2 && rv.winRate.prior4.decided === 2);
    ok('oldest in Contacted is the 35-day lead', rv.stuck.oldestContacted && rv.stuck.oldestContacted.lead.id === 'w5' && rv.stuck.oldestContacted.days === 35);
    ok('stuck stages need 2+ leads (Contacted ×2)', rv.stuck.bottlenecks.length === 1 && rv.stuck.bottlenecks[0].stage === 'contacted');
    const g = rv.gaps;
    ok('data gaps: wins with no payment / no cost / no package', g.noPayment.map((l) => l.id).sort().join() === 'w1,w9' && g.noCost.map((l) => l.id).sort().join() === 'w1,w9' && g.noPackage.map((l) => l.id).sort().join() === 'w1,w9');
    ok('data gaps: close date equal to created date; loss with no reason', g.closeDates.map((l) => l.id).join() === 'w9' && g.lostNoReason.map((l) => l.id).join() === 'w3');
    ok('data gaps: paid-source leads with no cost and no monthly spend', g.paidNoCost.map((l) => l.id).sort().join() === 'w3,w5,w7,w8');
    ok('reviews & referrals this week', rv.reviewsReferrals.asks === 1 && rv.reviewsReferrals.reviews === 1 && rv.reviewsReferrals.clicksThisMonth === 3);
    ok('weekKey = the Sunday the week ends on', N.weekKey(NOW) === '2026-10-04' && N.weekKey(new Date(2026, 9, 7).getTime()) === '2026-10-04');
    const dash = read('docs/pro/dashboard.html');
    ok('the page is routed (#/weekreview), linked from Home and Reports', /id="view-weekreview"/.test(dash) && /id="homeWeekReviewBtn"[^>]*data-target="weekreview"/.test(dash)
      && /id="btnReportsWeekReview"[^>]*data-target="weekreview"/.test(dash) && /'weekreview':\s*\{ label: 'Sunday Review'/.test(read('docs/pro/js/dashboard-state.js')));
    ok('the decision box saves per week to owner_numbers/week_<date>', /ownerDoc\('week_' \+ weekKey\)/.test(read('docs/pro/js/numbers-data.js')));
    const wr = read('docs/pro/js/week-review.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
    ok('the review never touches the personal tracker', !/tracker|daily-success|dailySuccess/i.test(wr));
  });

  // ── 11. stage-key drift ───────────────────────────────────────────────
  console.log('\n11. stage-key drift + migration 008');
  await sec('\n11. stage-key drift + migration 008', async () => {
    const cs = read('docs/pro/js/crm-stages.js');
    const sBlock = cs.slice(cs.indexOf('export const S = {'), cs.indexOf('};', cs.indexOf('export const S = {')));
    const keys = (sBlock.match(/:\s*'([a-z_]+)'/g) || []).map((m) => m.replace(/[:\s']/g, ''));
    ok('server BUILTIN_KEYS == crm-stages.js S (' + keys.length + ' keys)', keys.length > 30 && keys.length === SR.BUILTIN_KEYS.size && keys.every((k) => SR.BUILTIN_KEYS.has(k)));
    const wonClient = (cs.match(/const _ROLE_WON\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
    ok('numbers-logic WON/JOB sets match crm-stages', N.WON_KEYS.length === wonClient.split(',').length && N.JOB_KEYS.length === 6);
    ok('canonicalStageKey: New → new, Closed Won → closed, spacing variant → key, custom → null',
      SR.canonicalStageKey('New') === 'new' && SR.canonicalStageKey('Closed Won') === 'closed' && SR.canonicalStageKey('Install In Progress') === 'install_in_progress'
      && SR.canonicalStageKey('custom_review') === null && SR.canonicalStageKey('') === 'new');

    const M = require(path.join(ROOT, 'functions/migrations/scripts/008-normalize-lead-stages.js'));
    const p1 = M.planStageFix({ stage: 'New' });
    ok("plan: 'New' → stage 'new' + stageRole 'new'", p1 && p1.patch.stage === 'new' && p1.patch.stageRole === 'new');
    ok('plan: no stage at all → new', M.planStageFix({}).patch.stage === 'new');
    ok("plan: canonical key, no role → stamps role only", JSON.stringify(M.planStageFix({ stage: 'closed' }).patch) === JSON.stringify({ stageRole: 'won' }));
    ok('plan: a custom stage is never touched', M.planStageFix({ stage: 'custom_review' }) === null && M.planStageFix({ stage: 'custom_review', stageRole: 'won' }) === null);
    ok('plan: a valid stored role (maybe a tenant override) is kept', M.planStageFix({ stage: 'contract_signed', stageRole: 'job' }) === null);
    ok('plan: stale _stageKey rewritten with the stage', M.planStageFix({ stage: 'Complete', _stageKey: 'Complete', stageRole: 'won' }).patch._stageKey === 'closed');
    ok('plan: idempotent (the fixed doc plans nothing)', M.planStageFix(Object.assign({ stage: 'New' }, p1.patch)) === null);

    const docs = [{ stage: 'New' }, { stage: 'new', stageRole: 'new' }, { stage: 'Closed Won' }, { stage: 'custom_x' }];
    const committed = [];
    const fake = {
      batch: () => { const ops = []; return { update: (r, p) => ops.push([r, p]), commit: async () => committed.push(...ops) }; },
    };
    async function* pages() { yield { docs: docs.map((d, i) => ({ ref: 'leads/' + i, data: () => d })) }; }
    const dry = await M.run(fake, { dryRun: true, pages });
    ok('dry run: counts what would change, writes nothing', dry.wouldWrite === 2 && dry.docsWritten === 0 && committed.length === 0 && /DRY RUN/.test(dry.note));
    const real = await M.run(fake, { dryRun: false, pages });
    ok('apply: writes the two fixes', real.docsWritten === 2 && committed.length === 2 && committed[0][1].stage === 'new' && committed[1][1].stage === 'closed');
    ok('migration 008 loads in the runner (version 8, unique)', (() => { const R = require(path.join(ROOT, 'functions/migrations/runner.js')); const ms = R._loadMigrations(); return ms.some((m) => m.version === 8 && m.name === 'normalize-lead-stages'); })());

    // Readers normalise.
    const AM = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
    const sum = AM.summary([{ id: '1', stage: 'New', jobValue: 100 }, { id: '2', stage: 'new', jobValue: 100 }, { id: '3', stage: 'Closed Won', jobValue: 50000 }], '2026-10-04');
    ok("agent summary: 'New' + 'new' one bucket; 'Closed Won' not open pipeline", sum.by_stage.new === 2 && !sum.by_stage.New && sum.open_pipeline_value_projected === 200, JSON.stringify(sum));
    const MR = require(path.join(ROOT, 'functions/marketing-report.js'))._test;
    const agg = MR.aggregate({ leadDocsBySource: {}, funnelDocs: [], crmDocs: [{ webLead: true, stage: 'New' }, { webLead: true, stage: 'new' }], stormCount: 0 });
    ok("marketing report: 'New' and 'new' are one stage", agg.crmStages.new === 2 && !agg.crmStages.New);
  });

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
