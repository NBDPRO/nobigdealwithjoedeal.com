/**
 * tests/review-link-canonical-2026-11-05.test.js — every Google review link is NBD's real one.
 *
 * NBD's review link is https://g.page/r/CXzIjLwvtRPdEBM/review (Jo, 2026-11-05: "send them this
 * link for reviews every time"). The Thank-You letter's default in doc-preflight.js carried a
 * made-up https://g.page/r/nobigdeal/review, so every letter generated with it pointed customers
 * at a dead link.
 *
 *   1. every g.page/r/<id> link in docs/ and functions/ uses the real id
 *   2. positive control: the scan finds the known users (review-handoff.js, review-ask-auto-logic.js,
 *      the doc-preflight Thank-You default), so a broken scan cannot pass empty
 *   3. the /r short link in firebase.json still redirects to the real review link
 *
 * Zero deps. Run: node tests/review-link-canonical-2026-11-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const REVIEW_ID = 'CXzIjLwvtRPdEBM';
const REVIEW_URL = 'https://g.page/r/' + REVIEW_ID + '/review';
const SKIP_DIRS = new Set(['node_modules', 'vendor', '_archive', 'pagefind', '.git']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.html', '.json', '.txt', '.md']);

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, 'docs'), []).concat(walk(path.join(ROOT, 'functions'), []));
const hits = [];
const bad = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /g\.page\/r\/([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    hits.push(rel);
    if (m[1] !== REVIEW_ID) bad.push(rel + ': g.page/r/' + m[1]);
  }
}

console.log('review-link-canonical');
check('every g.page/r/<id> link in docs/ and functions/ is ' + REVIEW_ID, bad.length === 0, bad.join('\n       '));

const want = ['docs/pro/js/review-handoff.js', 'functions/review-ask-auto-logic.js', 'docs/pro/js/doc-preflight.js'];
const missing = want.filter((w) => !hits.includes(w));
check('positive control: the scan sees the known review-link users', missing.length === 0,
  'not found: ' + missing.join(', '));

const preflight = fs.readFileSync(path.join(ROOT, 'docs/pro/js/doc-preflight.js'), 'utf8');
check('Thank-You letter default review link is ' + REVIEW_URL,
  preflight.includes("source: 'literal:" + REVIEW_URL + "'"));

const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const redirects = (fb.hosting && [].concat(fb.hosting).flatMap((h) => h.redirects || [])) || [];
const r = redirects.find((x) => x.source === '/r');
check('/r redirects to ' + REVIEW_URL, !!r && r.destination === REVIEW_URL,
  r ? 'destination: ' + r.destination : 'no /r redirect');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
