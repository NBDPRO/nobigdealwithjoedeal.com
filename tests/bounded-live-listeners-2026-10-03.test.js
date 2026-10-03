#!/usr/bin/env node
/**
 * bounded-live-listeners-2026-10-03.test.js
 *
 * Pins the bound on three CRM live listeners that used to stream a whole
 * collection slice with no limit — every snapshot re-shipped the company's
 * entire history:
 *
 *   - d2d-tracker-core-2026b.js  subscribeTeamActivity  knocks by companyId
 *   - dashboard-bootstrap.module.js  window._subscribeEstimates
 *       estimates by userId, estimates by companyId (team readers)
 *
 * Each must carry orderBy('createdAt', 'desc') + limit(<named constant>), the
 * constant must stay generous (prod on 2026-10-03: 167 knocks, 8 estimates in
 * the WHOLE collections, every doc with a Timestamp createdAt), and every
 * where+orderBy pair must have its composite index in firestore.indexes.json
 * (the emulator never enforces indexes; production does — FAILED_PRECONDITION).
 *
 * Positive controls: the checker is run against the pre-fix (unbounded)
 * listener text and must FAIL it, so a green run here means the bound is
 * present, not that the checker stopped looking.
 *
 * Run: node tests/bounded-live-listeners-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? ' \u2014 ' + detail : '')); }
}

// Comments are stripped before any matching, so an explanatory comment that
// mentions orderBy/limit can never satisfy an assertion on its own.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

// Body of a function from its header to the matching close brace.
function bodyOf(src, headerRe) {
  const m = headerRe.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}

// Every `query(` call inside `body` that targets `coll` — returns each call's
// full argument text (balanced parentheses).
function queriesOn(body, coll) {
  const out = [];
  const re = /\bquery\(/g;
  let m;
  while ((m = re.exec(body))) {
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < body.length; j++) {
      if (body[j] === '(') depth++;
      else if (body[j] === ')') { depth--; if (depth === 0) break; }
    }
    const call = body.slice(m.index, j + 1);
    if (new RegExp("collection\\([^)]*['\"]" + coll + "['\"]").test(call)) out.push(call);
  }
  return out;
}

// The listener contract: >= 1 query on the collection, and EVERY one is
// ordered newest-first by createdAt and limited by `limitConst`.
function boundedProblems(body, coll, limitConst) {
  const qs = queriesOn(body, coll);
  if (!qs.length) return ['no query on ' + coll + ' found'];
  const probs = [];
  qs.forEach((q, i) => {
    if (!/orderBy\(\s*['"]createdAt['"]\s*,\s*['"]desc['"]\s*\)/.test(q)) probs.push('query #' + (i + 1) + ' lacks orderBy(createdAt, desc)');
    if (!new RegExp('limit\\(\\s*' + limitConst + '\\s*\\)').test(q)) probs.push('query #' + (i + 1) + ' lacks limit(' + limitConst + ')');
  });
  return probs;
}

function constValue(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)\\s*;').exec(src);
  return m ? Number(m[1]) : NaN;
}

// ── 1. D2D live team listener (knocks) ───────────────────────────────
console.log('\nD2D subscribeTeamActivity (knocks)');
const d2d = stripComments(read('docs/pro/js/d2d-tracker-core-2026b.js'));
const teamBody = bodyOf(d2d, /function\s+subscribeTeamActivity\s*\(\s*\)\s*\{/);
check('subscribeTeamActivity found', !!teamBody);
if (teamBody) {
  check('it still opens an onSnapshot', /onSnapshot\(/.test(teamBody));
  const probs = boundedProblems(teamBody, 'knocks', 'TEAM_LIVE_KNOCK_LIMIT');
  check('every knocks query is orderBy(createdAt desc) + limit(TEAM_LIVE_KNOCK_LIMIT)', !probs.length, probs.join('; '));
  check('the companyId scope is unchanged', /where\(\s*['"]companyId['"]\s*,\s*['"]==['"]/.test(teamBody));
}
const teamN = constValue(d2d, 'TEAM_LIVE_KNOCK_LIMIT');
check('TEAM_LIVE_KNOCK_LIMIT is >= 500 (3x the 167 prod knocks) and <= 5000', teamN >= 500 && teamN <= 5000, 'got ' + teamN);

// ── 2. Estimates live listeners ──────────────────────────────────────
console.log('\nwindow._subscribeEstimates (estimates)');
const boot = stripComments(read('docs/pro/js/dashboard-bootstrap.module.js'));
const estBody = bodyOf(boot, /window\._subscribeEstimates\s*=\s*function\s*\(\s*\)\s*\{/);
check('_subscribeEstimates found', !!estBody);
if (estBody) {
  const qs = queriesOn(estBody, 'estimates');
  check('both slices (userId + companyId) are still subscribed', qs.length === 2
    && qs.some((q) => /where\(\s*['"]userId['"]/.test(q)) && qs.some((q) => /where\(\s*['"]companyId['"]/.test(q)), 'found ' + qs.length);
  const probs = boundedProblems(estBody, 'estimates', 'ESTIMATES_LIVE_LIMIT');
  check('every estimates query is orderBy(createdAt desc) + limit(ESTIMATES_LIVE_LIMIT)', !probs.length, probs.join('; '));
  const n = constValue(estBody, 'ESTIMATES_LIVE_LIMIT');
  check('ESTIMATES_LIVE_LIMIT is >= 100 and <= 5000', n >= 100 && n <= 5000, 'got ' + n);
}
check('orderBy + limit are imported from the Firestore SDK',
  /import\s*\{[^}]*\borderBy\b[^}]*\}\s*from\s*["'][^"']*firebase-firestore\.js["']/.test(boot)
  && /import\s*\{[^}]*\blimit\b[^}]*\}\s*from\s*["'][^"']*firebase-firestore\.js["']/.test(boot));

// ── 3. Composite indexes (production enforces them) ──────────────────
console.log('\nfirestore.indexes.json');
const idx = JSON.parse(read('firestore.indexes.json')).indexes || [];
function hasIndex(coll, eqField) {
  return idx.some((i) => i.collectionGroup === coll && i.queryScope === 'COLLECTION'
    && i.fields.length === 2
    && i.fields[0].fieldPath === eqField && i.fields[0].order === 'ASCENDING'
    && i.fields[1].fieldPath === 'createdAt' && i.fields[1].order === 'DESCENDING');
}
check('knocks: companyId ASC + createdAt DESC', hasIndex('knocks', 'companyId'));
check('estimates: userId ASC + createdAt DESC', hasIndex('estimates', 'userId'));
check('estimates: companyId ASC + createdAt DESC', hasIndex('estimates', 'companyId'));

// ── 4. Positive controls — the checker must fail the pre-fix listeners ──
console.log('\npositive controls (pre-fix text must FAIL)');
const OLD_TEAM = "{ const q = window.query(window.collection(window._db, 'knocks'), window.where('companyId', '==', state.currentRep.companyId)); _teamUnsub = window.onSnapshot(q, () => {}); }";
check('unbounded knocks listener is flagged', boundedProblems(OLD_TEAM, 'knocks', 'TEAM_LIVE_KNOCK_LIMIT').length === 2);
const OLD_EST = "{ unsubs.push(onSnapshot(query(collection(db, 'estimates'), where('userId', '==', uid)), () => {})); "
  + "unsubs.push(onSnapshot(query(collection(db, 'estimates'), where('companyId', '==', claims.companyId), orderBy('createdAt', 'desc'), limit(ESTIMATES_LIVE_LIMIT)), () => {})); }";
check('one unbounded estimates slice among two is flagged', boundedProblems(OLD_EST, 'estimates', 'ESTIMATES_LIVE_LIMIT').length === 2);
check('a comment mentioning the bound does not satisfy it',
  boundedProblems(stripComments(OLD_TEAM.replace('{', "{ // orderBy('createdAt', 'desc') limit(TEAM_LIVE_KNOCK_LIMIT)\n")), 'knocks', 'TEAM_LIVE_KNOCK_LIMIT').length === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
