#!/usr/bin/env node
/**
 * tests/ai-evals/run-evals.js — current model vs claude-haiku-5-5, per route.
 *
 *   ANTHROPIC_API_KEY=... node tests/ai-evals/run-evals.js [--runs 3] [--routes a,b]
 *   node tests/ai-evals/run-evals.js --self-check     (no API: the checks on known-good answers)
 *
 * NOT run in CI: it calls the live Anthropic API and spends money (about
 * $0.01 for the default 3 runs x 5 routes x 2 models). Needs functions/ deps
 * (cd functions && npm ci) for @anthropic-ai/sdk. See README.md.
 */
'use strict';

const path = require('path');
const FN = (p) => path.join(__dirname, '..', '..', 'functions', p);
const Models = require(FN('ai-models.js'));
const AiSpend = require(FN('ai-spend.js'));
const { CASES, parseJson } = require('./evals');

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; };
const RUNS = Math.max(1, Math.min(10, Number(arg('--runs', 3)) || 3));
const ROUTES = (arg('--routes', '') || Object.keys(CASES).join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// Known-good answers, to prove the checks pass when the model does its job.
const GOOD = {
  'call-center-notes': { call_type: 'customer', summary: 'Pat Example called about the back porch gutter leaking again. Jo will look Thursday and email the repair quote by Friday.', promises: [{ who: 'jo', text: 'Email the gutter repair quote', due: '2026-10-09' }, { who: 'them', text: 'Leave the side gate unlocked', due: null }], follow_up_date: '2026-10-08', urgent: false, caller_name: 'Pat Example', street: 'Oak Hill Drive', town: 'Florence', service: 'gutters' },
  'call-center-facts': { caller_name: 'Pat Example', street: 'Oak Hill Drive', town: 'Florence', service: 'gutters' },
  'text-notes': { call_type: 'customer', summary: 'Pat asked about the gutter quote; Jo will send it tomorrow morning.', promises: [{ who: 'jo', text: 'Send Pat the gutter quote', due: '2026-10-08' }], follow_up_date: null, urgent: false },
  'visit-notes': { visit_type: 'inspection', summary: 'Jo inspected the roof: two layers, about 28 squares, 6/12 pitch, two soft spots by the chimney.', promises: [{ who: 'jo', text: 'Send the estimate', due: '2026-10-12' }], follow_ups: [], scope_facts: ['two layers', 'about 28 squares', '6/12 pitch'], insurance: { carrier: 'State Example' }, speakers: [], urgent: false },
  'promise-cleanup': { results: [{ promise: 0, kept: true, evidence: 'E1', quote: 'Emailed Pat the gutter repair quote' }, { promise: 1, kept: false, evidence: '', quote: '' }] },
};

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

function selfCheck() {
  let bad = 0;
  for (const r of ROUTES) {
    const checks = CASES[r].score(JSON.stringify(GOOD[r]));
    const failedChecks = checks.filter((c) => !c.ok);
    if (failedChecks.length) bad++;
    console.log(pad(r, 20) + (failedChecks.length ? 'FAIL ' + failedChecks.map((c) => c.name + ' ' + JSON.stringify(c.detail)).join('; ') : 'ok (' + checks.length + ' checks)'));
    const none = CASES[r].score('no json');
    if (none.every((c) => c.ok)) { bad++; console.log(pad(r, 20) + 'FAIL: a non-answer passes'); }
  }
  console.log(bad ? '\nself-check FAILED' : '\nself-check passed: every route\'s checks pass a good answer and fail a non-answer');
  process.exit(bad ? 1 : 0);
}

async function main() {
  if (argv.includes('--self-check')) return selfCheck();
  for (const r of ROUTES) if (!CASES[r]) { console.error('no eval case for route ' + r); process.exit(2); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set (this eval calls the live API; --self-check runs without it).'); process.exit(2); }
  let Sdk;
  try { Sdk = require(require.resolve('@anthropic-ai/sdk', { paths: [FN('')] })); } catch (_) { console.error('@anthropic-ai/sdk not found: cd functions && npm ci'); process.exit(2); }
  const client = new Sdk.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const rows = [];
  for (const route of ROUTES) {
    const entry = Models.routeConfig(route);
    const c = CASES[route];
    for (const model of [entry.model, Models.EVAL_CANDIDATE]) {
      const row = { route, model, pass: 0, runs: 0, fails: {}, stops: {}, inTok: 0, outTok: 0, micros: 0, errors: 0 };
      for (let i = 0; i < RUNS; i++) {
        row.runs++;
        let msg;
        try {
          // The same request ai-client.js sends for this route, with the model swapped.
          msg = await client.messages.create(
            { model, max_tokens: entry.maxTokens, system: c.system, messages: [{ role: 'user', content: c.prompt }] },
            { timeout: entry.timeoutMs || 60000, maxRetries: entry.maxRetries == null ? 1 : entry.maxRetries });
        } catch (e) {
          row.errors++; row.fails['API error ' + (e.status || e.name)] = (row.fails['API error ' + (e.status || e.name)] || 0) + 1;
          continue;
        }
        row.stops[msg.stop_reason] = (row.stops[msg.stop_reason] || 0) + 1;
        const spendRow = AiSpend.rowFromAnthropic(route, model, msg);
        row.inTok += spendRow.inputTokens; row.outTok += spendRow.outputTokens;
        row.micros += AiSpend.costMicros(spendRow).micros;
        const text = (msg.content || []).map((b) => (b && b.type === 'text' ? b.text : '')).join('').trim();
        const checks = c.score(text);
        const failedChecks = checks.filter((x) => !x.ok);
        if (!failedChecks.length) row.pass++;
        for (const f of failedChecks) row.fails[f.name] = (row.fails[f.name] || 0) + 1;
        if (!parseJson(text) && msg.stop_reason === 'max_tokens') row.fails['hit max_tokens'] = (row.fails['hit max_tokens'] || 0) + 1;
      }
      rows.push(row);
    }
  }

  console.log('\n' + pad('route', 20) + pad('model', 28) + pad('pass', 7) + pad('stop reasons', 22) + pad('avg in/out tok', 16) + pad('$/call', 10) + 'failed checks');
  console.log('-'.repeat(130));
  for (const r of rows) {
    const ok = r.runs - r.errors;
    console.log(pad(r.route, 20) + pad(r.model, 28) + pad(r.pass + '/' + r.runs, 7)
      + pad(Object.entries(r.stops).map(([k, v]) => k + ':' + v).join(' '), 22)
      + pad(ok ? Math.round(r.inTok / ok) + '/' + Math.round(r.outTok / ok) : '-', 16)
      + pad(ok ? '$' + (r.micros / ok / 1e6).toFixed(5) : '-', 10)
      + (Object.entries(r.fails).map(([k, v]) => k + ' x' + v).join('; ') || '-'));
  }
  console.log('\nVerdict (a switch is a one-line change to functions/ai-models.js, in its own PR, after Joe\'s OK):');
  for (const route of ROUTES) {
    const cur = rows.find((r) => r.route === route && r.model !== Models.EVAL_CANDIDATE) || rows.find((r) => r.route === route);
    const cand = rows.find((r) => r.route === route && r.model === Models.EVAL_CANDIDATE);
    const verdict = cand.pass === cand.runs && cand.pass >= cur.pass ? 'PASS: Haiku 5.5 held every check' : 'FAIL: stay on ' + cur.model;
    console.log('  ' + pad(route, 20) + verdict);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
