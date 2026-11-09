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
 *   node scripts/eval-call-brief.js --init <dir> [--count 20]
 *       KIT: writes N empty, valid label files (case-01.json …) plus a
 *       README into <dir>, for Jo to fill from real calls. <dir> must be
 *       OUTSIDE this repo and outside any git work tree (transcripts hold
 *       customer PII and are never committed), and new or empty. No network.
 *       Runbook: documentation/runbooks/CALL-BRIEF-LIVE-EVAL.md.
 *
 *   Blank cases (empty transcript, i.e. an unfilled --init file) are skipped,
 *   never sent. A label problem (validateCase: a typo'd field key, a promise
 *   off the list, a date not YYYY-MM-DD) stops the run before any model call.
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
 *   scope kept  walkthrough cases only (P2, review 2026-11-09): of the notes
 *               pass's scopeFacts, the share that ground in the transcript
 *               (functions/call-brief-logic.js groundScopeFacts). The facts
 *               are paraphrases and only verbatim ones ground, so a low rate
 *               on real walkthroughs means the walkthrough adds little scope.
 *
 * Case shape: { id, kind, callYmd, direction, call:{status,leadId,attachedBy?,
 * movedBy?,alternateLeadIds}, transcript, expect:{ reliable, refused, cutOff?,
 * fields:{key:value}, promises:[{who,kind}] }, canned:<model JSON>|null }
 * A walkthrough case adds source:'visit' and scopeFacts:[string] and has no
 * call: it skips the phone human-filed gate (a visit's own gate is
 * visitBriefProblem, on the visit doc this harness never sees) and is asked
 * with the callable's visit prompt.
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

// ── labels: the checker and the --init kit ──────────────────────────────
const DATE_KEYS = ['dateOfLoss', 'adjusterMeetingYmd'];
const ENUM_FIELDS = { jobType: ['insurance', 'cash'], workKind: ['repair', 'replace'] };
const isBool = (v) => v === true || v === false;
const isBlank = (c) => String(c && c.transcript != null ? c.transcript : '').trim() === '';

/** What is wrong with one labelled case ([] when nothing). Shape only for a blank (--init) case. */
function validateCase(c) {
  const p = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (typeof c.id !== 'string' || !c.id.trim()) p.push('id: a short name is required');
  if (typeof c.transcript !== 'string') p.push('transcript: must be a string');
  if (!isBlank(c) && !B.isYmd(c.callYmd)) p.push('callYmd: the call date as YYYY-MM-DD');
  else if (c.callYmd && !B.isYmd(c.callYmd)) p.push('callYmd: YYYY-MM-DD');
  if (c.direction != null && !['inbound', 'outbound', ''].includes(c.direction)) p.push('direction: inbound, outbound or ""');
  const call = c.call;
  if (!call || typeof call !== 'object') p.push('call: required ({ status, leadId, attachedBy, alternateLeadIds })');
  else if (call.alternateLeadIds != null && !Array.isArray(call.alternateLeadIds)) p.push('call.alternateLeadIds: a list');
  const x = c.expect;
  if (!x || typeof x !== 'object') { p.push('expect: required'); return p; }
  if (!isBool(x.reliable)) p.push('expect.reliable: true or false');
  if (!isBool(x.refused)) p.push('expect.refused: true or false');
  if (x.cutOff != null && !isBool(x.cutOff)) p.push('expect.cutOff: true, false or null');
  const f = x.fields;
  if (!f || typeof f !== 'object' || Array.isArray(f)) p.push('expect.fields: an object');
  else {
    for (const k of Object.keys(f)) {
      if (!B.FIELD_KEYS.includes(k)) { p.push('expect.fields.' + k + ': not a field the brief has (' + B.FIELD_KEYS.join(', ') + ')'); continue; }
      if (typeof f[k] !== 'string' || !f[k].trim()) p.push('expect.fields.' + k + ': a non-empty string (leave a field out when the call did not say it)');
      else if (DATE_KEYS.includes(k) && !B.isYmd(f[k])) p.push('expect.fields.' + k + ': YYYY-MM-DD');
      else if (ENUM_FIELDS[k] && !ENUM_FIELDS[k].includes(f[k])) p.push('expect.fields.' + k + ': one of ' + ENUM_FIELDS[k].join(', '));
    }
  }
  if (!Array.isArray(x.promises)) p.push('expect.promises: a list');
  else {
    x.promises.forEach((pr, i) => {
      const at = 'expect.promises[' + i + ']';
      if (!pr || typeof pr !== 'object') { p.push(at + ': { who, kind }'); return; }
      if (!['jo', 'them'].includes(pr.who)) p.push(at + '.who: jo or them');
      if (!B.PROMISE_KINDS.includes(pr.kind)) p.push(at + '.kind: one of ' + B.PROMISE_KINDS.join(', '));
      else if (pr.who === 'them' && pr.kind !== 'waiting') p.push(at + ': a "them" promise is always kind waiting');
      else if (pr.who === 'jo' && pr.kind === 'waiting') p.push(at + ': waiting is for a "them" promise');
    });
  }
  if (c.canned !== undefined && c.canned !== null && typeof c.canned !== 'object') p.push('canned: null or a model answer object');
  return p;
}

