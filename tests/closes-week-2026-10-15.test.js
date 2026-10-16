#!/usr/bin/env node
/**
 * tests/closes-week-2026-10-15.test.js — "What closes this week".
 *
 *   A. one ranking, two copies (functions/ + docs/pro/js/ byte-identical)
 *   B. ranking: likelihood × projected value, the transparent signals, reasons
 *   C. the next action per row
 *   D. who is never listed; no phone / email on a row
 *   E. the CRM MCP tool closes_this_week (cos / marcus / frank, read-only)
 *   F. the Home card: actions only open things or make drafts; every layout
 *
 * Run: node tests/closes-week-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CW = require(path.join(ROOT, 'functions/closes-week-logic.js'));
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}
const DAY = 86400000;
const NOW = Date.parse('2026-10-15T16:00:00Z');   // Thursday noon ET
const ago = (d) => NOW - d * DAY;
const lead = (id, o) => Object.assign({ id, firstName: id, lastName: 'Test', phone: '(859) 555-01' + String(id.length).padStart(2, '0'), email: id + '@example.com', jobValue: 10000, updatedAt: ago(5) }, o || {});
const byId = (rows) => { const m = {}; rows.forEach((r) => { m[r.leadId] = r; }); return m; };

console.log('\nA. one ranking, two copies');
ok('functions/closes-week-logic.js and docs/pro/js/closes-week-logic.js are byte-identical',
  read('functions/closes-week-logic.js') === read('docs/pro/js/closes-week-logic.js'));

console.log('\nB. likelihood × projected value');
{
  const leads = [
    lead('neg', { stage: 'negotiating', jobValue: 20000 }),
    lead('sent', { stage: 'estimate_sent_cash', jobValue: 20000, lastSharedAt: ago(4) }),
    lead('opened', { stage: 'estimate_sent_cash', jobValue: 20000, lastSharedAt: ago(5), lastViewedAt: ago(1), lastContactedAt: ago(6), updatedAt: ago(1) }),
    lead('big', { stage: 'inspected', jobValue: 60000 }),
    lead('loan', { stage: 'loan_approved', jobValue: 15000 }),
  ];
  const views = [{ leadId: 'opened', atMs: ago(1) }, { leadId: 'opened', atMs: ago(3) }, { leadId: 'opened', atMs: ago(9) }];
  const rows = CW.rank(leads, { nowMs: NOW, views });
  const m = byId(rows);
  ok('score = likelihood × projected value', rows.every((r) => r.score === Math.round(r.likelihood * r.projectedValue)), JSON.stringify(rows.map((r) => [r.leadId, r.likelihood, r.projectedValue, r.score])));
  ok('sorted by score, highest first', rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score));
  ok('stage bases: Inspected 20%, Est. Sent 30%, Negotiating 45%, Loan Approved 65% (before signals)',
    CW.BASE.inspected === 0.2 && CW.BASE.estimate_sent_cash === 0.3 && CW.BASE.negotiating === 0.45 && CW.BASE.loan_approved === 0.65 && CW.BASE.prequal_sent === 0.4);
  ok('opened twice this week (alerts inside 7 days only) → +15% and the reason says so, "no reply"',
    m.opened.reason.indexOf('opened estimate 2× this week, no reply') === 0 && m.opened.likelihoodPct === 50, m.opened.reason + ' ' + m.opened.likelihoodPct);
  ok('an estimate out 4 days, never opened, says so', /estimate out 4d, not opened/.test(m.sent.reason), m.sent.reason);
  ok('a $60k Inspected job outranks a $20k Negotiating one (value counts)', rows.findIndex((r) => r.leadId === 'big') < rows.findIndex((r) => r.leadId === 'neg'));
  ok('loan approved → +15%', m.loan.likelihoodPct === 80 && /loan approved/.test(m.loan.reason), m.loan.reason);
  ok('value is labelled projected in the row data', rows.every((r) => typeof r.projectedValue === 'number' && r.projectedValue > 0));

  const quiet = CW.rank([lead('q30', { stage: 'negotiating', updatedAt: ago(40), createdAt: ago(60) }), lead('q14', { stage: 'negotiating', updatedAt: ago(20), createdAt: ago(60) }), lead('fresh', { stage: 'negotiating', updatedAt: ago(1) })], { nowMs: NOW });
  const q = byId(quiet);
  ok('last touch: 30+ days −20%, 14–29 −10%, ≤3 days +5%', q.q30.likelihoodPct === 25 && q.q14.likelihoodPct === 35 && q.fresh.likelihoodPct === 50
    && /quiet 40 days/.test(q.q30.reason) && /touched 1 day ago/.test(q.fresh.reason), JSON.stringify(quiet.map((r) => [r.leadId, r.likelihoodPct, r.reason])));
  const fu = byId(CW.rank([lead('late', { stage: 'negotiating', followUp: '2026-10-12' })], { nowMs: NOW }));
  ok('follow-up 3 days late → −5% and the reason', fu.late.likelihoodPct === 40 && /follow-up 3 days late/.test(fu.late.reason), fu.late.reason);
  const fin = byId(CW.rank([lead('pq', { stage: 'prequal_sent' }), lead('dep', { stage: 'negotiating' })], { nowMs: NOW, deals: [{ leadId: 'pq', prequalStartedAtMs: ago(1) }], depositDraftLeadIds: ['dep'] }));
  ok('"Check my rate" started → +10%; a deposit invoice drafted → +15%', fin.pq.likelihoodPct === 50 && /started a rate check/.test(fin.pq.reason) && fin.dep.likelihoodPct === 60 && /deposit invoice drafted/.test(fin.dep.reason), JSON.stringify(fin));
  const est = byId(CW.rank([lead('nov', { stage: 'estimate_submitted', jobValue: '' })], { nowMs: NOW, estimates: [{ leadId: 'nov', grandTotal: 8000, createdAt: ago(9) }, { leadId: 'nov', grandTotal: 9100, createdAt: ago(2) }] }));
  ok('no job value → the latest estimate\'s total is the projection', est.nov && est.nov.projectedValue === 9100);
  ok('clamped to 2%–95%', CW.rank([lead('lo', { stage: 'new', updatedAt: ago(90), createdAt: ago(90), followUp: '2026-01-01' })], { nowMs: NOW })[0].likelihoodPct === 2);
  ok('limit', CW.rank(leads, { nowMs: NOW, limit: 2 }).length === 2);
}

console.log('\nC. the next action');
{
  const m = byId(CW.rank([
    lead('n', { stage: 'new' }), lead('c', { stage: 'contacted' }),
    lead('insp', { stage: 'inspected' }),
    lead('open', { stage: 'estimate_sent_cash', lastSharedAt: ago(5), lastViewedAt: ago(1) }),
    lead('unopen', { stage: 'estimate_submitted', lastSharedAt: ago(3) }),
    lead('pq', { stage: 'prequal_sent' }),
    lead('loan', { stage: 'loan_approved' }),
    lead('late', { stage: 'estimate_sent_cash', lastSharedAt: ago(5), lastViewedAt: ago(1), followUp: '2026-10-10' }),
  ], { nowMs: NOW }));
  ok('New / Contacted → book an inspection', m.n.nextAction.kind === 'book_inspection' && m.c.nextAction.kind === 'book_inspection');
  ok('opened, no reply → a text draft', m.open.nextAction.kind === 'text' && m.open.nextAction.label === 'Text (draft)');
  ok('out 2+ days, never opened → send the estimate again', m.unopen.nextAction.kind === 'resend_estimate' && m.unopen.nextAction.label === 'Send the estimate again');
  ok('Pre-Qual Sent → check rate', m.pq.nextAction.kind === 'check_rate');
  ok('Loan Approved / Inspected → call', m.loan.nextAction.kind === 'call' && m.insp.nextAction.kind === 'call');
  ok('a follow-up that is late wins: call', m.late.nextAction.kind === 'call');
}

console.log('\nD. never listed; no contact details');
{
  const rows = CW.rank([
    lead('won', { stage: 'closed', stageRole: 'won' }), lead('lost', { stage: 'lost', stageRole: 'lost' }),
    lead('job', { stage: 'install_in_progress', stageRole: 'job' }), lead('signed', { stage: 'contract_signed' }),
    lead('del', { stage: 'negotiating', deleted: true }), lead('snz', { stage: 'negotiating', snoozedUntil: NOW + DAY }),
    lead('zero', { stage: 'negotiating', jobValue: 0 }), lead('e2e', { stage: 'negotiating', e2eTestData: true }),
    lead('ok', { stage: 'negotiating' }),
  ], { nowMs: NOW });
  ok('won / lost / building / signed / deleted / snoozed / no value / test data → not listed', rows.length === 1 && rows[0].leadId === 'ok', rows.map((r) => r.leadId).join());
  const s = JSON.stringify(rows);
  ok('no phone or email on a row', !/859|@example\.com|"phone"|"email"/.test(s), s);
}

console.log('\nE. the CRM MCP tool');
{
  ok('closes_this_week is a tool with an object schema', !!L.TOOLS.closes_this_week && L.TOOLS.closes_this_week.inputSchema.type === 'object' && L.TOOLS.closes_this_week.inputSchema.additionalProperties === false);
  ok('read-only (annotation) and not a filing', L.annotationsFor('closes_this_week').readOnlyHint === true && L.WRITES.indexOf('closes_this_week') === -1);
  ok('cos, marcus and frank have it', ['cos', 'marcus', 'frank'].every((b) => L.botAllows(b, 'closes_this_week')));
  ok('the personal bots do not', !L.botAllows('coach', 'closes_this_week') && !L.botAllows('board', 'closes_this_week'));
  const leads = [lead('a', { stage: 'negotiating', jobValue: 30000, lastViewedAt: ago(1), lastSharedAt: ago(4) }), lead('b', { stage: 'estimate_sent_cash', jobValue: 9000 }), lead('c', { stage: 'closed', stageRole: 'won' })];
  const out = L.closesThisWeek(leads, [], [], [{ leadId: 'a', atMs: ago(1) }, { leadId: 'a', atMs: ago(2) }], { limit: 5 }, NOW, 'America/New_York');
  ok('rows: lead_id, name, stage, projected_value, likelihood_pct, score, reason, next_action', out.length === 2 && out[0].lead_id === 'a'
    && ['lead_id', 'name', 'stage', 'projected_value', 'likelihood_pct', 'score', 'reason', 'next_action'].every((k) => Object.prototype.hasOwnProperty.call(out[0], k)), JSON.stringify(out));
  ok('the reason reads like the card ("opened estimate 2× this week, no reply")', /opened estimate 2× this week, no reply/.test(out[0].reason), out[0].reason);
  const s = JSON.stringify(out);
  ok('no phone, no email, no forbidden key in the tool output', !/859|@example\.com/.test(s) && L.FORBIDDEN_KEYS.every((k) => s.indexOf('"' + k + '"') === -1));
  ok('limit defaults to 10 and caps at 50', L.closesThisWeek(Array.from({ length: 60 }, (_, i) => lead('x' + i, { stage: 'negotiating' })), [], [], [], {}, NOW).length === 10
    && L.closesThisWeek(Array.from({ length: 60 }, (_, i) => lead('x' + i, { stage: 'negotiating' })), [], [], [], { limit: 999 }, NOW).length === 50);
  const mcp = read('functions/agent-mcp.js');
  const blk = mcp.slice(mcp.indexOf("if (name === 'closes_this_week')"), mcp.indexOf("if (name === 'collected_revenue')"));
  ok('agent-mcp.js dispatches it from the company\'s own leads / estimates / deal rooms / view alerts, no write', /companyLeads\(company\)/.test(blk) && /'estimate_viewed'/.test(blk) && !/\.(set|update|add|delete)\(/.test(blk));
  ok('the Settings label exists', /closes_this_week: 'What closes this week'/.test(read('docs/pro/js/agent-bots-settings.js')));
}

console.log('\nF. the Home card');
{
  const src = read('docs/pro/js/closes-week.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');
  ok('the card sends nothing (no fetch, no send call, no Firestore write)', !/fetch\(|sendSMS|sendEmail|_platformPost|addDoc|setDoc|updateDoc|httpsCallable/.test(code));
  // vm: the DOM half's action markup
  const win = { _leadsLoaded: false, addEventListener() {}, _isNbdPlatformTenant: () => true, NBDEstimateFollowups: { computeFollowups: () => ({ rows: [{ leadId: 'unopen' }] }) } };
  win.window = win;
  const doc = { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null, body: {} };
  const c = { window: win, document: doc, localStorage: { getItem: () => JSON.stringify({ username: 'joedeal' }) }, setTimeout: () => 0, Math, JSON, Date, encodeURIComponent, String, Number, Array, Object, MutationObserver: function () { this.observe = () => {}; } };
  vm.createContext(c);
  vm.runInContext(read('docs/pro/js/closes-week.js'), c);
  const A = win.NBDClosesWeek._actionHtml;
  const L1 = { phone: '(859) 555-0142', firstName: 'Pat' };
  const row = (k, id) => ({ leadId: id || 'L1', nextAction: { kind: k, label: CW.ACTION_LABELS[k] } });
  ok('call → a plain tel: link', /href="tel:\+18595550142"/.test(A(row('call'), L1, {})));
  const t = A(row('text'), L1, {});
  ok('text → an sms: link with the draft typed (Joe presses Send)', /href="sms:\+18595550142\?&amp;body=Hi%20Pat%2C%20/.test(t) && !/claim|insurance/i.test(decodeURIComponent(t)), t);
  ok('send the estimate again → the estimate follow-ups share sheet (data-ef-send)', /data-ef-send="unopen"/.test(A(row('resend_estimate', 'unopen'), L1, { unopen: 1 })));
  ok('…and the customer page when that lead is not on the follow-up list', /href="\/pro\/customer\.html\?id=L1"/.test(A(row('resend_estimate'), L1, {})));
  const cr = decodeURIComponent(A(row('check_rate'), L1, {}));
  ok('check rate → a text draft with the Acorn link and Acorn\'s soft-check wording', /https:\/\/www\.acornfinance\.com\/pre-qualify\/\?d=QU6WZ/.test(cr) && /soft credit check, it does not affect your credit score/.test(cr), cr);
  ok('book an inspection → a text draft with the booking link', /cal\.com\/joedeal\/roof-inspection/.test(decodeURIComponent(A(row('book_inspection'), L1, {}))));
  ok('no phone on file → the customer page, never a broken link', /href="\/pro\/customer\.html\?id=L1"/.test(A(row('call'), {}, {})));
  const card = win.NBDClosesWeek._cardHtml([{ leadId: 'L1', name: '<b>x</b>', stageLabel: 'Negotiating', projectedValue: 12000, likelihoodPct: 50, score: 6000, reason: 'opened estimate 2× this week, no reply', nextAction: { kind: 'call', label: 'Call' } }]);
  ok('each row taps through to the customer; value says "projected"; names are escaped', /class="cwk-main" href="\/pro\/customer\.html\?id=L1"/.test(card) && /\$12,000 projected/.test(card) && card.indexOf('<b>x</b>') === -1);
  ok('no inline handlers or styles', !/\son[a-z]+=|style="/i.test(card + t));

  const dash = read('docs/pro/dashboard.html');
  ok('Home template: #homeClosesWeek right after #todayPlan, outside .home-more (Classic, Bento, Island)', dash.indexOf('id="homeClosesWeek"') > dash.indexOf('id="todayPlan"') && dash.indexOf('id="homeClosesWeek"') < dash.indexOf('class="home-more'));
  for (const [f, slot] of [['focus', 'focus'], ['field', 'field'], ['inbox', 'inbox'], ['crew', 'crew'], ['mission', 'mission']]) {
    ok('the ' + f + ' layout leaves a [data-cwk-slot] in its own markup', read('docs/pro/js/layouts/' + f + '.js').indexOf('data-cwk-slot="' + slot + '"') !== -1);
  }
  ok('every registered layout is covered (no new layout without a slot or Home)', (() => {
    const ls = read('docs/pro/js/layout-system.js');
    const ids = [...ls.matchAll(/id: '([a-z-]+)', name:/g)].map((x) => x[1]);
    const covered = { classic: 1, bento: 1, island: 1, focus: 1, field: 1, inbox: 1, crew: 1, mission: 1 };
    return ids.length >= 7 && ids.every((i) => covered[i] || i === 'FALLBACK');
  })(), [...read('docs/pro/js/layout-system.js').matchAll(/id: '([a-z-]+)', name:/g)].map((x) => x[1]).join());
  const sl = read('docs/pro/js/script-loader.js');
  ok('lazy bundle "closesweek" (css + logic + card), no boot <script> tag', /closesweek: \[\s*'css\/closes-week\.css\?v=2',\s*'js\/closes-week-logic\.js\?v=1',\s*'js\/closes-week\.js\?v=2'\s*\]/.test(sl) && !/<script[^>]*closes-week/.test(dash));
  ok('today-home.js kicks it at Home boot', /loadBundle\('closesweek'\)/.test(read('docs/pro/js/today-home.js')) && /today-home\.js\?v=18/.test(dash));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
