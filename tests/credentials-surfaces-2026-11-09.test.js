/**
 * tests/credentials-surfaces-2026-11-09.test.js - the credential claims that
 * live OUTSIDE scripts/build-credentials.mjs's own surfaces must agree with
 * docs/assets/data/credentials.json (the source of truth; only status
 * "active" rows may be claimed anywhere).
 *
 * WHY (plan: CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09, "Fix now"):
 *   A. functions/agent-mcp-logic.js told the AI assistant NBD holds "IKO
 *      ROOFPRO Advantage" while credentials.json holds IKO as pending and not
 *      public (IKO bars public representation of that tier). The assistant
 *      drafts customer copy, so it must never state a credential the site
 *      hides.
 *
 * Pure Node, no deps. Run: node tests/credentials-surfaces-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' - ' + detail : '')); failed++; }
}

const rows = JSON.parse(read('docs/assets/data/credentials.json')).credentials;
const active = rows.filter((r) => r.status === 'active').sort((a, b) => a.order - b.order);
const held = rows.filter((r) => r.status !== 'active');
const short = (r) => r.issuerShort || r.issuer;
const ofType = (t) => active.filter((r) => r.type === t);

console.log('A. the AI assistant\'s credential list matches the active rows');
{
  const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
  const cred = L.rulesReference().credentials;
  const certs = cred.certifications || [];
  const mems = cred.memberships || [];
  const mfr = ofType('manufacturer');
  const mem = ofType('membership');

  ok('one certification per active manufacturer row', certs.length === mfr.length,
    certs.length + ' listed vs ' + mfr.length + ' active: ' + JSON.stringify(certs));
  mfr.forEach((r, i) => {
    ok('certification ' + (i + 1) + ' is ' + r.id + ' (issuer' + (r.contractorId ? ' + ID ' + r.contractorId : '') + ')',
      !!certs[i] && certs[i].includes(short(r)) && (!r.contractorId || certs[i].includes(r.contractorId)), certs[i]);
  });
  ok('one membership per active membership row', mems.length === mem.length,
    mems.length + ' listed vs ' + mem.length + ' active: ' + JSON.stringify(mems));
  mem.forEach((r, i) => {
    ok('membership ' + (i + 1) + ' is ' + r.id, !!mems[i] && mems[i].includes(short(r)), mems[i]);
  });
  ofType('insurance').forEach((r) => {
    ok('the note carries the insurance wording "' + r.claimWording + '"', String(cred.note || '').includes(r.claimWording));
  });
  const listed = certs.concat(mems).join(' | ');
  held.forEach((r) => {
    ok('a ' + r.status + ' row (' + r.id + ') is never listed', !listed.includes(short(r)), listed);
  });
  // Belt and braces: a known roofing/siding issuer with no active row.
  const ISSUERS = ['GAF', 'TAMKO', 'IKO', 'Owens Corning', 'CertainTeed', 'Atlas', 'Malarkey', 'James Hardie', 'LP SmartSide', 'American Operator', 'BBB', 'Haag'];
  const activeNames = active.map(short).join(' | ');
  const stray = ISSUERS.filter((n) => new RegExp('\\b' + n + '\\b').test(listed) && !activeNames.includes(n));
  ok('no issuer is listed that has no active row', stray.length === 0, stray.join(', '));
  ok('no honesty word in the list (Master Elite only as "not Master Elite"; never Licensed)',
    !/master\s*elite/i.test(listed.replace(/not Master Elite/g, '')) && !/\blicensed\b/i.test(listed), listed);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
