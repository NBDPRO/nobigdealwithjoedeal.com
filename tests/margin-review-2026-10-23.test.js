#!/usr/bin/env node
/**
 * Weekly margin review (queue item 5, 2026-10-23): agent tool `margin_review`
 * (Frank only, read only, INTERNAL). Jobs finished in the window whose margin
 * is >= 5 points below the company's own margin on the prior 90 days, with
 * the biggest direct cost category. Cents math; collected money only.
 * Run: node tests/margin-review-2026-10-23.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const NOW = Date.parse('2026-10-23T16:00:00Z');
const DAY = 86400000;
const iso = (n) => new Date(NOW - n * DAY).toISOString();
const job = (id, ago) => ({ id, name: 'Job ' + id, address: id + ' St', stage: 'final_payment', stageRole: 'won', completedAt: iso(ago), createdAt: iso(ago + 30) });
const inv = (id, cents, ago) => ({ leadId: id, total: cents / 100, balanceDue: 0, payments: [{ amount: cents / 100, at: iso(ago) }] });
const exp = (id, category, cents) => ({ leadId: id, costType: 'direct', category, amountCents: cents, taxCents: 0 });
const leads = [], invoices = [], expenses = [];
function add(id, ago, collected, costs) {
  leads.push(job(id, ago)); invoices.push(inv(id, collected, ago));
  (costs || []).forEach(([c, n]) => expenses.push(exp(id, c, n)));
}
// Baseline: three jobs, each $10,000 collected, $6,000 direct = 40%.
add('b1', 20, 1000000, [['materials', 400000], ['direct_labor', 200000]]);
add('b2', 40, 1000000, [['materials', 400000], ['direct_labor', 200000]]);
add('b3', 60, 1000000, [['materials', 400000], ['direct_labor', 200000]]);
add('b0', 30, 1000000, []); // collected but no costs logged: must not drag the baseline up
expenses.push({ leadId: 'r1', costType: 'overhead', category: 'marketing', amountCents: 900000, taxCents: 0 }); // overhead never counts against a job
// Recent window (last 7 days)
add('r1', 2, 1000000, [['materials', 600000], ['subcontractor', 200000]]); // 20% -> flagged
add('r2', 2, 1000000, [['materials', 620000]]);                             // 38% -> within 5 points
add('r3', 3, 1000000, []);                                                  // no costs logged -> skipped
add('r4', 1, 1000000, [['materials', 650000]]);                             // 35% -> exactly 5 below -> flagged
add('r5', 1, 1000000, [['materials', 640000]]);                             // 36% -> not flagged
const r = L.marginReview(leads, invoices, expenses, NOW, {}, 'America/New_York', null);
const ids = r.flagged.map((f) => f.lead_id);

console.log('A. judgement');
ok('baseline is the collected-weighted margin of prior jobs (40%)', r.baseline_margin_pct === 40 && r.baseline_jobs === 3, JSON.stringify([r.baseline_margin_pct, r.baseline_jobs]));
ok('positive: a job 20 points down is flagged', ids.includes('r1'), ids.join());
ok('positive: exactly 5 points below is flagged (boundary)', ids.includes('r4'));
ok('negative: 4 points below / 2 points below are not flagged', !ids.includes('r5') && !ids.includes('r2'));
ok('negative: a job with no costs logged is skipped, not judged', !ids.includes('r3') && r.jobs_skipped_no_costs === 1);
ok('only judged jobs are counted in the review (r1 r2 r4 r5)', r.jobs_reviewed === 4, String(r.jobs_reviewed));
ok('baseline jobs are never flagged themselves', !ids.some((i) => /^b/.test(i)));
ok('worst first', ids[0] === 'r1' && r.flagged[0].points_below === 20, JSON.stringify(r.flagged[0]));

console.log('B. reason and shape');
const f1 = r.flagged.find((f) => f.lead_id === 'r1');
ok('reason: the biggest direct cost category and its share of collected', f1.top_cost.category === 'materials' && f1.top_cost.pct_of_collected === 60, JSON.stringify(f1.top_cost));
ok('whole-percent integers, collected in dollars from cents', Number.isInteger(f1.margin_pct) && f1.margin_pct === 20 && f1.collected === 10000);
ok('marked INTERNAL', /INTERNAL/.test(r.note));
const thin = L.marginReview(leads.filter((l) => !/^b[23]$/.test(l.id)), invoices, expenses, NOW, {}, 'America/New_York', null);
ok('negative: under 3 baseline jobs -> no baseline, nothing flagged, says why', thin.baseline_margin_pct === null && thin.flagged.length === 0 && /Not enough history/.test(thin.note));
const none = L.marginReview(leads, invoices.map((i) => Object.assign({}, i, { payments: [] })), expenses, NOW, {}, 'America/New_York', null);
ok('negative: money not collected is not margin (no payments -> nothing judged)', none.jobs_reviewed === 0 && none.flagged.length === 0);

console.log('C. wiring');
const srv = fs.readFileSync(path.join(ROOT, 'functions/agent-mcp.js'), 'utf8');
const has = (b, t) => L.toolsForBot(b).some((x) => x.name === t);
ok('margin_review is Frank\'s alone', Object.keys(L.BOTS).filter((b) => L.BOTS[b].tools.includes('margin_review')).join() === 'frank' && has('frank', 'margin_review'));
ok('read only: not in WRITES, annotated read-only', !L.WRITES.includes('margin_review') && L.toolsForBot('frank').find((t) => t.name === 'margin_review').annotations.readOnlyHint === true);
ok('handler reads only this company\'s data', /name === 'margin_review'[\s\S]{0,400}companyDocs\('invoices', company/.test(srv) && /L\.marginReview\(/.test(srv));
const scan = (d, acc) => { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) scan(p, acc); else if (/.(js|html|json|md|txt|xml)$/.test(e.name)) acc.push(p); }); return acc; };
const pub = scan(path.join(ROOT, 'docs'), []);
ok('nothing published under docs/ mentions the tool (scanned ' + pub.length + ' files)', pub.length > 100 && !pub.some((p) => /margin_review/.test(fs.readFileSync(p, 'utf8'))));
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
