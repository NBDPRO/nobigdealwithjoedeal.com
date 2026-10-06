#!/usr/bin/env node
/**
 * Bot team MCP v1.1 — tools matched to every role (Jo, 2026-10-02: "perfect
 * all the bots and all their roles as well as the MCP itself to match").
 *   rules_reference      Quinn / Marcus / Tucker / Dana — tiers, warranty, deposit, KY lines, house rules
 *   post_job             Tucker — finished jobs: days since, balance owed, review asked, warranty, anniversary
 *   lead_sources         CoS / Dana / Frank / Theo — leads per source, win rate, spend, cost per lead
 *   job_profit           Frank — collected minus direct costs per finished job (internal)
 *   storm_near_customers Marcus / Quinn — NWS storm reports with the customers within R miles
 *   team_activity        CoS / Priya — what each bot did and how Jo decided its filings
 * plus MCP tool annotations (read-only hints) and server version (1.3.0 since the 2026-10-06 list_leads paging).
 *
 * Run: node tests/agent-mcp-roles-v2-2026-10-02.test.js  (section E needs FIRESTORE_EMULATOR_HOST)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

(async () => {
  const NOW = Date.parse('2026-10-02T20:00:00Z');
  const DAY = 86400000;
  const iso = (n) => new Date(NOW - n * DAY).toISOString();

  console.log('A. roles ↔ tools');
  const has = (b, t) => L.botAllows(b, t);
  ok('every listed tool exists, for every bot', Object.values(L.BOTS).every((b) => b.tools.every((t) => !!L.TOOLS[t])));
  ok('Quinn can check against the rules, storms, money and estimates', ['rules_reference', 'storm_near_customers', 'collected_revenue', 'estimates_status', 'verify_item'].every((t) => has('quinn', t)));
  ok('Tucker gets finished jobs + the rules', has('tucker', 'post_job') && has('tucker', 'rules_reference'));
  ok('Marcus gets storms near customers + the rules', has('marcus', 'storm_near_customers') && has('marcus', 'rules_reference'));
  ok('Frank gets job profit + lead sources', has('frank', 'job_profit') && has('frank', 'lead_sources'));
  ok('Dana + Theo get lead sources; Dana the rules for copy', has('dana', 'lead_sources') && has('theo', 'lead_sources') && has('dana', 'rules_reference'));
  ok('CoS gets team activity + lead sources; Priya team activity', has('cos', 'team_activity') && has('cos', 'lead_sources') && has('priya', 'team_activity'));
  ok('job_profit (cost + margin) is Frank\'s alone', Object.keys(L.BOTS).filter((b) => has(b, 'job_profit')).join() === 'frank');
  ok('personal bots got none of the new business tools', ['coach', 'board'].every((b) => !['rules_reference', 'post_job', 'lead_sources', 'job_profit', 'storm_near_customers', 'team_activity'].some((t) => has(b, t))));
  ok('no new tool sends, edits or deletes', !['rules_reference', 'post_job', 'lead_sources', 'job_profit', 'storm_near_customers', 'team_activity'].some((t) => L.WRITES.includes(t)));
  const ann = L.toolsForBot('quinn');
  ok('tools/list carries MCP annotations: reads are read-only, filings are not, nothing destructive',
    ann.find((t) => t.name === 'rules_reference').annotations.readOnlyHint === true && ann.find((t) => t.name === 'verify_item').annotations.readOnlyHint === false && ann.every((t) => t.annotations.destructiveHint === false));
  ok('server version 1.3.0 (2026-10-06 drafts, then list_leads paging)', L.SERVER_INFO.version === '1.3.0');

  console.log('B. rules_reference matches the CRM\'s own config (no drift)');
  const CFG = require(path.join(ROOT, 'docs/pro/js/estimate-config.js'));
  const r = L.rulesReference();
  ok('tier keys + order match TIER_ORDER', r.tiers.map((t) => t.key).join() === (CFG.TIER_ORDER || Object.keys(CFG.TIER_RATES)).join(), r.tiers.map((t) => t.key).join());
  ok('per-SQ retail rates match TIER_RATES', r.tiers.every((t) => CFG.TIER_RATES[t.key] === t.ratePerSq), JSON.stringify(CFG.TIER_RATES));
  ok('customer-facing labels match TIER_DISPLAY', r.tiers.every((t) => CFG.TIER_DISPLAY[t.key].label === t.label));
  ok('warranty wording follows the TIER_DISPLAY flags', r.tiers.every((t) => {
    const w = CFG.TIER_DISPLAY[t.key].warranty;
    if (w.systemWarranty === false && !/no system warranty/.test(t.warranty)) return false;
    if (w.workmanshipYears && !new RegExp(w.workmanshipYears + '-year').test(t.warranty)) return false;
    if (w.transferable === false && !/not transferable/.test(t.warranty)) return false;
    if (w.transferWindowDays && !new RegExp(w.transferWindowDays + ' days').test(t.warranty)) return false;
    if (w.inspection && !/inspection|Elite warranty/.test(t.warranty)) return false;
    if (w.hailWarranty && !/hail/.test(t.warranty)) return false;
    return true;
  }));
  ok('workmanship years by job type match WORKMANSHIP_WARRANTY', Object.keys(L.WORKMANSHIP_YEARS).every((k) => {
    const v = CFG.WORKMANSHIP_WARRANTY && CFG.WORKMANSHIP_WARRANTY[k];
    return v != null && (typeof v === 'number' ? v : (v.years != null ? v.years : v.workmanshipYears)) === L.WORKMANSHIP_YEARS[k];
  }), JSON.stringify(CFG.WORKMANSHIP_WARRANTY));
  ok('deposit rule matches DEPOSIT_RULE', CFG.DEPOSIT_RULE.CASH_NO_DEPOSIT_UNDER_CENTS === L.DEPOSIT.cashNoDepositUnderCents && CFG.DEPOSIT_RULE.CASH_DEPOSIT_PCT === L.DEPOSIT.cashDepositPct);
  ok('Kentucky lines come from the server\'s jurisdiction module', /KRS 367\.626/.test(r.kentucky_insurance_jobs.crm_messages.depositHold || '') && r.kentucky_insurance_jobs.never_say.length >= 3);
  ok('house rules: subs not in-house, revenue = collected, no public cost figures', /independent subcontractors/.test(r.house_rules[0]) && /collected/.test(r.house_rules[1]) && /cost/.test(r.house_rules[2]));
  ok('the reference passes the Kentucky wording guard itself', !L.claimWordingProblem(JSON.stringify(r).replace(/never_say[^\]]*\]/, '')));

  console.log('C. finished jobs, sources, profit, storms');
  const leads = [
    { id: 'A', firstName: 'Ann', lastName: 'Lee', address: '1 A St', stage: 'final_payment', stageRole: 'won', completedAt: iso(20), reviewRequested: true, warranty: { tierLabel: 'Elite' }, source: 'Referral', createdAt: iso(60), lat: 39.0, lng: -84.6, phone: '859-555-0101' },
    { id: 'B', name: 'Bob Roe', address: '2 B St', stage: 'install_complete', stageStartedAt: iso(5), source: 'Door Knock', createdAt: iso(30), lat: 39.02, lng: -84.6 },
    { id: 'C', name: 'Cy Doe', address: '3 C St', stage: 'lost', source: 'Door Knock', createdAt: iso(40), lat: 39.5, lng: -84.6 },
    { id: 'D', name: 'Di Poe', address: '4 D St', stage: 'negotiating', source: 'Website — Free inspection', createdAt: iso(10) },
    { id: 'E', name: 'Old Job', stage: 'closed', completedAt: iso(400), source: 'Referral', createdAt: iso(500) },
  ];
  const invoices = [
    { leadId: 'A', total: 12000, balanceDue: 0, payments: [{ amount: 6000, at: iso(30) }, { amount: 6000, at: iso(18) }] },
    { leadId: 'B', total: 9000, balanceDue: 4500, status: 'sent', payments: [{ amount: 4500, at: iso(6) }] },
  ];
  const expenses = [
    { leadId: 'A', costType: 'direct', amountCents: 500000, taxCents: 30000 },
    { leadId: 'A', costType: 'overhead', amountCents: 99999 },
    { marketingSource: 'Door Knock', amountCents: 20000, date: iso(10).slice(0, 10) },
  ];
  const pj = L.postJob(leads, invoices, NOW, {});
  ok('post_job: finished jobs only, newest first, old ones out', pj.map((j) => j.lead_id).join() === 'B,A', pj.map((j) => j.lead_id).join());
  ok('post_job: days since, balance owed, review asked, warranty tier; no phone', pj[0].days_since === 5 && pj[0].balance_owed === 4500 && pj[1].review_requested === true && pj[1].warranty_tier === 'Elite' && !JSON.stringify(pj).includes('859-555'));
  const ls = L.leadSources(leads, expenses, NOW, 90);
  const dk = ls.sources.find((s) => s.source === 'Door Knock');
  ok('lead_sources: per source counts, win rate, spend, cost per lead', dk.leads === 2 && dk.won === 1 && dk.lost === 1 && dk.win_rate === 50 && dk.spend === 200 && dk.cost_per_lead === 100, JSON.stringify(dk));
  ok('lead_sources: outside the window excluded, no names', !ls.sources.some((s) => s.leads && s.source === 'Referral' && s.leads > 1) && !JSON.stringify(ls).includes('Ann'));
  const jp = L.jobProfit(leads, invoices, expenses, NOW, {});
  const a = jp.jobs.find((j) => j.lead_id === 'A');
  ok('job_profit: collected − direct costs (tax in, overhead out)', a.collected === 12000 && a.direct_costs === 5300 && a.profit === 6700 && a.margin_pct === 56, JSON.stringify(a));
  ok('job_profit: a job with no costs logged says so', jp.jobs.find((j) => j.lead_id === 'B').costs_logged === false && /INTERNAL/.test(jp.note));
  const ev = [{ kind: 'hail', mag: 1.75, lat: 39.01, lon: -84.6, city: 'Florence', st: 'KY', valid: iso(2) }, { kind: 'wind', mag: 70, lat: 41, lon: -80, valid: iso(1) }, { kind: 'hail', lat: 39.0, lon: -84.6, valid: iso(40) }];
  const st = L.stormNearCustomers(ev, leads, NOW, { days: 14, miles: 3 });
  ok('storm_near_customers: recent events, customers within R miles, nearest first', st.events.length === 2 && st.events[1].customers_within === 2 && st.events[1].customers[0].miles <= st.events[1].customers[1].miles && st.events[0].customers_within === 0, JSON.stringify(st.events.map((e) => [e.kind, e.customers_within])));
  ok('storm_near_customers: says it is area data, not roof proof', /not per-roof proof/.test(st.note) && st.customers_without_location >= 1);
  ok('haversine sanity (0.01° lat ≈ 0.69 mi)', Math.abs(L.haversineMi(39, -84.6, 39.01, -84.6) - 0.69) < 0.01);
  const ta = L.teamActivity([{ botId: 'marcus', ok: true, at: NOW - 1000 }, { botId: 'coach', ok: true, at: NOW }], [{ botId: 'marcus', status: 'approved', createdAt: NOW }, { botId: 'marcus', status: 'dismissed', createdAt: NOW }], NOW, 7);
  ok('team_activity: per bot calls, filings, approval rate; personal bots never shown', ta.bots.find((b) => b.bot_id === 'marcus').approval_rate === 50 && !ta.bots.some((b) => b.bot_id === 'coach'));

  console.log('D. server wiring');
  const srv = read('functions/agent-mcp.js');
  ok('each new tool has a handler', ['rules_reference', 'post_job', 'lead_sources', 'job_profit', 'storm_near_customers', 'team_activity'].every((t) => srv.includes("name === '" + t + "'")));
  ok('storm events matched only against THIS company\'s customers', /collection\('storm_events'\)\.where\('processedAt', '>=',/.test(srv) && /L\.stormNearCustomers\(ev\.docs\.map\(\(d\) => d\.data\(\)\), leads,/.test(srv));
  ok('team activity reads only this company\'s audit + inbox', /collection\('agent_audit'\)\.where\('companyId', '==', company\)/.test(srv) && /collection\('agent_inbox'\)\.where\('companyId', '==', company\)/.test(srv));

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log('E. emulator end to end');
    const { initializeApp, getApps } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
    if (!getApps().length) initializeApp({ projectId: 'nbd-test' });
    const { getFirestore } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
    const db = getFirestore();
    const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'))._internal;
    const CO = 'co-roles-v2';
    await db.doc('leads/rA').set({ companyId: CO, userId: CO, firstName: 'Ann', stage: 'final_payment', stageRole: 'won', completedAt: new Date(Date.now() - 10 * DAY), lat: 39.0, lng: -84.6, source: 'Referral', createdAt: new Date(Date.now() - 20 * DAY) });
    await db.doc('leads/rX').set({ companyId: 'other-co', userId: 'other-co', firstName: 'Other', stage: 'final_payment', stageRole: 'won', completedAt: new Date(), lat: 39.0, lng: -84.6 });
    await db.doc('invoices/iA').set({ companyId: CO, createdBy: CO, leadId: 'rA', total: 10000, balanceDue: 0, payments: [{ amount: 10000, at: new Date(Date.now() - 9 * DAY).toISOString() }] });
    await db.doc('expenses/eA').set({ companyId: CO, userId: CO, leadId: 'rA', costType: 'direct', amountCents: 400000, taxCents: 0 });
    await db.doc('storm_events/s1').set({ kind: 'hail', mag: 1.5, lat: 39.005, lon: -84.6, city: 'Florence', st: 'KY', valid: new Date().toISOString(), processedAt: new Date() });
    const key = (b) => ({ id: 'k-' + b, botId: b, companyId: CO, scope: 'crm', ownerUid: null });
    const call = async (b, name, args) => JSON.parse((await M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }, key(b))).result.content[0].text);
    const p = await call('tucker', 'post_job');
    ok('Tucker: post_job returns only this company\'s finished job', p.jobs.length === 1 && p.jobs[0].lead_id === 'rA', JSON.stringify(p));
    const f = await call('frank', 'job_profit');
    ok('Frank: job_profit 10,000 collected − 4,000 direct = 6,000', f.jobs[0].profit === 6000 && f.jobs[0].margin_pct === 60, JSON.stringify(f.jobs));
    const s = await call('marcus', 'storm_near_customers', { days: 3 });
    ok('Marcus: the storm finds this company\'s customer, never the other company\'s', s.events[0].customers_within === 1 && s.events[0].customers[0].lead_id === 'rA', JSON.stringify(s.events[0]));
    // NBD's own rules for NBD's house team (another company gets its own —
    // tests/agent-tenant-bots-2026-10-04.test.js).
    const q = JSON.parse((await M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rules_reference', arguments: {} } }, Object.assign(key('quinn'), { companyId: M.NBD_OWNER_UID }))).result.content[0].text);
    ok('Quinn: rules_reference over the wire', q.tiers.length === 5);
    const denied = (await M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'job_profit', arguments: {} } }, key('dana'))).result;
    ok('Dana asking for job_profit is refused', denied.isError === true);
  } else {
    console.log('E. (skipped — no FIRESTORE_EMULATOR_HOST)');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