/** One empty label file. Fictional placeholders only; the call block passes the human-filed gate. */
function skeleton(id) {
  return {
    _help: 'Fill transcript, kind, callYmd, direction and expect from ONE real call. Leave out any field the call did not say. See README.md. Never commit this file.',
    id,
    kind: '',
    callYmd: '',
    direction: '',
    call: { status: 'noted', leadId: 'L-' + id, attachedBy: 'jo', alternateLeadIds: [] },
    transcript: '',
    expect: { reliable: true, refused: false, cutOff: null, fields: {}, promises: [] },
    canned: null,
  };
}

function kitReadme(n) {
  return [
    '# Call Brief live eval: label files',
    '',
    'These ' + n + ' files are empty label skeletons written by',
    '`node scripts/eval-call-brief.js --init`. Fill one file per real call.',
    '',
    '**They will hold customer names, addresses and claim numbers. Never commit them,',
    'never copy them into the repo, never paste them into a chat or an issue.**',
    'Delete the folder when the eval is done.',
    '',
    'Full steps, the label format and a worked example: the repo runbook',
    '`documentation/runbooks/CALL-BRIEF-LIVE-EVAL.md`.',
    '',
    '## In short',
    '',
    '1. Paste the call transcript into `transcript` (from the call card: Transcript).',
    '2. Set `kind` (claim, repair, replace, angry, spanish, cut-off, shared-number, other),',
    '   `callYmd` (the call date, YYYY-MM-DD) and `direction` (inbound or outbound).',
    '3. In `expect.fields` put only what the caller actually said: ' + B.FIELD_KEYS.join(', ') + '.',
    '   Dates as YYYY-MM-DD. jobType is insurance or cash; workKind is repair or replace.',
    '4. In `expect.promises` list each promise as { "who": "jo" | "them", "kind": ... }.',
    '   Kinds: ' + B.PROMISE_KINDS.join(', ') + '. A "them" promise is always waiting.',
    '5. Set `expect.reliable` false for a non-English or garbled transcript, `expect.cutOff`',
    '   true when it ends mid-call. A shared-number call: alternateLeadIds ["L-other"],',
    '   remove attachedBy, and `expect.refused` true.',
    '',
    'Unfilled files (empty transcript) are skipped, never sent.',
    '',
    '## Run (from the repo folder; the --live runs spend real API money)',
    '',
    '    node scripts/eval-call-brief.js --cases <this folder>      # free label check, canned answers, no model',
    '    ANTHROPIC_API_KEY=<key> node scripts/eval-call-brief.js --live --cases <this folder>',
    '    ANTHROPIC_API_KEY=<key> node scripts/eval-call-brief.js --live --cases <this folder> --model claude-sonnet-5-5',
    '',
  ].join('\n');
}

/** Why p is inside this repo or any git work tree ('' when it is not). Follows symlinks of the part that exists. */
function insideRepo(p) {
  let probe = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(probe)) {
    tail.unshift(path.basename(probe));
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = path.join(fs.realpathSync(probe), ...tail);
  const root = fs.realpathSync(ROOT);
  const rel = path.relative(root, real);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return 'inside this repo (' + root + ')';
  for (let d = real; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return 'inside a git work tree (' + d + ')';
    if (path.dirname(d) === d) return '';
  }
}

/** --init: writes count skeletons + README into dir. '' when done, else why it refused (nothing written). */
function initCases(dir, count) {
  const n = count == null ? 20 : Number(count);
  if (!dir) return '--init needs a folder outside the repo, e.g. --init ~/nbd-call-eval';
  if (!Number.isInteger(n) || n < 1 || n > 100) return '--count must be a whole number from 1 to 100';
  const why = insideRepo(dir);
  if (why) return 'refusing --init ' + dir + ': it is ' + why + '. Transcripts hold customer PII and stay out of every repo; pick a folder like ~/nbd-call-eval.';
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) return 'refusing --init ' + dir + ': it exists and is not an empty folder (nothing was overwritten).';
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = 'case-' + String(i).padStart(2, '0');
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(skeleton(id), null, 2) + '\n', { flag: 'wx' });
  }
  fs.writeFileSync(path.join(dir, 'README.md'), kitReadme(n), { flag: 'wx' });
  return '';
}

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

