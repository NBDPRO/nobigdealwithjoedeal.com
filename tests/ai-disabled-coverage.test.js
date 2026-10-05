/**
 * tests/ai-disabled-coverage.test.js — every direct Anthropic/Groq caller in
 * functions/ must be behind SOME feature_flags/global kill switch.
 *
 * WHY THIS EXISTS
 * ────────────────
 * SPEND_KILLSWITCH.md's "ONE-BUTTON: halt all billable AI instantly" claimed
 * `aiDisabled` stopped claudeProxy, analyzePhotoVision, and
 * visualizerImageGen — and nothing enforced that claim, or extended it as
 * new AI endpoints shipped. Re-auditing every literal
 * `fetch('https://api.anthropic.com/v1/messages', ...)` /
 * `fetch('https://api.groq.com/...', ...)` call site in `functions/`
 * (2026-09-14) found SIX more live, client-wired endpoints spending
 * Anthropic and/or Groq tokens with zero read of the flag:
 * `extractReceiptData`, `dictate`, `previewAiPersona`, `analyzeRoofPhoto`,
 * and — worse, because they are UNAUTHENTICATED and public —
 * `publicVisualizerAI` and `publicFunnelAI`. `adminAI` (admin-only) was
 * also ungated. None of this was caught by any existing test: there was no
 * suite at all pinning `isAiDisabled` coverage, not even for the original
 * three.
 *
 * This suite is the fix for that hole, not just the flag wiring: it
 * enumerates every known literal fetch call site (so an agent extending
 * this list later has one place to update) and asserts, for the enclosing
 * exported endpoint, that `isAiDisabled()` is checked before the network
 * call — same method as tests/voice-portal-draft-killswitch.test.js
 * (source-pattern, no network/emulator).
 *
 * Pure-Node. Run: node tests/ai-disabled-coverage.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '').replace(/\s\/\/[^\n]*$/mg, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// Slice one named export's body out of a source file: from `exports.NAME`
// (or `exports.NAME =`) up to the next top-level `\nexports.` or EOF. Good
// enough for this repo's house style (each exported Cloud Function is its
// own top-level `exports.foo = on...(` block, never nested inside another).
function sliceExport(src, name) {
  const start = src.indexOf('exports.' + name);
  if (start === -1) return null;
  const rest = src.slice(start + ('exports.' + name).length);
  const nextMatch = rest.match(/\n(?:exports\.|module\.exports)/);
  const end = nextMatch ? start + ('exports.' + name).length + nextMatch.index : src.length;
  return src.slice(start, end);
}

// { file, export, fetchLine, killswitchFn } — one row per literal fetch call
// site found by grepping functions/ for the Anthropic/Groq endpoints
// (2026-09-14 audit; re-run the grep below periodically and extend this
// list — that's the whole point of enumerating rather than trusting a
// file-level "does isAiDisabled appear ANYWHERE in this file" check, which
// is exactly the check that missed publicVisualizerAI/publicFunnelAI/adminAI
// living alongside the already-gated claudeProxy in the same file).
//   grep -rn "fetch('https://api.anthropic.com/v1/messages'\|fetch('https://api.groq.com" functions/ --include=*.js | grep -v test
// `spend` is the evidence a real vendor call happens inside this export's
// own body — usually the literal fetch(), but a few endpoints spend via a
// local helper function (dictate -> callClaudeForDictate, previewAiPersona
// -> the shared callClaudeForDraft in ai-texting.js) or a non-Anthropic
// vendor (visualizerImageGen -> Replicate/Kie, still "billable AI"). Each
// pattern is verified against the real file above, not assumed.
const VENDOR_FETCH = /fetch\(['"]https:\/\/api\.(anthropic|groq)\.com/;
const ENDPOINTS = [
  { file: 'functions/handlers/ai.js', export: 'claudeProxy', gate: 'isAiDisabled', spend: VENDOR_FETCH },
  { file: 'functions/handlers/ai.js', export: 'publicVisualizerAI', gate: 'isAiDisabled', spend: VENDOR_FETCH },
  { file: 'functions/handlers/ai.js', export: 'publicFunnelAI', gate: 'isAiDisabled', spend: VENDOR_FETCH },
  { file: 'functions/handlers/ai.js', export: 'adminAI', gate: 'isAiDisabled', spend: VENDOR_FETCH },
  // The Anthropic fetch moved into the shared classifyPhoto() (also used by the
  // photo-created trigger door); the callable's spend is its call to it.
  { file: 'functions/photo-vision.js', export: 'analyzePhotoVision', gate: 'isAiDisabled', spend: /\bclassifyPhoto\(/ },
  { file: 'functions/visualizer-image-gen.js', export: 'visualizerImageGen', gate: 'isAiDisabled', spend: /generateViaReplicate\(|generateViaKie\(/ },
  { file: 'functions/receipt-vision.js', export: 'extractReceiptData', gate: 'isAiDisabled', spend: VENDOR_FETCH },
  { file: 'functions/dictate.js', export: 'dictate', gate: 'isAiDisabled', spend: /callClaudeForDictate\(/ },
  { file: 'functions/handlers/ai-texting-preview.js', export: 'previewAiPersona', gate: 'isAiDisabled', spend: /callClaudeForDraft\(/ },
  { file: 'functions/handlers/photo.js', export: 'analyzeRoofPhoto', gate: 'isAiDisabled', spend: VENDOR_FETCH },
  // 2026-10-04: moved off Deepgram onto Groq through the shared helper.
  { file: 'functions/integrations/voice-memo.js', export: 'transcribeVoiceMemo', gate: 'isAiDisabled', spend: /transcribeGroqBuffer\(/ },
];

section('every known AI-spending Cloud Function checks its kill switch before calling the vendor');
for (const { file, export: exportName, gate, spend } of ENDPOINTS) {
  const src = codeOnly(read(file));
  const body = sliceExport(src, exportName);
  ok(`${exportName} (${file}) — export found`, !!body, 'sliceExport() found no exports.' + exportName + ' in ' + file);
  if (!body) continue;

  const gateAt = body.indexOf(gate + '()');
  ok(`${exportName} — checks ${gate}()`, gateAt > -1);

  const spendAt = body.search(spend);
  ok(`${exportName} — spend evidence exists in this slice (sanity — catches a bad export name/boundary/pattern)`, spendAt > -1);

  if (gateAt > -1 && spendAt > -1) {
    ok(`${exportName} — the gate runs BEFORE the spend, not after`, gateAt < spendAt);
  }

  // Every gate in this codebase either throws/returns before any spend —
  // pin the specific deny shape isn't required here (each already has its
  // own dedicated test file, e.g. photo-vision.test.js), just that SOME
  // early-exit follows the check within a short window.
  if (gateAt > -1) {
    const afterGate = body.slice(gateAt, gateAt + 300);
    ok(`${exportName} — the gate is followed by an early exit (return/throw) close by`,
      /\breturn\b/.test(afterGate) || /\bthrow\b/.test(afterGate));
  }
}

section('SPEND_KILLSWITCH.md names every endpoint aiDisabled actually covers');
{
  const runbook = read('documentation/runbooks/SPEND_KILLSWITCH.md');
  for (const { export: exportName } of ENDPOINTS) {
    ok(`runbook mentions ${exportName}`, new RegExp(exportName).test(runbook));
  }
  ok('the doc no longer claims only three endpoints are covered', !/claudeProxy.*analyzePhotoVision.*and\s*\n`visualizerImageGen`\s*all check it/s.test(runbook));
}

section('photo-vision — classifyPhoto() is where the vendor spend lives');
{
  const src = codeOnly(read('functions/photo-vision.js'));
  const start = src.indexOf('async function classifyPhoto(');
  const next = src.indexOf('\nasync function ', start + 1);
  const body = start > -1 ? src.slice(start, next > -1 ? next : undefined) : '';
  ok('classifyPhoto() exists', start > -1);
  ok('classifyPhoto() makes the Anthropic call (so gating its callers gates the spend)',
    /fetchImpl\(['"]https:\/\/api\.anthropic\.com/.test(body) || VENDOR_FETCH.test(body));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  console.log('\nFAILED:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
