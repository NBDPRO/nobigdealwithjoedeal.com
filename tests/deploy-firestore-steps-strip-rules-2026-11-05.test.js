/**
 * tests/deploy-firestore-steps-strip-rules-2026-11-05.test.js
 *
 * The Rules API refuses firestore.rules once its sources reach 262,144 bytes, and the commented file is past that
 * (#2792). #2869 made the "Deploy Firestore rules" step upload a copy without comment-only lines, but
 * `firebase deploy --only firestore:indexes` compiles the rules too, so the next step failed with the same
 * "Total size of sources must be smaller than 262144" (2026-11-05). Guard: every deploy step whose command deploys
 * any firestore target strips the rules first and restores the readable file on exit.
 *
 * Zero deps. Run: node tests/deploy-firestore-steps-strip-rules-2026-11-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Split the workflow into its steps ("- name:" blocks) and keep those whose run block deploys a firestore target.
function firestoreDeploySteps(yml) {
  const steps = yml.replace(/\r\n/g, '\n').split(/\n(?=\s*- name: )/);
  return steps
    .map((s) => ({ name: (s.match(/- name: (.*)/) || [])[1] || '?', body: s }))
    .filter((s) => /firebase-tools deploy --only [^\n]*\bfirestore\b/.test(s.body.replace(/^\s*#.*$/gm, '')));
}

const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/firebase-deploy.yml'), 'utf8');
const steps = firestoreDeploySteps(yml);
ok('POSITIVE CONTROL: the rules and index deploy steps are both found', steps.length >= 2 && steps.some((s) => /rules/i.test(s.name)) && steps.some((s) => /indexes/i.test(s.name)), steps.map((s) => s.name).join(' | '));
for (const s of steps) {
  const code = s.body.replace(/^\s*#.*$/gm, '');
  const strip = code.indexOf('strip-rules-comments.js --write firestore.rules');
  const deploy = code.search(/firebase-tools deploy --only [^\n]*\bfirestore\b/);
  ok('"' + s.name.trim() + '" strips the rules before it deploys', strip !== -1 && strip < deploy);
  ok('"' + s.name.trim() + '" puts the readable firestore.rules back on exit', /trap 'git checkout -- firestore\.rules' EXIT/.test(code));
}
ok('the guard catches a firestore step without the strip', firestoreDeploySteps(
  "      - name: Deploy X\n        run: |\n          npx firebase-tools deploy --only firestore:indexes --project p\n").every((s) => !/strip-rules-comments/.test(s.body)));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