/** One case's scores from its sanitised brief (or its gate refusal). */
function scoreCase(c, brief, refusedWhy) {
  const exp = c.expect || {};
  const refused = !!refusedWhy;
  const s = { id: c.id, kind: c.kind, gate: refused === !!exp.refused, refused };
  if (refused) return Object.assign(s, { precision: null, recall: null, claim: null, promise: null, reliable: null, dropped: null, scopeKeep: null });
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
  s.scopeKeep = null;
  if (Array.isArray(c.scopeFacts) && c.scopeFacts.length) {
    const g = B.groundScopeFacts(c.scopeFacts, c.transcript);
    s.scopeKeep = g.facts.length / c.scopeFacts.length;
    s.scopeDropped = g.dropped;
  }
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
    const visit = c.source === 'visit';
    const call = Object.assign({ transcript: c.transcript }, c.call || {});
    const why = visit ? '' : B.humanFiledProblem(call);
    if (why) { rows.push(scoreCase(c, null, why)); continue; }
    const req = B.buildRequest({ tenant: TENANT, stages, transcript: c.transcript, callYmd: c.callYmd, direction: c.direction, model, source: visit ? 'visit' : undefined });
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
    scopeKeep: mean(rows, 'scopeKeep'),
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
  const a = { live: argv.includes('--live'), init: argv.includes('--init'), bars: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--init') a.initDir = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
    if (argv[i] === '--count') a.count = argv[i + 1];
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
  if (args.init) {
    const why = initCases(args.initDir, args.count);
    if (why) { console.error(why); return 2; }
    console.log('Wrote ' + (args.count == null ? 20 : Number(args.count)) + ' empty label files and README.md to ' + path.resolve(args.initDir) + '. Fill them from real calls; never commit them.');
    return 0;
  }
  if (args.model && !B.ALLOWED_MODELS.includes(args.model)) { console.error('--model must be one of ' + B.ALLOWED_MODELS.join(', ')); return 2; }
  let callModel = null;
  if (args.live) {
    if (!env.ANTHROPIC_API_KEY) { console.error('--live needs ANTHROPIC_API_KEY (and Jo\'s OK: it spends real API money).'); return 2; }
    callModel = liveModel(env.ANTHROPIC_API_KEY);
  }
  const loaded = loadCases(args.cases);
  const cases = loaded.filter((c) => !isBlank(c));
  const skipped = loaded.length - cases.length;
  const problems = [].concat(...cases.map((c) => validateCase(c).map((m) => 'LABEL PROBLEM ' + (c.id || '(no id)') + ': ' + m)));
  if (problems.length) { problems.forEach((m) => console.error(m)); console.error('Fix the labels above; no model was called.'); return 2; }
  if (!cases.length) { console.error('No filled cases' + (skipped ? ' (' + skipped + ' blank files skipped)' : '') + ': paste a transcript into at least one file. No model was called.'); return 2; }
  if (skipped) console.log('skipped ' + skipped + ' blank case files (empty transcript)');
  const { rows, overall } = await runEval({ cases, callModel, model: args.model });
  console.log((args.live ? 'LIVE ' + (args.model || B.BRIEF_MODEL) : 'OFFLINE (canned answers)') + ' · ' + cases.length + ' cases · ' + overall.modelCalls + ' model calls');
  console.log('case                         kind           prec  recall claim promise reliable gate');
  for (const r of rows) {
    console.log(String(r.id).padEnd(28) + ' ' + String(r.kind || '').padEnd(14) + pct(r.precision) + '  ' + pct(r.recall) + '  ' + (r.claim == null ? ' n/a' : r.claim ? '  ok' : 'MISS') + '  ' + pct(r.promise) + '   ' + (r.reliable == null ? ' n/a' : r.reliable ? '  ok' : 'MISS') + '    ' + (r.gate ? 'ok' : 'MISS')
      + (r.dropped ? '   dropped ' + JSON.stringify(r.dropped) : '')
      + (r.scopeKeep != null ? '   scope kept ' + pct(r.scopeKeep).trim() + ' ' + JSON.stringify(r.scopeDropped) : ''));
  }
  console.log('OVERALL precision ' + pct(overall.precision) + ' · recall ' + pct(overall.recall) + ' · claim ' + pct(overall.claim) + ' · promise ' + pct(overall.promise) + ' · reliable ' + pct(overall.reliable) + ' · gate ' + pct(overall.gate)
    + (overall.scopeKeep != null ? ' · scope kept ' + pct(overall.scopeKeep).trim() + ' (walkthroughs)' : ''));
  let miss = 0;
  for (const [k, bar] of Object.entries(args.bars)) {
    if (overall[k] == null || overall[k] < bar) { console.log('BELOW BAR: ' + k + ' ' + pct(overall[k]) + ' < ' + pct(bar)); miss++; }
  }
  return miss ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code), (e) => { console.error(e && e.message); process.exit(1); });
}

module.exports = { loadCases, runEval, scoreCase, parseArgs, main, liveModel, validateCase, initCases, FIXTURES, TENANT };
