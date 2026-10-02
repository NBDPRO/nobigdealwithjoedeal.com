#!/usr/bin/env node
/**
 * scripts/eval-ask-joe.mjs — ask the real model Ask Joe's golden questions
 * with Ask Joe's real system prompt, and grade the answers (2026-10-02).
 *
 *   ANTHROPIC_API_KEY=… node scripts/eval-ask-joe.mjs              # CRM Ask Joe
 *   ANTHROPIC_API_KEY=… node scripts/eval-ask-joe.mjs --standalone # /pro/ask-joe
 *
 * The prompt is built exactly as the browser builds it (ai.js
 * buildJoeSystemPrompt + js/ask-joe-rules.js + js/deposit-rule.js, loaded in a
 * vm), with a fixture member context, on the same model the product uses.
 * Run it after any change to the rules, the prompt, or the model. Exit 1 when
 * any answer breaks a rule. Not in CI: CI holds no Anthropic key.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GOLDEN, grade } = require('./eval-ask-joe-logic.js');
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('Set ANTHROPIC_API_KEY.'); process.exit(2); }
const MODEL = 'claude-haiku-4-5-20251001'; // what docs/pro/js/ai.js sends
const standalone = process.argv.includes('--standalone');

const read = (p) => fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', p), 'utf8');
const win = {};
const ctx = vm.createContext({ window: win, console });
vm.runInContext(read('deposit-rule.js'), ctx);
vm.runInContext(read('ask-joe-rules.js'), ctx);
let system;
if (standalone) {
  const main = read('pages/ask-joe-main.js');
  const r0 = main.indexOf('const _rules =');
  const r1 = main.indexOf(';', main.indexOf('const _systemPrompt =')) + 1;
  system = vm.runInContext('(function(){ ' + main.slice(r0, r1) + ' return _systemPrompt; })()', ctx);
} else {
  const ai = read('ai.js');
  const g = ai.indexOf('function joeGroundRules(');
  const b = ai.indexOf('function buildJoeSystemPrompt(');
  vm.runInContext(ai.slice(g, ai.indexOf('\n}', g) + 2) + '\n' + ai.slice(b, ai.indexOf('\n}', b) + 2) + '\nwindow.__build = buildJoeSystemPrompt;', ctx);
  system = win.__build({ name: 'Pat', company: 'Example Roofing', totalLeads: 40, activeLeads: 12, pipelineValue: 182000, closedRevenue: 96000, collectedRevenue: 71000, overdueCount: 3, stageBreakdown: 'new 5, inspected 4', topLeads: 'A ($21,000)', overdueFollowUps: 'B, C', tasksDueToday: 2, totalEstimates: 18 });
}

let failed = 0;
for (const q of GOLDEN) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': KEY },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: q.q }] }),
  });
  const data = await res.json();
  if (!res.ok) { console.log('✗ ' + q.id + ': API ' + res.status + ' ' + JSON.stringify(data).slice(0, 200)); failed++; continue; }
  const answer = (data.content || []).map((c) => c.text || '').join('');
  const g = grade(q, answer);
  console.log((g.pass ? '✓ ' : '✗ ') + q.id + (g.pass ? '' : '\n    ' + g.misses.join('\n    ') + '\n    answer: ' + answer.replace(/\s+/g, ' ').slice(0, 400)));
  if (!g.pass) failed++;
}
console.log('\n' + (GOLDEN.length - failed) + '/' + GOLDEN.length + ' answers within the rules (' + (standalone ? '/pro/ask-joe' : 'CRM Ask Joe') + ', ' + MODEL + ')');
process.exit(failed ? 1 : 0);
