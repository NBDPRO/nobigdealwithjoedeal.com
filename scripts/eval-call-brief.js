#!/usr/bin/env node
/**
 * scripts/eval-call-brief.js — the Call Brief eval harness (Call to Close P0
 * step 0, 2026-11-09; design documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §9).
 *
 * Scores the Call Brief on labelled calls: the same prompt the callable sends
 * (functions/call-brief-logic.js buildRequest), the same server sanitising
 * (grounding, digit rule, dates, reliability), the same human-filed gate.
 *
 *   node scripts/eval-call-brief.js
 *       OFFLINE (the default, and what CI runs): the synthetic fixtures in
 *       tests/fixtures/call-brief-eval.json, each scored on its own canned
 *       model answer. No network, no key, no cost. Proves the harness and
 *       the server checks, not the model.
 *
 *   ANTHROPIC_API_KEY=… node scripts/eval-call-brief.js --live [--model claude-sonnet-5-5] [--cases <file|dir>]
 *       LIVE (Jo's run, spends real API money, needs his OK): asks the real
 *       model for every case. --cases points at Jo's ~20 labelled real NBD
 *       calls, kept OUTSIDE the repo (they hold customer PII): JSON files in
 *       the same shape as the fixture file ({ cases: [...] } or one case per
 *       file). Run it once per model (Haiku 4.5, Sonnet 5.5) and compare.
 *
 *   Bars (exit 1 when a given bar is missed; none are applied by default,
 *   because Jo sets them):
 *       --bar-precision 0.95   kept facts whose value matches the label
 *       --bar-claim 1          claim # exact match
 *       --bar-promise 0.8      promise who + kind accuracy
 *       --bar-reliable 1       unreliable transcripts caught
 *
 * Metrics, per case and overall:
 *   precision   of the fields the brief kept, the share that match the label
 *   recall      of the labelled fields, the share the brief found
 *   claim       claim # exact match (cases that label a claim # or say there is none)
 *   promise     greedy who + kind match / max(expected, got)
 *   reliable    the brief's reliable flag equals the label
 *   gate        the human-filed gate refused exactly the cases labelled refused
 *   dropped     what the server dropped (ungrounded, digits, dates, injection)
 *
 * Case shape: { id, kind, callYmd, direction, call:{status,leadId,attachedBy?,
 * movedBy?,alternateLeadIds}, transcript, expect:{ reliable, refused, cutOff?,
 * fields:{key:value}, promises:[{who,kind}] }, canned:<model JSON>|null }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const B = require('../functions/call-brief-logic');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'call-brief-eval.json');
const TENANT = { name: 'Example Roofing Co', region: 'Southwest Ohio and Northern Kentucky' };

function loadCases(p) {
  const target = p || FIXTURES;
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(target, f))
    : [target];
  const out = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const c of Array.isArray(j.cases) ? j.cases : [j]) if (c && c.transcript != null) out.push(c);
  }
  return out;
}

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

/** One case's scores from its sanitised brief (or its gate refusal). */
function scoreCase(c, brief, refusedWhy) {
  const exp = c.expect || {};
  const refused = !!refusedWhy;
  const s = { id: c.id, kind: c.kind, gate: refused === !!exp.refused, refused };
  if (refused) return Object.assign(s, { precision: null, recall: null, claim: null, promise: null, reliable: null, dropped: null });
  const expFields = exp.fields || {};
  const kept = Object.keys(brief.fields).filter((k) => brief.fields[k] && brief.fields[k].value);
  const right = kept.filter((k) => norm(expFields[k]) === norm(brief.fields[k].value));
  s.precision = kept.length ? right.length / kept.length : 1;
  const labelled = Object.keys(expFields);
  s.recall = labelled.length ? labelled.filter((k) => brief.fields[k] && norm(brief.fields[k].value) === norm(expFields[k])).length / labelled.length : 1;
  const got = brief.fields.claimNumber ? brief.fields.claimNumber.value : '';
  s.claim = norm(got) === norm(expFields.claimNumber || '');
  const want = (exp.promises || []).slice();
  let hits = 0;
  for (const p of brief.promises) {
    const i = want.findIndex((w) => w.who === p.who && w.kind === p.kind);
    if (i >= 0) { hits++; want.splice(i, 1); }
  }
  const denom = Math.max((exp.promises || []).length, brief.promises.length);
  s.promise = denom ? hits / denom : 1;
  s.reliable = brief.transcriptOk.reliable === (exp.reliable !== false);
  if (exp.cutOff != null) s.cutOff = brief.transcriptOk.cutOff === exp.cutOff;
  s.dropped = brief.dropped;
  return s;
}

