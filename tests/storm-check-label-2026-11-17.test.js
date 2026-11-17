/**
 * tests/storm-check-label-2026-11-17.test.js — the free tool at /storm-check is
 * "Storm Damage Check" everywhere. The old labels "Is It Worth a Claim" and
 * "Storm Damage Claim Check" implied the tool predicts claim outcomes (Jo,
 * 2026-11-17). Fails if either returns under docs/. documentation/ notes may
 * keep the history. docs/llms-full.txt is regenerated at deploy from the pages,
 * so it is covered once the pages are clean.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const BANNED = ['Is It Worth a Claim', 'Storm Damage Claim Check'];
const TEXT = /\.(html|txt|md|json|js|xml)$/;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const f of walk(DOCS, [])) {
  if (path.basename(f) === 'llms-full.txt') continue;
  const s = fs.readFileSync(f, 'utf8');
  for (const b of BANNED) if (s.includes(b)) hits.push(path.relative(DOCS, f) + ': "' + b + '"');
}
if (hits.length) {
  console.error('FAIL: old storm-check label under docs/:\n  ' + hits.join('\n  '));
  process.exit(1);
}
console.log('storm-check-label: ok');
