/**
 * tests/roof-rep-game-2026-10-03.test.js — Roof Rep, the NBD Pro sales game
 * (docs/pro/roof-rep.html + js/pages/roof-rep.js, Jo 2026-10-03).
 *
 * What must never drift:
 *   1. The game TEACHES the Kentucky rules. Every trap line (handle the claim,
 *      cover or waive the deductible, pad the estimate, AOB, no permit, ...)
 *      must lose the door or break the clean-day streak, never win it.
 *   2. Prices shown in the game are NBD retail from the CRM price book
 *      (estimate-config TIER_RATES, job-template retail floors, gutters /LF).
 *   3. The talk trees are well-formed (every "go" lands on a real node).
 *   4. CSP + ratchet hygiene, data rules, GDPR registry and the nav tab.
 *
 * Run: node tests/roof-rep-game-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('docs/pro/js/pages/roof-rep.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// Pull one top-level `var NAME = <literal>;` out of the game and evaluate it.
function literal(name) {
  const start = SRC.indexOf('var ' + name + ' = ');
  if (start < 0) throw new Error('missing var ' + name);
  const open = SRC.indexOf(name + ' = ', start) + name.length + 3;
  const close = { '{': '}', '[': ']' }[SRC[open]];
  let depth = 0, i = open, inStr = null;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === SRC[open]) depth++;
    else if (c === close && --depth === 0) break;
  }
  return vm.runInNewContext('(' + SRC.slice(open, i + 1) + ')', {});
}

console.log('\n1. Kentucky traps always lose');
const TREES = literal('TREES');
const TRAPS = [
  /handl\w* (your|this|the|everything)\b.*\b(claim|adjuster)/i, /\bI(?:'| a)m handling this claim/i,
  /(cover|waive|eat|take care of)\b.{0,30}deductible/i, /bump the estimate/i,
  /assignment of benefits so/i, /skip the permit/i, /no permit/i, /sign it over|check over to me/i,
  /write it up as storm damage/i, /seemed to understand/i, /Just sign here/i,
];
const isTrap = (t) => TRAPS.some((re) => re.test(t));
let trapCount = 0; const leaks = [];
for (const [persona, tree] of Object.entries(TREES)) {
  for (const [key, node] of Object.entries(tree)) {
    for (const ch of node.choices) {
      if (!isTrap(ch.say)) continue;
      trapCount++;
      if (!(ch.dirty === true && ch.end === 'lose')) leaks.push(persona + '.' + key + ': ' + ch.say.slice(0, 60));
    }
  }
}
ok('talk trees carry the Kentucky trap lines (the lesson is in the game)', trapCount >= 8, 'found ' + trapCount);
ok('every trap line in a talk tree is dirty AND loses the door', leaks.length === 0, leaks.join(' | '));
// Traps outside the trees (adjuster, calls, supplement, rival, news) live in code:
// each one must set DAY.clean = false or carry dirty: true right after it.
const codeTraps = [
  "I'm handling this claim for", "take care of \" + h.name + \"'s deductible", "I'll match him. I'll cover your deductible too.",
  'Get me to a number and I', 'Sign the check over to me today', 'Call the insurer yourself and push for the extra money.',
  "We'll handle your whole claim for you!", "We don't really pull permits for re-roofs.", 'Cancel and you owe us 20% today.',
];
for (const t of codeTraps) {
  const at = SRC.indexOf(t);
  const after = at < 0 ? '' : SRC.slice(at, at + 500);
  ok('code trap is penalized: ' + t.slice(0, 48), at >= 0 && /DAY\.clean = false|dirty: true/.test(after), at < 0 ? 'phrase not found' : '');
}

console.log('\n2. Prices come from the CRM price book');
const TIERS = literal('TIERS');
const cfg = read('docs/pro/js/estimate-config.js');
const rate = (k) => Number((cfg.match(new RegExp('\\b' + k + ':\\s*(\\d+)')) || [])[1]);
ok('Good / Better / Best per square match estimate-config TIER_RATES',
  ['good', 'better', 'best'].every((k) => TIERS.find((t) => t.key === k).psq === rate(k)), JSON.stringify(TIERS.map((t) => t.psq)));
const tpl = read('docs/pro/js/job-templates-data.js');
const floor = (id) => Number((tpl.match(new RegExp('"id":"' + id + '"[^}]*?"minJobCharge":(\\d+)')) || [])[1]);
const CAUSES = literal('CAUSES');
const want = { boot: 'jt_rr_pipe_boot_1', flash: 'jt_lf_chimney_reflash', nails: 'jt_rr_ridge_cap_20', icedam: 'jt_se_ice_dam_retrofit' };
for (const [k, id] of Object.entries(want)) ok('repair "' + k + '" = job template ' + id + ' retail floor', CAUSES[k].price === floor(id) && floor(id) > 0, CAUSES[k].price + ' vs ' + floor(id));
const gut = Number((read('docs/pro/js/estimate-builder-v2.js').match(/guttersLf:\s*([\d.]+)/) || [])[1]);
ok('gutters price at the CRM seamless rate per LF, with the K5 system floor',
  SRC.includes('Math.max(' + floor('jt_gi_k5_seamless_full') + ', Math.round(lf * ' + gut + '))'), 'rate ' + gut + ', floor ' + floor('jt_gi_k5_seamless_full'));

console.log('\n3. Talk trees are well-formed');
const ENDS = new Set(['inspect', 'book', 'later', 'lose', 'hanger', 'owner']);
const broken = [];
for (const [persona, tree] of Object.entries(TREES)) {
  if (!tree.start) broken.push(persona + ': no start');
  for (const [key, node] of Object.entries(tree)) for (const ch of node.choices) {
    if (ch.go && !tree[ch.go]) broken.push(persona + '.' + key + ' → ' + ch.go);
    if (!ch.go && !ENDS.has(ch.end)) broken.push(persona + '.' + key + ' end=' + ch.end);
  }
}
ok('every choice goes to a real node or a known ending', broken.length === 0, broken.join(' | '));
const PERSONA = literal('PERSONA');
ok('every persona with a door has a talk tree', Object.keys(PERSONA).filter((p) => p !== 'empty').every((p) => TREES[p]), Object.keys(PERSONA).filter((p) => p !== 'empty' && !TREES[p]).join(','));

console.log('\n4. Page hygiene, data rules, registry, nav');
const html = read('docs/pro/roof-rep.html');
ok('no style="…" strings in roof-rep.js (classes only)', !/\bstyle\s*=\s*\\?["'`]/.test(SRC));
ok('no inline <script> bodies or on*= handlers on the page', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) && !/\son[a-z]+\s*=/i.test(html));
const css = read('docs/pro/css/roof-rep.css');
ok('challenge bar width classes exist for every 5% step', [0, 25, 50, 75, 100].every((p) => css.includes('.bar i.rr-w' + p + ' { width: ' + p + '%; }')));
ok('no claude.ai runtime left in the CRM build', !/window\.claude|claude\.use\(/.test(SRC));
const rules = read('firestore.rules');
const block = (name) => { const i = rules.indexOf('match /' + name + '/{uid}'); return i < 0 ? '' : rules.slice(i, rules.indexOf('\n    }', i)); };
ok('roofRep/{uid} is owner-only', /allow read, write: if isOwner\(uid\);/.test(block('roofRep')));
ok('roofRepScores reads are owner or SAME company only', /resource\.data\.companyId == request\.auth\.token\.get\('companyId', null\)/.test(block('roofRepScores')));
ok('roofRepScores writes are the owner, stamped with their own company, board fields only',
  /isOwner\(uid\)\s*&& request\.resource\.data\.companyId == request\.auth\.token\.get\('companyId', null\)\s*&& request\.resource\.data\.keys\(\)\.hasOnly/.test(block('roofRepScores')));
const owned = require(path.join(ROOT, 'functions/integrations/user-owned.js'));
ok('GDPR erasure/export covers roofRep and roofRepScores', ['roofRep', 'roofRepScores'].every((c) => owned.OWNER_KEYED_DOCS.includes(c)));
const dash = read('docs/pro/dashboard.html');
ok('CRM sidebar has the Roof Rep tab', /<a class="ni" href="\/pro\/roof-rep\.html" id="nav-roofrep">/.test(dash));
ok('phone More drawer has the Roof Rep tab', /<a class="mm-item" href="\/pro\/roof-rep\.html" id="mm-roofrep">/.test(dash));
ok('the Home game card links to the game (Game mode on)', /<a class="btn btn-ghost btn-sm gc-play" href="\/pro\/roof-rep\.html">/.test(read('docs/pro/js/game-card.js')));
ok('the page is noindexed', /"\/pro\/@\(roof-rep\|/.test(read('firebase.json')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