function mean(rows, k) {
  const v = rows.map((r) => r[k]).filter((x) => x !== null && x !== undefined).map((x) => (x === true ? 1 : x === false ? 0 : x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Runs every case. callModel(req, case) → an Anthropic response; the offline
 * default answers each case with its own canned JSON. Never touches Firestore.
 */
async function runEval({ cases, callModel, model } = {}) {
  const list = cases || loadCases();
  const ask = callModel || (async (req, c) => ({ content: [{ type: 'text', text: JSON.stringify(c.canned || {}) }] }));
  const stages = B.tenantStages(null);
  const rows = [];
  let modelCalls = 0;
  for (const c of list) {
    const call = Object.assign({ transcript: c.transcript }, c.call || {});
    const why = B.humanFiledProblem(call);
    if (why) { rows.push(scoreCase(c, null, why)); continue; }
    const req = B.buildRequest({ tenant: TENANT, stages, transcript: c.transcript, callYmd: c.callYmd, direction: c.direction, model });
    modelCalls++;
    const resp = await ask(req, c);
    const raw = B.parseResponse(resp);
    const brief = B.sanitizeBrief(raw || {}, { transcript: c.transcript, stages, stageKeys: stages.map((s) => s.key), callYmd: c.callYmd });
    rows.push(scoreCase(c, brief, ''));
  }
  const overall = {
    cases: rows.length, modelCalls,
    precision: mean(rows, 'precision'), recall: mean(rows, 'recall'), claim: mean(rows, 'claim'),
    promise: mean(rows, 'promise'), reliable: mean(rows, 'reliable'), gate: mean(rows, 'gate'),
  };
  return { rows, overall };
}

function liveModel(apiKey) {
  return async function (req) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + JSON.stringify(data).slice(0, 200));
    return data;
  };
}

function parseArgs(argv) {
  const a = { live: argv.includes('--live'), bars: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') a.model = argv[i + 1];
    if (argv[i] === '--cases') a.cases = argv[i + 1];
    const m = /^--bar-(precision|claim|promise|reliable)$/.exec(argv[i]);
    if (m) a.bars[m[1]] = Number(argv[i + 1]);
  }
  return a;
}

const pct = (x) => (x == null ? '  n/a' : (100 * x).toFixed(0).padStart(4) + '%');

async function main(argv, env) {
  const args = parseArgs(argv);
  if (args.model && !B.ALLOWED_MODELS.includes(args.model)) { console.error('--model must be one of ' + B.ALLOWED_MODELS.join(', ')); return 2; }
  let callModel = null;
  if (args.live) {
    if (!env.ANTHROPIC_API_KEY) { console.error('--live needs ANTHROPIC_API_KEY (and Jo\'s OK: it spends real API money).'); return 2; }
    callModel = liveModel(env.ANTHROPIC_API_KEY);
  }
  const cases = loadCases(args.cases);
  const { rows, overall } = await runEval({ cases, callModel, model: args.model });
  console.log((args.live ? 'LIVE ' + (args.model || B.BRIEF_MODEL) : 'OFFLINE (canned answers)') + ' · ' + cases.length + ' cases · ' + overall.modelCalls + ' model calls');
  console.log('case                         kind           prec  recall claim promise reliable gate');
  for (const r of rows) {
    console.log(String(r.id).padEnd(28) + ' ' + String(r.kind || '').padEnd(14) + pct(r.precision) + '  ' + pct(r.recall) + '  ' + (r.claim == null ? ' n/a' : r.claim ? '  ok' : 'MISS') + '  ' + pct(r.promise) + '   ' + (r.reliable == null ? ' n/a' : r.reliable ? '  ok' : 'MISS') + '    ' + (r.gate ? 'ok' : 'MISS')
      + (r.dropped ? '   dropped ' + JSON.stringify(r.dropped) : ''));
  }
  console.log('OVERALL precision ' + pct(overall.precision) + ' · recall ' + pct(overall.recall) + ' · claim ' + pct(overall.claim) + ' · promise ' + pct(overall.promise) + ' · reliable ' + pct(overall.reliable) + ' · gate ' + pct(overall.gate));
  let miss = 0;
  for (const [k, bar] of Object.entries(args.bars)) {
    if (overall[k] == null || overall[k] < bar) { console.log('BELOW BAR: ' + k + ' ' + pct(overall[k]) + ' < ' + pct(bar)); miss++; }
  }
  return miss ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code), (e) => { console.error(e && e.message); process.exit(1); });
}

module.exports = { loadCases, runEval, scoreCase, parseArgs, main, liveModel, FIXTURES, TENANT };
